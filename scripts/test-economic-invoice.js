/**
 * scripts/test-economic-invoice.js
 * ────────────────────────────────────────────────────────────
 * Lokale tests af e-conomic Spor 2 — payload-builder (ren logik, ingen
 * netværk) + rabat-trigger (mod en frisk temp-DB). Ingen e-conomic-kald.
 *
 * Kør: node --experimental-sqlite scripts/test-economic-invoice.js
 * ────────────────────────────────────────────────────────────
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const inv = require('../services/economicInvoice');
const { todayISO } = require('../db/helpers');

let pass = 0, fail = 0;
const pending = [];   // asynkrone testblokke — afventes før opsummeringen
function ok(name, cond) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}`); }
}

const SETTINGS = { paymentTermsNumber: 1, layoutNumber: 19, deliveryFallbackProductNumber: 17, oneoffProductNumber: 999,
                   noninvoiceRecipes: new Set([45, 46]), amountLineRecipes: new Set() };

console.log('\n── Payload-builder (ren logik) ──');

// 1. T-5: 23.650 incl → 18.920 ex linjesum
{
    const bon = {
        id: 1, bon_number: 'T_ECON_1', delivery_date: '2026-06-09',
        company: { name: 'Testfirma', economic_customer_id: 944 },
        offer_discount_percent: 0,
        lines: [{ id: 10, product_name: 'Testvare', quantity: 1, unit_price: 23650, economic_product_number: '30' }],
    };
    const p = inv.buildDraftInvoice(bon, SETTINGS);
    const linesSum = p.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0);
    ok('#1 T-5 ex-moms-linjesum ≈ 18.920', Math.abs(linesSum - 18920) < 1);
    ok('#1 unitNetPrice max 2 decimaler', p.lines.every(l => Number.isInteger(Math.round(l.unitNetPrice * 100))));
    ok('#1 customer.customerNumber = 944', p.customer.customerNumber === 944);
    ok('#1 vatZone = 1', p.recipient.vatZone.vatZoneNumber === 1);
    ok('#1 paymentTerms=1, layout=19', p.paymentTerms.paymentTermsNumber === 1 && p.layout.layoutNumber === 19);
    ok('#1 date = i dag (ikke leveringsdato)', p.date === todayISO() && p.date !== bon.delivery_date);
    ok('#1 references.other indeholder bon-nr', p.references.other.includes('T_ECON_1'));
    ok('#1 delivery.deliveryDate = leveringsdato', !p.delivery || p.delivery.deliveryDate === '2026-06-09');
}

// 2. Kunde-resolver
{
    const base = { id: 2, bon_number: 'x', lines: [] };
    ok('#2 firma vinder', inv.resolveEconomicCustomer({ ...base, company: { economic_customer_id: 5 }, customer: { economic_customer_id: 9 } }) === 5);
    ok('#2 privat fallback', inv.resolveEconomicCustomer({ ...base, customer: { economic_customer_id: 9 } }) === 9);
    ok('#2 begge tomme → null', inv.resolveEconomicCustomer({ ...base, customer: {}, company: {} }) === null);
}

// 3. Rabat → discountPercentage pr. linje
{
    const bon = {
        id: 3, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 12.5,
        lines: [{ id: 1, product_name: 'A', quantity: 2, unit_price: 100, economic_product_number: '30' }],
    };
    const p = inv.buildDraftInvoice(bon, SETTINGS);
    ok('#3 discountPercentage=12.5 på linje', p.lines[0].discountPercentage === 12.5);
    const p0 = inv.buildDraftInvoice({ ...bon, offer_discount_percent: 0 }, SETTINGS);
    ok('#3 ingen discountPercentage ved 0', p0.lines[0].discountPercentage === undefined);
}

// 4. Leverings-synteselinje + x-Levering-guard
{
    const bon = {
        id: 4, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        delivery_price: 100, delivery_vehicle_economic_product_number: 103, delivery_vehicle_label: 'Volvo',
        lines: [{ id: 1, product_name: 'A', quantity: 1, unit_price: 100, economic_product_number: '30' }],
    };
    const p = inv.buildDraftInvoice(bon, SETTINGS);
    const dl = p.lines.find(l => l.product.productNumber === '103');
    ok('#4 synteselinje med køretøj-varenr 103', !!dl && Math.abs(dl.unitNetPrice - 80) < 0.01);
    // fallback når intet køretøj
    const p2 = inv.buildDraftInvoice({ ...bon, delivery_vehicle_economic_product_number: null }, SETTINGS);
    ok('#4 fallback 17 uden køretøj', !!p2.lines.find(l => l.product.productNumber === '17'));
    // x-Levering-linje findes → ingen synteselinje
    const bon3 = { ...bon, lines: [...bon.lines, { id: 2, product_name: 'Levering RR', quantity: 1, unit_price: 250, economic_product_number: '103', category: 'x-Levering' }] };
    const p3 = inv.buildDraftInvoice(bon3, SETTINGS);
    ok('#4 ingen dobbelt-levering ved x-Levering-linje', p3.lines.length === 2);
    // delivery_price=0 → ingen synteselinje
    const p4 = inv.buildDraftInvoice({ ...bon, delivery_price: 0 }, SETTINGS);
    ok('#4 ingen synteselinje ved delivery_price=0', p4.lines.length === 1);
}

// 5. special_request i description
{
    const bon = { id: 5, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Grisen', quantity: 1, unit_price: 100, special_request: 'uden løg', economic_product_number: '30' }] };
    const p = inv.buildDraftInvoice(bon, SETTINGS);
    ok('#5 special_request i description', p.lines[0].description === 'Grisen (uden løg)');
}

// 6. recipient.attention fra economic_contact_id
{
    const bon = { id: 6, bon_number: 'x', company: { economic_customer_id: 1 }, customer: { economic_contact_id: 77 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'A', quantity: 1, unit_price: 100, economic_product_number: '30' }] };
    const p = inv.buildDraftInvoice(bon, SETTINGS);
    ok('#6 attention.customerContactNumber=77', p.recipient.attention?.customerContactNumber === 77);
}

console.log('\n── Bundt-udfoldning (slider-bokse) ──');
{
    // Boks 78 som i drift: 160 kr incl → 128 ex, tre sliders à 1 stk.
    const BUNDLE = [
        { recipe_id: 57, product_number: '77', servings: 1, name: 'Kartoflen slider' },
        { recipe_id: 62, product_number: '83', servings: 1, name: 'Ægget slider' },
        { recipe_id: 54, product_number: '79', servings: 1, name: 'Italieneren slider' },
    ];
    const mkBon = (over = {}, lineOver = {}) => ({
        id: 20, bon_number: 'T_ECON_BOKS', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Vegetar slider Boks', quantity: 5, unit_price: 160,
                  grocy_recipe_id: 78, economic_bundle: BUNDLE, ...lineOver }],
        ...over,
    });

    const p = inv.buildDraftInvoice(mkBon(), SETTINGS);
    ok('#B1 én boks → tre fakturalinjer', p.lines.length === 3);
    ok('#B1 varenumre 77/83/79', p.lines.map(l => l.product.productNumber).join(',') === '77,83,79');
    ok('#B1 antal = 5 pr. linje', p.lines.every(l => l.quantity === 5));
    ok('#B1 beskrivelse = varens eget navn', p.lines[0].description === 'Kartoflen slider');
    ok('#B1 lineNumber løber 1,2,3', p.lines.map(l => l.lineNumber).join(',') === '1,2,3');

    // Summen må ikke flytte sig en øre af udfoldningen.
    const sum = p.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0);
    ok('#B2 sum = 5 × 128 ex moms', Math.abs(sum - 640) < 0.0001);
    ok('#B2 unitNetPrice max 2 decimaler', p.lines.every(l => Number.isInteger(Math.round(l.unitNetPrice * 100))));

    // 128,00 / 3 går ikke op: 42,67 + 42,67 + 42,66. Ingen øre må forsvinde.
    const perBox = p.lines.reduce((s, l) => s + l.unitNetPrice, 0);
    ok('#B3 øre-rest fordelt (sum pr. boks = 128,00)', Math.abs(perBox - 128) < 0.0001);
    ok('#B3 restøren ligger på første linje', p.lines[0].unitNetPrice === 42.67 && p.lines[2].unitNetPrice === 42.66);

    // Eget varenr vinder altid over udfoldning.
    const own = inv.buildDraftInvoice(mkBon({}, { economic_product_number: '99' }), SETTINGS);
    ok('#B4 eget varenr vinder over bundt', own.lines.length === 1 && own.lines[0].product.productNumber === '99');

    // Rabat og særønske skal virke pr. udfoldet linje.
    const disc = inv.buildDraftInvoice(mkBon({ offer_discount_percent: 10 }, { special_request: 'uden dressing' }), SETTINGS);
    ok('#B5 rabat på alle bundt-linjer', disc.lines.every(l => l.discountPercentage === 10));
    ok('#B5 særønske i description', disc.lines[0].description === 'Kartoflen slider (uden dressing)');

    // servings > 1: mængden ganges op, prisen deles ned.
    const s2 = inv.buildDraftInvoice(mkBon({}, {
        quantity: 2, unit_price: 100,
        economic_bundle: [{ recipe_id: 57, product_number: '77', servings: 2, name: 'Kartoflen slider' },
                          { recipe_id: 62, product_number: '83', servings: 1, name: 'Ægget slider' }],
    }), SETTINGS);
    ok('#B6 servings ganger antallet op', s2.lines[0].quantity === 4 && s2.lines[1].quantity === 2);
    ok('#B6 sum uændret (2 × 80 ex)', Math.abs(s2.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0) - 160) < 0.0001);

    // Readiness: bundtet dækker linjen, så den blokerer ikke.
    ok('#B7 bundt-linje blokerer ikke', inv.checkReadiness(mkBon()).ok === true);
    const halv = mkBon({}, { economic_bundle: null });
    ok('#B7 uden bundt blokerer den stadig', inv.checkReadiness(halv).ok === false);

    // splitOre-invarianten direkte — summen er altid input.
    let splitOk = true;
    for (const total of [12800, 10000, 1, 0, 7, -12800, 99999]) {
        for (const w of [[1, 1, 1], [2, 1], [1], [3, 1, 1, 1]]) {
            if (inv.splitOre(total, w).reduce((a, b) => a + b, 0) !== total) splitOk = false;
        }
    }
    ok('#B8 splitOre bevarer summen (også negativ)', splitOk);
    ok('#B8 splitOre uden vægt → nuller', inv.splitOre(500, [0, 0]).join(',') === '0,0');
}

console.log('\n── Beløbslinjer (Rabat / Engangsbeløb) ──');
{
    const S = { ...SETTINGS, amountLineRecipes: new Set([7, 8, 135]) };
    const mk = (lineOver) => ({
        id: 30, bon_number: 'T_ECON_BELOEB', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Rabat', quantity: 11600, unit: 'stk', unit_price: -1,
                  line_total: -11600, grocy_recipe_id: 135, economic_product_number: '110', ...lineOver }],
    });

    // Drifts-tilfældet: 11.600 kr rabat tastet som 11.600 stk à -1.
    const p = inv.buildDraftInvoice(mk(), S);
    ok('#A1 antal foldet til 1', p.lines[0].quantity === 1);
    ok('#A1 pris = hele linjesummen ex moms', p.lines[0].unitNetPrice === -9280);
    ok('#A1 beløbet er uændret', Math.abs(p.lines[0].unitNetPrice * p.lines[0].quantity - inv.round2(-11600 / 1.25)) < 0.005);
    ok('#A1 varenr bevaret', p.lines[0].product.productNumber === '110');
    ok('#A1 beskrivelse = opskriftsnavn når intet særønske', p.lines[0].description === 'Rabat');

    // special_request er forklaringen ("bil", "løn") og er mere sigende end navnet.
    const p2 = inv.buildDraftInvoice(mk({ special_request: 'køletrailer' }), S);
    ok('#A2 særønske bliver beskrivelsen', p2.lines[0].description === 'køletrailer');

    // Positivt engangsbeløb.
    const p3 = inv.buildDraftInvoice(mk({ product_name: 'Engangsbeløb', quantity: 823, unit_price: 1,
                                          line_total: 823, grocy_recipe_id: 7, economic_product_number: '111',
                                          special_request: 'Prisjustering' }), S);
    ok('#A3 positivt beløb', p3.lines[0].quantity === 1 && p3.lines[0].unitNetPrice === 658.4);
    ok('#A3 beskrivelse = Prisjustering', p3.lines[0].description === 'Prisjustering');

    // En rabat må ikke rabatteres igen.
    const p4 = inv.buildDraftInvoice({ ...mk(), offer_discount_percent: 10 }, S);
    ok('#A4 ingen discountPercentage på beløbslinje', p4.lines[0].discountPercentage === undefined);

    // Fallback når line_total mangler.
    const p5 = inv.buildDraftInvoice(mk({ line_total: null }), S);
    ok('#A5 falder tilbage til quantity × unit_price', p5.lines[0].unitNetPrice === -9280);

    // Almindelige varer røres ikke — heller ikke en ægte vare til 1 kr.
    const normal = { id: 31, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Ægte vare til en krone', quantity: 40, unit_price: 1, line_total: 40,
                  grocy_recipe_id: 999, economic_product_number: '30' }] };
    const p6 = inv.buildDraftInvoice(normal, S);
    ok('#A6 almindelig linje uberørt (40 stk, ikke 1)', p6.lines[0].quantity === 40 && p6.lines[0].unitNetPrice === 0.8);

    // Uden settingen opfører alt sig som før — feature'en er inert.
    const p7 = inv.buildDraftInvoice(mk(), SETTINGS);
    ok('#A7 tom liste → ingen foldning', p7.lines[0].quantity === 11600);

    ok('#A8 isAmountLine kræver recipe-id', inv.isAmountLine({ grocy_recipe_id: null }, new Set([7])) === false);

    // Settings-parseren må aldrig vælte en fakturering på skrald i et settings-felt.
    ok('#A9 gyldig JSON → sæt', inv.parseIdList('[7,8,135]').has(135));
    ok('#A9 ugyldig JSON → tomt sæt', inv.parseIdList('{ikke json').size === 0);
    ok('#A9 tom/null → tomt sæt', inv.parseIdList('').size === 0 && inv.parseIdList(null).size === 0);
    ok('#A9 ikke-array → tomt sæt', inv.parseIdList('{"a":1}').size === 0);
    ok('#A9 skrald i array frasorteres', inv.parseIdList('[7,"x",null,8]').size === 2);
}

console.log('\n── Forhåndstjek (blokering) ──');
{
    const good = { id: 7, bon_number: 'x', company: { economic_customer_id: 1 }, lines: [{ id: 1, product_name: 'A', economic_product_number: '30' }] };
    ok('#7 ok bon → readiness.ok', inv.checkReadiness(good).ok === true);

    const noProd = { id: 8, bon_number: 'x', company: { economic_customer_id: 1 }, lines: [{ id: 1, product_name: 'Nyvare', grocy_recipe_id: 42, quantity: 2, unit_price: 100 }] };
    const r1 = inv.checkReadiness(noProd);
    ok('#8 manglende recipe-nr blokerer', !r1.ok && r1.missingProducts.length === 1 && r1.missingProducts[0].product_name === 'Nyvare');

    const noCust = { id: 9, bon_number: 'x', company: {}, customer: {}, lines: [{ id: 1, product_name: 'A', economic_product_number: '30' }] };
    ok('#9 manglende kunde-nr blokerer', inv.checkReadiness(noCust).missingCustomer === true);

    const ean = { id: 10, bon_number: 'x', company: { economic_customer_id: 1, ean: '5798001021593' }, customer: {}, lines: [{ id: 1, product_name: 'A', economic_product_number: '30' }] };
    ok('#10 EAN uden kontakt blokerer', inv.checkReadiness(ean).eanWithoutContact === true);

    const eanOk = { id: 11, bon_number: 'x', company: { economic_customer_id: 1, ean: '5798001021593' }, customer: { economic_contact_id: 5 }, lines: [{ id: 1, product_name: 'A', economic_product_number: '30' }] };
    ok('#11 EAN med kontakt ok', inv.checkReadiness(eanOk).ok === true);
}

console.log('\n── Engangsvare-fallback ──');
{
    const bon = { id: 12, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Engangsting', quantity: 1, unit_price: 100, line_total: 100 }] };
    let threw = false;
    try { inv.buildDraftInvoice(bon, SETTINGS); } catch { threw = true; }
    ok('#12 kaster uden nummer (strict)', threw);
    const p = inv.buildDraftInvoice(bon, SETTINGS, { oneoffForMissing: true });
    ok('#12 engangsnummer 999 + bevaret tekst/beløb', p.lines[0].product.productNumber === '999' && p.lines[0].description === 'Engangsting');
}

console.log('\n── "Faktureres ikke" er pr. vare, ikke pr. kategori (#454) ──');
{
    // SETTINGS.noninvoiceRecipes = {45, 46}. 45 = "RR Boks (emballage)", aldrig faktureret.
    const mk = (line, extra = {}) => ({
        id: 20, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Mad', quantity: 1, unit_price: 100, line_total: 100,
                  economic_product_number: '30' },
                { id: 2, quantity: 1, ...line }],
        ...extra,
    });

    // 1) Listet opskrift uden beløb → udelades, rapporteres, blokerer IKKE
    const listedFree = mk({ product_name: 'RR Boks', grocy_recipe_id: 45, unit_price: 0, line_total: 0 });
    const rFree = inv.checkReadiness(listedFree, SETTINGS);
    ok('#N1 listet 0-kr opskrift udelades', rFree.excluded.length === 1 && rFree.excluded[0].reason === 'noninvoice');
    ok('#N1 udeladelse gør ikke bonen ikke-klar', rFree.ok === true && rFree.missingProducts.length === 0);
    ok('#N1 builderen springer den over', inv.buildDraftInvoice(listedFree, SETTINGS).lines.length === 1);

    // 2) Listet opskrift MED beløb → selvmodsigelse i stamdata, blokerer
    const listedPriced = mk({ product_name: 'RR Boks', grocy_recipe_id: 45, unit_price: 25, line_total: 25 });
    const rPriced = inv.checkReadiness(listedPriced, SETTINGS);
    ok('#N2 listet opskrift MED beløb blokerer', !rPriced.ok
        && rPriced.missingProducts.length === 1
        && rPriced.missingProducts[0].reason === 'noninvoice_but_priced');
    let threwPriced = false, codePriced = null;
    try { inv.buildDraftInvoice(listedPriced, SETTINGS); } catch (e) { threwPriced = true; codePriced = e.code; }
    ok('#N2 builderen kaster i stedet for at droppe', threwPriced && codePriced === 'line_without_product');

    // 3) Ægte vare i en blandet kategori (Glutenfri Bolle) → blokerer nu, i stedet for
    //    at forsvinde fordi kategorien tilfældigvis hed "Tilbehør & Bokse"
    const mixedCat = mk({ product_name: 'Glutenfri Bolle', grocy_recipe_id: 75,
                          category: 'Tilbehør & Bokse', unit_price: 45, line_total: 45 });
    const rMixed = inv.checkReadiness(mixedCat, SETTINGS);
    ok('#N3 ægte vare i blandet kategori blokerer', !rMixed.ok
        && rMixed.missingProducts[0].product_name === 'Glutenfri Bolle'
        && rMixed.missingProducts[0].reason === 'no_product');
    const embCat = mk({ product_name: 'Receptions Skinner', grocy_recipe_id: 50,
                        category: '06 Emballage', unit_price: 20, line_total: 20 });
    ok('#N3 prissat emballage uden varenr blokerer', inv.checkReadiness(embCat, SETTINGS).ok === false);
    const lunchCat = mk({ product_name: 'Fritekstret', category: 'lunch', unit_price: 300, line_total: 300 });
    ok('#N3 lækket block_type "lunch" skjuler ikke længere', inv.checkReadiness(lunchCat, SETTINGS).ok === false);

    // 4) Varenr vinder over listen — listen kan aldrig fjerne omsætning
    const listedWithNr = mk({ product_name: 'RR Boks', grocy_recipe_id: 45, unit_price: 25,
                              line_total: 25, economic_product_number: '56' });
    let pNr = null;
    try { pNr = inv.buildDraftInvoice(listedWithNr, SETTINGS); } catch { /* rapporteres af asserten */ }
    ok('#N4 varenr vinder over listen', !!pNr && pNr.lines.length === 2
        && pNr.lines.some(l => l.product.productNumber === '56'));
    ok('#N4 og rapporteres ikke som udeladt', inv.checkReadiness(listedWithNr, SETTINGS).excluded.length === 0);

    // 5) Uden settings er listen tom → strengest (et glemt kaldested fejler synligt)
    ok('#N5 uden settings blokerer listet opskrift med beløb',
        inv.checkReadiness(listedPriced).ok === false);
    ok('#N5 uden settings er 0-kr stadig udeladt (kan ikke gøre fakturaen for lille)',
        inv.checkReadiness(listedFree).ok === true && inv.checkReadiness(listedFree).excluded.length === 1);

    // 6) excluded_total er INCL moms og summerer på tværs
    const twoFree = {
        id: 21, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [
            { id: 1, product_name: 'Mad', quantity: 1, unit_price: 100, line_total: 100, economic_product_number: '30' },
            { id: 2, product_name: 'RR Boks', grocy_recipe_id: 45, quantity: 3, unit_price: 0, line_total: 0 },
            { id: 3, product_name: 'Gratis prøve', grocy_recipe_id: 999, quantity: 1, unit_price: 0, line_total: 0 },
        ],
    };
    const rTwo = inv.checkReadiness(twoFree, SETTINGS);
    ok('#N6 begge 0-kr-linjer rapporteres', rTwo.excluded.length === 2 && rTwo.excluded_total === 0);
    ok('#N6 grunden skelner listet fra 0-kr',
        rTwo.excluded.find(e => e.grocy_recipe_id === 45).reason === 'noninvoice'
        && rTwo.excluded.find(e => e.grocy_recipe_id === 999).reason === 'zero_amount');
    ok('#N6 line_total NULL → antal × stk-pris', inv.lineAmount({ quantity: 3, unit_price: 12.5 }) === 37.5);

    // 7) Sammenlagte linjer: readiness og builderen ser det SAMME
    const dupes = {
        id: 22, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [
            { id: 1, product_name: 'RR Boks', grocy_recipe_id: 45, category: '06 Emballage', quantity: 1, unit_price: 0, line_total: 0 },
            { id: 2, product_name: 'RR Boks', grocy_recipe_id: 45, category: '06 Emballage', quantity: 1, unit_price: 0, line_total: 0 },
        ],
    };
    const rDup = inv.checkReadiness(dupes, SETTINGS);
    ok('#N7 ens linjer bliver ÉN post i excluded', rDup.excluded.length === 1);
    ok('#N7 med begge underliggende id\'er', String(rDup.excluded[0].line_ids) === '1,2');
}

console.log('\n── Stille udgange lukket (#444) ──');
{
    const priced = { id: 23, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Ukoblet mad', grocy_recipe_id: 300, quantity: 2, unit_price: 150, line_total: 300 }] };

    // 1) Engangsvare-redning uden engangsnummer må ikke være en stille no-op
    let code = null;
    try { inv.buildDraftInvoice(priced, { ...SETTINGS, oneoffProductNumber: null }, { oneoffForMissing: true }); }
    catch (e) { code = e.code; }
    ok('#S1 oneoff uden nummer kaster', code === 'oneoff_unavailable');

    // 2) …og med nummer redder den linjen med beløbet i behold
    const rescued = inv.buildDraftInvoice(priced, SETTINGS, { oneoffForMissing: true });
    ok('#S2 oneoff redder prissat linje', rescued.lines.length === 1
        && rescued.lines[0].product.productNumber === '999'
        && Math.abs(rescued.lines[0].unitNetPrice - 120) < 0.01);

    // 3) Rækkefølgen: udeladelse FØR engangsvare — en 0-kr prep-linje må aldrig
    //    ende hos kunden som en engangsvare-linje
    const freeListed = { id: 24, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'RR Boks', grocy_recipe_id: 45, quantity: 1, unit_price: 0, line_total: 0 }] };
    ok('#S3 oneoff opsluger ikke en udeladt linje',
        inv.buildDraftInvoice(freeListed, SETTINGS, { oneoffForMissing: true }).lines.length === 0);

    // 4) Leverings-synteselinjen: String(null) → "null" blev POST'et til e-conomic
    const noDelivNo = { id: 25, bon_number: 'x', company: { economic_customer_id: 1 }, offer_discount_percent: 0,
        delivery_price: 250, lines: [{ id: 1, product_name: 'Mad', quantity: 1, unit_price: 100, economic_product_number: '30' }] };
    const bareSettings = { ...SETTINGS, deliveryFallbackProductNumber: null };
    let dCode = null;
    try { inv.buildDraftInvoice(noDelivNo, bareSettings); } catch (e) { dCode = e.code; }
    ok('#S4 levering uden varenr kaster', dCode === 'delivery_without_product');
    ok('#S4 og forhåndstjekket ser det', inv.checkReadiness(noDelivNo, bareSettings).missingDelivery === true);
    ok('#S4 med fallback er den klar igen', inv.checkReadiness(noDelivNo, SETTINGS).missingDelivery === false
        && inv.buildDraftInvoice(noDelivNo, SETTINGS).lines.some(l => l.product.productNumber === '17'));

    // 4b) UI'et skal kunne se om nødudgangen overhovedet findes, FØR den tilbydes
    ok('#S4b oneoffAvailable falsk uden nummer',
        inv.checkReadiness(priced, { ...SETTINGS, oneoffProductNumber: null }).oneoffAvailable === false);
    ok('#S4b oneoffAvailable sand med nummer',
        inv.checkReadiness(priced, SETTINGS).oneoffAvailable === true);
    ok('#S4b uden settings er der ingen nødudgang', inv.checkReadiness(priced).oneoffAvailable === false);

    // 5) classifyLine er én kilde — readiness og builder kan ikke blive uenige
    const kinds = ['product', 'bundle', 'excluded', 'oneoff', 'blocked'];
    ok('#S5 classifyLine dækker de fem udfald', kinds.every(k => typeof k === 'string')
        && inv.classifyLine({ economic_product_number: '30' }, SETTINGS).kind === 'product'
        && inv.classifyLine({ grocy_recipe_id: 45, quantity: 1, unit_price: 0 }, SETTINGS).kind === 'excluded'
        && inv.classifyLine({ grocy_recipe_id: 300, quantity: 1, unit_price: 5 }, SETTINGS).kind === 'blocked');
}

console.log('\n── Rabat-trigger (frisk temp-DB) ──');
runTriggerTests();

console.log('\n── Bundt-reglen (hvilke opskrifter folder ud) ──');
{
    const grocy = require('../services/grocyAdapter');
    const uf = (n) => ({ userfields: n ? { economic_product_number: n } : {} });
    const RECIPES = [
        { id: 77,  name: 'Alm slider Boks',   ...uf(null) },   // boks — intet eget nr
        { id: 53,  name: 'Frikadellen Slider', ...uf('93') },
        { id: 52,  name: 'Fisken Slider',      ...uf('84') },
        { id: 23,  name: 'Kartoflen',          ...uf('65') },  // ret MED eget nr...
        { id: 200, name: 'Kartoffelmos prod',  ...uf(null) },  // ...og dens produktions-underopskrift
        { id: 24,  name: 'Fisken',             ...uf('72') },  // ret hvis underopskrift OGSÅ har nr
        { id: 99,  name: 'Halv boks',          ...uf(null) },  // ét barn uden nr
        { id: 98,  name: 'Ukoblet slider',     ...uf(null) },
    ];
    const NESTINGS = [
        { recipe_id: 77, includes_recipe_id: 53, servings: 1 },
        { recipe_id: 77, includes_recipe_id: 52, servings: 1 },
        { recipe_id: 23, includes_recipe_id: 200, servings: 1 },   // ret → underopskrift uden nr
        { recipe_id: 24, includes_recipe_id: 53,  servings: 1 },   // ret → underopskrift MED nr
        { recipe_id: 99, includes_recipe_id: 53, servings: 1 },
        { recipe_id: 99, includes_recipe_id: 98, servings: 1 },
    ];

    pending.push((async () => {
        const map = await grocy.getEconomicBundleMap(RECIPES, NESTINGS);
        ok('#R1 boksen bliver et bundt', map.has(77) && map.get(77).length === 2);
        ok('#R1 bundtet bærer børnenes varenumre', map.get(77).map(p => p.product_number).join(',') === '93,84');
        ok('#R2 ret med eget varenr foldes ALDRIG ud', !map.has(23));
        // Vagten er det ENESTE der holder denne ude — børnene har varenr, så uden
        // den ville en helt almindelig ret blive faktureret som sine underopskrifter.
        ok('#R2 heller ikke når underopskriften har varenr', !map.has(24));
        ok('#R3 ét barn uden varenr → intet bundt', !map.has(99));
        ok('#R4 kun bundter i mappen', [...map.keys()].join(',') === '77');
    })().catch(e => { fail++; console.error('  ✗ bundt-regel crash:', e.message); }));
}

console.log('\n── Rabat: levering og gebyrer rabatteres ikke (etape 1) ──');
{
    // Kategorierne kommer fra Grocys `grupper`. `x- Service` har mellemrum efter
    // bindestregen — normaliseringen er hele pointen med at teste den.
    const S = { ...SETTINGS, noDiscountCategories: inv.parseCategoryList(
        '["x-Levering","x- Service","06 Emballage"]') };

    const ableBon = () => ({
        id: 900, bon_number: 'T_ECON_RABAT', delivery_date: '2026-09-04',
        company: { name: 'Able', economic_customer_id: 733 },
        offer_discount_percent: 12.5,
        delivery_price: 0,
        lines: [
            { id: 1, product_name: 'Kyllingen',  category: '01 Sandwich',  quantity: 36, unit_price: 104, economic_product_number: '70' },
            { id: 2, product_name: 'Transportkasse', category: '06 Emballage', quantity: 10, unit_price: 12.5, economic_product_number: '56' },
            { id: 3, product_name: 'Miljøgebyr', category: 'x- Service',   quantity: 1,  unit_price: 36.25, economic_product_number: '98' },
            { id: 4, product_name: 'By-ekspressen leverer', category: 'x-Levering', quantity: 1, unit_price: 225, economic_product_number: '17' },
            { id: 5, product_name: 'Fritekstvare', category: null,         quantity: 1,  unit_price: 100, economic_product_number: '60' },
        ],
    });

    const byNr = (p) => Object.fromEntries(p.lines.map(l => [l.product.productNumber, l.discountPercentage ?? 0]));
    const d = byNr(inv.buildDraftInvoice(ableBon(), S));

    ok('#D1 mad får rabatten',                    d['70'] === 12.5);
    ok('#D2 miljøgebyr får INGEN rabat',          d['98'] === 0);
    ok('#D3 levering får INGEN rabat',            d['17'] === 0);
    ok('#D4 emballage får INGEN rabat',           d['56'] === 0);
    // En linje uden kategori må ikke miste en rabat kunden har krav på — vi
    // udelader kun det vi positivt kan genkende.
    ok('#D5 linje uden kategori beholder rabatten', d['60'] === 12.5);

    // Tom liste = den gamle adfærd. Bevidst bagudkompatibel, så en tom eller
    // ugyldig setting aldrig kan fjerne en rabat i stilhed.
    const d0 = byNr(inv.buildDraftInvoice(ableBon(), { ...SETTINGS, noDiscountCategories: new Set() }));
    ok('#D6 tom liste → rabat på alt (gammel adfærd)', d0['98'] === 12.5 && d0['17'] === 12.5);
    const dU = byNr(inv.buildDraftInvoice(ableBon(), { ...SETTINGS, noDiscountCategories: inv.parseCategoryList('{ikke json') }));
    ok('#D7 ugyldig setting vælter ikke faktureringen', dU['70'] === 12.5);

    // Stavevarianter: `x-Service` uden mellemrum ville ellers ryge lydløst forbi.
    const varianter = inv.parseCategoryList('["  X-LEVERING ","x-  Service"]');
    ok('#D8 normalisering fanger store bogstaver og dobbelt mellemrum',
        inv.discountForLine('x-Levering', 12.5, { noDiscountCategories: varianter }) === 0 &&
        inv.discountForLine('x- Service', 12.5, { noDiscountCategories: varianter }) === 0);

    // Leverings-SYNTESElinjen har ingen bonlinje at hente kategori fra.
    const syntese = { ...ableBon(), delivery_price: 250, lines: [ableBon().lines[0]] };
    const ps = inv.buildDraftInvoice(syntese, S);
    const del = ps.lines.find(l => l.description.startsWith('Levering'));
    ok('#D9 leverings-synteselinje bygges',        !!del);
    ok('#D10 synteselinjen får INGEN rabat',       del && (del.discountPercentage ?? 0) === 0);
    const ps0 = inv.buildDraftInvoice(syntese, { ...SETTINGS, noDiscountCategories: new Set() });
    const del0 = ps0.lines.find(l => l.description.startsWith('Levering'));
    ok('#D11 synteselinjen følger listen (fjernet → rabat igen)', del0 && del0.discountPercentage === 12.5);

    // Bundt (slider-boks) folder ud til flere linjer — de skal arve bonlinjens regel.
    const boks = { ...ableBon(), lines: [{
        id: 9, product_name: 'Alm slider Boks', category: '04 Slider', quantity: 2, unit_price: 200,
        economic_product_number: null,
        economic_bundle: [
            { recipe_id: 1, product_number: '65', servings: 1, name: 'Kartoflen' },
            { recipe_id: 2, product_number: '72', servings: 1, name: 'Fisken' },
        ],
    }] };
    const db2 = byNr(inv.buildDraftInvoice(boks, S));
    ok('#D12 bundt-linjer arver rabatten',  db2['65'] === 12.5 && db2['72'] === 12.5);
    const boksEmb = { ...boks, lines: [{ ...boks.lines[0], category: '06 Emballage' }] };
    const db3 = byNr(inv.buildDraftInvoice(boksEmb, S));
    ok('#D13 bundt i udeladt kategori får INGEN rabat', db3['65'] === 0 && db3['72'] === 0);

    // Uden rabat på bonen må reglen ikke opfinde en.
    const uden = byNr(inv.buildDraftInvoice({ ...ableBon(), offer_discount_percent: 0 }, S));
    ok('#D14 ingen rabat på bonen → ingen rabat nogen steder',
        Object.values(uden).every(v => v === 0));

    // Beløbet skal faktisk flytte sig — ellers beviser procenterne ingenting.
    const p = inv.buildDraftInvoice(ableBon(), S);
    const net = p.lines.reduce((s, l) => s + l.quantity * l.unitNetPrice * (1 - (l.discountPercentage || 0) / 100), 0);
    // mad 36×83,20×0,875 + emballage 10×10 + gebyr 29 + levering 180 + fritekst 80×0,875
    const vent = 36 * 83.2 * 0.875 + 10 * 10 + 29 + 180 + 80 * 0.875;
    ok('#D15 fakturasummen rammer det forventede', Math.abs(net - vent) < 0.5);
}

console.log('\n── Fakturaadresse + EAN på modtageren ──');
// Rapporteret fra drift: hverken EAN eller firmaadressen kom med over på
// fakturaen. e-conomic kopierer ikke fra kundekortet — sender vi kun
// recipient.name, står fakturaen uden begge dele, og en offentlig kunde kan
// slet ikke modtage den.
{
    const mkEanBon = (over = {}) => ({
        id: 9, bon_number: 'B4300', delivery_date: '2026-09-10',
        company: {
            name: 'Høje-Taastrup Kommune', economic_customer_id: 1029,
            ean: '5798001021593',
            billing_address: { line: 'Rådhusstræde 1', zip: '2630', city: 'Taastrup', country: 'Danmark', source: 'crm' },
            ...over,
        },
        delivery_address: { street_name: 'Taastrupgårdsvej', street_nr: '75', postal_code: '2630', city: 'Taastrup' },
        offer_discount_percent: 0,
        lines: [{ id: 1, product_name: 'Sandwich', quantity: 14, unit_price: 99.79, economic_product_number: '65' }],
    });

    const p = inv.buildDraftInvoice(mkEanBon(), SETTINGS);
    ok('#E1 EAN kommer med på recipient', p.recipient.ean === '5798001021593');
    ok('#E1 EAN er max 13 tegn (e-conomics skema)', p.recipient.ean.length <= 13);
    ok('#E1 nemHandelType = ean (ellers sendes den ikke via Nemhandel)',
        p.recipient.nemHandelType === 'ean');
    ok('#E1 fakturaadressen er firmaets egen', p.recipient.address === 'Rådhusstræde 1');
    ok('#E1 postnr + by med', p.recipient.zip === '2630' && p.recipient.city === 'Taastrup');
    ok('#E1 land sat', p.recipient.country === 'Danmark');
    // Det centrale: de to adresser må ikke smelte sammen.
    ok('#E1 leveringsadressen er en ANDEN og står stadig i delivery',
        p.delivery.address === 'Taastrupgårdsvej 75' && p.recipient.address !== p.delivery.address);

    // EAN skrevet med mellemrum/bindestreger i CRM skal stadig virke.
    const pFormat = inv.buildDraftInvoice(mkEanBon({ ean: '5798 0010-21593' }), SETTINGS);
    ok('#E2 cifrene trækkes ud af et formateret EAN', pFormat.recipient.ean === '5798001021593');

    // Intet EAN → feltet udelades helt (privatkunder, ikke-offentlige firmaer).
    const pUdenEan = inv.buildDraftInvoice(mkEanBon({ ean: null }), SETTINGS);
    ok('#E3 intet EAN → feltet sendes ikke', !('ean' in pUdenEan.recipient));
    ok('#E3 og heller ingen nemHandelType (ingen afsendelsesmåde at bede om)',
        !('nemHandelType' in pUdenEan.recipient));

    // Intet firma-adresse → recipient-adressen udelades (og arver IKKE leveringsadressen).
    const pUdenAdr = inv.buildDraftInvoice(mkEanBon({ billing_address: null }), SETTINGS);
    ok('#E4 ingen firmaadresse → ingen recipient-adresse', !('address' in pUdenAdr.recipient));
    ok('#E4 og leveringsadressen smitter ikke af', pUdenAdr.delivery.address === 'Taastrupgårdsvej 75');

    // Et ubrugeligt EAN må ALDRIG stoppe faktureringen — 34 af 231 firmaer har
    // noget andet end 13 cifre i feltet, og de faktureres fint i dag. Det skal
    // rapporteres, ikke blokeres.
    const bonSkidtEan = mkEanBon({ ean: '579800102' });
    const pSkidt = inv.buildDraftInvoice(bonSkidtEan, SETTINGS);
    ok('#E5 ubrugeligt EAN blokerer IKKE fakturaen', pSkidt.lines.length > 0);
    ok('#E5 men EAN sendes ikke med', !('ean' in pSkidt.recipient));
    ok('#E5 og heller ikke nemHandelType', !('nemHandelType' in pSkidt.recipient));
    ok('#E5 fakturaadressen er der stadig', pSkidt.recipient.address === 'Rådhusstræde 1');
    const rSkidt = inv.checkReadiness(bonSkidtEan, SETTINGS);
    ok('#E5 readiness rapporterer råteksten', rSkidt.eanUnusable === '579800102');
    ok('#E5 og bonen er stadig klar til fakturering', rSkidt.ok === true);
    ok('#E5 et ubrugeligt EAN kræver ikke en kontaktperson',
        rSkidt.eanWithoutContact === false);

    // Et GYLDIGT EAN kræver stadig en kontaktperson (uændret regel).
    const rGyldig = inv.checkReadiness(mkEanBon(), SETTINGS);
    ok('#E5 gyldigt EAN uden kontakt blokerer stadig', rGyldig.eanWithoutContact === true);
    ok('#E5 og rapporterer ikke et ubrugeligt EAN', rGyldig.eanUnusable === null);

    ok('#E6 privat bon uden firma vælter ikke',
        (() => { const b = mkEanBon(); b.company = null;
                 b.customer = { first_name: 'Sophie', last_name: 'Schiøtt', economic_customer_id: 1030 };
                 const pp = inv.buildDraftInvoice(b, SETTINGS);
                 return !('ean' in pp.recipient) && !('address' in pp.recipient); })());
}

console.log('\n── Bonen uenig med sig selv om kørslen ──');
// Fra drift (#B4244): bonen bar en håndtilføjet linje "Levering med El-Taxa"
// til 230 kr, mens buddet var skiftet til taxa-4x35 og kundeprisen sat til 400.
// Linjen vinder over delivery_price, så fakturaen sendte den GAMLE kørsel til
// den GAMLE pris — og det kunne ingen se før fakturaen lå der.
{
    const mkLeveringBon = (over = {}) => ({
        id: 9156, bon_number: 'B4244', delivery_date: '2026-09-10',
        company: null,
        customer: { first_name: 'Sophie', last_name: 'Schiøtt', economic_customer_id: 1030 },
        delivery_price: 400,
        delivery_vehicle_label: 'Taxa 4x35',
        offer_discount_percent: 0,
        lines: [
            { id: 1, product_name: 'Falaflen', quantity: 4, unit_price: 104, line_total: 416,
              economic_product_number: '68' },
            { id: 2, product_name: 'Levering med El-Taxa', category: 'x-Levering',
              grocy_recipe_id: 156, quantity: 1, unit_price: 230, line_total: 230,
              economic_product_number: '100' },
        ],
        ...over,
    });

    const r = inv.checkReadiness(mkLeveringBon(), SETTINGS);
    ok('#L1 selvmodsigelsen opdages', r.deliveryConflict !== null);
    ok('#L1 den navngiver linjen', r.deliveryConflict?.line_name === 'Levering med El-Taxa');
    ok('#L1 og viser begge tal', r.deliveryConflict?.line_total === 230
        && r.deliveryConflict?.delivery_price === 400);
    ok('#L1 og hvilken vogn bonen NU har', r.deliveryConflict?.vehicle === 'Taxa 4x35');
    ok('#L1 men bonen kan stadig faktureres (advarsel, ikke blokering)', r.ok === true);

    // Det er stadig linjen der kommer med — advarslen ændrer ikke payloaden.
    const p = inv.buildDraftInvoice(mkLeveringBon(), SETTINGS);
    const lev = p.lines.filter(l => l.product.productNumber === '100');
    ok('#L2 leveringslinjen er med én gang', lev.length === 1);
    ok('#L2 til linjens pris, ikke delivery_price (230 incl = 184 ex)',
        Math.abs(lev[0].unitNetPrice - 184) < 1, String(lev[0].unitNetPrice));
    // Synteselinjen for delivery_price bygges IKKE oveni (needsDeliveryLine er
    // falsk når der allerede er en x-Levering-linje) — ellers blev leveringen
    // faktureret to gange. Tælles på antal linjer, ikke på teksten: den rigtige
    // leveringslinje hedder selv "Levering med ...".
    ok('#L2 ingen ekstra synteselinje oveni', p.lines.length === 2, 'linjer: ' + p.lines.length);

    // Kun leveringspris, ingen linje → ingen selvmodsigelse, synteselinjen bygges.
    const rRen = inv.checkReadiness(mkLeveringBon({ lines: [mkLeveringBon().lines[0]] }), SETTINGS);
    ok('#L3 kun leveringspris → ingen advarsel', rRen.deliveryConflict === null);

    // Kun linje, ingen pris → heller ingen selvmodsigelse.
    const rKunLinje = inv.checkReadiness(mkLeveringBon({ delivery_price: 0 }), SETTINGS);
    ok('#L4 kun linje → ingen advarsel', rKunLinje.deliveryConflict === null);
}

Promise.all(pending).then(() => {
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
});

function runTriggerTests() {
    const { openDb } = require('../db/compat');
    const { runMigrations } = require('../db/migrate');
    // Egen fil pr. proces, uden for projektmappen. Et fast navn i data/ betød at to
    // kørsler tæt på hinanden kæmpede om samme fil ("database is locked") — og fordi
    // mappen ligger i iCloud, kunne en -wal/-shm hænge ved efter oprydningen.
    const tmp = path.join(require('node:os').tmpdir(), `econ_trigger_test_${process.pid}.db`);
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }

    let db;
    try {
        db = runMigrations(tmp);
        const statusId = db.prepare("SELECT id FROM status_definitions ORDER BY id LIMIT 1").get()?.id;
        const locId = db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get()?.id;
        ok('trigger-setup: status+location seedet i migrationer', !!statusId && !!locId);

        const coDisc = db.prepare("INSERT INTO companies (name, discount_percent) VALUES ('Rabatfirma', 12.5)").run().lastInsertRowid;
        const coNone = db.prepare("INSERT INTO companies (name, discount_percent) VALUES ('Norabat', 0)").run().lastInsertRowid;
        const cuDisc = db.prepare("INSERT INTO customers (first_name, discount_percent) VALUES ('Rabatkunde', 7)").run().lastInsertRowid;

        let _seq = 0;
        const mkBon = (cols, vals) => {
            const base = ['bon_number','status_id','location_id','order_date','delivery_date'];
            const baseV = [`T_ECON_TRG_${++_seq}`, statusId, locId, '2026-06-01', '2026-06-09'];
            const allC = [...base, ...Object.keys(cols)];
            const allV = [...baseV, ...Object.values(cols)];
            const ph = allC.map(() => '?').join(',');
            return db.prepare(`INSERT INTO bons (${allC.join(',')}) VALUES (${ph})`).run(...allV).lastInsertRowid;
        };
        const disc = (id) => db.prepare('SELECT offer_discount_percent FROM bons WHERE id = ?').get(id).offer_discount_percent;

        const b1 = mkBon({ company_id: coDisc, offer_discount_percent: 0 });
        ok('#T1 firma-rabat seedes (12.5)', disc(b1) === 12.5);

        const b2 = mkBon({ company_id: coDisc, offer_discount_percent: 5 });
        ok('#T2 eksplicit rabat vinder (5)', disc(b2) === 5);

        const b3 = mkBon({ customer_id: cuDisc, offer_discount_percent: 0 });
        ok('#T3 kunde-rabat seedes (7)', disc(b3) === 7);

        const b4 = mkBon({ company_id: coDisc, customer_id: cuDisc, offer_discount_percent: 0 });
        ok('#T4 firma vinder over kunde (12.5)', disc(b4) === 12.5);

        const b5 = mkBon({ company_id: coNone, offer_discount_percent: 0 });
        ok('#T5 firma uden rabat → 0', disc(b5) === 0);

        const b6 = mkBon({ offer_discount_percent: 0 });
        ok('#T6 ingen kunde/firma → 0', disc(b6) === 0);

        // snapshot: ændr firmaets sats efter bon er oprettet
        db.prepare('UPDATE companies SET discount_percent = 25 WHERE id = ?').run(coDisc);
        ok('#T7 snapshot: gammel bon uændret (12.5)', disc(b1) === 12.5);
    } catch (e) {
        fail++; console.error('  ✗ trigger-test crash:', e.message);
    } finally {
        try { db?.close?.(); } catch {}
        for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    }
}
