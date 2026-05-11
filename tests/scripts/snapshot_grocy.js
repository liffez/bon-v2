#!/usr/bin/env node
/**
 * tests/scripts/snapshot_grocy.js
 * ════════════════════════════════════════════════════════════
 * Henter de 8 testprodukters opskrifter, ingredienser og priser
 * fra Grocy test-instans og dumper til JSON-fixture.
 *
 * Output: tests/fixtures/grocy_snapshot.json
 *
 * Snapshottet er sandheden under test — ingrediens-aggregering
 * verificeres mod denne fil. Kør på ny når Grocy-data ændres.
 *
 * Usage:
 *   node tests/scripts/snapshot_grocy.js
 *
 * Forudsætninger:
 *   - .env.test loaded (NODE_ENV=test, GROCY_API_URL, GROCY_API_KEY)
 *   - safety_check.js bestået
 *   - 8 produkter findes som opskrifter i Grocy test-instansen
 *
 * Reference: docs/tests/specs/T_PLAN.md §5
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const safetyCheck  = require('./safety_check');

// De 8 testprodukter som de hedder i seed_planning.sql (alias).
// Mappes til faktiske Grocy-navne der ofte har leading spaces, citationstegn
// eller suffixer som "(emballage)". Sæt grocyName=null for produkter der ikke
// findes i grocytest endnu — de havner i `missing` og rapporteres som
// `lines_without_recipe` af /api/bons/planning/ingredients.
const TEST_PRODUCTS = [
    { alias: 'Falaflen',           grocyName: ' Falaflen' },              // bemærk leading space i Grocy
    { alias: 'Kyllingen',          grocyName: 'Kyllingen' },
    { alias: 'Tunen',              grocyName: '"Tunen"' },                // i citationstegn
    { alias: 'Kålen',              grocyName: 'Kålen - Salat' },
    { alias: 'Frikadellen-Slider', grocyName: null },                     // findes ikke i grocytest endnu
    { alias: 'RR Boks',            grocyName: 'RR Boks  (emballage)' },   // dobbelt-space + suffix
    { alias: 'Sliderbox',          grocyName: null },                     // findes ikke i grocytest endnu
    { alias: 'Transportkasse',     grocyName: 'Transportkasse (emballage)' },
];

const OUTPUT_PATH = path.resolve(
    __dirname, '..', 'fixtures', 'grocy_snapshot.json'
);

async function grocyGet(endpoint) {
    const baseUrl = process.env.GROCY_API_URL.replace(/\/$/, '');
    const url     = `${baseUrl}${endpoint}`;
    const apiKey  = process.env.GROCY_API_KEY;

    const res = await fetch(url, {
        headers: { 'GROCY-API-KEY': apiKey, 'Accept': 'application/json' }
    });

    if (!res.ok) {
        throw new Error(`Grocy ${res.status} på ${endpoint}: ${await res.text()}`);
    }
    return res.json();
}

async function main() {
    safetyCheck({ skipDb: true });

    console.log('[snapshot_grocy] Henter Grocy-data fra ' + process.env.GROCY_API_URL);

    // 1. Hent alle opskrifter (recipes) og find dem der matcher TEST_PRODUCTS
    const recipes = await grocyGet('/objects/recipes');
    const recipesByName = {};
    for (const r of recipes) recipesByName[r.name] = r;

    // 2. Hent recipe_pos (ingredienser) for at kunne udfolde
    //    Userfields hentes per-recipe nedenfor via /userfields/recipes/{id} —
    //    Grocy understøtter ikke GET på /userfields/recipes (kun OPTIONS).
    const recipePos = await grocyGet('/objects/recipes_pos');

    // 4. Hent products for ingrediens-data og enheder
    const products = await grocyGet('/objects/products');
    const productsById = {};
    for (const p of products) productsById[p.id] = p;

    // 5. Hent quantity_units for enhedskonvertering
    const quantityUnits = await grocyGet('/objects/quantity_units');
    const quByName = {};
    const quById   = {};
    for (const q of quantityUnits) {
        quByName[q.name] = q;
        quById[q.id]     = q;
    }

    // ── Saml snapshot ──
    const snapshot = {
        snapshot_at: new Date().toISOString(),
        grocy_url:   process.env.GROCY_API_URL,
        products:    {},     // { name → { recipe_id, prices, costprice, ingredients } }
        missing:     [],     // produkter vi ikke fandt
    };

    for (const { alias, grocyName } of TEST_PRODUCTS) {
        if (grocyName === null) {
            snapshot.missing.push({ alias, reason: 'mangler i grocytest' });
            console.warn(`  ⊘ Ikke i grocytest: ${alias} (mark som null i TEST_PRODUCTS)`);
            continue;
        }

        const recipe = recipesByName[grocyName];
        if (!recipe) {
            snapshot.missing.push({ alias, grocyName, reason: 'ikke fundet via navn-lookup' });
            console.warn(`  ⚠ Mappet til '${grocyName}' men findes ikke i Grocy: ${alias}`);
            continue;
        }

        // Hent userfield-værdier for denne opskrift
        let recipeUf = {};
        try {
            recipeUf = await grocyGet(`/userfields/recipes/${recipe.id}`);
        } catch (err) {
            console.warn(`  ⚠ Kunne ikke hente userfields for ${alias}: ${err.message}`);
        }

        // Find ingredienser (recipe_pos hvor recipe_id matcher)
        const ingredientRows = recipePos.filter(rp => rp.recipe_id == recipe.id);
        const ingredients    = ingredientRows.map(rp => {
            const product = productsById[rp.product_id] || {};
            const qu      = quById[rp.qu_id] || {};
            return {
                product_id:   parseInt(rp.product_id),
                product_name: product.name || `(unknown product ${rp.product_id})`,
                amount:       parseFloat(rp.amount),
                qu_id:        parseInt(rp.qu_id),
                qu_name:      qu.name || null,
                only_check_single_unit_in_stock: rp.only_check_single_unit_in_stock === '1',
            };
        });

        snapshot.products[alias] = {
            recipe_id:    parseInt(recipe.id),
            grocy_name:   recipe.name,                    // faktisk navn i Grocy (kan have whitespace etc.)
            description:  recipe.description || null,
            base_servings: parseFloat(recipe.base_servings) || 1,
            prices: {
                store:      parseFloat(recipeUf.SalespriceStore)      || 0,
                catering:   parseFloat(recipeUf.SalespriceCatering)   || 0,
                festival:   parseFloat(recipeUf.SalespriceFestival)   || 0,
                produktion: parseFloat(recipeUf.SalespriceProduktion) || 0,
                waiste:     parseFloat(recipeUf.SalespriceWaiste)     || 0,
            },
            costprice: parseFloat(recipeUf.costprice) || null,
            co2e:      parseFloat(recipeUf.Co2e) || null,
            sellable:  recipeUf.sellable === '1',
            ingredients,
        };

        console.log(`  ✓ ${alias} → '${recipe.name}' (id=${recipe.id}, ${ingredients.length} ingredienser)`);
    }

    // ── Skriv fil ──
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2));

    console.log('');
    console.log(`[snapshot_grocy] ✓ Skrevet til ${OUTPUT_PATH}`);
    console.log(`  Produkter fundet: ${Object.keys(snapshot.products).length} / ${TEST_PRODUCTS.length}`);
    if (snapshot.missing.length) {
        console.log(`  Manglende: ${snapshot.missing.map(m => m.alias).join(', ')}`);
        // Manglende med grocyName=null er bevidste (ikke i grocytest endnu) — exit 0.
        // Manglende med grocyName=string men ikke fundet → konfigurationsfejl, exit 1.
        const unexpected = snapshot.missing.filter(m => m.grocyName);
        if (unexpected.length) {
            console.log(`  Uventet manglende (mapped til navn der ikke findes): ${unexpected.map(m => m.grocyName).join(', ')}`);
            process.exit(1);
        }
    }
}

main().catch(err => {
    console.error('[snapshot_grocy] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
