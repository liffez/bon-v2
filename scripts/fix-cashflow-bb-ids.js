// scripts/fix-cashflow-bb-ids.js
//
// Engangs-oprydning: cf_invoices placeholder-id'er fik tidligere dobbelt-præfiks
// fordi computeInvoiceId byggede `B${bon.bon_number}` mens bon_number allerede
// har et præfiks ("B4015" → "BB4015", "cafe-65" → "Bcafe-65"). PR #184 rettede
// generatoren, men eksisterende rækker i prod har stadig de forkerte id'er.
//
// Dette script finder cf_invoices hvor id == 'B' || bons.bon_number (præcis det
// dobbelt-præfiks-mønster) og omdøber til bon_number. Matchede bank-transaktioner
// følger med (cf_transactions.matched_invoice_id opdateres i samme transaction).
//
// Rører KUN placeholder-id'er (ingen rigtige fakturanumre — dem matcher mønsteret
// ikke). Springer over hvis target-id allerede er i brug (konflikt → log).
//
// Brug:
//   node --experimental-sqlite scripts/fix-cashflow-bb-ids.js          # dry-run
//   node --experimental-sqlite scripts/fix-cashflow-bb-ids.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb, transaction } = require('../db/compat');
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
    const backup = `${DB_PATH}.pre-fix-bb-ids-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup: ${backup}`);
}

console.log('Kører migrationer (idempotent)…');
runMigrations(DB_PATH);

const db = openDb(DB_PATH);

// Find placeholder-rækker med dobbelt-præfiks: id === 'B' + bon_number.
const rows = db.prepare(`
    SELECT i.id AS old_id, b.bon_number AS new_id
    FROM cf_invoices i
    JOIN bons b ON i.bon_id = b.id
    WHERE i.id = 'B' || b.bon_number
    ORDER BY i.id
`).all();

console.log(`\nFundet ${rows.length} cf_invoices med dobbelt-præfiks-id.`);
if (rows.length === 0) {
    console.log('Intet at rette.');
    process.exit(0);
}

// Vis de første som eksempel
rows.slice(0, 15).forEach(r => console.log(`  ${r.old_id}  →  ${r.new_id}`));
if (rows.length > 15) console.log(`  … +${rows.length - 15} flere`);

let renamed = 0, skipped = 0;

for (const r of rows) {
    if (r.old_id === r.new_id) { continue; }
    const conflict = db.prepare(`SELECT 1 FROM cf_invoices WHERE id = ?`).get(r.new_id);
    if (conflict) {
        console.warn(`  ⚠ Springer over ${r.old_id} → ${r.new_id}: target-id findes allerede`);
        skipped++;
        continue;
    }
    if (!apply) { renamed++; continue; }

    // Kopiér rækken under nyt id, omdiriger match-links, slet gammelt id — alt i
    // én transaction (FK fra cf_transactions.matched_invoice_id forhindrer direkte
    // UPDATE af primærnøglen).
    transaction(db, () => {
        db.prepare(`
            INSERT INTO cf_invoices (id, bon_id, kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter, created_at)
            SELECT ?, bon_id, kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter, created_at
            FROM cf_invoices WHERE id = ?
        `).run(r.new_id, r.old_id);
        db.prepare(`UPDATE cf_transactions SET matched_invoice_id = ? WHERE matched_invoice_id = ?`).run(r.new_id, r.old_id);
        db.prepare(`DELETE FROM cf_invoices WHERE id = ?`).run(r.old_id);
    });
    renamed++;
}

console.log(`\n${apply ? 'Omdøbt' : 'Ville omdøbe'}: ${renamed} · sprunget over (konflikt): ${skipped}`);
if (!apply) console.log('\nDRY-RUN — kør med --apply for at gemme.');
