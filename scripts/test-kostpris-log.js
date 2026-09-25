// scripts/test-kostpris-log.js
// ============================================================
// #695 — kostprisens købshistorik hentes i ÉT log-opslag, ikke pr. produkt.
//
// Før: ét `stock_log`-kald pr. produkt + `/stock/products/:id` for varer uden
// køb — 277 kald og ~9 s mod grocy-hq. Nu: `/objects/stock_log` side for side.
// Reglerne der testes her:
//
//   1. ét opslag for hele kataloget, og aldrig `/stock/products/:id`
//   2. side for side: et loft skærer aldrig rækker væk, og en række der
//      kommer igen på næste side tælles ikke to gange
//   3. filtrene holder i koden, også hvis Grocy ignorerer en query —
//      forbrug og fortrudte køb kommer aldrig ind i en kostpris
//   4. trin 3's "seneste pris" følger Grocys regel: nyeste KØBSDATO, ikke
//      nyeste række; `stock-edit-old` og prisløse rækker er ikke priser
//   5. hullet er lukket: et prisløst køb skjuler ikke en pris fra en optælling
//   6. en pris der ikke stammer fra et køb, mærkes (price_not_purchased)
//   7. kan loggen ikke læses, kastes der — og intet forkert svar caches
//
// Grocy stubbes på HTTP-laget. Ingen netværk.
//
//   node --experimental-sqlite scripts/test-kostpris-log.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kostpris-log-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { getDb } = require('../db/database');
const db = getDb();
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('default_grocy_location_id','1')`).run();
db.prepare(`UPDATE locations SET grocy_api_url='https://eksempel/api', grocy_api_key='n' WHERE id=1`).run();

const grocy = require('../services/grocyAdapter');
const { computeAll, describeWarning } = require('../services/recipeCost');
const { offsetISO } = require('../db/helpers');

let pass = 0, fail = 0;
const ok   = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

// 10 Spidskål — købt (i vinduet)
// 20 Salat boks — kun et PRISLØST køb, men en optælling med pris (hullet)
// 30 kikærter — rettet lagerpost med GAMMEL dato + nyere egenproduktion
// 40 Sukker — kun forbrug og et fortrudt køb: ingen pris må komme ind
// 50 Rødløg — to optællinger samme dato: den senest skrevne vinder
const PRODUKTER = [
    { id: 10, name: 'Spidskål',  qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 20, name: 'Salat boks', qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 30, name: 'kikærter',  qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 40, name: 'Sukker',    qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 50, name: 'Rødløg',    qu_id_stock: 1, qu_id_purchase: 1 },
];
const d = n => offsetISO(n);
const LOG = [
    { id: 1,  product_id: 10, transaction_type: 'purchase',             undone: 0, amount: 2, price: 20, purchased_date: d(-10) },
    { id: 2,  product_id: 10, transaction_type: 'consume',              undone: 0, amount: -1, price: 999, purchased_date: d(-2) },
    { id: 3,  product_id: 20, transaction_type: 'purchase',             undone: 0, amount: 60, price: 0,  purchased_date: d(-300) },
    { id: 4,  product_id: 20, transaction_type: 'inventory-correction', undone: 0, amount: 5, price: 3.5, purchased_date: d(-200) },
    { id: 5,  product_id: 30, transaction_type: 'self-production',      undone: 0, amount: 1, price: 40.58, purchased_date: d(-100) },
    // Skrevet SENERE (højere id), men retter en lagerpost fra før — Grocy
    // går efter købsdatoen, så 40,58 vinder over 40.
    { id: 6,  product_id: 30, transaction_type: 'stock-edit-old',       undone: 0, amount: 1, price: 0,   purchased_date: d(-400) },
    { id: 7,  product_id: 30, transaction_type: 'stock-edit-new',       undone: 0, amount: 1, price: 40,  purchased_date: d(-400) },
    { id: 8,  product_id: 40, transaction_type: 'purchase',             undone: 1, amount: 1, price: 650, purchased_date: d(-5) },
    { id: 9,  product_id: 40, transaction_type: 'consume',              undone: 0, amount: -1, price: 650, purchased_date: d(-4) },
    { id: 10, product_id: 50, transaction_type: 'inventory-correction', undone: 0, amount: 1, price: 9,   purchased_date: d(-20) },
    { id: 11, product_id: 50, transaction_type: 'inventory-correction', undone: 0, amount: 1, price: 11,  purchased_date: d(-20) },
];

const kald = [];
let logFejler = false;
let nyRaekkeEfterSide1 = null;   // skrives "imens" der hentes side for side
// Attrappen IGNORERER undone/amount-filtrene med vilje (regel 3), men
// respekterer limit/offset, så side for side kan måles.
globalThis.fetch = async (url) => {
    const u = String(url);
    kald.push(u);
    const sti = u.split('?')[0];
    if (sti.endsWith('/objects/stock_log')) {
        if (logFejler) return { ok: false, status: 500, text: async () => 'nede' };
        const q = new URLSearchParams(u.split('?')[1] || '');
        const limit = Number(q.get('limit')) || LOG.length;
        const offset = Number(q.get('offset')) || 0;
        const sorteret = [...LOG].sort((a, b) => b.id - a.id);
        const side = sorteret.slice(offset, offset + limit);
        if (nyRaekkeEfterSide1 && offset === 0) { LOG.push(nyRaekkeEfterSide1); nyRaekkeEfterSide1 = null; }
        return { ok: true, status: 200, json: async () => side };
    }
    if (sti.endsWith('/objects/products')) return { ok: true, status: 200, json: async () => PRODUKTER };
    if (sti.endsWith('/objects/stock')) return { ok: true, status: 200, json: async () => [] };
    if (sti.endsWith('/objects/product_barcodes')) return { ok: true, status: 200, json: async () => [] };
    throw new Error('uventet kald: ' + u);
};

async function main() {
    console.log('\n1 · Ét opslag for hele kataloget');
    grocy.clearCache();
    kald.length = 0;
    const det = await grocy.getProductUnitCostDetails(6);
    const logKald = kald.filter(u => u.includes('/objects/stock_log'));
    ok(logKald.length === 1, `loggen spørges én gang, ikke pr. vare (${logKald.length} kald)`);
    ok(!kald.some(u => /\/stock\/products\/\d+/.test(u)), 'og /stock/products/:id spørges aldrig');
    ok(!logKald.some(u => /product_id/.test(decodeURIComponent(u))), 'opslaget er ikke afgrænset til ét produkt');
    ok(!logKald.some(u => /purchased_date|row_created_timestamp%3E/.test(u)),
       'intet datofilter — trin 2 bruger seneste køb uanset alder');

    console.log('\n2 · Side for side');
    kald.length = 0;
    const sider = await grocy.fetchStockLogIntakes(3);
    const sideKald = kald.filter(u => u.includes('/objects/stock_log'));
    ok(sideKald.length === Math.ceil(LOG.length / 3) + (LOG.length % 3 === 0 ? 1 : 0),
       `sider á 3 → ${sideKald.length} kald, til en side er kortere end loftet`);
    const alle = await grocy.fetchStockLogIntakes(1000);
    ok(JSON.stringify(sider.map(r => r.id)) === JSON.stringify(alle.map(r => r.id)),
       'små sider giver præcis de samme rækker i samme rækkefølge som én stor');
    ok(sideKald.every(u => /order=id%3Adesc/.test(u)), 'sorteret på id (entydigt), ikke på tidsstempel');

    // En postering skrevet MENS der hentes, skubber alt én plads ned: sidste
    // række på side 1 kommer igen øverst på side 2. Den må kun tælle én gang —
    // ellers vejer et køb dobbelt i snittet.
    nyRaekkeEfterSide1 = { id: 99, product_id: 50, transaction_type: 'consume', undone: 0,
                           amount: -1, price: 11, purchased_date: d(-1) };
    // Sider á 2: side 1 = [11, 10]; efter den nye række er side 2 = [10, 9],
    // så optællingen #10 (en rigtig tilgang med pris) kommer igen.
    const underSkriv = await grocy.fetchStockLogIntakes(2);
    const ids = underSkriv.map(r => r.id);
    ok(ids.length === new Set(ids).size,
       `en række der kommer igen på næste side, tælles én gang (${ids.length} rækker, ${new Set(ids).size} forskellige)`);
    ok(ids.filter(i => i === 10).length === 1, 'optællingen #10 står der præcis én gang');
    LOG.pop();

    console.log('\n3 · Filtrene holder i koden');
    ok(!alle.some(r => r.transaction_type === 'consume'), 'forbrug kommer aldrig med (negativ mængde)');
    ok(!alle.some(r => Number(r.undone) === 1), 'et fortrudt køb kommer aldrig med');
    ok(!det.has('40'), `Sukker har kun forbrug og et fortrudt køb → ingen pris (fik ${det.get('40')?.cost})`);

    console.log('\n4 · Trin 3 følger Grocys regel for "seneste pris"');
    ok(near(det.get('30')?.cost, 40.58),
       `nyeste KØBSDATO vinder: egenproduktionen 40,58 slår den senere rettelse af en gammel post (fik ${det.get('30')?.cost})`);
    ok(det.get('30')?.last_price_type === 'self-production', 'og typen følger med');
    ok(near(det.get('50')?.cost, 11), `samme dato → den senest skrevne vinder (fik ${det.get('50')?.cost})`);
    const le = grocy.lastEntryFromLog([
        { id: 1, transaction_type: 'stock-edit-old', price: 99, purchased_date: d(-1) },
        { id: 2, transaction_type: 'product-opened', price: 88, purchased_date: d(-1) },
        { id: 3, transaction_type: 'inventory-correction', price: 0, purchased_date: d(-1) },
    ]);
    ok(le === null, 'stock-edit-old, product-opened og prisløse rækker er ikke priser');

    console.log('\n5 · Hullet er lukket');
    ok(near(det.get('20')?.cost, 3.5) && det.get('20')?.source === 'last',
       `et prisløst køb skjuler ikke optællingens pris (fik ${det.get('20')?.cost} / ${det.get('20')?.source})`);
    ok(near(det.get('10')?.cost, 20) && det.get('10')?.source === 'avg_window',
       'en vare med et rigtigt køb bruger stadig købet — trin 3 rører den ikke');

    console.log('\n6 · En pris der ikke er et køb, mærkes');
    {
        const res = computeAll({
            recipes: [{ id: 1, name: 'Salatbar', base_servings: 1, userfields: {} }],
            pos: [
                { id: 1, recipe_id: 1, product_id: 20, amount: 2, qu_id: 1 },
                { id: 2, recipe_id: 1, product_id: 10, amount: 1, qu_id: 1 },
            ],
            nestings: [], products: PRODUKTER, units: [{ id: 1, name: 'Kilo' }], conversions: [],
            priceByProduct: new Map([...det].map(([k, v]) => [k, v.cost])),
            priceDetailByProduct: det,
        }).get(1);
        ok(near(res.cost, 2 * 3.5 + 20), `kostprisen regnes med optællingens pris: 2×3,5 + 20 = ${res.cost}`);
        ok(res.missing_price.size === 0, 'og den er KOMPLET — prisen findes, den er bare ikke betalt');
        const w = res.warnings.get('unpurchased:20');
        ok(w && w.kind === 'price_not_purchased' && w.entry_type === 'inventory-correction',
           'Salat boks bærer en advarsel om hvor prisen kommer fra');
        ok(!res.warnings.has('unpurchased:10'), 'Spidskål, der ER købt, får ingen');
        const txt = describeWarning(w);
        ok(/Salat boks/.test(txt) && /lagerrettelse/.test(txt) && /ikke et køb/.test(txt),
           'teksten siger hvor den kommer fra: ' + txt);
    }

    console.log('\n7 · Kan loggen ikke læses, kastes der — og intet caches');
    grocy.clearCache();
    logFejler = true;
    let kastede = null;
    try { await grocy.getProductUnitCostDetails(6); } catch (e) { kastede = e; }
    ok(!!kastede, 'et svar uden købshistorik ville se rigtigt ud — derfor en fejl i stedet');
    logFejler = false;
    kald.length = 0;
    const igen = await grocy.getProductUnitCostDetails(6);
    ok(kald.some(u => u.includes('/objects/stock_log')) && near(igen.get('10')?.cost, 20),
       'og næste kald spørger igen i stedet for at servere noget halvt fra cachen');

    console.log('\n' + '─'.repeat(60));
    console.log(`${pass} PASS · ${fail} FAIL`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
