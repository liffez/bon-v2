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

// Session til de almindelige (ikke-force) kald. Siden #316 er hele /api bag
// en auth-gate, så en runner uden login får 401 på alt — også i preflight.
// Force-casene laver deres egne logins, fordi de netop skal teste roller.
let SESSION_COOKIE = null;

async function patchStatus(bonId, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;
    const res = await fetch(`${SERVER_URL}/api/bons/${bonId}/status`, {
        method: 'PATCH',
        headers,
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
    // 27 → 30: migration 081 (FAKTURERET→BETALT) + 083 (KLAR→GODKENDT) + udvidet direkte-flow
    assertEq('T_BON_DB_02', 'DB', 30, st.c, 'Antal status_transitions');

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
        // confirm_no_invoice: fakturavagten (#319) 409'er ellers når e-conomic er
        // konfigureret i test-miljøet. Testen handler om changelog, ikke fakturaer.
        const r = await patchStatus(4002, { status_code: 'AFSLUTTET', confirm_no_invoice: true });
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
        // confirm_no_invoice: se CL_01 — vagten må ikke stå i vejen for user_id-testen.
        const r = await patchStatus(4002, { status_code: 'FAKTURERET', user_id: 2, confirm_no_invoice: true });
        if (r.status !== 200) {
            record('T_BON_API_CL_02', 'CL', 'FAIL', `Setup: PATCH returnerede ${r.status}`);
        } else {
            const after = db.prepare(
                `SELECT user_id FROM changelog WHERE entity_type='bon' AND entity_id=4002 AND action='status_change' ORDER BY id DESC LIMIT 1`
            ).get();
            assertEq('T_BON_API_CL_02', 'CL', 2, after?.user_id, 'user_id i changelog');
        }
    }

    console.log('\n── 3.5 Force-mode (Patch D) ──');
    await runForceCases();
}

// ════════════════════════════════════════════════════════════
// Force-mode cases (Patch D) — kræver login som forskellige roller
// ════════════════════════════════════════════════════════════

async function loginCookie(pin) {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
    });
    if (res.status !== 200) throw new Error(`Login PIN ${pin} fejlede: status=${res.status}`);
    const setCookie = res.headers.get('set-cookie');
    return setCookie?.split(';')[0] || null;
}

async function patchStatusAuth(bonId, body, cookie) {
    const opts = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    if (cookie) opts.headers['Cookie'] = cookie;
    const res = await fetch(`${SERVER_URL}/api/bons/${bonId}/status`, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
}

function latestStatusChangelog(bonId) {
    return db.prepare(`
        SELECT user_id, payload FROM changelog
        WHERE entity_type='bon' AND entity_id=? AND action='status_change'
        ORDER BY id DESC LIMIT 1
    `).get(bonId);
}

async function runForceCases() {
    // Sikre seedede brugere: admin (id=2, intet PIN) og kitchen (id=3, PIN 1234).
    // For admin-login: opret midlertidig admin-PIN i DB (kitchen-runneren bruger
    // pin-endpointet, som er enklest). Admin har email-login i prod men PIN
    // virker også hvis sat.
    const adminUser = db.prepare(`SELECT id, pin FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1`).get();
    // Kitchen-brugeren slås op så FORCE_02/03 kan efterprøve at auditsporet
    // peger på den der FAKTISK var logget ind — ikke på body.user_id.
    const kitchenUser = db.prepare(`SELECT id FROM users WHERE pin = '1234' AND is_active = 1 LIMIT 1`).get();
    if (!adminUser) {
        for (let i = 1; i <= 7; i++) record(`T_BON_API_FORCE_0${i}`, 'FORCE', 'SKIP', 'Ingen aktiv admin-bruger');
        return;
    }
    // Backup eksisterende PIN og sæt midlertidig
    const originalAdminPin = adminUser.pin;
    const TMP_ADMIN_PIN = '9911';
    db.prepare(`UPDATE users SET pin = ? WHERE id = ?`).run(TMP_ADMIN_PIN, adminUser.id);

    let adminCookie = null;
    let kitchenCookie = null;
    try {
        adminCookie = await loginCookie(TMP_ADMIN_PIN);
        kitchenCookie = await loginCookie('1234');
    } catch (err) {
        for (let i = 1; i <= 7; i++) record(`T_BON_API_FORCE_0${i}`, 'FORCE', 'SKIP', `Login fejlede: ${err.message}`);
        // Restore PIN
        if (originalAdminPin != null) {
            db.prepare(`UPDATE users SET pin = ? WHERE id = ?`).run(originalAdminPin, adminUser.id);
        } else {
            db.prepare(`UPDATE users SET pin = NULL WHERE id = ?`).run(adminUser.id);
        }
        return;
    }

    try {
        // FORCE_01: admin force'r forbudt transition → 200
        setBonStatus(4002, 'GODKENDT');  // GODKENDT → BETALT er ikke en lovlig transition
        {
            const r = await patchStatusAuth(4002, { status_code: 'BETALT', force: true }, adminCookie);
            if (r.status === 200) {
                record('T_BON_API_FORCE_01', 'FORCE', 'PASS');
            } else {
                record('T_BON_API_FORCE_01', 'FORCE', 'FAIL',
                    `Admin force fejlede: status=${r.status}, body=${JSON.stringify(r.body)}`);
            }
        }

        // FORCE_02: ikke-admin med force: true → 200, og auditsporet peger på HENDE.
        // Force var admin-only indtil aug 2026. Virkeligheden følger ikke altid
        // flow-diagrammet, og auth er rolle-baseret med delte konti — så kravet
        // ramte roller, ikke ansvar. Login-kravet + auditsporet er værnet.
        setBonStatus(4002, 'GODKENDT');
        if (!kitchenUser) {
            record('T_BON_API_FORCE_02', 'FORCE', 'SKIP', 'Ingen aktiv kitchen-bruger med PIN 1234');
        } else {
            const r = await patchStatusAuth(4002, { status_code: 'BETALT', force: true }, kitchenCookie);
            const cl = latestStatusChangelog(4002);
            const auditOk = cl?.user_id === kitchenUser.id
                && JSON.parse(cl?.payload || '{}').by_user_id === kitchenUser.id;
            if (r.status === 200 && auditOk) {
                record('T_BON_API_FORCE_02', 'FORCE', 'PASS',
                    VERBOSE ? 'Ikke-admin kan force\'e; audit peger på kitchen-brugeren' : '');
            } else {
                record('T_BON_API_FORCE_02', 'FORCE', 'FAIL',
                    `Forventede 200 + audit=${kitchenUser.id}, fik status=${r.status}, cl=${JSON.stringify(cl)}`);
            }
        }

        // FORCE_03 (D-3 regression): body.user_id må ALDRIG bestemme hvem
        // historikken siger det var. Rolle-tjekket er væk, men netop derfor er
        // auditsporet nu det eneste der peger på et menneske — og det skal komme
        // fra sessionen. Skriver en afsender en anden brugers id i body, skal
        // det ignoreres.
        setBonStatus(4002, 'GODKENDT');
        if (!kitchenUser) {
            record('T_BON_API_FORCE_03', 'FORCE', 'SKIP', 'Ingen aktiv kitchen-bruger med PIN 1234');
        } else {
            const r = await patchStatusAuth(4002, {
                status_code: 'BETALT',
                force: true,
                user_id: adminUser.id,  // forsøg på at skrive en anden i historikken
            }, kitchenCookie);
            const cl = latestStatusChangelog(4002);
            const auditOk = cl?.user_id === kitchenUser.id
                && JSON.parse(cl?.payload || '{}').by_user_id === kitchenUser.id;
            if (r.status === 200 && auditOk) {
                record('T_BON_API_FORCE_03', 'FORCE', 'PASS',
                    VERBOSE ? 'D-3: body.user_id ignoreret i auditsporet' : '');
            } else {
                record('T_BON_API_FORCE_03', 'FORCE', 'FAIL',
                    `D-3 BRUDT: body.user_id=${adminUser.id} med kitchen-session gav `
                    + `status=${r.status}, cl=${JSON.stringify(cl)} (forventede audit=${kitchenUser.id})`);
            }
        }

        // FORCE_04: ingen session + force: true → 401
        setBonStatus(4002, 'GODKENDT');
        {
            const r = await patchStatusAuth(4002, { status_code: 'BETALT', force: true }, null);
            if (r.status === 401) {
                record('T_BON_API_FORCE_04', 'FORCE', 'PASS');
            } else {
                record('T_BON_API_FORCE_04', 'FORCE', 'FAIL',
                    `Forventede 401, fik ${r.status}`);
            }
        }

        // FORCE_05: ikke-force + forbudt transition → 400 (som hidtil)
        setBonStatus(4002, 'GODKENDT');
        {
            const r = await patchStatus(4002, { status_code: 'BETALT' });
            if (r.status === 400 && /ikke tilladt/i.test(r.body?.error || '')) {
                record('T_BON_API_FORCE_05', 'FORCE', 'PASS');
            } else {
                record('T_BON_API_FORCE_05', 'FORCE', 'FAIL',
                    `Forventede 400 'ikke tilladt', fik status=${r.status}, body=${JSON.stringify(r.body)}`);
            }
        }

        // FORCE_06: admin force'r FAKTURERET → IGANG (terminal-tilbageskift)
        setBonStatus(4002, 'FAKTURERET');
        {
            const r = await patchStatusAuth(4002, { status_code: 'IGANG', force: true }, adminCookie);
            if (r.status === 200) {
                record('T_BON_API_FORCE_06', 'FORCE', 'PASS');
            } else {
                record('T_BON_API_FORCE_06', 'FORCE', 'FAIL',
                    `Terminal force fejlede: status=${r.status}, body=${JSON.stringify(r.body)}`);
            }
        }

        // FORCE_07: audit — payload har was_forced=true OG kolonne-rækkefølge intakt
        // (D-2 regression: field_name skal IKKE være forskudt)
        setBonStatus(4002, 'GODKENDT');
        {
            const r = await patchStatusAuth(4002, { status_code: 'BETALT', force: true }, adminCookie);
            if (r.status !== 200) {
                record('T_BON_API_FORCE_07', 'FORCE', 'FAIL', `Setup-PATCH fejlede: ${r.status}`);
            } else {
                const cl = db.prepare(`
                    SELECT entity_type, entity_id, action, field_name, old_value, new_value, user_id, payload
                    FROM changelog
                    WHERE entity_type='bon' AND entity_id=4002 AND action='status_change'
                    ORDER BY id DESC LIMIT 1
                `).get();

                const payloadOk = cl?.payload && JSON.parse(cl.payload).was_forced === true
                    && JSON.parse(cl.payload).by_user_id === adminUser.id;
                const columnOrderOk = cl?.entity_type === 'bon'
                    && cl?.entity_id === 4002
                    && cl?.action === 'status_change'
                    && cl?.field_name === 'status_id'
                    && cl?.old_value === 'GODKENDT'
                    && cl?.new_value === 'BETALT'
                    && cl?.user_id === adminUser.id;

                if (payloadOk && columnOrderOk) {
                    record('T_BON_API_FORCE_07', 'FORCE', 'PASS',
                        VERBOSE ? `payload + kolonne-rækkefølge OK` : '');
                } else {
                    record('T_BON_API_FORCE_07', 'FORCE', 'FAIL',
                        `payloadOk=${payloadOk}, columnOrderOk=${columnOrderOk}, cl=${JSON.stringify(cl)}`);
                }
            }
        }
    } finally {
        // Restore admin's oprindelige PIN
        if (originalAdminPin != null) {
            db.prepare(`UPDATE users SET pin = ? WHERE id = ?`).run(originalAdminPin, adminUser.id);
        } else {
            db.prepare(`UPDATE users SET pin = NULL WHERE id = ?`).run(adminUser.id);
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

    // Log ind før preflight — auth-gaten (#316) svarer ellers 401 på alt.
    try {
        SESSION_COOKIE = await loginCookie(process.env.TEST_PIN || '1234');
    } catch (err) {
        console.error(`[run_T_BON] Login fejlede: ${err.message}`);
        process.exit(1);
    }

    // Verificer at server svarer
    try {
        const r = await fetch(`${SERVER_URL}/api/statuses`, {
            headers: SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {},
        });
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
