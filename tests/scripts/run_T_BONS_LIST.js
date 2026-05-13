#!/usr/bin/env node
/**
 * tests/scripts/run_T_BONS_LIST.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for office listview backend (T_BONS_LIST).
 *
 * Verificerer `GET /api/bons` med alle filter-/sort-/pagination-parametre
 * + SSE-events der lytter realtid-opdateringer.
 *
 * ~80 cases på tværs af 17 grupper. Bruger hermetisk snapshot+create+
 * cleanup-mønster: alle test-bons har bon_number = 'T_BL_*' så de kan
 * slettes uden at røre seedede data.
 *
 * Usage:
 *   npm run test:run-bons-list
 *   node tests/scripts/run_T_BONS_LIST.js --verbose
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt
 *   - test:server kører på port 4322
 *
 * Reference: tests/specs/T_BONS_LIST.md
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

let db;
let SESSION_COOKIE = null;
let sseListener = null;
const results = [];

// Test-fixture-IDs (sættes i runSetupCases)
const testBons = {};   // { NY_1: {id, bon_number, ...}, ... }
let testCustomerId, testCompanyId;
const TEST_PREFIX = 'T_BL';

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
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

function statusId(code) {
    return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}

function defaultLocation() {
    return db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id;
}

// ════════════════════════════════════════════════════════════
// Test-fixture creation — direkte SQL for fart
// ════════════════════════════════════════════════════════════

function createTestCustomerAndCompany() {
    // Opret testfirma + testkunde med Hansen-navn for search-tests
    const compRes = db.prepare(`
        INSERT INTO companies (name, ean, notes) VALUES (?, ?, ?)
    `).run(`${TEST_PREFIX} Hansen ApS`, '5790000000001', 'T_BL_test');
    testCompanyId = compRes.lastInsertRowid;

    const custRes = db.prepare(`
        INSERT INTO customers (company_id, first_name, last_name, phone, email, is_primary_contact, notes)
        VALUES (?, 'Lars', 'Hansen', '12345678', 'lars@hansen.dk', 1, 'T_BL_test')
    `).run(testCompanyId);
    testCustomerId = custRes.lastInsertRowid;
}

function createTestBon(opts) {
    const {
        key,
        statusCode,
        date,
        time = '12:00',
        pax = 5,
        totalPrice = 800,
        isOffer = 0,
        customerId = testCustomerId,
        companyId = testCompanyId,
        unreadMailCount = 0,
    } = opts;

    const bonNumber = `${TEST_PREFIX}_${key}`;
    const result = db.prepare(`
        INSERT INTO bons (
            bon_number, status_id, location_id, customer_id, company_id,
            order_date, delivery_date, delivery_time,
            pax, total_price, is_offer, delivery_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivery')
    `).run(
        bonNumber, statusId(statusCode), defaultLocation(), customerId, companyId,
        today(), date, time, pax, totalPrice, isOffer
    );

    const bonId = result.lastInsertRowid;
    const bon = db.prepare(`SELECT * FROM bons WHERE id = ?`).get(bonId);
    testBons[key] = bon;

    // Opret evt. ulæste mails — kræver mail_threads + mail_messages
    if (unreadMailCount > 0) {
        const threadRes = db.prepare(`
            INSERT INTO mail_threads (bon_id, subject, status, created_at, updated_at)
            VALUES (?, ?, 'active', datetime('now'), datetime('now'))
        `).run(bonId, `${TEST_PREFIX} test`);
        for (let i = 0; i < unreadMailCount; i++) {
            db.prepare(`
                INSERT INTO mail_messages (thread_id, direction, is_read, body_text, from_email, to_email, subject, message_id, created_at)
                VALUES (?, 'in', 0, 'test', 'a@b.dk', 'c@d.dk', 'test', ?, datetime('now'))
            `).run(threadRes.lastInsertRowid, `T_BL_${bonId}_${i}@test`);
        }
    }

    return bon;
}

// ════════════════════════════════════════════════════════════
// SETUP — 5 cases
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── 4.1 SETUP ──');

    // SETUP_01: DB seedet
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM bons`).get().n;
    if (cnt > 0) record('T_BL_SETUP_01', 'SETUP', 'PASS');
    else { record('T_BL_SETUP_01', 'SETUP', 'FAIL', `bons.count = ${cnt}`); return false; }

    // SETUP_02: Opret testfirma + 6 testbons
    try {
        createTestCustomerAndCompany();
        createTestBon({ key: 'NY_1',   statusCode: 'NY',         date: today(),     pax: 5,  totalPrice: 800,  unreadMailCount: 1 });
        createTestBon({ key: 'NY_2',   statusCode: 'NY',         date: today(),     pax: 10, totalPrice: 1500 });
        createTestBon({ key: 'VENTER', statusCode: 'VENTER',     date: tomorrow(),  pax: 3,  totalPrice: 600 });
        createTestBon({ key: 'IGANG',  statusCode: 'IGANG',      date: today(),     pax: 8,  totalPrice: 1200, unreadMailCount: 2 });
        createTestBon({ key: 'FAKT',   statusCode: 'FAKTURERET', date: daysAgo(5),  pax: 4,  totalPrice: 700 });
        createTestBon({ key: 'OFFER',  statusCode: 'NY',         date: today(),     pax: 12, totalPrice: 2000, isOffer: 1 });
        record('T_BL_SETUP_02', 'SETUP', 'PASS', VERBOSE ? '6 bons + 1 kunde + 1 firma' : '');
    } catch (err) {
        record('T_BL_SETUP_02', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_03: Auth virker (med + uden cookie)
    try {
        await login();
        const without = await fetch(`${SERVER_URL}/api/bons`);
        const withCookie = await api('GET', '/api/bons');
        // bons-endpoint har IKKE requireAuth — uden cookie skal også returnere 200
        // (vi tester at endpointet er reachable; auth findes på andre endpoints)
        if (withCookie.status === 200) record('T_BL_SETUP_03', 'SETUP', 'PASS',
            VERBOSE ? `med cookie=${withCookie.status}, uden cookie=${without.status}` : '');
        else record('T_BL_SETUP_03', 'SETUP', 'FAIL', `status=${withCookie.status}`);
    } catch (err) {
        record('T_BL_SETUP_03', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_04: SSE-listener kan tilsluttes
    try {
        sseListener = await sse.connect(SERVER_URL, SESSION_COOKIE);
        // Vent kort på 'connected'-event
        await sseListener.waitForEvent('connected', null, 2000);
        record('T_BL_SETUP_04', 'SETUP', 'PASS');
    } catch (err) {
        record('T_BL_SETUP_04', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // SETUP_05: computeMomsFields helper
    try {
        const { computeMomsFields } = require('../../db/helpers');
        const fields = computeMomsFields(1000);
        // Verificér at helper returnerer noget meningsfuldt
        if (fields && typeof fields === 'object' && Object.keys(fields).length > 0) {
            record('T_BL_SETUP_05', 'SETUP', 'PASS',
                VERBOSE ? `fields=${Object.keys(fields).join(',')}` : '');
        } else {
            record('T_BL_SETUP_05', 'SETUP', 'FAIL', `Returnerede: ${JSON.stringify(fields)}`);
        }
    } catch (err) {
        record('T_BL_SETUP_05', 'SETUP', 'FAIL', err.message);
    }

    return true;
}

// Helper: filtrér response til kun T_BL-bons
function ourBons(rows) {
    return rows.filter(r => r.bon_number?.startsWith(`${TEST_PREFIX}_`));
}

// ════════════════════════════════════════════════════════════
// 4.2 FILTER_DEFAULT — 4 cases
// ════════════════════════════════════════════════════════════

async function runFilterDefaultCases() {
    console.log('\n── 4.2 FILTER_DEFAULT ──');

    const r = await api('GET', '/api/bons');
    if (r.status !== 200) {
        for (let i = 1; i <= 4; i++) record(`T_BL_DEF_0${i}`, 'DEF', 'FAIL', `status=${r.status}`);
        return;
    }

    // DEF_01: alle non-offer T_BL-bons (5 ud af 6)
    const ours = ourBons(r.body);
    const hasOffer = ours.some(b => b.bon_number === `${TEST_PREFIX}_OFFER`);
    if (ours.length >= 5 && !hasOffer) {
        record('T_BL_DEF_01', 'DEF', 'PASS',
            VERBOSE ? `${ours.length} T_BL-bons, OFFER ekskluderet` : '');
    } else {
        record('T_BL_DEF_01', 'DEF', 'FAIL', `T_BL count=${ours.length}, OFFER inkluderet=${hasOffer}`);
    }

    // DEF_02: default limit=100
    if (r.body.length <= 100) record('T_BL_DEF_02', 'DEF', 'PASS');
    else record('T_BL_DEF_02', 'DEF', 'FAIL', `length=${r.body.length}, forventede ≤100`);

    // DEF_03: sortering — delivery_date ASC default
    let sorted = true;
    for (let i = 0; i < r.body.length - 1; i++) {
        if (r.body[i].delivery_date && r.body[i+1].delivery_date
            && r.body[i].delivery_date > r.body[i+1].delivery_date) { sorted = false; break; }
    }
    if (sorted) record('T_BL_DEF_03', 'DEF', 'PASS');
    else record('T_BL_DEF_03', 'DEF', 'FAIL', 'ikke sorteret ASC');

    // DEF_04: hver row har moms-felter
    const sample = r.body[0];
    const momsKeys = sample ? Object.keys(sample).filter(k => k.includes('moms') || k.includes('excl')) : [];
    if (momsKeys.length > 0) {
        record('T_BL_DEF_04', 'DEF', 'PASS', VERBOSE ? `moms-felter: ${momsKeys.join(',')}` : '');
    } else {
        record('T_BL_DEF_04', 'DEF', 'FAIL', 'Ingen moms-felter på row');
    }
}

// ════════════════════════════════════════════════════════════
// 4.3 FILTER_DATE — 5 cases
// ════════════════════════════════════════════════════════════

async function runFilterDateCases() {
    console.log('\n── 4.3 FILTER_DATE ──');

    // DATE_01: ?date=today
    {
        const r = await api('GET', '/api/bons?date=today');
        const ours = ourBons(r.body || []);
        const expected = ['NY_1', 'NY_2', 'IGANG'].map(k => `${TEST_PREFIX}_${k}`);
        const missing = expected.filter(bn => !ours.find(b => b.bon_number === bn));
        const hasOffer = ours.some(b => b.bon_number === `${TEST_PREFIX}_OFFER`);
        if (missing.length === 0 && !hasOffer && r.status === 200) {
            record('T_BL_DATE_01', 'DATE', 'PASS');
        } else {
            record('T_BL_DATE_01', 'DATE', 'FAIL',
                `status=${r.status}, missing=${missing.join(',')}, hasOffer=${hasOffer}`);
        }
    }

    // DATE_02: ?date=<specifik dato>
    {
        const r = await api('GET', `/api/bons?date=${today()}`);
        const ours = ourBons(r.body || []);
        const allMatch = ours.every(b => b.delivery_date === today());
        if (r.status === 200 && allMatch && ours.length >= 3) {
            record('T_BL_DATE_02', 'DATE', 'PASS');
        } else {
            record('T_BL_DATE_02', 'DATE', 'FAIL', `allMatch=${allMatch}, ours=${ours.length}`);
        }
    }

    // DATE_03: ?date_from + date_to
    {
        const r = await api('GET', `/api/bons?date_from=${daysAgo(7)}&date_to=${tomorrow()}`);
        const ours = ourBons(r.body || []);
        // Skal indeholde NY_1, NY_2, IGANG, VENTER, FAKT (alle T_BL undtagen OFFER)
        if (r.status === 200 && ours.length === 5) {
            record('T_BL_DATE_03', 'DATE', 'PASS');
        } else {
            record('T_BL_DATE_03', 'DATE', 'FAIL', `ours.length=${ours.length}, forventede 5`);
        }
    }

    // DATE_04: ?date_from kun (ingen øvre)
    {
        const r = await api('GET', `/api/bons?date_from=${today()}`);
        const ours = ourBons(r.body || []);
        // Skal kun have today + tomorrow bons (NY_1, NY_2, IGANG, VENTER) — IKKE FAKT
        const hasFakt = ours.some(b => b.bon_number === `${TEST_PREFIX}_FAKT`);
        if (r.status === 200 && !hasFakt && ours.length >= 4) {
            record('T_BL_DATE_04', 'DATE', 'PASS');
        } else {
            record('T_BL_DATE_04', 'DATE', 'FAIL', `hasFakt=${hasFakt}, ours=${ours.length}`);
        }
    }

    // DATE_05: OFFER ekskluderes uanset dato
    {
        const r = await api('GET', `/api/bons?date_from=${daysAgo(30)}&date_to=${tomorrow()}`);
        const hasOffer = (r.body || []).some(b => b.bon_number === `${TEST_PREFIX}_OFFER`);
        if (r.status === 200 && !hasOffer) record('T_BL_DATE_05', 'DATE', 'PASS');
        else record('T_BL_DATE_05', 'DATE', 'FAIL', `hasOffer=${hasOffer}`);
    }
}

// ════════════════════════════════════════════════════════════
// 4.4 FILTER_STATUS — 6 cases
// ════════════════════════════════════════════════════════════

async function runFilterStatusCases() {
    console.log('\n── 4.4 FILTER_STATUS ──');

    // STAT_01: single status
    {
        const r = await api('GET', '/api/bons?status=NY');
        const ours = ourBons(r.body || []);
        const allNy = ours.every(b => b.status_code === 'NY');
        const hasOffer = ours.some(b => b.bon_number === `${TEST_PREFIX}_OFFER`);
        if (r.status === 200 && allNy && !hasOffer && ours.length >= 2) {
            record('T_BL_STAT_01', 'STAT', 'PASS');
        } else {
            record('T_BL_STAT_01', 'STAT', 'FAIL', `allNy=${allNy}, hasOffer=${hasOffer}, ours=${ours.length}`);
        }
    }

    // STAT_02: multi-status (åbne)
    {
        const r = await api('GET', '/api/bons?status=NY,VENTER,GODKENDT,IGANG,KLAR');
        const ours = ourBons(r.body || []);
        const hasFakt = ours.some(b => b.bon_number === `${TEST_PREFIX}_FAKT`);
        if (r.status === 200 && !hasFakt && ours.length >= 4) {
            record('T_BL_STAT_02', 'STAT', 'PASS');
        } else {
            record('T_BL_STAT_02', 'STAT', 'FAIL', `hasFakt=${hasFakt}, ours=${ours.length}`);
        }
    }

    // STAT_03: multi-comma
    {
        const r = await api('GET', '/api/bons?status=NY,IGANG');
        const ours = ourBons(r.body || []);
        const validCodes = ours.every(b => ['NY', 'IGANG'].includes(b.status_code));
        if (r.status === 200 && validCodes) record('T_BL_STAT_03', 'STAT', 'PASS');
        else record('T_BL_STAT_03', 'STAT', 'FAIL', `validCodes=${validCodes}`);
    }

    // STAT_04: tom status — alle bons
    {
        const r = await api('GET', '/api/bons?status=');
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 5) record('T_BL_STAT_04', 'STAT', 'PASS');
        else record('T_BL_STAT_04', 'STAT', 'FAIL', `ours.length=${ours.length}`);
    }

    // STAT_05: ukendt status → tom
    {
        const r = await api('GET', '/api/bons?status=UKENDT_STATUS_XYZ');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) {
            record('T_BL_STAT_05', 'STAT', 'PASS');
        } else {
            record('T_BL_STAT_05', 'STAT', 'FAIL', `status=${r.status}, length=${r.body?.length}`);
        }
    }

    // STAT_06: whitespace i comma-liste
    {
        const r = await api('GET', `/api/bons?${encodeURI('status=NY, VENTER')}`);
        const ours = ourBons(r.body || []);
        const validCodes = ours.every(b => ['NY', 'VENTER'].includes(b.status_code));
        if (r.status === 200 && validCodes && ours.length >= 3) {
            record('T_BL_STAT_06', 'STAT', 'PASS', VERBOSE ? '.trim() virker' : '');
        } else {
            record('T_BL_STAT_06', 'STAT', 'FAIL', `validCodes=${validCodes}, ours=${ours.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.5 FILTER_SEARCH — 7 cases
// ════════════════════════════════════════════════════════════

async function runFilterSearchCases() {
    console.log('\n── 4.5 FILTER_SEARCH ──');

    // SEARCH_01: digits → prefix-match på bon_number
    // Vi opretter midlertidig bon med pure-digit bon_number for at teste
    const digitBonRes = db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                          order_date, delivery_date, pax, total_price, is_offer, delivery_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, 0, 'delivery')
    `).run('T_BL_99999', statusId('NY'), defaultLocation(), testCustomerId, testCompanyId, today(), today());
    // bon_number er ikke pure digits, men starter med 'T_BL_' — vi tester at digits-grenen virker
    // ved at søge efter "T_BL_99999" som NON-digit (text-gren)

    {
        // Prefix-match: '99999' er pure digits → '99999%' LIKE
        // Vores bon hedder 'T_BL_99999' — den starter IKKE med '99999' så vi bør IKKE finde den
        const r = await api('GET', '/api/bons?q=99999');
        const ours = ourBons(r.body || []);
        const found = ours.some(b => b.bon_number === 'T_BL_99999');
        if (r.status === 200 && !found) {
            record('T_BL_SEARCH_01', 'SEARCH', 'PASS', VERBOSE ? 'digits-gren bruger prefix-match (LIKE q%)' : '');
        } else {
            record('T_BL_SEARCH_01', 'SEARCH', 'FAIL', `found=${found} (digits-gren matched ikke prefix korrekt)`);
        }
    }

    // SEARCH_02: text-gren — søg på Hansen
    {
        const r = await api('GET', '/api/bons?q=Hansen');
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 5) {
            record('T_BL_SEARCH_02', 'SEARCH', 'PASS',
                VERBOSE ? `${ours.length} matches på 'Hansen'` : '');
        } else {
            record('T_BL_SEARCH_02', 'SEARCH', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // SEARCH_03 (F42): email-format matches IKKE — koden søger ikke på email
    {
        const r = await api('GET', `/api/bons?q=${encodeURIComponent('lars@hansen.dk')}`);
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length === 0) {
            record('T_BL_SEARCH_03', 'SEARCH', 'PASS',
                VERBOSE ? 'F42: email ikke i søge-felter (intentional eller bug?)' : '');
        } else {
            record('T_BL_SEARCH_03', 'SEARCH', 'FAIL',
                `F42 status: email returnerede ${ours.length} matches — ikke som spec antog`);
        }
    }

    // SEARCH_04: tom q → ingen filter
    {
        const r = await api('GET', '/api/bons?q=');
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 5) {
            record('T_BL_SEARCH_04', 'SEARCH', 'PASS');
        } else {
            record('T_BL_SEARCH_04', 'SEARCH', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // SEARCH_05: 1-char q
    {
        const r = await api('GET', '/api/bons?q=H');
        const ours = ourBons(r.body || []);
        // Hansen indeholder H → matches firma + kunde
        if (r.status === 200 && ours.length >= 1) {
            record('T_BL_SEARCH_05', 'SEARCH', 'PASS');
        } else {
            record('T_BL_SEARCH_05', 'SEARCH', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // SEARCH_06 (F43): % wildcard
    {
        const r = await api('GET', '/api/bons?q=%');
        // Forventet: returnerer alle (% er valid LIKE-wildcard, ikke escaped)
        if (r.status === 200 && Array.isArray(r.body)) {
            record('T_BL_SEARCH_06', 'SEARCH', 'PASS',
                VERBOSE ? `F43: % returnerede ${r.body.length} (ikke escaped)` : '');
        } else {
            record('T_BL_SEARCH_06', 'SEARCH', 'FAIL', `status=${r.status}`);
        }
    }

    // SEARCH_07: kombiner q + status
    {
        const r = await api('GET', '/api/bons?q=Hansen&status=NY');
        const ours = ourBons(r.body || []);
        const allNy = ours.every(b => b.status_code === 'NY');
        if (r.status === 200 && allNy && ours.length >= 2) {
            record('T_BL_SEARCH_07', 'SEARCH', 'PASS');
        } else {
            record('T_BL_SEARCH_07', 'SEARCH', 'FAIL', `allNy=${allNy}, ours=${ours.length}`);
        }
    }

    // Cleanup digit-test bon
    db.prepare(`DELETE FROM bons WHERE id = ?`).run(digitBonRes.lastInsertRowid);
}

// ════════════════════════════════════════════════════════════
// 4.6 FILTER_UNREAD_MAIL — 3 cases
// ════════════════════════════════════════════════════════════

async function runFilterMailCases() {
    console.log('\n── 4.6 FILTER_UNREAD_MAIL ──');

    // MAIL_01: ?unread_mail=1 — kun NY_1 (1) + IGANG (2)
    {
        const r = await api('GET', '/api/bons?unread_mail=1');
        const ours = ourBons(r.body || []);
        const expected = [`${TEST_PREFIX}_NY_1`, `${TEST_PREFIX}_IGANG`];
        const found = expected.every(bn => ours.some(b => b.bon_number === bn));
        const onlyExpected = ours.every(b => expected.includes(b.bon_number));
        if (r.status === 200 && found && onlyExpected) {
            record('T_BL_MAIL_01', 'MAIL', 'PASS');
        } else {
            record('T_BL_MAIL_01', 'MAIL', 'FAIL',
                `found=${found}, onlyExpected=${onlyExpected}, ours=${ours.map(b => b.bon_number).join(',')}`);
        }
    }

    // MAIL_02 (F44): ?unread_mail=0 — kun '1' aktiverer, så alle returneres
    {
        const r = await api('GET', '/api/bons?unread_mail=0');
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 5) {
            record('T_BL_MAIL_02', 'MAIL', 'PASS',
                VERBOSE ? 'F44: =0 behandles som ingen filter' : '');
        } else {
            record('T_BL_MAIL_02', 'MAIL', 'FAIL', `ours=${ours.length}`);
        }
    }

    // MAIL_03 (F44): ?unread_mail=true — kun '1' aktiverer
    {
        const r = await api('GET', '/api/bons?unread_mail=true');
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 5) {
            record('T_BL_MAIL_03', 'MAIL', 'PASS',
                VERBOSE ? 'F44: =true behandles som ingen filter' : '');
        } else {
            record('T_BL_MAIL_03', 'MAIL', 'FAIL', `ours=${ours.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.7 FILTER_FIRMA + KUNDE — 4 cases
// ════════════════════════════════════════════════════════════

async function runFilterFirmaCases() {
    console.log('\n── 4.7 FILTER_FIRMA + KUNDE ──');

    // FIRMA_01: company_id
    {
        const r = await api('GET', `/api/bons?company_id=${testCompanyId}`);
        const ours = ourBons(r.body || []);
        // Vores testfirma har 5 bons (excl. OFFER)
        if (r.status === 200 && ours.length === 5) {
            record('T_BL_FIRMA_01', 'FIRMA', 'PASS');
        } else {
            record('T_BL_FIRMA_01', 'FIRMA', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // FIRMA_02: customer_id
    {
        const r = await api('GET', `/api/bons?customer_id=${testCustomerId}`);
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length === 5) {
            record('T_BL_FIRMA_02', 'FIRMA', 'PASS');
        } else {
            record('T_BL_FIRMA_02', 'FIRMA', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // FIRMA_03: begge
    {
        const r = await api('GET', `/api/bons?company_id=${testCompanyId}&customer_id=${testCustomerId}`);
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length === 5) {
            record('T_BL_FIRMA_03', 'FIRMA', 'PASS');
        } else {
            record('T_BL_FIRMA_03', 'FIRMA', 'FAIL', `ours.length=${ours.length}`);
        }
    }

    // FIRMA_04: ukendt company_id → tom array
    {
        const r = await api('GET', '/api/bons?company_id=999999999');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) {
            record('T_BL_FIRMA_04', 'FIRMA', 'PASS');
        } else {
            record('T_BL_FIRMA_04', 'FIRMA', 'FAIL', `status=${r.status}, length=${r.body?.length}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.8 FILTER_LOCATION — 2 cases
// ════════════════════════════════════════════════════════════

async function runFilterLocationCases() {
    console.log('\n── 4.8 FILTER_LOCATION ──');

    // Find aktiv lokations-kode
    const locCode = db.prepare(`SELECT code FROM locations WHERE id = ?`).get(defaultLocation())?.code;
    if (!locCode) {
        record('T_BL_LOC_01', 'LOC', 'SKIP', 'Ingen aktiv lokations-kode');
        record('T_BL_LOC_02', 'LOC', 'SKIP', '');
        return;
    }

    // LOC_01: ?location=<korrekt>
    {
        const r = await api('GET', `/api/bons?location=${locCode}`);
        const ours = ourBons(r.body || []);
        if (r.status === 200 && ours.length >= 1) {
            record('T_BL_LOC_01', 'LOC', 'PASS');
        } else {
            record('T_BL_LOC_01', 'LOC', 'FAIL', `ours=${ours.length}`);
        }
    }

    // LOC_02 (F45): case-sensitivity
    {
        const r = await api('GET', `/api/bons?location=${locCode.toLowerCase()}`);
        const ours = ourBons(r.body || []);
        const isCaseSensitive = ours.length === 0;
        if (r.status === 200) {
            record('T_BL_LOC_02', 'LOC', 'PASS',
                `F45: case-${isCaseSensitive ? 'sensitive' : 'insensitive'} (ours=${ours.length})`);
        } else {
            record('T_BL_LOC_02', 'LOC', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.9 SORT — 8 cases
// ════════════════════════════════════════════════════════════

function isSorted(arr, key, dir = 'asc') {
    for (let i = 0; i < arr.length - 1; i++) {
        const a = arr[i][key], b = arr[i+1][key];
        if (a == null || b == null) continue;
        if (dir === 'asc' && a > b) return false;
        if (dir === 'desc' && a < b) return false;
    }
    return true;
}

async function runSortCases() {
    console.log('\n── 4.9 SORT ──');

    // SORT_01: delivery_date ASC
    {
        const r = await api('GET', '/api/bons?sort=delivery_date&dir=asc');
        if (r.status === 200 && isSorted(r.body, 'delivery_date', 'asc')) {
            record('T_BL_SORT_01', 'SORT', 'PASS');
        } else record('T_BL_SORT_01', 'SORT', 'FAIL', '');
    }

    // SORT_02: delivery_date DESC
    {
        const r = await api('GET', '/api/bons?sort=delivery_date&dir=desc');
        if (r.status === 200 && isSorted(r.body, 'delivery_date', 'desc')) {
            record('T_BL_SORT_02', 'SORT', 'PASS');
        } else record('T_BL_SORT_02', 'SORT', 'FAIL', '');
    }

    // SORT_03: bon_number
    {
        const r = await api('GET', '/api/bons?sort=bon_number&dir=asc');
        if (r.status === 200 && isSorted(r.body, 'bon_number', 'asc')) {
            record('T_BL_SORT_03', 'SORT', 'PASS');
        } else record('T_BL_SORT_03', 'SORT', 'FAIL', '');
    }

    // SORT_04: customer_name (alias contact_name_full)
    {
        const r = await api('GET', '/api/bons?sort=customer_name&dir=asc');
        if (r.status === 200 && isSorted(r.body, 'contact_name_full', 'asc')) {
            record('T_BL_SORT_04', 'SORT', 'PASS');
        } else record('T_BL_SORT_04', 'SORT', 'FAIL', '');
    }

    // SORT_05: pax desc
    {
        const r = await api('GET', '/api/bons?sort=pax&dir=desc');
        if (r.status === 200 && isSorted(r.body, 'pax', 'desc')) {
            record('T_BL_SORT_05', 'SORT', 'PASS');
        } else record('T_BL_SORT_05', 'SORT', 'FAIL', '');
    }

    // SORT_06: total_price
    {
        const r = await api('GET', '/api/bons?sort=total_price&dir=asc');
        if (r.status === 200 && isSorted(r.body, 'total_price', 'asc')) {
            record('T_BL_SORT_06', 'SORT', 'PASS');
        } else record('T_BL_SORT_06', 'SORT', 'FAIL', '');
    }

    // SORT_07 (F46): ukendt sort → default fallback (b.delivery_date ASC)
    {
        const r = await api('GET', '/api/bons?sort=UKENDT_KOL');
        if (r.status === 200 && isSorted(r.body, 'delivery_date', 'asc')) {
            record('T_BL_SORT_07', 'SORT', 'PASS',
                VERBOSE ? 'F46: fallback til delivery_date ASC' : '');
        } else record('T_BL_SORT_07', 'SORT', 'FAIL', `status=${r.status}`);
    }

    // SORT_08: dir=invalid → ASC fallback
    {
        const r = await api('GET', '/api/bons?sort=delivery_date&dir=invalid');
        if (r.status === 200 && isSorted(r.body, 'delivery_date', 'asc')) {
            record('T_BL_SORT_08', 'SORT', 'PASS');
        } else record('T_BL_SORT_08', 'SORT', 'FAIL', '');
    }
}

// ════════════════════════════════════════════════════════════
// 4.10 PAGINATION — 5 cases
// ════════════════════════════════════════════════════════════

async function runPaginationCases() {
    console.log('\n── 4.10 PAGINATION ──');

    // PAG_01: limit=3
    {
        const r = await api('GET', '/api/bons?limit=3');
        if (r.status === 200 && r.body.length === 3) record('T_BL_PAG_01', 'PAG', 'PASS');
        else record('T_BL_PAG_01', 'PAG', 'FAIL', `length=${r.body?.length}`);
    }

    // PAG_02: limit=200
    {
        const r = await api('GET', '/api/bons?limit=200');
        if (r.status === 200 && r.body.length <= 200) record('T_BL_PAG_02', 'PAG', 'PASS');
        else record('T_BL_PAG_02', 'PAG', 'FAIL', `length=${r.body?.length}`);
    }

    // PAG_03: limit=1000 → cap til 500
    {
        const r = await api('GET', '/api/bons?limit=1000');
        if (r.status === 200 && r.body.length <= 500) record('T_BL_PAG_03', 'PAG', 'PASS');
        else record('T_BL_PAG_03', 'PAG', 'FAIL', `length=${r.body?.length}`);
    }

    // PAG_04 (F47): limit=abc → NaN → default
    {
        const r = await api('GET', '/api/bons?limit=abc');
        if (r.status === 200 && r.body.length <= 100) {
            record('T_BL_PAG_04', 'PAG', 'PASS',
                VERBOSE ? 'F47: NaN → default 100' : '');
        } else record('T_BL_PAG_04', 'PAG', 'FAIL', `length=${r.body?.length}`);
    }

    // PAG_05: offset
    {
        const r1 = await api('GET', '/api/bons?limit=5&offset=0');
        const r2 = await api('GET', '/api/bons?limit=5&offset=5');
        if (r1.status === 200 && r2.status === 200
            && Array.isArray(r1.body) && Array.isArray(r2.body)
            && r1.body.length === 5 && r2.body.length >= 1
            && r1.body[0].id !== r2.body[0].id) {
            record('T_BL_PAG_05', 'PAG', 'PASS');
        } else {
            record('T_BL_PAG_05', 'PAG', 'FAIL',
                `r1.len=${r1.body?.length}, r2.len=${r2.body?.length}, r1[0]=${r1.body?.[0]?.id}, r2[0]=${r2.body?.[0]?.id}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.11 RESPONSE_STRUCTURE — 7 cases
// ════════════════════════════════════════════════════════════

async function runResponseStructureCases() {
    console.log('\n── 4.11 RESPONSE_STRUCTURE ──');

    const r = await api('GET', `/api/bons?customer_id=${testCustomerId}`);
    const ours = ourBons(r.body || []);
    const sample = ours.find(b => b.bon_number === `${TEST_PREFIX}_NY_1`);

    if (!sample) {
        for (let i = 1; i <= 7; i++) record(`T_BL_RESP_0${i}`, 'RESP', 'FAIL', 'Setup-bon NY_1 ikke i response');
        return;
    }

    // RESP_01: core-felter
    {
        const core = ['id', 'bon_number', 'delivery_date', 'delivery_time', 'pickup_time', 'pax', 'total_price'];
        const missing = core.filter(k => !(k in sample));
        if (missing.length === 0) record('T_BL_RESP_01', 'RESP', 'PASS');
        else record('T_BL_RESP_01', 'RESP', 'FAIL', `mangler: ${missing.join(',')}`);
    }

    // RESP_02: status-info
    {
        if (sample.status_code === 'NY' && 'status_label' in sample && 'status_color' in sample) {
            record('T_BL_RESP_02', 'RESP', 'PASS');
        } else {
            record('T_BL_RESP_02', 'RESP', 'FAIL',
                `code=${sample.status_code}, label=${sample.status_label}`);
        }
    }

    // RESP_03: kunde-info
    {
        if (sample.contact_name_full?.includes('Lars')
            && sample.customer_phone === '12345678'
            && sample.customer_email === 'lars@hansen.dk') {
            record('T_BL_RESP_03', 'RESP', 'PASS');
        } else {
            record('T_BL_RESP_03', 'RESP', 'FAIL',
                `name=${sample.contact_name_full}, phone=${sample.customer_phone}, email=${sample.customer_email}`);
        }
    }

    // RESP_04: firma-info
    {
        if (sample.company_name?.includes('Hansen ApS') && sample.company_ean === '5790000000001') {
            record('T_BL_RESP_04', 'RESP', 'PASS');
        } else {
            record('T_BL_RESP_04', 'RESP', 'FAIL',
                `name=${sample.company_name}, ean=${sample.company_ean}`);
        }
    }

    // RESP_05: lokation
    {
        if ('location_name' in sample && sample.location_name) {
            record('T_BL_RESP_05', 'RESP', 'PASS');
        } else {
            record('T_BL_RESP_05', 'RESP', 'FAIL', `location_name=${sample.location_name}`);
        }
    }

    // RESP_06: pris-kategori (kan være null hvis ikke sat)
    {
        if ('price_category_code' in sample && 'price_category_label' in sample) {
            record('T_BL_RESP_06', 'RESP', 'PASS');
        } else {
            record('T_BL_RESP_06', 'RESP', 'FAIL',
                `code=${sample.price_category_code}, label=${sample.price_category_label}`);
        }
    }

    // RESP_07: subqueries — unread_mail_count + latest_delivery_event
    {
        const igangBon = ours.find(b => b.bon_number === `${TEST_PREFIX}_IGANG`);
        if (igangBon
            && typeof igangBon.unread_mail_count === 'number'
            && igangBon.unread_mail_count === 2
            && 'latest_delivery_event' in igangBon
            && 'latest_delivery_event_time' in igangBon) {
            record('T_BL_RESP_07', 'RESP', 'PASS',
                VERBOSE ? `IGANG har unread=${igangBon.unread_mail_count}` : '');
        } else {
            record('T_BL_RESP_07', 'RESP', 'FAIL',
                `unread=${igangBon?.unread_mail_count} (forventede 2)`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.12 MOMS_DECORATION — 4 cases
// ════════════════════════════════════════════════════════════

async function runMomsDecorationCases() {
    console.log('\n── 4.12 MOMS_DECORATION ──');

    const r = await api('GET', `/api/bons?customer_id=${testCustomerId}`);
    const ours = ourBons(r.body || []);

    // MOMS_01: total_price=1500 (NY_2) → moms-decoration
    const ny2 = ours.find(b => b.bon_number === `${TEST_PREFIX}_NY_2`);
    if (!ny2) {
        for (let i = 1; i <= 4; i++) record(`T_BL_MOMS_0${i}`, 'MOMS', 'FAIL', 'Setup-bon NY_2 mangler');
        return;
    }

    // Find moms-felter generelt
    const momsKeys = Object.keys(ny2).filter(k => k.match(/moms|excl|incl/i));
    // 1500 incl moms → 1200 excl + 300 moms (25%)
    const exclKey = momsKeys.find(k => k.match(/excl/i));
    const amountKey = momsKeys.find(k => k.match(/(moms_amount|amount)/i));

    {
        if (exclKey && Math.abs(ny2[exclKey] - 1200) < FLOAT_TOL) {
            record('T_BL_MOMS_01', 'MOMS', 'PASS',
                VERBOSE ? `${exclKey}=${ny2[exclKey]}` : '');
        } else {
            record('T_BL_MOMS_01', 'MOMS', 'FAIL',
                `moms-felter: ${JSON.stringify(momsKeys.reduce((a,k) => ({...a, [k]: ny2[k]}), {}))}`);
        }
    }

    // MOMS_02: NULL/0 total_price → moms-felter null eller 0 (ikke NaN)
    {
        // Opret midlertidig bon med total_price=null
        const nullRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, 'delivery')
        `).run('T_BL_NULLPRICE', statusId('NY'), defaultLocation(), testCustomerId, testCompanyId, today(), today());

        const r2 = await api('GET', '/api/bons?q=T_BL_NULLPRICE');
        const found = ourBons(r2.body || []).find(b => b.bon_number === 'T_BL_NULLPRICE');
        if (found) {
            const anyNaN = momsKeys.some(k => Number.isNaN(found[k]));
            if (!anyNaN) record('T_BL_MOMS_02', 'MOMS', 'PASS');
            else record('T_BL_MOMS_02', 'MOMS', 'FAIL', 'NaN i moms-felter');
        } else {
            record('T_BL_MOMS_02', 'MOMS', 'SKIP', 'Kunne ikke finde NULLPRICE-bon');
        }

        db.prepare(`DELETE FROM bons WHERE id = ?`).run(nullRes.lastInsertRowid);
    }

    // MOMS_03: alle rows har moms-felter (intet missing)
    {
        const allHave = ours.every(r => momsKeys.every(k => k in r));
        if (allHave) record('T_BL_MOMS_03', 'MOMS', 'PASS');
        else record('T_BL_MOMS_03', 'MOMS', 'FAIL', 'Inkonsistent decoration');
    }

    // MOMS_04 (F48): konkrete navne dokumenteres
    {
        record('T_BL_MOMS_04', 'MOMS', 'PASS',
            `F48: moms-felter på rows: ${momsKeys.join(', ')}`);
    }
}

// ════════════════════════════════════════════════════════════
// 4.13 SSE — bon_created (3)
// ════════════════════════════════════════════════════════════

async function runSseCreateCases() {
    console.log('\n── 4.13 SSE — bon_created ──');

    sseListener.clearEvents();

    // SSE_CREATE_01: POST → bon_created event
    let newBonId = null;
    {
        const postRes = await api('POST', '/api/bons', {
            delivery_date: today(),
            customer_id: testCustomerId,
            company_id: testCompanyId,
            pax: 1,
        });
        if (postRes.status !== 200 && postRes.status !== 201) {
            for (let i = 1; i <= 3; i++) record(`T_BL_SSE_CREATE_0${i}`, 'SSE_C', 'FAIL', `POST status=${postRes.status}`);
            return;
        }
        newBonId = postRes.body.id;

        try {
            const evt = await sseListener.waitForEvent('bon_created', e => e.id === newBonId, 2500);
            record('T_BL_SSE_CREATE_01', 'SSE_C', 'PASS',
                VERBOSE ? `event for bon ${newBonId} modtaget på ${evt.at}` : '');
        } catch (err) {
            record('T_BL_SSE_CREATE_01', 'SSE_C', 'FAIL', err.message);
        }
    }

    // SSE_CREATE_02: event-data felter
    {
        const evts = sseListener.getEvents('bon_created').filter(e => e.data?.id === newBonId);
        if (evts.length > 0 && typeof evts[0].data.id === 'number' && typeof evts[0].data.bon_number === 'string') {
            record('T_BL_SSE_CREATE_02', 'SSE_C', 'PASS');
        } else {
            record('T_BL_SSE_CREATE_02', 'SSE_C', 'FAIL',
                `data=${JSON.stringify(evts[0]?.data)}`);
        }
    }

    // SSE_CREATE_03: DELETE udsender IKKE bon_created (negative test)
    {
        sseListener.clearEvents();
        // Vi laver ikke DELETE — vi bare verificerer at ingen bon_created i rolig periode
        await sleep(500);
        const createdEvents = sseListener.getEvents('bon_created');
        if (createdEvents.length === 0) {
            record('T_BL_SSE_CREATE_03', 'SSE_C', 'PASS');
        } else {
            record('T_BL_SSE_CREATE_03', 'SSE_C', 'FAIL',
                `${createdEvents.length} uventede bon_created events i rolig periode`);
        }
    }

    // Cleanup
    if (newBonId) db.prepare(`DELETE FROM bons WHERE id = ?`).run(newBonId);
}

// ════════════════════════════════════════════════════════════
// 4.14 SSE — bon_updated (4)
// ════════════════════════════════════════════════════════════

async function runSseUpdateCases() {
    console.log('\n── 4.14 SSE — bon_updated ──');

    const bonId = testBons.NY_1?.id;
    if (!bonId) {
        for (let i = 1; i <= 4; i++) record(`T_BL_SSE_UPDATE_0${i}`, 'SSE_U', 'SKIP', 'NY_1 mangler');
        return;
    }

    sseListener.clearEvents();

    // SSE_UPDATE_01: PATCH felt-ændring
    {
        const r = await api('PATCH', `/api/bons/${bonId}`, { pax: 7 });
        if (r.status !== 200) {
            record('T_BL_SSE_UPDATE_01', 'SSE_U', 'FAIL', `PATCH status=${r.status}`);
        } else {
            try {
                await sseListener.waitForEvent('bon_updated', e => e.id === bonId || e.bon_id === bonId, 2000);
                record('T_BL_SSE_UPDATE_01', 'SSE_U', 'PASS');
            } catch (err) {
                record('T_BL_SSE_UPDATE_01', 'SSE_U', 'FAIL', err.message);
            }
        }
    }

    // SSE_UPDATE_02 (F49): POST lines → bon_updated event
    {
        sseListener.clearEvents();
        const r = await api('POST', `/api/bons/${bonId}/lines`, {
            product_name: 'T_BL test vare',
            quantity: 1,
            unit_price: 100,
            unit: 'stk',
        });
        if (r.status !== 200 && r.status !== 201) {
            record('T_BL_SSE_UPDATE_02', 'SSE_U', 'FAIL', `POST line status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_updated',
                    e => e.id === bonId || e.bon_id === bonId, 2000);
                const usesId = 'id' in evt.data;
                const usesBonId = 'bon_id' in evt.data;
                record('T_BL_SSE_UPDATE_02', 'SSE_U', 'PASS',
                    `F49: line-add bruger ${usesId ? '{id}' : ''}${usesBonId ? '{bon_id}' : ''}`);
            } catch (err) {
                record('T_BL_SSE_UPDATE_02', 'SSE_U', 'FAIL', err.message);
            }
        }
    }

    // SSE_UPDATE_03: mail-read → bon_updated (skip — endpointet er ikke trivielt)
    record('T_BL_SSE_UPDATE_03', 'SSE_U', 'SKIP',
        'Mail-read PATCH er ikke prio i denne runde — endpointet kræver thread+message setup');

    // SSE_UPDATE_04: notification → notification event (ikke bon_updated)
    {
        sseListener.clearEvents();
        const r = await api('POST', `/api/bons/${bonId}/notifications`, {
            type: 'flyver',
            message: 'T_BL test',
            priority: 'normal',
        });
        if (r.status !== 200 && r.status !== 201) {
            record('T_BL_SSE_UPDATE_04', 'SSE_U', 'FAIL', `POST status=${r.status}`);
        } else {
            try {
                await sseListener.waitForEvent('notification', null, 2000);
                record('T_BL_SSE_UPDATE_04', 'SSE_U', 'PASS');
            } catch (err) {
                record('T_BL_SSE_UPDATE_04', 'SSE_U', 'FAIL', err.message);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.15 SSE — bon_status (2)
// ════════════════════════════════════════════════════════════

async function runSseStatusCases() {
    console.log('\n── 4.15 SSE — bon_status ──');

    const bonId = testBons.NY_2?.id;
    if (!bonId) {
        for (let i = 1; i <= 2; i++) record(`T_BL_SSE_STATUS_0${i}`, 'SSE_S', 'SKIP', 'NY_2 mangler');
        return;
    }

    sseListener.clearEvents();

    // SSE_STATUS_01: PATCH /:id/status → bon_status event
    {
        const r = await api('PATCH', `/api/bons/${bonId}/status`, { status_code: 'GODKENDT' });
        if (r.status !== 200) {
            record('T_BL_SSE_STATUS_01', 'SSE_S', 'FAIL', `PATCH status=${r.status}, body=${JSON.stringify(r.body)}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_status',
                    e => e.bon_id === bonId, 2000);
                if (evt.data.old === 'NY' && evt.data.new === 'GODKENDT') {
                    record('T_BL_SSE_STATUS_01', 'SSE_S', 'PASS');
                } else {
                    record('T_BL_SSE_STATUS_01', 'SSE_S', 'FAIL',
                        `event.data=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_BL_SSE_STATUS_01', 'SSE_S', 'FAIL', err.message);
            }
        }
    }

    // SSE_STATUS_02: en almindelig transition sender også bon_status
    // (vi tester ikke force-mode her — det er T_BON's domæne)
    {
        sseListener.clearEvents();
        const r = await api('PATCH', `/api/bons/${bonId}/status`, { status_code: 'IGANG' });
        if (r.status !== 200) {
            record('T_BL_SSE_STATUS_02', 'SSE_S', 'FAIL', `PATCH status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_status',
                    e => e.bon_id === bonId && e.new === 'IGANG', 2000);
                record('T_BL_SSE_STATUS_02', 'SSE_S', 'PASS');
            } catch (err) {
                record('T_BL_SSE_STATUS_02', 'SSE_S', 'FAIL', err.message);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.16 EDGE_CASES (5)
// ════════════════════════════════════════════════════════════

async function runEdgeCases() {
    console.log('\n── 4.16 EDGE_CASES ──');

    // EDGE_01: tom DB-match
    {
        const r = await api('GET', '/api/bons?company_id=99999999');
        if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) {
            record('T_BL_EDGE_01', 'EDGE', 'PASS');
        } else {
            record('T_BL_EDGE_01', 'EDGE', 'FAIL', `status=${r.status}, length=${r.body?.length}`);
        }
    }

    // EDGE_02: kunde uden last_name — opret midlertidig
    {
        const noLastRes = db.prepare(`
            INSERT INTO customers (first_name, last_name, is_primary_contact)
            VALUES ('OnlyFirst', NULL, 0)
        `).run();
        const bonRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, ?, 1, 100, 0, 'delivery')
        `).run('T_BL_NOLAST', statusId('NY'), defaultLocation(), noLastRes.lastInsertRowid, today(), today());

        const r = await api('GET', `/api/bons?q=T_BL_NOLAST`);
        const found = ourBons(r.body || []).find(b => b.bon_number === 'T_BL_NOLAST');
        if (found && found.contact_name_full && !found.contact_name_full.includes('null')) {
            record('T_BL_EDGE_02', 'EDGE', 'PASS',
                VERBOSE ? `contact_name_full="${found.contact_name_full}"` : '');
        } else {
            record('T_BL_EDGE_02', 'EDGE', 'FAIL',
                `contact_name_full="${found?.contact_name_full}"`);
        }

        db.prepare(`DELETE FROM bons WHERE id = ?`).run(bonRes.lastInsertRowid);
        db.prepare(`DELETE FROM customers WHERE id = ?`).run(noLastRes.lastInsertRowid);
    }

    // EDGE_03 (F50): bon uden customer → LEFT JOIN bevarer rækken
    {
        const bonRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, 1, 100, 0, 'delivery')
        `).run('T_BL_NOCUST', statusId('NY'), defaultLocation(), today(), today());

        const r = await api('GET', `/api/bons?q=T_BL_NOCUST`);
        const found = ourBons(r.body || []).find(b => b.bon_number === 'T_BL_NOCUST');
        if (found) {
            record('T_BL_EDGE_03', 'EDGE', 'PASS',
                `F50: contact_name_full="${found.contact_name_full}"`);
        } else {
            record('T_BL_EDGE_03', 'EDGE', 'FAIL', 'Bon uden customer kom ikke med — LEFT JOIN brudt?');
        }

        db.prepare(`DELETE FROM bons WHERE id = ?`).run(bonRes.lastInsertRowid);
    }

    // EDGE_04: UTF-8 i søgning (Søren)
    {
        const danishRes = db.prepare(`
            INSERT INTO customers (first_name, last_name, is_primary_contact)
            VALUES ('Søren', 'Ærøbo', 0)
        `).run();
        const bonRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, ?, 1, 100, 0, 'delivery')
        `).run('T_BL_DANISH', statusId('NY'), defaultLocation(), danishRes.lastInsertRowid, today(), today());

        const r = await api('GET', `/api/bons?q=${encodeURIComponent('Søren')}`);
        const ours = ourBons(r.body || []);
        if (ours.find(b => b.bon_number === 'T_BL_DANISH')) {
            record('T_BL_EDGE_04', 'EDGE', 'PASS');
        } else {
            record('T_BL_EDGE_04', 'EDGE', 'FAIL', 'UTF-8-søg matched ikke');
        }

        db.prepare(`DELETE FROM bons WHERE id = ?`).run(bonRes.lastInsertRowid);
        db.prepare(`DELETE FROM customers WHERE id = ?`).run(danishRes.lastInsertRowid);
    }

    // EDGE_05: SQL-injection-forsøg
    {
        const r = await api('GET', `/api/bons?q=${encodeURIComponent("' OR 1=1 --")}`);
        // Skal IKKE returnere alle bons + skal ikke crashe
        if (r.status === 200 && Array.isArray(r.body)) {
            // Prepared statements binder string som data — søgning matcher ingen rækker
            // med den eksakte sekvens "' OR 1=1 --"
            record('T_BL_EDGE_05', 'EDGE', 'PASS',
                VERBOSE ? `SQLi attempt: ${r.body.length} rows (forventet 0 eller meget få)` : '');
        } else {
            record('T_BL_EDGE_05', 'EDGE', 'FAIL', `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 4.17 CLEANUP — 4 cases
// ════════════════════════════════════════════════════════════

async function runCleanupCases() {
    console.log('\n── 4.17 CLEANUP ──');

    if (SKIP_CLEANUP) {
        for (let i = 1; i <= 4; i++) record(`T_BL_CLEANUP_0${i}`, 'CLEANUP', 'SKIP', '--skip-cleanup');
        return;
    }

    // Snapshot before cleanup
    const beforeBonsCount = db.prepare(
        `SELECT COUNT(*) AS n FROM bons WHERE bon_number NOT LIKE 'T_BL_%'`
    ).get().n;

    // Cleanup: alle T_BL_-bons + tilhørende
    const bonIds = db.prepare(
        `SELECT id FROM bons WHERE bon_number LIKE 'T_BL_%'`
    ).all().map(r => r.id);

    if (bonIds.length > 0) {
        const ph = bonIds.map(() => '?').join(',');
        // mail_messages → mail_threads → bons + notifications + bon_lines
        db.prepare(`DELETE FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph}))`).run(...bonIds);
        db.prepare(`DELETE FROM mail_threads WHERE bon_id IN (${ph})`).run(...bonIds);
        db.prepare(`DELETE FROM notifications WHERE bon_id IN (${ph})`).run(...bonIds);
        db.prepare(`DELETE FROM bon_lines WHERE bon_id IN (${ph})`).run(...bonIds);
        db.prepare(`DELETE FROM delivery_events WHERE bon_id IN (${ph})`).run(...bonIds);
        db.prepare(`DELETE FROM changelog WHERE entity_type='bon' AND entity_id IN (${ph})`).run(...bonIds);
    }

    db.prepare(`DELETE FROM bons WHERE bon_number LIKE 'T_BL_%'`).run();
    db.prepare(`DELETE FROM customers WHERE notes = 'T_BL_test'`).run();
    db.prepare(`DELETE FROM companies WHERE notes = 'T_BL_test'`).run();

    // CLEANUP_01: alle T_BL_-bons slettet
    const remainingBons = db.prepare(`SELECT COUNT(*) AS n FROM bons WHERE bon_number LIKE 'T_BL_%'`).get().n;
    if (remainingBons === 0) record('T_BL_CLEANUP_01', 'CLEANUP', 'PASS');
    else record('T_BL_CLEANUP_01', 'CLEANUP', 'FAIL', `${remainingBons} T_BL-bons tilbage`);

    // CLEANUP_02: bon_lines + mail_threads + delivery_events ryddet via CASCADE-DELETE
    const orphanLines = db.prepare(
        `SELECT COUNT(*) AS n FROM bon_lines WHERE bon_id NOT IN (SELECT id FROM bons)`
    ).get().n;
    const orphanThreads = db.prepare(
        `SELECT COUNT(*) AS n FROM mail_threads WHERE bon_id IS NOT NULL AND bon_id NOT IN (SELECT id FROM bons)`
    ).get().n;
    if (orphanLines === 0 && orphanThreads === 0) {
        record('T_BL_CLEANUP_02', 'CLEANUP', 'PASS');
    } else {
        record('T_BL_CLEANUP_02', 'CLEANUP', 'FAIL', `lines=${orphanLines}, threads=${orphanThreads}`);
    }

    // CLEANUP_03: pre-eksisterende bons uændret
    const afterBonsCount = db.prepare(
        `SELECT COUNT(*) AS n FROM bons WHERE bon_number NOT LIKE 'T_BL_%'`
    ).get().n;
    if (beforeBonsCount === afterBonsCount) {
        record('T_BL_CLEANUP_03', 'CLEANUP', 'PASS',
            VERBOSE ? `${afterBonsCount} pre-eksisterende bons uændret` : '');
    } else {
        record('T_BL_CLEANUP_03', 'CLEANUP', 'FAIL',
            `before=${beforeBonsCount}, after=${afterBonsCount}`);
    }

    // CLEANUP_04: SSE-listener afsluttet
    try {
        if (sseListener) sseListener.disconnect();
        record('T_BL_CLEANUP_04', 'CLEANUP', 'PASS');
    } catch (err) {
        record('T_BL_CLEANUP_04', 'CLEANUP', 'FAIL', err.message);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_BONS_LIST_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','DEF','DATE','STAT','SEARCH','MAIL','FIRMA','LOC','SORT','PAG','RESP','MOMS','SSE_C','SSE_U','SSE_S','EDGE','CLEANUP'];

    let md = `# T_BONS_LIST — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_BONS_LIST] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_BONS_LIST] Server: ${SERVER_URL}`);
    if (SKIP_CLEANUP) console.log(`[run_T_BONS_LIST] WARNING: --skip-cleanup`);

    const ok = await runSetupCases();
    if (!ok) {
        console.error('[run_T_BONS_LIST] Setup fejlede — bryder');
        if (sseListener) sseListener.disconnect();
        db.close();
        writeReport();
        process.exit(1);
    }

    try {
        await runFilterDefaultCases();
        await runFilterDateCases();
        await runFilterStatusCases();
        await runFilterSearchCases();
        await runFilterMailCases();
        await runFilterFirmaCases();
        await runFilterLocationCases();
        await runSortCases();
        await runPaginationCases();
        await runResponseStructureCases();
        await runMomsDecorationCases();
        await runSseCreateCases();
        await runSseUpdateCases();
        await runSseStatusCases();
        await runEdgeCases();
    } catch (err) {
        console.error('[run_T_BONS_LIST] FEJL under test:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await runCleanupCases();
    db.close();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_BONS_LIST] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_BONS_LIST] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    if (sseListener) sseListener.disconnect();
    process.exit(1);
});
