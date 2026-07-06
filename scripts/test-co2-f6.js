// scripts/test-co2-f6.js
// ============================================================
// Unit-test for CO₂ F6 — bons.total_co2e = Σ(bon_lines.co2e × quantity).
// In-memory DB, tester recalcBonTotalCo2e (db/helpers.js) direkte.
//
// Kør:  node --experimental-sqlite scripts/test-co2-f6.js
// ============================================================

'use strict';

const assert = require('assert');
const { openDb } = require('../db/compat');
const { recalcBonTotalCo2e } = require('../db/helpers');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}
const near = (a, b) => Math.abs((a || 0) - b) <= 1e-9;

console.log('CO₂ F6 — bons.total_co2e');

const db = openDb(':memory:');
db.exec(`
  CREATE TABLE bons (id INTEGER PRIMARY KEY, total_co2e REAL);
  CREATE TABLE bon_lines (id INTEGER PRIMARY KEY, bon_id INTEGER, co2e REAL, quantity REAL);
  INSERT INTO bons (id) VALUES (1), (2), (3);
  -- bon 1: 2 linjer med co2e
  INSERT INTO bon_lines (bon_id, co2e, quantity) VALUES (1, 0.5, 10), (1, 1.2, 3);   -- 5.0 + 3.6 = 8.6
  -- bon 2: en linje uden co2e (NULL) + en med
  INSERT INTO bon_lines (bon_id, co2e, quantity) VALUES (2, NULL, 5), (2, 0.3, 4);   -- 0 + 1.2 = 1.2
  -- bon 3: ingen linjer
`);

t('Σ(co2e × quantity) frosset korrekt', () => {
    const total = recalcBonTotalCo2e(db, 1);
    assert.ok(near(total, 8.6), `total=${total}`);
    assert.ok(near(db.prepare('SELECT total_co2e FROM bons WHERE id=1').get().total_co2e, 8.6));
});
t('NULL-co2e-linjer tæller som 0', () => {
    const total = recalcBonTotalCo2e(db, 2);
    assert.ok(near(total, 1.2), `total=${total}`);
});
t('bon uden linjer → 0', () => {
    assert.ok(near(recalcBonTotalCo2e(db, 3), 0));
});
t('frosset: total ændrer sig ikke før recalc kaldes igen', () => {
    // sæt en linjes co2e op — total_co2e skal FØRST ændres når recalc kaldes
    db.prepare('UPDATE bon_lines SET co2e = 9.9 WHERE bon_id = 1 AND quantity = 3').run();
    assert.ok(near(db.prepare('SELECT total_co2e FROM bons WHERE id=1').get().total_co2e, 8.6), 'stadig gammel værdi');
    const total = recalcBonTotalCo2e(db, 1);
    assert.ok(near(total, 0.5 * 10 + 9.9 * 3)); // 5 + 29.7 = 34.7
});

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
