// scripts/test-co2-materials.js
// ============================================================
// Unit-test for CO₂ F3 — materiale-faktortabel + emballage-tildeler.
// Spec: docs/CLAUDE_CO2.md §6 + §8.
//
// Mocker grocyAdapter's produkt-/gruppe-læsning + userfield-skrivning, så vi
// tester resolve-/status-/re-resolve-logikken uden en live Grocy. Bruger en
// in-memory DB til selve faktortabellen.
//
// Kør:  node --experimental-sqlite scripts/test-co2-materials.js
// ============================================================

'use strict';

const assert = require('assert');
const { openDb } = require('../db/compat');

// ── Mock Grocy (property-access ved kald-tid, som test-recipe-factor.js) ──
const grocy = require('../services/grocyAdapter');

let PRODUCTS = [];
const GROUPS = [
    { id: 10, name: '10 Emballage' },
    { id: 1,  name: '01 Sandwich' },
];
const writes = [];           // { id, fields } — hver updateProductUserfields
grocy.getProducts       = async () => PRODUCTS.map(p => ({ ...p, userfields: { ...p.userfields } }));
grocy.getProductGroups  = async () => GROUPS.map(g => ({ ...g }));
grocy.clearCache        = () => {};
grocy.updateProductUserfields = async (id, fields) => {
    writes.push({ id, fields });
    // Spejl skrivningen ind i vores mock-produkter, så re-læsning ser den.
    const p = PRODUCTS.find(x => x.id === id);
    if (p) p.userfields = { ...(p.userfields || {}), ...fields };
};

const co2 = require('../services/co2Materials');
const { parseFactor } = require('../routes/co2')._test;

// ── In-memory faktortabel (kopi af migration 121's DDL + seed) ──
const db = openDb(':memory:');
db.exec(`
  CREATE TABLE co2_material_factors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    factor_kg_co2e_per_kg REAL, version TEXT, typical_items TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT
  );
  INSERT INTO co2_material_factors (key,label,sort_order) VALUES
    ('karton','Karton/pap',2), ('ldpe','LDPE-film',4);
`);

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}

(async () => {
    console.log('CO₂ F3 — materiale-tildeler');

    // 1. parseFactor: dansk komma, tom=null (ryd), ugyldigt=NaN
    t('parseFactor("0,9") = 0.9',        () => assert.strictEqual(parseFactor('0,9'), 0.9));
    t('parseFactor("1.250,5") = 1250.5', () => assert.strictEqual(parseFactor('1.250,5'), 1250.5));
    t('parseFactor("") = null (ryd)',    () => assert.strictEqual(parseFactor(''), null));
    t('parseFactor("abc") = NaN',        () => assert.ok(Number.isNaN(parseFactor('abc'))));
    t('parseFactor("-1") = NaN',         () => assert.ok(Number.isNaN(parseFactor('-1'))));

    // 2. fieldsForMaterial: med faktor → resolves; uden faktor → material sat, tal tomt
    t('fieldsForMaterial med faktor resolver', () => {
        const f = co2.fieldsForMaterial({ key: 'karton', factor: 1.25, version: 'KK 2025' });
        assert.strictEqual(f.co2e_material, 'karton');
        assert.strictEqual(f.co2e_source, 'material');
        assert.strictEqual(f.co2e_per_kg, '1.25');
        assert.strictEqual(f.co2e_version, 'KK 2025');
        assert.strictEqual(f.co2e_klima_id, '');   // emballage = ikke fødevare
    });
    t('fieldsForMaterial uden faktor lader tal stå tomt', () => {
        const f = co2.fieldsForMaterial({ key: 'ldpe', factor: null, version: null });
        assert.strictEqual(f.co2e_material, 'ldpe');
        assert.strictEqual(f.co2e_source, 'material');
        assert.strictEqual(f.co2e_per_kg, '');
        assert.strictEqual(f.co2e_version, '');
    });

    // 3. isPackagingGroup
    t('isPackagingGroup matcher "Emballage"', () => {
        assert.ok(co2.isPackagingGroup('10 Emballage'));
        assert.ok(!co2.isPackagingGroup('01 Sandwich'));
    });

    // ── Reset mock-produkter for status-/assign-tests ──
    PRODUCTS = [
        { id: 70, name: 'RR Boks',   product_group_id: 10, userfields: {} },
        { id: 84, name: 'Bambus spyd', product_group_id: 10, userfields: {} },
        { id: 99, name: 'Kyllingen', product_group_id: 1,  userfields: {} }, // ikke emballage
    ];
    writes.length = 0;

    // 4. listPackagingProducts filtrerer til emballage + status=unassigned
    let pkg = await co2.listPackagingProducts(db);
    t('kun emballagevarer med i listen (2, ikke sandwich)', () => {
        assert.strictEqual(pkg.length, 2);
        assert.ok(!pkg.find(p => p.id === 99));
    });
    t('alle unassigned til at starte med', () => {
        assert.ok(pkg.every(p => p.status === 'unassigned'));
    });

    // 5. assign uden faktor → status pending_factor
    await co2.assignMaterial(db, 70, 'ldpe');
    pkg = await co2.listPackagingProducts(db);
    t('assign uden faktor → pending_factor', () => {
        const p = pkg.find(x => x.id === 70);
        assert.strictEqual(p.co2e_material, 'ldpe');
        assert.strictEqual(p.status, 'pending_factor');
        assert.strictEqual(p.co2e_per_kg, null);
    });

    // 6. udfyld ldpe-faktor + re-resolve → RR Boks bliver ok med tallet
    db.prepare("UPDATE co2_material_factors SET factor_kg_co2e_per_kg=2.1, version='KK 2025' WHERE key='ldpe'").run();
    const rr = await co2.reresolveMaterial(db, 'ldpe');
    t('reresolve rammer netop den ene koblede vare', () => assert.strictEqual(rr.updated, 1));
    pkg = await co2.listPackagingProducts(db);
    t('efter re-resolve → status ok + per_kg=2.1', () => {
        const p = pkg.find(x => x.id === 70);
        assert.strictEqual(p.status, 'ok');
        assert.strictEqual(p.co2e_per_kg, 2.1);
        assert.strictEqual(p.co2e_source, 'material');
    });

    // 7. assign MED kendt faktor → resolves straks
    await co2.assignMaterial(db, 84, 'ldpe');
    pkg = await co2.listPackagingProducts(db);
    t('assign med kendt faktor resolver straks (ok)', () => {
        const p = pkg.find(x => x.id === 84);
        assert.strictEqual(p.status, 'ok');
        assert.strictEqual(p.co2e_per_kg, 2.1);
    });

    // 8. clear → tilbage til unassigned
    await co2.clearMaterial(db, 70);
    pkg = await co2.listPackagingProducts(db);
    t('clear → unassigned igen', () => {
        const p = pkg.find(x => x.id === 70);
        assert.strictEqual(p.status, 'unassigned');
        assert.strictEqual(p.co2e_material, null);
    });

    // 9. unknown_material status når varen peger på et slettet materiale
    PRODUCTS.find(p => p.id === 84).userfields.co2e_material = 'fantasi';
    pkg = await co2.listPackagingProducts(db);
    t('ukendt materiale-nøgle → status unknown_material', () => {
        assert.strictEqual(pkg.find(x => x.id === 84).status, 'unknown_material');
    });

    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
