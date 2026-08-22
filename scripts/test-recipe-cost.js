// scripts/test-recipe-cost.js
// ============================================================
// Kostpris-resolveren (#517) — Bon regner selv i stedet for at læse Grocys
// `/recipes/fulfillment` → `costs`.
//
// Målt mod produktions-Grocy 22.08.2026: 97 af 102 opskrifter stemmer med
// Grocy når man trækker `desired_servings`-skævheden fra. I de fem der er
// tilbage, tager GROCY fejl hver gang — forældet cache (Brownie, Langtids
// stegt Gris), bundter (#455) og forældre-produkter prissat til 0.
//
// Fixturerne herunder er de rigtige tal fra de opskrifter, så testen fejler
// hvis nogen ændrer fortolkningen af data vi har verificeret i drift.
//
// Kør:  node scripts/test-recipe-cost.js
// ============================================================

'use strict';

const { computeAll, unitCostFromRow, yieldInStockUnits, unitIdByName } = require('../services/recipeCost');

const QUS = [
    { id: 4, name: 'Kilo' }, { id: 5, name: 'Gram' },
    { id: 6, name: 'Liter' }, { id: 8, name: 'Antal' },
];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b, tol = 0.005) => Math.abs(a - b) < tol;

function run(world) {
    return computeAll({
        recipes: world.recipes, pos: world.pos, nestings: world.nestings || [],
        products: world.products, units: QUS, conversions: world.conversions || [],
        priceByProduct: new Map(Object.entries(world.prices || {})),
    });
}

console.log('\nKostpris-resolveren\n');

// ── K1 · desired_servings må ikke røre tallet ────────────────
console.log('K1 · desired_servings ignoreres');
{
    // Remoulade som i drift: 0,5 kg mayo à 114,62 + 0,5 kg relish à 34,00.
    // Grocy rapporterer 148,62 fordi desired_servings er 2. Sandheden er 74,31.
    const w = {
        recipes: [{ id: 10, name: 'Remoulade', base_servings: 1, desired_servings: 2,
                    userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }],
        products: [{ id: 1, name: 'Mayonaise', qu_id_stock: 4 }, { id: 2, name: 'Pickles', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 0.5 }, { recipe_id: 10, product_id: 2, amount: 0.5 }],
        prices: { 1: 114.62, 2: 34.00 },
    };
    const r = run(w).get(10);
    ok(near(r.cost, 74.31), `74,31 kr — ikke Grocys 148,62 (fik ${r.cost.toFixed(2)})`);
    ok(near(r.cost_per_unit, 74.31), `74,31 kr pr. kg (fik ${r.cost_per_unit.toFixed(2)})`);
    ok(r.complete === true, 'markeret komplet');
}

// ── K2 · produceret vare uden købspris arver fra sin opskrift ──
console.log('\nK2 · Produceret vare uden købspris arver fra opskriften');
{
    // Præcis konverterings-tilfældet fra #269: menuen peger på produktet,
    // produktet har ingen pris, og bidraget ville ellers blive 0.
    const w = {
        recipes: [
            { id: 10, name: 'Remoulade', base_servings: 1, product_id: 20,
              userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
            { id: 24, name: 'Fisken', base_servings: 1, userfields: { recipeunit: 'antal', recipeunitnumber: '1' } },
        ],
        products: [{ id: 1, name: 'Mayonaise', qu_id_stock: 4 }, { id: 2, name: 'Pickles', qu_id_stock: 4 },
                   { id: 20, name: 'Remoulade', qu_id_stock: 4 }, { id: 3, name: 'Fiskefrikadelle', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 0.5 }, { recipe_id: 10, product_id: 2, amount: 0.5 },
              { recipe_id: 24, product_id: 3, amount: 0.065 }, { recipe_id: 24, product_id: 20, amount: 0.035 }],
        prices: { 1: 114.62, 2: 34.00, 3: 92.31 },   // produkt 20 har INGEN pris
    };
    const r = run(w).get(24);
    // 0,065 × 92,31 + 0,035 × 74,31 = 6,00 + 2,60
    ok(near(r.cost, 8.60, 0.01), `bidraget er med: 8,60 kr (fik ${r.cost.toFixed(2)})`);
    ok(r.complete === true, 'ikke rapporteret som manglende pris');
}

console.log('\nK2b · En rigtig købspris vinder over den arvede');
{
    const w = {
        recipes: [{ id: 10, name: 'Remoulade', base_servings: 1, product_id: 20,
                    userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
                  { id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Remoulade', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
        prices: { 1: 100, 20: 60 },   // produktet ER købt til 60
    };
    ok(near(run(w).get(24).cost, 60), 'købsprisen bruges — det er hvad varen FAKTISK kostede');
}

// ── K3 · udbytte i en anden enhed end lager-enheden ──────────
console.log('\nK3 · Udbytte erklæret i antal, produkt lagerført i kilo');
{
    // Falaffel: 36 antal pr. batch, 1 Kilo = 35 Antal → 1,0286 kg pr. batch.
    const w = {
        recipes: [{ id: 97, name: 'Falaffel-stegning', base_servings: 1, product_id: 30,
                    userfields: { recipeunit: 'antal', recipeunitnumber: '36' } },
                  { id: 91, name: 'Falaflen', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Ærter', qu_id_stock: 4 }, { id: 30, name: 'Falaffel', qu_id_stock: 4 }],
        pos: [{ recipe_id: 97, product_id: 1, amount: 1 }, { recipe_id: 91, product_id: 30, amount: 0.5 }],
        conversions: [{ product_id: 30, from_qu_id: 8, to_qu_id: 4, factor: 1 / 35 }],
        prices: { 1: 50 },
    };
    // batch koster 50 kr og giver 36/35 = 1,0286 kg → 48,61 kr/kg → 0,5 kg = 24,31
    ok(near(run(w).get(91).cost, 24.31, 0.01), `konverteringen bruges (fik ${run(w).get(91).cost.toFixed(2)})`);
}

// ── K4 · uden erklæret udbytte arves der ikke ────────────────
console.log('\nK4 · Uden erklæret udbytte gættes der ikke');
{
    const w = {
        recipes: [{ id: 10, name: 'Blanding', base_servings: 1, product_id: 20, userfields: { recipeunit: 'kg' } },
                  { id: 24, name: 'Ret', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Blanding', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
        prices: { 1: 100 },
    };
    const r = run(w).get(24);
    ok(r.cost === 0, 'intet bidrag opfundet');
    ok(r.complete === false && [...r.missing_price].includes('Blanding'),
       `varen står som manglende pris (fik ${JSON.stringify([...r.missing_price])})`);
}

// ── K5 · nestings skaleres efter base_servings ───────────────
console.log('\nK5 · Nesting skaleres efter base_servings, ikke desired');
{
    const w = {
        recipes: [{ id: 9, name: 'Frisk Grønt', base_servings: 2, desired_servings: 8, userfields: {} },
                  { id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Spinat', qu_id_stock: 4 }],
        pos: [{ recipe_id: 9, product_id: 1, amount: 1 }],
        nestings: [{ recipe_id: 24, includes_recipe_id: 9, servings: 1 }],
        prices: { 1: 78 },
    };
    // Frisk Grønt koster 78 for 2 portioner → 1 portion = 39
    ok(near(run(w).get(24).cost, 39), `1 af 2 portioner = 39 kr (fik ${run(w).get(24).cost.toFixed(2)})`);
}

// ── K6 · manglende pris siges højt ───────────────────────────
console.log('\nK6 · Manglende pris regnes ikke som nul i det stille');
{
    const w = {
        recipes: [{ id: 1, name: 'Ret', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mel', qu_id_stock: 4 }, { id: 2, name: 'karry', qu_id_stock: 4 }],
        pos: [{ recipe_id: 1, product_id: 1, amount: 1 }, { recipe_id: 1, product_id: 2, amount: 0.01 }],
        prices: { 1: 12 },
    };
    const r = run(w).get(1);
    ok(near(r.cost, 12), 'de kendte varer tælles med');
    ok(r.complete === false && [...r.missing_price].includes('karry'), 'den ukendte navngives');
}

// ── K7 · cyklus vælter ikke ──────────────────────────────────
console.log('\nK7 · En cyklus vælter ikke beregningen');
{
    const w = {
        recipes: [{ id: 1, name: 'A', base_servings: 1, product_id: 10, userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
                  { id: 2, name: 'B', base_servings: 1, product_id: 20, userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }],
        products: [{ id: 10, name: 'A-vare', qu_id_stock: 4 }, { id: 20, name: 'B-vare', qu_id_stock: 4 }],
        pos: [{ recipe_id: 1, product_id: 20, amount: 1 }, { recipe_id: 2, product_id: 10, amount: 1 }],
        prices: {},
    };
    let crashed = false;
    try { run(w); } catch (e) { crashed = true; }
    ok(!crashed, 'ingen stack overflow');
}

// ── K8 · hjælpere ────────────────────────────────────────────
console.log('\nK8 · Prisrækkefølge og enhedsnavne');
{
    ok(unitCostFromRow({ last_price: 90, avg_price: 240 }) === 90, 'seneste købspris slår gennemsnittet');
    ok(unitCostFromRow({ last_price: 0, avg_price: 240 }) === 240, 'en nul-pris er ikke en pris (kål havde 0)');
    ok(near(unitCostFromRow({ value: 50, amount: 2 }), 25), 'lagerværdi/mængde som sidste udvej');
    ok(unitCostFromRow({}) === null, 'ingen pris → null, ikke 0');
    ok(unitIdByName(QUS, 'kg') === 4 && unitIdByName(QUS, 'antal') === 8, 'fritekst-enheder oversættes');
    ok(unitIdByName(QUS, 'Timer') === null, 'et ikke-enheds-navn giver null');
}

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
