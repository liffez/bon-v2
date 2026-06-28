// scripts/backfill-total-units.js
//
// Re-beregner bons.total_units for alle bons — BOKS-AWARE.
//
// Enheds-reglen (samme som recalcBonTotalUnits / drift via db/helpers.bonUnitsExpr):
//   - kun kategorier i settings.unit_count_categories tæller (sandwich/salat/slider)
//   - kombo-bokse (Grocy recipe der nester tællelige retter, fx "Alm slider Boks"
//     = 3 sliders) ekspanderes til deres indhold via recipe_unit_counts
//   - recipes i settings.unit_count_extra_recipes (fx Børne Bokse) tæller som 1
//   - emballage/levering/drikke/kager/tilbehør tæller IKKE
//
// Scriptet OPDATERER FØRST recipe_unit_counts fra live Grocy (recipes_nestings +
// grupper), så boks-ekspansionen er korrekt, og recomputer derefter total_units.
// Kræver Grocy-adgang (kør på prod / mod den aktive grocy-lokation).
//
// Brug:
//   node --experimental-sqlite scripts/backfill-total-units.js          # dry-run
//   node --experimental-sqlite scripts/backfill-total-units.js --apply  # skriv
//
// Tager backup af DB før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

// Sørg for at getDb()-singleton (brugt af helpers + grocyAdapter) peger på SAMME
// fil som vores openDb — ellers ville bonUnitsExpr læse settings fra en anden DB.
process.env.DB_PATH = DB_PATH;

const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const { bonUnitsExpr } = require('../db/helpers');
const { refreshRecipeUnitCounts } = require('../services/recipeUnits');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

(async () => {
    if (apply) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${DB_PATH}.pre-backfill-units-${ts}`;
        fs.copyFileSync(DB_PATH, backup);
        console.log(`Backup: ${backup}`);
    }

    console.log('Kører migrationer (idempotent)…');
    runMigrations(DB_PATH);

    const db = openDb(DB_PATH);

    // 1) Opdater recipe_unit_counts fra live Grocy (boks-ekspansion).
    console.log('Opdaterer recipe_unit_counts fra Grocy…');
    let ruCount;
    try {
        ({ count: ruCount } = await refreshRecipeUnitCounts(db));
    } catch (e) {
        console.error(`\n❌ Kunne ikke hente Grocy-data: ${e.message}`);
        console.error('   Backfill afbrudt — uden recipe_unit_counts ville bokse blive undertalt.');
        console.error('   Tjek Grocy-forbindelse (default_grocy_location_id + locations) og prøv igen.');
        process.exit(1);
    }
    const boxes = db.prepare(`SELECT COUNT(*) n FROM recipe_unit_counts WHERE unit_count > 1`).get().n;
    console.log(`  ${ruCount} recipes mappet · ${boxes} kombo-bokse (>1 enhed/styk)\n`);

    // 2) Beregn ny total_units boks-aware (samme udtryk som recalc/drift).
    const { contrib, join, args: uArgs } = bonUnitsExpr();
    const rows = db.prepare(`
        SELECT b.id, b.bon_number, b.total_units AS current_units,
               COALESCE((
                   SELECT SUM(${contrib})
                   FROM bon_lines bl
                   ${join}
                   WHERE bl.bon_id = b.id
                     AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
               ), 0) AS new_units
        FROM bons b
    `).all(...uArgs);

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

        const fmt = list => list.slice(0, 10).forEach(r => console.log(`  ${r.bon_number || ('#' + r.id)}: ${r.current_units} → ${r.new_units}`));
        console.log('\nTop 10 største stigninger:');
        fmt([...increased].sort((a, b) => (b.new_units - b.current_units) - (a.new_units - a.current_units)));
        console.log('\nTop 10 største fald (tjek disse — bør være bokse/oppustede):');
        fmt([...decreased].sort((a, b) => (a.new_units - a.current_units) - (b.new_units - b.current_units)));
    }

    if (!apply) {
        console.log('\n(dry-run — kør med --apply for at skrive ændringer)');
        process.exit(0);
    }

    const upd = db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    let written = 0;
    for (const r of changed) { upd.run(r.new_units, r.id); written++; }

    console.log(`\n✅ Opdateret ${written} bons.`);
    process.exit(0);
})();
