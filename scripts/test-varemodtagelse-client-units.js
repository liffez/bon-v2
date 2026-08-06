// scripts/test-varemodtagelse-client-units.js
// ============================================================
// Klient-siden af #358: sender varemodtagelsen den enhed tallet står i?
//
// Serveren omregner nu indkøbs-enhed → lager-enhed, men den kan kun gøre det
// hvis klienten fortæller HVILKEN enhed tallet står i. Uden `qu_id` i payloadet
// nægter serveren (på tvetydige produkter), og varemodtagelsen ville stå af på
// hver fjerde vare. Serverens del er dækket af T_VAREMODTAGELSE_FULL; det her
// er den anden halvdel af kontrakten.
//
// `shared/varemodtagelse.js` er browser-kode og kan ikke require'es. Den køres
// i en vm-sandkasse med stubbede globals, hvorefter de rene funktioner kaldes
// direkte — samme mønster som scripts/test-recipe-viewer-nested.js. Det er de
// samme funktioner browseren bruger, ikke en kopi.
//
//   node scripts/test-varemodtagelse-client-units.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const check = (c, m) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`); c ? pass++ : fail++; };

const noop = () => {};
const stubEl = {
    addEventListener: noop, appendChild: noop, textContent: '', innerHTML: '', value: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, querySelector: () => null, querySelectorAll: () => [], setAttribute: noop,
};
const sandbox = {
    console,
    document: {
        getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [],
        createElement: () => stubEl, addEventListener: noop, body: stubEl,
    },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    fetch: async () => ({ ok: true, json: async () => [] }),
    setTimeout, clearTimeout, alert: noop, confirm: () => true, prompt: () => null,
    navigator: { userAgent: 'test' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'varemodtagelse.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'varemodtagelse.js' });

console.log('\n\x1b[1m#358 — klienten oplyser enheden\x1b[0m');

// Fixture: Brød Rug — købes i Kasse (qu 13), lagerføres i Kilo (qu 4).
// Præcis den række issuet fandt i driftens indkøbsliste.
Object.assign(sandbox, {
    _vmShoppingList: [
        { id: 501, product_id: 1, amount: 994, qu_id: 13,
          userfields: { ordered_supplier: 'Hørkram', ordered_varenr: '12345' } },
        // Vare uden qu_id på listen → skal falde tilbage til produktets lager-enhed
        // frem for at sende ingenting (som ville få serveren til at nægte).
        { id: 502, product_id: 8, amount: 5, qu_id: null,
          userfields: { ordered_supplier: 'Hørkram', ordered_varenr: '67890' } },
    ],
    _vmProductNames:   { 1: 'Brød Rug', 8: 'Humus' },
    _vmProductStockQu: { 1: 4, 8: 4 },
    _vmQuNames:        { 4: 'Kilo', 13: 'Kasse' },
});

sandbox._vmBuildItemsFromShoppingList('Hørkram');
const items = sandbox._vmState.items;

const brod = items.find(i => i.grocy_product_id === 1);
check(!!brod, 'varen bygges fra indkøbslisten');
check(brod && brod.qu_id === 13,
    `qu_id følger med fra indkøbslisten (Kasse=13) — fik ${brod && brod.qu_id}`);
check(brod && brod.unit === 'Kasse', 'enhedens navn vises fortsat til brugeren');
check(brod && brod.expected === 994, 'mængden er uændret (994, i købs-enhed)');

const humus = items.find(i => i.grocy_product_id === 8);
check(humus && humus.qu_id === 4,
    `manglende qu_id på listen falder tilbage til lager-enhed — fik ${humus && humus.qu_id}`);

// Selve payloadet: qu_id skal overleve hele vejen ud i POST-bodyen. Uden dette
// led er alt ovenstående ligegyldigt — det var netop her enheden faldt på gulvet.
const payloadItems = sandbox._vmState.items.map(function (item) {
    return {
        grocy_product_id: item.grocy_product_id,
        product_name: item.product_name,
        expected_quantity: item.expected,
        received_quantity: item.received,
        unit: item.unit,
        qu_id: item.qu_id != null ? item.qu_id : null,
        status: item.status,
        notes: item.notes || null,
    };
});
check(payloadItems.every(i => i.qu_id != null), 'alle payload-linjer bærer qu_id');
check(payloadItems.find(i => i.grocy_product_id === 1).qu_id === 13,
    'payloadet sender købs-enheden, ikke lager-enheden');

// Kilde-tjek: at feltet rent faktisk sendes i den ægte _vmSubmit (og ikke kun i
// min rekonstruktion ovenfor). _vmSubmit kan ikke køres uden hele DOM'en.
check(/qu_id:\s*item\.qu_id/.test(src),
    '_vmSubmit har qu_id med i sit items-payload');

// Manuelt tilføjede varer har hverken Grocy-produkt eller enhed. De må ikke
// begynde at fejle — de rører aldrig lageret. Selve adfærden er dækket
// server-side i scripts/test-consume-hardening.js ("manuel vare uden
// Grocy-produkt"); her tjekker vi bare at klienten fortsat sender null, så de
// to ender af kontrakten passer sammen. (_vmAddManualItem kan ikke køres i
// sandkassen — den renderer DOM.)
check(/grocy_product_id:\s*null/.test(src),
    'manuel vare sendes fortsat uden Grocy-produkt');

console.log(`\n${'─'.repeat(50)}\n${pass} PASS · ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
