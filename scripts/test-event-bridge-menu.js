/**
 * Fase 1-test: event-bro menu-builder (routes/event-bridge.js buildBridgeMenu).
 *
 * Ren unit-test med injicerede Grocy-deps — rører hverken Grocy eller DB.
 * Kør:  node --experimental-sqlite scripts/test-event-bridge-menu.js
 */

const { buildBridgeMenu, buildCategoryId } = require('../routes/event-bridge');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (fik ${JSON.stringify(a)}, ventede ${JSON.stringify(b)})`); }

const mockDeps = {
    getRecipes: async () => [
        { id: 91, name: 'Grisen på Rug', category: '01 Sandwich', unit: 'stk', prices: { festival: 115, catering: 94 }, cost_price: 23.5, co2e: 0.4 },
        { id: 92, name: 'Salaten',        category: '02 Salat',    unit: 'stk', prices: { festival: 98 },              cost_price: 20 },
        { id: 93, name: 'Skjult ret',     category: '01 Sandwich', unit: 'stk', prices: { festival: 50 } },
        { id: 94, name: 'Uden festivalpris', category: '02 Salat', unit: 'stk', prices: { catering: 60 } }
    ],
    getRecipesRaw: async () => [
        { id: 91, userfields: { bestil_tags: 'vegan, gf', bestil_allergens: 'gluten' } },
        { id: 92, userfields: {} },
        { id: 93, userfields: { bestil_skjul: '1' } },
        { id: 94, userfields: {} }
    ]
};

(async () => {
    // buildCategoryId slugificering
    eq(buildCategoryId('01 Sandwich'), '01_sandwich', 'buildCategoryId sandwich');
    eq(buildCategoryId('Blåbær & Øl'), 'blaabaer_oel', 'buildCategoryId æøå');

    const menu = await buildBridgeMenu('standard', mockDeps);

    // Top-level shape
    eq(menu.menu_id, 'standard', 'menu_id');
    eq(menu.source, 'grocy-bridge', 'source');
    ok(typeof menu.version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(menu.version), 'version er ISO-dato');

    // Skjult ret (93) filtreres fra → 3 items tilbage
    eq(menu.items.length, 3, 'antal items (skjult filtreret)');
    ok(!menu.items.some(i => i.id === 'r93'), 'r93 er skjult (bestil_skjul=1)');

    const i91 = menu.items.find(i => i.id === 'r91');
    ok(i91, 'r91 findes');
    eq(i91.name, 'Grisen på Rug', 'r91 navn');
    eq(i91.price, 11500, 'r91 festival-pris i øre (115 kr)');
    eq(i91.category, '01_sandwich', 'r91 kategori-slug');
    eq(JSON.stringify(i91.tags), JSON.stringify(['vegan', 'gf']), 'r91 tags parset fra CSV');
    eq(i91.allergens, 'gluten', 'r91 allergener');
    eq(i91.active, true, 'r91 active');

    const i92 = menu.items.find(i => i.id === 'r92');
    eq(i92.price, 9800, 'r92 festival-pris i øre (98 kr)');
    eq(JSON.stringify(i92.tags), JSON.stringify([]), 'r92 tomme tags');

    const i94 = menu.items.find(i => i.id === 'r94');
    eq(i94.price, 0, 'r94 uden festival-pris → 0 øre');

    // Kategorier — unikke, i mødt rækkefølge, med pæne navne
    eq(menu.categories.length, 2, 'antal kategorier');
    eq(menu.categories[0].id, '01_sandwich', 'kategori 0 id');
    eq(menu.categories[0].name, '01 Sandwich', 'kategori 0 navn');
    eq(menu.categories[1].id, '02_salat', 'kategori 1 id');

    console.log(`\nFase 1 (event-bro menu): ${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
