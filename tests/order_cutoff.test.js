// tests/order_cutoff.test.js
// ============================================================
// Cut-off for offentlige bestillinger — håndhævet på SERVEREN.
//
// Baggrund (september 2026): deadline blev kun tjekket i browseren, og kun i
// det øjeblik kunden valgte datoen. `checkCutoff` aflæste klokken dér og satte
// knappens `disabled`-attribut; hverken submit-handleren eller serveren kiggede
// igen. En side der havde stået åben siden formiddagen kunne derfor sende en
// bestilling til næste dag kl. 20.54 — og et direkte POST spurgte ingen om noget.
//
// De to invarianter der holdes fast her:
//   1. Er deadline passeret, oprettes bonen IKKE — og kunden får det at vide.
//      En webhook der svarer "tak" uden at oprette noget er den værste udgang:
//      kunden tror maden kommer.
//   2. Kan deadline ikke beregnes troværdigt, slipper bestillingen IGENNEM.
//      En for sen ordre kan office nå at ringe om; en tabt opdager ingen.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, og begge
// webhooks rammes over HTTP — det er routens egen kode der efterprøves.
//
// Kør: npm run test:cutoff
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

const mailService = require('../services/mailService');
mailService.sendFromTemplate = async () => ({ ok: true });

const {
    CUTOFF_DEFAULTS, readCutoffConfig, cutoffMomentFor, danishWallClock, checkOrderTiming,
} = require('../services/orderCutoff');
const { todayISO, offsetISO } = require('../db/helpers');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function createFreshDb(settings = {}) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value='' WHERE key='webhook_secret'").run();
    const put = db.prepare(
        'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    for (const [k, v] of Object.entries(settings)) put.run(k, String(v));
    db.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Testfirma');
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (1,?,?,1)')
      .run('Caroline', 'caroline@test.dk');
    return db;
}

// Onsdag 16. september 2026, dansk sommertid. Deadline for torsdag den 17. var
// onsdag kl. 12 — det er præcis den bon der startede det hele.
const ONSDAG_1130 = new Date('2026-09-16T09:30:00Z'); // 11:30 dansk
const ONSDAG_1200 = new Date('2026-09-16T10:00:00Z'); // 12:00 dansk
const ONSDAG_1201 = new Date('2026-09-16T10:01:00Z'); // 12:01 dansk
const ONSDAG_2054 = new Date('2026-09-16T18:54:00Z'); // 20:54 dansk
const TORSDAG     = '2026-09-17';

const check = (db, iso, now, todayIso = '2026-09-16') =>
    checkOrderTiming(db, iso, { now, todayIso });

// ─────────────────────────────────────────────────────────────
// 1. Selve reglen
// ─────────────────────────────────────────────────────────────

test('drifts-sagen: bestilling kl. 20.54 til næste dag afvises', () => {
    const r = check(createFreshDb(), TORSDAG, ONSDAG_2054);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'cutoff_passed');
    assert.match(r.message, /2026-09-16 kl\. 12:00/);
});

test('samme bestilling kl. 11.30 slipper igennem', () => {
    assert.equal(check(createFreshDb(), TORSDAG, ONSDAG_1130).ok, true);
});

test('kl. 12.00 præcis er stadig rettidigt — "senest kl. 12" er inklusivt', () => {
    assert.equal(check(createFreshDb(), TORSDAG, ONSDAG_1200).ok, true);
});

test('kl. 12.01 er for sent', () => {
    assert.equal(check(createFreshDb(), TORSDAG, ONSDAG_1201).ok, false);
});

// Den her fanger en server der står i UTC. 10:30Z er 12:30 dansk — altså efter
// deadline — men ser ud som 10:30 hvis man bygger en Date i serverens egen
// tidszone. Uden Europe/Copenhagen-forankringen ville ordren blive accepteret,
// og alle ordrer mellem kl. 12 og 14 dansk ville slippe forbi.
test('deadline måles i dansk tid, ikke i serverens tidszone', () => {
    const db = createFreshDb();
    assert.equal(check(db, TORSDAG, new Date('2026-09-16T10:30:00Z')).ok, false, '12:30 dansk er for sent');
    assert.equal(check(db, TORSDAG, new Date('2026-09-16T09:30:00Z')).ok, true,  '11:30 dansk er rettidigt');
});

// Og her fanges DATO-delen. Ved midnat dansk er UTC stadig i går, så en
// deadline sent på dagen ville se ud som om den ikke var passeret endnu.
// Torsdag kl. 00.30 dansk er onsdag kl. 22.30 UTC; med deadline onsdag kl. 23
// er ordren for sen i Danmark og rettidig i UTC.
test('også datoen måles i dansk tid — midnat er det sted det går galt', () => {
    const db = createFreshDb({ 'bestilling.cutoff_time': '23' });
    const r = check(db, TORSDAG, new Date('2026-09-16T22:30:00Z'), '2026-09-17');
    assert.equal(r.ok, false, 'torsdag 00.30 dansk er efter deadline onsdag kl. 23');
});

test('tælle-dage springes over: levering mandag har deadline fredag', () => {
    // cutoff_days = mandag–fredag. Én åben dag før mandag 21/9 er fredag 18/9.
    const db = createFreshDb({ 'bestilling.cutoff_days': 'mon,tue,wed,thu,fri' });
    const cut = cutoffMomentFor('2026-09-21', readCutoffConfig(db));
    assert.deepEqual(cut, { date: '2026-09-18', time: '12:00' });
});

test('to åbne dage før levering', () => {
    const db = createFreshDb({ 'bestilling.cutoff_lead_days': '2', 'bestilling.cutoff_days': 'mon,tue,wed,thu,fri' });
    assert.deepEqual(cutoffMomentFor('2026-09-21', readCutoffConfig(db)), { date: '2026-09-17', time: '12:00' });
});

// ─────────────────────────────────────────────────────────────
// 2. Hastebestilling
// ─────────────────────────────────────────────────────────────

test('hastebestilling åbner dagen — også efter deadline', () => {
    const db = createFreshDb({ 'bestilling.cutoff_override_date': '2026-09-16' });
    const r = check(db, TORSDAG, ONSDAG_2054);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'hastebestilling');
});

test('hastebestilling fra en anden dag gælder ikke — den nulstiller sig selv', () => {
    const db = createFreshDb({ 'bestilling.cutoff_override_date': '2026-09-07' });
    assert.equal(check(db, TORSDAG, ONSDAG_2054).ok, false);
});

// ─────────────────────────────────────────────────────────────
// 3. Fejler åbent
// ─────────────────────────────────────────────────────────────

test('ulæseligt klokkeslæt falder tilbage til standarden i stedet for NaN', () => {
    // Browserens gamle fejl: `parseInt('tolv') != null` er sandt, så NaN blev
    // skrevet ind — og en NaN-deadline slår cut-off HELT fra.
    const db = createFreshDb({ 'bestilling.cutoff_time': 'tolv' });
    const cfg = readCutoffConfig(db);
    assert.equal(cfg.time, CUTOFF_DEFAULTS.time);
    assert.ok(cfg.problems.length, 'problemet skal rapporteres, ikke sluges');
    assert.equal(check(db, TORSDAG, ONSDAG_2054).ok, false, 'guarden virker stadig');
});

test('en ukendt ugedag erstatter HELE listen — den frafiltreres ikke', () => {
    // Frafiltrering ville fjerne tælle-dage, og færre tælle-dage rykker deadline
    // længere tilbage. Altså flere afviste ordrer af en tastefejl.
    const db = createFreshDb({ 'bestilling.cutoff_days': 'tuesday,wed' });
    const cfg = readCutoffConfig(db);
    assert.deepEqual([...cfg.cutoffDays], [...CUTOFF_DEFAULTS.cutoffDays]);
    assert.ok(cfg.problems.length);
});

test('tom liste over tælle-dage giver standarden — og hænger ikke', () => {
    const db = createFreshDb({ 'bestilling.cutoff_days': '' });
    assert.deepEqual([...readCutoffConfig(db).cutoffDays], [...CUTOFF_DEFAULTS.cutoffDays]);
});

test('cutoffMomentFor hænger ikke når ingen ugedag kan tælles', () => {
    // Funktionen er eksporteret og kan kaldes med hvad som helst. En uendelig
    // løkke her ville hænge hele bestillings-webhooken.
    assert.equal(cutoffMomentFor('2026-09-17', { leadDays: 1, cutoffDays: [], time: 12 }), null);
});

test('uforståelig leveringsdato accepteres i stedet for at blive afvist', () => {
    const db = createFreshDb();
    assert.equal(check(db, 'i morgen', ONSDAG_2054).ok, true);
    assert.equal(check(db, '', ONSDAG_2054).ok, true);
    assert.equal(check(db, null, ONSDAG_2054).ok, true);
});

test('dansk væg-ur formateres som sammenlignelige strenge', () => {
    const w = danishWallClock(ONSDAG_2054);
    assert.equal(w.date, '2026-09-16');
    assert.equal(w.time, '20:54');
});

// ─────────────────────────────────────────────────────────────
// 4. Begge webhooks, over HTTP
// ─────────────────────────────────────────────────────────────

const express = require('express');
const app = express();
app.use(express.json());
app.use('/webhook', require('../routes/web-orders'));
app.use('/api/webhooks', require('../routes/webhooks'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));

async function post(url, body) {
    const res = await fetch(baseUrl + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const bonCount = () => _testDb.prepare('SELECT COUNT(*) AS n FROM bons').get().n;

// Datoerne regnes ud fra dagen i dag, ikke skrevet fast: en fast dato ville
// begynde at fejle den dag den passerer.
const FOR_SENT = () => todayISO();      // deadline lå mindst i går kl. 12
const I_TIDE   = () => offsetISO(30);

function order(extra = {}) {
    return {
        first_name: 'Caroline', last_name: 'Rye Elkjær', email: 'caroline@test.dk',
        phone: '35440948', ordertype: 'catering', pax: '30',
        delivery_date: I_TIDE(), delivery_time: '15:00', ...extra,
    };
}
const legacy = (extra = {}) => ({
    f2: 'Caroline Rye Elkjær', f3: 'caroline@test.dk',
    f7_date: I_TIDE(), f7_time: '15:00', ...extra,
});

test('webhook: for sen bestilling afvises med 409 og en besked kunden kan læse', async () => {
    _testDb = createFreshDb();
    const r = await post('/webhook/bestilling', order({ delivery_date: FOR_SENT() }));
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'cutoff_passed');
    assert.match(r.body.message, /Deadline/);
    assert.equal(bonCount(), 0, 'ingen bon må være oprettet');
});

test('webhook: rettidig bestilling oprettes som før', async () => {
    _testDb = createFreshDb();
    const r = await post('/webhook/bestilling', order());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(bonCount(), 1);
});

test('webhook: hastebestilling lukker en for sen ordre ind', async () => {
    _testDb = createFreshDb({ 'bestilling.cutoff_override_date': todayISO() });
    const r = await post('/webhook/bestilling', order({ delivery_date: FOR_SENT() }));
    assert.equal(r.status, 200);
    assert.equal(bonCount(), 1);
});

test('webhook: ferielukket afvises nu synligt i stedet for et tavst "tak"', async () => {
    const dato = I_TIDE();
    _testDb = createFreshDb({
        'bestilling.closed_dates': JSON.stringify([{ from: dato, to: dato, label: 'Sommerferie' }]),
    });
    const r = await post('/webhook/bestilling', order({ delivery_date: dato }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'closed_period');
    assert.equal(bonCount(), 0);
});

test('webhook: honeypot svarer stadig 200 — sig ikke til en bot at den er fanget', async () => {
    _testDb = createFreshDb();
    const r = await post('/webhook/bestilling', order({ website: 'bot', delivery_date: FOR_SENT() }));
    assert.equal(r.status, 200);
    assert.equal(bonCount(), 0);
});

test('den gamle f-felt-formular håndhæver samme deadline', async () => {
    _testDb = createFreshDb();
    const sent = await post('/api/webhooks/bestilling', legacy({ f7_date: FOR_SENT() }));
    assert.equal(sent.status, 409);
    assert.equal(sent.body.code, 'cutoff_passed');
    assert.equal(bonCount(), 0);

    _testDb = createFreshDb();
    const ok = await post('/api/webhooks/bestilling', legacy());
    assert.equal(ok.status, 200);
    assert.equal(bonCount(), 1);
});
