// tests/mail_sent_overview.test.js
// ============================================================
// Sendt-oversigten: "hvem har vi skrevet til i dag?"
//
// Simply gemmer ingen sendt-mappe, så Bons egen kopi (mail_messages med
// retning 'out') er det eneste sted svaret findes. GET /api/mail/sent skal:
//
//   1. Afgrænse til DANSK døgn — en mail kl. 00:30 dansk tid ligger på
//      gårsdagens UTC-dato og skal alligevel med i "i dag".
//   2. Holde leverandørmails ude (indkøbsordrer + s-tråde) — altid.
//   3. Skjule automatiske mails som standard (is_system ELLER ingen bruger),
//      men TÆLLE dem, så listen kan sige hvad den skjuler.
//   4. Vise en fejlet afsendelse som fejlet, ikke som sendt.
//   5. Kunne afgrænse til egne mails, kilde (bon@/kontakt@) og søgning.
//   6. Tage et interval (begge dage inklusive) og afvise vrøvl.
//   7. Give fanen samme tal som listen (sendt_idag).
//
// Skemaet bygges af de RIGTIGE migrations i :memory:, og alt går gennem de
// ægte endpoints over HTTP.
//
// Kør: node --experimental-sqlite --test tests/mail_sent_overview.test.js
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

const { todayISO, addDaysISO, copenhagenDayStartSql } = require('../db/helpers');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

const TODAY = todayISO();
const YDAY = addDaysISO(TODAY, -1);

// Dansk klokkeslæt på en dansk dato → UTC i databasens format.
function dk(date, hh, mm) {
    const start = copenhagenDayStartSql(date);
    const t = new Date(start.replace(' ', 'T') + 'Z').getTime() + (hh * 60 + mm) * 60000;
    return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// Besked-id'er gennem hele filen
const M = {
    kunde: 1, bon: 2, system: 3, cron: 4, leverandoer: 5, fejlet: 6,
    igaarSent: 7, natten: 8, indgaaende: 9, alarm: 10, kontakt: 11, indkoeb: 12,
};

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }

    const u1 = db.prepare('SELECT id, name FROM users WHERE id = 1').get();
    assert.ok(u1, 'migrationerne seeder bruger 1');
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (99, 'Anne Kontor', 'anne@example.com', 'office')").run();

    db.prepare("INSERT INTO companies (id, name) VALUES (20, 'Novo Nordisk')").run();
    db.prepare("INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (30, 'Lærke', 'Haumann', 'laerke@cap.dk', 20)").run();
    db.prepare("INSERT INTO customers (id, first_name, last_name, email) VALUES (31, 'Morten', 'Wulff', 'morten@example.com')").run();
    db.prepare("INSERT INTO suppliers (id, name) VALUES (40, 'Hørkram')").run();

    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='NY'").get().id;
    db.prepare(`INSERT INTO bons (id, bon_number, customer_id, company_id, location_id, order_date, delivery_date, delivery_type, status_id)
                VALUES (50, 'B4321', 31, NULL, 1, date('now'), ?, 'delivery', ?)`).run(TODAY, statusId);
    db.prepare(`INSERT INTO purchase_orders (id, supplier_id, location_id, status) VALUES (60, 40, 1, 'sent')`).run();

    const th = db.prepare(`INSERT INTO mail_threads (id, subject, bon_id, customer_id, supplier_id, purchase_order_id, handling_status)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`);
    th.run(100, 'Kunde-tråd', null, 30, null, null, 'afventer_kunde');
    th.run(101, 'Bon-tråd',   50, null, null, null, 'afventer_kunde');
    th.run(102, 'Leverandør', null, null, 40, null, null);
    th.run(103, 'Alarm',      null, null, null, null, null);
    th.run(104, 'Indkøb',     null, null, null, 60, null);   // som i drift: kun purchase_order_id

    const msg = db.prepare(`INSERT INTO mail_messages
        (id, thread_id, direction, from_email, to_email, subject, body_text, sent_at, created_at, created_by_user_id, is_system, send_error, received_at)
        VALUES (?, ?, ?, ?, ?, ?, 'brødtekst', ?, ?, ?, ?, ?, ?)`);
    const out = (id, thread, subj, at, user, opts = {}) => msg.run(
        id, thread, opts.dir || 'out', opts.from || 'bon@ristetrug.dk', opts.to || 'kunde@example.com', subj,
        opts.failed ? null : at, at, user, opts.system ? 1 : 0, opts.failed || null, opts.dir === 'in' ? at : null);

    out(M.kunde,       100, 'Tilbud på frokost',  dk(TODAY, 9, 15),  1, { to: 'laerke@cap.dk' });
    out(M.bon,         101, 'Ordrebekræftelse',   dk(TODAY, 10, 0),  99, { to: 'morten@example.com' });
    out(M.system,      100, 'Tak for din booking', dk(TODAY, 10, 5), 1, { system: true });
    out(M.cron,        100, 'Påmindelse',         dk(TODAY, 6, 0),   null);
    out(M.leverandoer, 102, 'Spørgsmål til Hørkram', dk(TODAY, 11, 0), 1, { to: 'salg@hoka.dk' });
    out(M.fejlet,      100, 'Opfølgning',         dk(TODAY, 12, 0),  1, { failed: 'SMTP 550 mailbox unavailable' });
    out(M.igaarSent,   100, 'Sen aftenmail',      dk(YDAY, 23, 30),  1);
    out(M.natten,      100, 'Natmail',            dk(TODAY, 0, 30),  1);
    out(M.indgaaende,  100, 'Svar fra kunden',    dk(TODAY, 13, 0),  null, { dir: 'in', from: 'laerke@cap.dk', to: 'kontakt@ristetrug.dk' });
    out(M.alarm,       103, 'Lagertræk fejlede',  dk(TODAY, 6, 5),   null, { to: 'leif@ristetrug.dk' });
    out(M.kontakt,     100, 'Fra kontakt@',       dk(TODAY, 14, 0),  1, { from: 'kontakt@ristetrug.dk' });
    out(M.indkoeb,     104, 'Bestilling',         dk(TODAY, 8, 0),   1, { to: 'ordre@hoka.dk' });
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
let _sessionUser = 1;
app.use((req, _res, next) => {
    req.session = _sessionUser ? { userId: _sessionUser, userRole: 'admin' } : {};
    next();
});
app.use('/api/mail', require('../routes/mail'));

let server, baseUrl;
test.before(async () => {
    await new Promise(r => { server = app.listen(0, r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => { _testDb = createFreshDb(); _sessionUser = 1; });

async function get(url) {
    const r = await fetch(baseUrl + url);
    return { status: r.status, body: await r.json() };
}
const ids = (body) => body.rows.map(r => r.id);

test('i dag: kun manuelle kundemails, nyeste først, dansk døgn', async () => {
    const { status, body } = await get('/api/mail/sent');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.from, TODAY);
    assert.strictEqual(body.to, TODAY);
    assert.deepStrictEqual(ids(body), [M.kontakt, M.fejlet, M.bon, M.kunde, M.natten],
        'nyeste øverst; natmailen kl. 00:30 dansk tid er med selvom den ligger på gårsdagens UTC-dato');
    assert.ok(!ids(body).includes(M.igaarSent), 'gårsdagens kl. 23:30 hører ikke til i dag');
    assert.strictEqual(body.total, 5);
});

test('leverandør- og indkøbsmails er aldrig med — heller ikke med automatiske', async () => {
    const { body } = await get('/api/mail/sent?auto=1');
    assert.ok(!ids(body).includes(M.leverandoer), 's-tråd udeladt');
    assert.ok(!ids(body).includes(M.indkoeb), 'indkøbsordre udeladt');
    assert.ok(!ids(body).includes(M.indgaaende), 'indgående mail er ikke sendt');
});

test('automatiske skjules, men tælles', async () => {
    const skjult = (await get('/api/mail/sent')).body;
    assert.strictEqual(skjult.hidden_auto, 3, 'booking-bekræftelse + påmindelse + alarm');
    for (const id of [M.system, M.cron, M.alarm]) assert.ok(!ids(skjult).includes(id));

    const alle = (await get('/api/mail/sent?auto=1')).body;
    assert.strictEqual(alle.hidden_auto, 0);
    assert.strictEqual(alle.total, 8);
    const sys = alle.rows.find(r => r.id === M.system);
    assert.strictEqual(sys.is_auto, true, 'is_system med sælgerens userId er stadig automatisk');
    const cron = alle.rows.find(r => r.id === M.cron);
    assert.strictEqual(cron.is_auto, true, 'uden afsender-bruger = automatisk');
    const alarm = alle.rows.find(r => r.id === M.alarm);
    assert.strictEqual(alarm.openable, false, 'en tråd uden kunde/bon kan ikke åbnes i indbakken');
    assert.strictEqual(alarm.link, null);
});

test('fejlet afsendelse står som fejlet', async () => {
    const { body } = await get('/api/mail/sent');
    const f = body.rows.find(r => r.id === M.fejlet);
    assert.strictEqual(f.sent, false);
    assert.match(f.error, /550/);
    assert.strictEqual(body.failed, 1);
    const ok = body.rows.find(r => r.id === M.kunde);
    assert.strictEqual(ok.sent, true);
    assert.strictEqual(ok.error, null);
});

test('rækken fortæller hvem, hvor og af hvem', async () => {
    const { body } = await get('/api/mail/sent');
    const k = body.rows.find(r => r.id === M.kunde);
    assert.strictEqual(k.recipient, 'Lærke Haumann');
    assert.strictEqual(k.company_name, 'Novo Nordisk');
    assert.strictEqual(k.to_email, 'laerke@cap.dk');
    assert.deepStrictEqual(k.link, { type: 'customer', id: 30, label: '#k-30' });
    assert.strictEqual(k.openable, true);
    assert.strictEqual(k.thread_id, 100);
    assert.strictEqual(k.src, 'bon');

    const b = body.rows.find(r => r.id === M.bon);
    assert.strictEqual(b.recipient, 'Morten Wulff', 'bon-tråd viser bonens kunde');
    assert.strictEqual(b.link.label, 'Bon B4321');
    assert.strictEqual(b.sent_by, 'Anne Kontor');

    assert.strictEqual(body.rows.find(r => r.id === M.kontakt).src, 'kontakt');
});

test('kun mine', async () => {
    _sessionUser = 99;
    const { body } = await get('/api/mail/sent?mine=1');
    assert.deepStrictEqual(ids(body), [M.bon]);
    assert.strictEqual(body.hidden_auto, 0, 'automatiske tælles også kun for mine');
});

test('kilde: bon@ og kontakt@', async () => {
    assert.deepStrictEqual(ids((await get('/api/mail/sent?mailbox=kontakt')).body), [M.kontakt]);
    const bon = ids((await get('/api/mail/sent?mailbox=bon')).body);
    assert.ok(!bon.includes(M.kontakt));
    assert.strictEqual(bon.length, 4);
});

test('søgning på kundenavn, firma, bonnummer og emne', async () => {
    assert.deepStrictEqual(ids((await get('/api/mail/sent?q=Haumann')).body).sort(), [M.kunde, M.fejlet, M.natten, M.kontakt].sort());
    assert.deepStrictEqual(ids((await get('/api/mail/sent?q=B4321')).body), [M.bon]);
    assert.deepStrictEqual(ids((await get('/api/mail/sent?q=Novo')).body).length, 4);
    assert.deepStrictEqual(ids((await get('/api/mail/sent?q=' + encodeURIComponent('Ordrebekræftelse'))).body), [M.bon]);
});

test('interval: i går alene, og i går + i dag', async () => {
    const igaar = (await get(`/api/mail/sent?from=${YDAY}&to=${YDAY}`)).body;
    assert.deepStrictEqual(ids(igaar), [M.igaarSent], 'natmailen fra 00:30 i dag hører ikke til i går');

    const begge = (await get(`/api/mail/sent?from=${YDAY}&to=${TODAY}`)).body;
    assert.strictEqual(begge.days, 2);
    assert.ok(ids(begge).includes(M.igaarSent) && ids(begge).includes(M.natten));
    assert.strictEqual(begge.total, 6);

    const byttet = (await get(`/api/mail/sent?from=${TODAY}&to=${YDAY}`)).body;
    assert.strictEqual(byttet.from, YDAY, 'omvendte datoer byttes');
    assert.strictEqual(byttet.total, 6);
});

test('vrøvl og for lange perioder afvises', async () => {
    assert.strictEqual((await get('/api/mail/sent?from=17-09-2026')).status, 400);
    assert.strictEqual((await get(`/api/mail/sent?from=2020-01-01&to=${TODAY}`)).status, 400);
    assert.strictEqual((await get(`/api/mail/sent?from=${addDaysISO(TODAY, -365)}&to=${TODAY}`)).status, 200, '366 dage er lige nok');
});

test('kun mine kræver login, og uden login er der intet', async () => {
    _sessionUser = null;
    assert.strictEqual((await get('/api/mail/sent')).status, 401);
});

test('fanens tal er listens tal', async () => {
    const counts = (await get('/api/mail/threads/counts')).body;
    const list = (await get('/api/mail/sent')).body;
    assert.strictEqual(counts.sendt_idag, list.total);
    assert.strictEqual(counts.sendt_idag, 5);
});
