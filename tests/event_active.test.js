// tests/event_active.test.js
// ============================================================
// GET /webhook/event-active — "hvilket event tages der imod
// forudbestillinger til lige nu?"
//
// Findes fordi koblingen før lå i event-order-3's egen konfigurationsfil
// (`bonV2.eventId`): et nyt event krævede opret i Bon → kopiér id → redigér
// fil på en anden server → deploy. Nu erklærer eventet det selv.
//
// Kernepåstanden: vi gætter ALDRIG. Er der ikke præcis ét, siger vi hvad vi
// fandt — et forkert valg ville lægge kundernes forudbestillinger på det
// forkerte event, og det ville se helt rigtigt ud.
//
// Kør: node --experimental-sqlite --test tests/event_active.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;
require('../shared/sse').broadcast = () => {};

const bridge = require('../routes/event-bridge');
const { todayISO, offsetISO } = require('../db/helpers');
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

let server, base;

function freshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    return db;
}

function makeEvent(db, { id, name, start, end = null, enabled = 1, status = 'active' }) {
    const loc = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO events (id, name, location_id, start_date, end_date, status, event_order_enabled)
                VALUES (?,?,?,?,?,?,?)`).run(id, name, loc, start, end, status, enabled);
}

test.before(async () => {
    _testDb = freshDb();
    const app = express();
    app.use(express.json());
    app.use('/webhook', bridge);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server?.close());

const get = async (secret) => {
    const r = await fetch(base + '/webhook/event-active', { headers: secret ? { 'x-webhook-secret': secret } : {} });
    return { status: r.status, body: await r.json().catch(() => ({})) };
};
const clear = () => _testDb.prepare('DELETE FROM events').run();

/* ══════════════════════════════════════════════════════════ */

test('intet event med fluebenet → null med en anvisning, ikke en fejl', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Uden forudbestilling', start: todayISO(), enabled: 0 });
    const { status, body } = await get();
    assert.equal(status, 200, 'broen skal kunne spørge uden at få en fejl i hovedet');
    assert.equal(body.event_id, null);
    assert.equal(body.reason, 'none');
    assert.match(body.hint, /flueben/i, 'sig hvad man skal gøre');
});

test('præcis ét event med fluebenet → det event', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Uden', start: todayISO(), enabled: 0 });
    makeEvent(_testDb, { id: 2, name: 'Vig Festival', start: todayISO(), end: offsetISO(2) });
    const { body } = await get();
    assert.equal(body.event_id, 2);
    assert.equal(body.name, 'Vig Festival');
});

test('to events med fluebenet → ambiguous, aldrig et gæt', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'A', start: todayISO() });
    makeEvent(_testDb, { id: 2, name: 'B', start: todayISO() });
    const { body } = await get();
    assert.equal(body.event_id, null);
    assert.equal(body.reason, 'ambiguous');
    assert.deepEqual(body.candidates.map(c => c.name), ['A', 'B'], 'sig hvilke, så det kan rettes');
});

test('et afsluttet event tæller ikke — forudbestillingerne er forbi', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'I går', start: offsetISO(-5), end: offsetISO(-1) });
    assert.equal((await get()).body.event_id, null);
});

test('et event der kører NU tæller — der kan stadig bestilles til i morgen', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Kører', start: offsetISO(-1), end: offsetISO(1) });
    assert.equal((await get()).body.event_id, 1);
});

test('et kommende event tæller — forudbestilling åbner før eventet', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Om en måned', start: offsetISO(30), end: offsetISO(31) });
    assert.equal((await get()).body.event_id, 1);
});

test('et aflyst event tæller ikke, selv med fluebenet', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Aflyst', start: todayISO(), status: 'cancelled' });
    assert.equal((await get()).body.event_id, null);
});

test('nærmeste event vælges når kun ét er aktivt ad gangen', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Senere', start: offsetISO(60), end: offsetISO(61) });
    assert.equal((await get()).body.event_id, 1);
});

test('hemmeligheden håndhæves når den er sat', async () => {
    clear();
    makeEvent(_testDb, { id: 1, name: 'Vig', start: todayISO() });
    _testDb.prepare("UPDATE settings SET value = 'hemmelig' WHERE key = 'event_bridge_secret'").run();
    assert.equal((await get()).status, 401, 'uden hemmelighed');
    assert.equal((await get('forkert')).status, 401, 'med forkert hemmelighed');
    assert.equal((await get('hemmelig')).body.event_id, 1);
    _testDb.prepare("UPDATE settings SET value = '' WHERE key = 'event_bridge_secret'").run();
});
