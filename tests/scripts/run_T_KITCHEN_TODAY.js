#!/usr/bin/env node
/**
 * tests/scripts/run_T_KITCHEN_TODAY.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_KITCHEN_TODAY — I dag-viewets backend.
 *
 * Tester /api/bons/today, prep, kitchen-info, status-flow til LEVERET + fortryd.
 * Bon 4006 (GODKENDT) UPDATE'es midlertidigt til today, restoreres ved exit.
 *
 * Usage:
 *   npm run test:run-kt
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt
 *   - npm run test:server kører
 *
 * Reference: tests/specs/T_KITCHEN_TODAY.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');
const { login, withSession } = require('./helpers/login');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const VERBOSE    = process.argv.includes('--verbose');

const TEST_BON_ID       = 4006;
const ORIGINAL_DATE     = '2026-05-14';
// Serverens egen dato-sandhed. toISOString() giver UTC-datoen, og mellem
// midnat og kl. 02 (dansk sommertid) er den GÅRSDAGENS — så testen satte
// bonen til i går og spurgte derefter efter i dag. Fejlede kun om natten.
// Se memory project_utc_today_bug + #133.
const { todayISO }      = require('../../db/helpers');
const TODAY             = todayISO();

let db;
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
    if (condition) record(id, group, 'PASS');
    else           record(id, group, 'FAIL', label);
}

// Siden #316 (global auth-gate på /api) skal runneren have en session.
// _session sættes af doLogin() og bærer cookien på hvert kald. Formen her
// returnerer kun { status, body } — bevaret, så kaldstederne er urørte.
let _session = null;

async function doLogin() {
    _session = withSession(SERVER_URL, await login(SERVER_URL));
}

async function api(method, pathPart, body = null) {
    if (!_session) throw new Error('api() kaldt før doLogin() — se tests/scripts/helpers/login.js');
    const r = await _session(method, pathPart, body);
    return { status: r.status, body: r.body };
}

function setBonDate(bonId, date) {
    db.prepare(`UPDATE bons SET delivery_date = ? WHERE id = ?`).run(date, bonId);
}

function setBonStatus(bonId, code) {
    db.prepare(
        `UPDATE bons SET status_id = (SELECT id FROM status_definitions WHERE code = ?) WHERE id = ?`
    ).run(code, bonId);
}

function getBonField(bonId, field) {
    return db.prepare(`SELECT ${field} FROM bons WHERE id = ?`).get(bonId)?.[field];
}

function getBonStatus(bonId) {
    return db.prepare(
        `SELECT sd.code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`
    ).get(bonId)?.code;
}

// ════════════════════════════════════════════════════════════
// 3.1 GET /api/bons/today
// ════════════════════════════════════════════════════════════

async function runGetTests() {
    console.log('\n── 3.1 GET /api/bons/today ──');

    // Setup: 4006 → today, GODKENDT
    setBonDate(TEST_BON_ID, TODAY);
    setBonStatus(TEST_BON_ID, 'GODKENDT');

    // GET_01: default filter inkluderer GODKENDT
    {
        const r = await api('GET', '/api/bons/today');
        const has = r.status === 200 && r.body?.some(b => b.id === TEST_BON_ID);
        assertTrue('T_KT_GET_01', 'GET', has, `Bon ${TEST_BON_ID} i /today efter GODKENDT+today`);
    }

    // GET_02: hver bon har lines
    {
        const r = await api('GET', '/api/bons/today');
        const ourBon = r.body?.find(b => b.id === TEST_BON_ID);
        assertTrue('T_KT_GET_02', 'GET',
            ourBon && Array.isArray(ourBon.lines) && ourBon.lines.length > 0,
            `Bon ${TEST_BON_ID} har lines: ${ourBon?.lines?.length || 0}`);
    }

    // GET_03: VENTER ekskluderes i default
    setBonStatus(TEST_BON_ID, 'VENTER');
    {
        const r = await api('GET', '/api/bons/today');
        const has = r.body?.some(b => b.id === TEST_BON_ID);
        assertEq('T_KT_GET_03', 'GET', false, has, 'VENTER ikke i /today default');
    }

    // Restore til GODKENDT for resterende tests
    setBonStatus(TEST_BON_ID, 'GODKENDT');
}

// ════════════════════════════════════════════════════════════
// 3.2 PATCH prep
// ════════════════════════════════════════════════════════════

async function runPrepTests() {
    console.log('\n── 3.2 PATCH /api/bons/:id/prep ──');

    // PREP_01: ingredients_ready → 1
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/prep`, {
            ingredients_ready: 1,
            supplies_ready:    0,
        });
        if (r.status !== 200) {
            record('T_KT_PREP_01', 'PREP', 'FAIL', `PATCH returnerede ${r.status}`);
        } else {
            assertEq('T_KT_PREP_01', 'PREP', 1,
                getBonField(TEST_BON_ID, 'prep_ingredients_ready'),
                'prep_ingredients_ready = 1');
        }
    }

    // PREP_02: supplies_ready → 1
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/prep`, {
            ingredients_ready: 1,
            supplies_ready:    1,
        });
        if (r.status !== 200) {
            record('T_KT_PREP_02', 'PREP', 'FAIL', `PATCH returnerede ${r.status}`);
        } else {
            assertEq('T_KT_PREP_02', 'PREP', 1,
                getBonField(TEST_BON_ID, 'prep_supplies_ready'),
                'prep_supplies_ready = 1');
        }
    }

    // PREP_03: ingredients_ready → 0
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/prep`, {
            ingredients_ready: 0,
            supplies_ready:    1,
        });
        if (r.status !== 200) {
            record('T_KT_PREP_03', 'PREP', 'FAIL', `PATCH returnerede ${r.status}`);
        } else {
            assertEq('T_KT_PREP_03', 'PREP', 0,
                getBonField(TEST_BON_ID, 'prep_ingredients_ready'),
                'prep_ingredients_ready = 0');
        }
    }
}

// ════════════════════════════════════════════════════════════
// 3.3 PATCH kitchen-info
// ════════════════════════════════════════════════════════════

async function runKitchenInfoTests() {
    console.log('\n── 3.3 PATCH /api/bons/:id/kitchen-info ──');

    // KI_01: sæt tekst
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/kitchen-info`, {
            text: 'T_KT test note',
        });
        if (r.status !== 200) {
            record('T_KT_KI_01', 'KI', 'FAIL', `PATCH returnerede ${r.status}`);
        } else {
            assertEq('T_KT_KI_01', 'KI', 'T_KT test note',
                getBonField(TEST_BON_ID, 'kitchen_info'),
                'kitchen_info text gemt');
        }
    }

    // KI_02: ryd
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/kitchen-info`, { text: '' });
        if (r.status !== 200) {
            record('T_KT_KI_02', 'KI', 'FAIL', `PATCH returnerede ${r.status}`);
        } else {
            const v = getBonField(TEST_BON_ID, 'kitchen_info');
            assertTrue('T_KT_KI_02', 'KI', v === '' || v === null,
                `kitchen_info ryddet (fik ${JSON.stringify(v)})`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 3.4 Status-flow
// ════════════════════════════════════════════════════════════

async function runStatusFlow() {
    console.log('\n── 3.4 Status-flow ──');

    // 4006 er GODKENDT efter setup
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/status`, { status_code: 'IGANG' });
        assertEq('T_KT_STAT_01', 'STAT', 'IGANG',
            r.status === 200 ? getBonStatus(TEST_BON_ID) : `HTTP ${r.status}`,
            'GODKENDT → IGANG');
    }
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/status`, { status_code: 'KLAR' });
        assertEq('T_KT_STAT_02', 'STAT', 'KLAR',
            r.status === 200 ? getBonStatus(TEST_BON_ID) : `HTTP ${r.status}`,
            'IGANG → KLAR');
    }
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/status`, { status_code: 'LEVERET' });
        assertEq('T_KT_STAT_03', 'STAT', 'LEVERET',
            r.status === 200 ? getBonStatus(TEST_BON_ID) : `HTTP ${r.status}`,
            'KLAR → LEVERET');
    }
    {
        const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/status`, { status_code: 'IGANG' });
        assertEq('T_KT_STAT_04', 'STAT', 'IGANG',
            r.status === 200 ? getBonStatus(TEST_BON_ID) : `HTTP ${r.status}`,
            'LEVERET → IGANG (fortryd)');
    }
}

// ════════════════════════════════════════════════════════════
// 3.5 AFLYST forsvinder
// ════════════════════════════════════════════════════════════

async function runCancelTests() {
    console.log('\n── 3.5 AFLYST forsvinder fra /today ──');

    // 4006 er IGANG efter status-flow — sæt til AFLYST
    const r = await api('PATCH', `/api/bons/${TEST_BON_ID}/status`, { status_code: 'AFLYST' });
    if (r.status !== 200) {
        record('T_KT_AFL_01', 'AFL', 'FAIL', `PATCH til AFLYST returnerede ${r.status}`);
        return;
    }

    const today = await api('GET', '/api/bons/today');
    const has = today.body?.some(b => b.id === TEST_BON_ID);
    assertEq('T_KT_AFL_01', 'AFL', false, has, 'AFLYST bon forsvinder fra /today');
}

// ════════════════════════════════════════════════════════════
// Cleanup + Rapport
// ════════════════════════════════════════════════════════════

function cleanup() {
    // Restore bon 4006 til original tilstand
    setBonDate(TEST_BON_ID, ORIGINAL_DATE);
    setBonStatus(TEST_BON_ID, 'GODKENDT');
    db.prepare(
        `UPDATE bons SET prep_ingredients_ready = 0, prep_supplies_ready = 0, kitchen_info = NULL WHERE id = ?`
    ).run(TEST_BON_ID);
}

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_KITCHEN_TODAY_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['GET','PREP','KI','STAT','AFL'];
    let md = `# T_KITCHEN_TODAY — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** ${SERVER_URL} · DB: ${process.env.DB_PATH}\n\n`;
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
    console.log(`\n[run_T_KT] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    await doLogin();

    try {
        const r = await api('GET', '/api/statuses');
        if (r.status !== 200) throw new Error(`status ${r.status}`);
    } catch (err) {
        console.error(`[run_T_KT] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    try {
        await runGetTests();
        await runPrepTests();
        await runKitchenInfoTests();
        await runStatusFlow();
        await runCancelTests();
    } finally {
        cleanup();
        db.close();
    }

    const { passes, fails } = writeReport();
    console.log(`\n[run_T_KT] ${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_KT] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    if (db) cleanup();
    process.exit(1);
});
