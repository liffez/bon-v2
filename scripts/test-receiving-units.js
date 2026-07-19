// scripts/test-receiving-units.js
// ============================================================
// Regressionstest for #358 — varemodtagelsens enheds-oversættelse.
//
// Varemodtagelsen arbejder i den enhed varen blev BESTILT i (indkøbslisten
// gemmer i indkøbs-enhed: "Brød Rug: 994 Kasse"), mens Grocy tolker
// /stock/add's `amount` i produktets LAGER-enhed (Kilo). Uden konvertering
// blev 994 kasser til 994 kilo.
//
// To tilfælde nåede at ske i drift, og de er gengivet som testcases nedenfor
// med de rigtige konverteringsfaktorer fra grocy-hq.
//
// Princip der låses fast: der GÆTTES ALDRIG. Kan enheden ikke afgøres,
// returneres en fejl, så modtagelsen bliver partially_approved.
//
// Kør:
//   node scripts/test-receiving-units.js
// ============================================================

'use strict';

const { buildStockQuantityResolver } = require('../services/receivingUnits');

// Enheder og produkter som i grocy-hq
const UNITS = [
    { id: 4, name: 'Kilo' }, { id: 5, name: 'Gram' }, { id: 8, name: 'Antal' },
    { id: 13, name: 'Kasse' }, { id: 14, name: 'Pose' },
];
const PRODUCTS = [
    { id: 27, name: 'Spidskål',      qu_id_stock: 4, qu_id_purchase: 8 },
    { id: 25, name: 'Rødkål - Rå',   qu_id_stock: 4, qu_id_purchase: 8 },
    { id: 1,  name: 'Brød Rug',      qu_id_stock: 4, qu_id_purchase: 13 },
    { id: 47, name: 'Mayonaise',     qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 99, name: 'Uden konvert.', qu_id_stock: 4, qu_id_purchase: 14 },
];
const CONVERSIONS = [
    { product_id: 27, from_qu_id: 8,  to_qu_id: 4, factor: 0.5 },   // 1 spidskål = 0,5 kg
    { product_id: 25, from_qu_id: 8,  to_qu_id: 4, factor: 1.3 },   // 1 rødkål   = 1,3 kg
    { product_id: 1,  from_qu_id: 13, to_qu_id: 4, factor: 12 },    // 1 kasse    = 12 kg
    // produkt 99 har med vilje INGEN konvertering
];
const SHOPPING_LIST = [
    { id: 101, product_id: 27, amount: 10,      qu_id: 8 },
    { id: 102, product_id: 25, amount: 12.1875, qu_id: 8 },
    { id: 103, product_id: 1,  amount: 994,     qu_id: 13 },
    { id: 104, product_id: 47, amount: 15.875,  qu_id: 4 },
    { id: 105, product_id: 99, amount: 3,       qu_id: 14 },
];

const resolve = buildStockQuantityResolver({
    products: PRODUCTS, units: UNITS, conversions: CONVERSIONS, shoppingList: SHOPPING_LIST,
});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

console.log('\nVaremodtagelse: indkøbs-enhed → lager-enhed (#358)\n');

// ── De to tilfælde der faktisk skete ──
console.log('S1 · Spidskål, 3. juni 2026 — modtaget "10 Antal"');
let r = resolve({ grocy_product_id: 27, received_quantity: 10 });
ok(close(r.amount, 5) && r.unit === 'Kilo', `lægges på som 5 Kilo — fik ${r.amount} ${r.unit}`);
ok(r.factor === 0.5, `faktor 0,5 anvendt — fik ${r.factor}`);
ok(!r.assumed, 'markeret som verificeret konvertering, ikke et gæt');

console.log('\nS2 · Rødkål - Rå, 18. maj 2026 — modtaget "12,1875 Antal"');
r = resolve({ grocy_product_id: 25, received_quantity: 12.1875 });
ok(close(r.amount, 15.84375), `lægges på som 15,84 Kilo (var 12,19) — fik ${r.amount}`);

console.log('\nS3 · Brød Rug — 994 kasser er ikke 994 kilo');
r = resolve({ grocy_product_id: 1, received_quantity: 994 });
ok(close(r.amount, 11928), `994 Kasse × 12 = 11928 Kilo — fik ${r.amount}`);

// ── Uændret hvor enhederne er ens ──
console.log('\nS4 · Samme enhed → tallet røres ikke');
r = resolve({ grocy_product_id: 47, received_quantity: 15.875 });
ok(close(r.amount, 15.875) && r.factor === undefined, `15,875 Kilo uændret — fik ${r.amount}`);

// ── Der gættes aldrig ──
console.log('\nS5 · Manglende konvertering → fejl, ikke et gæt');
r = resolve({ grocy_product_id: 99, received_quantity: 3 });
ok(!!r.error && r.amount === undefined, `fejl i stedet for tal — fik "${r.error || r.amount}"`);
ok(/Pose/.test(r.error) && /Kilo/.test(r.error), `fejlen nævner begge enheder — "${r.error}"`);

console.log('\nS6 · Ukendt produkt → fejl');
r = resolve({ grocy_product_id: 12345, received_quantity: 1 });
ok(!!r.error, `fejl — fik "${r.error || r.amount}"`);

console.log('\nS7 · Samme vare i to enheder på listen → fejl frem for at vælge en');
const mixed = buildStockQuantityResolver({
    products: PRODUCTS, units: UNITS, conversions: CONVERSIONS,
    shoppingList: [{ id: 1, product_id: 27, amount: 2, qu_id: 8 },
                   { id: 2, product_id: 27, amount: 3, qu_id: 4 }],
});
r = mixed({ grocy_product_id: 27, received_quantity: 5 });
ok(!!r.error && /flere forskellige enheder/.test(r.error), `fejl — fik "${r.error || r.amount}"`);

// ── Serveren er autoritativ ──
console.log('\nS8 · Indkøbslisten vinder over klientens qu_id');
r = resolve({ grocy_product_id: 27, received_quantity: 10, qu_id: 4 });   // klient påstår Kilo
ok(close(r.amount, 5), `listen siger Antal → 5 Kilo, uanset hvad klienten sender — fik ${r.amount}`);

console.log('\nS9 · Uden indkøbsliste-række bruges klientens qu_id');
const noList = buildStockQuantityResolver({ products: PRODUCTS, units: UNITS, conversions: CONVERSIONS, shoppingList: [] });
r = noList({ grocy_product_id: 27, received_quantity: 10, qu_id: 8 });
ok(close(r.amount, 5), `klientens Antal → 5 Kilo — fik ${r.amount}`);

console.log('\nS10 · Ingen enhed nogen steder → gammel adfærd, men markeret');
r = noList({ grocy_product_id: 27, received_quantity: 10 });
ok(close(r.amount, 10) && r.assumed === true, `10 uændret og markeret som antaget — fik ${r.amount}, assumed=${r.assumed}`);

console.log('\nS11 · Grocy nede → intet lægges på lager');
const down = buildStockQuantityResolver({});
ok(!!down({ grocy_product_id: 27, received_quantity: 10 }).error, 'fejl frem for at skrive et utjekket tal');

console.log('\n─────────────────────────────────────────');
console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
