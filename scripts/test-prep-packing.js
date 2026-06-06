// scripts/test-prep-packing.js
// ============================================================
// Regressions-test for pakke-overrides (CLAUDE_EVENT.md §6).
//
// Verificerer at consumeRecipes(lines, overrides) trækker den OVERRIDEDE
// mængde fra Grocy i stedet for den BOM-beregnede. Mocker:
//   - ingredientResolver.resolveConsumeItems (canned items)
//   - global.fetch (Grocy stock/products GET + consume POST capture)
//
// Kør:
//   node --experimental-sqlite scripts/test-prep-packing.js
// ============================================================

'use strict';
const path = require('path');
const Module = require('module');

// ── Mock ingredientResolver FØR grocyAdapter loades ──
const MOCK_ITEMS = [
    { product_id: 1, product_name: 'Brød Rug', amount_stock: 30, qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null, purchase_factor: 1 },
    { product_id: 2, product_name: 'Falaffel', amount_stock: 60, qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null, purchase_factor: 1 },
];
const resolverPath = path.resolve(__dirname, '../services/ingredientResolver.js');
require.cache[resolverPath] = {
    id: resolverPath, filename: resolverPath, loaded: true, exports: {
        resolveConsumeItems: async () => MOCK_ITEMS.map(i => ({ ...i })),
        resolveIngredients: async () => ({ production: { ingredients: [], groups: [] }, raw: { ingredients: [], groups: [] } }),
    },
};

// ── Mock global.fetch ──
const consumeCalls = [];   // { product_id, amount }
global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts?.method || 'GET').toUpperCase();
    // Stock: rigeligt på lager så intet bliver partial
    if (u.includes('/stock') && method === 'GET' && !/products\/\d+/.test(u)) {
        return { ok: true, status: 200, json: async () => ([
            { product_id: 1, amount: 1000 }, { product_id: 2, amount: 1000 },
        ]) };
    }
    // Products
    if (u.includes('/objects/products')) {
        return { ok: true, status: 200, json: async () => ([
            { id: 1, name: 'Brød Rug', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null },
            { id: 2, name: 'Falaffel', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null },
        ]) };
    }
    // Consume POST → capture
    const m = u.match(/\/stock\/products\/(\d+)\/consume/);
    if (m && method === 'POST') {
        const body = JSON.parse(opts.body);
        consumeCalls.push({ product_id: parseInt(m[1]), amount: body.amount });
        return { ok: true, status: 200, json: async () => ([{ id: 'tx_' + m[1] }]) };
    }
    // Default: tomt OK
    return { ok: true, status: 200, json: async () => ([]) };
};

// Sæt env så grocyAdapter har en base-url (ellers kan getGrocyConfig fejle)
process.env.GROCY_TEST_URL = process.env.GROCY_TEST_URL || 'http://mock.local/api';
process.env.GROCY_TEST_KEY = process.env.GROCY_TEST_KEY || 'mock';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

(async () => {
    const grocy = require('../services/grocyAdapter');
    const lines = [{ grocy_recipe_id: 91, quantity: 30 }];

    console.log('\nPakke-override → consume regressionstest\n');

    // S1: uden overrides → beregnet mængde (30 / 60)
    console.log('S1 · Uden override — beregnet mængde trækkes');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines);
    const brod1 = consumeCalls.find(c => c.product_id === 1);
    const fal1  = consumeCalls.find(c => c.product_id === 2);
    ok(brod1?.amount === 30, `Brød Rug = 30 (beregnet), fik ${brod1?.amount}`);
    ok(fal1?.amount === 60, `Falaffel = 60 (beregnet), fik ${fal1?.amount}`);

    // S2: override Brød Rug 30→40 (Map) → 40 trækkes, Falaffel uberørt
    console.log('\nS2 · Override 30→40 (Map) — override-mængde trækkes');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, new Map([[1, 40]]));
    const brod2 = consumeCalls.find(c => c.product_id === 1);
    const fal2  = consumeCalls.find(c => c.product_id === 2);
    ok(brod2?.amount === 40, `Brød Rug = 40 (override), fik ${brod2?.amount}`);
    ok(fal2?.amount === 60, `Falaffel = 60 (uberørt), fik ${fal2?.amount}`);

    // S3: override via plain object
    console.log('\nS3 · Override via plain object');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, { 2: 100 });
    const fal3 = consumeCalls.find(c => c.product_id === 2);
    ok(fal3?.amount === 100, `Falaffel = 100 (object-override), fik ${fal3?.amount}`);

    // S4: override til 0 → produktet trækkes ikke (amount 0 → skippes af partial-logik)
    console.log('\nS4 · Override til 0 — intet træk for det produkt');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, new Map([[1, 0]]));
    const brod4 = consumeCalls.find(c => c.product_id === 1);
    ok(!brod4, `Brød Rug ikke trukket ved override=0 (fik ${brod4?.amount ?? 'intet'})`);

    // S5: orphan-override (produkt ikke i opskrift) ignoreres uden at påvirke andre
    console.log('\nS5 · Orphan-override ignoreres');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, new Map([[999, 50]]));
    const brod5 = consumeCalls.find(c => c.product_id === 1);
    const orphan = consumeCalls.find(c => c.product_id === 999);
    ok(brod5?.amount === 30 && !orphan, 'Beregnet mængde bevaret, orphan ikke trukket');

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
