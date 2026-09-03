// tests/standing_discount.test.js
// ============================================================
// Den stående kunderabat: kan rettes, kan hentes igen, rammer ikke gebyrer.
//
// Baggrund (målt på Ables bogførte fakturaer, sep. 2026): e-conomics egen
// prisgruppe fyrer IKKE gennem API'et — 12,5 % kom med på manuelt oprettede
// fakturaer og 0 % på vores udkast til samme kunde. Rabatten skal derfor komme
// fra bon. To ting spærrede:
//
//   1. `bons_seed_standing_discount` (migration 111) fyrer kun ved INSERT, så en
//      rabat aftalt i dag ramte aldrig de bons der allerede lå i køen.
//   2. `offer_discount_percent` stod ikke i PATCH-allowlisten, så en forkert sats
//      kunne hverken rettes fra skærmen eller API'et.
//
// Det kostede to kreditnotaer i august (faktura 4150 → 4177 → 4178, og
// 4161 → 4179 → 4180), hvor eneste ændring var 12 % lagt på hver linje i hånden.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en kolonne
// der flytter sig får testen til at fejle i stedet for at bestå mod en kopi.
//
// Kør: node --experimental-sqlite --test tests/standing_discount.test.js
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
    // Able med stående rabat + et almindeligt firma uden (kontrolgruppen).
    db.prepare('INSERT INTO companies (id, name, discount_percent, economic_customer_id) VALUES (?,?,?,?)')
      .run(1, 'Able', 12.5, '733');
    db.prepare('INSERT INTO companies (id, name) VALUES (?,?)').run(2, 'Stromma Danmark A/S');
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)').run(1, 'Maikenn', 1);
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)').run(2, 'Info', 2);
    // Privatkunde med egen sats — triggeren har en anden gren for den.
    db.prepare('INSERT INTO customers (id, first_name, discount_percent) VALUES (?,?,?)').run(3, 'Privat', 5);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/api/bons', require('../routes/bons'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function req(method, url, body) {
    const res = await fetch(baseUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** En bon oprettet DIREKTE i basen — altså gennem triggeren, som i drift. */
function makeBon({ companyId = null, customerId = null, id = 1, number = 'B4184' } = {}) {
    const statusId = _testDb.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
    const locId = _testDb.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    _testDb.prepare(`INSERT INTO bons (id, bon_number, status_id, location_id, company_id, customer_id,
                                       order_date, delivery_date, payment_type)
                     VALUES (?,?,?,?,?,?,date('now'),date('now'),'invoice')`)
        .run(id, number, statusId, locId, companyId, customerId);
    _testDb.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit_price, line_total)
                     VALUES (?,?,?,?,?,?)`).run(id, 'Kyllingen', '01 Sandwich', 10, 100, 1000);
    // Totalen regnes som i drift. Uden den ville total_price være NULL, og
    // enhver påstand om beløb ville måle fixturen frem for koden.
    require('../db/helpers').recalcBonTotal(_testDb, id);
    return id;
}
const pctOf = (id) => _testDb.prepare('SELECT offer_discount_percent AS p FROM bons WHERE id=?').get(id).p;
const totalOf = (id) => _testDb.prepare('SELECT total_price AS t FROM bons WHERE id=?').get(id).t;

// ─────────────────────────────────────────────────────────────
// A. Snapshot-adfærden — den vi IKKE ændrer
// ─────────────────────────────────────────────────────────────

test('triggeren kopierer firmaets sats ved oprettelsen', () => {
    makeBon({ companyId: 1, customerId: 1 });
    assert.equal(pctOf(1), 12.5);
});

test('en sats aftalt EFTER oprettelsen rammer ikke bonen af sig selv', () => {
    _testDb.prepare('UPDATE companies SET discount_percent = 0 WHERE id = 1').run();
    makeBon({ companyId: 1, customerId: 1 });
    assert.equal(pctOf(1), 0, 'ingen rabat ved oprettelsen');

    _testDb.prepare('UPDATE companies SET discount_percent = 12.5 WHERE id = 1').run();
    assert.equal(pctOf(1), 0, 'bonen er stadig 0 — det er hele problemet');
});

// ─────────────────────────────────────────────────────────────
// B. Rabatten kan hentes igen
// ─────────────────────────────────────────────────────────────

test('hent-igen henter firmaets sats og regner totalen om', async () => {
    _testDb.prepare('UPDATE companies SET discount_percent = 0 WHERE id = 1').run();
    makeBon({ companyId: 1, customerId: 1 });
    _testDb.prepare('UPDATE companies SET discount_percent = 12.5 WHERE id = 1').run();

    const r = await req('POST', '/api/bons/1/reapply-discount');
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, true);
    assert.equal(r.body.discount_percent, 12.5);
    assert.equal(pctOf(1), 12.5);
    // 1000 kr linjesum − 12,5 % = 875. Beløbet skal flytte sig — ellers beviser
    // procenten ingenting.
    assert.equal(totalOf(1), 875);
});

test('hent-igen på en bon der allerede har den rigtige sats ændrer intet', async () => {
    makeBon({ companyId: 1, customerId: 1 });
    const r = await req('POST', '/api/bons/1/reapply-discount');
    assert.equal(r.body.changed, false);
    assert.equal(pctOf(1), 12.5);
});

test('firmaet vinder over personen — samme prioritet som triggeren', async () => {
    _testDb.prepare('UPDATE customers SET discount_percent = 5 WHERE id = 1').run();
    _testDb.prepare('UPDATE companies SET discount_percent = 0 WHERE id = 1').run();
    makeBon({ companyId: 1, customerId: 1 });
    _testDb.prepare('UPDATE companies SET discount_percent = 12.5 WHERE id = 1').run();

    await req('POST', '/api/bons/1/reapply-discount');
    assert.equal(pctOf(1), 12.5, 'firmaets 12,5 — ikke personens 5');
});

test('privatkunde uden firma får sin egen sats', async () => {
    makeBon({ customerId: 3 });
    _testDb.prepare('UPDATE bons SET offer_discount_percent = 0 WHERE id = 1').run();
    await req('POST', '/api/bons/1/reapply-discount');
    assert.equal(pctOf(1), 5);
});

test('hent-igen nulstiller når den stående rabat er fjernet', async () => {
    makeBon({ companyId: 1, customerId: 1 });
    assert.equal(pctOf(1), 12.5);
    _testDb.prepare('UPDATE companies SET discount_percent = 0 WHERE id = 1').run();

    const r = await req('POST', '/api/bons/1/reapply-discount');
    assert.equal(r.body.discount_percent, 0);
    assert.equal(pctOf(1), 0);
    assert.equal(totalOf(1), 1000, 'totalen er tilbage på linjesummen');
});

test('hent-igen skriver en changelog-linje med begrundelsen', async () => {
    _testDb.prepare('UPDATE companies SET discount_percent = 0 WHERE id = 1').run();
    makeBon({ companyId: 1, customerId: 1 });
    _testDb.prepare('UPDATE companies SET discount_percent = 12.5 WHERE id = 1').run();
    await req('POST', '/api/bons/1/reapply-discount');

    const row = _testDb.prepare(`SELECT * FROM changelog
        WHERE entity_type='bon' AND entity_id=1 AND field_name='offer_discount_percent'
        ORDER BY id DESC LIMIT 1`).get();
    assert.ok(row, 'der er en changelog-linje');
    assert.equal(row.new_value, '12.5');
    assert.match(row.notes || '', /Able/, 'noten siger hvor satsen kom fra');
});

test('ukendt bon giver 404, ikke en tavs no-op', async () => {
    const r = await req('POST', '/api/bons/999/reapply-discount');
    assert.equal(r.status, 404);
});

// ─────────────────────────────────────────────────────────────
// C. Rabatten kan rettes — og valideres hvor den skrives
// ─────────────────────────────────────────────────────────────

test('rabatten kan sættes med PATCH og totalen følger med', async () => {
    makeBon({ companyId: 2, customerId: 2 });
    assert.equal(pctOf(1), 0);

    const r = await req('PATCH', '/api/bons/1', { offer_discount_percent: 20 });
    assert.equal(r.status, 200);
    assert.equal(pctOf(1), 20);
    assert.equal(totalOf(1), 800);
});

test('rabatten kan nulstilles igen', async () => {
    makeBon({ companyId: 1, customerId: 1 });
    await req('PATCH', '/api/bons/1', { offer_discount_percent: 0 });
    assert.equal(pctOf(1), 0);
    assert.equal(totalOf(1), 1000);
});

test('en negativ sats afvises — den ville lægge TIL fakturaen', async () => {
    makeBon({ companyId: 2, customerId: 2 });
    const r = await req('PATCH', '/api/bons/1', { offer_discount_percent: -5 });
    assert.equal(r.status, 400);
    assert.equal(pctOf(1), 0, 'intet skrevet');
});

test('100 % og derover afvises — det er ikke en rabat', async () => {
    makeBon({ companyId: 2, customerId: 2 });
    for (const v of [100, 250]) {
        const r = await req('PATCH', '/api/bons/1', { offer_discount_percent: v });
        assert.equal(r.status, 400, `${v} afvises`);
    }
    assert.equal(pctOf(1), 0);
});

test('vrøvl afvises frem for at blive til 0 i stilhed', async () => {
    makeBon({ companyId: 1, customerId: 1 });
    const r = await req('PATCH', '/api/bons/1', { offer_discount_percent: 'tolv' });
    assert.equal(r.status, 400);
    assert.equal(pctOf(1), 12.5, 'den rigtige sats står urørt');
});

// ─────────────────────────────────────────────────────────────
// D. Kontrolgruppen — alt andet er uændret
// ─────────────────────────────────────────────────────────────

test('et firma uden stående rabat får stadig ingen', () => {
    makeBon({ companyId: 2, customerId: 2 });
    assert.equal(pctOf(1), 0);
    assert.equal(totalOf(1), 1000, 'hele linjesummen — intet trukket fra');
});

test('triggerens rabat slår igennem i totalen', () => {
    makeBon({ companyId: 1, customerId: 1 });
    assert.equal(totalOf(1), 875);
});

test('et andet felt i samme PATCH regner ikke rabatten om', async () => {
    makeBon({ companyId: 1, customerId: 1 });
    const før = totalOf(1);
    await req('PATCH', '/api/bons/1', { pax: 25 });
    assert.equal(pctOf(1), 12.5);
    assert.equal(totalOf(1), før);
});
