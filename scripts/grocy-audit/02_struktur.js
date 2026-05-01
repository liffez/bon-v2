// FASE 2 — Strukturelle problemer
// Find rækker der bryder antagelser:
// - Dublet-produkter
// - Brækkede FK i recipes_pos / recipes_nestings
// - Tomme opskrifter (ingen ingredienser, ingen sub-recipes)
// - Forældreløse opskrifter (ikke sellable + ikke brugt som sub-recipe)
// - Sub-recipe loops
// - Sellable opskrifter uden recipes_pos (ingen ingredienser)
// - Userfield-værdier på slettede objekter (skrald)

const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');

const db = openDb();
const sections = [];

// 2.1 Aktive produkter — qu-mapping (NULL ikke muligt jf skema, men dobbelttjek)
const productsNoQu = db.prepare(`
    SELECT id, name, qu_id_purchase, qu_id_stock, qu_id_price
    FROM products
    WHERE active=1 AND (qu_id_purchase IS NULL OR qu_id_stock IS NULL OR qu_id_price IS NULL)
`).all();
sections.push({ title: '2.1 Aktive produkter med NULL qu-mapping', body: formatTable(productsNoQu) });

// 2.2 Dublet-produkter (samme navn, case-insensitive)
const duplicates = db.prepare(`
    SELECT LOWER(TRIM(name)) AS lower_name, COUNT(*) AS antal,
           GROUP_CONCAT(id || ':' || name || ':active=' || active) AS rækker
    FROM products
    GROUP BY LOWER(TRIM(name))
    HAVING antal > 1
    ORDER BY antal DESC
`).all();
sections.push({ title: '2.2 Dublet-produkter (samme navn)', body: formatTable(duplicates) });

// 2.3 Recipes_pos der peger på slettede produkter
const brokenPos = db.prepare(`
    SELECT rp.id, rp.recipe_id, r.name AS recipe_name, rp.product_id, rp.amount, rp.qu_id, rp.note
    FROM recipes_pos rp
    LEFT JOIN products p ON p.id = rp.product_id
    LEFT JOIN recipes r ON r.id = rp.recipe_id
    WHERE rp.product_id IS NOT NULL AND p.id IS NULL
`).all();
sections.push({ title: '2.3 Recipes_pos med brækket FK til products', body: formatTable(brokenPos) });

// 2.4 Recipes_nestings der peger på slettede recipes
const brokenNestings = db.prepare(`
    SELECT rn.id, rn.recipe_id, r1.name AS parent, rn.includes_recipe_id, r2.name AS sub
    FROM recipes_nestings rn
    LEFT JOIN recipes r1 ON r1.id = rn.recipe_id
    LEFT JOIN recipes r2 ON r2.id = rn.includes_recipe_id
    WHERE r1.id IS NULL OR r2.id IS NULL
`).all();
sections.push({ title: '2.4 Recipes_nestings med brækket FK', body: formatTable(brokenNestings) });

// 2.5 Tomme opskrifter (ingen recipes_pos OG ingen recipes_nestings)
const emptyRecipes = db.prepare(`
    SELECT r.id, r.name, r.type, r.base_servings,
           (SELECT COUNT(*) FROM recipes_pos WHERE recipe_id = r.id) AS pos_count,
           (SELECT COUNT(*) FROM recipes_nestings WHERE recipe_id = r.id) AS nest_count
    FROM recipes r
    WHERE NOT EXISTS (SELECT 1 FROM recipes_pos WHERE recipe_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM recipes_nestings WHERE recipe_id = r.id)
    ORDER BY r.name
`).all();

// Markér hvilke der er sellable
const sellableIds = new Set(
    db.prepare(`
        SELECT object_id FROM userfield_values uv
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1'
    `).all().map(r => r.object_id)
);
const usedAsSub = new Set(
    db.prepare(`SELECT DISTINCT includes_recipe_id FROM recipes_nestings`).all()
        .map(r => String(r.includes_recipe_id))
);
emptyRecipes.forEach(r => {
    r.sellable = sellableIds.has(String(r.id)) ? 'JA' : 'nej';
    r.brugt_som_sub = usedAsSub.has(String(r.id)) ? 'JA' : 'nej';
});
sections.push({ title: '2.5 Tomme opskrifter (ingen ingredienser, ingen sub-recipes)', body: formatTable(emptyRecipes) });

// 2.6 Forældreløse opskrifter (ikke sellable, ikke brugt som sub-recipe)
const orphans = db.prepare(`
    SELECT r.id, r.name, r.type
    FROM recipes r
    WHERE NOT EXISTS (
        SELECT 1 FROM userfield_values uv
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1' AND uv.object_id = CAST(r.id AS TEXT)
    )
    AND r.id NOT IN (SELECT includes_recipe_id FROM recipes_nestings)
    ORDER BY r.name
`).all();
sections.push({ title: '2.6 Forældreløse opskrifter (ikke sellable, ikke sub-recipe)', body: formatTable(orphans) });

// 2.7 Sellable opskrifter UDEN recipes_pos (kun nestings) — sjovt edge case
const sellableNoPos = db.prepare(`
    SELECT r.id, r.name,
           (SELECT COUNT(*) FROM recipes_pos WHERE recipe_id = r.id) AS pos_count,
           (SELECT COUNT(*) FROM recipes_nestings WHERE recipe_id = r.id) AS nest_count
    FROM recipes r
    WHERE r.id IN (
        SELECT object_id FROM userfield_values uv
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1'
    )
    AND (SELECT COUNT(*) FROM recipes_pos WHERE recipe_id = r.id) = 0
`).all();
sections.push({ title: '2.7 Sellable opskrifter uden direkte ingredienser', body: formatTable(sellableNoPos) });

// 2.8 Userfield-værdier der peger på ikke-eksisterende recipes
const orphanRecipeUfs = db.prepare(`
    SELECT uv.id, uf.entity, uf.name, uv.object_id, uv.value
    FROM userfield_values uv
    JOIN userfields uf ON uf.id = uv.field_id
    WHERE uf.entity = 'recipes'
      AND CAST(uv.object_id AS INTEGER) NOT IN (SELECT id FROM recipes)
    LIMIT 50
`).all();
sections.push({ title: '2.8 Userfield-værdier på slettede recipes', body: formatTable(orphanRecipeUfs) });

const orphanProductUfs = db.prepare(`
    SELECT uv.id, uf.entity, uf.name, uv.object_id, uv.value
    FROM userfield_values uv
    JOIN userfields uf ON uf.id = uv.field_id
    WHERE uf.entity = 'products'
      AND CAST(uv.object_id AS INTEGER) NOT IN (SELECT id FROM products)
    LIMIT 50
`).all();
sections.push({ title: '2.8b Userfield-værdier på slettede products', body: formatTable(orphanProductUfs) });

// 2.9 Cirkulære sub-recipes (recipe inkluderer sig selv via et eller flere niveauer)
const allNestings = db.prepare(`SELECT recipe_id, includes_recipe_id FROM recipes_nestings`).all();
const nestMap = {};
for (const n of allNestings) {
    if (!nestMap[n.recipe_id]) nestMap[n.recipe_id] = [];
    nestMap[n.recipe_id].push(n.includes_recipe_id);
}
const cycles = [];
for (const start of Object.keys(nestMap)) {
    const startId = parseInt(start);
    const visited = new Set([startId]);
    const queue = [...nestMap[startId]];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === startId) {
            cycles.push({ recipe_id: startId });
            break;
        }
        if (visited.has(cur)) continue;
        visited.add(cur);
        if (nestMap[cur]) queue.push(...nestMap[cur]);
    }
}
const cycleNames = cycles.map(c => {
    const name = db.prepare(`SELECT name FROM recipes WHERE id = ?`).get(c.recipe_id)?.name;
    return { recipe_id: c.recipe_id, name };
});
sections.push({ title: '2.9 Cirkulære sub-recipes', body: formatTable(cycleNames) });

writeReport('02_struktur', sections);
db.close();

console.log('Fase 2 fund:');
console.log(`  NULL qu-mapping:        ${productsNoQu.length}`);
console.log(`  Dublet-produkter:       ${duplicates.length}`);
console.log(`  Brækkede recipes_pos:   ${brokenPos.length}`);
console.log(`  Brækkede nestings:      ${brokenNestings.length}`);
console.log(`  Tomme opskrifter:       ${emptyRecipes.length}`);
console.log(`  Forældreløse opskr:     ${orphans.length}`);
console.log(`  Sellable uden pos:      ${sellableNoPos.length}`);
console.log(`  Skrald-uf (recipes):    ${orphanRecipeUfs.length}`);
console.log(`  Skrald-uf (products):   ${orphanProductUfs.length}`);
console.log(`  Cirkulære nestings:     ${cycles.length}`);
