// tests/customer_close.test.js
// ============================================================
// Fjern en kontaktperson fra et firma.
//
// Baggrunden er konkret: Danner-firmaet står med 15 kontaktpersoner, hvoraf
// flere er dubletter — "Ida Devald" findes både med ida@danner.dk og med
// ida@danner.dl (tastefejl i domænet), Eline Østergaard står to gange, og
// "anne møller" bærer en hotmail-adresse. Ingen af dem kunne fjernes.
//
// Årsagen: customers.is_active har eksisteret siden 001 og filtreres på i hver
// eneste CRM-liste, men INGEN skærm kunne sætte den til 0. Kun scripts og
// merge-guiden kunne lukke en række.
//
// "Fjern" dækker to forskellige ting, og de har hver sit udfald:
//   • stoppet i firmaet → company_id = null (findes allerede som PATCH)
//   • forkert oprettet  → is_active = 0
//
// Kernepåstandene:
//   1. En kontakt kan lukkes, og rækken slettes ALDRIG.
//   2. Hendes bons beholder navnet — lukningen rører ikke historikken.
//   3. Kontaktpunkterne lukkes med, så mail-routingen holder op med at finde
//      hende. (2 og 3 er hele grunden til at lukning er sikker.)
//   4. Et efterladt PERSONLIGT firma lægges væk; et rigtigt firma røres ikke.
//   5. Gendan åbner præcis de punkter vi selv lukkede — men ikke en adresse
//      en anden kunde har overtaget imens, for så ville findCustomerByEmail
//      blive tvetydig.
//   6. "Stoppet i firmaet" skriver den rigtige begrundelse i changeloggen.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, og alt går
// gennem de ægte endpoints over HTTP.
//
// Kør: node --experimental-sqlite --test tests/customer_close.test.js
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

const DANNER = 20;          // rigtigt firma med flere kontakter — må aldrig forsvinde
const PERSONAL = 21;        // auto-oprettet af ensurePersonalCompanies (services/rfm.js)
// Et RIGTIGT firma der endnu ikke har handlet — oprettet med CVR via "+ Nyt
// firma", men uden bons, noter eller e-conomic-nummer. Det er præcis her
// is_personal-vagten bærer: uden den ville deaktiveringsreglen finde firmaet
// tomt og lukke det, fordi CVR ikke er et af dens værn.
const NYT_FIRMA = 22;

const HIBAQ = 1;            // kontakt MED en bon — sagen fra driften
const DUBLET = 2;           // kontakt uden noget på sig
const KOLLEGA = 3;          // skal blive tilbage så firmaet ikke står tomt
const PRIVAT = 4;           // sidder på et personligt firma
const ANDEN = 5;            // overtager adressen mens HIBAQ er lukket
const ENESTE = 6;           // eneste kontakt under NYT_FIRMA

const { findCustomerByEmail } = require('../services/mailService');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }

    db.prepare('INSERT INTO companies (id, name, cvr) VALUES (?,?,?)')
      .run(DANNER, 'Danner', '89030811');
    db.prepare('INSERT INTO companies (id, name, is_personal) VALUES (?,?,1)')
      .run(PERSONAL, 'Privat Persson');
    db.prepare('INSERT INTO companies (id, name, cvr) VALUES (?,?,?)')
      .run(NYT_FIRMA, 'Nyt Firma ApS', '12345678');

    db.prepare('INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (?,?,?,?,?)')
      .run(HIBAQ, 'Hibaq', 'Musa French', 'hib@danner.dk', DANNER);
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (?,?,?,?,?)')
      .run(DUBLET, 'Ida', 'Devald', 'ida@danner.dl', DANNER);
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (?,?,?,?,?)')
      .run(KOLLEGA, 'Anne', 'Zacho', 'azm@danner.dk', DANNER);
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)')
      .run(PRIVAT, 'Persson', PERSONAL);
    db.prepare('INSERT INTO customers (id, first_name, last_name, company_id) VALUES (?,?,?,?)')
      .run(ANDEN, 'Sara', 'Hornum', DANNER);
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)')
      .run(ENESTE, 'Eneste', NYT_FIRMA);

    // Kontaktpunkter — det er DEM mail-routingen slår op i
    db.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_primary, is_active)
                VALUES ('customer', ?, 'email', 'hib@danner.dk', 'manual', 1, 1)`).run(HIBAQ);
    db.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_primary, is_active)
                VALUES ('customer', ?, 'phone', '30788291', 'manual', 1, 1)`).run(HIBAQ);

    // Hibaqs bon — den skal stå urørt efter lukningen
    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
    db.prepare(`INSERT INTO bons (bon_number, customer_id, company_id, location_id,
                                  order_date, delivery_date, delivery_type, status_id, pax)
                VALUES ('T-CLOSE-1', ?, ?, 1, date('now'), '2026-03-07', 'delivery', ?, 12)`)
      .run(HIBAQ, DANNER, statusId);

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
app.use('/api/crm', require('../routes/crm'));

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
    `SELECT * FROM contact_points WHERE entity_type='customer' AND entity_id=? ORDER BY id`
).all(cid);
const closeLog = cid => _testDb.prepare(
    `SELECT * FROM changelog WHERE entity_type='customer' AND entity_id=? AND field_name='is_active' ORDER BY id`
).all(cid);

/* ══ 1. Lukning ═══════════════════════════════════════════════════════ */

test('kontaktpersonen lukkes — og slettes aldrig', async () => {
    const r = await api('DELETE', '/api/customers/' + HIBAQ, { reason: 'dublet' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.closed, true);

    const c = cust(HIBAQ);
    assert.ok(c, 'rækken findes stadig — lukning er is_active = 0, ikke DELETE');
    assert.strictEqual(c.is_active, 0);
    assert.strictEqual(c.first_name, 'Hibaq', 'navnet er urørt');
});

test('bonnen beholder kundenavnet — historikken er urørt', async () => {
    await api('DELETE', '/api/customers/' + HIBAQ, {});
    // Præcis det join alle bon-visninger bruger: ingen filtrerer på is_active.
    const row = _testDb.prepare(`
        SELECT b.bon_number, c.first_name, c.last_name
          FROM bons b LEFT JOIN customers c ON b.customer_id = c.id
         WHERE b.bon_number = 'T-CLOSE-1'
    `).get();
    assert.strictEqual(row.first_name, 'Hibaq');
    assert.strictEqual(row.last_name, 'Musa French');
});

test('kontaktpunkterne lukkes med, så mailen ikke længere rammer hende', async () => {
    // Før: adressen finder hende
    assert.strictEqual(findCustomerByEmail(_testDb, 'hib@danner.dk')?.id, HIBAQ);

    const r = await api('DELETE', '/api/customers/' + HIBAQ, {});
    assert.strictEqual(r.body.contact_points_closed, 2, 'både mail og telefon');

    for (const cp of cps(HIBAQ)) {
        assert.strictEqual(cp.is_active, 0);
        assert.strictEqual(cp.is_primary, 0);
    }
    // Efter: ingen. findCustomerByEmail filtrerer på BEGGE niveauer, så et
    // åbent punkt på en lukket kunde ville stadig kunne route en mail hertil.
    assert.strictEqual(findCustomerByEmail(_testDb, 'hib@danner.dk'), null);
});

test('svaret siger hvad der hang på rækken, så bekræftelsen kan sige det', async () => {
    const pre = await api('GET', '/api/customers/' + HIBAQ + '/content');
    assert.strictEqual(pre.status, 200);
    assert.strictEqual(pre.body.counts.bons, 1);
    assert.strictEqual(pre.body.is_active, true);

    const r = await api('DELETE', '/api/customers/' + HIBAQ, {});
    assert.strictEqual(r.body.counts.bons, 1, 'samme opslag som bekræftelsen brugte');
});

test('lukningen skrives i changeloggen med grunden', async () => {
    await api('DELETE', '/api/customers/' + HIBAQ, { reason: 'fjernet fra Danner' });
    const rows = closeLog(HIBAQ);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].old_value, '1');
    assert.strictEqual(rows[0].new_value, '0');
    assert.strictEqual(rows[0].user_id, 1, 'brugeren kommer fra sessionen');
    assert.match(rows[0].notes || '', /fjernet fra Danner/);

    const payload = JSON.parse(rows[0].payload);
    assert.strictEqual(payload.closed_contact_points.length, 2);
    assert.strictEqual(payload.counts.bons, 1);
});

test('en allerede lukket kontakt afvises', async () => {
    await api('DELETE', '/api/customers/' + HIBAQ, {});
    const r = await api('DELETE', '/api/customers/' + HIBAQ, {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /allerede lukket/i);
});

test('en ukendt kunde giver 404', async () => {
    const r = await api('DELETE', '/api/customers/9999', {});
    assert.strictEqual(r.status, 404);
});

/* ══ 2. Firmaet ═══════════════════════════════════════════════════════ */

test('et RIGTIGT firma røres ikke når en kontakt lukkes', async () => {
    await api('DELETE', '/api/customers/' + HIBAQ, {});
    assert.strictEqual(comp(DANNER).is_active, 1);
    assert.strictEqual(_events.at(-1).name, 'customer_updated');
});

test('selv den SIDSTE kontakt tager ikke et rigtigt firma med sig', async () => {
    for (const id of [HIBAQ, DUBLET, KOLLEGA, ANDEN]) {
        await api('DELETE', '/api/customers/' + id, {});
    }
    assert.strictEqual(comp(DANNER).is_active, 1,
        'et rigtigt firma må aldrig forsvinde som bivirkning — dertil findes "Ryd tomme firmaer"');
});

test('et ubrugt RIGTIGT firma bliver stående selv når dets eneste kontakt lukkes', async () => {
    // Firmaet har hverken bons, noter eller e-conomic-nummer, så
    // deaktiveringsreglen ville finde det tomt — CVR er ikke et af dens værn.
    // is_personal-vagten er det eneste der holder det i live.
    const r = await api('DELETE', '/api/customers/' + ENESTE, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.company_cleanup, null, 'firmaet blev slet ikke vurderet');
    assert.strictEqual(comp(NYT_FIRMA).is_active, 1);
});

test('et efterladt PERSONLIGT firma lægges væk', async () => {
    const r = await api('DELETE', '/api/customers/' + PRIVAT, {});
    assert.deepStrictEqual(r.body.company_cleanup.deactivated, [PERSONAL]);
    assert.strictEqual(comp(PERSONAL).is_active, 0);
});

/* ══ 3. Gendan ════════════════════════════════════════════════════════ */

test('gendan åbner kunden og præcis de punkter vi selv lukkede', async () => {
    // Et punkt der ALLEREDE var lukket før — det må gendan ikke åbne
    _testDb.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_active)
                     VALUES ('customer', ?, 'email', 'gammel@danner.dk', 'manual', 0)`).run(HIBAQ);

    await api('DELETE', '/api/customers/' + HIBAQ, {});
    const r = await api('POST', '/api/customers/' + HIBAQ + '/restore');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(cust(HIBAQ).is_active, 1);

    const aktive = cps(HIBAQ).filter(p => p.is_active === 1).map(p => p.value).sort();
    assert.deepStrictEqual(aktive, ['30788291', 'hib@danner.dk']);
    assert.strictEqual(
        cps(HIBAQ).find(p => p.value === 'gammel@danner.dk').is_active, 0,
        'et punkt der lå lukket i forvejen bliver liggende');

    // Primær-flaget sættes tilbage — ellers ville kundens visning miste sin
    // primære adresse uden at nogen rørte den.
    assert.strictEqual(cps(HIBAQ).find(p => p.value === 'hib@danner.dk').is_primary, 1);
    assert.strictEqual(findCustomerByEmail(_testDb, 'hib@danner.dk')?.id, HIBAQ);
});

test('en adresse en ANDEN kunde har overtaget imens åbnes ikke igen', async () => {
    await api('DELETE', '/api/customers/' + HIBAQ, {});
    // #478 lærer adressen på en anden kunde, fordi den er fri nu
    _testDb.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_primary, is_active)
                     VALUES ('customer', ?, 'email', 'hib@danner.dk', 'mail', 1, 1)`).run(ANDEN);

    const r = await api('POST', '/api/customers/' + HIBAQ + '/restore');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.contact_points_skipped.map(s => s.value), ['hib@danner.dk']);
    assert.strictEqual(r.body.contact_points_skipped[0].taken_by, ANDEN);

    assert.strictEqual(cps(HIBAQ).find(p => p.value === 'hib@danner.dk').is_active, 0,
        'to aktive ejere ville gøre findCustomerByEmail tvetydig');
    // Telefonen er ikke optaget og kommer med
    assert.deepStrictEqual(r.body.contact_points_reopened, ['30788291']);
    assert.strictEqual(findCustomerByEmail(_testDb, 'hib@danner.dk')?.id, ANDEN,
        'adressen peger entydigt på den kunde der har den nu');
});

test('gendan åbner det personlige firma vi selv lukkede med', async () => {
    await api('DELETE', '/api/customers/' + PRIVAT, {});
    assert.strictEqual(comp(PERSONAL).is_active, 0);

    const r = await api('POST', '/api/customers/' + PRIVAT + '/restore');
    assert.strictEqual(r.body.company_reopened, PERSONAL);
    assert.strictEqual(comp(PERSONAL).is_active, 1,
        'ellers stod kunden uden det firma hun havde før lukningen');
});

test('gendan af en aktiv kunde afvises', async () => {
    const r = await api('POST', '/api/customers/' + HIBAQ + '/restore');
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /ikke lukket/i);
});

/* ══ 4. "Stoppet i firmaet" ═══════════════════════════════════════════ */

test('den anden vej — kontakten tages af firmaet og bliver privatkunde', async () => {
    const r = await api('PATCH', '/api/customers/' + HIBAQ, { company_id: null });
    assert.strictEqual(r.status, 200);

    const c = cust(HIBAQ);
    assert.strictEqual(c.company_id, null);
    assert.strictEqual(c.is_active, 1, 'hun er stadig kunde — bare ikke hos Danner');
    assert.strictEqual(findCustomerByEmail(_testDb, 'hib@danner.dk')?.id, HIBAQ,
        'og modtager stadig mail');
});

test('changelog-noten siger det rigtige ved fjernelse fra firmaet', async () => {
    await api('PATCH', '/api/customers/' + HIBAQ, { company_id: null });
    const row = _testDb.prepare(
        `SELECT notes FROM changelog WHERE entity_type='customer' AND entity_id=? AND field_name='company_id'`
    ).get(HIBAQ);
    assert.match(row.notes, /fjernet fra firmaet/i,
        'ikke "flyttet til andet firma" — der er intet andet firma');
});

/* ══ 5. Firma 360°-listen ═════════════════════════════════════════════ */

test('en lukket kontakt forsvinder fra listen og dukker op under de lukkede', async () => {
    const før = await api('GET', '/api/crm/company/' + DANNER);
    assert.strictEqual(før.body.customers.length, 4);
    assert.deepStrictEqual(før.body.closed_customers, []);

    await api('DELETE', '/api/customers/' + DUBLET, {});

    const efter = await api('GET', '/api/crm/company/' + DANNER);
    assert.strictEqual(efter.body.customers.length, 3);
    assert.strictEqual(efter.body.closed_customers.length, 1);
    assert.match(efter.body.closed_customers[0].name, /Ida Devald/);
    assert.strictEqual(efter.body.aggregations.contact_count, 3,
        'tælleren i firma-headeren følger med');
});
