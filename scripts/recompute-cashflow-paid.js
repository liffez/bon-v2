// scripts/recompute-cashflow-paid.js
//
// Gen-kører syncCashflowInvoice på alle auto-cf_invoices (bon_id IS NOT NULL)
// så betalingsstatus opdateres efter cf_assume_paid_after_days-thresholdet.
//
// Use case: efter migration 079 har vi sat 90 dage som default — alle
// historiske FAKTURERET-bons ældre end 90 dage bør nu markeres betalt
// automatisk. Dette script gør det idempotent uden at røre andre felter.
//
// Brug:
//   node --experimental-sqlite scripts/recompute-cashflow-paid.js          # dry-run
//   node --experimental-sqlite scripts/recompute-cashflow-paid.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const { syncCashflowInvoice, getAssumePaidDays } = require('../services/cashflowSync');

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
    const backup = `${DB_PATH}.pre-recompute-paid-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup: ${backup}`);
}

console.log('Kører migrationer (idempotent)…');
runMigrations(DB_PATH);

const db = openDb(DB_PATH);
const threshold = getAssumePaidDays(db);
console.log(`cf_assume_paid_after_days = ${threshold} dage`);

if (threshold <= 0) {
    console.log('Threshold er 0 — auto-mark deaktiveret. Intet at gøre.');
    process.exit(0);
}

// Tæl før-tilstand
const before = db.prepare(`
    SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN betalt = 1 THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN betalt = 0 THEN 1 ELSE 0 END) AS unpaid,
        COALESCE(SUM(CASE WHEN betalt = 0 THEN beloeb ELSE 0 END), 0) AS unpaid_total
    FROM cf_invoices WHERE bon_id IS NOT NULL
`).get();
console.log(`\nFør:  ${before.total} auto-cf_invoices (${before.paid} betalt, ${before.unpaid} ubetalt = ${before.unpaid_total.toFixed(2)} kr)`);

if (!apply) {
    // Dry-run: tæl hvor mange der VILLE blive markeret betalt
    const candidates = db.prepare(`
        SELECT ci.id, ci.beloeb, b.delivery_date
        FROM cf_invoices ci
        JOIN bons b ON b.id = ci.bon_id
        WHERE ci.betalt = 0
          AND b.delivery_date < date('now', '-' || ? || ' days')
    `).all(threshold);
    const sum = candidates.reduce((s, r) => s + r.beloeb, 0);
    console.log(`\n[DRY-RUN] ${candidates.length} cf_invoices ville blive markeret betalt (${sum.toFixed(2)} kr)`);
    console.log('\nKør med --apply for at gennemføre.');
    process.exit(0);
}

// Hent alle auto-cf_invoices og gen-kør sync
const all = db.prepare(`SELECT bon_id FROM cf_invoices WHERE bon_id IS NOT NULL`).all();
console.log(`\nGen-kører sync for ${all.length} cf_invoices…`);

const stats = { updated: 0, deleted: 0, skipped: 0, error: 0 };
for (const r of all) {
    try {
        const result = syncCashflowInvoice(db, r.bon_id);
        stats[result.action] = (stats[result.action] || 0) + 1;
    } catch (err) {
        stats.error++;
        console.error(`  bon_id=${r.bon_id}: ${err.message}`);
    }
}

const after = db.prepare(`
    SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN betalt = 1 THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN betalt = 0 THEN 1 ELSE 0 END) AS unpaid,
        COALESCE(SUM(CASE WHEN betalt = 0 THEN beloeb ELSE 0 END), 0) AS unpaid_total
    FROM cf_invoices WHERE bon_id IS NOT NULL
`).get();

console.log('\nResultat:');
for (const [k, v] of Object.entries(stats)) if (v) console.log(`  ${k}: ${v}`);
console.log(`\nEfter: ${after.total} auto-cf_invoices (${after.paid} betalt, ${after.unpaid} ubetalt = ${after.unpaid_total.toFixed(2)} kr)`);
console.log(`\nNetto: ${after.paid - before.paid} flere markeret betalt, udestående reduceret med ${(before.unpaid_total - after.unpaid_total).toFixed(2)} kr.`);
