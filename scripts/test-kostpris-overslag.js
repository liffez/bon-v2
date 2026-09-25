// scripts/test-kostpris-overslag.js
// ============================================================
// #657 — kostprisen må bruge et manuelt OVERSLAG, men først til allersidst.
//
// Et overslag er ikke en målt pris. Det er et menneskes bedste bud, gemt som
// et internt varenummer i Grocy. Reglerne der testes her:
//
//   1. alt der er MÅLT vinder — også en pris arvet fra en forælders børn
//   2. uden noget målt er overslaget bedre end "ingen pris", for uden en pris
//      kan en ny opskrift slet ikke prissættes
//   3. kostprisen er KOMPLET når den hviler på et overslag (det er ikke en
//      manglende pris) — men den bærer en advarsel, så et gæt aldrig kan
//      forveksles med noget vi har betalt
//
// Grocy stubbes på HTTP-laget. Ingen netværk.
//
//   node --experimental-sqlite scripts/test-kostpris-overslag.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kostpris-overslag-'));
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

// 10 Spidskål (målt køb) · 11 Hvidkål (målt køb) · 12 kål (forælder)
// 20 Sirup (KUN overslag) · 21 Mel (målt køb OG overslag)
const PRODUKTER = [
    { id: 10, name: 'Spidskål', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: 12 },
    { id: 11, name: 'Hvidkål',  qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: 12 },
    { id: 12, name: 'kål',      qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 20, name: 'Sirup',    qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 21, name: 'Mel',      qu_id_stock: 1, qu_id_purchase: 1 },
    // #706 §11 — leverandørprisen, før overslaget
    { id: 30, name: 'Glutenfri Bolle', qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 31, name: 'Oliven',   qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 32, name: 'Kapers',   qu_id_stock: 1, qu_id_purchase: 1 },
    { id: 33, name: 'Senep',    qu_id_stock: 1, qu_id_purchase: 1 },
];
const KOEB = {
    10: [{ price: 20, amount: 1, purchased_date: offsetISO(-5) }],
    11: [{ price: 30, amount: 1, purchased_date: offsetISO(-5) }],
    21: [{ price: 12, amount: 1, purchased_date: offsetISO(-5) }],
};
let BARCODES = [
    { id: 900, product_id: 20, barcode: 'OVERSLAG-20', qu_id: 1, amount: 1, last_price: 77 },
    { id: 901, product_id: 21, barcode: 'OVERSLAG-21', qu_id: 1, amount: 1, last_price: 999 },
    { id: 902, product_id: 12, barcode: 'OVERSLAG-12', qu_id: 1, amount: 1, last_price: 500 },
    // Mel har OGSÅ en leverandørpris — købet skal stadig vinde
    { id: 903, product_id: 21, barcode: '1111', qu_id: 1, amount: 1, last_price: 55 },
    // Glutenfri Bolle: fakturapris på et internt nummer + et gammelt overslag
    { id: 910, product_id: 30, barcode: 'INT-0001', qu_id: 1, amount: 1, last_price: 4.5 },
    { id: 911, product_id: 30, barcode: 'OVERSLAG-30', qu_id: 1, amount: 1, last_price: 99 },
    // Oliven: to prissatte varenumre, intet foretrukket → flertydigt; overslaget fanger
    { id: 920, product_id: 31, barcode: '2221', qu_id: 1, amount: 1, last_price: 40 },
    { id: 921, product_id: 31, barcode: '2222', qu_id: 1, amount: 1, last_price: 60 },
    { id: 922, product_id: 31, barcode: 'OVERSLAG-31', qu_id: 1, amount: 1, last_price: 50 },
    // Kapers: flertydigt og INTET overslag → ingen pris (vi gætter ikke på den billigste)
    { id: 930, product_id: 32, barcode: '3331', qu_id: 1, amount: 1, last_price: 30 },
    { id: 931, product_id: 32, barcode: '3332', qu_id: 1, amount: 1, last_price: 35 },
    // Senep: to prissatte, det ene foretrukket → det gælder
    { id: 940, product_id: 33, barcode: '4441', qu_id: 1, amount: 1, last_price: 18,
      userfields: { is_preferred: '1' } },
    { id: 941, product_id: 33, barcode: '4442', qu_id: 1, amount: 1, last_price: 12 },
];
let barcodesFejler = false;

const SVAR = {
    '/objects/recipes': [
        { id: 1, name: 'Sirupskage', base_servings: 1,
          userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
    ],
    '/objects/recipes_pos': [
        { id: 1, recipe_id: 1, product_id: 20, amount: 2, qu_id: 1 },
        { id: 2, recipe_id: 1, product_id: 21, amount: 1, qu_id: 1 },
    ],
    '/objects/recipes_nestings': [],
    '/objects/quantity_units': [{ id: 1, name: 'Kilo' }],
    '/objects/quantity_unit_conversions': [],
    '/recipes/fulfillment': [{ recipe_id: 1, costs: 0 }],
    '/objects/stock': [],
    '/objects/stock_entries': [],
};

function logRaekker() {
    // Det samlede opslag (#695): alle tilgange, ikke ét kald pr. produkt.
    let id = 1;
    const ud = [];
    for (const [pid, rows] of Object.entries(KOEB)) {
        for (const r of rows) ud.push({ id: id++, product_id: Number(pid), transaction_type: 'purchase', undone: 0, ...r });
    }
    return ud.sort((a, b) => b.id - a.id);
}

globalThis.fetch = async (url) => {
    const sti = String(url).split('?')[0];
    if (sti.endsWith('/objects/product_barcodes')) {
        if (barcodesFejler) return { ok: false, status: 500, text: async () => 'nede' };
        return { ok: true, status: 200, json: async () => BARCODES };
    }
    if (sti.endsWith('/objects/products')) return { ok: true, status: 200, json: async () => PRODUKTER };
    if (sti.endsWith('/objects/stock_log')) return { ok: true, status: 200, json: async () => logRaekker() };
    const n = Object.keys(SVAR).find(k => sti.endsWith(k));
    if (n) return { ok: true, status: 200, json: async () => SVAR[n] };
    throw new Error('uventet kald: ' + url);
};

async function main() {
    console.log('\n1 · Rækkefølgen: alt der er målt vinder over overslaget');
    grocy.clearCache();
    let d = await grocy.getProductUnitCostDetails(4);

    ok(near(d.get('21')?.cost, 12) && d.get('21')?.source !== 'estimate',
       `Mel har både et køb og et overslag → købet gælder (fik ${d.get('21')?.cost} / ${d.get('21')?.source})`);
    ok(d.get('12')?.source === 'parent_avg' && near(d.get('12')?.cost, 25),
       'kål arver gennemsnittet af sine børn — ikke sit eget overslag på 500');

    console.log('\n2 · Uden noget målt er overslaget bedre end ingen pris');
    ok(d.get('20')?.source === 'estimate' && near(d.get('20')?.cost, 77),
       `Sirup har kun et overslag → 77 kr, mærket som overslag (fik ${d.get('20')?.source})`);
    ok(d.get('20')?.warn === false && d.get('20')?.last_price === null,
       'overslaget udgiver sig ikke for at være et køb');

    console.log('\n3 · Kostprisen er komplet, men bærer en advarsel');
    {
        const res = computeAll({
            recipes: SVAR['/objects/recipes'], pos: SVAR['/objects/recipes_pos'],
            nestings: [], products: PRODUKTER, units: SVAR['/objects/quantity_units'],
            conversions: [],
            priceByProduct: new Map([...d].map(([k, v]) => [k, v.cost])),
            priceDetailByProduct: d,
        }).get(1);

        ok(near(res.cost, 2 * 77 + 12), `kostprisen regnes med overslaget: 2×77 + 12 = ${res.cost}`);
        ok(res.missing_price.size === 0, 'og den er KOMPLET — et overslag er ikke en manglende pris');
        const w = res.warnings.get('estimate:20');
        ok(w && w.kind === 'estimated_price', 'men den bærer en advarsel om at tallet er et gæt');
        ok(!res.warnings.has('estimate:21'), 'Mel, hvis pris ER målt, får ingen overslags-advarsel');
        const txt = describeWarning(w);
        ok(/Sirup/.test(txt) && /overslag/.test(txt) && /varenummer/.test(txt),
           'advarslen siger hvad man kan gøre ved det: ' + txt);
    }

    console.log('\n5 · Leverandørens pris før overslaget (#706 §11, beslutning 14.3)');
    grocy.clearCache();
    d = await grocy.getProductUnitCostDetails(4);
    ok(d.get('30')?.source === 'supplier' && near(d.get('30')?.cost, 4.5),
       `Glutenfri Bolle: fakturaprisen 4,5 vinder over overslaget 99 (fik ${d.get('30')?.cost} / ${d.get('30')?.source})`);
    ok(d.get('30')?.supplier_barcode === 'INT-0001',
       'og det står hvilket varenummer prisen kommer fra');
    ok(near(d.get('21')?.cost, 12) && d.get('21')?.source !== 'supplier',
       'Mel: et målt køb (12) vinder stadig over leverandørens listepris (55)');
    ok(d.get('31')?.source === 'estimate' && near(d.get('31')?.cost, 50),
       `Oliven: flertydigt valg → overslaget, ikke et gæt på et af varenumrene (fik ${d.get('31')?.source})`);
    ok(!d.has('32'),
       'Kapers: flertydigt og intet overslag → ingen pris, ikke den billigste');
    ok(d.get('33')?.source === 'supplier' && near(d.get('33')?.cost, 18),
       'Senep: det foretrukne varenummer gælder, også når et andet er billigere');
    {
        const w = computeAll({
            recipes: [{ id: 2, name: 'Bolle', base_servings: 1, userfields: { sellable: '1' } }],
            pos: [{ id: 9, recipe_id: 2, product_id: 30, amount: 2, qu_id: 1 }],
            nestings: [], products: PRODUKTER, units: SVAR['/objects/quantity_units'], conversions: [],
            priceByProduct: new Map([...d].map(([k, v]) => [k, v.cost])),
            priceDetailByProduct: d,
        }).get(2);
        ok(near(w.cost, 9) && w.missing_price.size === 0, `kostprisen regnes med leverandørprisen: 2 × 4,5 = ${w.cost}`);
        ok(!w.warnings.has('estimate:30'), 'en leverandørpris er ikke et gæt — ingen overslags-advarsel');
    }

    console.log('\n4 · Kan varenumrene ikke læses, falder kostprisen bare tilbage');
    barcodesFejler = true;
    grocy.clearCache();
    // Kastede den, ville HELE kostprisen forsvinde for alle varer — ikke bare
    // overslagene. Derfor en assert på at den overhovedet svarer.
    let kastede = null;
    try { d = await grocy.getProductUnitCostDetails(4); }
    catch (e) { kastede = e; d = new Map(); }
    ok(!kastede, 'kostprisen regnes stadig' + (kastede ? ' — men kastede: ' + kastede.message : ''));
    ok(!d.has('20'), 'Sirup står uden pris — den rapporteres som manglende, ikke som 0 kr');
    ok(near(d.get('21')?.cost, 12), 'og de målte priser er upåvirkede');
    barcodesFejler = false;

    console.log('\n' + '─'.repeat(60));
    console.log(`${pass} PASS · ${fail} FAIL`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
