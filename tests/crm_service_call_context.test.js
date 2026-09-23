// tests/crm_service_call_context.test.js
// ============================================================
// Service-kald-listen: kontekst før man ringer.
//
// Når man ringer rundt, er spørgsmålene "har vi talt med dem før, hvordan gik
// det, og hvor langt væk er de?". Svarene lå kun i Kunde 360°. Nu leverer
// GET /api/crm/service-calls dem pr. række, og GET /customer/:id/activities
// giver den korte historik bag "▼ historik".
//
// Skemaet bygges af de RIGTIGE migrations i :memory:.
// Kør: node --experimental-sqlite --test tests/crm_service_call_context.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;
require('../shared/sse').broadcast = () => {};

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const { todayISO, offsetISO } = require('../db/helpers');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value = '55.69' WHERE key = 'delivery_hq_lat'").run();
    db.prepare("UPDATE settings SET value = '12.55' WHERE key = 'delivery_hq_lon'").run();
    const lev = db.prepare("SELECT id FROM status_definitions WHERE code = 'LEVERET'").get().id;

    // Firma 1 med tre kontakter (Anna ringes op, Bo og Cecilie er kolleger).
    db.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Instituttet');
    // Firma 2 er personligt — ingen kolleger, selv om der ligger en anden række på det.
    db.prepare('INSERT INTO companies (id, name, is_personal) VALUES (2, ?, 1)').run('Privat');
    const cust = db.prepare('INSERT INTO customers (id, first_name, last_name, company_id) VALUES (?,?,?,?)');
    cust.run(1, 'Anna', 'A', 1);
    cust.run(2, 'Bo', 'B', 1);
    cust.run(3, 'Cecilie', 'C', 1);
    cust.run(4, 'Dan', 'D', 2);
    cust.run(5, 'Eva', 'E', 2);

    const addr = db.prepare('INSERT INTO addresses (id, street_name, postal_code, city, lat, lon) VALUES (?,?,?,?,?,?)');
    addr.run(1, 'Vej', '2200', 'København N', 55.70, 12.56);   // har ORS-cache
    addr.run(2, 'Vej', '4000', 'Roskilde', 55.64, 12.08);      // kun koordinater
    db.prepare("INSERT INTO geo_calculations (address_id, distance_meters, duration_seconds) VALUES (1, 3456, 600)").run();

    const loc = db.prepare('SELECT id FROM locations LIMIT 1').get().id;
    const bon = db.prepare(`INSERT INTO bons (id, bon_number, status_id, customer_id, company_id, delivery_date,
        delivery_type, delivery_address_id, is_internal, location_id, order_date) VALUES (?,?,?,?,?,?,?,?,0,${loc},'2026-01-01')`);
    const d = offsetISO(-1);
    bon.run(1, 'B1', lev, 1, 1, d, 'delivery', 1);
    bon.run(2, 'B2', lev, 4, 2, d, 'delivery', 2);
    bon.run(3, 'B3', lev, 5, 2, d, 'pickup', 2);
    bon.run(9, 'B9', lev, 1, 1, offsetISO(-60), 'delivery', 1);  // gammel bon, uden for listen

    const act = db.prepare(`INSERT INTO crm_activities (customer_id, bon_id, type, sentiment, text, created_at, done_at, due_at)
        VALUES (?,?,?,?,?,?,?,?)`);
    // Anna: en neutral samtale for længe siden, en positiv senere (done_at vinder over created_at).
    act.run(1, null, 'call', 'neutral', 'Gammel', '2026-01-01 10:00:00', '2026-01-01 10:00:00', null);
    act.run(1, null, 'note', 'positive', 'Glad', '2025-12-01 10:00:00', '2026-03-01 10:00:00', null);
    // Aktivitet kun på Annas gamle bon (customer_id NULL) — skal tælle med.
    act.run(null, 9, 'service_call', null, 'Via bon', '2026-02-01 10:00:00', '2026-02-01 10:00:00', null);
    // Planlagt opfølgning — ikke en samtale.
    act.run(1, null, 'followup', null, 'Ring igen', '2026-04-01 10:00:00', null, '2099-01-01 10:00:00');
    // Kollega Bo var sur.
    act.run(2, null, 'call', 'negative', 'Sur', '2026-05-01 10:00:00', '2026-05-01 10:00:00', null);
    // Eva (samme personlige firma som Dan) — må IKKE vises hos Dan.
    act.run(5, null, 'call', 'positive', 'Eva', '2026-05-01 10:00:00', '2026-05-01 10:00:00', null);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1 } }; next(); });
app.use('/api/crm', require('../routes/crm'));
app.use('/api/campaigns', require('../routes/campaigns'));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const row = (rows, n) => rows.find(r => r.bon_number === n) || {};

test('egen stemning: nyeste efter done_at', async () => {
    const { body } = await get('/api/crm/service-calls?days=7');
    const a = row(body, 'B1');
    assert.strictEqual(a.last_sentiment, 'positive');
    assert.strictEqual(a.last_sentiment_at, '2026-03-01 10:00:00');
});

test('aktiviteter tæller bon-aktiviteter med, men ikke planlagte', async () => {
    const { body } = await get('/api/crm/service-calls?days=7');
    const a = row(body, 'B1');
    assert.strictEqual(a.activity_count, 3);
    assert.strictEqual(a.last_contact_type, 'note');
});

test('kollegaens stemning leveres med navn', async () => {
    const { body } = await get('/api/crm/service-calls?days=7');
    const a = row(body, 'B1');
    assert.strictEqual(a.colleague_sentiment, 'negative');
    assert.strictEqual(a.colleague_sentiment_by, 'Bo B');
    assert.strictEqual(a.colleague_activity_count, 1);
});

test('personligt firma har ingen kolleger', async () => {
    const { body } = await get('/api/crm/service-calls?days=7');
    const d = row(body, 'B2');
    assert.strictEqual(d.colleague_sentiment, null);
    assert.strictEqual(d.colleague_activity_count, 0);
    assert.strictEqual(d.activity_count, 0);
});

test('afstand: cache giver vejafstand, ellers skøn, afhentning ingen', async () => {
    const { body } = await get('/api/crm/service-calls?days=7');
    const a = row(body, 'B1'), d = row(body, 'B2'), e = row(body, 'B3');
    assert.strictEqual(a.distance_km, 3.5);
    assert.strictEqual(a.distance_estimated, false);
    assert.strictEqual(a.delivery_postal_code, '2200');
    assert.ok(d.distance_km > 30 && d.distance_km < 50, 'Roskilde ca. 30-50 km, fik ' + d.distance_km);
    assert.strictEqual(d.distance_estimated, true);
    assert.strictEqual(e.distance_km, null);
});

test('/customer/:id/activities: egne + kolleger, mærket, planlagt markeret', async () => {
    const { status, body } = await get('/api/crm/customer/1/activities?limit=10');
    assert.strictEqual(status, 200);
    const texts = body.map(a => a.text);
    assert.ok(texts.includes('Via bon'), 'bon-aktivitet med');
    assert.ok(texts.includes('Sur'), 'kollega med');
    assert.ok(!texts.includes('Eva'));
    assert.strictEqual(body.find(a => a.text === 'Sur').is_colleague, true);
    assert.strictEqual(body.find(a => a.text === 'Glad').is_colleague, false);
    assert.strictEqual(body.find(a => a.text === 'Ring igen').is_planned, true);
    assert.strictEqual(body[0].text, 'Ring igen', 'planlagt (fremtidig) øverst');
});

test('/customer/:id/activities: personligt firma viser ikke naboens', async () => {
    const { body } = await get('/api/crm/customer/4/activities');
    assert.deepStrictEqual(body, []);
});

// ── Samme kontekst på ringelisten og kampagne-tavlen ─────────────────
const { enrichContactContext } = require('../services/crmContactContext');

test('ringeliste-rækker: kundens SENESTE leveringsadresse, ikke en afhentning', () => {
    // Anna (1) har kun B1 (adresse 1, cache 3,5 km) og B9 (samme). Dan (4): B2 Roskilde.
    const rows = [{ customer_id: 1 }, { customer_id: 4 }, { customer_id: 5 }];
    enrichContactContext(_testDb, rows);
    assert.strictEqual(rows[0].distance_km, 3.5);
    assert.strictEqual(rows[0].last_sentiment, 'positive');
    assert.strictEqual(rows[1].distance_estimated, true);
    // Eva har kun en afhentning (B3) → ingen leveringsadresse at måle til.
    assert.strictEqual(rows[2].distance_km, null);
});

test('customerKey: sovende-rækken bærer kunden som primary_customer_id', () => {
    const rows = [{ company_id: 1, primary_customer_id: 1 }];
    enrichContactContext(_testDb, rows, { customerKey: 'primary_customer_id' });
    assert.strictEqual(rows[0].activity_count, 3);
    assert.strictEqual(rows[0].last_sentiment, 'positive');
});

test('fallbackAddressKey: firma uden kontaktperson får firmaets adresse', () => {
    const rows = [{ customer_id: null, company_address_id: 2 }];
    enrichContactContext(_testDb, rows, { fallbackAddressKey: 'company_address_id' });
    assert.ok(rows[0].distance_km > 30, 'Roskilde');
    assert.strictEqual(rows[0].activity_count, 0);
});

test('rækkens egen stemning overskrives ikke', () => {
    const rows = [{ customer_id: 4, last_sentiment: 'neutral', last_sentiment_at: 'x' }];
    enrichContactContext(_testDb, rows);
    assert.strictEqual(rows[0].last_sentiment, 'neutral');
});

test('kampagne-pipeline: kortet bærer kontekst, og medlemmets egen last_activity_at står urørt', async () => {
    _testDb.prepare("INSERT INTO outreach_campaigns (id, name) VALUES (1, 'Jul')").run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, customer_id, member_status, last_activity_at)
        VALUES (1, 1, 1, 'lead', '2020-01-01 00:00:00')`).run();
    const { status, body } = await get('/api/campaigns/pipeline?campaign_id=1');
    assert.strictEqual(status, 200);
    const m = body.columns.lead.members[0];
    assert.strictEqual(m.last_activity_at, '2020-01-01 00:00:00');
    assert.strictEqual(m.activity_count, 3);
    assert.strictEqual(m.last_sentiment, 'positive');
    assert.strictEqual(m.distance_km, 3.5);
});

test('kolde tilbud: tilbuddets egen adresse', async () => {
    const loc = _testDb.prepare('SELECT id FROM locations LIMIT 1').get().id;
    const tilbud = _testDb.prepare("SELECT id FROM status_definitions WHERE code = 'TILBUD'").get();
    _testDb.prepare(`INSERT INTO bons (id, bon_number, status_id, customer_id, company_id, delivery_date, delivery_type,
        delivery_address_id, is_internal, location_id, order_date, is_offer, offer_status, offer_valid_until, total_price)
        VALUES (50, 'T-50', ?, 1, 1, ?, 'delivery', 2, 0, ?, '2026-01-01', 1, 'sent', ?, 1000)`)
        .run(tilbud.id, offsetISO(-20), loc, offsetISO(-10));
    // Datoen ligger FØR Annas seneste levering (B1, i Kbh), så "seneste adresse"
    // ville give 3,5 km — kun tilbuddets egen adresse giver Roskilde.
    const { status, body } = await get('/api/crm/cold-offers');
    assert.strictEqual(status, 200);
    const r = body.find(x => x.bon_id === 50);
    assert.ok(r, 'tilbuddet står på listen');
    // Anna leverer normalt i Kbh (3,5 km), men tilbuddet er i Roskilde.
    assert.ok(r.distance_km > 30, 'fik ' + r.distance_km);
    assert.strictEqual(r.activity_count, 3);
});
