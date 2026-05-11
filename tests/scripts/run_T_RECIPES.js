#!/usr/bin/env node
/**
 * tests/scripts/run_T_RECIPES.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_RECIPES-tracken.
 *
 * Tester recipe-CRUD via vores Grocy proxy:
 *   - POST/PUT /recipes
 *   - PUT /recipes/:id/userfields
 *   - POST/PUT/DELETE /recipes-pos (ingredienser)
 *   - POST/PUT/DELETE /recipes-nestings (underopskrifter)
 *
 * Recipe-deletion sker via direkte Grocy-kald (vi har intet DELETE-endpoint
 * for recipes). Det er kun cleanup-infrastruktur — selve testene bruger
 * altid vores proxy.
 *
 * Usage:
 *   npm run test:run-recipes
 *   node tests/scripts/run_T_RECIPES.js --verbose
 *   node tests/scripts/run_T_RECIPES.js --skip-cleanup  (debugging — efterlader orphans)
 *
 * Reference: tests/specs/T_RECIPES.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const SERVER_URL    = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const GROCY_URL     = process.env.GROCY_API_URL;
const GROCY_API_KEY = process.env.GROCY_API_KEY;
const REPORT_DIR    = path.resolve(__dirname, '..', 'reports');

const args = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const NAME_PREFIX = 'T_RECIPES_';
const TEST_PRODUCT_ID = 87;  // Affaldsposer — disjoint fra T_INVENTORY's recipe-ingredienser
const TEST_PRODUCT_QU_ID = 8; // qu_id_stock for pid=87

// Tracker over recipes oprettet undervejs — cleanup'es til sidst hvis ikke per-case-rydet
const createdRecipeIds = new Set();

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

let db;
const results = [];

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')       console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP')  console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)            console.log(`  ✓ ${id}`);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res  = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

/**
 * Direkte Grocy-kald — KUN til cleanup af recipes (vi har intet DELETE-endpoint).
 * Safety-check har bekræftet at GROCY_URL indeholder "test".
 */
async function grocyDeleteDirect(objectPath) {
    if (!GROCY_API_KEY) throw new Error('GROCY_API_KEY mangler i .env.test');
    if (!GROCY_URL.includes('test')) throw new Error('GROCY_URL peger ikke på test-instans — afviser DELETE');
    const url = `${GROCY_URL}${objectPath}`;
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'GROCY-API-KEY': GROCY_API_KEY }
    });
    const text = await res.text();
    return { status: res.status, raw: text };
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ════════════════════════════════════════════════════════════
// Recipe helpers
// ════════════════════════════════════════════════════════════

/**
 * Opret en transient test-recipe. Tilføjer id til createdRecipeIds så cleanup kan finde den.
 * Returnerer id eller kaster ved fejl.
 */
async function createTestRecipe(suffix, extraFields = {}) {
    const name = `${NAME_PREFIX}${suffix}_${timestamp()}`;
    const payload = {
        name,
        base_servings: 1,
        desired_servings: 1,
        type: 'normal',
        not_check_shoppinglist: 0,
        ...extraFields
    };
    const res = await api('POST', '/api/grocy/recipes', payload);
    if (res.status !== 200) {
        throw new Error(`createTestRecipe(${suffix}): status=${res.status} body=${res.raw.slice(0,200)}`);
    }
    const id = res.body && res.body.created_object_id;
    if (!id) {
        throw new Error(`createTestRecipe(${suffix}): mangler created_object_id i response: ${JSON.stringify(res.body)}`);
    }
    createdRecipeIds.add(parseInt(id));
    return { id: parseInt(id), name };
}

async function getRecipeById(id) {
    const res = await api('GET', '/api/grocy/recipes/raw');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`GET recipes/raw fejlede: ${res.status}`);
    }
    return res.body.find(r => parseInt(r.id) === parseInt(id)) || null;
}

async function deleteTestRecipe(id) {
    if (!id) return;
    const res = await grocyDeleteDirect(`/objects/recipes/${id}`);
    if (res.status >= 200 && res.status < 300) {
        createdRecipeIds.delete(parseInt(id));
        return true;
    }
    if (res.status === 404) {
        createdRecipeIds.delete(parseInt(id));
        return true;
    }
    console.warn(`  ⚠ deleteTestRecipe(${id}): status=${res.status}`);
    return false;
}

// ════════════════════════════════════════════════════════════
// SETUP-cases
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── SETUP ─────────────────────────');

    // T_RECIPES_SETUP_01 — GET endpoints svarer
    try {
        const r1 = await api('GET', '/api/grocy/recipes/raw');
        const r2 = await api('GET', '/api/grocy/recipes-pos/all');
        const r3 = await api('GET', '/api/grocy/recipes-nestings');
        const ok = r1.status === 200 && Array.isArray(r1.body)
                && r2.status === 200 && Array.isArray(r2.body)
                && r3.status === 200 && Array.isArray(r3.body);
        if (ok) {
            record('T_RECIPES_SETUP_01', 'SETUP', 'PASS',
                `recipes=${r1.body.length}, pos=${r2.body.length}, nestings=${r3.body.length}`);
        } else {
            record('T_RECIPES_SETUP_01', 'SETUP', 'FAIL',
                `status: ${r1.status}/${r2.status}/${r3.status}`);
            return false;
        }
    } catch (err) {
        record('T_RECIPES_SETUP_01', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // T_RECIPES_SETUP_02 — direkte Grocy DELETE virker
    try {
        const canary = await createTestRecipe('SETUP_CANARY');
        const ok = await deleteTestRecipe(canary.id);
        if (!ok) {
            record('T_RECIPES_SETUP_02', 'SETUP', 'FAIL',
                `Direkte DELETE fejlede på canary recipe ${canary.id}`);
            return false;
        }
        // Bekræft at den faktisk er væk
        const lookup = await getRecipeById(canary.id);
        if (lookup === null) {
            record('T_RECIPES_SETUP_02', 'SETUP', 'PASS',
                `Canary recipe ${canary.id} oprettet og slettet via direkte Grocy DELETE`);
        } else {
            record('T_RECIPES_SETUP_02', 'SETUP', 'FAIL',
                `Canary recipe ${canary.id} eksisterer stadig efter DELETE`);
            return false;
        }
    } catch (err) {
        record('T_RECIPES_SETUP_02', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // T_RECIPES_SETUP_03 — test-produkt eksisterer
    try {
        const res = await api('GET', '/api/grocy/products');
        const p = (res.body || []).find(p => parseInt(p.id) === TEST_PRODUCT_ID);
        if (p && p.active === 1) {
            record('T_RECIPES_SETUP_03', 'SETUP', 'PASS',
                `pid=${TEST_PRODUCT_ID} (${p.name}) aktiv`);
        } else {
            record('T_RECIPES_SETUP_03', 'SETUP', 'FAIL',
                `pid=${TEST_PRODUCT_ID} ikke fundet eller inaktiv`);
            return false;
        }
    } catch (err) {
        record('T_RECIPES_SETUP_03', 'SETUP', 'FAIL', err.message);
        return false;
    }

    return true;
}

// ════════════════════════════════════════════════════════════
// CREATE recipe
// ════════════════════════════════════════════════════════════

async function runCreateCases() {
    console.log('\n── CREATE (recipes) ─────────────');

    // T_RECIPES_CREATE_01 — basal create
    let r01Id = null;
    try {
        const created = await createTestRecipe('CREATE_01');
        r01Id = created.id;
        const lookup = await getRecipeById(r01Id);
        if (lookup && lookup.name === created.name && lookup.base_servings === 1) {
            record('T_RECIPES_CREATE_01', 'CREATE', 'PASS',
                `id=${r01Id} name="${created.name}"`);
        } else {
            record('T_RECIPES_CREATE_01', 'CREATE', 'FAIL',
                `lookup=${JSON.stringify(lookup)}`);
        }
    } catch (err) {
        record('T_RECIPES_CREATE_01', 'CREATE', 'FAIL', err.message);
    }
    if (r01Id && !SKIP_CLEANUP) await deleteTestRecipe(r01Id);

    // T_RECIPES_CREATE_02 — create med description
    let r02Id = null;
    try {
        const created = await createTestRecipe('CREATE_02', {
            description: 'T_RECIPES test-opskrift med description',
            base_servings: 3
        });
        r02Id = created.id;
        const lookup = await getRecipeById(r02Id);
        if (lookup
            && lookup.description === 'T_RECIPES test-opskrift med description'
            && lookup.base_servings === 3) {
            record('T_RECIPES_CREATE_02', 'CREATE', 'PASS',
                `id=${r02Id} description og base_servings=3 sat`);
        } else {
            record('T_RECIPES_CREATE_02', 'CREATE', 'FAIL',
                `desc='${lookup && lookup.description}', base_servings=${lookup && lookup.base_servings}`);
        }
    } catch (err) {
        record('T_RECIPES_CREATE_02', 'CREATE', 'FAIL', err.message);
    }
    if (r02Id && !SKIP_CLEANUP) await deleteTestRecipe(r02Id);
}

// ════════════════════════════════════════════════════════════
// UPDATE recipe + userfields
// ════════════════════════════════════════════════════════════

async function runUpdateCases() {
    console.log('\n── UPDATE (recipes + userfields) ─');

    // T_RECIPES_UPDATE_01 — opdater navn + description
    let rId = null;
    try {
        const created = await createTestRecipe('UPDATE_01');
        rId = created.id;
        const newName = `${created.name}_RENAMED`;
        const r = await api('PUT', `/api/grocy/recipes/${rId}`, {
            name: newName,
            description: 'Updated description'
        });
        if (r.status !== 200) {
            record('T_RECIPES_UPDATE_01', 'UPDATE', 'FAIL',
                `PUT status=${r.status}`);
        } else {
            const lookup = await getRecipeById(rId);
            if (lookup && lookup.name === newName && lookup.description === 'Updated description') {
                record('T_RECIPES_UPDATE_01', 'UPDATE', 'PASS',
                    `id=${rId} renamed + description sat`);
            } else {
                record('T_RECIPES_UPDATE_01', 'UPDATE', 'FAIL',
                    `name='${lookup && lookup.name}', desc='${lookup && lookup.description}'`);
            }
        }
    } catch (err) {
        record('T_RECIPES_UPDATE_01', 'UPDATE', 'FAIL', err.message);
    }
    if (rId && !SKIP_CLEANUP) await deleteTestRecipe(rId);

    // T_RECIPES_UPDATE_02 — opdater base_servings
    let rId2 = null;
    try {
        const created = await createTestRecipe('UPDATE_02');
        rId2 = created.id;
        const r = await api('PUT', `/api/grocy/recipes/${rId2}`, {
            base_servings: 10
        });
        if (r.status !== 200) {
            record('T_RECIPES_UPDATE_02', 'UPDATE', 'FAIL', `PUT status=${r.status}`);
        } else {
            const lookup = await getRecipeById(rId2);
            if (lookup && lookup.base_servings === 10) {
                record('T_RECIPES_UPDATE_02', 'UPDATE', 'PASS', `base_servings: 1 → 10`);
            } else {
                record('T_RECIPES_UPDATE_02', 'UPDATE', 'FAIL',
                    `base_servings=${lookup && lookup.base_servings}`);
            }
        }
    } catch (err) {
        record('T_RECIPES_UPDATE_02', 'UPDATE', 'FAIL', err.message);
    }
    if (rId2 && !SKIP_CLEANUP) await deleteTestRecipe(rId2);

    // T_RECIPES_USERFIELDS_01 — PUT userfields
    let rId3 = null;
    try {
        const created = await createTestRecipe('USERFIELDS_01');
        rId3 = created.id;
        const r = await api('PUT', `/api/grocy/recipes/${rId3}/userfields`, {
            sellable: '1',
            grupper: '99 T_RECIPES_TEST',
            SalespriceStore: '42'
        });
        if (r.status !== 200) {
            record('T_RECIPES_USERFIELDS_01', 'UPDATE', 'FAIL',
                `PUT userfields status=${r.status}`);
        } else {
            const lookup = await getRecipeById(rId3);
            const uf = lookup && lookup.userfields || {};
            if (uf.sellable === '1' && uf.grupper === '99 T_RECIPES_TEST' && uf.SalespriceStore === '42') {
                record('T_RECIPES_USERFIELDS_01', 'UPDATE', 'PASS',
                    `userfields persisteret`);
            } else {
                record('T_RECIPES_USERFIELDS_01', 'UPDATE', 'FAIL',
                    `userfields: sellable='${uf.sellable}', grupper='${uf.grupper}', SalespriceStore='${uf.SalespriceStore}'`);
            }
        }
    } catch (err) {
        record('T_RECIPES_USERFIELDS_01', 'UPDATE', 'FAIL', err.message);
    }
    if (rId3 && !SKIP_CLEANUP) await deleteTestRecipe(rId3);
}

// ════════════════════════════════════════════════════════════
// RECIPE POSITIONS (ingredienser) CRUD
// ════════════════════════════════════════════════════════════

async function runPosCases() {
    console.log('\n── POS (recipe positions) ──────');

    let parentRecipeId = null;
    let posId = null;

    try {
        const parent = await createTestRecipe('POS_PARENT');
        parentRecipeId = parent.id;

        // T_RECIPES_POS_01 — POST ny position
        const createRes = await api('POST', '/api/grocy/recipes-pos', {
            recipe_id: parentRecipeId,
            product_id: TEST_PRODUCT_ID,
            amount: 5,
            qu_id: TEST_PRODUCT_QU_ID
        });
        if (createRes.status !== 200) {
            record('T_RECIPES_POS_01', 'POS', 'FAIL',
                `POST status=${createRes.status} body=${createRes.raw.slice(0,200)}`);
        } else {
            posId = createRes.body && createRes.body.created_object_id;
            if (!posId) {
                record('T_RECIPES_POS_01', 'POS', 'FAIL',
                    `mangler created_object_id: ${JSON.stringify(createRes.body)}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-pos/all');
                const found = (all.body || []).find(p => parseInt(p.id) === parseInt(posId));
                if (found && parseInt(found.recipe_id) === parentRecipeId
                    && parseInt(found.product_id) === TEST_PRODUCT_ID
                    && parseFloat(found.amount) === 5) {
                    record('T_RECIPES_POS_01', 'POS', 'PASS',
                        `pos_id=${posId} for recipe=${parentRecipeId}, product=${TEST_PRODUCT_ID}, amount=5`);
                } else {
                    record('T_RECIPES_POS_01', 'POS', 'FAIL',
                        `pos lookup: ${JSON.stringify(found)}`);
                }
            }
        }

        // T_RECIPES_POS_02 — PUT opdater amount
        if (posId) {
            const updRes = await api('PUT', `/api/grocy/recipes-pos/${posId}`, { amount: 10 });
            if (updRes.status !== 200) {
                record('T_RECIPES_POS_02', 'POS', 'FAIL', `PUT status=${updRes.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-pos/all');
                const found = (all.body || []).find(p => parseInt(p.id) === parseInt(posId));
                if (found && parseFloat(found.amount) === 10) {
                    record('T_RECIPES_POS_02', 'POS', 'PASS', `amount: 5 → 10`);
                } else {
                    record('T_RECIPES_POS_02', 'POS', 'FAIL',
                        `amount=${found && found.amount}`);
                }
            }
        } else {
            record('T_RECIPES_POS_02', 'POS', 'SKIP', 'POS_01 fejlede');
        }

        // T_RECIPES_POS_03 — DELETE position
        if (posId) {
            const delRes = await api('DELETE', `/api/grocy/recipes-pos/${posId}`);
            if (delRes.status !== 200) {
                record('T_RECIPES_POS_03', 'POS', 'FAIL', `DELETE status=${delRes.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-pos/all');
                const found = (all.body || []).find(p => parseInt(p.id) === parseInt(posId));
                if (!found) {
                    record('T_RECIPES_POS_03', 'POS', 'PASS', `pos_id=${posId} fjernet`);
                    posId = null;  // markér som ryddet
                } else {
                    record('T_RECIPES_POS_03', 'POS', 'FAIL', `pos_id=${posId} eksisterer stadig`);
                }
            }
        } else {
            record('T_RECIPES_POS_03', 'POS', 'SKIP', 'POS_02 fejlede eller ingen id');
        }

        // T_RECIPES_POS_04 — DELETE ikke-eksisterende id (negativ)
        const ghostDel = await api('DELETE', '/api/grocy/recipes-pos/999999999');
        record('T_RECIPES_POS_04', 'POS', 'PASS',
            `DELETE 999999999 → status=${ghostDel.status} (observation, ikke krav)`);

        // T_RECIPES_POS_05 — opdatér flere felter (ingredient_group, note, variable_amount)
        let pos5Id = null;
        const create5Res = await api('POST', '/api/grocy/recipes-pos', {
            recipe_id: parentRecipeId,
            product_id: TEST_PRODUCT_ID,
            amount: 1,
            qu_id: TEST_PRODUCT_QU_ID
        });
        if (create5Res.status !== 200 || !create5Res.body || !create5Res.body.created_object_id) {
            record('T_RECIPES_POS_05', 'POS', 'FAIL',
                `kunne ikke oprette pos til POS_05: status=${create5Res.status}`);
        } else {
            pos5Id = create5Res.body.created_object_id;
            const upd5 = await api('PUT', `/api/grocy/recipes-pos/${pos5Id}`, {
                ingredient_group: 'Hovedingrediens',
                note: 'Test note T_RECIPES',
                variable_amount: '0.5*portions'
            });
            if (upd5.status !== 200) {
                record('T_RECIPES_POS_05', 'POS', 'FAIL', `PUT status=${upd5.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-pos/all');
                const found = (all.body || []).find(p => parseInt(p.id) === parseInt(pos5Id));
                if (found
                    && found.ingredient_group === 'Hovedingrediens'
                    && found.note === 'Test note T_RECIPES'
                    && found.variable_amount === '0.5*portions') {
                    record('T_RECIPES_POS_05', 'POS', 'PASS',
                        `ingredient_group, note, variable_amount persisteret`);
                } else {
                    record('T_RECIPES_POS_05', 'POS', 'FAIL',
                        `ingredient_group='${found && found.ingredient_group}', note='${found && found.note}', variable_amount='${found && found.variable_amount}'`);
                }
            }
            if (!SKIP_CLEANUP && pos5Id) {
                await api('DELETE', `/api/grocy/recipes-pos/${pos5Id}`).catch(() => {});
            }
        }

        // T_RECIPES_POS_06 — opdater qu_id
        let pos6Id = null;
        const create6Res = await api('POST', '/api/grocy/recipes-pos', {
            recipe_id: parentRecipeId,
            product_id: TEST_PRODUCT_ID,
            amount: 1,
            qu_id: TEST_PRODUCT_QU_ID
        });
        if (create6Res.status !== 200 || !create6Res.body || !create6Res.body.created_object_id) {
            record('T_RECIPES_POS_06', 'POS', 'FAIL',
                `kunne ikke oprette pos til POS_06: status=${create6Res.status}`);
        } else {
            pos6Id = create6Res.body.created_object_id;
            // qu_id=4 (kg) som alternativ til 8 (stk) — Grocy plejer at acceptere det selvom det er meningsløst for Affaldsposer
            const ALT_QU = 4;
            const upd6 = await api('PUT', `/api/grocy/recipes-pos/${pos6Id}`, { qu_id: ALT_QU });
            if (upd6.status !== 200) {
                record('T_RECIPES_POS_06', 'POS', 'FAIL', `PUT status=${upd6.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-pos/all');
                const found = (all.body || []).find(p => parseInt(p.id) === parseInt(pos6Id));
                if (found && parseInt(found.qu_id) === ALT_QU) {
                    record('T_RECIPES_POS_06', 'POS', 'PASS',
                        `qu_id: ${TEST_PRODUCT_QU_ID} → ${ALT_QU}`);
                } else {
                    record('T_RECIPES_POS_06', 'POS', 'FAIL',
                        `qu_id=${found && found.qu_id}`);
                }
            }
            if (!SKIP_CLEANUP && pos6Id) {
                await api('DELETE', `/api/grocy/recipes-pos/${pos6Id}`).catch(() => {});
            }
        }

    } catch (err) {
        record('T_RECIPES_POS_01', 'POS', 'FAIL', err.message);
    } finally {
        // Backup-cleanup hvis POS_03 ikke ryddede
        if (posId && !SKIP_CLEANUP) {
            await api('DELETE', `/api/grocy/recipes-pos/${posId}`).catch(() => {});
        }
        if (parentRecipeId && !SKIP_CLEANUP) {
            await deleteTestRecipe(parentRecipeId);
        }
    }
}

// ════════════════════════════════════════════════════════════
// CASCADE — recipe-delete med relaterede positioner/nestings
// ════════════════════════════════════════════════════════════

async function runCascadeCases() {
    console.log('\n── CASCADE (recipe-delete adfærd) ─');

    // T_RECIPES_CASCADE_01 — slet recipe der har positioner
    try {
        const parent = await createTestRecipe('CASCADE_01_PARENT');
        const posCreate = await api('POST', '/api/grocy/recipes-pos', {
            recipe_id: parent.id,
            product_id: TEST_PRODUCT_ID,
            amount: 1,
            qu_id: TEST_PRODUCT_QU_ID
        });
        if (posCreate.status !== 200 || !posCreate.body || !posCreate.body.created_object_id) {
            record('T_RECIPES_CASCADE_01', 'CASCADE', 'FAIL',
                `kunne ikke oprette pos: status=${posCreate.status}`);
        } else {
            const posId = posCreate.body.created_object_id;
            // Slet selve opskriften via direkte Grocy DELETE
            await deleteTestRecipe(parent.id);
            // Tjek om positionen stadig findes
            const all = await api('GET', '/api/grocy/recipes-pos/all');
            const orphan = (all.body || []).find(p => parseInt(p.id) === parseInt(posId));
            if (orphan) {
                record('T_RECIPES_CASCADE_01', 'CASCADE', 'PASS',
                    `OBSERVATION: position ${posId} HÆNGER som orphan efter recipe-delete (recipe_id=${orphan.recipe_id} peger på slettet opskrift)`);
                // Manuel oprydning så vi ikke efterlader skrald
                if (!SKIP_CLEANUP) {
                    await api('DELETE', `/api/grocy/recipes-pos/${posId}`).catch(() => {});
                }
            } else {
                record('T_RECIPES_CASCADE_01', 'CASCADE', 'PASS',
                    `OBSERVATION: position ${posId} CASCADE-slettet (Grocy fjerner positioner ved recipe-delete)`);
            }
        }
    } catch (err) {
        record('T_RECIPES_CASCADE_01', 'CASCADE', 'FAIL', err.message);
    }

    // T_RECIPES_CASCADE_02 — slet parent recipe der har nesting pegende på child
    try {
        const parent = await createTestRecipe('CASCADE_02_PARENT');
        const child  = await createTestRecipe('CASCADE_02_CHILD');
        const nestCreate = await api('POST', '/api/grocy/recipes-nestings', {
            recipe_id: parent.id,
            includes_recipe_id: child.id,
            servings: 0.5
        });
        if (nestCreate.status !== 200 || !nestCreate.body || !nestCreate.body.created_object_id) {
            record('T_RECIPES_CASCADE_02', 'CASCADE', 'FAIL',
                `kunne ikke oprette nesting: status=${nestCreate.status}`);
            if (!SKIP_CLEANUP) {
                await deleteTestRecipe(parent.id);
                await deleteTestRecipe(child.id);
            }
        } else {
            const nestId = nestCreate.body.created_object_id;
            // Slet parent
            await deleteTestRecipe(parent.id);
            // Tjek om nesting'en stadig findes
            const all = await api('GET', '/api/grocy/recipes-nestings');
            const orphan = (all.body || []).find(n => parseInt(n.id) === parseInt(nestId));
            if (orphan) {
                record('T_RECIPES_CASCADE_02', 'CASCADE', 'PASS',
                    `OBSERVATION: nesting ${nestId} HÆNGER som orphan efter parent-delete (recipe_id=${orphan.recipe_id})`);
                if (!SKIP_CLEANUP) {
                    await api('DELETE', `/api/grocy/recipes-nestings/${nestId}`).catch(() => {});
                }
            } else {
                record('T_RECIPES_CASCADE_02', 'CASCADE', 'PASS',
                    `OBSERVATION: nesting ${nestId} CASCADE-slettet (Grocy fjerner nestings ved recipe-delete)`);
            }
            if (!SKIP_CLEANUP) {
                await deleteTestRecipe(child.id);
            }
        }
    } catch (err) {
        record('T_RECIPES_CASCADE_02', 'CASCADE', 'FAIL', err.message);
    }
}

// ════════════════════════════════════════════════════════════
// RECIPE NESTINGS (underopskrifter) CRUD
// ════════════════════════════════════════════════════════════

async function runNestingCases() {
    console.log('\n── NEST (recipe nestings) ──────');

    let parentId = null;
    let childId  = null;
    let nestId   = null;

    try {
        const parent = await createTestRecipe('NEST_PARENT');
        const child  = await createTestRecipe('NEST_CHILD');
        parentId = parent.id;
        childId  = child.id;

        // T_RECIPES_NEST_01 — POST nesting
        const createRes = await api('POST', '/api/grocy/recipes-nestings', {
            recipe_id: parentId,
            includes_recipe_id: childId,
            servings: 0.5
        });
        if (createRes.status !== 200) {
            record('T_RECIPES_NEST_01', 'NEST', 'FAIL',
                `POST status=${createRes.status} body=${createRes.raw.slice(0,200)}`);
        } else {
            nestId = createRes.body && createRes.body.created_object_id;
            if (!nestId) {
                record('T_RECIPES_NEST_01', 'NEST', 'FAIL',
                    `mangler created_object_id: ${JSON.stringify(createRes.body)}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-nestings');
                const found = (all.body || []).find(n => parseInt(n.id) === parseInt(nestId));
                if (found && parseInt(found.recipe_id) === parentId
                    && parseInt(found.includes_recipe_id) === childId
                    && parseFloat(found.servings) === 0.5) {
                    record('T_RECIPES_NEST_01', 'NEST', 'PASS',
                        `nest_id=${nestId}: ${childId} → ${parentId} (servings=0.5)`);
                } else {
                    record('T_RECIPES_NEST_01', 'NEST', 'FAIL',
                        `nest lookup: ${JSON.stringify(found)}`);
                }
            }
        }

        // T_RECIPES_NEST_02 — PUT opdater servings
        if (nestId) {
            const updRes = await api('PUT', `/api/grocy/recipes-nestings/${nestId}`, { servings: 1.0 });
            if (updRes.status !== 200) {
                record('T_RECIPES_NEST_02', 'NEST', 'FAIL', `PUT status=${updRes.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-nestings');
                const found = (all.body || []).find(n => parseInt(n.id) === parseInt(nestId));
                if (found && parseFloat(found.servings) === 1.0) {
                    record('T_RECIPES_NEST_02', 'NEST', 'PASS', `servings: 0.5 → 1.0`);
                } else {
                    record('T_RECIPES_NEST_02', 'NEST', 'FAIL',
                        `servings=${found && found.servings}`);
                }
            }
        } else {
            record('T_RECIPES_NEST_02', 'NEST', 'SKIP', 'NEST_01 fejlede');
        }

        // T_RECIPES_NEST_03 — DELETE nesting
        if (nestId) {
            const delRes = await api('DELETE', `/api/grocy/recipes-nestings/${nestId}`);
            if (delRes.status !== 200) {
                record('T_RECIPES_NEST_03', 'NEST', 'FAIL', `DELETE status=${delRes.status}`);
            } else {
                const all = await api('GET', '/api/grocy/recipes-nestings');
                const found = (all.body || []).find(n => parseInt(n.id) === parseInt(nestId));
                if (!found) {
                    record('T_RECIPES_NEST_03', 'NEST', 'PASS', `nest_id=${nestId} fjernet`);
                    nestId = null;
                } else {
                    record('T_RECIPES_NEST_03', 'NEST', 'FAIL', `nest_id=${nestId} eksisterer stadig`);
                }
            }
        } else {
            record('T_RECIPES_NEST_03', 'NEST', 'SKIP', 'NEST_02 fejlede eller ingen id');
        }

    } catch (err) {
        record('T_RECIPES_NEST_01', 'NEST', 'FAIL', err.message);
    } finally {
        if (nestId && !SKIP_CLEANUP) {
            await api('DELETE', `/api/grocy/recipes-nestings/${nestId}`).catch(() => {});
        }
        if (parentId && !SKIP_CLEANUP) await deleteTestRecipe(parentId);
        if (childId && !SKIP_CLEANUP)  await deleteTestRecipe(childId);
    }
}

// ════════════════════════════════════════════════════════════
// Final cleanup verification
// ════════════════════════════════════════════════════════════

async function finalCleanup() {
    console.log('\n── FINAL CLEANUP ───────────────');
    if (SKIP_CLEANUP) {
        console.log(`  (sprunget pga --skip-cleanup — orphans: ${[...createdRecipeIds].join(', ')})`);
        record('T_RECIPES_CLEANUP_01', 'CLEANUP', 'SKIP', '--skip-cleanup aktiv');
        return;
    }

    // Først: backup-ryd dem vi tror er tilbage
    const stillTracked = [...createdRecipeIds];
    for (const id of stillTracked) {
        await deleteTestRecipe(id);
    }

    // Verificer at INGEN T_RECIPES_-præfiks-opskrifter er tilbage på Grocy
    try {
        const all = await api('GET', '/api/grocy/recipes/raw');
        const orphans = (all.body || []).filter(r => r.name && r.name.startsWith(NAME_PREFIX));
        if (orphans.length === 0) {
            record('T_RECIPES_CLEANUP_01', 'CLEANUP', 'PASS',
                'Ingen T_RECIPES_-orphans tilbage på Grocy');
        } else {
            const orphanList = orphans.slice(0, 5).map(r => `${r.id}:${r.name}`).join('; ');
            record('T_RECIPES_CLEANUP_01', 'CLEANUP', 'FAIL',
                `Orphans tilbage (${orphans.length}): ${orphanList}`);
        }
    } catch (err) {
        record('T_RECIPES_CLEANUP_01', 'CLEANUP', 'FAIL', err.message);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_RECIPES_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','CREATE','UPDATE','POS','NEST','CASCADE','CLEANUP'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass: inGroup.filter(r => r.status === 'PASS').length,
            fail: inGroup.filter(r => r.status === 'FAIL').length,
            skip: inGroup.filter(r => r.status === 'SKIP').length,
        };
    }

    let md = `# T_RECIPES — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** ${SERVER_URL} · DB: ${process.env.DB_PATH} · Grocy: ${GROCY_URL}\n\n`;
    md += `## Resumé\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `| Gruppe | PASS | FAIL | SKIP |\n|--------|-----:|-----:|-----:|\n`;
    for (const g of groups) {
        if (byGroup[g].pass + byGroup[g].fail + byGroup[g].skip === 0) continue;
        md += `| ${g} | ${byGroup[g].pass} | ${byGroup[g].fail} | ${byGroup[g].skip} |\n`;
    }

    if (fails > 0) {
        md += `\n## Fejl\n\n| ID | Detalje |\n|----|---------|\n`;
        for (const f of results.filter(r => r.status === 'FAIL')) {
            md += `| ${f.id} | ${f.detail.replace(/\|/g, '\\|')} |\n`;
        }
    }

    md += `\n## Alle cases\n\n| ID | Gruppe | Status | Note |\n|----|--------|--------|------|\n`;
    for (const r of results) {
        md += `| ${r.id} | ${r.group} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |\n`;
    }

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_RECIPES] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    if (!GROCY_URL || !GROCY_API_KEY) {
        console.error('[run_T_RECIPES] GROCY_API_URL eller GROCY_API_KEY mangler i .env.test');
        process.exit(1);
    }

    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_RECIPES] Server: ${SERVER_URL}`);
    console.log(`[run_T_RECIPES] Grocy:  ${GROCY_URL}`);
    if (SKIP_CLEANUP) console.log(`[run_T_RECIPES] WARNING: --skip-cleanup`);

    // Verificér at server svarer
    try {
        const r = await api('GET', '/api/grocy/recipes/raw');
        if (r.status !== 200) {
            console.error(`[run_T_RECIPES] Server svarer ${r.status} på /api/grocy/recipes/raw`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_RECIPES] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    const setupOk = await runSetupCases();
    if (!setupOk) {
        console.error('[run_T_RECIPES] Setup fejlede — bryder');
        await finalCleanup();
        db.close();
        const { fails } = writeReport();
        process.exit(1);
    }

    await runCreateCases();
    await runUpdateCases();
    await runPosCases();
    await runNestingCases();
    await runCascadeCases();
    await finalCleanup();

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_RECIPES] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_RECIPES] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    // Forsøg cleanup ved unexpected fail
    finalCleanup().catch(() => {}).finally(() => process.exit(1));
});
