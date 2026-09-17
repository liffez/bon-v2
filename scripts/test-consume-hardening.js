// scripts/test-consume-hardening.js
// ============================================================
// Tests for hærdningen af consume-/varemodtagelses-stien:
//
//   #358  varemodtagelse skrev indkøbs-enhed som lager-enhed
//   #359  inventory_deducted blev sat selvom hvert Grocy-træk fejlede
//   #361  consume-endpoints havde ingen idempotens
//
// De tre deler rod (enheds-forveksling + manglende idempotens), og de deler
// derfor også test-opsætning her.
//
// Grocy-adapteren er STUBBET (require-cache overskrives før db/helpers loades),
// så testen kan fremprovokere præcis de tilstande der er svære at ramme i drift:
// "hvert eneste kald fejler", "kun ét fejler", "ingen konvertering findes".
// Det var netop fordi de tilstande aldrig blev testet at fejlene overlevede.
//
//   node --experimental-sqlite scripts/test-consume-hardening.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-consume-hardening-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── Grocy-stub. Skal ligge i require-cachen FØR noget loader adapteren ──────
const grocyPath = require.resolve('../services/grocyAdapter');
const realGrocy = require(grocyPath);
const stub = {
    _addCalls: [],
    _consumeResults: null,
    _throwMeta: false,
    products: [
        // Spidskål: købes i Antal, lagerføres i Kilo (1 Antal = 0,5 Kilo).
        // Præcis den vare der blev fordoblet i drift 3. juni.
        { id: 10, name: 'Spidskål', qu_id_stock: 2, qu_id_purchase: 1 },
        // Mel: samme enhed begge veje — ingen tvetydighed.
        { id: 11, name: 'Mel', qu_id_stock: 2, qu_id_purchase: 2 },
        // Karton: forskellige enheder, men INGEN konvertering findes i Grocy.
        { id: 12, name: 'Karton', qu_id_stock: 2, qu_id_purchase: 3 },
    ],
    conversions: [
        { product_id: 10, from_qu_id: 1, to_qu_id: 2, factor: 0.5 },
    ],
};
require.cache[grocyPath].exports = {
    ...realGrocy,
    getProducts: async () => stub.products,
    getQuantityUnitConversions: async () => stub.conversions,
    addToStock: async (pid, amount) => { stub._addCalls.push({ pid, amount }); },
    // Varemodtagelsen bruger addToStockFull fra #657 (for at kunne sende en pris med).
    addToStockFull: async (pid, body) => { stub._addCalls.push({ pid, amount: body.amount, body }); },
    getProductBarcodes: async () => [],
    getQuantityUnits: async () => [],
    updateProductUserfields: async () => {},
    updateShoppingListItem: async () => {},
    deleteShoppingListItem: async () => {},
    consumeRecipes: async () => stub._consumeResults,
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const helpers = require('../db/helpers');
const { getStatusId, getDefaultLocationId } = helpers;
const { resolveToStockAmount } = require('../services/quConvert');
const { findUndeducted, findPartial } = require('./check-inventory-deduct');
const db = getDb();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    /* ══════════════════════════════════════════════════════════════════════════
       #358 — enheds-omregning (ren funktion)
       ══════════════════════════════════════════════════════════════════════════ */
    head('#358 — resolveToStockAmount');
    {
        const conv = stub.conversions;
        const P = id => stub.products.find(p => p.id === id);

        // Drifts-scenariet: 10 "Antal" spidskål skal blive til 5 kg, ikke 10.
        const r1 = resolveToStockAmount({ product: P(10), amount: 10, quId: 1, conversions: conv });
        check(r1.error === null && r1.amount === 5,
            `10 Antal spidskål → 5 Kilo (var 10 før fixet) — fik ${r1.amount}`);

        // Samme enhed → uændret, ingen konvertering nødvendig.
        const r2 = resolveToStockAmount({ product: P(11), amount: 7, quId: 2, conversions: conv });
        check(r2.error === null && r2.amount === 7 && r2.factor === 1, 'samme enhed → uændret mængde');

        // Eksplicit lager-enhed på et tvetydigt produkt skal også gå igennem urørt.
        const r3 = resolveToStockAmount({ product: P(10), amount: 4, quId: 2, conversions: conv });
        check(r3.error === null && r3.amount === 4, 'eksplicit lager-enhed → uændret');

        // Ingen konvertering → FEJL, ikke et gæt. Kernen i issuets beslutning.
        const r4 = resolveToStockAmount({ product: P(12), amount: 3, quId: 3, conversions: conv });
        check(r4.error !== null && r4.amount === null,
            'manglende konvertering → fejl frem for gæt');

        // Enhed ikke oplyst + tvetydigt produkt → fejl (cachet klient efter deploy).
        const r5 = resolveToStockAmount({ product: P(10), amount: 10, quId: null, conversions: conv });
        check(r5.error !== null, 'ingen enhed oplyst på tvetydigt produkt → fejl');

        // Enhed ikke oplyst + entydigt produkt → OK. Gammel klient må ikke brække
        // varemodtagelse af varer hvor der aldrig var noget at forveksle.
        const r6 = resolveToStockAmount({ product: P(11), amount: 9, quId: null, conversions: conv });
        check(r6.error === null && r6.amount === 9, 'ingen enhed oplyst på entydigt produkt → OK');

        // Ukendt produkt / manglende lager-enhed → fejl.
        check(resolveToStockAmount({ product: null, amount: 1, quId: 1, conversions: conv }).error !== null,
            'ukendt produkt → fejl');
        check(resolveToStockAmount({ product: { id: 99, qu_id_stock: null }, amount: 1, quId: 1, conversions: conv }).error !== null,
            'produkt uden lager-enhed → fejl');

        // Omvendt retning skal også findes (reverse-opslag i findConversionFactor).
        const r7 = resolveToStockAmount({
            product: { id: 20, qu_id_stock: 1, qu_id_purchase: 2 },
            amount: 5, quId: 2,
            conversions: [{ product_id: 20, from_qu_id: 1, to_qu_id: 2, factor: 0.5 }],
        });
        check(r7.error === null && r7.amount === 10, 'reverse-konvertering: 5 → 10');
    }

    /* ══════════════════════════════════════════════════════════════════════════
       #358 — hele varemodtagelses-stien over HTTP-laget (route-handleren direkte)
       ══════════════════════════════════════════════════════════════════════════ */
    head('#358 — goods-receipts skriver lager-enhed til Grocy');
    {
        // Kald route-handleren direkte med falske req/res, så vi rammer den ÆGTE
        // kode (inkl. transaction + item-insert) uden at skulle rejse en server.
        const grRouter = require('../routes/goods-receipts');
        const layer = grRouter.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
        // Sidste handler i kæden er selve forretningslogikken (requireAuth ligger før).
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;

        async function postReceipt(items) {
            stub._addCalls = [];
            let body = null, status = 200;
            const req = { body: { supplier_name: 'Test', received_by_name: 'Tester', items }, session: { userId: null, userRole: 'admin' } };
            const res = {
                status(c) { status = c; return this; },
                json(b)   { body = b; return this; },
            };
            await handler(req, res, err => { if (err) throw err; });
            return { status, body };
        }

        const r = await postReceipt([
            { grocy_product_id: 10, product_name: 'Spidskål', expected_quantity: 10, received_quantity: 10, qu_id: 1, unit: 'Antal', status: 'ok' },
            { grocy_product_id: 11, product_name: 'Mel',      expected_quantity: 3,  received_quantity: 3,  qu_id: 2, unit: 'Kilo',  status: 'ok' },
        ]);

        const spids = stub._addCalls.find(c => c.pid === 10);
        check(spids && spids.amount === 5,
            `Grocy fik 5 (lager-enhed) for 10 Antal spidskål — fik ${spids && spids.amount}`);
        check(stub._addCalls.find(c => c.pid === 11)?.amount === 3, 'entydigt produkt går uændret igennem');

        // Begge tal gemt, så en fremtidig afvigelse kan afgøres uden at gætte.
        const rows = db.prepare(
            `SELECT product_name, received_quantity, received_qu_id, received_quantity_stock
             FROM goods_receipt_items WHERE receipt_id = ? ORDER BY id`
        ).all(r.body.receipt_id ?? r.body.id);
        const sp = rows.find(x => x.product_name === 'Spidskål');
        check(sp && sp.received_quantity === 10 && sp.received_quantity_stock === 5 && sp.received_qu_id === 1,
            'begge tal + enhed gemt på linjen (10 Antal → 5 Kilo)');

        // Manglende konvertering: lageret røres IKKE, og receiptet beder om hjælp.
        const r2 = await postReceipt([
            { grocy_product_id: 12, product_name: 'Karton', expected_quantity: 2, received_quantity: 2, qu_id: 3, unit: 'Kasse', status: 'ok' },
        ]);
        check(stub._addCalls.length === 0, 'manglende konvertering → addToStock kaldes ALDRIG');
        check(r2.body.status === 'partially_approved',
            `receipt markeret partially_approved — fik '${r2.body.status}'`);
        const kartonErr = db.prepare(
            `SELECT grocy_error, grocy_added FROM goods_receipt_items
             WHERE product_name = 'Karton' ORDER BY id DESC LIMIT 1`
        ).get();
        check(kartonErr && kartonErr.grocy_added === 0 && /omregning/i.test(kartonErr.grocy_error || ''),
            'fejlen står på linjen, så nogen kan handle på den');

        // Manuelt tilføjet vare (uden Grocy-produkt) må ikke fejle noget.
        const r3 = await postReceipt([
            { grocy_product_id: null, product_name: 'Manuel vare', received_quantity: 1, status: 'ok' },
        ]);
        check(r3.body.status === 'approved' && stub._addCalls.length === 0,
            'manuel vare uden Grocy-produkt: ingen fejl, intet lagertræk');
    }

    /* ══════════════════════════════════════════════════════════════════════════
       #359 — inventory_deducted må kun påstå noget der skete
       ══════════════════════════════════════════════════════════════════════════ */
    head('#359 — inventory_deducted + status');
    {
        db.prepare(`INSERT INTO settings (key, value) VALUES ('inventory_auto_deduct', '1')
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

        let counter = 9100;
        function mkBon() {
            const id = counter++;
            db.prepare(`
                INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date,
                                  inventory_deducted, is_offer, total_price, created_at, updated_at)
                VALUES (?, ?, ?, ?, date('now'), date('now'), 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(id, 'B' + id, getStatusId('LEVERET'), getDefaultLocationId());
            db.prepare(`
                INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, quantity, unit_price, line_total)
                VALUES (?, 1, 'Testvare', 1, 0, 0)
            `).run(id);
            return id;
        }
        const state = id => db.prepare(
            `SELECT inventory_deducted, inventory_deduct_status FROM bons WHERE id = ?`).get(id);

        // (a) ALT fejlede — den tilstand der før stod som "lager trukket".
        stub._consumeResults = [
            { product_id: 1, product_name: 'A', success: false, error: 'HTTP 500' },
            { product_id: 2, product_name: 'B', success: false, error: 'HTTP 500' },
        ];
        const bonFail = mkBon();
        helpers.autoConsumeBonInventory(bonFail);
        await sleep(60);
        const sFail = state(bonFail);
        check(sFail.inventory_deducted === 0,
            'alle træk fejlede → flaget bliver på 0 (var 1 før fixet)');
        check(sFail.inventory_deduct_status === 'failed', "status = 'failed'");
        check(findUndeducted(db, 3).some(r => r.id === bonFail),
            'vagthunden ser den fejlede bon (den var usynlig før)');

        // (b) DELVIST — flaget SKAL sættes (ellers dobbelt-træk ved gentagelse),
        //     men tilstanden skal være synlig.
        stub._consumeResults = [
            { product_id: 1, product_name: 'A', success: true,  amount: 2 },
            { product_id: 2, product_name: 'B', success: false, error: 'HTTP 500' },
        ];
        const bonPartial = mkBon();
        helpers.autoConsumeBonInventory(bonPartial);
        await sleep(60);
        const sPart = state(bonPartial);
        check(sPart.inventory_deducted === 1, 'delvist træk → flaget sættes (beskytter det der lykkedes)');
        check(sPart.inventory_deduct_status === 'partial', "status = 'partial'");
        check(!findUndeducted(db, 3).some(r => r.id === bonPartial),
            'delvis bon er (korrekt) ikke i "ikke trukket"-listen');
        check(findPartial(db, 3).some(r => r.id === bonPartial),
            'vagthunden fanger den DELVISE bon via findPartial — den var helt usynlig før');

        // (c) ALT LYKKEDES.
        stub._consumeResults = [{ product_id: 1, product_name: 'A', success: true, amount: 2 }];
        const bonOk = mkBon();
        helpers.autoConsumeBonInventory(bonOk);
        await sleep(60);
        check(state(bonOk).inventory_deducted === 1 && state(bonOk).inventory_deduct_status === 'ok',
            "alt trukket → flag 1 + status 'ok'");

        // (d) INTET AT TRÆKKE — legitim slutstilstand. Flaget skal sættes, ellers
        //     ville vagthunden råbe hver eneste dag om en bon uden opskriftslinjer.
        stub._consumeResults = [];
        const bonEmpty = mkBon();
        helpers.autoConsumeBonInventory(bonEmpty);
        await sleep(60);
        check(state(bonEmpty).inventory_deducted === 1 && state(bonEmpty).inventory_deduct_status === 'empty',
            "intet at trække → flag 1 + status 'empty' (ingen falsk alarm)");

        // (e) Idempotens-vagten holder stadig: et andet kald må ikke trække igen.
        stub._consumeResults = [{ product_id: 1, product_name: 'A', success: true, amount: 2 }];
        let called = false;
        const prev = require.cache[grocyPath].exports.consumeRecipes;
        require.cache[grocyPath].exports.consumeRecipes = async () => { called = true; return stub._consumeResults; };
        helpers.autoConsumeBonInventory(bonOk);
        await sleep(60);
        check(called === false, 'allerede trukket bon trækker ikke igen (idempotens intakt)');
        require.cache[grocyPath].exports.consumeRecipes = prev;

        // (f) Og en FEJLET bon kan gentages — det er hele pointen med at lade flaget stå.
        stub._consumeResults = [{ product_id: 1, product_name: 'A', success: true, amount: 2 }];
        helpers.autoConsumeBonInventory(bonFail);
        await sleep(60);
        check(state(bonFail).inventory_deducted === 1 && state(bonFail).inventory_deduct_status === 'ok',
            'fejlet bon kan trækkes igen og ender korrekt');
    }

    /* ══════════════════════════════════════════════════════════════════════════
       #361 — idempotens på consume-endpoints
       ══════════════════════════════════════════════════════════════════════════ */
    head('#361 — consume-idempotens');
    {
        const gRouter = require('../routes/grocy');
        const find = (p) => {
            const l = gRouter.stack.find(x => x.route && x.route.path === p && x.route.methods.post);
            return l.route.stack[l.route.stack.length - 1].handle;
        };
        const consumeProductsHandler = find('/consume-products');

        let consumeCalls = 0;
        require.cache[grocyPath].exports.consumeProduct = async () => { consumeCalls++; };
        require.cache[grocyPath].exports.clearCache = () => {};

        async function post(handler, body) {
            let out = null, status = 200;
            const res = { status(c) { status = c; return this; }, json(b) { out = b; return this; } };
            await handler({ body, session: { userId: null } }, res, err => { if (err) throw err; });
            return { status, body: out };
        }

        // Uden nonce → afvist. Et tavst dobbelt-træk er værre end en fejlbesked.
        const noNonce = await post(consumeProductsHandler, { items: [{ product_id: 1, amount: 1 }] });
        check(noNonce.status === 400 && noNonce.body.code === 'NONCE_REQUIRED',
            'kald uden nonce afvises med 400');
        check(consumeCalls === 0, 'afvist kald trak intet lager');

        // Første kald trækker.
        const nonce = 'test-nonce-1';
        const first = await post(consumeProductsHandler, { items: [{ product_id: 1, amount: 1 }, { product_id: 2, amount: 2 }], consume_nonce: nonce });
        check(first.status === 200 && first.body.consumed === 2, 'første kald trækker 2 produkter');
        check(consumeCalls === 2, 'to Grocy-consume-kald');

        // Andet klik med samme nonce → INTET nyt træk. Kernen i #361.
        const second = await post(consumeProductsHandler, { items: [{ product_id: 1, amount: 1 }, { product_id: 2, amount: 2 }], consume_nonce: nonce });
        check(consumeCalls === 2, 'gentaget kald trak IKKE lager igen (var dobbelt-træk før fixet)');
        check(second.body.idempotent === true, 'svaret er markeret idempotent');
        check(second.body.consumed === 2, 'det oprindelige resultat spilles tilbage');

        // Ny nonce = ny handling → trækker igen (brugeren må gerne producere to gange).
        await post(consumeProductsHandler, { items: [{ product_id: 1, amount: 1 }], consume_nonce: 'test-nonce-2' });
        check(consumeCalls === 3, 'ny nonce trækker igen (bevidst gentagelse er stadig mulig)');

        // Igangværende træk (claim uden svar) → 409, ikke et opdigtet resultat.
        db.prepare(`INSERT INTO grocy_consume_log (nonce, endpoint, state) VALUES ('busy-nonce', 'consume-products', 'in_progress')`).run();
        const busy = await post(consumeProductsHandler, { items: [{ product_id: 1, amount: 1 }], consume_nonce: 'busy-nonce' });
        check(busy.status === 409 && busy.body.code === 'CONSUME_IN_PROGRESS',
            'samtidigt kald får 409 i stedet for et gættet svar');
        check(consumeCalls === 3, 'det samtidige kald trak intet');

        // Journalen er samtidig kvitteringen #361 efterlyste.
        const logged = db.prepare(`SELECT * FROM grocy_consume_log WHERE nonce = ?`).get(nonce);
        check(logged && logged.state === 'done' && logged.response_json,
            'trækket er journaliseret med resultat (var usynligt bagefter før)');

        // Samme beskyttelse på /consume.
        let recipeCalls = 0;
        require.cache[grocyPath].exports.consumeRecipes = async () => { recipeCalls++; return [{ product_id: 1, success: true }]; };
        const consumeHandler = find('/consume');
        const lines = [{ grocy_recipe_id: 1, quantity: 1 }];
        await post(consumeHandler, { lines, consume_nonce: 'recipe-nonce' });
        await post(consumeHandler, { lines, consume_nonce: 'recipe-nonce' });
        check(recipeCalls === 1, '/consume er beskyttet af samme nonce-mekanisme');
        const noN = await post(consumeHandler, { lines });
        check(noN.status === 400, '/consume uden nonce afvises');
    }

}

/* ── Resultat ────────────────────────────────────────────── */
main().then(() => {
console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass} PASS · ${fail} FAIL`);
try { fs.unlinkSync(TEST_DB); } catch (_) {}
try { fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
try { fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
process.exit(fail === 0 ? 0 : 1);
}).catch(err => { console.error('FATAL:', err); process.exit(2); });
