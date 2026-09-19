// tests/stock_counts.test.js
// ============================================================
// Optællingen som objekt (#673, spec §14.4).
//
// Rammer de ÆGTE ruter over HTTP: /api/stock-counts og lagerkaldet
// /api/grocy/stock/:id/inventory. Grocy og prismodulet stubbes;
// stock_counts/lines/entries er rigtige tabeller bygget af de rigtige
// migrations.
//
// Kør: node --experimental-sqlite --test tests/stock_counts.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _db = null;
dbModule.getDb = () => _db;
require('../shared/sse').broadcast = () => {};

// ── Grocy-stub ──
// Hvidkål tælles i Antal (qu 3) og lagerføres i Kilo (qu 2): 1 stk = 0,8 kg.
const G = {};
function nulstilGrocy() {
    G.produkter = [
        { id: 5, name: 'Hvidkål', qu_id_stock: 2, qu_id_purchase: 2, active: '1' },
        { id: 6, name: 'Mayo', qu_id_stock: 2, qu_id_purchase: 2, active: '1' },
    ];
    G.konverteringer = [{ product_id: 5, from_qu_id: 3, to_qu_id: 2, factor: 0.8 }];
    G.lager = [];
    G.skrivFejl = null;
    G.uændret = false;
}
const grocyStub = {
    getProducts: async () => G.produkter.map(p => ({ ...p })),
    getQuantityUnitConversions: async () => G.konverteringer.map(c => ({ ...c })),
    setInventory: async (id, amount) => {
        if (G.skrivFejl) throw new Error(G.skrivFejl);
        G.lager.push({ id, amount });
        return { unchanged: G.uændret };
    },
};
const grocyPath = require.resolve('../services/grocyAdapter');
require.cache[grocyPath] = {
    id: grocyPath, filename: grocyPath, loaded: true,
    exports: new Proxy(grocyStub, { get: (t, k) => (k in t ? t[k] : async () => []) }),
};
require('../services/supplierPrices').priceForStock = async () => ({ price: null, reason: 'missing' });

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function nyDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(7, 'Køkken');
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(8, 'Kontor');
    const pu = db.prepare('INSERT INTO physical_units (id, grocy_location_id, name) VALUES (?, ?, ?)');
    pu.run(1, 2, 'KØL-1');
    pu.run(2, 2, 'KØL-2');
    pu.run(3, 4, 'FRYS-1');   // anden lokation
    return db;
}

let SESSION_USER = 7;
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: SESSION_USER, userRole: 'kitchen' }; next(); });
app.use('/api/grocy', require('../routes/grocy'));
app.use('/api/stock-counts', require('../routes/stock-counts'));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _db = nyDb(); nulstilGrocy(); SESSION_USER = 7; });

async function call(method, url, body) {
    const res = await fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const linjer = () => _db.prepare('SELECT * FROM stock_count_lines ORDER BY product_id, physical_unit_name').all();
const poster = (lineId) => _db.prepare('SELECT * FROM stock_count_entries WHERE line_id = ? ORDER BY id').all(lineId);
const optælling = (id) => _db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id);

async function start(body = { grocy_location_id: 2, physical_unit_id: 1, physical_unit_name: 'KØL-1' }) {
    const r = await call('POST', '/api/stock-counts', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
}

// Hvidkål talt i KØL-1: 3 stk (klienten påstår faktor 99 — serveren skal bruge sin egen 0,8).
function hvidkålCount(countId, extra = {}) {
    return Object.assign({
        id: countId, product_name: 'Hvidkål', expected_qty: 2,
        lines: [{ physical_unit_id: 1, physical_unit_name: 'KØL-1', stock_qty: 297, sort_index: 4,
                  entries: [{ qu_id: 3, qty: 3, factor_used: 99 }] }],
    }, extra);
}

// ── Start ──

test('Start opretter optællingen med bruger fra sessionen — aldrig fra body', async () => {
    const b = await start({ grocy_location_id: 2, physical_unit_id: 1, physical_unit_name: 'KØL-1', user_id: 99 });
    const c = optælling(b.count.id);
    assert.equal(c.user_id, 7);
    assert.equal(c.status, 'open');
    assert.equal(c.current_physical_unit_id, 1);
    assert.equal(c.grocy_location_id, 2);
    assert.deepEqual(b.others, []);
});

test('Start uden lokation afvises', async () => {
    const r = await call('POST', '/api/stock-counts', { physical_unit_id: 1 });
    assert.equal(r.status, 400);
});

// ── Samtidigheds-advarsel ──

test('en anden åben optælling på samme lokation advarer — med den fysiske enhed den står ved', async () => {
    const første = await start();
    SESSION_USER = 8;
    const anden = await start({ grocy_location_id: 2, physical_unit_id: 2, physical_unit_name: 'KØL-2' });
    assert.equal(anden.others.length, 1);
    assert.equal(anden.others[0].id, første.count.id);
    assert.equal(anden.others[0].physical_unit_name, 'KØL-1');
});

test('skifter tælleren chip, følger advarslen med', async () => {
    const første = await start();
    await call('PATCH', '/api/stock-counts/' + første.count.id, { physical_unit_id: 2, physical_unit_name: 'KØL-2' });
    const anden = await start();
    assert.equal(anden.others[0].physical_unit_name, 'KØL-2');
});

test('en anden lokation advarer ikke', async () => {
    await start();
    const anden = await start({ grocy_location_id: 4, physical_unit_id: 3, physical_unit_name: 'FRYS-1' });
    assert.deepEqual(anden.others, []);
});

test('en forladt (gammel) åben optælling advarer ikke', async () => {
    const første = await start();
    _db.prepare("UPDATE stock_counts SET started_at = datetime('now', '-13 hours') WHERE id = ?").run(første.count.id);
    const anden = await start();
    assert.deepEqual(anden.others, []);
});

test('en lukket optælling advarer ikke — og man advares ikke om sig selv ved genoptagelse', async () => {
    const første = await start();
    await call('POST', `/api/stock-counts/${første.count.id}/discard`);
    const anden = await start();
    assert.deepEqual(anden.others, []);
    const selv = await call('GET', `/api/stock-counts/open?grocy_location_id=2&exclude=${anden.count.id}`);
    assert.deepEqual(selv.body.others, []);
});

// ── Lagerkaldet: rettede varer ──

test('en rettet vare logges med serverens faktor, udfald og poster', async () => {
    const { count } = await start();
    const r = await call('POST', '/api/grocy/stock/5/inventory',
        { amount: 297, entries: [{ qu_id: 3, qty: 3, factor_used: 99 }], count: hvidkålCount(count.id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.log_error, undefined);
    assert.equal(G.lager[0].amount, 2.4, 'Grocy fik serverens sum');
    const [l] = linjer();
    assert.equal(l.outcome, 'corrected');
    assert.equal(l.stock_qty, 2.4, 'linjens mængde er serverens omregning, ikke klientens 297');
    assert.equal(l.expected_qty, 2);
    assert.equal(l.deviation_pct, 20);
    assert.equal(l.sort_index, 4);
    assert.equal(l.physical_unit_id, 1);
    assert.equal(l.product_name, 'Hvidkål');
    const [e] = poster(l.id);
    assert.equal(e.qu_id, 3);
    assert.equal(e.qty, 3);
    assert.equal(e.factor_used, 0.8, 'serverens faktor — aldrig klientens 99');
});

test('Grocy siger uændret → udfaldet er "unchanged", ikke "corrected"', async () => {
    const { count } = await start();
    G.uændret = true;
    await call('POST', '/api/grocy/stock/5/inventory',
        { amount: 2.4, entries: [{ qu_id: 3, qty: 3 }], count: hvidkålCount(count.id) });
    assert.equal(linjer()[0].outcome, 'unchanged');
});

test('fejler Grocy, logges intet — en rettelse der ikke skete, må ikke stå i historikken', async () => {
    const { count } = await start();
    G.skrivFejl = 'Grocy nede';
    const r = await call('POST', '/api/grocy/stock/5/inventory',
        { amount: 2.4, entries: [{ qu_id: 3, qty: 3 }], count: hvidkålCount(count.id) });
    assert.notEqual(r.status, 200);
    assert.equal(linjer().length, 0);
});

test('fejler loggen, vælter den ikke lagerrettelsen — men den siges i svaret', async () => {
    const { count } = await start();
    await call('POST', `/api/stock-counts/${count.id}/finish`);   // lukket → kan ikke få linjer
    const r = await call('POST', '/api/grocy/stock/5/inventory',
        { amount: 2.4, entries: [{ qu_id: 3, qty: 3 }], count: hvidkålCount(count.id) });
    assert.equal(r.status, 200);
    assert.equal(G.lager.length, 1, 'lageret blev rettet');
    assert.match(r.body.log_error, /lukket/);
    assert.equal(linjer().length, 0);
});

test('uden count i kaldet opfører lagerkaldet sig som før', async () => {
    const r = await call('POST', '/api/grocy/stock/5/inventory', { amount: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.log_error, undefined);
    assert.equal(r.body.logged, undefined);
    assert.equal(linjer().length, 0);
});

test('et nyt Gem-forsøg erstatter varens linjer i stedet for at lægge nye til', async () => {
    const { count } = await start();
    const body = { amount: 2.4, entries: [{ qu_id: 3, qty: 3 }], count: hvidkålCount(count.id) };
    await call('POST', '/api/grocy/stock/5/inventory', body);
    const igen = await call('POST', '/api/grocy/stock/5/inventory', body);
    assert.equal(igen.body.log_error, undefined, 'andet forsøg logges rent — ikke afvist af den unikke nøgle');
    assert.equal(igen.body.logged, 1);
    assert.equal(linjer().length, 1);
    assert.equal(_db.prepare('SELECT COUNT(*) n FROM stock_count_entries').get().n, 1);
});

// ── De øvrige udfald ──

test('uændret og lagerets-tal-beholdt logges også — at vi talte ER sket', async () => {
    const { count } = await start();
    const r = await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        { product_id: 5, product_name: 'Hvidkål', expected_qty: 2.4, outcome: 'unchanged',
          lines: [{ physical_unit_name: 'KØL-1', physical_unit_id: 1, stock_qty: 2.4, sort_index: 1,
                    entries: [{ qu_id: 3, qty: 3 }] }] },
        { product_id: 6, product_name: 'Mayo', expected_qty: 5, outcome: 'kept_stock',
          lines: [{ physical_unit_name: 'KØL-1', stock_qty: 4, sort_index: 2,
                    entries: [{ qu_id: 2, qty: 4 }] }] },
    ] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.errors, []);
    const [kål, mayo] = linjer();
    assert.equal(kål.outcome, 'unchanged');
    assert.equal(kål.deviation_pct, 0, 'en afvigelse på nul er en måling — den skal stå der');
    assert.equal(poster(kål.id)[0].factor_used, 0.8);
    assert.equal(mayo.outcome, 'kept_stock');
    assert.equal(poster(mayo.id)[0].factor_used, 1, 'også tælling i lager-enheden får en faktor (§15.11)');
    assert.equal(mayo.physical_unit_id, 1, 'enheden slås op på navnet når id mangler');
});

test('en vare talt i to fysiske enheder får to linjer — og ingen afvigelse pr. linje', async () => {
    const { count } = await start();
    await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        { product_id: 5, expected_qty: 3, outcome: 'failed', lines: [
            { physical_unit_name: 'KØL-1', physical_unit_id: 1, stock_qty: 1.6, entries: [{ qu_id: 3, qty: 2 }] },
            { physical_unit_name: 'KØL-2', physical_unit_id: 2, stock_qty: 0.5, entries: [{ qu_id: 2, qty: 0.5 }] },
        ] },
    ] });
    const ls = linjer();
    assert.equal(ls.length, 2);
    assert.deepEqual(ls.map(l => l.physical_unit_name), ['KØL-1', 'KØL-2']);
    assert.ok(ls.every(l => l.deviation_pct === null), 'Grocy kender ikke fordelingen mellem KØL-1 og KØL-2');
    assert.ok(ls.every(l => l.expected_qty === 3), 'forventet er hele varens tal');
    assert.ok(ls.every(l => l.outcome === 'failed'));
});

test('et enheds-id fra en anden lokation bruges ikke — enheden slås op på navnet', async () => {
    const { count } = await start();
    await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        { product_id: 6, outcome: 'unchanged', lines: [{ physical_unit_name: 'KØL-2', physical_unit_id: 3, stock_qty: 1 }] },
    ] });
    assert.equal(linjer()[0].physical_unit_id, 2);
});

test('en post der ikke kan omregnes, stopper kun sin egen vare — og siges i svaret', async () => {
    const { count } = await start();
    const r = await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        { product_id: 6, outcome: 'unchanged', lines: [{ physical_unit_name: 'KØL-1', stock_qty: 1,
          entries: [{ qu_id: 9, qty: 1 }] }] },
        { product_id: 5, outcome: 'unchanged', lines: [{ physical_unit_name: 'KØL-1', stock_qty: 0.8,
          entries: [{ qu_id: 3, qty: 1 }] }] },
    ] });
    assert.equal(r.body.errors.length, 1);
    assert.equal(r.body.errors[0].product_id, 6);
    assert.deepEqual(linjer().map(l => l.product_id), [5]);
});

test('et ukendt udfald afvises', async () => {
    const { count } = await start();
    const r = await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        { product_id: 5, outcome: 'gættet', lines: [{ physical_unit_name: 'KØL-1', stock_qty: 1 }] },
    ] });
    assert.equal(r.body.errors.length, 1);
    assert.equal(linjer().length, 0);
});

// ── Luk ──

test('finish sætter status og tidspunkt — og en lukket optælling genåbnes ikke af discard', async () => {
    const { count } = await start();
    const f = await call('POST', `/api/stock-counts/${count.id}/finish`);
    assert.equal(f.body.count.status, 'saved');
    assert.ok(f.body.count.finished_at);
    const d = await call('POST', `/api/stock-counts/${count.id}/discard`);
    assert.equal(d.body.count.status, 'saved');
});

test('ukendt optælling giver 404', async () => {
    assert.equal((await call('POST', '/api/stock-counts/999/finish')).status, 404);
    assert.equal((await call('POST', '/api/stock-counts/999/lines', { products: [{}] })).status, 404);
});

test('den aktive Grocy gemmes på optællingen', async () => {
    _db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_grocy_location_id', '1')").run();
    const { count } = await start();
    assert.equal(optælling(count.id).site_location_id, 1);
});

// ── Audit-scriptet ──

test('audit-scriptet viser optællingen, udfaldene og faktor-sporet', async () => {
    const { buildReport } = require('../scripts/audit-stock-counts');
    const { count } = await start();
    await call('POST', '/api/grocy/stock/5/inventory',
        { amount: 2.4, entries: [{ qu_id: 3, qty: 3 }], count: hvidkålCount(count.id) });
    await call('POST', `/api/stock-counts/${count.id}/lines`, { products: [
        // Forventet sat, så Mayo HAR en afvigelse — den skal udelukkes fordi
        // den er talt i lager-enheden, ikke fordi tallet mangler.
        { product_id: 6, product_name: 'Mayo', expected_qty: 5, outcome: 'unchanged', lines: [{ physical_unit_name: 'KØL-1', stock_qty: 4,
          entries: [{ qu_id: 2, qty: 4 }] }] },
    ] });
    await call('POST', `/api/stock-counts/${count.id}/finish`);
    const r = buildReport(_db, { days: 14 });
    assert.match(r, /Optællinger de seneste 14 dage: 1/);
    assert.match(r, /1 gemt/);
    assert.match(r, /2 linjer \(1 rettet, 1 uændret\)|2 linjer \(1 uændret, 1 rettet\)/);
    assert.match(r, /Intet at se efter/);
    assert.match(r, /Hvidkål\s+enhed 3 · faktor 0,8 · 1 gang · snit-afvigelse \+20 %/);
    assert.doesNotMatch(r, /Mayo\s+enhed/, 'tælling i lager-enheden er ikke et faktor-spor');
    const d = buildReport(_db, { countId: count.id });
    assert.match(d, /Hvidkål \[KØL-1\] · talt 2,4 · forventet 2 · afvigelse \+20 % · rettet/);
    assert.match(d, /3 × enhed 3 · faktor 0,8/);
});

test('audit-scriptet peger på det der er galt', async () => {
    const { buildReport } = require('../scripts/audit-stock-counts');
    const tom = await start();
    await call('POST', `/api/stock-counts/${tom.count.id}/finish`);
    const gammel = await start();
    _db.prepare("UPDATE stock_counts SET started_at = datetime('now', '-13 hours') WHERE id = ?").run(gammel.count.id);
    const r = buildReport(_db, { days: 14 });
    assert.match(r, new RegExp(`gemt uden linjer \\(#${tom.count.id}\\)`));
    assert.match(r, new RegExp(`åben i over 12 timer \\(#${gammel.count.id}\\)`));
});
