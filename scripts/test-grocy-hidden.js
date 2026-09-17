// scripts/test-grocy-hidden.js
// ============================================================
// #616 — Bon respekterer Grocys to produkt-flag.
//
//   hide_on_stock_overview  "Vis aldrig på lageroversigten"
//   no_own_stock            forælder hvis beholdning ligger på børnene
//
// Hvorfor det ikke bare er kosmetik: en forælder står per konstruktion med 0
// på sin egen lagerrække, så i optællingen ligner den en tom vare. Det var
// dét der fik nogen til at trykke "Varen findes ikke mere" på kål — varen
// blev sat inaktiv i Grocy, og 13 bons fik `partial` 14.–16. september 2026.
//
// Browser-kode kan ikke require's, så de RIGTIGE filer køres i en
// vm-sandkasse (samme mønster som test-stock-inactive.js). utils.js loades
// først, så helper-definitionen er den ægte og ikke en stub.
//
// Kør:  npm run test:grocy-hidden
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function eq(a, b, label) {
    if (JSON.stringify(a) === JSON.stringify(b)) { pass++; return; }
    fail++;
    console.log('  ✗ ' + label + '\n      forventet: ' + JSON.stringify(b) + '\n      fik:       ' + JSON.stringify(a));
}
function ok(c, label) { eq(!!c, true, label); }

const SHARED = path.join(__dirname, '..', 'shared');
function load(sandbox, file) {
    vm.runInContext(fs.readFileSync(path.join(SHARED, file), 'utf8'), sandbox, { filename: file });
}

// ── Fælles DOM-attrap ────────────────────────────────────────
function makeEls() {
    const els = {};
    return function el(id) {
        if (!els[id]) els[id] = {
            id, value: '', innerHTML: '', textContent: '', style: {}, disabled: false,
            classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            // Elementer giver stub-elementer tilbage, ikke null: _icStartCheck
            // wirer lyttere på sine egne knapper, og en null dér ville vælte
            // testen før vi når det den handler om.
            querySelector: (sel) => el(id + '>' + sel), querySelectorAll: () => [],
            appendChild() {}, remove() {}, addEventListener() {}, scrollIntoView() {},
        };
        return els[id];
    };
}

// ── Produkt-fixture ──────────────────────────────────────────
// Kål er den ægte sag: forælder, ingen egen beholdning, skjult i oversigten.
const P = (id, name, extra) => Object.assign({
    id, name, active: '1', qu_id_stock: 1, location_id: 1, product_group_id: 1,
    hide_on_stock_overview: 0, no_own_stock: 0, parent_product_id: null,
    userfields: { HverDag: '7' },
}, extra || {});

const PRODUCTS = [
    P(1, 'Brød Rug'),
    P(2, 'Kål', { hide_on_stock_overview: 1, no_own_stock: 1 }),
    P(3, 'Spidskål', { parent_product_id: 2 }),
    P(4, 'Hvidkål',  { parent_product_id: 2 }),
    // Flagene er uafhængige — begge veje skal kunne stå alene.
    P(5, 'Kun skjult',      { hide_on_stock_overview: 1 }),
    P(6, 'Kun uden lager',  { no_own_stock: 1 }),
];

(async () => {

// ════════════════════════════════════════════════════════════
console.log('1. helperne tåler Grocys formater');
// ════════════════════════════════════════════════════════════
{
    // utils.js hænger en pointerdown-lytter på document ved indlæsning.
    const el = makeEls();
    const sb = { console, setTimeout, clearTimeout,
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => el('_t'), addEventListener() {}, body: el('body') } };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    load(sb, 'utils.js');

    // Grocy sender kolonner som tal, userfields som strenge. Begge skal virke.
    ok(sb.grocyFlagOn(1),      'tallet 1 er sat');
    ok(sb.grocyFlagOn('1'),    'strengen "1" er sat');
    ok(sb.grocyFlagOn(true),   'true er sat');
    eq(sb.grocyFlagOn(0),         false, 'tallet 0 er ikke sat');
    eq(sb.grocyFlagOn('0'),       false, 'strengen "0" er ikke sat');
    eq(sb.grocyFlagOn(undefined), false, 'undefined er ikke sat');
    eq(sb.grocyFlagOn(null),      false, 'null er ikke sat');
    eq(sb.grocyFlagOn(''),        false, 'tom streng er ikke sat');

    ok(sb.grocyHiddenOnStockOverview({ hide_on_stock_overview: 1 }), 'skjult-flaget læses');
    ok(sb.grocyHasNoOwnStock({ no_own_stock: '1' }),                 'uden-eget-lager læses');
    eq(sb.grocyHiddenOnStockOverview(null),      false, 'null produkt vælter ikke');
    eq(sb.grocyHasNoOwnStock(undefined),         false, 'undefined produkt vælter ikke');
    // Et produkt UDEN felterne (fx /stock's indlejrede `product`) må ikke
    // skjules — så ville en almindelig vare forsvinde ved et hik.
    eq(sb.grocyHiddenOnStockOverview({ id: 9 }),  false, 'manglende felt = ikke skjult');
    eq(sb.grocyHasNoOwnStock({ id: 9 }),          false, 'manglende felt = har eget lager');
}

// ════════════════════════════════════════════════════════════
console.log('2. lageroversigten viser ikke en skjult vare');
// ════════════════════════════════════════════════════════════
let so;
{
    const el = makeEls();
    so = {
        console, setTimeout, clearTimeout,
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') },
        localStorage: { getItem: () => null, setItem() {} },
        confirm: () => true,
        fetchGrocyStock: async () => [
            // Kål HAR en lagerpost på 0 — sådan ser en forælder ud i /stock.
            { product_id: 1, amount: '47', best_before_date: null },
            { product_id: 2, amount: '0',  best_before_date: null },
            { product_id: 3, amount: '12', best_before_date: null },
            { product_id: 5, amount: '3',  best_before_date: null },
        ],
        fetchGrocyProducts: async () => PRODUCTS,
        fetchGrocyQuantityUnits: async () => [{ id: 1, name: 'Kilo' }],
        fetchGrocyLocations: async () => [{ id: 1, name: 'HQ' }],
        fetchGrocyProductGroups: async () => [{ id: 1, name: '01 Brød' }],
        fetchShoppingLocations: async () => [],
        fetchGrocyQuantityUnitConversions: async () => [],
    };
    so.window = so; so.globalThis = so;
    vm.createContext(so);
    load(so, 'utils.js');
    load(so, 'stock_overview.js');
    so._soShowToast = () => {};
    so._soContainer = el('root');

    await so._soLoadData();

    const names = so._soStockData.map(x => x.name).sort();
    eq(names, ['Brød Rug', 'Spidskål'], 'kål og "Kun skjult" er ude af listen');
    ok(!names.includes('Kål'),        'kål vises ikke');
    ok(names.includes('Spidskål'),    'men barnet gør — det er dér beholdningen er');

    // Uden eget lager alene skjuler IKKE i oversigten. Grocys to flag betyder
    // hver sit, og "Kun uden lager" har ingen lagerpost, så den er bare ikke med.
    ok(!so._soStockData.some(x => x.name === 'Kun uden lager'), 'ingen lagerpost = ingen række (uændret)');

    eq(so._soHiddenCount, 2, 'to varer er skjult (kål + "Kun skjult")');
    ok(!so._soAllProducts.some(p => p.id === 2), '"Tilføj vare" kan ikke ramme en skjult vare');
    ok(so._soAllProducts.some(p => p.id === 6),  'men "Kun uden lager" kan stadig tilføjes');
}

// ════════════════════════════════════════════════════════════
console.log('3. en skjult vare gemmer sig heller ikke i inaktiv-listen');
// ════════════════════════════════════════════════════════════
{
    const el = makeEls();
    const sb = Object.assign({}, so);
    sb.document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') };
    sb.fetchGrocyProducts = async () => [
        P(1, 'Brød Rug'),
        // Skjult OG inaktiv: må ikke dukke op bag "inaktive"-pillen, ellers er
        // "vis aldrig" kun halvt sandt.
        P(2, 'Kål', { hide_on_stock_overview: 1, no_own_stock: 1, active: '0' }),
        P(7, 'Gammel bolle', { active: '0' }),
    ];
    sb.fetchGrocyStock = async () => [{ product_id: 1, amount: '47', best_before_date: null }];
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    load(sb, 'utils.js');
    load(sb, 'stock_overview.js');
    sb._soShowToast = () => {};
    sb._soContainer = el('root');

    await sb._soLoadData();

    const inactive = sb._soInactiveItems.map(x => x.name);
    eq(inactive, ['Gammel bolle'], 'kun den almindelige inaktive vare');
    ok(!inactive.includes('Kål'),  'den skjulte er ude af inaktiv-listen');
}

// ════════════════════════════════════════════════════════════
console.log('4. status-baren siger at noget er skjult');
// ════════════════════════════════════════════════════════════
{
    const el = makeEls();
    so.document.getElementById = el;
    so._soHiddenCount = 2;
    so._soFilteredData = [];
    so._soUpdateStatusBar([], 0);
    const html = el('soStatusBar').innerHTML;
    ok(/2 skjult/.test(html), 'tallet står i baren');
    ok(!/data-filter="hidden"/.test(html), 'men det er ikke en pille man kan klikke');

    so._soHiddenCount = 0;
    so._soUpdateStatusBar([], 0);
    ok(!/skjult/.test(el('soStatusBar').innerHTML), 'ingen skjulte = ingen note');
}

// ════════════════════════════════════════════════════════════
console.log('5. optællingen kan ikke tælle en forælder uden eget lager');
// ════════════════════════════════════════════════════════════
{
    const el = makeEls();
    const ic = {
        console, setTimeout, clearTimeout, Date,
        document: { getElementById: el, querySelector: (sel) => el('d' + sel), querySelectorAll: () => [],
            createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: () => true, alert: () => {},
        fetchGrocyProducts: async () => PRODUCTS,
        fetchGrocyStock: async () => [],
        fetchGrocyQuantityUnitConversions: async () => [],
    };
    ic.window = ic; ic.globalThis = ic;
    vm.createContext(ic);
    load(ic, 'utils.js');
    load(ic, 'inventory_check.js');

    // Den ÆGTE _icLoadData køres. `_ic.allProducts` sættes tidligt — før alt
    // hvad der rører DOM — og funktionens egen try/catch sluger det der måtte
    // vælte i renderingen bagefter. Et spejl af filtret her ville kunne drive
    // fra koden uden at én eneste assert faldt.
    ic._icContainer = { querySelector: (sel) => el('q' + sel), querySelectorAll: () => [] };
    ic._icAlert = () => {};
    ic._ic.locationId = 1;
    ic._ic.physicalUnit = 'frost-1';
    await ic._icStartCheck();

    const kept = ic._ic.allProducts.map(p => p.name).sort();

    eq(kept, ['Brød Rug', 'Hvidkål', 'Spidskål'], 'kun varer man faktisk kan tælle');
    ok(!kept.includes('Kål'),            'forælderen er ude — man tæller børnene');
    ok(!kept.includes('Kun uden lager'), 'no_own_stock alene er nok til at udelade');
    ok(!kept.includes('Kun skjult'),     'og "vis aldrig" gælder også her');
    ok(kept.includes('Spidskål') && kept.includes('Hvidkål'), 'børnene tælles som før');

    // Og varen kan heller ikke hentes frem manuelt ("tilføj uventet vare") —
    // det er den anden vej ind i tællelisten.
    ok(!ic._ic.productsById[2], 'kål kan ikke slås op som et tælleligt produkt');
}

// ════════════════════════════════════════════════════════════
console.log('6. en almindelig vare er upåvirket');
// ════════════════════════════════════════════════════════════
{
    const el = makeEls();
    const sb = Object.assign({}, so);
    sb.document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') };
    // Ingen af produkterne bærer felterne overhovedet — som et ældre Grocy-svar.
    sb.fetchGrocyProducts = async () => [
        { id: 1, name: 'Brød Rug', active: '1', qu_id_stock: 1, location_id: 1, product_group_id: 1, userfields: {} },
        { id: 2, name: 'Ost',      active: '1', qu_id_stock: 1, location_id: 1, product_group_id: 1, userfields: {} },
    ];
    sb.fetchGrocyStock = async () => [
        { product_id: 1, amount: '47', best_before_date: null },
        { product_id: 2, amount: '5',  best_before_date: null },
    ];
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    load(sb, 'utils.js');
    load(sb, 'stock_overview.js');
    sb._soShowToast = () => {};
    sb._soContainer = el('root');

    await sb._soLoadData();
    eq(sb._soStockData.map(x => x.name).sort(), ['Brød Rug', 'Ost'], 'begge varer vises');
    eq(sb._soHiddenCount, 0, 'intet skjult');
}

console.log('\n' + pass + ' PASS · ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
