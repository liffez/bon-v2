// scripts/test-last-checked.js
// ============================================================
// #613 — "sidst tjekket" i lageroversigten.
//
// `shared/stock_overview.js` er browser-kode og kan ikke require'es rent, så
// den køres i en vm-sandkasse med stubbet API/DOM, og de rigtige funktioner
// kaldes direkte — de samme som browseren bruger, ikke en kopi.
//
// Dækker:
//   1. Tjek-status (samme regler som optællingen) + formatering
//   2. Gem-stien stempler: ved ændring, ved "Ingen ændring", ved "behold lagerets tal"
//   3. Der sendes KUN LastCheckedAt — aldrig LastCheckedUnit
//   4. Lager-skrivningen kommer FØR stemplet, og et fejlet stempel vælter den ikke
//   5. Filter "ikke tjekket" + sortering "ældst tjekket først"
//   6. Backfill-scriptets rene regler (lokal tid → UTC, hvornår der skrives)
//
// Kør:  npm run test:last-checked
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
    fail++;
    console.log('  ✗ ' + label + '\n      forventet: ' + JSON.stringify(expected) + '\n      fik:       ' + JSON.stringify(actual));
}
function ok(cond, label) { eq(!!cond, true, label); }

// ── Sandkasse ──
const calls = [];
const toasts = [];
const els = {};
function el(id) {
    if (!els[id]) els[id] = { id, value: '', innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {}, addEventListener() {}, scrollIntoView() {} };
    return els[id];
}
const sandbox = {
    console, setTimeout, clearTimeout,
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_tmp' + Math.random()), addEventListener() {}, body: el('body') },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true,   // "OK — mit tal er rigtigt" som default
    esc: (s) => String(s),
    parseServerDate: (s) => new Date(/Z$/.test(s) ? s : s + 'Z'),
    isOutsideClick: () => false,
    // API-stubs — registrerer rækkefølgen
    fetchGrocyStock: async () => sandbox.__stock,
    postGrocyInventory: async (id, amount, bb) => { calls.push(['inventory', id, amount]); },
    putGrocyProductUserfields: async (id, fields) => { calls.push(['userfields', id, fields]); if (sandbox.__stampFails) throw new Error('Grocy PUT fejl 500'); },
    __stock: [], __stampFails: false,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// utils.js FØRST: stock_overview bruger dens Grocy-flag-helpers (#616).
// Den rigtige fil, ikke en stub — ellers kan testen ikke se om de to driver fra hinanden.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8'), sandbox, { filename: 'utils.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'stock_overview.js'), 'utf8'), sandbox, { filename: 'stock_overview.js' });
sandbox._soShowToast = (msg, type) => toasts.push([type, msg]);
sandbox._soCloseExpand = () => {};

(async () => {
const DAY = 86400000;
// Status-funktionerne tager et eksplicit 'nu' (fastlåst); kort-rendering og
// Gem-stien læser det rigtige ur, så varer til dem bygges mod uret.
const now = new Date('2026-09-14T12:00:00Z');
const agoFixed = (d) => new Date(now.getTime() - d * DAY);
const ago = (d) => new Date(Date.now() - d * DAY - 60000);

// ── 1. Status + formatering ──
console.log('1. tjek-status');
eq(sandbox._soCheckStatus(7, null, now).status, 'overdue',  'aldrig tjekket MED interval → forfaldent');
eq(sandbox._soCheckStatus(null, null, now).status, 'never',  'aldrig tjekket UDEN interval → never (ikke rød)');
eq(sandbox._soCheckStatus(7, agoFixed(3), now), { status: 'ok', daysSince: 3 },      '3 af 7 dage → ok');
eq(sandbox._soCheckStatus(7, agoFixed(6), now), { status: 'soon', daysSince: 6 },    '6 af 7 dage (>80 %) → snart');
eq(sandbox._soCheckStatus(7, agoFixed(8), now), { status: 'overdue', daysSince: 8 }, '8 af 7 dage → forfaldent');
eq(sandbox._soCheckStatus(null, agoFixed(30), now).status, 'neutral',                'dato men intet interval → neutral');
eq(sandbox._soFormatSince(agoFixed(0), now), 'i dag',    'i dag');
eq(sandbox._soFormatSince(agoFixed(1), now), 'i går',    'i går');
eq(sandbox._soFormatSince(agoFixed(3), now), '3d siden', '3 dage');
ok(/sep/.test(sandbox._soFormatSince(agoFixed(10), now)), 'over en uge → dato');

// ── 2–4. Gem-stien ──
function item(id, amount, lastChecked, interval) {
    return { product_id: id, name: 'Vare ' + id, amount, amount_opened: 0, qu_name: 'Kilo', best_before_date: null,
        daysUntilExpiry: Infinity, status: 'ok', min_stock_amount: 0, alt_conv: [], location_id: 1, product_group_id: 1,
        last_checked: lastChecked, last_checked_unit: 'køl-2', check_interval: interval, check: null };
}
async function runSave(it, typed, opts) {
    calls.length = 0; toasts.length = 0;
    sandbox.__stampFails = !!(opts && opts.stampFails);
    sandbox.__stock = [{ product_id: it.product_id, amount: (opts && opts.fresh !== undefined) ? opts.fresh : it.amount }];
    sandbox._soStockData = [it]; sandbox._soProductsMap = { [it.product_id]: { id: it.product_id, userfields: { LastCheckedUnit: 'køl-2' } } };
    sandbox._soRecalcCheck(it);
    el('soAdj-' + it.product_id).value = String(typed);
    await sandbox._soAdjustInventory(it.product_id);
}

console.log('2. Gem med ændring');
let it = item(1, 10, ago(20), 7);
await runSave(it, 12);
eq(calls.map(c => c[0]), ['inventory', 'userfields'], 'lager-skrivning FØR stempel');
eq(calls[0].slice(1), [1, 12], 'nyt tal skrevet til Grocy');
eq(Object.keys(calls[1][2]), ['LastCheckedAt'], 'KUN LastCheckedAt sendes — aldrig LastCheckedUnit');
ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(calls[1][2].LastCheckedAt), 'stemplet er ISO UTC med Z');
eq(it.amount, 12, 'lokalt tal opdateret');
eq(it.check.status, 'ok', 'tjek-status er ok efter stempel');
eq(it.last_checked_unit, 'køl-2', 'enheden er urørt lokalt');
eq(sandbox._soProductsMap[1].userfields.LastCheckedUnit, 'køl-2', 'enheden er urørt i produkt-cachen');
ok(Date.now() - it.last_checked.getTime() < 5000, 'last_checked er nu');

console.log('3. Gem uden ændring = også et tjek');
it = item(2, 10, ago(20), 7);
await runSave(it, 10);
eq(calls.map(c => c[0]), ['userfields'], 'ingen lager-skrivning, men et stempel');
ok(toasts.some(t => /tjek registreret/.test(t[1])), 'kvitteringen siger at tjekket er registreret');
eq(it.check.status, 'ok', 'varen er ikke længere forfaldent');

console.log('4. Behold lagerets tal (Grocy flyttede sig imens)');
sandbox.confirm = () => false;   // Annuller = lagerets tal er rigtigt
it = item(3, 10, null, 7);
await runSave(it, 12, { fresh: 9 });
eq(calls.map(c => c[0]), ['userfields'], 'stemplet skrives — varen blev set');
eq(it.amount, 9, 'lagerets tal beholdt');
sandbox.confirm = () => true;

console.log('5. Fejlet stempel vælter ikke lager-skrivningen');
it = item(4, 10, ago(20), 7);
let threw = false;
try { await runSave(it, 15, { stampFails: true }); } catch (e) { threw = true; }
eq(threw, false, 'ingen exception ud af Gem');
eq(calls[0].slice(0, 3), ['inventory', 4, 15], 'tallet er skrevet');
eq(it.amount, 15, 'lokalt tal opdateret trods fejlet stempel');
ok(toasts.some(t => t[0] === 'warn' && /kunne ikke skrives/.test(t[1])), 'fejlen siges højt (warn-toast)');
eq(it.check.status, 'overdue', 'tjek-status er IKKE opdateret når stemplet ikke landede');

// ── 5. Filter + sortering + rendering ──
console.log('6. filter, sortering, kort');
const a = item(10, 5, ago(2), 7);  a.name = 'Æg';
const b = item(11, 5, null, 7);    b.name = 'Brød';
const c = item(12, 5, ago(30), 7); c.name = 'Ost';
const d = item(13, 5, null, null); d.name = 'Salt';   // aldrig tjekket, intet interval
[a, b, c, d].forEach(sandbox._soRecalcCheck);
eq([a, b, c, d].map(sandbox._soIsUnchecked), [false, true, true, true], 'ikke-tjekket: aldrig/forfaldent/aldrig-uden-interval');
sandbox._soStockData = [a, b, c, d];
el('soSearch').value = ''; el('soLocationFilter').value = ''; el('soGroupFilter').value = '';
sandbox._soActiveStatusFilter = 'unchecked';
sandbox._soApplyFilters();
eq(sandbox._soFilteredData.map(x => x.name).sort(), ['Brød', 'Ost', 'Salt'], 'pillen "ikke tjekket" filtrerer');
ok(/3 ikke tjekket/.test(el('soStatusBar').innerHTML), 'pillen tæller 3');
sandbox._soActiveStatusFilter = '';
sandbox._soSortMode = 'checked';
eq(sandbox._soSortItems([a, b, c, d]).map(x => x.name), ['Brød', 'Salt', 'Ost', 'Æg'], 'ældst først: aldrig tjekket øverst (navn som tiebreak), så ældste dato');
sandbox._soSortMode = 'name';
eq(sandbox._soSortItems([a, b, c, d]).map(x => x.name), ['Brød', 'Ost', 'Salt', 'Æg'], 'navn-sortering er uændret');
ok(/so-check-overdue/.test(sandbox._soRenderCheck(c)) && /⏰/.test(sandbox._soRenderCheck(c)), 'forfaldent kort får rødt ⏰-mærke');
ok(/aldrig tjekket/.test(sandbox._soRenderCheck(b)), 'aldrig tjekket vises med ord');
ok(/so-check-ok/.test(sandbox._soRenderCheck(a)) && /2d siden/.test(sandbox._soRenderCheck(a)), 'ok-kort viser "2d siden" gråt');
ok(/køl-2/.test(sandbox._soRenderCheck(a)), 'tooltip nævner enheden fra optællingen');
ok(/so-check/.test(sandbox._soRenderCard(a)), 'mærket sidder på kortet');

// ── 6. Backfill-scriptets rene regler ──
console.log('7. backfill: tidszone + beslutning');
const bf = require('./backfill-last-checked.js');
eq(bf.cphLocalToUtcIso('2026-07-17 16:10:00'), '2026-07-17T14:10:00.000Z', 'sommertid: lokal 16:10 → 14:10Z (drifts-eksemplet)');
eq(bf.cphLocalToUtcIso('2026-01-10 10:00:00'), '2026-01-10T09:00:00.000Z', 'vintertid: −1 time');
eq(bf.cphLocalToUtcIso('2026-03-29 03:30:00'), '2026-03-29T01:30:00.000Z', 'lige efter skift til sommertid');
eq(bf.cphLocalToUtcIso('vrøvl'), null, 'ugyldigt input → null, ikke "Invalid Date"');
eq(bf.decide(null, '2026-09-11T09:37:47.000Z').set, true,  'intet stempel → sæt');
eq(bf.decide(undefined, null).set, false,                    'intet log-spor → sæt ALDRIG (vi opfinder ikke et tjek)');
eq(bf.decide('2026-07-17T14:13:07.144Z', '2026-09-11T09:37:47.000Z').set, true,  'loggen nyere → sæt');
eq(bf.decide('2026-09-12T08:00:00.000Z', '2026-09-11T09:37:47.000Z').set, false, 'stemplet nyere (optælling vandt) → rør ikke');
eq(bf.decide('2026-09-11T09:37:30.000Z', '2026-09-11T09:37:47.000Z').set, false, 'samme minut → rør ikke (tolerance)');
eq(bf.decide('2026-07-17 14:13:07', '2026-09-11T09:37:47.000Z').set, true,  'stempel uden Z tolkes som UTC');
const latest = bf.latestPerProduct([
    { product_id: 1, transaction_type: 'purchase',             row_created_timestamp: '2026-09-02 20:41:00' },
    { product_id: 1, transaction_type: 'inventory-correction', row_created_timestamp: '2026-09-11 11:37:47' },
    { product_id: 2, transaction_type: 'inventory-correction', row_created_timestamp: '2026-08-24 12:41:40' },
]);
eq(latest[1].type, 'inventory-correction', 'seneste spor pr. produkt vinder uanset type');
eq(latest[1].iso, '2026-09-11T09:37:47.000Z', '…og er konverteret til UTC');
eq(Object.keys(latest).length, 2, 'ét spor pr. produkt');

// ── 8. Indlæsning: userfields kommer fra /objects/products, ikke /stock ──
// /stock indlejrer et `product`-objekt UDEN userfields. Første udgave læste
// derfra og viste "aldrig tjekket" på alt — fundet i browseren, ikke i testen.
console.log('8. indlæsning læser userfields fra det fulde produkt');
sandbox.fetchGrocyStock = async () => [{ product_id: 1, amount: '47', best_before_date: '2026-10-01', product: { id: 1, name: 'Brød Rug', qu_id_stock: 1, location_id: 1, product_group_id: 1 /* ingen userfields */ } }];
sandbox.fetchGrocyProducts = async () => [{ id: 1, name: 'Brød Rug', active: '1', qu_id_stock: 1, location_id: 1, product_group_id: 1, userfields: { LastCheckedAt: ago(3).toISOString(), LastCheckedUnit: 'frost-1', HverDag: '7' } }];
sandbox.fetchGrocyQuantityUnits = async () => [{ id: 1, name: 'Kilo' }];
sandbox.fetchGrocyLocations = async () => [{ id: 1, name: 'HQ' }];
sandbox.fetchGrocyProductGroups = async () => [{ id: 1, name: '01 Brød' }];
sandbox.fetchShoppingLocations = async () => [];
sandbox.fetchGrocyQuantityUnitConversions = async () => [];
sandbox._soContainer = el('root');
await sandbox._soLoadData();
const loaded = sandbox._soStockData.find(x => x.product_id === 1);
// `instanceof Date` er falsk på tværs af realms: utils.js kører i vm-konteksten
// og laver dens Date, ikke Nodes. Kryds-realm-sikker form.
ok(loaded && Object.prototype.toString.call(loaded.last_checked) === '[object Date]',
   'last_checked er sat fra /objects/products');
eq(loaded && loaded.last_checked_unit, 'frost-1', 'enheden læses samme sted');
eq(loaded && loaded.check_interval, 7, 'HverDag læses samme sted');
eq(loaded && loaded.check.status, 'ok', 'og status er ok (3 af 7 dage)');
ok(/so-check-ok/.test(el('soContent').innerHTML), 'kortet renderes med grå ✓');

console.log('\n' + pass + ' PASS · ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
