// tests/stamdata_spor.test.js
// ============================================================
// Stamdata-ændringer efterlader et spor i Bon (#666).
//
// Lageroversigtens ✎, optællingens ⋯ og prisfelterne skrev direkte til
// Grocy uden en linje i Bon. Da «kål» blev sat inaktiv, fik 13 bons
// `partial`, og intet i Bon sagde hvem eller hvornår (#645).
//
// Testen rammer de ÆGTE ruter over HTTP. Grocy og prismodulet stubbes;
// changelog er en rigtig tabel bygget af de rigtige migrations.
//
// Kør: node --experimental-sqlite --test tests/stamdata_spor.test.js
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

// ── Grocy-stub: ukendte funktioner er harmløse no-ops ──
const G = {};
function nulstilGrocy() {
    G.produkt = { id: 5, name: 'Kål', active: '1', location_id: '2', product_group_id: '4', default_best_before_days: '7' };
    G.userfields = { HverDag: '', LastCheckedAt: '2026-09-01T10:00:00Z' };
    G.skrevet = [];
    G.skrivFejl = null;
    G.læsFejl = null;
}
const grocyStub = {
    getProductFresh: async () => { if (G.læsFejl) throw new Error(G.læsFejl); return { ...G.produkt }; },
    getProductUserfieldsFresh: async () => { if (G.læsFejl) throw new Error(G.læsFejl); return { ...G.userfields }; },
    updateProduct: async (id, body) => { if (G.skrivFejl) throw new Error(G.skrivFejl); G.skrevet.push({ id, body }); },
    updateProductUserfields: async (id, body) => { if (G.skrivFejl) throw new Error(G.skrivFejl); G.skrevet.push({ id, body }); },
    getLocations: async () => [{ id: 2, name: 'Køl' }, { id: 3, name: 'Frys' }],
    getShoppingLocations: async () => [],
    getProductGroups: async () => [{ id: 4, name: 'Grønt' }],
    getQuantityUnits: async () => [],
    getProductBarcodes: async () => [{ id: 11, product_id: 5, barcode: '12345' }],
};
const grocyPath = require.resolve('../services/grocyAdapter');
require.cache[grocyPath] = {
    id: grocyPath, filename: grocyPath, loaded: true,
    exports: new Proxy(grocyStub, { get: (t, k) => (k in t ? t[k] : async () => []) }),
};

// ── Prismodulet: "før" og "efter" styres af testen ──
const sp = require('../services/supplierPrices');
const P = {};
function nulstilPriser() {
    P.kandidater = [
        { id: 11, barcode: '12345', stock_price: 20, is_preferred: true, is_estimate: false },
        { id: 12, barcode: '67890', stock_price: 18, is_preferred: false, is_estimate: false },
        { id: 13, barcode: 'OVERSLAG-5', stock_price: 15, is_preferred: false, is_estimate: true },
    ];
}
sp.priceForStock = async () => ({ price: 20, reason: 'preferred', reason_text: '', candidates: P.kandidater.map(c => ({ ...c })) });
sp.setBarcodeStockPrice = async (_g, id, p) => {
    const c = P.kandidater.find(x => x.id === id); c.stock_price = Number(p);
    return { last_price: Number(p), stock_price: Number(p) };
};
sp.setEstimatePrice = async (_g, _pid, p) => {
    const c = P.kandidater.find(x => x.is_estimate);
    if (p === null) return { price: null, barcode: 'OVERSLAG-5', removed: true };
    c.stock_price = Number(p); return { price: Number(p), barcode: 'OVERSLAG-5', removed: false };
};
sp.setPreferredBarcode = async (_g, _pid, bcId) => {
    P.kandidater.forEach(c => { c.is_preferred = c.id === bcId; });
};

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function nyDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(7, 'Anne');
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 7, userRole: 'kitchen' }; next(); });
app.use('/api/grocy', require('../routes/grocy'));
app.use('/api/purchasing', require('../routes/purchasing'));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _db = nyDb(); nulstilGrocy(); nulstilPriser(); });

async function put(url, body, kilde) {
    const headers = { 'Content-Type': 'application/json' };
    if (kilde) headers['X-Bon-Kilde'] = kilde;
    const res = await fetch(base + url, { method: 'PUT', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const spor = () => _db.prepare("SELECT * FROM changelog WHERE entity_type = 'grocy_product' ORDER BY id").all();

test('en ændring skrives med navne, bruger fra sessionen og skærmen den kom fra', async () => {
    const r = await put('/api/grocy/products/5', { location_id: 3, user_id: 99 }, 'lageroversigt');
    assert.equal(r.status, 200);
    assert.equal(G.skrevet.length, 1, 'Grocy fik ændringen');
    const rows = spor().filter(x => x.field_name === 'location_id');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].old_value, 'Køl', 'navnet, ikke id 2');
    assert.equal(rows[0].new_value, 'Frys');
    assert.equal(rows[0].user_id, 7, 'brugeren kommer fra sessionen — aldrig fra body');
    assert.match(rows[0].notes, /fra lageroversigten/);
    assert.equal(rows[0].entity_id, 5);
});

test('et felt der ikke ændrer sig, logges ikke — heller ikke når Grocy skriver 1 som "1"', async () => {
    const r = await put('/api/grocy/products/5', { active: 1, location_id: '2' });
    assert.equal(r.status, 200);
    assert.equal(r.body.logget, 0);
    assert.equal(spor().length, 0);
});

test('kål-sagen: active 1 → 0 fra optællingen står i sporet', async () => {
    await put('/api/grocy/products/5', { active: 0 }, 'optaelling');
    const [row] = spor();
    assert.equal(row.field_name, 'active');
    assert.equal(row.old_value, '1');
    assert.equal(row.new_value, '0');
    assert.match(row.notes, /fra optællingen/);
});

test('observationer (LastCheckedAt) logges ikke — kun beslutninger', async () => {
    const r = await put('/api/grocy/products/5/userfields',
        { LastCheckedAt: '2026-09-18T09:00:00Z', HverDag: '7', hk_brand: 'X' });
    assert.equal(r.status, 200);
    const felter = spor().map(x => x.field_name);
    assert.deepEqual(felter, ['HverDag']);
});

test('fejler skrivningen til Grocy, logges intet', async () => {
    G.skrivFejl = 'Grocy nede';
    const r = await put('/api/grocy/products/5', { location_id: 3 });
    assert.notEqual(r.status, 200);
    assert.equal(spor().length, 0, 'en ændring der ikke skete, må ikke stå i sporet');
});

test('kan "før" ikke hentes, skrives ændringen alligevel — og sporet siger det', async () => {
    G.læsFejl = 'timeout';
    const r = await put('/api/grocy/products/5', { location_id: 3 });
    assert.equal(r.status, 200);
    assert.equal(G.skrevet.length, 1);
    const [row] = spor();
    assert.equal(row.old_value, null);
    assert.match(row.notes, /før-værdien kunne ikke hentes/);
});

test('fejler sporet, er ændringen stadig gemt — og svaret siger at sporet mangler', async () => {
    _db.exec('DROP TABLE changelog');
    const r = await put('/api/grocy/products/5', { location_id: 3 });
    assert.equal(r.status, 200, 'et spor der fejler må ikke vælte ændringen');
    assert.equal(G.skrevet.length, 1);
    assert.ok(r.body.log_error, 'men det må heller ikke fejle i stilhed');
});

test('en ukendt kilde kasseres — kun etiketter vi kender kommer i sporet', async () => {
    await put('/api/grocy/products/5', { location_id: 3 }, '<script>');
    assert.equal(spor()[0].notes, null);
});

test('historik: nyeste først, med brugerens navn', async () => {
    await put('/api/grocy/products/5', { location_id: 3 });
    await put('/api/grocy/products/5', { active: 0 });
    const res = await fetch(base + '/api/grocy/products/5/historik');
    const rows = await res.json();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].field_name, 'active', 'nyeste øverst');
    assert.equal(rows[0].user_name, 'Anne');
    // En anden vare — både med højere og lavere id — ser ingen af varens linjer.
    await put('/api/grocy/products/9', { location_id: 3 });
    for (const pid of [4, 6]) {
        const andre = await (await fetch(base + '/api/grocy/products/' + pid + '/historik')).json();
        assert.equal(andre.length, 0, 'kun varens egne linjer (vare ' + pid + ')');
    }
    const ni = await (await fetch(base + '/api/grocy/products/9/historik')).json();
    assert.equal(ni.length, 1);
});

test('pris: en rettet pris på et varenummer står i sporet', async () => {
    const r = await put('/api/purchasing/prices/barcode/11', { stock_price: 22.5 }, 'lageroversigt');
    assert.equal(r.status, 200);
    const [row] = spor();
    assert.equal(row.entity_id, 5, 'på varen, ikke på varenummeret');
    assert.equal(row.field_name, 'pris');
    assert.equal(row.old_value, '20');
    assert.equal(row.new_value, '22.5');
    assert.match(row.notes, /varenr 12345/);
    assert.equal(row.user_id, 7);
});

test('pris: samme pris igen logges ikke', async () => {
    await put('/api/purchasing/prices/barcode/11', { stock_price: 20 });
    assert.equal(spor().length, 0);
});

test('overslag: sat og fjernet står begge i sporet', async () => {
    await put('/api/purchasing/prices/product/5/estimate', { stock_price: 17 }, 'opskrifter');
    await put('/api/purchasing/prices/product/5/estimate', { stock_price: null });
    const rows = spor();
    assert.deepEqual(rows.map(x => [x.field_name, x.old_value, x.new_value]),
        [['overslag', '15', '17'], ['overslag', '17', null]]);
    assert.match(rows[0].notes, /Opskrifter & priser/);
});

test('foretrukket varenummer: skiftet står i sporet', async () => {
    const r = await put('/api/purchasing/prices/product/5/preferred', { barcode_id: 12 }, 'indkob');
    assert.equal(r.status, 200);
    const [row] = spor();
    assert.equal(row.field_name, 'foretrukket varenummer');
    assert.equal(row.old_value, '12345');
    assert.equal(row.new_value, '67890');
});
