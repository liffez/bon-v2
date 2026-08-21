// scripts/test-conversion-gate.js
// ============================================================
// Gaten for #269: beviser at en konvertering kan MÅLES, ikke vurderes.
//
// Når en `RR produktion Hurtig`-blanding laves om til et rigtigt produkt,
// tilføjes et BOM-niveau: menu → mellemprodukt → råvarer. To ting kan gå galt,
// og begge er tavse:
//
//   dobbelt-tælling — råvarerne trækkes både gennem produktet og igen direkte
//   tabt led        — mellemproduktets råvarer forsvinder helt ud af regnskabet
//
// `consume` ÆNDRER sig med vilje ved konverteringen. Invarianten er hvad der
// til sidst forlader råvarelageret — det er dét `expandProducedToRaw` regner,
// og dét gaten sammenligner.
//
// Testen bygger de to verdener side om side med mocks og kræver at de giver
// nøjagtig samme råvareforbrug. Derefter ødelægges konverteringen på tre
// måder, og hver gang skal forskellen kunne ses.
//
// Kør:  node scripts/test-conversion-gate.js
// ============================================================

'use strict';

const grocy = require('../services/grocyAdapter');

const QUS = [{ id: 4, name: 'Kilo' }, { id: 5, name: 'Gram' }];
const CONVERSIONS = [{ product_id: null, from_qu_id: 4, to_qu_id: 5, factor: 1000 }];
const PRODUCTS = [
    { id: 10, name: 'Mayonaise',      qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 11, name: 'Pickles/Relish', qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 12, name: 'Fiskefrikadelle', qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 20, name: 'Remoulade',      qu_id_stock: 4, qu_id_purchase: 4 },
];

// ── FØR: menuen NESTER blandingen. Remoulade er ikke et produkt. ──
// Opskrift 2 "Remoulade" laver 1 kg af 0,5 mayo + 0,5 relish.
// Menuen (1) bruger 0,35 kg remoulade → nesting servings 0,35.
const WORLD_BEFORE = {
    recipes: new Map([
        [1, { id: 1, name: 'Fisken',    base_servings: 1, userfields: {} }],
        [2, { id: 2, name: 'Remoulade', base_servings: 1,
              userfields: { recipeunit: 'kg', recipeunitnumber: '1', grupper: 'RR produktion Hurtig' } }],
    ]),
    pos: [
        { recipe_id: 1, product_id: 12, amount: 0.065, qu_id: 4, ingredient_group: '' },
        { recipe_id: 2, product_id: 10, amount: 0.5,   qu_id: 4, ingredient_group: '' },
        { recipe_id: 2, product_id: 11, amount: 0.5,   qu_id: 4, ingredient_group: '' },
    ],
    nestings: [{ recipe_id: 1, includes_recipe_id: 2, servings: 0.35 }],
};

// ── EFTER: opskrift 2 producerer produkt 20, og menuen peger på PRODUKTET. ──
const WORLD_AFTER = {
    recipes: new Map([
        [1, { id: 1, name: 'Fisken',    base_servings: 1, userfields: {} }],
        [2, { id: 2, name: 'Remoulade', base_servings: 1, product_id: 20,
              userfields: { recipeunit: 'kg', recipeunitnumber: '1', grupper: 'RR produktion Hurtig' } }],
    ]),
    pos: [
        { recipe_id: 1, product_id: 12, amount: 0.065, qu_id: 4, ingredient_group: '' },
        { recipe_id: 1, product_id: 20, amount: 0.35,  qu_id: 4, ingredient_group: '' },
        { recipe_id: 2, product_id: 10, amount: 0.5,   qu_id: 4, ingredient_group: '' },
        { recipe_id: 2, product_id: 11, amount: 0.5,   qu_id: 4, ingredient_group: '' },
    ],
    nestings: [],
};

function useWorld(w) {
    grocy.getRecipes = async () => ([{ id: 1, name: 'Fisken', unit_number: 1 }]);
    grocy.getRecipesRawMap = async () => w.recipes;
    grocy.getAllRecipesPos = async () => w.pos;
    grocy.getRecipeNestings = async () => w.nestings;
    grocy.getProducts = async () => PRODUCTS;
    grocy.getQuantityUnits = async () => QUS;
    grocy.getQuantityUnitConversions = async () => CONVERSIONS;
    grocy.getStock = async () => ([]);
    grocy.makeEffectiveStock = () => () => 0;
    if (grocy._clearCache) grocy._clearCache();
}

const { resolveConsumeItems, expandProducedToRaw } = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

async function measure(world, qty = 10) {
    useWorld(world);
    const consume = await resolveConsumeItems([{ grocy_recipe_id: 1, quantity: qty }]);
    const eq = await expandProducedToRaw(consume);
    const byName = {};
    for (const [pid, amt] of eq.raw) {
        const p = PRODUCTS.find(x => x.id === pid) || { name: '#' + pid };
        byName[p.name] = Math.round(amt * 10000) / 10000;
    }
    return {
        consume: Object.fromEntries(consume.map(c => [c.product_name, Math.round(c.amount_stock * 10000) / 10000])),
        raw: byName,
        unexpanded: eq.unexpanded.map(u => u.product_name),
    };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

(async () => {
    console.log('\nKonverterings-gate: samme råvareforbrug før og efter\n');

    const before = await measure(WORLD_BEFORE);
    const after  = await measure(WORLD_AFTER);

    console.log('G1 · consume ÆNDRER sig — det er meningen');
    ok(before.consume['Mayonaise'] === 1.75, `før: menuen trækker mayo direkte (${before.consume['Mayonaise']})`);
    ok(after.consume['Mayonaise'] === undefined, 'efter: menuen trækker ikke længere mayo');
    ok(after.consume['Remoulade'] === 3.5, `efter: menuen trækker produktet (${after.consume['Remoulade']})`);

    console.log('\nG2 · Råvare-ækvivalenten er UÆNDRET — invarianten');
    ok(eq(before.raw, after.raw),
       `samme råvareforbrug begge veje\n      før:   ${JSON.stringify(before.raw)}\n      efter: ${JSON.stringify(after.raw)}`);
    ok(before.raw['Mayonaise'] === 1.75 && after.raw['Mayonaise'] === 1.75,
       '1,75 kg mayo i begge verdener — hverken tabt eller talt to gange');
    ok(before.unexpanded.length === 0 && after.unexpanded.length === 0, 'alt kunne foldes ud');

    console.log('\nG3 · Forkert udbytte fanges');
    // Samme konvertering, men opskriften erklærer 2 kg pr. batch hvor den laver 1.
    // Så tror systemet at 0,35 kg remoulade kun koster halvt så mange råvarer.
    const badYield = JSON.parse(JSON.stringify({ pos: WORLD_AFTER.pos, nestings: WORLD_AFTER.nestings }));
    const worldBadYield = {
        ...badYield,
        recipes: new Map([
            [1, { id: 1, name: 'Fisken', base_servings: 1, userfields: {} }],
            [2, { id: 2, name: 'Remoulade', base_servings: 1, product_id: 20,
                  userfields: { recipeunit: 'kg', recipeunitnumber: '2' } }],
        ]),
    };
    const bad = await measure(worldBadYield);
    ok(!eq(before.raw, bad.raw), 'gaten ser forskellen når udbyttet er sat forkert');
    ok(bad.raw['Mayonaise'] === 0.875, `råvarerne halveres tavst (${bad.raw['Mayonaise']} mod 1,75)`);

    console.log('\nG4 · Dobbelt-tælling fanges');
    // Klassikeren: menuen peger på produktet, men de gamle råvarelinjer blev
    // aldrig fjernet fra menuen.
    const worldDouble = {
        recipes: WORLD_AFTER.recipes,
        nestings: [],
        pos: [...WORLD_AFTER.pos,
            { recipe_id: 1, product_id: 10, amount: 0.175, qu_id: 4, ingredient_group: '' },
            { recipe_id: 1, product_id: 11, amount: 0.175, qu_id: 4, ingredient_group: '' }],
    };
    const dbl = await measure(worldDouble);
    ok(!eq(before.raw, dbl.raw), 'gaten ser dobbelt-tællingen');
    ok(dbl.raw['Mayonaise'] === 3.5, `mayo talt to gange (${dbl.raw['Mayonaise']} mod 1,75)`);

    console.log('\nG5 · Tabt led fanges');
    // Nestingen fjernet, men menuen fik aldrig produktlinjen.
    const worldLost = { recipes: WORLD_AFTER.recipes, nestings: [], pos: WORLD_AFTER.pos.filter(p => !(p.recipe_id === 1 && p.product_id === 20)) };
    const lost = await measure(worldLost);
    ok(!eq(before.raw, lost.raw), 'gaten ser det tabte led');
    ok(lost.raw['Mayonaise'] === undefined, 'remouladen er helt væk ud af regnskabet');

    console.log('\nG6 · Uden erklæret udbytte foldes der ikke ud — og det siges');
    const worldNoYield = {
        recipes: new Map([
            [1, { id: 1, name: 'Fisken', base_servings: 1, userfields: {} }],
            [2, { id: 2, name: 'Remoulade', base_servings: 1, product_id: 20, userfields: { recipeunit: 'kg' } }],
        ]),
        pos: WORLD_AFTER.pos, nestings: [],
    };
    const noY = await measure(worldNoYield);
    ok(noY.unexpanded.includes('Remoulade'), 'markeret som ufoldet i stedet for gættet');
    ok(noY.raw['Remoulade'] === 3.5, 'produktet bliver stående som sig selv');
    ok(noY.raw['Mayonaise'] === undefined, 'der opfindes ingen råvarer bag det');

    console.log('\nG7 · CO₂ overlever konverteringen');
    // Uden roll-down forsvinder remouladens bidrag i det øjeblik menuen holder
    // op med at neste den: et nyt produkt har ingen `co2e_per_kg`, og et
    // manglende bidrag ser ud som nul.
    const engine = require('../services/co2Engine');
    const withFactors = (w) => ({
        recipes: [...w.recipes.values()],
        pos: w.pos, nestings: w.nestings, units: QUS, conversions: CONVERSIONS,
        products: PRODUCTS.map(p => ({ ...p,
            userfields: p.id === 20 ? {} : { co2e_per_kg: '2', co2e_source: 'klimadb' } })),
    });
    const cBefore = engine.computeAll(withFactors(WORLD_BEFORE)).get(1);
    const cAfter  = engine.computeAll(withFactors(WORLD_AFTER)).get(1);
    ok(Math.abs(cBefore.total - cAfter.total) < 1e-9,
       `samme CO₂ før og efter — ${r4(cBefore.total)} mod ${r4(cAfter.total)}`);
    ok(cBefore.complete === cAfter.complete && cBefore.complete === true,
       'dækningen er fuld begge veje — det nye produkt tæller ikke som en mangel');
    ok(cAfter.total > 0, 'bidraget er der stadig, ikke tavst nul');

    console.log('\nG8 · Egen faktor på produktet vinder over opskriften');
    // Sætter nogen en faktor direkte på mellemproduktet, er det et menneskes
    // beslutning. Lægges opskriften oveni, dobbelt-tælles den.
    const withOwn = withFactors(WORLD_AFTER);
    withOwn.products = withOwn.products.map(p => p.id === 20 ? { ...p, userfields: { co2e_per_kg: '99', co2e_source: 'manual' } } : p);
    const cOwn = engine.computeAll(withOwn).get(1);
    ok(cOwn.total > cAfter.total, `den manuelle faktor bruges (${r4(cOwn.total)} mod ${r4(cAfter.total)})`);
    // computeAll regner pr. opskrift SOM INDTASTET (base_servings 1) — ikke pr.
    // bon-linje. Menuen har 0,065 fiskefrikadelle + 0,35 remoulade.
    ok(Math.abs(cOwn.total - (0.065 * 2 + 0.35 * 99)) < 1e-9,
       `og opskriften lægges ikke oveni — ${r4(cOwn.total)} = 0,065×2 + 0,35×99`);

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
