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

const SETTINGS = { paymentTermsNumber: 1, layoutNumber: 19, deliveryFallbackProductNumber: 17, oneoffProductNumber: 999 };

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

console.log('\n── Forhåndstjek (blokering) ──');
{
    const good = { id: 7, bon_number: 'x', company: { economic_customer_id: 1 }, lines: [{ id: 1, product_name: 'A', economic_product_number: '30' }] };
    ok('#7 ok bon → readiness.ok', inv.checkReadiness(good).ok === true);

    const noProd = { id: 8, bon_number: 'x', company: { economic_customer_id: 1 }, lines: [{ id: 1, product_name: 'Nyvare', grocy_recipe_id: 42 }] };
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
        lines: [{ id: 1, product_name: 'Engangsting', quantity: 1, unit_price: 100 }] };
    let threw = false;
    try { inv.buildDraftInvoice(bon, SETTINGS); } catch { threw = true; }
    ok('#12 kaster uden nummer (strict)', threw);
    const p = inv.buildDraftInvoice(bon, SETTINGS, { oneoffForMissing: true });
    ok('#12 engangsnummer 999 + bevaret tekst/beløb', p.lines[0].product.productNumber === '999' && p.lines[0].description === 'Engangsting');
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

Promise.all(pending).then(() => {
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
});

function runTriggerTests() {
    const { openDb } = require('../db/compat');
    const { runMigrations } = require('../db/migrate');
    const tmp = path.join(__dirname, '../data/_econ_trigger_test.db');
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
