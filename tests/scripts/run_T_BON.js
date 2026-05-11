#!/usr/bin/env node
/**
 * tests/scripts/run_T_BON.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_BON-tracken — bon livscyklus.
 *
 * Tester status-flow, transitions, changelog, force-mode.
 *
 * Usage:
 *   npm run test:run-bon
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_BON.js --verbose
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt
 *   - npm run test:server kører på port 4322
 *
 * Reference: tests/specs/T_BON.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const VERBOSE    = process.argv.includes('--verbose');

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

async function patchStatus(bonId, body) {
    const res = await fetch(`${SERVER_URL}/api/bons/${bonId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

function setBonStatus(bonId, statusCode) {
    db.prepare(
        `UPDATE bons SET status_id = (SELECT id FROM status_definitions WHERE code = ?) WHERE id = ?`
    ).run(statusCode, bonId);
}

function getBonStatus(bonId) {
    const row = db.prepare(
        `SELECT sd.code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`
    ).get(bonId);
    return row?.code;
}

// ════════════════════════════════════════════════════════════
// 3.1 DB-tests
// ════════════════════════════════════════════════════════════

function runDbTests() {
    console.log('\n── 3.1 DB-tests ──');

    const sd = db.prepare('SELECT COUNT(*) AS c FROM status_definitions').get();
    assertEq('T_BON_DB_01', 'DB', 11, sd.c, 'Antal status_definitions');

    const st = db.prepare('SELECT COUNT(*) AS c FROM status_transitions').get();
    assertEq('T_BON_DB_02', 'DB', 27, st.c, 'Antal status_transitions');

    const fkErrs = db.prepare('PRAGMA foreign_key_check(status_transitions)').all();
    assertEq('T_BON_DB_03', 'DB', [], fkErrs, 'FK-check transitions');

    const inactive = db.prepare('SELECT COUNT(*) AS c FROM status_transitions WHERE is_active = 0').get();
    assertEq('T_BON_DB_04', 'DB', 0, inactive.c, 'Inaktive transitions');

    // T_BON_DB_05: alle aktive statusser har AFLYST som mulig destination
    const cancelable = db.prepare(`
        SELECT sf.code AS f
        FROM status_definitions sf
        WHERE sf.code IN ('TILBUD','NY','VENTER','GODKENDT','IGANG','KLAR','LEVERET')
          AND NOT EXISTS (
              SELECT 1 FROM status_transitions x
              JOIN status_definitions ts ON x.to_status_id = ts.id
              WHERE x.from_status_id = sf.id AND ts.code = 'AFLYST'
          )
    `).all();
    assertEq('T_BON_DB_05', 'DB', [], cancelable, 'Aktive statusser uden AFLYST-transition');

    // T_BON_DB_06: BETALT og AFSLUTTET har ingen udgående
    const terminalOut = db.prepare(`
        SELECT sf.code AS f, COUNT(*) AS c
        FROM status_transitions x
        JOIN status_definitions sf ON x.from_status_id = sf.id
        WHERE sf.code IN ('BETALT','AFSLUTTET')
        GROUP BY sf.code
    `).all();
    assertEq('T_BON_DB_06', 'DB', [], terminalOut, 'Terminale statusser har udgående transitions');
}

// ════════════════════════════════════════════════════════════
// 3.2 + 3.3 + 3.4 API-tests
// ════════════════════════════════════════════════════════════

async function runApiTests() {
    console.log('\n── 3.2 Tilladte transitions ──');

    // OK_01: NY → GODKENDT (sæt 4006 til NY først)
    setBonStatus(4006, 'NY');
    {
        const r = await patchStatus(4006, { status_code: 'GODKENDT' });
        assertEq('T_BON_API_OK_01', 'OK', 200, r.status, 'NY → GODKENDT');
    }

    // OK_02: GODKENDT → IGANG (4006 er nu GODKENDT)
    {
        const r = await patchStatus(4006, { status_code: 'IGANG' });
        assertEq('T_BON_API_OK_02', 'OK', 200, r.status, 'GODKENDT → IGANG');
    }

    // OK_03: IGANG → KLAR (4005 er IGANG i seed)
    {
        const r = await patchStatus(4005, { status_code: 'KLAR' });
        assertEq('T_BON_API_OK_03', 'OK', 200, r.status, 'IGANG → KLAR');
    }

    // OK_04: KLAR → LEVERET (4003 er KLAR i seed)
    {
        const r = await patchStatus(4003, { status_code: 'LEVERET' });
        assertEq('T_BON_API_OK_04', 'OK', 200, r.status, 'KLAR → LEVERET');
    }

    // OK_05: LEVERET → IGANG (4001 er LEVERET i seed — fortryd)
    {
        const r = await patchStatus(4001, { status_code: 'IGANG' });
        assertEq('T_BON_API_OK_05', 'OK', 200, r.status, 'LEVERET → IGANG (fortryd)');
    }

    console.log('\n── 3.3 Forbudte transitions ──');

    // NO_01: 4006 er nu IGANG, IGANG → BETALT er ikke tilladt
    {
        const r = await patchStatus(4006, { status_code: 'BETALT' });
        assertEq('T_BON_API_NO_01', 'NO', 400, r.status, 'IGANG → BETALT forbudt');
    }

    // NO_02: BETALT → IGANG (sæt 4007 til BETALT først via DB direkte, da API ikke tillader det)
    setBonStatus(4007, 'BETALT');
    {
        const r = await patchStatus(4007, { status_code: 'IGANG' });
        assertEq('T_BON_API_NO_02', 'NO', 400, r.status, 'BETALT → IGANG forbudt (terminal)');
    }

    // NO_03: Ukendt status
    {
        const r = await patchStatus(4002, { status_code: 'FOOBAR' });
        assertEq('T_BON_API_NO_03', 'NO', 400, r.status, 'Ukendt status returnerer 400');
    }

    // NO_04: Manglende status_code
    {
        const r = await patchStatus(4002, {});
        assertEq('T_BON_API_NO_04', 'NO', 400, r.status, 'Tom body returnerer 400');
    }

    // NO_05: Ukendt bon-id
    {
        const r = await patchStatus(999999, { status_code: 'GODKENDT' });
        assertEq('T_BON_API_NO_05', 'NO', 404, r.status, 'Ukendt bon-id returnerer 404');
    }

    console.log('\n── 3.4 Changelog ──');

    // CL_01: status-skift skriver changelog
    setBonStatus(4002, 'FAKTURERET');
    const before = db.prepare(
        `SELECT COUNT(*) AS c FROM changelog WHERE entity_type='bon' AND entity_id=4002 AND action='status_change'`
    ).get().c;
    {
        const r = await patchStatus(4002, { status_code: 'AFSLUTTET' });
        if (r.status !== 200) {
            record('T_BON_API_CL_01', 'CL', 'FAIL', `Setup: PATCH returnerede ${r.status}, ikke 200`);
        } else {
            const after = db.prepare(
                `SELECT * FROM changelog WHERE entity_type='bon' AND entity_id=4002 AND action='status_change' ORDER BY id DESC LIMIT 1`
            ).get();
            const ok = after && after.old_value === 'FAKTURERET' && after.new_value === 'AFSLUTTET';
            assertEq('T_BON_API_CL_01', 'CL', true, ok,
                `Changelog: old=${after?.old_value}, new=${after?.new_value}`);
        }
    }

    // CL_02: user_id videregives
    setBonStatus(4002, 'LEVERET');
    {
        const r = await patchStatus(4002, { status_code: 'FAKTURERET', user_id: 2 });
        if (r.status !== 200) {
            record('T_BON_API_CL_02', 'CL', 'FAIL', `Setup: PATCH returnerede ${r.status}`);
        } else {
            const after = db.prepare(
                `SELECT user_id FROM changelog WHERE entity_type='bon' AND entity_id=4002 AND action='status_change' ORDER BY id DESC LIMIT 1`
            ).get();
            assertEq('T_BON_API_CL_02', 'CL', 2, after?.user_id, 'user_id i changelog');
        }
    }

    console.log('\n── 3.5 Force-mode (parkeret — venter på design-beslutning) ──');

    // FORCE_01: GODKENDT → BETALT med force: true
    // Feature er nævnt i CLAUDE.md men ikke implementeret i routes/bons.js.
    // SKIPpes indtil beslutning: implementer eller fjern fra CLAUDE.md.
    // Hvis features skal valideres, ændr SKIP → den faktiske assert nedenfor.
    setBonStatus(4002, 'GODKENDT');
    {
        const r = await patchStatus(4002, { status_code: 'BETALT', force: true });
        if (r.status === 200) {
            record('T_BON_API_FORCE_01', 'FORCE', 'PASS',
                'Force-mode virker — feature er implementeret. Opdater T_BON.md §6.');
        } else {
            record('T_BON_API_FORCE_01', 'FORCE', 'SKIP',
                `Force-mode ikke implementeret (PATCH returnerede ${r.status}). Venter på design-beslutning. Se T_BON.md §6.`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_BON_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['DB','OK','NO','CL','FORCE'];
    let md = `# T_BON — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_BON] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    // Verificer at server svarer
    try {
        const r = await fetch(`${SERVER_URL}/api/statuses`);
        if (r.status !== 200) {
            console.error(`[run_T_BON] Server svarer ${r.status} — er test:server startet?`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_BON] Kan ikke nå server: ${err.message}`);
        console.error(`Start serveren med: npm run test:server`);
        process.exit(1);
    }

    runDbTests();
    await runApiTests();

    db.close();
    const { passes, fails } = writeReport();
    console.log(`\n[run_T_BON] ${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_BON] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
