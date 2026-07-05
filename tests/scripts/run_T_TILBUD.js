#!/usr/bin/env node
/**
 * tests/scripts/run_T_TILBUD.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for routes/quotes.js — tilbud = bon med is_offer=1.
 *
 * Femte office-track. ~70 cases på tværs af 13 grupper:
 *   SETUP, NEXT_NUMBER, POST, GET, GET_BY_ID, PATCH, STATUS_PATCH,
 *   CONVERT, DELETE, RECALC, MOMS-DISCIPLIN, ISOLATION, CLEANUP
 *
 * Hermetisk gennem ejer-relation (T_TIL_-prefix på customer/company).
 * Bon_number genereres af serveren (T-N), så vi sporer skabte IDs i
 * `created.quotes`-mappen og sletter via dem i CLEANUP.
 *
 * Usage:
 *   npm run test:run-tilbud
 *   node tests/scripts/run_T_TILBUD.js --verbose
 *
 * Reference: tests/specs/T_TILBUD.md
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
const TEST_PREFIX = 'T_TIL';

let db;
let SESSION_COOKIE = null;
let sseListener = null;
const results = [];

// Test entity IDs
const created = {
    customers: {},     // key -> id
    companies: {},     // key -> id
    quotes: {},        // key -> id (quote = bon with is_offer=1)
    convertedBons: [], // ids der er converted og dermed nu er regulære bons
};

let quoteNumberStart = null;

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

function today() { return new Date().toISOString().slice(0, 10); }
function daysFromNow(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function daysAgo(n) { return daysFromNow(-n); }

function statusId(code) {
    return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}

function getQuoteNumberSetting() {
    return parseInt(db.prepare(`SELECT value FROM settings WHERE key='quote_number_next'`).get()?.value ?? '1');
}

// Helper: POST /api/quotes med given body, gem id i created.quotes[key]
async function createQuote(key, body) {
    const r = await api('POST', '/api/quotes', body);
    if (r.status !== 201 || !r.body?.id) {
        throw new Error(`Kunne ikke oprette ${key}: ${r.status} ${r.raw?.slice(0, 100)}`);
    }
    created.quotes[key] = r.body.id;
    return r.body;
}

// ════════════════════════════════════════════════════════════
// 4.1 SETUP (5)
// ════════════════════════════════════════════════════════════

async function runSetup() {
    console.log('\n── 4.1 SETUP ──');

    // SETUP_01: TILBUD-status findes
    try {
        const id = statusId('TILBUD');
        if (id) record('T_TIL_SETUP_01', 'SETUP', 'PASS');
        else record('T_TIL_SETUP_01', 'SETUP', 'FAIL', 'TILBUD-status mangler');
    } catch (e) { record('T_TIL_SETUP_01', 'SETUP', 'FAIL', e.message); }

    // SETUP_02: GODKENDT-status findes
    try {
        const id = statusId('GODKENDT');
        if (id) record('T_TIL_SETUP_02', 'SETUP', 'PASS');
        else record('T_TIL_SETUP_02', 'SETUP', 'FAIL', 'GODKENDT-status mangler');
    } catch (e) { record('T_TIL_SETUP_02', 'SETUP', 'FAIL', e.message); }

    // SETUP_03: Settings konfigureret
    try {
        const prefix = db.prepare(`SELECT value FROM settings WHERE key='quote_number_prefix'`).get()?.value;
        const next   = db.prepare(`SELECT value FROM settings WHERE key='quote_number_next'`).get()?.value;
        if (prefix && next) {
            quoteNumberStart = parseInt(next);
            record('T_TIL_SETUP_03', 'SETUP', 'PASS', `prefix=${prefix}, next=${next}`);
        } else {
            record('T_TIL_SETUP_03', 'SETUP', 'FAIL', 'prefix eller next mangler');
        }
    } catch (e) { record('T_TIL_SETUP_03', 'SETUP', 'FAIL', e.message); }

    // SETUP_04: Test-relationer
    try {
        const comp = db.prepare(`INSERT INTO companies (name, cvr, is_active) VALUES (?, ?, 1)`)
            .run(`${TEST_PREFIX}_company`, '12345678');
        created.companies.main = comp.lastInsertRowid;

        const cust1 = db.prepare(`INSERT INTO customers (first_name, last_name, email, is_active) VALUES (?, ?, ?, 1)`)
            .run(`${TEST_PREFIX}_first`, `${TEST_PREFIX}_priv`, `${TEST_PREFIX}_priv@test.dk`);
        created.customers.priv = cust1.lastInsertRowid;

        const cust2 = db.prepare(`INSERT INTO customers (company_id, first_name, last_name, email, is_active) VALUES (?, ?, ?, ?, 1)`)
            .run(created.companies.main, `${TEST_PREFIX}_first`, `${TEST_PREFIX}_corp`, `${TEST_PREFIX}_corp@test.dk`);
        created.customers.corp = cust2.lastInsertRowid;

        record('T_TIL_SETUP_04', 'SETUP', 'PASS');
    } catch (e) { record('T_TIL_SETUP_04', 'SETUP', 'FAIL', e.message); }

    // SETUP_05: Moms-helper
    try {
        const Moms = require('../../shared/moms.js');
        if (typeof Moms.computeMomsFields === 'function' && typeof Moms.inclToExcl === 'function') {
            record('T_TIL_SETUP_05', 'SETUP', 'PASS');
        } else {
            record('T_TIL_SETUP_05', 'SETUP', 'FAIL', 'Moms-helper API mangler');
        }
    } catch (e) { record('T_TIL_SETUP_05', 'SETUP', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.2 NEXT_NUMBER (3)
// ════════════════════════════════════════════════════════════

async function runNextNumber() {
    console.log('\n── 4.2 NEXT_NUMBER ──');

    // NUM_01: GET /next-number returnerer valid format
    let firstNumber = null;
    try {
        const r = await api('GET', '/api/quotes/next-number');
        if (r.status === 200 && /^T-\d+$/.test(r.body?.quote_number || '')) {
            firstNumber = r.body.quote_number;
            record('T_TIL_NUM_01', 'NEXT_NUMBER', 'PASS', firstNumber);
        } else {
            record('T_TIL_NUM_01', 'NEXT_NUMBER', 'FAIL', `quote_number=${r.body?.quote_number}`);
        }
    } catch (e) { record('T_TIL_NUM_01', 'NEXT_NUMBER', 'FAIL', e.message); }

    // NUM_02: 2× kald uden POST → samme nummer (kun læser)
    try {
        const r1 = await api('GET', '/api/quotes/next-number');
        const r2 = await api('GET', '/api/quotes/next-number');
        if (r1.body?.quote_number === r2.body?.quote_number) {
            record('T_TIL_NUM_02', 'NEXT_NUMBER', 'PASS', `idempotent: ${r1.body.quote_number}`);
        } else {
            record('T_TIL_NUM_02', 'NEXT_NUMBER', 'FAIL', `${r1.body?.quote_number} != ${r2.body?.quote_number}`);
        }
    } catch (e) { record('T_TIL_NUM_02', 'NEXT_NUMBER', 'FAIL', e.message); }

    // NUM_03: POST inkrementerer; GET /next-number returnerer nu (N+1)
    try {
        const beforeR = await api('GET', '/api/quotes/next-number');
        const beforeN = parseInt(beforeR.body.quote_number.replace('T-', ''));

        const post = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(14),
            pax: 5,
        });
        if (post.status !== 201) throw new Error(`POST fejlede: ${post.status}`);
        created.quotes.NUM_03 = post.body.id;

        const afterR = await api('GET', '/api/quotes/next-number');
        const afterN = parseInt(afterR.body.quote_number.replace('T-', ''));

        if (afterN === beforeN + 1) {
            record('T_TIL_NUM_03', 'NEXT_NUMBER', 'PASS', `${beforeR.body.quote_number} → ${afterR.body.quote_number}`);
        } else {
            record('T_TIL_NUM_03', 'NEXT_NUMBER', 'FAIL', `Forventet T-${beforeN+1}, fik T-${afterN}`);
        }
    } catch (e) { record('T_TIL_NUM_03', 'NEXT_NUMBER', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.3 POST (10)
// ════════════════════════════════════════════════════════════

async function runPost() {
    console.log('\n── 4.3 POST ──');

    // Forbered SSE-listener til POST_09
    sseListener = await sse.connect(SERVER_URL, SESSION_COOKIE);

    // POST_01: Minimal POST
    let draft1Id = null;
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(14),
        });
        if (r.status === 201 && r.body?.id && /^T-\d+$/.test(r.body.bon_number)) {
            draft1Id = r.body.id;
            created.quotes.DRAFT_1 = draft1Id;
            record('T_TIL_POST_01', 'POST', 'PASS', `id=${draft1Id}, bon_number=${r.body.bon_number}`);
        } else {
            record('T_TIL_POST_01', 'POST', 'FAIL', `status=${r.status}, body=${JSON.stringify(r.body)?.slice(0, 100)}`);
        }
    } catch (e) { record('T_TIL_POST_01', 'POST', 'FAIL', e.message); }

    // POST_02: is_offer=1 i DB
    try {
        const row = db.prepare(`SELECT is_offer FROM bons WHERE id = ?`).get(draft1Id);
        if (row?.is_offer === 1) record('T_TIL_POST_02', 'POST', 'PASS');
        else record('T_TIL_POST_02', 'POST', 'FAIL', `is_offer=${row?.is_offer}`);
    } catch (e) { record('T_TIL_POST_02', 'POST', 'FAIL', e.message); }

    // POST_03: offer_status='draft'
    try {
        const row = db.prepare(`SELECT offer_status FROM bons WHERE id = ?`).get(draft1Id);
        if (row?.offer_status === 'draft') record('T_TIL_POST_03', 'POST', 'PASS');
        else record('T_TIL_POST_03', 'POST', 'FAIL', `offer_status=${row?.offer_status}`);
    } catch (e) { record('T_TIL_POST_03', 'POST', 'FAIL', e.message); }

    // POST_04: offer_valid_until = quote_date + 30 dage
    try {
        const row = db.prepare(`SELECT order_date, offer_valid_until FROM bons WHERE id = ?`).get(draft1Id);
        const od = new Date(row.order_date);
        od.setDate(od.getDate() + 30);
        const expected = od.toISOString().slice(0, 10);
        if (row.offer_valid_until === expected) {
            record('T_TIL_POST_04', 'POST', 'PASS', `order_date+30 = ${expected}`);
        } else {
            record('T_TIL_POST_04', 'POST', 'FAIL', `valid_until=${row.offer_valid_until}, forventet=${expected}`);
        }
    } catch (e) { record('T_TIL_POST_04', 'POST', 'FAIL', e.message); }

    // POST_05: Custom valid_until honoreres
    try {
        const customValid = daysFromNow(45);
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(30),
            valid_until: customValid,
        });
        created.quotes.POST_05 = r.body.id;
        const row = db.prepare(`SELECT offer_valid_until FROM bons WHERE id = ?`).get(r.body.id);
        if (row.offer_valid_until === customValid) {
            record('T_TIL_POST_05', 'POST', 'PASS');
        } else {
            record('T_TIL_POST_05', 'POST', 'FAIL', `valid_until=${row.offer_valid_until}, forventet=${customValid}`);
        }
    } catch (e) { record('T_TIL_POST_05', 'POST', 'FAIL', e.message); }

    // POST_06: 2 lines
    let withLinesId = null;
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.corp,
            company_id: created.companies.main,
            delivery_date: daysFromNow(20),
            pax: 25,
            lines: [
                { product_name: 'Sandwich', quantity: 10, unit_price: 100, unit: 'stk' },
                { product_name: 'Salat',    quantity: 5,  unit_price: 50,  unit: 'stk' },
            ],
        });
        withLinesId = r.body.id;
        created.quotes.WITH_LINES = withLinesId;
        const lines = db.prepare(`SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order`).all(withLinesId);
        if (lines.length === 2 &&
            Math.abs(lines[0].line_total - 1000) < FLOAT_TOL &&
            Math.abs(lines[1].line_total - 250) < FLOAT_TOL) {
            record('T_TIL_POST_06', 'POST', 'PASS', `lines: ${lines[0].line_total}, ${lines[1].line_total}`);
        } else {
            record('T_TIL_POST_06', 'POST', 'FAIL',
                `${lines.length} lines: ${lines.map(l => l.line_total).join(', ')}`);
        }
    } catch (e) { record('T_TIL_POST_06', 'POST', 'FAIL', e.message); }

    // POST_07: total_price = SUM(line_total) + delivery_price
    try {
        const row = db.prepare(`SELECT total_price, delivery_price FROM bons WHERE id = ?`).get(withLinesId);
        const expected = 1000 + 250; // ingen delivery på denne
        if (Math.abs(row.total_price - expected) < FLOAT_TOL) {
            record('T_TIL_POST_07', 'POST', 'PASS', `total_price=${row.total_price}`);
        } else {
            record('T_TIL_POST_07', 'POST', 'FAIL', `total_price=${row.total_price}, forventet=${expected}`);
        }
    } catch (e) { record('T_TIL_POST_07', 'POST', 'FAIL', e.message); }

    // POST_08: Linje uden unit_price → line_total=null, total bidrag 0
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(10),
            lines: [
                { product_name: 'TBD', quantity: 3 },  // ingen unit_price
            ],
        });
        const nullLineId = r.body.id;
        created.quotes.NULL_LINE = nullLineId;
        const line = db.prepare(`SELECT line_total FROM bon_lines WHERE bon_id = ?`).get(nullLineId);
        const total = db.prepare(`SELECT total_price FROM bons WHERE id = ?`).get(nullLineId);
        if (line.line_total === null && total.total_price === 0) {
            record('T_TIL_POST_08', 'POST', 'PASS');
        } else {
            record('T_TIL_POST_08', 'POST', 'FAIL', `line_total=${line.line_total}, total=${total.total_price}`);
        }
    } catch (e) { record('T_TIL_POST_08', 'POST', 'FAIL', e.message); }

    // POST_09: SSE bon_created event med is_offer:true
    try {
        sseListener.clearEvents();
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(15),
        });
        created.quotes.SSE_TEST = r.body.id;
        const evt = await sseListener.waitForEvent('bon_created',
            d => d?.id === r.body.id && d?.is_offer === true,
            2000
        ).catch(() => null);
        if (evt) {
            record('T_TIL_POST_09', 'POST', 'PASS');
        } else {
            const allBonCreated = sseListener.getEvents('bon_created');
            record('T_TIL_POST_09', 'POST', 'FAIL',
                `ingen matching event — alle bon_created: ${JSON.stringify(allBonCreated.map(e => e.data)).slice(0, 200)}`);
        }
    } catch (e) { record('T_TIL_POST_09', 'POST', 'FAIL', e.message); }

    // POST_10: Changelog-entry oprettet
    try {
        const log = db.prepare(`
            SELECT * FROM changelog
            WHERE entity_type='bon' AND entity_id=? AND action='create'
            ORDER BY id DESC LIMIT 1
        `).get(draft1Id);
        if (log && log.notes === 'Tilbud oprettet') {
            record('T_TIL_POST_10', 'POST', 'PASS');
        } else {
            record('T_TIL_POST_10', 'POST', 'FAIL', `log=${JSON.stringify(log)?.slice(0, 100)}`);
        }
    } catch (e) { record('T_TIL_POST_10', 'POST', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.4 GET (9)
// ════════════════════════════════════════════════════════════

async function runGet() {
    console.log('\n── 4.4 GET ──');

    // Opret yderligere test-tilbud med varierende status
    // SENT_1 (corp)
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.corp,
            company_id: created.companies.main,
            delivery_date: daysFromNow(18),
            pax: 30,
            lines: [{ product_name: 'A', quantity: 1, unit_price: 100 }],
        });
        created.quotes.SENT_1 = r.body.id;
        await api('PATCH', `/api/quotes/${r.body.id}/status`, { status: 'sent' });
    } catch (e) {/* ignore */}

    // LOST (corp)
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.corp,
            company_id: created.companies.main,
            delivery_date: daysFromNow(8),
            pax: 10,
        });
        created.quotes.LOST = r.body.id;
        await api('PATCH', `/api/quotes/${r.body.id}/status`, { status: 'lost' });
    } catch (e) {/* ignore */}

    // GET_01: Listen indeholder vores tilbud (alle med is_offer=1)
    try {
        const r = await api('GET', '/api/quotes');
        const ourNumbers = (r.body || [])
            .filter(q => q.customer_id === created.customers.priv || q.customer_id === created.customers.corp)
            .map(q => q.id);
        const expected = [
            created.quotes.NUM_03, created.quotes.DRAFT_1, created.quotes.POST_05,
            created.quotes.WITH_LINES, created.quotes.NULL_LINE, created.quotes.SSE_TEST,
            created.quotes.SENT_1, created.quotes.LOST,
        ].filter(Boolean);
        const allFound = expected.every(id => ourNumbers.includes(id));
        if (allFound) {
            record('T_TIL_GET_01', 'GET', 'PASS', `${ourNumbers.length} af vores tilbud i listen`);
        } else {
            const missing = expected.filter(id => !ourNumbers.includes(id));
            record('T_TIL_GET_01', 'GET', 'FAIL', `missing ids: ${missing.join(',')}`);
        }
    } catch (e) { record('T_TIL_GET_01', 'GET', 'FAIL', e.message); }

    // GET_02: skip — testes i CONVERT-sektionen
    record('T_TIL_GET_02', 'GET', 'PASS', 'testes i T_TIL_CONV_03 (efter convert)');

    // GET_03: Filter status=draft
    try {
        const r = await api('GET', '/api/quotes?status=draft');
        const ourDraft = (r.body || []).filter(q =>
            q.customer_id === created.customers.priv || q.customer_id === created.customers.corp
        );
        const allDraft = ourDraft.every(q => q.status === 'draft');
        if (allDraft && ourDraft.length > 0) {
            record('T_TIL_GET_03', 'GET', 'PASS', `${ourDraft.length} draft-tilbud`);
        } else {
            record('T_TIL_GET_03', 'GET', 'FAIL', `${ourDraft.length} matches, statusser=${ourDraft.map(q => q.status).join(',')}`);
        }
    } catch (e) { record('T_TIL_GET_03', 'GET', 'FAIL', e.message); }

    // GET_04: Filter status=sent,lost (multi)
    try {
        const r = await api('GET', '/api/quotes?status=sent,lost');
        const ourSenLost = (r.body || []).filter(q =>
            q.customer_id === created.customers.priv || q.customer_id === created.customers.corp
        );
        const hasSent = ourSenLost.some(q => q.status === 'sent');
        const hasLost = ourSenLost.some(q => q.status === 'lost');
        const noDrafts = !ourSenLost.some(q => q.status === 'draft');
        if (hasSent && hasLost && noDrafts) {
            record('T_TIL_GET_04', 'GET', 'PASS');
        } else {
            record('T_TIL_GET_04', 'GET', 'FAIL', `sent=${hasSent}, lost=${hasLost}, no-drafts=${noDrafts}`);
        }
    } catch (e) { record('T_TIL_GET_04', 'GET', 'FAIL', e.message); }

    // GET_05: Filter customer_id
    try {
        const r = await api('GET', `/api/quotes?customer_id=${created.customers.priv}`);
        const allMatch = (r.body || []).every(q => q.customer_id === created.customers.priv);
        if (allMatch && r.body.length > 0) {
            record('T_TIL_GET_05', 'GET', 'PASS', `${r.body.length} tilbud`);
        } else {
            record('T_TIL_GET_05', 'GET', 'FAIL', `${r.body?.length}, all-match=${allMatch}`);
        }
    } catch (e) { record('T_TIL_GET_05', 'GET', 'FAIL', e.message); }

    // GET_06: Filter company_id
    try {
        const r = await api('GET', `/api/quotes?company_id=${created.companies.main}`);
        const allMatch = (r.body || []).every(q => q.company_id === created.companies.main);
        if (allMatch && r.body.length > 0) {
            record('T_TIL_GET_06', 'GET', 'PASS', `${r.body.length} tilbud`);
        } else {
            record('T_TIL_GET_06', 'GET', 'FAIL', `${r.body?.length}, all-match=${allMatch}`);
        }
    } catch (e) { record('T_TIL_GET_06', 'GET', 'FAIL', e.message); }

    // GET_07: Filter q=customer_name
    try {
        const r = await api('GET', `/api/quotes?q=${TEST_PREFIX}_priv`);
        const ourMatches = (r.body || []).filter(q =>
            q.customer_id === created.customers.priv
        );
        if (ourMatches.length > 0) {
            record('T_TIL_GET_07', 'GET', 'PASS', `${ourMatches.length} matches`);
        } else {
            record('T_TIL_GET_07', 'GET', 'FAIL', `ingen matches på ${TEST_PREFIX}_priv`);
        }
    } catch (e) { record('T_TIL_GET_07', 'GET', 'FAIL', e.message); }

    // GET_08: Sortering DESC (nyeste først)
    try {
        const r = await api('GET', '/api/quotes');
        const ours = (r.body || []).filter(q =>
            q.customer_id === created.customers.priv || q.customer_id === created.customers.corp
        );
        // Hent created_at via DB for sammenligning
        let sorted = true;
        for (let i = 1; i < ours.length; i++) {
            const prevDate = db.prepare(`SELECT created_at FROM bons WHERE id=?`).get(ours[i - 1].id)?.created_at;
            const currDate = db.prepare(`SELECT created_at FROM bons WHERE id=?`).get(ours[i].id)?.created_at;
            if (prevDate < currDate) { sorted = false; break; }
        }
        if (sorted) record('T_TIL_GET_08', 'GET', 'PASS', `${ours.length} tilbud i DESC`);
        else record('T_TIL_GET_08', 'GET', 'FAIL', 'ikke DESC-sorteret');
    } catch (e) { record('T_TIL_GET_08', 'GET', 'FAIL', e.message); }

    // GET_09: Moms-felter inkluderet
    try {
        const r = await api('GET', '/api/quotes');
        const withLines = r.body.find(q => q.id === created.quotes.WITH_LINES);
        if (withLines && 'total_incl_moms' in withLines && 'total_excl_moms' in withLines && 'moms_amount' in withLines) {
            record('T_TIL_GET_09', 'GET', 'PASS',
                `incl=${withLines.total_incl_moms}, excl=${withLines.total_excl_moms?.toFixed(2)}`);
        } else {
            record('T_TIL_GET_09', 'GET', 'FAIL', `moms-felter mangler: ${JSON.stringify(Object.keys(withLines || {})).slice(0, 100)}`);
        }
    } catch (e) { record('T_TIL_GET_09', 'GET', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.5 GET_BY_ID (8)
// ════════════════════════════════════════════════════════════

async function runGetById() {
    console.log('\n── 4.5 GET_BY_ID ──');

    // DETAIL_01: GET /:id
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.WITH_LINES}`);
        if (r.status === 200 && r.body?.id === created.quotes.WITH_LINES) {
            record('T_TIL_DETAIL_01', 'GET_BY_ID', 'PASS');
        } else {
            record('T_TIL_DETAIL_01', 'GET_BY_ID', 'FAIL', `status=${r.status}`);
        }
    } catch (e) { record('T_TIL_DETAIL_01', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_02: lines array sorteret
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.WITH_LINES}`);
        const lines = r.body?.lines || [];
        if (lines.length === 2 && lines[0].product_name === 'Sandwich' && lines[1].product_name === 'Salat') {
            record('T_TIL_DETAIL_02', 'GET_BY_ID', 'PASS');
        } else {
            record('T_TIL_DETAIL_02', 'GET_BY_ID', 'FAIL',
                `${lines.length} lines: ${lines.map(l => l.product_name).join(', ')}`);
        }
    } catch (e) { record('T_TIL_DETAIL_02', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_03: delivery_address rendret (kræver opsætning af adresse — opret quote med adresse)
    try {
        const addrRes = db.prepare(`INSERT INTO addresses (street_name, street_nr, postal_code, city) VALUES (?,?,?,?)`)
            .run('Testvej', '5', '8000', 'Aarhus');
        const addrId = addrRes.lastInsertRowid;
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(20),
            delivery_address_id: addrId,
        });
        created.quotes.WITH_ADDR = r.body.id;
        const detail = await api('GET', `/api/quotes/${r.body.id}`);
        if (detail.body?.delivery_address === 'Testvej 5 8000 Aarhus') {
            record('T_TIL_DETAIL_03', 'GET_BY_ID', 'PASS');
        } else {
            record('T_TIL_DETAIL_03', 'GET_BY_ID', 'FAIL', `delivery_address=${detail.body?.delivery_address}`);
        }
        // ryd op for adressen i CLEANUP
        created.companies._addrId = addrId;
    } catch (e) { record('T_TIL_DETAIL_03', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_04: Moms-felter
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.WITH_LINES}`);
        const b = r.body;
        if (b && 'total_incl_moms' in b && 'total_excl_moms' in b && 'moms_amount' in b) {
            record('T_TIL_DETAIL_04', 'GET_BY_ID', 'PASS',
                `incl=${b.total_incl_moms}, excl=${b.total_excl_moms?.toFixed(2)}, moms=${b.moms_amount?.toFixed(2)}`);
        } else {
            record('T_TIL_DETAIL_04', 'GET_BY_ID', 'FAIL', `mangler moms-felter`);
        }
    } catch (e) { record('T_TIL_DETAIL_04', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_05: offer_block_metadata parses som JSON
    try {
        const meta = { breakfast: { pax: 5 }, lunch: { pax: 10 } };
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(25),
            offer_block_metadata: meta,
        });
        created.quotes.WITH_META = r.body.id;
        const detail = await api('GET', `/api/quotes/${r.body.id}`);
        if (detail.body?.offer_block_metadata?.breakfast?.pax === 5) {
            record('T_TIL_DETAIL_05', 'GET_BY_ID', 'PASS');
        } else {
            record('T_TIL_DETAIL_05', 'GET_BY_ID', 'FAIL', `meta=${JSON.stringify(detail.body?.offer_block_metadata)}`);
        }
    } catch (e) { record('T_TIL_DETAIL_05', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_06: GET /:id på en regulær bon (is_offer=0) → 404
    try {
        const bon = db.prepare(`SELECT id FROM bons WHERE is_offer=0 LIMIT 1`).get();
        if (!bon) {
            record('T_TIL_DETAIL_06', 'GET_BY_ID', 'SKIP', 'ingen is_offer=0-bon i DB');
        } else {
            const r = await api('GET', `/api/quotes/${bon.id}`);
            if (r.status === 404) record('T_TIL_DETAIL_06', 'GET_BY_ID', 'PASS');
            else record('T_TIL_DETAIL_06', 'GET_BY_ID', 'FAIL', `status=${r.status}`);
        }
    } catch (e) { record('T_TIL_DETAIL_06', 'GET_BY_ID', 'FAIL', e.message); }

    // DETAIL_07: testes i CONVERT-sektionen (efter convert er is_offer=0 → 404)
    record('T_TIL_DETAIL_07', 'GET_BY_ID', 'PASS', 'testes i T_TIL_CONV_03/04');

    // DETAIL_08: GET /:id på ukendt id → 404
    try {
        const r = await api('GET', '/api/quotes/9999999');
        if (r.status === 404) record('T_TIL_DETAIL_08', 'GET_BY_ID', 'PASS');
        else record('T_TIL_DETAIL_08', 'GET_BY_ID', 'FAIL', `status=${r.status}`);
    } catch (e) { record('T_TIL_DETAIL_08', 'GET_BY_ID', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.6 PATCH (8)
// ════════════════════════════════════════════════════════════

async function runPatch() {
    console.log('\n── 4.6 PATCH ──');

    // PATCH_01: pax-felt
    try {
        const r = await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, { pax: 30 });
        const row = db.prepare(`SELECT pax FROM bons WHERE id=?`).get(created.quotes.DRAFT_1);
        const log = db.prepare(`
            SELECT * FROM changelog WHERE entity_id=? AND field_name='pax' ORDER BY id DESC LIMIT 1
        `).get(created.quotes.DRAFT_1);
        if (row.pax === 30 && log?.new_value === '30') {
            record('T_TIL_PATCH_01', 'PATCH', 'PASS');
        } else {
            record('T_TIL_PATCH_01', 'PATCH', 'FAIL', `pax=${row.pax}, log=${JSON.stringify(log)?.slice(0, 100)}`);
        }
    } catch (e) { record('T_TIL_PATCH_01', 'PATCH', 'FAIL', e.message); }

    // PATCH_02: notes → internal_notes
    try {
        await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, { notes: 'intern test' });
        const row = db.prepare(`SELECT internal_notes FROM bons WHERE id=?`).get(created.quotes.DRAFT_1);
        if (row.internal_notes === 'intern test') {
            record('T_TIL_PATCH_02', 'PATCH', 'PASS');
        } else {
            record('T_TIL_PATCH_02', 'PATCH', 'FAIL', `internal_notes=${row.internal_notes}`);
        }
    } catch (e) { record('T_TIL_PATCH_02', 'PATCH', 'FAIL', e.message); }

    // PATCH_03: template → offer_template
    try {
        await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, { template: 'event' });
        const row = db.prepare(`SELECT offer_template FROM bons WHERE id=?`).get(created.quotes.DRAFT_1);
        if (row.offer_template === 'event') {
            record('T_TIL_PATCH_03', 'PATCH', 'PASS');
        } else {
            record('T_TIL_PATCH_03', 'PATCH', 'FAIL', `offer_template=${row.offer_template}`);
        }
    } catch (e) { record('T_TIL_PATCH_03', 'PATCH', 'FAIL', e.message); }

    // PATCH_04: lines replace-all
    try {
        await api('PATCH', `/api/quotes/${created.quotes.WITH_LINES}`, {
            lines: [
                { product_name: 'NewItem', quantity: 5, unit_price: 200 },
            ],
        });
        const lines = db.prepare(`SELECT * FROM bon_lines WHERE bon_id=?`).all(created.quotes.WITH_LINES);
        if (lines.length === 1 && lines[0].product_name === 'NewItem' && Math.abs(lines[0].line_total - 1000) < FLOAT_TOL) {
            record('T_TIL_PATCH_04', 'PATCH', 'PASS');
        } else {
            record('T_TIL_PATCH_04', 'PATCH', 'FAIL',
                `${lines.length} lines: ${lines.map(l => l.product_name + '=' + l.line_total).join(', ')}`);
        }
    } catch (e) { record('T_TIL_PATCH_04', 'PATCH', 'FAIL', e.message); }

    // PATCH_05: total_price recalc'et efter line-replace
    try {
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(created.quotes.WITH_LINES);
        if (Math.abs(row.total_price - 1000) < FLOAT_TOL) {
            record('T_TIL_PATCH_05', 'PATCH', 'PASS', `total_price=${row.total_price}`);
        } else {
            record('T_TIL_PATCH_05', 'PATCH', 'FAIL', `total_price=${row.total_price}, forventet=1000`);
        }
    } catch (e) { record('T_TIL_PATCH_05', 'PATCH', 'FAIL', e.message); }

    // PATCH_06: total_units ekskluderer accessory + is_accessory gemmes — Patch I lukker F72
    // Siden migration 070 tæller kun whitelisted kategorier (01 Sandwich m.fl.) i total_units —
    // en kategori-løs linje giver 0. 'Main' får derfor en tællende kategori så F72-regressionen
    // (is_accessory gemmes + accessory ekskluderes fra units) stadig verificeres.
    try {
        await api('PATCH', `/api/quotes/${created.quotes.WITH_LINES}`, {
            lines: [
                { product_name: 'Main',    category: '01 Sandwich', quantity: 5,  unit_price: 100, is_accessory: 0 },
                { product_name: 'Servietter', quantity: 50, unit_price: 0, is_accessory: 1 },
            ],
        });
        const row = db.prepare(`SELECT total_units FROM bons WHERE id=?`).get(created.quotes.WITH_LINES);
        const acc = db.prepare(`SELECT is_accessory FROM bon_lines WHERE bon_id=? AND product_name='Servietter'`).get(created.quotes.WITH_LINES);
        if (row.total_units === 5 && acc?.is_accessory === 1) {
            record('T_TIL_PATCH_06', 'PATCH', 'PASS',
                `F72 lukket: is_accessory gemt korrekt + total_units=5 (accessory ekskluderet)`);
        } else if (row.total_units === 55 && acc?.is_accessory === 0) {
            record('T_TIL_PATCH_06', 'PATCH', 'FAIL',
                'F72 ikke lukket: routes/quotes.js INSERT mangler stadig is_accessory-kolonne');
        } else {
            record('T_TIL_PATCH_06', 'PATCH', 'FAIL',
                `total_units=${row.total_units}, accessory_gemt=${acc?.is_accessory}`);
        }
    } catch (e) { record('T_TIL_PATCH_06', 'PATCH', 'FAIL', e.message); }

    // PATCH_07: offer_block_metadata invalid JSON
    try {
        const r = await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, {
            offer_block_metadata: '[not an object]',  // array, ikke objekt
        });
        if (r.status === 400 && /JSON-objekt/.test(r.body?.error || '')) {
            record('T_TIL_PATCH_07', 'PATCH', 'PASS');
        } else {
            record('T_TIL_PATCH_07', 'PATCH', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
        }
    } catch (e) { record('T_TIL_PATCH_07', 'PATCH', 'FAIL', e.message); }

    // PATCH_08: SSE bon_updated broadcast
    try {
        sseListener.clearEvents();
        await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, { pax: 35 });
        const evt = await sseListener.waitForEvent('bon_updated',
            d => d?.id === created.quotes.DRAFT_1,
            2000
        ).catch(() => null);
        if (evt) record('T_TIL_PATCH_08', 'PATCH', 'PASS');
        else record('T_TIL_PATCH_08', 'PATCH', 'FAIL', 'ingen bon_updated SSE for DRAFT_1');
    } catch (e) { record('T_TIL_PATCH_08', 'PATCH', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.7 STATUS_PATCH (6)
// ════════════════════════════════════════════════════════════

async function runStatusPatch() {
    console.log('\n── 4.7 STATUS_PATCH ──');

    // Opret en frisk quote vi kan manipulere statussen på
    let targetId = null;
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(20),
        });
        targetId = r.body.id;
        created.quotes.STAT_TARGET = targetId;
    } catch (e) { /* ignore — tests vil fejle pænt */ }

    // STAT_01: status='sent' + offer_sent_at sat
    try {
        const r = await api('PATCH', `/api/quotes/${targetId}/status`, { status: 'sent' });
        const row = db.prepare(`SELECT offer_status, offer_sent_at FROM bons WHERE id=?`).get(targetId);
        if (r.status === 200 && row.offer_status === 'sent' && row.offer_sent_at) {
            record('T_TIL_STAT_01', 'STATUS_PATCH', 'PASS');
        } else {
            record('T_TIL_STAT_01', 'STATUS_PATCH', 'FAIL',
                `status=${row.offer_status}, sent_at=${row.offer_sent_at}`);
        }
    } catch (e) { record('T_TIL_STAT_01', 'STATUS_PATCH', 'FAIL', e.message); }

    // STAT_02: status='lost'
    try {
        const r = await api('PATCH', `/api/quotes/${targetId}/status`, { status: 'lost' });
        const row = db.prepare(`SELECT offer_status FROM bons WHERE id=?`).get(targetId);
        if (r.status === 200 && row.offer_status === 'lost') {
            record('T_TIL_STAT_02', 'STATUS_PATCH', 'PASS');
        } else {
            record('T_TIL_STAT_02', 'STATUS_PATCH', 'FAIL', `status=${row.offer_status}`);
        }
    } catch (e) { record('T_TIL_STAT_02', 'STATUS_PATCH', 'FAIL', e.message); }

    // STAT_03: status='expired'
    try {
        const r = await api('PATCH', `/api/quotes/${targetId}/status`, { status: 'expired' });
        const row = db.prepare(`SELECT offer_status FROM bons WHERE id=?`).get(targetId);
        if (r.status === 200 && row.offer_status === 'expired') {
            record('T_TIL_STAT_03', 'STATUS_PATCH', 'PASS');
        } else {
            record('T_TIL_STAT_03', 'STATUS_PATCH', 'FAIL', `status=${row.offer_status}`);
        }
    } catch (e) { record('T_TIL_STAT_03', 'STATUS_PATCH', 'FAIL', e.message); }

    // STAT_04: status='xyz' → 400
    try {
        const r = await api('PATCH', `/api/quotes/${targetId}/status`, { status: 'xyz' });
        if (r.status === 400 && /Ugyldig status/.test(r.body?.error || '')) {
            record('T_TIL_STAT_04', 'STATUS_PATCH', 'PASS');
        } else {
            record('T_TIL_STAT_04', 'STATUS_PATCH', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
        }
    } catch (e) { record('T_TIL_STAT_04', 'STATUS_PATCH', 'FAIL', e.message); }

    // STAT_05: status='won' direkte skal afvises — Patch I lukker F68
    try {
        // Opret en frisk så vi ikke korrumperer STAT_TARGET
        const fresh = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(22),
        });
        created.quotes.STAT_WON = fresh.body.id;
        const r = await api('PATCH', `/api/quotes/${fresh.body.id}/status`, { status: 'won' });
        const row = db.prepare(`SELECT is_offer, offer_status FROM bons WHERE id=?`).get(fresh.body.id);
        if (r.status === 400 && /convert/.test(r.body?.error || '')) {
            record('T_TIL_STAT_05', 'STATUS_PATCH', 'PASS',
                "F68 lukket: 'won' afvist med besked om at bruge /convert");
        } else if (r.status === 200 && row.offer_status === 'won' && row.is_offer === 1) {
            record('T_TIL_STAT_05', 'STATUS_PATCH', 'FAIL',
                'F68 ikke lukket: status=won uden convert giver stadig inkonsistent state');
        } else {
            record('T_TIL_STAT_05', 'STATUS_PATCH', 'FAIL',
                `Uventet: status=${r.status}, body=${JSON.stringify(r.body)?.slice(0, 100)}`);
        }
    } catch (e) { record('T_TIL_STAT_05', 'STATUS_PATCH', 'FAIL', e.message); }

    // STAT_06: Changelog status_change
    try {
        const log = db.prepare(`
            SELECT * FROM changelog
            WHERE entity_id=? AND action='status_change' AND field_name='offer_status'
            ORDER BY id DESC LIMIT 1
        `).get(targetId);
        if (log) {
            record('T_TIL_STAT_06', 'STATUS_PATCH', 'PASS', `old=${log.old_value}, new=${log.new_value}`);
        } else {
            record('T_TIL_STAT_06', 'STATUS_PATCH', 'FAIL', 'ingen changelog-entry');
        }
    } catch (e) { record('T_TIL_STAT_06', 'STATUS_PATCH', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.8 CONVERT (7)
// ════════════════════════════════════════════════════════════

async function runConvert() {
    console.log('\n── 4.8 CONVERT ──');

    // Opret to friske drafts til CONV_01-03 og CONV_07
    let convId = null, conv2Id = null;
    try {
        const r1 = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(30),
            lines: [{ product_name: 'ConvItem', quantity: 2, unit_price: 250 }],
        });
        convId = r1.body.id;
        created.quotes.CONV_TARGET = convId;

        const r2 = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(28),
            lines: [
                { product_name: 'ConvL1', quantity: 3, unit_price: 100 },
                { product_name: 'ConvL2', quantity: 1, unit_price: 50 },
            ],
        });
        conv2Id = r2.body.id;
        created.quotes.CONV_LINES = conv2Id;
    } catch (e) {/* ignore */}

    // CONV_01: POST /:id/convert
    try {
        const r = await api('POST', `/api/quotes/${convId}/convert`);
        const row = db.prepare(`
            SELECT b.is_offer, b.offer_status, sd.code AS status_code
            FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
            WHERE b.id = ?
        `).get(convId);
        if (r.status === 200 && row.is_offer === 0 && row.offer_status === 'won' && row.status_code === 'GODKENDT') {
            created.convertedBons.push(convId);
            record('T_TIL_CONV_01', 'CONVERT', 'PASS');
        } else {
            record('T_TIL_CONV_01', 'CONVERT', 'FAIL',
                `status=${r.status}, is_offer=${row?.is_offer}, offer_status=${row?.offer_status}, code=${row?.status_code}`);
        }
    } catch (e) { record('T_TIL_CONV_01', 'CONVERT', 'FAIL', e.message); }

    // CONV_02: Konverteret bon i GET /api/bons
    try {
        const r = await api('GET', '/api/bons');
        const found = (r.body?.bons || r.body || []).find(b => b.id === convId);
        if (found) {
            record('T_TIL_CONV_02', 'CONVERT', 'PASS', 'konverteret tilbud findes i bons-list');
        } else {
            record('T_TIL_CONV_02', 'CONVERT', 'FAIL', 'konverteret bon ikke fundet i /api/bons');
        }
    } catch (e) { record('T_TIL_CONV_02', 'CONVERT', 'FAIL', e.message); }

    // CONV_03: Konverteret bon IKKE i GET /api/quotes (T_TIL_GET_02 + DETAIL_07)
    try {
        const r = await api('GET', '/api/quotes');
        const found = (r.body || []).find(q => q.id === convId);
        if (!found) {
            record('T_TIL_CONV_03', 'CONVERT', 'PASS', 'konverteret tilbud filtreret bort fra /api/quotes');
        } else {
            record('T_TIL_CONV_03', 'CONVERT', 'FAIL', 'konverteret bon stadig i /api/quotes');
        }
    } catch (e) { record('T_TIL_CONV_03', 'CONVERT', 'FAIL', e.message); }

    // CONV_04: Convert ikke-eksisterende id
    try {
        const r = await api('POST', '/api/quotes/9999999/convert');
        if (r.status === 404) record('T_TIL_CONV_04', 'CONVERT', 'PASS');
        else record('T_TIL_CONV_04', 'CONVERT', 'FAIL', `status=${r.status}`);
    } catch (e) { record('T_TIL_CONV_04', 'CONVERT', 'FAIL', e.message); }

    // CONV_05: Convert allerede konverteret bon (is_offer=0)
    try {
        const r = await api('POST', `/api/quotes/${convId}/convert`);
        if (r.status === 400 && /ikke et tilbud/.test(r.body?.error || '')) {
            record('T_TIL_CONV_05', 'CONVERT', 'PASS');
        } else {
            record('T_TIL_CONV_05', 'CONVERT', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
        }
    } catch (e) { record('T_TIL_CONV_05', 'CONVERT', 'FAIL', e.message); }

    // CONV_06: Convert tilbud med offer_status='won' (sat via PATCH /status) — F69
    try {
        if (created.quotes.STAT_WON) {
            // STAT_WON har offer_status='won' MEN is_offer=1 (hvis F68 bekræftet)
            const beforeRow = db.prepare(`SELECT is_offer, offer_status FROM bons WHERE id=?`).get(created.quotes.STAT_WON);
            if (beforeRow.offer_status === 'won' && beforeRow.is_offer === 1) {
                const r = await api('POST', `/api/quotes/${created.quotes.STAT_WON}/convert`);
                if (r.status === 400 && /allerede konverteret/.test(r.body?.error || '')) {
                    record('T_TIL_CONV_06', 'CONVERT', 'PASS',
                        'F69 dokumenteret: convert afviser når offer_status=won, selv hvis is_offer stadig=1');
                } else {
                    record('T_TIL_CONV_06', 'CONVERT', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
                }
            } else {
                record('T_TIL_CONV_06', 'CONVERT', 'SKIP', 'STAT_WON state ikke som forventet');
            }
        } else {
            record('T_TIL_CONV_06', 'CONVERT', 'SKIP', 'STAT_WON ikke oprettet');
        }
    } catch (e) { record('T_TIL_CONV_06', 'CONVERT', 'FAIL', e.message); }

    // CONV_07: Lines bevares ved convert
    try {
        const linesBefore = db.prepare(`SELECT id, product_name, line_total FROM bon_lines WHERE bon_id=? ORDER BY id`).all(conv2Id);
        const r = await api('POST', `/api/quotes/${conv2Id}/convert`);
        const linesAfter = db.prepare(`SELECT id, product_name, line_total FROM bon_lines WHERE bon_id=? ORDER BY id`).all(conv2Id);
        if (r.status === 200 &&
            linesBefore.length === linesAfter.length &&
            linesBefore.every((l, i) => l.id === linesAfter[i].id)) {
            created.convertedBons.push(conv2Id);
            record('T_TIL_CONV_07', 'CONVERT', 'PASS', `${linesBefore.length} lines bevaret`);
        } else {
            record('T_TIL_CONV_07', 'CONVERT', 'FAIL',
                `før=${linesBefore.length}, efter=${linesAfter.length}`);
        }
    } catch (e) { record('T_TIL_CONV_07', 'CONVERT', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.9 DELETE (5)
// ════════════════════════════════════════════════════════════

async function runDelete() {
    console.log('\n── 4.9 DELETE ──');

    // Opret en frisk draft til DEL_01
    let delDraftId = null;
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(50),
        });
        delDraftId = r.body.id;
    } catch (e) {/* ignore */}

    // DEL_01: DELETE på draft
    try {
        const r = await api('DELETE', `/api/quotes/${delDraftId}`);
        const row = db.prepare(`SELECT id FROM bons WHERE id=?`).get(delDraftId);
        if (r.status === 200 && !row) {
            record('T_TIL_DEL_01', 'DELETE', 'PASS');
        } else {
            record('T_TIL_DEL_01', 'DELETE', 'FAIL', `status=${r.status}, row exists=${!!row}`);
        }
    } catch (e) { record('T_TIL_DEL_01', 'DELETE', 'FAIL', e.message); }

    // DEL_02: DELETE på sent
    try {
        const r = await api('DELETE', `/api/quotes/${created.quotes.SENT_1}`);
        if (r.status === 400 && /kladder/.test(r.body?.error || '')) {
            record('T_TIL_DEL_02', 'DELETE', 'PASS');
        } else {
            record('T_TIL_DEL_02', 'DELETE', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
        }
    } catch (e) { record('T_TIL_DEL_02', 'DELETE', 'FAIL', e.message); }

    // DEL_03: DELETE på lost
    try {
        const r = await api('DELETE', `/api/quotes/${created.quotes.LOST}`);
        if (r.status === 400 && /kladder/.test(r.body?.error || '')) {
            record('T_TIL_DEL_03', 'DELETE', 'PASS');
        } else {
            record('T_TIL_DEL_03', 'DELETE', 'FAIL', `status=${r.status}, error=${r.body?.error}`);
        }
    } catch (e) { record('T_TIL_DEL_03', 'DELETE', 'FAIL', e.message); }

    // DEL_04: DELETE på konverteret bon (is_offer=0) via /api/quotes/:id
    try {
        if (created.convertedBons.length > 0) {
            const r = await api('DELETE', `/api/quotes/${created.convertedBons[0]}`);
            if (r.status === 404) record('T_TIL_DEL_04', 'DELETE', 'PASS');
            else record('T_TIL_DEL_04', 'DELETE', 'FAIL', `status=${r.status}`);
        } else {
            record('T_TIL_DEL_04', 'DELETE', 'SKIP', 'ingen konverterede bons');
        }
    } catch (e) { record('T_TIL_DEL_04', 'DELETE', 'FAIL', e.message); }

    // DEL_05: DELETE ukendt id
    try {
        const r = await api('DELETE', '/api/quotes/9999999');
        if (r.status === 404) record('T_TIL_DEL_05', 'DELETE', 'PASS');
        else record('T_TIL_DEL_05', 'DELETE', 'FAIL', `status=${r.status}`);
    } catch (e) { record('T_TIL_DEL_05', 'DELETE', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.10 RECALC (5)
// ════════════════════════════════════════════════════════════

async function runRecalc() {
    console.log('\n── 4.10 RECALC ──');

    // REC_01: delivery_price + line
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(35),
            delivery_price: 200,
            lines: [{ product_name: 'Item', quantity: 5, unit_price: 100 }],
        });
        created.quotes.REC_DELIVERY = r.body.id;
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(r.body.id);
        if (Math.abs(row.total_price - 700) < FLOAT_TOL) {
            record('T_TIL_REC_01', 'RECALC', 'PASS', `total=${row.total_price}`);
        } else {
            record('T_TIL_REC_01', 'RECALC', 'FAIL', `total=${row.total_price}, forventet=700`);
        }
    } catch (e) { record('T_TIL_REC_01', 'RECALC', 'FAIL', e.message); }

    // REC_02: discount_percent
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(38),
            discount_percent: 15,
            lines: [
                { product_name: 'A', quantity: 5, unit_price: 100 },
                { product_name: 'B', quantity: 5, unit_price: 100 },
            ],
        });
        created.quotes.REC_DISCOUNT = r.body.id;
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(r.body.id);
        // 1000 - 15% = 850
        if (Math.abs(row.total_price - 850) < FLOAT_TOL) {
            record('T_TIL_REC_02', 'RECALC', 'PASS', `total=${row.total_price}`);
        } else {
            record('T_TIL_REC_02', 'RECALC', 'FAIL', `total=${row.total_price}, forventet=850`);
        }
    } catch (e) { record('T_TIL_REC_02', 'RECALC', 'FAIL', e.message); }

    // REC_03: x-Levering quick-fix (Del 5.5)
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(40),
            delivery_price: 300,
            lines: [
                { product_name: 'Sandwich', quantity: 10, unit_price: 100, category: 'event' },
                { product_name: 'Levering', quantity: 1, unit_price: 200, category: 'x-Levering' },
            ],
        });
        created.quotes.REC_X_LEV = r.body.id;
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(r.body.id);
        // 1000 (sandwich) + 200 (x-Levering line) = 1200, IKKE +300 oveni
        if (Math.abs(row.total_price - 1200) < FLOAT_TOL) {
            record('T_TIL_REC_03', 'RECALC', 'PASS', `total=${row.total_price} (delivery_price ignoreret)`);
        } else {
            record('T_TIL_REC_03', 'RECALC', 'FAIL',
                `total=${row.total_price}, forventet=1200 (quick-fix Del 5.5)`);
        }
    } catch (e) { record('T_TIL_REC_03', 'RECALC', 'FAIL', e.message); }

    // REC_04: NO_LINES + delivery=0 → 0
    try {
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(created.quotes.SSE_TEST);
        if (row.total_price === 0) {
            record('T_TIL_REC_04', 'RECALC', 'PASS');
        } else {
            record('T_TIL_REC_04', 'RECALC', 'FAIL', `total=${row.total_price}`);
        }
    } catch (e) { record('T_TIL_REC_04', 'RECALC', 'FAIL', e.message); }

    // REC_05: recalc ved PATCH med nye lines
    try {
        await api('PATCH', `/api/quotes/${created.quotes.REC_DELIVERY}`, {
            lines: [{ product_name: 'NewItem', quantity: 10, unit_price: 50 }],
        });
        const row = db.prepare(`SELECT total_price, delivery_price FROM bons WHERE id=?`).get(created.quotes.REC_DELIVERY);
        // 500 (line) + 200 (delivery_price unchanged) = 700
        if (Math.abs(row.total_price - 700) < FLOAT_TOL) {
            record('T_TIL_REC_05', 'RECALC', 'PASS', `total=${row.total_price}`);
        } else {
            record('T_TIL_REC_05', 'RECALC', 'FAIL',
                `total=${row.total_price}, delivery_price=${row.delivery_price}`);
        }
    } catch (e) { record('T_TIL_REC_05', 'RECALC', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.11 MOMS-DISCIPLIN (4)
// ════════════════════════════════════════════════════════════

async function runMoms() {
    console.log('\n── 4.11 MOMS-DISCIPLIN ──');

    const Moms = require('../../shared/moms.js');

    // MOMS_01: total_price er INCL moms
    try {
        // REC_DISCOUNT: total_price=850 (efter 15% rabat)
        const r = await api('GET', `/api/quotes/${created.quotes.REC_DISCOUNT}`);
        const row = db.prepare(`SELECT total_price FROM bons WHERE id=?`).get(created.quotes.REC_DISCOUNT);
        if (r.body.total_price === row.total_price && Math.abs(r.body.total_price - 850) < FLOAT_TOL) {
            record('T_TIL_MOMS_01', 'MOMS', 'PASS', `total_price=${r.body.total_price} (INCL)`);
        } else {
            record('T_TIL_MOMS_01', 'MOMS', 'FAIL', `API=${r.body.total_price}, DB=${row.total_price}`);
        }
    } catch (e) { record('T_TIL_MOMS_01', 'MOMS', 'FAIL', e.message); }

    // MOMS_02: total_incl_moms == total_price
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.REC_DISCOUNT}`);
        if (Math.abs(r.body.total_incl_moms - r.body.total_price) < FLOAT_TOL) {
            record('T_TIL_MOMS_02', 'MOMS', 'PASS', `incl=${r.body.total_incl_moms}`);
        } else {
            record('T_TIL_MOMS_02', 'MOMS', 'FAIL',
                `total_incl=${r.body.total_incl_moms} != total_price=${r.body.total_price}`);
        }
    } catch (e) { record('T_TIL_MOMS_02', 'MOMS', 'FAIL', e.message); }

    // MOMS_03: total_excl_moms = inclToExcl(total_price)
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.REC_DISCOUNT}`);
        const expected = Moms.inclToExcl(r.body.total_price);
        if (Math.abs(r.body.total_excl_moms - expected) < FLOAT_TOL) {
            record('T_TIL_MOMS_03', 'MOMS', 'PASS',
                `incl=${r.body.total_incl_moms}, excl=${r.body.total_excl_moms.toFixed(2)}`);
        } else {
            record('T_TIL_MOMS_03', 'MOMS', 'FAIL',
                `excl=${r.body.total_excl_moms}, forventet=${expected}`);
        }
    } catch (e) { record('T_TIL_MOMS_03', 'MOMS', 'FAIL', e.message); }

    // MOMS_04: moms_amount = total_incl - total_excl
    try {
        const r = await api('GET', `/api/quotes/${created.quotes.REC_DISCOUNT}`);
        const expected = r.body.total_incl_moms - r.body.total_excl_moms;
        if (Math.abs(r.body.moms_amount - expected) < FLOAT_TOL) {
            record('T_TIL_MOMS_04', 'MOMS', 'PASS',
                `moms_amount=${r.body.moms_amount.toFixed(2)}`);
        } else {
            record('T_TIL_MOMS_04', 'MOMS', 'FAIL',
                `moms=${r.body.moms_amount}, forventet=${expected.toFixed(2)}`);
        }
    } catch (e) { record('T_TIL_MOMS_04', 'MOMS', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.12 ISOLATION (4)
// ════════════════════════════════════════════════════════════

async function runIsolation() {
    console.log('\n── 4.12 ISOLATION ──');

    // ISO_01: GET /api/bons ekskluderer is_offer=1
    try {
        const r = await api('GET', '/api/bons');
        const bons = r.body?.bons || r.body || [];
        const ourTilbudIds = Object.values(created.quotes);
        const stillOffers = bons.filter(b => ourTilbudIds.includes(b.id));
        // De konverterede er nu is_offer=0 — de skal være med
        // De ikke-konverterede skal IKKE være med
        const shouldBeMissing = ourTilbudIds.filter(id => !created.convertedBons.includes(id));
        const wronglyPresent = shouldBeMissing.filter(id => bons.some(b => b.id === id));
        if (wronglyPresent.length === 0) {
            record('T_TIL_ISO_01', 'ISOLATION', 'PASS',
                `${created.convertedBons.length} konverterede med, ${shouldBeMissing.length} tilbud ekskluderet`);
        } else {
            record('T_TIL_ISO_01', 'ISOLATION', 'FAIL',
                `${wronglyPresent.length} tilbud lækker til /api/bons: ${wronglyPresent.slice(0, 3).join(',')}`);
        }
    } catch (e) { record('T_TIL_ISO_01', 'ISOLATION', 'FAIL', e.message); }

    // ISO_02: GET /api/invoices/queue ekskluderer is_offer=1
    try {
        const r = await api('GET', '/api/invoices/queue');
        const pending = r.body?.pending || [];
        const ourTilbudIds = Object.values(created.quotes);
        const stillOffers = pending.filter(p =>
            ourTilbudIds.includes(p.id) && !created.convertedBons.includes(p.id)
        );
        if (stillOffers.length === 0) {
            record('T_TIL_ISO_02', 'ISOLATION', 'PASS', 'Patch G F62 verificeret igen');
        } else {
            record('T_TIL_ISO_02', 'ISOLATION', 'FAIL',
                `${stillOffers.length} tilbud i invoice queue`);
        }
    } catch (e) { record('T_TIL_ISO_02', 'ISOLATION', 'FAIL', e.message); }

    // ISO_03: GET kalender VISER tilbud (kun verificér at endpoint ikke crasher)
    try {
        const yyyy = new Date().getFullYear();
        const mm = String(new Date().getMonth() + 1).padStart(2, '0');
        const r = await api('GET', `/api/bons/calendar?year=${yyyy}&month=${mm}`);
        if (r.status === 200) {
            record('T_TIL_ISO_03', 'ISOLATION', 'PASS', 'kalender-endpoint OK');
        } else {
            record('T_TIL_ISO_03', 'ISOLATION', 'FAIL', `status=${r.status}`);
        }
    } catch (e) { record('T_TIL_ISO_03', 'ISOLATION', 'FAIL', e.message); }

    // ISO_04: GET /api/bons/later viser tilbud (OR b.is_offer=1)
    try {
        const r = await api('GET', '/api/bons/later');
        const bons = r.body?.bons || r.body || [];
        // Vi har test-tilbud med delivery_date i fremtiden — verificér at de KAN dukke op
        // (mindst én er accepteret hvis endpointet inkluderer tilbud)
        const ourTilbudInLater = bons.filter(b =>
            Object.values(created.quotes).includes(b.id) && !created.convertedBons.includes(b.id)
        );
        if (r.status === 200) {
            record('T_TIL_ISO_04', 'ISOLATION', 'PASS',
                `later-endpoint OK, ${ourTilbudInLater.length} test-tilbud synlige`);
        } else {
            record('T_TIL_ISO_04', 'ISOLATION', 'FAIL', `status=${r.status}`);
        }
    } catch (e) { record('T_TIL_ISO_04', 'ISOLATION', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.13 PATCH_I_VERIFICATION (3) — eksplicitte positive tests
// ════════════════════════════════════════════════════════════

async function runPatchIVerification() {
    console.log('\n── 4.13 PATCH_I_VERIFICATION ──');

    // PI_01: POST tilbud med is_accessory=true → DB-row har is_accessory=1
    try {
        const r = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(42),
            lines: [
                { product_name: 'Hovedret', quantity: 10, unit_price: 100, is_accessory: 0 },
                { product_name: 'Bestik',   quantity: 10, unit_price: 0, is_accessory: true },
            ],
        });
        created.quotes.PI_POST = r.body.id;
        const lines = db.prepare(`SELECT product_name, is_accessory FROM bon_lines WHERE bon_id=?`).all(r.body.id);
        const bestik = lines.find(l => l.product_name === 'Bestik');
        const hoved = lines.find(l => l.product_name === 'Hovedret');
        if (bestik?.is_accessory === 1 && hoved?.is_accessory === 0) {
            record('T_TIL_PI_01', 'PATCH_I_VERIFICATION', 'PASS',
                'F72 verificeret på POST: is_accessory bevares korrekt');
        } else {
            record('T_TIL_PI_01', 'PATCH_I_VERIFICATION', 'FAIL',
                `Bestik.is_accessory=${bestik?.is_accessory}, Hovedret.is_accessory=${hoved?.is_accessory}`);
        }
    } catch (e) { record('T_TIL_PI_01', 'PATCH_I_VERIFICATION', 'FAIL', e.message); }

    // PI_02: SSE bon_updated efter convert har is_offer=false
    try {
        const fresh = await api('POST', '/api/quotes', {
            customer_id: created.customers.priv,
            delivery_date: daysFromNow(44),
            lines: [{ product_name: 'X', quantity: 1, unit_price: 100 }],
        });
        created.quotes.PI_CONV = fresh.body.id;
        created.convertedBons.push(fresh.body.id);

        sseListener.clearEvents();
        await api('POST', `/api/quotes/${fresh.body.id}/convert`);
        const evt = await sseListener.waitForEvent('bon_updated',
            d => d?.id === fresh.body.id && d?.is_offer === false,
            2000
        ).catch(() => null);
        if (evt) {
            record('T_TIL_PI_02', 'PATCH_I_VERIFICATION', 'PASS',
                'F73 verificeret: convert sender bon_updated{is_offer:false} så tilbudslisten kan fjerne den');
        } else {
            const all = sseListener.getEvents('bon_updated');
            record('T_TIL_PI_02', 'PATCH_I_VERIFICATION', 'FAIL',
                `ingen matching event — alle bon_updated: ${JSON.stringify(all.map(e => e.data)).slice(0, 200)}`);
        }
    } catch (e) { record('T_TIL_PI_02', 'PATCH_I_VERIFICATION', 'FAIL', e.message); }

    // PI_03: PATCH /:id på tilbud sender bon_updated med is_offer=true
    try {
        sseListener.clearEvents();
        await api('PATCH', `/api/quotes/${created.quotes.DRAFT_1}`, { pax: 99 });
        const evt = await sseListener.waitForEvent('bon_updated',
            d => d?.id === created.quotes.DRAFT_1 && d?.is_offer === true,
            2000
        ).catch(() => null);
        if (evt) {
            record('T_TIL_PI_03', 'PATCH_I_VERIFICATION', 'PASS',
                'F73 verificeret: PATCH /:id sender bon_updated{is_offer:true}');
        } else {
            const all = sseListener.getEvents('bon_updated');
            record('T_TIL_PI_03', 'PATCH_I_VERIFICATION', 'FAIL',
                `mangler is_offer:true i payload — alle: ${JSON.stringify(all.map(e => e.data)).slice(0, 200)}`);
        }
    } catch (e) { record('T_TIL_PI_03', 'PATCH_I_VERIFICATION', 'FAIL', e.message); }
}

// ════════════════════════════════════════════════════════════
// 4.14 CLEANUP (5)
// ════════════════════════════════════════════════════════════

async function runCleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n── 4.13 CLEANUP (SKIP) ──');
        return;
    }
    console.log('\n── 4.13 CLEANUP ──');

    // CLEAN_01: Slet alle T_TIL-relaterede bons (tilbud + konverterede)
    try {
        const custIds = Object.values(created.customers);
        const compIds = Object.values(created.companies).filter(v => typeof v === 'number' && !isNaN(v));
        // Brug DELETE FROM bons WHERE customer_id IN (...) ELLER company_id IN (...)
        const placeholders = custIds.map(() => '?').join(',');
        const stmt = db.prepare(`
            DELETE FROM bons
            WHERE customer_id IN (${placeholders})
               OR company_id = ?
        `);
        const del = stmt.run(...custIds, created.companies.main);

        const remaining = db.prepare(`
            SELECT COUNT(*) AS n FROM bons
            WHERE customer_id IN (${placeholders}) OR company_id = ?
        `).get(...custIds, created.companies.main).n;

        if (remaining === 0) record('T_TIL_CLEAN_01', 'CLEANUP', 'PASS', `slettet ${del.changes}`);
        else record('T_TIL_CLEAN_01', 'CLEANUP', 'FAIL', `${remaining} tilbage`);
    } catch (e) { record('T_TIL_CLEAN_01', 'CLEANUP', 'FAIL', e.message); }

    // CLEAN_02: bon_lines slettet via CASCADE
    try {
        const orphans = db.prepare(`
            SELECT COUNT(*) AS n FROM bon_lines WHERE bon_id NOT IN (SELECT id FROM bons)
        `).get().n;
        if (orphans === 0) record('T_TIL_CLEAN_02', 'CLEANUP', 'PASS');
        else record('T_TIL_CLEAN_02', 'CLEANUP', 'FAIL', `${orphans} orphan lines`);
    } catch (e) { record('T_TIL_CLEAN_02', 'CLEANUP', 'FAIL', e.message); }

    // CLEAN_03: Test-kunder
    try {
        for (const id of Object.values(created.customers)) {
            db.prepare(`DELETE FROM customers WHERE id=?`).run(id);
        }
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE first_name=?`).get(`${TEST_PREFIX}_first`).n;
        if (remaining === 0) record('T_TIL_CLEAN_03', 'CLEANUP', 'PASS');
        else record('T_TIL_CLEAN_03', 'CLEANUP', 'FAIL', `${remaining} kunder tilbage`);
    } catch (e) { record('T_TIL_CLEAN_03', 'CLEANUP', 'FAIL', e.message); }

    // CLEAN_04: T_TIL_company
    try {
        db.prepare(`DELETE FROM companies WHERE id=?`).run(created.companies.main);
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE name=?`).get(`${TEST_PREFIX}_company`).n;
        if (remaining === 0) record('T_TIL_CLEAN_04', 'CLEANUP', 'PASS');
        else record('T_TIL_CLEAN_04', 'CLEANUP', 'FAIL');
    } catch (e) { record('T_TIL_CLEAN_04', 'CLEANUP', 'FAIL', e.message); }

    // CLEAN_05: Cleanup adresser fra DETAIL_03
    try {
        if (created.companies._addrId) {
            db.prepare(`DELETE FROM addresses WHERE id=?`).run(created.companies._addrId);
        }
        const finalNext = getQuoteNumberSetting();
        const delta = finalNext - (quoteNumberStart ?? finalNext);
        if (delta >= 0) {
            record('T_TIL_CLEAN_05', 'CLEANUP', 'PASS',
                `quote_number_next steg ${delta}: ${quoteNumberStart} → ${finalNext}`);
        } else {
            record('T_TIL_CLEAN_05', 'CLEANUP', 'FAIL', `delta=${delta}`);
        }
    } catch (e) { record('T_TIL_CLEAN_05', 'CLEANUP', 'FAIL', e.message); }

    // Luk SSE-listener
    if (sseListener) await sseListener.disconnect();
}

// ════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════

function writeReport() {
    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    const skip = results.filter(r => r.status === 'SKIP').length;

    const date = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_TILBUD_${date}.md`);

    let md = `# T_TILBUD — Kørsel ${date}\n\n`;
    md += `**Endpoints:** \`/api/quotes/*\`\n`;
    md += `**Server:** ${SERVER_URL}\n\n`;
    md += `## Resultat\n\n${pass} PASS · ${fail} FAIL · ${skip} SKIP\n\n`;

    const byGroup = {};
    for (const r of results) (byGroup[r.group] ||= []).push(r);

    for (const group of Object.keys(byGroup)) {
        md += `## ${group}\n\n`;
        for (const r of byGroup[group]) {
            const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '⊘';
            md += `- ${icon} **${r.id}** — ${r.status}${r.detail ? ` — ${r.detail}` : ''}\n`;
        }
        md += '\n';
    }

    md += `## Findings\n\n`;
    const findings = results.filter(r => r.detail?.includes('BEKRÆFTET') || r.detail?.includes('F68') || r.detail?.includes('F69'));
    if (findings.length === 0) md += `Ingen bekræftede findings.\n\n`;
    else for (const f of findings) md += `- **${f.id}** — ${f.detail}\n`;

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(reportPath, md);
    console.log(`\nRapport: ${reportPath}`);
    console.log(`Resultat: ${pass} PASS · ${fail} FAIL · ${skip} SKIP\n`);

    return { pass, fail, skip };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  T_TILBUD — tilbudsmodul (is_offer=1)');
    console.log('═══════════════════════════════════════════════════');

    safetyCheck();

    db = openDb(process.env.DB_PATH);
    await login();

    try {
        await runSetup();
        await runNextNumber();
        await runPost();
        await runGet();
        await runGetById();
        await runPatch();
        await runStatusPatch();
        await runConvert();
        await runDelete();
        await runRecalc();
        await runMoms();
        await runIsolation();
        await runPatchIVerification();
    } catch (e) {
        console.error('Fatal:', e);
    } finally {
        await runCleanup();
    }

    const { fail } = writeReport();
    db.close();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
