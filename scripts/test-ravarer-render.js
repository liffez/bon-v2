// scripts/test-ravarer-render.js
// ============================================================
// Råvarer-modalens visning af "kan laves" (#266 §4.1).
//
// Motoren i `ingredientResolver` er dækket af test-producibility.js. Den her
// dækker det motoren IKKE kan se: hvad der faktisk står på skærmen.
//
// Fejlen der gjorde testen nødvendig blev fundet i browseren, ikke af de 31
// motor-tests: en vare der lå på hylden fik alligevel teksten "skal laves",
// fordi noten kun så på `producible` og ikke på om der manglede noget. Halvdelen
// af listen bad dermed om arbejde der ikke skulle udføres — og en liste der
// beder om for meget bliver lige så hurtigt ignoreret som en der råber ulven.
//
// `shared/modal.js` er browser-kode og kan ikke require'es. Den køres i en
// vm-sandkasse, og `_buildRavarerHtml` kaldes direkte — samme funktion
// browseren bruger, ikke en kopi.
//
// Kør:  node scripts/test-ravarer-render.js
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const stubEl = { addEventListener: noop, appendChild: noop, textContent: '', innerHTML: '',
                 classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                 style: {}, querySelector: () => null, querySelectorAll: () => [],
                 setAttribute: noop, getAttribute: () => null, closest: () => null };
const sandbox = {
    console,
    document: { getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [],
                createElement: () => stubEl, addEventListener: noop, body: stubEl },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout,
    BON_CONFIG: { statuses: {} },
    statusToFrontend: (s) => s,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'modal.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'modal.js' });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

// Trækker den ene <div class="ing-row …"> ud der bærer varens navn.
// Kaster hvis rækken ikke findes — ellers ville hver eneste "indeholder IKKE
// X"-assertion bestå på en tom streng, og testen ville lyve grønt.
function rowFor(html, name) {
    const key = name.toLowerCase();
    for (const part of html.split('<div class="ing-row')) {
        if (part.includes(`data-ing-name="${key}"`)) return '<div class="ing-row' + part;
    }
    throw new Error(`rækken for "${name}" blev ikke fundet i outputtet`);
}

// `_ravarerLevel` er en `let` inde i modulet og kan ikke sættes udefra i en
// vm-sandkasse — fixturen lægges derfor på det niveau der er default.
function build(ingredients) {
    return sandbox._buildRavarerHtml({
        production: { ingredients, groups: [{ name: '', ingredients }], sub_recipes: [] },
        raw: { ingredients: [], groups: [], sub_recipes: [] },
    });
}

const base = {
    amount_needed: 1, amount_stock: 0, unit: 'kg', stock_unit: 'kg',
    ingredient_group: '', shortfall_purchase: 1, purchase_unit: 'kg', make_shortfalls: [],
};

(async () => {
    console.log('\nRåvarer-modalen: visning af "kan laves"\n');

    console.log('R1 · Kan laves ⇒ blå prik, ikke grøn');
    let html = build([{ ...base, product_id: 1, product_name: 'Rødløg - Sylt',
        status: 'mangler', effective_status: 'kan_laves', producible: true,
        make_recipe_name: 'Rødløg - Syltet', make_batches: 1, make_estimated: false }]);
    let row = rowFor(html, 'Rødløg - Sylt');
    ok(row.includes('🔵'), 'prikken er blå');
    ok(!row.includes('🟢'), 'IKKE grøn — "på lager" og "kan laves" må ikke se ens ud');
    ok(row.includes('ing-status-kan-laves'), 'egen CSS-klasse så kanten kan markeres');
    ok(row.includes('skal laves: Rødløg - Syltet'), `opskriften navngives i noten`);
    ok(!row.includes('ing-btn-cart'), 'ingen indkøbskurv — et mellemprodukt kan ikke købes');

    console.log('\nR2 · Vare PÅ LAGER får ingen note, selvom den også kan laves');
    html = build([{ ...base, product_id: 2, product_name: 'Langtids Stegt Gris',
        amount_stock: 5, status: 'ok', effective_status: 'ok', producible: true,
        make_recipe_name: 'Langtids stegt Gris', make_batches: 1 }]);
    row = rowFor(html, 'Langtids Stegt Gris');
    ok(row.includes('🟢'), 'grøn');
    ok(!row.includes('skal laves'), 'INGEN "skal laves" — den ligger jo på hylden (fundet i browseren)');
    ok(!row.includes('ing-sub-caret'), 'ingen fold-ud-pil på en vare der er dækket');

    console.log('\nR3 · Kan IKKE laves ⇒ rød, og råvarerne navngives');
    html = build([{ ...base, product_id: 3, product_name: 'Rødløg - Sylt',
        status: 'mangler', effective_status: 'mangler', producible: true,
        make_recipe_name: 'Rødløg - Syltet', make_batches: 1,
        make_shortfalls: [{ product_id: 9, product_name: 'Rødløg - Rå', needed: 1, stock: 0, status: 'mangler' }] }]);
    row = rowFor(html, 'Rødløg - Sylt');
    ok(row.includes('🔴'), 'rød — der råbes stadig når råvarerne mangler');
    ok(row.includes('1 råvare mangler'), 'antallet siges');
    ok(html.includes('Rødløg - Rå'), 'den manglende RÅVARE står i fold-ud-listen');
    ok(!row.includes('ing-btn-cart'), 'stadig ingen kurv på selve mellemproduktet');

    console.log('\nR4 · Almindelig indkøbsvare er fuldstændig uændret');
    html = build([{ ...base, product_id: 4, product_name: 'Mozzarella',
        status: 'mangler', effective_status: 'mangler', producible: false }]);
    row = rowFor(html, 'Mozzarella');
    ok(row.includes('🔴'), 'rød som før');
    ok(row.includes('ing-btn-cart'), 'kurven er der — den kan jo købes');
    ok(!row.includes('skal laves'), 'ingen make-note opfundet');

    console.log('\nR5 · Skøn siges højt');
    html = build([{ ...base, product_id: 5, product_name: 'Gris',
        status: 'mangler', effective_status: 'kan_laves', producible: true,
        make_recipe_name: 'Langtids stegt Gris', make_batches: 1, make_estimated: true }]);
    ok(rowFor(html, 'Gris').includes('(skøn)'), 'markeret som skøn, ikke skjult');

    console.log('\nR8 · Ukendt udbytte forklares som et hul i stamdata');
    // Uden `recipeunitnumber` kan behovet ikke omsættes til batches. Så skal
    // der stå hvorfor — ikke en mangelliste vi ikke kan stå inde for.
    html = build([{ ...base, product_id: 8, product_name: 'Falaffel',
        status: 'mangler', effective_status: 'mangler', producible: true,
        make_status: 'ukendt', make_estimated: true,
        make_recipe_name: 'Falaffel- stegning-styk', make_batches: 1,
        make_shortfalls: [{ product_id: 9, product_name: 'pebber', needed: 1, stock: 0, status: 'mangler' }] }]);
    row = rowFor(html, 'Falaffel');
    ok(row.includes('udbytte ikke oplyst'), 'siger at udbyttet mangler i Grocy');
    ok(row.includes('1 råvare mangler'), 'OG at en råvare mangler — begge beskeder er sande');
    ok(!row.includes('🔵'), 'ikke blå — vi kan ikke sige at den kan laves');
    ok(row.includes('ing-sub-caret'), 'kan foldes ud: listen kommer fra den verificerbare opskrift');
    ok(html.includes('pebber'), 'og råvaren navngives i fold-ud');

    console.log('\nR8b · Uden nogen verificerbar opskrift siges der intet om råvarerne');
    html = build([{ ...base, product_id: 18, product_name: 'Tomfalaffel',
        status: 'mangler', effective_status: 'mangler', producible: true,
        make_status: 'ukendt', make_estimated: true, make_recipe_name: 'Ukendt', make_shortfalls: [] }]);
    row = rowFor(html, 'Tomfalaffel');
    ok(row.includes('udbytte ikke oplyst'), 'kun data-hullet nævnes');
    ok(!row.includes('råvare'), 'ingen mangelliste gættet frem');
    ok(!row.includes('ing-sub-caret'), 'intet at folde ud');

    console.log('\nR7 · Producerbar uden mangelliste: stadig ingen kurv');
    // Kanten hvor `showCart`-guarden er den eneste der holder: rækken kan ikke
    // foldes ud (intet at vise), så uden guarden ville der stå en indkøbskurv
    // på et mellemprodukt man ikke kan købe.
    html = build([{ ...base, product_id: 7, product_name: 'Tomvare',
        status: 'mangler', effective_status: 'mangler', producible: true,
        make_recipe_name: null, make_shortfalls: [] }]);
    row = rowFor(html, 'Tomvare');
    ok(!row.includes('ing-btn-cart'), 'ingen kurv på en producerbar vare, heller ikke uden mangelliste');
    ok(!row.includes('ing-sub-caret'), 'ingen fold-ud-pil når der intet er at folde ud');

    console.log('\nR6 · Et gammelt svar uden de nye felter opfører sig som før');
    html = build([{ ...base, product_id: 6, product_name: 'Kartoffel', status: 'lav' }]);
    row = rowFor(html, 'Kartoffel');
    ok(row.includes('🟡'), 'falder tilbage på `status`');
    ok(row.includes('ing-btn-cart'), 'kurven bevares');

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
