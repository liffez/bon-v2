// scripts/test-indkob-tilfoej-vare.js
// ============================================================
// "+ Tilføj vare" i indkøbslisten — to fejl fundet i drift 21. september 2026.
//
// REGRESSIONEN er Tørrepapir: varen FINDES i grocy-hq (id 106) men er sat
// `active: 0`, så Grocy afviste den med 400 "Product does not exist or is
// inactive" — en fejl der først kom når man havde trykket Tilføj, og som ikke
// sagde hvad man skulle gøre. 39 af 225 produkter er inaktive.
//
// At SKJULE dem er den forkerte kur: så opretter man en dublet ved siden af
// den der findes. De vises mærket og lægges sidst, og tilføjelsen tager dem i
// brug igen — højlydt, for nogen har truffet den modsatte beslutning.
//
// Den anden fejl er ren CSS og måles i browseren, ikke her: dropdownen er
// position:absolute inde i .ib-panel-inner, som har overflow-y:auto (#257), og
// blev klippet til panelets egen højde. Testen holder fast i at undtagelsen
// kun gælder add-product-panelet — lange Manglende/Udløbende-lister skal
// fortsat scrolle indeni.
//
// Browser-kode kan ikke require'es, så den ÆGTE shared/indkob.js køres i en
// vm-sandkasse og funktionerne kaldes direkte.
//
//   node scripts/test-indkob-tilfoej-vare.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);

const ROD = path.join(__dirname, '..');

/* ── §1 Aktiv-reglen (shared/utils.js) ────────────────────────── */
console.log('\n=== §1 Er varen i brug? ===');
const uCtx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
    document: { addEventListener() {}, getElementById: () => null,
                querySelector: () => null, querySelectorAll: () => [],
                createElement: () => ({ style: {}, classList: { add() {}, remove() {} },
                                        appendChild() {}, addEventListener() {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getSelection: () => ({ rangeCount: 0, isCollapsed: true, toString: () => '' }),
};
uCtx.window = uCtx; vm.createContext(uCtx);
vm.runInContext(fs.readFileSync(path.join(ROD, 'shared', 'utils.js'), 'utf8'), uCtx, { filename: 'utils.js' });
const aktiv = uCtx.grocyProductActive;

ok(aktiv({ active: 1 }) && aktiv({ active: '1' }) && aktiv({ active: true }),
   'active 1/"1"/true tæller som i brug');
ok(!aktiv({ active: 0 }) && !aktiv({ active: '0' }) && !aktiv({ active: false }),
   'active 0/"0"/false tæller som ude af brug');
ok(aktiv({ name: 'uden feltet' }),
   'et produkt UDEN active-felt er i brug — /stock bærer ikke alle felter (#613)');
ok(!aktiv(null), 'intet produkt er ikke i brug');

/* ── §2 Autocomplete (shared/indkob.js) ───────────────────────── */
console.log('\n=== §2 Søgelisten ===');
const k = lavKlient();
k._ibProducts = {
    101: { id: 101, name: 'Tørrepapir - Papirhåndklæder', active: 0, product_group: 'Emballage' },
    102: { id: 102, name: 'Tørrepapir - Rulle', active: 0 },
    103: { id: 103, name: 'Tørret Tomat', active: 1 },
    104: { id: 104, name: 'Tørrede Figner' },          // uden feltet = i brug
};

k._ibAddProductAutocomplete('tørre');
const ac = k.__el('ibAddProdAC');
ok(ac.style.display === 'block', 'listen vises');
const raekker = [...ac.innerHTML.matchAll(/data-pid="(\d+)"/g)].map(m => m[1]);
eq(raekker.length, 4, 'inaktive varer SKJULES ikke — ellers oprettes en dublet');
ok(raekker.slice(0, 2).every(id => id === '103' || id === '104'),
   'de aktive står først');
ok(raekker.slice(2).every(id => id === '101' || id === '102'),
   'de inaktive lægges sidst');
ok(ac.innerHTML.includes('ikke i brug'), 'de inaktive er mærket, så man ser det FØR valget');
eq((ac.innerHTML.match(/ikke i brug/g) || []).length, 2, 'kun de inaktive er mærket');
// Klassen sidder på selve rækken, så den kan aflæses pr. data-pid.
function udeKlasse(html, pid) {
    const m = html.match(new RegExp('class="(ib-add-ac-item[^"]*)"\\s+data-pid="' + pid + '"'));
    return !!m && m[1].includes('ude');
}
ok(!udeKlasse(ac.innerHTML, 103) && !udeKlasse(ac.innerHTML, 104),
   'aktive rækker får ikke ude-klassen');
ok(udeKlasse(ac.innerHTML, 101) && udeKlasse(ac.innerHTML, 102),
   'inaktive rækker får den');

k._ibAddProductAutocomplete('findes-ikke');
eq(k.__el('ibAddProdAC').style.display, 'none', 'ingen træffere → listen skjules');

/* ── §3 Tilføj tager varen i brug igen ────────────────────────── */
async function tilfoej(pid) {
    const c = lavKlient();
    c._ibProducts = {
        101: { id: 101, name: 'Tørrepapir - Papirhåndklæder', active: 0 },
        103: { id: 103, name: 'Tørret Tomat', active: 1 },
    };
    c._ibAddProductAutocomplete('tørre');
    // Vælg gennem den ÆGTE klik-handler, så valget bygges som i browseren.
    c.__valgt = c.__klikItem(pid);
    c.__el('ibAddProdQty').value = '2';
    await c._ibAddProductConfirm();
    return c;
}

(async function main() {
console.log('\n=== §3 Tilføj ===');
const a = await tilfoej('101');
ok(a.__valgt, 'den inaktive vare KAN vælges — den skal ikke være skjult');
ok(a.__putProduct !== null, 'inaktiv vare: den tages i brug igen først');
eq(a.__putProduct && a.__putProduct.body.active, 1, 'der sættes active = 1');
ok(a.__added !== null, 'og varen lægges på listen');
ok(a.__rækkefølge.join(',') === 'put,add',
   'i DEN rækkefølge — Grocy afviser en inaktiv vare med 400');
ok(String(a.__toast).includes('taget i brug igen'),
   'det siges højt — nogen har truffet den modsatte beslutning');

const b = await tilfoej('103');
eq(b.__putProduct, null, 'aktiv vare: ingen unødig skrivning til Grocy');
ok(b.__added !== null && !String(b.__toast).includes('taget i brug'),
   'og kvitteringen påstår ikke noget der ikke skete');

/* En fejlet genaktivering må ikke lægge varen på listen alligevel — så ville
   den blive afvist af Grocy, og kvitteringen ville lyve. */
const c2 = lavKlient();
c2._ibProducts = { 101: { id: 101, name: 'Tørrepapir', active: 0 } };
c2.putGrocyProduct = async () => { throw new Error('Grocy nede'); };
c2._ibAddProductAutocomplete('tørre');
ok(c2.__klikItem('101'), 'den inaktive vare er i listen at vælge');
await c2._ibAddProductConfirm();
eq(c2.__added, null, 'fejler genaktiveringen, tilføjes varen ikke');
ok(String(c2.__toast).toLowerCase().includes('fejl'), 'og fejlen siges');

/* ── §4 CSS: dropdownen klippes ikke, men lange lister scroller ── */
console.log('\n=== §4 Klipningen ===');
const css = fs.readFileSync(path.join(ROD, 'shared', 'indkob.css'), 'utf8');
ok(/\.ib-panel-inner\s*\{[^}]*max-height:\s*44vh[^}]*overflow-y:\s*auto/.test(css),
   'lange Manglende/Udløbende-lister scroller stadig inde i panelet (#257)');
ok(/\.ib-panel\[data-ib-panel="add-product"\]\s+\.ib-panel-inner\s*\{[^}]*overflow:\s*visible/.test(css),
   'men tilføj-panelet klipper ikke sin autocomplete');
ok(/\.ib-add-ac-ude\s*\{/.test(css), 'ude-mærket har styling');

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
})();

/* ── vm-sandkasse med lige nok DOM til panelets felter ─────────── */
function lavKlient() {
    const noder = {};
    function el(id) {
        if (!noder[id]) {
            noder[id] = {
                id, value: '', innerHTML: '', style: {}, dataset: {},
                _lyt: {}, focus() {}, select() {},
                addEventListener(t, fn) { (this._lyt[t] = this._lyt[t] || []).push(fn); },
                setAttribute() {}, getAttribute: () => null,
                _børn: [],
                querySelectorAll(sel) {
                    // Noderne skal være STABILE: _ibAddProductAutocomplete binder
                    // klik-lyttere på dem, og en frisk kopi pr. kald ville betyde
                    // at testen klikker på noget ingen lytter til.
                    if (!String(sel).includes('ib-add-ac-item')) return [];
                    return this._børn;
                },
            };
            let _html = '';
            Object.defineProperty(noder[id], 'innerHTML', {
                get() { return _html; },
                set(v) {
                    _html = String(v);
                    this._børn = [..._html.matchAll(/data-pid="(\d+)"/g)].map(m => ({
                        dataset: { pid: m[1] }, _lyt: {},
                        addEventListener(t, fn) { (this._lyt[t] = this._lyt[t] || []).push(fn); },
                        klik() { (this._lyt.click || []).forEach(fn => fn.call(this)); },
                    }));
                },
            });
        }
        return noder[id];
    }
    const ctx = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, String, Number,
        Array, Object, Date, parseInt, parseFloat, isNaN, RegExp,
        document: { getElementById: el, createElement: () => el('x'),
                    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
        navigator: { clipboard: { writeText: async () => {} } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        grocyProductActive: uCtx.grocyProductActive,
        SupplierOrderLines: require(path.join(ROD, 'shared', 'supplier_order_lines')),
        InvoicePrice: require(path.join(ROD, 'shared', 'invoice_price')),
        __putProduct: null, __added: null, __toast: null, __rækkefølge: [], __manglede: null,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROD, 'shared', 'indkob.js'), 'utf8'), ctx, { filename: 'indkob.js' });

    ctx.putGrocyProduct = async (id, body) => {
        ctx.__putProduct = { id, body }; ctx.__rækkefølge.push('put');
    };
    ctx.addShoppingListProduct = async (id, qty) => {
        ctx.__added = { id, qty }; ctx.__rækkefølge.push('add');
    };
    ctx.fetchShoppingList = async () => [];
    ctx._ibBuildGroups = () => {};
    ctx._ibRender = () => {};
    ctx._ibToast = (t) => { ctx.__toast = t; };
    ctx._ibContainer = null;
    ctx.__el = el;
    // Klik på en række i autocomplete — gennem den ÆGTE lytter.
    ctx.__klikItem = (pid) => {
        const mål = el('ibAddProdAC')._børn.find(r => r.dataset.pid === String(pid));
        if (!mål) { ctx.__manglede = pid; return false; }
        mål.klik();
        return true;
    };
    return ctx;
}
