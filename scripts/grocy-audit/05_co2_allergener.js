// FASE 5 — Co2e + allergener
// Read-only listing af manglende felter på SALG-opskrifter og deres ingredienser.

const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');
const { classifyGroup } = require('./lib/groups');

const db = openDb();
const sections = [];

// Hent SALG-opskrifter
const sellable = db.prepare(`
    SELECT r.id, r.name,
        (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='recipes' AND uf.name='grupper' AND uv.object_id=CAST(r.id AS TEXT)) AS gruppe,
        (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='recipes' AND uf.name='Co2e' AND uv.object_id=CAST(r.id AS TEXT)) AS co2e,
        (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='recipes' AND uf.name='Oeko' AND uv.object_id=CAST(r.id AS TEXT)) AS oeko
    FROM recipes r
    WHERE r.id IN (
        SELECT object_id FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
        WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1'
    )
    ORDER BY r.name
`).all().map(r => ({ ...r, klasse: classifyGroup(r.gruppe) }));

// 5.1 SALG-opskrifter uden Co2e
const salgNoCo2e = sellable.filter(r => r.klasse === 'SALG' && (!r.co2e || parseFloat(r.co2e) <= 0));
sections.push({ title: '5.1 SALG-opskrifter uden Co2e (recipe-niveau)',
    body: formatTable(salgNoCo2e.map(r => ({ id: r.id, name: r.name, gruppe: r.gruppe }))) });

// 5.2 SALG-opskrifter uden Oeko-flag
const salgNoOeko = sellable.filter(r => r.klasse === 'SALG' && !r.oeko);
sections.push({ title: '5.2 SALG-opskrifter uden Oeko-flag (recipe-niveau)',
    body: formatTable(salgNoOeko.map(r => ({ id: r.id, name: r.name, gruppe: r.gruppe }))) });

// 5.3 Aktive råvare-produkter (kun dem brugt i sellable opskrifter) uden Co2e
const productsInUse = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.product_group_id, pg.name AS group_name,
        (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='products' AND uf.name='Co2e' AND uv.object_id=CAST(p.id AS TEXT)) AS co2e,
        (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='products' AND uf.name='hk_co2e' AND uv.object_id=CAST(p.id AS TEXT)) AS hk_co2e,
        (SELECT GROUP_CONCAT(value) FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
         WHERE uf.entity='product_barcodes' AND uf.name='hk_allergens'
           AND uv.object_id IN (SELECT CAST(id AS TEXT) FROM product_barcodes WHERE product_id = p.id)) AS hk_allergens
    FROM products p
    LEFT JOIN product_groups pg ON pg.id = p.product_group_id
    WHERE p.active = 1 AND p.id IN (SELECT product_id FROM recipes_pos)
    ORDER BY pg.name, p.name
`).all();

const productsNoCo2e = productsInUse.filter(p => (!p.co2e || parseFloat(p.co2e) <= 0) && (!p.hk_co2e || parseFloat(p.hk_co2e) <= 0));
sections.push({ title: '5.3 Råvarer brugt i opskrifter — uden Co2e (heller ikke fra Hørkram)',
    body: formatTable(productsNoCo2e.map(p => ({ id: p.id, name: p.name, group: p.group_name }))) });

const productsNoAllergens = productsInUse.filter(p => !p.hk_allergens);
sections.push({ title: '5.4 Råvarer brugt i opskrifter — uden allergen-data',
    body: formatTable(productsNoAllergens.slice(0, 100).map(p => ({ id: p.id, name: p.name, group: p.group_name }))) +
        (productsNoAllergens.length > 100 ? `\n\n_... og ${productsNoAllergens.length - 100} mere_` : '') });

// 5.5 Sammenfatning: hvor mange % er dækket?
const total = productsInUse.length;
const withCo2e = productsInUse.filter(p => (p.co2e && parseFloat(p.co2e) > 0) || (p.hk_co2e && parseFloat(p.hk_co2e) > 0)).length;
const withAllergens = productsInUse.filter(p => p.hk_allergens).length;
sections.push({ title: '5.5 Coverage-sammenfatning',
    body: `- Råvarer i opskrifter: **${total}**\n` +
          `- Med Co2e (recipe eller hk): **${withCo2e}** (${Math.round(withCo2e/total*100)}%)\n` +
          `- Med allergen-data:        **${withAllergens}** (${Math.round(withAllergens/total*100)}%)\n` +
          `- SALG-opskrifter uden Co2e: **${salgNoCo2e.length}** af ${sellable.filter(s => s.klasse === 'SALG').length}\n` +
          `- SALG-opskrifter uden Oeko: **${salgNoOeko.length}** af ${sellable.filter(s => s.klasse === 'SALG').length}` });

writeReport('05_co2_allergener', sections);
db.close();

console.log('Fase 5 fund:');
console.log(`  SALG uden Co2e:               ${salgNoCo2e.length}/${sellable.filter(s => s.klasse === 'SALG').length}`);
console.log(`  SALG uden Oeko:               ${salgNoOeko.length}`);
console.log(`  Råvarer uden Co2e:            ${productsNoCo2e.length}/${total}`);
console.log(`  Råvarer uden allergen-data:   ${productsNoAllergens.length}/${total}`);
