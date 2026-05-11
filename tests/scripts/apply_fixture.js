#!/usr/bin/env node
/**
 * tests/scripts/apply_fixture.js
 * ════════════════════════════════════════════════════════════
 * Anvender en SQL-fixture-fil mod test-DB'en via node:sqlite.
 *
 * Eksisterer fordi db/seed.js har hard-kodet seed-data og ikke
 * understøtter --fixture=...-flag. Dette script kører bare en
 * vilkårlig .sql-fil mod $DB_PATH.
 *
 * Usage:
 *   node --env-file=.env.test --experimental-sqlite \
 *       tests/scripts/apply_fixture.js tests/fixtures/seed_planning.sql
 *
 * Sikkerhed: kalder safety_check først (NODE_ENV=test, DB_PATH
 * skal indeholde 'test'). Aborterer ellers før der røres ved DB.
 *
 * Reference: tests/specs/T_PLAN.md, docs/CLAUDE_TESTPLAN.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

const fixturePath = process.argv[2];
if (!fixturePath) {
    console.error('Brug: apply_fixture.js <sti-til-fixture.sql>');
    process.exit(1);
}

const absPath = path.resolve(fixturePath);
if (!fs.existsSync(absPath)) {
    console.error(`Fixture findes ikke: ${absPath}`);
    process.exit(1);
}

// Validér miljø før vi rør DB'en (men spring DB-tjek over — det er normalt
// at DB'en ikke findes endnu hvis test:reset lige har slettet den)
safetyCheck({ skipDb: true });

const db = openDb(process.env.DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const sql = fs.readFileSync(absPath, 'utf8');

try {
    db.exec(sql);
    console.log(`[apply_fixture] ✓ ${path.basename(absPath)} anvendt mod ${process.env.DB_PATH}`);
} catch (err) {
    console.error(`[apply_fixture] FEJL: ${err.message}`);
    process.exit(1);
} finally {
    db.close();
}
