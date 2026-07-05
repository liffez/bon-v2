// scripts/test-unit-counts.js
//
// Unit-tests for boks-aware enheds-tælling (services/recipeUnits.computeUnitsMap).
// Ren funktion → ingen DB/Grocy nødvendig.
//
//   node scripts/test-unit-counts.js
//
// Dækker: kombo-boks ekspansion, almindelig retter, emballage=0, extra-recipes
// (Børne Bokse), boks-i-boks rekursion, og cyklus-værn.

const assert = require('assert');
const { computeUnitsMap } = require('../services/recipeUnits');

let pass = 0;
function eq(label, got, want) {
    try { assert.strictEqual(got, want); console.log(`✓ ${label}`); pass++; }
    catch { console.log(`✗ ${label}: fik ${got}, forventede ${want}`); process.exitCode = 1; }
}

const WL = new Set(['01 Sandwich', '02 Salat', '04 Slider']);

// ── Scenarie 1: kombo-boks (recipe 77) nester 3 sliders ──
{
    const recipes = [
        { id: 77, userfields: { grupper: '04 Slider' } },   // boks
        { id: 52, userfields: { grupper: '04 Slider' } },   // slider
        { id: 53, userfields: { grupper: '04 Slider' } },   // slider
        { id: 57, userfields: { grupper: '04 Slider' } },   // slider
        { id: 9,  userfields: { grupper: 'RR Produktion' } }, // ingrediens (Frisk Grønt)
        { id: 46, userfields: { grupper: '06 Emballage' } },  // emballage
        { id: 71, userfields: { grupper: 'Tilbehør & Bokse' } }, // Børne Boks
    ];
    const nest = [
        { recipe_id: 77, includes_recipe_id: 52 },
        { recipe_id: 77, includes_recipe_id: 53 },
        { recipe_id: 77, includes_recipe_id: 57 },
        // en almindelig slider nester kun ingredienser → må IKKE gøre den til en boks
        { recipe_id: 53, includes_recipe_id: 9 },
    ];
    const m = computeUnitsMap(recipes, nest, WL, new Set([71]));
    eq('kombo-boks (77) = 3 sliders', m.get(77), 3);
    eq('almindelig slider (53) = 1 (ingrediens-nest tæller ikke)', m.get(53), 1);
    eq('slider uden nest (52) = 1', m.get(52), 1);
    eq('emballage (46) = 0', m.get(46), 0);
    eq('ingrediens (9) = 0', m.get(9), 0);
    eq('Børne Boks (71) via extra = 1 trods kategori', m.get(71), 1);
}

// ── Scenarie 2: 2-slider boks (data-drevet, ingen hardcoding) ──
{
    const recipes = [
        { id: 80, userfields: { grupper: '04 Slider' } },
        { id: 81, userfields: { grupper: '04 Slider' } },
        { id: 82, userfields: { grupper: '04 Slider' } },
    ];
    const nest = [
        { recipe_id: 80, includes_recipe_id: 81 },
        { recipe_id: 80, includes_recipe_id: 82 },
    ];
    const m = computeUnitsMap(recipes, nest, WL, new Set());
    eq('2-slider boks = 2', m.get(80), 2);
}

// ── Scenarie 3: boks-i-boks (rekursion) ──
{
    const recipes = [
        { id: 1, userfields: { grupper: '04 Slider' } }, // mega-boks
        { id: 2, userfields: { grupper: '04 Slider' } }, // boks med 3
        { id: 3, userfields: { grupper: '04 Slider' } },
        { id: 4, userfields: { grupper: '04 Slider' } },
        { id: 5, userfields: { grupper: '04 Slider' } },
    ];
    const nest = [
        { recipe_id: 1, includes_recipe_id: 2 }, // boks 2 (=3) + slider 5
        { recipe_id: 1, includes_recipe_id: 5 },
        { recipe_id: 2, includes_recipe_id: 3 },
        { recipe_id: 2, includes_recipe_id: 4 },
        { recipe_id: 2, includes_recipe_id: 5 },
    ];
    const m = computeUnitsMap(recipes, nest, WL, new Set());
    eq('indre boks (2) = 3', m.get(2), 3);
    eq('mega-boks (1) = 3 + 1 = 4', m.get(1), 4);
}

// ── Scenarie 4: cyklus-værn (må ikke hænge) ──
{
    const recipes = [
        { id: 10, userfields: { grupper: '04 Slider' } },
        { id: 11, userfields: { grupper: '04 Slider' } },
    ];
    const nest = [
        { recipe_id: 10, includes_recipe_id: 11 },
        { recipe_id: 11, includes_recipe_id: 10 },
    ];
    const m = computeUnitsMap(recipes, nest, WL, new Set());
    // Begge er countable og nester hinanden → ingen uendelig løkke; tal er endeligt.
    eq('cyklus: 10 er endeligt', Number.isFinite(m.get(10)), true);
    eq('cyklus: 11 er endeligt', Number.isFinite(m.get(11)), true);
}

console.log(`\n${process.exitCode ? '❌ FEJL' : '✅ ALLE'} — ${pass} pass`);
