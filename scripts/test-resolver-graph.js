// scripts/test-resolver-graph.js
// ============================================================
// Regressionstest for #354 — opskriftstræets FORM, ikke dets tal.
//
// De to opløsere i services/ingredientResolver.js brugte ét `visited`-sæt for
// hele træet under en bon-linje. Det er for groft:
//
//   • DIAMANT (A→B→D og A→C→D): D's egne råvarer blev korrekt talt to gange
//     (de tilføjes i løkken FØR rekursionen), men rekursionen ind i D blev
//     sprunget over anden gang — så alt UNDER D blev undertalt. Rammer også
//     consume-stien, altså rigtigt lagertræk.
//
//   • CYKLUS: calcSubRecipeWeightGrams havde slet intet værn og ville løbe
//     tør for stak og vælte hele /api/bons/:id/ingredients.
//
// Rettelsen er en STAK (tilføj ved indgang, fjern ved udgang) i stedet for et
// sæt — samme mønster som services/co2Engine.js allerede bruger.
//
// Kør:
//   node scripts/test-resolver-graph.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const grocy = require('../services/grocyAdapter');

// ── Diamant med et niveau UNDER det delte knudepunkt ──
//   1 Top   → 2 Gren-B  og  3 Gren-C
//   2 Gren-B → 4 Delt
//   3 Gren-C → 4 Delt          (samme underopskrift, to veje)
//   4 Delt  → 5 Bund           ← DET er her undertællingen skete
//
// Alle base_servings = 1 og alle servings = 1, så tallene er lette at læse:
// hver vej bidrager præcis 1.
const RECIPES = [
    { id: 1, name: 'Top',    unit_number: 1 },
    { id: 2, name: 'Gren-B', unit_number: 1 },
    { id: 3, name: 'Gren-C', unit_number: 1 },
    { id: 4, name: 'Delt',   unit_number: 1 },
    { id: 5, name: 'Bund',   unit_number: 1 },
];
const NESTINGS = [
    { recipe_id: 1, includes_recipe_id: 2, servings: 1 },
    { recipe_id: 1, includes_recipe_id: 3, servings: 1 },
    { recipe_id: 2, includes_recipe_id: 4, servings: 1 },
    { recipe_id: 3, includes_recipe_id: 4, servings: 1 },
    { recipe_id: 4, includes_recipe_id: 5, servings: 1 },
];

grocy.getRecipes = async () => RECIPES;
grocy.getRecipeNestings = async () => NESTINGS;
grocy.getRecipesRawMap = async () => new Map(RECIPES.map(r => [r.id, { base_servings: 1, name: r.name }]));
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 4, product_id: 100, amount: 1, qu_id: 4, ingredient_group: '' },  // i det DELTE led
    { recipe_id: 5, product_id: 101, amount: 1, qu_id: 4, ingredient_group: '' },  // ét niveau UNDER
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Delt-råvare', qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 101, name: 'Bund-råvare', qu_id_stock: 4, qu_id_purchase: 4 },
]);
grocy.getQuantityUnits = async () => ([{ id: 4, name: 'Kilo', name_short: 'kg' }]);
grocy.getQuantityUnitConversions = async () => ([]);
grocy.makeEffectiveStock = () => () => 99;
grocy.getStock = async () => ([]);

const { resolveIngredients, resolveConsumeItems } = require('../services/ingredientResolver');
const LINES = [{ grocy_recipe_id: 1, quantity: 1 }];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

// Kør en async funktion med en hård tidsgrænse, så en uendelig rekursion
// giver en FAIL i stedet for at hænge testen (eller vælte processen).
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: tidsgrænse`)), ms)),
    ]);
}

(async () => {
    console.log('\nResolver: diamant-mønster og cyklusser (#354)\n');

    console.log('S1 · Diamant — delt underopskrift nået ad to veje');
    const raw = (await resolveIngredients(LINES)).raw;
    const byName = Object.fromEntries(raw.ingredients.map(i => [i.product_name, i.needed_stock]));
    ok(byName['Delt-råvare'] === 2,
        `råvaren I det delte led tælles 2× — fik ${byName['Delt-råvare']}`);
    ok(byName['Bund-råvare'] === 2,
        `råvaren UNDER det delte led tælles også 2× (var 1 før) — fik ${byName['Bund-råvare']}`);

    console.log('\nS2 · Samme på consume-stien (rigtigt lagertræk)');
    const consume = Object.fromEntries(
        (await resolveConsumeItems(LINES)).map(i => [i.product_name, i.amount_stock])
    );
    ok(consume['Delt-råvare'] === 2, `Delt-råvare 2 — fik ${consume['Delt-råvare']}`);
    ok(consume['Bund-råvare'] === 2, `Bund-råvare 2 — der blev consumet for lidt før — fik ${consume['Bund-råvare']}`);

    console.log('\nS3 · Ægte cyklus stopper stadig (og hænger ikke)');
    NESTINGS.push({ recipe_id: 5, includes_recipe_id: 2, servings: 1 });   // Bund → Gren-B
    try {
        const cyc = await withTimeout(resolveIngredients(LINES), 5000, 'resolveIngredients');
        ok(true, 'resolveIngredients returnerer i stedet for at løbe løbsk');
        const w = (cyc.production.sub_recipes || []).every(s => Number.isFinite(s.weight_grams));
        ok(w, 'vægt-beregningen giver endelige tal (intet stack overflow)');
        await withTimeout(resolveConsumeItems(LINES), 5000, 'resolveConsumeItems');
        ok(true, 'resolveConsumeItems returnerer også');
    } catch (e) {
        ok(false, `cyklus håndteret — fik: ${e.message}`);
    }
    NESTINGS.pop();

    console.log('\nS4 · Uden diamant er tallene uændrede (ingen dobbelttælling)');
    NESTINGS.splice(NESTINGS.findIndex(n => n.recipe_id === 3 && n.includes_recipe_id === 4), 1);
    const plain = (await resolveIngredients(LINES)).raw;
    const p = Object.fromEntries(plain.ingredients.map(i => [i.product_name, i.needed_stock]));
    ok(p['Delt-råvare'] === 1 && p['Bund-råvare'] === 1,
        `én vej → 1 af hver — fik ${p['Delt-råvare']} / ${p['Bund-råvare']}`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
