// scripts/test-yield-model.js
// ============================================================
// Yield-modellen: en opskrift vejer IKKE summen af sine input.
//
// Køkkenet har standardiseret på at hver produktionsopskrift yielder en fast
// mængde af den vare der bruges senere — typisk 1 kg. Syltelagen hældes fra,
// kødet svinder:
//
//   "Balsamico + løg" = 1 kg løg + 0,06 L balsamico + 0,5 L vand
//       sum af input: 470 g pr. batch
//       yield:        300 g   ← det man reelt kan bruge
//
//   Syltet rødkål: 2,7 kg ind → 1 kg brugbar vare
//   1,12 kg svinekam → 1 kg pulled pork
//
// Yieldet ER erklæret i Grocy som recipeunit + recipeunitnumber. Modellen her
// bruger det når det findes, og falder tilbage på summen når det ikke gør —
// vi opfinder aldrig et yield.
//
// To slags yield, to slags visning:
//   • masse/volumen (dressinger)  → yieldet ER mængden
//   • antal (sliders)             → bonen tæller stykker, men køkkenet skal
//                                    stadig kunne se hvad ét stykke vejer
//
// Kør:
//   node scripts/test-yield-model.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const grocy = require('../services/grocyAdapter');

const QUS = [
    { id: 4, name: 'Kilo', name_short: 'kg' },
    { id: 5, name: 'Gram', name_short: 'g' },
    { id: 6, name: 'Liter', name_short: 'l' },
];
const CONVERSIONS = [{ product_id: null, from_qu_id: 4, to_qu_id: 5, factor: 1000 }];

// 1 Ret nester tre slags underopskrift:
//   2 "Sylted"  — yield 0,3 kg, men 1,5 kg input (lagen hældes fra)
//   3 "Slider"  — yield 2 antal, input 0,3 kg (køkkenet skal kende g/stk)
//   4 "Uerklæret" — intet yield → fald tilbage på summen
grocy.getRecipes = async () => ([
    { id: 1, name: 'Ret', unit_number: 1 }, { id: 2, name: 'Sylted', unit_number: 1 },
    { id: 3, name: 'Slider', unit_number: 1 }, { id: 4, name: 'Uerklæret', unit_number: 1 },
]);
grocy.getRecipeNestings = async () => ([
    { recipe_id: 1, includes_recipe_id: 2, servings: 1 },
    { recipe_id: 1, includes_recipe_id: 3, servings: 1 },
    { recipe_id: 1, includes_recipe_id: 4, servings: 1 },
]);
grocy.getRecipesRawMap = async () => new Map([
    [1, { base_servings: 1, name: 'Ret', userfields: {} }],
    [2, { base_servings: 1, name: 'Sylted',    userfields: { recipeunit: 'kg',    recipeunitnumber: '0.3' } }],
    [3, { base_servings: 1, name: 'Slider',    userfields: { recipeunit: 'antal', recipeunitnumber: '2' } }],
    [4, { base_servings: 1, name: 'Uerklæret', userfields: { recipeunit: 'kg' } }],   // intet tal
]);
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 2, product_id: 100, amount: 1,   qu_id: 4, ingredient_group: '' },  // 1 kg kål
    { recipe_id: 2, product_id: 101, amount: 0.5, qu_id: 6, ingredient_group: '' },  // 0,5 L lage
    { recipe_id: 3, product_id: 100, amount: 0.3, qu_id: 4, ingredient_group: '' },  // 0,3 kg
    { recipe_id: 4, product_id: 100, amount: 0.8, qu_id: 4, ingredient_group: '' },  // 0,8 kg
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Kål',  qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 101, name: 'Lage', qu_id_stock: 6, qu_id_purchase: 6 },
]);
grocy.getQuantityUnits = async () => QUS;
grocy.getQuantityUnitConversions = async () => CONVERSIONS;
grocy.makeEffectiveStock = () => () => 999;
grocy.getStock = async () => ([]);

const { resolveIngredients } = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b) => Math.abs(a - b) < 0.5;

(async () => {
    console.log('\nYield-modellen: erklæret udbytte slår summen af input\n');

    const r = await resolveIngredients([{ grocy_recipe_id: 1, quantity: 1 }]);
    const by = Object.fromEntries((r.production.sub_recipes || []).map(s => [s.recipe_name, s]));

    console.log('S1 · Masse-yield: lagen tælles ikke med');
    const s = by['Sylted'];
    // input: 1 kg kål + 0,5 L lage. Lagen har ingen vej til kilo → 1000 g sum.
    ok(close(s.input_weight_grams, 1000), `sum af input 1000 g — fik ${s.input_weight_grams}`);
    ok(close(s.weight_grams, 300), `vægten er YIELDET 300 g, ikke summen — fik ${s.weight_grams}`);
    ok(s.amount === '300 g', `vises som "300 g" — fik "${s.amount}"`);
    ok(close(s.yield_amount, 0.3) && s.yield_unit === 'kg', `yield 0,3 kg eksponeret`);

    console.log('\nS2 · Antal-yield: bonen tæller, køkkenet kan se vægten');
    const sl = by['Slider'];
    ok(/^2 antal$/.test(sl.amount), `vises som "2 antal" — fik "${sl.amount}"`);
    ok(close(sl.unit_weight_grams, 150), `150 g pr. stk (300 g / 2) — fik ${sl.unit_weight_grams}`);
    ok(close(sl.input_weight_grams, 300), `samlet råvarevægt bevaret — fik ${sl.input_weight_grams}`);

    console.log('\nS3 · Uden erklæret yield falder vi tilbage på summen');
    const u = by['Uerklæret'];
    ok(u.yield_amount === null, 'intet yield opfindes');
    ok(close(u.weight_grams, 800), `bruger summen 800 g — fik ${u.weight_grams}`);

    console.log('\nS4 · Yield skalerer med mængden på bonen');
    const r10 = await resolveIngredients([{ grocy_recipe_id: 1, quantity: 10 }]);
    const s10 = (r10.production.sub_recipes || []).find(x => x.recipe_name === 'Sylted');
    ok(close(s10.weight_grams, 3000), `10× → 3000 g — fik ${s10.weight_grams}`);
    const sl10 = (r10.production.sub_recipes || []).find(x => x.recipe_name === 'Slider');
    ok(/^20 antal$/.test(sl10.amount), `10× → "20 antal" — fik "${sl10.amount}"`);
    ok(close(sl10.unit_weight_grams, 150), `g/stk er uændret ved skalering — fik ${sl10.unit_weight_grams}`);

    console.log('\nS5 · Lagertrækket røres ikke — råvarerne forbruges som før');
    const raw = Object.fromEntries(r.raw.ingredients.map(i => [i.product_name, i.needed_stock]));
    ok(close(raw['Kål'], 2.1), `Kål 1 + 0,3 + 0,8 = 2,1 kg trækkes uændret — fik ${raw['Kål']}`);
    ok(close(raw['Lage'], 0.5), `Lagen forbruges stadig, selvom den ikke vejer med — fik ${raw['Lage']}`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
