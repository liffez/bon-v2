#!/usr/bin/env node
/**
 * tests/scripts/patch_grocy_recipe_ids.js
 * ════════════════════════════════════════════════════════════
 * Opdaterer bon_lines.grocy_recipe_id baseret på product_name
 * ved at slå navn op i tests/fixtures/grocy_snapshot.json.
 *
 * Hvorfor:
 *   seed_planning.sql sætter grocy_recipe_id=0 (placeholder), fordi
 *   recipe-ID'er først kendes når Grocy er snapshot'et. Uden denne
 *   patch returnerer /api/bons/planning/ingredients tomme arrays for
 *   alle linjer (de havner i lines_without_recipe), og niveau B-tests
 *   tester ikke noget reelt.
 *
 * Køres efter:
 *   1. npm run test:reset       (frisk test.db + seed)
 *   2. npm run test:snapshot    (skriver grocy_snapshot.json)
 *   3. npm run test:patch       (DENNE)
 *
 * Usage:
 *   node --env-file=.env.test --experimental-sqlite \
 *       tests/scripts/patch_grocy_recipe_ids.js
 *
 * Reference: tests/specs/T_PLAN.md §5
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb, transaction } = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const SNAPSHOT_PATH = path.resolve(__dirname, '..', 'fixtures', 'grocy_snapshot.json');

if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`[patch] grocy_snapshot.json mangler — kør 'npm run test:snapshot' først.`);
    console.error(`[patch] Forventet sti: ${SNAPSHOT_PATH}`);
    process.exit(1);
}

safetyCheck();

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const db       = openDb(process.env.DB_PATH);

// Byg navn → recipe_id map
const nameToRecipeId = {};
for (const [name, data] of Object.entries(snapshot.products)) {
    if (data.recipe_id) nameToRecipeId[name] = data.recipe_id;
}

console.log(`[patch] Snapshot har ${Object.keys(nameToRecipeId).length} produkter med recipe_id`);

// Find alle bon_lines hvor grocy_recipe_id=0 (eller NULL) og bon_id er i test-range
const lines = db.prepare(`
    SELECT bl.id, bl.bon_id, bl.product_name
    FROM bon_lines bl
    WHERE bl.bon_id BETWEEN 4001 AND 4008
      AND (bl.grocy_recipe_id = 0 OR bl.grocy_recipe_id IS NULL)
`).all();

console.log(`[patch] ${lines.length} bon-linjer skal opdateres`);

const update = db.prepare('UPDATE bon_lines SET grocy_recipe_id = ? WHERE id = ?');

let updated = 0;
const missing = new Set();

transaction(db, () => {
    for (const line of lines) {
        const recipeId = nameToRecipeId[line.product_name];
        if (recipeId) {
            update.run(recipeId, line.id);
            updated++;
        } else {
            missing.add(line.product_name);
        }
    }
});

console.log(`[patch] ✓ ${updated} linjer opdateret`);

if (missing.size > 0) {
    console.log(`[patch] ⚠ Manglende i snapshot (${missing.size}):`);
    for (const name of missing) console.log(`   - ${name}`);
    console.log(`[patch] Disse linjer beholder grocy_recipe_id=0 og rapporteres som lines_without_recipe.`);
}

db.close();
