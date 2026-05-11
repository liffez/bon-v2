#!/usr/bin/env node
/**
 * tests/scripts/safety_check.js
 * ════════════════════════════════════════════════════════════
 * Validerer at det aktuelle miljø peger på TEST-mål, ikke prod.
 * Kaldes inden hver test-kørsel for at forhindre at runneren ramler
 * ind i produktionsdata.
 *
 * Tjekker:
 *   1. NODE_ENV === 'test'
 *   2. DB_PATH indeholder 'test'
 *   3. GROCY_API_URL indeholder 'test'
 *   4. BON_V1_DB_PATH må IKKE være sat (ingen v1-adgang under test)
 *   5. data/test.db eksisterer og er gyldig SQLite (springes over med --skip-db-check)
 *
 * Usage:
 *   CLI:    node tests/scripts/safety_check.js [--skip-db-check]
 *   Modul:  const safetyCheck = require('./safety_check');
 *           safetyCheck();              // alle tjek
 *           safetyCheck({ skipDb: true }); // spring DB-tjek over
 *
 * Exit-kode:
 *   0 — alle checks bestået
 *   2 — mindst ét check fejlede (beskrivelse til stderr)
 *
 * Reference: docs/CLAUDE_TESTPLAN.md §4.4
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

function safetyCheck(options = {}) {
    const skipDb = options.skipDb === true;
    const errors = [];

    // ── 1. NODE_ENV ──
    if (process.env.NODE_ENV !== 'test') {
        errors.push(
            `NODE_ENV er '${process.env.NODE_ENV || '(unset)'}' — skal være 'test'.`
            + ` Sæt NODE_ENV=test i .env.test eller eksportér før kørsel.`
        );
    }

    // ── 2. DB_PATH ──
    const dbPath = process.env.DB_PATH || '';
    if (!dbPath) {
        errors.push("DB_PATH er ikke sat.");
    } else if (!dbPath.includes('test')) {
        errors.push(
            `DB_PATH ('${dbPath}') indeholder ikke 'test' — afslår at køre mod muligvis prod-DB.`
            + ` Forventet noget i stil med 'data/test.db'.`
        );
    }

    // ── 3. GROCY_API_URL ──
    const grocyUrl = process.env.GROCY_API_URL || '';
    if (!grocyUrl) {
        errors.push("GROCY_API_URL er ikke sat.");
    } else if (!grocyUrl.includes('test')) {
        errors.push(
            `GROCY_API_URL ('${grocyUrl}') indeholder ikke 'test' — afslår at køre mod muligvis prod-Grocy.`
            + ` Forventet noget i stil med 'https://grocytest.ristetrug.dk/api'.`
        );
    }

    // ── 4. BON_V1_DB_PATH må ikke være sat ──
    if (process.env.BON_V1_DB_PATH) {
        errors.push(
            `BON_V1_DB_PATH er sat ('${process.env.BON_V1_DB_PATH}') — testen må ikke have adgang til v1-data.`
            + ` Fjern fra env eller .env.test.`
        );
    }

    // ── 5. test.db eksisterer og er gyldig SQLite (springes over hvis skipDb) ──
    if (!skipDb && dbPath && dbPath.includes('test')) {
        const absPath = path.resolve(dbPath);

        if (!fs.existsSync(absPath)) {
            errors.push(
                `Test-DB findes ikke: ${absPath}`
                + ` — kør 'npm run test:reset' først.`
            );
        } else {
            try {
                const fd  = fs.openSync(absPath, 'r');
                const buf = Buffer.alloc(16);
                fs.readSync(fd, buf, 0, 16, 0);
                fs.closeSync(fd);

                const magic = buf.toString('utf8', 0, 15);
                if (magic !== 'SQLite format 3') {
                    errors.push(
                        `Test-DB er ikke en gyldig SQLite-fil: ${absPath}`
                        + ` (magic header er '${magic}', forventet 'SQLite format 3')`
                    );
                }
            } catch (err) {
                errors.push(`Kunne ikke læse test-DB ${absPath}: ${err.message}`);
            }

            // ── 6. Locations-tabel: aktiv Grocy-URL skal pege på test-instans ──
            //
            // grocyAdapter (services/grocyAdapter.js:49-79) læser Grocy-URL fra
            // locations-tabellen, IKKE fra GROCY_API_URL env-var. Et env-tjek alene
            // ville derfor ikke beskytte mod at write-tests rammer prod-Grocy.
            // Det er sket én gang (maj 2026); siden er dette tjek tilføjet.
            try {
                const { openDb } = require('../../db/compat');
                const db = openDb(absPath);
                const setting = db.prepare(
                    `SELECT value FROM settings WHERE key = 'default_grocy_location_id'`
                ).get();
                let loc;
                if (setting && setting.value) {
                    loc = db.prepare(
                        `SELECT id, code, name, grocy_api_url FROM locations WHERE id = ?`
                    ).get(parseInt(setting.value));
                } else {
                    loc = db.prepare(
                        `SELECT id, code, name, grocy_api_url FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`
                    ).get();
                }
                db.close();

                if (!loc) {
                    errors.push(`Ingen aktiv Grocy-lokation fundet i ${absPath}.`);
                } else if (!loc.grocy_api_url || !loc.grocy_api_url.includes('test')) {
                    errors.push(
                        `Aktiv Grocy-lokation peger på '${loc.grocy_api_url}' `
                        + `(lokation ${loc.id}/${loc.code}/${loc.name}). `
                        + `URL'en skal indeholde 'test'. Sæt 'default_grocy_location_id=3' `
                        + `i settings, eller tilpas locations-tabellen. `
                        + `Test-tabeller modificerer Grocy-stock — afslår at køre mod prod.`
                    );
                }
            } catch (err) {
                errors.push(`Kunne ikke tjekke locations-tabellen i test-DB: ${err.message}`);
            }
        }
    }

    // ── Resultat ──
    if (errors.length) {
        console.error('');
        console.error('[safety_check] ABORT — testen kan ikke køre:');
        for (const e of errors) {
            console.error('  ✗ ' + e);
        }
        console.error('');
        process.exit(2);
    }
}

// CLI-mode: parse --skip-db-check, kør og print OK
if (require.main === module) {
    const skipDb = process.argv.includes('--skip-db-check');
    safetyCheck({ skipDb });
    const suffix = skipDb ? ' (DB-tjek sprunget over)' : '';
    console.log(`[safety_check] OK — miljø peger på test-mål.${suffix}`);
}

module.exports = safetyCheck;
