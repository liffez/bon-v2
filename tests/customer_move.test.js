// tests/customer_move.test.js
// ============================================================
// Flyt en kontaktperson til det rigtige firma — og lad den lærte
// adresse følge med.
//
// Baggrunden er en konkret sag: en mail fra
// "Communication <communication@iuno.law>" blev koblet med "Opret som lead".
// createPrivateLead giver ALDRIG et firma, og navnet bliver mailens
// afsendernavn — så vi fik en kontakt ved navn "Communication" uden
// forbindelse til det IUNO-firma vi allerede havde i kartoteket.
//
// To fejl gjorde det umuligt at rette:
//
//   1. Der fandtes intet PATCH /api/customers/:id. Kun /economic, /stage og
//      /consent; company_id kunne kun flyttes af merge-guiden (der kræver TO
//      firmaer) eller af et script. Hverken navn eller firma kunne ændres.
//
//   2. createPrivateLead mærkede adressen 'manual', selvom den kom fra en
//      mail. moveThreadOwner tager kun source='mail' med, så omvejen — opret
//      personen forfra og flyt tråden — efterlod adressen på leadet, og
//      kundens næste mail landede samme forkerte sted igen.
//
// Kernepåstandene her:
//   1. En kontakt kan flyttes til et firma, og navnet kan rettes.
//   2. Et efterladt PERSONLIGT firma lægges væk; et rigtigt firma røres ikke.
//   3. Et lead oprettet fra en mail får source='mail' på adressen.
//   4. …og derfor følger adressen med når tråden flyttes. (3 uden 4 er kun
//      en kolonneværdi; 4 er hele grunden til at 3 betyder noget.)
//   5. Den manuelle vej (lead-import) mærker stadig 'manual'.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, og alt går
// gennem de ægte endpoints over HTTP — en omskrevet SQL i testen ville ikke
// bevise noget om routen.
//
// Kør: node --experimental-sqlite --test tests/customer_move.test.js
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
const _events = [];
sseModule.broadcast = (name, data) => { _events.push({ name, data }); };

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

// Firma-id'er der bruges gennem hele filen
const IUNO = 10;          // rigtigt firma — må aldrig forsvinde af sig selv
const PERSONAL = 11;      // auto-oprettet af ensurePersonalCompanies (services/rfm.js)
const PERSONAL_WITH_BON = 12;
// ensurePersonalCompanies laver ÉT firma pr. kunde uden firma — to kunder deler
// aldrig et personligt firma. Leadet fra sagen får derfor sit eget.
const PERSONAL_LEAD = 13;

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }

    db.prepare('INSERT INTO companies (id, name, cvr) VALUES (?,?,?)')
      .run(IUNO, 'IUNO Advokatselskab', '29788483');
    db.prepare('INSERT INTO companies (id, name, is_personal) VALUES (?,?,1)')
      .run(PERSONAL, 'Communication');
    db.prepare('INSERT INTO companies (id, name, is_personal) VALUES (?,?,1)')
      .run(PERSONAL_WITH_BON, 'Har handlet');
    db.prepare('INSERT INTO companies (id, name, is_personal) VALUES (?,?,1)')
      .run(PERSONAL_LEAD, 'Communication');

    // Kunden fra sagen: navn gættet fra mailen, intet firma
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,NULL)')
      .run(1, 'Communication', 'communication@iuno.law');
    // Kollegaen der allerede lå under firmaet
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (?,?,?,?,?)')
      .run(2, 'Jessica', 'Ebenezerson', 'office@iuno.law', IUNO);
    // Kunde hængende på et personligt firma
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)')
      .run(3, 'Persona', PERSONAL);
    // Kunde på et personligt firma der HAR en bon — må ikke lægges væk
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)')
      .run(4, 'Handlende', PERSONAL_WITH_BON);

    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='NY'").get().id;
    db.prepare(`INSERT INTO bons (bon_number, customer_id, company_id, location_id,
                                  order_date, delivery_date, delivery_type, status_id)
                VALUES ('T-MOVE-1', 4, ?, 1, date('now'), '2026-09-10', 'delivery', ?)`)
      .run(PERSONAL_WITH_BON, statusId);

    // Bruger 1 seedes af migrationerne — vi genbruger den som handlende.
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.session = { userId: 1, userRole: 'admin', user: { id: 1, role: 'admin' } };
    next();
});
app.use('/api/customers', require('../routes/customers'));
app.use('/api/mail', require('../routes/mail'));

let server, baseUrl;

test.before(async () => {
    await new Promise(r => { server = app.listen(0, r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => { _testDb = createFreshDb(); _events.length = 0; });

async function api(method, url, body) {
    const res = await fetch(baseUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* tom body */ }
    return { status: res.status, body: json };
}

const cust = id => _testDb.prepare('SELECT * FROM customers WHERE id = ?').get(id);
const comp = id => _testDb.prepare('SELECT * FROM companies WHERE id = ?').get(id);
const cps  = cid => _testDb.prepare(
    `SELECT * FROM contact_points WHERE entity_type='customer' AND entity_id=? AND kind='email' ORDER BY id`
).all(cid);
const changesFor = (cid, field) => _testDb.prepare(
    `SELECT * FROM changelog WHERE entity_type='customer' AND entity_id=? AND field_name=?`
).all(cid, field);

/* ══ 1. Flytning og navn ══════════════════════════════════════════════ */

test('kontakten flyttes til firmaet og navnet rettes i ét kald', async () => {
    const r = await api('PATCH', '/api/customers/1', {
        first_name: 'Isabella', last_name: 'Hansen', company_id: IUNO,
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.changed.sort(), ['company_id', 'first_name', 'last_name']);

    const c = cust(1);
    assert.strictEqual(c.company_id, IUNO, 'kunden ligger nu under IUNO');
    assert.strictEqual(c.first_name, 'Isabella');
    assert.strictEqual(c.last_name, 'Hansen');
});

test('hvert ændret felt får sin egen changelog-linje med gammel og ny værdi', async () => {
    await api('PATCH', '/api/customers/1', { first_name: 'Isabella', company_id: IUNO });

    const navn = changesFor(1, 'first_name');
    assert.strictEqual(navn.length, 1);
    assert.strictEqual(navn[0].old_value, 'Communication');
    assert.strictEqual(navn[0].new_value, 'Isabella');

    const firma = changesFor(1, 'company_id');
    assert.strictEqual(firma.length, 1);
    assert.strictEqual(firma[0].old_value, null, 'kunden havde intet firma før');
    assert.strictEqual(firma[0].new_value, String(IUNO));
    assert.match(firma[0].notes || '', /flyttet/i);
});

test('kun felter der faktisk flytter sig skrives — et Gem uden ændringer er stille', async () => {
    const r = await api('PATCH', '/api/customers/2', {
        first_name: 'Jessica', last_name: 'Ebenezerson', company_id: IUNO,
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.changed, []);
    assert.strictEqual(changesFor(2, 'first_name').length, 0, 'ingen tom historik-linje');
});

test('kontakten kan gøres til privatkunde med company_id: null', async () => {
    const r = await api('PATCH', '/api/customers/2', { company_id: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(cust(2).company_id, null);
});

test('et delvist kald rører kun det medsendte felt', async () => {
    await api('PATCH', '/api/customers/2', { company_id: null });
    const c = cust(2);
    assert.strictEqual(c.first_name, 'Jessica', 'navnet står urørt');
    assert.strictEqual(c.last_name, 'Ebenezerson');
});

test('ændringen broadcastes så andre skærme opdaterer', async () => {
    await api('PATCH', '/api/customers/1', { company_id: IUNO });
    const ev = _events.find(e => e.name === 'customer_updated');
    assert.ok(ev, 'customer_updated blev sendt');
    assert.strictEqual(ev.data.customer_id, 1);
});

/* ══ 2. Værn ══════════════════════════════════════════════════════════ */

test('tomt fornavn afvises — en navnløs kunde kan kun findes på sit id', async () => {
    const r = await api('PATCH', '/api/customers/1', { first_name: '   ' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cust(1).first_name, 'Communication', 'navnet står urørt');
});

test('ukendt firma afvises', async () => {
    const r = await api('PATCH', '/api/customers/1', { company_id: 9999 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cust(1).company_id, null);
});

test('et lukket firma kan ikke bruges som mål', async () => {
    _testDb.prepare('UPDATE companies SET is_active = 0 WHERE id = ?').run(IUNO);
    const r = await api('PATCH', '/api/customers/1', { company_id: IUNO });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cust(1).company_id, null);
});

test('ukendt kunde giver 404', async () => {
    const r = await api('PATCH', '/api/customers/9999', { first_name: 'Nogen' });
    assert.strictEqual(r.status, 404);
});

test('en lukket kunde kan ikke redigeres', async () => {
    _testDb.prepare('UPDATE customers SET is_active = 0 WHERE id = 1').run();
    const r = await api('PATCH', '/api/customers/1', { first_name: 'Isabella' });
    assert.strictEqual(r.status, 404);
});

/* ══ 3. Efterladt firma ═══════════════════════════════════════════════ */

test('et tomt personligt firma lægges væk når kontakten flytter', async () => {
    const r = await api('PATCH', '/api/customers/3', { company_id: IUNO });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.company_cleanup.deactivated, [PERSONAL]);
    assert.strictEqual(comp(PERSONAL).is_active, 0, 'spøgelset er lagt væk');
});

test('et personligt firma med en bon fredes — reglen gentjekkes', async () => {
    const r = await api('PATCH', '/api/customers/4', { company_id: IUNO });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.company_cleanup.deactivated, []);
    assert.deepStrictEqual(r.body.company_cleanup.skipped, [PERSONAL_WITH_BON]);
    assert.strictEqual(comp(PERSONAL_WITH_BON).is_active, 1, 'firmaet med bon står');
});

test('et RIGTIGT firma forsvinder aldrig som bivirkning af at en kontakt flyttes', async () => {
    // Jessica er den eneste kontakt på IUNO. Flyttes hun væk, står firmaet tomt
    // — men det er tastet af et menneske og skal blive. Oprydning af rigtige
    // firmaer er en bevidst handling i CRM → Værktøjer, ikke en bivirkning.
    const r = await api('PATCH', '/api/customers/2', { company_id: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.company_cleanup, null, 'oprydningen kørte slet ikke');
    assert.strictEqual(comp(IUNO).is_active, 1, 'IUNO står stadig');
});

test('en ren navneændring rører ikke firmaet', async () => {
    const r = await api('PATCH', '/api/customers/3', { first_name: 'Persona II' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.company_cleanup, null);
    assert.strictEqual(comp(PERSONAL).is_active, 1);
});

/* ══ 4. source-mærkning ═══════════════════════════════════════════════ */

function seedUnmatched(fromEmail, fromName) {
    return Number(_testDb.prepare(`
        INSERT INTO mail_unmatched (mailbox, message_id, from_email, from_name, subject, body_text, received_at, status)
        VALUES ('kontakt@ristetrug.dk', ?, ?, ?, 'Bestilling til event', 'Hej Ristet Rug', datetime('now'), 'open')
    `).run('<' + Math.random() + '@test>', fromEmail, fromName).lastInsertRowid);
}

test('et lead oprettet fra en mail mærker adressen "mail", ikke "manual"', async () => {
    const umId = seedUnmatched('isabella@nyt-firma.dk', 'Isabella');
    const r = await api('POST', `/api/mail/unmatched/${umId}/create-lead`, {});
    assert.strictEqual(r.status, 200);

    const rows = cps(r.body.customer_id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value, 'isabella@nyt-firma.dk');
    assert.strictEqual(rows[0].source, 'mail',
        'adressen ER mailens afsender — mærkes den manual, lader flytningen den blive');
});

test('den lærte adresse følger med når tråden flyttes til den rigtige kunde', async () => {
    // Hele grunden til at mærkningen betyder noget: uden source='mail' bliver
    // adressen på leadet, og kundens næste mail lander samme forkerte sted.
    const umId = seedUnmatched('isabella@nyt-firma.dk', 'Isabella');
    const lead = await api('POST', `/api/mail/unmatched/${umId}/create-lead`, {});
    const leadId = lead.body.customer_id;
    const threadId = lead.body.thread_id;

    const move = await api('POST', `/api/mail/threads/${threadId}/move`, { customer_id: 2 });
    assert.strictEqual(move.status, 200);
    assert.strictEqual(move.body.moved_addresses.length, 1, 'præcis én adresse fulgte med');
    assert.strictEqual(move.body.moved_addresses[0].email, 'isabella@nyt-firma.dk');
    assert.strictEqual(move.body.moved_addresses[0].added, true);

    const paaLeadet = cps(leadId).find(c => c.value === 'isabella@nyt-firma.dk');
    assert.strictEqual(paaLeadet.is_active, 0, 'fjernet fra leadet (deaktiveret, ikke slettet)');

    const paaJessica = cps(2).find(c => c.value === 'isabella@nyt-firma.dk');
    assert.ok(paaJessica, 'adressen står nu på den rigtige kunde');
    assert.strictEqual(paaJessica.is_active, 1);
});

test('en manuelt indtastet adresse flyttes stadig ikke — den står nogen inde for', async () => {
    // Kontrolprøven. Havde rettelsen bare fjernet source-filteret i
    // moveThreadOwner, ville en indtastet fakturaadresse kunne rives væk.
    const umId = seedUnmatched('bogholder@iuno.law', 'Bogholderiet');
    const lead = await api('POST', `/api/mail/unmatched/${umId}/create-lead`, {});
    const leadId = lead.body.customer_id;
    _testDb.prepare(
        `UPDATE contact_points SET source='manual' WHERE entity_type='customer' AND entity_id=?`
    ).run(leadId);

    const move = await api('POST', `/api/mail/threads/${lead.body.thread_id}/move`, { customer_id: 2 });
    assert.strictEqual(move.status, 200);

    const paaLeadet = cps(leadId).find(c => c.value === 'bogholder@iuno.law');
    assert.strictEqual(paaLeadet.is_active, 1, 'den indtastede adresse blev IKKE fjernet');
});

test('ensureContactPoint mærker stadig manual som default — lead-import er urørt', () => {
    const { ensureContactPoint } = require('../services/leadCreate');
    ensureContactPoint(_testDb, 'customer', 2, 'email', 'indtastet@iuno.law');
    const row = cps(2).find(c => c.value === 'indtastet@iuno.law');
    assert.strictEqual(row.source, 'manual');
});

test('en adresse der allerede findes beholder sin mærkning', () => {
    // Vi opgraderer aldrig et menneskes indtastning til et systemgæt.
    const { ensureContactPoint } = require('../services/leadCreate');
    ensureContactPoint(_testDb, 'customer', 2, 'email', 'indtastet@iuno.law');
    ensureContactPoint(_testDb, 'customer', 2, 'email', 'indtastet@iuno.law', 'mail');
    const rows = cps(2).filter(c => c.value === 'indtastet@iuno.law');
    assert.strictEqual(rows.length, 1, 'ingen dublet');
    assert.strictEqual(rows[0].source, 'manual');
});

/* ══ 5. Sagen fra drift, hele vejen ═══════════════════════════════════ */

test('drifts-sagen: leadet bliver til Isabella under IUNO, og spøgelset ryddes', async () => {
    // Sådan som den faktisk så ud: RFM-batchen havde nået at give leadet et
    // personligt firma med det gættede navn.
    _testDb.prepare('UPDATE customers SET company_id = ? WHERE id = 1').run(PERSONAL_LEAD);

    const r = await api('PATCH', '/api/customers/1', {
        first_name: 'Isabella', company_id: IUNO,
    });
    assert.strictEqual(r.status, 200);

    const c = cust(1);
    assert.strictEqual(c.first_name, 'Isabella');
    assert.strictEqual(c.company_id, IUNO);
    assert.strictEqual(c.email, 'communication@iuno.law', 'adressen følger personen');
    assert.strictEqual(comp(PERSONAL_LEAD).is_active, 0, 'det gættede firmanavn er ikke længere i kartoteket');

    // Og hun står nu ved siden af kollegaen under samme firma
    const underIuno = _testDb.prepare(
        'SELECT first_name FROM customers WHERE company_id = ? AND is_active = 1 ORDER BY first_name'
    ).all(IUNO).map(r => r.first_name);
    assert.deepStrictEqual(underIuno, ['Isabella', 'Jessica']);
});
