// tests/moms.test.js
// Smoke-test for shared/moms.js
// Køres via:  node --test tests/moms.test.js

const test = require('node:test');
const assert = require('node:assert');

const {
    MOMS_RATE,
    MOMS_FACTOR,
    inclToExcl,
    exclToIncl,
    momsOfIncl,
    computeMomsFields,
    applyDiscount,
} = require('../shared/moms');

test('MOMS_FACTOR og MOMS_RATE er de fundamentale konstanter', () => {
    assert.strictEqual(MOMS_RATE, 0.25);
    assert.strictEqual(MOMS_FACTOR, 1.25);
});

test('Grocy-pris 104 kr incl. moms giver korrekt opsplit', () => {
    const r = computeMomsFields(104);
    assert.strictEqual(r.total_incl_moms, 104);
    assert.strictEqual(r.total_excl_moms, 83.20);
    assert.strictEqual(r.moms_amount, 20.80);
});

test('T-5 case: 60×104 + 70×114 + 70×99 + 8×312.5 → 23.650/18.920/4.730', () => {
    const total = 60 * 104 + 70 * 114 + 70 * 99 + 8 * 312.5;
    const r = computeMomsFields(total);
    assert.strictEqual(r.total_incl_moms, 23650);
    assert.strictEqual(r.total_excl_moms, 18920);
    assert.strictEqual(r.moms_amount, 4730);
});

test('inclToExcl og exclToIncl er reversible', () => {
    const incl = 1234.56;
    assert.strictEqual(Math.round(exclToIncl(inclToExcl(incl)) * 100) / 100, incl);
});

test('momsOfIncl giver 20% af incl-beløb (= 25% af ex moms)', () => {
    assert.strictEqual(momsOfIncl(125), 25);
    assert.strictEqual(Math.round(momsOfIncl(104) * 100) / 100, 20.8);
});

test('computeMomsFields tåler null/undefined', () => {
    const r1 = computeMomsFields(null);
    const r2 = computeMomsFields(undefined);
    assert.deepStrictEqual(r1, { total_incl_moms: 0, total_excl_moms: 0, moms_amount: 0 });
    assert.deepStrictEqual(r2, { total_incl_moms: 0, total_excl_moms: 0, moms_amount: 0 });
});

test('applyDiscount: 10 % rabat på 1000 kr (incl)', () => {
    const r = applyDiscount(1000, 10);
    assert.strictEqual(r.discountIncl, 100);
    assert.strictEqual(r.totalIncl, 900);
    // discountExcl = 100 / 1.25 = 80
    assert.strictEqual(Math.round(r.discountExcl * 100) / 100, 80);
});

test('applyDiscount: T-5 minus 10% → 21.285 kr', () => {
    const sub = 60 * 104 + 70 * 114 + 70 * 99 + 8 * 312.5;
    const r = applyDiscount(sub, 10);
    assert.strictEqual(Math.round(r.totalIncl * 100) / 100, 21285);
});

test('applyDiscount: 0 % rabat returnerer original', () => {
    const r = applyDiscount(500, 0);
    assert.strictEqual(r.discountIncl, 0);
    assert.strictEqual(r.totalIncl, 500);
});
