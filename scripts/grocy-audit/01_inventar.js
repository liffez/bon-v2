// FASE 1 — Inventar
// Baseline-tællinger. Sellable per gruppe (klassificeret: SALG/HALVFABRIKATA/SERVICE/EMBALLAGE).
// Userfield-coverage per gruppe.

const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');
const { classifyGroup } = require('./lib/groups');

const db = openDb();
const sections = [];

// 1.1 Tabel-tællinger
const tables = ['products', 'recipes', 'recipes_pos', 'recipes_nestings',
    'quantity_units', 'quantity_unit_conversions', 'product_groups',
    'shopping_list', 'stock', 'userfields', 'userfield_values',
    'product_barcodes', 'cache__products_average_price'];
const counts = tables.map(t => {
    try {
        return { tabel: t, antal: db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n };
    } catch { return { tabel: t, antal: '(findes ikke)' }; }
});
sections.push({ title: '1.1 Tabel-tællinger', body: formatTable(counts) });

// 1.2 Produkter — aktive vs inaktive
const productStatus = db.prepare(`
    SELECT CASE WHEN active=1 THEN 'aktive' ELSE 'inaktive' END AS status, COUNT(*) AS antal
    FROM products GROUP BY active
`).all();
sections.push({ title: '1.2 Produkter — aktive vs inaktive', body: formatTable(productStatus) });

// 1.3 Sellable opskrifter per gruppe (klassificeret)
const sellableByGroup = db.prepare(`
    SELECT uv.value AS gruppe, COUNT(DISTINCT uv.object_id) AS antal
    FROM userfield_values uv
    JOIN userfields uf ON uf.id = uv.field_id
    WHERE uf.entity = 'recipes' AND uf.name = 'grupper'
      AND uv.object_id IN (
        SELECT object_id FROM userfield_values uv2
        JOIN userfields uf2 ON uf2.id = uv2.field_id
        WHERE uf2.entity = 'recipes' AND uf2.name = 'sellable' AND uv2.value = '1'
      )
    GROUP BY uv.value ORDER BY antal DESC
`).all().map(r => ({ ...r, klasse: classifyGroup(r.gruppe) }));
sections.push({ title: '1.3 Sellable opskrifter per gruppe (klassificeret)', body: formatTable(sellableByGroup) });

// Aggregér klassifikation
const byClass = {};
for (const r of sellableByGroup) {
    byClass[r.klasse] = (byClass[r.klasse] || 0) + r.antal;
}
sections.push({
    title: '1.3b Sellable opskrifter per klassifikation',
    body: formatTable(Object.entries(byClass).map(([klasse, antal]) => ({ klasse, antal })))
});

// 1.4 Aktive opskrifter (alle, uanset sellable)
// Recipes har ingen 'active'-kolonne — type='normal' antages som "i brug"
const recipeTypes = db.prepare(`SELECT type, COUNT(*) AS antal FROM recipes GROUP BY type`).all();
sections.push({ title: '1.4 Recipes per type', body: formatTable(recipeTypes) });

// 1.5 Userfield-definitioner — kort liste over relevante for audit
const auditUfs = db.prepare(`
    SELECT entity, name, type, caption FROM userfields
    WHERE entity IN ('recipes', 'products')
    ORDER BY entity, name
`).all();
sections.push({ title: '1.5 Audit-relevante userfields', body: formatTable(auditUfs) });

// 1.6 Userfield-værdier — coverage per relevant felt
const fields = [
    { entity: 'recipes', name: 'sellable', expect: 'alle salgsvarer + halvfabrikata' },
    { entity: 'recipes', name: 'SalespriceCatering', expect: 'alle SALG' },
    { entity: 'recipes', name: 'SalespriceStore', expect: 'alle SALG' },
    { entity: 'recipes', name: 'Co2e', expect: 'alle SALG' },
    { entity: 'recipes', name: 'grupper', expect: 'alle sellable' },
    { entity: 'recipes', name: 'recipeunit', expect: 'alle sellable' },
    { entity: 'products', name: 'Co2e', expect: 'aktive råvarer' },
    { entity: 'products', name: 'Oeko', expect: 'aktive råvarer' }
];
const coverage = [];
for (const f of fields) {
    const total = db.prepare(`
        SELECT COUNT(*) AS n FROM userfield_values uv
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity = ? AND uf.name = ?
    `).get(f.entity, f.name).n;
    const empty = db.prepare(`
        SELECT COUNT(*) AS n FROM userfield_values uv
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity = ? AND uf.name = ? AND (uv.value = '' OR uv.value = '0')
    `).get(f.entity, f.name).n;
    coverage.push({ entity: f.entity, name: f.name, antal_rækker: total, tomme_eller_0: empty, forventet: f.expect });
}
sections.push({ title: '1.6 Userfield-værdier coverage', body: formatTable(coverage) });

// 1.7 Quantity units — er alle aktive?
const qus = db.prepare(`SELECT id, name, name_plural, active FROM quantity_units ORDER BY id`).all();
sections.push({ title: '1.7 Quantity units', body: formatTable(qus) });

// 1.8 Product groups — kategorier på råvarer
const pGroups = db.prepare(`
    SELECT pg.id, pg.name, pg.active, COUNT(p.id) AS antal_produkter
    FROM product_groups pg
    LEFT JOIN products p ON p.product_group_id = pg.id AND p.active = 1
    GROUP BY pg.id, pg.name, pg.active ORDER BY antal_produkter DESC
`).all();
sections.push({ title: '1.8 Product groups (råvare-kategorier)', body: formatTable(pGroups) });

writeReport('01_inventar', sections);
db.close();
console.log(`Sellable klassifikation:`);
for (const [klasse, antal] of Object.entries(byClass)) console.log(`  ${klasse.padEnd(15)} ${antal}`);
