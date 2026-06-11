#!/usr/bin/env node
/**
 * tests/scripts/run_T_OPSKRIFTER.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for Opskrifter & priser (routes/recipes_overview.js).
 *
 * Fokuserer på de kritiske moms- og filter-cases. Cache-invalidering,
 * stale-detection og standalone-script testes ikke her (separate concerns
 * og/eller eksterne afhængigheder).
 *
 * Hermetisk: bons med T_OPS_-prefix, item_prices/recipe_cost_cache rækker
 * for valgte test-recipe-IDs ryddes i CLEANUP.
 *
 * Krav: Grocy-test-instans tilgængelig (grocytest) for at /overview kan
 * hente recipes. Hvis Grocy ikke svarer, fejler suiten med 503 — det er
 * forventet og signalerer environment-problem, ikke kode-fejl.
 *
 * Usage:
 *   npm run test:run-opskrifter
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_OPSKRIFTER.js --verbose
 *
 * Reference: tests/specs/T_OPSKRIFTER.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

const args         = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const FLOAT_TOL = 0.01;
const PREFIX = 'T_OPS';

let db;
let SESSION_COOKIE = null;
const results = [];

// Test-state
const created = {
    bons: {},        // key → bon_id
    customers: {},
    addresses: {},
    // Test-recipe-IDs vælges fra grocytest ved opstart
    testRecipes: {}, // R1, R2, R3, R_MOMS → grocy_recipe_id
    priceCategoryId: null,
    festivalCategoryId: null,
};

const TEST_CATEGORIES = ['T_OPS_TestKat_A', 'T_OPS_TestKat_B'];

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')      console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP') console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)           console.log(`  ✓ ${id}`);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (SESSION_COOKIE) opts.headers['Cookie'] = SESSION_COOKIE;
    if (body !== null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

async function login() {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) throw new Error(`Login fejlede: ${res.status}`);
    SESSION_COOKIE = res.headers.get('set-cookie')?.split(';')[0];
    if (!SESSION_COOKIE) throw new Error('Ingen set-cookie modtaget — er server konfigureret korrekt?');
}

function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
}
function statusId(code) {
    return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}
function defaultLocation() {
    return db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id;
}

// ════════════════════════════════════════════════════════════
// SETUP
// ════════════════════════════════════════════════════════════

async function runSetup() {
    console.log('\n── SETUP ──');

    // SETUP_01: Schema-tjek
    try {
        const tables = ['item_prices', 'recipe_cost_cache', 'recipe_db_targets'];
        const missing = tables.filter(t => !db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        ).get(t));
        if (missing.length === 0) record('T_OPS_SETUP_01', 'SETUP', 'PASS');
        else record('T_OPS_SETUP_01', 'SETUP', 'FAIL', `Mangler tabeller: ${missing.join(',')}`);
    } catch (e) { record('T_OPS_SETUP_01', 'SETUP', 'FAIL', e.message); }

    // SETUP_02: item_prices har item_type-kolonne
    try {
        const cols = db.prepare(`PRAGMA table_info(item_prices)`).all();
        const hasItemType = cols.some(c => c.name === 'item_type');
        const hasUpdatedBy = cols.some(c => c.name === 'updated_by_user_id');
        if (hasItemType && hasUpdatedBy) record('T_OPS_SETUP_02', 'SETUP', 'PASS');
        else record('T_OPS_SETUP_02', 'SETUP', 'FAIL', `item_type=${hasItemType}, updated_by=${hasUpdatedBy}`);
    } catch (e) { record('T_OPS_SETUP_02', 'SETUP', 'FAIL', e.message); }

    // SETUP_03: Hent price_categories
    try {
        const cat = db.prepare(`SELECT id FROM price_categories WHERE code = 'catering'`).get();
        const fest = db.prepare(`SELECT id FROM price_categories WHERE code = 'festival'`).get();
        if (!cat) throw new Error('catering price_category mangler');
        if (!fest) throw new Error('festival price_category mangler');
        created.priceCategoryId = cat.id;
        created.festivalCategoryId = fest.id;
        record('T_OPS_SETUP_03', 'SETUP', 'PASS');
    } catch (e) { record('T_OPS_SETUP_03', 'SETUP', 'FAIL', e.message); }

    // SETUP_04: Login virker
    try {
        await login();
        record('T_OPS_SETUP_04', 'SETUP', 'PASS');
    } catch (e) { record('T_OPS_SETUP_04', 'SETUP', 'FAIL', e.message); }

    // SETUP_05: Vælg test-recipe-IDs fra Grocy via API (kræver auth)
    try {
        const r = await api('GET', '/api/grocy/recipes');
        if (r.status !== 200) throw new Error(`Grocy ikke tilgængelig (status ${r.status})`);
        const recipes = r.body || [];
        if (recipes.length < 4) throw new Error(`Mindst 4 sellable recipes kræves, fandt ${recipes.length}`);
        created.testRecipes.R1 = recipes[0].id;
        created.testRecipes.R2 = recipes[1].id;
        created.testRecipes.R3 = recipes[2].id;
        created.testRecipes.R_MOMS = recipes[3].id;
        record('T_OPS_SETUP_05', 'SETUP', 'PASS',
            `R1=${recipes[0].id} (${recipes[0].name}), R_MOMS=${recipes[3].id}`);
    } catch (e) { record('T_OPS_SETUP_05', 'SETUP', 'FAIL', e.message); }

    // SETUP_06: Snapshot baseline sold_units FØR vi inserter test-bons,
    // så vi kan asserte på DIFF (test.db deler recipe-IDs med seed-data)
    try {
        const baseline = await api('GET', '/api/recipes/overview?price_category=catering&period_days=365');
        if (baseline.status !== 200) throw new Error(`Baseline kald fejlede: ${baseline.status}`);
        const byId = {};
        for (const r of baseline.body.recipes) byId[r.grocy_recipe_id] = r;
        created.baseline = {
            soldR1: byId[created.testRecipes.R1]?.sold_units || 0,
            soldR2: byId[created.testRecipes.R2]?.sold_units || 0,
            soldR3: byId[created.testRecipes.R3]?.sold_units || 0,
            soldR_MOMS: byId[created.testRecipes.R_MOMS]?.sold_units || 0,
            revR_MOMS: byId[created.testRecipes.R_MOMS]?.revenue_excl_moms || 0,
            lossCount: baseline.body.summary.loss_making_count || 0,
            activeCount: baseline.body.summary.active_count || 0,
        };
        record('T_OPS_SETUP_06_BASELINE', 'SETUP', 'PASS',
            `baseline sold: R1=${created.baseline.soldR1}, R_MOMS=${created.baseline.soldR_MOMS}`);
    } catch (e) { record('T_OPS_SETUP_06_BASELINE', 'SETUP', 'FAIL', e.message); }

    // SETUP_07: Seed test-data
    try {
        await seedTestData();
        record('T_OPS_SETUP_07', 'SETUP', 'PASS');
    } catch (e) { record('T_OPS_SETUP_07', 'SETUP', 'FAIL', e.message); }
}

async function seedTestData() {
    const locId = defaultLocation();
    const { R1, R2, R3, R_MOMS } = created.testRecipes;

    // Kunde
    const cust = db.prepare(`
        INSERT INTO customers (first_name, last_name, phone, email, is_active)
        VALUES (?, ?, ?, ?, 1)
    `).run(PREFIX, '_cust', '12345678', `${PREFIX}@test.dk`);
    created.customers.priv = cust.lastInsertRowid;

    // Adresse
    const addr = db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city)
        VALUES (?, ?, ?, ?)
    `).run('Testvej', '1', '8000', 'Aarhus');
    created.addresses.a1 = addr.lastInsertRowid;

    // Indsæt test-bons
    const insertBon = (bonNum, statusCode, deliveryDate, opts = {}) => {
        const stmt = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, customer_id,
                delivery_address_id, order_date, delivery_date, pax,
                total_units, total_price, payment_type, is_offer, is_internal
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const r = stmt.run(
            bonNum, statusId(statusCode), locId, created.customers.priv,
            created.addresses.a1, deliveryDate, deliveryDate,
            1, 1, 0, 'card',
            opts.is_offer ?? 0, opts.is_internal ?? 0
        );
        return r.lastInsertRowid;
    };

    const insertLine = (bonId, recipeId, qty, unitPriceIncl) => {
        db.prepare(`
            INSERT INTO bon_lines (
                bon_id, grocy_recipe_id, product_name, quantity, unit_price, line_total
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(bonId, recipeId, 'TestProduct', qty, unitPriceIncl, qty * unitPriceIncl);
    };

    // T_OPS_LEV_1: LEVERET 10 dage siden, R1 × 5 stk
    created.bons.LEV_1 = insertBon('T_OPS_LEV_1', 'LEVERET', daysAgo(10));
    insertLine(created.bons.LEV_1, R1, 5, 80);
    // T_OPS_LEV_2: LEVERET 30 dage siden, R1 × 3 + R2 × 2
    created.bons.LEV_2 = insertBon('T_OPS_LEV_2', 'LEVERET', daysAgo(30));
    insertLine(created.bons.LEV_2, R1, 3, 80);
    insertLine(created.bons.LEV_2, R2, 2, 50);
    // T_OPS_FAKT: FAKTURERET 60 dage siden, R2 × 4
    created.bons.FAKT = insertBon('T_OPS_FAKT', 'FAKTURERET', daysAgo(60));
    insertLine(created.bons.FAKT, R2, 4, 50);
    // T_OPS_BETALT: BETALT 90 dage siden, R3 × 2
    created.bons.BETALT = insertBon('T_OPS_BETALT', 'BETALT', daysAgo(90));
    insertLine(created.bons.BETALT, R3, 2, 30);
    // T_OPS_AFSLUT: AFSLUTTET 120 dage siden, R3 × 1
    created.bons.AFSLUT = insertBon('T_OPS_AFSLUT', 'AFSLUTTET', daysAgo(120));
    insertLine(created.bons.AFSLUT, R3, 1, 30);
    // T_OPS_NY: NY, 5 dage frem, skal ekskluderes
    created.bons.NY = insertBon('T_OPS_NY', 'NY', daysAgo(-5));
    insertLine(created.bons.NY, R1, 99, 80);
    // T_OPS_AFLYST: AFLYST, 5 dage siden, skal ekskluderes
    created.bons.AFLYST = insertBon('T_OPS_AFLYST', 'AFLYST', daysAgo(5));
    insertLine(created.bons.AFLYST, R1, 10, 80);
    // T_OPS_OFFER: LEVERET men is_offer=1, skal ekskluderes
    created.bons.OFFER = insertBon('T_OPS_OFFER', 'LEVERET', daysAgo(5), { is_offer: 1 });
    insertLine(created.bons.OFFER, R1, 50, 80);
    // T_OPS_INTERNAL: LEVERET men is_internal=1, skal ekskluderes
    created.bons.INTERNAL = insertBon('T_OPS_INTERNAL', 'LEVERET', daysAgo(5), { is_internal: 1 });
    insertLine(created.bons.INTERNAL, R2, 50, 50);
    // T_OPS_NULL_RECIPE: LEVERET med NULL grocy_recipe_id
    created.bons.NULL_REC = insertBon('T_OPS_NULL_RECIPE', 'LEVERET', daysAgo(5));
    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, quantity, unit_price, line_total)
        VALUES (?, NULL, 'NoRecipe', 5, 80, 400)
    `).run(created.bons.NULL_REC);
    // T_OPS_MOMS: LEVERET 5 dage siden, R_MOMS × 4 stk a 125 INCL moms → 500 incl, 400 excl
    created.bons.MOMS = insertBon('T_OPS_MOMS', 'LEVERET', daysAgo(5));
    insertLine(created.bons.MOMS, R_MOMS, 4, 125);

    // Recipe cost cache (kontrollerede kostpriser ex moms)
    const upsertCost = db.prepare(`
        INSERT OR REPLACE INTO recipe_cost_cache
        (grocy_recipe_id, cost_price_excl_moms, ingredients_json, co2e, refreshed_at)
        VALUES (?, ?, '[]', ?, CURRENT_TIMESTAMP)
    `);
    upsertCost.run(R1,     35.00, 0.5);
    upsertCost.run(R2,     40.00, 0.4);
    upsertCost.run(R3,     35.00, 0.3);
    upsertCost.run(R_MOMS, 50.00, 0.6);

    // Item prices (kontrollerede salgspriser ex moms)
    const upsertPrice = db.prepare(`
        INSERT OR REPLACE INTO item_prices
        (item_type, item_id, price_category_id, price)
        VALUES ('recipe', ?, ?, ?)
    `);
    upsertPrice.run(R1,     created.priceCategoryId,    80.00);
    upsertPrice.run(R1,     created.festivalCategoryId, 75.00);
    upsertPrice.run(R2,     created.priceCategoryId,    50.00);
    // R2: ingen festival-pris (test mangler-pris-tilstand)
    upsertPrice.run(R3,     created.priceCategoryId,    30.00);  // tabsgivende: 35 > 30
    upsertPrice.run(R_MOMS, created.priceCategoryId,   100.00);

    // Targets — set TestKat_A til 60% mål (alle R'er har ingen kategori i Grocy
    // sandsynligvis, men test-suiten verificerer i kapacitet at backfill virker)
}

// ════════════════════════════════════════════════════════════
// OVERVIEW_BASIC + SOLD_AGGREGATION + MOMS
// ════════════════════════════════════════════════════════════

async function runOverviewAndMoms() {
    console.log('\n── OVERVIEW + SOLD + MOMS ──');

    const r = await api('GET', '/api/recipes/overview?price_category=catering&period_days=365');
    if (r.status !== 200) {
        record('T_OPS_OV_01', 'OVERVIEW', 'FAIL', `Status ${r.status}: ${r.raw.slice(0, 150)}`);
        return;
    }

    const body = r.body;
    record('T_OPS_OV_01', 'OVERVIEW', 'PASS');

    // OV_02: response struktur
    const hasKeys = body.summary && Array.isArray(body.recipes) && body.price_category && body.period_days;
    if (hasKeys) record('T_OPS_OV_02', 'OVERVIEW', 'PASS');
    else record('T_OPS_OV_02', 'OVERVIEW', 'FAIL', 'Manglende top-level keys');

    const { R1, R2, R3, R_MOMS } = created.testRecipes;
    const findR = (id) => body.recipes.find(r => r.grocy_recipe_id === id);

    // OV_03: testopskrifter er i array
    const rR1 = findR(R1);
    const rR2 = findR(R2);
    const rR3 = findR(R3);
    const rRM = findR(R_MOMS);
    if (rR1 && rR2 && rR3 && rRM) record('T_OPS_OV_03', 'OVERVIEW', 'PASS');
    else record('T_OPS_OV_03', 'OVERVIEW', 'FAIL', 'En eller flere test-recipes mangler i response');

    // OV_04: R1 salgspris = 80 ex
    if (rR1 && Math.abs(rR1.sales_price_excl_moms - 80) < FLOAT_TOL) record('T_OPS_OV_04', 'OVERVIEW', 'PASS');
    else record('T_OPS_OV_04', 'OVERVIEW', 'FAIL', `R1.sales = ${rR1?.sales_price_excl_moms}`);

    // OV_05: R1 db_kr = 45
    if (rR1 && Math.abs(rR1.db_kr_excl_moms - 45) < FLOAT_TOL) record('T_OPS_OV_05', 'OVERVIEW', 'PASS');
    else record('T_OPS_OV_05', 'OVERVIEW', 'FAIL', `R1.db_kr = ${rR1?.db_kr_excl_moms}`);

    // OV_06: R1 db_pct ≈ 56.25
    if (rR1 && Math.abs(rR1.db_pct - 56.25) < 0.1) record('T_OPS_OV_06', 'OVERVIEW', 'PASS');
    else record('T_OPS_OV_06', 'OVERVIEW', 'FAIL', `R1.db_pct = ${rR1?.db_pct}`);

    // OV_07: missing_price_count beregnes (test at strukturen virker — eksakte tal
    // er svære at validere fordi auto-backfill populerer fra Grocy ved første kald)
    const r2 = await api('GET', '/api/recipes/overview?price_category=festival&period_days=365');
    if (r2.status === 200 && typeof r2.body.summary.missing_price_count === 'number') {
        record('T_OPS_OV_07', 'OVERVIEW', 'PASS',
            `festival missing_price_count = ${r2.body.summary.missing_price_count}`);
    } else {
        record('T_OPS_OV_07', 'OVERVIEW', 'FAIL', `Festival call status ${r2.status}`);
    }

    // OV_08: period_buckets længde
    if (rR1 && Array.isArray(rR1.period_buckets) && rR1.period_buckets.length === 12) {
        record('T_OPS_OV_08', 'OVERVIEW', 'PASS');
    } else {
        record('T_OPS_OV_08', 'OVERVIEW', 'FAIL', `buckets.length = ${rR1?.period_buckets?.length}`);
    }

    // ─── SOLD_AGGREGATION (DIFF mod baseline) ───
    const base = created.baseline || {};

    // SOLD_01: R1 DELTA = 8 (LEV_1=5 + LEV_2=3) — NY/AFLYST/OFFER/INTERNAL skal IKKE bidrage
    if (rR1) {
        const delta = rR1.sold_units - (base.soldR1 || 0);
        if (delta === 8) record('T_OPS_SOLD_01', 'SOLD', 'PASS', `delta=${delta}`);
        else record('T_OPS_SOLD_01', 'SOLD', 'FAIL',
            `delta = ${delta} (forventet 8). Tjek NY/AFLYST/OFFER-ekskludering — KRITISK bug-mistanke`);
    }

    // SOLD_02: NY-bon (99 stk) IKKE tællet → delta < 99
    if (rR1) {
        const delta = rR1.sold_units - (base.soldR1 || 0);
        if (delta < 99) record('T_OPS_SOLD_02', 'SOLD', 'PASS');
        else record('T_OPS_SOLD_02', 'SOLD', 'FAIL', `delta inkluderer NY (99) — status-filter glemt`);
    }

    // SOLD_04: OFFER-bon (50 stk) IKKE tællet → delta ≤ 8
    if (rR1) {
        const delta = rR1.sold_units - (base.soldR1 || 0);
        if (delta <= 8) record('T_OPS_SOLD_04', 'SOLD', 'PASS');
        else record('T_OPS_SOLD_04', 'SOLD', 'FAIL', `delta inkluderer OFFER (50 stk)`);
    }

    // SOLD_05: INTERNAL-bon (50 stk på R2) IKKE tællet → delta = 6
    if (rR2) {
        const delta = rR2.sold_units - (base.soldR2 || 0);
        if (delta === 6) record('T_OPS_SOLD_05', 'SOLD', 'PASS', `delta=${delta}`);
        else record('T_OPS_SOLD_05', 'SOLD', 'FAIL', `delta = ${delta} (forventet 6)`);
    }

    // SOLD_08: R3 delta = 3 (BETALT=2 + AFSLUT=1)
    if (rR3) {
        const delta = rR3.sold_units - (base.soldR3 || 0);
        if (delta === 3) record('T_OPS_SOLD_08', 'SOLD', 'PASS');
        else record('T_OPS_SOLD_08', 'SOLD', 'FAIL', `delta = ${delta} (forventet 3)`);
    }

    // SOLD_10: period_buckets summerer til sold_units
    if (rR1) {
        const bucketSum = rR1.period_buckets.reduce((a, b) => a + b, 0);
        if (Math.abs(bucketSum - rR1.sold_units) < 0.01) record('T_OPS_SOLD_10', 'SOLD', 'PASS');
        else record('T_OPS_SOLD_10', 'SOLD', 'FAIL', `SUM(buckets)=${bucketSum} vs sold=${rR1.sold_units}`);
    }

    // ─── MOMS (kritisk) — DIFF mod baseline ───
    // T_OPS_MOMS bon: 4 × 125 INCL moms = 500 incl → 400 ex moms (delta)
    if (rRM) {
        const delta = rRM.revenue_excl_moms - (base.revR_MOMS || 0);
        const expected = 400;
        if (Math.abs(delta - expected) < FLOAT_TOL) {
            record('T_OPS_MOMS_01', 'MOMS', 'PASS', `delta = ${delta.toFixed(2)} (korrekt ex moms)`);
        } else if (Math.abs(delta - 500) < FLOAT_TOL) {
            record('T_OPS_MOMS_01', 'MOMS', 'FAIL',
                `delta = 500 (incl moms) — Moms.inclToExcl() konvertering glemt! KRITISK BUG.`);
        } else {
            record('T_OPS_MOMS_01', 'MOMS', 'FAIL',
                `delta = ${delta.toFixed(2)}, forventet ${expected}`);
        }
    }

    // MOMS_04: R_MOMS db_kr = 100 - 50 = 50 (ex moms)
    if (rRM && Math.abs(rRM.db_kr_excl_moms - 50) < FLOAT_TOL) {
        record('T_OPS_MOMS_04', 'MOMS', 'PASS');
    } else {
        record('T_OPS_MOMS_04', 'MOMS', 'FAIL', `db_kr = ${rRM?.db_kr_excl_moms}, forventet 50`);
    }

    // ─── KPI ───
    // KPI_01: loss_making_count ≥ 1 (R3 har 30 sales < 35 cost = tab)
    if (body.summary.loss_making_count >= 1) record('T_OPS_KPI_01', 'KPI', 'PASS',
        `loss_making_count = ${body.summary.loss_making_count}`);
    else record('T_OPS_KPI_01', 'KPI', 'FAIL', `loss_making_count = ${body.summary.loss_making_count}, forventet ≥1`);

    // KPI_03: share_under_target_pct = under_target_count / active_count × 100
    const s = body.summary;
    if (s.active_count === 0) {
        record('T_OPS_KPI_03', 'KPI', 'SKIP', 'active_count=0, kan ikke beregne');
    } else {
        const expectedShare = Math.round(s.under_target_count / s.active_count * 1000) / 10;
        const diff = Math.abs(s.share_under_target_pct - expectedShare);
        if (diff < 1) record('T_OPS_KPI_03', 'KPI', 'PASS');
        else record('T_OPS_KPI_03', 'KPI', 'FAIL', `share=${s.share_under_target_pct}, expected≈${expectedShare}`);
    }
}

// ════════════════════════════════════════════════════════════
// TARGETS CRUD
// ════════════════════════════════════════════════════════════

async function runTargets() {
    console.log('\n── TARGETS_CRUD ──');

    // TG_01: GET /targets returnerer struktur
    let g = await api('GET', '/api/recipes/targets');
    if (g.status === 200 && Array.isArray(g.body.targets) && Array.isArray(g.body.categories)) {
        record('T_OPS_TG_01', 'TARGETS', 'PASS');
    } else {
        record('T_OPS_TG_01', 'TARGETS', 'FAIL', `status=${g.status}`);
        return;
    }

    // Ryd test-kategorier først (idempotent)
    for (const cat of TEST_CATEGORIES) {
        await api('DELETE', `/api/recipes/targets/${encodeURIComponent(cat)}`);
    }

    // TG_02: PUT bulk
    const p = await api('PUT', '/api/recipes/targets', {
        targets: [
            { category: TEST_CATEGORIES[0], target_pct: 65 },
            { category: TEST_CATEGORIES[1], target_pct: 60 },
        ],
    });
    if (p.status === 200 && p.body.count === 2) record('T_OPS_TG_02', 'TARGETS', 'PASS');
    else record('T_OPS_TG_02', 'TARGETS', 'FAIL', `status=${p.status}, count=${p.body?.count}`);

    // TG_03: PATCH ét mål
    const pa = await api('PATCH', `/api/recipes/targets/${encodeURIComponent(TEST_CATEGORIES[0])}`, {
        target_pct: 70,
    });
    if (pa.status === 200 && Math.abs(pa.body.target_pct - 70) < FLOAT_TOL) {
        record('T_OPS_TG_03', 'TARGETS', 'PASS');
    } else {
        record('T_OPS_TG_03', 'TARGETS', 'FAIL', `status=${pa.status}, target=${pa.body?.target_pct}`);
    }

    // Verificér i DB
    const row = db.prepare(`SELECT target_pct FROM recipe_db_targets WHERE category=?`).get(TEST_CATEGORIES[0]);
    if (row && Math.abs(row.target_pct - 70) < FLOAT_TOL) record('T_OPS_TG_VERIFY', 'TARGETS', 'PASS');
    else record('T_OPS_TG_VERIFY', 'TARGETS', 'FAIL', `DB has ${row?.target_pct}`);

    // TG_05: DELETE
    const d = await api('DELETE', `/api/recipes/targets/${encodeURIComponent(TEST_CATEGORIES[1])}`);
    if (d.status === 200 && d.body.deleted === 1) record('T_OPS_TG_05', 'TARGETS', 'PASS');
    else record('T_OPS_TG_05', 'TARGETS', 'FAIL', `status=${d.status}, deleted=${d.body?.deleted}`);
}

// ════════════════════════════════════════════════════════════
// ITEM_PRICES CRUD
// ════════════════════════════════════════════════════════════

async function runItemPrices() {
    console.log('\n── ITEM_PRICES ──');

    const { R1 } = created.testRecipes;
    if (!R1) {
        record('T_OPS_IP_01', 'PRICES', 'SKIP', 'R1 ikke valgt');
        return;
    }

    // Snapshot R1's Grocy store-pris (incl moms) — PUT skriver nu tilbage til
    // Grocy-userfieldet, så vi skal kunne gendanne i cleanup.
    try {
        const gr = await api('GET', '/api/grocy/recipes');
        const r1 = (gr.body || []).find(x => x.id === R1);
        created.r1StoreInclOriginal = r1?.prices?.store ?? 0;
    } catch (e) { created.r1StoreInclOriginal = 0; }

    // IP_01: PUT opretter ny pris (forventer overwrite siden seed populerede den)
    const p1 = await api('PUT', '/api/item-prices', {
        item_type: 'recipe',
        item_id: R1,
        price_category_code: 'store',
        price_excl_moms: 95.50,
    });
    if (p1.status === 200 && p1.body.ok) record('T_OPS_IP_01', 'PRICES', 'PASS');
    else record('T_OPS_IP_01', 'PRICES', 'FAIL', `status=${p1.status}, ${p1.raw.slice(0, 100)}`);

    // Verificer i DB
    const row1 = db.prepare(`
        SELECT price FROM item_prices
        WHERE item_type='recipe' AND item_id=? AND price_category_id=(
            SELECT id FROM price_categories WHERE code='store'
        )
    `).get(R1);
    if (row1 && Math.abs(row1.price - 95.50) < FLOAT_TOL) record('T_OPS_IP_VERIFY_NEW', 'PRICES', 'PASS');
    else record('T_OPS_IP_VERIFY_NEW', 'PRICES', 'FAIL', `DB price=${row1?.price}`);

    // IP_02: PUT igen opdaterer (ingen duplicate)
    const p2 = await api('PUT', '/api/item-prices', {
        item_type: 'recipe',
        item_id: R1,
        price_category_code: 'store',
        price_excl_moms: 99.00,
    });
    if (p2.status === 200) {
        const row2 = db.prepare(`
            SELECT COUNT(*) AS n, MAX(price) AS p FROM item_prices
            WHERE item_type='recipe' AND item_id=? AND price_category_id=(
                SELECT id FROM price_categories WHERE code='store'
            )
        `).get(R1);
        if (row2.n === 1 && Math.abs(row2.p - 99.00) < FLOAT_TOL) record('T_OPS_IP_02', 'PRICES', 'PASS');
        else record('T_OPS_IP_02', 'PRICES', 'FAIL', `n=${row2.n}, p=${row2.p}`);
    } else {
        record('T_OPS_IP_02', 'PRICES', 'FAIL', `status=${p2.status}`);
    }

    // IP_05: Negativ pris afvises
    const p3 = await api('PUT', '/api/item-prices', {
        item_type: 'recipe',
        item_id: R1,
        price_category_code: 'store',
        price_excl_moms: -10,
    });
    if (p3.status === 400) record('T_OPS_IP_05', 'PRICES', 'PASS');
    else record('T_OPS_IP_05', 'PRICES', 'FAIL', `status=${p3.status} (forventet 400)`);

    // IP_06: PUT skriver tilbage til Grocy Salesprice-userfield (incl moms).
    // Sidste gemte pris var 99.00 ex → 123.75 incl i Grocy (§6b: exclToIncl).
    try {
        const gr = await api('GET', '/api/grocy/recipes');
        const r1 = (gr.body || []).find(x => x.id === R1);
        const grocyIncl = r1?.prices?.store;
        if (grocyIncl != null && Math.abs(grocyIncl - 123.75) < FLOAT_TOL) {
            record('T_OPS_IP_06', 'PRICES', 'PASS', `Grocy store=${grocyIncl} incl`);
        } else {
            record('T_OPS_IP_06', 'PRICES', 'FAIL', `Grocy store=${grocyIncl} (forventet 123.75 incl)`);
        }
    } catch (e) { record('T_OPS_IP_06', 'PRICES', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════

async function runCleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n── CLEANUP sprunget over ──');
        return;
    }
    console.log('\n── CLEANUP ──');

    // Slet test-bons (CASCADE rydder lines)
    db.prepare(`DELETE FROM bons WHERE bon_number LIKE ?`).run(`${PREFIX}_%`);
    // Slet test-customers
    db.prepare(`DELETE FROM customers WHERE last_name LIKE '%_cust' AND first_name = ?`).run(PREFIX);
    // Slet test-addresses
    db.prepare(`DELETE FROM addresses WHERE street_name = 'Testvej' AND street_nr = '1' AND postal_code = '8000'`);
    // Slet item_prices for test-recipes
    const recIds = Object.values(created.testRecipes).filter(Boolean);
    if (recIds.length) {
        const placeholders = recIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM item_prices WHERE item_type='recipe' AND item_id IN (${placeholders})`).run(...recIds);
        db.prepare(`DELETE FROM recipe_cost_cache WHERE grocy_recipe_id IN (${placeholders})`).run(...recIds);
    }
    // Slet test-targets
    for (const cat of TEST_CATEGORIES) {
        db.prepare(`DELETE FROM recipe_db_targets WHERE category = ?`).run(cat);
    }

    // Gendan R1's Grocy store-pris (item-price-testene skrev tilbage til Grocy)
    if (created.testRecipes.R1 && created.r1StoreInclOriginal != null) {
        try {
            const exclOriginal = Math.round((created.r1StoreInclOriginal / 1.25) * 100) / 100;
            await api('PUT', '/api/item-prices', {
                item_type: 'recipe',
                item_id: created.testRecipes.R1,
                price_category_code: 'store',
                price_excl_moms: exclOriginal,
            });
            console.log(`  ✓ R1 Grocy store-pris gendannet til ${created.r1StoreInclOriginal} incl`);
        } catch (e) {
            console.log(`  ⚠ Kunne ikke gendanne R1 Grocy-pris: ${e.message}`);
        }
    }

    console.log('  ✓ Cleanup færdig');
}

// ════════════════════════════════════════════════════════════
// REPORT
// ════════════════════════════════════════════════════════════

function writeReport() {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(REPORT_DIR, `T_OPSKRIFTER_${stamp}.md`);

    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    const skip = results.filter(r => r.status === 'SKIP').length;

    let md = `# T_OPSKRIFTER report\n\n`;
    md += `**Server:** ${SERVER_URL}\n`;
    md += `**Tidspunkt:** ${new Date().toISOString()}\n\n`;
    md += `**Resultat:** ${pass} PASS · ${fail} FAIL · ${skip} SKIP\n\n`;
    md += `## Cases\n\n`;
    md += `| ID | Group | Status | Detail |\n|---|---|---|---|\n`;
    for (const r of results) md += `| ${r.id} | ${r.group} | ${r.status} | ${r.detail || ''} |\n`;
    fs.writeFileSync(file, md);
    return file;
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`\n═══ T_OPSKRIFTER ═══`);
    console.log(`Server: ${SERVER_URL}`);
    console.log(`Verbose: ${VERBOSE}, SkipCleanup: ${SKIP_CLEANUP}`);

    try {
        await runSetup();

        // Stop hvis setup fejlede kritisk
        if (results.some(r => r.id.startsWith('T_OPS_SETUP_0') && r.id !== 'T_OPS_SETUP_05' && r.status === 'FAIL')) {
            console.log('\n⚠ Kritisk SETUP-fejl — springer resten over');
        } else if (!created.testRecipes.R1) {
            console.log('\n⚠ Test-recipes ikke valgt (Grocy nede?) — springer overview/sold/moms over');
        } else {
            await runOverviewAndMoms();
        }

        await runTargets();
        await runItemPrices();
    } catch (err) {
        console.error('FATAL:', err.stack);
    } finally {
        try { await runCleanup(); } catch (e) { console.error('Cleanup-fejl:', e.message); }
        const reportPath = writeReport();
        const pass = results.filter(r => r.status === 'PASS').length;
        const fail = results.filter(r => r.status === 'FAIL').length;
        const skip = results.filter(r => r.status === 'SKIP').length;
        console.log(`\n═══ SUMMARY ═══`);
        console.log(`${pass} PASS · ${fail} FAIL · ${skip} SKIP`);
        console.log(`Report: ${reportPath}`);
        process.exit(fail > 0 ? 1 : 0);
    }
}

main();
