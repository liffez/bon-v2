// scripts/test-subrecipe-status.js
// ============================================================
// To ting testes her, begge fundet i drift på bon B4123:
//
//   1) STATUS-OPRULNING: Produktion-visningen viste underopskrifter med en
//      hardcodet grøn prik. "Æggesalat 1,56 kg" stod grøn mens Råvarer-fanen
//      samtidig sagde at der kun var 10 af de 18 nødvendige æg. Serveren skal
//      nu sætte status + mangelliste på hver underopskrift.
//
//   2) BASE_SERVINGS I REKURSIONEN: resolveSubRecipesRaw/resolveNestings gangede
//      med subBaseServings når de rekurserede, hvilket ophævede divisionen og
//      pustede råvarer i underopskrifter-i-underopskrifter op. Latent i dag
//      (alt i grocy-hq har base_servings = 1), men consume-stien deducerer
//      rigtigt lager — så den skal låses fast med base_servings > 1.
//
// Mocker Grocy-data på den rigtige adapter (samme mønster som
// test-recipe-factor.js) så vi tester matematikken uden live Grocy.
//
// Kør:
//   node scripts/test-subrecipe-status.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const grocy = require('../services/grocyAdapter');

// Opskriftstræ (bevidst base_servings > 1 på begge underopskrifter):
//   1 Sandwich   base=1  → nester 2 "Æggesalat"  med servings=2
//   2 Æggesalat  base=4  → nester 3 "Remoulade"  med servings=2
//   3 Remoulade  base=2
grocy.getRecipes = async () => ([
    { id: 1, name: 'Sandwich',  unit_number: 1 },
    { id: 2, name: 'Æggesalat', unit_number: 1 },
    { id: 3, name: 'Remoulade', unit_number: 1 },
]);
grocy.getRecipeNestings = async () => ([
    { recipe_id: 1, includes_recipe_id: 2, servings: 2 },
    { recipe_id: 2, includes_recipe_id: 3, servings: 2 },
]);
grocy.getRecipesRawMap = async () => new Map([
    [1, { base_servings: 1, name: 'Sandwich'  }],
    [2, { base_servings: 4, name: 'Æggesalat' }],
    [3, { base_servings: 2, name: 'Remoulade' }],
]);
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 1, product_id: 200, amount: 1, qu_id: 4, ingredient_group: '' },          // Rugbrød (direkte)
    { recipe_id: 2, product_id: 100, amount: 1, qu_id: 4, ingredient_group: '' },          // Æg
    { recipe_id: 2, product_id: 300, amount: 1, qu_id: 4, ingredient_group: 'Emballage' }, // Serviet
    { recipe_id: 3, product_id: 101, amount: 1, qu_id: 4, ingredient_group: '' },          // Mayo
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Æg',       qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 101, name: 'Mayo',     qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 200, name: 'Rugbrød',  qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 300, name: 'Serviet',  qu_id_stock: 4, qu_id_purchase: 4 },
]);
grocy.getQuantityUnits = async () => ([{ id: 4, name: 'Kilo', name_short: 'kg' }]);
grocy.getQuantityUnitConversions = async () => ([]);

// Lager styres pr. testcase
let STOCK = {};
grocy.makeEffectiveStock = () => (pid) => (STOCK[pid] || 0);
grocy.getStock = async () => ([]);

const { resolveIngredients, resolveConsumeItems } = require('../services/ingredientResolver');

const LINES = [{ grocy_recipe_id: 1, quantity: 1 }];
const round = n => Math.round(n * 1000) / 1000;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const subOf = prod => (prod.sub_recipes || []).find(s => s.recipe_name === 'Æggesalat');
const rawOf = (raw, name) => (raw.ingredients || []).find(i => i.product_name === name);

(async () => {
    console.log('\nUnderopskrift-status + base_servings-rekursion\n');

    // ── S1: base_servings i rekursionen ────────────────────────────
    // 1 sandwich → 2 servings Æggesalat / base 4 = 0,5 batch → Æg = 1 × 0,5 = 0,5
    // Remoulade: 2 servings pr. Æggesalat-batch × 0,5 = 1 serving / base 2
    //            = 0,5 batch → Mayo = 1 × 0,5 = 0,5
    // Den gamle kode gav Mayo = 2 (4× for meget — faktor subBaseServings=4).
    console.log('S1 · base_servings > 1 i dybden (consume-stien)');
    const consume = Object.fromEntries(
        (await resolveConsumeItems(LINES)).map(i => [i.product_name, round(i.amount_stock)])
    );
    ok(consume['Æg'] === 0.5,   `Æg 0,5 (2 servings / base 4) — fik ${consume['Æg']}`);
    ok(consume['Mayo'] === 0.5, `Mayo 0,5 — dybde 2 må ikke ganges med base_servings — fik ${consume['Mayo']}`);

    console.log('\nS2 · Samme tal på råvare-niveauet i visningen');
    STOCK = { 100: 10, 101: 10, 200: 10, 300: 10 };
    let r = await resolveIngredients(LINES);
    ok(round(rawOf(r.raw, 'Æg').needed_stock)   === 0.5, `Æg 0,5 — fik ${round(rawOf(r.raw, 'Æg').needed_stock)}`);
    ok(round(rawOf(r.raw, 'Mayo').needed_stock) === 0.5, `Mayo 0,5 — fik ${round(rawOf(r.raw, 'Mayo').needed_stock)}`);

    // ── S3: status-oprulning ───────────────────────────────────────
    console.log('\nS3 · Alt på lager → underopskriften er grøn');
    ok(subOf(r.production).status === 'ok', `status 'ok' — fik '${subOf(r.production).status}'`);
    ok(subOf(r.production).shortfalls.length === 0, `ingen mangelliste — fik ${subOf(r.production).shortfalls.length}`);

    console.log('\nS4 · For få æg → gul, og ægget står på mangellisten');
    STOCK = { 100: 0.2, 101: 10, 200: 10, 300: 10 };
    r = await resolveIngredients(LINES);
    let sub = subOf(r.production);
    ok(sub.status === 'lav', `status 'lav' — fik '${sub.status}'`);
    ok(sub.shortfalls.length === 1 && sub.shortfalls[0].product_name === 'Æg',
        `mangelliste = [Æg] — fik [${sub.shortfalls.map(s => s.product_name).join(', ')}]`);

    console.log('\nS5 · Ingen æg → rød (samme signal som råvare-fanen)');
    STOCK = { 100: 0, 101: 10, 200: 10, 300: 10 };
    r = await resolveIngredients(LINES);
    sub = subOf(r.production);
    ok(sub.status === 'mangler', `status 'mangler' — fik '${sub.status}'`);
    ok(sub.status === rawOf(r.raw, 'Æg').status,
        `Produktion og Råvarer er enige ('${sub.status}' = '${rawOf(r.raw, 'Æg').status}')`);

    console.log('\nS6 · Mangel i en DYBERE underopskrift slår også igennem');
    STOCK = { 100: 10, 101: 0, 200: 10, 300: 10 };
    r = await resolveIngredients(LINES);
    sub = subOf(r.production);
    ok(sub.status === 'mangler', `Mayo (i Remoulade, dybde 2) gør Æggesalat rød — fik '${sub.status}'`);
    ok(sub.shortfalls.some(s => s.product_name === 'Mayo'), `Mayo står på mangellisten`);

    console.log('\nS7 · Emballage tæller ikke med i underopskriftens status');
    STOCK = { 100: 10, 101: 10, 200: 10, 300: 0 };   // servietter helt væk
    r = await resolveIngredients(LINES);
    sub = subOf(r.production);
    ok(sub.status === 'ok', `manglende servietter gør ikke blandingen rød — fik '${sub.status}'`);
    ok(!sub.shortfalls.some(s => s.product_name === 'Serviet'), `Serviet ikke på mangellisten`);
    ok(rawOf(r.raw, 'Serviet').status === 'mangler', `…men Serviet er stadig rød i Råvarer-visningen`);

    console.log('\nS8 · Direkte råvarer uden for underopskriften påvirker den ikke');
    STOCK = { 100: 10, 101: 10, 200: 0, 300: 10 };   // rugbrødet mangler
    r = await resolveIngredients(LINES);
    ok(subOf(r.production).status === 'ok',
        `Rugbrød hører til sandwichen, ikke Æggesalaten — fik '${subOf(r.production).status}'`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
