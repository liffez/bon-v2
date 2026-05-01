// FASE 4 — Enheds-konsistens
// Fokus: produkter hvor qu_id_stock IKKE er Kilo (din intention er Kilo for normale varer).
// + drikke der mistænkes for at have skæve enheds-mappings.
// + recipes_pos hvor amount er voldsomt mistænkelig (< 0.001 eller > 100).

const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');

const db = openDb();
const sections = [];

const quNames = Object.fromEntries(
    db.prepare(`SELECT id, name FROM quantity_units`).all().map(r => [r.id, r.name])
);

// 4.1 Aktive produkter hvor qu_id_stock IKKE er Kilo (ID 4)
const nonKiloStock = db.prepare(`
    SELECT p.id, p.name, p.qu_id_stock, p.qu_id_purchase, p.qu_id_price,
           pg.name AS group_name
    FROM products p
    LEFT JOIN product_groups pg ON pg.id = p.product_group_id
    WHERE p.active = 1 AND p.qu_id_stock != 4
    ORDER BY pg.name, p.name
`).all().map(r => ({
    ...r,
    stock: quNames[r.qu_id_stock],
    purchase: quNames[r.qu_id_purchase],
    price: quNames[r.qu_id_price]
}));
sections.push({ title: '4.1 Aktive produkter med qu_id_stock ≠ Kilo',
    body: formatTable(nonKiloStock.map(r => ({
        id: r.id, name: r.name, group: r.group_name,
        stock: r.stock, purchase: r.purchase, price: r.price
    }))) });

// 4.2 Pris-pr-enhed mismatch: qu_id_stock ≠ qu_id_price uden konvertering
const priceUnitMismatch = db.prepare(`
    SELECT p.id, p.name, p.qu_id_stock, p.qu_id_price,
           (SELECT factor FROM cache__quantity_unit_conversions_resolved
            WHERE product_id = p.id AND from_qu_id = p.qu_id_stock AND to_qu_id = p.qu_id_price) AS factor
    FROM products p
    WHERE p.active = 1 AND p.qu_id_stock != p.qu_id_price
`).all().map(r => ({
    id: r.id, name: r.name,
    stock: quNames[r.qu_id_stock],
    price: quNames[r.qu_id_price],
    konvertering: r.factor === null ? 'INGEN' : r.factor
}));
sections.push({ title: '4.2 Produkter hvor qu_id_stock ≠ qu_id_price (kræver konvertering)',
    body: formatTable(priceUnitMismatch) });

// 4.3 Recipes_pos hvor amount er ekstrem (< 0.001 eller > 1000)
const extremeAmounts = db.prepare(`
    SELECT rp.id, rp.recipe_id, r.name AS recipe_name, p.name AS product_name,
           rp.amount, rp.qu_id, rp.price_factor
    FROM recipes_pos rp
    LEFT JOIN recipes r ON r.id = rp.recipe_id
    LEFT JOIN products p ON p.id = rp.product_id
    WHERE rp.amount < 0.001 OR rp.amount > 1000
    ORDER BY rp.amount DESC
`).all().map(r => ({
    ...r, qu: quNames[r.qu_id]
}));
sections.push({ title: '4.3 Recipes_pos med ekstreme amounts (< 0.001 eller > 1000)',
    body: extremeAmounts.length ? formatTable(extremeAmounts.map(r => ({
        recipe: r.recipe_name, product: r.product_name,
        amount: r.amount, qu: r.qu, factor: r.price_factor
    }))) : '_(ingen)_' });

// 4.4 Recipes_pos hvor qu_id ≠ products.qu_id_stock og produktets qu_id_stock IKKE er Kilo
// (de mest sandsynlige fejl-kilder)
const recipeUnitMismatch = db.prepare(`
    SELECT rp.id, r.name AS recipe_name, p.name AS product_name,
           rp.amount, rp.qu_id AS recipe_qu, p.qu_id_stock,
           (SELECT factor FROM cache__quantity_unit_conversions_resolved
            WHERE product_id = p.id AND from_qu_id = rp.qu_id AND to_qu_id = p.qu_id_stock) AS to_stock,
           (SELECT factor FROM cache__quantity_unit_conversions_resolved
            WHERE product_id = p.id AND from_qu_id = rp.qu_id AND to_qu_id = p.qu_id_price) AS to_price
    FROM recipes_pos rp
    LEFT JOIN recipes r ON r.id = rp.recipe_id
    LEFT JOIN products p ON p.id = rp.product_id
    WHERE rp.qu_id != p.qu_id_stock
    ORDER BY r.name
`).all().map(r => ({
    recipe: r.recipe_name, product: r.product_name,
    amount: r.amount, recipe_qu: quNames[r.recipe_qu],
    stock_qu: quNames[r.qu_id_stock],
    to_stock: r.to_stock,
    to_price: r.to_price
}));
sections.push({ title: '4.4 Recipes_pos hvor qu_id ≠ product.qu_id_stock',
    body: recipeUnitMismatch.length > 50
        ? formatTable(recipeUnitMismatch.slice(0, 50)) + `\n\n_... og ${recipeUnitMismatch.length - 50} mere_`
        : formatTable(recipeUnitMismatch) });

const noConv = recipeUnitMismatch.filter(r => r.to_stock === null);
sections.push({ title: '4.4b Heraf UDEN konvertering til stock-enhed (kritisk)',
    body: noConv.length ? formatTable(noConv) : '_(alle har konvertering)_' });

// 4.5 Drikke (group=08 Drikkevarer eller recipes med gruppe=05 Drikke)
const drinks = db.prepare(`
    SELECT p.id, p.name, p.qu_id_stock, p.qu_id_purchase, p.qu_id_price,
           pg.name AS group_name
    FROM products p
    LEFT JOIN product_groups pg ON pg.id = p.product_group_id
    WHERE p.active = 1 AND pg.name LIKE '%Drikke%'
    ORDER BY p.name
`).all().map(r => ({
    id: r.id, name: r.name, group: r.group_name,
    stock: quNames[r.qu_id_stock],
    purchase: quNames[r.qu_id_purchase],
    price: quNames[r.qu_id_price]
}));
sections.push({ title: '4.5 Drikkevare-produkter — qu-mapping',
    body: formatTable(drinks) });

// 4.6 Inaktive produkter brugt i aktive recipes
const inactiveInUse = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.active, COUNT(rp.id) AS used_in_recipes
    FROM products p
    JOIN recipes_pos rp ON rp.product_id = p.id
    WHERE p.active = 0
    GROUP BY p.id
`).all();
sections.push({ title: '4.6 Inaktive produkter brugt i opskrifter',
    body: inactiveInUse.length ? formatTable(inactiveInUse) : '_(ingen)_' });

writeReport('04_enheder', sections);
db.close();

console.log('Fase 4 fund:');
console.log(`  Aktive produkter ≠ Kilo stock:           ${nonKiloStock.length}`);
console.log(`  qu_id_stock ≠ qu_id_price (kræver konv): ${priceUnitMismatch.length}`);
console.log(`  Ekstreme amounts (<0.001 eller >1000):   ${extremeAmounts.length}`);
console.log(`  recipes_pos.qu ≠ product.stock_qu:       ${recipeUnitMismatch.length}`);
console.log(`    heraf uden konvertering (KRITISK):     ${noConv.length}`);
console.log(`  Drikkevarer:                              ${drinks.length}`);
console.log(`  Inaktive produkter i recipes:            ${inactiveInUse.length}`);
