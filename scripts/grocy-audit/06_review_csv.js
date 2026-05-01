// FASE 6 — Generér review-CSV'er
//
// Output: ~/grocy-audit-2026-05-02/review/*.csv
//
// Hver fil indeholder fund + relevant Bon v2-kontekst (antal bons der bruger
// opskriften, sidste gang brugt, gennemsnits-salgspris) så du kan beslutte
// hurtigt om hver række skal: keep, fix, delete, archive.
//
// Workflow:
//   1) Kør dette script
//   2) Åbn CSV-filerne i Numbers/Excel
//   3) Udfyld 'decision' og 'note' for hver række
//   4) Når klar: kør apply.js (som vi bygger bagefter)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('./lib/db');
const { writeCsv } = require('./lib/csv');

const REVIEW_DIR = path.join(os.homedir(), 'grocy-audit-2026-05-02', 'review');
fs.mkdirSync(REVIEW_DIR, { recursive: true });

const KEY_FILE = path.join(os.homedir(), 'grocy-audit-2026-05-02', '.api-key');
const API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();

async function fetchFulfillment(recipeId) {
    try {
        const res = await fetch(`http://localhost:9283/api/recipes/${recipeId}/fulfillment`, {
            headers: { 'GROCY-API-KEY': API_KEY }
        });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

// Bon v2 DB — bruger production
const V2_DB_PATH = path.join(__dirname, '..', '..', 'data', 'bon.db');
let v2 = null;
try {
    v2 = new DatabaseSync(V2_DB_PATH, { readOnly: true });
    console.log(`✓ Bon v2 DB åbnet: ${V2_DB_PATH}`);
} catch (e) {
    console.log(`⚠ Bon v2 DB ikke tilgængelig (${e.message}) — usage-kontekst springes over`);
}

function getV2Usage(recipeId) {
    if (!v2) return { v2_bons: '?', v2_last_used: '?', v2_avg_price: '?' };
    try {
        const r = v2.prepare(`
            SELECT COUNT(*) AS n,
                   MAX(b.delivery_date) AS last_used,
                   ROUND(AVG(bl.unit_price), 2) AS avg_price
            FROM bon_lines bl
            JOIN bons b ON b.id = bl.bon_id
            WHERE bl.grocy_recipe_id = ?
              AND bl.unit_price > 0
        `).get(recipeId);
        return {
            v2_bons: r.n || 0,
            v2_last_used: r.last_used || '',
            v2_avg_price: r.avg_price || ''
        };
    } catch {
        return { v2_bons: '?', v2_last_used: '?', v2_avg_price: '?' };
    }
}

const db = openDb();

const REVIEW_COLUMNS_BASE = ['decision', 'note'];
const FILES = [];

async function main() {
    // ─────────────────────────────────────────────────────────────
    // 1. Forældreløse opskrifter (16) — ikke sellable, ikke sub-recipe
    // ─────────────────────────────────────────────────────────────
    console.log('\n[1/7] Forældreløse opskrifter...');
    const orphanRecipes = db.prepare(`
        SELECT r.id, r.name, r.type, r.base_servings, r.row_created_timestamp,
               (SELECT COUNT(*) FROM recipes_pos WHERE recipe_id = r.id) AS pos_count,
               (SELECT COUNT(*) FROM recipes_nestings WHERE recipe_id = r.id) AS nest_count,
               (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
                WHERE uf.entity='recipes' AND uf.name='grupper' AND uv.object_id=CAST(r.id AS TEXT)) AS gruppe
        FROM recipes r
        WHERE NOT EXISTS (
            SELECT 1 FROM userfield_values uv
            JOIN userfields uf ON uf.id = uv.field_id
            WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1' AND uv.object_id = CAST(r.id AS TEXT)
        )
        AND r.id NOT IN (SELECT includes_recipe_id FROM recipes_nestings)
        ORDER BY r.row_created_timestamp DESC, r.name
    `).all().map(r => ({ ...r, ...getV2Usage(r.id), decision: '', note: '' }));

    const f1 = path.join(REVIEW_DIR, '01_orphan_recipes.csv');
    writeCsv(f1, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'gruppe', 'pos_count', 'nest_count',
        'row_created_timestamp', 'v2_bons', 'v2_last_used', 'v2_avg_price', 'type', 'base_servings'],
        orphanRecipes);
    FILES.push({ file: '01_orphan_recipes.csv', rows: orphanRecipes.length, default_action: 'delete (de fleste — kontroller v2_last_used)' });

    // ─────────────────────────────────────────────────────────────
    // 2. SALG uden Catering-pris (5)
    // ─────────────────────────────────────────────────────────────
    console.log('[2/7] SALG uden Catering-pris...');
    const allSellable = db.prepare(`
        SELECT r.id, r.name,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='grupper' AND uv.object_id=CAST(r.id AS TEXT)) AS gruppe,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='SalespriceCatering' AND uv.object_id=CAST(r.id AS TEXT)) AS catering,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='SalespriceStore' AND uv.object_id=CAST(r.id AS TEXT)) AS store
        FROM recipes r
        WHERE r.id IN (
            SELECT object_id FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
            WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1'
        )
    `).all();
    const SALG_GROUPS = ['Frugt', '01 Sandwich', '02 Salat', '03 Kager', '04 Slider', '05 Drikke'];
    const noPrice = allSellable
        .filter(r => SALG_GROUPS.includes(r.gruppe) && (!r.catering || parseFloat(r.catering) <= 0))
        .map(r => ({ ...r, ...getV2Usage(r.id), decision: '', note: '' }));

    const f2 = path.join(REVIEW_DIR, '02_salg_no_price.csv');
    writeCsv(f2, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'gruppe', 'catering', 'store',
        'v2_bons', 'v2_last_used', 'v2_avg_price'], noPrice);
    FILES.push({ file: '02_salg_no_price.csv', rows: noPrice.length,
        default_action: 'fix (udfyld pris) eller archive (sellable=0 hvis ikke skal sælges)' });

    // ─────────────────────────────────────────────────────────────
    // 3. Cost > Sales (alle sellable opskrifter, ikke kun SALG-klassen)
    // ─────────────────────────────────────────────────────────────
    console.log('[3/7] Cost > Sales (Grocy API)...');
    const inverted = [];
    for (const r of allSellable) {
        if (!r.catering || parseFloat(r.catering) <= 0) continue;
        const f = await fetchFulfillment(r.id);
        if (!f) continue;
        const cost = f.costs_per_serving || 0;
        const salesEx = parseFloat(r.catering) / 1.25;
        if (cost > salesEx) {
            inverted.push({
                id: r.id, name: r.name, gruppe: r.gruppe,
                catering: r.catering,
                sales_ex_moms: Math.round(salesEx * 100) / 100,
                grocy_cost: Math.round(cost * 100) / 100,
                ratio: Math.round((cost / salesEx) * 100) / 100,
                ...getV2Usage(r.id),
                decision: '', note: ''
            });
        }
    }
    inverted.sort((a, b) => b.ratio - a.ratio);
    const f3 = path.join(REVIEW_DIR, '03_cost_gt_sales.csv');
    writeCsv(f3, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'gruppe', 'catering', 'sales_ex_moms',
        'grocy_cost', 'ratio', 'v2_bons', 'v2_last_used', 'v2_avg_price'], inverted);
    FILES.push({ file: '03_cost_gt_sales.csv', rows: inverted.length,
        default_action: 'fix (juster salgspris) eller fix (juster opskrift hvis cost er forkert)' });

    // ─────────────────────────────────────────────────────────────
    // 4. Catering ≠ Store
    // ─────────────────────────────────────────────────────────────
    console.log('[4/7] Catering ≠ Store...');
    const cateringStoreDiff = allSellable
        .filter(r => parseFloat(r.catering) > 0 && parseFloat(r.store) > 0
            && parseFloat(r.catering) !== parseFloat(r.store))
        .map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe,
            catering: parseFloat(r.catering),
            store: parseFloat(r.store),
            diff: Math.round((parseFloat(r.catering) - parseFloat(r.store)) * 100) / 100,
            ...getV2Usage(r.id),
            decision: '', note: ''
        }));
    const f4 = path.join(REVIEW_DIR, '04_catering_ne_store.csv');
    writeCsv(f4, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'gruppe', 'catering', 'store', 'diff',
        'v2_bons', 'v2_last_used', 'v2_avg_price'], cateringStoreDiff);
    FILES.push({ file: '04_catering_ne_store.csv', rows: cateringStoreDiff.length,
        default_action: 'keep (hvis bevidst) eller fix (sæt ens)' });

    // ─────────────────────────────────────────────────────────────
    // 5. Øre-priser (ikke hele kroner)
    // ─────────────────────────────────────────────────────────────
    console.log('[5/7] Øre-priser...');
    const decimalPrices = allSellable
        .filter(r => {
            const c = parseFloat(r.catering);
            return c > 0 && c !== Math.round(c);
        })
        .map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe,
            catering: parseFloat(r.catering),
            store: parseFloat(r.store) || 0,
            ...getV2Usage(r.id),
            decision: '', note: ''
        }));
    const f5 = path.join(REVIEW_DIR, '05_price_format.csv');
    writeCsv(f5, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'gruppe', 'catering', 'store',
        'v2_bons', 'v2_last_used', 'v2_avg_price'], decimalPrices);
    FILES.push({ file: '05_price_format.csv', rows: decimalPrices.length,
        default_action: 'fix (rund op) eller keep (hvis bevidst, fx Servicepersonale time-takst)' });

    // ─────────────────────────────────────────────────────────────
    // 6. Enheds-mistænkelige produkter
    // ─────────────────────────────────────────────────────────────
    console.log('[6/7] Enheds-mistænkelige produkter...');
    const quNames = Object.fromEntries(
        db.prepare(`SELECT id, name FROM quantity_units`).all().map(r => [r.id, r.name])
    );
    // Drikke + andre med stock=Antal og purchase=Kilo (mismatch)
    const unitAnomalies = db.prepare(`
        SELECT p.id, p.name, p.qu_id_stock, p.qu_id_purchase, p.qu_id_price,
               pg.name AS group_name,
               (SELECT COUNT(*) FROM recipes_pos WHERE product_id = p.id) AS used_in_recipes
        FROM products p
        LEFT JOIN product_groups pg ON pg.id = p.product_group_id
        WHERE p.active = 1 AND (
            (p.qu_id_stock = 8 AND p.qu_id_purchase = 4)  -- stock=Antal, purchase=Kilo
            OR (p.qu_id_stock = 6 AND p.qu_id_price != p.qu_id_stock AND p.qu_id_price != p.qu_id_purchase)  -- Liter med mismatch
            OR p.qu_id_stock = 15  -- stock=Pakke (ikke standard)
        )
        ORDER BY pg.name, p.name
    `).all().map(p => ({
        id: p.id, name: p.name, group: p.group_name,
        stock: quNames[p.qu_id_stock],
        purchase: quNames[p.qu_id_purchase],
        price: quNames[p.qu_id_price],
        used_in_recipes: p.used_in_recipes,
        decision: '', note: ''
    }));
    const f6 = path.join(REVIEW_DIR, '06_unit_anomalies.csv');
    writeCsv(f6, [...REVIEW_COLUMNS_BASE, 'id', 'name', 'group', 'stock', 'purchase', 'price',
        'used_in_recipes'], unitAnomalies);
    FILES.push({ file: '06_unit_anomalies.csv', rows: unitAnomalies.length,
        default_action: 'keep (hvis bevidst, fx drikke) eller fix (juster i Grocy UI)' });

    // ─────────────────────────────────────────────────────────────
    // 7. Brækkede recipes_nestings (auto-DELETE forslag)
    // ─────────────────────────────────────────────────────────────
    console.log('[7/7] Brækkede recipes_nestings...');
    const brokenNestings = db.prepare(`
        SELECT rn.id, rn.recipe_id, r1.name AS parent, rn.includes_recipe_id, r2.name AS sub,
               rn.servings, rn.row_created_timestamp
        FROM recipes_nestings rn
        LEFT JOIN recipes r1 ON r1.id = rn.recipe_id
        LEFT JOIN recipes r2 ON r2.id = rn.includes_recipe_id
        WHERE r1.id IS NULL OR r2.id IS NULL
        ORDER BY rn.id
    `).all().map(r => ({
        nesting_id: r.id,
        recipe_id_parent: r.recipe_id,
        parent_name: r.parent || '(SLETTET)',
        includes_recipe_id: r.includes_recipe_id,
        sub_name: r.sub || '(SLETTET)',
        servings: r.servings,
        row_created_timestamp: r.row_created_timestamp,
        decision: 'delete',  // Default: alle skal slettes (orphan-rækker)
        note: 'auto-foreslået: orphan FK'
    }));
    const f7 = path.join(REVIEW_DIR, '07_broken_nestings.csv');
    writeCsv(f7, [...REVIEW_COLUMNS_BASE, 'nesting_id', 'recipe_id_parent', 'parent_name',
        'includes_recipe_id', 'sub_name', 'servings', 'row_created_timestamp'], brokenNestings);
    FILES.push({ file: '07_broken_nestings.csv', rows: brokenNestings.length,
        default_action: 'delete (default — orphan rækker, ingen risiko)' });

    db.close();
    if (v2) v2.close();

    // ─────────────────────────────────────────────────────────────
    // Generér review/README.md
    // ─────────────────────────────────────────────────────────────
    const readme = `# Grocy Review — udfyld decision-kolonnen

> Genereret ${new Date().toISOString().slice(0, 10)} af \`scripts/grocy-audit/06_review_csv.js\`

## Sådan bruger du filerne

1. Åbn hver CSV i Numbers/Excel
2. Udfyld kolonnen \`decision\` for hver række — én af:

| decision | Betydning |
|---|---|
| (tom) | Ikke besluttet endnu — springes over ved apply |
| \`keep\` | Bevares — markeres som reviewed, ingen ændring |
| \`fix\` | Skal rettes manuelt i Grocy UI — apply genererer todo-liste |
| \`delete\` | Sikker at slette — apply inkluderer i SQL DELETE |
| \`archive\` | Bevares men deaktiveres (sellable=0 / active=0) — apply opdaterer |

3. Skriv en kort \`note\` der forklarer hvorfor (især for \`keep\` og \`fix\`)
4. Gem CSV'en
5. Når du er klar (kan tage flere sessioner), kør \`apply.js\` mod arbejdskopien

## Bon v2-kontekst pr. række

- \`v2_bons\`: antal bons der har brugt opskriften (alle tider)
- \`v2_last_used\`: sidste delivery_date for opskriften
- \`v2_avg_price\`: gennemsnits-unit_price på alle bon_lines

> Hvis \`v2_bons = 0\` → opskriften er aldrig solgt → sandsynligvis sikker at slette/archive
> Hvis \`v2_last_used\` er > 3 år gammel → meget gammel data, måske bevar bare som arkiv

## Filer

${FILES.map(f => `- **${f.file}** — ${f.rows} rækker — *${f.default_action}*`).join('\n')}

## Næste skridt

Når CSV'erne er udfyldt:

\`\`\`bash
node scripts/grocy-audit/apply.js --dry-run    # Preview
node scripts/grocy-audit/apply.js --apply       # Eksekvér mod arbejdskopi
\`\`\`

\`apply.js\` rører ALDRIG den frosne backup. Den kører kun mod \`grocy.db\` (arbejdskopi).
Manuelle \`fix\`-rækker bliver listet i en separat to-do-fil til Grocy UI.
`;

    fs.writeFileSync(path.join(REVIEW_DIR, 'README.md'), readme);

    console.log('');
    console.log('═'.repeat(78));
    console.log(`Review-CSV'er klar i: ${REVIEW_DIR}`);
    console.log('═'.repeat(78));
    for (const f of FILES) {
        console.log(`  ${f.file.padEnd(28)} ${String(f.rows).padStart(4)} rækker   →  ${f.default_action}`);
    }
    console.log('');
    console.log(`Læs ${path.join(REVIEW_DIR, 'README.md')} for instruktioner.`);
}

main().catch(e => { console.error(e); process.exit(1); });
