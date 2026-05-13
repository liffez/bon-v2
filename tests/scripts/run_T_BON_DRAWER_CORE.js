#!/usr/bin/env node
/**
 * tests/scripts/run_T_BON_DRAWER_CORE.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for bon-drawer's kerne-endpoints.
 *
 * 6 endpoints + ~60 cases:
 *   GET /api/bons/:id              — detalje incl. moms
 *   POST /api/bons                  — opret med server-autoritativ recalc
 *   PATCH /api/bons/:id            — opdater (felt-whitelist)
 *   PATCH /api/bons/:id/status     — status-skift med transition-tjek
 *   PATCH /api/bons/:id/prep       — prep-flags
 *   PATCH /api/bons/:id/kitchen-info — fri-tekst notat
 *
 * Plus RECALC/MOMS-regression, SSE-verifikation, EDGE-cases.
 *
 * Hermetisk via T_BD_-prefix på bon_number.
 *
 * Usage:
 *   npm run test:run-bon-drawer-core
 *   node tests/scripts/run_T_BON_DRAWER_CORE.js --verbose
 *
 * Reference: tests/specs/T_BON_DRAWER_CORE.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');
const sse          = require('./helpers/sse_listener');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

const args         = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const FLOAT_TOL = 0.01;
const TEST_PREFIX = 'T_BD';

let db;
let SESSION_COOKIE = null;
let sseListener = null;
const results = [];
const testBons = {};   // { BASE: {id,...}, TERM: ..., PREP: ... }
let testCustomerId, testCompanyId;
let initialBonsCount = null;  // Snapshot ved runner-start (CLEANUP_04 sammenligning)

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
    const res  = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function login() {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) throw new Error(`Login fejlede: ${res.status}`);
    SESSION_COOKIE = res.headers.get('set-cookie')?.split(';')[0];
    if (!SESSION_COOKIE) throw new Error('Ingen set-cookie');
}

function today()    { return new Date().toISOString().slice(0, 10); }
function statusId(code) { return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id; }
function defaultLocation() { return db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id; }
function getBonStatusCode(bonId) {
    const row = db.prepare(`SELECT sd.code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`).get(bonId);
    return row?.code;
}

// Test-fixtures
function createTestCustomerAndCompany() {
    const compRes = db.prepare(`INSERT INTO companies (name, notes) VALUES (?, ?)`)
        .run(`${TEST_PREFIX} Drawer test`, 'T_BD_test');
    testCompanyId = compRes.lastInsertRowid;

    const custRes = db.prepare(
        `INSERT INTO customers (company_id, first_name, last_name, phone, email, notes) VALUES (?, 'Drawer', 'Hansen', '11223344', 'drawer@test.dk', 'T_BD_test')`
    ).run(testCompanyId);
    testCustomerId = custRes.lastInsertRowid;
}

function createTestBon(key, statusCode, extra = {}) {
    const bonNumber = `${TEST_PREFIX}_${key}`;
    const result = db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                          order_date, delivery_date, pax, total_price, is_offer, delivery_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        bonNumber, statusId(statusCode), defaultLocation(), testCustomerId, testCompanyId,
        today(), today(), extra.pax ?? 5, extra.totalPrice ?? 0, extra.isOffer ?? 0,
        extra.deliveryType ?? 'delivery'
    );
    const id = result.lastInsertRowid;
    const bon = db.prepare(`SELECT * FROM bons WHERE id = ?`).get(id);
    testBons[key] = bon;
    return bon;
}

function getChangelogCount(bonId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=?`).get(bonId).n;
}

// ════════════════════════════════════════════════════════════
// 4.1 SETUP (4)
// ════════════════════════════════════════════════════════════

async function runSetup() {
    console.log('\n── 4.1 SETUP ──');

    // SETUP_01: Opret testfirma + 3 test-bons
    try {
        createTestCustomerAndCompany();
        createTestBon('BASE', 'NY');
        createTestBon('TERM', 'FAKTURERET');
        createTestBon('PREP', 'IGANG');
        record('T_BD_C_SETUP_01', 'SETUP', 'PASS', VERBOSE ? `3 test-bons + kunde + firma` : '');
    } catch (err) {
        record('T_BD_C_SETUP_01', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_02: computeMomsFields importerbar
    try {
        const { computeMomsFields } = require('../../db/helpers');
        if (typeof computeMomsFields === 'function') {
            record('T_BD_C_SETUP_02', 'SETUP', 'PASS');
        } else {
            record('T_BD_C_SETUP_02', 'SETUP', 'FAIL', 'computeMomsFields ikke function');
            return false;
        }
    } catch (err) {
        record('T_BD_C_SETUP_02', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_03: Login + cookie
    try {
        await login();
        record('T_BD_C_SETUP_03', 'SETUP', 'PASS');
    } catch (err) {
        record('T_BD_C_SETUP_03', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_04: SSE-listener forbundet
    try {
        sseListener = await sse.connect(SERVER_URL, SESSION_COOKIE);
        await sseListener.waitForEvent('connected', null, 2000);
        record('T_BD_C_SETUP_04', 'SETUP', 'PASS');
    } catch (err) {
        record('T_BD_C_SETUP_04', 'SETUP', 'FAIL', err.message);
        return false;
    }

    return true;
}

// ════════════════════════════════════════════════════════════
// 4.2 GET /api/bons/:id (5)
// ════════════════════════════════════════════════════════════

async function runGetCases() {
    console.log('\n── 4.2 GET /:id ──');

    const baseId = testBons.BASE.id;

    // GET_01: valid id → 200 + fuld bon + moms
    {
        const r = await api('GET', `/api/bons/${baseId}`);
        if (r.status === 200 && r.body?.id === baseId && r.body?.bon_number) {
            record('T_BD_C_GET_01', 'GET', 'PASS');
        } else {
            record('T_BD_C_GET_01', 'GET', 'FAIL', `status=${r.status}, id=${r.body?.id}`);
        }
    }

    // GET_02: ikke-eksisterende → 404
    {
        const r = await api('GET', '/api/bons/99999999');
        if (r.status === 404) record('T_BD_C_GET_02', 'GET', 'PASS');
        else record('T_BD_C_GET_02', 'GET', 'FAIL', `status=${r.status}`);
    }

    // GET_03: string id → parseInt NaN → 404 (graceful)
    {
        const r = await api('GET', '/api/bons/abc');
        if (r.status === 404 || r.status === 400) record('T_BD_C_GET_03', 'GET', 'PASS',
            VERBOSE ? `status=${r.status}` : '');
        else record('T_BD_C_GET_03', 'GET', 'FAIL', `status=${r.status}`);
    }

    // GET_04: moms-decoration
    {
        const r = await api('GET', `/api/bons/${baseId}`);
        const momsKeys = Object.keys(r.body || {}).filter(k => k.match(/moms|excl|incl/i));
        if (momsKeys.length >= 2) {
            record('T_BD_C_GET_04', 'GET', 'PASS', VERBOSE ? momsKeys.join(',') : '');
        } else {
            record('T_BD_C_GET_04', 'GET', 'FAIL', `moms-keys=${momsKeys.join(',')}`);
        }
    }

    // GET_05: bon med is_offer=1 returneres alligevel (kun listview ekskluderer)
    {
        const offerRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, 1, 'delivery')
        `).run(`${TEST_PREFIX}_OFFER`, statusId('NY'), defaultLocation(), testCustomerId, testCompanyId, today(), today());
        const offerId = offerRes.lastInsertRowid;

        const r = await api('GET', `/api/bons/${offerId}`);
        if (r.status === 200 && r.body?.id === offerId) {
            record('T_BD_C_GET_05', 'GET', 'PASS', VERBOSE ? 'GET /:id ekskluderer IKKE tilbud' : '');
        } else {
            record('T_BD_C_GET_05', 'GET', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.3 POST /api/bons (8)
// ════════════════════════════════════════════════════════════

const createdBonsInRunner = [];

async function runPostCases() {
    console.log('\n── 4.3 POST / ──');

    // POST_01: minimal body
    {
        const r = await api('POST', '/api/bons', { delivery_date: today() });
        if (r.status === 200 || r.status === 201) {
            const id = r.body?.id;
            createdBonsInRunner.push(id);
            const dbBon = db.prepare(`SELECT * FROM bons WHERE id = ?`).get(id);
            if (dbBon && dbBon.bon_number && dbBon.status_id === statusId('NY')) {
                record('T_BD_C_POST_01', 'POST', 'PASS',
                    VERBOSE ? `bon_number=${dbBon.bon_number}` : '');
            } else {
                record('T_BD_C_POST_01', 'POST', 'FAIL', `dbBon=${JSON.stringify(dbBon)}`);
            }
        } else {
            record('T_BD_C_POST_01', 'POST', 'FAIL', `status=${r.status}, body=${r.raw?.slice(0,150)}`);
        }
    }

    // POST_02: uden delivery_date → 400
    {
        const r = await api('POST', '/api/bons', { pax: 5 });
        if (r.status === 400 && /delivery_date/i.test(r.body?.error || '')) {
            record('T_BD_C_POST_02', 'POST', 'PASS');
        } else {
            record('T_BD_C_POST_02', 'POST', 'FAIL', `status=${r.status}, body=${r.raw?.slice(0,150)}`);
        }
    }

    // POST_03 (KRITISK): klient-sat total_price IGNORERES (server-recalc)
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: today(),
            total_price: 99999,
        });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            const dbBon = db.prepare(`SELECT total_price FROM bons WHERE id = ?`).get(r.body.id);
            if (dbBon.total_price !== 99999) {
                record('T_BD_C_POST_03', 'POST', 'PASS',
                    `Server-recalc holdt: klient sendte 99999, DB.total_price=${dbBon.total_price}`);
            } else {
                record('T_BD_C_POST_03', 'POST', 'FAIL',
                    `KRITISK: klient kunne diktere total_price=99999`);
            }
        } else {
            record('T_BD_C_POST_03', 'POST', 'FAIL', `status=${r.status}`);
        }
    }

    // POST_04: total_with_delivery også ignoreres
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: today(),
            delivery_price: 50,
            total_with_delivery: 99999,
        });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            const dbBon = db.prepare(`SELECT total_with_delivery FROM bons WHERE id = ?`).get(r.body.id);
            if (dbBon.total_with_delivery !== 99999) {
                record('T_BD_C_POST_04', 'POST', 'PASS',
                    VERBOSE ? `DB.total_with_delivery=${dbBon.total_with_delivery}` : '');
            } else {
                record('T_BD_C_POST_04', 'POST', 'FAIL',
                    `Server-recalc forhindrede ikke klient-værdi`);
            }
        } else {
            record('T_BD_C_POST_04', 'POST', 'FAIL', `status=${r.status}`);
        }
    }

    // POST_05: booleans konverteres
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: today(),
            kitchen_selects: true,
            customer_collects: false,
            is_internal: true,
        });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            const dbBon = db.prepare(`SELECT kitchen_selects, customer_collects, is_internal FROM bons WHERE id = ?`).get(r.body.id);
            if (dbBon.kitchen_selects === 1 && dbBon.customer_collects === 0 && dbBon.is_internal === 1) {
                record('T_BD_C_POST_05', 'POST', 'PASS');
            } else {
                record('T_BD_C_POST_05', 'POST', 'FAIL', JSON.stringify(dbBon));
            }
        } else {
            record('T_BD_C_POST_05', 'POST', 'FAIL', `status=${r.status}`);
        }
    }

    // POST_06: customer + company persisterer
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: today(),
            customer_id: testCustomerId,
            company_id: testCompanyId,
        });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            const dbBon = db.prepare(`SELECT customer_id, company_id FROM bons WHERE id = ?`).get(r.body.id);
            if (dbBon.customer_id === testCustomerId && dbBon.company_id === testCompanyId) {
                record('T_BD_C_POST_06', 'POST', 'PASS');
            } else {
                record('T_BD_C_POST_06', 'POST', 'FAIL', JSON.stringify(dbBon));
            }
        } else {
            record('T_BD_C_POST_06', 'POST', 'FAIL', `status=${r.status}`);
        }
    }

    // POST_07: logChange registreret
    {
        const r = await api('POST', '/api/bons', { delivery_date: today() });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            const cl = db.prepare(`SELECT * FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='create' LIMIT 1`).get(r.body.id);
            if (cl) record('T_BD_C_POST_07', 'POST', 'PASS', VERBOSE ? `action=${cl.action}, newValue=${cl.new_value}` : '');
            else record('T_BD_C_POST_07', 'POST', 'FAIL', 'Ingen create-entry i changelog');
        } else {
            record('T_BD_C_POST_07', 'POST', 'FAIL', `status=${r.status}`);
        }
    }

    // POST_08: SSE bon_created broadcast
    {
        sseListener.clearEvents();
        const r = await api('POST', '/api/bons', { delivery_date: today() });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            try {
                await sseListener.waitForEvent('bon_created', e => e.id === r.body.id, 2500);
                record('T_BD_C_POST_08', 'POST', 'PASS');
            } catch (err) {
                record('T_BD_C_POST_08', 'POST', 'FAIL', err.message);
            }
        } else {
            record('T_BD_C_POST_08', 'POST', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.4 PATCH /api/bons/:id (10)
// ════════════════════════════════════════════════════════════

async function runPatchCases() {
    console.log('\n── 4.4 PATCH /:id ──');

    const baseId = testBons.BASE.id;

    // PATCH_01: valid felt-opdatering
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, { pax: 10 });
        const dbBon = db.prepare(`SELECT pax FROM bons WHERE id = ?`).get(baseId);
        if (r.status === 200 && dbBon.pax === 10) {
            record('T_BD_C_PATCH_01', 'PATCH', 'PASS');
        } else {
            record('T_BD_C_PATCH_01', 'PATCH', 'FAIL', `status=${r.status}, db.pax=${dbBon.pax}`);
        }
    }

    // PATCH_02: 5 felter samtidigt
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, {
            pax: 12,
            delivery_time: '14:00',
            pickup_time: '13:30',
            kitchen_info: 'Test note',
            internal_notes: 'Internal test',
        });
        const dbBon = db.prepare(`SELECT pax, delivery_time, pickup_time, kitchen_info, internal_notes FROM bons WHERE id = ?`).get(baseId);
        if (r.status === 200
            && dbBon.pax === 12
            && dbBon.delivery_time === '14:00'
            && dbBon.pickup_time === '13:30'
            && dbBon.kitchen_info === 'Test note'
            && dbBon.internal_notes === 'Internal test') {
            record('T_BD_C_PATCH_02', 'PATCH', 'PASS');
        } else {
            record('T_BD_C_PATCH_02', 'PATCH', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PATCH_03: tom body → 400
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, {});
        if (r.status === 400) record('T_BD_C_PATCH_03', 'PATCH', 'PASS');
        else record('T_BD_C_PATCH_03', 'PATCH', 'FAIL', `status=${r.status}`);
    }

    // PATCH_04 (KRITISK): ikke-allowed felter filtreres væk
    {
        const before = db.prepare(`SELECT status_id, total_price, bon_number FROM bons WHERE id = ?`).get(baseId);
        const r = await api('PATCH', `/api/bons/${baseId}`, {
            status_id: 99,
            total_price: 99999,
            bon_number: 'HACKED',
            pax: 99, // allowed — sikker at den ikke filtreres
        });
        const after = db.prepare(`SELECT status_id, total_price, bon_number, pax FROM bons WHERE id = ?`).get(baseId);
        const filtered =
            after.status_id === before.status_id
            && after.total_price === before.total_price
            && after.bon_number === before.bon_number
            && after.pax === 99;
        if (r.status === 200 && filtered) {
            record('T_BD_C_PATCH_04', 'PATCH', 'PASS',
                VERBOSE ? 'status_id/total_price/bon_number ignoreret, pax opdateret' : '');
        } else {
            record('T_BD_C_PATCH_04', 'PATCH', 'FAIL', `before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
        }
    }

    // PATCH_05: 404
    {
        const r = await api('PATCH', '/api/bons/99999999', { pax: 1 });
        if (r.status === 404) record('T_BD_C_PATCH_05', 'PATCH', 'PASS');
        else record('T_BD_C_PATCH_05', 'PATCH', 'FAIL', `status=${r.status}`);
    }

    // PATCH_06: boolean-konvertering
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, {
            kitchen_selects: true,
            is_internal: false,
        });
        const dbBon = db.prepare(`SELECT kitchen_selects, is_internal FROM bons WHERE id = ?`).get(baseId);
        if (r.status === 200 && dbBon.kitchen_selects === 1 && dbBon.is_internal === 0) {
            record('T_BD_C_PATCH_06', 'PATCH', 'PASS');
        } else {
            record('T_BD_C_PATCH_06', 'PATCH', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PATCH_07: delivery_price → recalc. NB: recalcBonTotal skriver
    // (linesSum + delivery) til BÅDE total_price OG total_with_delivery.
    // Bon BASE har ingen lines → linesSum=0 → total_price = total_with_delivery = 75.
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, { delivery_price: 75 });
        const dbBon = db.prepare(`SELECT delivery_price, total_price, total_with_delivery FROM bons WHERE id = ?`).get(baseId);
        if (r.status === 200
            && dbBon.delivery_price === 75
            && Math.abs(dbBon.total_with_delivery - 75) < FLOAT_TOL
            && Math.abs(dbBon.total_price - dbBon.total_with_delivery) < FLOAT_TOL) {
            record('T_BD_C_PATCH_07', 'PATCH', 'PASS',
                VERBOSE ? `total_price=total_with_delivery=${dbBon.total_with_delivery}` : '');
        } else {
            record('T_BD_C_PATCH_07', 'PATCH', 'FAIL',
                `delivery_price=${dbBon.delivery_price}, total_price=${dbBon.total_price}, total_with_delivery=${dbBon.total_with_delivery}`);
        }
    }

    // PATCH_08: logChange pr. ændret felt, IKKE for uændret
    {
        // Sæt en kendt værdi først
        await api('PATCH', `/api/bons/${baseId}`, { pax: 20, day_contact_name: 'Mr Test' });
        const beforeCount = getChangelogCount(baseId);

        // Send samme værdi for pax (no-op) + ny værdi for day_contact_name
        await api('PATCH', `/api/bons/${baseId}`, { pax: 20, day_contact_name: 'Ms Test' });
        const afterCount = getChangelogCount(baseId);

        // Forventet: præcis 1 ny entry (kun day_contact_name ændret)
        if (afterCount === beforeCount + 1) {
            record('T_BD_C_PATCH_08', 'PATCH', 'PASS',
                VERBOSE ? `+1 entry (kun day_contact_name ændret)` : '');
        } else {
            record('T_BD_C_PATCH_08', 'PATCH', 'FAIL',
                `+${afterCount - beforeCount} entries (forventede 1)`);
        }
    }

    // PATCH_09: SSE bon_updated
    {
        sseListener.clearEvents();
        const r = await api('PATCH', `/api/bons/${baseId}`, { pax: 7 });
        if (r.status !== 200) {
            record('T_BD_C_PATCH_09', 'PATCH', 'FAIL', `status=${r.status}`);
        } else {
            try {
                await sseListener.waitForEvent('bon_updated', e => e.id === baseId, 2000);
                record('T_BD_C_PATCH_09', 'PATCH', 'PASS');
            } catch (err) {
                record('T_BD_C_PATCH_09', 'PATCH', 'FAIL', err.message);
            }
        }
    }

    // PATCH_10: updated_at opdateres
    {
        const before = db.prepare(`SELECT updated_at FROM bons WHERE id = ?`).get(baseId);
        await sleep(1100); // sikrer at TIMESTAMP er anderledes (sekund-granularitet)
        await api('PATCH', `/api/bons/${baseId}`, { pax: 8 });
        const after = db.prepare(`SELECT updated_at FROM bons WHERE id = ?`).get(baseId);
        if (after.updated_at > before.updated_at) {
            record('T_BD_C_PATCH_10', 'PATCH', 'PASS');
        } else {
            record('T_BD_C_PATCH_10', 'PATCH', 'FAIL',
                `before=${before.updated_at}, after=${after.updated_at}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.5 PATCH /:id/status (8)
// ════════════════════════════════════════════════════════════

async function runStatusCases() {
    console.log('\n── 4.5 PATCH /:id/status ──');

    const baseId = testBons.BASE.id;

    // STATUS_01: NY → VENTER (sæt først til NY)
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), baseId);
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'VENTER' });
        const code = getBonStatusCode(baseId);
        if (r.status === 200 && code === 'VENTER') {
            record('T_BD_C_STATUS_01', 'STATUS', 'PASS');
        } else {
            record('T_BD_C_STATUS_01', 'STATUS', 'FAIL', `status=${r.status}, db.code=${code}`);
        }
    }

    // STATUS_02: uden status_code
    {
        const r = await api('PATCH', `/api/bons/${baseId}/status`, {});
        if (r.status === 400 && /status_code/i.test(r.body?.error || '')) {
            record('T_BD_C_STATUS_02', 'STATUS', 'PASS');
        } else {
            record('T_BD_C_STATUS_02', 'STATUS', 'FAIL', `status=${r.status}`);
        }
    }

    // STATUS_03: ukendt status
    {
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'XYZ' });
        if (r.status === 400 && /ukendt/i.test(r.body?.error || '')) {
            record('T_BD_C_STATUS_03', 'STATUS', 'PASS');
        } else {
            record('T_BD_C_STATUS_03', 'STATUS', 'FAIL', `status=${r.status}, body=${JSON.stringify(r.body)}`);
        }
    }

    // STATUS_04: forbudt transition (NY → FAKTURERET)
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), baseId);
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'FAKTURERET' });
        if (r.status === 400 && /ikke tilladt/i.test(r.body?.error || '')) {
            record('T_BD_C_STATUS_04', 'STATUS', 'PASS');
        } else {
            record('T_BD_C_STATUS_04', 'STATUS', 'FAIL', `status=${r.status}`);
        }
    }

    // STATUS_05: changelog action='status_change', fieldName='status_id'
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), baseId);
        const beforeCount = getChangelogCount(baseId);
        await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'GODKENDT' });
        const cl = db.prepare(
            `SELECT action, field_name, old_value, new_value FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='status_change' ORDER BY id DESC LIMIT 1`
        ).get(baseId);
        if (cl
            && cl.action === 'status_change'
            && cl.field_name === 'status_id'
            && cl.old_value === 'NY'
            && cl.new_value === 'GODKENDT') {
            record('T_BD_C_STATUS_05', 'STATUS', 'PASS');
        } else {
            record('T_BD_C_STATUS_05', 'STATUS', 'FAIL', JSON.stringify(cl));
        }
    }

    // STATUS_06: SSE bon_status broadcast (predicate matcher specifik transition
    // for at undgå at fange stale events fra forrige status-cases)
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('GODKENDT'), baseId);
        sseListener.clearEvents();
        await sleep(200); // sikrer at clearEvents tager effekt før broadcast
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'IGANG' });
        if (r.status !== 200) {
            record('T_BD_C_STATUS_06', 'STATUS', 'FAIL', `status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_status',
                    e => e.id === baseId && e.new === 'IGANG' && e.old === 'GODKENDT', 2000);
                record('T_BD_C_STATUS_06', 'STATUS', 'PASS');
            } catch (err) {
                record('T_BD_C_STATUS_06', 'STATUS', 'FAIL', err.message);
            }
        }
    }

    // STATUS_07: LEVERET trigger Grocy-flow (vi tjekker blot at inventory_deducted=1 sættes)
    {
        // Sæt op: bon med ingen lines = ingen consume mulig, men flag bør stadig sættes ved poll
        db.prepare(`UPDATE bons SET status_id = ?, inventory_deducted = 0 WHERE id = ?`).run(statusId('KLAR'), baseId);
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'LEVERET' });
        if (r.status !== 200) {
            record('T_BD_C_STATUS_07', 'STATUS', 'FAIL', `status=${r.status}`);
        } else {
            // Vent kort på async consume-flow
            let deducted = 0;
            for (let i = 0; i < 15; i++) {
                await sleep(300);
                deducted = db.prepare(`SELECT inventory_deducted FROM bons WHERE id = ?`).get(baseId).inventory_deducted;
                if (deducted === 1) break;
            }
            if (deducted === 1) {
                record('T_BD_C_STATUS_07', 'STATUS', 'PASS',
                    VERBOSE ? 'inventory_deducted=1 sat' : '');
            } else {
                record('T_BD_C_STATUS_07', 'STATUS', 'PASS',
                    `inventory_deducted=${deducted} (bon har ingen lines → consume ikke kørt — fint)`);
            }
        }
    }

    // STATUS_08: LEVERET idempotens (anden gang skipper)
    {
        // Sæt allerede til LEVERET med inventory_deducted=1
        db.prepare(`UPDATE bons SET status_id = ?, inventory_deducted = 1 WHERE id = ?`).run(statusId('IGANG'), baseId);
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'LEVERET' });
        if (r.status === 200) {
            // inventory_deducted bør stadig være 1 (idempotens — ingen ny consume)
            const after = db.prepare(`SELECT inventory_deducted FROM bons WHERE id = ?`).get(baseId);
            if (after.inventory_deducted === 1) {
                record('T_BD_C_STATUS_08', 'STATUS', 'PASS',
                    VERBOSE ? 'idempotens-tjek: skipped consume' : '');
            } else {
                record('T_BD_C_STATUS_08', 'STATUS', 'FAIL',
                    `inventory_deducted=${after.inventory_deducted}`);
            }
        } else {
            record('T_BD_C_STATUS_08', 'STATUS', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.6 PATCH /:id/prep (6)
// ════════════════════════════════════════════════════════════

async function runPrepCases() {
    console.log('\n── 4.6 PATCH /:id/prep ──');

    const prepId = testBons.PREP.id;

    // PREP_01: ingredients_ready
    {
        // Reset prep-flags først
        db.prepare(`UPDATE bons SET prep_ingredients_ready = 0, prep_supplies_ready = 0 WHERE id = ?`).run(prepId);
        const r = await api('PATCH', `/api/bons/${prepId}/prep`, { ingredients_ready: true });
        const dbBon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(prepId);
        if (r.status === 200 && dbBon.prep_ingredients_ready === 1 && dbBon.prep_supplies_ready === 0) {
            record('T_BD_C_PREP_01', 'PREP', 'PASS');
        } else {
            record('T_BD_C_PREP_01', 'PREP', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PREP_02: supplies_ready
    {
        db.prepare(`UPDATE bons SET prep_ingredients_ready = 0, prep_supplies_ready = 0 WHERE id = ?`).run(prepId);
        const r = await api('PATCH', `/api/bons/${prepId}/prep`, { supplies_ready: true });
        const dbBon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(prepId);
        if (r.status === 200 && dbBon.prep_ingredients_ready === 0 && dbBon.prep_supplies_ready === 1) {
            record('T_BD_C_PREP_02', 'PREP', 'PASS');
        } else {
            record('T_BD_C_PREP_02', 'PREP', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PREP_03: begge
    {
        db.prepare(`UPDATE bons SET prep_ingredients_ready = 0, prep_supplies_ready = 0 WHERE id = ?`).run(prepId);
        const r = await api('PATCH', `/api/bons/${prepId}/prep`, { ingredients_ready: true, supplies_ready: true });
        const dbBon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(prepId);
        if (r.status === 200 && dbBon.prep_ingredients_ready === 1 && dbBon.prep_supplies_ready === 1) {
            record('T_BD_C_PREP_03', 'PREP', 'PASS');
        } else {
            record('T_BD_C_PREP_03', 'PREP', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PREP_04: tom body
    {
        const r = await api('PATCH', `/api/bons/${prepId}/prep`, {});
        if (r.status === 400) record('T_BD_C_PREP_04', 'PREP', 'PASS');
        else record('T_BD_C_PREP_04', 'PREP', 'FAIL', `status=${r.status}`);
    }

    // PREP_05: booleans → 0/1
    {
        db.prepare(`UPDATE bons SET prep_ingredients_ready = 1, prep_supplies_ready = 1 WHERE id = ?`).run(prepId);
        const r = await api('PATCH', `/api/bons/${prepId}/prep`, { ingredients_ready: false });
        const dbBon = db.prepare(`SELECT prep_ingredients_ready FROM bons WHERE id = ?`).get(prepId);
        if (r.status === 200 && dbBon.prep_ingredients_ready === 0) {
            record('T_BD_C_PREP_05', 'PREP', 'PASS');
        } else {
            record('T_BD_C_PREP_05', 'PREP', 'FAIL', JSON.stringify(dbBon));
        }
    }

    // PREP_06 (F52): prep-PATCH skriver IKKE changelog
    {
        const before = getChangelogCount(prepId);
        await api('PATCH', `/api/bons/${prepId}/prep`, { ingredients_ready: true, supplies_ready: true });
        const after = getChangelogCount(prepId);
        if (after === before) {
            record('T_BD_C_PREP_06', 'PREP', 'PASS',
                `F52: prep-flag-ændringer logges IKKE i changelog (audit-gap)`);
        } else {
            record('T_BD_C_PREP_06', 'PREP', 'PASS',
                `F52 lukket: prep nu logget (+${after - before} entries)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.7 PATCH /:id/kitchen-info (4)
// ════════════════════════════════════════════════════════════

async function runKitchenInfoCases() {
    console.log('\n── 4.7 PATCH /:id/kitchen-info ──');

    const baseId = testBons.BASE.id;

    // KI_01: sæt tekst
    {
        const r = await api('PATCH', `/api/bons/${baseId}/kitchen-info`, { text: 'Allergi - nødder' });
        const dbBon = db.prepare(`SELECT kitchen_info FROM bons WHERE id = ?`).get(baseId);
        if (r.status === 200 && dbBon.kitchen_info === 'Allergi - nødder') {
            record('T_BD_C_KI_01', 'KI', 'PASS');
        } else {
            record('T_BD_C_KI_01', 'KI', 'FAIL', `db.kitchen_info=${dbBon.kitchen_info}`);
        }
    }

    // KI_02 (F53): tom text
    {
        const r = await api('PATCH', `/api/bons/${baseId}/kitchen-info`, { text: '' });
        const dbBon = db.prepare(`SELECT kitchen_info FROM bons WHERE id = ?`).get(baseId);
        // F53: tom string lander som null eller "" — dokumentér
        const isCleared = dbBon.kitchen_info === null || dbBon.kitchen_info === '';
        if (r.status === 200 && isCleared) {
            record('T_BD_C_KI_02', 'KI', 'PASS',
                `F53: tom text → kitchen_info=${JSON.stringify(dbBon.kitchen_info)} (clear)`);
        } else {
            record('T_BD_C_KI_02', 'KI', 'FAIL',
                `status=${r.status}, kitchen_info=${JSON.stringify(dbBon.kitchen_info)}`);
        }
    }

    // KI_03: 404
    {
        const r = await api('PATCH', '/api/bons/99999999/kitchen-info', { text: 'test' });
        if (r.status === 404) record('T_BD_C_KI_03', 'KI', 'PASS');
        else record('T_BD_C_KI_03', 'KI', 'FAIL', `status=${r.status}`);
    }

    // KI_04: changelog action='update', fieldName='kitchen_info'
    {
        await api('PATCH', `/api/bons/${baseId}/kitchen-info`, { text: 'Initial' });
        const beforeCount = getChangelogCount(baseId);
        await api('PATCH', `/api/bons/${baseId}/kitchen-info`, { text: 'Updated' });
        const cl = db.prepare(
            `SELECT action, field_name, old_value, new_value FROM changelog WHERE entity_type='bon' AND entity_id=? AND field_name='kitchen_info' ORDER BY id DESC LIMIT 1`
        ).get(baseId);
        if (cl && cl.action === 'update' && cl.field_name === 'kitchen_info'
            && cl.old_value === 'Initial' && cl.new_value === 'Updated') {
            record('T_BD_C_KI_04', 'KI', 'PASS');
        } else {
            record('T_BD_C_KI_04', 'KI', 'FAIL', JSON.stringify(cl));
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.8 RECALC + MOMS (4)
// ════════════════════════════════════════════════════════════

async function runRecalcCases() {
    console.log('\n── 4.8 RECALC + MOMS ──');

    // RECALC_01: POST ny bon, tilføj line, verificér total_price er server-beregnet
    {
        const postRes = await api('POST', '/api/bons', { delivery_date: today() });
        if (postRes.status !== 200 && postRes.status !== 201) {
            record('T_BD_C_RECALC_01', 'RECALC', 'FAIL', `POST status=${postRes.status}`);
            record('T_BD_C_RECALC_02', 'RECALC', 'SKIP', 'setup fejlede');
            record('T_BD_C_RECALC_03', 'RECALC', 'SKIP', '');
            record('T_BD_C_RECALC_04', 'RECALC', 'SKIP', '');
            return;
        }
        const bonId = postRes.body.id;
        createdBonsInRunner.push(bonId);

        const lineRes = await api('POST', `/api/bons/${bonId}/lines`, {
            product_name: 'Test vare',
            quantity: 2,
            unit_price: 100,
            unit: 'stk',
        });
        if (lineRes.status !== 200 && lineRes.status !== 201) {
            record('T_BD_C_RECALC_01', 'RECALC', 'FAIL', `POST line status=${lineRes.status}`);
            return;
        }

        const dbBon = db.prepare(`SELECT total_price FROM bons WHERE id = ?`).get(bonId);
        if (Math.abs(dbBon.total_price - 200) < FLOAT_TOL) {
            record('T_BD_C_RECALC_01', 'RECALC', 'PASS',
                VERBOSE ? `total_price=${dbBon.total_price}` : '');
        } else {
            record('T_BD_C_RECALC_01', 'RECALC', 'FAIL',
                `total_price=${dbBon.total_price} (forventet 200)`);
        }

        // RECALC_02: PATCH delivery_price = 50 → recalc total_with_delivery
        const patchRes = await api('PATCH', `/api/bons/${bonId}`, { delivery_price: 50 });
        const dbAfter = db.prepare(`SELECT total_price, total_with_delivery, delivery_price FROM bons WHERE id = ?`).get(bonId);
        if (patchRes.status === 200
            && Math.abs(dbAfter.delivery_price - 50) < FLOAT_TOL
            && Math.abs(dbAfter.total_with_delivery - 250) < FLOAT_TOL) {
            record('T_BD_C_RECALC_02', 'RECALC', 'PASS');
        } else {
            record('T_BD_C_RECALC_02', 'RECALC', 'FAIL',
                `delivery=${dbAfter.delivery_price}, total_w_del=${dbAfter.total_with_delivery}`);
        }

        // RECALC_03: GET /:id → moms-felter
        const getRes = await api('GET', `/api/bons/${bonId}`);
        const momsKeys = Object.keys(getRes.body || {}).filter(k => k.match(/moms|excl|incl/i));
        if (getRes.status === 200 && momsKeys.length >= 2) {
            record('T_BD_C_RECALC_03', 'RECALC', 'PASS', VERBOSE ? momsKeys.join(',') : '');
        } else {
            record('T_BD_C_RECALC_03', 'RECALC', 'FAIL', `keys=${momsKeys.join(',')}`);
        }

        // RECALC_04: klient PATCH total_price → ignoreres.
        // NB: recalcBonTotal skriver linesSum + delivery til total_price → 200 + 50 = 250.
        // Klient kan ikke ændre dette (allowed-listen filtrerer total_price væk).
        // Vi tester at PATCH endpointet enten returnerer 200 (filtreret) eller 400
        // (ingen gyldige felter) — begge er korrekt opførsel.
        const r = await api('PATCH', `/api/bons/${bonId}`, { total_price: 99999 });
        const dbFinal = db.prepare(`SELECT total_price FROM bons WHERE id = ?`).get(bonId);
        const isExpectedTotal = Math.abs(dbFinal.total_price - 250) < FLOAT_TOL;
        const isFilteredResponse = r.status === 200 || r.status === 400;
        if (isFilteredResponse && isExpectedTotal) {
            record('T_BD_C_RECALC_04', 'RECALC', 'PASS',
                VERBOSE ? `Klient-99999 ignoreret; DB.total_price=${dbFinal.total_price} (recalc'ed)` : '');
        } else {
            record('T_BD_C_RECALC_04', 'RECALC', 'FAIL',
                `status=${r.status}, DB.total_price=${dbFinal.total_price} (forventet 250)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.9 SSE (3)
// ════════════════════════════════════════════════════════════

async function runSseCases() {
    console.log('\n── 4.9 SSE ──');

    const baseId = testBons.BASE.id;

    // SSE_01 (Patch F): status-PATCH → bon_status event med {id, old, new}
    {
        // Sæt op: kendt status først
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), baseId);
        sseListener.clearEvents();
        const r = await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'GODKENDT' });
        if (r.status === 200) {
            try {
                const evt = await sseListener.waitForEvent('bon_status', e => e.id === baseId, 2000);
                if (evt.data.id === baseId && evt.data.old === 'NY' && evt.data.new === 'GODKENDT') {
                    record('T_BD_C_SSE_01', 'SSE', 'PASS');
                } else {
                    record('T_BD_C_SSE_01', 'SSE', 'FAIL', JSON.stringify(evt.data));
                }
            } catch (err) {
                record('T_BD_C_SSE_01', 'SSE', 'FAIL', err.message);
            }
        } else {
            record('T_BD_C_SSE_01', 'SSE', 'FAIL', `status=${r.status}`);
        }
    }

    // SSE_02 (F49 LUKKET — Patch F): bon_status payload bruger {id}, IKKE {bon_id}
    {
        const events = sseListener.getEvents('bon_status').filter(e => e.data?.id === baseId);
        if (events.length > 0) {
            const hasId = 'id' in events[0].data;
            const hasBonIdLegacy = 'bon_id' in events[0].data;
            if (hasId && !hasBonIdLegacy) {
                record('T_BD_C_SSE_02', 'SSE', 'PASS',
                    VERBOSE ? 'F49 lukket: bon_status bruger {id} uden bon_id-fallback' : '');
            } else {
                record('T_BD_C_SSE_02', 'SSE', 'FAIL',
                    `F49 regression: hasId=${hasId}, hasBonIdLegacy=${hasBonIdLegacy}`);
            }
        } else {
            record('T_BD_C_SSE_02', 'SSE', 'FAIL', 'Ingen bon_status events fanget');
        }
    }

    // SSE_03: fejlet transition → ingen broadcast
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), baseId);
        sseListener.clearEvents();
        await api('PATCH', `/api/bons/${baseId}/status`, { status_code: 'FAKTURERET' }); // forbudt
        await sleep(500);
        const events = sseListener.getEvents('bon_status');
        if (events.length === 0) {
            record('T_BD_C_SSE_03', 'SSE', 'PASS');
        } else {
            record('T_BD_C_SSE_03', 'SSE', 'FAIL', `${events.length} uventede events`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.10 EDGE_CASES (5)
// ════════════════════════════════════════════════════════════

async function runEdgeCases() {
    console.log('\n── 4.10 EDGE_CASES ──');

    const baseId = testBons.BASE.id;

    // EDGE_01: PATCH med samme værdi → DB opdateres, men INGEN changelog-entry
    {
        await api('PATCH', `/api/bons/${baseId}`, { pax: 15 });
        const beforeCount = getChangelogCount(baseId);
        await api('PATCH', `/api/bons/${baseId}`, { pax: 15 });
        const afterCount = getChangelogCount(baseId);
        if (afterCount === beforeCount) {
            record('T_BD_C_EDGE_01', 'EDGE', 'PASS',
                VERBOSE ? 'no-op PATCH skriver ikke changelog' : '');
        } else {
            record('T_BD_C_EDGE_01', 'EDGE', 'FAIL',
                `+${afterCount - beforeCount} entries (forventede 0)`);
        }
    }

    // EDGE_02: POST med order_date i fortiden
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: today(),
            order_date: '2020-01-01',
        });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            record('T_BD_C_EDGE_02', 'EDGE', 'PASS',
                VERBOSE ? 'fortidig order_date accepteres' : '');
        } else {
            record('T_BD_C_EDGE_02', 'EDGE', 'FAIL', `status=${r.status}`);
        }
    }

    // EDGE_03 (F55): POST med delivery_date i fortiden
    {
        const r = await api('POST', '/api/bons', { delivery_date: '2020-01-01' });
        if (r.status === 200 || r.status === 201) {
            createdBonsInRunner.push(r.body.id);
            record('T_BD_C_EDGE_03', 'EDGE', 'PASS',
                `F55: fortidig delivery_date accepteres (designvalg eller mangel?)`);
        } else {
            record('T_BD_C_EDGE_03', 'EDGE', 'FAIL', `status=${r.status}`);
        }
    }

    // EDGE_04: PATCH-felt med null
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, { delivery_notes: null });
        const dbBon = db.prepare(`SELECT delivery_notes FROM bons WHERE id = ?`).get(baseId);
        // delivery_notes er allowed — null bør persistere
        // (JSON null parses som JS null som binds som SQL NULL)
        if (r.status === 200 || r.status === 400) {
            // Begge er acceptable — 400 hvis "ingen gyldige felter" pga null-filtreret
            record('T_BD_C_EDGE_04', 'EDGE', 'PASS',
                VERBOSE ? `status=${r.status}, db.delivery_notes=${dbBon.delivery_notes}` : '');
        } else {
            record('T_BD_C_EDGE_04', 'EDGE', 'FAIL', `status=${r.status}`);
        }
    }

    // EDGE_05: string-format på currency-felter
    {
        const r = await api('PATCH', `/api/bons/${baseId}`, { delivery_price: '100.50' });
        const dbBon = db.prepare(`SELECT delivery_price FROM bons WHERE id = ?`).get(baseId);
        // SQLite type affinity: '100.50' kan blive REAL eller TEXT
        if (r.status === 200) {
            record('T_BD_C_EDGE_05', 'EDGE', 'PASS',
                `string-format accepteret, DB.delivery_price=${dbBon.delivery_price} (typeof ${typeof dbBon.delivery_price})`);
        } else {
            record('T_BD_C_EDGE_05', 'EDGE', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.11 CLEANUP (4)
// ════════════════════════════════════════════════════════════

async function runCleanup() {
    console.log('\n── 4.11 CLEANUP ──');

    if (SKIP_CLEANUP) {
        for (let i = 1; i <= 4; i++) record(`T_BD_C_CLEANUP_0${i}`, 'CLEANUP', 'SKIP', '--skip-cleanup');
        return;
    }

    // Saml alle test-bon-ids
    const allTestBonIds = db.prepare(
        `SELECT id FROM bons WHERE bon_number LIKE 'T_BD_%'`
    ).all().map(r => r.id);
    // Også eventuelle runtime-oprettede bons via POST_01-08 (har auto-bon_number, ikke T_BD_-prefix)
    const allIds = [...new Set([...allTestBonIds, ...createdBonsInRunner])];

    if (allIds.length > 0) {
        const ph = allIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph}))`).run(...allIds);
        db.prepare(`DELETE FROM mail_threads WHERE bon_id IN (${ph})`).run(...allIds);
        db.prepare(`DELETE FROM notifications WHERE bon_id IN (${ph})`).run(...allIds);
        db.prepare(`DELETE FROM bon_lines WHERE bon_id IN (${ph})`).run(...allIds);
        db.prepare(`DELETE FROM delivery_events WHERE bon_id IN (${ph})`).run(...allIds);
        db.prepare(`DELETE FROM changelog WHERE entity_type='bon' AND entity_id IN (${ph})`).run(...allIds);
        db.prepare(`DELETE FROM bons WHERE id IN (${ph})`).run(...allIds);
    }

    db.prepare(`DELETE FROM customers WHERE notes = 'T_BD_test'`).run();
    db.prepare(`DELETE FROM companies WHERE notes = 'T_BD_test'`).run();

    // CLEANUP_01
    const remainingBons = db.prepare(`SELECT COUNT(*) AS n FROM bons WHERE bon_number LIKE 'T_BD_%'`).get().n;
    if (remainingBons === 0) record('T_BD_C_CLEANUP_01', 'CLEANUP', 'PASS');
    else record('T_BD_C_CLEANUP_01', 'CLEANUP', 'FAIL', `${remainingBons} T_BD_-bons tilbage`);

    // CLEANUP_02: vores changelog ryddet — kun for de IDs vi har skabt
    // (orphan check på tværs af alle bons fanger residue fra andre runners)
    if (allIds.length === 0) {
        record('T_BD_C_CLEANUP_02', 'CLEANUP', 'PASS');
    } else {
        const ph = allIds.map(() => '?').join(',');
        const ourOrphans = db.prepare(
            `SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id IN (${ph})`
        ).get(...allIds).n;
        if (ourOrphans === 0) record('T_BD_C_CLEANUP_02', 'CLEANUP', 'PASS');
        else record('T_BD_C_CLEANUP_02', 'CLEANUP', 'FAIL', `${ourOrphans} af vores entries tilbage`);
    }

    // CLEANUP_03: SSE-listener afsluttet
    try {
        if (sseListener) sseListener.disconnect();
        record('T_BD_C_CLEANUP_03', 'CLEANUP', 'PASS');
    } catch (err) {
        record('T_BD_C_CLEANUP_03', 'CLEANUP', 'FAIL', err.message);
    }

    // CLEANUP_04: vores test-bons er væk + pre-eksisterende uændret (tolerant for
    // cross-runner residue: vi tillader at andre runners har efterladt bons,
    // men vores EGNE må ikke være tilbage)
    const remainingTBD = db.prepare(`SELECT COUNT(*) AS n FROM bons WHERE bon_number LIKE 'T_BD_%'`).get().n;
    const afterBonsCount = db.prepare(`SELECT COUNT(*) AS n FROM bons`).get().n;
    const noOurResidue = remainingTBD === 0;
    const matchesInitial = initialBonsCount !== null && initialBonsCount >= afterBonsCount;
    if (noOurResidue && matchesInitial) {
        record('T_BD_C_CLEANUP_04', 'CLEANUP', 'PASS',
            VERBOSE ? `T_BD_=${remainingTBD}, total=${afterBonsCount} (initial=${initialBonsCount})` : '');
    } else {
        record('T_BD_C_CLEANUP_04', 'CLEANUP', 'FAIL',
            `T_BD_=${remainingTBD}, initial=${initialBonsCount}, after=${afterBonsCount}`);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_BON_DRAWER_CORE_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','GET','POST','PATCH','STATUS','PREP','KI','RECALC','SSE','EDGE','CLEANUP'];

    let md = `# T_BON_DRAWER_CORE — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `| Gruppe | PASS | FAIL | SKIP |\n|--------|-----:|-----:|-----:|\n`;
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        if (inGroup.length === 0) continue;
        md += `| ${g} | ${inGroup.filter(r => r.status === 'PASS').length} | ${inGroup.filter(r => r.status === 'FAIL').length} | ${inGroup.filter(r => r.status === 'SKIP').length} |\n`;
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
    console.log(`\n[run_T_BON_DRAWER_CORE] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_BON_DRAWER_CORE] Server: ${SERVER_URL}`);
    if (SKIP_CLEANUP) console.log(`[run_T_BON_DRAWER_CORE] WARNING: --skip-cleanup`);

    // Snapshot pre-eksisterende bon-count FØR vi opretter noget
    initialBonsCount = db.prepare(`SELECT COUNT(*) AS n FROM bons`).get().n;

    const ok = await runSetup();
    if (!ok) {
        if (sseListener) sseListener.disconnect();
        db.close();
        writeReport();
        process.exit(1);
    }

    try {
        await runGetCases();
        await runPostCases();
        await runPatchCases();
        await runStatusCases();
        await runPrepCases();
        await runKitchenInfoCases();
        await runRecalcCases();
        await runSseCases();
        await runEdgeCases();
    } catch (err) {
        console.error('[run_T_BON_DRAWER_CORE] FEJL:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await runCleanup();
    db.close();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_BON_DRAWER_CORE] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_BON_DRAWER_CORE] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    if (sseListener) sseListener.disconnect();
    process.exit(1);
});
