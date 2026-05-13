#!/usr/bin/env node
/**
 * tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js
 * ════════════════════════════════════════════════════════════
 * Regression-runner for varemodtagelse — Patch A.
 *
 * Verificerer at de 5 fixes fra maj 2026 forbliver løste:
 *   F26 — counter ruller tilbage hvis INSERT fejler (transaction-wrap)
 *   F30 — photo_path nulles hvis temp-fil mangler
 *   F31 — webhook_dispatched-felt tilføjet
 *   F32 — received_by_name resolves via users-tabel
 *   F35 — UPDATE matcher på item.id (ikke grocy_product_id)
 *
 * Plus baseline: happy-path, validation, GET list/detail.
 *
 * Strategi:
 *   - Login som seeded kitchen-user (PIN 1234) for at få session-cookie
 *   - Test-data markeres med supplier_name = 'T_VAREMOD test' så cleanup
 *     kan slette præcist det testen har skabt. (Denne præfiks bruges KUN
 *     af denne runner — _FULL bruger 'T_VAREMOD_F test' så cleanup-grænser
 *     ikke krydsforurener)
 *   - F35 testes ved at sende bogus grocy_product_id (999999) så addStock
 *     fejler kontrolleret — kræver ikke at ægte Grocy-stock mutates
 *   - Counter snapshot'es ved start og restores ved cleanup
 *
 * Usage:
 *   npm run test:run-varemod-patch
 *   node tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js --verbose
 *   node tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js --skip-cleanup
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt (test-DB med seedede users + settings)
 *   - test:server kører på port fra PORT env
 *
 * Reference:
 *   - tests/specs/T_VAREMODTAGELSE_PATCH_REGRESSION.md (spec for denne runner)
 *   - docs/archive/patches/PATCH_goods_receipts_critical_fixes.md (patch-detalje)
 *
 * Komplementær runner:
 *   - tests/scripts/run_T_VAREMODTAGELSE_FULL.js — bredere coverage
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs          = require('node:fs');
const path        = require('node:path');
const { openDb }  = require('../../db/compat');
const safetyCheck = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

const args = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const TEST_SUPPLIER = 'T_VAREMOD test';
const BOGUS_PID     = 999999;  // Garanteret ikke-eksisterende Grocy-pid

// ════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════

let db;
let SESSION_COOKIE = null;
let testUserId = null;
let testUserName = null;
let originalCounter = null;
const results = [];

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')        console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP')   console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)             console.log(`  ✓ ${id}`);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (SESSION_COOKIE) opts.headers['Cookie'] = SESSION_COOKIE;
    if (body !== null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res  = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function readCounter() {
    const row = db.prepare(
        `SELECT value FROM settings WHERE key = 'goods_receipt_number_next'`
    ).get();
    return parseInt(row?.value ?? '1');
}

function writeCounter(value) {
    db.prepare(
        `UPDATE settings SET value = ? WHERE key = 'goods_receipt_number_next'`
    ).run(String(value));
}

// ════════════════════════════════════════════════════════════
// Auth setup
// ════════════════════════════════════════════════════════════

async function login() {
    // Seedede brugere: id=3 kitchen@ristetrug.dk, PIN 1234 (migration 011)
    // Login via PIN er enklere end at oprette ny test-user med password
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) {
        throw new Error(`Login (PIN) fejlede: status=${res.status}`);
    }
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('Ingen set-cookie fra /api/auth/pin');
    SESSION_COOKIE = setCookie.split(';')[0];
}

// ════════════════════════════════════════════════════════════
// Test-payload builder (default-værdier, override per case)
// ════════════════════════════════════════════════════════════

function basePayload(overrides = {}) {
    return {
        supplier_name: TEST_SUPPLIER,
        received_by_name: 'Test Modtager',
        items: [{
            grocy_product_id: BOGUS_PID,
            product_name: 'Test vare',
            received_quantity: 0,
            status: 'missing'  // Skipper addStock — ingen Grocy-mutation
        }],
        ...overrides,
    };
}

// ════════════════════════════════════════════════════════════
// Setup-cases
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── Setup ──');

    // SETUP_01: settings har goods_receipt_number_prefix + _next
    {
        const prefix = db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_prefix'`).get();
        const next   = db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_next'`).get();
        if (prefix?.value && next?.value) {
            record('T_VAREMOD_SETUP_01', 'SETUP', 'PASS');
        } else {
            record('T_VAREMOD_SETUP_01', 'SETUP', 'FAIL',
                `Settings mangler: prefix=${JSON.stringify(prefix)}, next=${JSON.stringify(next)}`);
            return false;
        }
    }

    // SETUP_02: en aktiv user findes (til F32-test)
    {
        const user = db.prepare(
            `SELECT id, name FROM users WHERE is_active = 1 AND name IS NOT NULL ORDER BY id LIMIT 1`
        ).get();
        if (user) {
            testUserId   = user.id;
            testUserName = user.name;
            record('T_VAREMOD_SETUP_02', 'SETUP', 'PASS',
                VERBOSE ? `user=${user.id} ${user.name}` : '');
        } else {
            record('T_VAREMOD_SETUP_02', 'SETUP', 'FAIL', 'Ingen aktiv user fundet');
            return false;
        }
    }

    // SETUP_03: kan login
    {
        try {
            await login();
            record('T_VAREMOD_SETUP_03', 'SETUP', 'PASS');
        } catch (err) {
            record('T_VAREMOD_SETUP_03', 'SETUP', 'FAIL', err.message);
            return false;
        }
    }

    // SETUP_04: kan kalde GET /api/goods-receipts/users (auth-tjek)
    {
        const r = await api('GET', '/api/goods-receipts/users');
        if (r.status === 200 && Array.isArray(r.body)) {
            record('T_VAREMOD_SETUP_04', 'SETUP', 'PASS');
        } else {
            record('T_VAREMOD_SETUP_04', 'SETUP', 'FAIL', `status=${r.status}`);
            return false;
        }
    }

    // Gem counter til verifikation
    originalCounter = readCounter();
    if (VERBOSE) console.log(`    counter ved start: ${originalCounter}`);

    return true;
}

// ════════════════════════════════════════════════════════════
// HAPPY-cases
// ════════════════════════════════════════════════════════════

async function runHappyCases() {
    console.log('\n── Happy-path ──');

    const counterBefore = readCounter();
    const r = await api('POST', '/api/goods-receipts', basePayload());

    // HAPPY_01: 200 OK + felter
    if (r.status === 200 && r.body?.id && r.body?.receipt_number) {
        record('T_VAREMOD_HAPPY_01', 'HAPPY', 'PASS');
    } else {
        record('T_VAREMOD_HAPPY_01', 'HAPPY', 'FAIL',
            `status=${r.status}, body=${r.raw?.slice(0, 200)}`);
        return null;
    }

    // HAPPY_02: receipt findes i DB med status='approved'
    const row = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(r.body.id);
    if (row && row.status === 'approved' && row.receipt_number === r.body.receipt_number) {
        record('T_VAREMOD_HAPPY_02', 'HAPPY', 'PASS');
    } else {
        record('T_VAREMOD_HAPPY_02', 'HAPPY', 'FAIL',
            `DB-row: ${JSON.stringify(row)}`);
    }

    // HAPPY_03 (F31): response indeholder BÅDE webhook_sent og webhook_dispatched
    if (r.body.webhook_sent === true && r.body.webhook_dispatched === true) {
        record('T_VAREMOD_HAPPY_03', 'HAPPY', 'PASS');
    } else {
        record('T_VAREMOD_HAPPY_03', 'HAPPY', 'FAIL',
            `webhook_sent=${r.body.webhook_sent}, webhook_dispatched=${r.body.webhook_dispatched}`);
    }

    // HAPPY_04: items er indsat
    const items = db.prepare(`SELECT * FROM goods_receipt_items WHERE receipt_id = ?`).all(r.body.id);
    if (items.length === 1 && items[0].product_name === 'Test vare') {
        record('T_VAREMOD_HAPPY_04', 'HAPPY', 'PASS');
    } else {
        record('T_VAREMOD_HAPPY_04', 'HAPPY', 'FAIL',
            `items.length=${items.length}, first=${JSON.stringify(items[0])}`);
    }

    return r.body.id;
}

// ════════════════════════════════════════════════════════════
// VAL-cases (validation)
// ════════════════════════════════════════════════════════════

async function runValidationCases() {
    console.log('\n── Validation ──');

    // VAL_01: manglende supplier_name → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ supplier_name: undefined }));
        if (r.status === 400) {
            record('T_VAREMOD_VAL_01', 'VAL', 'PASS');
        } else {
            record('T_VAREMOD_VAL_01', 'VAL', 'FAIL', `status=${r.status}, body=${r.raw?.slice(0,150)}`);
        }
    }

    // VAL_02: manglende både received_by_name OG received_by_user_id → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ received_by_name: undefined }));
        if (r.status === 400) {
            record('T_VAREMOD_VAL_02', 'VAL', 'PASS');
        } else {
            record('T_VAREMOD_VAL_02', 'VAL', 'FAIL', `status=${r.status}`);
        }
    }

    // VAL_03: tom items[] → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ items: [] }));
        if (r.status === 400) {
            record('T_VAREMOD_VAL_03', 'VAL', 'PASS');
        } else {
            record('T_VAREMOD_VAL_03', 'VAL', 'FAIL', `status=${r.status}`);
        }
    }

    // VAL_04: items er ikke et array → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ items: 'not an array' }));
        if (r.status === 400) {
            record('T_VAREMOD_VAL_04', 'VAL', 'PASS');
        } else {
            record('T_VAREMOD_VAL_04', 'VAL', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// NUM-cases (counter-adfærd, dækker F26)
// ════════════════════════════════════════════════════════════

async function runCounterCases() {
    console.log('\n── Counter / receipt-number (F26) ──');

    // NUM_01: counter advancer præcis 1 ved successful POST
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts', basePayload());
        const after = readCounter();
        if (r.status === 200 && after === before + 1) {
            record('T_VAREMOD_NUM_01', 'NUM', 'PASS');
        } else {
            record('T_VAREMOD_NUM_01', 'NUM', 'FAIL',
                `before=${before}, after=${after}, status=${r.status}`);
        }
    }

    // NUM_02: counter UÆNDRET ved validation-fejl (validation kommer før counter)
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ supplier_name: undefined }));
        const after = readCounter();
        if (r.status === 400 && after === before) {
            record('T_VAREMOD_NUM_02', 'NUM', 'PASS');
        } else {
            record('T_VAREMOD_NUM_02', 'NUM', 'FAIL',
                `before=${before}, after=${after}, status=${r.status}`);
        }
    }

    // NUM_03 (F26): counter UÆNDRET hvis items-INSERT fejler i transaction.
    // Status-feltet har CHECK ('ok','missing','wrong','damaged') — alt andet
    // får INSERT til at kaste → transaction rulles tilbage → counter restores.
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts', basePayload({
            items: [{
                grocy_product_id: BOGUS_PID,
                product_name: 'Test vare med ugyldig status',
                received_quantity: 0,
                status: 'INVALID_STATUS_VALUE'  // bryder CHECK constraint
            }]
        }));
        const after = readCounter();

        // Vi forventer 5xx (CHECK constraint kaster) og counter UÆNDRET
        if (r.status >= 400 && after === before) {
            record('T_VAREMOD_NUM_03', 'NUM', 'PASS',
                VERBOSE ? `status=${r.status}, counter holdt på ${before}` : '');
        } else {
            record('T_VAREMOD_NUM_03', 'NUM', 'FAIL',
                `F26 brudt: før=${before}, efter=${after}, status=${r.status}, body=${r.raw?.slice(0,200)}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// USER-cases (F32: received_by_name via users-lookup)
// ════════════════════════════════════════════════════════════

async function runUserLookupCases() {
    console.log('\n── F32: received_by_name lookup ──');

    // USER_01 (F32): kun received_by_user_id → DB-row har resolved name
    {
        const r = await api('POST', '/api/goods-receipts', basePayload({
            received_by_name: undefined,
            received_by_user_id: testUserId,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_USER_01', 'USER', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT received_by, received_by_name FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row && row.received_by_name === testUserName) {
                record('T_VAREMOD_USER_01', 'USER', 'PASS',
                    VERBOSE ? `resolved '${testUserName}' fra users.id=${testUserId}` : '');
            } else {
                record('T_VAREMOD_USER_01', 'USER', 'FAIL',
                    `forventet received_by_name='${testUserName}', fik '${row?.received_by_name}'`);
            }
        }
    }

    // USER_02: eksplicit received_by_name bruges (lookup overrules ikke)
    {
        const r = await api('POST', '/api/goods-receipts', basePayload({
            received_by_name: 'Eksplicit Navn',
            received_by_user_id: testUserId,  // har anden name i users-tabel
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_USER_02', 'USER', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT received_by_name FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row?.received_by_name === 'Eksplicit Navn') {
                record('T_VAREMOD_USER_02', 'USER', 'PASS');
            } else {
                record('T_VAREMOD_USER_02', 'USER', 'FAIL',
                    `forventet 'Eksplicit Navn', fik '${row?.received_by_name}'`);
            }
        }
    }

    // USER_03 (F26 + F32 sammenflettet): ugyldig user_id → FK-constraint kaster,
    // transaction rulles tilbage → counter UÆNDRET + ingen receipt skabt.
    // Bonus-bekræftelse på at F26 (transaction-rollback) virker for FK-fejl,
    // ikke kun CHECK-fejl som NUM_03 dækker.
    {
        const counterBefore = readCounter();
        const r = await api('POST', '/api/goods-receipts', basePayload({
            received_by_name: undefined,
            received_by_user_id: 999999,  // FK violation — users(id) findes ikke
        }));
        const counterAfter = readCounter();

        if (r.status >= 400 && counterAfter === counterBefore) {
            record('T_VAREMOD_USER_03', 'USER', 'PASS',
                VERBOSE ? `FK-violation status=${r.status}, counter holdt på ${counterBefore}` : '');
        } else {
            record('T_VAREMOD_USER_03', 'USER', 'FAIL',
                `status=${r.status}, counter: ${counterBefore} → ${counterAfter}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// DUP-cases (F35: UPDATE matcher på item.id ikke pid)
// ════════════════════════════════════════════════════════════

async function runDuplicatePidCases() {
    console.log('\n── F35: duplikat grocy_product_id i samme receipt ──');

    // DUP_01 (F35): To items, samme grocy_product_id.
    //   Item A: status='ok', qty=5, BOGUS_PID → addStock fejler → grocy_error sættes
    //   Item B: status='missing', qty=0, BOGUS_PID → skippes (intet UPDATE)
    //
    // Før patch: A's error-UPDATE matchede WHERE pid=BOGUS_PID → skrev error
    //            til BÅDE rækker (selvom B var skipped).
    // Efter patch: UPDATE matcher på id → kun A's række får error, B forbliver
    //              med default-værdier (grocy_added=0, grocy_error=NULL).
    {
        const r = await api('POST', '/api/goods-receipts', basePayload({
            items: [
                {
                    grocy_product_id: BOGUS_PID,
                    product_name: 'Spinat batch A',
                    received_quantity: 5,
                    status: 'ok',
                    notes: 'F35_test_A'
                },
                {
                    grocy_product_id: BOGUS_PID,
                    product_name: 'Spinat batch B',
                    received_quantity: 0,
                    status: 'missing',
                    notes: 'F35_test_B'
                },
            ]
        }));

        if (r.status !== 200) {
            record('T_VAREMOD_DUP_01', 'DUP', 'FAIL', `POST status=${r.status}`);
            record('T_VAREMOD_DUP_02', 'DUP', 'SKIP', 'forrige case fejlede');
            return;
        }

        const items = db.prepare(
            `SELECT id, product_name, notes, grocy_added, grocy_error
             FROM goods_receipt_items
             WHERE receipt_id = ?
             ORDER BY id`
        ).all(r.body.id);

        // DUP_01: begge items findes med UNIK id og korrekte notes (insert-side)
        const itemA = items.find(i => i.notes === 'F35_test_A');
        const itemB = items.find(i => i.notes === 'F35_test_B');
        if (itemA && itemB && itemA.id !== itemB.id
            && itemA.product_name === 'Spinat batch A'
            && itemB.product_name === 'Spinat batch B') {
            record('T_VAREMOD_DUP_01', 'DUP', 'PASS');
        } else {
            record('T_VAREMOD_DUP_01', 'DUP', 'FAIL',
                `items=${JSON.stringify(items)}`);
        }

        // DUP_02 (F35 kernen): A har error sat, B har IKKE.
        // Hvis F35-bug stadig findes vil B ALDREN have ARVET A's error.
        if (itemA && itemB) {
            const aFailed   = itemA.grocy_added === 0 && itemA.grocy_error !== null;
            const bUntouched = itemB.grocy_added === 0 && itemB.grocy_error === null;
            if (aFailed && bUntouched) {
                record('T_VAREMOD_DUP_02', 'DUP', 'PASS',
                    VERBOSE
                        ? `A.grocy_error='${itemA.grocy_error?.slice(0,40)}...', B.grocy_error=NULL`
                        : '');
            } else {
                record('T_VAREMOD_DUP_02', 'DUP', 'FAIL',
                    `F35 stadig brudt — `
                    + `A: added=${itemA.grocy_added} error=${JSON.stringify(itemA.grocy_error)} | `
                    + `B: added=${itemB.grocy_added} error=${JSON.stringify(itemB.grocy_error)} `
                    + `(B burde være urørt)`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// PHOTO-cases (F30)
// ════════════════════════════════════════════════════════════

async function runPhotoCases() {
    console.log('\n── F30: photo_path nulling ──');

    // PHOTO_01 (F30): photo_path peger på ikke-eksisterende temp-fil → NULL i DB
    {
        const r = await api('POST', '/api/goods-receipts', basePayload({
            photo_path: '/uploads/receipts/vr-tmp-nonexistent-99999999.jpg'
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_PHOTO_01', 'PHOTO', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT photo_path FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row?.photo_path === null) {
                record('T_VAREMOD_PHOTO_01', 'PHOTO', 'PASS');
            } else {
                record('T_VAREMOD_PHOTO_01', 'PHOTO', 'FAIL',
                    `F30 brudt — photo_path='${row?.photo_path}', forventet NULL`);
            }
        }
    }

    // PHOTO_02: photo_path uden vr-tmp prefix bevares som-er (ingen rename forsøgt)
    {
        const r = await api('POST', '/api/goods-receipts', basePayload({
            photo_path: '/uploads/receipts/existing-photo.jpg'
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_PHOTO_02', 'PHOTO', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT photo_path FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row?.photo_path === '/uploads/receipts/existing-photo.jpg') {
                record('T_VAREMOD_PHOTO_02', 'PHOTO', 'PASS');
            } else {
                record('T_VAREMOD_PHOTO_02', 'PHOTO', 'FAIL',
                    `non-tmp path ændret: '${row?.photo_path}'`);
            }
        }
    }

    // PHOTO_03: ingen photo_path → DB har NULL (uændret)
    {
        const r = await api('POST', '/api/goods-receipts', basePayload());
        if (r.status !== 200) {
            record('T_VAREMOD_PHOTO_03', 'PHOTO', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT photo_path FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row?.photo_path === null) {
                record('T_VAREMOD_PHOTO_03', 'PHOTO', 'PASS');
            } else {
                record('T_VAREMOD_PHOTO_03', 'PHOTO', 'FAIL',
                    `forventet NULL, fik '${row?.photo_path}'`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// LIST/DETAIL-cases (GET-endpoints)
// ════════════════════════════════════════════════════════════

async function runListDetailCases() {
    console.log('\n── GET list / detail ──');

    // LIST_01: GET / med supplier-filter finder vores test-rækker
    {
        const r = await api('GET', `/api/goods-receipts?supplier=${encodeURIComponent('T_VAREMOD')}`);
        if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 1) {
            record('T_VAREMOD_LIST_01', 'LIST', 'PASS',
                VERBOSE ? `fundet ${r.body.length} test-receipts` : '');
        } else {
            record('T_VAREMOD_LIST_01', 'LIST', 'FAIL',
                `status=${r.status}, count=${r.body?.length}`);
        }
    }

    // DETAIL_01: GET /:id returnerer receipt med items[]
    {
        const oneId = db.prepare(
            `SELECT id FROM goods_receipts WHERE supplier_name = ? ORDER BY id DESC LIMIT 1`
        ).get(TEST_SUPPLIER)?.id;

        if (!oneId) {
            record('T_VAREMOD_DETAIL_01', 'DETAIL', 'SKIP', 'ingen test-receipt at slå op');
            return;
        }

        const r = await api('GET', `/api/goods-receipts/${oneId}`);
        if (r.status === 200 && r.body?.id === oneId && Array.isArray(r.body?.items)) {
            record('T_VAREMOD_DETAIL_01', 'DETAIL', 'PASS');
        } else {
            record('T_VAREMOD_DETAIL_01', 'DETAIL', 'FAIL',
                `status=${r.status}, has items=${Array.isArray(r.body?.items)}`);
        }
    }

    // DETAIL_02: ukendt id → 404
    {
        const r = await api('GET', '/api/goods-receipts/999999');
        if (r.status === 404) {
            record('T_VAREMOD_DETAIL_02', 'DETAIL', 'PASS');
        } else {
            record('T_VAREMOD_DETAIL_02', 'DETAIL', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════

async function cleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n[cleanup] SKIPPED (--skip-cleanup) — test-rækker bliver i DB');
        return;
    }

    console.log('\n── Cleanup ──');

    const rows = db.prepare(
        `SELECT id FROM goods_receipts WHERE supplier_name = ?`
    ).all(TEST_SUPPLIER);

    if (rows.length === 0) {
        console.log('  Intet at rydde op.');
    } else {
        const ids = rows.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(
            `DELETE FROM goods_receipt_items WHERE receipt_id IN (${placeholders})`
        ).run(...ids);
        db.prepare(
            `DELETE FROM goods_receipts WHERE supplier_name = ?`
        ).run(TEST_SUPPLIER);
        console.log(`  ✓ Slettet ${ids.length} test-receipts + items`);
    }

    // Restore counter til pre-test-værdi
    if (originalCounter !== null) {
        const currentCounter = readCounter();
        writeCounter(originalCounter);
        if (VERBOSE) {
            console.log(`  ↻ Counter: ${currentCounter} → ${originalCounter} (restored)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_VAREMODTAGELSE_PATCH_REGRESSION_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','HAPPY','VAL','NUM','USER','DUP','PHOTO','LIST','DETAIL'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass: inGroup.filter(r => r.status === 'PASS').length,
            fail: inGroup.filter(r => r.status === 'FAIL').length,
            skip: inGroup.filter(r => r.status === 'SKIP').length,
        };
    }

    let md = `# T_VAREMODTAGELSE_PATCH_REGRESSION — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** ${SERVER_URL} · DB: ${process.env.DB_PATH}\n\n`;
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
            md += `| ${f.id} | ${(f.detail || '').replace(/\|/g, '\\|')} |\n`;
        }
    }

    md += `\n## Alle cases\n\n| ID | Gruppe | Status | Note |\n|----|--------|--------|------|\n`;
    for (const r of results) {
        md += `| ${r.id} | ${r.group} | ${r.status} | ${(r.detail || '').replace(/\|/g, '\\|')} |\n`;
    }

    md += `\n## Patch-dækning\n\n`;
    md += `| Finding | Dækket af | Status |\n|---------|-----------|--------|\n`;
    const patchMap = {
        'F26': 'T_VAREMOD_NUM_01-03',
        'F30': 'T_VAREMOD_PHOTO_01-03',
        'F31': 'T_VAREMOD_HAPPY_03',
        'F32': 'T_VAREMOD_USER_01-03',
        'F35': 'T_VAREMOD_DUP_01-02',
    };
    for (const [f, cases] of Object.entries(patchMap)) {
        const ids = cases.match(/T_VAREMOD_[A-Z]+_\d+/g) || [];
        const status = ids.every(id => {
            const r = results.find(x => x.id === id);
            return r && r.status === 'PASS';
        }) ? '✓' : '✗';
        md += `| ${f} | ${cases} | ${status} |\n`;
    }

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_VAREMODTAGELSE_PATCH_REGRESSION] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_VAREMODTAGELSE_PATCH_REGRESSION] Server: ${SERVER_URL}`);
    console.log(`[run_T_VAREMODTAGELSE_PATCH_REGRESSION] DB:     ${process.env.DB_PATH}`);
    if (SKIP_CLEANUP) console.log(`[run_T_VAREMODTAGELSE_PATCH_REGRESSION] WARNING: --skip-cleanup`);

    // Verificer at server svarer
    try {
        const r = await fetch(`${SERVER_URL}/api/auth/pin-users`);
        if (r.status !== 200) {
            console.error(`[run_T_VAREMODTAGELSE_PATCH_REGRESSION] Server svarer ${r.status} på /api/auth/pin-users`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_VAREMODTAGELSE_PATCH_REGRESSION] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    const setupOk = await runSetupCases();
    if (!setupOk) {
        console.error('[run_T_VAREMODTAGELSE_PATCH_REGRESSION] Setup fejlede — bryder');
        db.close();
        const { fails } = writeReport();
        process.exit(fails > 0 ? 1 : 0);
    }

    try {
        await runHappyCases();
        await runValidationCases();
        await runCounterCases();
        await runUserLookupCases();
        await runDuplicatePidCases();
        await runPhotoCases();
        await runListDetailCases();
    } catch (err) {
        console.error('[run_T_VAREMODTAGELSE_PATCH_REGRESSION] FEJL under test:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await cleanup();

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_VAREMODTAGELSE_PATCH_REGRESSION] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_VAREMODTAGELSE_PATCH_REGRESSION] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
