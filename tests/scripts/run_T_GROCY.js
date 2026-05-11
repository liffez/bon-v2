#!/usr/bin/env node
/**
 * tests/scripts/run_T_GROCY.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_GROCY — adapter-tests.
 *
 * Tester read-funktioner i grocyAdapter, cache-adfærd, og
 * ingredient-resolver. Skrive-operationer (consume) er SKIP'et.
 *
 * Ingen test-server nødvendig — adapteren kalder Grocy direkte.
 *
 * Usage:
 *   npm run test:run-grocy
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_GROCY.js --verbose
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt (grocyAdapter henter location-config fra DB)
 *   - grocytest.ristetrug.dk er oppe
 *
 * Reference: tests/specs/T_GROCY.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const safetyCheck  = require('./safety_check');

const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const VERBOSE    = process.argv.includes('--verbose');

const results = [];
function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')      console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP') console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)           console.log(`  ✓ ${id}`);
}

function assertEq(id, group, expected, actual, label = '') {
    if (JSON.stringify(expected) === JSON.stringify(actual)) {
        record(id, group, 'PASS');
    } else {
        record(id, group, 'FAIL', `${label}: forventet ${JSON.stringify(expected)}, fik ${JSON.stringify(actual)}`);
    }
}

function assertTrue(id, group, condition, label = '') {
    if (condition) {
        record(id, group, 'PASS');
    } else {
        record(id, group, 'FAIL', label);
    }
}

// ════════════════════════════════════════════════════════════
// 2.1 Read-funktioner
// ════════════════════════════════════════════════════════════

async function runReadTests(grocy) {
    console.log('\n── 2.1 Read-funktioner ──');

    // R_01: getRecipes returnerer >= 1
    let recipes;
    try {
        recipes = await grocy.getRecipes();
        assertTrue('T_GROCY_R_01', 'R', recipes.length > 0, `getRecipes() returnerede ${recipes.length} recipes`);
    } catch (err) {
        record('T_GROCY_R_01', 'R', 'FAIL', `getRecipes() kastede: ${err.message}`);
        return null;
    }

    // R_02: hver recipe har required fields (faktisk shape fra grocyAdapter — flat struct)
    const required = ['id', 'name', 'category', 'unit', 'unit_number', 'prices', 'cost_price'];
    const firstRecipe = recipes[0];
    const missing = required.filter(f => !(f in firstRecipe));
    assertEq('T_GROCY_R_02', 'R', [], missing, 'Manglende felter på recipe');

    // R_03: getProducts
    try {
        const products = await grocy.getProducts();
        assertTrue('T_GROCY_R_03', 'R', products.length > 0, `getProducts() returnerede ${products.length}`);
    } catch (err) {
        record('T_GROCY_R_03', 'R', 'FAIL', err.message);
    }

    // R_04: getStock
    try {
        const stock = await grocy.getStock();
        assertTrue('T_GROCY_R_04', 'R', Array.isArray(stock), 'getStock() er ikke array');
    } catch (err) {
        record('T_GROCY_R_04', 'R', 'FAIL', err.message);
    }

    // R_05: getQuantityUnits
    try {
        const qus = await grocy.getQuantityUnits();
        const ok = qus.length > 0 && qus.every(q => 'name' in q && 'id' in q);
        assertTrue('T_GROCY_R_05', 'R', ok, `getQuantityUnits returnerede ${qus.length}`);
    } catch (err) {
        record('T_GROCY_R_05', 'R', 'FAIL', err.message);
    }

    // R_06: getRecipeIngredients(88) (Kyllingen — fra snapshot har 5 ingredienser)
    try {
        const ing = await grocy.getRecipeIngredients(88);
        assertTrue('T_GROCY_R_06', 'R', ing.length === 5, `Forventet 5 ingredienser på recipe 88, fik ${ing.length}`);
    } catch (err) {
        record('T_GROCY_R_06', 'R', 'FAIL', err.message);
    }

    // R_07: getRecipeNestings
    try {
        const nestings = await grocy.getRecipeNestings();
        assertTrue('T_GROCY_R_07', 'R', Array.isArray(nestings), 'getRecipeNestings ikke array');
    } catch (err) {
        record('T_GROCY_R_07', 'R', 'FAIL', err.message);
    }

    // R_08: getAllRecipesPos
    try {
        const pos = await grocy.getAllRecipesPos();
        assertTrue('T_GROCY_R_08', 'R', pos.length > 0, `getAllRecipesPos returnerede ${pos.length}`);
    } catch (err) {
        record('T_GROCY_R_08', 'R', 'FAIL', err.message);
    }

    return recipes;
}

// ════════════════════════════════════════════════════════════
// 2.2 Cache
// ════════════════════════════════════════════════════════════

async function runCacheTests(grocy) {
    console.log('\n── 2.2 Cache ──');

    // Ryd cache først så vi måler cold + warm korrekt
    grocy.clearCache && grocy.clearCache();

    const t1Start = Date.now();
    await grocy.getRecipes();
    const t1 = Date.now() - t1Start;

    const t2Start = Date.now();
    await grocy.getRecipes();
    const t2 = Date.now() - t2Start;

    // Cache-hit skal være væsentligt hurtigere — vi accepterer t2 < t1/2 eller t2 < 5ms
    assertTrue('T_GROCY_C_01', 'C', t2 < Math.max(t1 / 2, 5),
        `Andet kald (${t2}ms) skal være hurtigere end første (${t1}ms)`);

    if (typeof grocy.clearCache === 'function') {
        grocy.clearCache();
        const t3Start = Date.now();
        await grocy.getRecipes();
        const t3 = Date.now() - t3Start;
        // Efter clearCache skal det være langsommere igen — accept variation, men > 5ms
        assertTrue('T_GROCY_C_02', 'C', t3 > 5,
            `Efter clearCache skal kald være langsom igen (fik ${t3}ms)`);
    } else {
        record('T_GROCY_C_02', 'C', 'SKIP', 'clearCache er ikke eksporteret');
    }
}

// ════════════════════════════════════════════════════════════
// 2.3 Ingredient resolver
// ════════════════════════════════════════════════════════════

async function runResolverTests(resolver) {
    console.log('\n── 2.3 Ingredient resolver ──');

    // Test-bon: 4001 har Falaflen 30, Kyllingen 20, RR Boks 50, Transportkasse 3
    // Efter test:patch er deres grocy_recipe_id'er sat
    const { openDb } = require('../../db/compat');
    const db = openDb(process.env.DB_PATH);
    const lines = db.prepare(
        `SELECT id, bon_id, grocy_recipe_id, product_name, quantity, unit
         FROM bon_lines WHERE bon_id = 4001 ORDER BY sort_order`
    ).all();
    db.close();

    // IR_01: resolveIngredients returnerer production + raw
    try {
        const result = await resolver.resolveIngredients(lines);
        const hasProduction = result && result.production && Array.isArray(result.production.ingredients);
        const hasRaw = result && result.raw && Array.isArray(result.raw.ingredients);
        assertTrue('T_GROCY_IR_01', 'IR', hasProduction && hasRaw,
            `production=${hasProduction}, raw=${hasRaw}`);
    } catch (err) {
        record('T_GROCY_IR_01', 'IR', 'FAIL', err.message);
    }

    // IR_02: 2x quantity giver 2x mængder
    try {
        const lines2x = lines.map(l => ({ ...l, quantity: l.quantity * 2 }));
        const r1 = await resolver.resolveIngredients(lines);
        const r2 = await resolver.resolveIngredients(lines2x);

        // Find samme ingrediens i begge resultater og sammenlign mængde
        const ing1 = r1.raw.ingredients[0];
        const ing2 = r2.raw.ingredients.find(i => i.product_name === ing1.product_name);

        if (!ing1 || !ing2) {
            record('T_GROCY_IR_02', 'IR', 'SKIP', 'Kunne ikke finde sammenlignelig ingrediens');
        } else {
            const ratio = ing2.amount_needed / ing1.amount_needed;
            assertTrue('T_GROCY_IR_02', 'IR', Math.abs(ratio - 2) < 0.01,
                `2x linjer skal give 2x mængde — fik ratio ${Number.isFinite(ratio) ? ratio.toFixed(3) : ratio}`);
        }
    } catch (err) {
        record('T_GROCY_IR_02', 'IR', 'FAIL', err.message);
    }

    // IR_03: resolveConsumeItems returnerer per-produkt mængder
    try {
        const items = await resolver.resolveConsumeItems(lines);
        const ok = Array.isArray(items) && items.length > 0
            && items.every(i => 'product_id' in i && 'amount_stock' in i);
        assertTrue('T_GROCY_IR_03', 'IR', ok,
            `resolveConsumeItems returnerede ${items.length} items`);
    } catch (err) {
        record('T_GROCY_IR_03', 'IR', 'FAIL', err.message);
    }

    // IR_04: linjer uden grocy_recipe_id ekskluderes
    try {
        const linesNoRecipe = lines.map(l => ({ ...l, grocy_recipe_id: 0 }));
        const items = await resolver.resolveConsumeItems(linesNoRecipe);
        assertEq('T_GROCY_IR_04', 'IR', 0, items.length,
            'Linjer uden grocy_recipe_id skal ekskluderes');
    } catch (err) {
        record('T_GROCY_IR_04', 'IR', 'FAIL', err.message);
    }
}

// ════════════════════════════════════════════════════════════
// 2.4 Skrive-operationer (SKIP)
// ════════════════════════════════════════════════════════════

function runWriteTests() {
    console.log('\n── 2.4 Skrive-operationer (SKIP) ──');
    record('T_GROCY_W_01', 'W', 'SKIP',
        'consumeRecipes — kræver isoleret test-stock. Implementeres senere.');
    record('T_GROCY_W_02', 'W', 'SKIP',
        'LEVERET → IGANG tilbageføring — afventer T_GROCY_W_01.');
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_GROCY_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['R','C','IR','W'];
    let md = `# T_GROCY — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** Grocy: ${process.env.GROCY_API_URL} · DB: ${process.env.DB_PATH}\n\n`;
    md += `## Resumé\n\n**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `| Gruppe | PASS | FAIL | SKIP |\n|--------|-----:|-----:|-----:|\n`;
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        md += `| ${g} | ${inGroup.filter(r => r.status === 'PASS').length} | ${inGroup.filter(r => r.status === 'FAIL').length} | ${inGroup.filter(r => r.status === 'SKIP').length} |\n`;
    }

    if (fails > 0) {
        md += `\n## Fejl\n\n| ID | Detalje |\n|----|---------|\n`;
        for (const f of results.filter(r => r.status === 'FAIL')) {
            md += `| ${f.id} | ${f.detail.replace(/\|/g, '\\|')} |\n`;
        }
    }

    md += `\n## Alle cases\n\n| ID | Gruppe | Status | Note |\n|----|--------|--------|------|\n`;
    for (const r of results) {
        md += `| ${r.id} | ${r.group} | ${r.status} | ${(r.detail || '').replace(/\|/g, '\\|')} |\n`;
    }

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_GROCY] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    // grocyAdapter henter location-config via getDb() (singleton).
    // For at det virker mod test.db skal vi sikre at processens DB_PATH peger derhen
    // FØR vi loader adapteren.
    const grocy    = require('../../services/grocyAdapter');
    const resolver = require('../../services/ingredientResolver');

    await runReadTests(grocy);
    await runCacheTests(grocy);
    await runResolverTests(resolver);
    runWriteTests();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_GROCY] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_GROCY] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
