// scripts/test-co2-computed-factor.js
// ============================================================
// #663 — co2-f5-compute.js skrev opskriftens CO₂ pr. PORTION som produktets
// kg-faktor. Uden division med udbyttet pr. portion blev Chili Mayo
// (recipeunitnumber 1,1) 10 % for høj: 3,3613 i stedet for 3,0557.
//
// Dækker co2Engine.computedProductFactors (hvad F5 må skrive), motorens regel
// om at en 'computed'-cache taber til den levende udrulning, og den delte
// udbytte-helper.
//
// Kør:  node scripts/test-co2-computed-factor.js
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../services/co2Engine');
const RY = require('../shared/recipe_yield');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.log('  ✗', name, '\n     →', e.message); fail++; }
}
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) <= eps;

console.log('CO₂ #663 — faktor for producerede varer');

// 4=Kilo, 8=Antal (plural "Stk" så plural-matchet kan prøves)
const UNITS = [{ id: 4, name: 'Kilo', name_plural: 'Kilo' }, { id: 8, name: 'Antal', name_plural: 'Stk' }];
const CONV = [
    { product_id: 200, from_qu_id: 8, to_qu_id: 4, factor: 0.02 },  // Falaffel: 1 stk = 20 g
];

// Chili Mayo: 1 kg mayo (2,9) + 0,1 kg chili (4,613) = 3,3613 kg CO₂ pr. batch,
// batchen giver 1,1 kg → 3,0557 pr. kg.
function products(over = {}) {
    const base = [
        { id: 1,   name: 'Mayo',       qu_id_stock: 4, userfields: { co2e_per_kg: '2.9',   co2e_source: 'klimadb' } },
        { id: 2,   name: 'Chili',      qu_id_stock: 4, userfields: { co2e_per_kg: '4.613', co2e_source: 'klimadb' } },
        { id: 3,   name: 'Kikærter',   qu_id_stock: 4, userfields: { co2e_per_kg: '1.0',   co2e_source: 'klimadb' } },
        { id: 4,   name: 'Uden faktor', qu_id_stock: 4, userfields: {} },
        { id: 34,  name: 'Chili Mayo', qu_id_stock: 4, userfields: {} },
        { id: 200, name: 'Falaffel',   qu_id_stock: 4, userfields: {} },
        { id: 300, name: 'Kage',       qu_id_stock: 8, userfields: {} },   // antal uden kg-vej
    ];
    return base.map(p => over[p.id] ? { ...p, userfields: { ...over[p.id] } } : p);
}
const CHILI = { id: 110, name: 'Chili Mayo', base_servings: 1, product_id: 34,
                userfields: { recipeunit: 'kg', recipeunitnumber: '1.1' } };
const MENU  = { id: 88,  name: 'Kyllingen',  base_servings: 1, userfields: {} };
const POS = [
    { recipe_id: 110, product_id: 1, amount: 1 },
    { recipe_id: 110, product_id: 2, amount: 0.1 },
    { recipe_id: 88,  product_id: 34, amount: 0.033 },
];
function data({ recipes = [CHILI, MENU], pos = POS, prodOver = {} } = {}) {
    return { units: UNITS, conversions: CONV, products: products(prodOver), nestings: [], recipes, pos };
}
const row = (d, pid) => E.computedProductFactors(d).find(x => x.product_id === pid);

/* 1. Divisionen med udbyttet */
t('recipeunitnumber 1,1 → faktor = total ÷ 1,1 (Chili Mayo 3,0557, ikke 3,3613)', () => {
    const r = row(data(), 34);
    assert.strictEqual(r.action, 'write');
    assert.strictEqual(r.factor, 3.0557, `fik ${r.factor}`);
    assert.ok(near(r.yield_kg, 1.1));
});

t('recipeunitnumber 1 → faktor = total (uændret regel)', () => {
    const d = data({ recipes: [{ ...CHILI, userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }, MENU] });
    assert.strictEqual(row(d, 34).factor, 3.3613);
});

t('base_servings 2 → udbyttet ganges med portionerne (total ÷ 2,2)', () => {
    const d = data({ recipes: [{ ...CHILI, base_servings: 2 }, MENU] });
    assert.strictEqual(row(d, 34).factor, Math.round(3.3613 / 2.2 * 10000) / 10000);
});

t('dansk komma "1,1" læses som 1,1 — ikke som 1', () => {
    const d = data({ recipes: [{ ...CHILI, userfields: { recipeunit: 'kg', recipeunitnumber: '1,1' } }, MENU] });
    assert.strictEqual(row(d, 34).factor, 3.0557);
    assert.strictEqual(RY.num('1,1'), 1.1);
    assert.strictEqual(RY.num('1.1'), 1.1);
});

t('udbytte i antal, lager i kg → konverteringen bruges (36 stk × 20 g = 0,72 kg)', () => {
    const FAL = { id: 97, name: 'Falaffel- stegning', base_servings: 1, product_id: 200,
                  userfields: { recipeunit: 'antal', recipeunitnumber: '36' } };
    const d = data({ recipes: [FAL], pos: [{ recipe_id: 97, product_id: 3, amount: 0.5 }] });
    const r = row(d, 200);
    assert.ok(near(r.yield_kg, 0.72), `udbytte ${r.yield_kg}`);
    assert.strictEqual(r.factor, Math.round(0.5 / 0.72 * 10000) / 10000);
});

t('antal uden kg-vej → springes over, der gættes ikke', () => {
    const KAGE = { id: 18, name: 'Kage bagning', base_servings: 1, product_id: 300,
                   userfields: { recipeunit: 'antal', recipeunitnumber: '10' } };
    const r = row(data({ recipes: [KAGE], pos: [{ recipe_id: 18, product_id: 3, amount: 1 }] }), 300);
    assert.strictEqual(r.action, 'skip');
    assert.match(r.reason, /kg-vej/);
});

t('intet erklæret udbytte → springes over', () => {
    const d = data({ recipes: [{ ...CHILI, userfields: { recipeunit: 'kg' } }, MENU] });
    assert.strictEqual(row(d, 34).action, 'skip');
});

t('ufuldstændig opskrift → springes over (vi cacher aldrig et halvt tal)', () => {
    const d = data({ pos: [...POS, { recipe_id: 110, product_id: 4, amount: 0.1 }] });
    const r = row(d, 34);
    assert.strictEqual(r.action, 'skip');
    assert.match(r.reason, /ufuldstændig/);
});

/* 2. Kilder der aldrig må røres */
for (const src of ['klimadb', 'supplier', 'manual', 'material']) {
    t(`ægte faktor (${src}) → urørt`, () => {
        const r = row(data({ prodOver: { 34: { co2e_per_kg: '2.775', co2e_source: src } } }), 34);
        assert.strictEqual(r.action, 'skip');
        assert.strictEqual(r.factor, null);
    });
}
t('faktor uden kilde → urørt (et menneske har sat den)', () => {
    assert.strictEqual(row(data({ prodOver: { 34: { co2e_per_kg: '2.775' } } }), 34).action, 'skip');
});
t("'na' uden faktor → urørt (bevidst ikke relevant — ellers overskrev den gamle vagt den)", () => {
    const r = row(data({ prodOver: { 34: { co2e_source: 'na' } } }), 34);
    assert.strictEqual(r.action, 'skip');
    assert.match(r.reason, /'na'/);
});
t("tidligere 'computed' → genberegnes", () => {
    const r = row(data({ prodOver: { 34: { co2e_per_kg: '3.3613', co2e_source: 'computed' } } }), 34);
    assert.strictEqual(r.action, 'write');
    assert.strictEqual(r.factor, 3.0557);
});
t("'computed' med samme tal → uændret (intet skrives)", () => {
    const r = row(data({ prodOver: { 34: { co2e_per_kg: '3.0557', co2e_source: 'computed' } } }), 34);
    assert.strictEqual(r.action, 'unchanged');
});

/* 3. Samme opskrift som motoren */
t('flere producenter → laveste opskrift-id, som motoren (ikke den sidste i listen)', () => {
    const A = { ...CHILI, id: 110 };
    const B = { ...CHILI, id: 150, name: 'Chili Mayo gammel', userfields: { recipeunit: 'kg', recipeunitnumber: '1' } };
    const d = data({ recipes: [B, A, MENU], pos: [...POS,
        { recipe_id: 150, product_id: 1, amount: 1 }, { recipe_id: 150, product_id: 2, amount: 0.1 }] });
    const rows = E.computedProductFactors(d).filter(x => x.product_id === 34);
    assert.strictEqual(rows.length, 1, 'én række pr. vare');
    assert.strictEqual(rows[0].recipe_id, 110);
    assert.strictEqual(rows[0].factor, 3.0557);
});

/* 4. B — en computed-cache taber til den levende udrulning */
t("forældet 'computed'-cache på varen → motoren ruller fra opskriften (cachen ignoreres)", () => {
    const d = data({ prodOver: { 34: { co2e_per_kg: '9.9', co2e_source: 'computed' } } });
    const r = E.computeAll(d).get(88);
    assert.ok(near(r.total, 0.033 * 3.3613 / 1.1), `fik ${r.total} — cachen 9,9 vandt`);
});
t("'computed' uden bestemmeligt udbytte → cachen bruges som fallback", () => {
    const d = data({ recipes: [{ ...CHILI, userfields: { recipeunit: 'kg' } }, MENU],
                     prodOver: { 34: { co2e_per_kg: '3.0', co2e_source: 'computed' } } });
    assert.ok(near(E.computeAll(d).get(88).total, 0.099));
});
t('ægte faktor på varen vinder stadig over opskriften', () => {
    const d = data({ prodOver: { 34: { co2e_per_kg: '2.775', co2e_source: 'supplier' } } });
    assert.ok(near(E.computeAll(d).get(88).total, 0.033 * 2.775));
});
t('skrevet faktor = motorens udrulning (læse- og skrivesiden er enige)', () => {
    const f = row(data(), 34).factor;
    const rolled = E.computeAll(data()).get(88).total / 0.033;
    assert.ok(Math.abs(f - rolled) < 5e-5, `skrevet ${f}, udrullet ${rolled}`);
});

/* 5. Én udbytte-regel */
t("motoren bruger den delte helper: recipeunit 'Kilogram' og plural 'Stk' kan rulles", () => {
    const d = data({ recipes: [{ ...CHILI, userfields: { recipeunit: 'Kilogram', recipeunitnumber: '1.1' } }, MENU] });
    assert.ok(near(E.computeAll(d).get(88).total, 0.033 * 3.3613 / 1.1));
    const ctx = E.buildCtx(data());
    const FAL = { id: 97, base_servings: 1, product_id: 200, userfields: { recipeunit: 'Stk', recipeunitnumber: '36' } };
    assert.ok(near(E.producedYieldStock(FAL, ctx.productById.get('200'), ctx), 0.72));
});
t('co2Engine har ikke sin egen udbytte-regel igen', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'co2Engine.js'), 'utf8');
    assert.ok(/yieldInStockUnits\(recipeRaw, product, ctx\.units, ctx\.conversions\)/.test(src));
    assert.ok(!/UNIT_ALIAS\s*=/.test(src), 'en lokal alias-tabel er tilbage');
});

/* 6. F5-scriptet bruger reglen */
t('co2-f5-compute.js skriver fra computedProductFactors, ikke co2e_per_serving', () => {
    const src = fs.readFileSync(path.join(__dirname, 'co2-f5-compute.js'), 'utf8');
    assert.ok(/engine\.computedProductFactors\(/.test(src));
    assert.ok(!/co2e_per_kg:\s*String\(fmt\(r\.co2e_per_serving/.test(src), 'den gamle regel er tilbage');
    assert.ok(src.indexOf('computedProductFactors(') < src.indexOf('if (APPLY)'),
        'rapporten skal vises i dry-run, før --apply');
});

/* 7. recipes.Co2e-cachen — kun forskelle (natlig kørsel) */
console.log('\nrecipes.Co2e: kun forskelle skrives');
const PSEUDO = { id: 7, name: 'Rabat', base_servings: 1, userfields: {} };
function cacheData(chiliCo2e, menuCo2e, extra = {}) {
    const d = data(extra);
    d.recipes = [{ ...CHILI, userfields: { ...CHILI.userfields, Co2e: chiliCo2e } },
                 { ...MENU,  userfields: { Co2e: menuCo2e } }, PSEUDO];
    return d;
}
const up = (d) => E.recipeCacheUpdates(d);
const byId = (rows, id) => rows.find(x => x.recipe_id === id);
t('cachen er aktuel → intet skrives', () => {
    const rows = up(cacheData('3.3613', String(Math.round(0.033 * 3.3613 / 1.1 * 10000) / 10000)));
    assert.deepStrictEqual(rows.filter(x => x.action === 'write'), []);
    assert.strictEqual(rows.filter(x => x.action === 'unchanged').length, 2);
});
t('forældet cache → skrives med før og efter', () => {
    const r = byId(up(cacheData('3.5', '0.1')), 110);
    assert.strictEqual(r.action, 'write');
    assert.strictEqual(r.current, 3.5);
    assert.strictEqual(r.next, 3.3613);
});
t('tom cache → skrives', () => {
    assert.strictEqual(byId(up(cacheData('', '')), 110).action, 'write');
});
t('dansk komma i cachen læses som tal (ellers skrives alt hver nat)', () => {
    assert.strictEqual(byId(up(cacheData('3,3613', '')), 110).action, 'unchanged');
});
t('opskrift uden ingredienser får aldrig et 0 skrevet', () => {
    assert.strictEqual(byId(up(cacheData('', '')), 7), undefined);
});
t('ufuldstændig opskrift med gammelt tal → stale, skrives ikke', () => {
    const d = cacheData('3.3613', '0.1');
    d.pos = [...d.pos, { recipe_id: 110, product_id: 4, amount: 0.1 }];
    const rows = up(d);
    assert.strictEqual(byId(rows, 110).action, 'stale');
    assert.strictEqual(byId(rows, 110).next, null);
    assert.strictEqual(byId(rows, 88).action, 'stale', 'menuen er også ufuldstændig nu');
});
t('co2-f5-compute.js skriver kun "write"-rækker, ikke alle komplette', () => {
    const src = fs.readFileSync(path.join(__dirname, 'co2-f5-compute.js'), 'utf8');
    assert.ok(/for \(const x of toWrite\) \{\s*try \{ await grocy\(cfg, 'PUT', `\/userfields\/recipes\//.test(src),
        'skrive-løkken skal gå over toWrite');
    assert.ok(!/for \(const r of complete\)[\s\S]{0,120}userfields\/recipes/.test(src), 'den gamle skriv-alt-løkke er tilbage');
    assert.ok(/recipeCacheUpdates\(\{ recipes, pos, nestings \}/.test(src), 'pos/nestings skal med, ellers får tomme opskrifter 0');
});

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
