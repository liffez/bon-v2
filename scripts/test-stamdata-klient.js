/**
 * scripts/test-stamdata-klient.js — klientsiden af stamdata-sporet (#666)
 *
 *   1. api.js sender X-Bon-Kilde — OG beholder Content-Type. apiFetch spreder
 *      options OVER sine standard-headers, så en headers-nøgle uden
 *      Content-Type ville sende JSON som tekst, og serveren ville se en tom body.
 *   2. Lageroversigtens historik renderes læsbart (navne, ja/nej, dansk tid).
 *   3. Et fejlet spor siges højt: ✎'s Gem og "↺ Aktivér" giver en advarsel.
 *
 * De RIGTIGE filer køres i en vm-sandkasse.
 * Kør: node scripts/test-stamdata-klient.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label, info) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label + (info !== undefined ? '\n      ' + info : '')); }
}
const læs = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

async function apiDel() {
    console.log('\n── api.js: kilden rejser i en header ──');
    const kald = [];
    const sb = {
        console,
        fetch: async (url, opts) => { kald.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    };
    vm.createContext(sb);
    vm.runInContext(læs('shared/api.js'), sb, { filename: 'api.js' });

    await sb.putGrocyProduct(5, { active: 0 }, 'optaelling');
    let h = kald[0].opts.headers;
    ok(h['X-Bon-Kilde'] === 'optaelling', 'putGrocyProduct sender kilden', JSON.stringify(h));
    ok(h['Content-Type'] === 'application/json', '… og beholder Content-Type', JSON.stringify(h));
    ok(JSON.parse(kald[0].opts.body).active === 0, '… og body er uændret');

    kald.length = 0;
    await sb.putGrocyProductUserfields(5, { HverDag: '' });
    h = kald[0].opts.headers;
    ok(!('X-Bon-Kilde' in h) && h['Content-Type'] === 'application/json', 'uden kilde: ingen header, men stadig JSON', JSON.stringify(h));

    kald.length = 0;
    await sb.setBarcodeStockPrice(11, 22.5, 'lageroversigt');
    await sb.setEstimatePrice(5, 17, true, 'opskrifter');
    await sb.setPreferredBarcode(5, 12, 'indkob');
    ok(kald.map(k => k.opts.headers['X-Bon-Kilde']).join(',') === 'lageroversigt,opskrifter,indkob',
        'de tre pris-kald sender kilden', kald.map(k => k.opts.headers['X-Bon-Kilde']).join(','));
    ok(JSON.parse(kald[1].opts.body).recompute === true, 'setEstimatePrice beholder recompute med kilden på');

    kald.length = 0;
    await sb.fetchGrocyProductHistorik(5, 25);
    ok(kald[0].url === '/api/grocy/products/5/historik?limit=25', 'historik-kaldet rammer ruten', kald[0].url);
}

async function lageroversigtDel() {
    console.log('\n── Lageroversigten: historik og fejlet spor ──');
    const toasts = [];
    const els = {};
    const el = id => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false,
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, addEventListener() {}, remove() {} });
    const sb = {
        console, setTimeout, clearTimeout,
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') },
        localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: () => true,
        isOutsideClick: () => false,
        __svar: { ok: true },
        __kald: [],
        putGrocyProduct: async (id, body, kilde) => { sb.__kald.push({ fn: 'product', id, body, kilde }); return sb.__svar; },
        putGrocyProductUserfields: async (id, body, kilde) => { sb.__kald.push({ fn: 'userfields', id, body, kilde }); return sb.__svar; },
        fetchGrocyProductHistorik: async () => sb.__historik,
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(læs('shared/utils.js'), sb, { filename: 'utils.js' });
    vm.runInContext(læs('shared/stock_overview.js'), sb, { filename: 'stock_overview.js' });
    sb._soShowToast = (msg, type) => toasts.push({ msg, type });

    const html = vm.runInContext(`_soHistorikHtml([
        { field_name: 'location_id', old_value: 'Køl', new_value: 'Frys', created_at: '2026-09-18 08:05:00', user_name: 'Anne', notes: 'fra lageroversigten' },
        { field_name: 'active', old_value: '1', new_value: '0', created_at: '2026-09-17 20:00:00', user_name: null, notes: null },
    ])`, sb);
    ok(/Standardplacering/.test(html) && /Køl → Frys/.test(html), 'feltets danske navn og før → efter', html);
    ok(/10\.05|10:05/.test(html), 'tiden står i dansk tid (UTC 08:05 → 10:05)', html);
    ok(/Aktiv<\/b>: ja → nej/.test(html), 'aktiv vises som ja/nej', html);
    ok(/ukendt bruger/.test(html), 'mangler brugeren, siges det', html);
    ok(/fra lageroversigten/.test(html), 'kilden står med');
    ok(/Ingen ændringer registreret/.test(vm.runInContext('_soHistorikHtml([])', sb)), 'tom historik siger hvorfor');

    // Historik-sektionen er med i ✎ for én vare — men ikke ved flere.
    vm.runInContext(`_soProductsMap[5] = { id: 5, name: 'Kål', active: '1', location_id: 2, userfields: {} };
        _soProductsMap[6] = { id: 6, name: 'Løg', active: '1', location_id: 2, userfields: {} };`, sb);
    ok(/soEditHistorik/.test(vm.runInContext('_soBuildEditForm([5])', sb)), '✎ for én vare har en Historik-sektion');
    ok(!/soEditHistorik/.test(vm.runInContext('_soBuildEditForm([5,6])', sb)), '… men ikke når flere varer rettes samtidig');

    // Lazy indlæsning via den rigtige loader.
    sb.__historik = [{ field_name: 'active', old_value: '1', new_value: '0', created_at: '2026-09-18 08:05:00', user_name: 'Anne' }];
    vm.runInContext('_soEditIds = [5];', sb);
    await vm.runInContext('_soLoadHistorik(5)', sb);
    ok(/ja → nej/.test(el('soEditHistorikBody').innerHTML), 'loaderen henter og tegner historikken', el('soEditHistorikBody').innerHTML);

    // "↺ Aktivér" med et fejlet spor: ændringen er sket, men det skal siges.
    vm.runInContext(`_soInactiveItems = [{ product_id: 5, name: 'Kål', amount: 0 }];
        _soMoveToActive = function(){}; _soApplyFilters = function(){};`, sb);
    sb.__svar = { ok: true, log_error: 'no such table' };
    await vm.runInContext('_soReactivate(5)', sb);
    const t = toasts[toasts.length - 1] || {};
    ok(t.type === 'warn' && /historikken/.test(t.msg), '"↺ Aktivér" advarer når sporet fejlede', JSON.stringify(t));

    sb.__svar = { ok: true, logget: 1 };
    vm.runInContext(`_soInactiveItems = [{ product_id: 5, name: 'Kål', amount: 0 }];`, sb);
    await vm.runInContext('_soReactivate(5)', sb);
    const t2 = toasts[toasts.length - 1] || {};
    ok(t2.type === 'success' && !/historikken/.test(t2.msg), '… og tier når sporet lykkedes', JSON.stringify(t2));
}

async function gemDel() {
    console.log('\n── ✎ Gem: den rigtige gem-sti ──');
    const toasts = [];
    const els = {};
    const el = id => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', checked: false, style: {}, disabled: false,
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, addEventListener() {}, remove() {} });
    const sb = {
        console, setTimeout, clearTimeout,
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_t' + Math.random()), addEventListener() {}, body: el('body') },
        localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: () => true, isOutsideClick: () => false,
        __svar: { ok: true }, __kald: [],
        putGrocyProduct: async (id, body, kilde) => { sb.__kald.push({ fn: 'product', id, body, kilde }); return sb.__svar; },
        putGrocyProductUserfields: async (id, body, kilde) => { sb.__kald.push({ fn: 'userfields', id, body, kilde }); return sb.__svar; },
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(læs('shared/utils.js'), sb, { filename: 'utils.js' });
    vm.runInContext(læs('shared/stock_overview.js'), sb, { filename: 'stock_overview.js' });
    sb._soShowToast = (msg, type) => toasts.push({ msg, type });
    vm.runInContext(`_soContainer = document.body;
        _soProductsMap[5] = { id: 5, name: 'Kål', active: '1', location_id: 2, userfields: { HverDag: '7' } };
        _soApplyFilters = function(){};`, sb);

    async function gem(svar) {
        sb.__svar = svar; sb.__kald.length = 0; toasts.length = 0;
        el('soEdit_active').checked = true;
        el('soEdit_location_id').value = '3';     // Køl → Frys
        el('soEdit_hverdag').value = '14';
        vm.runInContext('_soEditIds = [5]; _soProductsMap[5].location_id = 2; _soProductsMap[5].userfields.HverDag = "7";', sb);
        await vm.runInContext('_soSaveEdit()', sb);
        return toasts[toasts.length - 1] || {};
    }

    let t = await gem({ ok: true, logget: 1 });
    ok(sb.__kald.length === 2 && sb.__kald.every(k => k.kilde === 'lageroversigt'),
        'Gem sender begge skrivninger med kilden "lageroversigt"', JSON.stringify(sb.__kald));
    ok(t.type === 'success' && !/historikken/.test(t.msg), 'et lykket spor giver en almindelig kvittering', JSON.stringify(t));

    t = await gem({ ok: true, log_error: 'no such table' });
    ok(t.type === 'warn' && /historikken/.test(t.msg), 'et fejlet spor giver en advarsel — ændringen er gemt', JSON.stringify(t));
}

(async () => {
    await gemDel();
    await apiDel();
    await lageroversigtDel();
    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
