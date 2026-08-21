// scripts/test-producibility.js
// ============================================================
// "Kan varen laves?" — tilgængelighed fra råvarer (#266 §4.1)
//
// Grocys fulfillment stopper ved et produkts lager. Den ved ikke at
// mellemproduktet kan LAVES, og derfor så 9 af 11 mellemprodukter i grocy-hq
// ud som "mangler" i 28 opskrifts-referencer 20.08.2026, selvom råvarerne lå
// på hylden. Køkkenets egen sætning er hele reglen:
//
//   "Grisen er stegt, og mayoen blander vi det der mangler — hvis råvarerne
//    er der til at lave menuen, har vi styr på resten."
//
// To ting testes lige hårdt:
//   1. at "kan laves" siges når det ER sandt
//   2. at det IKKE siges når råvarerne også mangler — og at den fysiske
//      `status` aldrig pyntes, uanset hvad
//
// Kør:  node scripts/test-producibility.js
// ============================================================

'use strict';

const grocy = require('../services/grocyAdapter');

const QUS = [
    { id: 4, name: 'Kilo' },
    { id: 5, name: 'Gram' },
    { id: 8, name: 'Antal' },
];

// Lager sættes pr. test. Alt der ikke står her er 0.
let STOCK = {};

// ── Verden ──────────────────────────────────────────────────
// 1  Menu "Kartoflen"  → bruger 0,3 kg Rødløg-Sylt (et PRODUKT, ikke en nesting)
// 2  "Rødløg - Syltet" → producerer produkt 200, base_servings 2,8, 1 kg/portion
//                        = 2,8 kg pr. batch. Råvarer: 1 kg rå rødløg + 0,2 kg sukker
// 3  "Falaffel-stegning" → producerer produkt 210, yield erklæret i ANTAL (36)
//                        mens produktet lagerføres i KILO → kræver konvertering
// 4  "Ærter udblødt"   → producerer produkt 220 (kæde: 220 bruges af 3)
// 5  "Uden råvarer"    → producerer produkt 230, men har ingen ingredienser
// 6  "Gris"            → producerer produkt 240, uden erklæret udbytte
const RECIPES_RAW = new Map([
    [1, { id: 1, name: 'Kartoflen', base_servings: 1, userfields: {} }],
    [2, { id: 2, name: 'Rødløg - Syltet', base_servings: 2.8, product_id: 200,
          userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }],
    [3, { id: 3, name: 'Falaffel-stegning', base_servings: 1, product_id: 210,
          userfields: { recipeunit: 'antal', recipeunitnumber: '36' } }],
    [4, { id: 4, name: 'Ærter udblødt', base_servings: 1, product_id: 220,
          userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }],
    [5, { id: 5, name: 'Uden råvarer', base_servings: 1, product_id: 230,
          userfields: { recipeunit: 'kg', recipeunitnumber: '1' } }],
    [6, { id: 6, name: 'Gris', base_servings: 1, product_id: 240, userfields: {} }],
]);

const POS = [
    // menuen bruger de producerede varer direkte
    { recipe_id: 1, product_id: 200, amount: 0.3, qu_id: 4, ingredient_group: '' },
    { recipe_id: 1, product_id: 100, amount: 0.1, qu_id: 4, ingredient_group: '' }, // kartoffel
    // Rødløg-Syltet: 1 kg rå rødløg + 0,2 kg sukker + en serviet (emballage)
    { recipe_id: 2, product_id: 101, amount: 1,   qu_id: 4, ingredient_group: '' },
    { recipe_id: 2, product_id: 102, amount: 0.2, qu_id: 4, ingredient_group: '' },
    { recipe_id: 2, product_id: 103, amount: 1,   qu_id: 8, ingredient_group: 'Emballage' },
    // Falaffel: 0,3 kg udblødte ærter (selv et produceret produkt) + 0,25 kg tempty
    { recipe_id: 3, product_id: 220, amount: 0.3, qu_id: 4, ingredient_group: '' },
    { recipe_id: 3, product_id: 104, amount: 0.25, qu_id: 4, ingredient_group: '' },
    // Ærter udblødt: 1 kg tørrede ærter
    { recipe_id: 4, product_id: 105, amount: 1, qu_id: 4, ingredient_group: '' },
    // recipe 5 har med vilje ingen linjer
    // Gris: 1,1 kg svinekam
    { recipe_id: 6, product_id: 106, amount: 1.1, qu_id: 4, ingredient_group: '' },
];

const PRODUCTS = [
    { id: 100, name: 'Kartoffel',        qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 101, name: 'Rødløg - Rå',      qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 102, name: 'Sukker',           qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 103, name: 'Serviet',          qu_id_stock: 8, qu_id_purchase: 8 },
    { id: 104, name: 'Tempty',           qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 105, name: 'Ærter - tørrede',  qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 106, name: 'Svinekam',         qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 200, name: 'Rødløg - Sylt',    qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 210, name: 'Falaffel',         qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 220, name: 'Ærter udblødt',    qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 230, name: 'Tomvare',          qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 240, name: 'Stegt gris',       qu_id_stock: 4, qu_id_purchase: 4 },
];

// Falaffel: 1 Kilo = 35 Antal (som i grocy-hq)
const CONVERSIONS = [
    { product_id: null, from_qu_id: 4, to_qu_id: 5, factor: 1000 },
    { product_id: 210, from_qu_id: 8, to_qu_id: 4, factor: 1 / 35 },
    { product_id: 210, from_qu_id: 4, to_qu_id: 8, factor: 35 },
];

grocy.getRecipes = async () => ([{ id: 1, name: 'Kartoflen', unit_number: 1 }]);
grocy.getAllRecipesPos = async () => POS;
grocy.getRecipeNestings = async () => ([]);
grocy.getRecipesRawMap = async () => RECIPES_RAW;
grocy.getProducts = async () => PRODUCTS;
grocy.getQuantityUnits = async () => QUS;
grocy.getQuantityUnitConversions = async () => CONVERSIONS;
grocy.getStock = async () => ([]);
grocy.makeEffectiveStock = () => (pid) => STOCK[pid] || 0;

const { resolveIngredients } = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b) => Math.abs(a - b) < 1e-6;

async function ing(pid, lines = [{ grocy_recipe_id: 1, quantity: 1 }]) {
    const r = await resolveIngredients(lines);
    return (r.raw.ingredients || []).find(i => i.product_id === pid);
}

(async () => {
    console.log('\n"Kan varen laves?" — tilgængelighed fra råvarer\n');

    // ────────────────────────────────────────────────────────
    console.log('P1 · Mellemprodukt på 0, men råvarerne er der');
    STOCK = { 101: 5, 102: 5, 100: 5 };
    let i = await ing(200);
    ok(i.status === 'mangler', `den FYSISKE status er stadig "mangler" — fik "${i.status}"`);
    ok(i.effective_status === 'kan_laves', `effective_status = "kan_laves" — fik "${i.effective_status}"`);
    ok(i.producible === true, 'markeret som producerbar');
    ok(i.make_recipe_name === 'Rødløg - Syltet', `opskriften navngives — fik "${i.make_recipe_name}"`);
    ok(i.make_batches === 1, `0,3 kg behov af en 2,8 kg-batch → 1 batch — fik ${i.make_batches}`);
    ok(i.make_estimated === false, 'udbyttet er kendt, så det er ikke et skøn');
    ok(i.make_shortfalls.length === 0, 'ingen mangelliste når alt er der');

    // ────────────────────────────────────────────────────────
    console.log('\nP2 · Råvarerne mangler også — så råbes der stadig');
    STOCK = { 100: 5 };                       // ingen rå rødløg, intet sukker
    i = await ing(200);
    ok(i.status === 'mangler', 'fysisk status uændret');
    ok(i.effective_status === 'mangler', `effective_status forbliver "mangler" — fik "${i.effective_status}"`);
    ok(i.producible === true, 'varen ER producerbar — det er råvarerne der mangler');
    ok(i.make_status === 'mangler', 'make_status siger hvorfor');
    const names = i.make_shortfalls.map(s => s.product_name).sort();
    ok(names.join(',') === 'Rødløg - Rå,Sukker', `mangellisten peger på RÅVARERNE — fik ${JSON.stringify(names)}`);
    ok(!i.make_shortfalls.some(s => s.product_name === 'Serviet'),
       'emballage tæller ikke med — en manglende serviet stopper ikke en syltning');

    // ────────────────────────────────────────────────────────
    console.log('\nP3 · Delvis dækning af råvaren tæller ikke som "kan laves"');
    STOCK = { 101: 0.5, 102: 5, 100: 5 };      // kun 0,5 af 1 kg rødløg
    i = await ing(200);
    ok(i.effective_status === 'mangler', 'ikke nok råvarer ⇒ ikke "kan laves"');
    ok(i.make_shortfalls.length === 1 && i.make_shortfalls[0].status === 'lav',
       'råvaren står som "lav", ikke "mangler"');

    // ────────────────────────────────────────────────────────
    console.log('\nP4 · Hele batches — behovet rundes op, ikke ned');
    STOCK = { 101: 99, 102: 99, 100: 5 };
    const big = await ing(200, [{ grocy_recipe_id: 1, quantity: 30 }]);   // 30 × 0,3 = 9 kg
    ok(big.make_batches === 4, `9 kg af 2,8 kg pr. batch → 4 batches — fik ${big.make_batches}`);

    console.log('\nP5 · Råvarebehovet skalerer MED antallet af batches');
    STOCK = { 101: 3, 102: 99, 100: 5 };       // 3 kg rødløg rækker til 3 batches, ikke 4
    const short = await ing(200, [{ grocy_recipe_id: 1, quantity: 30 }]);
    ok(short.effective_status === 'mangler',
       'nok til 3 af 4 batches er ikke nok — ellers ville skaleringen være pynt');

    // ────────────────────────────────────────────────────────
    console.log('\nP6 · Udbytte erklæret i en ANDEN enhed end lager-enheden');
    // Falaffel: 36 antal pr. batch, 1 Antal = 1/35 Kilo → 1,0286 kg pr. batch
    STOCK = { 220: 99, 104: 99, 100: 5 };
    const fal = await resolveIngredients([{ grocy_recipe_id: 3, quantity: 1 }]);
    // recipe 3 er ikke en menu her; test i stedet direkte via en menu-linje:
    POS.push({ recipe_id: 1, product_id: 210, amount: 2, qu_id: 4, ingredient_group: '' });
    i = await ing(210);
    ok(i.effective_status === 'kan_laves', 'falaffel kan laves når ærter og tempty er der');
    ok(i.make_batches === 2, `2 kg behov af 1,03 kg pr. batch → 2 batches — fik ${i.make_batches}`);
    ok(i.make_estimated === false, 'konverteringen Antal→Kilo bruges, den ignoreres ikke');

    console.log('\nP7 · Kæden går i dybden: ærter → udblødte ærter → falaffel');
    STOCK = { 105: 99, 104: 99, 100: 5 };      // KUN tørrede ærter — ikke de udblødte
    i = await ing(210);
    ok(i.effective_status === 'kan_laves',
       'falaffel kan stadig laves, fordi de udblødte ærter selv kan laves');
    STOCK = { 104: 99, 100: 5 };               // hverken udblødte eller tørrede
    i = await ing(210);
    ok(i.effective_status === 'mangler', 'kæden brydes når bunden af den er tom');

    // ────────────────────────────────────────────────────────
    console.log('\nP8 · Uden erklæret udbytte påstås INTET');
    // Drifts-tilfældet: `Falaffel- stegning-styk` mangler recipeunitnumber, og
    // dens mængder er pr. stk. Ét batch er én falafel — men behovet var 20.
    // Regnet som "1 batch rækker" ville varen stå grøn på et grundlag der kun
    // beviser at man kan lave én.
    POS.push({ recipe_id: 1, product_id: 240, amount: 5, qu_id: 4, ingredient_group: '' });
    STOCK = { 106: 99, 100: 5 };
    i = await ing(240);
    ok(i.effective_status === 'mangler',
       `IKKE "kan laves" — udbyttet er ukendt, så behovet kan ikke omsættes til batches (fik "${i.effective_status}")`);
    ok(i.producible === true, 'varen er stadig markeret producerbar');
    ok(i.make_status === 'ukendt', `make_status siger hvorfor — fik "${i.make_status}"`);
    ok(i.make_estimated === true, 'markeret som skøn, så visningen kan sige det højt');

    console.log('\nP8b · En producent med KENDT udbytte vinder over en uden');
    // Samme vare, to opskrifter: 6 (uden udbytte) og 61 (med). Den der kan
    // verificeres skal vælges, ellers taber vi et sikkert svar til et usikkert.
    RECIPES_RAW.set(61, { id: 61, name: 'Gris - målt', base_servings: 1, product_id: 240,
        userfields: { recipeunit: 'kg', recipeunitnumber: '5' } });
    POS.push({ recipe_id: 61, product_id: 106, amount: 1, qu_id: 4, ingredient_group: '' });
    i = await ing(240);
    ok(i.make_recipe_name === 'Gris - målt', `vælger den målbare opskrift — fik "${i.make_recipe_name}"`);
    ok(i.effective_status === 'kan_laves', 'og så kan der siges "kan laves"');
    RECIPES_RAW.delete(61);

    console.log('\nP9 · En opskrift uden råvarer laver ingenting');
    POS.push({ recipe_id: 1, product_id: 230, amount: 1, qu_id: 4, ingredient_group: '' });
    STOCK = { 100: 5 };
    i = await ing(230);
    ok(i.effective_status === 'mangler',
       'en tom opskrift må ikke give "kan laves" ud af ingenting');

    console.log('\nP10 · Varer der ikke produceres er fuldstændig uændrede');
    STOCK = { 100: 0 };
    i = await ing(100);
    ok(i.status === 'mangler' && i.effective_status === 'mangler', 'status uændret');
    ok(i.producible === false, 'ikke markeret producerbar');
    ok(i.make_shortfalls.length === 0 && i.make_recipe_name === null, 'ingen make-felter opfundet');

    console.log('\nP11 · Er varen på lager, røres intet');
    STOCK = { 200: 99, 100: 5 };
    i = await ing(200);
    ok(i.status === 'ok' && i.effective_status === 'ok', 'ok forbliver ok');
    ok(i.make_shortfalls.length === 0, 'ingen mangelliste når der er dækning');

    console.log('\nP13 · Restbehovet kan regnes i ÉN enhed');
    // "Lav snart" skal sige hvor meget der SKAL LAVES, ikke hvad der skal bruges
    // i alt. Falaffel afslørede forskellen i drift: behov 130,96 med 124,89 på
    // lager blev vist som 130,96 — 20 gange for meget.
    //
    // De formaterede tal kan ikke trækkes fra hinanden, fordi autoformatet
    // vælger skala pr. værdi: 0,105 kg vises som "105 g" mens 0 vises som
    // "0 Kilo". Derfor skal den RÅ lagermængde være eksponeret.
    STOCK = { 200: 0.6, 101: 99, 102: 99, 100: 5 };
    i = await ing(200, [{ grocy_recipe_id: 1, quantity: 10 }]);   // behov 10 × 0,3 = 3 kg
    ok(i.stock_amount === 0.6, `rå lagermængde eksponeret i lager-enhed — fik ${i.stock_amount}`);
    const shortfall = (i.needed_stock - i.stock_amount) * (i.display_factor || 1);
    ok(Math.abs(shortfall - 2.4) < 1e-9,
       `restbehov 3 − 0,6 = 2,4 i visnings-enhed — fik ${shortfall}`);
    ok(i.amount_needed !== shortfall,
       'og det er IKKE det samme som det samlede behov — ellers var fejlen usynlig');

    console.log('\nP12 · Udfasede opskrifter navngives ikke');
    // "xgamle opskrifter" er konventionen for udfaset i grocy-hq. Køkkenet skal
    // ikke få besked på at lave efter en opskrift der er lagt væk — også når
    // den har et lavere id end den levende.
    RECIPES_RAW.set(3, { id: 3, name: 'Falaffel-stegning', base_servings: 1, product_id: 210,
        userfields: { recipeunit: 'antal', recipeunitnumber: '36', grupper: 'RR Produktion' } });
    RECIPES_RAW.set(2, { id: 2, name: 'Rødløg - Syltet (gammel)', base_servings: 2.8, product_id: 200,
        userfields: { recipeunit: 'kg', recipeunitnumber: '1', grupper: 'xgamle opskrifter' } });
    RECIPES_RAW.set(70, { id: 70, name: 'Rødløg - Syltet', base_servings: 2.8, product_id: 200,
        userfields: { recipeunit: 'kg', recipeunitnumber: '1', grupper: 'RR Produktion' } });
    POS.push({ recipe_id: 70, product_id: 101, amount: 1,   qu_id: 4, ingredient_group: '' });
    POS.push({ recipe_id: 70, product_id: 102, amount: 0.2, qu_id: 4, ingredient_group: '' });
    STOCK = { 101: 5, 102: 5, 100: 5 };
    i = await ing(200);
    ok(i.make_recipe_name === 'Rødløg - Syltet',
       `den levende opskrift navngives, ikke den udfasede med lavere id — fik "${i.make_recipe_name}"`);
    ok(i.make_recipe_group === 'RR Produktion',
       `gruppen eksponeres, så forecastet kan skelne RR fra Hurtig — fik "${i.make_recipe_group}"`);

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
