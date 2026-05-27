// scripts/cleanup-garbled-cashflow-tx.js
//
// Finder og sletter cf_transactions-rækker hvor tekst indeholder U+FFFD
// (replacement character) — det er rækker importeret før encoding-fixet
// i PR #8. De kan ikke repareres (originale bytes er tabt), kun slettes
// så du kan re-uploade CSV'en og få rene rækker.
//
// Brug:
//   node --experimental-sqlite scripts/cleanup-garbled-cashflow-tx.js          # dry-run
//   node --experimental-sqlite scripts/cleanup-garbled-cashflow-tx.js --apply  # slet
//
// Tager backup af data/bon.db før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

const db = openDb(DB_PATH);

// U+FFFD = replacement character. Findes kun i tekst hvor UTF-8 decoder
// fejlede på Windows-1252-bytes (typisk Ø/Æ/Å fra Nykredit/Fælles Kassen).
const garbled = db.prepare(`
    SELECT id, dato, tekst, beloeb,
           (SELECT COUNT(*) FROM cf_transactions ct2 WHERE ct2.matched_invoice_id IS NOT NULL AND ct2.id = cf_transactions.id) AS is_matched
    FROM cf_transactions
    WHERE tekst LIKE '%' || char(65533) || '%'
    ORDER BY dato DESC, id DESC
`).all();

console.log(`Fundet ${garbled.length} garblede rækker.`);

if (garbled.length === 0) {
    console.log('Intet at gøre.');
    process.exit(0);
}

const matchedCount = garbled.filter(r => r.is_matched).length;
if (matchedCount > 0) {
    console.warn(`\n⚠  ${matchedCount} af rækkerne har et faktura-match. Slettes også (match-link fjernes via ON DELETE SET NULL).`);
}

console.log('\nRækker der bliver slettet:');
for (const r of garbled) {
    console.log(`  id=${r.id}  ${r.dato}  ${r.beloeb.toFixed(2).padStart(10)} kr  "${r.tekst}"`);
}

if (!apply) {
    console.log(`\nKør med --apply for at slette ${garbled.length} rækker.`);
    console.log('Bagefter: upload CSV'en igen i Pengestrøm — så får du rene "Overførsel"-rækker.');
    process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${DB_PATH}.pre-cleanup-garbled-${ts}`;
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBackup: ${backup}`);

const stmt = db.prepare(`DELETE FROM cf_transactions WHERE id = ?`);
let deleted = 0;
for (const r of garbled) {
    const info = stmt.run(r.id);
    if (info.changes > 0) deleted++;
}

console.log(`\nSlettet ${deleted} rækker. Upload CSV'en igen i Pengestrøm-modulet.`);
