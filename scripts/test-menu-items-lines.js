// scripts/test-menu-items-lines.js
// ============================================================
// Unit-test for #382 — kobl web-bestillingens menu_items[] til bon-linjer.
//
// resolveMenuItemLines er en REN funktion: den mapper [{id,count}] +
// Grocy-opskrifter + priskategori → bon-linjer med pris/kostpris/CO₂-snapshot.
// Ingen DB, ingen server — kan køres hvor som helst.
//
// Kør:
//   node scripts/test-menu-items-lines.js
// ============================================================

'use strict';

const { resolveMenuItemLines, chipItemsFromWishes } = require('../services/menuItemsToLines');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

// ── Grocy-attrap: opskrifter som getRecipes ville returnere ──
const recipesById = new Map([
    [91, { id: 91, name: 'Falaflen', category: '01 Sandwich', unit: 'stk',
           prices: { store: 90, catering: 94, festival: 98, produktion: 0, waiste: 0 }, cost_price: 23.55, co2e: 0.42 }],
    [77, { id: 77, name: 'Tunen',    category: '01 Sandwich', unit: 'stk',
           prices: { store: 90, catering: 94, festival: 98, produktion: 0, waiste: 0 }, cost_price: 20,   co2e: 0.5 }],
    // Opskrift uden catering-pris sat (0) — skal give prisløs linje, ikke 0 kr.
    [50, { id: 50, name: 'Kildevand', category: '05 Drikke', unit: 'stk',
           prices: { store: 15, catering: 0, festival: 20, produktion: 0, waiste: 0 }, cost_price: 5, co2e: 0 }],
]);

// Manuel menu-item uden Grocy-kobling (fallback-navn)
const menuItemsById = new Map([
    ['adhoc_kage', { name: 'Hjemmelavet kage', category: '03 Kager' }],
]);

console.log('\n#382 — resolveMenuItemLines\n');

// ── 1. Grocy-koblet item → catering-pris snapshottet ──
{
    const { lines, unmatched } = resolveMenuItemLines({
        menuItems: [{ id: 'r91', count: 12 }], recipesById, priceCategory: 'catering'
    });
    ok(lines.length === 1 && unmatched.length === 0, '1 linje, 0 unmatched');
    const l = lines[0];
    ok(l.grocy_recipe_id === 91, '  grocy_recipe_id = 91');
    ok(l.product_name === 'Falaflen', '  navn fra Grocy');
    ok(l.category === '01 Sandwich', '  kategori fra Grocy');
    ok(l.quantity === 12, '  antal fra count');
    ok(l.unit_price === 94, '  catering-pris snapshottet (94)');
    ok(l.cost_price === 23.55, '  kostpris snapshottet');
    ok(l.co2e === 0.42, '  CO₂ snapshottet');
}

// ── 2. Festival-priskategori rammer festival-prisen ──
{
    const { lines } = resolveMenuItemLines({
        menuItems: [{ id: 'r91', count: 3 }], recipesById, priceCategory: 'festival'
    });
    ok(lines[0].unit_price === 98, 'festival-priskategori → festival-pris (98)');
}

// ── 3. count <= 0 og ugyldige rækker springes over ──
{
    const { lines } = resolveMenuItemLines({
        menuItems: [{ id: 'r91', count: 0 }, { id: 'r77', count: -2 }, { id: 'r77' }, { count: 5 }, null],
        recipesById, priceCategory: 'catering'
    });
    ok(lines.length === 0, 'count<=0 / manglende id+count / null springes over');
}

// ── 4. Manglende catering-pris (0) → prisløs linje (ikke 0 kr) ──
{
    const { lines } = resolveMenuItemLines({
        menuItems: [{ id: 'r50', count: 4 }], recipesById, priceCategory: 'catering'
    });
    ok(lines.length === 1, 'linje oprettet trods manglende pris');
    ok(lines[0].unit_price === null, '  uset catering-pris (0) → unit_price null');
    ok(lines[0].co2e === null, '  CO₂ 0 → null (ikke misvisende 0)');
}

// ── 5. Ikke-Grocy-koblet id med menu-navn → prisløs navn-linje ──
{
    const { lines, unmatched } = resolveMenuItemLines({
        menuItems: [{ id: 'adhoc_kage', count: 2 }], recipesById, menuItemsById, priceCategory: 'catering'
    });
    ok(lines.length === 1 && unmatched.length === 0, 'menu-navn brugt som fallback');
    ok(lines[0].grocy_recipe_id === null, '  ingen Grocy-kobling');
    ok(lines[0].product_name === 'Hjemmelavet kage', '  navn fra menu-JSON');
    ok(lines[0].unit_price === null, '  prisløs (office prissætter)');
}

// ── 6. r-id uden matchende opskrift → unmatched ──
{
    const { lines, unmatched } = resolveMenuItemLines({
        menuItems: [{ id: 'r999', count: 1 }], recipesById, priceCategory: 'catering'
    });
    ok(lines.length === 0 && unmatched.length === 1, 'ukendt r-id → unmatched');
    ok(unmatched[0].reason === 'recipe_not_found', '  reason=recipe_not_found');
}

// ── 7. Ukendt id uden menu-navn → unmatched ──
{
    const { unmatched } = resolveMenuItemLines({
        menuItems: [{ id: 'xyz', count: 1 }], recipesById, priceCategory: 'catering'
    });
    ok(unmatched.length === 1 && unmatched[0].reason === 'no_grocy_link_and_no_menu_name', 'ukendt id uden navn → unmatched');
}

// ── 8. Defensivt: ikke-array / tom input ──
{
    ok(resolveMenuItemLines({ menuItems: null, recipesById }).lines.length === 0, 'menuItems=null → tom');
    ok(resolveMenuItemLines({}).lines.length === 0, 'helt tom input → tom, kaster ikke');
}

// ── 9. Blandet realistisk payload ──
{
    const { lines, unmatched } = resolveMenuItemLines({
        menuItems: [{ id: 'r91', count: 20 }, { id: 'r77', count: 20 }, { id: 'adhoc_kage', count: 5 }],
        recipesById, menuItemsById, priceCategory: 'catering'
    });
    ok(lines.length === 3 && unmatched.length === 0, 'blandet payload: 3 linjer');
    const total = lines.reduce((s, l) => s + ((l.unit_price ?? 0) * l.quantity), 0);
    ok(total === 20 * 94 + 20 * 94, 'sum kun fra prissatte linjer (kage er prisløs)');
}

// ── 10. Kost-knapper → vare (Glutenfri: N → glutenfri bolle) ──
{
    const G = { Glutenfri: 75 };
    const w = 'Sandwichvalg: Køkkenet blander\n\nGlutenfri: 1\n\n--- Valgte Menu ---\n1× Falaflen';
    const r = chipItemsFromWishes(w, G);
    ok(r.length === 1 && r[0].id === 'r75' && r[0].count === 1, 'Glutenfri: 1 → r75 ×1 (B4314)');
    ok(chipItemsFromWishes('glutenfri : 3', G)[0]?.count === 3, 'store/små bogstaver + mellemrum tåles');
    ok(chipItemsFromWishes('Glutenfri: 0', G).length === 0, 'Glutenfri: 0 → intet');
    ok(chipItemsFromWishes('Glutenfri: den ene uden ost', G).length === 0, 'fri tekst efter kolon er en besked, ikke et antal');
    ok(chipItemsFromWishes('Ikke glutenfri: 2', G).length === 0, 'præfikset skal stå forrest på linjen');
    ok(chipItemsFromWishes('Vegansk: 3', G).length === 0, 'kun knapper i indstillingen');
    ok(chipItemsFromWishes('Glutenfri: 2', null).length === 0, 'uden indstilling → intet');
    ok(chipItemsFromWishes('Glutenfri: 2', { Glutenfri: 'x' }).length === 0, 'ugyldigt id → intet, kaster ikke');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
