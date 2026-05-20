// tests/pack_size_guard.test.js
// Unit-test for services/packSizeGuard.js — F13-guard.
// Køres via:  node --test tests/pack_size_guard.test.js
//
// Guarden fanger når pakke-vægt divergerer mellem product_barcodes
// userfield `pack_size_stock_unit` og quantity_unit_conversions.
// F12-fund: Brød Rug — conversion 10.8 kg vs barcode 7.68 kg.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');

const guard = require('../services/packSizeGuard');

// ── Beskyt en evt. eksisterende prod-log mod test-skriverier ────
let logExisted = false;
let logBackup  = null;
test.before(() => {
    logExisted = fs.existsSync(guard.LOG_FILE);
    if (logExisted) logBackup = fs.readFileSync(guard.LOG_FILE, 'utf8');
});
test.after(() => {
    if (logExisted) fs.writeFileSync(guard.LOG_FILE, logBackup);
    else if (fs.existsSync(guard.LOG_FILE)) fs.unlinkSync(guard.LOG_FILE);
});

// ── Mock grocyAdapter ───────────────────────────────────────────
// QU-id'er: 1=Stk, 2=Kilo, 3=Kasse
const mock = {
    getProducts: async () => ([
        { id: 1, name: 'Brød Rug', qu_id_purchase: 3, qu_id_stock: 2 }, // Kasse → Kilo
        { id: 2, name: 'Mælk',     qu_id_purchase: 2, qu_id_stock: 2 }, // ingen konvertering nødvendig
        { id: 3, name: 'Ny Vare',  qu_id_purchase: 3, qu_id_stock: 2 }, // mangler konvertering
    ]),
    getQuantityUnitConversions: async () => ([
        { id: 10, product_id: 1, from_qu_id: 3, to_qu_id: 2, factor: 10.8 }, // F12-fund: FORKERT
    ]),
    getProductBarcodes: async () => ([
        { id: 100, product_id: 1, barcode: '1001', amount: 1, qu_id: 3,
          userfields: { pack_size_stock_unit: '7.68' } },
        { id: 200, product_id: 2, barcode: '2001', amount: 1, qu_id: 2,
          userfields: { pack_size_stock_unit: '1.0' } },
        { id: 300, product_id: 3, barcode: '3001', amount: 1, qu_id: 3,
          userfields: {} },
    ]),
};

// ── checkBarcodePackSize ────────────────────────────────────────

test('Brød Rug: pakke 7.68 mod conversion 10.8 → divergence', async () => {
    const w = await guard.checkBarcodePackSize(mock, 100, '7.68');
    assert.ok(w, 'forventer warning');
    assert.strictEqual(w.type, 'divergence');
    assert.strictEqual(w.conversion_kg, 10.8);
    assert.strictEqual(w.product_name, 'Brød Rug');
    // spread = (10.8 - 7.68) / 7.68 = 40.6 %
    assert.ok(Math.abs(w.spread_pct - 40.6) < 0.5, 'spread ≈ 40.6 %');
});

test('pakke matcher conversion præcist → ingen warning', async () => {
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 100, '10.8'), null);
});

test('pakke indenfor ±2 % tolerance → ingen warning', async () => {
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 100, '10.9'), null);
});

test('purchase_qu === stock_qu: forventet pack = barcode.amount', async () => {
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 200, '1.0'), null);
    const w = await guard.checkBarcodePackSize(mock, 200, '2.0');
    assert.strictEqual(w && w.type, 'divergence');
});

test('produkt uden konvertering → no_conversion (informativt)', async () => {
    const w = await guard.checkBarcodePackSize(mock, 300, '5.0');
    assert.strictEqual(w && w.type, 'no_conversion');
});

test('dansk decimal-komma parses (7,68)', async () => {
    const w = await guard.checkBarcodePackSize(mock, 100, '7,68');
    assert.strictEqual(w && w.type, 'divergence');
});

test('tom/ugyldig pack_size → ingen warning', async () => {
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 100, ''), null);
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 100, '0'), null);
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 100, 'abc'), null);
});

test('ukendt barcode-id → ingen warning (fejler ikke)', async () => {
    assert.strictEqual(await guard.checkBarcodePackSize(mock, 99999, '5.0'), null);
});

// ── checkConversionFactor ───────────────────────────────────────

test('ny korrekt conversion (7.68) mod barcode 7.68 → ingen warning', async () => {
    const w = await guard.checkConversionFactor(mock,
        { product_id: 1, from_qu_id: 3, to_qu_id: 2, factor: 7.68 });
    assert.strictEqual(w, null);
});

test('ny forkert conversion (10.8) mod barcode 7.68 → divergence', async () => {
    const w = await guard.checkConversionFactor(mock,
        { product_id: 1, from_qu_id: 3, to_qu_id: 2, factor: 10.8 });
    assert.ok(w, 'forventer warning');
    assert.strictEqual(w.type, 'divergence');
    assert.strictEqual(w.barcodes.length, 1);
    assert.strictEqual(w.barcodes[0].barcode_id, 100);
});

test('ikke-stock konvertering ignoreres', async () => {
    const w = await guard.checkConversionFactor(mock,
        { product_id: 1, from_qu_id: 1, to_qu_id: 3, factor: 64 });
    assert.strictEqual(w, null);
});

test('omvendt retning (stock → purchase) inverteres korrekt', async () => {
    // 1/0.13 = 7.69 ≈ barcode 7.68 → ingen warning
    const w = await guard.checkConversionFactor(mock,
        { product_id: 1, from_qu_id: 2, to_qu_id: 3, factor: 0.13 });
    assert.strictEqual(w, null);
});

test('ugyldig factor → ingen warning', async () => {
    assert.strictEqual(await guard.checkConversionFactor(mock,
        { product_id: 1, from_qu_id: 3, to_qu_id: 2, factor: 0 }), null);
});

// ── resolveFactor ───────────────────────────────────────────────

test('resolveFactor: direkte, invers og ukendt', async () => {
    const c = await mock.getQuantityUnitConversions();
    assert.strictEqual(guard.resolveFactor(c, 1, 3, 2), 10.8);
    assert.ok(Math.abs(guard.resolveFactor(c, 1, 2, 3) - 1 / 10.8) < 1e-9);
    assert.strictEqual(guard.resolveFactor(c, 99, 3, 2), null);
    assert.strictEqual(guard.resolveFactor(c, 1, 5, 5), 1); // from === to
});
