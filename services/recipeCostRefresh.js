// services/recipeCostRefresh.js
// ==========================================
// Genberegning af `recipe_cost_cache` — ÉN implementation.
//
// HVORFOR EN SERVICE
// Beregningen fandtes to steder: det natlige script og knappen "Opdater
// priser" i Opskrifter & priser. Da kostprisen blev flyttet fra Grocy til
// Bon (#517), blev kun scriptet rettet — så et tryk på knappen skrev Grocys
// tal tilbage i cachen og rullede rettelsen tilbage uden at sige noget.
// To kopier af den samme beslutning driver fra hinanden; derfor kun én her.
//
// KILDE-RÆKKEFØLGE
//   1. `bon`       — resolverens egen beregning (services/recipeCost.js)
//   2. `grocy`     — nødspor: fulfillment.costs, når resolveren intet fandt
//   3. `userfield` — sidste udvej: håndindtastet `costprice`
//   4. `ukendt`    — intet tal findes. Gemmes som 0, men MÆRKET, så et
//                    dækningsbidrag på 100 % kan kendes fra et ægte.
//
// Kilden gemmes i `cost_source` (migration 153), fordi et tal uden ophav
// ikke kan efterprøves — og fordi 0 kr og "vi ved det ikke" ser ens ud.
//
// Spec: docs/CLAUDE_OPSKRIFTER.md
// ==========================================

const grocyAdapter = require('./grocyAdapter');
const recipeCost = require('./recipeCost');
const { syncPricesFromGrocy } = require('./itemPriceBackfill');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

/**
 * Henter alt fra Grocy, regner kostpris pr. opskrift og skriver cachen.
 *
 * Prisopslagene er dyre: Grocy har ingen bulk-vej for udsolgte varer, så
 * `getProductUnitCosts()` falder tilbage på ét kald pr. produkt uden lager.
 * Det er derfor det natlige job findes. Knappen kalder samme funktion —
 * langsom og rigtig slår hurtig og forkert.
 *
 * @param db        node:sqlite-database (getDb() eller openDb())
 * @param opts.log  valgfri logger (msg → void)
 * @returns {{refreshed, errors, errorDetails, sources, incomplete, unknown, priceSync}}
 */
async function refreshRecipeCosts(db, opts = {}) {
    const log = opts.log || (() => {});

    const [rawRecipes, pos, nestings, products, units, conversions, fulfillment] = await Promise.all([
        grocyAdapter.getRecipesRaw(),
        grocyAdapter.getAllRecipesPos(),
        grocyAdapter.getRecipeNestings(),
        grocyAdapter.getProducts(),
        grocyAdapter.getQuantityUnits(),
        grocyAdapter.getQuantityUnitConversions(),
        // Nødspor. Er Grocy delvist nede, skal resten stadig kunne regnes —
        // derfor .catch her og ikke omkring hele Promise.all.
        grocyAdapter.getRecipeFulfillment().catch(() => []),
    ]);
    const priser = await grocyAdapter.getProductUnitCosts();
    log(`Priser kendt for ${priser.size} af ${products.length} produkter`);

    const beregnet = recipeCost.computeAll({
        recipes: rawRecipes, pos, nestings, products, units, conversions, priceByProduct: priser,
    });

    const grocyCost = {};
    for (const f of (fulfillment || [])) grocyCost[f.recipe_id] = Number(f.costs) || 0;

    const upsert = db.prepare(`
        INSERT INTO recipe_cost_cache (grocy_recipe_id, cost_price_excl_moms, ingredients_json, co2e,
                                       cost_source, missing_prices_json, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(grocy_recipe_id) DO UPDATE SET
            cost_price_excl_moms = excluded.cost_price_excl_moms,
            ingredients_json     = excluded.ingredients_json,
            co2e                 = excluded.co2e,
            cost_source          = excluded.cost_source,
            missing_prices_json  = excluded.missing_prices_json,
            refreshed_at         = CURRENT_TIMESTAMP
    `);

    const sources = {};
    let refreshed = 0, incomplete = 0, unknown = 0;
    const errorDetails = [];

    for (const recipe of rawRecipes) {
        try {
            const uf = recipe.userfields || {};
            const b = beregnet.get(recipe.id);
            const co2e = parseFloat(uf.Co2e) || null;

            // `b.cost > 0 || b.complete` — en opskrift der lovligt koster 0
            // (fx en ren emballage-linje til 0 kr) er stadig en beregning.
            let cost, kilde;
            if (b && (b.cost > 0 || b.complete)) {
                cost = b.cost; kilde = 'bon';
            } else if (grocyCost[recipe.id] > 0) {
                cost = grocyCost[recipe.id]; kilde = 'grocy';
            } else if (parseFloat(uf.costprice) > 0) {
                cost = parseFloat(uf.costprice); kilde = 'userfield';
            } else {
                cost = 0; kilde = 'ukendt';
            }

            const mangler = b ? [...b.missing_price] : [];
            if (mangler.length) incomplete++;
            if (kilde === 'ukendt') unknown++;
            sources[kilde] = (sources[kilde] || 0) + 1;

            upsert.run(recipe.id, r2(cost), '[]', co2e, kilde,
                       mangler.length ? JSON.stringify(mangler) : null);
            refreshed++;
        } catch (err) {
            errorDetails.push({ recipe_id: recipe.id, name: recipe.name, error: err.message });
        }
    }

    if (incomplete) log(`${incomplete} opskrifter mangler pris på mindst én råvare`);
    if (unknown) log(`${unknown} opskrifter har INGEN kendt kostpris`);

    // Salgspriser: Grocy er master. Redigeringer i viewet skrives allerede
    // tilbage til Grocy, så overskrivning er sikker.
    let priceSync = null;
    try {
        priceSync = syncPricesFromGrocy(rawRecipes, { db });
    } catch (err) {
        errorDetails.push({ price_sync: true, error: err.message });
    }

    return {
        refreshed,
        errors: errorDetails.length,
        errorDetails,
        sources,
        incomplete,
        unknown,
        priceSync,
    };
}

/**
 * Hvad betyder en række i `recipe_cost_cache`?
 *
 * Ligger her ved siden af den kode der SKRIVER rækken, så betydningen af
 * `cost_source` og `missing_prices_json` kun er defineret ét sted.
 *
 *   unknown    intet brugbart tal — der findes ingen margin at vise
 *   isMinimum  tallet er en NEDRE grænse; dækningsbidraget bliver et maksimum
 *
 * En vare vi køber og sælger videre uden registreret pris (fx en øl) lander i
 * `unknown`. Uden det ville den vise 100 % dækningsbidrag, og det tal ville se
 * fuldstændig ægte ud.
 *
 * @param row  række fra recipe_cost_cache (eller null/undefined)
 */
function classifyCachedCost(row) {
    if (!row) return { cost: null, source: null, unknown: false, isMinimum: false, missing: [] };

    let missing = [];
    if (row.missing_prices_json) {
        try { missing = JSON.parse(row.missing_prices_json) || []; } catch { missing = []; }
    } else if (Array.isArray(row.missing)) {
        missing = row.missing;
    }

    const cost = Number(row.cost_price_excl_moms ?? row.cost);
    const source = row.cost_source ?? row.source ?? null;
    // Et positivt tal er brugbart, også selvom en enkelt krydderipris mangler.
    // Er tallet 0 OG noget mangler, ved vi reelt ingenting.
    const unknown = source === 'ukendt' || (missing.length > 0 && !(cost > 0));
    const isMinimum = missing.length > 0 && !unknown;

    return {
        cost: unknown ? null : (Number.isFinite(cost) ? cost : null),
        source, unknown, isMinimum, missing,
    };
}

module.exports = { refreshRecipeCosts, classifyCachedCost };
