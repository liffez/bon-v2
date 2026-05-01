// fix-001-cost-prices.js — Bug #001 fix
//
// v1's cost_price-værdier er systemisk forkerte (8-340× for høje på catering).
// scripts/sync-v1.js:476 kopierer dem blindt ind i bon_lines.
//
// Dette script overskriver cost_price på bon_lines hvor:
//   - grocy_recipe_id IS NOT NULL
//   - quantity > 0
//   - sync_source = 'v1' (kun v1-importerede bons; v2-native har korrekt cost)
//
// Den nye værdi er Grocys aktuelle costs_per_serving for samme recipe.
//
// SIKKERHED:
//   - Default: --dry-run (printer top 20 ændringer + sammenfatning)
//   - Apply kræver eksplicit --apply
//   - Backup tages før --apply (data/bon.db.pre-001-fix-<timestamp>)
//   - Kører i én transaktion
//   - Frossen prod-DB røres aldrig
//   - Bruger location-baseret Grocy-URL fra settings (default_grocy_location_id)
//   - Filterer på sync_source='v1' så v2-native bons IKKE røres

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v === undefined ? true : v];
        })
);
const DRY_RUN = !args.apply;
const THRESHOLD = parseFloat(args.threshold || '1.0');  // kr afvigelse for at trigge update

const DB_PATH = path.join(__dirname, '..', 'data', 'bon.db');

console.log('═'.repeat(78));
console.log(`Bug #001 fix — ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
console.log(`Threshold: |cost_price - grocy_cost| > ${THRESHOLD} kr`);
console.log('═'.repeat(78));

const db = new DatabaseSync(DB_PATH, { readOnly: DRY_RUN });

// ─── Find Grocy URL + key ───
const locId = parseInt(db.prepare(`SELECT value FROM settings WHERE key='default_grocy_location_id'`).get().value);
const loc = db.prepare(`SELECT code, name, grocy_api_url, grocy_api_key FROM locations WHERE id = ?`).get(locId);
if (!loc) { console.error(`Lokation ${locId} ikke fundet`); process.exit(1); }
const apiUrl = loc.grocy_api_url;
const envKey = `GROCY_${loc.code}_KEY`;
const apiKey = loc.grocy_api_key || process.env[envKey] || process.env.GROCY_HQ_KEY;
if (!apiUrl || !apiKey) { console.error(`Mangler URL eller key for lokation ${loc.name}`); process.exit(1); }
console.log(`Grocy: ${loc.name} (${loc.code}) → ${apiUrl}`);
console.log('');

// ─── Hent unikke recipe_ids fra v1-bon_lines ───
const recipeIds = db.prepare(`
    SELECT DISTINCT bl.grocy_recipe_id
    FROM bon_lines bl
    JOIN bons b ON b.id = bl.bon_id
    WHERE bl.grocy_recipe_id IS NOT NULL
      AND bl.quantity > 0
      AND b.sync_source = 'v1'
`).all().map(r => r.grocy_recipe_id);
console.log(`Unikke grocy_recipe_id'er på v1-linjer: ${recipeIds.length}`);

// ─── Cache Grocy costs_per_serving ───
const grocyCost = {};   // recipe_id → cost_per_serving (eller null hvis recipe slettet)
let n = 0;
async function fetchAll() {
    for (const id of recipeIds) {
        n++;
        process.stdout.write(`\r  henter ${n}/${recipeIds.length}`);
        try {
            const res = await fetch(`${apiUrl}/recipes/${id}/fulfillment`, {
                headers: { 'GROCY-API-KEY': apiKey }
            });
            if (!res.ok) {
                if (res.status === 400) { grocyCost[id] = null; continue; }  // recipe slettet
                grocyCost[id] = 'ERROR';
                continue;
            }
            const f = await res.json();
            if (f.error_message) { grocyCost[id] = null; continue; }
            grocyCost[id] = parseFloat(f.costs_per_serving) || 0;
        } catch (e) {
            grocyCost[id] = 'ERROR';
        }
    }
    console.log('');
}

(async () => {
    await fetchAll();

    const deletedIds = Object.entries(grocyCost).filter(([_, v]) => v === null).map(([k]) => parseInt(k));
    const errorIds = Object.entries(grocyCost).filter(([_, v]) => v === 'ERROR').map(([k]) => parseInt(k));
    console.log(`  Recipes returneret cost: ${recipeIds.length - deletedIds.length - errorIds.length}`);
    console.log(`  Recipes ikke fundet (slettet): ${deletedIds.length}`);
    console.log(`  Recipes API-fejl: ${errorIds.length}`);
    console.log('');

    // ─── Find linjer der skal opdateres ───
    const lines = db.prepare(`
        SELECT bl.id, bl.bon_id, b.bon_number, b.delivery_date,
               bl.grocy_recipe_id, bl.product_name, bl.quantity, bl.unit_price, bl.cost_price
        FROM bon_lines bl
        JOIN bons b ON b.id = bl.bon_id
        WHERE bl.grocy_recipe_id IS NOT NULL
          AND bl.quantity > 0
          AND b.sync_source = 'v1'
    `).all();

    const updates = [];
    let unchanged = 0;
    let skippedDeleted = 0;
    let skippedError = 0;

    for (const l of lines) {
        const newCost = grocyCost[l.grocy_recipe_id];
        if (newCost === null) { skippedDeleted++; continue; }
        if (newCost === 'ERROR') { skippedError++; continue; }
        const oldCost = parseFloat(l.cost_price) || 0;
        if (Math.abs(oldCost - newCost) <= THRESHOLD) { unchanged++; continue; }
        updates.push({ ...l, new_cost: newCost, diff: oldCost - newCost });
    }

    console.log(`Linjer evalueret: ${lines.length}`);
    console.log(`  Inden for threshold (uændret): ${unchanged}`);
    console.log(`  Recipe slettet (skippet):       ${skippedDeleted}`);
    console.log(`  API-fejl (skippet):             ${skippedError}`);
    console.log(`  → Skal opdateres:               ${updates.length}`);
    console.log('');

    if (updates.length) {
        console.log('Top 20 største afvigelser:');
        console.log('');
        console.log('  ' + 'bon_number'.padEnd(14) + 'date'.padEnd(12) + 'recipe'.padEnd(8) +
            'product'.padEnd(28) + 'qty'.padStart(5) + 'old_cost'.padStart(10) + 'new_cost'.padStart(10));
        for (const u of updates.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 20)) {
            console.log('  ' +
                String(u.bon_number).padEnd(14) +
                String(u.delivery_date).padEnd(12) +
                String(u.grocy_recipe_id).padEnd(8) +
                String(u.product_name).slice(0, 26).padEnd(28) +
                String(u.quantity).padStart(5) +
                String(parseFloat(u.cost_price).toFixed(2)).padStart(10) +
                String(u.new_cost.toFixed(2)).padStart(10));
        }
        console.log('');

        // Bons mest påvirket
        const byBon = {};
        for (const u of updates) {
            if (!byBon[u.bon_number]) byBon[u.bon_number] = { count: 0, total_diff: 0 };
            byBon[u.bon_number].count++;
            byBon[u.bon_number].total_diff += Math.abs(u.diff);
        }
        const topBons = Object.entries(byBon).sort((a, b) => b[1].total_diff - a[1].total_diff).slice(0, 10);
        console.log('Top 10 mest påvirkede bons (samlet kr-afvigelse):');
        for (const [bon, s] of topBons) {
            console.log(`  #${bon.padEnd(13)} ${s.count} linjer, ${s.total_diff.toFixed(0).padStart(7)} kr afvigelse`);
        }
        console.log('');
    }

    if (DRY_RUN) {
        console.log('═'.repeat(78));
        console.log('DRY RUN — ingen ændringer er gemt.');
        console.log('Hvis output ser fornuftigt ud, kør:');
        console.log('  node scripts/fix-001-cost-prices.js --apply');
        console.log('═'.repeat(78));
        db.close();
        return;
    }

    // ─── APPLY ───
    if (!updates.length) {
        console.log('Ingen ændringer at lave.');
        db.close();
        return;
    }

    db.close();

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(__dirname, '..', 'data', `bon.db.pre-001-fix-${ts}`);
    console.log(`Tager backup: ${backupFile}`);
    fs.copyFileSync(DB_PATH, backupFile);

    const w = new DatabaseSync(DB_PATH);
    const upd = w.prepare(`UPDATE bon_lines SET cost_price = ? WHERE id = ?`);

    console.log(`Opdaterer ${updates.length} linjer i transaktion...`);
    w.exec('BEGIN');
    try {
        for (const u of updates) {
            upd.run(u.new_cost, u.id);
        }
        w.exec('COMMIT');
        console.log(`✓ ${updates.length} linjer opdateret.`);
    } catch (e) {
        w.exec('ROLLBACK');
        console.error(`✗ Fejl: ${e.message}`);
        console.log('Transaktion rullet tilbage.');
        process.exit(1);
    }
    w.close();

    // Skriv log
    const logFile = path.join(__dirname, '..', 'data', `001-fix-log-${ts}.json`);
    fs.writeFileSync(logFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        threshold_kr: THRESHOLD,
        grocy_url: apiUrl,
        unique_recipes: recipeIds.length,
        recipes_deleted: deletedIds.length,
        recipes_errors: errorIds.length,
        lines_updated: updates.length,
        backup_file: backupFile
    }, null, 2));
    console.log(`Log: ${logFile}`);
})();
