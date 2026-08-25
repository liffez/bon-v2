// scripts/test-portions-decimal.js
// ============================================================
// Test for #548 — decimale portioner på opskrifter.
//
// Driftsbehovet: intern produktion (RR Produktion) skal kunne skaleres så den
// passer med de råvarer der faktisk står på lager. Før kunne portioner kun
// justeres i hele trin.
//
// `shared/recipe_viewer.js` og `shared/production_batch.js` er browser-kode og
// kan ikke require'es. De køres i en vm-sandkasse med stubbede globals, og de
// rene funktioner kaldes direkte — det er de samme funktioner browseren bruger,
// ikke en kopi. Samme mønster som scripts/test-recipe-viewer-nested.js.
//
// Dækker:
//   P1  dansk komma (taltastaturet på iPad giver ',' — ikke '.')
//   P2  klampning: 0/tomt/vrøvl falder tilbage, aldrig negative portioner
//   P3  ± går i hele trin, også fra en decimal
//   P4  lagertrækket må ikke runde en lille ingrediens VÆK (den fælde
//       decimalerne åbner — se RV_CONSUME_DECIMALS)
//   P5  produktionsbatchen arver portionstallet i stedet for base_servings
//
// Kør:  node scripts/test-portions-decimal.js
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ══════════════════════════════════════════════════════════════
// Sandkasse — kun det browser-API filerne rører ved indlæsning
// ══════════════════════════════════════════════════════════════
function makeSandbox(file) {
    const noop = () => {};
    // Feltet skal opføre sig som et rigtigt input: værdien skal kunne læses
    // tilbage, ellers kan vi ikke se hvad brugeren faktisk ville få vist.
    const fields = {};
    const mkEl = (id) => ({
        id, value: '', textContent: '', innerHTML: '',
        addEventListener: noop, appendChild: noop, select: noop, blur: noop, click: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, getAttribute: () => null, setAttribute: noop,
        querySelector: () => null, querySelectorAll: () => [],
    });
    const getEl = (id) => (fields[id] || (fields[id] = mkEl(id)));

    const sandbox = {
        console,
        document: {
            getElementById: getEl,
            querySelector: () => mkEl('q'), querySelectorAll: () => [],
            createElement: () => mkEl('c'), addEventListener: noop, body: mkEl('body'),
        },
        window: {}, localStorage: { getItem: () => null, setItem: noop },
        sessionStorage: { getItem: () => null, setItem: noop },
        fetch: async () => ({ json: async () => [] }),
        setTimeout, clearTimeout, esc: (s) => String(s),
        __fields: fields,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', file), 'utf8'),
                    sandbox, { filename: file });
    return sandbox;
}

// ══════════════════════════════════════════════════════════════
// Opskrift-vieweren
// ══════════════════════════════════════════════════════════════
const rv = makeSandbox('recipe_viewer.js');
const felt = () => rv.__fields['rvPortionsDisplay'].value;
// _rvSetPortions kalder _rvRenderIngredients — den rører DOM vi ikke stubber
// fuldt ud, så den neutraliseres. Portions-logikken er det testen handler om.
rv._rvRenderIngredients = () => {};
rv._rvBaseServings = 1;

console.log('\nDecimale portioner på opskrifter (#548)\n');

console.log('P1 · Dansk komma — taltastaturet på en iPad giver ","');
ok(close(rv._rvNum('0,5'), 0.5),   '"0,5" → 0.5');
ok(close(rv._rvNum('1.4'), 1.4),   '"1.4" → 1.4 (punktum virker også)');
ok(close(rv._rvNum('  2,25 '), 2.25), 'mellemrum omkring tallet ignoreres');
ok(rv._rvNum('abc') === 0,         'vrøvl → 0 (fanges af klampningen)');
ok(rv._rvNum('') === 0,            'tomt → 0');
ok(rv._rvNum(null) === 0,          'null → 0');
ok(rv._rvFmtPortions(1.4) === '1,4', 'vises med komma igen: 1.4 → "1,4"');
ok(rv._rvFmtPortions(2) === '2',     'hele tal står rent: 2 → "2"');

console.log('\nP2 · Klampning — 0 portioner er ikke en brugbar tilstand');
rv._rvBaseServings = 1;
rv._rvSetPortions(0.5);
ok(close(rv._rvCurrentPortions, 0.5) && felt() === '0,5', 'halv portion accepteres og vises som "0,5"');
rv._rvSetPortions(0);
ok(rv._rvCurrentPortions === 1, '0 falder tilbage til base_servings');
rv._rvSetPortions(-3);
ok(rv._rvCurrentPortions === 1, 'negativ falder tilbage til base_servings');
rv._rvSetPortions(rv._rvNum('abc'));
ok(rv._rvCurrentPortions === 1, 'vrøvl-input falder tilbage til base_servings');
rv._rvBaseServings = 4;
rv._rvSetPortions(0);
ok(rv._rvCurrentPortions === 4, 'fallback bruger opskriftens EGET tal, ikke hardkodet 1');
rv._rvBaseServings = 1;

console.log('\nP3 · ± går i hele trin — decimaler tastes i feltet');
rv._rvSetPortions(1.4);
rv._rvAdjustPortions(1);
ok(close(rv._rvCurrentPortions, 2.4), '1,4 + 1 = 2,4 (decimalen bevares)');
rv._rvAdjustPortions(-1);
ok(close(rv._rvCurrentPortions, 1.4), '2,4 − 1 = 1,4');
rv._rvAdjustPortions(-1);
ok(close(rv._rvCurrentPortions, 0.4), '1,4 − 1 = 0,4 — stadig gyldigt, ikke klampet til 1');
rv._rvAdjustPortions(-1);
ok(rv._rvCurrentPortions === 1, '0,4 − 1 ville være negativt → falder tilbage');

console.log('\nP4 · Lagertrækket må ikke runde en lille ingrediens VÆK');
// Fælden decimalerne åbner: 0,06 L balsamico × 0,05 portioner = 0,003.
// Med visningens to decimaler blev det 0,00, og consume-stien springer
// `amount <= 0` over — helt stille. Målt i drift på "Balsamico + løg".
ok(rv.RV_CONSUME_DECIMALS >= 4, `lagertræk runder til ${rv.RV_CONSUME_DECIMALS} decimaler, ikke visningens 2`);
const lille = 0.06 * 0.05;
ok(rv._rvRound(lille, 2) === 0,   'med 2 decimaler forsvinder 0,06 × 0,05 → 0 (det var fælden)');
ok(rv._rvRound(lille, rv.RV_CONSUME_DECIMALS) > 0,
   `med ${rv.RV_CONSUME_DECIMALS} overlever den: ${rv._rvRound(lille, rv.RV_CONSUME_DECIMALS)}`);
ok(rv._rvRound(0.06 * 0.01, rv.RV_CONSUME_DECIMALS) > 0, 'også ved 0,01 portioner');
ok(close(rv._rvRound(0.06 * 1, rv.RV_CONSUME_DECIMALS), 0.06),
   'hele portioner er uændrede — ingen regression');

// ══════════════════════════════════════════════════════════════
// Produktionsbatchen
// ══════════════════════════════════════════════════════════════
console.log('\nP5 · Producér arver portionstallet i stedet for base_servings');
const pb = makeSandbox('production_batch.js');

// `production_batch.js` er en IIFE, så `_st` kan ikke nås udefra. I stedet
// gives modalen en rigtig container, og tilstanden aflæses i den markup den
// faktisk renderer — det beviser samtidig at feltet får den rigtige værdi.
function aabn(extra) {
    let html = '';
    const container = {
        set innerHTML(v) { html = v; }, get innerHTML() { return html; },
        // _bind() henter elementer via container.querySelector — de skal
        // findes, ellers når vi aldrig frem til den renderede markup.
        querySelector: () => ({ addEventListener: () => {}, value: '', textContent: '',
                                className: '', innerHTML: '', style: {}, dataset: {},
                                getAttribute: () => null, setAttribute: () => {},
                                querySelector: () => null, querySelectorAll: () => [] }),
        querySelectorAll: () => [],
        addEventListener: () => {}, appendChild: () => {}, style: {},
    };
    pb.ProductionBatch.open(Object.assign({
        recipe: { id: 9, name: 'Balsamico + løg', base_servings: 2, product_id: 0 },
        ingredients: [{ product_id: 100, amount: 1.0, qu_id: 4 }],   // 1 kg pr. base (= 2 portioner)
        productsMap: { 100: { name: 'Løg', qu_id_stock: 4 } },
        quUnitsMap: { 4: 'Kilo' }, conversions: [],
    }, extra, { container }));
    const portions = (html.match(/id="pbPortions"[^>]*value="([^"]*)"/) || [])[1];
    // Master-kolonnen er opskriftens skalerede tal for den ene råvare.
    const master = (html.match(/pb-master[^>]*>([^<]*)</) || [])[1];
    return { portions, master, html };
}

let r = aabn({});
ok(r.portions === '2', `uden portions: starter på base_servings — fik "${r.portions}"`);

r = aabn({ portions: 0.5 });
ok(r.portions === '0,5', `portions: 0.5 arves og vises som "0,5" — fik "${r.portions}"`);
ok(/0,25/.test(r.html), '1 kg pr. 2 portioner → 0,25 kg ved en halv portion');

r = aabn({ portions: '1,4' });
ok(r.portions === '1,4', `dansk komma som streng arves også — fik "${r.portions}"`);
ok(/0,7/.test(r.html), '1,4 af base 2 → 0,7 kg løg');

r = aabn({ portions: 3 });
ok(r.portions === '3', 'hele tal arves uændret');

for (const [navn, v] of [['0', 0], ['negativ', -1], ['vrøvl', 'abc'], ['tomt', '']]) {
    r = aabn({ portions: v });
    ok(r.portions === '2', `${navn} falder tilbage til base — aldrig en tom batch (fik "${r.portions}")`);
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
