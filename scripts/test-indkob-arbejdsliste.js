// scripts/test-indkob-arbejdsliste.js
// ============================================================
// Arbejdslisten "N uden pris" i Indkøb → ⚙ → Produkter: prisen sættes i rækken.
//
// Målt mod grocy-test 22/9: 189 aktive varer, 133 uden pris — 95 uden
// varenummer, 16 med ét varenummer uden pris, 1 med flere uprissatte, 19 med
// flere prissatte men intet foretrukket, 2 med et foretrukket uden pris.
// Lageroversigten (den eneste vej der fandtes) viser kun varer med en
// lagerpost, så mange af dem kunne slet ikke nås.
//
// Testen holder fast i:
//   · hvilken vej en række går (vælg / pris på varenummer / overslag)
//   · at browseren KUN dividerer fakturaens pakkepris — enhedsomregningen bor
//     i services/supplierPrices.js (#352 kostede faktor 1000)
//   · at et tal der ikke kan læses aldrig gemmes som noget andet
//   · at Tab inden for rækken ikke gemmer (så "115" ikke bliver 115 kr/stk
//     før "25" er skrevet), men Tab ud af den gør
//   · at knappens tal ikke tæller inaktive varer med
//
// Browser-kode kan ikke require'es, så den ÆGTE shared/indkob_settings.js
// køres i en vm-sandkasse og funktionerne kaldes direkte.
//
//   node scripts/test-indkob-arbejdsliste.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(a === b, `${m} — fik ${JSON.stringify(a)}`);
const ROD = path.join(__dirname, '..');
const vent = () => new Promise(r => setTimeout(r, 0));

/* ── Oversigtens poster, i serverens egen form ────────────────── */
const OVERSIGT = () => ({
    // intet varenummer → overslag
    150: { price: null, reason: 'missing', reason_text: 'ingen pris', stock_unit: 'Kilo', barcodes: [] },
    // ét varenummer uden pris → prisen skal på varenummeret
    89: { price: null, reason: 'missing', reason_text: 'ingen pris', stock_unit: 'Antal', barcodes: [
        { id: 146, barcode: '60035437', stock_price: null, note: 'Ingen pris på varenummeret',
          text: 'Bagepapir 40x60, 500 ark', is_estimate: false, is_preferred: false, shopping_location_id: 2 },
    ] },
    // flere med pris, intet foretrukket → et valg, ikke en pris
    20: { price: null, reason: 'ambiguous', reason_text: 'flere varenumre', stock_unit: 'Kilo', barcodes: [
        { id: 7, barcode: '34258569', stock_price: 52.92, note: null, text: 'Cherry 250 g', is_estimate: false, is_preferred: false, is_agreement: true, shopping_location_id: 2 },
        { id: 96, barcode: '15561664', stock_price: 44.66, note: null, text: 'Cherry 3kg', is_estimate: false, is_preferred: false, is_agreement: true, shopping_location_id: 2 },
    ] },
    // flere UDEN pris, intet foretrukket → også et valg
    30: { price: null, reason: 'missing', reason_text: 'ingen pris', stock_unit: 'Kilo', barcodes: [
        { id: 1, barcode: 'A', stock_price: null, note: 'Ingen pris på varenummeret', text: null, is_estimate: false, is_preferred: false },
        { id: 2, barcode: 'B', stock_price: null, note: 'Ingen pris på varenummeret', text: null, is_estimate: false, is_preferred: false },
    ] },
    // foretrukket uden pris → prisen på DET nummer, andre som alternativ
    25: { price: null, reason: 'preferred_unpriced', reason_text: '', stock_unit: 'Kilo', barcodes: [
        { id: 40, barcode: '15426444', stock_price: null, note: 'Ingen pris på varenummeret', text: 'Rødkål 10 kg', is_estimate: false, is_preferred: true },
        { id: 41, barcode: '34244715', stock_price: 7.44, note: null, text: 'Rødkål 14 kg', is_estimate: false, is_preferred: false },
    ] },
    // varenummerets enhed kan ikke omregnes → serveren ville afvise; overslag
    170: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Antal', barcodes: [
        { id: 99, barcode: '18426663', stock_price: null, note: 'Varenummerets enhed kan ikke omregnes til lager-enheden',
          text: 'Sodavand 25 cl', is_estimate: false, is_preferred: false },
    ] },
    // laves selv efter en opskrift → kostprisen kommer derfra (#558)
    60: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Kilo', barcodes: [],
          produced_by: { id: 44, name: 'Remoulade Produktion' } },
    // intet varenummer, købes hos en leverandør UDEN varenumre (Emballage, email)
    61: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Antal', barcodes: [] },
    // intet varenummer, købes et sted der IKKE er koblet til en leverandør
    64: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Antal', barcodes: [] },
    // intet varenummer, købes hos Hørkram (api)
    62: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Kilo', barcodes: [] },
    // Hørkram-varenummer: leverandøren har en pris, stregkoden mangler indhold
    63: { price: null, reason: 'missing', reason_text: '', stock_unit: 'Antal', barcodes: [
        { id: 70, barcode: '60035437', stock_price: null, note: 'Ingen pris på varenummeret', text: 'Bagepapir',
          is_estimate: false, is_preferred: false, shopping_location_id: 2, unit: 'Antal', amount: null,
          supplier_unit_price: 346.02 },
    ] },
    // har allerede en pris
    5: { price: 12.5, reason: 'preferred', reason_text: 'foretrukket varenummer', stock_unit: 'Kilo', barcodes: [] },
});

/* ── Sandkassen ───────────────────────────────────────────────── */
function lavKlient(opts) {
    opts = opts || {};
    const celler = {};
    const kald = [];
    const ctx = {
        console, setTimeout, clearTimeout, Promise, JSON, Math, String, Number,
        Array, Object, Date, parseInt, parseFloat, isNaN, isFinite, RegExp,
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                    addEventListener() {},
                    // _isEsc escaper via textContent → innerHTML, som i browseren.
                    createElement: () => { let t = ''; return {
                        style: {}, set textContent(v) { t = String(v); },
                        get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
                    }; } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        InvoicePrice: require(path.join(ROD, 'shared', 'invoice_price')),
        __kald: kald,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROD, 'shared', 'indkob_settings.js'), 'utf8'), ctx,
        { filename: 'indkob_settings.js' });

    ctx._isPriceOverview = OVERSIGT();
    ctx._isGrocyLocs = [
        { grocy_location_id: 2, grocy_location_name: 'Hørkram', linked_supplier_id: 1 },
        { grocy_location_id: 7, grocy_location_name: 'Emballage', linked_supplier_id: 2 },
        { grocy_location_id: 9, grocy_location_name: 'RR Produktion', linked_supplier_id: 3 },
        { grocy_location_id: 11, grocy_location_name: 'Madsynergi', linked_supplier_id: null },
    ];
    ctx._isSupDropdown = [{ id: 1, integration_type: 'api' }, { id: 2, integration_type: 'email' },
                          { id: 3, integration_type: 'intern' }];
    const lok = { 61: 7, 62: 2, 64: 11, 150: 9 };
    ctx._isAllProducts = [150, 89, 20, 30, 25, 170, 60, 61, 62, 63, 64, 5, 999]
        .map(id => ({ id, name: 'Vare ' + id, shopping_location_id: lok[id] || null }));
    ctx._isContainer = {
        querySelector(sel) {
            const m = String(sel).match(/data-work-cell="(\d+)"/);
            if (m) {
                const id = m[1];
                return celler[id] || (celler[id] = { innerHTML: '', closest: () => null });
            }
            return null;
        },
        querySelectorAll: () => [],
    };
    ctx.__celle = (pid) => (celler[pid] || {}).innerHTML || '';

    ctx.setEstimatePrice = async (pid, pris, recompute, kilde) => {
        kald.push({ hvad: 'overslag', pid, pris, kilde });
        if (opts.skrivFejler) throw new Error('Grocy nede');
        return {};
    };
    ctx.setBarcodeStockPrice = async (id, pris, kilde) => {
        kald.push({ hvad: 'varenummer', id, pris, kilde });
        if (opts.skrivFejler) throw new Error('Grocy nede');
        return {};
    };
    ctx.createInternalBarcodePrice = async (pid, locId, pris, kilde) => {
        kald.push({ hvad: 'internt', pid, locId, pris, kilde });
        if (opts.skrivFejler) throw new Error('Grocy nede');
        return {};
    };
    ctx.setBarcodeContent = async (id, amount, kilde) => {
        kald.push({ hvad: 'indhold', id, amount, kilde });
        if (opts.skrivFejler) throw new Error('Grocy nede');
        return opts.indholdSvar || { price: 0.692, reason: 'only', unpriced_reason: null };
    };
    ctx.setPreferredBarcode = async (pid, id, kilde) => {
        kald.push({ hvad: 'foretrukket', pid, id, kilde });
        if (opts.skrivFejler) throw new Error('Grocy nede');
        return {};
    };
    ctx.fetchSupplierPrice = async (pid) => {
        kald.push({ hvad: 'hent', pid });
        if (opts.hentFejler) throw new Error('nede');
        return opts.svar ? opts.svar(pid) : {
            price: 4.6, reason: 'estimate', reason_text: 'manuelt overslag', stock_unit: 'Kilo',
            candidates: [{ id: 158, barcode: 'OVERSLAG-' + pid, stock_price: 4.6, is_estimate: true }],
        };
    };
    return ctx;
}

/* ── §1 Tallet på knappen ─────────────────────────────────────── */
console.log('\n=== §1 Hvem mangler en pris ===');
{
    const k = lavKlient();
    eq(k._isUdenPris({ id: 150 }), true, 'aktiv vare uden pris tælles');
    eq(k._isUdenPris({ id: 5 }), false, 'vare med pris tælles ikke');
    eq(k._isUdenPris({ id: 999 }), false, 'en vare der ikke står i oversigten (inaktiv) mangler ingen pris');
    eq(k._isAllProducts.filter(k._isUdenPris).length, 10, 'knappen tæller kun de aktive uden pris');
    eq(k._isUdenPris({ id: 60 }), false, 'en vare vi selv laver, mangler ingen leverandørpris');
    k._isPriceOverview = null;
    eq(k._isUdenPris({ id: 150 }), false, 'kunne oversigten ikke hentes, påstår vi intet');
}

/* ── §2 Hvilken vej en række går ──────────────────────────────── */
console.log('\n=== §2 Rækkens plan ===');
{
    const k = lavKlient();
    const o = k._isPriceOverview;
    const p150 = k._isWorkPlan(o[150]);
    eq(p150.mode, 'price', 'intet varenummer → prisfelt');
    eq(p150.target.kind, 'estimate', '… og det bliver et overslag');
    ok(/overslag/.test(p150.text), 'årsagen siger at det er et overslag');

    const p89 = k._isWorkPlan(o[89]);
    eq(p89.target.kind, 'barcode', 'ét varenummer uden pris → prisen på VARENUMMERET, ikke et overslag');
    eq(p89.target.id, 146, '… det rigtige varenummer');
    ok(/Bagepapir 40x60/.test(p89.text), 'årsagen navngiver leverandørens betegnelse');
    ok(!/Ingen pris på varenummeret \(/.test(p89.text), 'serverens pris-note står ikke som navn');
    ok(/Hørkram/.test(p89.text), '… og leverandøren');

    const p20 = k._isWorkPlan(o[20]);
    eq(p20.mode, 'choose', 'flere med pris, intet foretrukket → et valg');
    eq(p20.choices.length, 2, '… mellem alle varenumrene');
    eq(k._isWorkPlan(o[30]).mode, 'choose', 'flere UDEN pris, intet foretrukket → også et valg');

    const p25 = k._isWorkPlan(o[25]);
    eq(p25.mode, 'price', 'foretrukket uden pris → prisfelt');
    eq(p25.target.id, 40, '… på det foretrukne nummer');
    ok(p25.choices && p25.choices.length === 2, '… med de andre som alternativ');

    const p170 = k._isWorkPlan(o[170]);
    eq(p170.target.kind, 'estimate', 'enhed der ikke kan omregnes → overslag (serveren ville afvise prisen)');
    ok(/omregnes/.test(p170.text), '… og årsagen siger hvorfor');

    eq(k._isWorkPlan(o[5]).mode, 'done', 'har pris → færdig');
    const prod = (id) => k._isAllProducts.find(p => p.id === id);
    const p60 = k._isWorkPlan(o[60], prod(60));
    eq(p60.mode, 'produced', 'egen produktion → ingen prisfelt');
    ok(/egen produktion/.test(p60.text) && !/laves selv/.test(p60.text), '… og hedder "egen produktion"');
    ok(/Remoulade Produktion/.test(p60.text), '… og siger hvilken opskrift prisen kommer fra');
    const p61 = k._isWorkPlan(o[61], prod(61));
    eq(p61.target.kind, 'internal', 'intet varenummer hos en leverandør uden numre → nyt internt varenummer');
    eq(p61.target.locId, 7, '… hos varens egen leverandør');
    ok(/Emballage/.test(p61.text), '… og det står i årsagen');
    const p64 = k._isWorkPlan(o[64], prod(64));
    eq(p64.target.kind, 'internal', 'indkøbssted uden leverandør → internt varenummer, ikke overslag (#706 §15)');
    eq(p64.target.locId, 11, '… på netop det indkøbssted');
    ok(/Madsynergi/.test(p64.text) && /ikke koblet/.test(p64.text), '… og årsagen siger at stedet ikke er koblet');
    const p62 = k._isWorkPlan(o[62], prod(62));
    eq(p62.target.kind, 'estimate', 'intet varenummer hos Hørkram → IKKE et internt nummer (kan ikke opdateres)');
    ok(/Ny kobling/.test(p62.text), '… årsagen peger på at koble Hørkrams rigtige nummer');
    eq(k._isWorkPlan(o[150], prod(150)).target.kind, 'estimate', 'intern produktion uden opskrift → overslag');
    const p63 = k._isWorkPlan(o[63], prod(63));
    eq(p63.supplierPrice, 346.02, 'Hørkrams stykpris følger med når stregkoden mangler indhold');
    const med = JSON.parse(JSON.stringify(o[63])); med.barcodes[0].amount = 500;
    eq(k._isWorkPlan(med, prod(63)).supplierPrice, null, '… men ikke når indholdet er sat');
    eq(k._isWorkPlan(undefined).mode, 'none', 'ukendt vare → ingen handling');
}

/* ── §3 Rendering ─────────────────────────────────────────────── */
console.log('\n=== §3 Cellen ===');
{
    const k = lavKlient();
    const h150 = k._isWorkCellHtml(150);
    ok(/data-is="work-pris"/.test(h150) && /data-is="work-antal"/.test(h150), 'prisfelt og antal-felt');
    ok(/inputmode="decimal"/.test(h150), 'taltastatur på tablet');
    ok(/>kg</.test(h150), 'antallet er i varens LAGER-enhed');
    ok(/is-work-kind est">overslag/.test(h150), 'mærket "overslag"');
    const h89 = k._isWorkCellHtml(89);
    ok(/på varenummeret/.test(h89), 'mærket "på varenummeret"');
    const h20 = k._isWorkCellHtml(20);
    ok(!/work-pris/.test(h20), 'et valg har intet prisfelt — der mangler ikke en pris');
    eq((h20.match(/data-is="work-pref"/g) || []).length, 2, 'én knap pr. varenummer');
    ok(/type="button"/.test(h20), 'knapperne er type="button" (ingen utilsigtet submit)');
    ok(/52,92/.test(h20) && /44,66/.test(h20), 'knapperne viser serverens pris pr. lager-enhed');
    const h25 = k._isWorkCellHtml(25);
    ok(!/data-id="40"/.test(h25), 'det foretrukne nummer står ikke som alternativ til sig selv');
    ok(/data-id="41"/.test(h25), '… det andet gør');
    ok(/✓ 12,50/.test(k._isWorkCellHtml(5)), 'færdig række viser prisen');

    // Tastet tekst overlever en genrendering
    k._isWork.draft[150] = { pris: '115', antal: '25' };
    const hd = k._isWorkCellHtml(150);
    ok(/value="115"/.test(hd) && /value="25"/.test(hd), 'det tastede står der stadig efter genrendering');
    ok(/= 4,60 kr\/kg/.test(hd), 'udregningen vises mens man taster');
    k._isWork.draft[150] = { pris: '115', antal: 'tolv' };
    ok(/kan ikke læses/.test(k._isWorkCellHtml(150)), 'vrøvl i antal siges med det samme');
}

/* ── §4 Gem ───────────────────────────────────────────────────── */
console.log('\n=== §4 Gem ===');
(async () => {
    {
        const k = lavKlient();
        k._isWork.draft[150] = { pris: '115,00', antal: '25' };
        await k._isWorkSave(150, false);
        const s = k.__kald.find(x => x.hvad === 'overslag');
        ok(!!s, 'intet varenummer → gemt som overslag');
        eq(s && s.pris, 4.6, '115 kr for 25 → 4,6 kr pr. lager-enhed (kun division)');
        eq(s && s.kilde, 'indkob', 'kilden i stamdata-sporet er indkøbsindstillingerne');
        eq(k.__kald.filter(x => x.hvad === 'varenummer').length, 0, '… ikke på et varenummer');
        ok(k.__kald.some(x => x.hvad === 'hent' && x.pid === 150), 'serveren spørges bagefter om hvad der gælder');
        eq(k._isPriceOverview[150].price, 4.6, 'rækken bygges af SERVERENS svar');
        eq(k._isWork.draft[150], undefined, 'det tastede ryddes efter et gem');
        ok(/✓ 4,60/.test(k.__celle(150)), 'cellen viser kvitteringen');
    }
    {
        const k = lavKlient();
        k._isWork.draft[89] = { pris: '350', antal: '1000' };
        await k._isWorkSave(89, false);
        const s = k.__kald.find(x => x.hvad === 'varenummer');
        eq(s && s.id, 146, 'ét varenummer → prisen gemmes PÅ varenummeret');
        eq(s && s.pris, 0.35, '350 kr for 1000 stk → 0,35');
        eq(k.__kald.filter(x => x.hvad === 'overslag').length, 0, '… og der laves intet overslag ved siden af');
    }
    {
        const k = lavKlient();
        k._isWork.draft[150] = { pris: '115', antal: 'tolv' };
        await k._isWorkSave(150, false);
        eq(k.__kald.filter(x => x.hvad !== 'hent').length, 0, '"115 kr for tolv" gemmes IKKE');
        ok(k._isWork.msg[150] && k._isWork.msg[150].err, '… det siges som en fejl');
        eq(k._isWork.draft[150].antal, 'tolv', '… og det tastede bliver stående');
    }
    {
        const k = lavKlient();
        k._isWork.draft[150] = { pris: '', antal: '25' };
        await k._isWorkSave(150, false);
        eq(k.__kald.length, 0, 'intet beløb → intet at gemme (Tab forbi en tom række)');
        eq(k._isWork.msg[150], undefined, '… og ingen fejlbesked — at Tab forbi en række er ikke en fejl');
    }
    {
        const k = lavKlient();
        await k._isWorkSave(20, false);
        eq(k.__kald.length, 0, 'en række der mangler et valg, gemmer ingen pris');
    }
    {
        const k = lavKlient({ skrivFejler: true });
        k._isWork.draft[150] = { pris: '30', antal: '2' };
        await k._isWorkSave(150, false);
        ok(/Ikke gemt: Grocy nede/.test(k._isWork.msg[150].text), 'fejl fra serveren siges i rækken');
        eq(k._isWork.draft[150].pris, '30', '… det tastede tabes ikke');
        eq(k._isPriceOverview[150].price, null, '… og varen står stadig uden pris');
        eq(k._isWork.saving[150], false, '… og kan prøves igen');
    }
    {
        const k = lavKlient({ hentFejler: true });
        k._isWork.draft[150] = { pris: '30', antal: '2' };
        await k._isWorkSave(150, false);
        eq(k._isPriceOverview[150].price, 15, 'prisen ER gemt selvom status ikke kunne hentes igen');
        ok(/status kunne ikke hentes/.test(k._isWork.msg[150].text), '… og det siges');
    }
    {
        // Serveren tog imod, men varen har stadig ingen pris — må ikke ligne succes.
        const k = lavKlient({ svar: () => ({ price: null, reason: 'preferred_unpriced',
            reason_text: 'det foretrukne varenummer har ingen pris', candidates: [] }) });
        k._isWork.draft[89] = { pris: '10' };
        await k._isWorkSave(89, false);
        ok(k._isWork.msg[89] && k._isWork.msg[89].err, 'gemt men stadig uden pris → siges som fejl');
    }
    {
        // Dobbelt-gem (focusout + Enter i samme øjeblik) sender ét kald.
        const k = lavKlient();
        k._isWork.draft[150] = { pris: '30', antal: '2' };
        await Promise.all([k._isWorkSave(150, false), k._isWorkSave(150, true)]);
        eq(k.__kald.filter(x => x.hvad === 'overslag').length, 1, 'to gem på én gang → ét kald');
    }

    /* ── §4b Internt varenummer og stregkodens indhold ────────── */
    console.log('\n=== §4b Nye veje ===');
    {
        const k = lavKlient();
        ok(/nyt varenummer/.test(k._isWorkCellHtml(61)), 'rækken mærkes "nyt varenummer"');
        ok(!/work-pris/.test(k._isWorkCellHtml(60)), 'en vare vi laver selv har intet prisfelt');
        k._isWork.draft[61] = { pris: '115', antal: '25' };
        await k._isWorkSave(61, false);
        const c = k.__kald.find(x => x.hvad === 'internt');
        ok(c && c.pid === 61 && c.locId === 7, 'fakturaprisen oprettes som internt varenummer hos leverandøren');
        eq(c && c.pris, 4.6, '… med prisen pr. lager-enhed (kun division)');
        eq(k.__kald.filter(x => x.hvad === 'overslag').length, 0, '… og intet overslag ved siden af');
    }
    {
        const k = lavKlient();
        const h = k._isWorkCellHtml(63);
        ok(/data-is="work-indhold"/.test(h), 'Hørkram-varenummer uden indhold: felt til indholdet');
        ok(/346,02 kr/.test(h), '… med leverandørens stykpris som oplysning');
        k._isWork.draft[63] = { indhold: '500', pris: '' };
        await k._isWorkSave(63, false);
        const c = k.__kald.find(x => x.hvad === 'indhold');
        ok(c && c.id === 70 && c.amount === 500, 'indholdet sendes til serveren — browseren regner ikke prisen');
        eq(k.__kald.filter(x => x.hvad === 'varenummer').length, 0, '… og der gemmes ingen pris ved siden af');
        ok(k.__kald.some(x => x.hvad === 'hent' && x.pid === 63), 'serveren spørges bagefter');
    }
    {
        const k = lavKlient({ indholdSvar: { price: null, unpriced_reason: 'Stregkoden mangler indhold (mængde og enhed)' } });
        k._isWork.draft[63] = { indhold: '500' };
        await k._isWorkSave(63, false);
        ok(k._isWork.msg[63] && /Indholdet er gemt, men/.test(k._isWork.msg[63].text),
           'gemt indhold uden pris siges — ligner ikke en succes');
    }
    {
        const k = lavKlient();
        k._isWork.draft[63] = { indhold: 'fem' };
        await k._isWorkSave(63, false);
        eq(k.__kald.filter(x => x.hvad === 'indhold').length, 0, 'vrøvl i indholdet sendes ikke');
    }

    /* ── §5 Vælg foretrukket ─────────────────────────────────── */
    console.log('\n=== §5 Vælg varenummer ===');
    {
        const k = lavKlient({ svar: () => ({ price: 44.66, reason: 'preferred', reason_text: 'foretrukket varenummer',
            stock_unit: 'Kilo', candidates: [{ id: 96, stock_price: 44.66, is_preferred: true }] }) });
        await k._isWorkChoose(20, 96);
        const c = k.__kald.find(x => x.hvad === 'foretrukket');
        ok(c && c.pid === 20 && c.id === 96, 'ét klik → varenummeret markeres som foretrukket');
        eq(c && c.kilde, 'indkob', '… med kilde i sporet');
        eq(k._isPriceOverview[20].price, 44.66, 'varen har nu serverens pris');
        ok(/✓ 44,66/.test(k.__celle(20)), 'rækken viser kvitteringen');
    }
    {
        const k = lavKlient({ svar: () => ({ price: null, reason: 'preferred_unpriced', reason_text: '',
            stock_unit: 'Kilo', candidates: [{ id: 1, barcode: 'A', stock_price: null, is_preferred: true },
                                             { id: 2, barcode: 'B', stock_price: null, is_preferred: false }] }) });
        await k._isWorkChoose(30, 1);
        const plan = k._isWorkPlan(k._isPriceOverview[30]);
        eq(plan.mode, 'price', 'valgt nummer uden pris → prisfeltet står klar');
        eq(plan.target.id, 1, '… for netop det nummer');
    }
    {
        const k = lavKlient({ skrivFejler: true });
        await k._isWorkChoose(20, 96);
        ok(/Ikke gemt/.test(k._isWork.msg[20].text), 'fejlet valg siges i rækken');
        eq(k._isPriceOverview[20].reason, 'ambiguous', '… og rækken er uændret');
    }

    /* ── §6 Tab og Enter ─────────────────────────────────────── */
    console.log('\n=== §6 Tastaturet ===');
    {
        const k = lavKlient();
        const row = { contains: (el) => el === antal || el === pris };
        const pris = { dataset: { is: 'work-pris', pid: '150' }, closest: () => row };
        const antal = { dataset: { is: 'work-antal', pid: '150' }, closest: () => row };
        k._isWork.draft[150] = { pris: '115', antal: '' };
        k._isHandleFocusOut({ target: pris, relatedTarget: antal });
        await vent();
        eq(k.__kald.length, 0, 'Tab fra pris til antal i SAMME række gemmer ikke');
        k._isWork.draft[150].antal = '25';
        k._isHandleFocusOut({ target: antal, relatedTarget: { dataset: {} } });
        await vent(); await vent();
        const s = k.__kald.find(x => x.hvad === 'overslag');
        eq(s && s.pris, 4.6, 'Tab ud af rækken gemmer — med begge tal');
    }
    {
        const k = lavKlient();
        k._isWork.draft[150] = { pris: '30' };
        let forhindret = false;
        k._isHandleKeydown({ key: 'Enter', target: { dataset: { is: 'work-antal', pid: '150' } },
                             preventDefault() { forhindret = true; } });
        await vent(); await vent();
        ok(k.__kald.some(x => x.hvad === 'overslag'), 'Enter gemmer');
        ok(forhindret, '… uden at indsende noget andet');
        k.__kald.length = 0;
        k._isWork.draft[150] = { pris: '30' };
        k._isHandleKeydown({ key: 'a', target: { dataset: { is: 'work-pris', pid: '150' } }, preventDefault() {} });
        await vent();
        eq(k.__kald.length, 0, 'andre taster gemmer ikke');
    }

    /* ── §7 Browseren kender ikke enhedsomregningen ──────────── */
    console.log('\n=== §7 Kun division i browseren ===');
    {
        const src = fs.readFileSync(path.join(ROD, 'shared', 'indkob_settings.js'), 'utf8');
        const a = src.indexOf('ARBEJDSLISTEN "N uden pris"');
        const b = src.indexOf('function _isHandleFocusOut');
        const blok = src.slice(a, src.indexOf('\n}\n', b))
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        ok(a > 0 && b > a, 'arbejdslistens kode findes');
        ok(!/qu_id|quantity_unit|conversion|resolveToStock|last_price|amount\s*\*/.test(blok),
           'arbejdslisten regner ikke på enheder — den regel bor i supplierPrices.js');
        ok(/InvoicePrice\.priceFromInvoice/.test(blok), '… den bruger den delte fakturaregel');
        ok(!/function\s+\w*[Pp]riceFromInvoice/.test(src), 'og har ingen egen kopi af den');
    }

    /* ── §8 Serverens oversigt bærer det rækken skal bruge ───── */
    console.log('\n=== §8 priceOverview ===');
    {
        const sp = require(path.join(ROD, 'services', 'supplierPrices'));
        const grocy = {
            getProductBarcodes: async () => [
                { id: 7, product_id: 20, barcode: '34258569', qu_id: 2, amount: 0.25, last_price: 13.23,
                  note: 'Cherry 250 g', shopping_location_id: 2, userfields: { is_preferred: '1' } },
                { id: 8, product_id: 20, barcode: '15561664', qu_id: 2, last_price: 44.66,
                  note: 'Cherry 3kg', shopping_location_id: 2, userfields: {} },
            ],
            getProducts: async () => [{ id: 20, name: 'Cherry', qu_id_stock: 2, qu_id_purchase: 2, active: 1 },
                                      { id: 21, name: 'Gammel', qu_id_stock: 2, active: 0 }],
            getQuantityUnitConversions: async () => [],
            getQuantityUnits: async () => [{ id: 2, name: 'Kilo' }],
        };
        const o = await sp.priceOverview(grocy);
        const bc = o[20].barcodes.find(b => b.id === 7);
        eq(bc.is_preferred, true, 'varenummeret bærer is_preferred');
        eq(bc.text, 'Cherry 250 g', '… leverandørens betegnelse som `text`');
        eq(bc.shopping_location_id, 2, '… og leverandøren');
        eq(o[21], undefined, 'inaktive varer er ikke i oversigten');
        grocy.getRecipesRaw = async () => [{ id: 3, name: 'Tomat A', product_id: 20 }, { id: 9, name: 'Tomat B', product_id: 20 }];
        const o2 = await sp.priceOverview(grocy);
        eq(o2[20].produced_by && o2[20].produced_by.name, 'Tomat A', 'producerende opskrift — laveste id, som kostprisen');
        grocy.getRecipesRaw = async () => { throw new Error('nede'); };
        const o3 = await sp.priceOverview(grocy);
        eq(o3[20].produced_by, null, 'opskrifter nede → oversigten virker stadig, påstår intet');
    }
    {
        const sp = require(path.join(ROD, 'services', 'supplierPrices'));
        const skrevet = [];
        let barcodes = [
            { id: 1, product_id: 20, barcode: 'INT-0007', qu_id: 2, shopping_location_id: 5, userfields: {} },
            { id: 2, product_id: 30, barcode: '1234', qu_id: 2, shopping_location_id: 7, userfields: {} },
        ];
        const grocy = {
            getProductBarcodes: async () => barcodes,
            getProducts: async () => [{ id: 30, name: 'Handsker', qu_id_stock: 3, active: 1 },
                                      { id: 31, name: 'Låg', qu_id_stock: 3, active: 1 },
                                      { id: 32, name: 'Rør', qu_id_stock: 3, active: 1 }],
            getQuantityUnitConversions: async () => [], getQuantityUnits: async () => [{ id: 3, name: 'Antal' }],
            createProductBarcode: async (b) => { await vent(); skrevet.push(b); barcodes = barcodes.concat([{ ...b, id: 100 + skrevet.length, userfields: {} }]); return { created_object_id: 100 + skrevet.length }; },
        };
        const r = await sp.createInternalBarcode(grocy, 31, { shoppingLocationId: 7, stockPrice: 4.6 });
        eq(r.barcode, 'INT-0008', 'næste interne nummer efter det højeste');
        const b = skrevet[0];
        ok(b.qu_id === 3 && b.amount === 1 && b.last_price === 4.6 && b.shopping_location_id === 7,
           'stregkoden oprettes i lager-enheden, indhold 1, prisen = pris pr. lager-enhed, hos leverandøren');
        let fejl = null;
        try { await sp.createInternalBarcode(grocy, 30, { shoppingLocationId: 7, stockPrice: 5 }); } catch (e) { fejl = e; }
        eq(fejl && fejl.status, 409, 'har varen allerede et nummer hos leverandøren → afvist (prisen hører til det)');
        const [x, y] = await Promise.all([
            sp.createInternalBarcode(grocy, 32, { shoppingLocationId: 9, stockPrice: 1 }),
            sp.createInternalBarcode(grocy, 30, { shoppingLocationId: 9, stockPrice: 1 }),
        ]);
        ok(x.barcode !== y.barcode, 'to samtidige får hver sit nummer (' + x.barcode + ', ' + y.barcode + ')');
        let f2 = null;
        try { await sp.createInternalBarcode(grocy, 31, { shoppingLocationId: 7, stockPrice: 0 }); } catch (e) { f2 = e; }
        eq(f2 && f2.status, 400, 'nul er ikke en pris');
    }
    {
        const sp = require(path.join(ROD, 'services', 'supplierPrices'));
        const opd = [];
        const bc = { id: 70, product_id: 40, barcode: '60035437', qu_id: 3, amount: null, last_price: null,
                     shopping_location_id: 2, userfields: {} };
        const grocy = {
            getProductBarcodes: async () => [bc],
            getProducts: async () => [{ id: 40, name: 'Bagepapir', qu_id_stock: 3, active: 1 }],
            getQuantityUnitConversions: async () => [], getQuantityUnits: async () => [{ id: 3, name: 'Antal' }],
            updateProductBarcode: async (id, body) => { opd.push(body); Object.assign(bc, body); },
            updateProductBarcodeUserfields: async () => {},
        };
        const db = { prepare: (sql) => ({ all: () => /FROM suppliers/.test(sql)
            ? [{ id: 1, name: 'Hørkram' }] : [{ grocy_location_id: 2 }] }) };
        const fetchSnapshots = async () => ({ products: [{ varenummer: '60035437', baseUnitCode: 'kt',
            salesUnits: [{ code: 'kt', salesPrice: 346.02, isDefault: true }] }] });
        const r = await sp.setBarcodeContent(db, { grocy, fetchSnapshots }, 70, 500);
        eq(opd[0] && opd[0].amount, 500, 'indholdet skrives på stregkoden');
        eq(bc.last_price, 0.69204, 'og prisen regnes på SERVEREN: 346,02 ÷ 500');
        eq(r.refresh.updated, 1, '… via den samme Hørkram-opdatering som "Opdater priser nu"');
        let f = null;
        try { await sp.setBarcodeContent(db, { grocy, fetchSnapshots }, 70, 0); } catch (e) { f = e; }
        eq(f && f.status, 400, 'nul indhold afvises');
    }

    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
