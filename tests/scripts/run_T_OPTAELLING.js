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
    ok('12n antal-felt er type=text + inputmode=decimal',
        SRC.indexOf('inputmode="decimal" class="ic-qty-input"') !== -1 &&
        SRC.indexOf('type="number" class="ic-qty-input"') === -1);
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

    // Commit-stien: "Skal ikke tælles fast" rydder HverDag.
    ok('9b commit skriver HverDag=""',
       /putGrocyProductUserfields\(\s*dpid\s*,\s*\{\s*HverDag:\s*''\s*\}\s*\)/.test(SRC));

    // "Varen findes ikke mere": lager 0 + deaktivér produktet.
    ok('10b commit sætter lager til 0', /postGrocyInventory\(dpid,\s*0\)/.test(SRC));
    ok('10c commit deaktiverer produktet', /putGrocyProduct\(dpid,\s*\{\s*active:\s*0\s*\}\)/.test(SRC));

    // Destruktivt → skal bekræftes (3 tryk i alt, spec §7).
    const decideFn = SRC.slice(SRC.indexOf('function _icDecide'), SRC.indexOf('function _icSetCountUnit'));
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

    // Brøk-knapperne: "en kvart pakke" giver kun mening når tælleenheden er
    // STØRRE end lagerenheden. For en mindre enhed (gram af kilo) ville
    // "¼ gram" være meningsløst — der beholder brøken sin gamle betydning.
    const frac = SRC.slice(SRC.indexOf('function _icSetFraction'),
                           SRC.indexOf('function _icRefreshFractionLabels'));
    ok('13j brøk deler ÉN stykvare via _icIsPackUnit', /_icIsPackUnit\(toStock\)/.test(frac));
    ok('13k målenhed falder tilbage til andel af forventet lager',
       /grocy\s*\*\s*fraction\)\s*\/\s*toStock/.test(frac));

    // Stykvare vs. målenhed. Kålhovedet (0,8 kg) er det vigtige tilfælde: det er
    // mindre end lagerenheden, men "et halvt kålhoved" giver god mening.
    ok('13l lagerenhed er ikke en stykvare', IC._icIsPackUnit(1) === false);
    ok('13m bøtte (0,25 kg) er en stykvare', IC._icIsPackUnit(0.25) === true);
    ok('13n hovedkål (0,8 kg) er en stykvare', IC._icIsPackUnit(0.8) === true);
    ok('13o kasse (5 kg) er en stykvare', IC._icIsPackUnit(5) === true);
    ok('13p gram (0,001 kg) er en målenhed', IC._icIsPackUnit(0.001) === false);
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

// ── Main ────────────────────────────────────────────────────
function main() {
    console.log('[run_T_OPTAELLING] Pure runner — ingen server/Grocy');
    // Verificér export-guard
    const required = ['_icGroupOf', '_icVisibleInUnit', '_icClassifyCounted', '_icCategorize',
                      '_icFindFactor', '_icGetUnitsForLocation', '_icFmt', '_icParseNum', '_ic',
                      '_icCountUnitOptions', '_icPickCountUnit', '_icLocalDate', '_icIsPackUnit',
                      '_icSessionKey', '_icSessionIsOld', '_icSaveCount'];
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

    console.log(`\n[run_T_OPTAELLING] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main();
