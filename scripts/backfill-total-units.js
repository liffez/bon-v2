// scripts/backfill-total-units.js
//
// Re-beregner bons.total_units for alle bons efter den nye regel:
// kun linjer hvis category er i settings.unit_count_categories tæller med
// (sandwich, slider, salat — ikke kager/drikke/emballage/levering).
//
// Migration 070 introducerede settings-key unit_count_categories.
// Routes/bons.js + routes/quotes.js bruger nu helper recalcBonTotalUnits().
// Dette script reparerer eksisterende bons i én transaktion.
//
// Brug:
//   node --experimental-sqlite scripts/backfill-total-units.js          # dry-run
//   node --experimental-sqlite scripts/backfill-total-units.js --apply  # skriv
//
// Tager backup af data/bon.db før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb, transaction } = require('../db/compat');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const DB_PATH = path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

if (apply) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${DB_PATH}.pre-backfill-units-${ts}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup: ${backup}`);
}

const db = openDb(DB_PATH);

const settingRow = db.prepare(`SELECT value FROM settings WHERE key='unit_count_categories'`).get();
if (!settingRow?.value) {
    console.error('settings.unit_count_categories findes ikke — kør migrations først.');
    process.exit(1);
}

let cats = [];
try { cats = JSON.parse(settingRow.value); } catch { cats = []; }
if (!Array.isArray(cats) || cats.length === 0) {
    console.error('settings.unit_count_categories er tom — ingen kategorier vil tælle med.');
    process.exit(1);
}

console.log(`Enheds-kategorier (${cats.length}): ${cats.join(', ')}\n`);

const placeholders = cats.map(() => '?').join(',');

// Find alle bons og beregn ny total
const rows = db.prepare(`
    SELECT
        b.id,
        b.bon_number,
        b.total_units AS current_units,
        COALESCE((
            SELECT SUM(quantity)
            FROM bon_lines
            WHERE bon_id = b.id
              AND (is_accessory = 0 OR is_accessory IS NULL)
              AND category IN (${placeholders})
        ), 0) AS new_units
    FROM bons b
`).all(...cats);

const changed = rows.filter(r => r.current_units !== r.new_units);

console.log(`Bons i alt:       ${rows.length}`);
console.log(`Med ændring:      ${changed.length}`);

if (changed.length > 0) {
    const decreased = changed.filter(r => r.new_units < r.current_units);
    const increased = changed.filter(r => r.new_units > r.current_units);
    const totalCurrent = changed.reduce((s, r) => s + (r.current_units || 0), 0);
    const totalNew = changed.reduce((s, r) => s + (r.new_units || 0), 0);
    console.log(`  Falder:         ${decreased.length}`);
    console.log(`  Stiger:         ${increased.length}`);
    console.log(`  Sum før:        ${totalCurrent}`);
    console.log(`  Sum efter:      ${totalNew}`);
    console.log(`  Difference:     ${totalNew - totalCurrent} (${totalNew - totalCurrent > 0 ? '+' : ''}${((totalNew - totalCurrent) / (totalCurrent || 1) * 100).toFixed(1)}%)`);

    console.log('\nTop 10 største fald:');
    decreased.sort((a, b) => (a.new_units - a.current_units) - (b.new_units - b.current_units))
        .slice(0, 10)
        .forEach(r => console.log(`  ${r.bon_number || ('#' + r.id)}: ${r.current_units} → ${r.new_units}`));
}

if (!apply) {
    console.log('\n(dry-run — kør med --apply for at skrive ændringer)');
    process.exit(0);
}

// Skriv ændringer
const upd = db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
let written = 0;
transaction(db, () => {
    for (const r of changed) {
        upd.run(r.new_units, r.id);
        written++;
    }
});

console.log(`\n✅ Opdateret ${written} bons.`);
