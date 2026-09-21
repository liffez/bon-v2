// scripts/test-recipe-udfold.js
// ============================================================
// Udfoldningen af en underopskrift (designer-spec §6.3).
//
// Påstanden: mængderne i udfoldningen er dem LINJEN bruger — ikke opskriftens
// fulde hold — og faktoren er den SAMME som kostprisen og lagertrækket
// skalerer med. Er de to uenige, viser udfoldningen noget andet end der sker,
// og så er den værre end ingen udfoldning (#360's fejlklasse).
//
// To regler, to kodeveje:
//   nesting        faktor = portioner / base_servings
//   halvfabrikat   faktor = mængde / udbytte-i-LAGER-enhed
//
// §2 er beviset for at de to er ægte forskellige: SAMME opskrift, samme
// faktor — men den ene når frem via base_servings (64) og den anden via
// udbyttet i kilo (3,84). Rammer begge 0,25, er begge regler i brug.
//
// Kører uden Grocy og uden DB: fixturen er et read-only udtræk fra grocy-hq.
//
// Kør:  node scripts/test-recipe-udfold.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const nær = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

const draftLag = require('../services/recipeDraft');

function grocyData(over) {
    return Object.assign({
        recipes: SNAP.recipes,
        pos: SNAP.recipes_pos,
        nestings: SNAP.recipes_nestings,
        products: SNAP.products,
        units: SNAP.quantity_units,
        conversions: SNAP.quantity_unit_conversions,
        groups: [],
        priceByProduct: new Map(),
        priceDetailByProduct: new Map(),
    }, over || {});
}

/** Opskriftens egne mængder, uskaleret — det udfoldningen IKKE må vise. */
function egneMængder(rid) {
    return SNAP.recipes_pos.filter(p => Number(p.recipe_id) === rid)
        .map(p => Number(p.amount));
}

const g = grocyData();
const U = (id, kind, amount, data) => draftLag.expandUsage(id, { kind, amount }, data || g);

// ── §1 Halvfabrikat: mængde / udbytte ─────────────────────────
console.log('\n── §1 Halvfabrikat skaleres med UDBYTTET ─────────────────');
{
    // Chili Mayo: 1,1 kg udbytte. En linje bruger 0,055 kg → faktor 0,05.
    const r = U(110, 'semi', 0.055);
    ok(r != null && r.scaled === true, 'kan regnes om — `scaled` siger det selv');
    ok(nær(r.factor, 0.05), 'faktor = 0,055 / 1,1 = 0,05 (fik ' + r.factor + ')');
    ok(r.factor_basis === 'yield', 'grundlaget er udbyttet, ikke portionerne');
    ok(nær(r.yield.stock_amount, 1.1), 'udbyttet rapporteres (1,1 kg)');

    const egne = egneMængder(110);
    const vist = r.lines.filter(l => l.kind === 'product').map(l => l.amount);
    ok(vist.length === egne.length && vist.length > 0, 'alle råvarelinjer er med (' + vist.length + ')');
    ok(vist.every((v, i) => nær(v, egne[i] * 0.05)),
       'hver råvare er skaleret: ' + egne[0] + ' → ' + vist[0]);
    // Kontrolprøven: uden skalering ville tallene VÆRE opskriftens egne.
    ok(!vist.some((v, i) => nær(v, egne[i])),
       'ingen linje står med opskriftens eget tal — ellers måler §1 ingenting');
}

// ── §2 Samme opskrift, to regler, samme svar ──────────────────
console.log('\n── §2 De to regler er ægte forskellige ───────────────────');
{
    // Skære Slider Brød: base_servings 64, udbytte 3,84 kg (1 antal × 64,
    // omregnet til lager-enhed). En fjerdedel er 16 portioner ELLER 0,96 kg.
    const somNest = U(80, 'nesting', 16);
    const somSemi = U(80, 'semi', 0.96);
    ok(nær(somNest.factor, 0.25), 'nesting: 16 / 64 portioner = 0,25 (fik ' + somNest.factor + ')');
    ok(nær(somSemi.factor, 0.25), 'halvfabrikat: 0,96 / 3,84 kg = 0,25 (fik ' + somSemi.factor + ')');
    ok(somNest.factor_basis === 'servings' && somSemi.factor_basis === 'yield',
       'de når frem ad hver sin vej');
    // Udbyttet er 3,84 og ikke 64: konverteringen antal → kilo ER brugt.
    ok(nær(somSemi.yield.stock_amount, 3.84),
       'udbyttet er regnet om til lager-enhed (3,84 kg, ikke 64 antal)');
    const a = somNest.lines.map(l => l.amount), b = somSemi.lines.map(l => l.amount);
    ok(a.length && a.every((v, i) => nær(v, b[i])), 'og de giver samme mængder');
}

// ── §3 Nestings inde i udfoldningen skaleres med ──────────────
console.log('\n── §3 En nesting i udfoldningen følger samme faktor ──────');
{
    // Slider-boksen nester tre sliders à 1 portion. En halv boks = en halv af hver.
    const r = U(77, 'nesting', 0.5);
    const sub = r.lines.filter(l => l.kind === 'sub_recipe');
    ok(sub.length === 3, 'boksens tre sliders er med');
    ok(sub.every(s => nær(s.amount, 0.5)),
       'hver slider står som 0,5 portion, ikke 1 (' + sub.map(s => s.amount).join(', ') + ')');
    ok(sub.every(s => s.unit === 'portion'), 'og måles i portioner');
}

// ── §4 Ukendt faktor: sig det, gæt ikke ───────────────────────
console.log('\n── §4 Kan den ikke regnes om, står opskriftens egne tal ──');
{
    // Falaffel- stegning lægger ingen vare på lager → intet udbytte at måle mod.
    const r = U(97, 'semi', 5);
    ok(r.scaled === false && r.factor == null, 'ingen faktor — `scaled: false`');
    ok(/lægger ingen vare på lager/.test(r.reason || ''), 'grunden står der: ' + r.reason);
    const egne = egneMængder(97);
    ok(r.lines.filter(l => l.kind === 'product').every((l, i) => nær(l.amount, egne[i])),
       'mængderne er opskriftens EGNE — ikke skaleret med et gæt');

    // Samme vej når udbyttet mangler på en opskrift der ELLERS producerer en vare (#372).
    const udenUdbytte = grocyData({
        recipes: SNAP.recipes.map(x => Number(x.id) === 110
            ? { ...x, userfields: { ...(x.userfields || {}), recipeunitnumber: '' } } : x),
    });
    const u = U(110, 'semi', 0.055, udenUdbytte);
    ok(u.scaled === false && /udbytte/.test(u.reason || ''),
       'manglende udbytte: ' + u.reason);
    ok(u.lines.every((l, i) => nær(l.amount, egneMængder(110)[i])),
       'og heller ikke dér skaleres der');

    // En linje uden mængde er ikke en fejl — den er bare ikke tastet endnu.
    const tom = U(110, 'semi', null);
    ok(tom.scaled === false && /mængde/.test(tom.reason || ''), 'tom mængde: ' + tom.reason);
}

// ── §5 Enheder og navne kommer fra samme sted som tallet ──────
console.log('\n── §5 Enheden følger tallet ──────────────────────────────');
{
    const r = U(110, 'semi', 0.055);
    ok(r.lines.every(l => l.name && !/^#/.test(l.name)), 'alle linjer har et navn');
    ok(r.lines.filter(l => l.kind === 'product').every(l => !!l.unit),
       'og en enhed: ' + r.lines.filter(l => l.kind === 'product').map(l => l.unit).join(', '));
    ok(U(999999, 'semi', 1) === null, 'en ukendt opskrift giver null, ikke et tomt svar');
}

// ── §6 Små tal vises som gram og ml ──────────────────────────
// Reglen er `quConvert.autoFormatAmount` — den samme råvare-modalen bruger.
// Den bor på serveren, så udfoldningen og resten af huset ikke kan skride
// fra hinanden. Lager-enheden bliver stående ved siden af: det er DEN
// kostprisen og lagertrækket regner i (B7).
console.log('\n── §6 Gram og ml frem for fire decimaler ─────────────────');
{
    const { autoFormatAmount } = require('../services/quConvert');

    const r = U(110, 'semi', 0.055);
    const små = r.lines.filter(l => l.unit && /^kilo|^kg$/i.test(l.unit) && l.amount < 1);
    ok(små.length > 0, 'fixturen HAR små kg-mængder at formatere (' + små.length + ')');
    ok(små.every(l => /^g$/i.test(l.display_unit)),
       'de vises i gram: ' + små.slice(0, 3).map(l => l.display_amount + ' ' + l.display_unit).join(' · '));
    ok(små.every(l => nær(l.display_amount, Math.round(l.amount * 1000 * 100) / 100)),
       'og tallet er ganget med 1000 — ikke rundet væk');

    // Sandheden bliver stående. Et felt med to betydninger er dét #352 kostede.
    ok(r.lines.every(l => l.amount != null && l.unit != null),
       'lager-enheden står uberørt ved siden af visningen');

    // Reglen må ikke være en kopi der kan skride: samme svar som motorens.
    ok(r.lines.every(l => {
        const f = autoFormatAmount(l.amount, l.unit || '');
        return nær(l.display_amount, f.amount) && (f.unit || l.unit) === l.display_unit;
    }), 'og den er quConvert.autoFormatAmount, ikke en parallel udgave');

    // Over 1 kg er kg det rigtige svar — vi omregner ikke for omregningens skyld.
    const stor = U(110, 'semi', 55);
    const store = stor.lines.filter(l => l.unit && /^kilo|^kg$/i.test(l.unit) && l.amount >= 1);
    ok(store.length > 0 && store.every(l => /^kilo|^kg$/i.test(l.display_unit)),
       'mængder over 1 kg bliver i kg (' + store.length + ')');

    // Hovedets to tal går gennem samme regel.
    ok(r.used_display && /^g$/i.test(r.used_display.unit) && nær(r.used_display.amount, 55),
       '«det der bruges her» står som ' + (r.used_display && r.used_display.amount + ' ' + r.used_display.unit));
    ok(r.yield && r.yield.display && nær(r.yield.display.amount, 1.1),
       'udbyttet bliver i kg: ' + (r.yield && r.yield.display && (r.yield.display.amount + ' ' + r.yield.display.unit)));

    // Liter går samme vej — reglen er ikke kun skrevet for kilo.
    const væsker = r.lines.filter(l => l.unit && /^liter$|^l$/i.test(l.unit) && l.amount < 1);
    ok(væsker.length > 0, 'fixturen HAR en lille liter-mængde (' + væsker.length + ')');
    ok(væsker.every(l => /^ml$/i.test(l.display_unit) && nær(l.display_amount, Math.round(l.amount * 1000 * 100) / 100)),
       'den vises i ml: ' + væsker.map(l => l.display_amount + ' ' + l.display_unit).join(' · '));

    // En stk-enhed er ikke en masse og må ikke blive til noget andet.
    const stk = r.lines.filter(l => l.unit && /antal|stk/i.test(l.unit));
    ok(stk.every(l => l.display_unit === l.unit), 'stk-enheder røres ikke');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);
