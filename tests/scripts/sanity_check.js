#!/usr/bin/env node
/**
 * tests/scripts/sanity_check.js
 * ════════════════════════════════════════════════════════════
 * Verificerer at seed_planning.sql er anvendt korrekt.
 * Kører de 5 sanity-queries fra fixture-filens §5 og rapporterer.
 *
 * Usage:
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/sanity_check.js
 *
 * Reference: tests/fixtures/seed_planning.sql §5
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { openDb }  = require('../../db/compat');
const safetyCheck = require('./safety_check');

safetyCheck();

const db = openDb(process.env.DB_PATH);

function check(label, query, expected) {
    const rows = db.prepare(query).all();
    const got  = JSON.stringify(rows);
    const exp  = JSON.stringify(expected);
    const ok   = got === exp;
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) {
        console.log(`   forventet: ${exp}`);
        console.log(`   fik:       ${got}`);
    }
    return ok;
}

let passes = 0, fails = 0;

// A) Total bonner = 8
if (check(
    'A) 8 bonner i 4001-4008',
    'SELECT COUNT(*) AS c FROM bons WHERE id BETWEEN 4001 AND 4008',
    [{ c: 8 }]
)) passes++; else fails++;

// B) Total bon-linjer = 30
if (check(
    'B) 30 bon-linjer',
    'SELECT COUNT(*) AS c FROM bon_lines WHERE bon_id BETWEEN 4001 AND 4008',
    [{ c: 30 }]
)) passes++; else fails++;

// B2) Antal tilbud = 1
if (check(
    'B2) 1 tilbud (4008)',
    'SELECT COUNT(*) AS c FROM bons WHERE is_offer=1 AND id BETWEEN 4001 AND 4008',
    [{ c: 1 }]
)) passes++; else fails++;

// C) Sum enheder pr. dag (ekskl. AFLYST)
if (check(
    'C) Enheder pr. dag (ekskl. AFLYST)',
    `SELECT b.delivery_date AS d, SUM(bl.quantity) AS u
     FROM bons b JOIN bon_lines bl ON bl.bon_id = b.id
     WHERE b.id BETWEEN 4001 AND 4008
       AND b.status_id != (SELECT id FROM status_definitions WHERE code='AFLYST')
     GROUP BY b.delivery_date ORDER BY b.delivery_date`,
    [
        { d: '2026-05-11', u: 165 },
        { d: '2026-05-12', u: 103 },
        { d: '2026-05-13', u: 134 },
        { d: '2026-05-14', u: 130 },
        { d: '2026-05-15', u: 83  },
    ]
)) passes++; else fails++;

// D) total_price på bons matcher SUM(line_total)
{
    const rows = db.prepare(`
        SELECT b.bon_number, b.total_price,
               (SELECT ROUND(SUM(line_total), 2) FROM bon_lines WHERE bon_id = b.id) AS sum_lines
        FROM bons b WHERE b.id BETWEEN 4001 AND 4008
        ORDER BY b.id`).all();
    const mismatches = rows.filter(r => Math.abs(r.total_price - r.sum_lines) > 0.005);
    if (mismatches.length === 0) {
        console.log('✓ D) total_price = SUM(line_total) for alle bonner');
        passes++;
    } else {
        console.log('✗ D) total_price ≠ SUM(line_total):');
        for (const r of mismatches) console.log(`   ${r.bon_number}: total=${r.total_price}, sum=${r.sum_lines}`);
        fails++;
    }
}

// E) total_units på bons matcher SUM(quantity)
{
    const rows = db.prepare(`
        SELECT b.bon_number, b.total_units,
               (SELECT SUM(quantity) FROM bon_lines WHERE bon_id = b.id) AS sum_qty
        FROM bons b WHERE b.id BETWEEN 4001 AND 4008
        ORDER BY b.id`).all();
    const mismatches = rows.filter(r => r.total_units !== r.sum_qty);
    if (mismatches.length === 0) {
        console.log('✓ E) total_units = SUM(quantity) for alle bonner');
        passes++;
    } else {
        console.log('✗ E) total_units ≠ SUM(quantity):');
        for (const r of mismatches) console.log(`   ${r.bon_number}: total=${r.total_units}, sum=${r.sum_qty}`);
        fails++;
    }
}

db.close();

console.log(`\nSanity check: ${passes} PASS · ${fails} FAIL`);
process.exit(fails > 0 ? 1 : 0);
