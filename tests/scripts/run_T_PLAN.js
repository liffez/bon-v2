#!/usr/bin/env node
/**
 * tests/scripts/run_T_PLAN.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_PLAN-tracken.
 *
 * Udfører alle API-tests, sammenligner med facit fra T_PLAN.md §7,
 * og skriver rapport til tests/reports/T_PLAN_YYYY-MM-DD.md.
 *
 * Frontend-aggregeringstests (Playwright) køres separat —
 * se tests/playwright/T_PLAN_AGG.spec.js.
 *
 * Usage:
 *   npm run test:run                                # default: alle cases
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_PLAN.js --only=API
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_PLAN.js --verbose
 *
 * Forudsætninger:
 *   - safety_check.js bestået (tjekkes automatisk)
 *   - test:reset er kørt (data/test.db er klar med seed_planning)
 *   - test:server kører (default localhost:4322)
 *   - grocy_snapshot.json findes (kun nødvendig for ING-cases)
 *
 * Reference: tests/specs/T_PLAN.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');
const { login, withSession } = require('./helpers/login');

const SERVER_URL    = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR    = path.resolve(__dirname, '..', 'reports');
const SNAPSHOT_PATH = path.resolve(__dirname, '..', 'fixtures', 'grocy_snapshot.json');

const args    = process.argv.slice(2);
const ONLY    = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const VERBOSE = args.includes('--verbose');

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

let db;

// Siden #316 (global auth-gate på /api) skal runneren have en session.
// Signaturen her er GET-only — bevaret, så kaldstederne er urørte.
let _session = null;

async function doLogin() {
    _session = withSession(SERVER_URL, await login(SERVER_URL));
}

async function api(pathPart) {
    if (!_session) throw new Error('api() kaldt før doLogin() — se tests/scripts/helpers/login.js');
    const r = await _session('GET', pathPart);
    return { status: r.status, body: r.body };
}

function sql(query, ...params) {
    return db.prepare(query).all(...params);
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Tracker
const results = [];
function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')      console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP') console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)           console.log(`  ✓ ${id}`);
}

function assertEq(id, group, expected, actual, label = '') {
    if (deepEqual(expected, actual)) {
        record(id, group, 'PASS');
    } else {
        record(id, group, 'FAIL',
            `${label}: forventet ${JSON.stringify(expected)}, fik ${JSON.stringify(actual)}`);
    }
}

function shouldRun(group) {
    return !ONLY || ONLY.toUpperCase() === group;
}

// ════════════════════════════════════════════════════════════
// API tests (8.1) — mod /api/bons/planning
// ════════════════════════════════════════════════════════════
//
// Backend-adfærd (verificeret i routes/kitchen.js linje 148):
//   WHERE delivery_date BETWEEN from..to
//     AND (sd.code IN (status_codes) OR b.is_offer = 1)
//
// Konsekvens: tilbud (4008) returneres ALTID — uanset hvilken status
// der filtreres på. Det er bevidst og afspejles i facit nedenfor.
// ════════════════════════════════════════════════════════════

async function runApiTests() {
    if (!shouldRun('API')) return;
    console.log('\n── API-tests (/api/bons/planning) ──');

    // T_PLAN_API_01: Default filter returnerer 5 bonner (4 normal + 1 tilbud)
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const nums = r.body?.map(b => b.bon_number).sort();
        assertEq('T_PLAN_API_01', 'API', ['4001','4003','4005','4006','4008'], nums, 'Default-bonner');
    }

    // T_PLAN_API_02: AFLYST ekskluderet i default
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const has4004 = r.body?.some(b => b.bon_number === '4004');
        assertEq('T_PLAN_API_02', 'API', false, has4004, 'AFLYST ikke i default');
    }

    // T_PLAN_API_03: Tilbud (4008) inkluderes uanset status
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const has4008 = r.body?.some(b => b.bon_number === '4008' && b.is_offer === 1);
        assertEq('T_PLAN_API_03', 'API', true, has4008, 'Tilbud i default-svar');
    }

    // T_PLAN_API_04: Eksplicit status=AFLYST returnerer 4004 + 4008 (tilbud OR'es altid ind)
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15&status=AFLYST');
        const nums = r.body?.map(b => b.bon_number).sort();
        assertEq('T_PLAN_API_04', 'API', ['4004','4008'], nums, 'AFLYST + tilbud');
    }

    // T_PLAN_API_05: Multiple statusser — GODKENDT,VENTER giver 4006, 4007, 4008
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15&status=GODKENDT,VENTER');
        const nums = r.body?.map(b => b.bon_number).sort();
        assertEq('T_PLAN_API_05', 'API', ['4006','4007','4008'], nums, 'GODKENDT+VENTER');
    }

    // T_PLAN_API_06: Dato-range bounds inklusiv
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-11');
        const dates = [...new Set(r.body?.map(b => b.delivery_date))];
        assertEq('T_PLAN_API_06', 'API', ['2026-05-11'], dates, 'Kun 11/5');
    }

    // T_PLAN_API_07: Dato-range ekskl. uden for
    {
        const r = await api('/api/bons/planning?from=2026-05-12&to=2026-05-15');
        const has4001 = r.body?.some(b => b.bon_number === '4001');
        assertEq('T_PLAN_API_07', 'API', false, has4001, '4001 ikke i 12-15/5');
    }

    // T_PLAN_API_08: Hver bon har lines-array udfyldt
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const allHaveLines = r.body?.every(b => Array.isArray(b.lines) && b.lines.length > 0);
        assertEq('T_PLAN_API_08', 'API', true, allHaveLines, 'Lines udfyldt');
    }

    // T_PLAN_API_09: Lines indeholder alle påkrævede felter
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const requiredFields = ['product_name','category','quantity','unit_price','cost_price','line_total','is_accessory'];
        const firstLine = r.body?.[0]?.lines?.[0] || {};
        const missing = requiredFields.filter(f => !(f in firstLine));
        assertEq('T_PLAN_API_09', 'API', [], missing, 'Manglende felter');
    }

    // T_PLAN_API_10: Sortering: delivery_date, pickup_time, id
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const order  = r.body?.map(b => `${b.delivery_date}|${b.pickup_time}|${b.id}`);
        const sorted = [...order].sort();
        assertEq('T_PLAN_API_10', 'API', sorted, order, 'Sorteringsorden');
    }

    // T_PLAN_API_11: price_category_code joined fra price_categories
    //
    // BEMÆRK: routes/kitchen.js:145 har en bug — joiner b.price_category (TEXT)
    // mod pc.id (INTEGER). Bør være b.price_category_id. Indtil bug'en fixes
    // returnerer price_category_code som NULL — denne test fanger den.
    {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-15');
        const allCatering = r.body?.every(b => b.price_category_code === 'catering');
        assertEq('T_PLAN_API_11', 'API', true, allCatering, 'price_category_code = catering');
    }

    // T_PLAN_API_12: Tom periode returnerer tom liste, ikke fejl
    {
        const r = await api('/api/bons/planning?from=2026-06-01&to=2026-06-07');
        assertEq('T_PLAN_API_12',  'API', 200, r.status, 'Status code');
        assertEq('T_PLAN_API_12b', 'API', [],  r.body,   'Tom liste');
    }
}

// ════════════════════════════════════════════════════════════
// SQL-baserede facit-tests (DB-niveau, scenarie S1-S4)
// Disse verificerer at DB'en stemmer med facit i T_PLAN §7.
// ════════════════════════════════════════════════════════════

async function runDbFacitTests() {
    if (!shouldRun('DB')) return;
    console.log('\n── DB-facit (T_PLAN §7) ──');

    const S1_FILTER = `sd.code IN ('GODKENDT','IGANG','KLAR','LEVERET') AND b.is_offer=0`;
    const S4_FILTER = `sd.code != 'AFLYST'`;

    // T_PLAN_DB_S1_units: S1 enheder pr. dag
    {
        const rows = sql(`
            SELECT b.delivery_date AS d, SUM(bl.quantity) AS u
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008 AND ${S1_FILTER}
            GROUP BY b.delivery_date ORDER BY b.delivery_date`);
        const got = Object.fromEntries(rows.map(r => [r.d, r.u]));
        const expected = {'2026-05-11':103, '2026-05-12':103, '2026-05-13':134, '2026-05-14':47};
        assertEq('T_PLAN_DB_S1_units', 'DB', expected, got, 'S1 enheder pr. dag');
    }

    // T_PLAN_DB_S1_oms_kost: S1 omsætning + kostpris pr. dag
    {
        const rows = sql(`
            SELECT b.delivery_date AS d,
                   ROUND(SUM(bl.line_total),2) AS oms,
                   ROUND(SUM(bl.cost_price * bl.quantity),2) AS kost
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008 AND ${S1_FILTER}
            GROUP BY b.delivery_date ORDER BY b.delivery_date`);
        const expected_oms  = {'2026-05-11':5237.50, '2026-05-12':5237.50, '2026-05-13':7090.00, '2026-05-14':2655.00};
        const expected_kost = {'2026-05-11':1334.00, '2026-05-12':1334.00, '2026-05-13':1791.60, '2026-05-14':668.00};
        const got_oms  = Object.fromEntries(rows.map(r => [r.d, r.oms]));
        const got_kost = Object.fromEntries(rows.map(r => [r.d, r.kost]));
        assertEq('T_PLAN_DB_S1_oms',  'DB', expected_oms,  got_oms,  'S1 omsætning incl pr. dag');
        assertEq('T_PLAN_DB_S1_kost', 'DB', expected_kost, got_kost, 'S1 kostpris ex pr. dag');
    }

    // T_PLAN_DB_S4_units: S4 (alle ekskl. AFLYST)
    {
        const rows = sql(`
            SELECT b.delivery_date AS d, SUM(bl.quantity) AS u
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008 AND ${S4_FILTER}
            GROUP BY b.delivery_date ORDER BY b.delivery_date`);
        const got = Object.fromEntries(rows.map(r => [r.d, r.u]));
        const expected = {'2026-05-11':165, '2026-05-12':103, '2026-05-13':134, '2026-05-14':130, '2026-05-15':83};
        assertEq('T_PLAN_DB_S4_units', 'DB', expected, got, 'S4 enheder pr. dag');
    }

    // T_PLAN_DB_kategori: S1 kategori-fordeling
    {
        const rows = sql(`
            SELECT b.delivery_date AS d, bl.category AS c, SUM(bl.quantity) AS u
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008 AND ${S1_FILTER}
            GROUP BY b.delivery_date, bl.category
            ORDER BY b.delivery_date, bl.category`);
        const got = rows.reduce((acc, r) => {
            (acc[r.d] = acc[r.d] || {})[r.c] = r.u;
            return acc;
        }, {});
        const expected = {
            '2026-05-11': {'01 Sandwich': 50, '06 Emballage': 53},
            '2026-05-12': {'01 Sandwich': 50, '06 Emballage': 53},
            '2026-05-13': {'01 Sandwich': 60, '02 Salat': 10, '06 Emballage': 64},
            '2026-05-14': {'01 Sandwich': 20, '02 Salat': 5,  '06 Emballage': 22},
        };
        assertEq('T_PLAN_DB_kategori', 'DB', expected, got, 'S1 kategori pr. dag');
    }
}

// ════════════════════════════════════════════════════════════
// Råvare-tests (8.3) — /api/bons/planning/ingredients
// ════════════════════════════════════════════════════════════
//
// Forudsætter at grocy_recipe_id er sat på bon_lines.
// Køres efter: npm run test:snapshot && npm run test:patch
//
// Hvis snapshot mangler: ING-tests SKIPpes (ikke FAIL).
// ════════════════════════════════════════════════════════════

async function runIngredientTests() {
    if (!shouldRun('ING')) return;
    console.log('\n── Råvare-tests (/api/bons/planning/ingredients) ──');

    if (!fs.existsSync(SNAPSHOT_PATH)) {
        record('T_PLAN_ING_*', 'ING', 'SKIP',
            `grocy_snapshot.json mangler — kør 'npm run test:snapshot && npm run test:patch' først`);
        return;
    }

    // T_PLAN_ING_08: GET uden ids → 400
    {
        // Via sessionen — en rå fetch rammer auth-gaten og giver 401, ikke 400.
        const r = await _session('GET', '/api/bons/planning/ingredients');
        assertEq('T_PLAN_ING_08', 'ING', 400, r.status, 'GET uden ids returnerer 400');
    }

    // T_PLAN_ING_07: GET med ids
    {
        const r = await api('/api/bons/planning/ingredients?ids=4001');
        assertEq('T_PLAN_ING_07_status', 'ING', 200, r.status, 'GET med ids OK');
        const hasFields = r.body && 'ingredients' in r.body && 'lines_without_recipe' in r.body;
        assertEq('T_PLAN_ING_07_shape', 'ING', true, hasFields, 'Response har påkrævede felter');
    }

    // T_PLAN_ING_04: Tom anmodning via POST
    {
        const r = await _session('POST', '/api/bons/planning/ingredients',
                                 { bon_ids: [], extra_lines: [] });
        const body = r.body || {};
        const isEmpty = body.ingredients?.length === 0 && body.groups?.length === 0;
        assertEq('T_PLAN_ING_04', 'ING', true, isEmpty, 'Tom anmodning → tomme arrays');
    }

    // T_PLAN_ING_01: 1 bon-id returnerer ingredienser
    {
        const r = await api('/api/bons/planning/ingredients?ids=4001');
        const hasIngredients = (r.body?.ingredients?.length || 0) > 0;
        assertEq('T_PLAN_ING_01', 'ING', true, hasIngredients,
            'Bon 4001 skal returnere ingredienser efter patch_grocy_recipe_ids');
    }

    // T_PLAN_ING_02: Flere bon_ids aggregerer på tværs
    {
        const r1 = await api('/api/bons/planning/ingredients?ids=4001');
        const r2 = await api('/api/bons/planning/ingredients?ids=4001,4003');
        const cnt1 = r1.body?.ingredients?.length || 0;
        const cnt2 = r2.body?.ingredients?.length || 0;
        // Aggregering kan resultere i flere unikke ingredienser eller samme antal
        // (hvis 4001 og 4003 deler ingredienser). Test at flere bons ≥ enkelt bon.
        assertEq('T_PLAN_ING_02', 'ING', true, cnt2 >= cnt1,
            `4001+4003 (${cnt2}) skal ≥ 4001 alene (${cnt1})`);
    }
}

// ════════════════════════════════════════════════════════════
// Pris/moms-tests (8.5) — DB-niveau
// ════════════════════════════════════════════════════════════

async function runPriceTests() {
    if (!shouldRun('PRICE')) return;
    console.log('\n── Pris/moms-tests ──');

    // T_PLAN_PRICE_06: DB% korrekt for S1 uge
    {
        const row = sql(`
            SELECT
                ROUND(SUM(bl.line_total) / 1.25, 2) AS oms_ex,
                ROUND(SUM(bl.cost_price * bl.quantity), 2) AS kost_ex
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008
              AND sd.code IN ('GODKENDT','IGANG','KLAR','LEVERET') AND b.is_offer=0`)[0];
        const db_pct = ((row.oms_ex - row.kost_ex) / row.oms_ex) * 100;
        const inRange = db_pct > 68.0 && db_pct < 68.6;
        assertEq('T_PLAN_PRICE_06', 'PRICE', true, inRange,
            `DB% = ${db_pct.toFixed(2)} (forventet ~68,3)`);
    }

    // T_PLAN_PRICE_moms: Moms-fordeling stemmer
    {
        const row = sql(`
            SELECT
                ROUND(SUM(bl.line_total), 2) AS incl,
                ROUND(SUM(bl.line_total) / 1.25, 2) AS ex,
                ROUND(SUM(bl.line_total) - (SUM(bl.line_total) / 1.25), 2) AS moms
            FROM bons b JOIN bon_lines bl ON bl.bon_id=b.id
            JOIN status_definitions sd ON b.status_id=sd.id
            WHERE b.id BETWEEN 4001 AND 4008
              AND sd.code IN ('GODKENDT','IGANG','KLAR','LEVERET') AND b.is_offer=0`)[0];
        assertEq('T_PLAN_PRICE_moms_incl', 'PRICE', 20220.00, row.incl, 'S1 uge incl');
        assertEq('T_PLAN_PRICE_moms_ex',   'PRICE', 16176.00, row.ex,   'S1 uge ex');
        assertEq('T_PLAN_PRICE_moms_amt',  'PRICE',  4044.00, row.moms, 'S1 uge moms');
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_PLAN_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['API','DB','ING','PRICE'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass:  inGroup.filter(r => r.status === 'PASS').length,
            fail:  inGroup.filter(r => r.status === 'FAIL').length,
            skip:  inGroup.filter(r => r.status === 'SKIP').length,
            fails: inGroup.filter(r => r.status === 'FAIL'),
        };
    }

    let md = `# T_PLAN — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** ${SERVER_URL} · DB: ${process.env.DB_PATH} · Grocy: ${process.env.GROCY_API_URL}\n\n`;
    md += `## Resumé\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `| Gruppe | PASS | FAIL | SKIP |\n|--------|-----:|-----:|-----:|\n`;
    for (const g of groups) {
        md += `| ${g} | ${byGroup[g].pass} | ${byGroup[g].fail} | ${byGroup[g].skip} |\n`;
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
    console.log(`\n[run_T_PLAN] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_PLAN] Server: ${SERVER_URL}`);

    await doLogin();
    if (ONLY) console.log(`[run_T_PLAN] Filtrerer: --only=${ONLY}`);

    // Verificer at server svarer
    try {
        const r = await api('/api/bons/planning?from=2026-05-11&to=2026-05-11');
        if (r.status !== 200) {
            console.error(`[run_T_PLAN] Server svarer ${r.status} — er test:server startet?`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_PLAN] Kan ikke nå server: ${err.message}`);
        console.error(`Start serveren med: npm run test:server`);
        process.exit(1);
    }

    await runApiTests();
    await runDbFacitTests();
    await runIngredientTests();
    await runPriceTests();

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_PLAN] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_PLAN] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
