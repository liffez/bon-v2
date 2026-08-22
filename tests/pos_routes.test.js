// tests/pos_routes.test.js
// ============================================================
// HTTP-laget for /api/pos. Kører ruterne som de faktisk kaldes — mod en rigtig
// migreret database og en indsat session.
//
// Findes fordi service-testene ikke rører routeren: produktkoblingen gemte
// koblingen og fejlede DEREFTER på `changelog.entity_id NOT NULL`, så den var
// gemt uden at slå igennem på bonnen. Halvt udført er værre end slet ikke
// udført, og det så man kun ved at kalde endpointet.
//
// Kør: node --experimental-sqlite --test tests/pos_routes.test.js
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

// Grocy må ikke kaldes i en unit-test — ruterne skal tåle at den ikke svarer,
// men her giver vi dem et fast sæt så koblingen kan efterprøves.
const grocy = require('../services/grocyAdapter');
const RECIPES = [
    { id: 11, name: 'Fisken', category: '01 Sandwich', cost_price: 24.0, co2e: 0.5, unit: 'stk' },
];
grocy.getRecipes = async () => RECIPES;

const posRouter = require('../routes/pos');
const { normalizePurchase } = require('../services/zettleAdapter');
const posSync = require('../services/posSync');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zettle/purchases_festival.json'), 'utf8')).purchases;

let server, base;

test.before(async () => {
    _testDb = new DatabaseSync(':memory:');
    _testDb.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        _testDb.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    _testDb.prepare("UPDATE settings SET value = '1' WHERE key = 'zettle_enabled'").run();
    const loc = _testDb.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    _testDb.prepare(`INSERT INTO events (id, name, location_id, start_date, end_date, status, pos_enabled)
                     VALUES (1, 'Testfestival', ?, '2026-08-14', '2026-08-15', 'active', 1)`).run(loc);

    await posSync.syncPos(_testDb, {
        adapter: { isConfigured: () => true, getPurchases: async () => RAW.map(normalizePurchase) },
        from: '2026-08-13', to: '2026-08-16',
        deps: { getRecipes: async () => RECIPES, todayISO: () => '2026-08-16', offsetISO: () => '2026-08-13' },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
    app.use('/api/pos', posRouter);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => { server?.close(); });

const api = async (method, p, body) => {
    const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
};

/* ══════════════════════════════════════════════════════════ */

test('GET /days viser dagene med beløb, bon og ukoblede varer', async () => {
    const { status, body } = await api('GET', '/api/pos/days');
    assert.equal(status, 200);
    const d = body.days.find(x => x.business_date === '2026-08-14');
    assert.ok(d.gross_incl > 0);
    assert.ok(d.bon_number, 'bonnen skal kunne ses fra listen');
    assert.equal(d.assign_status, 'auto');
    assert.ok(Array.isArray(d.unmatched));
});

test('GET /days/:date har kandidat-events, så en glemt kobling kan rettes', async () => {
    const { status, body } = await api('GET', '/api/pos/days/2026-08-14');
    assert.equal(status, 200);
    assert.ok(body.candidate_events.some(e => e.id === 1));
    assert.ok(body.purchases.length > 0, 'købene skal med — de driver timekurven');
});

test('GET /days/:date afviser en dato der ikke er en dato', async () => {
    assert.equal((await api('GET', '/api/pos/days/14-08-2026')).status, 400);
    assert.equal((await api('GET', '/api/pos/days/2026-01-01')).status, 404);
});

test('GET /unmatched lister varer uden Grocy-kobling', async () => {
    const { body } = await api('GET', '/api/pos/unmatched');
    assert.ok(body.products.some(p => /hotdog/i.test(p.name)));
});

test('POST /products/map gemmer koblingen OG bygger dagen om', async () => {
    // Regressionen: koblingen blev gemt og kaldet fejlede derefter, så linjen
    // på bonnen aldrig blev opdateret.
    const before = (await api('GET', '/api/pos/unmatched')).body.products;
    const hotdog = before.find(p => /hotdog/i.test(p.name));

    const { status, body } = await api('POST', '/api/pos/products/map', {
        pos_product_uuid: hotdog.product_uuid, grocy_recipe_id: 11, name: hotdog.name,
    });
    assert.equal(status, 200, 'kaldet må ikke fejle efter at have skrevet');
    assert.equal(body.grocy_recipe_id, 11);
    assert.ok(body.rebuilt_days.length > 0, 'de berørte dage skal bygges om med det samme');

    const day = (await api('GET', '/api/pos/days/2026-08-14')).body;
    const bon = _testDb.prepare('SELECT * FROM bon_lines WHERE bon_id = ?').all(day.bon_id);
    const line = bon.find(l => /hotdog/i.test(l.product_name));
    assert.equal(line.grocy_recipe_id, 11, 'koblingen skal stå på bon-linjen');
    assert.equal(line.category, '01 Sandwich');
    assert.equal(line.cost_price, 24.0);
    assert.equal(day.unmatched.some(u => /hotdog/i.test(u.name)), false);

    // Og changelog-linjen skal faktisk være skrevet (det var dén der fejlede).
    const log = _testDb.prepare("SELECT * FROM changelog WHERE entity_type = 'pos_product' ORDER BY id DESC LIMIT 1").get();
    assert.ok(log, 'beslutningen skal kunne spores');
    assert.ok(log.entity_id, 'entity_id er NOT NULL — koblingens egen række er id\'et');
});

test('POST /products/map: null betyder "findes ikke i Grocy"', async () => {
    const p = (await api('GET', '/api/pos/unmatched')).body.products.find(x => x.product_uuid);
    const { status } = await api('POST', '/api/pos/products/map',
        { pos_product_uuid: p.product_uuid, grocy_recipe_id: null, name: p.name });
    assert.equal(status, 200);
    const after = (await api('GET', '/api/pos/unmatched')).body.products;
    assert.equal(after.some(x => x.product_uuid === p.product_uuid), false,
        'en afklaret vare skal ikke blive ved med at stå som uafklaret');
});

test('POST /products/map validerer input', async () => {
    assert.equal((await api('POST', '/api/pos/products/map', {})).status, 400);
    assert.equal((await api('POST', '/api/pos/products/map',
        { pos_product_uuid: 'x', grocy_recipe_id: 'ikke-et-tal' })).status, 400);
});

test('POST /days/:date/assign afviser at fjerne koblingen mens bonnen findes', async () => {
    const { status, body } = await api('POST', '/api/pos/days/2026-08-14/assign', { event_id: null });
    assert.equal(status, 409);
    assert.equal(body.code, 'bon_exists');
});

test('POST /days/:date/assign afviser et event der ikke findes', async () => {
    const { status, body } = await api('POST', '/api/pos/days/2026-08-14/assign', { event_id: 9999 });
    assert.equal(status, 404);
    assert.equal(body.code, 'unknown_event');
});

test('POST /sync tager et valgfrit datointerval — ellers står gamle events uden for vinduet', async () => {
    // Den automatiske hentning dækker kun `zettle_resync_days` bagud. Skal et
    // event fra i forgårs hentes ind første gang, må intervallet kunne angives.
    assert.equal((await api('POST', '/api/pos/sync', { from: '14-08-2026', to: '2026-08-15' })).status, 400);
    assert.equal((await api('POST', '/api/pos/sync', { from: '2026-08-13', to: 'i går' })).status, 400);
});

test('GET /health svarer også når integrationen ikke kan nå Zettle', async () => {
    const { status, body } = await api('GET', '/api/pos/health');
    assert.equal(status, 200, 'et panel der ikke kan vises, skjuler en død integration');
    assert.equal(body.enabled, true);
    assert.ok('unassigned_days' in body);
    assert.ok(body.connection, 'forbindelsens tilstand skal med — også når den er dårlig');
});

test('ruterne kræver login', async () => {
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/pos', posRouter);            // ingen session
    const s2 = http.createServer(app2);
    await new Promise(r => s2.listen(0, r));
    const r = await fetch('http://127.0.0.1:' + s2.address().port + '/api/pos/days');
    assert.equal(r.status, 401);
    s2.close();
});
