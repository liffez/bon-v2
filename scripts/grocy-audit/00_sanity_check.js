// Sanity-check: beregn kostpris for én konkret opskrift end-to-end.
// Output: per-ingrediens trace + total. Sammenlignes manuelt med Bon v2's
// bon_lines.cost_price og Grocys API-respons fra localhost:9283.
//
// Default: Italieneren (recipe_id=26, kendt worst offender, ratio 90×).
// Brug --recipe=<id> for at køre på en anden.

const path = require('path');
const os = require('os');
const { openDb } = require('./lib/db');

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => a.replace(/^--/, '').split('='))
);
const RECIPE_ID = parseInt(args.recipe || '26', 10);

const db = openDb();

const recipe = db.prepare(`
    SELECT id, name, base_servings, desired_servings, type
    FROM recipes WHERE id = ?
`).get(RECIPE_ID);

if (!recipe) {
    console.error(`Recipe ${RECIPE_ID} findes ikke.`);
    process.exit(1);
}

console.log('═'.repeat(78));
console.log(`SANITY-CHECK — Recipe ${recipe.id}: ${recipe.name}`);
console.log(`base_servings=${recipe.base_servings}, desired_servings=${recipe.desired_servings}, type=${recipe.type}`);
console.log('═'.repeat(78));

const userVals = db.prepare(`
    SELECT uf.name, uv.value
    FROM userfield_values uv
    JOIN userfields uf ON uf.id = uv.field_id
    WHERE uf.entity='recipes' AND uv.object_id = ?
`).all(String(RECIPE_ID));
const uf = Object.fromEntries(userVals.map(r => [r.name, r.value]));

console.log('\nUserfields:');
for (const [k, v] of Object.entries(uf)) console.log(`  ${k.padEnd(24)} = ${v}`);

const sales = parseFloat(uf.SalespriceCatering || 0);
const manualCost = parseFloat(uf.costprice || 0);

const ingredients = db.prepare(`
    SELECT rp.id, rp.product_id, p.name AS product_name, rp.amount, rp.qu_id,
           rp.price_factor, rp.note,
           p.qu_id_stock, p.qu_id_price, p.qu_id_purchase
    FROM recipes_pos rp
    LEFT JOIN products p ON p.id = rp.product_id
    WHERE rp.recipe_id = ?
    ORDER BY rp.id
`).all(RECIPE_ID);

const quNames = Object.fromEntries(
    db.prepare(`SELECT id, name FROM quantity_units`).all().map(r => [r.id, r.name])
);

const getConv = db.prepare(`
    SELECT factor, path FROM cache__quantity_unit_conversions_resolved
    WHERE product_id = ? AND from_qu_id = ? AND to_qu_id = ?
`);

const getAvgPrice = db.prepare(`
    SELECT price FROM cache__products_average_price WHERE product_id = ?
`);
const getLastPrice = db.prepare(`
    SELECT price, purchased_date FROM cache__products_last_purchased WHERE product_id = ?
`);

console.log('\nIngredienser:');
console.log('-'.repeat(78));

let totalCostNoConv = 0;
let totalCostWithConv = 0;
let unconvertedCount = 0;

for (const ing of ingredients) {
    const recipeQu = quNames[ing.qu_id] || `?(${ing.qu_id})`;
    const stockQu = quNames[ing.qu_id_stock] || `?(${ing.qu_id_stock})`;
    const priceQu = quNames[ing.qu_id_price] || `?(${ing.qu_id_price})`;

    const avg = getAvgPrice.get(ing.product_id);
    const last = getLastPrice.get(ing.product_id);
    const avgPrice = avg ? parseFloat(avg.price) : 0;

    // Grocys "naive" formel: amount × price_factor × avg_price (uden konvertering)
    const naiveCost = ing.amount * ing.price_factor * avgPrice;

    // Korrekt: konverter recipes_pos.qu_id → qu_id_price
    let convFactor = 1;
    let convPath = '(samme enhed)';
    if (ing.qu_id !== ing.qu_id_price) {
        const conv = getConv.get(ing.product_id, ing.qu_id, ing.qu_id_price);
        if (conv) {
            convFactor = parseFloat(conv.factor);
            convPath = conv.path;
        } else {
            convFactor = NaN;
            convPath = 'INGEN KONVERTERING FUNDET';
            unconvertedCount++;
        }
    }
    const correctCost = ing.amount * ing.price_factor * avgPrice * convFactor;

    totalCostNoConv += naiveCost;
    if (!isNaN(correctCost)) totalCostWithConv += correctCost;

    console.log(`#${ing.id} ${ing.product_name} (product_id=${ing.product_id})`);
    console.log(`  amount=${ing.amount} ${recipeQu}, price_factor=${ing.price_factor}`);
    console.log(`  product: stock=${stockQu}, price=${priceQu}, purchase=${quNames[ing.qu_id_purchase] || '?'}`);
    console.log(`  avg_price=${avgPrice.toFixed(4)} kr/${priceQu}`);
    if (last) console.log(`  last_purchase=${last.price} kr (${last.purchased_date})`);
    console.log(`  naive cost (uden konv): ${naiveCost.toFixed(4)} kr`);
    console.log(`  conv ${recipeQu}→${priceQu}: factor=${convFactor} ${convPath}`);
    console.log(`  korrekt cost (med konv): ${isNaN(correctCost) ? 'N/A' : correctCost.toFixed(4)} kr`);
    if (ing.note) console.log(`  note: ${ing.note}`);
    console.log('');
}

const servingsScale = (recipe.desired_servings || 1) / (recipe.base_servings || 1);

console.log('─'.repeat(78));
console.log(`Total kostpris (NAIV — uden enhedskonvertering): ${totalCostNoConv.toFixed(2)} kr`);
console.log(`Total kostpris (KORREKT — med konvertering):    ${(isNaN(totalCostWithConv) ? 0 : totalCostWithConv).toFixed(2)} kr`);
console.log(`Servings scale (desired/base): ${servingsScale}`);
console.log(`→ Pr. portion (naiv):    ${(totalCostNoConv * servingsScale).toFixed(2)} kr`);
console.log(`→ Pr. portion (korrekt): ${(totalCostWithConv * servingsScale).toFixed(2)} kr`);
if (unconvertedCount) console.log(`⚠ ${unconvertedCount} ingredienser uden konvertering`);

console.log('');
console.log('═'.repeat(78));
console.log('SAMMENLIGNING');
console.log('═'.repeat(78));
console.log(`Salgspris (Catering, incl moms): ${sales.toFixed(2)} kr`);
console.log(`Manuelt sat costprice (userfield): ${manualCost.toFixed(2)} kr`);
console.log('');
console.log('Margin-check (hvor "incl moms" antages, men cost er ex moms):');
const salesEx = sales / 1.25;
const costNaiv = totalCostNoConv * servingsScale;
const costKorr = totalCostWithConv * servingsScale;
console.log(`  Salgspris ex moms:           ${salesEx.toFixed(2)} kr`);
console.log(`  Naiv cost vs salg ex moms:   ratio ${(costNaiv / salesEx).toFixed(2)}`);
console.log(`  Korrekt cost vs salg ex moms: ratio ${(costKorr / salesEx).toFixed(2)}`);
console.log(`  Manuel cost vs salg ex moms: ratio ${(manualCost / salesEx).toFixed(2)}`);

console.log('');
console.log('Sammenlign nu med:');
console.log(`  1) Grocy API:  curl -u <login> http://localhost:9283/api/recipes/${RECIPE_ID}/fulfillment`);
console.log(`     (Grocys egen kostpris — beregnet samme måde som UI)`);
console.log(`  2) Bon v2:     SELECT product_name, unit_price, cost_price`);
console.log(`                 FROM bon_lines WHERE grocy_recipe_id=${RECIPE_ID} AND cost_price IS NOT NULL`);
console.log(`                 ORDER BY id DESC LIMIT 5;`);

db.close();
