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
// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

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
            { product_id: 1, amount: 1000 }, { product_id: 2, amount: 1000 }, { product_id: 3, amount: 1000 },
        ]) };
    }
    // Products (3 = Mayonnaise, bruges som ekstra-vare der ikke er i opskriften)
    if (u.includes('/objects/products')) {
        return { ok: true, status: 200, json: async () => ([
            { id: 1, name: 'Brød Rug', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null },
            { id: 2, name: 'Falaffel', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null },
            { id: 3, name: 'Mayonnaise', qu_id_stock: 1, qu_id_purchase: 1, parent_product_id: null },
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

// Sæt env så grocyAdapter's getGrocyConfig passerer for den aktive lokation
// (key-fallback er GROCY_<CODE>_KEY). global.fetch er fuldt mocket ovenfor, så
// der sker aldrig rigtigt netværk uanset hvilken url lokationen har.
process.env.GROCY_TEST_URL = process.env.GROCY_TEST_URL || 'http://mock.local/api';
process.env.GROCY_TEST_KEY = process.env.GROCY_TEST_KEY || 'mock';
process.env.GROCY_HQ_KEY   = process.env.GROCY_HQ_KEY   || 'mock';

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

    // ── Ekstra-varer (migration 102): lægges OVENI BOM-forbruget ──

    // S6: ny ekstra-vare (ikke i opskrift) → trækkes med sin egen mængde
    console.log('\nS6 · Ekstra ny vare (Mayonnaise 5) — trækkes oveni');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, null, [{ product_id: 3, amount: 5 }]);
    const mayo6 = consumeCalls.find(c => c.product_id === 3);
    const brod6 = consumeCalls.find(c => c.product_id === 1);
    ok(mayo6?.amount === 5, `Mayonnaise = 5 (ekstra), fik ${mayo6?.amount}`);
    ok(brod6?.amount === 30, `Brød Rug uændret = 30, fik ${brod6?.amount}`);

    // S7: ekstra PÅ en eksisterende BOM-vare → adderer (erstatter IKKE)
    console.log('\nS7 · Ekstra på eksisterende vare (Brød Rug +10) — adderer');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, null, [{ product_id: 1, amount: 10 }]);
    const brod7 = consumeCalls.find(c => c.product_id === 1);
    ok(brod7?.amount === 40, `Brød Rug = 30 + 10 = 40, fik ${brod7?.amount}`);

    // S8: override + extra på SAMME vare → override erstatter, derefter adderer extra
    console.log('\nS8 · Override 30→40 + extra +5 på Brød Rug = 45');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, new Map([[1, 40]]), [{ product_id: 1, amount: 5 }]);
    const brod8 = consumeCalls.find(c => c.product_id === 1);
    ok(brod8?.amount === 45, `Brød Rug = 40 (override) + 5 (extra) = 45, fik ${brod8?.amount}`);

    // S9: ugyldige extras (amount 0, pid 0) ignoreres
    console.log('\nS9 · Ugyldige extras ignoreres');
    consumeCalls.length = 0;
    await grocy.consumeRecipes(lines, null, [{ product_id: 3, amount: 0 }, { product_id: 0, amount: 5 }]);
    const mayo9 = consumeCalls.find(c => c.product_id === 3);
    const zero9 = consumeCalls.find(c => c.product_id === 0);
    ok(!mayo9 && !zero9, `Hverken amount=0 eller pid=0 trukket (fik ${consumeCalls.length} ekstra)`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
