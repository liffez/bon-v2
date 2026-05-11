#!/usr/bin/env node
/**
 * tests/scripts/run_T_INPUT.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_INPUT — bon-oprettelse.
 *
 * Tester POST /api/bons, POST /api/bons/:id/lines,
 * /api/webhooks/bestilling (legacy), /webhook/bestilling (nyt).
 *
 * Usage:
 *   npm run test:run-input
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt
 *   - npm run test:server kører på port 4322
 *
 * Reference: tests/specs/T_INPUT.md
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

function assertTrue(id, group, condition, label = '') {
    if (condition) record(id, group, 'PASS');
    else           record(id, group, 'FAIL', label);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${SERVER_URL}${pathPart}`, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════
// 2.1 POST /api/bons — manuel oprettelse
// ════════════════════════════════════════════════════════════

async function runManualTests() {
    console.log('\n── 2.1 POST /api/bons ──');

    // M_01: Minimal body
    let createdId = null;
    {
        const r = await api('POST', '/api/bons', { delivery_date: '2026-06-01' });
        if (r.status !== 201) {
            record('T_INPUT_M_01', 'M', 'FAIL', `Forventede 201, fik ${r.status}`);
        } else {
            assertEq('T_INPUT_M_01', 'M', 'NY', r.body?.status_code, 'Default status er NY');
            createdId = r.body?.id;
        }
    }

    // M_02: Uden delivery_date
    {
        const r = await api('POST', '/api/bons', {});
        assertEq('T_INPUT_M_02', 'M', 400, r.status, 'Uden delivery_date returnerer 400');
    }

    // M_03: bon_number genereret
    {
        const r = await api('POST', '/api/bons', { delivery_date: '2026-06-02' });
        const ok = r.status === 201 && typeof r.body?.bon_number === 'string' && r.body.bon_number.length > 0;
        assertTrue('T_INPUT_M_03', 'M', ok, `bon_number = ${JSON.stringify(r.body?.bon_number)}`);
    }

    // M_04: customer_id linker
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: '2026-06-03',
            customer_id: 9001,  // fra seed_planning
            company_id: 9001,
        });
        const ok = r.status === 201 && r.body?.customer_id === 9001 && r.body?.company_id === 9001;
        assertTrue('T_INPUT_M_04', 'M', ok, `customer/company linket: ${ok}`);
    }

    // M_05: changelog skrives
    if (createdId) {
        const cl = db.prepare(
            `SELECT * FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='create' ORDER BY id DESC LIMIT 1`
        ).get(createdId);
        assertTrue('T_INPUT_M_05', 'M', !!cl, 'changelog create-entry findes');
    } else {
        record('T_INPUT_M_05', 'M', 'SKIP', 'Setup fejlede i M_01');
    }

    // M_06: klient-supplied total_price ignoreres
    {
        const r = await api('POST', '/api/bons', {
            delivery_date: '2026-06-04',
            total_price: 99999,
        });
        // Server skal beregne via recalcBonTotal — uden linjer er total_price=0
        assertEq('T_INPUT_M_06', 'M', 0, r.body?.total_price, 'total_price = 0 (server-autoritativ)');
    }
}

// ════════════════════════════════════════════════════════════
// 2.2 POST /api/bons/:id/lines
// ════════════════════════════════════════════════════════════

async function runLineTests() {
    console.log('\n── 2.2 POST /api/bons/:id/lines ──');

    // Opret en frisk bon
    const create = await api('POST', '/api/bons', { delivery_date: '2026-06-10', price_category: 'catering' });
    const bonId  = create.body?.id;
    if (!bonId) {
        record('T_INPUT_L_*', 'L', 'SKIP', 'Kunne ikke oprette bon til linje-tests');
        return;
    }

    // L_01: Tilføj linje opdaterer total_price
    {
        const r = await api('POST', `/api/bons/${bonId}/lines`, {
            product_name: 'Test-vare',
            category:     '01 Sandwich',
            quantity:     5,
            unit:         'stk',
            unit_price:   100,
            cost_price:   25,
        });
        if (r.status !== 201) {
            record('T_INPUT_L_01', 'L', 'FAIL', `Linje-POST returnerede ${r.status}`);
        } else {
            // Hent bon efter og verificér total_price
            const bon = await api('GET', `/api/bons/${bonId}`);
            assertEq('T_INPUT_L_01', 'L', 500, bon.body?.total_price,
                `total_price = quantity × unit_price (5 × 100)`);
        }
    }

    // L_02: Linje uden product_name
    {
        const r = await api('POST', `/api/bons/${bonId}/lines`, {
            quantity: 1, unit: 'stk', unit_price: 50,
        });
        assertEq('T_INPUT_L_02', 'L', 400, r.status, 'Manglende product_name → 400');
    }

    // L_03: Linje med quantity=0
    {
        const r = await api('POST', `/api/bons/${bonId}/lines`, {
            product_name: 'Nul-vare', quantity: 0, unit: 'stk', unit_price: 0,
        });
        assertEq('T_INPUT_L_03', 'L', 201, r.status, 'Linje med 0/0 accepteres');
    }
}

// ════════════════════════════════════════════════════════════
// 2.3 Formbuilder webhook (legacy)
// ════════════════════════════════════════════════════════════

async function runWebhookLegacyTests() {
    console.log('\n── 2.3 Formbuilder webhook (legacy) ──');

    const countBefore = () => db.prepare('SELECT COUNT(*) AS c FROM bons').get().c;

    // W_01: Komplet body opretter bon
    {
        const before = countBefore();
        const r = await api('POST', '/api/webhooks/bestilling', {
            f2: 'Per Hansen',
            f5: 'T_INPUT-Firma',
            f7_date: '2026-06-15',
            f7_time: '12:00',
            f8: 30,
            f9: 'Levering venligst tidlig',
            f12: '5798009811578',  // EAN
        });
        const after = countBefore();
        const ok = r.status === 200 && after === before + 1;
        assertTrue('T_INPUT_W_01', 'W', ok, `200 OK + bon oprettet (før=${before}, efter=${after})`);
    }

    // W_02: Honeypot
    {
        const before = countBefore();
        const r = await api('POST', '/api/webhooks/bestilling', {
            f2: 'Bot Botson', f7_date: '2026-06-16', f7_time: '12:00',
            website: 'https://spam.example.com',
        });
        const after = countBefore();
        const ok = r.status === 200 && after === before;
        assertTrue('T_INPUT_W_02', 'W', ok, `Honeypot ignoreret (før=${before}, efter=${after})`);
    }

    // W_03: Manglende felter
    {
        const before = countBefore();
        const r = await api('POST', '/api/webhooks/bestilling', { f2: 'Mangler dato' });
        const after = countBefore();
        const ok = r.status === 200 && after === before;
        assertTrue('T_INPUT_W_03', 'W', ok, `Manglende felter → 200 men ingen bon`);
    }

    // W_04: EAN udtrækkes (verificér via DB efter W_01)
    {
        const company = db.prepare(`SELECT ean FROM companies WHERE name = 'T_INPUT-Firma'`).get();
        assertEq('T_INPUT_W_04', 'W', '5798009811578', company?.ean, 'EAN gemt på firma');
    }
}

// ════════════════════════════════════════════════════════════
// 2.4 Web-orders webhook (nyt format)
// ════════════════════════════════════════════════════════════

async function runWebhookNewTests() {
    console.log('\n── 2.4 Web-orders webhook ──');

    const countBefore = () => db.prepare('SELECT COUNT(*) AS c FROM bons').get().c;

    // O_01: Komplet body
    {
        const before = countBefore();
        const r = await api('POST', '/webhook/bestilling', {
            first_name:   'Alma',
            last_name:    'Andersen',
            email:        'alma@example.dk',
            phone:        '+45 12 34 56 78',
            delivery_date: '2026-06-20',
            delivery_time: '11:30',
            pax:           20,
            company:       'T_INPUT-Web-firma',
            customer_wishes: 'Vegansk venligst',
        });
        const after = countBefore();
        // Webhook svarer altid 200; bon oprettes hvis felter er gyldige
        const ok = r.status === 200 && after === before + 1;
        assertTrue('T_INPUT_O_01', 'O', ok, `200 OK + bon oprettet (før=${before}, efter=${after})`);
    }

    // O_02: Manglende delivery_date
    {
        const before = countBefore();
        const r = await api('POST', '/webhook/bestilling', {
            first_name: 'Per', email: 'per@example.dk',
            delivery_time: '11:30',  // mangler delivery_date
        });
        const after = countBefore();
        const ok = r.status === 200 && after === before;
        assertTrue('T_INPUT_O_02', 'O', ok, `Manglende delivery_date → 200 men ingen bon`);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_INPUT_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['M','L','W','O'];
    let md = `# T_INPUT — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_INPUT] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    try {
        const r = await api('GET', '/api/statuses');
        if (r.status !== 200) {
            console.error(`[run_T_INPUT] Server svarer ${r.status} — er test:server startet?`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_INPUT] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    await runManualTests();
    await runLineTests();
    await runWebhookLegacyTests();
    await runWebhookNewTests();

    db.close();
    const { passes, fails } = writeReport();
    console.log(`\n[run_T_INPUT] ${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_INPUT] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
