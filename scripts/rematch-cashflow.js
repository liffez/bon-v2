// scripts/rematch-cashflow.js
//
// Gen-kør match-algoritmen mod alle eksisterende cf_transactions efter
// tolerance-settings er ændret (migration 080). Bruger samme logik som
// CSV-upload triggerer, så ingen ny CSV behøves.
//
// Strategi:
//   1. Nulstil "bløde" matches (confidence < 70) — de markerer ikke
//      betalt og kan trygt revurderes med ny tolerance.
//   2. Lad eksisterende ≥ 70-matches stå (de har allerede markeret bonen
//      betalt — vi rører dem ikke for at undgå at fjerne bekræftede betalinger).
//   3. Kør runMatchLogic mod den resulterende unmatched-pool.
//
// Brug:
//   node --experimental-sqlite scripts/rematch-cashflow.js          # dry-run
//   node --experimental-sqlite scripts/rematch-cashflow.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');

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
    const backup = `${DB_PATH}.pre-rematch-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup: ${backup}`);
}

console.log('Kører migrationer (idempotent)…');
runMigrations(DB_PATH);

const db = openDb(DB_PATH);

// Hent settings
const pctRow = db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_relative_tolerance_pct'`).get();
const extraRow = db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_extra_tolerance_max'`).get();
console.log(`cf_match_relative_tolerance_pct = ${pctRow?.value ?? '(default 2.0)'}`);
console.log(`cf_match_extra_tolerance_max     = ${extraRow?.value ?? '(default 350)'} kr`);

// Før-tilstand
const before = db.prepare(`
    SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN matched_invoice_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
        SUM(CASE WHEN matched_invoice_id IS NOT NULL AND match_confidence >= 70 THEN 1 ELSE 0 END) AS hard,
        SUM(CASE WHEN matched_invoice_id IS NOT NULL AND match_confidence < 70 THEN 1 ELSE 0 END) AS soft
    FROM cf_transactions WHERE beloeb > 0
`).get();
const beforeInv = db.prepare(`
    SELECT
        SUM(CASE WHEN betalt = 0 THEN 1 ELSE 0 END) AS unpaid,
        COALESCE(SUM(CASE WHEN betalt = 0 THEN beloeb ELSE 0 END), 0) AS unpaid_total
    FROM cf_invoices
`).get();
console.log(`\nFør:`);
console.log(`  cf_transactions (positive): ${before.total} (${before.hard} hard-matched, ${before.soft} soft, ${before.unmatched} unmatched)`);
console.log(`  cf_invoices ubetalt: ${beforeInv.unpaid} stk = ${beforeInv.unpaid_total.toFixed(2)} kr`);

if (!apply) {
    // Hvor mange bløde matches ville blive nulstillet?
    const softCount = before.soft;
    console.log(`\n[DRY-RUN] Ville nulstille ${softCount} bløde matches (< 70 confidence) og re-evaluere mod ny tolerance.`);
    console.log('Kør med --apply for at gennemføre.');
    process.exit(0);
}

// 1) Nulstil bløde matches
const cleared = db.prepare(`
    UPDATE cf_transactions
    SET matched_invoice_id = NULL, match_confidence = 0
    WHERE matched_invoice_id IS NOT NULL AND match_confidence < 70
`).run();
console.log(`\nNulstillet ${cleared.changes} bløde matches.`);

// 2) Kør match-algoritmen — vi requirer routen for at genbruge logikken,
//    men runMatchLogic er ikke eksporteret. Re-implementér inline her
//    (samme logik som routes/cashflow.js:runMatchLogic).
const unmatched = db.prepare(`
    SELECT id, dato, tekst, beloeb FROM cf_transactions
    WHERE matched_invoice_id IS NULL AND beloeb > 0
`).all();

const invoices = db.prepare(`
    SELECT id, beloeb, forfald FROM cf_invoices WHERE betalt = 0
`).all();

const relativePct = parseFloat(pctRow?.value);
const extraMax = parseFloat(extraRow?.value);
const relRatio = (Number.isFinite(relativePct) && relativePct >= 0 ? relativePct : 2.0) / 100;
const extra = Number.isFinite(extraMax) && extraMax >= 0 ? extraMax : 350;

const updateTx = db.prepare(`UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = ? WHERE id = ?`);
const markPaid = db.prepare(`UPDATE cf_invoices SET betalt = 1, betalt_dato = ? WHERE id = ?`);

let newHardMatches = 0;
let newSoftMatches = 0;

for (const tx of unmatched) {
    let bestMatch = null;
    let bestConf = 0;

    for (const inv of invoices) {
        const diff = tx.beloeb - inv.beloeb;
        const absDiff = Math.abs(diff);
        const ratio = absDiff / Math.abs(inv.beloeb);
        const withinRelative = ratio <= relRatio;
        const withinExtraAbove = diff > 0 && diff <= extra;
        if (!withinRelative && !withinExtraAbove) continue;

        const nums = tx.tekst.match(/\d{4,}/g) || [];
        const hasInvNr = nums.some(n => n === inv.id);

        const txDate = new Date(tx.dato);
        const dueDate = new Date(inv.forfald);
        const daysDiff = Math.abs((txDate - dueDate) / 86400000);

        let conf = 0;
        if (hasInvNr) {
            conf = 95;
        } else if (daysDiff <= 5) {
            conf = withinRelative ? 80 : 70;
        } else if (daysDiff <= 14) {
            conf = withinRelative ? 55 : 50;
        } else {
            conf = 40;
        }

        if (conf > bestConf) {
            bestConf = conf;
            bestMatch = inv.id;
        }
    }

    if (bestMatch && bestConf > 0) {
        updateTx.run(bestMatch, bestConf, tx.id);
        if (bestConf >= 70) {
            markPaid.run(tx.dato, bestMatch);
            newHardMatches++;
            const idx = invoices.findIndex(i => i.id === bestMatch);
            if (idx >= 0) invoices.splice(idx, 1);
        } else {
            newSoftMatches++;
        }
    }
}

const after = db.prepare(`
    SELECT
        SUM(CASE WHEN matched_invoice_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
        SUM(CASE WHEN matched_invoice_id IS NOT NULL AND match_confidence >= 70 THEN 1 ELSE 0 END) AS hard,
        SUM(CASE WHEN matched_invoice_id IS NOT NULL AND match_confidence < 70 THEN 1 ELSE 0 END) AS soft
    FROM cf_transactions WHERE beloeb > 0
`).get();
const afterInv = db.prepare(`
    SELECT
        SUM(CASE WHEN betalt = 0 THEN 1 ELSE 0 END) AS unpaid,
        COALESCE(SUM(CASE WHEN betalt = 0 THEN beloeb ELSE 0 END), 0) AS unpaid_total
    FROM cf_invoices
`).get();

console.log(`\nResultat:`);
console.log(`  Nye hard-matches:  ${newHardMatches} (markeret betalt)`);
console.log(`  Nye soft-matches:  ${newSoftMatches} (kandidater til 'Sandsynlig betalt')`);
console.log(`\nEfter:`);
console.log(`  cf_transactions (positive): ${before.total} (${after.hard} hard, ${after.soft} soft, ${after.unmatched} unmatched)`);
console.log(`  cf_invoices ubetalt: ${afterInv.unpaid} stk = ${afterInv.unpaid_total.toFixed(2)} kr`);
console.log(`\nNetto: udestående reduceret med ${(beforeInv.unpaid_total - afterInv.unpaid_total).toFixed(2)} kr.`);
