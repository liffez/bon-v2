// scripts/test-horkram-salesunit.js
// ════════════════════════════════════════════════════════════
// Regressionstest for #419 — gætter kurven salgsenheden?
//
// PUT /api/horkram/basket/add slog salgsenheden op via Hørkrams snapshot.
// Kom der intet svar, sendte den alligevel — med `SalesUnitIndex: ?? 0` og
// `Code: || 'st'`. Hoka tog imod PUT'en og markerede linjen ugyldig, så
// fejlen dukkede op ovre hos dem, i deres ord ("fjern og tilføj produktet
// på ny"), efter at Bon v2 havde sagt "lagt i kurv". Rådet virker ikke:
// varenummeret er dødt, så samme forsøg giver samme resultat hver gang.
//
// 12 af 137 Hørkram-koblinger i grocy-hq havde døde varenumre 9. august.
//
// Kør:
//   node scripts/test-horkram-salesunit.js
// ════════════════════════════════════════════════════════════
'use strict';

const { resolveSalesUnits } = require('../routes/horkram');

let pass = 0, fail = 0;
const ok = (cond, msg) => cond
    ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${msg}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${msg}`));

const snap = (id, units) => [String(id), { Id: id, SalesUnits: { Values: units } }];

// Testen skal FEJLE når koden gætter igen — ikke crashe. Uden det her kaster
// et tomt `rejected` en TypeError, og en stak-udskrift er et dårligere signal
// end en rød linje der siger hvad der gik galt.
const at = (arr, i) => (arr && arr[i]) || {};

console.log('\nHørkram-kurv: gætter vi salgsenheden? (#419)\n');

/* ── S1 · Kendt vare: enheden opløses som før ────────────────── */
console.log('S1 · Kendt vare — uændret adfærd');
{
    const map = new Map([snap(1001, [
        { Code: 'st', Quantity: 1, IsDefault: true },
        { Code: 'ks', Quantity: 12 },
    ])]);
    const { resolved, rejected } = resolveSalesUnits(
        [{ varenummer: 1001, quantity: 2, salesUnitCode: 'ks' }], map, new Set());
    ok(rejected.length === 0, 'ingen afvisning');
    ok(resolved.length === 1, 'varen er med');
    ok(resolved[0]._salesUnitIndex === 1, `index peger på 'ks' — fik ${resolved[0]._salesUnitIndex}`);
    ok(resolved[0].salesUnitQuantity === 12, `kolli-antal fra snapshot — fik ${resolved[0].salesUnitQuantity}`);
}

/* ── S2 · Dødt varenummer: afvises, gættes ikke ──────────────── */
console.log('\nS2 · Dødt varenummer (404 hos Hørkram) — må IKKE gættes');
{
    const { resolved, rejected } = resolveSalesUnits(
        [{ varenummer: 15328434, quantity: 1, salesUnitCode: 'ks' }], new Map(), new Set());
    ok(resolved.length === 0, 'varen sendes ikke afsted');
    ok(rejected.length === 1, 'varen kommer retur som afvist');
    ok(at(rejected,0).reason === 'unknown_product', `årsag: unknown_product — fik '${at(rejected,0).reason}'`);
    ok(/15328434/.test(at(rejected,0).message || ''), 'beskeden nævner varenummeret');
    ok(/kobl/i.test(at(rejected,0).message || ''), 'beskeden peger på handlingen (kobl varen om)');
}

/* ── S3 · Opslag fejlede ≠ varen findes ikke ─────────────────── */
console.log('\nS3 · Opslaget kunne ikke gennemføres — anden årsag, anden handling');
{
    const { resolved, rejected } = resolveSalesUnits(
        [{ varenummer: 2002, quantity: 1 }], new Map(), new Set([2002]));
    ok(resolved.length === 0, 'varen sendes ikke afsted');
    ok(at(rejected,0).reason === 'lookup_failed', `årsag: lookup_failed — fik '${at(rejected,0).reason}'`);
    ok(/prøv igen/i.test(at(rejected,0).message || ''), 'beskeden siger prøv igen — ikke "kobl om"');
    ok(!/kobl/i.test(at(rejected,0).message || ''), 'råder IKKE til at omkoble en vare der findes');
}

/* ── S4 · Resten af kurven går uhindret igennem ──────────────── */
console.log('\nS4 · Én død vare spærrer ikke for de andre');
{
    const map = new Map([snap(3001, [{ Code: 'st', Quantity: 1, IsDefault: true }])]);
    const { resolved, rejected } = resolveSalesUnits([
        { varenummer: 3001, quantity: 1 },
        { varenummer: 9999, quantity: 1 },
    ], map, new Set());
    ok(resolved.length === 1 && at(resolved,0).varenummer === 3001, 'den gyldige vare er med');
    ok(rejected.length === 1 && at(rejected,0).varenummer === 9999, 'kun den døde er afvist');
}

/* ── S5 · Snapshot uden enheder tæller som ukendt ────────────── */
console.log('\nS5 · Snapshot uden SalesUnits — vi kender stadig ikke enheden');
{
    const map = new Map([snap(4001, [])]);
    const { resolved, rejected } = resolveSalesUnits([{ varenummer: 4001, quantity: 1 }], map, new Set());
    ok(resolved.length === 0 && rejected.length === 1, 'afvist frem for at antage "st"');
}

/* ── S6 · Ugyldigt varenummer siges højt ─────────────────────── */
console.log('\nS6 · Vare uden gyldigt varenummer — springes ikke tavst over');
{
    const { resolved, rejected } = resolveSalesUnits([{ varenummer: 'abc', quantity: 1 }], new Map(), new Set());
    ok(resolved.length === 0, 'sendes ikke');
    ok(rejected.length === 1 && at(rejected,0).reason === 'invalid_number',
        `kommer retur som invalid_number — fik '${at(rejected,0).reason}'`);
}

console.log('\n─────────────────────────────────────────');
console.log(`\x1b[${fail ? 31 : 32}m${pass} PASS\x1b[0m · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
