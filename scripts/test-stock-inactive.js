// scripts/test-stock-inactive.js
// ============================================================
// #615 — inaktive varer i lageroversigten + genaktivering fra Bon.
//
// Samme sandkasse-mønster som test-last-checked.js: den rigtige
// shared/stock_overview.js køres i vm med stubbet API/DOM.
//
// Dækker:
//   1. Indlæsning skiller aktive og inaktive — også når en inaktiv vare
//      stadig har en lagerpost (den må ikke stå i den aktive liste)
//   2. Pillen "N inaktive" tæller, og filteret viser kun inaktive
//   3. "↺ Aktivér" kalder API med KUN {active:1}, flytter varen, lager urørt
//   4. ✎-modalens Aktiv-felt flytter begge veje
//   5. Inaktivt kort: badge, ingen justeringspanel, aktivér-knap
//
// Kør:  npm run test:stock-inactive
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) { pass++; return; } fail++; console.log('  ✗ ' + label + '\n      forventet: ' + JSON.stringify(b) + '\n      fik:       ' + JSON.stringify(a)); }
function ok(c, label) { eq(!!c, true, label); }

const calls = [], toasts = [], els = {};
function el(id) {
    if (!els[id]) els[id] = { id, value: '', innerHTML: '', textContent: '', style: {}, disabled: false,
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {}, addEventListener() {}, scrollIntoView() {} };
    return els[id];
}
const sandbox = {
    console, setTimeout, clearTimeout,
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true, esc: (s) => String(s),
    parseServerDate: (s) => new Date(/Z$/.test(s) ? s : s + 'Z'), isOutsideClick: () => false,
    fetchGrocyStock: async () => sandbox.__stock,
    fetchGrocyProducts: async () => sandbox.__products,
    fetchGrocyQuantityUnits: async () => [{ id: 1, name: 'Kilo' }],
    fetchGrocyLocations: async () => [{ id: 1, name: 'HQ' }],
    fetchGrocyProductGroups: async () => [{ id: 1, name: '01 Brød' }, { id: 2, name: '02 Pålæg' }],
    fetchShoppingLocations: async () => [], fetchGrocyQuantityUnitConversions: async () => [],
    putGrocyProduct: async (id, body) => { calls.push(['product', id, body]); if (sandbox.__putFails) throw new Error('Grocy PUT fejl 500'); },
    putGrocyProductUserfields: async (id, f) => { calls.push(['userfields', id, f]); },
    postGrocyInventory: async (id, a) => { calls.push(['inventory', id, a]); },
    __stock: [], __products: [], __putFails: false,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'stock_overview.js'), 'utf8'), sandbox, { filename: 'stock_overview.js' });
sandbox._soShowToast = (m, t) => toasts.push([t, m]);
sandbox._soContainer = el('root');
sandbox._soContainer.querySelector = () => el('_saveBtn');

const P = (id, name, active, extra) => Object.assign({ id, name, active, qu_id_stock: 1, location_id: 1, product_group_id: 1, userfields: { HverDag: '7' } }, extra || {});

(async () => {
    // ── 1. Indlæsning ──
    console.log('1. indlæsning skiller aktive og inaktive');
    sandbox.__products = [
        P(1, 'Brød Rug', '1'),
        P(2, 'Gammel bolle', '0'),                 // inaktiv, uden lager
        P(3, 'Udgået pålæg', '0', { product_group_id: 2 }),   // inaktiv, MED lagerpost
        P(4, 'Ost', 1),
    ];
    sandbox.__stock = [
        { product_id: 1, amount: '47', best_before_date: '2026-10-01', product: { id: 1, name: 'Brød Rug' } },
        { product_id: 3, amount: '2.5', best_before_date: null, product: { id: 3, name: 'Udgået pålæg' } },
    ];
    el('soSearch').value = ''; el('soLocationFilter').value = ''; el('soGroupFilter').value = '';
    await sandbox._soLoadData();
    eq(sandbox._soStockData.map(i => i.name), ['Brød Rug'], 'aktiv liste: kun aktive med lagerpost');
    eq(sandbox._soInactiveItems.map(i => i.name), ['Gammel bolle', 'Udgået pålæg'], 'inaktiv liste: begge inaktive, sorteret');
    eq(sandbox._soInactiveItems[1].amount, 2.5, 'inaktiv vare med lagerpost bærer sin beholdning');
    ok(sandbox._soInactiveItems.every(i => i.inactive === true), 'inactive-flag sat');
    ok(sandbox._soProductsMap[2] && sandbox._soProductsMap[3], '_soProductsMap rummer inaktive (✎-modalen kan åbne dem)');
    eq(sandbox._soAllProducts.map(p => p.id), [1, 4], '_soAllProducts ("Tilføj vare") er stadig kun aktive');
    ok(/2 inaktive/.test(el('soStatusBar').innerHTML), 'pillen tæller 2 inaktive');
    ok(/1 varer/.test(el('soStatusBar').innerHTML), 'total-pillen tæller kun aktive');

    // ── 2. Filter ──
    console.log('2. filter "inaktive"');
    sandbox._soActiveStatusFilter = 'inactive';
    sandbox._soApplyFilters();
    eq(sandbox._soFilteredData.map(i => i.name), ['Gammel bolle', 'Udgået pålæg'], 'filteret viser kun inaktive');
    ok(/so-pill-inactive active/.test(el('soStatusBar').innerHTML), 'pillen er markeret aktiv');
    ok(/1 varer/.test(el('soStatusBar').innerHTML), 'total-pillen tæller stadig de aktive, ikke det viste udsnit');
    el('soGroupFilter').value = '2';
    sandbox._soApplyFilters();
    eq(sandbox._soFilteredData.map(i => i.name), ['Udgået pålæg'], 'gruppe-filter virker oven på inaktiv-filteret');
    ok(/1 inaktive/.test(el('soStatusBar').innerHTML), 'inaktiv-pillen følger gruppe-filteret');
    el('soGroupFilter').value = '';
    sandbox._soActiveStatusFilter = '';
    sandbox._soApplyFilters();
    eq(sandbox._soFilteredData.map(i => i.name), ['Brød Rug'], 'uden filter: kun aktive');

    // ── 3. Rendering ──
    console.log('3. inaktivt kort');
    const html = sandbox._soRenderCard(sandbox._soInactiveItems[0]);
    ok(/so-inactive/.test(html) && /inaktiv<\/span>/.test(html), 'kortet er markeret inaktivt med badge');
    ok(/so-reactivate-btn/.test(html), 'aktivér-knap findes');
    ok(!/so-expand-panel/.test(html) && !/so-adj-input/.test(html), 'ingen justeringspanel — intet lager at rette');
    ok(!/so-check/.test(html), 'intet tjek-mærke på en inaktiv vare');
    ok(/so-card-side-row/.test(html), 'knapperne ligger i én række (kortet vokser ikke)');

    // ── 4. Genaktivér ──
    console.log('4. ↺ Aktivér');
    calls.length = 0; toasts.length = 0;
    await sandbox._soReactivate(2);
    eq(calls, [['product', 2, { active: 1 }]], 'API kaldes med KUN {active:1} — lageret røres ikke');
    eq(sandbox._soInactiveItems.map(i => i.name), ['Udgået pålæg'], 'varen er væk fra inaktiv-listen');
    const back = sandbox._soStockData.find(i => i.product_id === 2);
    ok(back && back.inactive === false, 'varen står i den aktive liste, inactive=false');
    eq(back.isNew, true, 'uden lagerpost → "ingen beholdning endnu"');
    eq(sandbox._soProductsMap[2].active, '1', 'produkt-cachen opdateret');
    ok(toasts.some(t => t[0] === 'success' && /aktiv igen/.test(t[1])), 'kvittering');

    console.log('5. fejlet API = ingen flytning');
    calls.length = 0; toasts.length = 0; sandbox.__putFails = true;
    await sandbox._soReactivate(3);
    eq(sandbox._soInactiveItems.map(i => i.name), ['Udgået pålæg'], 'varen bliver stående som inaktiv når Grocy afviser');
    ok(toasts.some(t => t[0] === 'error'), 'fejlen siges højt');
    sandbox.__putFails = false;

    console.log('6. brugeren siger nej');
    calls.length = 0; sandbox.confirm = () => false;
    await sandbox._soReactivate(3);
    eq(calls, [], 'intet API-kald uden bekræftelse');
    sandbox.confirm = () => true;

    // ── 5. ✎-modalen begge veje ──
    console.log('7. ✎-modalens Aktiv-felt');
    sandbox._soApplyEditToLocal(3, { active: 1 }, {});
    ok(sandbox._soStockData.some(i => i.product_id === 3 && !i.inactive), 'Aktiv → flytter til aktiv liste');
    eq(sandbox._soStockData.find(i => i.product_id === 3).amount, 2.5, '…med sin beholdning bevaret');
    eq(sandbox._soInactiveItems.length, 0, 'inaktiv-listen er tom');
    sandbox._soApplyEditToLocal(1, { active: 0 }, {});
    ok(!sandbox._soStockData.some(i => i.product_id === 1), 'Inaktiv → væk fra aktiv liste');
    ok(sandbox._soInactiveItems.some(i => i.product_id === 1 && i.inactive), '…og over i inaktiv-listen (ikke bare fjernet)');
    eq(sandbox._soProductsMap[1].active, '0', 'produkt-cachen følger med');
    sandbox._soApplyEditToLocal(1, { active: '1' }, {});
    ok(sandbox._soStockData.some(i => i.product_id === 1), 'streng-"1" fra bulk-select virker også');

    console.log('\n' + pass + ' PASS · ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
