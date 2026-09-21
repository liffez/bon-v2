// scripts/test-packing-units.js
// ============================================================
// Regressionstest for #352.
//
// Pakkelisten viser mængder i produktets VISNINGS-enhed ("140 g") men gemmer
// dem i LAGER-enhed (0,14 kg) — det er den enhed serveren, databasen og
// Grocy-consume regner i. Broen mellem de to er `display_factor`, som serveren
// sender med hver ingrediens.
//
// Uden den faldt klienten tilbage på faktor 1, og "150" i et gram-felt blev
// gemt som 150 KILO. Testen låser hele kæden fast:
//   vist  = lager  × display_factor
//   lager = vist   ÷ display_factor
//
// Kør:
//   node scripts/test-packing-units.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const { autoFormatAmount, convertAndFormat } = require('../services/quConvert');
const grocy = require('../services/grocyAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Grocy-attrap: to produkter der rammer hver sin variant af fejlen ──
// 100 Æg:     lager Kilo, vises i Antal  → display ≠ stock (produkt-konvertering)
// 101 Rødløg: lager Kilo, vises i Kilo   → SAMME enhed, men autoFormat skifter kg→g
const QUS   = [{ id: 4, name: 'Kilo', name_short: 'kg' }, { id: 5, name: 'Gram', name_short: 'g' }, { id: 8, name: 'Antal' }];
const CONVS = [{ product_id: 100, from_qu_id: 4, to_qu_id: 8, factor: 16.666666 }];

grocy.getRecipes = async () => ([{ id: 1, name: 'Testret', unit_number: 1 }]);
grocy.getRecipeNestings = async () => ([]);
grocy.getRecipesRawMap = async () => new Map([[1, { base_servings: 1, name: 'Testret' }]]);
grocy.getAllRecipesPos = async () => ([
    { recipe_id: 1, product_id: 100, amount: 1.08, qu_id: 8, ingredient_group: '' },  // 1,08 kg æg, vises i Antal
    { recipe_id: 1, product_id: 101, amount: 0.14, qu_id: 4, ingredient_group: '' },  // 0,14 kg, vises som gram
]);
grocy.getProducts = async () => ([
    { id: 100, name: 'Æg',            qu_id_stock: 4, qu_id_purchase: 8 },
    { id: 101, name: 'Rødløg - Sylt', qu_id_stock: 4, qu_id_purchase: 4 },
]);
grocy.getQuantityUnits = async () => QUS;
grocy.getQuantityUnitConversions = async () => CONVS;
grocy.makeEffectiveStock = () => () => 99;
grocy.getStock = async () => ([]);

const { resolveIngredients } = require('../services/ingredientResolver');
const unitMap = new Map(QUS.map(u => [u.id, u]));

(async () => {
    console.log('\nPakkeliste: visnings-enhed vs. lager-enhed (#352)\n');

    // ── S1: autoFormatAmount melder hvilken faktor den brugte ──
    console.log('S1 · autoFormatAmount returnerer sin faktor');
    ok(autoFormatAmount(0.14, 'kg').factor === 1000, `0,14 kg → g giver faktor 1000 — fik ${autoFormatAmount(0.14, 'kg').factor}`);
    ok(autoFormatAmount(0.5, 'l').factor === 1000,   `0,5 l → ml giver faktor 1000 — fik ${autoFormatAmount(0.5, 'l').factor}`);
    ok(autoFormatAmount(1200, 'g').factor === 0.001, `1200 g → kg giver faktor 0,001 — fik ${autoFormatAmount(1200, 'g').factor}`);
    ok(autoFormatAmount(5, 'stk').factor === 1,      `uændret enhed giver faktor 1 — fik ${autoFormatAmount(5, 'stk').factor}`);

    // ── S2: convertAndFormat ganger BEGGE trin sammen ──
    console.log('\nS2 · convertAndFormat: enheds-konvertering × autoFormat');
    const egg = convertAndFormat(1.08, { productId: 100, fromQuId: 4, toQuId: 8, conversions: CONVS, unitMap });
    ok(egg.amount === 18 && egg.unit === 'Antal', `1,08 kg æg vises som 18 Antal — fik ${egg.amount} ${egg.unit}`);
    ok(close(egg.factor, 16.666666), `faktor 16,67 — fik ${egg.factor}`);

    const onion = convertAndFormat(0.14, { productId: 101, fromQuId: 4, toQuId: 4, conversions: CONVS, unitMap });
    ok(onion.amount === 140 && onion.unit === 'g', `0,14 kg vises som 140 g — fik ${onion.amount} ${onion.unit}`);
    ok(onion.factor === 1000, `faktor 1000 selvom qu_id er den samme — fik ${onion.factor}`);

    // ── S3: round-trip — det er DEN invariant klienten hviler på ──
    console.log('\nS3 · Round-trip: vist ÷ faktor = lager');
    ok(close(egg.amount / egg.factor, 1.08, 1e-4),     `18 ÷ 16,67 = 1,08 kg — fik ${egg.amount / egg.factor}`);
    ok(close(onion.amount / onion.factor, 0.14, 1e-9), `140 ÷ 1000 = 0,14 kg — fik ${onion.amount / onion.factor}`);

    // ── S4: serveren sender faktoren med ud på hver ingrediens ──
    console.log('\nS4 · display_factor + stock_unit_name eksponeres af resolveren');
    const r = await resolveIngredients([{ grocy_recipe_id: 1, quantity: 1 }]);
    const byName = Object.fromEntries(r.production.ingredients.map(i => [i.product_name, i]));

    const e = byName['Æg'], o = byName['Rødløg - Sylt'];
    ok(e && close(e.display_factor, 16.666666), `Æg: display_factor 16,67 — fik ${e && e.display_factor}`);
    ok(o && o.display_factor === 1000,          `Rødløg: display_factor 1000 — fik ${o && o.display_factor}`);
    ok(e && e.stock_unit_name === 'kg', `Æg: lager-enhed hedder kg (ikke visningens "Antal") — fik ${e && e.stock_unit_name}`);
    ok(o && o.stock_unit_name === 'kg', `Rødløg: lager-enhed kg (ikke visningens "g") — fik ${o && o.stock_unit_name}`);

    console.log('\nS5 · Invarianten holder på resolverens egne tal');
    for (const [name, ing] of Object.entries(byName)) {
        ok(close(ing.amount_needed / ing.display_factor, ing.needed_stock, 1e-4),
            `${name}: ${ing.amount_needed} ${ing.unit} ÷ ${Math.round(ing.display_factor * 100) / 100} = ${ing.needed_stock} (lager)`);
    }

    // ── S6: den konkrete fejl fra driften ──
    console.log('\nS6 · Køkkenet retter "140" til "150" i gram-feltet');
    const typed = 150;
    const storedNow    = typed / o.display_factor;   // efter rettelsen
    const storedBefore = typed;                      // før rettelsen (faktor 1)
    ok(close(storedNow, 0.15), `gemmes som 0,15 kg — fik ${storedNow}`);
    ok(storedBefore / storedNow === 1000, `den gamle kode gemte ${storedBefore} kg = ${storedBefore / storedNow}× for meget`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
