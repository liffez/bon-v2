// scripts/reconcile-item-prices.js
// ==========================================
// ENGANGS-AFSTEMNING af item_prices ↔ Grocy Salesprice*-userfields.
//
// Baggrund: indtil juni 2026 var item_prices frakoblet Grocy efter backfillen —
// redigeringer i "Opskrifter & priser" landede kun lokalt, og Grocy-ændringer
// slog ikke igennem i analysen. Fremover er Grocy master: viewet skriver
// tilbage til Grocy, og refresh-costs synker Grocy → item_prices.
//
// FØR den nye pull-sync første gang kører (refresh-knap eller nightly cron)
// skal divergerende rækker afstemmes — ellers overskrives view-redigeringer.
//
// Brug:
//   node --experimental-sqlite scripts/reconcile-item-prices.js           # dry-run: vis diffs
//   node --experimental-sqlite scripts/reconcile-item-prices.js --push    # item_prices → Grocy
//   node --experimental-sqlite scripts/reconcile-item-prices.js --pull    # Grocy → item_prices
//
// --push: brug når redigeringerne er sket i Opskrifter & priser-viewet
// --pull: brug når Grocy-priserne er de rigtige
// (updated_by_user_id kan IKKE bruges til at skelne — backfillen stemplede også bruger-id)
// ==========================================

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { openDb } = require('../db/compat');
const grocyAdapter = require('../services/grocyAdapter');
const { num: grocyNum } = require('../shared/grocy_num');
const { inclToExcl, exclToIncl } = require('../shared/moms');
const { USERFIELD_TO_CATEGORY, CATEGORY_TO_USERFIELD } = require('../services/itemPriceBackfill');

const PUSH = process.argv.includes('--push');
const PULL = process.argv.includes('--pull');
const TOL = 0.01;

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

async function main() {
    if (PUSH && PULL) {
        console.error('Vælg ENTEN --push ELLER --pull, ikke begge.');
        process.exit(1);
    }

    const db = openDb(process.env.DB_PATH);
    const rawRecipes = await grocyAdapter.getRecipesRaw();
    const recipeMap = {};
    for (const r of rawRecipes) recipeMap[r.id] = r;

    const catRows = db.prepare(`SELECT id, code FROM price_categories`).all();
    const idToCode = {};
    for (const c of catRows) idToCode[c.id] = c.code;

    const rows = db.prepare(`SELECT * FROM item_prices WHERE item_type = 'recipe'`).all();

    const diffs = [];
    for (const row of rows) {
        const recipe = recipeMap[row.item_id];
        if (!recipe) continue;   // recipe slettet i Grocy — rør ikke

        const code = idToCode[row.price_category_id];
        const userfield = CATEGORY_TO_USERFIELD[code];
        if (!userfield) continue;

        const grocyIncl = grocyNum((recipe.userfields || {})[userfield]);
        const grocyExcl = Number.isFinite(grocyIncl) && grocyIncl > 0 ? r2(inclToExcl(grocyIncl)) : null;
        const localExcl = r2(row.price);

        if (grocyExcl === null || Math.abs(grocyExcl - localExcl) > TOL) {
            diffs.push({ row, recipe, code, userfield, localExcl, grocyExcl });
        }
    }

    if (!diffs.length) {
        console.log(`Ingen diffs — item_prices og Grocy er allerede afstemt (${rows.length} rækker tjekket).`);
        process.exit(0);
    }

    console.log(`${diffs.length} diffs (af ${rows.length} rækker):\n`);
    for (const d of diffs) {
        console.log(`  ${d.recipe.name} [${d.code}]  lokalt ${d.localExcl} kr ex  ·  Grocy ${d.grocyExcl === null ? '(ingen pris)' : d.grocyExcl + ' kr ex'}`);
    }

    if (!PUSH && !PULL) {
        console.log('\nDry-run. Kør med --push (lokal → Grocy) eller --pull (Grocy → lokal) for at afstemme.');
        process.exit(0);
    }

    let done = 0;
    if (PUSH) {
        for (const d of diffs) {
            const incl = r2(exclToIncl(d.localExcl));
            await grocyAdapter.updateRecipeUserfields(d.row.item_id, { [d.userfield]: String(incl) });
            console.log(`  pushed: ${d.recipe.name} [${d.code}] → Grocy ${incl} kr incl`);
            done++;
        }
    } else {
        const upd = db.prepare(`UPDATE item_prices SET price = ?, updated_at = CURRENT_TIMESTAMP, updated_by_user_id = NULL WHERE id = ?`);
        const del = db.prepare(`DELETE FROM item_prices WHERE id = ?`);
        for (const d of diffs) {
            if (d.grocyExcl === null) {
                del.run(d.row.id);
                console.log(`  pulled: ${d.recipe.name} [${d.code}] — slettet lokalt (ingen Grocy-pris)`);
            } else {
                upd.run(d.grocyExcl, d.row.id);
                console.log(`  pulled: ${d.recipe.name} [${d.code}] → lokalt ${d.grocyExcl} kr ex`);
            }
            done++;
        }
    }
    console.log(`\nFærdig: ${done} rækker afstemt (${PUSH ? 'push' : 'pull'}).`);
}

main().catch(err => {
    console.error('FEJL:', err.message);
    process.exit(99);
});
