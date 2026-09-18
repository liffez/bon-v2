// tests/modtag_uden_bestilling.test.js
// ============================================================
// Varemodtagelse uden en bestilling (#658).
//
// Baggrund målt i drift 17.-18. september 2026:
//   · 33 modtagelser i Bon — men 24 af dem med NUL varer. I september: 6 af 6.
//   · 120 køb mod 379 lagerrettelser i Grocy på 90 dage. Varerne kommer ind
//     ad den anden dør, og en rettelse fodrer hverken kostprisens snit (#557)
//     eller fødevarekontrollen.
//   · Manuelle varelinjer er tastet tre gange i hele systemets levetid, og
//     ALLE tre endte uden grocy_product_id — de nåede aldrig lageret.
//
// Testen låser fire ting fast:
//   1. Mængden kan tastes i flere enheder, og SERVEREN summerer den med sine
//      egne omregninger (§14.4) — ikke med klientens factor_used.
//   2. Kan bare én post ikke omregnes, rører vi ikke lageret (#358) — men
//      fødevarekontrollen gemmes alligevel.
//   3. Fødevarekontrollen overlever at HVER ENESTE Grocy-skrivning fejler.
//      Den er lovpligtig; lageret er ikke.
//   4. En modtagelse UDEN varer sendes stadig til tavlen, så FVST kan få sin
//      rapport ved et kontrolbesøg.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en
// kolonne der flytter sig får testen til at fejle i stedet for at bestå mod
// en håndskrevet kopi.
//
// Kør: node --experimental-sqlite --test tests/modtag_uden_bestilling.test.js
// ============================================================

process.env.NODE_ENV = 'test';   // webhook.send() fanges i en buffer

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

// ── Grocy stubbes: testen må ikke afhænge af en instans der er oppe ──
//
// Stubben er styrbar, så "hver eneste skrivning fejler" kan fremprovokeres.
// Uden det ville punkt 3 aldrig blive kørt — og det er netop dét punkt der
// er hele grunden til at fødevarekontrollen ligger i sin egen transaktion.
const grocyPath = require.resolve('../services/grocyAdapter');
const G = {
    fejlPaaAddStock: false,
    addStockKald: [],
    userfieldKald: [],
    // Brød Rug: købes i Kasse (13), lagerføres i Kilo (4), tælles i stk (7).
    // 1 Kasse = 11 Kilo, 1 stk = 0,09 Kilo.
    produkter: [
        { id: 1, name: 'Brød Rug', active: '1', qu_id_stock: 4, qu_id_purchase: 13, qu_id_consume: 7 },
        { id: 2, name: 'Spidskål',  active: '1', qu_id_stock: 4, qu_id_purchase: 3,  qu_id_consume: 4 },
    ],
    konverteringer: [
        { id: 1, product_id: 1, from_qu_id: 13, to_qu_id: 4, factor: 11 },
        { id: 2, product_id: 1, from_qu_id: 7,  to_qu_id: 4, factor: 0.09 },
        // Spidskål mangler med vilje Antal → Kilo. Det er de fem produkter
        // uden købs→lager-konvertering fra driften.
    ],
    stregkoder: [
        { id: 10, product_id: 1, barcode: '60097769', qu_id: 13, amount: 11,
          last_price: 220, shopping_location_id: 2, userfields: { is_preferred: '1' } },
        { id: 11, product_id: 1, barcode: '11111111', qu_id: 13, amount: 11,
          last_price: 999, shopping_location_id: 2, userfields: {} },
    ],
    enheder: [
        { id: 4, name: 'Kilo' }, { id: 13, name: 'Kasse' },
        { id: 7, name: 'Antal' }, { id: 3, name: 'Antal' },
    ],
};
require.cache[grocyPath] = {
    id: grocyPath, filename: grocyPath, loaded: true,
    exports: {
        getProducts: async () => G.produkter,
        getQuantityUnitConversions: async () => G.konverteringer,
        getProductBarcodes: async () => G.stregkoder,
        getQuantityUnits: async () => G.enheder,
        addToStockFull: async (pid, opts) => {
            if (G.fejlPaaAddStock) throw new Error('Grocy svarer ikke');
            G.addStockKald.push({ pid, ...opts });
            return { ok: true };
        },
        updateProductUserfields: async (pid, uf) => { G.userfieldKald.push({ pid, uf }); },
        updateShoppingListItem: async () => {},
        deleteShoppingListItem: async () => {},
    },
};

const webhook = require('../services/goodsReceiptWebhook');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function friskDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.session = { userId: 1, userRole: 'admin', user: { id: 1, role: 'admin' } };
    next();
});
app.use('/api/goods-receipts', require('../routes/goods-receipts'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => {
    _testDb = friskDb();
    G.fejlPaaAddStock = false;
    G.addStockKald = [];
    G.userfieldKald = [];
    webhook._clearSentWebhooks();
});

async function post(body) {
    const res = await fetch(baseUrl + '/api/goods-receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

/** Fødevarekontrollen — den del der ALTID skal med. */
const FVST = {
    supplier_name: 'Hørkram',
    received_by_name: 'Anne',
    temperature_cool_enabled: true,
    temperature_cool_value: 4.2,
    temperature_cool_ok: true,
    temperature_frozen_enabled: false,
    date_check_ok: true,
    labeling_check_ok: true,
    packaging_check_ok: false,
    has_deviation: true,
    deviation_type: 'no_risk',
    deviation_note: 'Kasse bulet',
};

const linjer = (r) => _testDb.prepare(
    `SELECT * FROM goods_receipt_items WHERE receipt_id = ? ORDER BY id`).all(r);
const kvittering = () => _testDb.prepare(
    `SELECT * FROM goods_receipts ORDER BY id DESC LIMIT 1`).get();

/* ── 1. Mængden kan tastes i flere enheder ──────────────────────── */

test('to felter summeres af SERVEREN med dens egne omregninger', async () => {
    // "2 kasser brød og 25 ekstra styk" — Leifs eget eksempel.
    // 2 × 11 + 25 × 0,09 = 24,25 kg.
    const { status } = await post({
        ...FVST,
        items: [{
            grocy_product_id: 1, product_name: 'Brød Rug',
            received_quantity: 2.204545, qu_id: 13,
            entries: [
                { qu_id: 13, qty: 2,  factor_used: 11 },
                { qu_id: 7,  qty: 25, factor_used: 0.09 },
            ],
            status: 'ok',
        }],
    });
    assert.equal(status, 200);

    const l = linjer(kvittering().id)[0];
    assert.equal(l.received_quantity_stock, 24.25, 'summen er det eneste der posteres');
    assert.equal(G.addStockKald.length, 1);
    assert.equal(G.addStockKald[0].amount, 24.25, 'Grocy får summen i lager-enhed');

    const gemt = JSON.parse(l.received_entries_json);
    assert.equal(gemt.length, 2, 'hvert felt gemmes som sin egen post (§14.4)');
    assert.equal(gemt[0].factor_used, 11, 'faktoren på tastetidspunktet følger med');
    assert.equal(gemt[1].factor_used, 0.09);
});

test('serverens faktor vinder over klientens — den er ikke til forhandling', async () => {
    // En klient der påstår 1 Kasse = 999 Kilo må ikke kunne skrive 1998 kg
    // ind i lageret. Serverens egen omregning er den der gælder.
    await post({
        ...FVST,
        items: [{
            grocy_product_id: 1, product_name: 'Brød Rug',
            received_quantity: 2, qu_id: 13,
            entries: [{ qu_id: 13, qty: 2, factor_used: 999 }],
            status: 'ok',
        }],
    });
    assert.equal(G.addStockKald[0].amount, 22, '2 × 11, ikke 2 × 999');
    const gemt = JSON.parse(linjer(kvittering().id)[0].received_entries_json);
    assert.equal(gemt[0].factor_used, 11, 'sporet bærer den faktor der FAKTISK blev brugt');
});

test('ét felt opfører sig præcis som før — ingen regression', async () => {
    await post({
        ...FVST,
        items: [{
            grocy_product_id: 1, product_name: 'Brød Rug',
            received_quantity: 3, qu_id: 13, status: 'ok',
        }],
    });
    const l = linjer(kvittering().id)[0];
    assert.equal(l.received_quantity_stock, 33);
    assert.equal(l.received_entries_json, null, 'ingen poster = tastet i ét felt, som hidtil');
    assert.equal(G.addStockKald[0].amount, 33);
});

test('poster alene er nok — received_quantity behøver ikke følge med', () => {
    // En klient der KUN sender poster er en gyldig kontrakt. Uden at
    // shouldAddStock ser på summen, ville linjen blive sprunget over fordi
    // det ene tal stod 0 — og varen ville aldrig nå lageret, uden at nogen
    // fik det at vide. Præcis den fejlklasse #305 blev bygget for.
    return post({
        ...FVST,
        items: [{ grocy_product_id: 1, product_name: 'Brød Rug',
                  entries: [{ qu_id: 13, qty: 2, factor_used: 11 }], status: 'ok' }],
    }).then(({ status }) => {
        assert.equal(status, 200);
        assert.equal(G.addStockKald.length, 1, 'varen SKAL på lager');
        assert.equal(G.addStockKald[0].amount, 22);
        assert.equal(linjer(kvittering().id)[0].grocy_added, 1);
    });
});

/* ── 2. Kan én post ikke omregnes, rører vi ikke lageret ────────── */

test('én uomregnelig post stopper HELE linjen — ingen delvis sum', async () => {
    const { status } = await post({
        ...FVST,
        items: [{
            grocy_product_id: 2, product_name: 'Spidskål',
            received_quantity: 4, qu_id: 3,
            entries: [
                { qu_id: 4, qty: 1, factor_used: 1 },   // Kilo — kan omregnes
                { qu_id: 3, qty: 4, factor_used: 1 },   // Antal — kan IKKE
            ],
            status: 'ok',
        }],
    });
    assert.equal(status, 200, 'fødevarekontrollen gemmes uanset');

    const l = linjer(kvittering().id)[0];
    assert.equal(G.addStockKald.length, 0, 'lageret rører vi ikke');
    assert.equal(l.grocy_added, 0);
    assert.ok(l.grocy_error, 'manglen skrives på linjen i stedet for at forsvinde');
    assert.equal(l.received_quantity_stock, null, 'en delvis sum ville være et forkert tal');
    assert.equal(kvittering().status, 'partially_approved');
});

test('ugyldige poster afvises med en besked, ikke med en mængde', async () => {
    const a = await post({ ...FVST, items: [{ grocy_product_id: 1,
        product_name: 'Brød Rug', entries: [{ qu_id: 13, qty: 0 }] }] });
    assert.equal(a.status, 400);
    assert.match(a.body.error, /qty/);

    const b = await post({ ...FVST, items: [{ grocy_product_id: 1,
        product_name: 'Brød Rug', entries: [{ qty: 2 }] }] });
    assert.equal(b.status, 400);
    assert.match(b.body.error, /qu_id/);

    const c = await post({ ...FVST, items: [{ grocy_product_id: 1,
        product_name: 'Brød Rug', entries: 'to kasser' }] });
    assert.equal(c.status, 400);
});

/* ── 3. Fødevarekontrollen overlever at Grocy er nede ───────────── */

test('FVST gemmes fuldt ud selvom HVER ENESTE Grocy-skrivning fejler', async () => {
    G.fejlPaaAddStock = true;

    const { status } = await post({
        ...FVST,
        items: [
            { grocy_product_id: 1, product_name: 'Brød Rug',
              entries: [{ qu_id: 13, qty: 2, factor_used: 11 }], status: 'ok' },
            { grocy_product_id: 1, product_name: 'Brød Rug (2)',
              received_quantity: 1, qu_id: 13, status: 'ok' },
        ],
    });
    assert.equal(status, 200, 'en lovpligtig registrering må ikke afvises fordi lageret fejler');

    const k = kvittering();
    assert.equal(k.temperature_cool_value, 4.2, 'temperaturen er gemt');
    assert.equal(k.temperature_cool_ok, 1);
    assert.equal(k.packaging_check_ok, 0, 'FVST-tjekkene er gemt som de blev sat');
    assert.equal(k.has_deviation, 1);
    assert.equal(k.deviation_note, 'Kasse bulet');
    assert.equal(k.status, 'partially_approved', 'og det SIGES at lageret ikke fulgte med');

    const l = linjer(k.id);
    assert.equal(l.length, 2, 'linjerne er der stadig');
    assert.ok(l.every(x => x.grocy_added === 0 && x.grocy_error), 'hver linje bærer sin fejl');
});

test('modtagelsen sendes til tavlen også når Grocy fejler', async () => {
    G.fejlPaaAddStock = true;
    await post({ ...FVST, items: [{ grocy_product_id: 1, product_name: 'Brød Rug',
        received_quantity: 1, qu_id: 13, status: 'ok' }] });
    await new Promise(r => setTimeout(r, 30));   // send() er fire-and-forget
    assert.equal(webhook._getSentWebhooks().length, 1);
});

/* ── 4. En modtagelse uden varer er stadig en modtagelse ────────── */

test('nul varer: FVST gemmes OG sendes til tavlen', async () => {
    // 24 af 33 modtagelser i drift ser sådan ud. Kontrolbesøget skal kunne
    // få sin rapport, uanset at der ikke blev lagt noget på lager.
    const { status } = await post({ ...FVST, items: [] });
    assert.equal(status, 200);

    const k = kvittering();
    assert.equal(k.temperature_cool_value, 4.2);
    assert.equal(k.status, 'approved');

    await new Promise(r => setTimeout(r, 30));
    const sendt = webhook._getSentWebhooks();
    assert.equal(sendt.length, 1, 'tavlen får den — ellers mangler FVST-loggen en dag');
    assert.equal(sendt[0].supplier_name, 'Hørkram');
});

/* ── 5. Prisen findes uden en bestilling ────────────────────────── */

test('uden bestilt varenummer bruges det foretrukne', async () => {
    // Det er hele pointen med #658: kanalen var lukket for alt der ikke var
    // bestilt i Bon, og prisen kunne derfor kun komme fra ordered_varenr.
    await post({
        ...FVST,
        items: [{ grocy_product_id: 1, product_name: 'Brød Rug',
                  entries: [{ qu_id: 13, qty: 2, factor_used: 11 }], status: 'ok' }],
    });
    const l = linjer(kvittering().id)[0];
    assert.equal(l.received_price_source, '60097769', 'det foretrukne varenummer');
    assert.equal(l.received_price, 20, '220 kr pr. Kasse ÷ 11 Kilo');
    assert.equal(G.addStockKald[0].price, 20, 'og prisen følger med til Grocy');
});

test('kendes det leverede varenummer, er prisen dets — ikke det foretrukne', async () => {
    // Scanner eller taster man nummeret, VED vi hvilket der kom.
    await post({
        ...FVST,
        items: [{ grocy_product_id: 1, product_name: 'Brød Rug',
                  entries: [{ qu_id: 13, qty: 1, factor_used: 11 }],
                  ordered_varenrs: ['11111111'], status: 'ok' }],
    });
    const l = linjer(kvittering().id)[0];
    assert.equal(l.received_price_source, '11111111');
    // 999 kr pr. Kasse ÷ 11 Kilo, afrundet til 4 decimaler som prisreglen gør.
    assert.equal(l.received_price, 90.8182);
});

/* ── 6. Varen uden Grocy-produkt noteres, men rører ikke lageret ── */

test('noteret vare uden Grocy-produkt gemmes uden at røre lageret', async () => {
    const { status } = await post({
        ...FVST,
        items: [{ grocy_product_id: null, product_name: 'Blomster fra naboen',
                  received_quantity: 2, unit: 'bundt', status: 'ok' }],
    });
    assert.equal(status, 200);
    assert.equal(G.addStockKald.length, 0);
    const l = linjer(kvittering().id)[0];
    assert.equal(l.product_name, 'Blomster fra naboen');
    assert.equal(l.grocy_product_id, null);
    assert.equal(kvittering().status, 'approved', 'det er ikke en fejl — der var intet at lægge på');
});
