// scripts/refresh-recipe-costs.js
// ==========================================
// Nightly refresh af recipe_cost_cache fra Grocy fulfillment.
//
// Køres af system-crontab fx kl 03:00:
//   0 3 * * * cd /opt/bon-v2 && node --experimental-sqlite scripts/refresh-recipe-costs.js >> logs/recipe-costs.log 2>&1
//
// Færdigt før folk møder ind og før v1-sync kl 05.
// Scriptet:
//   1. Henter alle recipes fra Grocy (inkl. userfields)
//   2. Henter /recipes/fulfillment (cost-beregning pr. opskrift)
//   3. UPSERT'er recipe_cost_cache pr. recipe_id
//   4. Enkelt fejlende recipe afbryder ikke batch
//
// Spec: docs/CLAUDE_OPSKRIFTER.md
// ==========================================

const path = require('path');
const fs = require('fs');

// Load .env (Grocy API-credentials osv.)
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

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function logLine(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    const t0 = Date.now();
    const db = openDb();

    // Verificér at recipe_cost_cache findes (migration 068 kørt)
    const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='recipe_cost_cache'`
    ).get();
    if (!tableExists) {
        logLine('FEJL: recipe_cost_cache findes ikke — kør migration 068');
        process.exit(1);
    }

    logLine('Henter recipes + fulfillment fra Grocy...');
    let rawRecipes, fulfillment;
    try {
        [rawRecipes, fulfillment] = await Promise.all([
            grocyAdapter.getRecipesRaw(),
            grocyAdapter.getRecipeFulfillment(),
        ]);
    } catch (err) {
        logLine(`FEJL: Grocy ikke tilgængelig — ${err.message}`);
        process.exit(2);
    }

    const costMap = {};
    for (const f of fulfillment) costMap[f.recipe_id] = f.costs ?? 0;

    const upsert = db.prepare(`
        INSERT INTO recipe_cost_cache (grocy_recipe_id, cost_price_excl_moms, ingredients_json, co2e, refreshed_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(grocy_recipe_id) DO UPDATE SET
            cost_price_excl_moms = excluded.cost_price_excl_moms,
            ingredients_json = excluded.ingredients_json,
            co2e = excluded.co2e,
            refreshed_at = CURRENT_TIMESTAMP
    `);

    let refreshed = 0;
    let errors = 0;
    for (const recipe of rawRecipes) {
        try {
            const uf = recipe.userfields || {};
            const cost = costMap[recipe.id] ?? (parseFloat(uf.costprice) || 0);
            const co2e = parseFloat(uf.Co2e) || null;
            upsert.run(recipe.id, r2(cost), '[]', co2e);
            refreshed++;
        } catch (err) {
            errors++;
            logLine(`  fejl ved recipe ${recipe.id} (${recipe.name}): ${err.message}`);
        }
    }

    const duration = Date.now() - t0;
    logLine(`Færdig: refreshed=${refreshed}, errors=${errors}, duration_ms=${duration}`);
    process.exit(errors > 0 ? 3 : 0);
}

main().catch(err => {
    logLine(`UNCAUGHT: ${err.message}`);
    process.exit(99);
});
