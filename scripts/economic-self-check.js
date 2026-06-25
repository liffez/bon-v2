/**
 * scripts/economic-self-check.js
 * ────────────────────────────────────────────────────────────
 * Spor 1-gate: bekræft at e-conomic-forbindelsen virker.
 * Kalder GET /self (read-only, helt ufarligt) og udskriver firmanavnet.
 *
 * Kør:  node scripts/economic-self-check.js
 *       (læser tokens fra .env via dotenv)
 *
 * Forventet: "✅ Forbundet til e-conomic: Nordic Fast Food".
 * 401 → grant token tilbagekaldt/ugyldig. not_configured → tokens mangler i .env.
 * ────────────────────────────────────────────────────────────
 */

require('dotenv').config({ quiet: true });
const eco = require('../services/economicAdapter');

(async () => {
    const res = await eco.verifyConnection();

    if (res.ok) {
        console.log(`✅ Forbundet til e-conomic: ${res.companyName || '(navn mangler i /self)'}`);
        if (res.agreementNumber) console.log(`   Agreement-nr: ${res.agreementNumber}`);
        console.log(`   REST: ${eco.REST_BASE}  ·  OpenAPI: ${eco.OPENAPI_BASE}`);
        process.exit(0);
    }

    console.error('❌ e-conomic-forbindelse fejlede.');
    console.error(`   Årsag: ${res.reason}`);
    if (res.code)   console.error(`   Kode:  ${res.code}`);
    if (res.status) console.error(`   HTTP:  ${res.status}`);
    if (res.code === 'not_configured') {
        console.error('   → Sæt ECONOMIC_APP_SECRET + ECONOMIC_AGREEMENT_GRANT i .env.');
    }
    process.exit(1);
})();
