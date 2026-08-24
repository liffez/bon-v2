#!/usr/bin/env node
// scripts/check-frozen-zero-labor.js
// ============================================================
// Find dage der blev FROSSET uden løn, fordi Smartplan var utilgængelig.
//
// Indtil august 2026 slugte smartplanAdapter enhver fejl som en tom liste
// (`.catch(() => [])`). Blev en afsluttet dag vist i netop dét øjeblik — fx
// mens Smartplan throttlede os med 429 — frøs driftsregnskabet "0 kr løn" ind
// i labor_day_snapshot, permanent, uden at noget sagde fra. Værnet findes nu,
// men det gælder kun fremad; det der allerede er frosset, retter sig ikke selv.
//
// Scriptet SKRIVER ALDRIG. Det peger på de dage der bør genberegnes med
// "Genberegn dagen" i driftsregnskabet (admin) når Smartplan svarer igen.
//
// Kør:  node --experimental-sqlite scripts/check-frozen-zero-labor.js
//       node --experimental-sqlite scripts/check-frozen-zero-labor.js --json
// ============================================================

const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || './data/bon.db';
const asJson  = process.argv.includes('--json');

const db = openDb(DB_PATH);

const rows = db.prepare(`
    SELECT snapshot_date, mode, frozen_at, data_json
      FROM labor_day_snapshot
     ORDER BY snapshot_date DESC
`).all();

const suspect = [];
for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data_json); } catch { continue; }
    const shifts  = Array.isArray(d.labor_rows) ? d.labor_rows.length : 0;
    const revenue = Number(d.revenue_ex_moms) || 0;
    const units   = Number(d.units) || 0;

    // Mistænkelig = frosset uden en eneste vagt, men med aktivitet på dagen.
    // En stille dag UDEN omsætning og UDEN enheder er sandsynligvis bare en
    // lukkedag, og den skal ikke fylde i listen — ellers drukner de ægte.
    if (shifts === 0 && (revenue > 0 || units > 0)) {
        suspect.push({
            date: r.snapshot_date, mode: r.mode, frozen_at: r.frozen_at,
            revenue_ex_moms: revenue, units,
            labor_ex_moms: Number(d.labor_ex_moms) || 0,
            labor_error: d.labor_error || null,
        });
    }
}

if (asJson) {
    console.log(JSON.stringify({ frozen_total: rows.length, suspect }, null, 2));
} else {
    console.log(`\nFrosne dage i alt: ${rows.length}`);
    if (!suspect.length) {
        console.log('\x1b[32m✓ Ingen dage er frosset uden vagter. Intet at gøre.\x1b[0m\n');
    } else {
        console.log(`\x1b[33m⚠ ${suspect.length} dag(e) er frosset UDEN en eneste vagt, men med aktivitet:\x1b[0m\n`);
        console.log('  dato        omsætning     enheder   frosset');
        for (const s of suspect) {
            console.log(`  ${s.date}  ${String(Math.round(s.revenue_ex_moms)).padStart(9)} kr  ${String(s.units).padStart(7)}   ${s.frozen_at}`);
        }
        console.log('\n  Lønnen i disse dage står som 0 kr. Var der reelt ingen på arbejde,');
        console.log('  er tallet rigtigt og der er intet at gøre. Var der vagter, blev de tabt');
        console.log('  fordi Smartplan ikke svarede da dagen blev frosset.');
        console.log('\n  Ret op: åbn dagen i Driftsregnskab og tryk "Genberegn dagen" (admin).');
        console.log('  Den afviser nu selv at fryse hvis Smartplan stadig er utilgængelig.\n');
    }
}
db.close();
