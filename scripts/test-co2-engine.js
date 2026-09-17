// scripts/test-co2-engine.js
// ============================================================
// Unit-test for CO₂ F5-motoren (services/co2Engine.js).
// Ren matematik med mocket Grocy-data: kg-konvertering, Σ(kg×faktor),
// underopskrift-rekursion + skalering, mangler-flag, cyklus-vagt.
//
// Kør:  node scripts/test-co2-engine.js
// ============================================================

'use strict';

const assert = require('assert');
const E = require('../services/co2Engine');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('CO₂ F5 — beregningsmotor');

// Enheder: 4=Kilo, 5=Gram, 8=Antal
const UNITS = [{ id: 4, name: 'Kilo', name_short: 'kg' }, { id: 5, name: 'Gram', name_short: 'g' }, { id: 8, name: 'Antal', name_short: 'stk' }];
const CONV = [
    { product_id: null, from_qu_id: 5, to_qu_id: 4, factor: 0.001 },  // Gram→Kilo (global)
    { product_id: null, from_qu_id: 4, to_qu_id: 5, factor: 1000 },   // Kilo→Gram
    { product_id: 100, from_qu_id: 8, to_qu_id: 4, factor: 0.12 },    // produkt 100: 1 stk = 0,12 kg (kg-vej)
];

/* 1. stockToKg */
t('stock=Kilo → mængde uændret', () => {
    const p = { id: 1, qu_id_stock: 4 };
    assert.ok(near(E.stockToKg(p, 2, CONV, 4), 2));
});
t('stock=Antal m. kg-vej → ×faktor', () => {
    const p = { id: 100, qu_id_stock: 8 };
    assert.ok(near(E.stockToKg(p, 3, CONV, 4), 0.36)); // 3 stk × 0,12
});
t('stock=Antal UDEN kg-vej → null', () => {
    const p = { id: 999, qu_id_stock: 8 };
    assert.strictEqual(E.stockToKg(p, 3, CONV, 4), null);
});

/* 2. readFactor */
t('readFactor: gyldig', () => assert.strictEqual(E.readFactor({ userfields: { co2e_per_kg: '2.5' } }), 2.5));
t('readFactor: 0 (vand) er gyldig', () => assert.strictEqual(E.readFactor({ userfields: { co2e_per_kg: '0' } }), 0));
t('readFactor: tom → null', () => assert.strictEqual(E.readFactor({ userfields: { co2e_per_kg: '' } }), null));

/* 3. computeAll — simpel opskrift */
const PRODUCTS = [
    { id: 100, name: 'Brød', qu_id_stock: 8, userfields: { co2e_per_kg: '1.0' } },  // 1 stk=0,12kg, faktor 1,0
    { id: 101, name: 'Ost',  qu_id_stock: 4, userfields: { co2e_per_kg: '5.0' } },  // kg, faktor 5,0
    { id: 102, name: 'Salt', qu_id_stock: 4, userfields: { co2e_per_kg: '' } },     // ingen faktor
];

t('opskrift: Σ(kg×faktor) / base_servings', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'Sandwich', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1, qu_id: 8 },   // 0,12 kg × 1,0 = 0,12
            { recipe_id: 1, product_id: 101, amount: 0.05, qu_id: 4 }, // 0,05 kg × 5,0 = 0,25
        ],
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.ok(near(r.total, 0.37));
    assert.ok(near(r.co2e_per_serving, 0.37));
    assert.strictEqual(r.complete, true);
});

t('base_servings > 1 → per_serving = total / base', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'Batch', base_servings: 4 }],
        pos: [{ recipe_id: 1, product_id: 101, amount: 0.4, qu_id: 4 }], // 0,4 kg × 5 = 2,0 total
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.ok(near(r.total, 2.0));
    assert.ok(near(r.co2e_per_serving, 0.5)); // 2,0 / 4
});

/* 4. underopskrift-rekursion + skalering */
t('nesting: sub per-serving × servings', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [
            { id: 1, name: 'Top', base_servings: 1 },
            { id: 2, name: 'Dressing', base_servings: 2 }, // total 0,5 → per-serving 0,25
        ],
        pos: [
            { recipe_id: 2, product_id: 101, amount: 0.1, qu_id: 4 }, // 0,1×5 = 0,5 (for base 2)
        ],
        nestings: [
            { recipe_id: 1, includes_recipe_id: 2, servings: 3 }, // 0,25 × 3 = 0,75
        ],
    };
    const top = E.computeAll(data).get(1);
    assert.ok(near(top.total, 0.75), `total=${top.total}`);
});

/* 5. mangler-flag */
t('mangler faktor → flag + complete=false', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [{ recipe_id: 1, product_id: 102, amount: 0.01, qu_id: 4 }], // Salt: ingen faktor
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.deepStrictEqual(r.missing_factor, ['Salt']);
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.total, 0);
});
t('mangler kg-vej → missing_kgvej', () => {
    const prods = [{ id: 999, name: 'Ukonverterbar', qu_id_stock: 8, userfields: { co2e_per_kg: '2' } }];
    const data = {
        units: UNITS, conversions: CONV, products: prods,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [{ recipe_id: 1, product_id: 999, amount: 2, qu_id: 8 }],
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.deepStrictEqual(r.missing_kgvej, ['Ukonverterbar']);
});

/* 6. cyklus-vagt (A→B→A løkker ikke uendeligt) */
t('cyklus-vagt terminerer', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'A', base_servings: 1 }, { id: 2, name: 'B', base_servings: 1 }],
        pos: [{ recipe_id: 1, product_id: 101, amount: 0.01, qu_id: 4 }],
        nestings: [
            { recipe_id: 1, includes_recipe_id: 2, servings: 1 },
            { recipe_id: 2, includes_recipe_id: 1, servings: 1 }, // cyklus
        ],
    };
    const r = E.computeAll(data).get(1);
    assert.ok(Number.isFinite(r.total)); // ikke stack overflow / NaN
});

/* 7. breakdownRecipe — drill-down per-råvare */
const GROUPS = [{ id: 9, name: '01 Sandwich' }, { id: 10, name: '10 Emballage' }];
const BD_PRODUCTS = [
    { id: 100, name: 'Brød',   qu_id_stock: 8, product_group_id: 9,  userfields: { co2e_per_kg: '1.0', co2e_source: 'klimadb' } },
    { id: 101, name: 'Ost',    qu_id_stock: 4, product_group_id: 9,  userfields: { co2e_per_kg: '5.0', co2e_source: 'klimadb' } },
    { id: 102, name: 'Salt',   qu_id_stock: 4, product_group_id: 9,  userfields: { co2e_per_kg: '' } },        // mangler faktor
    { id: 200, name: 'Serviet', qu_id_stock: 8, product_group_id: 10, userfields: { co2e_per_kg: '0.5', co2e_source: 'material' } },
    { id: 999, name: 'Ukonverterbar', qu_id_stock: 8, product_group_id: 9, userfields: { co2e_per_kg: '2' } }, // mangler kg-vej
];
const BD_CONV = [...CONV, { product_id: 200, from_qu_id: 8, to_qu_id: 4, factor: 0.02 }]; // serviet 1 stk=0,02kg

t('breakdown: bidrag + andel + total matcher computeAll', () => {
    const data = {
        units: UNITS, conversions: BD_CONV, products: BD_PRODUCTS, groups: GROUPS,
        recipes: [{ id: 1, name: 'Sandwich', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1 },     // 0,12 kg × 1,0 = 0,12
            { recipe_id: 1, product_id: 101, amount: 0.05 },  // 0,05 kg × 5,0 = 0,25
        ],
        nestings: [],
    };
    const bd = E.breakdownRecipe(1, data);
    const full = E.computeAll(data).get(1);
    assert.ok(near(bd.total_per_serving, full.co2e_per_serving), `bd=${bd.total_per_serving} full=${full.co2e_per_serving}`);
    assert.strictEqual(bd.complete, true);
    const ost = bd.ingredients.find(i => i.name === 'Ost');
    assert.ok(near(ost.contribution, 0.25));
    assert.ok(near(ost.pct, 0.25 / 0.37 * 100));  // andel af total
    assert.strictEqual(ost.unit, 'kg');            // stock-enhedens navn
    assert.strictEqual(ost.source, 'klimadb');
});

t('breakdown: emballage-flag fra produktgruppe', () => {
    const data = {
        units: UNITS, conversions: BD_CONV, products: BD_PRODUCTS, groups: GROUPS,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [{ recipe_id: 1, product_id: 200, amount: 1 }],  // Serviet, gruppe 10 Emballage
        nestings: [],
    };
    const s = E.breakdownRecipe(1, data).ingredients[0];
    assert.strictEqual(s.is_packaging, true);
});

t('breakdown: mangler-rækker medtages med status', () => {
    const data = {
        units: UNITS, conversions: BD_CONV, products: BD_PRODUCTS, groups: GROUPS,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 102, amount: 0.01 },  // Salt → missing_factor
            { recipe_id: 1, product_id: 999, amount: 2 },     // → missing_kgvej
        ],
        nestings: [],
    };
    const bd = E.breakdownRecipe(1, data);
    assert.strictEqual(bd.complete, false);
    assert.strictEqual(bd.ingredients.find(i => i.name === 'Salt').status, 'missing_factor');
    assert.strictEqual(bd.ingredients.find(i => i.name === 'Ukonverterbar').status, 'missing_kgvej');
    assert.strictEqual(bd.ingredients.find(i => i.name === 'Salt').contribution, null);
});

t('breakdown: underopskrift som klikbar række m. bidrag', () => {
    const data = {
        units: UNITS, conversions: BD_CONV, products: BD_PRODUCTS, groups: GROUPS,
        recipes: [
            { id: 1, name: 'Top', base_servings: 1 },
            { id: 2, name: 'Dressing', base_servings: 2 },
        ],
        pos: [{ recipe_id: 2, product_id: 101, amount: 0.1 }],   // 0,1×5=0,5 for base 2 → 0,25/serving
        nestings: [{ recipe_id: 1, includes_recipe_id: 2, servings: 3 }], // 0,25×3 = 0,75
    };
    const bd = E.breakdownRecipe(1, data);
    assert.strictEqual(bd.sub_recipes.length, 1);
    const sub = bd.sub_recipes[0];
    assert.strictEqual(sub.recipe_id, 2);
    assert.strictEqual(sub.name, 'Dressing');
    assert.ok(near(sub.contribution, 0.75));
    assert.ok(near(sub.pct, 100));  // eneste bidrag
});

t('breakdown: base_servings>1 → per-serving mængder', () => {
    const data = {
        units: UNITS, conversions: BD_CONV, products: BD_PRODUCTS, groups: GROUPS,
        recipes: [{ id: 1, name: 'Batch', base_servings: 4 }],
        pos: [{ recipe_id: 1, product_id: 101, amount: 0.4 }],   // 0,4 kg for 4 → 0,1 kg/serving
        nestings: [],
    };
    const bd = E.breakdownRecipe(1, data);
    assert.strictEqual(bd.base_servings, 4);
    assert.ok(near(bd.ingredients[0].amount_per_serving, 0.1)); // 0,4/4
    assert.ok(near(bd.ingredients[0].kg, 0.1));
    assert.ok(near(bd.total_per_serving, 0.5)); // (0,4×5)/4
});

/* 8. nøjagtighed — masse-dækning (covered_kg / kendt kg) */

t('nøjagtighed: dækket + uden-faktor masse + %', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1 },     // Brød → 0,12 kg, faktor → covered
            { recipe_id: 1, product_id: 102, amount: 0.01 },  // Salt → 0,01 kg, INGEN faktor → missing_kg
        ],
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.ok(near(r.covered_kg, 0.12), `covered=${r.covered_kg}`);
    assert.ok(near(r.missing_kg, 0.01), `missing=${r.missing_kg}`);
    assert.strictEqual(r.accuracy_pct, 92); // 0,12 / 0,13
});

t('nøjagtighed: komplet opskrift → 100%', () => {
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1 },     // 0,12 covered
            { recipe_id: 1, product_id: 101, amount: 0.05 },  // 0,05 covered
        ],
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.strictEqual(r.accuracy_pct, 100);
    assert.strictEqual(r.missing_kg, 0);
});

t('nøjagtighed: rekursiv — underopskrifts uden-faktor skaleres ind (Falaflen-case)', () => {
    // Top: brød (dækket). Dressing: ost (dækket) + salt 1,0 kg (INGEN faktor).
    // Dressing nested med 0,02 servings → salt bidrager 0,02 kg uden faktor til Top.
    const data = {
        units: UNITS, conversions: CONV, products: PRODUCTS,
        recipes: [
            { id: 1, name: 'Falaflen', base_servings: 1 },
            { id: 2, name: 'Yoghurt dressing', base_servings: 1 },
        ],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1 },     // Brød → 0,12 covered
            { recipe_id: 2, product_id: 101, amount: 0.04 },  // Ost → 0,04 covered
            { recipe_id: 2, product_id: 102, amount: 1 },     // Salt (rolle: vegansk yoghurt) → 1,0 uden faktor
        ],
        nestings: [{ recipe_id: 1, includes_recipe_id: 2, servings: 0.02 }],
    };
    const top = E.computeAll(data).get(1);
    assert.ok(near(top.covered_kg, 0.1208), `covered=${top.covered_kg}`); // 0,12 + 0,04×0,02
    assert.ok(near(top.missing_kg, 0.02), `missing=${top.missing_kg}`);   // 1,0×0,02
    assert.strictEqual(top.accuracy_pct, 86); // 0,1208 / 0,1408

    // Samme case via breakdown: opskrift-nøjagtighed + underopskrift-rækkens masse
    const bd = E.breakdownRecipe(1, data);
    assert.strictEqual(bd.accuracy_pct, 86);
    assert.ok(near(bd.missing_kg_per_serving, 0.02));
    const sub = bd.sub_recipes[0];
    assert.ok(near(sub.mass_kg, 0.0208), `sub.mass_kg=${sub.mass_kg}`);   // (0,04+1,0)×0,02
    assert.ok(near(sub.missing_kg, 0.02), `sub.missing_kg=${sub.missing_kg}`);
});

t('nøjagtighed: kg-vej-mangel tælles IKKE i masse-% (kun kendt masse)', () => {
    const prods = [
        { id: 100, name: 'Brød', qu_id_stock: 8, userfields: { co2e_per_kg: '1.0' } },     // 0,12 covered
        { id: 999, name: 'Ukonverterbar', qu_id_stock: 8, userfields: { co2e_per_kg: '2' } }, // ingen kg-vej
    ];
    const data = {
        units: UNITS, conversions: CONV, products: prods,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [
            { recipe_id: 1, product_id: 100, amount: 1 },  // covered
            { recipe_id: 1, product_id: 999, amount: 2 },  // missing_kgvej (ukendt masse)
        ],
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.ok(near(r.covered_kg, 0.12));
    assert.strictEqual(r.missing_kg, 0);            // ukonverterbar bidrager IKKE til missing_kg
    assert.strictEqual(r.accuracy_pct, 100);        // 100% af den KENDTE masse
    assert.strictEqual(r.missing_kgvej_count, 1);   // men flagget separat
});

t('nøjagtighed: ingen kendt masse → null', () => {
    const prods = [{ id: 999, name: 'Ukonverterbar', qu_id_stock: 8, userfields: { co2e_per_kg: '2' } }];
    const data = {
        units: UNITS, conversions: CONV, products: prods,
        recipes: [{ id: 1, name: 'R', base_servings: 1 }],
        pos: [{ recipe_id: 1, product_id: 999, amount: 2 }], // kun kg-vej-mangel
        nestings: [],
    };
    const r = E.computeAll(data).get(1);
    assert.strictEqual(r.accuracy_pct, null);
    assert.strictEqual(r.missing_kgvej_count, 1);
});

/* 8. §1 'na' — bevidst udeladt vare (skjult i emballage-tildeleren).
      Må IKKE tælle som mangel, ellers nager rapporten om det man lige har skjult. */
const NA_UNITS = [{ id: 4, name: 'Kilo', name_short: 'kg' }, { id: 8, name: 'Antal', name_short: 'stk' }];
const NA_CONV = [{ product_id: 200, from_qu_id: 8, to_qu_id: 4, factor: 0.02 }];
const NA_GROUPS = [{ id: 9, name: '01 Sandwich' }, { id: 10, name: '10 Emballage' }];
const NA_PRODUCTS = [
    { id: 101, name: 'Ost', qu_id_stock: 4, product_group_id: 9, userfields: { co2e_per_kg: '5.0', co2e_source: 'klimadb' } },
    // Skjult: hide() sætter source='na' OG rydder faktoren
    { id: 200, name: 'Ølkasse', qu_id_stock: 8, product_group_id: 10, userfields: { co2e_per_kg: '', co2e_source: 'na' } },
    // Skjult UDEN kg-vej (id 201 har ingen konvertering) — må heller ikke flages
    { id: 201, name: 'Ølkrus', qu_id_stock: 8, product_group_id: 10, userfields: { co2e_per_kg: '', co2e_source: 'na' } },
];
const naData = (pos) => ({
    units: NA_UNITS, conversions: NA_CONV, products: NA_PRODUCTS, groups: NA_GROUPS,
    recipes: [{ id: 1, name: 'R', base_servings: 1 }], pos, nestings: [],
});

t("'na' udelades: ingen mangel-flag, opskrift kan blive komplet", () => {
    const r = E.computeAll(naData([
        { recipe_id: 1, product_id: 101, amount: 0.1 },   // 0,1 × 5 = 0,5
        { recipe_id: 1, product_id: 200, amount: 1 },     // skjult → springes over
    ])).get(1);
    assert.strictEqual(r.complete, true, 'skjult vare må ikke blokere complete');
    assert.deepStrictEqual(r.missing_factor, []);
    assert.ok(near(r.total, 0.5));
});

t("'na' tælles hverken som dækket eller manglende masse (100% dækning)", () => {
    const r = E.computeAll(naData([
        { recipe_id: 1, product_id: 101, amount: 0.1 },
        { recipe_id: 1, product_id: 200, amount: 1 },
    ])).get(1);
    assert.ok(near(r.covered_kg, 0.1), `covered=${r.covered_kg}`);
    assert.ok(near(r.missing_kg, 0), `missing=${r.missing_kg}`);
    assert.strictEqual(r.accuracy_pct, 100);
});

t("'na' uden kg-vej flages heller ikke som missing_kgvej", () => {
    const r = E.computeAll(naData([
        { recipe_id: 1, product_id: 101, amount: 0.1 },
        { recipe_id: 1, product_id: 201, amount: 1 },     // skjult + ingen kg-vej
    ])).get(1);
    assert.deepStrictEqual(r.missing_kgvej, []);
    assert.strictEqual(r.complete, true);
});

t("breakdown: 'na' vises som status 'na' (synlig, men tæller ikke)", () => {
    const bd = E.breakdownRecipe(1, naData([
        { recipe_id: 1, product_id: 101, amount: 0.1 },
        { recipe_id: 1, product_id: 200, amount: 1 },
    ]));
    const na = bd.ingredients.find(i => i.name === 'Ølkasse');
    assert.strictEqual(na.status, 'na', 'skal vises i nedbrydningen, ikke skjules');
    assert.strictEqual(na.contribution, null);
    assert.strictEqual(na.mass_kg, null);
    assert.strictEqual(na.missing_kg, null);
    assert.strictEqual(bd.complete, true);
    assert.ok(near(bd.total_per_serving, 0.5));
});

t('isExcluded: kun præcis "na" (ikke tom/klimadb)', () => {
    assert.strictEqual(E.isExcluded({ userfields: { co2e_source: 'na' } }), true);
    assert.strictEqual(E.isExcluded({ userfields: { co2e_source: ' na ' } }), true); // trimmes
    assert.strictEqual(E.isExcluded({ userfields: { co2e_source: '' } }), false);
    assert.strictEqual(E.isExcluded({ userfields: { co2e_source: 'klimadb' } }), false);
    assert.strictEqual(E.isExcluded({ userfields: {} }), false);
    assert.strictEqual(E.isExcluded({}), false);
});


/* ── Produceret mellemprodukt + forælder/barn (Remoulade, Tahin, kål) ── */
console.log('\nArv: producerende opskrift + forælder/barn');

// Remoulade-mønstret: opskrift 50 laver 1 kg af produkt 300 af 0,5 kg ost (5,0)
// + 0,5 kg brød-kilo (1,0) = 3,0 kg CO₂ pr. kg. Menu 60 bruger 0,2 kg produkt.
const PROD_PRODUCTS = [
    { id: 101, name: 'Ost',       qu_id_stock: 4, userfields: { co2e_per_kg: '5.0' } },
    { id: 103, name: 'Mel',       qu_id_stock: 4, userfields: { co2e_per_kg: '1.0' } },
    { id: 102, name: 'Salt',      qu_id_stock: 4, userfields: { co2e_per_kg: '' } },
    { id: 300, name: 'Remoulade', qu_id_stock: 4, userfields: {} },
    // kål-familien: forælder uden faktor, to børn med
    { id: 400, name: 'kål',       qu_id_stock: 4, userfields: {} },
    { id: 401, name: 'Spidskål',  qu_id_stock: 4, parent_product_id: 400, userfields: { co2e_per_kg: '0.2' } },
    { id: 402, name: 'Hvidkål',   qu_id_stock: 4, parent_product_id: 400, userfields: { co2e_per_kg: '0.4' } },
    { id: 403, name: 'Rødkål',    qu_id_stock: 4, parent_product_id: 400, userfields: { co2e_per_kg: '9', co2e_source: 'na' } },
    // Fatdane-mønstret: forælder MED faktor, barn uden
    { id: 500, name: 'Sodavand',  qu_id_stock: 4, userfields: { co2e_per_kg: '0.5' } },
    { id: 501, name: 'Sodavand cola', qu_id_stock: 4, parent_product_id: 500, userfields: {} },
];
const RAW_RECIPES = [
    { id: 50, name: 'Remoulade produktion', base_servings: 1, product_id: 300,
      userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
    { id: 60, name: 'Fisken', base_servings: 1, userfields: {} },
];
function prodData(pos, over = {}) {
    return { units: UNITS, conversions: CONV, products: PROD_PRODUCTS, nestings: [],
             recipes: RAW_RECIPES, pos: [
                 { recipe_id: 50, product_id: 101, amount: 0.5 },
                 { recipe_id: 50, product_id: 103, amount: 0.5 },
                 ...pos,
             ], ...over };
}

t('produceret vare uden faktor → rulles ned i opskriften (0,2 kg × 3,0)', () => {
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }])).get(60);
    assert.ok(near(r.total, 0.6), `fik ${r.total}`);
    assert.strictEqual(r.complete, true, 'Remoulade må ikke stå som manglende faktor');
    assert.ok(near(r.covered_kg, 0.2));
});

t('rapportens fælde: strippede opskrifter (uden product_id) kan IKKE se det', () => {
    const d = prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }]);
    const stripped = { ...d, recipes: d.recipes.map(r => ({ id: r.id, name: r.name, base_servings: r.base_servings })) };
    const r = E.computeAll(stripped).get(60);
    assert.deepStrictEqual(r.missing_factor, ['Remoulade'], 'kontrolprøve: derfor skal ruterne sende de rå opskrifter');
});

t('ruterne sender de rå opskrifter til motoren (ingen strip)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'co2.js'), 'utf8');
    assert.ok(!/map\(r => \(\{ id: r\.id, name: r\.name, base_servings/.test(src),
        'routes/co2.js stripper product_id/userfields fra opskrifterne igen');
});

t('udbyttet skalerer: 2 kg pr. batch → halv CO₂ pr. kg', () => {
    const recipes = [{ ...RAW_RECIPES[0], userfields: { recipeunit: 'kg', recipeunitnumber: '2' } }, RAW_RECIPES[1]];
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }], { recipes })).get(60);
    assert.ok(near(r.total, 0.3), `fik ${r.total}`);
});

t('egen faktor på produktet vinder over opskriften', () => {
    const products = PROD_PRODUCTS.map(p => p.id === 300 ? { ...p, userfields: { co2e_per_kg: '1.0' } } : p);
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }], { products })).get(60);
    assert.ok(near(r.total, 0.2), `fik ${r.total} — dobbelt-tælling?`);
});

t('drill-down viser den producerede vare som ok med kilde "opskrift"', () => {
    const bd = E.breakdownRecipe(60, prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }]));
    const i = bd.ingredients.find(x => x.product_id === 300);
    assert.strictEqual(i.status, 'ok');
    assert.strictEqual(i.source, 'opskrift');
    assert.strictEqual(i.producer_recipe_id, 50);
    assert.ok(near(i.contribution, 0.6));
    assert.ok(near(i.factor, 3.0), `effektiv faktor ${i.factor}`);
    assert.strictEqual(bd.complete, true);
    assert.ok(near(bd.total_per_serving, 0.6));
});

t('opskriften bag varen mangler data → sub_incomplete, mangel navngives', () => {
    const d = prodData([{ recipe_id: 60, product_id: 300, amount: 0.2 }]);
    d.pos.push({ recipe_id: 50, product_id: 102, amount: 0.1 });   // Salt uden faktor
    const r = E.computeAll(d).get(60);
    assert.deepStrictEqual(r.missing_factor, ['Salt'], 'manglen skal pege på Salt, ikke Remoulade');
    const i = E.breakdownRecipe(60, d).ingredients.find(x => x.product_id === 300);
    assert.strictEqual(i.status, 'sub_incomplete');
    assert.deepStrictEqual(i.missing_names, ['Salt']);
});

t('forælder uden faktor → gennemsnit af børnene (na-barn tæller ikke)', () => {
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 400, amount: 1 }])).get(60);
    assert.ok(near(r.total, 0.3), `fik ${r.total} (forventet (0,2+0,4)/2)`);
    assert.strictEqual(r.complete, true);
    const i = E.breakdownRecipe(60, prodData([{ recipe_id: 60, product_id: 400, amount: 1 }]))
        .ingredients.find(x => x.product_id === 400);
    assert.strictEqual(i.source, 'arvet');
    assert.match(i.source_note, /Spidskål, Hvidkål/);
});

t('forælder MED egen faktor bruger sin egen (børnene læses ikke)', () => {
    const products = PROD_PRODUCTS.map(p => p.id === 400 ? { ...p, userfields: { co2e_per_kg: '0.286' } } : p);
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 400, amount: 1 }], { products })).get(60);
    assert.ok(near(r.total, 0.286));
});

t('barn uden faktor → forælderens', () => {
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 501, amount: 2 }])).get(60);
    assert.ok(near(r.total, 1.0), `fik ${r.total}`);
});

t('ingen i familien har faktor → stadig en mangel (intet gæt)', () => {
    const products = PROD_PRODUCTS.map(p => [401, 402].includes(p.id) ? { ...p, userfields: {} } : p);
    const r = E.computeAll(prodData([{ recipe_id: 60, product_id: 400, amount: 1 }], { products })).get(60);
    assert.deepStrictEqual(r.missing_factor, ['kål']);
});

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
