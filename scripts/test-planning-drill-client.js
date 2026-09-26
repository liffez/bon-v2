'use strict';
/**
 * Klient-hjælperne i shared/planning_drill.js (Menu-kategorier, Råvarer-filter,
 * tjeklistens grupper). Den ÆGTE fil køres i en vm-sandkasse — det er de samme
 * funktioner browseren bruger, ikke en kopi.
 *   node scripts/test-planning-drill-client.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — fik ${JSON.stringify(got)}, forventet ${JSON.stringify(want)}`}`);
};

const store = {};
const ctx = { console, localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'planning_drill.js'), 'utf8'), ctx);

const nodes = {
    'cat:01': { id: 'cat:01', kind: 'category', name: 'Sandwich', children: ['item:a', 'item:b'], counts_as_unit: true, units: 30 },
    'cat:06': { id: 'cat:06', kind: 'category', name: 'Emballage', children: ['item:c'], counts_as_unit: false, units: 0, qty_display: '40' },
    'item:a': { kind: 'item', name: 'Kyllingen' }, 'item:b': { kind: 'item', name: 'Falaflen' }, 'item:c': { kind: 'item', name: 'Kasse' },
    'pgrp:1': { kind: 'raw_group', name: 'Kød', children: ['raw:1', 'raw:2'] },
    'pgrp:2': { kind: 'raw_group', name: 'Brød', children: ['raw:3'] },
    'raw:1': { kind: 'raw', name: 'Svinekam', short: true, check: { product_id: 1 } },
    'raw:2': { kind: 'raw', name: 'Salt', short: false, check: { product_id: 2 } },
    'raw:3': { kind: 'raw', name: 'Rugbrød', short: false, check: { product_id: 3 } },
    'prep:1': { kind: 'prep', name: 'Gris', group_name: 'Kød', check: { product_id: 10 } },
    'prep:2': { kind: 'prep', name: 'Bouillon', group_name: '', check: { product_id: 11 } },
    'prep:3': { kind: 'prep', name: 'Tahin', group_name: 'Krydderier', check: { product_id: 12 } },
    'prep:4': { kind: 'prep', name: 'Pickles', group_name: 'Kød', check: null },
};
const tree = { nodes, levels: { categories: ['cat:01', 'cat:06'], items: ['item:a', 'item:b', 'item:c'],
    raw: ['pgrp:1', 'pgrp:2'], prep: ['prep:1', 'prep:2', 'prep:3', 'prep:4'] } };
const set = (o) => vm.runInContext('_pd = ' + JSON.stringify(Object.assign({ tree, fold: {}, extras: [], from: 'a', to: 'b' }, o)) +
    '; _pd.selected = new Set(); _pdRenderDrill = function () { _pd.rendered = (_pd.rendered || 0) + 1; };', ctx);
const run = (code) => vm.runInContext(code, ctx);

console.log('\n§1 Menu = kategorierne som afsnit (Kategorier-fanen er lagt ind her)');
set({ tab: 'items' });
eq('fanerne: Menu · Ønsker · Skal laves · Råvarer · Tjekliste', run('PD_TABS.map(t => t.n + " " + t.label)'),
    ['1 Menu', '2 Ønsker', '3 Skal laves', '4 Råvarer', '5 Tjekliste']);
eq('afsnit i kategoriernes rækkefølge', run('_pdSectionsFor("items").map(s => [s.title, s.ids, s.sum])'),
    [['Sandwich', ['item:a', 'item:b'], '30 enh'], ['Emballage', ['item:c'], '40 stk · ikke enheder']]);
eq('standard: det der ikke tæller som enheder er foldet sammen',
    run('_pdSectionsFor("items").map(s => _pdIsFolded("items", s))'), [false, true]);

console.log('\n§1b Fold og husk');
run('_pdToggleFold("items:cat:01")');
eq('fold én: Sandwich foldet, Emballage uændret', run('_pdSectionsFor("items").map(s => _pdIsFolded("items", s))'), [true, true]);
eq('valget huskes på enheden', JSON.parse(store.planning2_fold), { 'items:cat:01': true });
run('_pdToggleFold("items:cat:06")');
eq('en standard-foldet kan foldes ud', run('_pdIsFolded("items", _pdSectionsFor("items")[1])'), false);
run('_pdFoldAll(false)');
eq('fold alle ud', run('_pdSectionsFor("items").map(s => _pdIsFolded("items", s))'), [false, false]);
run('_pdFoldAll(true)');
eq('fold alle ind', run('_pdSectionsFor("items").map(s => _pdIsFolded("items", s))'), [true, true]);
eq('foldet afsnit viser ingen rækker', (run('_pdSectionsHtml(_pdSectionsFor("items"), 0, null, "items")').match(/data-id=/g) || []).length, 0);
run('_pdFoldAll(false)');
eq('åbne afsnit viser varerne', (run('_pdSectionsHtml(_pdSectionsFor("items"), 0, null, "items")').match(/data-id=/g) || []).length, 3);
eq('knapperne "Fold alle" vises med flere afsnit', /data-foldall="in"/.test(run('_pdFoldAllHtml()')), true);

console.log('\n§2 Råvarer-filter');
set({ tab: 'raw', rawFilter: 'all' });
eq('alle: grupper uændret', vm.runInContext("_pdRawFiltered(['pgrp:1','pgrp:2'])", ctx), ['pgrp:1', 'pgrp:2']);
set({ tab: 'raw', rawFilter: 'short' });
eq('mangler: kun gruppen med noget der mangler', vm.runInContext("_pdRawFiltered(['pgrp:1','pgrp:2'])", ctx), ['pgrp:1']);
eq('mangler: kun svinekam i kød', vm.runInContext("_pdRawFiltered(['raw:1','raw:2'])", ctx), ['raw:1']);
set({ tab: 'raw', rawFilter: 'ok' });
eq('på lager: begge grupper', vm.runInContext("_pdRawFiltered(['pgrp:1','pgrp:2'])", ctx), ['pgrp:1', 'pgrp:2']);
eq('på lager: salt, ikke svinekam', vm.runInContext("_pdRawFiltered(['raw:1','raw:2'])", ctx), ['raw:2']);
set({ tab: 'items', rawFilter: 'short' });
eq('filteret rører ikke andre faner', vm.runInContext("_pdRawFiltered(['item:a','item:b'])", ctx), ['item:a', 'item:b']);
set({ tab: 'raw', rawFilter: 'short' });
const chips = vm.runInContext('_pdRawFilterHtml()', ctx);
eq('tællere: 3 i alt · 1 mangler · 2 på lager', (chips.match(/pd-rf-count">(\d+)/g) || []).map(x => x.replace(/\D/g, '')), ['3', '1', '2']);

set({ tab: 'raw', rawFilter: 'short' });
eq('Råvarer som afsnit: kun det der mangler, "1 af 2"', run('_pdSectionsFor("raw").map(s => [s.title, s.ids, s.count])'),
    [['Kød', ['raw:1'], '1 af 2']]);

console.log('\n§3 Tjeklistens grupper');
set({ tab: 'check' });
eq('færdige varer delt på varegruppe, uden gruppe sidst, så råvarerne',
    vm.runInContext('_pdCheckGroups().map(g => [g.title, g.ids])', ctx), [
        ['Færdige varer · Krydderier', ['prep:3']], ['Færdige varer · Kød', ['prep:1']],
        ['Færdige varer · uden varegruppe', ['prep:2']],
        ['Kød', ['raw:1', 'raw:2']], ['Brød', ['raw:3']]]);
store['planning2_check:a:b::'] = JSON.stringify({ items: { 1: { state: 'ok' }, 2: { state: 'fixed' } } });
set({ tab: 'check' });
eq('grupperne tæller hvor mange der er tjekket', run('_pdSectionsFor("check").map(s => [s.title, s.count, s.done])').slice(3),
    [['Kød', '2 af 2', true], ['Brød', '0 af 1', false]]);

console.log(`\n${fail === 0 ? '✅ ALLE' : '❌'} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
