/**
 * scripts/economic-smoke-draft.js
 * ────────────────────────────────────────────────────────────
 * ENGANGS smoke-test: opret ÉT rigtigt fakturaudkast i e-conomic via den
 * faktiske buildDraftInvoice/createDraftInvoice — for at bekræfte at vores
 * payload-format accepteres af det rigtige API.
 *
 * Opretter KUN et udkast (ikke bogført, ikke sendt). SLETTER IKKE — det gøres
 * separat med scripts/economic-delete-draft.js <nr> når Leif har set det.
 *
 * Kør: node --experimental-sqlite scripts/economic-smoke-draft.js
 * ────────────────────────────────────────────────────────────
 */

require('dotenv').config({ quiet: true });
const inv = require('../services/economicInvoice');
const { todayISO } = require('../db/helpers');

// Tydeligt markeret test-bon. Kunde 944 = Region Hovedstaden (fra referencefaktura).
// Vare 30 = "Vand - postevand i karton". unit_price er INCL moms (→ ex = /1.25).
const bon = {
    id: 'smoke',
    bon_number: 'SMOKE-TEST',
    delivery_date: todayISO(),
    company: { name: 'Region Hovedstaden', economic_customer_id: 944 },
    offer_discount_percent: 0,
    lines: [
        { id: 1, product_name: 'TEST – Bon v2 smoke (må slettes)', quantity: 1, unit_price: 25, economic_product_number: '30' },
    ],
};

(async () => {
    const settings = inv.getEconomicSettings();
    const payload = inv.buildDraftInvoice(bon, settings);
    console.log('── Payload der sendes ──');
    console.log(JSON.stringify(payload, null, 2));
    console.log('\n── Sender POST /invoices/drafts ...');
    try {
        const { draftInvoiceNumber, raw } = await inv.createDraftInvoice(bon);
        console.log(`\n✅ Udkast oprettet i e-conomic.`);
        console.log(`   draftInvoiceNumber: ${draftInvoiceNumber}`);
        console.log(`   Find den i e-conomic under Salg → Fakturaer (kladder).`);
        console.log(`   Subtotal ex moms forventet: 20,00  ·  moms 5,00  ·  total 25,00`);
        console.log(`\n   NÅR du har set den: kør "node --experimental-sqlite scripts/economic-delete-draft.js ${draftInvoiceNumber}" for at slette.`);
    } catch (err) {
        console.error('\n❌ Fejl ved oprettelse:', err.message);
        if (err.readiness) console.error('   readiness:', JSON.stringify(err.readiness));
        if (err.body) console.error('   body:', err.body);
        process.exit(1);
    }
})();
