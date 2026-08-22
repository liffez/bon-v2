// scripts/refresh-recipe-costs.js
// ==========================================
// Nightly refresh af recipe_cost_cache.
//
// Kostprisen regnes af `services/recipeCost.js` — IKKE af Grocys
// `/recipes/fulfillment`. Det felt viste sig upålideligt på fire uafhængige
// måder (#517): skaleret efter `desired_servings`, forældet, forkert for
// bundter (#455), og med forældre-produkter prissat til 0.
//
// Prisopslagene er dyre: Grocy har ingen bulk-vej for udsolgte varer, så
// `getProductUnitCosts()` falder tilbage på ét kald pr. produkt uden lager.
// Derfor findes det natlige job. Knappen "Opdater priser" i viewet regner
// det samme og tager derfor også tid — men langsom og rigtig slår hurtig og
// forkert, og det var netop dét valg der gik galt.
//
// Køres af system-crontab fx kl 03:00:
//   0 3 * * * cd /opt/bon-v2 && node --experimental-sqlite scripts/refresh-recipe-costs.js >> logs/recipe-costs.log 2>&1
//
// Færdigt før folk møder ind og før v1-sync kl 05.
// Selve beregningen ligger i `services/recipeCostRefresh.js`, som knappen
// "Opdater priser" i Opskrifter & priser kalder PRAECIS samme vej. To kopier
// af den beslutning drev fra hinanden en gang og skrev Grocys tal tilbage i
// cachen; derfor kun en.
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
const { refreshRecipeCosts } = require('../services/recipeCostRefresh');

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
    let out;
    try {
        out = await refreshRecipeCosts(db, { log: logLine });
    } catch (err) {
        logLine(`FEJL: Grocy ikke tilgaengelig - ${err.message}`);
        process.exit(2);
    }

    const refreshed = out.refreshed;
    const errors = out.errors;
    out.errorDetails.forEach(e => logLine(`  fejl: ${e.name || e.recipe_id || 'pris-sync'} - ${e.error}`));
    if (out.priceSync) {
        logLine(`Pris-sync: ${out.priceSync.updated} opdateret, ${out.priceSync.deleted} slettet (af ${out.priceSync.scanned} recipes)`);
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
