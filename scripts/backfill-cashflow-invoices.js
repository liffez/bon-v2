// scripts/backfill-cashflow-invoices.js
//
// Backfill cf_invoices for eksisterende FAKTURERET/AFSLUTTET/BETALT-bons
// der ikke allerede har en auto-genereret cf_invoice (bon_id IS NULL).
//
// Brug:
//   node --experimental-sqlite scripts/backfill-cashflow-invoices.js          # dry-run
//   node --experimental-sqlite scripts/backfill-cashflow-invoices.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.
//
// Idempotent: syncCashflowInvoice springer over bons der allerede har
// cf_invoice + opdaterer hvis feltværdier afviger.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const { syncCashflowInvoice } = require('../services/cashflowSync');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

if (apply) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${DB_PATH}.pre-cf-backfill-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup: ${backup}`);
}

// Migration 078 tilføjer bon_id til cf_invoices — sørg for den er kørt.
console.log('Kører migrationer (idempotent)…');
runMigrations(DB_PATH);

const db = openDb(DB_PATH);

// Find kandidater: alle bons med fakturerbar status der ikke allerede har
// en auto-genereret cf_invoice. (Bons med manuelt oprettet cf_invoice uden
// bon_id behandles også — sync vil enten linke via id-clash eller oprette
// ny under "B<nr>"-fallback.)
const candidates = db.prepare(`
    SELECT b.id, b.bon_number, sd.code AS status_code, b.payment_type,
           b.is_offer, b.is_internal, b.total_price, b.invoice_info
    FROM bons b
    JOIN status_definitions sd ON b.status_id = sd.id
    WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
      AND b.payment_type = 'invoice'
      AND COALESCE(b.is_offer, 0) = 0
      AND COALESCE(b.is_internal, 0) = 0
      AND COALESCE(b.total_price, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM cf_invoices ci WHERE ci.bon_id = b.id)
    ORDER BY b.id
`).all();

console.log(`Fundet ${candidates.length} kandidat-bons til backfill.`);
if (candidates.length === 0) {
    console.log('Intet at gøre.');
    process.exit(0);
}

if (!apply) {
    console.log('\n[DRY-RUN] — første 20 kandidater:');
    for (const b of candidates.slice(0, 20)) {
        console.log(`  bon #${b.bon_number}  status=${b.status_code}  total=${b.total_price}  invoice_info=${(b.invoice_info || '').slice(0, 40)}`);
    }
    console.log(`\nKør med --apply for at oprette ${candidates.length} cf_invoices.`);
    process.exit(0);
}

console.log('\nSkriver…');
const stats = { created: 0, updated: 0, renamed: 0, deleted: 0, skipped: 0, error: 0 };
const skipReasons = {};

for (const b of candidates) {
    try {
        const result = syncCashflowInvoice(db, b.id);
        stats[result.action] = (stats[result.action] || 0) + 1;
        if (result.action === 'skipped') {
            skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
        }
    } catch (err) {
        stats.error++;
        console.error(`  bon #${b.bon_number}: ${err.message}`);
    }
}

console.log('\nResultat:');
console.log(`  Oprettet:    ${stats.created}`);
console.log(`  Opdateret:   ${stats.updated}`);
console.log(`  Omdøbt:      ${stats.renamed}`);
console.log(`  Slettet:     ${stats.deleted}`);
console.log(`  Sprunget:    ${stats.skipped}`);
if (stats.error) console.log(`  Fejl:        ${stats.error}`);
if (Object.keys(skipReasons).length) {
    console.log('\n  Skip-årsager:');
    for (const [reason, count] of Object.entries(skipReasons)) {
        console.log(`    ${reason}: ${count}`);
    }
}
console.log('\nFærdig.');
