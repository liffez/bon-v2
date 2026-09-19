// tests/grocy_num.test.js
// ============================================================
// Tal fra Grocy-userfields læses med shared/grocy_num.js — ikke rå parseFloat.
//
// `parseFloat("1,1")` giver 1: et dansk decimal-komma bliver TAVST til et
// forkert tal. Grocy gemmer i dag med punktum, så det her er et værn.
//
// Dækker:
//   §1  hjælperen: komma, punktum, tal, tomt/vrøvl → NaN (som parseFloat)
//   §2  paritet: uden komma svarer den PRÆCIS som parseFloat — ellers ville
//       kaldstedernes `|| 0` / `|| 1`-fallbacks skifte betydning
//   §3  serveren bruger den: udbytte (ingredientResolver + recipeCost)
//   §4  browseren bruger den: pris/CO₂ i opskrift-editoren, pakkestørrelse
//       i indkøb — de ÆGTE funktioner skåret ud af filerne og kørt i en vm
//   §5  vagt: ingen rå parseFloat på et userfield i koden, og hver side der
//       loader en fil med GrocyNum.num loader også grocy_num.js FØR den
//
// Kør:  node --test tests/grocy_num.test.js
// ============================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { num } = require('../shared/grocy_num');

// ── §1 hjælperen ─────────────────────────────────────────────
test('§1 dansk komma læses som decimaltegn', () => {
    assert.equal(num('1,1'), 1.1);
    assert.equal(num(' 2,5 '), 2.5);
    assert.equal(num('0,25'), 0.25);
    assert.equal(num('-3,75'), -3.75);
});

test('§1 punktum og rene tal er uændrede', () => {
    assert.equal(num('1.1'), 1.1);
    assert.equal(num(94), 94);
    assert.equal(num('0'), 0);
});

test('§1 tomt, null, undefined og vrøvl giver NaN — ikke 0', () => {
    for (const v of ['', '   ', null, undefined, 'abc', ',']) {
        assert.ok(Number.isNaN(num(v)), `num(${JSON.stringify(v)}) skal være NaN`);
    }
    // Så kaldstedernes fallbacks virker som før.
    assert.equal(num('') || 0, 0);
    assert.equal(num(undefined) || 1, 1);
});

// ── §2 paritet med parseFloat uden komma ─────────────────────
test('§2 uden komma svarer num præcis som parseFloat', () => {
    const inputs = ['1.5', ' 7 ', '12abc', '1e3', '-0.5', '.5', '', null, undefined,
        'abc', '0', '100', 0, 2.25, NaN, '1.234.5'];
    for (const v of inputs) {
        const a = num(v), b = parseFloat(v);
        assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)),
            `num(${JSON.stringify(v)})=${a} mod parseFloat=${b}`);
    }
});

// ── §3 serveren ──────────────────────────────────────────────
test('§3 ingredientResolver: udbytte med komma læses rigtigt', () => {
    const { yieldPerBatchStockOf } = require('../services/ingredientResolver');
    const units = new Map([[2, { id: 2, name: 'Kilo', name_plural: 'Kilo' }]]);
    const recipe = { id: 1, base_servings: 1, userfields: { recipeunitnumber: '1,5', recipeunit: 'kg' } };
    const product = { id: 10, qu_id_stock: 2 };
    assert.equal(yieldPerBatchStockOf(recipe, product, units, []), 1.5);
});

test('§3 recipeCost: yield_amount med komma læses rigtigt', () => {
    const { computeAll } = require('../services/recipeCost');
    const out = computeAll({
        recipes: [{ id: 1, name: 'R', base_servings: 2,
            userfields: { recipeunitnumber: '1,25', recipeunit: 'kg' } }],
    });
    assert.equal(out.get(1).yield_amount, 2.5);
});

// ── §4 browseren ─────────────────────────────────────────────
// Funktionerne skæres ud af filerne (browser-kode kan ikke require'es) og
// køres mod den ÆGTE grocy_num.js — det er de samme funktioner browseren bruger.
function extractFn(file, name) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} findes i ${file}`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 2);
}

function browserSandbox(extra = {}) {
    const ctx = vm.createContext({ window: {}, isFinite, ...extra });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/grocy_num.js'), 'utf8'), ctx);
    ctx.GrocyNum = ctx.window.GrocyNum;
    return ctx;
}

test('§4 opskrift-editoren: salgspris og CO₂ med komma', () => {
    const ctx = browserSandbox({
        _rdRecipeMap: { 7: { userfields: { SalespriceCatering: '129,5', Co2e: '0,42' } } },
        _rdDs: { originalRecipeId: 7 },
        _rdPrice: { priceCat: 'catering' },
    });
    vm.runInContext(extractFn('shared/recipe_designer.js', '_rdActualPriceIncl'), ctx);
    vm.runInContext(extractFn('shared/recipe_designer.js', '_rdCo2PerUnit'), ctx);
    assert.equal(vm.runInContext('_rdActualPriceIncl()', ctx), 129.5);
    assert.equal(vm.runInContext('_rdCo2PerUnit()', ctx), 0.42);
});

test('§4 indkøb: pakkestørrelse med komma, fallback 1 bevaret', () => {
    const ctx = browserSandbox();
    vm.runInContext(extractFn('shared/indkob.js', '_ibPackSizeKg'), ctx);
    const f = vm.runInContext('_ibPackSizeKg', ctx);
    assert.equal(f({ userfields: { pack_size_stock_unit: '2,5' } }), 2.5);
    assert.equal(f({ userfields: { pack_size_stock_unit: 'abc' } }), 1);
    assert.equal(f({ userfields: {} }), 1);
});

// ── §5 vagt ──────────────────────────────────────────────────
// De to filer #663 omskriver (co2Engine, recipe_yield) er undtaget indtil den
// er merget — dér flytter #663 dem selv over på num().
const ALLOW = new Set(['services/co2Engine.js', 'shared/recipe_yield.js']);
const USERFIELD_PARSEFLOAT = /parseFloat\(\s*\(?\s*(uf\b|[\w.]*userfields\b|\(\s*[\w.]*userfields)/;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out); }
        else if (e.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

test('§5 ingen rå parseFloat på et Grocy-userfield', () => {
    const hits = [];
    for (const dir of ['services', 'shared', 'routes', 'office', 'kitchen', 'scripts', 'mobile']) {
        if (!fs.existsSync(path.join(ROOT, dir))) continue;
        for (const f of walk(dir)) {
            if (ALLOW.has(f)) continue;
            fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
                if (USERFIELD_PARSEFLOAT.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
            });
        }
    }
    assert.deepEqual(hits, [], 'brug grocyNum()/GrocyNum.num() fra shared/grocy_num.js');
});

test('§5 sider der bruger GrocyNum.num loader grocy_num.js før filen', () => {
    const users = walk('shared').concat(walk('office'), walk('kitchen'))
        .filter(f => /GrocyNum\.num\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
        .map(f => '/' + f);
    assert.ok(users.length > 0);
    const pages = [];
    for (const dir of ['office', 'kitchen', 'mobile', 'settings']) {
        if (!fs.existsSync(path.join(ROOT, dir))) continue;
        for (const e of fs.readdirSync(path.join(ROOT, dir))) {
            if (e.endsWith('.html')) pages.push(path.join(dir, e));
        }
    }
    for (const page of pages) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        for (const u of users) {
            const at = html.indexOf(`src="${u}`);
            if (at < 0) continue;
            const helper = html.indexOf('src="/shared/grocy_num.js');
            assert.ok(helper >= 0 && helper < at, `${page} loader ${u} uden grocy_num.js før`);
        }
    }
});
