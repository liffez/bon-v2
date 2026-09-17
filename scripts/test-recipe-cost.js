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

const { computeAll, unitCostFromRow, unitCostDetail, yieldInStockUnits, unitIdByName }
    = require('../services/recipeCost');

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
        priceDetailByProduct: new Map(Object.entries(world.priceDetails || {})),
    });
}

/** Advarslerne som en flad liste — de er en Map internt, så de kan merges. */
const warns = r => [...r.warnings.values()];
const hasWarn = (r, kind, pid) =>
    warns(r).some(w => w.kind === kind && (pid == null || String(w.product_id) === String(pid)));

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

// ── K2b · produceret gode: opskriften vinder over lagerprisen (#558) ──
console.log('\nK2b · Lagerprisen på et produceret gode taber til opskriften (#558)');
{
    // Et gode vi selv laver har ingen købspris. Står der alligevel en, er den
    // et artefakt af optællingen — `setInventory()` sender ingen pris, så Grocy
    // bærer den forrige videre. Remoulade stod til 43,47 og kostede 70,15.
    const base = {
        recipes: [{ id: 10, name: 'Remoulade', base_servings: 1, product_id: 20,
                    userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
                  { id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Remoulade', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
    };

    // Lagerprisen 60 findes, men opskriften koster 100. Opskriften vinder.
    const r = run({ ...base, prices: { 1: 100, 20: 60 } }).get(24);
    ok(near(r.cost, 100), `opskriftens 100 bruges, ikke lagerprisens 60 (fik ${r.cost.toFixed(2)})`);
    ok(hasWarn(r, 'produced_stock_price_differs', 20),
       '40 % afvigelse rapporteres som advarsel');
    ok(r.complete === true, 'en advarsel gør IKKE kostprisen ufuldstændig');
    ok(r.missing_price.size === 0, 'advarslen står ikke som en manglende pris');

    // Tæt på hinanden → ingen støj. 95 mod 100 er 5 %.
    const taet = run({ ...base, prices: { 1: 100, 20: 95 } }).get(24);
    ok(near(taet.cost, 100), 'opskriften bruges også når de to ligger tæt');
    ok(warns(taet).length === 0, 'under 20 % afvigelse advares der ikke');

    // Ingen lagerpris overhovedet: uændret fra før (#269-tilfældet).
    const ingen = run({ ...base, prices: { 1: 100 } }).get(24);
    ok(near(ingen.cost, 100), 'uden lagerpris arves opskriften som hidtil');
    ok(warns(ingen).length === 0, 'og der er intet at advare om');
}

// ── K2c · købte varer er urørte ──────────────────────────────
console.log('\nK2c · En KØBT vare beholder sin lagerpris');
{
    // Ingen opskrift producerer produkt 1, så reglen i K2b gælder ikke her.
    const w = {
        recipes: [{ id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }],
        pos: [{ recipe_id: 24, product_id: 1, amount: 1 }],
        prices: { 1: 100 },
    };
    const r = run(w).get(24);
    ok(near(r.cost, 100), 'lagerprisen ER hvad varen kostede');
    ok(warns(r).length === 0, 'og den er ikke i tvivl');
}

// ── K2d · kan opskriften ikke regnes, siges det højt ─────────
console.log('\nK2d · Uden udbytte falder vi tilbage på lagerprisen — og siger det');
{
    // Producenten mangler `recipeunitnumber`, så udbyttet er ukendt (#372).
    // Lagerprisen er så det eneste tal der findes; det må ikke ligne en
    // almindelig købt vare.
    const w = {
        recipes: [{ id: 10, name: 'Remoulade', base_servings: 1, product_id: 20, userfields: {} },
                  { id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Remoulade', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
        prices: { 1: 100, 20: 60 },
    };
    const r = run(w).get(24);
    ok(near(r.cost, 60), `lagerprisen bruges når opskriften ikke kan regnes (fik ${r.cost.toFixed(2)})`);
    ok(hasWarn(r, 'produced_recipe_cost_unavailable', 20), 'og det står som en advarsel');
}

// ── K2e · advarsler ruller op gennem træet ───────────────────
console.log('\nK2e · En advarsel dybt nede kan ses på retten');
{
    // Menu → nesting → produceret gode. Den der kigger på retten skal kunne se
    // at tallet bygger på noget der bør ses efter — ellers er advarslen gemt.
    const w = {
        recipes: [{ id: 10, name: 'Remoulade', base_servings: 1, product_id: 20,
                    userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
                  { id: 24, name: 'Fisken', base_servings: 1, userfields: {} },
                  { id: 77, name: 'Slider Boks', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Remoulade', qu_id_stock: 4 }],
        pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
        nestings: [{ recipe_id: 77, includes_recipe_id: 24, servings: 1 }],
        prices: { 1: 100, 20: 60 },
    };
    ok(hasWarn(run(w).get(77), 'produced_stock_price_differs', 20),
       'advarslen følger med op i den nestende opskrift');
}

// ── K2f · nødkøbet flytter ikke prisgrundlaget (#557) ────────
console.log('\nK2f · Et enkeltkøb langt fra gennemsnittet advares der om (#557)');
{
    // Mayo har to varenumre: 1 kg-posen til 114,56 og 5 kg-spanden til 42,01.
    // Købes spanden som nødløsning, er gennemsnittet det stabile tal — men de
    // to ligger så langt fra hinanden at ingen af dem er "prisen".
    const w = {
        recipes: [{ id: 24, name: 'Fisken', base_servings: 1, userfields: {} }],
        products: [{ id: 1, name: 'Mayonaise', qu_id_stock: 4 }],
        pos: [{ recipe_id: 24, product_id: 1, amount: 1 }],
        prices: { 1: 78.29 },
        priceDetails: { 1: unitCostDetail({ last_price: 42.01, avg_price: 78.29 }) },
    };
    const r = run(w).get(24);
    ok(hasWarn(r, 'last_vs_avg', 1), 'afvigelsen mellem seneste køb og gennemsnit rapporteres');
    ok(r.complete === true, 'men kostprisen er stadig komplet');
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
    ok(unitCostFromRow({ last_price: 90, avg_price: 240 }) === 240,
       'gennemsnittet slår seneste køb — ét bilag flytter ikke prisgrundlaget (#557)');
    ok(unitCostFromRow({ last_price: 90 }) === 90,
       'er der kun ét køb, ER det gennemsnittet');
    ok(unitCostDetail({ last_price: 42.01, avg_price: 78.29 }).warn === true,
       'over 30 % fra gennemsnittet → advarsel');
    ok(unitCostDetail({ last_price: 72, avg_price: 78.29 }).warn === false,
       'under 30 % → ingen advarsel');
    ok(unitCostDetail({ avg_price: 78.29 }).warn === false,
       'uden et seneste køb er der intet at sammenligne med');
    ok(unitCostFromRow({ last_price: 0, avg_price: 240 }) === 240, 'en nul-pris er ikke en pris (kål havde 0)');
    ok(near(unitCostFromRow({ value: 50, amount: 2 }), 25), 'lagerværdi/mængde som sidste udvej');
    ok(unitCostFromRow({}) === null, 'ingen pris → null, ikke 0');
    ok(unitIdByName(QUS, 'kg') === 4 && unitIdByName(QUS, 'antal') === 8, 'fritekst-enheder oversættes');
    ok(unitIdByName(QUS, 'Timer') === null, 'et ikke-enheds-navn giver null');
}

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
