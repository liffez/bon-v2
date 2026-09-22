// scripts/test-indkob-pris.js
// ============================================================
// Prisen på et leverandør-varenummer, tastet som den står på fakturaen.
//
// BAGGRUNDEN: de 15 Serviwet-koblinger i grocy-hq har alle `last_price` tom.
// Uden en pris kan kostprisen ikke regnes (#558), og varen falder tilbage på
// et overslag — eller på ingenting.
//
// FÆLDEN er enheden. Fakturaen skriver en PAKKEPRIS ("115,00 · Transportkasse,
// 25 stk."), mens Grocys `last_price` er pr. enhed. Tastede man 115 råt, ville
// Bon tro at én transportkasse koster 115 kr — 25 gange for meget. Derfor to
// felter ("115 kr for 25 stk") og en synlig udregning.
//
// Omregningen fra stregkodens enhed til varens LAGER-enhed bor derimod ét
// sted, på serveren (services/supplierPrices.js). Browseren må aldrig få en
// kopi af den: to uenige enhedsregler er præcis dét der kostede faktor 1000
// i #352. Testen holder fast i at klienten kun dividerer.
//
// Browser-kode kan ikke require'es, så den ÆGTE shared/indkob.js køres i en
// vm-sandkasse og funktionerne kaldes direkte.
//
//   node scripts/test-indkob-pris.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);

const ROD = path.join(__dirname, '..');

/* ── Sandkassen ───────────────────────────────────────────────── */
function lavKlient(opts) {
    opts = opts || {};
    const noder = {};
    function lavNode(sel) {
        if (!noder[sel]) {
            noder[sel] = {
                value: '', innerHTML: '', style: {}, dataset: {},
                focus() {}, select() {}, addEventListener() {},
                setAttribute() {}, getAttribute: () => null,
            };
        }
        return noder[sel];
    }
    const ctx = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, String, Number,
        Array, Object, Date, parseInt, parseFloat, isNaN, isFinite, RegExp,
        document: { getElementById: () => lavNode('#' + Math.random()),
                    createElement: () => lavNode('x'),
                    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
        navigator: { clipboard: { writeText: async () => {} } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        SupplierOrderLines: require(path.join(ROD, 'shared', 'supplier_order_lines')),
        grocyProductActive: (p) => !p || p.active === undefined || String(p.active) !== '0',
        __kaldt: [], __toast: [], __prisKald: [],
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROD, 'shared', 'indkob.js'), 'utf8'), ctx, { filename: 'indkob.js' });

    // Panelets felter — slås op på (data-ib, data-product-id) som i browseren.
    ctx._ibContainer = {
        querySelector(sel) {
            const m = String(sel).match(/data-ib="([^"]+)"\]\[data-product-id="([^"]+)"/);
            if (!m) return null;
            return lavNode(m[1] + ':' + m[2]);
        },
        querySelectorAll: () => [],
    };
    ctx.__felt = (navn, pid) => lavNode(navn + ':' + pid);

    // En vare i en Serviwet-gruppe med én kobling.
    const produkt = { id: 106, name: 'Transportkasse', qu_id_stock: 3 };
    const entry = {
        product: produkt,
        needUnit: 'stk',
        barcodes: opts.uKobling ? [] : [{ id: 900, barcode: 'INT-0004', note: 'Transportkasse, 25 stk.', shopping_location_id: 7 }],
        item: { amount: 1 }, allItems: [{ amount: 1 }], openItems: [{ amount: 1 }],
    };
    ctx._ibGroups = { 7: { displayName: 'Serviwet', supplierName: 'Serviwet', integrationType: 'email', items: [entry] } };
    ctx.__entry = entry;
    ctx._ibQUnits = { 3: { id: 3, name: 'stk' } };

    ctx.createProductBarcode = async (body) => {
        ctx.__kaldt.push({ hvad: 'kobl', body });
        if (opts.koblFejler) throw new Error('Grocy nede');
        return opts.udenId ? {} : { created_object_id: 901 };
    };
    ctx.setBarcodeStockPrice = async (id, pris, kilde) => {
        ctx.__prisKald.push({ id, pris, kilde });
        if (opts.prisFejler) throw new Error('Prisen kunne ikke gemmes');
        return { stock_price: pris };
    };
    ctx.fetchSupplierPrice = async (pid) => {
        ctx.__kaldt.push({ hvad: 'hent-pris', pid });
        if (opts.hentFejler) throw new Error('nede');
        return { candidates: [{ id: 900, stock_price: opts.kendtPris === undefined ? 4.6 : opts.kendtPris }] };
    };
    ctx.fetchProductBarcodes = async () => entry.barcodes;
    ctx.updateProductBarcode = async () => {};
    ctx._ibBuildGroups = () => {};
    ctx._ibRender = () => {};
    ctx._ibEnrichSnapshots = () => {};
    ctx._ibToast = (t, err) => { ctx.__toast.push({ t: String(t), err: !!err }); };
    ctx.__tekst = () => ctx.__toast.map(x => x.t).join(' | ');
    return ctx;
}

/* ── §1 Udregningen ───────────────────────────────────────────── */
console.log('\n=== §1 Fakturaens tal → kr pr. lager-enhed ===');
const k1 = lavKlient();
const pris = k1._ibPriceFromInvoice;

eq(pris('115', '25'), 4.6, 'drifts-tilfældet: 115 kr for 25 stk');
eq(pris('115,00', '25'), 4.6, 'dansk komma tælles med — fakturaen skriver 115,00');
eq(pris('115', ''), 115, 'tomt indhold = prisen er allerede pr. enhed');
eq(pris('115', null), 115, 'intet indhold-felt overhovedet: samme');
eq(pris('115', '1'), 115, 'indhold 1 er det samme');
eq(pris('1 250,50', '2'), 625.25, 'mellemrum som tusindtalsskiller tåles');
eq(pris('', '25'), null, 'ingen pris → intet gemmes');
eq(pris('0', '25'), null, 'nul er ikke en pris');
eq(pris('-115', '25'), null, 'en negativ pris ville trække fra');
eq(pris('vrøvl', '25'), null, 'vrøvl gemmes ikke som et tal');
eq(pris('115', '0'), null, 'nul enheder kan ikke divideres med');
eq(pris('115', '-25'), null, 'negativt indhold afvises');
eq(pris('115', 'vrøvl'), null, 'vrøvl i indhold gemmes ikke som 115');
eq(pris('100', '3'), 33.3333, 'afrundes til fire decimaler, ikke flere');
eq(pris('0,50', '1000'), 0.0005, 'gram-varer kan komme under en øre');

/* Klienten må KUN dividere. Stregkodens enhed er serverens sag. */
const src = fs.readFileSync(path.join(ROD, 'shared', 'indkob.js'), 'utf8');
const prisFn = src.slice(src.indexOf('function _ibPriceFromInvoice'),
                        src.indexOf('function _ibNumFromInput'));
ok(!/qu_id|quantity_unit|conversion|resolveToStock/i.test(prisFn),
   'udregningen kender ikke stregkodens enhed — den regel bor på serveren');

/* ── §2 Panelet ───────────────────────────────────────────────── */
console.log('\n=== §2 Prisfeltet i panelet ===');
const k2 = lavKlient();
k2._ibLinkPanelId = 106;
k2._ibLinkEditBcId = null;
const nyHtml = k2._ibRenderLinkPanel(k2.__entry);
ok(nyHtml.includes('data-ib="lp-pris"'), 'ved en NY kobling er prisfeltet der');
ok(nyHtml.includes('data-ib="lp-indhold"'), 'og feltet til pakkens indhold');
ok(nyHtml.includes('Pris hos Serviwet'), 'overskriften navngiver leverandøren');
ok(nyHtml.includes('ex moms'), 'og siger at prisen er ex moms — fakturaen viser begge');
ok(!nyHtml.includes('data-ib="lp-save-pris"'),
   'men INGEN "Gem pris"-knap: der er ikke noget varenummer at gemme den på endnu');
ok(nyHtml.includes('gemmes sammen med varenummeret'),
   'og det siges at prisen følger med koblingen — knappen findes jo ikke');
ok(nyHtml.indexOf('lp-pris') > nyHtml.indexOf('lp-varenr'),
   'prisen står EFTER varenummeret — nummeret er det der kobler');

k2._ibLinkEditBcId = 900;
const retHtml = k2._ibRenderLinkPanel(k2.__entry);
ok(retHtml.includes('data-ib="lp-pris"'), 'ved RET er prisfeltet der også');
ok(retHtml.includes('data-ib="lp-save-pris"'), 'og en "Gem pris"-knap — koblingen findes');
ok(/data-ib="lp-save-pris"[^>]*data-bc-id="900"/.test(retHtml),
   'knappen bærer varenummerets id, ikke varens');
ok(retHtml.indexOf('lp-pris') < retHtml.indexOf('lp-delete-varenr'),
   'prisen står over "Fjern varenummeret" — sletningen er sidste udvej');

k2._ibPriceDraft[106] = { pris: '115', indhold: '25' };
const medTal = k2._ibRenderLinkPanel(k2.__entry);
ok(medTal.includes('4,6 kr'), 'udregningen vises, så man kan se hvad der gemmes');
ok(medTal.includes('pr. stk'), 'og i hvilken enhed — lager-enheden, ikke pakkens');

/* ── §3 Ny kobling: prisen følger med ─────────────────────────── */
console.log('\n=== §3 Prisen på en ny kobling ===');
(async function() {

const a = lavKlient();
a._ibLinkPanelId = 106;
a.__felt('lp-varenr', '106').value = 'SW-2210';
a.__felt('lp-note', '106').value = 'Transportkasse, 25 stk.';
a.__felt('lp-pris', '106').value = '115';
a.__felt('lp-indhold', '106').value = '25';
await a._ibSaveFreeVarenr(106);
eq(a.__prisKald.length, 1, 'prisen skrives');
eq(a.__prisKald[0] && a.__prisKald[0].id, 901, 'på det NYE varenummers id, ikke varens');
eq(a.__prisKald[0] && a.__prisKald[0].pris, 4.6, 'som kr pr. lager-enhed — ikke fakturaens 115');
eq(a.__prisKald[0] && a.__prisKald[0].kilde, 'indkobsliste', 'og kilden er indkøbsLISTEN — ikke indstillingerne (#666)');
ok(a.__tekst().includes('4,6 kr'), 'kvitteringen siger prisen, så man kan se den ramte');

const b = lavKlient();
b._ibLinkPanelId = 106;
b.__felt('lp-varenr', '106').value = 'SW-2210';
b.__felt('lp-pris', '106').value = '';
await b._ibSaveFreeVarenr(106);
eq(b.__prisKald.length, 0, 'ingen pris tastet → intet priskald');
ok(b.__kaldt.some(x => x.hvad === 'kobl'), 'men koblingen laves — prisen er valgfri');
ok(!b.__tekst().includes('kr'), 'og kvitteringen påstår ikke en pris der ikke findes');

/* En fejlet pris må ikke gemme sig bag "Varenr. koblet" (#305/#319). */
const c = lavKlient({ prisFejler: true });
c._ibLinkPanelId = 106;
c.__felt('lp-varenr', '106').value = 'SW-2210';
c.__felt('lp-pris', '106').value = '115';
await c._ibSaveFreeVarenr(106);
ok(c.__kaldt.some(x => x.hvad === 'kobl'), 'koblingen står — den lykkedes');
ok(c.__toast.some(x => x.err), 'men det siges som en FEJL, ikke som en kvittering');
ok(c.__tekst().includes('IKKE gemt'), 'og teksten siger hvad der manglede');
ok(c.__tekst().includes('✎'), 'med vejen tilbage: tast den igen på chippen');
ok(!c.__toast.some(x => !x.err && /koblet til/.test(x.t)),
   'den grønne "koblet"-kvittering står ikke ved siden af fejlen');

/* Grocy uden created_object_id: prisen kan ikke skrives, og det skal ses. */
const d = lavKlient({ udenId: true });
d._ibLinkPanelId = 106;
d.__felt('lp-varenr', '106').value = 'SW-2210';
d.__felt('lp-pris', '106').value = '115';
await d._ibSaveFreeVarenr(106);
eq(d.__prisKald.length, 0, 'uden et id er der intet at skrive prisen på');
ok(d.__toast.some(x => x.err && x.t.includes('IKKE gemt')), 'og det siges');

/* ── §4 Ret prisen på en kobling der findes ───────────────────── */
console.log('\n=== §4 Gem prisen på en eksisterende kobling ===');
const e = lavKlient();
e._ibLinkPanelId = 106;
e._ibLinkEditBcId = 900;
e._ibPriceDraft[106] = { pris: '115', indhold: '25' };
await e._ibSavePrice(106, 900);
eq(e.__prisKald.length, 1, 'prisen skrives');
eq(e.__prisKald[0].id, 900, 'på den kobling man står i');
eq(e.__prisKald[0].pris, 4.6, 'med fakturaens tal delt ud');
eq(e.__prisKald[0].kilde, 'indkobsliste',
   'og kilden følger med — en prisændring skal kunne spores til skærmen (#666)');
eq(e._ibPriceDraft[106], undefined, 'og kladden ryddes, så næste vare starter tomt');
eq(e._ibStockPrice[900], 4.6, 'den kendte pris opdateres uden at skulle hentes igen');
ok(e.__tekst().includes('Pris gemt'), 'kvitteringen siger at det skete');

const f = lavKlient();
f._ibLinkEditBcId = 900;
f._ibPriceDraft[106] = { pris: '', indhold: '25' };
await f._ibSavePrice(106, 900);
eq(f.__prisKald.length, 0, 'tomt felt gemmer ingenting');
ok(String(f.__felt('lp-pris-msg', '106').innerHTML).includes('Skriv prisen'),
   'og siger det i panelet, hvor man står — ikke kun i en toast der forsvinder');

const g = lavKlient({ prisFejler: true });
g._ibLinkEditBcId = 900;
g._ibPriceDraft[106] = { pris: '115', indhold: '25' };
await g._ibSavePrice(106, 900);
ok(String(g.__felt('lp-pris-msg', '106').innerHTML).includes('kunne ikke'),
   'en fejl fra serveren vises i panelet');
ok(g.__toast.some(x => x.err), 'og som fejl-toast');
ok(g._ibPriceDraft[106] !== undefined, 'kladden BEVARES ved fejl — man skal ikke taste igen');

/* ── §5 Forudfyldning: serverens tal, ikke vores udregning ────── */
console.log('\n=== §5 Den kendte pris ===');
const h = lavKlient();
h._ibLinkPanelId = 106;
h._ibLinkEditBcId = 900;
await h._ibLoadStockPrice(106, 900);
eq(h._ibStockPrice[900], 4.6, 'prisen hentes fra serveren');
ok(h.__kaldt.some(x => x.hvad === 'hent-pris'),
   'gennem prisruten — last_price regnes ALDRIG om i browseren');
const hHtml = h._ibRenderLinkPanel(h.__entry);
ok(hHtml.includes('Står nu til'), 'og vises som den nuværende pris');
ok(hHtml.includes('4,6 kr'), 'med tallet');

const i = lavKlient({ kendtPris: null });
i._ibLinkPanelId = 106; i._ibLinkEditBcId = 900;
await i._ibLoadStockPrice(106, 900);
const iHtml = i._ibRenderLinkPanel(i.__entry);
ok(iHtml.includes('ingen pris'), 'ingen pris endnu siges ligeud — ikke som et tomt felt');

const j = lavKlient({ hentFejler: true });
j._ibLinkPanelId = 106; j._ibLinkEditBcId = 900;
await j._ibLoadStockPrice(106, 900);
eq(j._ibStockPrice[900], undefined, 'et fejlet opslag gætter ikke på en pris');
ok(j._ibRenderLinkPanel(j.__entry).includes('data-ib="lp-pris"'),
   'og panelet er stadig brugbart');

/* Svaret må ikke lande i et panel man er gået videre fra. */
const l = lavKlient();
l._ibLinkPanelId = 106; l._ibLinkEditBcId = 900;
let hintOpdateret = 0;
l._ibUpdatePriceHint = () => { hintOpdateret++; };
const vent = l._ibLoadStockPrice(106, 900);
l._ibLinkEditBcId = 999;          // brugeren klikker videre imens
await vent;
eq(hintOpdateret, 0, 'et svar der kommer for sent skriver ikke i et andet panel');

/* ── §6 Kladden ───────────────────────────────────────────────── */
console.log('\n=== §6 Kladden ryddes med de andre felter ===');
const m = lavKlient();
m._ibLinkDraft[106] = 'SW-2210';
m._ibLinkNoteDraft[106] = 'tekst';
m._ibPriceDraft[106] = { pris: '115', indhold: '25' };
m._ibClearLinkDraft(106);
eq(m._ibPriceDraft[106], undefined,
   'en efterladt pris ville dukke op på næste vare man kobler');

/* DOM'en vinder over kladden: et autoudfyldt felt fyrer ikke altid input. */
const n = lavKlient();
n._ibPriceDraft[106] = { pris: '999', indhold: '1' };
n.__felt('lp-pris', '106').value = '115';
n.__felt('lp-indhold', '106').value = '25';
eq(n._ibReadPrice(106), 4.6, 'feltets værdi læses, ikke kun kladden');

/* ── §7 Felterne er koblet til handlerne ──────────────────────── */
/* En test der kalder _ibSavePrice direkte beviser ikke at et klik når frem.
   Her fyres de ÆGTE handlere med et element som browseren ville give dem. */
console.log('\n=== §7 Wiring ===');

function attrap(dataIb, pid, vaerdi, ekstra) {
    var a = { 'data-ib': dataIb, 'data-product-id': String(pid) };
    for (var k in (ekstra || {})) a[k] = ekstra[k];
    var el = {
        value: vaerdi === undefined ? '' : vaerdi,
        getAttribute: (n) => (n in a ? a[n] : null),
        closest: () => null,
    };
    el.closest = (sel) => (String(sel) === '[data-ib]' ? el : null);
    return el;
}

const w = lavKlient();
w._ibHandleInput({ target: attrap('lp-pris', 106, '115') });
w._ibHandleInput({ target: attrap('lp-indhold', 106, '25') });
eq(w._ibPriceDraft[106] && w._ibPriceDraft[106].pris, '115',
   'det man taster i prisfeltet lander i kladden');
eq(w._ibPriceDraft[106] && w._ibPriceDraft[106].indhold, '25',
   'og i indholdsfeltet');
ok(String(w.__felt('lp-pris-ud', '106').innerHTML).includes('4,6'),
   'udregningen skrives mens man taster — ikke først ved gem');

/* Et re-render her ville koste markørens plads midt i et tal. */
let renders = 0;
const w2 = lavKlient();
w2._ibRender = () => { renders++; };
w2._ibHandleInput({ target: attrap('lp-pris', 106, '1') });
eq(renders, 0, 'og uden at bygge felterne om — markøren skal blive hvor den er');

const w3 = lavKlient();
w3._ibLinkEditBcId = 900;
w3._ibPriceDraft[106] = { pris: '115', indhold: '25' };
w3._ibHandleClick({ target: attrap('lp-save-pris', 106, '', { 'data-bc-id': '900' }) });
await new Promise(r => setTimeout(r, 0));
eq(w3.__prisKald.length, 1, '"Gem pris"-knappen er koblet til handleren');
eq(w3.__prisKald[0] && w3.__prisKald[0].id, 900, 'med varenummerets id fra knappen');

const w4 = lavKlient();
w4._ibLinkEditBcId = 900;
w4._ibPriceDraft[106] = { pris: '115', indhold: '25' };
let hindret = false;
w4._ibHandleKeydown({ key: 'Enter', preventDefault: () => { hindret = true; },
                      target: attrap('lp-pris', 106, '115') });
await new Promise(r => setTimeout(r, 0));
ok(hindret, 'Enter i prisfeltet indsender ikke siden');
eq(w4.__prisKald.length, 1, 'men gemmer prisen — som knappen ved siden af');

const w5 = lavKlient();
w5._ibLinkPanelId = 106;
w5.__felt('lp-varenr', '106').value = 'SW-2210';
w5.__felt('lp-pris', '106').value = '115';
w5.__felt('lp-indhold', '106').value = '25';
w5._ibHandleKeydown({ key: 'Enter', preventDefault: () => {},
                      target: attrap('lp-indhold', 106, '25') });
await new Promise(r => setTimeout(r, 0));
ok(w5.__kaldt.some(x => x.hvad === 'kobl'),
   'på en NY kobling gemmer Enter hele koblingen — prisen alene har intet at sidde på');
eq(w5.__prisKald.length, 1, 'og prisen følger med');

const w6 = lavKlient();
w6._ibHandleKeydown({ key: 'a', preventDefault: () => { fail++; },
                      target: attrap('lp-pris', 106, '1') });
ok(true, 'andre taster end Enter går uhindret igennem');

/* ── §8 CSS ───────────────────────────────────────────────────── */
console.log('\n=== §8 Rækken ===');
const css = fs.readFileSync(path.join(ROD, 'shared', 'indkob.css'), 'utf8');
ok(/\.ib-pris-inp\s*\{[^}]*box-sizing:\s*border-box/.test(css),
   'felterne er border-box — ellers skyder padding dem ud over den satte bredde');
ok(/\.ib-pris-row\s*\{[^}]*align-items:\s*center/.test(css),
   '"kr for" står på linje med felterne, så rækken læses som én sætning');
ok(/\.ib-pris-row\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
   'og bryder frem for at skubbe knappen ud af panelet på en smal skærm');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
})();
