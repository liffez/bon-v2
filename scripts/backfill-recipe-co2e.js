// scripts/backfill-recipe-co2e.js
//
// Fylder MANGLENDE CO₂-snapshot ind på gamle bon-linjer.
//
// bon_lines.co2e er et FROSSET snapshot pr. enhed (recipe.Co2e da linjen blev
// oprettet). Bons oprettet FØR opskrift-faktorerne blev sat frøs derfor co2e=0,
// og bons.total_co2e = Σ(co2e × antal) = 0 — selv om opskriften har en faktor nu.
//
// Dette script slår den AKTUELLE opskrift-co2e op (fra Grocy) og fylder den ind
// på linjer der har co2e = 0/NULL og et grocy_recipe_id. Linjer der ALLEREDE har
// et rigtigt tal røres IKKE (frys-på-bon bevares for ægte historik — vi udfylder
// kun de nuller der aldrig havde data). Derefter genberegnes bons.total_co2e.
//
// Retter både draweren OG rapporterne ("CO₂ over tid" undertæller også gamle bons).
// Kræver Grocy-adgang → kør på prod / mod den aktive grocy-lokation.
//
// Brug:
//   node --experimental-sqlite scripts/backfill-recipe-co2e.js                 # dry-run
//   node --experimental-sqlite scripts/backfill-recipe-co2e.js --since=2025-01-01
//   node --experimental-sqlite scripts/backfill-recipe-co2e.js --apply         # skriv (m. backup)
//
// Tager backup af DB før --apply.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sinceArg = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || null;

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');
process.env.DB_PATH = DB_PATH; // getDb()-singleton (grocyAdapter) → samme fil

const { openDb, transaction } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const grocy = require('../services/grocyAdapter');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}
if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
    console.error(`Ugyldig --since (forventer YYYY-MM-DD): ${sinceArg}`);
    process.exit(1);
}

(async () => {
    if (apply) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${DB_PATH}.pre-backfill-co2e-${ts}`;
        fs.copyFileSync(DB_PATH, backup);
        console.log(`Backup: ${backup}`);
    }

    console.log('Kører migrationer (idempotent)…');
    runMigrations(DB_PATH);
    const db = openDb(DB_PATH);

    console.log('Henter opskrift-co2e fra Grocy…');
    const recipes = await grocy.getRecipes();
    const co2eById = new Map();
    for (const r of recipes) {
        const c = Number(r.co2e);
        if (Number.isFinite(c) && c > 0) co2eById.set(Number(r.id), c);
    }
    console.log(`  ${co2eById.size} opskrifter har co2e > 0\n`);

    // Kandidat-linjer: mangler snapshot (0/NULL), har opskrift-link.
    const sinceClause = sinceArg ? 'AND b.delivery_date >= ?' : '';
    const lines = db.prepare(`
        SELECT bl.id, bl.bon_id, bl.grocy_recipe_id, bl.quantity, bl.product_name,
               b.bon_number, b.delivery_date
          FROM bon_lines bl
          JOIN bons b ON b.id = bl.bon_id
         WHERE (bl.co2e IS NULL OR bl.co2e = 0)
           AND bl.grocy_recipe_id IS NOT NULL
           ${sinceClause}
    `).all(...(sinceArg ? [sinceArg] : []));

    const updates = [];        // { id, bon_id, newCo2e, addedKg }
    let skippedNoFactor = 0;   // linjer hvis opskrift STADIG ikke har co2e
    for (const l of lines) {
        const rc = co2eById.get(Number(l.grocy_recipe_id));
        if (!rc) { skippedNoFactor++; continue; }
        updates.push({ id: l.id, bon_id: l.bon_id, newCo2e: rc, addedKg: rc * (Number(l.quantity) || 0), bon_number: l.bon_number });
    }

    const bonIds = [...new Set(updates.map(u => u.bon_id))];
    const totalAdded = updates.reduce((a, u) => a + u.addedKg, 0);

    console.log(`Linjer uden co2e-snapshot (m. opskrift-link): ${lines.length}`);
    console.log(`  → udfyldes (opskrift har faktor):           ${updates.length}`);
    console.log(`  → springes over (opskrift mangler faktor):  ${skippedNoFactor}`);
    console.log(`Berørte bons:                                 ${bonIds.length}`);
    console.log(`Samlet CO₂ der tilføjes:                      ${totalAdded.toFixed(1)} kg`);

    if (updates.length) {
        const perBon = new Map();
        for (const u of updates) perBon.set(u.bon_number || ('#' + u.bon_id), (perBon.get(u.bon_number || ('#' + u.bon_id)) || 0) + u.addedKg);
        const top = [...perBon.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log('\nTop 10 bons (kg tilføjet):');
        top.forEach(([bn, kg]) => console.log(`  ${bn}: +${kg.toFixed(1)} kg`));
    }

    if (!apply) {
        console.log('\n(dry-run — kør med --apply for at skrive ændringerne)');
        if (skippedNoFactor > 0) {
            console.log(`Bemærk: ${skippedNoFactor} linjer forbliver 0 fordi deres opskrift stadig`);
            console.log('mangler en CO₂-faktor i Grocy — udfyld dem for at få fuld dækning.');
        }
        return;
    }

    console.log('\nSkriver ændringer…');
    transaction(db, () => {
        const upd = db.prepare('UPDATE bon_lines SET co2e = ? WHERE id = ?');
        for (const u of updates) upd.run(u.newCo2e, u.id);
        const recalc = db.prepare(`
            UPDATE bons SET total_co2e =
                (SELECT COALESCE(SUM(co2e * quantity), 0) FROM bon_lines WHERE bon_id = ?)
             WHERE id = ?
        `);
        for (const bid of bonIds) recalc.run(bid, bid);
    });
    console.log(`✓ ${updates.length} linjer opdateret · ${bonIds.length} bons genberegnet · +${totalAdded.toFixed(1)} kg CO₂`);
})().catch(e => {
    console.error('Fejl:', e && e.message ? e.message : e);
    process.exit(1);
});
