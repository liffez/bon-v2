#!/usr/bin/env node
/**
 * tests/scripts/run_T_DB.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_DB-tracken — database-integritet.
 *
 * Verificerer schema, FK'er, views, constraints og determinisme.
 * Ingen server eller Grocy nødvendig.
 *
 * Usage:
 *   npm run test:run-db
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_DB.js --verbose
 *
 * Forudsætninger:
 *   - npm run test:reset er kørt (data/test.db findes med alle migrations + seed_planning)
 *
 * Reference: tests/specs/T_DB.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { execSync } = require('node:child_process');
const { openDb, transaction } = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const REPORT_DIR     = path.resolve(__dirname, '..', 'reports');
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const VERBOSE        = process.argv.includes('--verbose');

// ════════════════════════════════════════════════════════════
// Tracker
// ════════════════════════════════════════════════════════════

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
        record(id, group, 'FAIL',
            `${label}: forventet ${JSON.stringify(expected)}, fik ${JSON.stringify(actual)}`);
    }
}

function assertThrows(id, group, fn, expectedSubstring = null, label = '') {
    try {
        fn();
        record(id, group, 'FAIL', `${label}: forventet exception, men ingen blev kastet`);
    } catch (err) {
        if (expectedSubstring && !err.message.includes(expectedSubstring)) {
            record(id, group, 'FAIL', `${label}: exception kastet men besked '${err.message}' indeholder ikke '${expectedSubstring}'`);
        } else {
            record(id, group, 'PASS');
        }
    }
}

// ════════════════════════════════════════════════════════════
// 3.1 Schema-inventory
// ════════════════════════════════════════════════════════════

function runInventory(db) {
    console.log('\n── 3.1 Schema-inventory ──');

    // Migrations
    const migs = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get();
    assertEq('T_DB_INV_01', 'INV', 58, migs.c, 'Antal migrations');

    // User-tables (ekskl. sqlite_* og _* — _migrations er bookkeeping, _old_* er legacy)
    const tables = db.prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_%' ESCAPE '\\'`
    ).get();
    assertEq('T_DB_INV_02', 'INV', 58, tables.c, 'Antal user-tables');

    // Views
    const views = db.prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='view'`
    ).get();
    assertEq('T_DB_INV_03', 'INV', 11, views.c, 'Antal views');

    // Triggers
    const trgs = db.prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'`
    ).get();
    assertEq('T_DB_INV_04', 'INV', 4, trgs.c, 'Antal triggers');

    // _migrations.filename er unik
    const migDup = db.prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT filename) AS distinct_total FROM _migrations`
    ).get();
    assertEq('T_DB_INV_05', 'INV', migDup.total, migDup.distinct_total, '_migrations.filename unique');

    // Migration-filer matcher kørte migrations
    const dirFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const ranFiles = db.prepare('SELECT filename FROM _migrations ORDER BY filename').all().map(r => r.filename);
    assertEq('T_DB_INV_06', 'INV', dirFiles, ranFiles, 'Migration-filer = kørte migrations');
}

// ════════════════════════════════════════════════════════════
// 3.2 FK-integritet
// ════════════════════════════════════════════════════════════

function runForeignKeys(db) {
    console.log('\n── 3.2 FK-integritet ──');

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    assertEq('T_DB_FK_01', 'FK', [], violations, 'foreign_key_check violations');

    const fkOn = db.prepare('PRAGMA foreign_keys').get();
    assertEq('T_DB_FK_02', 'FK', 1, fkOn.foreign_keys, 'foreign_keys ON');
}

// ════════════════════════════════════════════════════════════
// 3.3 Views
// ════════════════════════════════════════════════════════════

function runViews(db) {
    console.log('\n── 3.3 Views ──');

    const views = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`
    ).all().map(r => r.name);

    const broken = [];
    for (const view of views) {
        try {
            db.prepare(`SELECT 1 FROM ${view} LIMIT 1`).all();
        } catch (err) {
            broken.push({ view, error: err.message });
        }
    }
    assertEq('T_DB_VIEW_01', 'VIEW', [], broken, 'Views med fejl');
}

// ════════════════════════════════════════════════════════════
// 3.4 Constraints
// ════════════════════════════════════════════════════════════

function runConstraints(db) {
    console.log('\n── 3.4 Constraints ──');

    // Kør alle constraint-tests inde i en transaction der altid rollback'es,
    // så vi ikke ændrer test.db permanent.
    db.exec('BEGIN');
    try {
        // Komplet bons-INSERT med alle NOT NULL felter — varierer kun det vi tester på.
        const fullBon = (overrides) => {
            const base = {
                bon_number: '99001',
                status_id: 1,
                location_id: 1,
                order_date: '2026-05-08',
                delivery_date: '2026-05-11',
                delivery_type: 'pickup',
                pax: 1,
                total_units: 1,
                total_price: 0,
                price_category: 'catering',
            };
            const data = { ...base, ...overrides };
            const cols = Object.keys(data).join(', ');
            const phs  = Object.keys(data).map(() => '?').join(', ');
            const vals = Object.values(data);
            return db.prepare(`INSERT INTO bons (${cols}) VALUES (${phs})`).run(...vals);
        };

        // T_DB_CHK_01: CHECK på bons.delivery_type
        assertThrows('T_DB_CHK_01', 'CHK', () => {
            fullBon({ delivery_type: 'ulovligt' });
        }, 'CHECK', 'CHECK på delivery_type');

        // T_DB_CHK_02: CHECK på users.role
        assertThrows('T_DB_CHK_02', 'CHK', () => {
            db.prepare(
                `INSERT INTO users (name, email, role) VALUES ('X', 'x@example.dk', 'hacker')`
            ).run();
        }, 'CHECK', 'CHECK på users.role');

        // T_DB_NN_01: NOT NULL på bons.bon_number
        assertThrows('T_DB_NN_01', 'NN', () => {
            fullBon({ bon_number: null });
        }, 'NOT NULL', 'NOT NULL bons.bon_number');

        // T_DB_NN_02: NOT NULL på bon_lines.product_name
        assertThrows('T_DB_NN_02', 'NN', () => {
            db.prepare(`
                INSERT INTO bon_lines (bon_id, quantity, unit, unit_price, line_total)
                VALUES (4001, 1, 'stk', 0, 0)
            `).run();
        }, 'NOT NULL', 'NOT NULL bon_lines.product_name');

        // T_DB_UQ_01: UNIQUE på bons.bon_number (4001 findes allerede i seed)
        assertThrows('T_DB_UQ_01', 'UQ', () => {
            fullBon({ bon_number: '4001' });
        }, 'UNIQUE', 'UNIQUE bons.bon_number');
    } finally {
        db.exec('ROLLBACK');
    }
}

// ════════════════════════════════════════════════════════════
// 3.5 Determinisme
// ════════════════════════════════════════════════════════════

function runDeterminism() {
    console.log('\n── 3.5 Determinisme ──');

    // Snapshot row-counts pr. tabel før reset
    const before = snapshotRowCounts();

    // Kør test:reset igen
    try {
        execSync('npm run test:reset', {
            cwd: path.resolve(__dirname, '..', '..'),
            stdio: 'pipe',
        });
    } catch (err) {
        record('T_DB_DET_01', 'DET', 'FAIL', `npm run test:reset fejlede: ${err.message}`);
        return;
    }

    const after = snapshotRowCounts();
    const diffs = [];
    for (const [table, count] of Object.entries(before)) {
        if (after[table] !== count) {
            diffs.push({ table, before: count, after: after[table] });
        }
    }
    assertEq('T_DB_DET_01', 'DET', [], diffs, 'Row-counts efter rerun af test:reset');
}

function snapshotRowCounts() {
    const db = openDb(process.env.DB_PATH);
    const tables = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_%' ESCAPE '\\'
         ORDER BY name`
    ).all().map(r => r.name);

    const counts = {};
    for (const t of tables) {
        try {
            counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
        } catch (err) {
            counts[t] = `ERR: ${err.message}`;
        }
    }
    db.close();
    return counts;
}

// ════════════════════════════════════════════════════════════
// 3.6 Indexes
// ════════════════════════════════════════════════════════════

function runIndexes(db) {
    console.log('\n── 3.6 Indexes ──');

    const indexes = db.prepare(
        `SELECT name, tbl_name FROM sqlite_master WHERE type='index'`
    ).all();

    function indexOn(table, columnSubstring) {
        return indexes.some(i =>
            i.tbl_name === table &&
            (i.name.toLowerCase().includes(columnSubstring.toLowerCase()) ||
             // SQLite auto-generates 'sqlite_autoindex_<table>_N' — vi kan ikke se kolonnen herfra
             i.name.startsWith('sqlite_autoindex_'))
        );
    }

    // Vi kan kigge i den faktiske CREATE INDEX-DDL via sqlite_master.sql
    function hasIndexOnColumn(table, column) {
        const ddl = db.prepare(
            `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql LIKE '%' || ? || '%'`
        ).all(table, column);
        return ddl.length > 0;
    }

    assertEq('T_DB_IDX_01', 'IDX', true, hasIndexOnColumn('bons', 'delivery_date'),
        'Index på bons.delivery_date');
    assertEq('T_DB_IDX_02', 'IDX', true, hasIndexOnColumn('bon_lines', 'bon_id'),
        'Index på bon_lines.bon_id');
    assertEq('T_DB_IDX_03', 'IDX', true, hasIndexOnColumn('changelog', 'entity_id'),
        'Index på changelog.entity_id');
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today      = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_DB_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['INV','FK','VIEW','CHK','NN','UQ','DET','IDX'];
    let md = `# T_DB — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_DB] Rapport: ${reportPath}`);
    return { passes, fails, skips, reportPath };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

function main() {
    safetyCheck();

    const db = openDb(process.env.DB_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    runInventory(db);
    runForeignKeys(db);
    runViews(db);
    runConstraints(db);
    runIndexes(db);
    db.close();

    // Determinisme kører test:reset igen — gøres til sidst så de andre tests kører mod
    // den oprindelige DB-state.
    runDeterminism();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_DB] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main();
