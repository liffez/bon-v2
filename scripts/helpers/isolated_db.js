// scripts/helpers/isolated_db.js
// ============================================================
// Et test-script må ALDRIG røre udviklerens egen database (#516).
//
// HVORFOR DET SKER AF SIG SELV
// Scripterne mocker Grocy fuldstændigt og rører aldrig netværk. Men de kalder
// `grocyAdapter`, og adapteren slår lokationen op gennem
// `getGrocyConfig()` → `getDb()` → `runMigrations(data/bon.db)`. Stien er
// repo-absolut, så hverken en anden cwd eller en mock af fetch holder dem væk.
//
// Konsekvensen er todelt, og den anden er den værste:
//   1. Er der en ventende migration, MIGRERER en test udviklerens database —
//      uden at spørge, som en bivirkning af at køre en test.
//   2. Kan migrationen ikke køre (fx et omdøbt filnavn der allerede står i
//      `_migrations`), fejler testen af en grund der intet har med dens egen
//      logik at gøre: adapteren får intet lager, og hver assert melder
//      "fik undefined". Resultatet afhænger af hvilken maskine man sidder ved.
//
// HVAD DEN GØR
// Sætter `DB_PATH` til en tom fil i systemets temp-mappe FØR `db/database`
// indlæses, og rydder op når processen slutter. Skemaet bygges af de rigtige
// migrations, så en skemafejl stadig fanges — bare et sted hvor den ikke gør
// skade.
//
// Har kalderen selv sat `DB_PATH`, respekteres det (fx til fejlsøgning) —
// med mindre det peger på repoets egen `data/`, for så er det netop det vi
// beskytter imod, og et test-script skal ikke kunne omgå sin egen isolation.
//
// BRUG — første linje i scriptet, før require af db/, services/ eller routes/:
//
//   require('./helpers/isolated_db');
//
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_DATA = path.resolve(__dirname, '..', '..', 'data');

function insideRepoData(p) {
    const abs = path.resolve(p);
    return abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep);
}

const valgt = process.env.DB_PATH;
if (!valgt || insideRepoData(valgt)) {
    if (valgt) {
        console.warn(`[isolated_db] DB_PATH pegede på repoets data/ (${valgt}) — bruger en temp-database i stedet.`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bon-test-db-'));
    process.env.DB_PATH = path.join(dir, 'test.db');

    const ryd = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
    process.on('exit', ryd);
    // Ctrl+C og kill: ryd op, og lad signalet gøre sit arbejde bagefter.
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { ryd(); process.exit(sig === 'SIGINT' ? 130 : 143); });
    }
}

module.exports = { dbPath: () => process.env.DB_PATH, insideRepoData, REPO_DATA };
