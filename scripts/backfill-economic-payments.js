#!/usr/bin/env node
/**
 * scripts/backfill-economic-payments.js
 * ════════════════════════════════════════════════════════════════════════
 * Engangs-hentning af HELE historikken af betalingsposteringer fra e-conomic.
 *
 * "⟳ Synk e-conomic"-knappen henter selv historikken første gang, men det tager
 * ~30 sekunder (12 regnskabsår, ~75.000 posteringer) og holder browseren
 * ventende. Kør hellere dette script én gang efter deploy; derefter tager
 * knappen kun det åbne regnskabsår og er nede på et sekund.
 *
 *   node --experimental-sqlite scripts/backfill-economic-payments.js          # tør-kørsel
 *   node --experimental-sqlite scripts/backfill-economic-payments.js --apply  # skriver
 *
 * Kun læsning fra e-conomic. Idempotent: kør den igen, og rækkerne opdateres.
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();
const { openDb } = require('../db/compat');
const eco = require('../services/economicAdapter');
const ledger = require('../services/economicLedger');

const apply = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || './data/bon.db';

(async () => {
    if (!eco.isConfigured()) {
        console.error('e-conomic er ikke konfigureret — sæt ECONOMIC_APP_SECRET + ECONOMIC_AGREEMENT_GRANT i .env');
        process.exit(2);
    }
    const conn = await eco.verifyConnection();
    if (!conn.ok) {
        console.error('Kan ikke nå e-conomic:', conn.reason);
        process.exit(2);
    }
    console.log(`e-conomic: ${conn.companyName || '(ukendt firma)'} · agreement ${conn.agreementNumber}`);
    console.log(`Database : ${DB_PATH}`);
    console.log(apply ? 'Tilstand : SKRIVER\n' : 'Tilstand : tør-kørsel (brug --apply for at skrive)\n');

    const db = openDb(DB_PATH);
    const t0 = Date.now();
    const r = await ledger.syncPayments(db, { dryRun: !apply, full: true });

    if (!r.available) {
        console.error('Betalingsposteringer er ikke tilgængelige:', r.reason);
        console.error('App-rollen mangler «Bookkeeping» — se docs/economics/CLAUDE_ECONOMIC_AUTH.md §1.');
        process.exit(3);
    }

    console.log(`Regnskabsår   : ${r.years.length} (${r.years.join(', ')})`);
    console.log(`Posteringer   : ${r.scanned} scannet`);
    console.log(`Betalinger    : ${r.payments}`);
    console.log(`Skrevet       : ${apply ? r.written : 0}`);
    console.log(`Tid           : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (apply) {
        const linked = db.prepare(`
            SELECT COUNT(*) AS n FROM cf_invoices i
            JOIN cf_economic_payments p ON p.invoice_number = i.economic_number
        `).get().n;
        console.log(`\nFakturaer der nu har en ægte betalingsdato: ${linked}`);
        console.log('Betalingsrytmen genberegnes automatisk ved næste opslag.');
    } else {
        console.log('\nIntet skrevet. Kør igen med --apply.');
    }
    db.close();
})().catch(err => {
    console.error('\nFejlede:', err.message);
    process.exit(1);
});
