// tests/companyMatcher.test.js
// Smoke-test for services/companyMatcher.js
// Køres via: node --experimental-sqlite --test tests/companyMatcher.test.js

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const { normalizeName, similarity, matchCompany } = require('../services/companyMatcher');

// ─── normalizeName ──────────────────────────────────────────

test('normalizeName fjerner juridiske suffixer', () => {
    assert.strictEqual(normalizeName('Magasin A/S'), 'magasin');
    assert.strictEqual(normalizeName('Kantinen ApS'), 'kantinen');
    assert.strictEqual(normalizeName('Foo I/S'), 'foo');
    assert.strictEqual(normalizeName('Bar Holding'), 'bar');
});

test('normalizeName fjerner parenteser', () => {
    assert.strictEqual(normalizeName('Magasin (FOND)'), 'magasin');
    assert.strictEqual(normalizeName('Foo (ODM) A/S'), 'foo');
});

test('normalizeName håndterer null/undefined uden at crashe', () => {
    assert.strictEqual(normalizeName(null), '');
    assert.strictEqual(normalizeName(undefined), '');
    assert.strictEqual(normalizeName(''), '');
});

test('normalizeName bevarer æøå', () => {
    assert.strictEqual(normalizeName('Bæverhuset ApS'), 'bæverhuset');
    assert.strictEqual(normalizeName('Søndergård I/S'), 'søndergård');
});

// ─── similarity ─────────────────────────────────────────────

test('similarity giver 1.0 for identiske navne efter normalisering', () => {
    // Suffix-fjernelse: begge bliver "magasin" → identisk efter normalisering
    assert.strictEqual(similarity('Magasin A/S', 'Magasin'), 1.0);
    assert.strictEqual(similarity('Magasin', 'Magasin A/S'), 1.0);
    assert.strictEqual(similarity('Foo Bar', 'foo bar'), 1.0);
});

test('similarity giver 0.95 for substring-match (ikke identisk efter normalisering)', () => {
    // "ristet rug cafe" vs "ristet rug" — substring, ikke identisk
    assert.strictEqual(similarity('Ristet Rug Cafe', 'Ristet Rug'), 0.95);
    assert.strictEqual(similarity('Foo Bar Baz', 'Foo Bar'), 0.95);
});

test('similarity giver lav score for ikke-relaterede navne', () => {
    assert.ok(similarity('Bagerhuset', 'Magasin') < 0.5);
    assert.ok(similarity('Foo', 'Bar') < 0.5);
});

test('similarity returnerer 0 for tomme input', () => {
    assert.strictEqual(similarity('', 'Magasin'), 0);
    assert.strictEqual(similarity('Magasin', ''), 0);
    assert.strictEqual(similarity(null, 'Magasin'), 0);
});

// ─── matchCompany ───────────────────────────────────────────

function setupDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cvr TEXT,
            ean TEXT,
            city TEXT,
            is_internal INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE contact_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            is_primary INTEGER NOT NULL DEFAULT 0
        );
    `);
    db.prepare('INSERT INTO companies (name, cvr, ean, city) VALUES (?, ?, ?, ?)')
        .run('Magasin A/S', '12345678', '5790000123456', 'København');
    db.prepare('INSERT INTO companies (name, cvr, city) VALUES (?, ?, ?)')
        .run('Bagerhuset I/S', '87654321', 'Aarhus');
    db.prepare('INSERT INTO companies (name, is_internal) VALUES (?, ?)')
        .run('RR Produktion', 1); // Intern — må aldrig matches
    db.prepare(`
        INSERT INTO contact_points (entity_type, entity_id, kind, value, is_active)
        VALUES ('company', 1, 'email', 'kontakt@magasin.dk', 1)
    `).run();
    return db;
}

test('matchCompany: CVR exact match', () => {
    const db = setupDb();
    const r = matchCompany(db, { cvr: '12345678' });
    assert.strictEqual(r.match_type, 'cvr_exact');
    assert.strictEqual(r.confidence, 1.0);
    assert.strictEqual(r.company_name, 'Magasin A/S');
});

test('matchCompany: CVR rydder ikke-cifre før opslag', () => {
    const db = setupDb();
    const r = matchCompany(db, { cvr: 'DK-1234.5678' });
    assert.strictEqual(r.match_type, 'cvr_exact');
});

test('matchCompany: EAN exact match', () => {
    const db = setupDb();
    const r = matchCompany(db, { ean: '5790000123456' });
    assert.strictEqual(r.match_type, 'ean_exact');
    assert.strictEqual(r.confidence, 1.0);
});

test('matchCompany: email match mod contact_points', () => {
    const db = setupDb();
    const r = matchCompany(db, { email: 'kontakt@magasin.dk' });
    assert.strictEqual(r.match_type, 'email_match');
    assert.strictEqual(r.confidence, 0.95);
    assert.strictEqual(r.company_name, 'Magasin A/S');
});

test('matchCompany: email lowercases input før opslag', () => {
    const db = setupDb();
    const r = matchCompany(db, { email: 'KONTAKT@MAGASIN.DK' });
    assert.strictEqual(r.match_type, 'email_match');
});

test('matchCompany: navn fuzzy match', () => {
    const db = setupDb();
    const r = matchCompany(db, { name: 'Magasin' });
    assert.strictEqual(r.match_type, 'name_fuzzy');
    assert.ok(r.confidence >= 0.85);
    assert.strictEqual(r.company_id, 1);
});

test('matchCompany: navn match med suffix-variant', () => {
    const db = setupDb();
    // "Magasin ApS" mod existing "Magasin A/S" → begge bliver "magasin" efter normalisering
    const r = matchCompany(db, { name: 'Magasin ApS' });
    assert.strictEqual(r.match_type, 'name_fuzzy');
    assert.strictEqual(r.confidence, 1.0); // identiske efter normalisering
});

test('matchCompany: lavt similarity-navn returnerer null', () => {
    const db = setupDb();
    const r = matchCompany(db, { name: 'Helt Andet Firma XYZ' });
    assert.strictEqual(r, null);
});

test('matchCompany: ekskluderer interne firmaer', () => {
    const db = setupDb();
    const r = matchCompany(db, { name: 'RR Produktion' });
    assert.strictEqual(r, null);
});

test('matchCompany: prioritet — CVR slår navn', () => {
    const db = setupDb();
    // CVR matcher Magasin, navn matcher Bagerhuset — CVR vinder
    const r = matchCompany(db, { cvr: '12345678', name: 'Bagerhuset' });
    assert.strictEqual(r.match_type, 'cvr_exact');
    assert.strictEqual(r.company_name, 'Magasin A/S');
});

test('matchCompany: prioritet — EAN slår email + navn', () => {
    const db = setupDb();
    const r = matchCompany(db, {
        ean: '5790000123456',
        email: 'kontakt@magasin.dk',
        name: 'Bagerhuset',
    });
    assert.strictEqual(r.match_type, 'ean_exact');
});

test('matchCompany: city som tiebreaker — afviser forkert by ved fuzzy match', () => {
    const db = setupDb();
    // "Magasin" matcher fuzzy mod Magasin A/S (København), men vi siger Aarhus
    const r = matchCompany(db, { name: 'Magasin', city: 'Aarhus' });
    assert.strictEqual(r, null);
});

test('matchCompany: city tillader manglende city på begge sider', () => {
    const db = setupDb();
    const r = matchCompany(db, { name: 'Magasin' }); // ingen city sat
    assert.strictEqual(r.match_type, 'name_fuzzy');
});

test('matchCompany: tomt input returnerer null', () => {
    const db = setupDb();
    assert.strictEqual(matchCompany(db, {}), null);
    assert.strictEqual(matchCompany(db, { cvr: '', ean: '', email: '', name: '' }), null);
});

test('matchCompany: ugyldig CVR-længde springes over', () => {
    const db = setupDb();
    const r = matchCompany(db, { cvr: '1234' }); // for kort
    assert.strictEqual(r, null);
});

test('matchCompany: ugyldig EAN-længde springes over', () => {
    const db = setupDb();
    const r = matchCompany(db, { ean: '12345' }); // for kort
    assert.strictEqual(r, null);
});
