// scripts/test-production-unit.js
// ==========================================
// Unit-tests for Produktionsbatch MVP — trin 1:
//   services/production.js (QU-konvertering R6 + pris R3) og
//   grocyAdapter.produceBatch (orkestrering med INJICERET mock-post).
//
// Ingen DB, ingen Grocy. produceBatch testes via deps.post-injektion.
//
// Kør med:
//   node scripts/test-production-unit.js
// ==========================================

const {
    ProductionError,
    toStockAmount,
    scaleToPortions,
    computeBatchPrice,
    unitCostFromStockRow,
    buildBatchPlan,
} = require('../services/production');

const { produceBatch } = require('../services/grocyAdapter');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function approx(a, b, msg, tol = 1e-6) {
    assert(Math.abs(a - b) <= tol, `${msg} (fik ${a}, forventet ${b})`);
}
function assertThrowsCode(fn, code, msg) {
    try { fn(); console.error('  ✗', msg, '— kastede ingen fejl'); fail++; }
    catch (e) {
        if (e instanceof ProductionError && e.code === code) { console.log('  ✓', msg); pass++; }
        else { console.error('  ✗', msg, `— forventet code='${code}', fik`, e.code || e.message); fail++; }
    }
}

// Grocy quantity_unit_conversions: 1 kg = 1000 g (qu 2 = g, qu 3 = kg)
const CONVERSIONS = [
    { product_id: null, from_qu_id: 2, to_qu_id: 3, factor: 0.001 }, // g → kg
    { product_id: 50, from_qu_id: 5, to_qu_id: 3, factor: 6 },       // produkt-specifik: 1 spand = 6 kg
];

(async () => {

console.log('\n── toStockAmount (R6 — QU-konvertering) ──');
{
    const r = toStockAmount({ productId: 1, displayAmount: 4, fromQuId: 3, toQuId: 3, conversions: CONVERSIONS });
    approx(r.stockAmount, 4, 'samme enhed → uændret');
    assert(r.factor === 1, 'samme enhed → faktor 1');
}
{
    const r = toStockAmount({ productId: 1, displayAmount: 250, fromQuId: 2, toQuId: 3, conversions: CONVERSIONS });
    approx(r.stockAmount, 0.25, '250 g → 0,25 kg (global g→kg)');
    assert(/250/.test(r.log) && /0\.25/.test(r.log), 'log indeholder konverteringen');
}
{
    // produkt-specifik vinder (spand → kg for produkt 50)
    const r = toStockAmount({ productId: 50, displayAmount: 2, fromQuId: 5, toQuId: 3, conversions: CONVERSIONS });
    approx(r.stockAmount, 12, '2 spande → 12 kg (produkt-specifik faktor 6)');
}
assertThrowsCode(
    () => toStockAmount({ productId: 99, displayAmount: 1, fromQuId: 7, toQuId: 3, conversions: CONVERSIONS }),
    'qu_missing',
    'manglende konvertering (display≠stock) → qu_missing (producér ikke)',
);

console.log('\n── scaleToPortions (§4 — override-per-model) ──');
approx(scaleToPortions(1000, 1.3), 1300, '1000 g/portion × 1,3 portioner = 1300 g');
approx(scaleToPortions(0, 5), 0, 'master 0 (ikke i opskrift) skalerer til 0');

console.log('\n── computeBatchPrice (R3 — pris ex moms) ──');
{
    // 2 linjer: 0,25 kg × 40 kr/kg + 0,5 kg × 20 kr/kg = 10 + 10 = 20 kr, udbytte 1 kg
    const { batchCost, pricePerUnit } = computeBatchPrice(
        [{ stockAmount: 0.25, unitCost: 40 }, { stockAmount: 0.5, unitCost: 20 }], 1);
    approx(batchCost, 20, 'batch-kost = Σ(mængde × enhedskost) ex moms');
    approx(pricePerUnit, 20, 'pris/enhed = batch-kost / udbytte');
}
{
    // INGEN moms: 100 kr kost, 1 enheds udbytte → 100 (ikke 125, ikke 80)
    const { pricePerUnit } = computeBatchPrice([{ stockAmount: 1, unitCost: 100 }], 1);
    approx(pricePerUnit, 100, 'råvarekost føres uændret igennem — ingen *1.25/ /1.25');
}
{
    // Svind koncentrerer prisen: 921 g ingrediens-kost → 870 g udbytte
    // kost = 0.921 kg × 100 = 92,1 kr; udbytte 0,87 kg → 105,86 kr/kg > 100
    const { pricePerUnit } = computeBatchPrice([{ stockAmount: 0.921, unitCost: 100 }], 0.87);
    assert(pricePerUnit > 100, 'svind (udbytte < ingrediens) → højere kr/enhed (korrekt, bevidst)');
}
assertThrowsCode(() => computeBatchPrice([{ stockAmount: 1, unitCost: 10 }], 0), 'invalid_yield',
    'udbytte 0 → invalid_yield');
assertThrowsCode(() => computeBatchPrice([{ stockAmount: 1, unitCost: 10 }], -5), 'invalid_yield',
    'negativt udbytte → invalid_yield');

console.log('\n── produceBatch (orkestrering, injiceret mock-post) ──');
{
    // Happy path: 2 consumes + 1 self-production add, alle ok
    const calls = [];
    const post = async (path, body) => {
        calls.push({ path, body });
        const id = calls.length * 10;
        return [{ transaction_id: `tx${id}` }];
    };
    const res = await produceBatch({
        consume: [{ productId: 1, amount: 0.25 }, { productId: 2, amount: 0.5 }],
        produce: { productId: 99, amount: 1, price: 20 },
    }, { post });

    assert(res.state === 'produced', 'alt ok → state=produced');
    assert(res.consumeTx.length === 2, 'to consume-tx registreret');
    assert(res.consumeTx[0].transactionId === 'tx10', 'consume-tx-id fanget fra svar');
    assert(res.produceTx === 'tx30', 'produce-tx-id fanget fra svar');
    assert(res.failedLines.length === 0, 'ingen fejlede linjer');
    const addCall = calls.find(c => c.path.endsWith('/99/add'));
    assert(addCall.body.transaction_type === 'self-production', 'add bruger self-production');
    approx(addCall.body.price, 20, 'add sender eksplicit pris');
    assert(addCall.body.best_before_date === '2999-12-31', 'default best_before når ingen angivet');
}
{
    // "Råvaren manglede" — amount 0 → INTET consume-kald (kan ikke blokere)
    const calls = [];
    const post = async (path) => { calls.push(path); return [{ transaction_id: 'x' }]; };
    const res = await produceBatch({
        consume: [{ productId: 1, amount: 0 }, { productId: 2, amount: 0.5 }],
        produce: { productId: 99, amount: 1, price: 5 },
    }, { post });
    assert(!calls.some(p => p.includes('/1/consume')), 'amount 0 → intet consume-kald for produkt 1');
    assert(calls.some(p => p.includes('/2/consume')), 'amount > 0 → consume-kald for produkt 2');
    assert(res.consumeTx.length === 1, 'kun den udfyldte linje gav tx');
    assert(res.state === 'produced', 'udeladt linje blokerer ikke → produced');
}
{
    // Consume-fejl på én linje → partial, øvrige fortsætter, add køres stadig
    const post = async (path) => {
        if (path.includes('/2/consume')) throw new Error('Grocy POST fejl 400: insufficient stock');
        return [{ transaction_id: 'ok' }];
    };
    const res = await produceBatch({
        consume: [{ productId: 1, amount: 1 }, { productId: 2, amount: 1 }],
        produce: { productId: 99, amount: 1, price: 5 },
    }, { post });
    assert(res.state === 'partial', 'consume-fejl → state=partial');
    assert(res.failedLines.length === 1 && res.failedLines[0].productId === 2, 'fejlende linje markeret');
    assert(res.consumeTx.length === 1, 'den lykkede consume blev stadig registreret');
    assert(res.produceTx === 'ok', 'add køres stadig efter linje-fejl (ingen rollback i MVP)');
}
{
    // Self-production add-fejl → partial + produceError sat
    const post = async (path) => {
        if (path.endsWith('/add')) throw new Error('Grocy POST fejl 500');
        return [{ transaction_id: 'c' }];
    };
    const res = await produceBatch({
        consume: [{ productId: 1, amount: 1 }],
        produce: { productId: 99, amount: 1, price: 5 },
    }, { post });
    assert(res.state === 'partial', 'add-fejl → state=partial');
    assert(res.produceTx === null && /500/.test(res.produceError), 'produceError fanget');
}

console.log('\n── unitCostFromStockRow (R3 — enhedskost, ex moms) ──');
approx(unitCostFromStockRow({ product_id: 1, last_price: 42, value: 999, amount: 3 }), 42,
    'last_price foretrækkes når til stede');
approx(unitCostFromStockRow({ product_id: 2, value: 60, amount: 3 }), 20,
    'fallback: value / amount når intet last_price');
assert(unitCostFromStockRow({ product_id: 3, amount: 0 }) === null,
    'amount 0 + ingen pris → null (ukendt, ingen division med 0)');
assert(unitCostFromStockRow(null) === null, 'null-række → null');

console.log('\n── buildBatchPlan (R6 konvertering + R3 pris, samlet) ──');
{
    // 2 råvarer: produkt 1 i gram (qu2→qu3), produkt 2 allerede i kg (qu3)
    const plan = buildBatchPlan({
        portions: 1,
        actualYield: 1,
        conversions: CONVERSIONS,
        costMap: { 1: 40, 2: 20 },     // kr/kg ex moms
        lines: [
            { productId: 1, productName: 'Falafelmasse', plannedQty: 250, actualQty: 250, fromQuId: 2, toQuId: 3, stockUnitName: 'kg' },
            { productId: 2, productName: 'Olie',          plannedQty: 0.5, actualQty: 0.5, fromQuId: 3, toQuId: 3, stockUnitName: 'kg' },
        ],
    });
    assert(plan.errors.length === 0, 'gyldig plan → ingen fejl');
    assert(plan.consume.length === 2, 'to consume-linjer (begge actual > 0)');
    approx(plan.consume[0].amount, 0.25, 'produkt 1 konverteret 250 g → 0,25 kg');
    // kost = 0,25×40 + 0,5×20 = 10 + 10 = 20, udbytte 1 → 20 kr/kg
    approx(plan.actualCost, 20, 'actualCost = Σ(stock × enhedskost) ex moms');
    approx(plan.pricePerUnit, 20, 'pris/enhed = actualCost / udbytte');
    assert(plan.conversionLog.length >= 1, 'konvertering logget');
}
{
    // Udeladt linje (actual 0) → ingen consume, men consumptionRow bevares
    const plan = buildBatchPlan({
        portions: 1, actualYield: 1, conversions: CONVERSIONS, costMap: { 1: 40 },
        lines: [{ productId: 1, productName: 'X', plannedQty: 1, actualQty: 0, fromQuId: 3, toQuId: 3, deviationReason: 'udeladt' }],
    });
    assert(plan.consume.length === 0, 'actual 0 → ingen consume');
    assert(plan.consumptionRows.length === 1 && plan.consumptionRows[0].deviation_reason === 'udeladt',
        'udeladt linje bevares i consumptionRows (signal til indkøbsliste)');
    approx(plan.masterCost, 40, 'masterCost bruger planned_qty × enhedskost (svind-reference)');
}
{
    // Manglende QU-konvertering → blokerende fejl (producér ikke)
    const plan = buildBatchPlan({
        portions: 1, actualYield: 1, conversions: CONVERSIONS, costMap: {},
        lines: [{ productId: 9, productName: 'Ukendt enhed', plannedQty: 1, actualQty: 1, fromQuId: 7, toQuId: 3 }],
    });
    assert(plan.errors.some(e => e.code === 'qu_missing' && e.productId === 9),
        'manglende QU → qu_missing-fejl med productId');
}
{
    const plan = buildBatchPlan({ portions: 0, actualYield: 0, lines: [] });
    assert(plan.errors.some(e => e.code === 'invalid_portions'), 'portioner 0 → invalid_portions');
    assert(plan.errors.some(e => e.code === 'invalid_yield'), 'udbytte 0 → invalid_yield');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

})();
