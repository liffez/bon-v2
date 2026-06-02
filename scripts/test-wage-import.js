// scripts/test-wage-import.js
// ==========================================
// Unit-tests for løn-CSV-import (driftsregnskab, spec CLAUDE_DRIFTSREGNSKAB §9).
// Dækker routes/wage_rates.js' _test-exports: parseWageCsv, importWageRows,
// rebuildChain — mod en ISOLERET temp-DB + en SYNTETISK roster.
//
// VIGTIGT: satserne her er OPDIGTEDE. Rigtige lønninger hører ikke i git —
// de importeres via Settings → Løn i drift. Skabelonen docs/loensatser_skabelon.csv
// er bevidst tom (assertion herunder bekræfter at den importerer 0 rækker).
//
// Kør med:
//   node --experimental-sqlite scripts/test-wage-import.js
// ==========================================

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-wage-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
delete process.env.SMARTPLAN_CLIENT_ID;   // ingen Smartplan-kald i denne test

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);
const { getDb } = require('../db/database');
const db = getDb();

const { parseWageCsv, importWageRows, rebuildChain } = require('../routes/wage_rates')._test;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function approx(a, b, msg) { assert(Math.abs(Number(a) - Number(b)) < 1e-6, `${msg} (fik ${a}, forventet ${b})`); }

// Syntetisk roster (som Smartplan /members/ ville give). To "Anne'r" deler
// initialer AL → AL er IKKE entydig og må ikke bruges til match.
const ROSTER = [
    { uuid: 'u-anne',  name: 'Anne Lindhardt',         initials: 'AL', active: true },
    { uuid: 'u-anne2', name: 'Anne Sofie B Lindhardt', initials: 'AL', active: true },
    { uuid: 'u-simon', name: 'Simon Jensen',           initials: 'SJ', active: true },
    { uuid: 'u-klara', name: 'Klara Grundsøe',         initials: 'KG', active: true },
];
const TODAY = '2026-06-02';

console.log('\n── parseWageCsv ──');
{
    const csv = [
        'navn,initialer,timeloen,gyldig_fra',
        'Anne Lindhardt,AL,180,2026-01-01',
        'Simon Jensen,SJ,195.50,2026-01-01',
        'Tom Rate,TR,,2026-01-01',          // ingen sats → springes over
    ].join('\n');
    const { rows, error } = parseWageCsv(csv);
    assert(error === null, 'gyldig CSV → ingen fejl');
    assert(rows.length === 2, 'rækker uden sats springes over (2 af 3)');
    approx(rows[1].timeloen, 195.5, 'engelsk decimal (195.50) parses');
}
{
    const { rows } = parseWageCsv('navn;initialer;timeloen;gyldig_fra\nSimon Jensen;SJ;1.250,75;2026-01-01');
    approx(rows[0].timeloen, 1250.75, 'semikolon-delim + dansk tusind/decimal (1.250,75)');
}
{
    const { rows } = parseWageCsv('navn,timeloen\nSimon Jensen,"182,50"');
    approx(rows[0].timeloen, 182.5, 'citeret felt + decimalkomma');
}
{
    const { error } = parseWageCsv('navn,initialer,gyldig_fra\nSimon,SJ,2026-01-01');
    assert(/mangler kolonner/i.test(error || ''), 'manglende timeloen-kolonne → fejl');
}

console.log('\n── importWageRows (match + upsert) ──');
{
    const { rows } = parseWageCsv([
        'navn,initialer,timeloen,gyldig_fra',
        'Anne Lindhardt,AL,180,2026-01-01',     // match på navn
        'Simon Jensen,SJ,195,2026-01-01',       // match på navn
        ',KG,170,2026-01-01',                   // match på entydig initial KG
        ',AL,180,2026-01-01',                   // KUN tvetydig initial AL → unmatched
        'Ukendt Person,XX,200,2026-01-01',      // ingen i roster → unmatched
    ].join('\n'));
    const res = importWageRows(db, rows, ROSTER, TODAY);
    assert(res.imported === 3, '3 importeret (Anne, Simon, Klara via entydig initial)');
    assert(res.unmatched.length === 2, '2 unmatched (tvetydig AL + Ukendt Person)');
    const cnt = db.prepare('SELECT COUNT(*) c FROM wage_rates').get().c;
    assert(cnt === 3, 'DB har 3 wage_rates-rækker');
    const anne = db.prepare("SELECT * FROM wage_rates WHERE smartplan_ref='u-anne'").get();
    approx(anne.hourly_rate, 180, 'Annes sats gemt');
    assert(anne.employee_name === 'Anne Lindhardt', 'navn snapshot fra roster (ikke CSV)');
}
{
    // Upsert: samme person + dato, ny sats → opdaterer (ingen dublet)
    const { rows } = parseWageCsv('navn,timeloen,gyldig_fra\nAnne Lindhardt,185,2026-01-01');
    importWageRows(db, rows, ROSTER, TODAY);
    const annes = db.prepare("SELECT * FROM wage_rates WHERE smartplan_ref='u-anne'").all();
    assert(annes.length === 1, 'upsert: ingen dublet på (ref, valid_from)');
    approx(annes[0].hourly_rate, 185, 'upsert opdaterede satsen');
}
{
    // Ugyldig dato → invalid, ikke importeret
    const { rows } = parseWageCsv('navn,timeloen,gyldig_fra\nSimon Jensen,200,ikke-en-dato');
    const res = importWageRows(db, rows, ROSTER, TODAY);
    assert(res.invalid.length === 1 && res.imported === 0, 'ugyldig dato → invalid, ikke importeret');
}
{
    // Tom gyldig_fra → default til today
    const fresh = '2026-06-02';
    const { rows } = parseWageCsv('navn,timeloen\nKlara Grundsøe,170');
    importWageRows(db, rows, ROSTER, fresh);
    const k = db.prepare("SELECT valid_from FROM wage_rates WHERE smartplan_ref='u-klara' AND valid_from=?").get(fresh);
    assert(!!k, 'tom gyldig_fra → default til today');
}

console.log('\n── rebuildChain (valid_to-kæde) ──');
{
    // Simon får en NY sats fra senere dato → kæden skal lukke den gamle
    const { rows } = parseWageCsv('navn,timeloen,gyldig_fra\nSimon Jensen,210,2026-09-01');
    importWageRows(db, rows, ROSTER, TODAY);   // importWageRows kalder selv rebuildChain
    const simons = db.prepare(
        "SELECT valid_from, valid_to FROM wage_rates WHERE smartplan_ref='u-simon' ORDER BY valid_from"
    ).all();
    assert(simons.length === 2, 'Simon har nu to satser (historik bevaret)');
    assert(simons[0].valid_to === '2026-09-01', 'gammel sats lukkes ved næste valid_from');
    assert(simons[1].valid_to === null, 'nyeste sats er åben (valid_to=NULL)');
}

console.log('\n── Skabelon-CSV importerer intet (docs/loensatser_skabelon.csv) ──');
{
    const tmpl = fs.readFileSync(path.join(__dirname, '..', 'docs', 'loensatser_skabelon.csv'), 'utf8');
    const { rows, error } = parseWageCsv(tmpl);
    assert(error === null, 'skabelon parses uden fejl');
    assert(rows.length === 0, 'tom timeloen-kolonne → 0 rækker (forklarer hvorfor tom skabelon seeder intet)');
}

try { fs.unlinkSync(TEST_DB); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
