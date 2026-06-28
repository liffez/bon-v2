/**
 * scripts/economic-delete-draft.js
 * ────────────────────────────────────────────────────────────
 * Slet et fakturaudkast i e-conomic (til oprydning efter smoke-test).
 * Kør: node --experimental-sqlite scripts/economic-delete-draft.js <draftInvoiceNumber>
 * ────────────────────────────────────────────────────────────
 */

require('dotenv').config({ quiet: true });
const inv = require('../services/economicInvoice');

const nr = Number(process.argv[2]);
if (!nr) {
    console.error('Brug: node --experimental-sqlite scripts/economic-delete-draft.js <draftInvoiceNumber>');
    process.exit(1);
}

(async () => {
    try {
        await inv.deleteDraftInvoice(nr);
        console.log(`✅ Udkast ${nr} slettet i e-conomic.`);
    } catch (err) {
        console.error(`❌ Kunne ikke slette udkast ${nr}:`, err.message);
        process.exit(1);
    }
})();
