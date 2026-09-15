// tests/company_create.test.js
// ============================================================
// "+ Nyt firma" i CRM → Firmaer (#612): POST /api/companies + GET /api/companies/match.
//
// Et firma kunne kun opstå som biprodukt (via "+ Ny kunde" eller en bon med et
// ukendt firmanavn). Oprydningen i kartoteket kræver at man kan lave den
// rigtige række i hånden — og at man FØR oprettelsen får at vide om den
// allerede findes (#607).
//
// Kernereglerne der holdes fast her:
//   1. /match bruger matcheren (CVR → EAN → e-mail → navnelighed), kun aktive.
//   2. POST lægger e-mail/telefon som kontaktpunkter — ellers kan firmaet
//      hverken ses i Firma 360° eller matches på e-mail bagefter.
//   3. POST spærrer IKKE på et CVR-sammenfald: afdelinger under samme CVR er
//      separate firmaer. Kontoret afgør, men skal have set matchet.
//   4. POST validerer CVR/EAN/adresse og skriver en changelog-linje.
//
// Skemaet bygges af de RIGTIGE migrations i :memory:, endpoints rammes over HTTP.
//
// Kør: npm run test:firma-opret
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
sseModule.broadcast = () => {};

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    const co = db.prepare('INSERT INTO companies (id, name, cvr, ean, is_active) VALUES (?,?,?,?,?)');
    co.run(1, 'Landbrug & Fødevarer A.m.b.A', '25529529', '5790000000019', 1);
    co.run(2, 'Gate21', '32112846', null, 0);   // lagt væk af "Ryd tomme firmaer"
    db.prepare("INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date, company_id) VALUES ('T-1', (SELECT id FROM status_definitions WHERE code='NY'), (SELECT id FROM locations LIMIT 1), date('now'), date('now'), 1)").run();
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/api/companies', require('../routes/companies'));
app.use('/api/addresses', require('../routes/addresses'));

let server, baseUrl;
test.before(() => new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function call(method, url, body) {
    const res = await fetch(baseUrl + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (u, b) => call('POST', u, b);
const get  = (u) => call('GET', u);
const company = (id) => _testDb.prepare('SELECT * FROM companies WHERE id=?').get(id);
const cps = (id) => _testDb.prepare("SELECT kind, value, source, is_primary, is_public FROM contact_points WHERE entity_type='company' AND entity_id=? ORDER BY kind").all(id);

// ── 1. /match ─────────────────────────────────────────────

test('match: CVR vinder over navnet og svarer med det der skal vises', async () => {
    const r = await get('/api/companies/match?name=Helt%20andet%20navn&cvr=25529529');
    assert.equal(r.status, 200);
    assert.equal(r.body.match.match_type, 'cvr_exact');
    assert.equal(r.body.match.company_id, 1);
    assert.equal(r.body.match.name, 'Landbrug & Fødevarer A.m.b.A');
    assert.equal(r.body.match.bons, 1, 'antal bons vises — så man kan se om det er en levende række');
});

test('match: EAN vinder over CVR — KU-afdelingen med det EAN, ikke en tilfældig række med samme CVR', async () => {
    _testDb.prepare("INSERT INTO companies (id, name, cvr, ean) VALUES (3, 'Department of Immunology and Microbiology, ku', '29979812', NULL)").run();
    _testDb.prepare("INSERT INTO companies (id, name, cvr, ean) VALUES (4, 'KU Science', '29979812', '5790000301959')").run();
    const r = await get('/api/companies/match?cvr=29979812&ean=5790000301959');
    assert.equal(r.body.match.match_type, 'ean_exact');
    assert.equal(r.body.match.company_id, 4);
});

test('match: et CVR-match siger hvor mange der deler CVR\'et', async () => {
    _testDb.prepare("INSERT INTO companies (id, name, cvr) VALUES (3, 'Dept A', '29979812')").run();
    _testDb.prepare("INSERT INTO companies (id, name, cvr) VALUES (4, 'Dept B', '29979812')").run();
    const r = await get('/api/companies/match?cvr=29979812');
    assert.equal(r.body.match.match_type, 'cvr_exact');
    assert.equal(r.body.match.cvr_shared, 2);
    const one = await get('/api/companies/match?cvr=25529529');
    assert.equal(one.body.match.cvr_shared, 1);
});

test('match: EAN alene finder firmaet', async () => {
    const r = await get('/api/companies/match?ean=5790000000019');
    assert.equal(r.body.match.match_type, 'ean_exact');
});

test('match: navnelighed — "Landbrug og Fødevarer" rammer den eksisterende', async () => {
    const r = await get('/api/companies/match?name=' + encodeURIComponent('Landbrug og Fødevarer'));
    assert.equal(r.body.match.match_type, 'name_fuzzy');
    assert.equal(r.body.match.company_id, 1);
});

test('match: et inaktivt firma matches ikke — heller ikke på præcis samme CVR', async () => {
    const r = await get('/api/companies/match?name=Gate21&cvr=32112846');
    assert.equal(r.body.match, null);
});

test('match: intet at slå op på → null', async () => {
    const r = await get('/api/companies/match');
    assert.deepEqual(r.body, { match: null });
});

// ── 2. POST ───────────────────────────────────────────────

test('opret: rækken oprettes, og e-mail + telefon bliver kontaktpunkter', async () => {
    const r = await post('/api/companies', { name: 'CAP Partner ApS', cvr: '34 59 99 63', email: 'info@cap-partner.eu', phone: '39 20 97 00' });
    assert.equal(r.status, 200);
    const co = company(r.body.id);
    assert.equal(co.name, 'CAP Partner ApS');
    assert.equal(co.cvr, '34599963', 'CVR normaliseres til 8 cifre');
    const c = cps(r.body.id);
    assert.equal(c.length, 2, 'to kontaktpunkter');
    assert.ok(c.every(x => x.is_primary === 1 && x.is_public === 0 && x.source === 'manual'));
});

test('opret: e-mailen kan bagefter matches — det er derfor kontaktpunktet er nødvendigt', async () => {
    const r = await post('/api/companies', { name: 'CAP Partner ApS', email: 'info@cap-partner.eu' });
    const m = await get('/api/companies/match?email=info@cap-partner.eu');
    assert.equal(m.body.match?.match_type, 'email_match');
    assert.equal(m.body.match?.company_id, r.body.id);
});

test('opret: adresse-id gemmes; ukendt adresse afvises', async () => {
    const a = await post('/api/addresses', { street_name: 'Bredgade', street_nr: '24', postal_code: '1260', city: 'København K' });
    const r = await post('/api/companies', { name: 'Bredgade Kontor', address_id: a.body.id });
    assert.equal(company(r.body.id).address_id, a.body.id);
    const bad = await post('/api/companies', { name: 'X', address_id: 999999 });
    assert.equal(bad.status, 400);
});

test('opret: changelog-linje med CVR og EAN', async () => {
    const r = await post('/api/companies', { name: 'Nyt Firma', cvr: '12345678', ean: '5798000000001' });
    const cl = _testDb.prepare("SELECT * FROM changelog WHERE entity_type='company' AND entity_id=? AND action='create'").get(r.body.id);
    assert.ok(cl, 'changelog-linje');
    assert.match(cl.notes, /CVR 12345678/);
    assert.match(cl.notes, /EAN 5798000000001/);
});

test('opret: validering — navn påkrævet, CVR 8 cifre, EAN 13 cifre', async () => {
    assert.equal((await post('/api/companies', { name: '  ' })).status, 400);
    assert.equal((await post('/api/companies', { name: 'A', cvr: '1234567' })).status, 400);
    assert.equal((await post('/api/companies', { name: 'A', ean: '123' })).status, 400);
});

test('opret: SPÆRRER IKKE på samme CVR — afdelinger under én juridisk enhed er separate firmaer', async () => {
    const r = await post('/api/companies', { name: 'Kunstforeningen Landbrug & Fødevarer', cvr: '25529529' });
    assert.equal(r.status, 200, 'oprettes trods CVR-sammenfald');
    assert.notEqual(r.body.id, 1);
    // …men /match VISER det, så det er et bevidst valg i UI'et, ikke en tavs dublet.
    const m = await get('/api/companies/match?cvr=25529529&name=' + encodeURIComponent('Kunstforeningen Landbrug & Fødevarer'));
    assert.equal(m.body.match.match_type, 'cvr_exact');
});

test('opret: uden e-mail/telefon oprettes ingen kontaktpunkter (KundeSoeg-kaldet er uændret)', async () => {
    const r = await post('/api/companies', { name: 'Kun Navn' });
    assert.equal(cps(r.body.id).length, 0);
});
