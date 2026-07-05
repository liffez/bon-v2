#!/usr/bin/env node
/**
 * tests/scripts/run_T_AGGR.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_AGGR — optællings-konsistens.
 *
 * Sammenligner /api/bons/calendar, /api/bons/planning og
 * /api/schedule/week for samme datointerval og verificerer at
 * non-offer-bonner regnes ens.
 *
 * Usage:
 *   npm run test:run-aggr
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_AGGR.js --verbose
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt
 *   - npm run test:server kører på port 4322
 *
 * Reference: tests/specs/T_AGGR.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const safetyCheck  = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const VERBOSE    = process.argv.includes('--verbose');

// Auth — schedule/week kræver login. Vi opretter en test-admin og bruger
// session-cookien til alle requests.
const TEST_ADMIN_EMAIL    = 'taggr@test.local';
const TEST_ADMIN_PASSWORD = 'taggr-test-password';
let SESSION_COOKIE = null;

async function ensureTestAdminAndLogin() {
    // Opret bruger direkte i DB hvis den ikke findes
    const { openDb }       = require('../../db/compat');
    const { hashPassword } = require('../../db/helpers');
    const db = openDb(process.env.DB_PATH);
    const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(TEST_ADMIN_EMAIL);
    if (!exists) {
        const hash = await hashPassword(TEST_ADMIN_PASSWORD);
        db.prepare(
            `INSERT INTO users (name, email, role, password_hash, is_active)
             VALUES ('T_AGGR test admin', ?, 'admin', ?, 1)`
        ).run(TEST_ADMIN_EMAIL, hash);
    }
    db.close();

    // Login og fang session-cookie
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
    });
    if (res.status !== 200) {
        throw new Error(`Login fejlede: ${res.status}`);
    }
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('Ingen set-cookie fra /api/auth/login');
    // Tag bare første cookie-værdi (connect.sid=...)
    SESSION_COOKIE = setCookie.split(';')[0];
}

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

async function api(pathPart) {
    const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
    const res = await fetch(`${SERVER_URL}${pathPart}`, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// Helpers — udtræk pr. dag-tal fra hver endpoint

async function getCalendarDay(date, status = null) {
    const [y, m] = date.split('-');
    const url = `/api/bons/calendar?year=${y}&month=${parseInt(m)}${status ? `&status=${status}` : ''}`;
    const r = await api(url);
    if (r.status !== 200 || !r.body) throw new Error(`calendar ${r.status}`);
    return r.body.days?.[date] || { bons: [], totals: { units: 0, pax: 0, count: 0, offers: 0 } };
}

async function getPlanningDay(date, status = null) {
    const url = `/api/bons/planning?from=${date}&to=${date}${status ? `&status=${status}` : ''}`;
    const r = await api(url);
    if (r.status !== 200) throw new Error(`planning ${r.status}`);
    return r.body || [];
}

async function getScheduleDay(date, status = null) {
    const url = `/api/schedule/week?from=${date}&to=${date}${status ? `&status=${status}` : ''}`;
    const r = await api(url);
    if (r.status !== 200 || !r.body) throw new Error(`schedule ${r.status}`);
    // Schema: { week: { days: [{ date, bons, ... }, ...] } }
    const days = r.body.week?.days || [];
    return days.find(d => d.date === date) || { bons: [] };
}

function sumUnits(bons) {
    return bons.reduce((s, b) => s + (b.total_units || 0), 0);
}

function sumPlanningUnits(planningBons) {
    return planningBons.reduce((s, b) => {
        return s + (b.lines || []).reduce((ls, l) => ls + (l.quantity || 0), 0);
    }, 0);
}

function bonNumbers(arr) {
    return arr.map(b => b.bon_number).sort();
}

// ════════════════════════════════════════════════════════════
// 3.1 Konsistens-tests
// ════════════════════════════════════════════════════════════

async function runConsistencyTests() {
    console.log('\n── 3.1 Konsistens — calendar / planning / schedule ──');

    // C_01: 11/5 status=LEVERET → kun 4001, 103 enheder
    {
        const cal  = await getCalendarDay('2026-05-11', 'LEVERET');
        const plan = await getPlanningDay('2026-05-11', 'LEVERET');
        const sch  = await getScheduleDay('2026-05-11', 'LEVERET');
        // Filtrér is_offer fra planning så vi sammenligner æbler med æbler
        const planNonOffer = plan.filter(b => !b.is_offer);

        const calBons  = bonNumbers(cal.bons);
        const planBons = bonNumbers(planNonOffer);
        const schBons  = bonNumbers(sch.bons);

        assertEq('T_AGGR_C_01_calendar_bons',  'C', ['4001'], calBons,  'calendar 11/5 LEVERET');
        assertEq('T_AGGR_C_01_planning_bons',  'C', ['4001'], planBons, 'planning 11/5 LEVERET (non-offer)');
        assertEq('T_AGGR_C_01_schedule_bons',  'C', ['4001'], schBons,  'schedule 11/5 LEVERET');

        assertEq('T_AGGR_C_01_calendar_units', 'C', 103, cal.totals.units, 'calendar units');
        assertEq('T_AGGR_C_01_planning_units', 'C', 103, sumPlanningUnits(planNonOffer), 'planning sum lines.qty');
        assertEq('T_AGGR_C_01_schedule_units', 'C', 103, sumUnits(sch.bons), 'schedule sum total_units');
    }

    // C_02: 12/5 status=KLAR → kun 4003, 103 enheder
    {
        const cal  = await getCalendarDay('2026-05-12', 'KLAR');
        const plan = await getPlanningDay('2026-05-12', 'KLAR');
        const sch  = await getScheduleDay('2026-05-12', 'KLAR');
        const planNonOffer = plan.filter(b => !b.is_offer);

        assertEq('T_AGGR_C_02_calendar', 'C', { bons: ['4003'], units: 103 },
            { bons: bonNumbers(cal.bons), units: cal.totals.units }, 'calendar 12/5 KLAR');
        assertEq('T_AGGR_C_02_planning', 'C', { bons: ['4003'], units: 103 },
            { bons: bonNumbers(planNonOffer), units: sumPlanningUnits(planNonOffer) }, 'planning 12/5 KLAR');
        assertEq('T_AGGR_C_02_schedule', 'C', { bons: ['4003'], units: 103 },
            { bons: bonNumbers(sch.bons), units: sumUnits(sch.bons) }, 'schedule 12/5 KLAR');
    }

    // C_03: 13/5 status=IGANG → kun 4005, 134 enheder
    {
        const cal  = await getCalendarDay('2026-05-13', 'IGANG');
        const plan = await getPlanningDay('2026-05-13', 'IGANG');
        const sch  = await getScheduleDay('2026-05-13', 'IGANG');
        const planNonOffer = plan.filter(b => !b.is_offer);

        assertEq('T_AGGR_C_03_calendar', 'C', { bons: ['4005'], units: 134 },
            { bons: bonNumbers(cal.bons), units: cal.totals.units }, 'calendar 13/5 IGANG');
        assertEq('T_AGGR_C_03_planning', 'C', { bons: ['4005'], units: 134 },
            { bons: bonNumbers(planNonOffer), units: sumPlanningUnits(planNonOffer) }, 'planning 13/5 IGANG');
        assertEq('T_AGGR_C_03_schedule', 'C', { bons: ['4005'], units: 134 },
            { bons: bonNumbers(sch.bons), units: sumUnits(sch.bons) }, 'schedule 13/5 IGANG');
    }

    // C_04: 14/5 status=GODKENDT → kun 4006 (4008 er VENTER+offer), 47 enheder
    {
        const cal  = await getCalendarDay('2026-05-14', 'GODKENDT');
        const plan = await getPlanningDay('2026-05-14', 'GODKENDT');
        const sch  = await getScheduleDay('2026-05-14', 'GODKENDT');
        const planNonOffer = plan.filter(b => !b.is_offer);

        assertEq('T_AGGR_C_04_calendar', 'C', { bons: ['4006'], units: 47 },
            { bons: bonNumbers(cal.bons), units: cal.totals.units }, 'calendar 14/5 GODKENDT');
        assertEq('T_AGGR_C_04_planning', 'C', { bons: ['4006'], units: 47 },
            { bons: bonNumbers(planNonOffer), units: sumPlanningUnits(planNonOffer) }, 'planning 14/5 GODKENDT');
        assertEq('T_AGGR_C_04_schedule', 'C', { bons: ['4006'], units: 47 },
            { bons: bonNumbers(sch.bons), units: sumUnits(sch.bons) }, 'schedule 14/5 GODKENDT');
    }
}

// ════════════════════════════════════════════════════════════
// 3.2 Tilbuds-håndtering (dokumenteret design-forskel)
// ════════════════════════════════════════════════════════════

async function runOfferTests() {
    console.log('\n── 3.2 Tilbuds-håndtering ──');

    // OFF_01: Calendar 14/5 (uden filter) — 4006 + 4008 men forskellig kategori
    {
        const cal = await getCalendarDay('2026-05-14');
        // 4006 er GODKENDT, 4008 er VENTER + is_offer=1
        // calendar tæller 4008 separat i offers, ikke i units
        const passNumbers = bonNumbers(cal.bons);
        assertEq('T_AGGR_OFF_01_bons',   'OFF', ['4006','4008'], passNumbers, 'calendar 14/5 har begge bonner');
        assertEq('T_AGGR_OFF_01_offers', 'OFF', 1, cal.totals.offers,           'calendar.totals.offers = 1');
        assertEq('T_AGGR_OFF_01_units',  'OFF', 47, cal.totals.units,           'calendar.totals.units kun 4006 (47)');
    }

    // OFF_02: Planning 14/5 status=GODKENDT — backend OR'er is_offer=1 ind → 4006 + 4008
    {
        const plan = await getPlanningDay('2026-05-14', 'GODKENDT');
        const nums = bonNumbers(plan);
        assertEq('T_AGGR_OFF_02', 'OFF', ['4006','4008'], nums,
            'planning 14/5 GODKENDT inkluderer tilbud 4008');
    }

    // OFF_03: Schedule/week 14/5 — ekskluderer altid is_offer
    {
        const sch = await getScheduleDay('2026-05-14');
        const nums = bonNumbers(sch.bons);
        assertEq('T_AGGR_OFF_03', 'OFF', ['4006'], nums,
            'schedule/week 14/5 ekskluderer tilbud');
    }
}

// ════════════════════════════════════════════════════════════
// 3.3 AFLYST-håndtering
// ════════════════════════════════════════════════════════════

async function runCancelTests() {
    console.log('\n── 3.3 AFLYST-håndtering ──');

    // AFL_01: Calendar 12/5 uden filter — 4003 + 4004, units=103 (4004=AFLYST), offers=0
    {
        const cal = await getCalendarDay('2026-05-12');
        const nums = bonNumbers(cal.bons);
        assertEq('T_AGGR_AFL_01_bons', 'AFL', ['4003','4004'], nums,
            'calendar 12/5 uden filter inkluderer AFLYST');
        // Calendar ekskluderer is_offer fra units — og siden commit 5a23bd6 ekskluderes
        // AFLYST også fra workload-summer (aflyste bons VISES stadig i kalenderen, jf.
        // AFL_01_bons ovenfor, men tæller ikke i kapacitet). 4004 er AFLYST → kun 4003.
        assertEq('T_AGGR_AFL_01_units', 'AFL', 103, cal.totals.units,
            'calendar.units ekskluderer AFLYST fra workload (kun 4003=103)');
    }

    // AFL_02: Planning 12/5 status=AFLYST — 4004 (+ 4008 fra OR is_offer, men 4008 er 14/5)
    {
        const plan = await getPlanningDay('2026-05-12', 'AFLYST');
        const nums = bonNumbers(plan);
        assertEq('T_AGGR_AFL_02', 'AFL', ['4004'], nums,
            'planning 12/5 status=AFLYST giver 4004 (4008 ikke på 12/5)');
    }

    // AFL_03: Schedule/week 12/5 default — kun 4003 (4004 AFLYST ekskluderet, 4008 is_offer ekskluderet)
    {
        const sch = await getScheduleDay('2026-05-12');
        const nums = bonNumbers(sch.bons);
        assertEq('T_AGGR_AFL_03', 'AFL', ['4003'], nums,
            'schedule/week 12/5 default ekskluderer AFLYST og tilbud');
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_AGGR_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['C','OFF','AFL'];
    let md = `# T_AGGR — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_AGGR] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    // Verificer at server svarer
    try {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-11');
        if (r.status !== 200) {
            console.error(`[run_T_AGGR] Server svarer ${r.status} — er test:server startet?`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_AGGR] Kan ikke nå server: ${err.message}`);
        console.error(`Start serveren med: npm run test:server`);
        process.exit(1);
    }

    // Schedule/week kræver auth — log ind som test-admin
    try {
        await ensureTestAdminAndLogin();
        console.log('[run_T_AGGR] Logget ind som test-admin');
    } catch (err) {
        console.error(`[run_T_AGGR] Kunne ikke logge ind: ${err.message}`);
        process.exit(1);
    }

    await runConsistencyTests();
    await runOfferTests();
    await runCancelTests();

    const { passes, fails } = writeReport();
    console.log(`\n[run_T_AGGR] ${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_AGGR] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
