// scripts/test-recipe-viewer-nested.js
// ============================================================
// Regressionstest for #353 — underopskrifter i opskrift-vieweren.
//
// `shared/recipe_viewer.js` er browser-kode og kan ikke require'es. Den køres
// derfor i en vm-sandkasse med stubbede globals, hvorefter de rene funktioner
// kaldes direkte. Det er de samme funktioner browseren bruger — ikke en kopi.
//
// Dækker:
//   1. base_servings i rekursionen (samme fejl som #349, men klient-side —
//      og den sidder i "Træk fra lager", altså rigtigt lagertræk)
//   2. Vægt-beregning der ikke gik i dybden (IKKE latent — der er nesting
//      i dybde 2 i grocy-hq i dag)
//   3. Status-oprulning på underopskrifter (den hardcodede grønne prik)
//
// Kør:
//   node scripts/test-recipe-viewer-nested.js
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Sandkasse med lige netop det browser-API filen rører ved indlæsning ──
const noop = () => {};
const stubEl = { addEventListener: noop, appendChild: noop, textContent: '', innerHTML: '',
                 classList: { add: noop, remove: noop, toggle: noop }, style: {}, querySelector: () => null,
                 querySelectorAll: () => [] };
const sandbox = {
    console,
    document: { getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [],
                createElement: () => stubEl, addEventListener: noop, body: stubEl },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    fetch: async () => ({ json: async () => [] }),
    setTimeout, clearTimeout, esc: (s) => String(s),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recipe_viewer.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'recipe_viewer.js' });

// ── Fixture: bevidst base_servings > 1 i to niveauer ──
//   1 Sandwich  base=1  → nester 2 "Æggesalat"  servings=2
//   2 Æggesalat base=4  → nester 3 "Remoulade"  servings=2
//   3 Remoulade base=2
Object.assign(sandbox, {
    _rvRecipeMap: {
        1: { id: 1, name: 'Sandwich',  base_servings: 1 },
        2: { id: 2, name: 'Æggesalat', base_servings: 4 },
        3: { id: 3, name: 'Remoulade', base_servings: 2 },
    },
    _rvAllNestings: [
        { recipe_id: 1, includes_recipe_id: 2, servings: 2 },
        { recipe_id: 2, includes_recipe_id: 3, servings: 2 },
    ],
    _rvAllRecipesPos: {
        2: [{ recipe_id: 2, product_id: 100, amount: 1, qu_id: 4, ingredient_group: '' },
            { recipe_id: 2, product_id: 300, amount: 5, qu_id: 4, ingredient_group: 'Emballage' }],
        3: [{ recipe_id: 3, product_id: 101, amount: 1, qu_id: 4, ingredient_group: '' }],
    },
    _rvProducts: {
        100: { id: 100, name: 'Æg',      qu_id_stock: 4 },
        101: { id: 101, name: 'Mayo',    qu_id_stock: 4 },
        300: { id: 300, name: 'Serviet', qu_id_stock: 4 },
    },
    _rvQuantityUnits: { 4: 'Kilo' },
    _rvChildrenByParent: {},
});

const setStock = (s) => { sandbox._rvStock = s; };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('\nOpskrift-viewer: underopskrifter i dybden (#353)\n');

// ── S1: rekursionens multiplier ──
console.log('S1 · base_servings må ikke ganges på igen ved rekursion');
setStock({ 100: 99, 101: 99 });
const seen = {};
sandbox._rvWalkNested(1, 1, (ing, m, sub) => {
    seen[sandbox._rvProducts[ing.product_id].name] = (parseFloat(ing.amount) || 0) * m;
}, {});
ok(close(seen['Æg'], 0.5),   `Æg 0,5 (2 servings / base 4) — fik ${seen['Æg']}`);
ok(close(seen['Mayo'], 0.5), `Mayo 0,5 i dybde 2 — den gamle kode gav 2 — fik ${seen['Mayo']}`);
ok(seen['Serviet'] === undefined, 'emballage springes over i blandingen');

// ── S2: vægt går nu i dybden ──
console.log('\nS2 · Vægt tæller underopskriftens egne underopskrifter med');
const w = sandbox._rvCalculateSubRecipeWeightGrams(2, 2);
ok(close(w, 1000), `0,5 kg æg + 0,5 kg mayo = 1000 g — uden rekursion kun 500 — fik ${w}`);

// ── S3: status rulles op ──
console.log('\nS3 · Status på underopskriften afspejler dens råvarer');
setStock({ 100: 99, 101: 99 });
let st = sandbox._rvNestingStatus(2, 2);
ok(st.status === 'ok' && st.shortfalls.length === 0, `alt på lager → 'ok' uden mangelliste — fik '${st.status}'`);

setStock({ 100: 0.2, 101: 99 });
st = sandbox._rvNestingStatus(2, 2);
ok(st.status === 'low', `for lidt æg → 'low' — fik '${st.status}'`);
ok(st.shortfalls.length === 1 && st.shortfalls[0].name === 'Æg', `mangelliste = [Æg] — fik [${st.shortfalls.map(s => s.name)}]`);

setStock({ 100: 0, 101: 99 });
ok(sandbox._rvNestingStatus(2, 2).status === 'missing', `ingen æg → 'missing'`);

setStock({ 100: 99, 101: 0 });
st = sandbox._rvNestingStatus(2, 2);
ok(st.status === 'missing', `mangel i DYBERE blanding (Mayo i Remoulade) slår igennem — fik '${st.status}'`);
ok(st.shortfalls.some(s => s.name === 'Mayo'), 'Mayo står på mangellisten');

setStock({ 100: 99, 101: 99, 300: 0 });
st = sandbox._rvNestingStatus(2, 2);
ok(st.status === 'ok', `manglende servietter gør ikke blandingen rød — fik '${st.status}'`);

// ── S4: cyklus vælter ikke siden ──
console.log('\nS4 · Cyklus i recipes_nestings giver ikke uendelig rekursion');
sandbox._rvAllNestings.push({ recipe_id: 3, includes_recipe_id: 2, servings: 1 });
let survived = true;
try { sandbox._rvCalculateSubRecipeWeightGrams(2, 2); sandbox._rvNestingStatus(2, 2); }
catch (e) { survived = false; console.log('   ', e.message); }
ok(survived, 'både vægt og status overlever en cyklus');
sandbox._rvAllNestings.pop();

console.log('\n─────────────────────────────────────────');
console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
