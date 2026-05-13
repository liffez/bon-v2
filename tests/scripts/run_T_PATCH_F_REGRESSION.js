#!/usr/bin/env node
/**
 * tests/scripts/run_T_PATCH_F_REGRESSION.js
 * ════════════════════════════════════════════════════════════
 * Regression-runner for Patch F (SSE broadcast consolidation).
 *
 * Verificerer at de 3 fixes fra maj 2026 forbliver løste:
 *   F49 — bon_status/notification/POST lines bruger {id}, ikke {bon_id}
 *   F57 — PUT lines udsender bon_updated broadcast
 *   F58 — DELETE lines udsender bon_updated broadcast
 *
 * 5 cases — én pr. broadcast-form patch'en har rørt.
 *
 * Usage:
 *   npm run test:run-patch-f
 *   node tests/scripts/run_T_PATCH_F_REGRESSION.js --verbose
 *
 * Reference: tests/specs/patches/PATCH_F_sse_broadcast_consolidation.md
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

const TEST_PREFIX = 'T_PATCH_F';

let db;
let SESSION_COOKIE = null;
let sseListener = null;
let testBonId, testLineId, testCustomerId, testCompanyId;
const results = [];

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
}

function statusId(code) { return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id; }
function defaultLocation() { return db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id; }
function today() { return new Date().toISOString().slice(0, 10); }

// Helper: assert at payload har `id` og IKKE `bon_id` (Patch F kontrakt)
function assertConsolidatedShape(evt, expectedId) {
    return evt.data.id === expectedId
        && !('bon_id' in evt.data);
}

// ════════════════════════════════════════════════════════════
// Setup
// ════════════════════════════════════════════════════════════

async function runSetup() {
    console.log('\n── Setup ──');

    try {
        await login();
        sseListener = await sse.connect(SERVER_URL, SESSION_COOKIE);
        await sseListener.waitForEvent('connected', null, 2000);

        // Opret test-firma + bon + line for at have noget at mutere
        const compRes = db.prepare(`INSERT INTO companies (name, notes) VALUES (?, ?)`)
            .run(`${TEST_PREFIX} test`, 'T_PATCH_F_test');
        testCompanyId = compRes.lastInsertRowid;

        const custRes = db.prepare(`INSERT INTO customers (company_id, first_name, last_name, notes) VALUES (?, 'F', 'Test', 'T_PATCH_F_test')`).run(testCompanyId);
        testCustomerId = custRes.lastInsertRowid;

        const bonRes = db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                              order_date, delivery_date, pax, total_price, is_offer, delivery_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, 5, 0, 0, 'delivery')
        `).run(`${TEST_PREFIX}_BASE`, statusId('NY'), defaultLocation(), testCustomerId, testCompanyId, today(), today());
        testBonId = bonRes.lastInsertRowid;

        // Tilføj én linje vi kan PUT/DELETE på
        const r = await api('POST', `/api/bons/${testBonId}/lines`, {
            product_name: 'Setup line', quantity: 1, unit_price: 100,
        });
        if (r.status === 201) {
            testLineId = r.body.id;
            return true;
        }
        return false;
    } catch (err) {
        console.error(`Setup-fejl: ${err.message}`);
        return false;
    }
}

// ════════════════════════════════════════════════════════════
// 5 test-cases
// ════════════════════════════════════════════════════════════

async function runCases() {
    // T_PATCH_F_01: PUT line → bon_updated event modtages med {id}
    {
        sseListener.clearEvents();
        const r = await api('PUT', `/api/bons/${testBonId}/lines/${testLineId}`, { quantity: 3 });
        if (r.status !== 200) {
            record('T_PATCH_F_01', 'F57', 'FAIL', `PUT status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_updated', e => e.id === testBonId, 2000);
                if (assertConsolidatedShape(evt, testBonId)) {
                    record('T_PATCH_F_01', 'F57', 'PASS',
                        VERBOSE ? 'PUT lines udsender bon_updated med {id}' : '');
                } else {
                    record('T_PATCH_F_01', 'F57', 'FAIL',
                        `payload=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_PATCH_F_01', 'F57', 'FAIL', err.message);
            }
        }
    }

    // T_PATCH_F_02: DELETE line → bon_updated event med {id}
    {
        // Opret en frisk linje at slette
        const tmp = await api('POST', `/api/bons/${testBonId}/lines`, { product_name: 'For DELETE' });
        const tmpId = tmp.body?.id;

        sseListener.clearEvents();
        const r = await api('DELETE', `/api/bons/${testBonId}/lines/${tmpId}`);
        if (r.status !== 200) {
            record('T_PATCH_F_02', 'F58', 'FAIL', `DELETE status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_updated', e => e.id === testBonId, 2000);
                if (assertConsolidatedShape(evt, testBonId)) {
                    record('T_PATCH_F_02', 'F58', 'PASS');
                } else {
                    record('T_PATCH_F_02', 'F58', 'FAIL',
                        `payload=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_PATCH_F_02', 'F58', 'FAIL', err.message);
            }
        }
    }

    // T_PATCH_F_03: PATCH status → bon_status med {id} (ikke {bon_id})
    {
        db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId('NY'), testBonId);
        sseListener.clearEvents();
        const r = await api('PATCH', `/api/bons/${testBonId}/status`, { status_code: 'GODKENDT' });
        if (r.status !== 200) {
            record('T_PATCH_F_03', 'F49', 'FAIL', `PATCH status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_status', e => e.id === testBonId, 2000);
                if (assertConsolidatedShape(evt, testBonId)
                    && evt.data.old === 'NY' && evt.data.new === 'GODKENDT') {
                    record('T_PATCH_F_03', 'F49', 'PASS');
                } else {
                    record('T_PATCH_F_03', 'F49', 'FAIL',
                        `payload=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_PATCH_F_03', 'F49', 'FAIL', err.message);
            }
        }
    }

    // T_PATCH_F_04: POST notification → notification-event med {id}
    {
        sseListener.clearEvents();
        const r = await api('POST', `/api/bons/${testBonId}/notifications`, { message: 'Patch F test' });
        if (r.status !== 201) {
            record('T_PATCH_F_04', 'F49', 'FAIL', `POST status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('notification', e => e.id === testBonId, 2000);
                if (assertConsolidatedShape(evt, testBonId)
                    && evt.data.notification
                    && 'sender_client_id' in evt.data) {
                    record('T_PATCH_F_04', 'F49', 'PASS');
                } else {
                    record('T_PATCH_F_04', 'F49', 'FAIL',
                        `payload=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_PATCH_F_04', 'F49', 'FAIL', err.message);
            }
        }
    }

    // T_PATCH_F_05: Regression — POST line → bon_updated med {id} (skiftet fra {bon_id})
    {
        sseListener.clearEvents();
        const r = await api('POST', `/api/bons/${testBonId}/lines`, { product_name: 'Patch F line' });
        if (r.status !== 201) {
            record('T_PATCH_F_05', 'F49', 'FAIL', `POST status=${r.status}`);
        } else {
            try {
                const evt = await sseListener.waitForEvent('bon_updated', e => e.id === testBonId, 2000);
                if (assertConsolidatedShape(evt, testBonId)) {
                    record('T_PATCH_F_05', 'F49', 'PASS',
                        VERBOSE ? 'POST lines bruger {id} (skiftet fra bon_id)' : '');
                } else {
                    record('T_PATCH_F_05', 'F49', 'FAIL',
                        `payload=${JSON.stringify(evt.data)}`);
                }
            } catch (err) {
                record('T_PATCH_F_05', 'F49', 'FAIL', err.message);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════

async function cleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n[cleanup] SKIPPED');
        return;
    }
    console.log('\n── Cleanup ──');
    try { if (sseListener) sseListener.disconnect(); } catch {}

    if (testBonId) {
        db.prepare(`DELETE FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id = ?)`).run(testBonId);
        db.prepare(`DELETE FROM mail_threads WHERE bon_id = ?`).run(testBonId);
        db.prepare(`DELETE FROM notification_reads WHERE notification_id IN (SELECT id FROM notifications WHERE bon_id = ?)`).run(testBonId);
        db.prepare(`DELETE FROM notifications WHERE bon_id = ?`).run(testBonId);
        db.prepare(`DELETE FROM bon_lines WHERE bon_id = ?`).run(testBonId);
        db.prepare(`DELETE FROM changelog WHERE entity_type='bon' AND entity_id = ?`).run(testBonId);
        db.prepare(`DELETE FROM bons WHERE id = ?`).run(testBonId);
    }
    db.prepare(`DELETE FROM customers WHERE notes = 'T_PATCH_F_test'`).run();
    db.prepare(`DELETE FROM companies WHERE notes = 'T_PATCH_F_test'`).run();
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_PATCH_F_REGRESSION_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    let md = `# T_PATCH_F_REGRESSION — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `## Patch-dækning\n\n`;
    md += `| Finding | Cases | Status |\n|---------|-------|--------|\n`;
    const map = {
        'F49': ['T_PATCH_F_03', 'T_PATCH_F_04', 'T_PATCH_F_05'],
        'F57': ['T_PATCH_F_01'],
        'F58': ['T_PATCH_F_02'],
    };
    for (const [f, ids] of Object.entries(map)) {
        const ok = ids.every(id => results.find(r => r.id === id && r.status === 'PASS'));
        md += `| ${f} | ${ids.join(', ')} | ${ok ? '✓' : '✗'} |\n`;
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
    console.log(`\n[run_T_PATCH_F_REGRESSION] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_PATCH_F_REGRESSION] Server: ${SERVER_URL}`);

    const ok = await runSetup();
    if (!ok) {
        console.error('[run_T_PATCH_F_REGRESSION] Setup fejlede');
        if (sseListener) sseListener.disconnect();
        db.close();
        process.exit(1);
    }

    try {
        await runCases();
    } catch (err) {
        console.error('[run_T_PATCH_F_REGRESSION] FEJL:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await cleanup();
    db.close();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_PATCH_F_REGRESSION] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_PATCH_F_REGRESSION] FEJL:', err.message);
    if (sseListener) sseListener.disconnect();
    process.exit(1);
});
