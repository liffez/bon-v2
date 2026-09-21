// scripts/test-kostpris-effekt.js
// ============================================================
// Måle-scriptets FØR-tal (#557 + #558).
//
// `audit:kostpris-kilder` måler hvad prisreglerne flytter. Tallet i PR'en
// kommer derfra, så FØR-tallet skal være den gamle adfærd — ikke en tilnærmelse.
// Det genskabes ved at ændre INPUT frem for beregningen:
//
//   · prisen slås op som main gør det: bulk-genvejens lagerpost først, ellers
//     seneste køb → Grocys gennemsnit
//   · `product_id` fjernes fra producerende opskrifter hvis produkt HAR en
//     pris — så falder beregningen tilbage på lagerprisen, som den gjorde før
//
// Er den emulering forkert, er PR-tallet forkert. Derfor denne test.
//
// Kør:  node scripts/test-kostpris-effekt.js
// ============================================================

'use strict';

// Isoleret database — et test-script må aldrig røre udviklerens egen (#516).
require('./helpers/isolated_db');

const { computeAll } = require('../services/recipeCost');
const { gammelPrisregel, gammelProduceretRegel } = require('./audit-kostpris-kilder');

const QUS = [{ id: 4, name: 'Kilo' }, { id: 8, name: 'Antal' }];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b, tol = 0.005) => Math.abs(a - b) < tol;

// Remoulade (produkt 20) laves af 1 kg mayo. Fisken bruger 1 kg remoulade.
const RECIPES = [
    { id: 10, name: 'Remoulade', base_servings: 1, product_id: 20,
      userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
    { id: 24, name: 'Fisken', base_servings: 1, userfields: {} },
];
const WORLD = {
    products: [{ id: 1, name: 'Mayo', qu_id_stock: 4 }, { id: 20, name: 'Remoulade', qu_id_stock: 4 }],
    pos: [{ recipe_id: 10, product_id: 1, amount: 1 }, { recipe_id: 24, product_id: 20, amount: 1 }],
    nestings: [], units: QUS, conversions: [],
};
const kør = (recipes, priser) => computeAll({ ...WORLD, recipes, priceByProduct: priser }).get(24).cost;

console.log('\nMåle-scriptets FØR-tal\n');

console.log('E1 · Den gamle prisrækkefølge');
{
    // Mains FØRSTE led var bulk-genvejen: nyeste lagerposts pris for alt der
    // var på lager. Den gik uden om prisvalget, så uden den i emuleringen ville
    // FØR-tallet være et andet end det main faktisk viste.
    ok(gammelPrisregel({ last_price: 42.01, avg_price: 78.29, source: 'avg_window', cost: 78.29 }, 40) === 40,
       'bulk-genvejens lagerpost vinder — sådan regnede main for alt på lager');
    ok(gammelPrisregel({ last_price: 42.01, avg_price: 78.29, source: 'avg_window', cost: 78.29 }, 0) === 42.01,
       'uden lagerpost: seneste køb — det var reglen før #557');
    ok(gammelPrisregel({ last_price: 42.01, avg_price: 78.29, source: 'avg', cost: 78.29 }) === 42.01,
       'seneste køb først — det var reglen før #557');
    ok(near(gammelPrisregel({ source: 'stock_value', cost: 25 }), 25),
       'lagerværdi/mængde er den samme før og efter');
    ok(gammelPrisregel({ last_price: null, avg_price: 78.29, source: 'avg', cost: 78.29 }) === 78.29,
       'gennemsnittet når der ikke er et seneste køb');
    // `stock_value`, `stock_row` og `parent_avg` valgtes ens før og efter, så
    // de bæres uændret igennem — ellers ville FØR-tallet flytte sig af sig selv.
    ok(gammelPrisregel({ source: 'parent_avg', cost: 19.25 }) === 19.25,
       'en arvet forældre-pris er den samme før og efter');
    ok(gammelPrisregel(null) === null, 'ingen pris → null');
}

console.log('\nE2 · Lagerprisen vandt før — og gør det i FØR-tallet');
{
    const priser = new Map([['1', 100], ['20', 60]]);
    const før = kør(gammelProduceretRegel(RECIPES, priser), priser);
    const efter = kør(RECIPES, priser);
    ok(near(før, 60), `FØR bruger lagerprisens 60 (fik ${før.toFixed(2)})`);
    ok(near(efter, 100), `EFTER bruger opskriftens 100 (fik ${efter.toFixed(2)})`);
    ok(!near(før, efter), 'de to er forskellige — ellers ville målingen vise 0 uanset hvad');
}

console.log('\nE3 · Uden lagerpris arvede den gamle kode også fra opskriften (#269)');
{
    // Emuleringen må ikke ændre dét tilfælde: gør den det, ville måle-scriptet
    // tilskrive #558 en effekt der aldrig fandtes.
    const priser = new Map([['1', 100]]);
    const stripped = gammelProduceretRegel(RECIPES, priser);
    ok(stripped.find(r => r.id === 10).product_id === 20,
       'produktet uden pris beholder sin producent');
    ok(near(kør(stripped, priser), 100), 'og bidraget arves fra opskriften — før som efter');
}

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
