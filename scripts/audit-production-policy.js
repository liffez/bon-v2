// scripts/audit-production-policy.js
// ============================================================
// Read-only: hvad er produktionspolitikken i den LEVENDE Grocy? (#329)
//
// Svarer på tre spørgsmål man ellers kun kan gætte om:
//
//   1. Hvilke varer LAVES af en opskrift, og er de `on_demand` (Hurtig, Bon
//      laver dem ved LEVERET) eller `to_stock` (personalet, efter plan)?
//   2. Er nogen af dem stadig NESTET ind i en menu? Det er den halv-konverterede
//      tilstand under #270's udrulning, hvor produktet findes før menuerne er
//      rewired — og hvor to_stock-vagten går fra inert til aktiv.
//   3. Mangler nogen af dem et erklæret udbytte? Uden det kan vagten ikke
//      udtrykke behovet i varens enhed og falder tilbage til råvarerne (#372).
//
// Skriver intet. Kør fra projektroden:
//   node --env-file=.env scripts/audit-production-policy.js
// ============================================================

'use strict';

const grocy = require('../services/grocyAdapter');
const {
    buildProducerIndex, buildProductionPolicy, productionTypeOf, yieldPerBatchStockOf,
} = require('../services/ingredientResolver');

const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', b: '\x1b[1m', off: '\x1b[0m' };

(async () => {
    const cfg = grocy.getGrocyConfig();
    console.log(`\n${C.b}Produktionspolitik — ${cfg.locationName}${C.off}\n`);

    const [rawRecipeMap, nestings, products, units, quConversions] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
    ]);
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap    = new Map(units.map(u => [Number(u.id), u]));
    const policy     = buildProductionPolicy(rawRecipeMap);
    const producers  = buildProducerIndex(rawRecipeMap);

    // recipe_id → de opskrifter der nester den
    const nestedIn = new Map();
    for (const n of nestings) {
        const c = Number(n.includes_recipe_id);
        if (!nestedIn.has(c)) nestedIn.set(c, []);
        nestedIn.get(c).push(Number(n.recipe_id));
    }

    const rows = [];
    for (const [pid, list] of producers) {
        const type = policy.get(pid);
        if (!type) continue;
        const product = productMap.get(pid);
        for (const r of list) {
            const parents = nestedIn.get(Number(r.id)) || [];
            const perBatch = product ? yieldPerBatchStockOf(r, product, unitMap, quConversions) : null;
            rows.push({
                pid, product: product?.name || `Produkt #${pid}`,
                recipe: r.name, recipeId: Number(r.id),
                type: productionTypeOf(r),
                nested: parents.map(p => rawRecipeMap.get(p)?.name || `#${p}`),
                yieldOk: perBatch != null && perBatch > 0,
            });
        }
    }
    rows.sort((a, b) => a.type.localeCompare(b.type) || a.product.localeCompare(b.product, 'da'));

    for (const t of ['to_stock', 'on_demand']) {
        const sub = rows.filter(r => r.type === t);
        const hvem = t === 'to_stock' ? 'personalet laver dem efter plan'
                                      : 'Bon laver dem ved LEVERET';
        console.log(`${C.b}${t}${C.off} ${C.dim}— ${hvem} · ${sub.length} opskrift(er)${C.off}`);
        for (const r of sub) {
            const flags = [];
            if (r.nested.length) flags.push(`${C.yel}NESTET i ${r.nested.join(', ')}${C.off}`);
            if (!r.yieldOk)      flags.push(`${C.red}udbytte mangler${C.off}`);
            console.log(`  ${String(r.recipeId).padStart(4)} ${r.recipe.padEnd(30)} → ${r.product}`
                      + (flags.length ? '  ' + flags.join(' · ') : ''));
        }
        console.log();
    }

    // ── Konklusionen, som en linje man kan handle på ────────────────────────
    const nestedToStock = rows.filter(r => r.type === 'to_stock' && r.nested.length);
    const utenYield     = rows.filter(r => r.nested.length && !r.yieldOk);

    if (!nestedToStock.length) {
        console.log(`${C.grn}✓ Ingen planlagt vare er nestet — to_stock-vagten er inert.${C.off}`);
        console.log(`${C.dim}  Menuerne peger på produkterne, så råvarerne trækkes præcis én gang:`);
        console.log(`  i produktionen. Intet at gøre.${C.off}\n`);
    } else {
        console.log(`${C.yel}⚠ ${nestedToStock.length} planlagt vare(r) er stadig nestet i en menu.${C.off}`);
        console.log(`${C.dim}  Vagten trækker VAREN dér, ikke råvarerne — hvilket er det rigtige, men`);
        console.log(`  menuen bør rewires til en produktlinje (--kun-rewire, spec §5.1),`);
        console.log(`  så visning og træk fortæller den samme historie.${C.off}\n`);
    }
    if (utenYield.length) {
        console.log(`${C.red}⚠ ${utenYield.length} nestet opskrift(er) mangler et erklæret udbytte${C.off}`);
        console.log(`${C.dim}  (recipeunit / recipeunitnumber). Uden det falder trækket tilbage til`);
        console.log(`  råvarerne. Se #372.${C.off}\n`);
    }
})().catch(e => { console.error('\n' + C.red + e.message + C.off + '\n'); process.exit(1); });
