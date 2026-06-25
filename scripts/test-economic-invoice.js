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

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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
