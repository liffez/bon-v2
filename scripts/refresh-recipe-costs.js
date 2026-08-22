// scripts/refresh-recipe-costs.js
// ==========================================
// Nightly refresh af recipe_cost_cache.
//
// Kostprisen regnes af `services/recipeCost.js` — IKKE af Grocys
// `/recipes/fulfillment`. Det felt viste sig upålideligt på fire uafhængige
// måder (#517): skaleret efter `desired_servings`, forældet, forkert for
// bundter (#455), og med forældre-produkter prissat til 0.
//
// Prisopslagene hører hjemme netop her: Grocy har ingen bulk-vej, så det
// koster 100+ kald. I et natligt job er det ligegyldigt; på en request-sti
// ville det ikke gå.
//
// Køres af system-crontab fx kl 03:00:
//   0 3 * * * cd /opt/bon-v2 && node --experimental-sqlite scripts/refresh-recipe-costs.js >> logs/recipe-costs.log 2>&1
//
// Færdigt før folk møder ind og før v1-sync kl 05.
// Scriptet:
//   1. Henter alle recipes fra Grocy (inkl. userfields)
//   2. Henter enhedskost pr. produkt (getProductUnitCosts)
//   3. Regner kostpris pr. opskrift og UPSERT'er recipe_cost_cache
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
const { syncPricesFromGrocy } = require('../services/itemPriceBackfill');
const recipeCost = require('../services/recipeCost');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function logLine(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    const t0 = Date.now();
    // openDb() kræver eksplicit sti (ingen default) — uden arg crasher scriptet
    const db = openDb(process.env.DB_PATH);

    // Verificér at recipe_cost_cache findes (migration 068 kørt)
    const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='recipe_cost_cache'`
    ).get();
    if (!tableExists) {
        logLine('FEJL: recipe_cost_cache findes ikke — kør migration 068');
        process.exit(1);
    }

    logLine('Henter opskrifter, priser og struktur fra Grocy...');
    let rawRecipes, pos, nestings, products, units, conversions, fulfillment, priser;
    try {
        [rawRecipes, pos, nestings, products, units, conversions, fulfillment] = await Promise.all([
            grocyAdapter.getRecipesRaw(),
            grocyAdapter.getAllRecipesPos(),
            grocyAdapter.getRecipeNestings(),
            grocyAdapter.getProducts(),
            grocyAdapter.getQuantityUnits(),
            grocyAdapter.getQuantityUnitConversions(),
            // Kun som nødspor: kan resolveren ikke regne en opskrift, er
            // Grocys tal bedre end ingenting — og det skal kunne ses at det
            // ER Grocys tal.
            grocyAdapter.getRecipeFulfillment().catch(() => []),
        ]);
        priser = await grocyAdapter.getProductUnitCosts();
    } catch (err) {
        logLine(`FEJL: Grocy ikke tilgængelig — ${err.message}`);
        process.exit(2);
    }
    logLine(`Priser kendt for ${priser.size} af ${products.length} produkter`);

    const beregnet = recipeCost.computeAll({
        recipes: rawRecipes, pos, nestings, products, units, conversions, priceByProduct: priser,
    });

    // Hvor mange opskrifter mangler mindst én pris? Et for lavt tal skal kunne
    // forklares, ikke bare være for lavt.
    const grocyCost = {};
    for (const f of (fulfillment || [])) grocyCost[f.recipe_id] = Number(f.costs) || 0;

    const ufuldstaendige = [...beregnet.values()].filter(r => !r.complete).length;
    if (ufuldstaendige) logLine(`${ufuldstaendige} opskrifter mangler pris på mindst én råvare`);

    const upsert = db.prepare(`
        INSERT INTO recipe_cost_cache (grocy_recipe_id, cost_price_excl_moms, ingredients_json, co2e,
                                       cost_source, missing_prices_json, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(grocy_recipe_id) DO UPDATE SET
            cost_price_excl_moms = excluded.cost_price_excl_moms,
            ingredients_json = excluded.ingredients_json,
            co2e = excluded.co2e,
            cost_source = excluded.cost_source,
            missing_prices_json = excluded.missing_prices_json,
            refreshed_at = CURRENT_TIMESTAMP
    `);

    let refreshed = 0;
    let errors = 0;
    for (const recipe of rawRecipes) {
        try {
            const uf = recipe.userfields || {};
            const b = beregnet.get(recipe.id);
            const co2e = parseFloat(uf.Co2e) || null;
            // `costprice`-userfeltet er sidste udvej — det er håndindtastet og
            // opdateres ikke af noget. Bruges kun hvis resolveren intet fandt.
            const harBeregning = b && (b.cost > 0 || b.complete);
            let cost, kilde;
            if (harBeregning) {
                cost = b.cost; kilde = 'bon';
            } else if (grocyCost[recipe.id] > 0) {
                cost = grocyCost[recipe.id]; kilde = 'grocy';
            } else if (parseFloat(uf.costprice) > 0) {
                cost = parseFloat(uf.costprice); kilde = 'userfield';
            } else {
                cost = 0; kilde = 'ukendt';
            }
            const mangler = b ? [...b.missing_price] : [];
            upsert.run(recipe.id, r2(cost), '[]', co2e, kilde, mangler.length ? JSON.stringify(mangler) : null);
            refreshed++;
        } catch (err) {
            errors++;
            logLine(`  fejl ved recipe ${recipe.id} (${recipe.name}): ${err.message}`);
        }
    }

    // Synk salgspriser Grocy → item_prices (Grocy er master)
    try {
        const sync = syncPricesFromGrocy(rawRecipes, { db });
        logLine(`Pris-sync: ${sync.updated} opdateret, ${sync.deleted} slettet (af ${sync.scanned} recipes)`);
    } catch (err) {
        errors++;
        logLine(`  fejl ved pris-sync: ${err.message}`);
    }

    const duration = Date.now() - t0;
    const kilder = db.prepare(
        `SELECT COALESCE(cost_source,'?') k, COUNT(*) n FROM recipe_cost_cache GROUP BY 1 ORDER BY n DESC`
    ).all().map(r => `${r.k}=${r.n}`).join(' · ');
    logLine(`Kilder: ${kilder}`);
    logLine(`Færdig: refreshed=${refreshed}, errors=${errors}, duration_ms=${duration}`);
    process.exit(errors > 0 ? 3 : 0);
}

main().catch(err => {
    logLine(`UNCAUGHT: ${err.message}`);
    process.exit(99);
});
