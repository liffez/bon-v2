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

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
