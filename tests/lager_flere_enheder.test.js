// tests/lager_flere_enheder.test.js
// ============================================================
// Lageroversigten: mængden kan tastes i flere enheder, og SERVEREN summerer.
//
// Baggrund (#658): varemodtagelsen har siden #358 ladet serveren omregne med
// sine egne omregninger — klientens tal er aldrig blevet stolet på. Lager-
// oversigten gjorde det modsatte: browseren regnede, og serveren sendte tallet
// videre til Grocy uden at kigge. Samme regel, to steder, og det svageste af
// dem var det der kunne skrive et forkert lagertal.
//
// En browser der har stået åben siden i går regner med gårsdagens
// omregningstabel. Derfor sender klienten nu hvad der blev TASTET, og serveren
// afgør hvad der skrives.
//
// Kør: node --experimental-sqlite --test tests/lager_flere_enheder.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');

// Grocy stubbes — testen må ikke afhænge af en instans der er oppe.
const grocyPath = require.resolve('../services/grocyAdapter');
const G = {
    sat: [],
    // Brød Rug: kilo på lager (4), kasse ved køb (13), stk ved forbrug (7).
    produkter: [
        { id: 1, name: 'Brød Rug', qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 },
        { id: 2, name: 'Spidskål', qu_id_stock: 4, qu_id_purchase: 3, qu_id_consume: 3 },
    ],
    konverteringer: [
        { id: 1, product_id: 1, from_qu_id: 13, to_qu_id: 4, factor: 7.68 },
        { id: 2, product_id: 1, from_qu_id: 7,  to_qu_id: 4, factor: 0.0081 },
        // Spidskål mangler med vilje Antal → Kilo.
    ],
};
require.cache[grocyPath] = {
    id: grocyPath, filename: grocyPath, loaded: true,
    exports: {
        getProducts: async () => G.produkter,
        getQuantityUnitConversions: async () => G.konverteringer,
        getProductBarcodes: async () => [],
        getQuantityUnits: async () => [{ id: 4, name: 'Kilo' }, { id: 13, name: 'Kasse' }, { id: 7, name: 'stk' }],
        setInventory: async (pid, amount, bb, opts) => { G.sat.push({ pid, amount, opts }); return { ok: true }; },
    },
};

// Prisopslaget må ikke kunne vælte en lagerrettelse.
const spPath = require.resolve('../services/supplierPrices');
const sp = require(spPath);
sp.priceForStock = async () => ({ price: null, reason: 'missing' });

const dbPath = require.resolve('../db/database');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { getDb: () => ({ prepare: () => ({ get: () => null, all: () => [], run: () => {} }) }) },
};

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/grocy', require('../routes/grocy'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { G.sat = []; });

async function sæt(pid, body) {
    const res = await fetch(`${baseUrl}/api/grocy/stock/${pid}/inventory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

test('serveren summerer posterne med SINE egne omregninger', async () => {
    // "2 kasser og 5 stk" — 2 × 7,68 + 5 × 0,0081 = 15,4005 kg.
    const { status, body } = await sæt(1, {
        amount: 999,   // klientens tal er med, men må ikke vinde
        entries: [{ qu_id: 13, qty: 2 }, { qu_id: 7, qty: 5 }],
    });
    assert.equal(status, 200);
    assert.equal(G.sat.length, 1);
    assert.equal(G.sat[0].amount, 15.4005, 'summen, ikke klientens tal');
    assert.equal(body.new_amount, 15.4005, 'og svaret siger hvad der FAKTISK blev gemt');
});

test('ét udfyldt felt er en komplet optælling', async () => {
    // "2 kasser og ingen løse stykker" er ikke en halv optælling.
    await sæt(1, { amount: 0, entries: [{ qu_id: 13, qty: 2 }] });
    assert.equal(G.sat[0].amount, 15.36);
});

test('små faktorer afrundes ikke væk', async () => {
    // 3 × 0,0081 = 0,0243. Afrundet til 2 decimaler ville det blive 0,02 —
    // 18 % af mængden, tabt i stilhed.
    await sæt(1, { amount: 0, entries: [{ qu_id: 7, qty: 3 }] });
    assert.equal(G.sat[0].amount, 0.0243);
});

test('kan én post ikke omregnes, rører vi ikke lageret', async () => {
    const { status, body } = await sæt(2, {
        amount: 5,
        entries: [{ qu_id: 4, qty: 1 }, { qu_id: 3, qty: 4 }],   // Antal → Kilo mangler
    });
    assert.equal(status, 400, 'det siges, i stedet for at gemme en delvis sum');
    assert.equal(G.sat.length, 0, 'og Grocy er urørt');
    assert.ok(body.error);
});

test('ugyldige poster afvises med en besked, ikke med en mængde', async () => {
    const a = await sæt(1, { amount: 1, entries: [{ qu_id: 13, qty: 0 }] });
    assert.equal(a.status, 400);
    assert.match(a.body.error, /qty/);

    const b = await sæt(1, { amount: 1, entries: [{ qty: 2 }] });
    assert.equal(b.status, 400);
    assert.match(b.body.error, /qu_id/);

    assert.equal(G.sat.length, 0, 'intet nåede Grocy');
});

test('uden poster er ruten præcis som før — ét tal, uændret', async () => {
    await sæt(1, { amount: 42.5 });
    assert.equal(G.sat[0].amount, 42.5);
});

test('tom liste er ikke en optælling — amount gælder', async () => {
    // En klient der sender entries: [] mener ikke "sæt lageret til 0".
    await sæt(1, { amount: 7, entries: [] });
    assert.equal(G.sat[0].amount, 7);
});

test('helt uden amount OG uden poster afvises', async () => {
    const { status } = await sæt(1, {});
    assert.equal(status, 400);
    assert.equal(G.sat.length, 0);
});
