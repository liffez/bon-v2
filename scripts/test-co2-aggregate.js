// scripts/test-co2-aggregate.js
// ============================================================
// Unit-test for CO₂-routenes aggregerings-matematik (services/co2Aggregate.js).
// Ren matematik — ingen DB, ingen Grocy, ingen server.
//
// Dækker den fælde der gør logikken subtil: covered_kg/missing_kg er pr.
// base_servings og SKAL divideres med base før de vægtes med solgte enheder.
//
// Kør:  node scripts/test-co2-aggregate.js
// ============================================================

'use strict';

const assert = require('assert');
const A = require('../services/co2Aggregate');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('CO₂ — route-aggregering (co2Aggregate)');

/* ── parseCo2Window ─────────────────────────────────────── */
console.log('\nparseCo2Window — periode-parsing');

t('gyldig from/to → interval, months=null', () => {
    assert.deepStrictEqual(A.parseCo2Window({ from: '2025-01-01', to: '2025-06-30' }),
        { from: '2025-01-01', to: '2025-06-30', months: null });
});
t('samme dag (from=to) er gyldigt', () => {
    const r = A.parseCo2Window({ from: '2025-03-01', to: '2025-03-01' });
    assert.strictEqual(r.months, null);
    assert.strictEqual(r.from, '2025-03-01');
});
t('from > to → ugyldigt → falder til months-default', () => {
    assert.deepStrictEqual(A.parseCo2Window({ from: '2025-07-01', to: '2025-01-01' }),
        { from: null, to: null, months: 12 });
});
t('ugyldigt datoformat → months-default', () => {
    assert.deepStrictEqual(A.parseCo2Window({ from: 'bad', to: 'også-bad' }),
        { from: null, to: null, months: 12 });
});
t('kun from (ingen to) → months-default', () => {
    assert.strictEqual(A.parseCo2Window({ from: '2025-01-01' }).months, 12);
});
t('intet input → 12 mdr', () => {
    assert.strictEqual(A.parseCo2Window({}).months, 12);
    assert.strictEqual(A.parseCo2Window(undefined).months, 12);
});
t('gyldig months bruges', () => {
    assert.strictEqual(A.parseCo2Window({ months: '6' }).months, 6);
    assert.strictEqual(A.parseCo2Window({ months: 24 }).months, 24);
});
t('months klampes: 0/-5/61/abc → 12 · grænser 1 og 60 er gyldige', () => {
    assert.strictEqual(A.parseCo2Window({ months: '0' }).months, 12);
    assert.strictEqual(A.parseCo2Window({ months: '-5' }).months, 12);
    assert.strictEqual(A.parseCo2Window({ months: '61' }).months, 12);
    assert.strictEqual(A.parseCo2Window({ months: 'abc' }).months, 12);
    assert.strictEqual(A.parseCo2Window({ months: '1' }).months, 1);
    assert.strictEqual(A.parseCo2Window({ months: '60' }).months, 60);
});
t('from/to vinder over months', () => {
    const r = A.parseCo2Window({ from: '2025-01-01', to: '2025-02-01', months: '6' });
    assert.strictEqual(r.months, null);
    assert.strictEqual(r.from, '2025-01-01');
});

/* ── weightedMassCoverage ───────────────────────────────── */
console.log('\nweightedMassCoverage — samlet dækning (sales-vægtet)');

t('base_servings skaleres FØR vægtning (kernefælden)', () => {
    // base 4: covered 4 kg for 4 portioner → 1 kg/enhed. 10 solgt → 10 kg dækket.
    const meta = new Map([[1, { covered_kg: 4, missing_kg: 0, base_servings: 4 }]]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 10 }], meta), 100);
});
t('halvt dækket på tværs af to opskrifter m. forskellig base', () => {
    const meta = new Map([
        [1, { covered_kg: 4, missing_kg: 0, base_servings: 4 }],  // 1 kg/enhed dækket
        [2, { covered_kg: 0, missing_kg: 2, base_servings: 2 }],  // 1 kg/enhed manglende
    ]);
    // 10 stk af hver → 10 dækket / 20 kendt = 50%
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 10 }, { rid: 2, units: 10 }], meta), 50);
});
t('vægtes efter SALG — storsælger dominerer', () => {
    const meta = new Map([
        [1, { covered_kg: 1, missing_kg: 0, base_servings: 1 }],  // fuldt dækket
        [2, { covered_kg: 0, missing_kg: 1, base_servings: 1 }],  // slet ikke dækket
    ]);
    // 90 stk dækket vs 10 stk udækket → 90%
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 90 }, { rid: 2, units: 10 }], meta), 90);
});
t('ukendt opskrift i usage springes over', () => {
    const meta = new Map([[1, { covered_kg: 1, missing_kg: 0, base_servings: 1 }]]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 5 }, { rid: 99, units: 999 }], meta), 100);
});
t('opskrift uden masse-data (covered_kg null) springes over', () => {
    const meta = new Map([
        [1, { covered_kg: 1, missing_kg: 0, base_servings: 1 }],
        [2, { covered_kg: null, missing_kg: null, base_servings: 1 }],
    ]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 5 }, { rid: 2, units: 50 }], meta), 100);
});
t('ingen kendt masse → null (ikke 0)', () => {
    const meta = new Map([[1, { covered_kg: 0, missing_kg: 0, base_servings: 1 }]]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 10 }], meta), null);
    assert.strictEqual(A.weightedMassCoverage([], meta), null);
    assert.strictEqual(A.weightedMassCoverage(null, meta), null);
});
t('alt manglende → 0%', () => {
    const meta = new Map([[1, { covered_kg: 0, missing_kg: 3, base_servings: 1 }]]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 2 }], meta), 0);
});
t('units=0 bidrager ikke', () => {
    const meta = new Map([[1, { covered_kg: 0, missing_kg: 5, base_servings: 1 }],
                          [2, { covered_kg: 5, missing_kg: 0, base_servings: 1 }]]);
    // kun rid 2 har salg → 100%
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 0 }, { rid: 2, units: 4 }], meta), 100);
});
t('base_servings 0/undefined → behandles som 1 (ingen division med 0)', () => {
    const meta = new Map([[1, { covered_kg: 2, missing_kg: 0, base_servings: 0 }]]);
    assert.strictEqual(A.weightedMassCoverage([{ rid: 1, units: 3 }], meta), 100);
});

/* ── aggregateBonAccuracy ───────────────────────────────── */
console.log('\naggregateBonAccuracy — bon-niveau nøjagtighed');

t('base_servings skaleres pr. linje, vægtet med antal', () => {
    // base 4: covered 0,4 / missing 0,1 for 4 portioner → 0,1 / 0,025 pr. enhed
    const res = new Map([[1, { covered_kg: 0.4, missing_kg: 0.1, base_servings: 4 }]]);
    const a = A.aggregateBonAccuracy([{ rid: 1, quantity: 10 }], res);
    assert.ok(near(a.covered_kg, 1.0), `covered=${a.covered_kg}`);
    assert.ok(near(a.missing_kg, 0.25), `missing=${a.missing_kg}`);
    assert.strictEqual(a.accuracy_pct, 80); // 1,0 / 1,25
});
t('flere linjer summeres (Falaflen-lignende bon)', () => {
    const res = new Map([
        [1, { covered_kg: 0.1208, missing_kg: 0.02, base_servings: 1 }], // Falaflen
        [2, { covered_kg: 0.5, missing_kg: 0, base_servings: 1 }],       // fuldt dækket
    ]);
    const a = A.aggregateBonAccuracy([{ rid: 1, quantity: 10 }, { rid: 2, quantity: 2 }], res);
    assert.ok(near(a.covered_kg, 2.208), `covered=${a.covered_kg}`); // 1,208 + 1,0
    assert.ok(near(a.missing_kg, 0.2), `missing=${a.missing_kg}`);
    assert.strictEqual(a.accuracy_pct, 92); // 2,208 / 2,408
});
t('komplet bon → 100%', () => {
    const res = new Map([[1, { covered_kg: 1, missing_kg: 0, base_servings: 1 }]]);
    assert.strictEqual(A.aggregateBonAccuracy([{ rid: 1, quantity: 3 }], res).accuracy_pct, 100);
});
t('linje med ukendt opskrift springes over', () => {
    const res = new Map([[1, { covered_kg: 1, missing_kg: 0, base_servings: 1 }]]);
    const a = A.aggregateBonAccuracy([{ rid: 1, quantity: 2 }, { rid: 99, quantity: 99 }], res);
    assert.ok(near(a.covered_kg, 2));
    assert.strictEqual(a.accuracy_pct, 100);
});
t('ingen linjer / ingen masse → accuracy null, 0 kg', () => {
    const res = new Map();
    const a = A.aggregateBonAccuracy([], res);
    assert.strictEqual(a.accuracy_pct, null);
    assert.strictEqual(a.covered_kg, 0);
    assert.strictEqual(a.missing_kg, 0);
    assert.strictEqual(A.aggregateBonAccuracy(null, res).accuracy_pct, null);
});
t('quantity 0 bidrager ikke', () => {
    const res = new Map([[1, { covered_kg: 1, missing_kg: 9, base_servings: 1 }],
                          [2, { covered_kg: 1, missing_kg: 0, base_servings: 1 }]]);
    const a = A.aggregateBonAccuracy([{ rid: 1, quantity: 0 }, { rid: 2, quantity: 5 }], res);
    assert.strictEqual(a.accuracy_pct, 100);
});

/* ── sumTransportByMonth ────────────────────────────────── */
console.log('\nsumTransportByMonth — transport pr. måned');

t('summerer pr. måned', () => {
    const bons = [{ id: 1, month: '2026-05' }, { id: 2, month: '2026-05' }, { id: 3, month: '2026-06' }];
    const tmap = new Map([[1, { kg: 1.5 }], [2, { kg: 2.5 }], [3, { kg: 4 }]]);
    const m = A.sumTransportByMonth(bons, tmap);
    assert.ok(near(m.get('2026-05'), 4));
    assert.ok(near(m.get('2026-06'), 4));
});
t('bons uden transport / kg=0 tælles ikke og opretter ikke måned', () => {
    const bons = [{ id: 1, month: '2026-05' }, { id: 2, month: '2026-07' }];
    const tmap = new Map([[1, { kg: 0 }]]); // id 2 mangler helt
    const m = A.sumTransportByMonth(bons, tmap);
    assert.strictEqual(m.has('2026-05'), false);
    assert.strictEqual(m.has('2026-07'), false);
});
t('tom input → tom map', () => {
    assert.strictEqual(A.sumTransportByMonth([], new Map()).size, 0);
    assert.strictEqual(A.sumTransportByMonth(null, new Map()).size, 0);
});

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
