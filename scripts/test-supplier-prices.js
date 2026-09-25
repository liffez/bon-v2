// scripts/test-supplier-prices.js
// ============================================================
// #657 — varemodtagelse og lageroversigt sender en pris med til Grocy.
//
// Prisen bor i Grocy (stregkodens last_price). Testen dækker:
//   1. reglerne (rene funktioner): leverandørpris → stregkodepris → lagerpris
//   2. hvilket varenummers pris der gælder — og hvornår der IKKE sendes nogen
//   3. "Opdater priser nu": én pris pr. varenummer, skrevet på stregkoden
//   4. ret en pris (tastet pr. lager-enhed)
//   5. varemodtagelses-routen: prisen følger med til Grocy, gemmes på linjen,
//      og en vare uden pris lander uden pris og uden fejl
//   6. lageroversigtens inventory-route sender prisen med
//   7. lageroversigtens klient-helpers (pille + prisparser)
//
// Grocy er STUBBET i require-cachen. Ingen netværk, ingen Grocy.
//
//   node --experimental-sqlite scripts/test-supplier-prices.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-supplier-prices-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const near  = (a, b, eps = 0.001) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < eps;

// ── Grocy-stub ──────────────────────────────────────────────────────────────
// Enheder: 1 Kilo · 2 Gram · 3 Antal · 4 Liter
const UNITS = [{ id: 1, name: 'Kilo' }, { id: 2, name: 'Gram' }, { id: 3, name: 'Antal' }, { id: 4, name: 'Liter' }];
const HK_LOC = 7;   // Grocy-indkøbssted koblet til Hørkram

function freshGrocyData() {
    return {
        products: [
            { id: 10, name: 'Salatost',  qu_id_stock: 1, qu_id_purchase: 1, active: 1 },
            { id: 11, name: 'Havregurt', qu_id_stock: 1, qu_id_purchase: 1, active: 1 },
            { id: 12, name: 'Mayo',      qu_id_stock: 1, qu_id_purchase: 1, active: 1 },   // pose + spand
            { id: 13, name: 'Sodavand',  qu_id_stock: 3, qu_id_purchase: 3, active: 1 },   // kilo-stregkode på antal-vare
            // Ingen kobling. Købs- og lager-enhed er FORSKELLIGE (én kasse = 2 kg):
            // et overslag gemt i den forkerte enhed ville være 2× ved siden af.
            { id: 14, name: 'Løs vare',  qu_id_stock: 1, qu_id_purchase: 3, active: 1 },
        ],
        conversions: [
            { product_id: null, from_qu_id: 1, to_qu_id: 2, factor: 1000 },   // global kilo → gram
            { product_id: 14, from_qu_id: 3, to_qu_id: 1, factor: 2 },        // Løs vare: 1 kasse = 2 kg
        ],
        barcodes: [
            // Salatost: 150 g pr. bakke, stregkoden i Kilo.
            { id: 100, product_id: 10, barcode: '60032236', amount: 0.15, qu_id: 1, last_price: null,
              shopping_location_id: HK_LOC, userfields: {} },
            // Havregurt: 400 g pr. pakke, stregkoden i GRAM.
            { id: 101, product_id: 11, barcode: '18688276', amount: 400, qu_id: 2, last_price: null,
              shopping_location_id: HK_LOC, userfields: {} },
            // Mayo: pose (1 kg) og spand (5 kg).
            { id: 102, product_id: 12, barcode: '11111111', amount: 1, qu_id: 1, last_price: null,
              shopping_location_id: HK_LOC, userfields: {} },
            { id: 103, product_id: 12, barcode: '55555555', amount: 5, qu_id: 1, last_price: null,
              shopping_location_id: HK_LOC, userfields: {} },
            // Sodavand: stregkoden siger 0,25 Kilo, men varen lagerføres i Antal.
            { id: 104, product_id: 13, barcode: '18426663', amount: 0.25, qu_id: 1, last_price: null,
              shopping_location_id: HK_LOC, userfields: {} },
            // Udgået varenummer — Hørkram kender det ikke længere.
            { id: 105, product_id: 10, barcode: '99999999', amount: 0.15, qu_id: 1, last_price: 70,
              shopping_location_id: HK_LOC, userfields: {} },
        ],
    };
}

const G = {
    data: freshGrocyData(),
    addCalls: [], invCalls: [], bcPuts: [], ufPuts: [], bcCreates: [], bcDeletes: [],
    reset() { this.data = freshGrocyData(); this.addCalls = []; this.invCalls = []; this.bcPuts = [];
              this.ufPuts = []; this.bcCreates = []; this.bcDeletes = []; },
};

const grocyPath = require.resolve('../services/grocyAdapter');
const realGrocy = require(grocyPath);
require.cache[grocyPath].exports = {
    ...realGrocy,
    getProducts: async () => G.data.products,
    getQuantityUnits: async () => UNITS,
    getQuantityUnitConversions: async () => G.data.conversions,
    getProductBarcodes: async () => G.data.barcodes,
    updateProductBarcode: async (id, body) => {
        G.bcPuts.push({ id, body });
        const b = G.data.barcodes.find(x => x.id === id);
        Object.assign(b, body);
    },
    createProductBarcode: async (body) => {
        const id = 900 + G.data.barcodes.length;
        const row = { id, userfields: {}, ...body };
        G.data.barcodes.push(row);
        G.bcCreates.push(row);
        return { created_object_id: id };
    },
    deleteProductBarcode: async (id) => {
        G.bcDeletes.push(id);
        G.data.barcodes = G.data.barcodes.filter(b => b.id !== id);
    },
    updateProductBarcodeUserfields: async (id, fields) => {
        G.ufPuts.push({ id, fields });
        const b = G.data.barcodes.find(x => x.id === id);
        b.userfields = { ...(b.userfields || {}), ...fields };
    },
    addToStock: async () => { throw new Error('addToStock må ikke bruges — prisen kan ikke sendes med'); },
    addToStockFull: async (pid, body) => { G.addCalls.push({ pid, body }); },
    setInventory: async (pid, amount, bbd, opts) => { G.invCalls.push({ pid, amount, opts }); return { ok: true }; },
    updateProductUserfields: async () => {},
    updateShoppingListItem: async () => {},
    deleteShoppingListItem: async () => {},
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);
const { getDb } = require('../db/database');
const db = getDb();
const sp = require('../services/supplierPrices');
const grocy = require(grocyPath);

// Hørkram-leverandør koblet til indkøbsstedet.
const supId = db.prepare(`INSERT INTO suppliers (name, integration_type) VALUES ('Hørkram', 'api')`).run().lastInsertRowid;
db.prepare(`INSERT INTO supplier_grocy_locations (supplier_id, grocy_location_id) VALUES (?, ?)`).run(supId, HK_LOC);

function routeHandler(router, method, pathStr) {
    const layer = router.stack.find(l => l.route && l.route.path === pathStr && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(handler, req) {
    let body = null, status = 200;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    let thrown = null;
    await handler({ session: { userId: null, userRole: 'admin' }, params: {}, query: {}, ...req }, res,
        err => { if (err) thrown = err; });
    if (thrown) throw thrown;
    return { status, body };
}

// Hørkram-svar i snapshot-summary-form (parseSnapshotToSummary).
function snap(vn, basePrice, perKg, base = 'bk', agreement = true) {
    return {
        varenummer: vn, name: 'x', baseUnitCode: base, pricePerUnit: basePrice, pricePerKg: perKg,
        salesUnits: [{ code: 'kt', quantity: 6, salesPrice: basePrice, isDefault: true },
                     { code: base, quantity: 1, salesPrice: basePrice, isDefault: false }],
        isAgreementItem: agreement,
    };
}

async function main() {
    /* ══════════════════════════════════════════════════════════════════════
       1. Reglerne
       ══════════════════════════════════════════════════════════════════════ */
    head('1. Leverandørpris → stregkodens pris');
    {
        // Driftens tal: Salatost 12,38 kr for 0,15 kg = 82,53 kr/kg.
        const r = sp.barcodePriceFromSupplier({ unitPrice: 12.38, content: 0.15, barcodeUnit: 'Kilo', pricePerKg: 82.53 });
        check(near(r.price, 82.5333), `12,38 kr ÷ 0,15 kg = 82,53 kr/kg — fik ${r.price}`);
        check(r.basis === 'content' && r.note === null, 'indhold er grundlaget, ingen advarsel når kiloprisen stemmer');

        // Pakkestørrelsen SKAL deles ud: prisen for en bakke er ikke prisen for et kilo (#358 på pris).
        check(!near(r.price, 12.38), 'prisen pr. bakke sendes IKKE som pris pr. kilo');

        const g = sp.barcodePriceFromSupplier({ unitPrice: 27.15, content: 400, barcodeUnit: 'Gram' });
        check(near(g.price, 0.067875, 1e-7), `gram-stregkode: 27,15 ÷ 400 g = 0,0679 kr/g — fik ${g.price}`);

        const warn = sp.barcodePriceFromSupplier({ unitPrice: 21.34, content: 0.33, barcodeUnit: 'Kilo', pricePerKg: 112.32 });
        check(warn.price !== null && /tjek indholdet/.test(warn.note || ''),
            'afviger udregnet kilopris fra leverandørens → prisen bruges, men det siges');

        const kgOnly = sp.barcodePriceFromSupplier({ unitPrice: 43.14, content: 0, barcodeUnit: 'Kilo', pricePerKg: 41.48 });
        check(near(kgOnly.price, 41.48) && kgOnly.basis === 'per_kg', 'uden indhold + kilo-stregkode → leverandørens kilopris');

        const noUnit = sp.barcodePriceFromSupplier({ unitPrice: 43.14, content: 0, barcodeUnit: 'Liter', pricePerKg: 41.48 });
        check(noUnit.price === null, 'uden indhold + liter-stregkode → INGEN pris (en kilopris er ikke en literpris)');

        const noPrice = sp.barcodePriceFromSupplier({ unitPrice: null, content: 1, barcodeUnit: 'Kilo' });
        check(noPrice.price === null && /ingen pris/i.test(noPrice.note), 'leverandøren oplyser ingen pris → ingen pris');
    }

    head('1b. Stregkodens pris → pris pr. lager-enhed');
    {
        const d = freshGrocyData();
        const P = id => d.products.find(p => p.id === id);
        const kg = sp.stockPriceFromBarcode({ barcode: { last_price: 82.53, qu_id: 1 }, product: P(10), conversions: d.conversions });
        check(near(kg.price, 82.53), 'kilo-stregkode på kilo-vare → uændret');

        const gram = sp.stockPriceFromBarcode({ barcode: { last_price: 0.067875, qu_id: 2 }, product: P(11), conversions: d.conversions });
        check(near(gram.price, 67.875), `0,0679 kr/g på kilo-vare → 67,88 kr/kg — fik ${gram.price}`);

        const noConv = sp.stockPriceFromBarcode({ barcode: { last_price: 40.44, qu_id: 1 }, product: P(13), conversions: d.conversions });
        check(noConv.price === null && /omregnes/.test(noConv.note), 'kilo-stregkode på antal-vare uden omregning → ingen pris');

        check(sp.stockPriceFromBarcode({ barcode: { last_price: null, qu_id: 1 }, product: P(10), conversions: [] }).price === null,
            'ingen last_price → ingen pris');
        check(sp.stockPriceFromBarcode({ barcode: { last_price: 5, qu_id: null }, product: P(10), conversions: [] }).price === null,
            'stregkode uden enhed → ingen pris');
    }

    head('2. Hvilken pris gælder?');
    {
        const pose  = { barcode: '1', stock_price: 114.56, is_preferred: false, is_agreement: true };
        const spand = { barcode: '5', stock_price: 42.01,  is_preferred: false, is_agreement: true };
        const tom   = { barcode: '9', stock_price: null,   is_preferred: false, is_agreement: false };

        const o = sp.resolveProductPrice([pose, spand], { barcode: '5' });
        check(o.price === 42.01 && o.reason === 'ordered', 'det leverede varenummer vinder');

        const ou = sp.resolveProductPrice([pose, tom], { barcode: '9' });
        check(ou.price === null && ou.reason === 'ordered_unpriced',
            'leveret varenummer uden pris → INGEN pris (låner ikke posens)');

        const ok2 = sp.resolveProductPrice([pose], { barcode: '777' });
        check(ok2.price === null && ok2.reason === 'ordered_unknown',
            'leveret varenummer der ikke er koblet → ingen pris');

        const amb = sp.resolveProductPrice([pose, spand]);
        check(amb.price === null && amb.reason === 'ambiguous', 'pose + spand uden valg → ingen pris (ville være et gæt)');

        const pref = sp.resolveProductPrice([pose, { ...spand, is_preferred: true }]);
        check(pref.price === 42.01 && pref.reason === 'preferred', 'foretrukket varenummer bestemmer');

        const prefTom = sp.resolveProductPrice([pose, { ...tom, is_preferred: true }]);
        check(prefTom.price === null && prefTom.reason === 'preferred_unpriced',
            'foretrukket varenummer uden pris → ingen pris (ikke det andet)');

        check(sp.resolveProductPrice([pose, tom]).price === 114.56, 'kun ét varenummer har pris → det bruges');
        check(sp.resolveProductPrice([pose, { ...spand, is_agreement: false }]).reason === 'agreement',
            'præcis én aftalevare → den bruges');
        check(sp.resolveProductPrice([]).reason === 'missing', 'ingen varenumre → ingen pris');
    }

    /* ══════════════════════════════════════════════════════════════════════
       3. Opdater priser nu
       ══════════════════════════════════════════════════════════════════════ */
    head('3. "Opdater priser nu" — én pris pr. varenummer, på stregkoden i Grocy');
    {
        G.reset();
        const fetchSnapshots = async (ids) => ({
            products: [
                snap('60032236', 12.38, 82.53, 'bg'),
                snap('18688276', 27.15, 67.88, 'pk', false),
                snap('11111111', 114.56, 114.56, 'ps'),
                snap('55555555', 210.05, 42.01, 'sp'),
                snap('18426663', 10.11, 40.44, 'fl'),
                // 99999999 mangler = udgået
            ],
            errors: [],
            failedIds: [],
        });
        const r = await sp.refreshHorkramPrices(db, { grocy, fetchSnapshots });
        const bc = id => G.data.barcodes.find(b => b.id === id);

        check(r.checked === 6, `alle 6 Hørkram-varenumre tjekket — fik ${r.checked}`);
        check(near(bc(100).last_price, 82.5333), 'Salatost-stregkoden fik 82,53 (pr. kilo)');
        check(near(bc(101).last_price, 0.067875, 1e-7), 'Havregurt-stregkoden fik prisen pr. GRAM (dens egen enhed)');
        check(near(bc(102).last_price, 114.56) && near(bc(103).last_price, 42.01),
            'pose og spand fik HVER SIN pris (før overskrev den ene den anden)');
        check(r.dead.length === 1 && r.dead[0].barcode === '99999999', 'udgået varenummer rapporteres');
        check(bc(105).last_price === 70, 'udgået varenummer beholder sin sidste pris');
        check(bc(104).last_price === 40.44, 'Sodavand (kilo-stregkode) fik kiloprisen — stregkodens enhed er kilo');
        check(bc(100).userfields.hk_price_per_unit === '12.38', 'leverandørens egen stykpris gemt på stregkoden');
        check((bc(101).userfields.is_agreement_item || '') === '' && bc(100).userfields.is_agreement_item === '1',
            'aftalestatus fulgt (aftale / ikke aftale)');
        check(!!bc(100).userfields.hk_scraped_at, 'hentet-dato skrevet');

        // Uændret pris: ingen PUT på last_price, men datoen fornyes.
        G.bcPuts = []; G.ufPuts = [];
        const r2 = await sp.refreshHorkramPrices(db, { grocy, fetchSnapshots });
        check(G.bcPuts.length === 0, 'ingen prisændring → last_price skrives ikke igen');
        check(r2.unchanged === 5 && G.ufPuts.length === 5, 'datoen fornyes på alle 5 levende varenumre');

        // Fejlet opslag må ikke røre noget.
        G.bcPuts = []; G.ufPuts = [];
        const r3 = await sp.refreshHorkramPrices(db, { grocy,
            fetchSnapshots: async (ids) => ({ products: [], errors: [{ error: 'HTTP 500' }], failedIds: ids }) });
        check(G.bcPuts.length === 0 && G.ufPuts.length === 0 && r3.dead.length === 0,
            'Hørkram nede → intet skrives, intet markeres udgået');

        // Kun udvalgte varenumre.
        const r4 = await sp.refreshHorkramPrices(db, { grocy, fetchSnapshots }, { barcodes: ['60032236'] });
        check(r4.checked === 1, 'enkelt-opdatering tjekker kun det ene varenummer');
    }

    head('3b. Lagerprisen efter opfriskning');
    {
        const meta = await sp.loadGrocyMeta(grocy);
        const havre = sp.resolveProductPrice(sp.candidatesFor(meta, 11));
        check(near(havre.price, 67.875, 0.0001), `Havregurt: gram-pris omregnet til 67,88 kr/kg — fik ${havre.price}`);
        const soda = sp.resolveProductPrice(sp.candidatesFor(meta, 13));
        check(soda.price === null, 'Sodavand (antal-vare, kilo-stregkode): ingen pris — ikke et gæt');
        const mayo = sp.resolveProductPrice(sp.candidatesFor(meta, 12));
        check(mayo.price === null && mayo.reason === 'ambiguous', 'Mayo med pose + spand: ingen pris før et varenummer er valgt');

        await sp.setPreferredBarcode(grocy, 12, 103);
        const mayo2 = await sp.priceForStock(grocy, 12);
        check(near(mayo2.price, 42.01) && mayo2.reason === 'preferred', 'spanden valgt → 42,01 kr/kg');
        check(G.data.barcodes.find(b => b.id === 102).userfields.is_preferred !== '1', 'kun ét foretrukket varenummer');
        await sp.setPreferredBarcode(grocy, 12, 102);
        check(G.data.barcodes.find(b => b.id === 103).userfields.is_preferred === ''
            && G.data.barcodes.find(b => b.id === 102).userfields.is_preferred === '1', 'skift af foretrukket rydder det gamle');
        let threw = false;
        try { await sp.setPreferredBarcode(grocy, 12, 100); } catch (e) { threw = e.status === 400; }
        check(threw, 'et varenummer fra en anden vare afvises');
    }

    head('4. Ret en pris — tastet pr. lager-enhed');
    {
        const r = await sp.setBarcodeStockPrice(grocy, 101, 70);
        check(near(r.last_price, 0.07, 1e-9), `70 kr/kg på gram-stregkode gemmes som 0,07 kr/g — fik ${r.last_price}`);
        const back = await sp.priceForStock(grocy, 11);
        check(near(back.price, 70), 'og læses tilbage som 70 kr/kg');
        let threw = false;
        try { await sp.setBarcodeStockPrice(grocy, 104, 10); } catch (e) { threw = e.status === 400; }
        check(threw, 'stregkode der ikke kan omregnes → afvist (intet skrevet)');
        threw = false;
        try { await sp.setBarcodeStockPrice(grocy, 100, 0); } catch (e) { threw = e.status === 400; }
        check(threw, 'pris 0 afvises');
    }

    /* ══════════════════════════════════════════════════════════════════════
       5. Varemodtagelsen
       ══════════════════════════════════════════════════════════════════════ */
    head('5. Varemodtagelsen sender prisen med');
    {
        // Kend priserne: Salatost 82,53 · Mayo pose 114,56 / spand 42,01 (pose foretrukket)
        const handler = routeHandler(require('../routes/goods-receipts'), 'post', '/');
        G.addCalls = [];
        const res = await call(handler, { body: {
            supplier_name: 'Hørkram', received_by_name: 'Tester',
            items: [
                { grocy_product_id: 10, product_name: 'Salatost', expected_quantity: 2, received_quantity: 2,
                  qu_id: 1, status: 'ok', ordered_varenrs: ['60032236'] },
                // Spanden blev leveret, selvom posen er foretrukket.
                { grocy_product_id: 12, product_name: 'Mayo', expected_quantity: 5, received_quantity: 5,
                  qu_id: 1, status: 'ok', ordered_varenrs: ['55555555'] },
                // Pose OG spand i samme leverance → ingen pris.
                { grocy_product_id: 12, product_name: 'Mayo blandet', expected_quantity: 6, received_quantity: 6,
                  qu_id: 1, status: 'ok', ordered_varenrs: ['11111111', '55555555'] },
                // Ingen kobling → lander uden pris og uden fejl.
                { grocy_product_id: 14, product_name: 'Løs vare', expected_quantity: 3, received_quantity: 3,
                  qu_id: 1, status: 'ok' },
            ],
        } });
        const call10 = G.addCalls.find(c => c.pid === 10);
        const calls12 = G.addCalls.filter(c => c.pid === 12);
        const call14 = G.addCalls.find(c => c.pid === 14);

        check(res.body.status === 'approved', `modtagelsen er godkendt — fik ${res.body.status}`);
        check(G.addCalls.length === 4, 'alle fire varer lagt på lager');
        check(call10 && near(call10.body.price, 82.5333), 'Salatost: 82,53 kr/kg sendt til Grocy');
        check(near(calls12[0].body.price, 42.01), 'Mayo: SPANDENS pris (det leverede varenummer), ikke den foretrukne pose');
        check(calls12[1].body.price === null || calls12[1].body.price === undefined,
            'pose + spand i samme leverance → ingen pris sendt');
        check(call14 && (call14.body.price === null || call14.body.price === undefined), 'vare uden kobling → ingen pris sendt');
        check(call10.body.best_before_date === null,
            'holdbarhed sendes som null — Grocy bruger varens standard (ikke "udløber aldrig")');

        const rows = db.prepare(`SELECT product_name, received_price, received_price_source, grocy_added, grocy_error
                                 FROM goods_receipt_items WHERE receipt_id = ? ORDER BY id`).all(res.body.receipt_id ?? res.body.id);
        const byName = Object.fromEntries(rows.map(r => [r.product_name, r]));
        check(near(byName['Salatost'].received_price, 82.5333) && byName['Salatost'].received_price_source === '60032236',
            'sendt pris + varenummer gemt på linjen');
        check(byName['Løs vare'].received_price === null && byName['Løs vare'].grocy_added === 1 && !byName['Løs vare'].grocy_error,
            'vare uden kobling: ingen pris, lagt på lager, ingen fejl');
        check(res.body.grocy_results.find(g => g.product_name === 'Salatost').price_sent !== undefined,
            'svaret fortæller hvilken pris der blev sendt');

        // Grocy-priser kan ikke hentes → modtagelsen går igennem uden pris.
        const realBc = grocy.getProductBarcodes;
        grocy.getProductBarcodes = async () => { throw new Error('Grocy nede'); };
        G.addCalls = [];
        const res2 = await call(handler, { body: {
            supplier_name: 'Hørkram', received_by_name: 'Tester',
            items: [{ grocy_product_id: 10, product_name: 'Salatost', expected_quantity: 1, received_quantity: 1,
                      qu_id: 1, status: 'ok', ordered_varenrs: ['60032236'] }],
        } });
        grocy.getProductBarcodes = realBc;
        check(res2.body.status === 'approved' && G.addCalls.length === 1 && G.addCalls[0].body.price == null,
            'prisopslag fejler → varen lægges stadig på lager, uden pris');
    }

    /* ══════════════════════════════════════════════════════════════════════
       6. Lageroversigtens inventory-route
       ══════════════════════════════════════════════════════════════════════ */
    head('6. Lageroversigten sender prisen med');
    {
        const handler = routeHandler(require('../routes/grocy'), 'post', '/stock/:id/inventory');
        G.invCalls = [];
        const r1 = await call(handler, { params: { id: '10' }, body: { amount: 3 } });
        check(near(G.invCalls[0].opts.price, 82.5333) && near(r1.body.price_sent, 82.5333),
            'Salatost: prisen sendes med og står i svaret');
        const r2 = await call(handler, { params: { id: '14' }, body: { amount: 3 } });
        check(G.invCalls[1].opts.price === null && r2.body.price_sent === null && r2.body.price_reason === 'missing',
            'vare uden kobling: ingen pris, og svaret siger hvorfor');
        const realBc = grocy.getProductBarcodes;
        grocy.getProductBarcodes = async () => { throw new Error('Grocy nede'); };
        const r3 = await call(handler, { params: { id: '10' }, body: { amount: 4 } });
        grocy.getProductBarcodes = realBc;
        check(r3.body.ok === true && G.invCalls.length === 3 && G.invCalls[2].opts.price === null,
            'prisopslag fejler → lagerrettelsen går stadig igennem');
    }

    /* ══════════════════════════════════════════════════════════════════════
       7. Lageroversigtens klient-helpers
       ══════════════════════════════════════════════════════════════════════ */
    head('7. Lageroversigten — pille og prisfelt');
    {
        global.esc = s => String(s == null ? '' : s);
        const so = require('../shared/stock_overview.js');
        check(so._soParsePrice('82,53') === 82.53, '"82,53" → 82,53');
        check(so._soParsePrice('82.53') === 82.53, '"82.53" → 82,53 (punktum som decimal)');
        check(so._soParsePrice('1.234,50') === 1234.5, '"1.234,50" → 1234,5');
        check(so._soParsePrice('12 kr') === 12, '"12 kr" → 12');
        check(so._soFmtPrice(82.5333, 'Kilo') === '82,53 kr/kg', `visning: ${so._soFmtPrice(82.5333, 'Kilo')}`);

        const d = { product_id: 12, price: null, reason_text: 'flere varenumre', stock_unit: 'Kilo', barcode: null,
            candidates: [{ id: 102, barcode: '11111111', stock_price: 114.56, is_preferred: false },
                         { id: 103, barcode: '55555555', stock_price: 42.01, is_preferred: false }] };
        const html = so._soRenderEditPrice(d, false);
        check(/Pris fra varenummer/.test(html) && !/soPriceInput/.test(html),
            'flere varenumre uden valg: vælger vises, INTET prisfelt (der tastes ikke uden grund)');

        const withPrice = so._soRenderEditPrice({ ...d, price: 42.01, barcode: '55555555',
            candidates: [{ ...d.candidates[1], is_preferred: true }] }, false);
        check(!/soPriceInput/.test(withPrice) && /data-price-act="edit"/.test(withPrice),
            'pris kendt: intet felt, kun "Ret"');
        check(/soPriceInput/.test(so._soRenderEditPrice({ ...d, price: 42.01, barcode: '55555555',
            candidates: [{ ...d.candidates[1], is_preferred: true }] }, true)), '"Ret" åbner feltet');

        const missing = so._soRenderEditPrice({ ...d, candidates: [{ id: 1, barcode: '1', stock_price: null }] }, false);
        check(/soPriceInput/.test(missing), 'pris mangler på eneste varenummer: feltet vises af sig selv');

        const none = so._soRenderEditPrice({ ...d, candidates: [] }, false);
        check(!/soPriceInput/.test(none) && /Ingen leverandør-varenummer/.test(none),
            'ingen kobling: forklaring, intet leverandør-prisfelt');
        check(/soEstimateInput/.test(none),
            'ingen kobling: overslaget tilbydes — at sende INGEN pris er heller ikke gratis');
        const withSupplier = so._soRenderEditPrice({ ...d, price: 42.01, barcode: '55555555',
            candidates: [{ ...d.candidates[1], is_preferred: true }] }, false);
        check(!/soEstimateInput/.test(withSupplier) && !/Eget overslag/.test(withSupplier),
            'leverandørpris kendt og intet overslag: der bedes ikke om et gæt');
        const estOnly = so._soRenderEditPrice({ ...d, price: 30, reason: 'estimate', barcode: 'OVERSLAG-14',
            candidates: [{ id: 900, barcode: 'OVERSLAG-14', stock_price: 30, is_estimate: true }] }, false);
        check(/so-price-estimate-tag/.test(estOnly) && /data-price-act="edit-estimate"/.test(estOnly)
              && /data-price-act="clear-estimate"/.test(estOnly),
            'overslag i brug: mærket som overslag, kan rettes og fjernes');
    }

    /* ══════════════════════════════════════════════════════════════════════
       8. Den ægte adapter — hvad der faktisk sendes til Grocy
       ══════════════════════════════════════════════════════════════════════ */
    head('8. Adapteren: holdbarhed og pris i det der POSTes');
    {
        process.env.GROCY_TEST_KEY = process.env.GROCY_TEST_KEY || 'test-key';
        process.env.GROCY_HQ_KEY = process.env.GROCY_HQ_KEY || 'test-key';
        const sent = [];
        const realFetch = global.fetch;
        global.fetch = async (url, opts) => {
            sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
            return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => null };
        };
        try {
            await realGrocy.addToStockFull(10, { amount: 2, best_before_date: null, price: 82.53 });
            await realGrocy.addToStockFull(10, { amount: 2, best_before_date: null, price: null });
            await realGrocy.addToStockFull(10, { amount: 2 });
            await realGrocy.setInventory(10, 5, null, { price: 82.53 });
            await realGrocy.setInventory(10, 5, null, { price: null });
            await realGrocy.setInventory(10, 5, null);
        } finally {
            global.fetch = realFetch;
        }
        const [a1, a2, a3, i1, i2, i3] = sent.map(x => x.body);
        check(a1 && !('best_before_date' in a1) && a1.price === 82.53 && a1.transaction_type === 'purchase',
            'varemodtagelse: ingen holdbarhed (Grocy bruger standarden), pris med, som køb');
        check(a2 && !('price' in a2), 'ingen pris → feltet udelades (Grocy fører den forrige videre)');
        check(a3 && a3.best_before_date === '2999-12-31', 'opret-produkt uden dato: den gamle standard er uændret');
        check(i1 && i1.price === 82.53 && i1.new_amount === 5, 'lagerrettelse: pris med');
        check(i2 && !('price' in i2) && i3 && !('price' in i3), 'lagerrettelse uden pris: feltet udelades');
    }

    /* ══════════════════════════════════════════════════════════════════════
       9. Manuelt overslag — et internt varenummer i Grocy
       ══════════════════════════════════════════════════════════════════════ */
    head('9. Manuelt overslag');
    {
        // Løs vare (14) har ingen kobling. Uden overslag: ingen pris.
        const før = await sp.priceForStock(grocy, 14);
        check(før.price === null && før.reason === 'missing', 'uden overslag: ingen pris');

        const set = await sp.setEstimatePrice(grocy, 14, 37.5);
        check(set.price === 37.5 && set.barcode === 'OVERSLAG-14', `overslaget får sit eget varenummer — ${set.barcode}`);
        const row = G.bcCreates[G.bcCreates.length - 1];
        check(row.product_id === 14 && row.qu_id === 1 && Number(row.amount) === 1 && row.last_price === 37.5,
            'gemt i varens LAGER-enhed (ikke købs-enheden) med amount 1 — så last_price ER prisen pr. lager-enhed');
        check(!row.shopping_location_id, 'ingen leverandør på overslaget');

        const efter = await sp.priceForStock(grocy, 14);
        check(efter.price === 37.5 && efter.reason === 'estimate' && efter.fell_back_from === 'missing',
            'overslaget bruges — og svaret siger hvad det trådte i stedet for');
        check(efter.reason_text === 'manuelt overslag', 'reason_text: ' + efter.reason_text);

        // Samme vare igen: opdatér, opret ikke et nyt.
        const antalFør = G.bcCreates.length;
        await sp.setEstimatePrice(grocy, 14, 40);
        check(G.bcCreates.length === antalFør, 'et nyt overslag opretter ikke et varenummer mere');
        check((await sp.priceForStock(grocy, 14)).price === 40, 'overslaget kan rettes');

        // En rigtig leverandørpris vinder ALTID.
        await sp.setEstimatePrice(grocy, 10, 5);     // Salatost har 82,53 fra Hørkram
        const salatost = await sp.priceForStock(grocy, 10);
        check(salatost.reason !== 'estimate' && near(salatost.price, 82.5333),
            `leverandørprisen vinder over overslaget (${salatost.reason}) — 82,53, ikke de 5 kr`);
        const ov0 = await sp.priceOverview(grocy);
        check(ov0[10].is_estimate === false && ov0[10].estimate_price === 5,
            'oversigten: prisen er leverandørens, men overslaget kan stadig ses og rettes');

        // Det foretrukne varenummer kan ikke blive overslaget.
        await sp.setPreferredBarcode(grocy, 14, null);
        const estBc = G.data.barcodes.find(b => b.barcode === 'OVERSLAG-14');
        check(!estBc.userfields.is_preferred, 'overslaget markeres ikke som foretrukken leverandør');
        let nægtet = false;
        try { await sp.setPreferredBarcode(grocy, 14, estBc.id); } catch (e) { nægtet = e.status === 400; }
        check(nægtet, 'og det kan ikke VÆLGES som foretrukket');

        // Opfriskning fra Hørkram rører det ikke.
        G.bcPuts = [];
        await sp.refreshHorkramPrices(db, {
            grocy, fetchSnapshots: async ids => ({ products: ids.map(id => snap(id, 12, 80)), errors: [], failedIds: [] }),
        });
        check(!G.bcPuts.some(p => p.id === estBc.id), '"Opdater priser nu" rører ikke overslaget');

        // Kostprisens opslag.
        const m = await sp.estimatePrices(grocy);
        check(m.get('14') === 40 && m.get('10') === 5, 'overslagene kan slås op pr. vare (kostprisen bruger dem sidst)');

        // Oversigten mærker det.
        const ov = await sp.priceOverview(grocy);
        check(ov[14].is_estimate === true && ov[14].estimate_price === 40, 'oversigten mærker overslaget');
        check(ov[10].is_estimate === true,
            'to lige gode leverandør-varenumre (ambiguous): overslaget fanger det, i stedet for ingen pris');

        // Varemodtagelsen sender overslaget med, mærket.
        const handler = routeHandler(require('../routes/goods-receipts'), 'post', '/');
        G.addCalls = [];
        const res = await call(handler, { body: {
            supplier_name: 'Hørkram', received_by_name: 'Tester',
            items: [{ grocy_product_id: 14, product_name: 'Løs vare', expected_quantity: 2, received_quantity: 2,
                      qu_id: 1, status: 'ok' }],
        } });
        check(G.addCalls.length === 1 && G.addCalls[0].body.price === 40, 'varemodtagelsen sender overslaget med');
        const rk = db.prepare(`SELECT received_price, received_price_source FROM goods_receipt_items
                               WHERE receipt_id = ?`).get(res.body.receipt_id ?? res.body.id);
        check(rk.received_price === 40 && rk.received_price_source === 'OVERSLAG-14',
            'og linjen husker at prisen VAR et overslag');

        // Indkøbs-fladerne må ikke se overslaget som en leverandør-kobling.
        // Filteret bor ét sted (shared/api.js) — browser-kode, så den køres i
        // en sandkasse, ikke som en kopi af reglen.
        {
            const vm = require('vm'), fs = require('fs');
            const sb = { console, document: {}, localStorage: { getItem: () => null, setItem: () => {} },
                         location: { href: '' }, fetch: async () => ({}), FormData: class {}, URLSearchParams: class {} };
            sb.window = sb;
            vm.createContext(sb);
            vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'api.js'), 'utf8'), sb);
            sb.apiFetch = async () => [{ barcode: '12345678' }, { barcode: 'OVERSLAG-14' }];
            const synlige = await sb.fetchProductBarcodes();
            check(synlige.length === 1 && synlige[0].barcode === '12345678',
                'indkøb og koblinger ser ikke overslaget — det er ikke en leverandør');
            check(sb.isEstimateBarcode('overslag-9') && !sb.isEstimateBarcode('60032236'),
                'klientens regel kender overslaget igen — uanset store og små bogstaver');
        }

        // Ryd overslaget igen.
        await sp.setEstimatePrice(grocy, 14, null);
        check(G.bcDeletes.length === 1 && !G.data.barcodes.some(b => b.barcode === 'OVERSLAG-14'),
            'overslaget kan fjernes helt');
        check((await sp.priceForStock(grocy, 14)).price === null, 'og så er der ingen pris igen');
    }

    console.log('\n── Oversigten med kostprisens viden (arbejdslistens to dele) ──');
    {
        G.reset();
        const base = await sp.priceOverview(grocy);
        const enId = Object.keys(base)[0], toId = Object.keys(base)[1];
        check(base[enId].cost === undefined || base[enId].cost === null,
            'uden with_cost: intet cost-felt — lageroversigten betaler ikke for opslaget');

        let costKald = 0;
        const medCost = {
            ...grocy,
            getProductUnitCostDetails: async () => { costKald++; return new Map([
                [String(enId), { cost: 12.5, source: 'last_purchase' }],
                [String(toId), { cost: 0, source: 'last' }],
            ]); },
            getAllRecipesPos: async () => [
                { recipe_id: 1, product_id: Number(enId) }, { recipe_id: 2, product_id: Number(enId) },
            ],
        };
        const ov = await sp.priceOverview(medCost, { withCost: true });
        check(costKald === 1, 'kostprisen slås op ÉN gang for hele oversigten');
        check(ov[enId].cost && ov[enId].cost.known === true && ov[enId].cost.price === 12.5
            && ov[enId].cost.source === 'last_purchase', 'en vare med kostpris: known + pris + kilde');
        check(ov[toId].cost && ov[toId].cost.known === false, 'en pris på 0 er IKKE kendt');
        check(ov[enId].in_recipes === 2 && ov[toId].in_recipes === 0, 'opskriftsbrug tælles pr. vare');

        const fejler = { ...grocy,
            getProductUnitCostDetails: async () => { throw new Error('nede'); },
            getAllRecipesPos: async () => { throw new Error('nede'); } };
        const ovF = await sp.priceOverview(fejler, { withCost: true });
        check(ovF[enId].cost === null && ovF[enId].in_recipes === null,
            'fejler opslaget: null (ukendt) — aldrig "kostprisen kender ingen pris"');
        check(ovF[enId].price === base[enId].price, 'og resten af oversigten er urørt');
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`${pass} PASS · ${fail} FAIL`);
    try { require('fs').unlinkSync(TEST_DB); } catch (_) {}
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
