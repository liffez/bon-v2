// scripts/test-menu-order-groups.js
// ============================================================
// Menu-rækkefølge og -grupper på bon-draweren og i info-modalen.
//
// Baggrund: bon-kortet har altid sorteret emballage/service/levering
// nederst (_sortAndMergeMenu i shared/utils.js), men draweren viste rå
// DB-rækkefølge og info-modalen delte op på `is_accessory` — et flag der
// i praksis aldrig er sat (0 af ~8.200 emballage-linjer i drift). Begge
// flader lod derfor emballage og levering lande midt i maden.
//
// Reglen er nu udtrukket til sortMenuLines/isBottomMenuLine og delt af
// alle tre flader. Draweren kan desuden lave de samme menu-grupper som
// køkkenets bon-kort (bon_menu_groups + PUT /bons/:id/menu-groups).
//
// Browser-kode kan ikke require'es, så filerne køres i en vm-sandkasse og
// de rigtige funktioner kaldes direkte — ikke en kopi.
//
// Kør:  node scripts/test-menu-order-groups.js
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

/* ── Sandkasse: kun det utils.js rører ved indlæsning ────────────── */
const noop = () => {};
const stubEl = { addEventListener: noop, appendChild: noop, removeChild: noop, remove: noop,
                 textContent: '', innerHTML: '', hidden: false, dataset: {}, style: {},
                 classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                 querySelector: () => null, querySelectorAll: () => [], closest: () => null,
                 insertBefore: noop, focus: noop, select: noop };
const sandbox = {
    console,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                createElement: () => Object.assign({}, stubEl), addEventListener: noop,
                body: Object.assign({}, stubEl, { classList: { contains: () => false, add: noop, remove: noop } }),
                activeElement: null },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    EventSource: function () { this.addEventListener = noop; this.close = noop; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const root = path.join(__dirname, '..');
vm.runInContext(fs.readFileSync(path.join(root, 'shared', 'utils.js'), 'utf8'), sandbox, { filename: 'utils.js' });

const { sortMenuLines, isBottomMenuLine, menuLinePriority, _sortAndMergeMenu, normalizeMenuCategory } = sandbox;

/* ── Fixture: B4165 fra drift, i den rå rækkefølge DB gav ────────── */
const B4165 = [
    { id: 1, product_name: '"Tunen" Spicy slider',              category: '04 Slider',    quantity: 7,  line_total: 392 },
    { id: 2, product_name: 'Æggesalaten slider',                 category: '04 Slider',    quantity: 7,  line_total: 420 },
    { id: 3, product_name: 'Ægget slider',                       category: '04 Slider',    quantity: 7,  line_total: 420 },
    { id: 4, product_name: 'Frikadellen Slider',                 category: '04 Slider',    quantity: 7,  line_total: 455 },
    { id: 5, product_name: 'Kartoflen slider',                   category: '04 Slider',    quantity: 7,  line_total: 392 },
    { id: 6, product_name: 'Kyllingen slider',                   category: '04 Slider',    quantity: 21, line_total: 1260 },
    { id: 7, product_name: 'Transportkasse m låg (emballage)',   category: '06 Emballage', quantity: 2,  line_total: 50 },
    { id: 8, product_name: 'Levering med El-Taxa',               category: 'x-Levering',   quantity: 1,  line_total: 230 },
    { id: 9, product_name: 'Fisken Slider',                      category: '04 Slider',    quantity: 7,  line_total: 420 },
    { id: 10, product_name: 'Grisen på Rug slider',              category: '04 Slider',    quantity: 7,  line_total: 525 },
];

console.log('\n── 1. Kategori-prioritet ───────────────────────────────');

eq(normalizeMenuCategory('x- Service'), 'x-service', 'Grocys "x- Service" normaliseres (mellemrum efter x-)');
eq(normalizeMenuCategory('  06 Emballage '), '06 emballage', 'trim + lowercase');
eq(normalizeMenuCategory(null), '', 'null → tom streng, ikke crash');

ok(menuLinePriority({ category: '03 Kager' })  === 0, 'kager ligger øverst');
ok(menuLinePriority({ category: '05 Drikke' }) === 0, 'drikke ligger øverst');
ok(menuLinePriority({ category: '01 Sandwich' }) === 1, 'mad ligger i midten');
ok(menuLinePriority({ category: '06 Emballage' }) === 10, 'emballage → 10');
ok(menuLinePriority({ category: 'x- Service' })   === 11, 'service → 11');
ok(menuLinePriority({ category: 'x-Levering' })   === 12, 'levering → 12');
ok(menuLinePriority({ category: '06 Emballage' }) < menuLinePriority({ category: 'x-Levering' }),
   'emballage før levering i bunden');

// is_accessory er i praksis aldrig sat, men må stadig virke når den ER sat
ok(menuLinePriority({ category: 'Ukendt', is_accessory: 1 }) === 10, 'is_accessory=1 → bundgruppen');
ok(menuLinePriority({ category: 'Ukendt', style: 'emballage' }) === 10, 'kort-items: style=emballage → bundgruppen');
ok(menuLinePriority({ category: 'Ukendt' }) === 1, 'ukendt kategori uden flag → midten (ikke skjult i bunden)');

console.log('\n── 2. Sortering (den fejl brugeren så) ─────────────────');

const sorted = sortMenuLines(B4165);
const names = sorted.map(l => l.product_name);

ok(names[names.length - 2] === 'Transportkasse m låg (emballage)', 'emballage næstsidst');
ok(names[names.length - 1] === 'Levering med El-Taxa',             'levering sidst');
ok(!names.slice(0, -2).some(n => /emballage|Levering/i.test(n)),
   'ingen emballage/levering blandt maden', names.slice(0, -2).join(', '));
ok(sorted.length === B4165.length, 'ingen linjer tabt i sorteringen');
eq(B4165.map(l => l.id), [1,2,3,4,5,6,7,8,9,10], 'input muteres ikke');

// Stabilitet: to rå rækker af samme vare skal beholde deres orden
// (draweren viser dem bevidst hver for sig, så man kan slette den enkelte)
const dupes = sortMenuLines([
    { id: 101, product_name: 'Kyllingen', category: '01 Sandwich' },
    { id: 102, product_name: 'Kyllingen', category: '01 Sandwich' },
]);
eq(dupes.map(l => l.id), [101, 102], 'ens rå rækker beholder indbyrdes rækkefølge');

const kager = sortMenuLines([
    { id: 1, product_name: 'Sandwich', category: '01 Sandwich' },
    { id: 2, product_name: 'Brownie',  category: '03 Kager' },
]);
eq(kager.map(l => l.id), [2, 1], 'kager sorteres op over maden');

eq(sortMenuLines([]), [], 'tom liste → tom liste');
eq(sortMenuLines(null), [], 'null → tom liste, ikke crash');

// Diskriminator: B4165 alene beviser for lidt, fordi dens kategorinavne
// tilfældigvis er næsten alfabetisk ordnede — en ren localeCompare ville
// give nogenlunde samme svar. Her er fem ÆGTE driftskategorier hvor
// alfabetisk og korrekt rækkefølge peger hver sin vej:
//   alfabetisk: 03 Kager · 06 Emballage · Frugt · Tilbehør & Bokse · x-Levering
//   korrekt:    03 Kager · Frugt · Tilbehør & Bokse · 06 Emballage · x-Levering
const mixed = [
    { id: 1, product_name: 'Transportkasse', category: '06 Emballage' },
    { id: 2, product_name: 'Børne Bokse',    category: 'Tilbehør & Bokse' },
    { id: 3, product_name: 'Levering',       category: 'x-Levering' },
    { id: 4, product_name: 'Æblekurv',       category: 'Frugt' },
    { id: 5, product_name: 'Brownie',        category: '03 Kager' },
];
eq(sortMenuLines(mixed).map(l => l.id), [5, 4, 2, 1, 3],
   'kategorier hvor alfabetisk ≠ korrekt: kager → mad → emballage → levering');

// Prioritet skal slå kategorinavnet, ikke omvendt
const alfaFaelde = sortMenuLines([
    { id: 1, product_name: 'Kasse', category: '06 Emballage' },
    { id: 2, product_name: 'Boks',  category: 'Tilbehør & Bokse' },
]);
eq(alfaFaelde.map(l => l.id), [2, 1],
   '"Tilbehør & Bokse" er mad og skal OVER emballage, selvom det sorterer efter alfabetisk');

// is_accessory-flaget skal virke i selve sorteringen, ikke kun i prioriteten
const flagged = sortMenuLines([
    { id: 1, product_name: 'Serviet',  category: 'Andet', is_accessory: 1 },
    { id: 2, product_name: 'Sandwich', category: '01 Sandwich' },
]);
eq(flagged.map(l => l.id), [2, 1], 'is_accessory-linje sorteres ned til bunden');

console.log('\n── 3. isBottomMenuLine (dæmpning + skillelinje) ────────');

ok(isBottomMenuLine({ category: '06 Emballage' }) === true,  'emballage er bundlinje');
ok(isBottomMenuLine({ category: 'x-Levering' })   === true,  'levering er bundlinje');
ok(isBottomMenuLine({ category: '04 Slider' })    === false, 'mad er ikke bundlinje');
ok(isBottomMenuLine({ category: '03 Kager' })     === false, 'kager er ikke bundlinje');

console.log('\n── 4. Bon-kortet er uændret (regression) ───────────────');

// Kortet bruger kort-item-form: {name, qty, category}
const cardItems = B4165.map(l => ({ name: l.product_name, qty: String(l.quantity), category: l.category, line_ids: [l.id] }));
const merged = _sortAndMergeMenu(cardItems);
const mNames = merged.map(i => i.name);
ok(mNames[mNames.length - 2] === 'Transportkasse m låg (emballage)', 'kortet: emballage stadig næstsidst');
ok(mNames[mNames.length - 1] === 'Levering med El-Taxa',             'kortet: levering stadig sidst');
ok(merged.filter(i => i.style === 'emballage').length === 2,
   'kortet: bundlinjer får stadig emballage-styling');

// Merge af ens varer uden særønske
const mergeIn = [
    { name: 'Kyllingen', qty: '3', category: '01 Sandwich', line_ids: [1] },
    { name: 'Kyllingen', qty: '4', category: '01 Sandwich', line_ids: [2] },
    { name: 'Kyllingen', qty: '2', category: '01 Sandwich', special_request: 'uden løg', line_ids: [3] },
];
const mergedOut = _sortAndMergeMenu(mergeIn);
ok(mergedOut.length === 2, 'kortet: ens varer slås stadig sammen (2 rækker ud af 3)');
ok(mergedOut[0].qty === '7', 'kortet: mængder lægges stadig sammen (3+4=7)');
ok(mergedOut[1].special_request === 'uden løg', 'kortet: særønske står stadig for sig, lige efter');

console.log('\n── 5. Draweren: partitionering i grupper ───────────────');

// Draweren er en klasse med DOM-afhængigheder. Partitioneringen —
// den del der afgør HVOR en linje havner — testes ved at kalde
// prototypens metoder på et minimalt objekt.
const drawerSrc = fs.readFileSync(path.join(root, 'shared', 'bon_drawer.js'), 'utf8');
vm.runInContext(drawerSrc, sandbox, { filename: 'bon_drawer.js' });
// `class BonDrawer` lander i contextens lexical scope, ikke som property
// på sandbox-objektet — hentes derfor med en eval i samme context.
const DP = vm.runInContext('BonDrawer', sandbox).prototype;

const groupLines = [
    { id: 1, product_name: 'Kyllingen slider',   category: '04 Slider',    menu_group_id: 7 },
    { id: 2, product_name: 'Transportkasse',     category: '06 Emballage', menu_group_id: null },
    { id: 3, product_name: 'Fisken Slider',      category: '04 Slider',    menu_group_id: 7 },
    { id: 4, product_name: 'Brownie',            category: '03 Kager',     menu_group_id: null },
    { id: 5, product_name: 'Spøgelseslinje',     category: '04 Slider',    menu_group_id: 999 }, // gruppe findes ikke
];
const d = {
    data: { menu_groups: [{ id: 7, title: 'Frokost', note: 'til mødet', sort_order: 0 }], lines: groupLines },
    _groupsDirty: false,
};
DP._syncGroupModel.call(d, groupLines);

eq(d._groups.map(g => g.key), ['g7'], 'gruppe fra serveren får lokal nøgle g<id>');
eq(d._groups[0].title, 'Frokost', 'titel bevares');
eq(d._lineGroup, { 1: 'g7', 3: 'g7' }, 'kun linjer med en EKSISTERENDE gruppe placeres i den');
ok(d._lineGroup[5] === undefined,
   'linje der peger på en slettet gruppe falder ned som løs — ikke usynlig');

// Løse linjer skal stadig sorteres: Brownie (kager) før Transportkasse (emballage)
const loose = groupLines.filter(l => !d._lineGroup[l.id]);
eq(sortMenuLines(loose).map(l => l.id), [4, 5, 2],
   'løse linjer: kager → mad → emballage');

console.log('\n── 6. Draweren: gem-payload ────────────────────────────');

// Serveren reconciler på line_ids, ikke på gruppe-id — derfor må lokale
// nøgler gerne blive stale mellem gem.
const payload = DP._buildGroupPayload.call(d);
eq(payload, [{ title: 'Frokost', note: 'til mødet', line_ids: [1, 3] }],
   'payload bærer titel, note og linje-id\'er');

// Ny gruppe oprettet lokalt (endnu uden DB-id)
const d2 = {
    data: { lines: groupLines },
    _groups: [{ key: 'n1', title: '', note: '' }],
    _lineGroup: { 2: 'n1', 4: 'n1' },
};
const payload2 = DP._buildGroupPayload.call(d2);
eq(payload2, [{ title: '', note: '', line_ids: [2, 4] }],
   'lokal gruppe uden DB-id kan gemmes — serveren normaliserer tom titel');

// Tom gruppe må ikke gemmes (serveren dropper den, men vi sender den ikke)
const d3 = { data: { lines: groupLines }, _groups: [{ key: 'n1', title: 'Tom', note: '' }], _lineGroup: {} };
eq(DP._buildGroupPayload.call(d3), [], 'gruppe uden linjer sendes ikke');

console.log('\n── 7. Draweren: gruppe-handlinger ──────────────────────');

function makeDrawer(lines, groups) {
    const inst = {
        data: { lines, menu_groups: groups || [] },
        _groupsDirty: false, _selectMode: false, _selected: new Set(),
        _groups: [], _lineGroup: {},
        el: { querySelector: () => null, contains: () => false },
        bonId: 1,
        _renderLines: noop, _scheduleSaveGroups: noop, _updateGroupBtn: noop,
        _editGroupTitle: noop, _flushGroupSave: () => Promise.resolve(),
    };
    DP._syncGroupModel.call(inst, lines);
    return inst;
}

const g = makeDrawer(groupLines, [{ id: 7, title: 'Frokost', note: '', sort_order: 0 }]);
g._selected = new Set(['2', '4']);
DP._groupSelected.call(g);
ok(g._groups.length === 2, 'ny gruppe oprettet ved siden af den eksisterende');
ok(g._lineGroup[2] && g._lineGroup[4] && g._lineGroup[2] === g._lineGroup[4],
   'de valgte linjer havner i SAMME nye gruppe');
ok(g._selected.size === 0, 'markeringen ryddes efter gruppering');
ok(g._groupsDirty === true, 'ændringen markeres som ugemt');

// Flyt en allerede grupperet linje over i en ny gruppe
const g2 = makeDrawer(groupLines, [{ id: 7, title: 'Frokost', note: '', sort_order: 0 }]);
g2._selected = new Set(['1']);
DP._groupSelected.call(g2);
ok(g2._lineGroup[1] !== 'g7', 'linje kan flyttes ud af sin gamle gruppe');
ok(g2._lineGroup[3] === 'g7', 'de øvrige linjer i den gamle gruppe rører sig ikke');

// Opløs
const g3 = makeDrawer(groupLines, [{ id: 7, title: 'Frokost', note: '', sort_order: 0 }]);
DP._dissolveGroup.call(g3, 'g7');
ok(g3._groups.length === 0, 'gruppen forsvinder ved opløsning');
eq(g3._lineGroup, {}, 'linjerne bliver liggende som løse — ingen linje slettes');

// Rækkefølge
const g4 = makeDrawer([], []);
g4._groups = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
DP._moveGroup.call(g4, 'b', -1);
eq(g4._groups.map(x => x.key), ['b', 'a', 'c'], 'gruppe kan flyttes op');
DP._moveGroup.call(g4, 'b', -1);
eq(g4._groups.map(x => x.key), ['b', 'a', 'c'], 'øverste gruppe kan ikke flyttes ud over kanten');
DP._moveGroup.call(g4, 'c', 1);
eq(g4._groups.map(x => x.key), ['b', 'a', 'c'], 'nederste gruppe kan ikke flyttes ud over kanten');

console.log('\n── 8. Vagt: ugemte grupper overlever et reload ─────────');

// Et baggrunds-reload (SSE fra vores eget gem) må ikke rive en ugemt
// gruppe væk under hænderne på brugeren.
const g5 = makeDrawer(groupLines, []);
g5._selected = new Set(['1']);
DP._groupSelected.call(g5);
const beforeKeys = g5._groups.map(x => x.key);
g5.data.menu_groups = [];                 // serveren ved endnu intet om gruppen
DP._syncGroupModel.call(g5, groupLines);  // reload
eq(g5._groups.map(x => x.key), beforeKeys, 'ugemt gruppe overlever et reload');

// Når der ikke er ugemte ændringer, SKAL serverdata vinde
const g6 = makeDrawer(groupLines, [{ id: 7, title: 'Frokost', note: '', sort_order: 0 }]);
g6._groupsDirty = false;
g6.data.menu_groups = [{ id: 9, title: 'Aften', note: '', sort_order: 0 }];
DP._syncGroupModel.call(g6, [{ id: 1, product_name: 'X', category: '04 Slider', menu_group_id: 9 }]);
eq(g6._groups.map(x => x.title), ['Aften'], 'uden ugemte ændringer vinder serverdata');

// _groupBusy: vagten der forhindrer at vores eget SSE-ekko lukker select-mode
const busy = { _selectMode: true, _groupsDirty: false, el: { contains: () => false } };
ok(DP._groupBusy.call(busy) === true, 'select-mode blokerer reload');
const busy2 = { _selectMode: false, _groupsDirty: true, el: { contains: () => false } };
ok(DP._groupBusy.call(busy2) === true, 'ugemte ændringer blokerer reload');
const idle = { _selectMode: false, _groupsDirty: false, el: { contains: () => false } };
ok(DP._groupBusy.call(idle) === false, 'ellers er reload tilladt');

// ── Linjens pris kan redigeres ─────────────────────────────────────────────
// Fra drift (#B4244): en forældet leveringslinje bar 230 kr, men prisen var ren
// tekst i skuffen. Linjen kunne kun slettes, ikke rettes — og den pris gik
// direkte videre til fakturaen.
console.log('\n— Pris-redigering på linjen —');
{
    const esc = (x) => String(x == null ? '' : x);
    const self = { _selectMode: false, _isBottomLine: () => false };
    const html = DP._lineHtml.call(self,
        { id: 891346, product_name: 'Levering med El-Taxa', category: 'x-Levering',
          quantity: 1, unit_price: 230, line_total: 230 }, esc);

    ok(/class="[^"]*price-editable/.test(html), 'prisen er klikbar');
    ok(/230 kr/.test(html), 'og viser linjens total');
    ok(/data-unit-price="230"/.test(html), 'stk-prisen følger med på rækken');
    ok(/qty-editable/.test(html), 'antal er stadig redigerbart');

    // Editoren skal sende stk-prisen, ikke totalen — ellers ganges der op to gange.
    const src = fs.readFileSync(path.join(root, 'shared', 'bon_drawer.js'), 'utf8');
    ok(/putBonLine\(this\.bonId, lineId, \{ unit_price: ny \}\)/.test(src),
        'gemmer unit_price (serveren ganger selv op til line_total)');
    ok(!/putBonLine\([^)]*line_total/.test(src),
        'sender ALDRIG line_total — den er server-autoritativ');
}


/* ── 9. Mailen til kunden følger samme rækkefølge ───────────────── */
console.log('\n── 9. Kundemail: MailThread.buildVars sorterer som kortet ──');
{
    // bon_kort.js og bon_drawer.js havde hver sin kopi af mail-builderen, og
    // ingen af dem fulgte med da sorteringen blev fælles — kunden fik varerne
    // i rå DB-rækkefølge med emballage midt i maden (B4274, sept. 2026).
    for (const f of ['bon_lines.js', 'moms.js', 'mail_thread.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'shared', f), 'utf8'), sandbox, { filename: f });
    }
    const MailThread = sandbox.MailThread;
    ok(MailThread && typeof MailThread.buildVars === 'function', 'MailThread.buildVars findes');

    // B4274 i den rå rækkefølge mailen viste den
    const B4274 = {
        bon_number: 'B4274', pax: 8, contact_name_full: 'Jesper Neergaard',
        delivery_date: '2026-09-14', delivery_time: '11:15',
        lines: [
            { id: 1, product_name: 'Kartoflen',          category: '01 Sandwich',  quantity: 1, unit_price: 99,   line_total: 99,   special_request: '1 Glutenfri' },
            { id: 2, product_name: 'Italieneren',        category: '01 Sandwich',  quantity: 3, unit_price: 104,  line_total: 312 },
            { id: 3, product_name: 'Kartoflen',          category: '01 Sandwich',  quantity: 2, unit_price: 99,   line_total: 198 },
            { id: 4, product_name: 'RR Boks (emballage)', category: '06 Emballage', quantity: 8, unit_price: 0,    line_total: 0 },
            { id: 5, product_name: 'Transportkasse (emballage)', category: '06 Emballage', quantity: 1, unit_price: 12.5, line_total: 12.5 },
            { id: 6, product_name: 'Fatdane – Sodavand', category: '05 Drikke',    quantity: 8, unit_price: 35,   line_total: 280 },
            { id: 7, product_name: 'Falaflen',           category: '01 Sandwich',  quantity: 1, unit_price: 104,  line_total: 104,  special_request: 'Vegansk' },
            { id: 8, product_name: 'Kartoflen',          category: '01 Sandwich',  quantity: 1, unit_price: 99,   line_total: 99,   special_request: 'Vegetar' },
        ],
    };
    const vars = MailThread.buildVars(B4274);
    const menu = vars.menuUdenPriser.split('\n');
    eq(menu, [
        '8× Fatdane – Sodavand',
        '1× Falaflen (Vegansk)',
        '3× Italieneren',
        '1× Kartoflen (1 Glutenfri)',
        '2× Kartoflen',
        '1× Kartoflen (Vegetar)',
        '8× RR Boks (emballage)',
        '1× Transportkasse (emballage)',
    ], 'drikke øverst, mad i midten (alfabetisk), emballage nederst — som drawer og info-modal');

    const idx = (needle) => menu.findIndex(l => l.includes(needle));
    ok(idx('RR Boks') > idx('Kartoflen (Vegetar)'), 'emballage står EFTER den sidste madvare');
    ok(idx('Fatdane') === 0, 'drikke står allerførst');
    eq(vars.menuMedPriser.split('\n').map(l => l.replace(/\s+[\d.,]+ kr$/, '')), menu,
        'menuMedPriser har præcis samme rækkefølge som menuUdenPriser');

    // Grupper: linjerne INDE i en gruppe sorteres også, og grupperne følger sort_order
    const grouped = {
        lines: [
            { id: 1, product_name: 'Transportkasse', category: '06 Emballage', quantity: 1, line_total: 12.5, menu_group_id: 7 },
            { id: 2, product_name: 'Kyllingen',      category: '01 Sandwich',  quantity: 4, line_total: 400,  menu_group_id: 7 },
            { id: 3, product_name: 'Brownie',        category: '03 Kager',     quantity: 4, line_total: 100,  menu_group_id: 9 },
            { id: 4, product_name: 'RR Boks',        category: '06 Emballage', quantity: 2, line_total: 0 },
            { id: 5, product_name: 'Falaflen',       category: '01 Sandwich',  quantity: 2, line_total: 200 },
        ],
        menu_groups: [
            { id: 9, title: 'Eftermiddag', sort_order: 2 },
            { id: 7, title: 'Frokost',     sort_order: 1 },
        ],
    };
    eq(MailThread.buildVars(grouped).menuUdenPriser.split('\n'), [
        'Frokost:',
        '  4× Kyllingen',
        '  1× Transportkasse',
        '',
        'Eftermiddag:',
        '  4× Brownie',
        '',
        '2× Falaflen',
        '2× RR Boks',
    ], 'grupper i sort_order, emballage nederst inde i gruppen OG blandt de løse');

    // Ekstra felter der før kun fandtes i drawerens kopi skal stadig være der
    const withTransport = MailThread.buildVars({ lines: [], transport_co2_source: 'ors', transport_co2e_kg: 0.9, delivery_method: 'bike' });
    eq(withTransport.co2Transport, '0,90 kg', 'co2Transport (drawerens felt) leveres fra den fælles builder');
    eq(withTransport.co2MedTransport, '0,90 kg CO₂e', 'co2MedTransport summerer mad + transport');
    eq(withTransport.leveringsMetode, 'Cykelbud', 'leveringsMetode falder tilbage på delivery_method');
    eq(MailThread.buildVars({ lines: [] }).co2Transport, '0,00 kg', 'ukendt transport → 0, ikke crash');

    // De to gamle kopier skal være væk — ellers driver de fra hinanden igen
    const kort = fs.readFileSync(path.join(root, 'shared', 'bon_kort.js'), 'utf8');
    const drawer = fs.readFileSync(path.join(root, 'shared', 'bon_drawer.js'), 'utf8');
    ok(/function _buildMailVars\(bon\) \{[\s\S]{0,400}?MailThread\.buildVars\(bon\)/.test(kort),
        'bon_kort.js delegerer til MailThread.buildVars');
    ok(/_buildMailVars = function\(bon\) \{ return MailThread\.buildVars\(bon\); \}/.test(drawer),
        'bon_drawer.js delegerer til MailThread.buildVars');
    ok(!/menuUdenPriser:/.test(kort) && !/menuUdenPriser:/.test(drawer),
        'ingen af dem bygger selv menuUdenPriser længere');
    for (const page of ['kitchen/today.html', 'kitchen/later.html', 'kitchen/calendar.html', 'kitchen/logistik.html', 'office/index.html', 'mobile/index.html']) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        ok(/mail_thread\.js/.test(html) && /shared\/utils\.js/.test(html), page + ' loader både mail_thread.js og utils.js');
    }
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`${pass} PASS · ${fail} FAIL`);
console.log('═'.repeat(55));
process.exit(fail ? 1 : 0);
