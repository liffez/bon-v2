// scripts/audit-production-policy.js
// ============================================================
// Read-only: hvad er produktionspolitikken i den LEVENDE Grocy? (#329)
//
// Svarer på fire spørgsmål man ellers kun kan gætte om:
//
//   1. Hvilke varer LAVES af en opskrift, og er de `on_demand` (Hurtig, Bon
//      laver dem ved LEVERET) eller `to_stock` (personalet, efter plan)?
//   2. Er nogen af dem stadig NESTET ind i en menu? Det er den halv-konverterede
//      tilstand under #270's udrulning, hvor produktet findes før menuerne er
//      rewired — og hvor to_stock-vagten går fra inert til aktiv.
//   3. Mangler nogen af dem et erklæret udbytte? Uden det kan vagten ikke
//      udtrykke behovet i varens enhed og falder tilbage til råvarerne (#372).
//   4. Hvilke blandinger er nestet ind i en menu UDEN at producere en vare?
//      Det er #270's resterende arbejde. De tre første spørgsmål handler kun
//      om varer der FINDES — uden dette kunne rapporten ikke skelne "alt er
//      konverteret" fra "jeg kigger kun på halvdelen".
//
// Skriver intet. Kør fra projektroden:
//   node --env-file=.env scripts/audit-production-policy.js
// ============================================================

'use strict';

const grocy = require('../services/grocyAdapter');
const {
    buildProducerIndex, buildProductionPolicy, productionTypeOf, yieldPerBatchStockOf,
    recipeGroupOf,
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

    // ── 4. Nestet, men producerer ingen vare ────────────────────────────────
    //
    // De tre lister ovenfor kan pr. konstruktion kun vise varer der FINDES:
    // `productionTypeOf` giver null uden et `Produces product`, så en blanding
    // der endnu ikke er konverteret er usynlig dér. Uden denne liste kunne
    // rapporten ikke skelne "alt er konverteret" fra "jeg kigger kun på de
    // konverterede" — og det er netop dét der gør resten troværdigt.
    //
    // Vi filtrerer IKKE på Grocy-gruppen, men VISER den. Hvilke af dem der bør
    // blive en vare (spec §5.1) er en beslutning om stamdata, ikke noget en
    // rapport skal træffe på dine vegne: en slider-boks der nester sin ret er
    // en anden ting end en dressing, og gruppen fortæller hvilken.
    const uconverted = [];
    for (const [childId, parents] of nestedIn) {
        const r = rawRecipeMap.get(childId);
        if (!r || Number(r.product_id)) continue;      // har en vare → står ovenfor
        uconverted.push({
            id: childId,
            name: r.name || `#${childId}`,
            // Nøglen normaliseres med den DELTE helper, så "RR Produktion" og
            // "rr produktion " ikke bliver to blokke; etiketten er den rå tekst,
            // for det er dén der står i Grocy.
            key: recipeGroupOf(r) || '\u00ff',          // uden gruppe → sidst ved uafgjort
            group: (r.userfields?.grupper || '').trim() || '(ingen gruppe)',
            uses: parents.length,
        });
    }
    // Grupperne først (tungeste øverst), derefter flest menuer inden for gruppen:
    // dét er rækkefølgen arbejdet betaler sig i. Sorteres der KUN på antal
    // menuer, brydes en gruppe op i flere blokke og overskriften gentages.
    const groupWeight = new Map();
    for (const u of uconverted) groupWeight.set(u.key, (groupWeight.get(u.key) || 0) + u.uses);
    uconverted.sort((a, b) =>
        (groupWeight.get(b.key) - groupWeight.get(a.key))
        || a.key.localeCompare(b.key, 'da')
        || (b.uses - a.uses)
        || a.name.localeCompare(b.name, 'da'));

    console.log(`${C.b}nestet uden vare${C.off} ${C.dim}— råvarerne trækkes gennem menuen `
              + `· ${uconverted.length} opskrift(er)${C.off}`);
    if (!uconverted.length) {
        console.log(`  ${C.dim}(ingen)${C.off}`);
    } else {
        let lastKey = null;
        for (const u of uconverted) {
            if (u.key !== lastKey) {
                console.log(`  ${C.dim}${u.group}${C.off}`);
                lastKey = u.key;
            }
            const n = `${u.uses} menu${u.uses === 1 ? '' : 'er'}`;
            console.log(`    ${String(u.id).padStart(4)} ${u.name.padEnd(30)} ${C.dim}brugt i ${n}${C.off}`);
        }
    }
    console.log();

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

    const nestedOnDemand = rows.filter(r => r.type === 'on_demand' && r.nested.length);
    if (nestedOnDemand.length) {
        console.log(`${C.dim}· ${nestedOnDemand.length} Hurtig-vare(r) har et produkt, men menuen nester `
                  + `dem stadig.\n  Dér trækkes råvarerne som hidtil (bevidst, #329) — auto-batchen laver\n`
                  + `  varen ved LEVERET. Rewire når I når dertil.${C.off}\n`);
    }
    if (uconverted.length) {
        console.log(`${C.dim}· ${uconverted.length} nestet opskrift(er) producerer ingen vare endnu og er`);
        console.log(`  derfor ikke med i listerne ovenfor. Se "nestet uden vare" for hvilke,`);
        console.log(`  og spec §5.1 for hvilke der skal konverteres.${C.off}\n`);
    }
})().catch(e => { console.error('\n' + C.red + e.message + C.off + '\n'); process.exit(1); });
