#!/usr/bin/env node
/**
 * tests/scripts/run_T_ECON.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_ECON — økonomi pr. bon.
 *
 * Verificerer moms-doktrin (BON_V2_PRINCIPPER §6b) og per-bon konsistens.
 * Kun DB-tests, ingen server.
 *
 * Usage:
 *   npm run test:run-econ
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt
 *
 * Reference: tests/specs/T_ECON.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const VERBOSE    = process.argv.includes('--verbose');

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

function assertClose(id, group, expected, actual, tol, label = '') {
    if (Math.abs(expected - actual) <= tol) {
        record(id, group, 'PASS');
    } else {
        record(id, group, 'FAIL', `${label}: forventet ${expected} ± ${tol}, fik ${actual}`);
    }
}

// ════════════════════════════════════════════════════════════
// 3.1 Per-bon konsistens
// ════════════════════════════════════════════════════════════

function runConsistencyTests(db) {
    console.log('\n── 3.1 Per-bon konsistens ──');

    // BON_01: total_price = SUM(line_total) for rigtige bons.
    // Tilbud ekskluderes: offer_price_mode='total'/'blok' sætter en manuel total der bevidst
    // afviger fra linjesummen (bon 4008 = total-mode tilbud, 4287.5 ≠ linjesum 4122.5).
    {
        const rows = db.prepare(`
            SELECT b.id, b.bon_number, b.total_price,
                   (SELECT ROUND(SUM(line_total), 2) FROM bon_lines WHERE bon_id = b.id) AS sum_lines
            FROM bons b WHERE b.id BETWEEN 4001 AND 4008 AND b.is_offer = 0
        `).all();
        const mismatches = rows.filter(r => Math.abs(r.total_price - r.sum_lines) > 0.01);
        assertEq('T_ECON_BON_01', 'BON', [], mismatches,
            `${rows.length} bonner: total_price vs SUM(line_total)`);
    }

    // BON_02: total_units = SUM(quantity)
    {
        const rows = db.prepare(`
            SELECT b.id, b.bon_number, b.total_units,
                   (SELECT SUM(quantity) FROM bon_lines WHERE bon_id = b.id) AS sum_qty
            FROM bons b WHERE b.id BETWEEN 4001 AND 4008
        `).all();
        const mismatches = rows.filter(r => r.total_units !== r.sum_qty);
        assertEq('T_ECON_BON_02', 'BON', [], mismatches,
            'total_units vs SUM(quantity)');
    }

    // BON_03: line_total = quantity × unit_price for alle 30 linjer
    {
        const rows = db.prepare(`
            SELECT bon_id, product_name, quantity, unit_price, line_total,
                   ROUND(quantity * unit_price, 2) AS calc
            FROM bon_lines WHERE bon_id BETWEEN 4001 AND 4008
        `).all();
        const mismatches = rows.filter(r => Math.abs(r.line_total - r.calc) > 0.01);
        assertEq('T_ECON_BON_03', 'BON', [], mismatches,
            `${rows.length} linjer: line_total vs quantity × unit_price`);
    }
}

// ════════════════════════════════════════════════════════════
// 3.2 Moms-beregning
// ════════════════════════════════════════════════════════════

function runMomsTests(db) {
    console.log('\n── 3.2 Moms-beregning ──');

    const bon4001 = db.prepare(`SELECT total_price FROM bons WHERE id = 4001`).get();

    // MOMS_01: incl-moms direkte fra DB
    assertEq('T_ECON_MOMS_01', 'MOMS', 5237.5, bon4001.total_price, 'Bon 4001 incl moms');

    // MOMS_02: ex-moms = incl / 1.25
    assertClose('T_ECON_MOMS_02', 'MOMS', 4190.00, bon4001.total_price / 1.25, 0.01, 'Bon 4001 ex moms');

    // MOMS_03: moms-andel = incl × 0.2
    assertClose('T_ECON_MOMS_03', 'MOMS', 1047.5, bon4001.total_price * 0.2, 0.01, 'Bon 4001 moms');

    // MOMS_04: Sum af bonner pr. uge stemmer (S4 = ekskl. AFLYST)
    {
        const row = db.prepare(`
            SELECT ROUND(SUM(total_price), 2) AS sum_incl,
                   ROUND(SUM(total_price) * 0.2, 2) AS sum_moms
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            WHERE b.id BETWEEN 4001 AND 4008 AND sd.code != 'AFLYST'
        `).get();
        // S4-totaler fra T_PLAN §7.4: 7 bonner ekskl. 4004. Summen er over bons.total_price.
        // Bon 4008 er et total-mode tilbud → dets total_price er 4287.5 (ikke linjesummen 4122.5);
        // den oprindelige forventning brugte fejlagtigt 4122.5. Korrekt sum:
        // 4001+4002+4003+4005+4006+4007+4008 = 5237.5 + 2485 + 5237.5 + 7090 + 2655 + 3807.5 + 4287.5 = 30800
        assertClose('T_ECON_MOMS_04_incl', 'MOMS', 30800.00, row.sum_incl, 0.01, 'S4 sum incl');
        assertClose('T_ECON_MOMS_04_moms', 'MOMS', 30800.00 * 0.2, row.sum_moms, 0.01, 'S4 moms-andel');
    }
}

// ════════════════════════════════════════════════════════════
// 3.3 Cost vs Revenue (margin)
// ════════════════════════════════════════════════════════════

function runMarginTests(db) {
    console.log('\n── 3.3 Margin ──');

    // MGN_01: Bon 4001 — revenue_ex = 4190, cost_ex = 1334, margin% ≈ 68.2
    {
        const row = db.prepare(`
            SELECT ROUND(SUM(line_total) / 1.25, 2) AS rev_ex,
                   ROUND(SUM(cost_price * quantity), 2) AS cost_ex
            FROM bon_lines WHERE bon_id = 4001
        `).get();
        assertClose('T_ECON_MGN_01_rev',  'MGN', 4190.00, row.rev_ex,  0.01, 'Bon 4001 revenue_ex');
        assertClose('T_ECON_MGN_01_cost', 'MGN', 1334.00, row.cost_ex, 0.01, 'Bon 4001 cost_ex');
        const marginPct = ((row.rev_ex - row.cost_ex) / row.rev_ex) * 100;
        assertClose('T_ECON_MGN_01_pct',  'MGN', 68.2, marginPct, 0.5, 'Bon 4001 margin%');
    }

    // MGN_02: Alle 8 bonner skal have positiv margin (DB%)
    {
        const rows = db.prepare(`
            SELECT b.bon_number,
                   ROUND(SUM(bl.line_total) / 1.25, 2) AS rev_ex,
                   ROUND(SUM(bl.cost_price * bl.quantity), 2) AS cost_ex
            FROM bons b JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE b.id BETWEEN 4001 AND 4008
            GROUP BY b.id, b.bon_number
        `).all();
        const negative = rows.filter(r => r.rev_ex > 0 && (r.rev_ex - r.cost_ex) <= 0);
        assertEq('T_ECON_MGN_02', 'MGN', [], negative,
            'Bonner med ikke-positiv margin');
    }
}

// ════════════════════════════════════════════════════════════
// 3.4 Snapshot-natur
// ════════════════════════════════════════════════════════════

function runSnapshotTests(db) {
    console.log('\n── 3.4 Snapshot-natur ──');

    // SNAP_01: Falaflen i seed har unit_price=104, cost_price=25
    {
        const rows = db.prepare(`
            SELECT bon_id, unit_price, cost_price
            FROM bon_lines WHERE product_name = 'Falaflen' AND bon_id BETWEEN 4001 AND 4008
        `).all();
        const wrong = rows.filter(r => r.unit_price !== 104 || r.cost_price !== 25);
        assertEq('T_ECON_SNAP_01', 'SNAP', [], wrong,
            `Alle Falaflen-linjer skal have unit_price=104, cost_price=25 (fandt ${rows.length})`);
    }

    // SNAP_02: RR Boks unit_price=0 (emballage er gratis i salgsprisen), cost_price=1.50
    {
        const rows = db.prepare(`
            SELECT bon_id, unit_price, cost_price
            FROM bon_lines WHERE product_name = 'RR Boks' AND bon_id BETWEEN 4001 AND 4008
        `).all();
        const wrong = rows.filter(r => r.unit_price !== 0 || r.cost_price !== 1.5);
        assertEq('T_ECON_SNAP_02', 'SNAP', [], wrong,
            `Alle RR Boks-linjer skal have unit_price=0, cost_price=1.5 (fandt ${rows.length})`);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_ECON_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['BON','MOMS','MGN','SNAP'];
    let md = `# T_ECON — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** DB: ${process.env.DB_PATH}\n\n`;
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
    console.log(`\n[run_T_ECON] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

function main() {
    safetyCheck();

    const db = openDb(process.env.DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    runConsistencyTests(db);
    runMomsTests(db);
    runMarginTests(db);
    runSnapshotTests(db);

    db.close();
    const { passes, fails } = writeReport();
    console.log(`\n[run_T_ECON] ${passes} PASS · ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
}

main();
