#!/usr/bin/env node
/**
 * tests/scripts/run_T_OPTAELLING.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_OPTAELLING-tracken (lageroptælling, #331).
 *
 * PURE runner — ingen server, ingen Grocy, ingen DB. Tester de rene
 * beslutnings-funktioner i shared/inventory_check.js (via export-guard):
 * 4-gruppe sortering (Bug 3), rullende visibility inkl. cross-location
 * fallback (Bug 4), concurrency-klassifikation (§6) og enheds-konvertering.
 * Plus to kilde-scan regressions-guards (Bug 1 + Bug 2).
 *
 * Usage:
 *   npm run test:run-optaelling
 *   node tests/scripts/run_T_OPTAELLING.js --verbose
 *
 * Reference: tests/specs/T_OPTAELLING.md · docs/CLAUDE_OPTAELLING.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// Den delte mængdefelt-komponent (§14.6) skal være der FØR optællingen, som i
// browseren — den afgør hvilke enheder en vare kan tælles i.
globalThis.window = globalThis;
require(path.join(__dirname, '..', '..', 'shared', 'mangde_felter.js'));

const MOD_PATH = path.join(__dirname, '..', '..', 'shared', 'inventory_check.js');
const IC = require(MOD_PATH);
const SRC = fs.readFileSync(MOD_PATH, 'utf8');

const VERBOSE = process.argv.includes('--verbose');

let passes = 0, fails = 0, skips = 0;
function ok(name, cond, detail) {
    if (cond) { passes++; if (VERBOSE) console.log(`  PASS  ${name}`); }
    else { fails++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function skip(name, why) { skips++; if (VERBOSE) console.log(`  SKIP  ${name} — ${why}`); }
function section(t) { if (VERBOSE) console.log(`\n[${t}]`); }

// ── Hjælpere til at bygge syntetisk _ic-state ───────────────
const _ic = IC._ic;
function daysAgoISO(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString();
}
function resetState() {
    _ic.locationId = 6;              // "Køl"
    _ic.locationName = 'Køl';
    _ic.physicalUnit = 'KØL-1';
    _ic.physicalUnits = { 6: [ { id: 1, name: 'KØL-1' }, { id: 2, name: 'KØL-2' } ],
                          4: [ { id: 3, name: 'FRYS-1' }, { id: 4, name: 'FRYS-2' } ] };
    _ic.products = [];
    _ic.counts = {};
    _ic.skipped = [];
    _ic.priorities = {};
    _ic.grocyStock = {};
    _ic.quantityUnits = { 4: 'Kilo', 8: 'Antal', 12: 'Bøtte' };
    _ic.conversions = [];
    _ic._commitFresh = null;
    // Hele sessionen skal nulstilles, ikke kun counts. Manglede disse fire, og
    // beslutninger fra en tidligere case blødte ind i den næste — commit-testen
    // så pludselig Grocy-kald den ikke selv havde opsat.
    _ic.decisions = {};
    _ic.skippedByUnit = {};
    _ic.countUnitPref = {};
    _ic.startedAt = null;
}

// ════════════════════════════════════════════════════════════
// CASE 7 — Bug 3: 4-gruppe sortering
// ════════════════════════════════════════════════════════════
function caseGroupAndSort() {
    section('Case 7 — 4-gruppe sortering');
    const g = IC._icGroupOf;
    const cs = IC._icComputeCheckStatus;
    const now = new Date();

    // _icGroupOf sandhedstabel
    ok('7a passiv (ingen interval) → gruppe 3', g(null, new Date(), cs(null, new Date(), now)) === 3);
    ok('7b interval + aldrig talt → gruppe 1', g(7, null, cs(7, null, now)) === 1);
    const overdue = cs(7, new Date(now - 40 * 86400000), now);
    ok('7c forfalden → gruppe 0', g(7, new Date(now - 40 * 86400000), overdue) === 0, 'status=' + overdue.status);
    const soon = cs(10, new Date(now - 9 * 86400000), now);
    ok('7d snart (ratio>0.8) → gruppe 2', g(10, new Date(now - 9 * 86400000), soon) === 2, 'status=' + soon.status);
    const okStatus = cs(30, new Date(now - 2 * 86400000), now);
    ok('7e nyligt tjekket → gruppe 3', g(30, new Date(now - 2 * 86400000), okStatus) === 3, 'status=' + okStatus.status);

    // Fuld _icCategorize: rækkefølge Forfaldne < Aldrig < Snart < Ikke-forfaldne
    resetState();
    function prod(id, name, uf) {
        return { id, name, location_id: 6, qu_id_stock: 8, userfields: uf || {} };
    }
    _ic.products = [
        prod(1, 'Ikke-forfalden', { HverDag: '30', LastCheckedAt: daysAgoISO(2) }),   // gruppe 3
        prod(2, 'Snart',          { HverDag: '10', LastCheckedAt: daysAgoISO(9) }),    // gruppe 2
        prod(3, 'Aldrig',         { HverDag: '7' }),                                   // gruppe 1
        prod(4, 'Forfalden',      { HverDag: '7', LastCheckedAt: daysAgoISO(40) }),    // gruppe 0
        prod(5, 'Passiv',         {} )                                                 // gruppe 3
    ];
    const res = IC._icCategorize();
    const order = res.unchecked.map(x => x.name);
    ok('7f rækkefølge korrekt', order[0] === 'Forfalden' && order[1] === 'Aldrig' && order[2] === 'Snart',
        'fik: ' + order.join(' > '));
    ok('7g passiv ligger i sidste gruppe', res.unchecked[res.unchecked.length - 1].group === 3);

    // BB kun tie-breaker: to forfaldne med samme ratio → tidligst udløb først
    resetState();
    _ic.products = [
        prod(10, 'ForfaldenSenBB',  { HverDag: '7', LastCheckedAt: daysAgoISO(14) }),
        prod(11, 'ForfaldenTidligBB',{ HverDag: '7', LastCheckedAt: daysAgoISO(14) })
    ];
    _ic.grocyStock = {
        10: { amount: 5, unit: 'Antal', bestBefore: daysAgoISO(-30).slice(0, 10) }, // udløber om 30 dage
        11: { amount: 5, unit: 'Antal', bestBefore: daysAgoISO(-2).slice(0, 10) }   // udløber om 2 dage
    };
    const tie = IC._icCategorize().unchecked.map(x => x.name);
    ok('7h BB tie-breaker: tidligst udløb først', tie[0] === 'ForfaldenTidligBB', 'fik: ' + tie.join(' > '));

    // 7i — stjernen (manuel prioritet) slår gruppen. En stjernemarkeret, IKKE-forfalden vare
    // skal ligge over en uforfalden-men-overskredet vare. Regression fanget i drift 18/7:
    // 4-gruppe-omskrivningen havde demoteret prioritet fra trin 1 til trin 2.
    resetState();
    _ic.products = [
        prod(20, 'ForfaldenUdenStjerne', { HverDag: '7', LastCheckedAt: daysAgoISO(40) }),  // gruppe 0
        prod(21, 'StjerneIkkeForfalden', { HverDag: '30', LastCheckedAt: daysAgoISO(1) })   // gruppe 3
    ];
    _ic.priorities = { 21: 'high' };
    const stjerne = IC._icCategorize().unchecked.map(x => x.name);
    ok('7i stjerne slår gruppe (manuel markering vinder)', stjerne[0] === 'StjerneIkkeForfalden',
        'fik: ' + stjerne.join(' > '));

    // 7j — uden stjerne er gruppe-rækkefølgen uændret (Bug 3-fixet er intakt)
    _ic.priorities = {};
    const udenStjerne = IC._icCategorize().unchecked.map(x => x.name);
    ok('7j uden stjerne: gruppen bestemmer', udenStjerne[0] === 'ForfaldenUdenStjerne',
        'fik: ' + udenStjerne.join(' > '));
}

// ════════════════════════════════════════════════════════════
// CASE 6 — Bug 4: rullende visibility (blød fallback, beslutning E)
// ════════════════════════════════════════════════════════════
function caseVisibility() {
    section('Case 6 — rullende visibility');
    resetState();
    const locUnits = IC._icGetUnitsForLocation(6);   // ['KØL-1','KØL-2']
    const vis = (uf) => IC._icVisibleInUnit({ location_id: 6, userfields: uf }, locUnits);

    ok('6a LastCheckedUnit == aktuel enhed → vis', vis({ LastCheckedUnit: 'KØL-1' }) === true);
    ok('6b LastCheckedUnit = anden enhed under lok → skjul', vis({ LastCheckedUnit: 'KØL-2' }) === false);
    ok('6c LastCheckedUnit tom + hører til lok → vis (fallback)', vis({}) === true);
    ok('6d LastCheckedUnit under ANDEN lok + hører til lok → vis (blød fallback E)',
        vis({ LastCheckedUnit: 'FRYS-2' }) === true);
    // vare der hverken hører til lok eller er talt her
    ok('6e ikke talt her + anden lok → skjul',
        IC._icVisibleInUnit({ location_id: 99, userfields: {} }, locUnits) === false);
}

// ════════════════════════════════════════════════════════════
// CASE 11 / 1 — §6 concurrency-klassifikation
// ════════════════════════════════════════════════════════════
function caseClassify() {
    section('Case 11 — concurrency-klassifikation');
    resetState();
    const p = { id: 1, name: 'X', location_id: 6, userfields: {} };
    const fresh = { '1': 10 };

    // Ikke talt → null (case 1)
    ok('1a ikke-talt → null (ingen skrivning)', IC._icClassifyCounted(p, fresh) === null);

    // Talt, ingen drift (baseline == grocyNow) → ingen konflikt
    _ic.counts = { 1: { units: { 'KØL-1': 12 }, total: 12, grocyAtCount: 10, lastUnit: 'KØL-1' } };
    let c = IC._icClassifyCounted(p, { '1': 10 });
    ok('11a baseline==grocyNow → conflict=false', c && c.conflict === false);
    ok('1b talt m. afvigelse → needsWrite=true', c && c.needsWrite === true, 'total=12 grocy=10');

    // Talt, Grocy har flyttet sig siden (baseline 10, nu 6) → konflikt
    c = IC._icClassifyCounted(p, { '1': 6 });
    ok('11b baseline≠grocyNow → conflict=true', c && c.conflict === true, 'baseline=10 grocyNow=6');

    // Afklaret → ingen konflikt længere
    _ic.counts[1].conflictResolved = 'override';
    c = IC._icClassifyCounted(p, { '1': 6 });
    ok('11c afklaret (override) → conflict=false', c && c.conflict === false);

    // Ingen baseline (legacy session uden grocyAtCount) → ingen falsk konflikt
    _ic.counts = { 1: { units: { 'KØL-1': 3 }, total: 3, lastUnit: 'KØL-1' } };
    c = IC._icClassifyCounted(p, { '1': 99 });
    ok('11d ingen baseline → conflict=false (ingen falsk-positiv)', c && c.conflict === false);
}

// ════════════════════════════════════════════════════════════
// CASE 4/5 — enheds-konvertering
// ════════════════════════════════════════════════════════════
function caseConversion() {
    section('Case 4/5 — enheds-konvertering');
    resetState();
    // Produkt-specifik: 1 bøtte (qu 12) = 1.5 kg (qu 4)
    _ic.conversions = [
        { product_id: 7, from_qu_id: 12, to_qu_id: 4, factor: 1.5 },
        { product_id: null, from_qu_id: 8, to_qu_id: 4, factor: 2.0 }   // global
    ];
    ok('4a produkt-specifik faktor (bøtte→kg)', IC._icFindFactor(7, 12, 4) === 1.5);
    const rev = IC._icFindFactor(7, 4, 12);
    ok('4b omvendt retning (kg→bøtte)', Math.abs(rev - (1 / 1.5)) < 1e-9, 'fik ' + rev);
    ok('4c global fallback-faktor', IC._icFindFactor(999, 8, 4) === 2.0);
    ok('4d samme enhed → 1', IC._icFindFactor(7, 4, 4) === 1);
    ok('5a ingen konvertering → null', IC._icFindFactor(7, 8, 99) === null);
}

// ════════════════════════════════════════════════════════════
// CASE 1/2/3 — regressions-guards (kilde-scan)
// ════════════════════════════════════════════════════════════
function caseSourceGuards() {
    section('Case 1/2/3 — regressions-guards');

    // Bug 2: ingen write hardkoder evighedsdato. Kun læse-sammenligningen i _icCategorize
    // må nævne 2999-12-31 (behandl evighedsdato som "ingen udløb").
    const writeBB = /postGrocyInventory\([^)]*2999-12-31/;
    ok('3 ingen postGrocyInventory(..., 2999-12-31) i writes', !writeBB.test(SRC));

    // Bug 1: _icSaveCount må ikke længere kalde _icUpdateLastChecked (skrives kun ved commit).
    // Slice præcis _icSaveCount-kroppen (næste funktion er _icUpdateLastChecked-definitionen,
    // som naturligt indeholder navnet — den må ikke tælle med).
    const saveCountBody = SRC.slice(
        SRC.indexOf('function _icSaveCount('),
        SRC.indexOf('async function _icUpdateLastChecked(')
    );
    ok('1c _icSaveCount kalder ikke _icUpdateLastChecked', saveCountBody.indexOf('_icUpdateLastChecked') === -1);

    // Bug 1: _icUpdateLastChecked skrives kun fra commit + _icCorrectInventory (2 kaldesteder).
    const callSites = (SRC.match(/await _icUpdateLastChecked\(/g) || []).length;
    ok('2 _icUpdateLastChecked kaldes kun ved commit + korrektion (2 steder)', callSites === 2, 'fandt ' + callSites);

    // "Ikke fundet"-varer skal kunne rettes med faktisk mængde (input + Ret), ikke kun Sæt til 0.
    ok('3b ikke-fundet har antal-felt + Ret', SRC.indexOf('data-nf-input') !== -1 && SRC.indexOf('data-correct-input') !== -1);
}

// ════════════════════════════════════════════════════════════
// CASE 12 — decimaler: komma til mennesker, punktum til Grocy
// ════════════════════════════════════════════════════════════
function caseDecimals() {
    section('Case 12 — decimal-adskillelse');
    const fmt = IC._icFmt, parse = IC._icParseNum;

    // Visning → dansk komma
    ok('12a _icFmt(2.5) → "2,5"', fmt(2.5) === '2,5', 'fik ' + fmt(2.5));
    ok('12b _icFmt(7.06) → "7,06"', fmt(7.06) === '7,06', 'fik ' + fmt(7.06));
    ok('12c _icFmt(13) → "13" (ingen unødig decimal)', fmt(13) === '13', 'fik ' + fmt(13));
    ok('12d _icFmt(-2.06) → "-2,06"', fmt(-2.06) === '-2,06', 'fik ' + fmt(-2.06));
    ok('12e _icFmt(null) → tom streng', fmt(null) === '');

    // Input → JS-tal (punktum), uanset hvad brugeren taster
    ok('12f _icParseNum("2,5") → 2.5', parse('2,5') === 2.5, 'fik ' + parse('2,5'));
    ok('12g _icParseNum("2.5") → 2.5', parse('2.5') === 2.5);
    ok('12h _icParseNum(" 3,25 ") → 3.25 (trimmer)', parse(' 3,25 ') === 3.25);
    ok('12i _icParseNum("") → 0', parse('') === 0);
    ok('12j _icParseNum("abc") → 0 (ingen NaN)', parse('abc') === 0);

    // DEN KRITISKE GRÆNSE: det der sendes til Grocy må aldrig indeholde komma.
    // Grocy afviser strenge hårdt ("must be of type float, string given").
    const sendt = parse('2,5');
    ok('12k værdi til Grocy er et JS-tal, ikke streng', typeof sendt === 'number');
    ok('12l JSON-serialisering bruger punktum',
        JSON.stringify({ new_amount: sendt }) === '{"new_amount":2.5}',
        JSON.stringify({ new_amount: sendt }));

    // Guard: data-amount-attributtet parses tilbage → må ikke formateres med komma
    ok('12m data-amount bruger rå værdi (ikke _icFmt)',
        /data-amount="' \+ item\.countedAmount \+ '"/.test(SRC));
    // Guard: antal-feltet må ikke være type="number" (afviser komma)
    // Felterne bygges nu af den delte komponent (#665). Guarden gælder dér:
    // et type="number"-felt giver et TOMT value for "2,5", og så ignoreres
    // feltet tavst. Komponenten skal både skrive type=text og læse komma.
    const MF_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'mangde_felter.js'), 'utf8');
    ok('12n tællefelterne er type=text + inputmode=decimal',
        /input\.type = 'text'/.test(MF_SRC) && /'inputmode', 'decimal'/.test(MF_SRC) &&
        !/input\.type = 'number'/.test(MF_SRC));
    ok('12n2 dansk komma læses', globalThis.MangdeFelter._num('2,5') === 2.5);
    // Guard: rå parseFloat må ikke bruges på .value (parseFloat('2,5') === 2)
    ok('12o ingen rå parseFloat(input.value)', SRC.indexOf('parseFloat(input.value)') === -1);

    // Guard mod den fejl vi netop fandt: et visnings-tal der glemmes i _icFmt.
    // Alle disse variabler er tal mennesker læser — de skal ALTID gennem _icFmt.
    const displayVars = ['item.grocyAmount', 'item.countedAmount', 'item.difference',
                         'c.total', 'c.grocyNow', 'c.baseline'];
    const uformaterede = displayVars.filter(v => {
        // find '+ <var> +' der IKKE står inde i _icFmt(...) og ikke er et data-attribut
        const re = new RegExp("\\+ " + v.replace('.', '\\.') + " \\+", 'g');
        let m, bad = false;
        while ((m = re.exec(SRC)) !== null) {
            const linje = SRC.slice(SRC.lastIndexOf('\n', m.index) + 1,
                                    SRC.indexOf('\n', m.index));
            if (linje.indexOf('data-amount') === -1) bad = true;   // data-attributter skal være rå
        }
        return bad;
    });
    ok('12p alle visnings-tal går gennem _icFmt', uformaterede.length === 0,
        'uformateret: ' + uformaterede.join(', '));
}

// ════════════════════════════════════════════════════════════
// PR 2 — enheds-chips, tælleenheder, beslutninger, session-nøgle
// ════════════════════════════════════════════════════════════

// Case 8 — enheds-chips må aldrig tabe en tælling. Skifter man frem og
// tilbage mellem KØL-1 og KØL-2 skal begge tal stå urørt, og totalen (det
// der skrives til lageret) skal være summen.
function caseUnitChips() {
    section('Case 8 — enheds-chips bevarer tælling');
    resetState();
    _ic.products = [{ id: 7, name: 'Mozzarella', userfields: {} }];
    _ic.grocyStock[7] = { amount: 5, unit: 'Kilo', bestBefore: null };

    _ic.physicalUnit = 'KØL-1';
    IC._icSaveCount(7, 3);
    _ic.physicalUnit = 'KØL-2';
    IC._icSaveCount(7, 1.5);

    ok('8a tælling i KØL-1 bevaret efter enhedsskift', _ic.counts[7].units['KØL-1'] === 3,
       'fik ' + _ic.counts[7].units['KØL-1']);
    ok('8b tælling i KØL-2 gemt', _ic.counts[7].units['KØL-2'] === 1.5);
    ok('8c total = sum over enheder', _ic.counts[7].total === 4.5, 'fik ' + _ic.counts[7].total);
    ok('8d lastUnit = sidst talte enhed', _ic.counts[7].lastUnit === 'KØL-2');

    // Tilbage til første enhed og tæl om — den anden enhed må ikke røres.
    _ic.physicalUnit = 'KØL-1';
    IC._icSaveCount(7, 2);
    ok('8e recount i KØL-1 rører ikke KØL-2', _ic.counts[7].units['KØL-2'] === 1.5);
    ok('8f total genberegnet efter recount', _ic.counts[7].total === 3.5, 'fik ' + _ic.counts[7].total);

    // §6-baseline fanges én gang, så den overlever recount + enhedsskift.
    ok('8g grocyAtCount-baseline uændret af recount', _ic.counts[7].grocyAtCount === 5);
}

// Case 9/10 — beslutningerne fra kortets menu skrives FØRST ved commit
// (spec §3: intet går til lageret før "Gem og luk"). Her låser vi at de
// ligger i sessionen, og at commit-stien indeholder de rigtige skrivninger.
function caseDecisions() {
    section('Case 9/10 — beslutninger fra kortmenuen');
    resetState();
    _ic.decisions = { '7': 'notrack', '9': 'discontinued' };

    ok('9a beslutning ligger i sessionen', _ic.decisions['7'] === 'notrack');
    ok('10a udgået-beslutning ligger i sessionen', _ic.decisions['9'] === 'discontinued');

    // (9b/10b/10c er nu rigtige adfærdstest i case 16 — de var kilde-scans,
    // som består selv hvis kaldet er gjort uopnåeligt.)

    // Destruktivt → skal bekræftes (3 tryk i alt, spec §7).
    const decideFn = SRC.slice(SRC.indexOf('function _icDecide'), SRC.indexOf('function _icMountCount'));
    ok('10d udgået kræver bekræftelse', decideFn.indexOf('confirm(') !== -1);

    // Beslutninger må ikke skrives fra kort-handlingen — kun ved commit.
    ok('9c _icDecide skriver ikke til Grocy',
       decideFn.indexOf('putGrocyProduct') === -1 && decideFn.indexOf('postGrocyInventory') === -1);
}

// Case 13 — tælleenheder: tæl i pakke, skriv i lagerenhed.
function caseCountUnits() {
    section('Case 13 — tælleenheder');
    resetState();
    // 1 kg = 4 bøtter  →  1 bøtte = 0,25 kg
    _ic.conversions = [{ product_id: 7, from_qu_id: 4, to_qu_id: 12, factor: 4 }];
    const prod = { id: 7, qu_id_stock: 4, qu_id_purchase: 12 };

    const opts = IC._icCountUnitOptions(prod);
    ok('13a lagerenhed er første valg', opts.length === 2 && opts[0].isStock === true);
    ok('13b lagerenhed har toStock=1', opts[0].toStock === 1);
    ok('13c pakke-enhed omregner til lagerenhed', Math.abs(opts[1].toStock - 0.25) < 1e-9,
       'fik ' + opts[1].toStock);
    ok('13d pakke-enhed har navn', opts[1].name === 'Bøtte', 'fik ' + opts[1].name);

    // 3 bøtter skal blive 0,75 kg på lageret.
    ok('13e 3 bøtter = 0,75 kg', Math.abs(3 * opts[1].toStock - 0.75) < 1e-9);

    // Ingen konvertering → kun lagerenheden, ingen fejl (spec §7 fallback).
    const bare = IC._icCountUnitOptions({ id: 8, qu_id_stock: 4, qu_id_purchase: 99 });
    ok('13f uden konvertering: kun lagerenhed', bare.length === 1 && bare[0].isStock === true);

    // Hukommelsen er pr. vare OG fysisk enhed — samme vare tælles ofte i
    // forskellige enheder alt efter hvor den står.
    _ic.countUnitPref = {};
    _ic.physicalUnit = 'KØL-1';
    _ic.countUnitPref[7 + '|KØL-1'] = 12;
    ok('13g husket tælleenhed vælges', String(IC._icPickCountUnit(prod).quId) === '12');
    _ic.physicalUnit = 'TØR-1';
    ok('13h anden fysisk enhed → lagerenhed igen', IC._icPickCountUnit(prod).isStock === true);
    ok('13i skrivning sker altid i lagerenhed (kommentar-anker)',
       /Grocy f.r ALTID lagerenheden/.test(SRC));

    // Brøkknapperne er væk (#665): det åbnede tælles i den fine enhed i
    // stedet for at gætte på en brøk hvis betydning skiftede med enheden.
    ok('13j brøkknapperne er væk', SRC.indexOf('data-action="frac"') === -1 &&
       SRC.indexOf('_icIsPackUnit') === -1);

    // Enhederne kommer fra den delte komponent — en enhed uden faktor til
    // lager-enheden tilbydes ikke (#358), ligesom i varemodtagelsen.
    _ic.conversions = [{ product_id: 7, from_qu_id: 4, to_qu_id: 12, factor: 4 },
                       { product_id: 7, from_qu_id: 8, to_qu_id: 4, factor: 0.05 }];
    const tre = IC._icCountUnitOptions({ id: 7, qu_id_stock: 4, qu_id_purchase: 12, qu_id_consume: 8 });
    ok('13k tre enheder når alle har en faktor', tre.length === 3 && tre[0].isStock === true,
       JSON.stringify(tre));
    ok('13l forbrugs-enhedens faktor', tre[2] && Math.abs(tre[2].toStock - 0.05) < 1e-9);
}

// Case 14 — session-nøglen. Fundet under PR 2: den var UTC-dateret, så en
// aftenoptælling skiftede nøgle ved dansk kl. 22 og forsvandt.
function caseSessionKey() {
    section('Case 14 — session-nøgle uden UTC-dato');
    resetState();

    ok('14a nøgle er ikke dato-scopet', IC._icSessionKey() === 'ic_counts_6',
       'fik ' + IC._icSessionKey());
    ok('14b nøglen indeholder ingen dato', !/\d{4}-\d{2}-\d{2}/.test(IC._icSessionKey()));

    // Lokal dato, ikke UTC (memory project_utc_today_bug).
    const nytaarsaften = new Date(2026, 11, 31, 23, 30, 0);   // lokal 31/12 kl. 23:30
    ok('14c _icLocalDate bruger lokal dato', IC._icLocalDate(nytaarsaften) === '2026-12-31',
       'fik ' + IC._icLocalDate(nytaarsaften));
    ok('14d ingen toISOString i session-nøglen',
       SRC.slice(SRC.indexOf('function _icSessionKey'), SRC.indexOf('function _icMigrateLegacySessions'))
          .indexOf('toISOString') === -1);

    // Genoptag-banner: kun når der faktisk ER noget at genoptage.
    _ic.startedAt = null; _ic.counts = {};
    ok('14e tom session er ikke "gammel"', IC._icSessionIsOld() === false);
    _ic.startedAt = daysAgoISO(2);
    _ic.counts = { 7: { units: { 'KØL-1': 1 }, total: 1 } };
    ok('14f session fra i forgårs er gammel', IC._icSessionIsOld() === true);
    _ic.startedAt = new Date().toISOString();
    ok('14g session fra i dag er ikke gammel', IC._icSessionIsOld() === false);
}

// Case 15 — sprunget over forsvinder ikke længere fra listen.
function caseSkipVisible() {
    section('Case 15 — sprunget over bliver synligt');
    resetState();
    _ic.products = [
        { id: 7, name: 'Mozzarella', location_id: 6, userfields: {} },
        { id: 8, name: 'Æg',         location_id: 6, userfields: {} }
    ];
    _ic.grocyStock[7] = { amount: 5, unit: 'Kilo', bestBefore: null };
    _ic.grocyStock[8] = { amount: 2, unit: 'Kilo', bestBefore: null };
    _ic.skipped = [7];

    const cat = IC._icCategorize();
    ok('15a sprunget vare er ikke i den utjekkede liste',
       cat.unchecked.filter(p => p.id === 7).length === 0);
    ok('15b sprunget vare forsvinder ikke — den er i skipped',
       (cat.skipped || []).filter(p => p.id === 7).length === 1);
    ok('15c ikke-sprunget vare er upåvirket',
       cat.unchecked.filter(p => p.id === 8).length === 1);
    ok('15d sprunget tæller ikke som tjekket', cat.checkedInUnit.length === 0);

    // 15g — søgning der KUN rammer en sprunget vare må ikke udløse tom-tilstanden.
    // De sprungne kort appendes til samme liste, så en innerHTML-overskrivning
    // bagefter ville slette dem: varen ligger der, men søgningen påstod nej.
    const render = SRC.slice(SRC.indexOf('function _icRenderProducts'),
                             SRC.indexOf('function _icCreateCard'));
    const tomTilstand = render.indexOf('ic-search-empty');
    const appendSkip  = render.indexOf('skippedNow.forEach');
    ok('15g tom-tilstand afgøres før de sprungne kort tilføjes',
       tomTilstand !== -1 && appendSkip !== -1 && tomTilstand < appendSkip);
    ok('15h tom-tilstand tæller sprungne med', /skippedNow\.length\s*===\s*0/.test(render));

    // Skip lever nu lige så længe som counts (ikke sessionStorage).
    ok('15e skip gemmes i sessionens localStorage-payload',
       /skippedByUnit:\s*_ic\.skippedByUnit/.test(SRC));
    // Kun omtale i kommentarer er fint — det er brugen der ville give to
    // forskellige levetider i samme session igen.
    ok('15f ingen sessionStorage-kald tilbage', !/sessionStorage\s*\.\s*(get|set|remove)Item/.test(SRC));
}


// ════════════════════════════════════════════════════════════
// CASE 16 — commit-stien kørt med attrap-Grocy
// ════════════════════════════════════════════════════════════
// Det her er den mest sikkerhedskritiske kode i modulet: hvad der rent
// faktisk bliver skrevet til lageret. Tidligere var den kun dækket af
// kilde-scans (regex mod filens tekst), som består selv hvis kaldet er
// gjort uopnåeligt — de beviser at koden er skrevet, ikke at den virker.
// Her injiceres attrapper for Grocy-funktionerne, commit'et køres, og vi
// asserterer præcis hvilke kald der fyrer, i hvilken rækkefølge.

let _realConsoleError = null;

function installFakeGrocy(failOn) {
    const calls = [];
    failOn = failOn || {};

    // De bevidste fejl-cases logger via console.error i produktionskoden.
    // Det er korrekt opførsel, men støjer i en grøn kørsel — dæmp den mens
    // attrappen er installeret.
    if (Object.keys(failOn).length && !_realConsoleError) {
        _realConsoleError = console.error;
        console.error = function() {};
    }

    globalThis.postGrocyInventory = async function(id, amount, bestBefore) {
        calls.push({ fn: 'inventory', id, amount, bestBefore, argc: arguments.length });
        if (failOn.inventory === id) throw new Error('attrap: lager-skrivning fejlede');
        return { ok: true };
    };
    globalThis.putGrocyProductUserfields = async function(id, fields, kilde) {
        calls.push({ fn: 'userfields', id, fields, kilde });
        if (failOn.userfields === id) throw new Error('attrap: userfield-skrivning fejlede');
        return failOn.sporFejl ? { ok: true, log_error: 'attrap: sporet fejlede' } : { ok: true };
    };
    globalThis.putGrocyProduct = async function(id, body, kilde) {
        calls.push({ fn: 'product', id, body, kilde });
        if (failOn.product === id) throw new Error('attrap: produkt-opdatering fejlede');
        return failOn.sporFejl ? { ok: true, log_error: 'attrap: sporet fejlede' } : { ok: true };
    };
    return calls;
}

function removeFakeGrocy() {
    if (_realConsoleError) { console.error = _realConsoleError; _realConsoleError = null; }
    delete globalThis.postGrocyInventory;
    delete globalThis.putGrocyProductUserfields;
    delete globalThis.putGrocyProduct;
}

// Byg en talt vare: produkt + lager + count med baseline.
function counted(id, name, grocyAmount, countedTotal, opts) {
    opts = opts || {};
    _ic.products.push({ id, name, location_id: 6, qu_id_stock: 4, userfields: {} });
    _ic.grocyStock[id] = { amount: grocyAmount, unit: 'Kilo', bestBefore: null };
    _ic.counts[id] = {
        units: { 'KØL-1': countedTotal },
        total: countedTotal,
        lastUnit: opts.lastUnit || 'KØL-1',
        grocyAtCount: opts.baseline === undefined ? grocyAmount : opts.baseline
    };
    if (opts.resolved) _ic.counts[id].conflictResolved = opts.resolved;
}

async function caseCommitExecution() {
    section('Case 16 — commit-stien med attrap-Grocy');

    // ── 16a-e: hvad bliver skrevet, og hvad bliver IKKE skrevet ──
    resetState();
    counted(1, 'Ændret',    5, 3);          // afviger → skal skrives
    counted(2, 'Uændret',   4, 4);          // stemmer → kun stemples
    _ic.products.push({ id: 3, name: 'Ikke talt', location_id: 6, userfields: {} });
    _ic.grocyStock[3] = { amount: 9, unit: 'Kilo', bestBefore: null };

    let calls = installFakeGrocy();
    let plan = IC._icPlanCommit({ '1': 5, '2': 4, '3': 9 });
    let res  = await IC._icExecuteCommit(plan);

    const inv = calls.filter(c => c.fn === 'inventory');
    ok('16a kun den afvigende vare får en lager-skrivning',
       inv.length === 1 && inv[0].id === 1 && inv[0].amount === 3,
       JSON.stringify(inv));

    // Bug 2 — ægte assertion nu: best-before må ALDRIG sendes med.
    ok('16b lager-skrivning sender ingen best-before (Bug 2)',
       inv[0].argc === 2 && inv[0].bestBefore === undefined,
       'argc=' + inv[0].argc + ' bb=' + inv[0].bestBefore);

    const stamped = calls.filter(c => c.fn === 'userfields' && c.fields.LastCheckedAt).map(c => c.id);
    ok('16c begge talte varer stemples som tjekket',
       stamped.length === 2 && stamped.includes(1) && stamped.includes(2), JSON.stringify(stamped));

    // Bug 1 — den ikke-talte vare må ikke efterlade spor overhovedet.
    ok('16d ikke-talt vare røres slet ikke (Bug 1)',
       calls.every(c => c.id !== 3), JSON.stringify(calls.filter(c => c.id === 3)));
    ok('16e stemplet bærer den enhed varen blev talt i',
       calls.find(c => c.fn === 'userfields' && c.id === 1).fields.LastCheckedUnit === 'KØL-1');
    ok('16f resultat tæller korrekt', res.invWritten === 1 && res.invFailed === 0);
    removeFakeGrocy();

    // ── 16g-i: konflikt-gaten blokerer FAKTISK ──
    resetState();
    counted(1, 'Drevet', 5, 3, { baseline: 5 });     // baseline 5, men frisk lager er 9
    calls = installFakeGrocy();
    plan = IC._icPlanCommit({ '1': 9 });
    ok('16g uafklaret konflikt havner i planen', plan.pendingConflicts === 1);
    ok('16h konflikt-varen er ikke i skrive-listen', plan.toWrite.length === 0);
    ok('16i intet blev skrevet ved konflikt', calls.length === 0);
    removeFakeGrocy();

    // "Lagerets tal er rigtigt" → varen glemmes, intet skrives
    resetState();
    counted(1, 'Behold lagerets', 5, 3, { baseline: 5, resolved: 'keep' });
    calls = installFakeGrocy();
    plan = IC._icPlanCommit({ '1': 9 });
    res  = await IC._icExecuteCommit(plan);
    ok('16j "lagerets tal er rigtigt" skriver intet', calls.length === 0);
    ok('16k den tælles som beholdt', plan.keepCount === 1 && plan.toWrite.length === 0);
    removeFakeGrocy();

    // "Mit tal er rigtigt" → skrives alligevel
    resetState();
    counted(1, 'Mit tal', 5, 3, { baseline: 5, resolved: 'override' });
    calls = installFakeGrocy();
    plan = IC._icPlanCommit({ '1': 9 });
    await IC._icExecuteCommit(plan);
    ok('16l "mit tal er rigtigt" skriver optællingen',
       calls.some(c => c.fn === 'inventory' && c.id === 1 && c.amount === 3));
    removeFakeGrocy();

    // ── 16m-p: beslutningerne fra kortets menu (9b/10b/10c) ──
    resetState();
    _ic.decisions = { '7': 'notrack', '9': 'discontinued' };
    calls = installFakeGrocy();
    plan = IC._icPlanCommit({});
    res  = await IC._icExecuteCommit(plan);

    const hverdag = calls.find(c => c.fn === 'userfields' && c.id === 7);
    ok('16m "skal ikke tælles fast" rydder HverDag',
       hverdag && hverdag.fields.HverDag === '' && Object.keys(hverdag.fields).length === 1,
       JSON.stringify(hverdag));

    const disc = calls.filter(c => c.id === 9);
    ok('16n "varen findes ikke mere" sætter lageret til 0',
       disc.some(c => c.fn === 'inventory' && c.amount === 0));
    ok('16o "varen findes ikke mere" deaktiverer produktet',
       disc.some(c => c.fn === 'product' && c.body.active === 0));
    ok('16p lageret nulstilles FØR produktet deaktiveres',
       disc.findIndex(c => c.fn === 'inventory') < disc.findIndex(c => c.fn === 'product'),
       JSON.stringify(disc.map(c => c.fn)));
    ok('16q beslutninger tælles hver for sig',
       res.notrackDone === 1 && res.discDone === 1 && res.decFailed === 0);
    // #666: beslutningerne er stamdata — de skal stå i varens historik som
    // kommende fra optællingen. Kål-sagen var netop en ⋯-beslutning.
    ok('16q2 beslutningerne sendes med kilden "optaelling" (#666)',
       hverdag && hverdag.kilde === 'optaelling' &&
       disc.some(c => c.fn === 'product' && c.kilde === 'optaelling'),
       JSON.stringify(calls.map(c => [c.fn, c.kilde])));
    ok('16q3 intet spor-hul når sporet lykkes', res.sporFejl === 0);
    removeFakeGrocy();

    // ── 16q4-5: beslutningen er gemt, men sporet fejlede — det skal siges ──
    resetState();
    _ic.decisions = { '9': 'discontinued' };
    calls = installFakeGrocy({ sporFejl: true });
    plan = IC._icPlanCommit({});
    res  = await IC._icExecuteCommit(plan);
    ok('16q4 et fejlet spor vælter ikke beslutningen', res.discDone === 1 && res.decFailed === 0);
    const sporMsg = IC._icCommitMessage({ toWrite: [], keepCount: 0 }, res);
    ok('16q5 kvitteringen siger at historikken mangler', res.sporFejl === 1 && /historik/.test(sporMsg), sporMsg);
    removeFakeGrocy();

    // ── 16r-t: fejl håndteres og holdes adskilt ──
    resetState();
    counted(1, 'Fejler', 5, 3);
    calls = installFakeGrocy({ inventory: 1 });
    plan = IC._icPlanCommit({ '1': 5 });
    res  = await IC._icExecuteCommit(plan);
    ok('16r fejlet lager-skrivning tælles', res.invFailed === 1 && res.invWritten === 0);
    ok('16s en vare hvis lager fejlede bliver IKKE stemplet som tjekket',
       !calls.some(c => c.fn === 'userfields' && c.id === 1),
       'ellers ville den se tjekket ud uden at være rettet');
    removeFakeGrocy();

    resetState();
    _ic.decisions = { '9': 'discontinued' };
    calls = installFakeGrocy({ product: 9 });
    plan = IC._icPlanCommit({});
    res  = await IC._icExecuteCommit(plan);
    ok('16t beslutnings-fejl blandes ikke sammen med lager-fejl',
       res.decFailed === 1 && res.invFailed === 0);
    removeFakeGrocy();

    // ── 16u-w: kvitteringsteksten ──
    const msg = IC._icCommitMessage(
        { toWrite: [1, 2], keepCount: 1 },
        { invWritten: 1, notrackDone: 1, discDone: 0 });
    ok('16u kvittering nævner det der skete', /1 vare rettet på lageret/.test(msg) &&
       /2 sat som talt/.test(msg) && /1 beholdt lagerets tal/.test(msg) &&
       /1 tælles ikke fast mere/.test(msg), msg);
    ok('16v kvittering bruger ingen systemord',
       !/Grocy|commit|overskriv|userfield|HverDag/i.test(msg), msg);
    const tom = IC._icCommitMessage({ toWrite: [], keepCount: 0 },
                                    { invWritten: 0, notrackDone: 0, discDone: 0 });
    ok('16w tom commit siger "Ingen ændringer"', /Ingen ændringer/.test(tom), tom);

    const fejlMsg = IC._icCommitErrorMessage({ invWritten: 2, invFailed: 1, decFailed: 1 });
    ok('16x fejlbesked skelner de to slags fejl',
       /1 lager-rettelse/.test(fejlMsg) && /1 ændring til varerne/.test(fejlMsg), fejlMsg);
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    console.log('[run_T_OPTAELLING] Pure runner — ingen server/Grocy');
    // Verificér export-guard
    const required = ['_icGroupOf', '_icVisibleInUnit', '_icClassifyCounted', '_icCategorize',
                      '_icFindFactor', '_icGetUnitsForLocation', '_icFmt', '_icParseNum', '_ic',
                      '_icCountUnitOptions', '_icPickCountUnit', '_icLocalDate', '_icCommitEntries',
                      '_icSessionKey', '_icSessionIsOld', '_icSaveCount',
                      '_icPlanCommit', '_icExecuteCommit', '_icCommitMessage',
                      '_icCommitErrorMessage'];
    const missing = required.filter(k => IC[k] === undefined);
    if (missing.length) {
        console.error('[run_T_OPTAELLING] SETUP-fejl: manglende export: ' + missing.join(', '));
        process.exit(1);
    }

    caseGroupAndSort();
    caseVisibility();
    caseClassify();
    caseConversion();
    caseSourceGuards();
    caseDecimals();
    caseUnitChips();
    caseDecisions();
    caseCountUnits();
    caseSessionKey();
    caseSkipVisible();
    await caseCommitExecution();

    console.log(`\n[run_T_OPTAELLING] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_OPTAELLING] Uventet fejl:', err);
    process.exit(1);
});
