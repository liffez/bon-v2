// scripts/test-wish-lines.js
// ============================================================
// Kundens ret-linjer: bestillingsformularens genkendelse + bonens advarsel.
//
// Baggrund (drift, B4259 4. sep 2026): kunden skrev "3× Kyllingen (1 without
// mayonaise)" i kundeønske-feltet. Formularens gamle getCurrentCount krævede
// at linjen sluttede LIGE efter retnavnet, så noten i parentesen gjorde at
// Kyllingen faldt ud af menu_items[] — og bonen fik 4 af 7 bestilte retter.
// Ingen advarede. Samme fejl ramte B4222 (1 x Falaflen (GLUTENFRI)) 25/8.
//
// Den modsatte fejl fandtes også: to menu-retter med samme navn fik BEGGE
// tællingen, så B4145 fik 14 linjer for 8 bestilte retter.
//
// Browser-kode kan ikke require'es, så både shared/utils.js og formularens
// egen blok køres i en vm-sandkasse — de SAMME funktioner browseren bruger,
// ikke en kopi. §3 asserterer at de to matchere svarer ens; går de fra
// hinanden, viser formularen noget andet end bonen får.
//
// Kør:  npm run test:wish-lines
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}
function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    ok(a === e, label, a === e ? '' : `fik      ${a}\n      ventede  ${e}`);
}
const ROOT = path.join(__dirname, '..');

// En assert der KASTER er et dårligere signal end en der fejler: mutationstesten
// skal se en rød linje med navn, ikke en stak der ligner et brudt testscript.
function check(fn, label) {
    try { fn(); } catch (e) { fail++; console.log(`  ✗ ${label}\n      kastede: ${e.message}`); }
}
// `const selectedItems` er en lexical binding i vm-contexten og bliver ikke en
// property på sandkassen — den skal læses inde i realmet.
function items0(f) { return JSON.parse(vm.runInContext('JSON.stringify(Object.fromEntries(selectedItems))', f.F)); }

/* ══════════════════════════════════════════════════════════════
   Sandkasse 1 — shared/utils.js (bonens side)
   ══════════════════════════════════════════════════════════════ */
const noop = () => {};
const stubEl = { addEventListener: noop, appendChild: noop, remove: noop, textContent: '',
                 innerHTML: '', hidden: false, dataset: {}, style: {},
                 classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                 querySelector: () => null, querySelectorAll: () => [], closest: () => null };
function baseSandbox() {
    const s = {
        console,
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                    createElement: () => Object.assign({}, stubEl), addEventListener: noop,
                    body: Object.assign({}, stubEl), activeElement: null },
        navigator: { userAgent: 'node' },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        sessionStorage: { getItem: () => null, setItem: noop },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        setTimeout, clearTimeout, setInterval, clearInterval,
        EventSource: function () { this.addEventListener = noop; this.close = noop; },
    };
    s.window = s; s.globalThis = s;
    return s;
}
const U = baseSandbox();
vm.createContext(U);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/utils.js'), 'utf8'), U, { filename: 'utils.js' });

/* ══════════════════════════════════════════════════════════════
   Sandkasse 2 — bestillingsformularens menu-blok
   ══════════════════════════════════════════════════════════════
   Kun blokken fra STRUCT_HEADER til og med input-handleren skæres ud;
   resten af siden (fetch, DAWA, cutoff) er uvedkommende her.
   ══════════════════════════════════════════════════════════════ */
const html = fs.readFileSync(path.join(ROOT, 'public/embed/bestilling.html'), 'utf8');
const start = html.indexOf("const STRUCT_HEADER = '--- Valgte Menu ---';");
const endMark = html.indexOf('// LOCALSTORAGE', start);
if (start < 0 || endMark < 0) {
    console.error('FEJL: kunne ikke finde menu-blokken i public/embed/bestilling.html');
    process.exit(1);
}
const formBlock = html.slice(start, html.lastIndexOf('});', endMark) + 3);

function makeForm(menu) {
    const wishes = { value: '', addEventListener: noop };
    const badge = { textContent: '', classList: { toggle: noop, add: noop, remove: noop } };
    const F = baseSandbox();
    F.document.getElementById = (id) => (id === 'wishes' ? wishes : id === 'menu-link-badge' ? badge : null);
    F.document.querySelectorAll = () => [];
    F.MENU = menu;
    F.postHeight = noop;
    vm.createContext(F);
    vm.runInContext(formBlock, F, { filename: 'bestilling.html:menu-blok' });
    return { F, wishes, badge };
}

// Menuen som den ser ud i drift for de retter sagen handler om
const MENU = [
    { id: 'r34', name: 'Kyllingen' },
    { id: 'r88', name: 'Kyllingen BBQ- Salat' },
    { id: 'r23', name: 'Ægget' },
    { id: 'r25', name: 'Frikadellen' },
    { id: 'r91', name: 'Falaflen' },
    { id: 'r12', name: 'Fisken' },
];

console.log('\n§1 FORMULAREN — genkender retten bag kundens note\n');

{
    // Præcis teksten fra B4259
    const f = makeForm(MENU);
    f.wishes.value = [
        '1× Ægget',
        '1× Frikadellen',
        '2× Kyllingen BBQ- Salat',
        '3× Kyllingen (1 without mayonaise)',
    ].join('\n');
    const { dishes } = f.F.parseWishes(f.wishes.value);
    f.F.syncSelected(dishes);

    eq(dishes.map(d => `${d.count}×${d.name}`),
       ['1×Ægget', '1×Frikadellen', '2×Kyllingen BBQ- Salat', '3×Kyllingen'],
       'B4259: alle fire linjer genkendes — noten stopper ikke Kyllingen');
    eq(dishes[3].note, '(1 without mayonaise)', 'kundens note bevares på linjen');
    eq(items0(f), { r23: 1, r25: 1, r88: 2, r34: 3 }, 'menu_items[] bærer alle 7 retter');
    eq(Object.values(items0(f)).reduce((a, b) => a + b, 0), 7,
       'alle 7 bestilte retter når frem — bonen fik 4 før rettelsen');
}

{
    const f = makeForm(MENU);
    f.wishes.value = '1 x Falaflen (GLUTENFRI)';    // B4222, mellemrum om x
    const { dishes } = f.F.parseWishes(f.wishes.value);
    f.F.syncSelected(dishes);
    eq(items0(f), { r91: 1 }, 'B4222: "1 x Falaflen (GLUTENFRI)" genkendes');
}

{
    const f = makeForm(MENU);
    f.wishes.value = '2× Kyllingen BBQ- Salat';
    const { dishes } = f.F.parseWishes(f.wishes.value);
    eq(dishes[0].name, 'Kyllingen BBQ- Salat',
       'længste match vinder — "Kyllingen" sluger ikke "Kyllingen BBQ- Salat"');
}

{
    const f = makeForm(MENU);
    f.wishes.value = '3× Fiskens fornemmelse';
    const { dishes } = f.F.parseWishes(f.wishes.value);
    eq(dishes[0].id, null, 'ordgrænse: "Fisken" rammer ikke "Fiskens ..."');
}

{
    // Menuen HAR haft to retter med samme navn (r161/r25 i juni). Begge fik
    // tællingen, så bonen blev bestilt dobbelt.
    const dupMenu = MENU.concat([{ id: 'r161', name: 'Frikadellen' }]);
    const f = makeForm(dupMenu);
    f.wishes.value = '5× Frikadellen';
    const { dishes } = f.F.parseWishes(f.wishes.value);
    f.F.syncSelected(dishes);
    eq(items0(f), { r25: 5 }, 'dublet-navn i menuen tælles ÉN gang, ikke to');
}

{
    const f = makeForm(MENU);
    f.wishes.value = '36× kyllinge salat m. brød';
    const { dishes } = f.F.parseWishes(f.wishes.value);
    f.F.syncSelected(dishes);
    eq(items0(f), {}, 'fri tekst bliver ikke til en bestilling — vi gætter ikke');
    eq(dishes[0].name, 'kyllinge salat m. brød', 'men linjen bevares ordret i feltet');
}

console.log('\n§1b FORMULAREN — at klikke igen bevarer noten\n');

{
    const f = makeForm(MENU);
    f.wishes.value = '3× Kyllingen (1 uden mayo)';
    f.F.addItem({ id: 'r34', name: 'Kyllingen' });
    eq(f.wishes.value, '4× Kyllingen (1 uden mayo)',
       'optælling rører ikke kundens note');
    eq(items0(f), { r34: 4 }, 'state følger med');
}

{
    const f = makeForm(MENU);
    f.wishes.value = 'Vi kommer kl. 12\n\n--- Valgte Menu ---\n2× Ægget';
    f.F.addItem({ id: 'r34', name: 'Kyllingen' });
    ok(f.wishes.value.startsWith('Vi kommer kl. 12'), 'fri tekst står øverst');
    ok(f.wishes.value.includes('--- Valgte Menu ---\n2× Ægget\n1× Kyllingen'),
       'retter samles i én blok under headeren');
    eq((f.wishes.value.match(/Valgte Menu/g) || []).length, 1, 'headeren dubleres ikke');
}

{
    const f = makeForm(MENU);
    f.wishes.value = 'Note\n\n--- Valgte Menu --\n2× Ægget';   // gammel header, to streger
    f.F.addItem({ id: 'r23', name: 'Ægget' });
    eq((f.wishes.value.match(/Valgte Menu/g) || []).length, 1,
       'gammel header genkendes og hober sig ikke op');
    eq(items0(f), { r23: 3 }, 'og retten under den tælles med');
}

console.log('\n§2 BONEN — hvad står i kundens tekst som ikke står på bonen\n');

const { wishLineDiff, parseWishDishes, matchDishName } = U;

{
    // B4259, som bonen faktisk så ud
    const wishes = [
        'Sandwichvalg: Eget valg', '',
        '1× Ægget', '1× Frikadellen', '2× Kyllingen BBQ- Salat',
        '3× Kyllingen (1 without mayonaise)', '',
        '[Form: standard v2026-08-05]',
    ].join('\n');
    const lines = [
        { product_name: 'Frikadellen', quantity: 1, category: '01 Sandwich' },
        { product_name: 'Ægget', quantity: 1, category: '01 Sandwich' },
        { product_name: 'Kyllingen BBQ- Salat', quantity: 2, category: '02 Salat' },
    ];
    const d = wishLineDiff(wishes, lines);
    ok(d !== null, 'B4259 giver en advarsel');
    eq(d && d.missing, [{ count: 3, text: 'Kyllingen (1 without mayonaise)' }],
       'og den navngiver præcis den ret der mangler');
    eq(d && d.differs, [], 'de tre andre stemmer og nævnes ikke');
}

{
    const lines = [
        { product_name: 'Ægget', quantity: 1, category: '01 Sandwich' },
        { product_name: 'Kyllingen', quantity: 3, category: '01 Sandwich' },
    ];
    ok(wishLineDiff('1× Ægget\n3× Kyllingen (1 uden mayo)', lines) === null,
       'stemmer det, siges der intet — advarslen forsvinder når office har rettet');
}

{
    const lines = [
        { product_name: 'Ægget', quantity: 1, category: '01 Sandwich' },
        { product_name: 'RR Boks', quantity: 7, category: '06 Emballage' },
        { product_name: 'Levering', quantity: 1, category: 'x-Levering' },
    ];
    ok(wishLineDiff('1× Ægget', lines) === null,
       'emballage og levering vi selv lægger på larmer ikke — vi går kun tekst → bon');
    const d = wishLineDiff('1× Ægget\n2× RR Boks', lines);
    eq(d && d.differs, [{ name: 'RR Boks', want: 2, have: 7 }],
       'men nævner kunden emballagen, kan antallet sammenlignes');
}

{
    const lines = [{ product_name: 'Ægget', quantity: 1, category: '01 Sandwich' },
                   { product_name: 'Kyllingen', quantity: 4, category: '01 Sandwich' }];
    ok(wishLineDiff('1× Ægget', lines) === null,
       'bonen må gerne have MERE end teksten — office tilføjer efter aftale');
}

{
    const lines = [{ product_name: 'Kyllingen', quantity: 1, category: '01 Sandwich' }];
    const d = wishLineDiff('3× Kyllingen', lines);
    eq(d && d.differs, [{ name: 'Kyllingen', want: 3, have: 1 }],
       'afvigende antal nævnes med begge tal');
}

{
    // B4224: kunden skrev samme ret på to linjer
    const lines = [{ product_name: 'kyllingen', quantity: 3, category: '01 Sandwich' }];
    const d = wishLineDiff('3× kyllingen\n3× kyllingen', lines);
    eq(d && d.differs, [{ name: 'kyllingen', want: 6, have: 3 }],
       'to tekstlinjer med samme ret lægges sammen (B4224)');
}

{
    ok(wishLineDiff('Vi vil gerne have noget godt', []) === null,
       'tekst uden ret-linjer giver intet at holde op imod');
    ok(wishLineDiff(null, null) === null, 'tom bon uden ønsker er stille');
}

{
    const d = wishLineDiff('1× glutenfri\n5× vegetar', [{ product_name: 'Ægget', quantity: 6, category: '01 Sandwich' }]);
    eq(d && d.missing.map(m => m.text), ['glutenfri', 'vegetar'],
       'kostønsker i N×-form bliver også nævnt — office skal handle på dem');
}

{
    const { dishes, free } = parseWishDishes('Hej\n2× Ægget\n\nMvh');
    eq(dishes, [{ count: 2, rest: 'Ægget' }], 'ret-linjer skilles fra fri tekst');
    eq(free, ['Hej', '', 'Mvh'], 'og fri tekst bevares i rækkefølge');
}

console.log('\n§2b BONEN — færre enheder end gæster\n');

{
    const { unitPaxHint } = U;

    // Sliders er 2-3 pr. gæst. Reglen må ALDRIG fyre på dem — det ville være
    // 123 falske alarmer i 2026 alene.
    ok(unitPaxHint(6, 24, true) === null, 'slider-bon (6 pax, 24 enheder) er tavs');
    ok(unitPaxHint(50, 153, true) === null, 'buffet (51 pax, 153 enheder) er tavs');
    ok(unitPaxHint(8, 8, true) === null, 'enheder = pax er tavs');

    // Det den SKAL fange
    eq(unitPaxHint(8, 4, true), { kind: 'few', pax: 8, units: 4 },
       'B4259: 4 enheder til 8 pax nævnes');
    eq(unitPaxHint(50, 0, true), { kind: 'zero', pax: 50, units: 0 },
       'B4123: 0 enheder med varer på bonen nævnes særskilt');

    // Det den ikke må larme om
    ok(unitPaxHint(8, 0, false) === null, 'tom, netop oprettet bon er ufærdig — ikke forkert');
    ok(unitPaxHint(0, 0, true) === null, 'bon uden pax siger intet');
    ok(unitPaxHint(null, null, true) === null, 'manglende tal vælter ikke reglen');

    // Brugerens eget eksempel: kunden skrev 8 pax men bestilte 7 retter.
    // Det ER legitimt — men reglen nævner det, for det er ikke til at se
    // forskel på "én spiser ikke med" og "en ret faldt ud".
    eq(unitPaxHint(8, 7, true), { kind: 'few', pax: 8, units: 7 },
       '7 til 8 nævnes også — forskellen er ikke vores at afgøre');
}

console.log('\n§3 DE TO KOPIER AF REGLEN SVARER ENS\n');

{
    const names = MENU.map(m => m.name);
    const f = makeForm(MENU);
    const cases = [
        'Kyllingen (1 without mayonaise)', 'Kyllingen BBQ- Salat', 'Kyllingen',
        'Falaflen (GLUTENFRI)', 'Fiskens fornemmelse', 'Fisken',
        'kyllinge salat m. brød', 'Ægget - uden mayo', 'ÆGGET', '',
        'Frikadellen, 2 uden løg', 'Kyllingen BBQ- Salat (glutenfri)',
    ];
    let enige = 0;
    for (const c of cases) {
        const a = matchDishName(c, names);
        const b = f.F.matchDish(c, names);
        const same = JSON.stringify(a) === JSON.stringify(b);
        if (same) enige++;
        else ok(false, `uenige om "${c}"`, `utils ${JSON.stringify(a)}\n      form  ${JSON.stringify(b)}`);
    }
    ok(enige === cases.length,
       `formularens matchDish og utils' matchDishName er enige (${enige}/${cases.length})`);
}

console.log(`\n${'═'.repeat(60)}\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
