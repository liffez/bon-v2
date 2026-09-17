#!/usr/bin/env node
/**
 * tests/scripts/run_T_VAREMODTAGELSE_FULL.js
 * ════════════════════════════════════════════════════════════
 * Bred test-runner for varemodtagelse — kører oven på
 * run_T_VAREMODTAGELSE_PATCH_REGRESSION.js (der dækker Patch A's fixes).
 *
 * Dækker ~49 cases på tværs af 12 grupper:
 *   NUM     — receipt-number sequence + format          (6)
 *   VAL     — validation-grene                          (6)
 *   TEMP    — temperature-felter (køl + frys)            (6)
 *   CHECK   — date/labeling/packaging checks            (3)
 *   DEV     — deviation-felter                          (3)
 *   PHOTO_F — foto-upload edge cases (PNG/WebP/over-size) (6)
 *   FAIL    — partial Grocy-failure (ægte addStock)     (5)
 *   CONC    — concurrency på receipt-number             (2)
 *   LIST    — GET / filter-tests                        (6)
 *   DETAIL  — GET /:id                                  (3)
 *   USERS   — GET /users dropdown                       (3)
 *   CLEANUP — verifikation af hermetisk cleanup         (5)
 *
 * Strategi:
 *   - Test-data markeres med supplier_name = 'T_VAREMOD_F test' (forskelligt
 *     fra PATCH_REGRESSION's 'T_VAREMOD test' så cleanup-grænser ikke
 *     krydsforurener)
 *   - Photo-fixtures genereres inline (Buffer + image/* mime-type — busboy
 *     validerer ikke PNG/WebP-headers, kun mime)
 *   - FAIL-gruppen muterer ægte Grocy (pid=1 + pid=2 fra T_INDKOB_pids.json),
 *     snapshot+consume-cleanup som T_INVENTORY
 *   - Webhook auto-mock'es via NODE_ENV=test — kald fanges i in-memory buffer
 *     der hentes via /api/test/sent-webhooks
 *   - Counter snapshot'es ved start og restores ved cleanup
 *
 * Usage:
 *   npm run test:run-varemod-full
 *   node tests/scripts/run_T_VAREMODTAGELSE_FULL.js --verbose
 *   node tests/scripts/run_T_VAREMODTAGELSE_FULL.js --skip-cleanup
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt
 *   - test:server kører
 *   - NODE_ENV=test (auto-mock kræver det)
 *   - Grocy test-instans tilgængelig (FAIL-gruppen)
 *
 * Reference: tests/specs/T_VAREMODTAGELSE_FULL.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs          = require('node:fs');
const path        = require('node:path');
const { openDb }  = require('../../db/compat');
const safetyCheck = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'data', 'uploads', 'receipts');

const args         = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const TEST_SUPPLIER = 'T_VAREMOD_F test';

// Bogus pid bruges når vi vil have addStock til at fejle kontrolleret
const BOGUS_PID = 999999;

// FAIL-gruppen bruger ægte pids fra T_INDKOB_pids.json — har stock på grocytest
const REAL_PID_A = 1;  // Brød Rug
const REAL_PID_B = 2;  // Glutenfri Bolle
const FAIL_QTY   = 1;  // Lille mængde — minimal stock-drift hvis cleanup fejler

// #358: klienten oplyser nu hvilken enhed det modtagne tal står i. Brød Rug og
// Glutenfri Bolle KØBES i kasser men LAGERFØRES i kilo — netop den forveksling
// der fordoblede lageret i drift. Tallene her er i lager-enhed (faktor 1), så
// mængde-assertionerne nedenfor er uændrede; selve omregningen dækkes af
// UNIT-gruppen til sidst.
const STOCK_QU   = 4;  // Kilo — qu_id_stock for både REAL_PID_A og _B

// ════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════

let db;
let SESSION_COOKIE = null;
let testUserId = null;
let originalCounter = null;
const results = [];

// Track ting der skal cleanup'es
const createdReceiptIds = [];      // for DELETE FROM goods_receipts
const grocyMutations = [];         // [{ pid, amount }] for consume-back
const createdPhotoPaths = [];      // /uploads/receipts/* filer

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

async function uploadPhoto(buffer, mimeType, filename = 'test.bin') {
    const fd = new FormData();
    fd.append('photo', new Blob([buffer], { type: mimeType }), filename);
    const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const res = await fetch(`${SERVER_URL}/api/goods-receipts/photo`, {
        method: 'POST',
        body: fd,
        headers,
    });
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

async function login() {
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

// Admin-session. Test-DB'ens admin-bruger (migration 011) har hverken pin eller
// password, så vi giver den en midlertidig pin og logger ind via PIN. Returnerer
// cookien i stedet for at overskrive den globale kitchen-session.
async function adminLogin() {
    const admin = db.prepare(
        `SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`
    ).get();
    if (!admin) throw new Error('Ingen admin-bruger i test-DB');
    db.prepare(`UPDATE users SET pin = '9911' WHERE id = ?`).run(admin.id);

    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '9911', user_id: admin.id }),
    });
    if (res.status !== 200) throw new Error(`Admin-login (PIN) fejlede: status=${res.status}`);
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('Ingen set-cookie fra admin-login');
    return setCookie.split(';')[0];
}

// Som api(), men med en eksplicit cookie (bruges til admin-session).
async function apiAs(cookie, method, pathPart, body = null) {
    const opts = { method, headers: { Cookie: cookie } };
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

function basePayload(overrides = {}) {
    return {
        supplier_name: TEST_SUPPLIER,
        received_by_name: 'Test Modtager',
        items: [{
            grocy_product_id: BOGUS_PID,
            product_name: 'Test vare',
            received_quantity: 0,
            status: 'missing'  // Skipper addStock
        }],
        ...overrides,
    };
}

// Helper: POST receipt og track id automatisk
async function createReceipt(payload) {
    const r = await api('POST', '/api/goods-receipts', payload);
    if (r.status === 200 && r.body?.id) {
        createdReceiptIds.push(r.body.id);
    }
    return r;
}

// Webhook buffer-helpers
async function clearWebhookBuffer() {
    await api('POST', '/api/test/clear-webhooks');
}

async function getWebhookBuffer() {
    const r = await api('GET', '/api/test/sent-webhooks');
    return r.body?.webhooks || [];
}

// ════════════════════════════════════════════════════════════
// SETUP
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── Setup ──');

    // SETUP_01: NODE_ENV=test (auto-mock kræver det)
    if (process.env.NODE_ENV === 'test') {
        record('T_VAREMOD_F_SETUP_01', 'SETUP', 'PASS');
    } else {
        record('T_VAREMOD_F_SETUP_01', 'SETUP', 'FAIL',
            `NODE_ENV='${process.env.NODE_ENV}' — webhook auto-mock virker ikke`);
        return false;
    }

    // SETUP_02: Test-server svarer
    try {
        const r = await fetch(`${SERVER_URL}/api/auth/pin-users`);
        if (r.status === 200) {
            record('T_VAREMOD_F_SETUP_02', 'SETUP', 'PASS');
        } else {
            record('T_VAREMOD_F_SETUP_02', 'SETUP', 'FAIL', `status=${r.status}`);
            return false;
        }
    } catch (err) {
        record('T_VAREMOD_F_SETUP_02', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_03: Login + cookie
    try {
        await login();
        record('T_VAREMOD_F_SETUP_03', 'SETUP', 'PASS');
    } catch (err) {
        record('T_VAREMOD_F_SETUP_03', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_04: Aktiv user til F32-genskabning
    const user = db.prepare(
        `SELECT id, name FROM users WHERE is_active = 1 AND name IS NOT NULL ORDER BY id LIMIT 1`
    ).get();
    if (user) {
        testUserId = user.id;
        record('T_VAREMOD_F_SETUP_04', 'SETUP', 'PASS');
    } else {
        record('T_VAREMOD_F_SETUP_04', 'SETUP', 'FAIL', 'Ingen aktiv user');
        return false;
    }

    // SETUP_05: Webhook-buffer endpoint reachable
    try {
        await clearWebhookBuffer();
        const initial = await getWebhookBuffer();
        if (initial.length === 0) {
            record('T_VAREMOD_F_SETUP_05', 'SETUP', 'PASS');
        } else {
            record('T_VAREMOD_F_SETUP_05', 'SETUP', 'FAIL',
                `Buffer ikke tom efter clear: ${initial.length}`);
        }
    } catch (err) {
        record('T_VAREMOD_F_SETUP_05', 'SETUP', 'FAIL', err.message);
        return false;
    }

    originalCounter = readCounter();
    if (VERBOSE) console.log(`    counter ved start: ${originalCounter}`);

    return true;
}

// ════════════════════════════════════════════════════════════
// NUM — receipt-number sequence + format (6 cases)
// ════════════════════════════════════════════════════════════

async function runNumCases() {
    console.log('\n── NUM: receipt-number sequence ──');

    // NUM_01: snapshot counter, opret 1, tjek counter
    {
        const before = readCounter();
        const r = await createReceipt(basePayload());
        const after = readCounter();
        if (r.status === 200 && after === before + 1) {
            record('T_VAREMOD_F_NUM_01', 'NUM', 'PASS');
        } else {
            record('T_VAREMOD_F_NUM_01', 'NUM', 'FAIL',
                `before=${before}, after=${after}, status=${r.status}`);
        }
    }

    // NUM_02: Format matcher regex
    {
        const r = await createReceipt(basePayload());
        if (r.status !== 200) {
            record('T_VAREMOD_F_NUM_02', 'NUM', 'FAIL', `status=${r.status}`);
        } else {
            const ok = /^VR-\d{4}-\d{3}$/.test(r.body.receipt_number);
            if (ok) {
                record('T_VAREMOD_F_NUM_02', 'NUM', 'PASS',
                    VERBOSE ? r.body.receipt_number : '');
            } else {
                record('T_VAREMOD_F_NUM_02', 'NUM', 'FAIL',
                    `'${r.body.receipt_number}' matcher ikke ^VR-\\d{4}-\\d{3}$`);
            }
        }
    }

    // NUM_03: Year-segment = current year
    {
        const r = await createReceipt(basePayload());
        if (r.status !== 200) {
            record('T_VAREMOD_F_NUM_03', 'NUM', 'FAIL', `status=${r.status}`);
        } else {
            const expectedYear = new Date().getFullYear();
            const match = r.body.receipt_number.match(/^VR-(\d{4})-/);
            if (match && parseInt(match[1]) === expectedYear) {
                record('T_VAREMOD_F_NUM_03', 'NUM', 'PASS');
            } else {
                record('T_VAREMOD_F_NUM_03', 'NUM', 'FAIL',
                    `Year-segment '${match?.[1]}' ≠ ${expectedYear}`);
            }
        }
    }

    // NUM_04: Sequence-segment padding (3-cifret minimum).
    // Bruger kun værdier ≥ 99 fordi lave counter-værdier (1-98) kan kollidere
    // med UNIQUE constraint på receipt_number — tests længere oppe har allerede
    // brugt 1-7. counter=99 + 100 dækker padding-grænsen (099 → 100).
    {
        const checks = [
            { counter: 99,  expected: '099', note: '2→3 cifre padding' },
            { counter: 100, expected: '100', note: 'ingen padding påkrævet' },
        ];
        const failures = [];
        for (const { counter, expected } of checks) {
            writeCounter(counter);
            const r = await createReceipt(basePayload());
            if (r.status !== 200) {
                failures.push(`counter=${counter}: status=${r.status} (${r.body?.error || ''})`);
                continue;
            }
            const seqMatch = r.body.receipt_number.match(/-(\d+)$/);
            const seq = seqMatch?.[1];
            if (seq !== expected) {
                failures.push(`counter=${counter}: forventet seq=${expected}, fik ${seq}`);
            }
        }
        if (failures.length === 0) {
            record('T_VAREMOD_F_NUM_04', 'NUM', 'PASS');
        } else {
            record('T_VAREMOD_F_NUM_04', 'NUM', 'FAIL', failures.join('; '));
        }
    }

    // NUM_05: Counter rulles tilbage hvis INSERT fejler (F26 — re-test)
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts', basePayload({
            items: [{
                grocy_product_id: BOGUS_PID,
                product_name: 'Bad status item',
                received_quantity: 0,
                status: 'INVALID_STATUS_VALUE'  // CHECK violation
            }]
        }));
        const after = readCounter();
        if (r.status >= 400 && after === before) {
            record('T_VAREMOD_F_NUM_05', 'NUM', 'PASS');
        } else {
            record('T_VAREMOD_F_NUM_05', 'NUM', 'FAIL',
                `F26 regression: før=${before}, efter=${after}, status=${r.status}`);
        }
    }

    // NUM_06: To receipts hurtigt efter hinanden får forskellige numre
    {
        const rA = await createReceipt(basePayload());
        const rB = await createReceipt(basePayload());
        if (rA.status === 200 && rB.status === 200
            && rA.body.receipt_number !== rB.body.receipt_number) {
            record('T_VAREMOD_F_NUM_06', 'NUM', 'PASS',
                VERBOSE ? `${rA.body.receipt_number} ≠ ${rB.body.receipt_number}` : '');
        } else {
            record('T_VAREMOD_F_NUM_06', 'NUM', 'FAIL',
                `A=${rA.body?.receipt_number}, B=${rB.body?.receipt_number}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// VAL — validation (6 cases)
// ════════════════════════════════════════════════════════════

async function runValidationCases() {
    console.log('\n── VAL: validation-grene ──');

    // VAL_01: Manglende supplier_name → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ supplier_name: undefined }));
        if (r.status === 400) record('T_VAREMOD_F_VAL_01', 'VAL', 'PASS');
        else record('T_VAREMOD_F_VAL_01', 'VAL', 'FAIL', `status=${r.status}`);
    }

    // VAL_02: Manglende både received_by_name OG received_by_user_id → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ received_by_name: undefined }));
        if (r.status === 400) record('T_VAREMOD_F_VAL_02', 'VAL', 'PASS');
        else record('T_VAREMOD_F_VAL_02', 'VAL', 'FAIL', `status=${r.status}`);
    }

    // VAL_03: Kun received_by_user_id (uden name) → 200
    {
        const r = await createReceipt(basePayload({
            received_by_name: undefined,
            received_by_user_id: testUserId,
        }));
        if (r.status === 200) record('T_VAREMOD_F_VAL_03', 'VAL', 'PASS');
        else record('T_VAREMOD_F_VAL_03', 'VAL', 'FAIL', `status=${r.status}`);
    }

    // VAL_04: items=[] → 200 (varefri fødevarekontrol-registrering er tilladt).
    // Tidligere blokeret med 400; ændret så ad-hoc varer (købt uden om
    // indkøbsmodulet) kan registreres uden varelinjer.
    {
        const r = await createReceipt(basePayload({ items: [] }));
        if (r.status !== 200 || !r.body?.id) {
            record('T_VAREMOD_F_VAL_04', 'VAL', 'FAIL', `status=${r.status}`);
        } else {
            const itemCount = db.prepare(
                `SELECT COUNT(*) AS n FROM goods_receipt_items WHERE receipt_id = ?`
            ).get(r.body.id).n;
            const status = db.prepare(
                `SELECT status FROM goods_receipts WHERE id = ?`
            ).get(r.body.id)?.status;
            if (itemCount === 0 && status === 'approved') {
                record('T_VAREMOD_F_VAL_04', 'VAL', 'PASS',
                    VERBOSE ? 'varefri: 0 items, status approved' : '');
            } else {
                record('T_VAREMOD_F_VAL_04', 'VAL', 'FAIL',
                    `items=${itemCount} status=${status} (forventede 0/approved)`);
            }
        }
    }

    // VAL_05: items=null → 400
    {
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ items: null }));
        if (r.status === 400) record('T_VAREMOD_F_VAL_05', 'VAL', 'PASS');
        else record('T_VAREMOD_F_VAL_05', 'VAL', 'FAIL', `status=${r.status}`);
    }

    // VAL_06 (F37 LUKKET — patch B): item uden product_name → 400 + counter UÆNDRET.
    //
    // Patch B fix: eksplicit validation efter de øvrige valideringer (før transaction)
    // tjekker hvert item's product_name. Returnerer pæn 400-besked i stedet for
    // SQLite NOT NULL 500-fejl.
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts', basePayload({
            items: [{
                grocy_product_id: BOGUS_PID,
                // product_name UDELADT bevidst
                received_quantity: 0,
                status: 'missing'
            }]
        }));
        const after = readCounter();
        const hasIndexedError = typeof r.body?.error === 'string'
            && r.body.error.includes('product_name')
            && r.body.error.includes('[0]');

        if (r.status === 400 && hasIndexedError && after === before) {
            record('T_VAREMOD_F_VAL_06', 'VAL', 'PASS',
                VERBOSE ? `F37 lukket: ${r.body.error}` : '');
        } else {
            record('T_VAREMOD_F_VAL_06', 'VAL', 'FAIL',
                `F37: status=${r.status}, error='${r.body?.error}', counter ${before}→${after} (forventede 400 + indexed message + uændret counter)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// TEMP — temperature-felter (6 cases)
// ════════════════════════════════════════════════════════════

async function runTempCases() {
    console.log('\n── TEMP: temperature-felter ──');

    // TEMP_01: cool_enabled=true, value=4.0, ok=true → alle 3 sat
    {
        const r = await createReceipt(basePayload({
            temperature_cool_enabled: true,
            temperature_cool_value: 4.0,
            temperature_cool_ok: true,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_01', 'TEMP', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT temperature_cool_enabled, temperature_cool_value, temperature_cool_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.temperature_cool_enabled === 1
                && Math.abs(row.temperature_cool_value - 4.0) < 0.01
                && row.temperature_cool_ok === 1) {
                record('T_VAREMOD_F_TEMP_01', 'TEMP', 'PASS');
            } else {
                record('T_VAREMOD_F_TEMP_01', 'TEMP', 'FAIL', JSON.stringify(row));
            }
        }
    }

    // TEMP_02: cool_enabled=false + client sender value+ok alligevel → DB clampe til null
    {
        const r = await createReceipt(basePayload({
            temperature_cool_enabled: false,
            temperature_cool_value: 4.0,
            temperature_cool_ok: true,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_02', 'TEMP', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT temperature_cool_enabled, temperature_cool_value, temperature_cool_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.temperature_cool_enabled === 0
                && row.temperature_cool_value === null
                && row.temperature_cool_ok === null) {
                record('T_VAREMOD_F_TEMP_02', 'TEMP', 'PASS');
            } else {
                record('T_VAREMOD_F_TEMP_02', 'TEMP', 'FAIL',
                    `Clamp brudt: ${JSON.stringify(row)} (forventede enabled=0, value=null, ok=null)`);
            }
        }
    }

    // TEMP_03: frozen_enabled=true, value=-18, ok=true
    {
        const r = await createReceipt(basePayload({
            temperature_frozen_enabled: true,
            temperature_frozen_value: -18,
            temperature_frozen_ok: true,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_03', 'TEMP', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.temperature_frozen_enabled === 1
                && Math.abs(row.temperature_frozen_value - (-18)) < 0.01
                && row.temperature_frozen_ok === 1) {
                record('T_VAREMOD_F_TEMP_03', 'TEMP', 'PASS');
            } else {
                record('T_VAREMOD_F_TEMP_03', 'TEMP', 'FAIL', JSON.stringify(row));
            }
        }
    }

    // TEMP_04: Begge enabled → alle 6 felter sat
    {
        const r = await createReceipt(basePayload({
            temperature_cool_enabled: true,
            temperature_cool_value: 5.0,
            temperature_cool_ok: true,
            temperature_frozen_enabled: true,
            temperature_frozen_value: -20,
            temperature_frozen_ok: false,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_04', 'TEMP', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT temperature_cool_enabled, temperature_cool_value, temperature_cool_ok, temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            const ok = row.temperature_cool_enabled === 1
                && row.temperature_cool_value === 5.0
                && row.temperature_cool_ok === 1
                && row.temperature_frozen_enabled === 1
                && row.temperature_frozen_value === -20
                && row.temperature_frozen_ok === 0;
            if (ok) record('T_VAREMOD_F_TEMP_04', 'TEMP', 'PASS');
            else record('T_VAREMOD_F_TEMP_04', 'TEMP', 'FAIL', JSON.stringify(row));
        }
    }

    // TEMP_05: Begge disabled → alle 6 felter null/0
    {
        const r = await createReceipt(basePayload({
            temperature_cool_enabled: false,
            temperature_frozen_enabled: false,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_05', 'TEMP', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT temperature_cool_enabled, temperature_cool_value, temperature_cool_ok, temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            const ok = row.temperature_cool_enabled === 0
                && row.temperature_cool_value === null
                && row.temperature_cool_ok === null
                && row.temperature_frozen_enabled === 0
                && row.temperature_frozen_value === null
                && row.temperature_frozen_ok === null;
            if (ok) record('T_VAREMOD_F_TEMP_05', 'TEMP', 'PASS');
            else record('T_VAREMOD_F_TEMP_05', 'TEMP', 'FAIL', JSON.stringify(row));
        }
    }

    // TEMP_06 (F40 LUKKET — patch B): cool_enabled=true uden cool_value.
    //
    // Patch B fix: `enabled ? (value ?? null) : null` (i stedet for
    // `enabled ? value : null` der videregav undefined til node:sqlite).
    //
    // Vi verificerer nu at:
    //   - status er 200 (ingen crash)
    //   - DB.cool_enabled = 1
    //   - DB.cool_value = null (klampet fra undefined)
    //   - DB.cool_ok = matchet til hvad client sendte
    //   - Counter er bumpet
    {
        const before = readCounter();
        const r = await createReceipt(basePayload({
            temperature_cool_enabled: true,
            // value mangler bevidst
            temperature_cool_ok: true,
        }));
        const after = readCounter();

        if (r.status !== 200) {
            record('T_VAREMOD_F_TEMP_06', 'TEMP', 'FAIL',
                `F40 regression: status=${r.status} (forventede 200 efter patch B), counter ${before}→${after}`);
        } else {
            const row = db.prepare(
                `SELECT temperature_cool_enabled, temperature_cool_value, temperature_cool_ok FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row?.temperature_cool_enabled === 1
                && row?.temperature_cool_value === null
                && row?.temperature_cool_ok === 1
                && after === before + 1) {
                record('T_VAREMOD_F_TEMP_06', 'TEMP', 'PASS',
                    VERBOSE ? 'F40 lukket: ?? null klamping virker, counter bumpet' : '');
            } else {
                record('T_VAREMOD_F_TEMP_06', 'TEMP', 'FAIL',
                    `row=${JSON.stringify(row)}, counter ${before}→${after}`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// CHECK — date/labeling/packaging (3 cases)
// ════════════════════════════════════════════════════════════

async function runCheckCases() {
    console.log('\n── CHECK: date/labeling/packaging ──');

    // CHECK_01: alle 3 = true
    {
        const r = await createReceipt(basePayload({
            date_check_ok: true,
            labeling_check_ok: true,
            packaging_check_ok: true,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_CHECK_01', 'CHECK', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT date_check_ok, labeling_check_ok, packaging_check_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.date_check_ok === 1 && row.labeling_check_ok === 1 && row.packaging_check_ok === 1) {
                record('T_VAREMOD_F_CHECK_01', 'CHECK', 'PASS');
            } else {
                record('T_VAREMOD_F_CHECK_01', 'CHECK', 'FAIL', JSON.stringify(row));
            }
        }
    }

    // CHECK_02: alle 3 = false
    {
        const r = await createReceipt(basePayload({
            date_check_ok: false,
            labeling_check_ok: false,
            packaging_check_ok: false,
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_CHECK_02', 'CHECK', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT date_check_ok, labeling_check_ok, packaging_check_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.date_check_ok === 0 && row.labeling_check_ok === 0 && row.packaging_check_ok === 0) {
                record('T_VAREMOD_F_CHECK_02', 'CHECK', 'PASS');
            } else {
                record('T_VAREMOD_F_CHECK_02', 'CHECK', 'FAIL', JSON.stringify(row));
            }
        }
    }

    // CHECK_03: manglende felter (undefined → `? 1 : 0` → 0)
    {
        const r = await createReceipt(basePayload({
            // alle 3 udeladt
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_CHECK_03', 'CHECK', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT date_check_ok, labeling_check_ok, packaging_check_ok FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.date_check_ok === 0 && row.labeling_check_ok === 0 && row.packaging_check_ok === 0) {
                record('T_VAREMOD_F_CHECK_03', 'CHECK', 'PASS',
                    VERBOSE ? 'undefined → 0 (default)' : '');
            } else {
                record('T_VAREMOD_F_CHECK_03', 'CHECK', 'FAIL', JSON.stringify(row));
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// DEV — deviation-felter (3 cases)
// ════════════════════════════════════════════════════════════

async function runDeviationCases() {
    console.log('\n── DEV: deviation-felter ──');

    // DEV_01: has_deviation=true + type + note
    {
        const r = await createReceipt(basePayload({
            has_deviation: true,
            deviation_type: 'returned',
            deviation_note: 'for varm',
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_DEV_01', 'DEV', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT has_deviation, deviation_type, deviation_note FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.has_deviation === 1
                && row.deviation_type === 'returned'
                && row.deviation_note === 'for varm') {
                record('T_VAREMOD_F_DEV_01', 'DEV', 'PASS');
            } else {
                record('T_VAREMOD_F_DEV_01', 'DEV', 'FAIL', JSON.stringify(row));
            }
        }
    }

    // DEV_02 (F41 LUKKET — patch B): has_deviation=false men type/note sendt.
    //
    // Patch B fix: clamping af deviation_type + deviation_note til null når
    // has_deviation=false. Samme mønster som temperature-felterne.
    // Sikrer konsistent DB-state (ingen "phantom deviation").
    {
        const r = await createReceipt(basePayload({
            has_deviation: false,
            deviation_type: 'other',
            deviation_note: 'zombie',
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_DEV_02', 'DEV', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(
                `SELECT has_deviation, deviation_type, deviation_note FROM goods_receipts WHERE id = ?`
            ).get(r.body.id);
            if (row.has_deviation === 0
                && row.deviation_type === null
                && row.deviation_note === null) {
                record('T_VAREMOD_F_DEV_02', 'DEV', 'PASS',
                    VERBOSE ? 'F41 lukket: type+note klampet til null trods client-sent værdier' : '');
            } else if (row.has_deviation === 0
                && row.deviation_type === 'other'
                && row.deviation_note === 'zombie') {
                record('T_VAREMOD_F_DEV_02', 'DEV', 'FAIL',
                    `F41 regression: clamping fjernet — type='${row.deviation_type}', note='${row.deviation_note}' (forventede null/null)`);
            } else {
                record('T_VAREMOD_F_DEV_02', 'DEV', 'FAIL',
                    `Uventet: ${JSON.stringify(row)}`);
            }
        }
    }

    // DEV_03: has_deviation=true men tomme strings → null via || null
    {
        const r = await createReceipt(basePayload({
            has_deviation: true,
            deviation_type: '',
            deviation_note: '',
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_DEV_03', 'DEV', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT has_deviation, deviation_type, deviation_note FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row.has_deviation === 1
                && row.deviation_type === null
                && row.deviation_note === null) {
                record('T_VAREMOD_F_DEV_03', 'DEV', 'PASS');
            } else {
                record('T_VAREMOD_F_DEV_03', 'DEV', 'FAIL', JSON.stringify(row));
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// PHOTO_F — foto-upload edge cases (6 cases)
// ════════════════════════════════════════════════════════════

async function runPhotoCases() {
    console.log('\n── PHOTO_F: foto-upload edge cases ──');

    // PHOTO_F_01: text/plain → 400 "Kun billedfiler er tilladt"
    {
        const r = await uploadPhoto(Buffer.from('not an image'), 'text/plain', 'test.txt');
        if (r.status === 400 && r.body?.error?.includes('billedfiler')) {
            record('T_VAREMOD_F_PHOTO_F_01', 'PHOTO_F', 'PASS');
        } else {
            record('T_VAREMOD_F_PHOTO_F_01', 'PHOTO_F', 'FAIL',
                `status=${r.status}, body=${r.raw?.slice(0,150)}`);
        }
    }

    // PHOTO_F_02: ingen fil i form-data → 400
    {
        const fd = new FormData();
        const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
        const res = await fetch(`${SERVER_URL}/api/goods-receipts/photo`, {
            method: 'POST', body: fd, headers,
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 400 && body?.error?.includes('Ingen fil')) {
            record('T_VAREMOD_F_PHOTO_F_02', 'PHOTO_F', 'PASS');
        } else {
            record('T_VAREMOD_F_PHOTO_F_02', 'PHOTO_F', 'FAIL',
                `status=${res.status}, body=${JSON.stringify(body)}`);
        }
    }

    // PHOTO_F_03 (F38): 11 MB → 413
    {
        const big = Buffer.alloc(11 * 1024 * 1024);  // 11 MB zero-buffer
        const r = await uploadPhoto(big, 'image/jpeg', 'huge.jpg');
        if (r.status === 413) {
            record('T_VAREMOD_F_PHOTO_F_03', 'PHOTO_F', 'PASS');
        } else {
            record('T_VAREMOD_F_PHOTO_F_03', 'PHOTO_F', 'FAIL',
                `F38: status=${r.status} (forventede 413)`);
        }
    }

    // PHOTO_F_04: PNG → path slutter .png + fil findes
    {
        // Minimal "PNG" — busboy validerer kun mime-type, ikke header
        const r = await uploadPhoto(Buffer.from('fake-png-bytes'), 'image/png', 'test.png');
        if (r.status !== 200 || !r.body?.path) {
            record('T_VAREMOD_F_PHOTO_F_04', 'PHOTO_F', 'FAIL', `status=${r.status}`);
        } else {
            const filePath = path.join(UPLOAD_DIR, path.basename(r.body.path));
            createdPhotoPaths.push(filePath);
            const endsWithPng = r.body.path.endsWith('.png');
            const fileExists = fs.existsSync(filePath);
            if (endsWithPng && fileExists) {
                record('T_VAREMOD_F_PHOTO_F_04', 'PHOTO_F', 'PASS');
            } else {
                record('T_VAREMOD_F_PHOTO_F_04', 'PHOTO_F', 'FAIL',
                    `endsWithPng=${endsWithPng}, fileExists=${fileExists}, path=${r.body.path}`);
            }
        }
    }

    // PHOTO_F_05: WebP → path slutter .webp + fil findes
    {
        const r = await uploadPhoto(Buffer.from('fake-webp-bytes'), 'image/webp', 'test.webp');
        if (r.status !== 200 || !r.body?.path) {
            record('T_VAREMOD_F_PHOTO_F_05', 'PHOTO_F', 'FAIL', `status=${r.status}`);
        } else {
            const filePath = path.join(UPLOAD_DIR, path.basename(r.body.path));
            createdPhotoPaths.push(filePath);
            const endsWithWebp = r.body.path.endsWith('.webp');
            const fileExists = fs.existsSync(filePath);
            if (endsWithWebp && fileExists) {
                record('T_VAREMOD_F_PHOTO_F_05', 'PHOTO_F', 'PASS');
            } else {
                record('T_VAREMOD_F_PHOTO_F_05', 'PHOTO_F', 'FAIL',
                    `endsWithWebp=${endsWithWebp}, fileExists=${fileExists}`);
            }
        }
    }

    // PHOTO_F_06: POST receipt uden photo_path → DB.photo_path = null
    {
        const r = await createReceipt(basePayload());
        if (r.status !== 200) {
            record('T_VAREMOD_F_PHOTO_F_06', 'PHOTO_F', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT photo_path FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row?.photo_path === null) {
                record('T_VAREMOD_F_PHOTO_F_06', 'PHOTO_F', 'PASS');
            } else {
                record('T_VAREMOD_F_PHOTO_F_06', 'PHOTO_F', 'FAIL',
                    `photo_path='${row?.photo_path}'`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// FAIL — partial Grocy-failure (5 cases, ÆGTE Grocy-mutation)
// ════════════════════════════════════════════════════════════

async function runFailCases() {
    console.log('\n── FAIL: partial Grocy-failure ──');

    // Snapshot stock før — bruges af FAIL_02
    let beforeStockA, beforeStockB;
    try {
        const stockRes = await api('GET', '/api/grocy/stock');
        const stockArr = stockRes.body || [];
        beforeStockA = parseFloat(stockArr.find(s => parseInt(s.product_id) === REAL_PID_A)?.amount || 0);
        beforeStockB = parseFloat(stockArr.find(s => parseInt(s.product_id) === REAL_PID_B)?.amount || 0);
    } catch (err) {
        record('T_VAREMOD_F_FAIL_01', 'FAIL', 'SKIP', `Kunne ikke hente stock: ${err.message}`);
        record('T_VAREMOD_F_FAIL_02', 'FAIL', 'SKIP', '');
        record('T_VAREMOD_F_FAIL_03', 'FAIL', 'SKIP', '');
        record('T_VAREMOD_F_FAIL_04', 'FAIL', 'SKIP', '');
        record('T_VAREMOD_F_FAIL_05', 'FAIL', 'SKIP', '');
        return;
    }

    // Ryd webhook-buffer før FAIL-test
    await clearWebhookBuffer();

    // FAIL_01-05 alle bygger på SAMME receipt med 3 items: real, bogus, real
    const failPayload = basePayload({
        items: [
            { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'Real A',  received_quantity: FAIL_QTY, status: 'ok' },
            { grocy_product_id: BOGUS_PID, product_name: 'Bogus',    received_quantity: 1,        status: 'ok' },
            { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'Real B',  received_quantity: FAIL_QTY, status: 'ok' },
        ]
    });

    const r = await createReceipt(failPayload);
    if (r.status !== 200) {
        record('T_VAREMOD_F_FAIL_01', 'FAIL', 'FAIL', `POST status=${r.status}`);
        record('T_VAREMOD_F_FAIL_02', 'FAIL', 'SKIP', 'forrige fejlede');
        record('T_VAREMOD_F_FAIL_03', 'FAIL', 'SKIP', '');
        record('T_VAREMOD_F_FAIL_04', 'FAIL', 'SKIP', '');
        record('T_VAREMOD_F_FAIL_05', 'FAIL', 'SKIP', '');
        return;
    }

    // Track Grocy-mutationer til cleanup (real_a + real_b er tilført FAIL_QTY hver)
    grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });
    grocyMutations.push({ pid: REAL_PID_B, amount: FAIL_QTY });

    // FAIL_01: items[0] og items[2] har grocy_added=1, items[1] har grocy_error
    {
        const items = db.prepare(
            `SELECT id, product_name, grocy_added, grocy_error
             FROM goods_receipt_items WHERE receipt_id = ? ORDER BY id`
        ).all(r.body.id);

        const realA  = items.find(i => i.product_name === 'Real A');
        const bogus  = items.find(i => i.product_name === 'Bogus');
        const realB  = items.find(i => i.product_name === 'Real B');

        if (realA?.grocy_added === 1 && bogus?.grocy_added === 0 && bogus?.grocy_error
            && realB?.grocy_added === 1) {
            record('T_VAREMOD_F_FAIL_01', 'FAIL', 'PASS');
        } else {
            record('T_VAREMOD_F_FAIL_01', 'FAIL', 'FAIL',
                `A.added=${realA?.grocy_added}, Bogus.added=${bogus?.grocy_added}, B.added=${realB?.grocy_added}`);
        }
    }

    // FAIL_02: Begge real-pids øget med FAIL_QTY (sekventiel-loop ikke afbrudt)
    {
        // Lille pause for at sikre Grocy har committed
        await sleep(500);
        const stockRes = await api('GET', '/api/grocy/stock');
        const stockArr = stockRes.body || [];
        const afterA = parseFloat(stockArr.find(s => parseInt(s.product_id) === REAL_PID_A)?.amount || 0);
        const afterB = parseFloat(stockArr.find(s => parseInt(s.product_id) === REAL_PID_B)?.amount || 0);
        const deltaA = afterA - beforeStockA;
        const deltaB = afterB - beforeStockB;
        if (Math.abs(deltaA - FAIL_QTY) < 0.01 && Math.abs(deltaB - FAIL_QTY) < 0.01) {
            record('T_VAREMOD_F_FAIL_02', 'FAIL', 'PASS',
                VERBOSE ? `A: +${deltaA}, B: +${deltaB}` : '');
        } else {
            record('T_VAREMOD_F_FAIL_02', 'FAIL', 'FAIL',
                `A: +${deltaA} (forventet +${FAIL_QTY}), B: +${deltaB} (forventet +${FAIL_QTY})`);
        }
    }

    // FAIL_03: response.grocy_results har 3 entries
    {
        const gr = r.body?.grocy_results;
        if (Array.isArray(gr) && gr.length === 3) {
            const success = gr.filter(x => x.grocy_added).length;
            const failed  = gr.filter(x => x.error).length;
            if (success === 2 && failed === 1) {
                record('T_VAREMOD_F_FAIL_03', 'FAIL', 'PASS');
            } else {
                record('T_VAREMOD_F_FAIL_03', 'FAIL', 'FAIL',
                    `success=${success}, failed=${failed} (forventede 2/1)`);
            }
        } else {
            record('T_VAREMOD_F_FAIL_03', 'FAIL', 'FAIL',
                `grocy_results.length=${gr?.length}`);
        }
    }

    // FAIL_04 (F33 LUKKET — patch E): receipt-status sættes til 'partially_approved'
    // ved partial Grocy-failure (i stedet for hardcoded 'approved' fra før patch E).
    {
        const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
        if (row?.status === 'partially_approved') {
            record('T_VAREMOD_F_FAIL_04', 'FAIL', 'PASS',
                VERBOSE ? 'F33 lukket: status=partially_approved ved 1/3 Grocy-fejl' : '');
        } else {
            record('T_VAREMOD_F_FAIL_04', 'FAIL', 'FAIL',
                `F33 regression — status='${row?.status}', forventet 'partially_approved'`);
        }
    }

    // FAIL_05: webhook stadig sendt trods Grocy-fejl
    {
        await sleep(500);  // webhook er fire-and-forget — vent på det
        const buffer = await getWebhookBuffer();
        const matched = buffer.filter(w => w.receipt_id === r.body.id);
        if (matched.length === 1) {
            record('T_VAREMOD_F_FAIL_05', 'FAIL', 'PASS',
                VERBOSE ? `webhook fanget for receipt ${r.body.id}` : '');
        } else {
            record('T_VAREMOD_F_FAIL_05', 'FAIL', 'FAIL',
                `Forventet 1 webhook-kald for receipt ${r.body.id}, fik ${matched.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// PATCH_E — partially_approved status (7 cases, ÆGTE Grocy)
// ════════════════════════════════════════════════════════════
//
// Patch E lukkede F33: receipt-status er nu 'partially_approved' (i stedet for
// hardcoded 'approved') når mindst ét item fejler i Grocy. Skipped items
// (status='missing' eller qty=0) tæller IKKE som failures.
//
// Bruger samme cleanup-mønster som runFailCases — mutérer ægte Grocy stock på
// REAL_PID_A/B og restoreer via grocyMutations[].

async function runPatchECases() {
    console.log('\n── PATCH_E: partially_approved status (F33 lukket) ──');

    // E_01: 3 items alle OK → status='approved' (ikke partial)
    {
        const r = await createReceipt(basePayload({
            items: [
                { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'PE_A',  received_quantity: FAIL_QTY, status: 'ok' },
                { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'PE_B',  received_quantity: FAIL_QTY, status: 'ok' },
                { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'PE_A2', received_quantity: FAIL_QTY, status: 'ok' },
            ]
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_PATCH_E_01', 'PATCH_E', 'FAIL', `status=${r.status}`);
        } else {
            grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY * 2 });
            grocyMutations.push({ pid: REAL_PID_B, amount: FAIL_QTY });
            const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row?.status === 'approved' && r.body.status === 'approved' && r.body.grocy_failure_count === 0) {
                record('T_VAREMOD_F_PATCH_E_01', 'PATCH_E', 'PASS');
            } else {
                record('T_VAREMOD_F_PATCH_E_01', 'PATCH_E', 'FAIL',
                    `DB.status=${row?.status}, resp.status=${r.body.status}, failure_count=${r.body.grocy_failure_count}`);
            }
        }
    }

    // E_02: 3 items, 1 fejler → status='partially_approved'
    let e02Receipt;
    {
        const r = await createReceipt(basePayload({
            items: [
                { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'PE2_A', received_quantity: FAIL_QTY, status: 'ok' },
                { grocy_product_id: BOGUS_PID, product_name: 'PE2_Bogus', received_quantity: 1, status: 'ok' },
                { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'PE2_B', received_quantity: FAIL_QTY, status: 'ok' },
            ]
        }));
        e02Receipt = r;
        if (r.status !== 200) {
            record('T_VAREMOD_F_PATCH_E_02', 'PATCH_E', 'FAIL', `status=${r.status}`);
        } else {
            grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });
            grocyMutations.push({ pid: REAL_PID_B, amount: FAIL_QTY });
            const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row?.status === 'partially_approved') {
                record('T_VAREMOD_F_PATCH_E_02', 'PATCH_E', 'PASS');
            } else {
                record('T_VAREMOD_F_PATCH_E_02', 'PATCH_E', 'FAIL',
                    `DB.status=${row?.status} (forventede 'partially_approved')`);
            }
        }
    }

    // E_03: 3 items, alle fejler → status='partially_approved' (ikke 'rejected')
    {
        const r = await createReceipt(basePayload({
            items: [
                { grocy_product_id: BOGUS_PID, product_name: 'PE3_A', received_quantity: 1, status: 'ok' },
                { grocy_product_id: BOGUS_PID + 1, product_name: 'PE3_B', received_quantity: 1, status: 'ok' },
                { grocy_product_id: BOGUS_PID + 2, product_name: 'PE3_C', received_quantity: 1, status: 'ok' },
            ]
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_PATCH_E_03', 'PATCH_E', 'FAIL', `status=${r.status}`);
        } else {
            const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
            // 'rejected' var en tidlig design-idé; valgt design er at alt-fejlet
            // stadig er 'partially_approved' (operatøren har bevidst godkendt fysisk
            // modtagelse — Grocy-fejlen er teknisk, ikke domæne)
            if (row?.status === 'partially_approved') {
                record('T_VAREMOD_F_PATCH_E_03', 'PATCH_E', 'PASS',
                    VERBOSE ? '3/3 fejl → stadig partially_approved (ikke rejected)' : '');
            } else {
                record('T_VAREMOD_F_PATCH_E_03', 'PATCH_E', 'FAIL',
                    `DB.status=${row?.status}`);
            }
        }
    }

    // E_04: 3 items hvor 1 har grocy_product_id=null (skipped) → status='approved'
    //       (skipped tæller IKKE som failure)
    {
        const r = await createReceipt(basePayload({
            items: [
                { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'PE4_A', received_quantity: FAIL_QTY, status: 'ok' },
                { grocy_product_id: null, product_name: 'PE4_NoPid', received_quantity: 1, status: 'ok' },
                { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'PE4_B', received_quantity: FAIL_QTY, status: 'ok' },
            ]
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_PATCH_E_04', 'PATCH_E', 'FAIL', `status=${r.status}`);
        } else {
            grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });
            grocyMutations.push({ pid: REAL_PID_B, amount: FAIL_QTY });
            const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
            // Item uden pid bliver markeret skipped i grocyResults — tæller ikke som failure
            if (row?.status === 'approved' && r.body.grocy_failure_count === 0) {
                record('T_VAREMOD_F_PATCH_E_04', 'PATCH_E', 'PASS',
                    VERBOSE ? 'skipped tæller ikke som failure' : '');
            } else {
                record('T_VAREMOD_F_PATCH_E_04', 'PATCH_E', 'FAIL',
                    `DB.status=${row?.status}, failure_count=${r.body.grocy_failure_count}`);
            }
        }
    }

    // E_05: response.status matcher DB.status (re-fetch efter UPDATE)
    {
        if (e02Receipt?.status === 200) {
            const dbStatus = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(e02Receipt.body.id)?.status;
            if (e02Receipt.body.status === dbStatus && dbStatus === 'partially_approved') {
                record('T_VAREMOD_F_PATCH_E_05', 'PATCH_E', 'PASS',
                    VERBOSE ? `resp=${e02Receipt.body.status}, db=${dbStatus}` : '');
            } else {
                record('T_VAREMOD_F_PATCH_E_05', 'PATCH_E', 'FAIL',
                    `resp.status=${e02Receipt.body.status}, db.status=${dbStatus}`);
            }
        } else {
            record('T_VAREMOD_F_PATCH_E_05', 'PATCH_E', 'SKIP', 'E_02 fejlede');
        }
    }

    // E_06: grocy_failure_count = antal fejlede (excl. skipped) — sanity-check
    {
        if (e02Receipt?.status === 200) {
            if (e02Receipt.body.grocy_failure_count === 1) {
                record('T_VAREMOD_F_PATCH_E_06', 'PATCH_E', 'PASS');
            } else {
                record('T_VAREMOD_F_PATCH_E_06', 'PATCH_E', 'FAIL',
                    `failure_count=${e02Receipt.body.grocy_failure_count} (forventede 1)`);
            }
        } else {
            record('T_VAREMOD_F_PATCH_E_06', 'PATCH_E', 'SKIP', 'E_02 fejlede');
        }
    }

    // E_07: webhook payload har det FAKTISKE status (re-læst fra DB). Vi fanger
    //       webhook'en via _getSentWebhooks() og verificerer at den fik
    //       'partially_approved' (ikke 'approved') for E_02-receipten.
    //
    //       NB: services/goodsReceiptWebhook.js bygger payload fra receipt-row,
    //       der allerede er re-fetched i routes/goods-receipts.js (linje ~373).
    //       Mock'en gemmer dog kun et subsæt af felterne — vi tjekker derfor at
    //       det captured webhook-objekt eksisterer for receipt'en. Hvis vi vil
    //       teste FAKTISK status i payload, skal mock-buffer udvides med
    //       receipt.status — TODO som separat opgave hvis vigtigt.
    {
        if (e02Receipt?.status === 200) {
            await sleep(500);
            const buffer = await getWebhookBuffer();
            const matched = buffer.filter(w => w.receipt_id === e02Receipt.body.id);
            if (matched.length === 1) {
                record('T_VAREMOD_F_PATCH_E_07', 'PATCH_E', 'PASS',
                    VERBOSE ? 'webhook sendt for partial-receipt' : '');
            } else {
                record('T_VAREMOD_F_PATCH_E_07', 'PATCH_E', 'FAIL',
                    `Forventet 1 webhook, fik ${matched.length}`);
            }
        } else {
            record('T_VAREMOD_F_PATCH_E_07', 'PATCH_E', 'SKIP', 'E_02 fejlede');
        }
    }

    // E_08 (v2-tilføjelse): item.status='missing' med qty>0 — skipped tæller IKKE
    // som failure selvom shouldAddStock=false (status='missing' uanset qty).
    // Modsat status='ok' med qty>0 hvor skipped kun gælder ved qty<=0.
    // Vigtigt at adskille "bevidst skip" fra "Grocy-fejl".
    {
        const r = await createReceipt(basePayload({
            items: [
                { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'PE8_ok',      received_quantity: FAIL_QTY, status: 'ok' },
                { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'PE8_missing', received_quantity: 2,        status: 'missing' },
            ]
        }));
        if (r.status !== 200) {
            record('T_VAREMOD_F_PATCH_E_08', 'PATCH_E', 'FAIL', `status=${r.status}`);
        } else {
            grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });
            // missing-item: addStock skippes UANSET qty — REAL_PID_B's stock urørt
            const row = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(r.body.id);
            if (row?.status === 'approved' && r.body.grocy_failure_count === 0) {
                record('T_VAREMOD_F_PATCH_E_08', 'PATCH_E', 'PASS',
                    VERBOSE ? 'status=missing skippe addStock, tæller ikke som failure' : '');
            } else {
                record('T_VAREMOD_F_PATCH_E_08', 'PATCH_E', 'FAIL',
                    `DB.status=${row?.status}, failure_count=${r.body.grocy_failure_count}`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// CONC — concurrency på receipt-number (2 cases)
// ════════════════════════════════════════════════════════════

async function runConcurrencyCases() {
    console.log('\n── CONC: concurrency ──');

    // CONC_01: To POST'er uden delay
    {
        const before = readCounter();
        const [rA, rB] = await Promise.all([
            createReceipt(basePayload()),
            createReceipt(basePayload()),
        ]);
        const after = readCounter();
        const numA = rA.body?.receipt_number;
        const numB = rB.body?.receipt_number;
        if (rA.status === 200 && rB.status === 200
            && numA !== numB
            && after === before + 2) {
            record('T_VAREMOD_F_CONC_01', 'CONC', 'PASS',
                VERBOSE ? `${numA} ≠ ${numB}, counter +2` : '');
        } else {
            record('T_VAREMOD_F_CONC_01', 'CONC', 'FAIL',
                `A=${numA}, B=${numB}, counter ${before}→${after}`);
        }
    }

    // CONC_02 (F34): 3 parallel POST'er via Promise.all
    {
        const before = readCounter();
        const [rA, rB, rC] = await Promise.all([
            createReceipt(basePayload()),
            createReceipt(basePayload()),
            createReceipt(basePayload()),
        ]);
        const after = readCounter();
        const nums = [rA, rB, rC].map(r => r.body?.receipt_number);
        const unique = new Set(nums.filter(Boolean));
        const allOk = rA.status === 200 && rB.status === 200 && rC.status === 200;
        if (allOk && unique.size === 3 && after === before + 3) {
            record('T_VAREMOD_F_CONC_02', 'CONC', 'PASS',
                VERBOSE ? `F34: 3 unikke numre ${[...unique].join(', ')}` : '');
        } else {
            record('T_VAREMOD_F_CONC_02', 'CONC', 'FAIL',
                `F34: status=${rA.status}/${rB.status}/${rC.status}, unique=${unique.size}, counter ${before}→${after} (forventede +3)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// LIST — GET / filter-tests (6 cases)
// ════════════════════════════════════════════════════════════

async function runListCases() {
    console.log('\n── LIST: GET / filtre ──');

    // Opret nogle ekstra receipts med kendte attributter til filter-tests
    const r1 = await createReceipt(basePayload({ location_id: 1 }));
    const r2 = await createReceipt(basePayload({ location_id: 2 }));
    const r3 = await createReceipt(basePayload({ supplier_name: 'T_VAREMOD_F Hørkram test' }));

    // LIST_01: GET / uden filtre — test-receipts findes
    {
        const r = await api('GET', '/api/goods-receipts');
        if (r.status === 200 && Array.isArray(r.body)) {
            const ourCount = r.body.filter(x =>
                x.supplier_name === TEST_SUPPLIER ||
                x.supplier_name === 'T_VAREMOD_F Hørkram test'
            ).length;
            if (ourCount >= 3) {
                record('T_VAREMOD_F_LIST_01', 'LIST', 'PASS',
                    VERBOSE ? `${ourCount} test-receipts` : '');
            } else {
                record('T_VAREMOD_F_LIST_01', 'LIST', 'FAIL',
                    `Forventet ≥3 test-receipts, fik ${ourCount}`);
            }
        } else {
            record('T_VAREMOD_F_LIST_01', 'LIST', 'FAIL', `status=${r.status}`);
        }
    }

    // LIST_02: ?from= — kun receipts fra given dato (alle er fra i dag)
    {
        const today = new Date().toISOString().slice(0, 10);
        const r = await api('GET', `/api/goods-receipts?from=${today}`);
        if (r.status === 200 && Array.isArray(r.body)) {
            const allFromToday = r.body.every(x => x.received_at?.startsWith(today));
            if (allFromToday) {
                record('T_VAREMOD_F_LIST_02', 'LIST', 'PASS');
            } else {
                record('T_VAREMOD_F_LIST_02', 'LIST', 'FAIL',
                    `Ikke alle fra ${today}`);
            }
        } else {
            record('T_VAREMOD_F_LIST_02', 'LIST', 'FAIL', `status=${r.status}`);
        }
    }

    // LIST_03: ?to= — inkluderer hele dagen (23:59:59 padding)
    {
        const today = new Date().toISOString().slice(0, 10);
        const r = await api('GET', `/api/goods-receipts?to=${today}`);
        if (r.status === 200 && Array.isArray(r.body)) {
            // Vores receipts fra i dag SKAL være i resultatet (de er sat med datetime('now'))
            const includesOurs = r.body.some(x =>
                x.supplier_name === TEST_SUPPLIER && x.received_at?.startsWith(today)
            );
            if (includesOurs) {
                record('T_VAREMOD_F_LIST_03', 'LIST', 'PASS',
                    VERBOSE ? '23:59:59 padding virker' : '');
            } else {
                record('T_VAREMOD_F_LIST_03', 'LIST', 'FAIL',
                    'Receipts fra i dag ekskluderet — to-padding mangler eller fungerer ikke');
            }
        } else {
            record('T_VAREMOD_F_LIST_03', 'LIST', 'FAIL', `status=${r.status}`);
        }
    }

    // LIST_04 (F39): ?supplier=Hørkram — LIKE-match
    {
        const r = await api('GET', `/api/goods-receipts?supplier=${encodeURIComponent('Hørkram')}`);
        if (r.status === 200 && Array.isArray(r.body)) {
            const matchesOur = r.body.some(x => x.supplier_name?.includes('Hørkram'));
            if (matchesOur) {
                record('T_VAREMOD_F_LIST_04', 'LIST', 'PASS',
                    VERBOSE ? 'LIKE-match med diacritic virker' : '');
            } else {
                record('T_VAREMOD_F_LIST_04', 'LIST', 'FAIL',
                    `Vores 'T_VAREMOD_F Hørkram test' fundet ikke (F39: UTF-8 LIKE-issue?)`);
            }
        } else {
            record('T_VAREMOD_F_LIST_04', 'LIST', 'FAIL', `status=${r.status}`);
        }
    }

    // LIST_05: ?location=1 — kun receipts med location_id=1
    {
        const r = await api('GET', '/api/goods-receipts?location=1');
        if (r.status === 200 && Array.isArray(r.body)) {
            const allLoc1 = r.body.every(x => x.location_id === 1 || x.location_id === null);
            // Vores r1 SKAL være i resultatet
            const includesR1 = r.body.some(x => x.id === r1.body.id);
            if (includesR1) {
                // Tjek at vores r2 (location=2) IKKE er i resultatet
                const includesR2 = r.body.some(x => x.id === r2.body.id);
                if (!includesR2) {
                    record('T_VAREMOD_F_LIST_05', 'LIST', 'PASS');
                } else {
                    record('T_VAREMOD_F_LIST_05', 'LIST', 'FAIL',
                        'Receipt med location=2 inkluderet i ?location=1');
                }
            } else {
                record('T_VAREMOD_F_LIST_05', 'LIST', 'FAIL',
                    'Vores location=1 receipt mangler');
            }
        } else {
            record('T_VAREMOD_F_LIST_05', 'LIST', 'FAIL', `status=${r.status}`);
        }
    }

    // LIST_06: Sortering — ORDER BY received_at DESC (nyeste først)
    {
        const r = await api('GET', '/api/goods-receipts');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 2) {
            // Check de første 5 er DESC-sorteret
            const slice = r.body.slice(0, 5).map(x => x.received_at);
            let sorted = true;
            for (let i = 0; i < slice.length - 1; i++) {
                if (slice[i] < slice[i+1]) { sorted = false; break; }
            }
            if (sorted) {
                record('T_VAREMOD_F_LIST_06', 'LIST', 'PASS');
            } else {
                record('T_VAREMOD_F_LIST_06', 'LIST', 'FAIL',
                    'Receipts ikke sorteret DESC');
            }
        } else {
            record('T_VAREMOD_F_LIST_06', 'LIST', 'FAIL', `status=${r.status}, count=${r.body?.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// DETAIL — GET /:id (3 cases)
// ════════════════════════════════════════════════════════════

async function runDetailCases() {
    console.log('\n── DETAIL: GET /:id ──');

    // Brug en eksisterende test-receipt
    const oneId = createdReceiptIds[0];
    if (!oneId) {
        record('T_VAREMOD_F_DETAIL_01', 'DETAIL', 'SKIP', 'Ingen test-receipt');
        record('T_VAREMOD_F_DETAIL_02', 'DETAIL', 'SKIP', '');
        record('T_VAREMOD_F_DETAIL_03', 'DETAIL', 'SKIP', '');
        return;
    }

    // DETAIL_01: GET /:id returnerer receipt + items
    {
        const r = await api('GET', `/api/goods-receipts/${oneId}`);
        if (r.status === 200 && r.body?.id === oneId && Array.isArray(r.body?.items)) {
            record('T_VAREMOD_F_DETAIL_01', 'DETAIL', 'PASS');
        } else {
            record('T_VAREMOD_F_DETAIL_01', 'DETAIL', 'FAIL',
                `status=${r.status}, items array=${Array.isArray(r.body?.items)}`);
        }
    }

    // DETAIL_02: ikke-eksisterende → 404
    {
        const r = await api('GET', '/api/goods-receipts/99999999');
        if (r.status === 404) {
            record('T_VAREMOD_F_DETAIL_02', 'DETAIL', 'PASS');
        } else {
            record('T_VAREMOD_F_DETAIL_02', 'DETAIL', 'FAIL', `status=${r.status}`);
        }
    }

    // DETAIL_03: items er ALTID array (selv hvis receipt blev oprettet uden items
    // via direkte INSERT — vi tester via en synthesis receipt der har items)
    {
        // Vores test-receipts har items. Verifiér at array returneres
        const r = await api('GET', `/api/goods-receipts/${oneId}`);
        if (r.status === 200 && Array.isArray(r.body?.items) && r.body.items.length >= 1) {
            record('T_VAREMOD_F_DETAIL_03', 'DETAIL', 'PASS');
        } else {
            record('T_VAREMOD_F_DETAIL_03', 'DETAIL', 'FAIL',
                `items.length=${r.body?.items?.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// USERS — GET /users (3 cases)
// ════════════════════════════════════════════════════════════

async function runUsersCases() {
    console.log('\n── USERS: GET /users ──');

    // USERS_01: GET /users returnerer aktive brugere
    {
        const r = await api('GET', '/api/goods-receipts/users');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 1) {
            const hasIdName = r.body.every(u => 'id' in u && 'name' in u);
            if (hasIdName) {
                record('T_VAREMOD_F_USERS_01', 'USERS', 'PASS',
                    VERBOSE ? `${r.body.length} users` : '');
            } else {
                record('T_VAREMOD_F_USERS_01', 'USERS', 'FAIL',
                    'Mangler id eller name på en eller flere users');
            }
        } else {
            record('T_VAREMOD_F_USERS_01', 'USERS', 'FAIL',
                `status=${r.status}, length=${r.body?.length}`);
        }
    }

    // USERS_02: soft-deleted (is_active=0) ekskluderet
    {
        // Find en eksisterende user vi kan deaktivere midlertidigt
        const target = db.prepare(`SELECT id, name FROM users WHERE is_active = 1 LIMIT 1`).get();
        if (!target) {
            record('T_VAREMOD_F_USERS_02', 'USERS', 'SKIP', 'Ingen aktiv user at deaktivere');
        } else {
            db.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).run(target.id);
            try {
                const r = await api('GET', '/api/goods-receipts/users');
                const included = r.body?.some(u => u.id === target.id) ?? false;
                if (!included) {
                    record('T_VAREMOD_F_USERS_02', 'USERS', 'PASS');
                } else {
                    record('T_VAREMOD_F_USERS_02', 'USERS', 'FAIL',
                        `Deaktiveret user id=${target.id} stadig i listen`);
                }
            } finally {
                db.prepare(`UPDATE users SET is_active = 1 WHERE id = ?`).run(target.id);
            }
        }
    }

    // USERS_03: ORDER BY name
    {
        const r = await api('GET', '/api/goods-receipts/users');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length >= 2) {
            const names = r.body.map(u => u.name);
            const sorted = [...names].sort((a, b) => a.localeCompare(b));
            if (JSON.stringify(names) === JSON.stringify(sorted)) {
                record('T_VAREMOD_F_USERS_03', 'USERS', 'PASS');
            } else {
                // SQLite's default sort kan afvige fra JS localeCompare for danske tegn.
                // Tjek SQL-version: ORDER BY name (byte-order) — accepter hvis sorteret efter charCode
                const byteSorted = [...names].sort();
                if (JSON.stringify(names) === JSON.stringify(byteSorted)) {
                    record('T_VAREMOD_F_USERS_03', 'USERS', 'PASS',
                        VERBOSE ? 'SQLite byte-sort (ikke localeCompare)' : '');
                } else {
                    record('T_VAREMOD_F_USERS_03', 'USERS', 'FAIL',
                        `${JSON.stringify(names)} ≠ ${JSON.stringify(sorted)}`);
                }
            }
        } else {
            record('T_VAREMOD_F_USERS_03', 'USERS', 'SKIP',
                `Kun ${r.body?.length} users — kan ikke verificere ordre`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// ADHOC + BACKDATE — varefri registrering + admin-modtagedato
// ════════════════════════════════════════════════════════════
//
// Dækker de nye adfærd (issue #278):
//   - varefri registrering (kun fødevarekontrol) er tilladt + webhook fyrer
//   - admin kan sætte received_at (modtagedato fra følgeseddel); created_at
//     forbliver "nu" som ærligt revisionsspor
//   - ikke-admin der forsøger at sætte received_at afvises (403) uden at
//     bumpe receipt-counteren

async function runAdhocBackdateCases() {
    console.log('\n── ADHOC + BACKDATE ──');

    // ADHOC_01: items=[] → 200, 0 varelinjer, status approved, webhook fyret,
    //           ingen Grocy-mutation (ingen varer at lægge på lager).
    {
        await clearWebhookBuffer();
        const r = await createReceipt(basePayload({ items: [] }));
        if (r.status !== 200 || !r.body?.id) {
            record('T_VAREMOD_F_ADHOC_01', 'ADHOC', 'FAIL', `status=${r.status}`);
        } else {
            const itemCount = db.prepare(
                `SELECT COUNT(*) AS n FROM goods_receipt_items WHERE receipt_id = ?`
            ).get(r.body.id).n;
            const status = db.prepare(
                `SELECT status FROM goods_receipts WHERE id = ?`
            ).get(r.body.id)?.status;
            await sleep(100);
            const hooks = await getWebhookBuffer();
            const fired = hooks.some(h => h.receipt_id === r.body.id);
            if (itemCount === 0 && status === 'approved' && fired) {
                record('T_VAREMOD_F_ADHOC_01', 'ADHOC', 'PASS',
                    VERBOSE ? '0 items, approved, webhook fyret' : '');
            } else {
                record('T_VAREMOD_F_ADHOC_01', 'ADHOC', 'FAIL',
                    `items=${itemCount} status=${status} webhook=${fired}`);
            }
        }
    }

    // BACKDATE_01+02: admin-session
    let adminCookie = null;
    try {
        adminCookie = await adminLogin();
    } catch (err) {
        record('T_VAREMOD_F_BACKDATE_01', 'BACKDATE', 'FAIL', err.message);
        record('T_VAREMOD_F_BACKDATE_02', 'BACKDATE', 'SKIP', 'admin-login fejlede');
    }

    if (adminCookie) {
        // BACKDATE_01: admin sætter received_at = fortidsdato → received_at bliver
        //              den valgte dato (kl 12), created_at forbliver i dag (UTC).
        {
            const pastDate = '2026-01-15';
            const r = await apiAs(adminCookie, 'POST', '/api/goods-receipts',
                basePayload({ received_at: pastDate }));
            if (r.status === 200 && r.body?.id) createdReceiptIds.push(r.body.id);
            if (r.status !== 200) {
                record('T_VAREMOD_F_BACKDATE_01', 'BACKDATE', 'FAIL', `status=${r.status}`);
            } else {
                const row = db.prepare(
                    `SELECT received_at, created_at FROM goods_receipts WHERE id = ?`
                ).get(r.body.id);
                const rcvDate = String(row?.received_at || '').slice(0, 10);
                const createdDate = String(row?.created_at || '').slice(0, 10);
                const todayUtc = new Date().toISOString().slice(0, 10);
                if (rcvDate === pastDate && createdDate === todayUtc) {
                    record('T_VAREMOD_F_BACKDATE_01', 'BACKDATE', 'PASS',
                        VERBOSE ? `received_at=${row.received_at}, created_at=${row.created_at}` : '');
                } else {
                    record('T_VAREMOD_F_BACKDATE_01', 'BACKDATE', 'FAIL',
                        `received_at=${row?.received_at} (forventet ${pastDate}), created_at=${row?.created_at} (forventet ${todayUtc})`);
                }
            }
        }

        // BACKDATE_02: admin sender ugyldig dato → 400.
        {
            const r = await apiAs(adminCookie, 'POST', '/api/goods-receipts',
                basePayload({ received_at: 'ikke-en-dato' }));
            if (r.status === 200 && r.body?.id) createdReceiptIds.push(r.body.id);
            if (r.status === 400) {
                record('T_VAREMOD_F_BACKDATE_02', 'BACKDATE', 'PASS');
            } else {
                record('T_VAREMOD_F_BACKDATE_02', 'BACKDATE', 'FAIL', `status=${r.status}`);
            }
        }

        // BACKDATE_04: en køkken-bruger (ikke admin) MED evnen 'modtag_backdate'
        //              kan backdatere. Admin tildeler evnen via API, køkken-sessionen
        //              registrerer, evnen fjernes igen.
        {
            const kitchen = db.prepare(
                `SELECT id FROM users WHERE pin = '1234' AND is_active = 1 LIMIT 1`
            ).get();
            if (!kitchen) {
                record('T_VAREMOD_F_BACKDATE_04', 'BACKDATE', 'SKIP', 'ingen køkken-bruger (pin 1234)');
            } else {
                const grant = await apiAs(adminCookie, 'PATCH', `/api/users/${kitchen.id}`,
                    { modules: { modtag_backdate: true } });
                const pastDate = '2026-02-20';
                const r = await api('POST', '/api/goods-receipts',
                    basePayload({ received_at: pastDate }));
                if (r.status === 200 && r.body?.id) createdReceiptIds.push(r.body.id);
                // Fjern evnen igen (best-effort — test:reset rydder alligevel)
                await apiAs(adminCookie, 'PATCH', `/api/users/${kitchen.id}`,
                    { modules: { modtag_backdate: null } });

                if (r.status !== 200) {
                    record('T_VAREMOD_F_BACKDATE_04', 'BACKDATE', 'FAIL',
                        `grant=${grant.status} post=${r.status}`);
                } else {
                    const rcvDate = String(db.prepare(
                        `SELECT received_at FROM goods_receipts WHERE id = ?`
                    ).get(r.body.id)?.received_at || '').slice(0, 10);
                    if (rcvDate === pastDate) {
                        record('T_VAREMOD_F_BACKDATE_04', 'BACKDATE', 'PASS',
                            VERBOSE ? 'køkken m. evne kunne backdatere' : '');
                    } else {
                        record('T_VAREMOD_F_BACKDATE_04', 'BACKDATE', 'FAIL',
                            `received_at slice=${rcvDate} (forventet ${pastDate})`);
                    }
                }
            }
        }
    }

    // BACKDATE_03: ikke-admin (kitchen-session) UDEN evnen sender received_at → 403 og
    //              counteren bumpes ikke (afvist før transaction).
    {
        const before = readCounter();
        const r = await api('POST', '/api/goods-receipts',
            basePayload({ received_at: '2020-01-01' }));
        const after = readCounter();
        if (r.status === 200 && r.body?.id) createdReceiptIds.push(r.body.id);
        if (r.status === 403 && before === after) {
            record('T_VAREMOD_F_BACKDATE_03', 'BACKDATE', 'PASS',
                VERBOSE ? 'ikke-admin afvist, counter uændret' : '');
        } else {
            record('T_VAREMOD_F_BACKDATE_03', 'BACKDATE', 'FAIL',
                `status=${r.status}, counter ${before}→${after} (forventede 403 + uændret)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// OBS — #336: modtagelse stempler varen som observeret
// ════════════════════════════════════════════════════════════
// Optællingen bruger LastCheckedUnit til at afgøre hvilken fysisk enheds
// liste en vare hører til, og LastCheckedAt til at sortere efter hvad der
// trænger. En netop modtaget vare ER observeret — ellers står den som
// "aldrig tjekket" dagen efter den kom ind ad døren.

// goods_receipts.location_id har en fremmednøgle til locations — et syntetisk
// id giver "FOREIGN KEY constraint failed". Test-lokationen (3) er den rigtige
// at bruge, og den fysiske enhed hæftes på den for testens varighed.
const OBS_LOCATION_ID = 3;
const OBS_UNIT_NAME   = 'T_VAREMOD_F-OBS';
let obsUnitId = null;
let obsUserfieldsBefore = null;
let obsBStampBefore = null;

// ════════════════════════════════════════════════════════════
// UNIT — indkøbs-enhed omregnes til lager-enhed (#358)
// ════════════════════════════════════════════════════════════
//
// Kernen i #358: tallet på indkøbslisten står i INDKØBS-enhed, men Grocys
// /stock/add læser LAGER-enhed. Uden omregning blev "10 Antal spidskål" til
// 10 kg. Her modtages i købs-enhed mod ÆGTE grocytest, og vi måler at lageret
// flyttede sig med qty × faktor — ikke med qty.
async function runUnitConversionCases() {
    console.log('\n── UNIT: købs-enhed → lager-enhed (#358) ──');

    // Hent produktets rigtige enheder + faktor fra Grocy, så testen ikke
    // hardkoder tal der kan drive fra hinanden.
    let purchaseQu, stockQu, factor;
    try {
        const [pRes, cRes] = await Promise.all([
            api('GET', '/api/grocy/products'),
            api('GET', '/api/grocy/quantity-unit-conversions'),
        ]);
        const prod = (pRes.body || []).find(p => parseInt(p.id) === REAL_PID_A);
        purchaseQu = parseInt(prod.qu_id_purchase);
        stockQu    = parseInt(prod.qu_id_stock);
        const conv = (cRes.body || []).find(c =>
            parseInt(c.product_id) === REAL_PID_A &&
            parseInt(c.from_qu_id) === purchaseQu && parseInt(c.to_qu_id) === stockQu);
        factor = parseFloat(conv.factor);
        if (!(purchaseQu !== stockQu && factor > 0)) throw new Error('utilstrækkelig fixture');
    } catch (err) {
        record('T_VAREMOD_F_UNIT_01', 'UNIT', 'SKIP', `Kunne ikke hente enheds-fixture: ${err.message}`);
        record('T_VAREMOD_F_UNIT_02', 'UNIT', 'SKIP', '');
        record('T_VAREMOD_F_UNIT_03', 'UNIT', 'SKIP', '');
        return;
    }

    const stockOf = async (pid) => {
        const r = await api('GET', '/api/grocy/stock');
        return parseFloat((r.body || []).find(s => parseInt(s.product_id) === pid)?.amount || 0);
    };

    const before = await stockOf(REAL_PID_A);
    const r = await createReceipt(basePayload({
        items: [{ grocy_product_id: REAL_PID_A, qu_id: purchaseQu,
                  product_name: 'UNIT købs-enhed', received_quantity: FAIL_QTY, status: 'ok' }],
    }));
    if (r.status === 200) createdReceiptIds.push(r.body.id);

    const after    = await stockOf(REAL_PID_A);
    const expected = FAIL_QTY * factor;
    const delta    = after - before;
    if (r.status === 200) grocyMutations.push({ pid: REAL_PID_A, amount: expected });

    // Uden fixet ville delta være FAIL_QTY (tallet råt) i stedet for qty × faktor.
    record('T_VAREMOD_F_UNIT_01', 'UNIT',
        Math.abs(delta - expected) < 0.01 ? 'PASS' : 'FAIL',
        `delta=${delta.toFixed(3)} forventet=${expected.toFixed(3)} (rå tal ville give ${FAIL_QTY})`);

    // Begge tal skal være gemt, ellers kan en fremtidig afvigelse ikke afgøres.
    const row = r.status === 200 ? db.prepare(
        `SELECT received_quantity, received_qu_id, received_quantity_stock
         FROM goods_receipt_items WHERE receipt_id = ?`).get(r.body.id) : null;
    record('T_VAREMOD_F_UNIT_02', 'UNIT',
        row && row.received_qu_id === purchaseQu
            && Math.abs(row.received_quantity_stock - expected) < 0.01
            && row.received_quantity === FAIL_QTY ? 'PASS' : 'FAIL',
        `gemt: qty=${row?.received_quantity} qu=${row?.received_qu_id} stock=${row?.received_quantity_stock}`);

    // Ukendt enhed uden konvertering → lageret røres IKKE, og receiptet beder om hjælp.
    const beforeBad = await stockOf(REAL_PID_A);
    const rBad = await createReceipt(basePayload({
        items: [{ grocy_product_id: REAL_PID_A, qu_id: 99999,
                  product_name: 'UNIT ukendt enhed', received_quantity: FAIL_QTY, status: 'ok' }],
    }));
    if (rBad.status === 200) createdReceiptIds.push(rBad.body.id);
    const afterBad = await stockOf(REAL_PID_A);
    const itemBad  = rBad.status === 200 ? db.prepare(
        `SELECT grocy_added, grocy_error FROM goods_receipt_items WHERE receipt_id = ?`).get(rBad.body.id) : null;
    record('T_VAREMOD_F_UNIT_03', 'UNIT',
        Math.abs(afterBad - beforeBad) < 0.001
            && rBad.body?.status === 'partially_approved'
            && itemBad?.grocy_added === 0 && !!itemBad?.grocy_error ? 'PASS' : 'FAIL',
        `delta=${(afterBad - beforeBad).toFixed(3)} status=${rBad.body?.status} err=${itemBad?.grocy_error ? 'ja' : 'nej'}`);
}

// ════════════════════════════════════════════════════════════
// UNIT — prisen følger med til Grocy (#657)
// ════════════════════════════════════════════════════════════
//
// Varemodtagelsen sender kr pr. LAGER-enhed med, udledt af det bestilte
// varenummers pris i Grocy (stregkodens last_price, pr. 1 af stregkodens enhed).
// Her lægges en midlertidig stregkode i KØBS-enheden (kassen) på REAL_PID_A.
// Prisen pr. kasse skal deles med faktoren kasse→kilo; sendes den råt, er det
// #358 igen — bare på prisen i stedet for mængden.
const PRICE_BARCODE = `T657-${Date.now()}`;
const PRICE_PER_PURCHASE_UNIT = 123.45;
let priceBarcodeId = null;

// Grocy direkte, kun til at LÆSE lagerposterne (serveren har ingen route til dem).
function grocyDirect() {
    const loc = db.prepare(`
        SELECT l.grocy_api_url AS url, l.grocy_api_key AS key, l.code
        FROM locations l
        WHERE l.id = COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_grocy_location_id'), l.id)
        ORDER BY l.id LIMIT 1`).get();
    const key = loc?.key || process.env[`GROCY_${String(loc?.code || '').toUpperCase()}_KEY`] || process.env.GROCY_HQ_KEY;
    return { url: String(loc?.url || '').replace(/\/+$/, ''), key };
}
async function newestStockEntry(pid) {
    const g = grocyDirect();
    const res = await fetch(`${g.url}/stock/products/${pid}/entries`, { headers: { 'GROCY-API-KEY': g.key } });
    if (!res.ok) throw new Error(`Grocy ${res.status}`);
    const entries = await res.json();
    return entries.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

async function runPriceCases() {
    console.log('\n── UNIT: pris pr. lager-enhed følger med (#657) ──');

    let purchaseQu, stockQu, factor, plainPid = null;
    try {
        const [pRes, cRes, bRes] = await Promise.all([
            api('GET', '/api/grocy/products'),
            api('GET', '/api/grocy/quantity-unit-conversions'),
            api('GET', '/api/grocy/product-barcodes'),
        ]);
        const prods = pRes.body || [];
        const prod = prods.find(p => parseInt(p.id) === REAL_PID_A);
        purchaseQu = parseInt(prod.qu_id_purchase);
        stockQu    = parseInt(prod.qu_id_stock);
        const conv = (cRes.body || []).find(c =>
            parseInt(c.product_id) === REAL_PID_A &&
            parseInt(c.from_qu_id) === purchaseQu && parseInt(c.to_qu_id) === stockQu);
        factor = parseFloat(conv.factor);
        if (!(purchaseQu !== stockQu && factor > 0 && factor !== 1)) throw new Error('utilstrækkelig fixture');

        // En aktiv vare helt uden stregkoder og med samme købs- og lager-enhed.
        const withBarcode = new Set((bRes.body || []).map(b => parseInt(b.product_id)));
        const plain = prods.find(p => Number(p.active) === 1 && !withBarcode.has(parseInt(p.id))
            && parseInt(p.qu_id_purchase) === parseInt(p.qu_id_stock) && !Number(p.no_own_stock));
        plainPid = plain ? parseInt(plain.id) : null;

        const created = await api('POST', '/api/grocy/product-barcodes', {
            product_id: REAL_PID_A, barcode: PRICE_BARCODE,
            qu_id: purchaseQu, amount: 1, last_price: PRICE_PER_PURCHASE_UNIT,
        });
        priceBarcodeId = created.body?.created_object_id ? parseInt(created.body.created_object_id) : null;
        if (!priceBarcodeId) throw new Error(`kunne ikke oprette test-stregkode (${created.status})`);
    } catch (err) {
        for (const id of ['T_VAREMOD_F_UNIT_04', 'T_VAREMOD_F_UNIT_05', 'T_VAREMOD_F_UNIT_06']) {
            record(id, 'UNIT', 'SKIP', `Kunne ikke sætte pris-fixture op: ${err.message}`);
        }
        return;
    }

    // UNIT_04 + 05: modtag 1 kasse af det bestilte varenummer.
    const expectedPrice = PRICE_PER_PURCHASE_UNIT / factor;
    const r = await createReceipt(basePayload({
        items: [{ grocy_product_id: REAL_PID_A, qu_id: purchaseQu, ordered_varenrs: [PRICE_BARCODE],
                  product_name: 'PRIS varenummer', received_quantity: FAIL_QTY, status: 'ok' }],
    }));
    if (r.status === 200) {
        createdReceiptIds.push(r.body.id);
        grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY * factor });
    }
    let entry = null;
    try { entry = await newestStockEntry(REAL_PID_A); } catch (e) { /* vises i detaljen */ }
    const entryPrice = entry ? parseFloat(entry.price) : NaN;
    record('T_VAREMOD_F_UNIT_04', 'UNIT',
        r.status === 200 && Math.abs(entryPrice - expectedPrice) < 0.01 ? 'PASS' : 'FAIL',
        `lagerpostens pris=${entryPrice} forventet=${expectedPrice.toFixed(4)} ` +
        `(${PRICE_PER_PURCHASE_UNIT} pr. kasse ÷ ${factor}; rå pris ville give ${PRICE_PER_PURCHASE_UNIT})`);

    const row = r.status === 200 ? db.prepare(
        `SELECT received_price, received_price_source FROM goods_receipt_items WHERE receipt_id = ?`).get(r.body.id) : null;
    record('T_VAREMOD_F_UNIT_05', 'UNIT',
        row && Math.abs(row.received_price - expectedPrice) < 0.01 && row.received_price_source === PRICE_BARCODE
            ? 'PASS' : 'FAIL',
        `gemt: pris=${row?.received_price} varenr=${row?.received_price_source}`);

    // UNIT_06: vare uden kobling lander uden pris og uden fejl.
    if (!plainPid) {
        record('T_VAREMOD_F_UNIT_06', 'UNIT', 'SKIP', 'ingen vare uden stregkoder på grocytest');
        return;
    }
    const r2 = await createReceipt(basePayload({
        items: [{ grocy_product_id: plainPid, product_name: 'PRIS uden kobling',
                  received_quantity: FAIL_QTY, status: 'ok' }],
    }));
    if (r2.status === 200) {
        createdReceiptIds.push(r2.body.id);
        grocyMutations.push({ pid: plainPid, amount: FAIL_QTY });
    }
    const row2 = r2.status === 200 ? db.prepare(
        `SELECT received_price, grocy_added, grocy_error FROM goods_receipt_items WHERE receipt_id = ?`).get(r2.body.id) : null;
    record('T_VAREMOD_F_UNIT_06', 'UNIT',
        r2.body?.status === 'approved' && row2 && row2.received_price === null
            && row2.grocy_added === 1 && !row2.grocy_error ? 'PASS' : 'FAIL',
        `pid=${plainPid} status=${r2.body?.status} pris=${row2?.received_price} added=${row2?.grocy_added} err=${row2?.grocy_error || '—'}`);
}

async function cleanupPrice() {
    if (priceBarcodeId) {
        try { await api('DELETE', `/api/grocy/product-barcodes/${priceBarcodeId}`); }
        catch (e) { console.log(`  ! test-stregkode ${PRICE_BARCODE} (id ${priceBarcodeId}) ikke slettet: ${e.message}`); }
    }
}

async function runObservedCases() {
    console.log('\n── OBS: modtagelse stempler som observeret (#336) ──');

    // Fysisk enhed på en syntetisk lokation — receipten peger selv på den,
    // så vi behøver ikke ramme en rigtig Grocy-lokation.
    try {
        const ins = db.prepare(`
            INSERT INTO physical_units (grocy_location_id, name, sort_order)
            VALUES (?, ?, 0)
        `).run(OBS_LOCATION_ID, OBS_UNIT_NAME);
        obsUnitId = ins.lastInsertRowid;
    } catch (err) {
        record('T_VAREMOD_F_OBS_01', 'OBS', 'SKIP', `Kunne ikke oprette enhed: ${err.message}`);
        return;
    }

    // Snapshot userfields så de kan rulles tilbage
    try {
        const prods = (await api('GET', '/api/grocy/products')).body || [];
        const p = prods.find(x => parseInt(x.id) === REAL_PID_A);
        obsUserfieldsBefore = {
            LastCheckedAt:   p?.userfields?.LastCheckedAt   || '',
            LastCheckedUnit: p?.userfields?.LastCheckedUnit || '',
        };
        // B's stempel skal sammenlignes eksakt før/efter. "Er det friskt?"
        // duer ikke: FAIL-gruppen har allerede stemplet B lovligt tidligere i
        // samme kørsel, så et frisk stempel siger intet om DENNE receipt.
        const pB = prods.find(x => parseInt(x.id) === REAL_PID_B);
        obsBStampBefore = pB?.userfields?.LastCheckedAt || null;
    } catch (err) {
        record('T_VAREMOD_F_OBS_01', 'OBS', 'SKIP', `Kunne ikke snapshotte userfields: ${err.message}`);
        return;
    }

    const r = await createReceipt(basePayload({
        location_id: OBS_LOCATION_ID,
        items: [
            { grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'OBS modtaget', received_quantity: FAIL_QTY, status: 'ok' },
            { grocy_product_id: REAL_PID_B, qu_id: STOCK_QU, product_name: 'OBS mangler',  received_quantity: 0,        status: 'missing' },
        ]
    }));

    if (r.status !== 200) {
        record('T_VAREMOD_F_OBS_01', 'OBS', 'FAIL', `POST status=${r.status}`);
        record('T_VAREMOD_F_OBS_02', 'OBS', 'SKIP', 'forrige fejlede');
        record('T_VAREMOD_F_OBS_03', 'OBS', 'SKIP', '');
        return;
    }
    grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });

    await sleep(500);
    const prodsAfter = (await api('GET', '/api/grocy/products')).body || [];
    const a = prodsAfter.find(x => parseInt(x.id) === REAL_PID_A);
    const b = prodsAfter.find(x => parseInt(x.id) === REAL_PID_B);

    // OBS_01: enheden udledt af lokationen — ingen brugerhandling
    if (a?.userfields?.LastCheckedUnit === OBS_UNIT_NAME) {
        record('T_VAREMOD_F_OBS_01', 'OBS', 'PASS');
    } else {
        record('T_VAREMOD_F_OBS_01', 'OBS', 'FAIL',
            `LastCheckedUnit=${a?.userfields?.LastCheckedUnit} (forventet ${OBS_UNIT_NAME})`);
    }

    // OBS_02: tidsstemplet er sat og friskt
    {
        const raw = a?.userfields?.LastCheckedAt;
        const alder = raw ? (Date.now() - new Date(raw).getTime()) / 1000 : Infinity;
        if (raw && alder < 120) {
            record('T_VAREMOD_F_OBS_02', 'OBS', 'PASS', VERBOSE ? `${Math.round(alder)}s gammel` : '');
        } else {
            record('T_VAREMOD_F_OBS_02', 'OBS', 'FAIL', `LastCheckedAt=${raw}`);
        }
    }

    // OBS_03: en vare der IKKE kom på lager må ikke stemples. Ellers ville en
    // manglende vare se "tjekket" ud og synke i optællingens sortering — præcis
    // Bug 1 fra #331, bare gennem en anden dør.
    {
        const bAt = b?.userfields?.LastCheckedAt || null;
        if (bAt === obsBStampBefore) {
            record('T_VAREMOD_F_OBS_03', 'OBS', 'PASS');
        } else {
            record('T_VAREMOD_F_OBS_03', 'OBS', 'FAIL',
                `manglende vares stempel ændret: ${obsBStampBefore} → ${bAt}`);
        }
    }

    // OBS_04: uden location_id findes ingen enhed — stemplingen må stadig ikke
    // vælte modtagelsen, og LastCheckedUnit skal være urørt.
    {
        const before = a?.userfields?.LastCheckedUnit;
        const r2 = await createReceipt(basePayload({
            items: [{ grocy_product_id: REAL_PID_A, qu_id: STOCK_QU, product_name: 'OBS uden lokation',
                      received_quantity: FAIL_QTY, status: 'ok' }]
        }));
        if (r2.status === 200) grocyMutations.push({ pid: REAL_PID_A, amount: FAIL_QTY });
        await sleep(500);
        const again = ((await api('GET', '/api/grocy/products')).body || [])
            .find(x => parseInt(x.id) === REAL_PID_A);
        if (r2.status === 200 && again?.userfields?.LastCheckedUnit === before) {
            record('T_VAREMOD_F_OBS_04', 'OBS', 'PASS');
        } else {
            record('T_VAREMOD_F_OBS_04', 'OBS', 'FAIL',
                `status=${r2.status}, unit=${again?.userfields?.LastCheckedUnit} (forventet uændret ${before})`);
        }
    }
}

async function cleanupObserved() {
    if (obsUnitId) {
        try { db.prepare(`DELETE FROM physical_units WHERE id = ?`).run(obsUnitId); } catch (e) {}
    }
    if (obsUserfieldsBefore) {
        try {
            await api('PUT', `/api/grocy/products/${REAL_PID_A}/userfields`, obsUserfieldsBefore);
        } catch (e) { /* best-effort */ }
    }
}

async function cleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n[cleanup] SKIPPED (--skip-cleanup)');
        console.log(`  ${createdReceiptIds.length} receipts, ${grocyMutations.length} Grocy-muts, ${createdPhotoPaths.length} fotos — IKKE ryddet`);
        return;
    }

    console.log('\n── Cleanup ──');

    // CLEANUP_01: Slet test-receipts (alle markeret med T_VAREMOD_F supplier)
    const rows = db.prepare(
        `SELECT id FROM goods_receipts WHERE supplier_name LIKE 'T_VAREMOD_F %'`
    ).all();
    const ids = rows.map(r => r.id);
    if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM goods_receipt_items WHERE receipt_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM goods_receipts WHERE supplier_name LIKE 'T_VAREMOD_F %'`).run();
    }

    const remaining = db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipts WHERE supplier_name LIKE 'T_VAREMOD_F %'`
    ).get().n;
    if (remaining === 0) {
        record('T_VAREMOD_F_CLEANUP_01', 'CLEANUP', 'PASS',
            VERBOSE ? `Slettet ${ids.length} receipts` : '');
    } else {
        record('T_VAREMOD_F_CLEANUP_01', 'CLEANUP', 'FAIL',
            `${remaining} test-receipts tilbage`);
    }

    // CLEANUP_02: cascade items væk
    const orphanItems = db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_items WHERE receipt_id IN (
            SELECT id FROM goods_receipts WHERE supplier_name LIKE 'T_VAREMOD_F %'
        )`
    ).get().n;
    if (orphanItems === 0) {
        record('T_VAREMOD_F_CLEANUP_02', 'CLEANUP', 'PASS');
    } else {
        record('T_VAREMOD_F_CLEANUP_02', 'CLEANUP', 'FAIL',
            `${orphanItems} items har stadig parent`);
    }

    // CLEANUP_03: Restore Grocy stock (consume det vi har tilført)
    if (grocyMutations.length > 0) {
        const items = grocyMutations.map(m => ({ product_id: m.pid, amount: m.amount }));
        try {
            const r = await api('POST', '/api/grocy/consume-products', {
                items,
                // #361: lagertræk kræver nu en idempotens-nonce. Cleanup er en
                // engangshandling pr. kørsel, så et tidsstempel er nok til at
                // gøre den unik.
                consume_nonce: `t-varemod-cleanup-${Date.now()}`,
            });
            const allOk = r.body?.results?.every(x => x.success);
            if (allOk) {
                record('T_VAREMOD_F_CLEANUP_03', 'CLEANUP', 'PASS',
                    VERBOSE ? `Consumed ${items.length} mutations` : '');
            } else {
                record('T_VAREMOD_F_CLEANUP_03', 'CLEANUP', 'FAIL',
                    `Grocy consume fejlede: ${JSON.stringify(r.body)}`);
            }
        } catch (err) {
            record('T_VAREMOD_F_CLEANUP_03', 'CLEANUP', 'FAIL', err.message);
        }
    } else {
        record('T_VAREMOD_F_CLEANUP_03', 'CLEANUP', 'PASS', 'Ingen Grocy-mutationer at restore');
    }

    // CLEANUP_04: Restore counter
    const currentCounter = readCounter();
    writeCounter(originalCounter);
    record('T_VAREMOD_F_CLEANUP_04', 'CLEANUP', 'PASS',
        VERBOSE ? `Counter: ${currentCounter} → ${originalCounter}` : '');

    // CLEANUP_05: Photo-filer ryddet
    let photoErrors = 0;
    for (const p of createdPhotoPaths) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (err) {
            photoErrors++;
            console.warn(`  ⚠ kunne ikke slette ${p}: ${err.message}`);
        }
    }
    if (photoErrors === 0) {
        record('T_VAREMOD_F_CLEANUP_05', 'CLEANUP', 'PASS',
            VERBOSE ? `Slettet ${createdPhotoPaths.length} photo-filer` : '');
    } else {
        record('T_VAREMOD_F_CLEANUP_05', 'CLEANUP', 'FAIL',
            `${photoErrors}/${createdPhotoPaths.length} photo-filer kunne ikke slettes`);
    }

    // Webhook-buffer ryddes til sidst (har ikke konsekvens, men ren state for næste kørsel)
    await clearWebhookBuffer();
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_VAREMODTAGELSE_FULL_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','NUM','VAL','TEMP','CHECK','DEV','PHOTO_F','FAIL','PATCH_E','CONC','LIST','DETAIL','USERS','CLEANUP'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass: inGroup.filter(r => r.status === 'PASS').length,
            fail: inGroup.filter(r => r.status === 'FAIL').length,
            skip: inGroup.filter(r => r.status === 'SKIP').length,
        };
    }

    let md = `# T_VAREMODTAGELSE_FULL — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_VAREMODTAGELSE_FULL] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_VAREMODTAGELSE_FULL] Server: ${SERVER_URL}`);
    console.log(`[run_T_VAREMODTAGELSE_FULL] DB:     ${process.env.DB_PATH}`);
    if (SKIP_CLEANUP) console.log(`[run_T_VAREMODTAGELSE_FULL] WARNING: --skip-cleanup`);

    const setupOk = await runSetupCases();
    if (!setupOk) {
        console.error('[run_T_VAREMODTAGELSE_FULL] Setup fejlede — bryder');
        db.close();
        const { fails } = writeReport();
        process.exit(fails > 0 ? 1 : 0);
    }

    try {
        await runNumCases();
        await runValidationCases();
        await runTempCases();
        await runCheckCases();
        await runDeviationCases();
        await runPhotoCases();
        await runFailCases();
        await runPatchECases();
        await runConcurrencyCases();
        await runListCases();
        await runDetailCases();
        await runUsersCases();
        await runAdhocBackdateCases();
        await runObservedCases();
        await runUnitConversionCases();
        await runPriceCases();
    } catch (err) {
        console.error('[run_T_VAREMODTAGELSE_FULL] FEJL under test:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await cleanupObserved();
    await cleanupPrice();
    await cleanup();

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_VAREMODTAGELSE_FULL] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_VAREMODTAGELSE_FULL] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
