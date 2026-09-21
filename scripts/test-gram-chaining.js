// scripts/test-gram-chaining.js
// ============================================================
// Regressionstest: vægtberegningen skal kunne kæde to hop.
//
// findConversionFactorToGrams slog kun ÉT hop op. Et produkt med en gyldig vej
// til kilo — fx "1 Liter = 1 Kilo" (densitet) eller "1 Antal = 0,06 Kilo" —
// returnerede derfor null, og varen blev TAVST udeladt af underopskriftens
// vægt (linjen `if (gFactor !== null)`).
//
// Målt på grocy-hq: 27 råvarer var i den situation. Dataen var på plads; koden
// læste den bare ikke. Konkret eksempel fra driften:
//
//   "Balsamico + løg" = 1 kg løg + 0,06 L balsamico + 0,5 L vand
//     før:   1000 g   (kun løgene talte med)
//     efter: 1566 g
//
// Der antages intet: første hop er produktets eget (eller en global regel),
// andet hop er den globale Kilo → Gram. Findes der ingen vej, udelades varen
// stadig — vi opfinder ikke en vægt.
//
// Kør:
//   node scripts/test-gram-chaining.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const grocy = require('../services/grocyAdapter');

const QUS = [
    { id: 4, name: 'Kilo', name_short: 'kg' },
    { id: 5, name: 'Gram', name_short: 'g' },
    { id: 6, name: 'Liter', name_short: 'l' },
    { id: 8, name: 'Antal' },
];
// Global Kilo→Gram (findes i grocy-hq) + produkt-specifik densitet på vandet.
const CONVERSIONS = [
    { product_id: null, from_qu_id: 4, to_qu_id: 5, factor: 1000 },
    { product_id: 101,  from_qu_id: 6, to_qu_id: 4, factor: 1 },      // 1 L vand = 1 kg
    { product_id: 103,  from_qu_id: 8, to_qu_id: 4, factor: 0.06 },   // 1 æg = 60 g
];

// Ret (1) → Blanding (2). Blandingen er dér vægten beregnes.
grocy.getRecipes = async () => ([
    { id: 1, name: 'Ret', unit_number: 1 },
    { id: 2, name: 'Blanding', unit_number: 1 },
]);
grocy.getRecipeNestings = async () => ([{ recipe_id: 1, includes_recipe_id: 2, servings: 1 }]);
grocy.getRecipesRawMap = async () => new Map([
    [1, { base_servings: 1, name: 'Ret' }],
    [2, { base_servings: 1, name: 'Blanding' }],
]);
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 2, product_id: 100, amount: 1,   qu_id: 4, ingredient_group: '' },  // 1 kg løg
    { recipe_id: 2, product_id: 101, amount: 0.5, qu_id: 6, ingredient_group: '' },  // 0,5 L vand
    { recipe_id: 2, product_id: 103, amount: 2,   qu_id: 8, ingredient_group: '' },  // 2 æg
    { recipe_id: 2, product_id: 102, amount: 3,   qu_id: 8, ingredient_group: '' },  // 3 stk uden vej til vægt
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Løg',      qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 101, name: 'Vand',     qu_id_stock: 6, qu_id_purchase: 6 },
    { id: 102, name: 'Serviet',  qu_id_stock: 8, qu_id_purchase: 8 },
    { id: 103, name: 'Æg',       qu_id_stock: 8, qu_id_purchase: 8 },
]);
grocy.getQuantityUnits = async () => QUS;
grocy.getQuantityUnitConversions = async () => CONVERSIONS;
grocy.makeEffectiveStock = () => () => 99;
grocy.getStock = async () => ([]);

const { resolveIngredients } = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b) => Math.abs(a - b) < 0.01;

(async () => {
    console.log('\nVægt: kæd to hop via kilo\n');

    const r = await resolveIngredients([{ grocy_recipe_id: 1, quantity: 1 }]);
    const sub = (r.production.sub_recipes || []).find(s => s.recipe_name === 'Blanding');
    ok(!!sub, 'underopskriften findes i produktions-visningen');

    console.log('\nS1 · Direkte vej (Kilo → Gram, global)');
    // Løg alene ville give 1000 g
    ok(sub.weight_grams >= 1000, `løgene tæller med — samlet vægt ${sub.weight_grams} g`);

    console.log('\nS2 · Kædet vej: Liter → Kilo → Gram');
    // 1 kg løg + 0,5 L vand (=500 g) + 2 æg (=120 g) = 1620 g. Servietten kan
    // ikke vejes og skal fortsat udelades.
    ok(close(sub.weight_grams, 1620),
        `1000 (løg) + 500 (vand) + 120 (æg) = 1620 g — fik ${sub.weight_grams}`);

    console.log('\nS3 · Kædet vej: Antal → Kilo → Gram');
    ok(sub.weight_grams > 1500, 'æggene (Antal med kilo-konvertering) tælles nu med');

    console.log('\nS4 · Uden nogen vej opfindes der ingen vægt');
    // Servietten har hverken →Gram eller →Kilo. Ville den blive talt med som
    // "3", ville vægten være 1623 i stedet for 1620.
    ok(!close(sub.weight_grams, 1623), 'servietten uden konvertering udelades stadig');

    console.log('\nS5 · Uden den globale Kilo → Gram kædes der ikke');
    grocy.getQuantityUnitConversions = async () => CONVERSIONS.filter(c => c.product_id !== null);
    const r2 = await resolveIngredients([{ grocy_recipe_id: 1, quantity: 1 }]);
    const sub2 = (r2.production.sub_recipes || []).find(s => s.recipe_name === 'Blanding');
    ok(close(sub2.weight_grams, 0),
        `intet kan vejes uden Kilo → Gram — fik ${sub2.weight_grams} g (ingen gætterier)`);
    grocy.getQuantityUnitConversions = async () => CONVERSIONS;

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
