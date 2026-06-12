// scripts/test-recipe-factor.js
// ============================================================
// Regressions-test for underopskrift-skalering (CLAUDE_EVENT.md §14b,
// migration 103_prep_packing_recipe_overrides).
//
// Verificerer at en recipe-faktor i resolveConsumeItems(lines, recipeFactors)
// skalerer underopskriftens råvarer PROPORTIONALT — inkl. at faktoren bæres
// videre ned i dybere underopskrifter, og at faktorer på forskellige niveauer
// virker uafhængigt.
//
// Bruger den RIGTIGE resolver (modsat test-prep-packing.js der mocker den) og
// mocker i stedet Grocy-data-funktionerne på grocyAdapter — så vi tester selve
// skalerings-matematikken uden en live Grocy.
//
// Kør:
//   node --experimental-sqlite scripts/test-recipe-factor.js
// ============================================================

'use strict';

// ── Mock Grocy-data på den rigtige grocyAdapter (property-access ved kald-tid) ──
const grocy = require('../services/grocyAdapter');

// Opskrifter: 1 "Sandwich" (top) → 2 "Frisk Grønt" → 3 "Tahin dressing"
grocy.getRecipes = async () => ([
    { id: 1, name: 'Sandwich',      unit_number: 1 },
    { id: 2, name: 'Frisk Grønt',   unit_number: 1 },
    { id: 3, name: 'Tahin dressing', unit_number: 1 },
]);
// Råvarer pr. opskrift (recipes_pos)
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 2, product_id: 100, amount: 2 },   // Kål
    { recipe_id: 2, product_id: 101, amount: 1 },   // Spinat
    { recipe_id: 3, product_id: 102, amount: 0.5 }, // Tahini
]);
// Nestings: 1→2 (Frisk Grønt) og 2→3 (Tahin dressing inde i Frisk Grønt)
grocy.getRecipeNestings = async () => ([
    { recipe_id: 1, includes_recipe_id: 2, servings: 1 },
    { recipe_id: 2, includes_recipe_id: 3, servings: 1 },
]);
grocy.getRecipesRawMap = async () => new Map([
    [1, { base_servings: 1, name: 'Sandwich' }],
    [2, { base_servings: 1, name: 'Frisk Grønt' }],
    [3, { base_servings: 1, name: 'Tahin dressing' }],
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Kål' }, { id: 101, name: 'Spinat' }, { id: 102, name: 'Tahini' },
]);
grocy.getQuantityUnitConversions = async () => ([]);

const { resolveConsumeItems } = require('../services/ingredientResolver');
const LINES = [{ grocy_recipe_id: 1, quantity: 1 }];
const asMap = arr => Object.fromEntries(arr.map(i => [i.product_name, Math.round(i.amount_stock * 1000) / 1000]));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

(async () => {
    console.log('\nUnderopskrift-skalering (recipe-factor) regressionstest\n');

    // S1: ingen faktor → standard-mængder
    console.log('S1 · Uden faktor — standard-mængder');
    const base = asMap(await resolveConsumeItems(LINES));
    ok(base['Kål'] === 2 && base['Spinat'] === 1 && base['Tahini'] === 0.5,
        `Kål 2 / Spinat 1 / Tahini 0,5 — fik ${JSON.stringify(base)}`);

    // S2: faktor 1,5 på Frisk Grønt (recipe 2) → dens DIREKTE råvarer skaleres
    console.log('\nS2 · Faktor 1,5 på Frisk Grønt — direkte råvarer ×1,5');
    const s2 = asMap(await resolveConsumeItems(LINES, new Map([[2, 1.5]])));
    ok(s2['Kål'] === 3 && s2['Spinat'] === 1.5, `Kål 3 / Spinat 1,5 — fik Kål ${s2['Kål']} / Spinat ${s2['Spinat']}`);

    // S3: faktoren bæres VIDERE ned i dybere underopskrift (Tahin dressing inde i Frisk Grønt)
    console.log('\nS3 · Faktor på Frisk Grønt skalerer også dens nestede dressing');
    ok(s2['Tahini'] === 0.75, `Tahini 0,5 → 0,75 (×1,5 via rekursion) — fik ${s2['Tahini']}`);

    // S4: faktor på den DYBE underopskrift (recipe 3) virker uafhængigt
    console.log('\nS4 · Faktor 2,0 kun på Tahin dressing — kun dens råvarer skaleres');
    const s4 = asMap(await resolveConsumeItems(LINES, new Map([[3, 2]])));
    ok(s4['Kål'] === 2 && s4['Spinat'] === 1, `Kål/Spinat uændret (2/1) — fik ${s4['Kål']}/${s4['Spinat']}`);
    ok(s4['Tahini'] === 1, `Tahini 0,5 → 1,0 (×2) — fik ${s4['Tahini']}`);

    // S5: faktorer på begge niveauer komponerer (1,5 × 2,0 på Tahini)
    console.log('\nS5 · Faktorer på begge niveauer komponerer');
    const s5 = asMap(await resolveConsumeItems(LINES, new Map([[2, 1.5], [3, 2]])));
    ok(s5['Kål'] === 3 && s5['Spinat'] === 1.5, `Kål/Spinat ×1,5 (3/1,5) — fik ${s5['Kål']}/${s5['Spinat']}`);
    ok(Math.abs(s5['Tahini'] - 1.5) < 1e-9, `Tahini 0,5 ×1,5 ×2 = 1,5 — fik ${s5['Tahini']}`);

    // S6: faktor 1,0 (ingen ændring) → standard
    console.log('\nS6 · Faktor 1,0 = ingen ændring');
    const s6 = asMap(await resolveConsumeItems(LINES, new Map([[2, 1]])));
    ok(s6['Kål'] === 2 && s6['Tahini'] === 0.5, `Standard bevaret — fik ${JSON.stringify(s6)}`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
