/**
 * services/ingredientResolver.js
 * ════════════════════════════════════════════════════════════
 * Aggregerer ingrediensbehov for bon-linjer med fuld
 * opløsning af underopskrifter (recipes_nestings).
 *
 * Returnerer TO niveauer:
 *   production: Direkte ingredienser + underopskrifter som kompakte rækker
 *   raw:        Alt fladt — underopskrifters ingredienser opløst rekursivt
 *
 * Bruges af:
 *   routes/bons.js       GET /:id/ingredients
 *   routes/kitchen.js    GET /planning/ingredients
 *
 * Logik fra bontools/tools/grocy/recipe-viewer.html's
 * collectSubRecipeIngredients() — tilpasset server-side.
 * ════════════════════════════════════════════════════════════
 */

const grocy = require('./grocyAdapter');
const { findConversionFactor, convertAndFormat } = require('./quConvert');
const { num: grocyNum } = require('../shared/grocy_num');

/**
 * Aggregér ingrediensbehov for en liste bon-linjer.
 * Returnerer begge niveauer i ét kald.
 *
 * @param {Array} recipeLines  Bon-linjer med grocy_recipe_id + quantity
 * @returns {Object} { production: { ingredients, groups }, raw: { ingredients, groups } }
 */
async function resolveIngredients(recipeLines) {
    const empty = { ingredients: [], groups: [] };
    if (!recipeLines.length) {
        return { production: empty, raw: empty };
    }

    // ── Hent ALT parallelt ──
    const [
        recipes,
        allRecipesPos,
        nestings,
        rawRecipeMap,
        stockArr,
        products,
        quantityUnits,
        quConversions,
    ] = await Promise.all([
        grocy.getRecipes(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getRecipesRawMap(),
        grocy.getStock(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]);

    // ── Lookup-maps ──
    const recipeMap = new Map(recipes.map(r => [r.id, r]));
    // Effektivt lager PR PRODUKT inkl. parent/child-substitution: et parent-produkt
    // ("kål") har typisk eget lager = 0, men børnene (Spidskål, Hvidkål) har lageret.
    // Grocy's consume + tør-kørsel (planConsume) ruller børnenes lager op på parenten
    // via makeEffectiveStock — visningen skal bruge SAMME kilde, ellers står et
    // parent-produkt fejlagtigt som rødt "0" selvom børnene har rigeligt (#327).
    const effectiveStock = grocy.makeEffectiveStock(stockArr, products);
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(quantityUnits.map(u => [u.id, u]));

    // Gruppér recipes_pos per recipe_id
    const posByRecipe = {};
    allRecipesPos.forEach(p => {
        const rid = p.recipe_id;
        if (!posByRecipe[rid]) posByRecipe[rid] = [];
        posByRecipe[rid].push(p);
    });

    // Gruppér nestings per parent recipe_id
    const nestingsByRecipe = {};
    nestings.forEach(n => {
        const rid = n.recipe_id;
        if (!nestingsByRecipe[rid]) nestingsByRecipe[rid] = [];
        nestingsByRecipe[rid].push(n);
    });

    // ══════════════════════════════════════════════════════════
    // NIVEAU 1: PRODUKTION
    // Direkte ingredienser + underopskrifter som kompakte rækker
    // ══════════════════════════════════════════════════════════
    const prodAgg = new Map();      // product_id → aggregated ingredient
    const subRecipeAgg = new Map(); // sub_recipe_id → { name, needed_stock, unit, ... }

    function addProdIngredient(pid, scaledStock, ing) {
        if (prodAgg.has(pid)) {
            prodAgg.get(pid).needed_stock += scaledStock;
        } else {
            const product = productMap.get(pid) || {};
            prodAgg.set(pid, {
                product_id:       pid,
                product_name:     product.name || `Produkt #${pid}`,
                needed_stock:     scaledStock,
                qu_id_stock:      product.qu_id_stock,
                qu_id_purchase:   product.qu_id_purchase,
                qu_id_display:    ing.qu_id,
                ingredient_group: ing.ingredient_group || '',
            });
        }
    }

    /**
     * Beregn totalvægt i gram for en underopskrift (til produktion-visning).
     * Summerer alle ingredienser (ekskl. emballage) konverteret til gram.
     */
    function calcSubRecipeWeightGrams(subRecipeId, scaledServings, stack = new Set()) {
        const subRaw = rawRecipeMap.get(subRecipeId);
        if (!subRaw) return 0;
        // Uden dette værn giver en cyklus i recipes_nestings stack overflow og
        // vælter hele /api/bons/:id/ingredients. Cykler er ikke teoretiske —
        // scripts/grocy-audit/02_struktur.js leder eksplicit efter dem.
        if (stack.has(subRecipeId)) return 0;
        stack.add(subRecipeId);
        const subBase = parseInt(subRaw.base_servings) || 1;
        const mult = scaledServings / subBase;
        const ings = posByRecipe[subRecipeId] || [];
        let totalG = 0;

        for (const ing of ings) {
            const group = (ing.ingredient_group || '').toLowerCase();
            if (group === 'emballage') continue;
            const product = productMap.get(ing.product_id) || {};
            const stockQuId = product.qu_id_stock || ing.qu_id;
            const baseAmount = parseFloat(ing.amount) || 0;
            const amount = baseAmount * mult;

            // Konvertér til gram via quConversions
            const gFactor = findConversionFactorToGrams(quConversions, ing.product_id, stockQuId, unitMap);
            if (gFactor !== null) {
                totalG += amount * gFactor;
            }
        }

        // Rekursér ind i underopskriftens egne nestings
        const subNestings = nestingsByRecipe[subRecipeId] || [];
        for (const sn of subNestings) {
            const snServings = (parseFloat(sn.servings) || 1) * mult;
            totalG += calcSubRecipeWeightGrams(sn.includes_recipe_id, snServings, stack);
        }

        stack.delete(subRecipeId);
        return totalG;
    }

    // ══════════════════════════════════════════════════════════
    // NIVEAU 2: RÅVARER
    // Alt fladt — underopskrifters ingredienser opløst rekursivt
    // ══════════════════════════════════════════════════════════
    const rawAgg = new Map();

    function addRawIngredient(pid, scaledStock, ing) {
        if (rawAgg.has(pid)) {
            rawAgg.get(pid).needed_stock += scaledStock;
        } else {
            const product = productMap.get(pid) || {};
            rawAgg.set(pid, {
                product_id:       pid,
                product_name:     product.name || `Produkt #${pid}`,
                needed_stock:     scaledStock,
                qu_id_stock:      product.qu_id_stock,
                qu_id_purchase:   product.qu_id_purchase,
                qu_id_display:    ing.qu_id,
                ingredient_group: ing.ingredient_group || '',
            });
        }
    }

    // `stack` er de opskrifter vi er MIDT i lige nu — ikke alle vi har set.
    // Forskellen betyder noget: nås den samme underopskrift ad to forskellige
    // grene (A→B→D og A→C→D), skal D's egne underopskrifter tælles begge gange.
    // Med et almindeligt "set" blev anden gren stille sprunget over, og alt under
    // D blev undertalt. Kun en ægte cyklus (en opskrift inde i sig selv) skal stoppes.
    function resolveSubRecipesRaw(recipeId, parentMultiplier, stack) {
        if (stack.has(recipeId)) return;
        stack.add(recipeId);

        const subNestings = nestingsByRecipe[recipeId] || [];
        for (const nesting of subNestings) {
            const subRecipeId = nesting.includes_recipe_id;
            const subRaw = rawRecipeMap.get(subRecipeId);
            if (!subRaw) continue;

            const subBaseServings = parseInt(subRaw.base_servings) || 1;
            const nestingServings = parseFloat(nesting.servings) || 1;
            const subMultiplier = (nestingServings * parentMultiplier) / subBaseServings;

            const subIngs = posByRecipe[subRecipeId] || [];
            for (const ing of subIngs) {
                const pid = ing.product_id;
                const baseAmount = parseFloat(ing.amount) || 0;
                const scaledStock = baseAmount * subMultiplier;
                if (scaledStock <= 0) continue;
                addRawIngredient(pid, scaledStock, ing);
            }

            // Rekursér med underopskriftens EGEN batch-multiplier. Argumentet er
            // altid "gang denne på recipes_pos.amount" — se kaldet nedenfor, hvor
            // top-niveauet sender scaleFactor. Tidligere blev der ganget med
            // subBaseServings her, hvilket ophævede divisionen ovenfor og pustede
            // råvarer i underopskrifter-i-underopskrifter op med base_servings.
            resolveSubRecipesRaw(subRecipeId, subMultiplier, stack);
        }

        stack.delete(recipeId);
    }

    // ── Behandl bon-linjer ──
    for (const line of recipeLines) {
        const recipe = recipeMap.get(line.grocy_recipe_id);
        const unitNumber = recipe ? recipe.unit_number : 1;
        const scaleFactor = line.quantity / unitNumber;

        // Direkte ingredienser → begge niveauer
        const ings = posByRecipe[line.grocy_recipe_id] || [];
        for (const ing of ings) {
            const pid = ing.product_id;
            const baseAmount = parseFloat(ing.amount) || 0;
            const scaledStock = baseAmount * scaleFactor;
            if (scaledStock <= 0) continue;
            addProdIngredient(pid, scaledStock, ing);
            addRawIngredient(pid, scaledStock, ing);
        }

        // PRODUKTION: underopskrifter som kompakte rækker
        const lineNestings = nestingsByRecipe[line.grocy_recipe_id] || [];
        for (const nesting of lineNestings) {
            const subRecipeId = nesting.includes_recipe_id;
            const subRaw = rawRecipeMap.get(subRecipeId);
            if (!subRaw) continue;

            const nestingServings = parseFloat(nesting.servings) || 1;
            const scaledServings = nestingServings * scaleFactor;

            // Beregn vægt i gram
            const weightG = calcSubRecipeWeightGrams(subRecipeId, scaledServings);

            // Forsøg at vise i enheden defineret i underopskriftens recipeunit
            const subRecipeSellable = recipeMap.get(subRecipeId);
            const subUnit = subRecipeSellable
                ? (subRecipeSellable.unit || 'stk')
                : (subRaw.userfields?.recipeunit || 'stk');

            // YIELD — hvad opskriften faktisk producerer.
            //
            // En produktionsopskrift vejer IKKE summen af sine input: syltelagen
            // hældes fra, kødet svinder. Køkkenet har standardiseret på at hver
            // opskrift yielder en fast mængde af den vare der bruges senere
            // (typisk 1 kg), og det tal ER erklæret i Grocy som
            // recipeunit + recipeunitnumber.
            //
            // Målt: "Balsamico + løg" = 1 kg løg + 0,06 L balsamico + 0,5 L vand.
            // Summen er 470 g pr. batch, men yieldet er 300 g — lagen tælles ikke
            // med. Omvendt rammer Frisk Grønt og Remoulade præcist, fordi intet
            // går tabt der. Yieldet er aldrig HØJERE end summen.
            //
            // input_weight_grams beholdes ved siden af: for antal-opskrifter
            // (sliders) er det den eneste kilde til "hvad vejer én af dem", som
            // opskrift-visningen har brug for.
            const yieldUnit = String(subRaw.userfields?.recipeunit || '').trim();
            const yieldNumRaw = subRaw.userfields?.recipeunitnumber;
            const yieldNum = parseFloat(yieldNumRaw);
            const hasYield = !!yieldUnit && Number.isFinite(yieldNum) && yieldNum > 0;

            const key = `sub_${subRecipeId}`;
            if (subRecipeAgg.has(key)) {
                const existing = subRecipeAgg.get(key);
                existing.weight_grams += weightG;
                existing.servings += scaledServings;
            } else {
                subRecipeAgg.set(key, {
                    recipe_id:    subRecipeId,
                    recipe_name:  subRaw.name,
                    weight_grams: weightG,
                    servings:     scaledServings,
                    unit:         subUnit,
                    base_servings: parseInt(subRaw.base_servings) || 1,
                    yield_unit:       hasYield ? yieldUnit : null,
                    yield_per_serving: hasYield ? yieldNum : null,
                });
            }
        }

        // RÅVARER: fuld rekursiv opløsning. Argumentet er batch-multiplieren —
        // altså det tal recipes_pos.amount ganges med — og for bon-linjens egen
        // opskrift er det simpelthen scaleFactor. (Stod tidligere som
        // `scaleFactor * baseServings / baseServings`, hvilket er det samme, men
        // fik det til at ligne at base_servings havde en rolle. Multiplier-
        // konventionen har allerede kostet én fejl her — #349.)
        resolveSubRecipesRaw(line.grocy_recipe_id, scaleFactor, new Set());
    }

    // ── Kan-laves-laget (#266 §4.1) ──
    // Bygges på præcis de samme opslag som resten af resolveren, så visningen
    // og lagertrækket ikke kan komme til at bygge på hver sin virkelighed.
    const producibility = makeProducibility({
        rawRecipeMap, posByRecipe, nestingsByRecipe, productMap, unitMap,
        quConversions, effectiveStock,
    });

    // ── Format & klassificér ──
    const production = formatLevel(prodAgg, effectiveStock, quConversions, unitMap, subRecipeAgg, producibility);
    const raw        = formatLevel(rawAgg, effectiveStock, quConversions, unitMap, null, producibility);

    // Rul råvare-status op på underopskrifterne, så Produktion-visningen ikke
    // kan vise en grøn "Æggesalat" mens Råvarer-visningen siger at æggene mangler.
    attachSubRecipeStatus(production.sub_recipes, raw.ingredients, posByRecipe, nestingsByRecipe);

    return { production, raw };
}


// ════════════════════════════════════════════════════════════
// "KAN VAREN LAVES?" — tilgængelighed fra råvarer  (#266, §4.1)
//
// Grocys fulfillment stopper ved et produkts lager: den ved ikke at produktet
// kan *laves*. Målt på grocy-hq 20.08.2026 stod 9 af 11 mellemprodukter på 0
// og blev brugt i 28 opskrifts-referencer — alle sammen vist som "mangler",
// selvom råvarerne til dem lå på hylden.
//
// Laget herunder svarer på ét spørgsmål: kan restbehovet af en vare laves af
// de råvarer der ER der? Det ÆNDRER ikke hvad der trækkes ved LEVERET
// (`resolveConsumeItems` er urørt) og skriver ingenting. Det annoterer.
//
// Bevidst additivt: `status` bliver stående som den fysiske sandhed, og
// `effective_status` er den nye. En forbruger der ikke kender feltet opfører
// sig præcis som før — hvilket er nødvendigt, fordi `shared/modal.js` falder
// tilbage til GRØN på en ukendt status, og en usynlig grøn er værre end en
// rød der råber for højt.
// ════════════════════════════════════════════════════════════

// `recipeunit` er fritekst ("kg", "antal"), mens Grocys enheder hedder
// "Kilo"/"Antal". Uden den her oversættelse kan intet yield bindes til en
// lager-enhed, og alt ville falde tilbage på skøn.
const UNIT_ALIASES = {
    kg: 'kilo', kilo: 'kilo', kilogram: 'kilo',
    g: 'gram', gram: 'gram',
    l: 'liter', liter: 'liter',
    ml: 'ml',
    stk: 'antal', 'stk.': 'antal', styk: 'antal', antal: 'antal', pcs: 'antal',
};

function normaliseUnitName(name) {
    const n = String(name || '').trim().toLowerCase();
    return UNIT_ALIASES[n] || n;
}

/** Grocy-enhedens id ud fra et fritekst-navn. null når navnet ikke er en enhed. */
function resolveUnitIdByName(unitMap, name) {
    const want = normaliseUnitName(name);
    if (!want) return null;
    for (const [id, u] of unitMap) {
        if (normaliseUnitName(u.name) === want) return id;
        if (u.name_plural && normaliseUnitName(u.name_plural) === want) return id;
        if (u.name_short && normaliseUnitName(u.name_short) === want) return id;
    }
    return null;
}

/** product_id → [producerende opskrifter]. Falaffel har fx tre. */
function buildProducerIndex(rawRecipeMap) {
    const idx = new Map();
    // Nøglen er sandheden om opskriftens id — `r.id` findes i Grocys svar, men
    // ikke nødvendigvis i en testfixtur, og et opslag der falder tilbage til
    // `undefined` ville give en anonym opskrift i visningen.
    for (const [recipeId, r] of rawRecipeMap) {
        const pid = Number(r.product_id);
        if (!pid) continue;
        const entry = { ...r, id: r.id ?? recipeId };
        if (!idx.has(pid)) idx.set(pid, []);
        idx.get(pid).push(entry);
    }
    // Deterministisk rækkefølge — ellers kan to kørsler navngive hver sin
    // opskrift på den samme vare (Falaffel har tre).
    //
    // Udfasede opskrifter lægges bagest. Køkkenet skal ikke få besked på at
    // lave "Original Falaffel- stegning" når den lever i gruppen
    // `xgamle opskrifter`. Det er en navnekonvention, ikke et flag — derfor
    // kun en SORTERING, aldrig en udelukkelse: værste udfald hvis konventionen
    // ændrer sig er et dårligere navn, ikke et forkert svar.
    const retired = (r) => /^x/i.test(String(r.userfields?.grupper || '').trim()) ? 1 : 0;
    for (const list of idx.values()) {
        list.sort((a, b) => (retired(a) - retired(b)) || (Number(a.id) - Number(b.id)));
    }
    return idx;
}

// ── Produktionstype: hvem laver varen, og hvad må trækket gøre (#329) ────────
//
// Grocy-gruppen ER grænsen mellem de to roller, og den skal kun aflæses ÉT
// sted. `services/autoBatch.js` havde sin egen kopi af navnet og sin egen
// `groupOf`; to steder der skal blive enige om det samme er præcis sådan #349
// og #353 opstod. Auto-batchen importerer derfor herfra.
const HURTIG_GROUP = 'rr produktion hurtig';

/** Grocy-gruppen på en opskrift, normaliseret til sammenligning. */
function recipeGroupOf(recipeRaw) {
    return String(recipeRaw?.userfields?.grupper || '').trim().toLowerCase();
}

/**
 * Produktionstypen for EN opskrift.
 *
 *   'on_demand' — `RR produktion Hurtig`: mayo, dressing. Bon laver den ved
 *                 LEVERET af råvarer der står på lager (#267).
 *   'to_stock'  — alt andet der producerer en vare: langtidsstegt gris,
 *                 syltede løg. Personalet laver den efter plan, i forvejen.
 *   null        — opskriften producerer ingen vare.
 */
function productionTypeOf(recipeRaw) {
    if (!recipeRaw || !Number(recipeRaw.product_id)) return null;
    return recipeGroupOf(recipeRaw) === HURTIG_GROUP ? 'on_demand' : 'to_stock';
}

/**
 * product_id → produktionstype, for hver vare der LAVES af en opskrift.
 *
 * Et produkt kan have flere producenter (Falaffel har tre). Er bare ÉN af dem
 * Hurtig, er varen `on_demand` — så er den noget Bon kan lave ved levering,
 * og det er dén mulighed der afgør hvad trækket må gøre. Samme valg som
 * `planAutoBatches` træffer når den filtrerer producenterne på gruppen.
 */
function buildProductionPolicy(rawRecipeMap) {
    const out = new Map();
    for (const producers of buildProducerIndex(rawRecipeMap).values()) {
        const types = producers.map(productionTypeOf).filter(Boolean);
        if (!types.length) continue;
        const pid = Number(producers[0].product_id);
        out.set(pid, types.includes('on_demand') ? 'on_demand' : 'to_stock');
    }
    return out;
}

// Rækkefølgen bruges to steder: til at vælge den bedste af flere producenter,
// og til at rulle den værste status op på en underopskrift.
// `ukendt` = varen KAN produceres, men opskriftens udbytte er ikke oplyst i
// Grocy, så vi kan ikke regne ud hvor mange batches der skal til. Den er bedre
// end en producent vi ved ikke rækker (`lav`), og dårligere end en vi kan
// verificere (`ok`).
/**
 * Fold producerede mellemprodukter tilbage til deres råvarer.
 *
 * Bruges af gaten i #269: når en blanding laves om til et produkt, ÆNDRER
 * `consume` sig med vilje — menuen trækker fremover produktet i stedet for
 * dets råvarer. Det der IKKE må ændre sig, er hvad der i sidste ende forlader
 * råvarelageret. Den her funktion regner netop dét tal, så de to sider af
 * konverteringen kan sammenlignes ærligt.
 *
 * Deler `makeProducibility`'s udbytte-fortolkning ved at kalde ind i den samme
 * checker-fabrik — en anden implementering ville drive fra appens med tiden,
 * og det er præcis sådan #349/#353 opstod.
 *
 * @param {Array} items  [{ product_id, amount_stock }] i lager-enheder
 * @returns {{ raw: Map<number, number>, unexpanded: Array }}
 *   `unexpanded` er de producerede varer hvis udbytte ikke kunne bestemmes.
 *   De bliver stående som sig selv — vi opfinder ikke et udbytte for at få
 *   regnskabet til at gå op.
 */
async function expandProducedToRaw(items) {
    const [rawRecipeMap, allPos, nestings, products, units, quConversions] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
    ]);
    const posByRecipe = {};
    allPos.forEach(p => { (posByRecipe[p.recipe_id] = posByRecipe[p.recipe_id] || []).push(p); });
    const nestingsByRecipe = {};
    nestings.forEach(n => { (nestingsByRecipe[n.recipe_id] = nestingsByRecipe[n.recipe_id] || []).push(n); });
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(units.map(u => [u.id, u]));

    const producers = buildProducerIndex(rawRecipeMap);
    const out = new Map();
    const unexpanded = [];

    function add(pid, amount) { out.set(pid, (out.get(pid) || 0) + amount); }

    function walk(pid, amount, stack) {
        const list = producers.get(Number(pid));
        const product = productMap.get(pid);
        if (!list || !list.length || !product || stack.has(Number(pid))) { add(pid, amount); return; }

        const recipe = list[0];
        const perBatch = yieldPerBatchStockOf(recipe, product, unitMap, quConversions);
        if (perBatch == null || perBatch <= 0) {
            unexpanded.push({ product_id: pid, product_name: product.name, amount, recipe_name: recipe.name });
            add(pid, amount);
            return;
        }

        // Brøkdele af et batch er det rigtige her: spørgsmålet er hvor mange
        // råvarer der ligger BAG mængden, ikke hvor mange hele batches nogen
        // skal røre. Rundede vi op, ville de to sider af konverteringen aldrig
        // kunne matche.
        const factor = amount / perBatch;
        stack.add(Number(pid));
        collectRecipeNeedsFlat(recipe.id, factor, posByRecipe, nestingsByRecipe, rawRecipeMap, (cpid, camt) => {
            walk(cpid, camt, stack);
        });
        stack.delete(Number(pid));
    }

    for (const it of items) {
        const amt = Number(it.amount_stock);
        if (!(amt > 0)) continue;
        walk(it.product_id, amt, new Set());
    }
    return { raw: out, unexpanded };
}

/** Udbytte for én opskrift i produktets lager-enhed. null = kan ikke bestemmes. */
function yieldPerBatchStockOf(recipeRaw, product, unitMap, quConversions) {
    const uf = recipeRaw.userfields || {};
    const perServing = grocyNum(uf.recipeunitnumber);
    if (!Number.isFinite(perServing) || perServing <= 0) return null;
    const base = parseFloat(recipeRaw.base_servings);
    const servings = Number.isFinite(base) && base > 0 ? base : 1;
    const total = perServing * servings;
    const yieldQuId = resolveUnitIdByName(unitMap, uf.recipeunit);
    if (yieldQuId == null) return null;
    if (Number(yieldQuId) === Number(product.qu_id_stock)) return total;
    const f = findConversionFactor(quConversions, product.id, yieldQuId, product.qu_id_stock);
    return f == null ? null : total * f;
}

/** Kald `emit(product_id, amount)` for hver råvare i en opskrift × multiplier. */
function collectRecipeNeedsFlat(recipeId, multiplier, posByRecipe, nestingsByRecipe, rawRecipeMap, emit, stack = new Set(), opts = {}) {
    for (const ing of (posByRecipe[recipeId] || [])) {
        // `skipEmballage`: en produktionsbatch af mayonnaise pakker ingenting —
        // emballagen hører til den menulinje der serverer den. Samme afgrænsning
        // som `makeProducibility` bruger, så "kan laves" og "blev lavet" er
        // enige om hvad der skal være på lager.
        if (opts.skipEmballage && (ing.ingredient_group || '').toLowerCase() === 'emballage') continue;
        const amt = (parseFloat(ing.amount) || 0) * multiplier;
        if (amt > 0) emit(ing.product_id, amt);
    }
    if (stack.has(recipeId)) return;
    stack.add(recipeId);
    for (const n of (nestingsByRecipe[recipeId] || [])) {
        const subRaw = rawRecipeMap.get(n.includes_recipe_id);
        if (!subRaw) continue;
        const subBase = parseInt(subRaw.base_servings) || 1;
        const m = ((parseFloat(n.servings) || 1) * multiplier) / subBase;
        collectRecipeNeedsFlat(n.includes_recipe_id, m, posByRecipe, nestingsByRecipe, rawRecipeMap, emit, stack, opts);
    }
    stack.delete(recipeId);
}

const MAKE_RANK = { ok: 0, kan_laves: 1, ukendt: 2, lav: 3, mangler: 4 };

/**
 * Byg en checker: (product_id, behov_i_lagerenhed) → kan det laves?
 *
 * Returnerer altid et objekt; `producible:false` betyder at ingen opskrift
 * producerer varen — så er der intet at svare på, og status står som den er.
 */
function makeProducibility(ctx) {
    const { rawRecipeMap, posByRecipe, nestingsByRecipe, productMap, unitMap,
            quConversions, effectiveStock } = ctx;
    const producerIndex = buildProducerIndex(rawRecipeMap);

    /**
     * Udbytte for ÉN opskrift som den er indtastet, udtrykt i produktets
     * lager-enhed. null = kan ikke bestemmes med sikkerhed.
     *
     * `recipes_pos.amount` hører til opskriften som indtastet, altså til
     * `base_servings` portioner — og `recipeunitnumber` er udbytte PR PORTION
     * (samme fortolkning som yield-modellen i formatLevel bruger). Derfor
     * ganges de to. Målt: Rødløg-Syltet har base_servings 2,8 og 1 kg/portion
     * = 2,8 kg pr. batch, hvilket præcis matcher summen af dens input.
     *
     * Gætter ALDRIG: kan enheden ikke bindes til lager-enheden, returneres
     * null, og kalderen falder tilbage på ét batch og siger at det er et skøn.
     */
    function yieldPerBatchStock(recipeRaw, product) {
        const uf = recipeRaw.userfields || {};
        const perServing = grocyNum(uf.recipeunitnumber);
        if (!Number.isFinite(perServing) || perServing <= 0) return null;

        const base = parseFloat(recipeRaw.base_servings);
        const servings = Number.isFinite(base) && base > 0 ? base : 1;
        const total = perServing * servings;

        const yieldQuId = resolveUnitIdByName(unitMap, uf.recipeunit);
        if (yieldQuId == null) return null;
        if (Number(yieldQuId) === Number(product.qu_id_stock)) return total;

        // Falaffel erklærer sit udbytte i "antal" (36 stk) mens produktet
        // lagerføres i kilo. Konverteringen findes på produktet (1 Kilo = 35
        // Antal) — den skal bruges, ikke ignoreres.
        const f = findConversionFactor(quConversions, product.id, yieldQuId, product.qu_id_stock);
        return f == null ? null : total * f;
    }

    /**
     * Saml det samlede råvarebehov for `multiplier` gange en opskrift —
     * inkl. dens egne underopskrifter.
     *
     * `stack` (ikke et `visited`-sæt) er bevidst: nås den samme underopskrift
     * ad to grene, skal begge tælle. Kun en ægte cyklus stoppes. Samme lære
     * som #354.
     */
    function collectRecipeNeeds(recipeId, multiplier, out, stack) {
        for (const ing of (posByRecipe[recipeId] || [])) {
            if ((ing.ingredient_group || '').toLowerCase() === 'emballage') continue;
            const amt = (parseFloat(ing.amount) || 0) * multiplier;
            if (amt <= 0) continue;
            const pid = ing.product_id;
            out.set(pid, (out.get(pid) || 0) + amt);
        }
        if (stack.has(recipeId)) return;
        stack.add(recipeId);
        for (const n of (nestingsByRecipe[recipeId] || [])) {
            const subRaw = rawRecipeMap.get(n.includes_recipe_id);
            if (!subRaw) continue;
            const subBase = parseInt(subRaw.base_servings) || 1;
            const m = ((parseFloat(n.servings) || 1) * multiplier) / subBase;
            collectRecipeNeeds(n.includes_recipe_id, m, out, stack);
        }
        stack.delete(recipeId);
    }

    const NOT_PRODUCIBLE = { producible: false };

    /**
     * @param {number} productId
     * @param {number} neededStock  behov i produktets lager-enhed
     * @param {Set}    seen         produkter vi er midt i at vurdere (cyklus-værn)
     */
    function check(productId, neededStock, seen = new Set()) {
        const producers = producerIndex.get(Number(productId));
        if (!producers || !producers.length) return NOT_PRODUCIBLE;
        if (seen.has(Number(productId))) return NOT_PRODUCIBLE;

        const product = productMap.get(productId);
        if (!product) return NOT_PRODUCIBLE;

        const stock = effectiveStock(productId);
        const shortfall = Math.max(0, neededStock - stock);
        if (shortfall <= 0) {
            // Der er dækning — men varen ER producerbar, og det skal en kalder
            // kunne se uden at skulle spørge igen.
            return { producible: true, make_status: null };
        }

        seen.add(Number(productId));
        let best = null;
        // Den bedste kandidat vi kan REGNE på. Vinder den ikke, bærer vi
        // alligevel dens mangelliste med: at én opskrift ikke har fået udfyldt
        // sit udbytte, må ikke skjule at en anden mangler en råvare. Køkkenet
        // skal have begge dele — "6 stk mangler, og pebberen er sluppet op" er
        // handlingsbart, "udbytte ikke oplyst" er kun en opgave til Grocy.
        let bestVerifiable = null;

        for (const recipeRaw of producers) {
            const perBatch = yieldPerBatchStock(recipeRaw, product);
            const estimated = perBatch == null;
            // Hele batches — køkkenet rører ikke en halv portion mayo.
            const batches = estimated
                ? 1
                : Math.max(1, Math.ceil(shortfall / perBatch));

            const needs = new Map();
            collectRecipeNeeds(recipeRaw.id, batches, needs, new Set());
            if (!needs.size) continue;   // en opskrift uden råvarer laver ingenting

            let worst = 'ok';
            const shortfalls = [];
            for (const [pid, amount] of needs) {
                const childStock = effectiveStock(pid);
                let st = childStock >= amount ? 'ok' : (childStock > 0 ? 'lav' : 'mangler');

                if (st !== 'ok') {
                    // Kan råvaren selv laves? Ingrid ærter udblødt → Falaffel
                    // er en ægte kæde i grocy-hq, så det er ikke teoretisk.
                    const sub = check(pid, amount, seen);
                    if (sub.producible && sub.make_status === 'ok') st = 'kan_laves';
                }

                if (MAKE_RANK[st] > MAKE_RANK[worst]) worst = st;
                if (st === 'lav' || st === 'mangler') {
                    const cp = productMap.get(pid) || {};
                    shortfalls.push({
                        product_id:   pid,
                        product_name: cp.name || `Produkt #${pid}`,
                        needed:       amount,
                        stock:        childStock,
                        status:       st,
                    });
                }
            }

            // Uden et erklæret udbytte kan behovet ikke omsættes til batches, og
            // så er "råvarerne rækker" en påstand vi ikke kan stå inde for.
            //
            // Målt i drift: `Falaffel- stegning-styk` har ingen
            // `recipeunitnumber`, og dens mængder er PR STK. Ét batch er altså
            // én falafel — men behovet var 20. Regnet som "1 batch rækker" ville
            // varen stå som "kan laves" på et grundlag der kun beviser at man
            // kan lave én. Det er præcis den slags stille optimisme der får en
            // liste til at holde op med at blive troet på.
            //
            // Derfor: producerbar, ja — "kan laves", nej. Hullet vises i stedet
            // som det det er, et manglende felt i Grocy (#372).
            const makeStatus = estimated
                ? 'ukendt'
                : (worst === 'kan_laves' ? 'ok' : worst);
            const candidate = {
                producible:   true,
                make_status:  makeStatus,
                make_recipe_id:    recipeRaw.id,
                make_recipe_name:  recipeRaw.name,
                // Gruppen afgør HVEM der laver varen: `RR produktion Hurtig`
                // laver Bon selv (#267), `RR Produktion` skal personalet lave
                // i forvejen — det er hele forskellen på de to roller.
                make_recipe_group: String(recipeRaw.userfields?.grupper || ''),
                make_batches:     batches,
                make_estimated:   estimated,
                make_shortfalls:  shortfalls.sort((a, b) =>
                    (MAKE_RANK[b.status] - MAKE_RANK[a.status]) ||
                    a.product_name.localeCompare(b.product_name, 'da')),
            };

            // Flere opskrifter kan lave samme vare (Falaffel har tre) — køkkenet
            // vælger selv, så den bedste vej vinder.
            if (candidate.make_status !== 'ukendt'
                && (!bestVerifiable || MAKE_RANK[candidate.make_status] < MAKE_RANK[bestVerifiable.make_status])) {
                bestVerifiable = candidate;
            }
            if (!best || MAKE_RANK[candidate.make_status] < MAKE_RANK[best.make_status]) {
                best = candidate;
                if (best.make_status === 'ok') break;
            }
        }

        seen.delete(Number(productId));

        // Vandt en uberegnelig opskrift, så erstat dens mangelliste med den
        // verificerbares. Den uberegnelige liste er regnet på ÉT batch og er
        // ikke til at stå inde for; den verificerbares er.
        if (best && best.make_status === 'ukendt' && bestVerifiable) {
            best.make_shortfalls       = bestVerifiable.make_shortfalls;
            best.make_blocked_recipe   = bestVerifiable.make_recipe_name;
            best.make_blocked_status   = bestVerifiable.make_status;
        } else if (best && best.make_status === 'ukendt') {
            // Ingen af opskrifterne kunne regnes — så har vi intet at sige om
            // råvarerne, og en liste ville være et gæt.
            best.make_shortfalls = [];
        }

        return best || { producible: true, make_status: 'mangler', make_shortfalls: [] };
    }

    return check;
}

const STATUS_RANK = { ok: 0, lav: 1, mangler: 2 };

/**
 * Saml alle produkt-id'er en underopskrift afhænger af, rekursivt gennem dens
 * egne underopskrifter. Emballage udelades — den optræder som egen gruppe i
 * visningen, og en manglende serviet siger intet om hvorvidt blandingen kan laves.
 */
function collectSubRecipeProductIds(recipeId, posByRecipe, nestingsByRecipe, visited = new Set(), out = new Set()) {
    if (visited.has(recipeId)) return out;
    visited.add(recipeId);

    for (const ing of (posByRecipe[recipeId] || [])) {
        if ((ing.ingredient_group || '').toLowerCase() === 'emballage') continue;
        out.add(ing.product_id);
    }
    for (const nesting of (nestingsByRecipe[recipeId] || [])) {
        collectSubRecipeProductIds(nesting.includes_recipe_id, posByRecipe, nestingsByRecipe, visited, out);
    }
    return out;
}

/**
 * Sæt status + mangelliste på hver underopskrift i produktion-visningen.
 *
 * Statussen læses fra RÅVARE-niveauet, altså det SAMLEDE behov på tværs af hele
 * bonnen — ikke underopskriftens isolerede behov. Det er med vilje: hvis to
 * opskrifter tilsammen bruger flere æg end der er på lager, kan æggesalaten
 * heller ikke laves. Det er også det eneste der garanterer at de to faner
 * aldrig modsiger hinanden.
 */
function attachSubRecipeStatus(subRecipes, rawIngredients, posByRecipe, nestingsByRecipe) {
    if (!subRecipes || !subRecipes.length) return;
    const byPid = new Map(rawIngredients.map(i => [i.product_id, i]));

    for (const sr of subRecipes) {
        const pids = collectSubRecipeProductIds(sr.recipe_id, posByRecipe, nestingsByRecipe);
        let worst = 'ok';
        let worstEffective = 'ok';
        const shortfalls = [];

        for (const pid of pids) {
            const ing = byPid.get(pid);
            if (!ing) continue;   // mængde ≤ 0 eller ikke aggregeret
            if (STATUS_RANK[ing.status] > STATUS_RANK[worst]) worst = ing.status;
            const eff = ing.effective_status || ing.status;
            if (MAKE_RANK[eff] > MAKE_RANK[worstEffective]) worstEffective = eff;
            if (ing.status !== 'ok') {
                shortfalls.push({
                    product_id:   ing.product_id,
                    product_name: ing.product_name,
                    amount_needed: ing.amount_needed,
                    unit:          ing.unit,
                    amount_stock:  ing.amount_stock,
                    stock_unit:    ing.stock_unit,
                    status:        ing.status,
                    effective_status: ing.effective_status || ing.status,
                    make_recipe_name: ing.make_recipe_name || null,
                });
            }
        }

        shortfalls.sort((a, b) =>
            (STATUS_RANK[b.status] - STATUS_RANK[a.status]) ||
            a.product_name.localeCompare(b.product_name, 'da')
        );

        sr.status = worst;
        // Additivt: `status` er uændret (fysisk lager), `effective_status` er
        // den nye. En blanding hvis råvarer alle kan skaffes er "kan_laves" —
        // og en underopskrift skal jo altid laves, så det er ikke en undskyldning,
        // det er den rigtige besked.
        sr.effective_status = worstEffective;
        sr.shortfalls = shortfalls;
    }
}

/**
 * Formatér et aggregeringsniveau til gruppestruktur med statusser.
 *
 * @param {Function} effectiveStock  (product_id) → lager i stock-units inkl.
 *   parent/child-substitution (fra grocy.makeEffectiveStock).
 */
function formatLevel(aggregated, effectiveStock, quConversions, unitMap, subRecipeAgg, producibility) {
    const ingredients = [...aggregated.values()].map(ing => {
        const stockAmount = effectiveStock(ing.product_id);

        let status;
        if (stockAmount >= ing.needed_stock)       status = 'ok';
        else if (stockAmount > 0)                  status = 'lav';
        else                                       status = 'mangler';

        // `status` ER og bliver den fysiske sandhed om lageret. `effective_status`
        // er svaret på det spørgsmål køkkenet faktisk stiller: kan retten laves?
        // De holdes adskilt, fordi en flade der kun kender `status` skal opføre
        // sig præcis som før — og fordi "på lager" og "kan laves" er to
        // forskellige beskeder til den der står i køkkenet.
        const make = producibility
            ? producibility(ing.product_id, ing.needed_stock)
            : { producible: false };
        const effectiveStatus = (status === 'ok')
            ? 'ok'
            : (make.producible && make.make_status === 'ok' ? 'kan_laves' : status);

        const convOpts = {
            productId: ing.product_id,
            fromQuId: ing.qu_id_stock,
            toQuId: ing.qu_id_display,
            conversions: quConversions,
            unitMap,
        };
        const fmtNeeded = convertAndFormat(ing.needed_stock, convOpts);
        const fmtStock  = convertAndFormat(stockAmount, convOpts);

        const shortfallStock = Math.max(0, ing.needed_stock - stockAmount);
        let shortfallPurchase = shortfallStock;
        let purchaseUnitName = '';
        // purchaseFactor = lager→indkøbsenhed (1 = samme enhed / ingen konvertering).
        // Eksponeres rå så kaldere (fx forecast) kan konvertere TOTALT behov, ikke
        // kun restbehov-mod-lager (shortfall).
        let purchaseFactor = 1;

        if (ing.qu_id_purchase && ing.qu_id_purchase !== ing.qu_id_stock) {
            const toPurchaseFactor = findConversionFactor(
                quConversions, ing.product_id, ing.qu_id_stock, ing.qu_id_purchase
            );
            if (toPurchaseFactor !== null) { shortfallPurchase = shortfallStock * toPurchaseFactor; purchaseFactor = toPurchaseFactor; }
            const puUnit = unitMap.get(ing.qu_id_purchase);
            purchaseUnitName = puUnit ? (puUnit.name_short || puUnit.name || '') : '';
        } else {
            const stUnit = unitMap.get(ing.qu_id_stock);
            purchaseUnitName = stUnit ? (stUnit.name_short || stUnit.name || '') : '';
        }
        const purchaseIsRealUnit = !!(ing.qu_id_purchase && ing.qu_id_purchase !== ing.qu_id_stock);

        // gramsFactor = lager→gram (via findConversionFactorToGrams; null hvis
        // produktet ikke har en vægt/densitet i Grocy → kan ikke vejes i kg).
        const gramsFactor = findConversionFactorToGrams(quConversions, ing.product_id, ing.qu_id_stock, unitMap);

        return {
            product_id:       ing.product_id,
            product_name:     ing.product_name,
            amount_needed:    fmtNeeded.amount,
            amount_stock:     fmtStock.amount,
            unit:             fmtNeeded.unit,
            stock_unit:       fmtStock.unit,
            status,
            ingredient_group: ing.ingredient_group,
            // Rund op til hele purchase-enheder (1 Kasse, 1 Pakke — ikke 0.01)
            // Epsilon før oprundingen: 1,12 er i binært 1,1200000000000001, så
            // Math.ceil(x × 100) gav 1,13 — og 0,7 / 0,35 gav 3 kasser i stedet for 2.
            shortfall_purchase: purchaseIsRealUnit
                ? Math.ceil(shortfallPurchase - 1e-9)
                : Math.ceil(shortfallPurchase * 100 - 1e-9) / 100,
            purchase_unit:      purchaseUnitName,
            // Rå bygge-klodser til enheds-konvertering hos kalderen:
            needed_stock:       ing.needed_stock,
            // Lageret i RÅ lager-enhed. `amount_stock` ovenfor er formateret og
            // kan have valgt en anden skala end `amount_needed` (0,105 kg vises
            // som "105 g" mens 0 vises som "0 Kilo"). At trække de to
            // VISTE tal fra hinanden ville derfor give vrøvl.
            stock_amount:       stockAmount,
            // display_factor = lager → det tal der står i `amount_needed`/`amount_stock`.
            // Pakkelisten lader køkkenet REDIGERE det viste tal og skal kunne regne
            // tilbage: stock = redigeret / display_factor. Uden den blev "150 g"
            // gemt som 150 kg (#352).
            display_factor:     fmtNeeded.factor,
            // Navnet på den ægte lager-enhed. `unit`/`stock_unit` ovenfor er
            // VISNINGS-enheder — de kan være g selvom produktet lagerføres i kg.
            stock_unit_name:    (unitMap.get(ing.qu_id_stock)?.name_short
                                 || unitMap.get(ing.qu_id_stock)?.name || ''),
            purchase_factor:    purchaseFactor,
            purchase_is_real_unit: purchaseIsRealUnit,
            grams_factor:       gramsFactor,   // null = kan ikke vejes
            // ── kan-laves (#266) ──
            effective_status:  effectiveStatus,
            producible:        !!make.producible,
            make_status:       make.make_status ?? null,
            make_recipe_id:    make.make_recipe_id ?? null,
            make_recipe_name:  make.make_recipe_name ?? null,
            make_recipe_group: make.make_recipe_group ?? null,
            make_batches:      make.make_batches ?? null,
            // true = udbyttet kunne ikke bindes til lager-enheden, så der er
            // regnet med ÉT batch. Skal siges højt i visningen, ikke skjules.
            make_estimated:    !!make.make_estimated,
            make_shortfalls:   make.make_shortfalls ?? [],
            // Sat når udbyttet ikke kunne regnes, men en ANDEN opskrift på
            // samme vare kunne — og den er blokeret. Begge beskeder er sande.
            make_blocked_recipe: make.make_blocked_recipe ?? null,
            make_blocked_status: make.make_blocked_status ?? null,
        };
    });

    // Byg grupperet struktur
    const groupsMap = {};
    for (const ing of ingredients) {
        const g = ing.ingredient_group || '';
        if (!groupsMap[g]) groupsMap[g] = [];
        groupsMap[g].push(ing);
    }

    // Underopskrifter som egen gruppe (kun produktion-niveau)
    let subRecipes = [];
    if (subRecipeAgg && subRecipeAgg.size > 0) {
        subRecipes = [...subRecipeAgg.values()].map(sr => {
            const inputWeightG = sr.weight_grams;

            // Erklæret yield vinder over summen af input. Findes intet yield,
            // falder vi tilbage på summen — den er stadig bedre end ingenting,
            // men den overvurderer alt hvor der hældes fra eller svinder.
            const yieldAmount = sr.yield_per_serving != null
                ? sr.servings * sr.yield_per_serving : null;
            const yu = String(sr.yield_unit || '').toLowerCase();
            const isMassYield = /^(kg|kilo)$/.test(yu);
            const isVolYield  = /^(l|liter)$/.test(yu);

            // Vægten i gram, som pakkelisten og vejningen bruger. Er yieldet en
            // masse, ER det vægten — ikke summen. Er yieldet et antal (sliders),
            // er summen den eneste vægt-kilde vi har.
            const weightG = (yieldAmount != null && isMassYield)
                ? yieldAmount * 1000
                : inputWeightG;

            let display;
            if (yieldAmount != null && !isMassYield && !isVolYield) {
                // Antal-yield: sliders tælles, de vejes ikke.
                display = `${Math.round(yieldAmount * 100) / 100} ${sr.yield_unit}`;
            } else if (yieldAmount != null && isVolYield) {
                display = yieldAmount >= 1
                    ? `${Math.round(yieldAmount * 100) / 100} ${sr.yield_unit}`
                    : `${Math.round(yieldAmount * 1000)} ml`;
            } else if (weightG > 0) {
                display = weightG >= 1000
                    ? (Math.round(weightG / 10) / 100).toLocaleString('da-DK') + ' kg'
                    : Math.round(weightG * 100) / 100 + ' g';
            } else {
                const s = Math.round(sr.servings * 100) / 100;
                display = `${s} ${sr.unit}`;
            }

            return {
                recipe_id:    sr.recipe_id,
                recipe_name:  sr.recipe_name,
                amount:       display,
                // Numerisk vægt (ekskl. emballage) — bruges af pakkelisten til
                // redigerbar buffer (factor = ønsket / weight_grams).
                weight_grams: weightG,
                servings:     sr.servings,
                // Yieldet som erklæret i Grocy. null = ikke erklæret → summen bruges.
                yield_amount: yieldAmount,
                yield_unit:   sr.yield_unit,
                // Summen af input. Beholdes fordi den for ANTAL-opskrifter er den
                // eneste kilde til "hvad vejer én slider" — som opskrift-visningen
                // skal kunne vise, selvom bonen kun interesserer sig for antallet.
                input_weight_grams: inputWeightG,
                unit_weight_grams: (yieldAmount > 0 && !isMassYield && !isVolYield)
                    ? inputWeightG / yieldAmount : null,
            };
        }).sort((a, b) => a.recipe_name.localeCompare(b.recipe_name, 'da'));
    }

    const groupNames = Object.keys(groupsMap).sort((a, b) => {
        const aLow = a.toLowerCase(), bLow = b.toLowerCase();
        if (aLow === 'emballage') return 1;
        if (bLow === 'emballage') return -1;
        if (a === '') return -1;
        if (b === '') return 1;
        return a.localeCompare(b, 'da');
    });

    const statusOrder = { mangler: 0, lav: 1, ok: 2 };
    const groups = groupNames.map(name => ({
        name,
        ingredients: groupsMap[name].sort((a, b) =>
            (statusOrder[a.status] - statusOrder[b.status]) ||
            a.product_name.localeCompare(b.product_name, 'da')
        ),
    }));

    return { ingredients, groups, sub_recipes: subRecipes };
}

/**
 * Forsøg at finde konverteringsfaktor til gram for et produkt.
 * Søger efter gram-enheder (g, Gram) i konverteringer.
 */
function findConversionFactorToGrams(conversions, productId, fromQuId, unitMap) {
    // Find gram-enhed ID
    let gramQuId = null;
    for (const [id, u] of unitMap) {
        const name = (u.name || '').toLowerCase();
        const short = (u.name_short || '').toLowerCase();
        if (name === 'gram' || name === 'g' || short === 'g') {
            gramQuId = id;
            break;
        }
    }
    if (!gramQuId || fromQuId === gramQuId) {
        // Allerede i gram eller kan ikke finde gram-enhed
        if (fromQuId === gramQuId) return 1;
        return null;
    }

    const direct = findConversionFactor(conversions, productId, fromQuId, gramQuId);
    if (direct !== null) return direct;

    // Kæd via KILO når der ikke findes en direkte vej til gram.
    //
    // findConversionFactor slår kun ÉT hop op. Det betød at et produkt med en
    // gyldig vej til kilo — fx Citronsaft med "1 Liter = 1 Kilo", eller Æg med
    // "1 Antal = 0,06 Kilo" — alligevel returnerede null, og så blev varen
    // TAVST udeladt af vægtberegningen (linjen `if (gFactor !== null)` ovenfor).
    // 27 råvarer i grocy-hq var i den situation: dataen var på plads, koden
    // læste den bare ikke.
    //
    // Der antages intet her. Begge led kommer fra Grocy: første hop er
    // produktets eget (eller en global regel), andet hop er den globale
    // Kilo → Gram = 1000.
    let kiloQuId = null;
    for (const [id, u] of unitMap) {
        const name = (u.name || '').toLowerCase();
        const short = (u.name_short || '').toLowerCase();
        if (name === 'kilo' || name === 'kg' || short === 'kg') { kiloQuId = id; break; }
    }
    if (kiloQuId && fromQuId !== kiloQuId) {
        const toKilo = findConversionFactor(conversions, productId, fromQuId, kiloQuId);
        const kiloToGram = findConversionFactor(conversions, productId, kiloQuId, gramQuId);
        if (toKilo !== null && kiloToGram !== null) return toKilo * kiloToGram;
    }

    return null;
}

/**
 * Resolve consume items for inventory deduction.
 * Returnerer flad liste af produkter med mængder i stock-units,
 * aggregeret per product_id, inkl. underopskrifter og emballage.
 *
 * Bruges af consumeRecipes() i grocyAdapter.js og
 * POST /api/grocy/consume endpoint.
 *
 * @param {Array} recipeLines  Bon-linjer med grocy_recipe_id + quantity
 * @returns {Array<{ product_id, amount_stock, product_name }>}
 */
async function resolveConsumeItems(recipeLines, recipeFactors = null) {
    if (!recipeLines.length) return [];

    const [
        recipes,
        allRecipesPos,
        nestings,
        rawRecipeMap,
        products,
        quConversions,
    ] = await Promise.all([
        grocy.getRecipes(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getRecipesRawMap(),
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
    ]);

    const recipeMap = new Map(recipes.map(r => [r.id, r]));
    const productMap = new Map(products.map(p => [p.id, p]));
    const policy = buildProductionPolicy(rawRecipeMap);

    // Gruppér per recipe_id
    const posByRecipe = {};
    allRecipesPos.forEach(p => {
        const rid = p.recipe_id;
        if (!posByRecipe[rid]) posByRecipe[rid] = [];
        posByRecipe[rid].push(p);
    });

    const nestingsByRecipe = {};
    nestings.forEach(n => {
        const rid = n.recipe_id;
        if (!nestingsByRecipe[rid]) nestingsByRecipe[rid] = [];
        nestingsByRecipe[rid].push(n);
    });

    // Enhederne bruges KUN af to_stock-vagten nedenfor, til at slå udbyttet op.
    // Findes der ingen nesting der peger på en planlagt vare, kan vagten ikke
    // fyre — og så hentes de ikke. Det holder den hotteste sti fri for en
    // afhængighed den ikke bruger: målt mod grocy-hq 24.08.2026 er NUL af de
    // 14 producerende opskrifter nestet, så i dag er kaldet aldrig nødvendigt.
    let unitMap = new Map();
    const vagtenKanFyre = nestings.some(n => {
        const sub = rawRecipeMap.get(n.includes_recipe_id);
        const pid = Number(sub?.product_id) || null;
        return pid && policy.get(pid) === 'to_stock';
    });
    if (vagtenKanFyre) {
        unitMap = new Map((await grocy.getQuantityUnits() || []).map(u => [Number(u.id), u]));
    }

    // Aggregér: product_id → total amount i stock-units
    const aggregated = new Map();

    function addAmount(pid, amount) {
        if (amount <= 0) return;
        if (aggregated.has(pid)) {
            aggregated.get(pid).amount_stock += amount;
        } else {
            const product = productMap.get(pid) || {};
            // Faktor stock→purchase (fx 1 kg → 1/6 kasse hvis 1 kasse = 6 kg).
            // Bruges af consumeRecipes til at oprunde shortfall til hel purchase-enhed
            // (samme adfærd som v1's auto-shopping-list ved partial consume).
            let purchaseFactor = 1;
            if (product.qu_id_purchase && product.qu_id_stock
                && product.qu_id_purchase !== product.qu_id_stock) {
                const f = findConversionFactor(
                    quConversions, pid, product.qu_id_stock, product.qu_id_purchase
                );
                if (f !== null) purchaseFactor = f;
            }
            aggregated.set(pid, {
                product_id:        pid,
                product_name:      product.name || `Produkt #${pid}`,
                amount_stock:      amount,
                qu_id_stock:       product.qu_id_stock || null,
                qu_id_purchase:    product.qu_id_purchase || null,
                parent_product_id: product.parent_product_id ? parseInt(product.parent_product_id) : null,
                purchase_factor:   purchaseFactor,
            });
        }
    }

    // Stak, ikke sæt — se resolveSubRecipesRaw for hvorfor. Her rammer forskellen
    // det faktiske lagertræk: en delt underopskrift ville få sit eget indhold
    // undertalt, så der blev consumet for lidt fra Grocy.
    function resolveNestings(recipeId, parentMultiplier, stack) {
        if (stack.has(recipeId)) return;
        stack.add(recipeId);

        const subNestings = nestingsByRecipe[recipeId] || [];
        for (const nesting of subNestings) {
            const subRecipeId = nesting.includes_recipe_id;
            const subRaw = rawRecipeMap.get(subRecipeId);
            if (!subRaw) continue;

            const subBaseServings = parseInt(subRaw.base_servings) || 1;
            const nestingServings = parseFloat(nesting.servings) || 1;
            let subMultiplier = (nestingServings * parentMultiplier) / subBaseServings;

            // Buffer-skalering (event-prep §6): tager køkkenet fx 17 % mere Frisk
            // Grønt med, ganges faktoren på multiplieren → ALLE underopskriftens
            // råvarer (og dybere underopskrifter, via rekursionen nedenfor) skaleres
            // tilsvarende. Ingen faktor → uændret.
            const subFactor = recipeFactors && recipeFactors.get(subRecipeId);
            if (subFactor && subFactor > 0) subMultiplier *= subFactor;

            // ── to_stock-vagten (#329) ──────────────────────────────────────
            //
            // Laver underopskriften en vare personalet producerer EFTER PLAN
            // (langtidsstegt gris, syltede rødløg), så træk VAREN — aldrig
            // dens råvarer.
            //
            // Råvarerne blev nemlig trukket dengang varen blev produceret.
            // Trak menuen dem igen, ville de være væk to gange i Grocy og kun
            // én gang i virkeligheden, og varen ville aldrig blive trukket —
            // altså både en dobbelt-tælling og en skjult mangel. Er varen tom,
            // skal det KUNNE ses (§7.2: den må gå i shortfall); et fald-igennem
            // til råvarerne ville dække over præcis dét signal.
            //
            // Hurtig (`on_demand`) er bevidst undtaget: er opskriften stadig
            // nestet, trækkes dens råvarer som hidtil. Først når menuen er
            // rewired til en produktlinje, trækkes produktet — og så har
            // auto-batchen (#267) allerede lavet det. Uændret adfærd i drift.
            //
            // Målt mod grocy-hq-snapshot 24.08.2026: 14 opskrifter producerer
            // en vare, og NUL af dem er nestet. Vagten er altså inert i dag —
            // den er der for at #270's udrulning ikke kan tabe på rækkefølgen,
            // hvor et produkt findes før menuerne er rewired (jf. `--kun-rewire`).
            const subProductId = Number(subRaw.product_id) || null;
            if (subProductId && policy.get(subProductId) === 'to_stock') {
                const subProduct = productMap.get(subProductId);
                const perBatch = subProduct
                    ? yieldPerBatchStockOf(subRaw, subProduct, unitMap, quConversions)
                    : null;
                if (perBatch != null && perBatch > 0) {
                    addAmount(subProductId, perBatch * subMultiplier);
                    continue;                       // ALDRIG ned i råvarerne
                }
                // Uden et erklæret udbytte kan behovet ikke udtrykkes i varens
                // enhed. Vi opfinder ikke et tal — og vi trækker heller ikke
                // NUL i stilhed, for så ville råvarelageret blive for højt uden
                // at nogen kunne se hvorfor. Falder tilbage til råvarerne som
                // hidtil, og siger det højt. Hullet er et manglende felt i
                // Grocy (#372), ikke en beslutning koden skal træffe.
                console.warn(`[consume] ${subRaw.name || `opskrift #${subRecipeId}`} laver et `
                           + 'planlagt mellemprodukt, men udbyttet er ikke oplyst i Grocy — '
                           + 'trækker råvarerne i stedet. Udfyld recipeunit/recipeunitnumber.');
            }

            const subIngs = posByRecipe[subRecipeId] || [];
            for (const ing of subIngs) {
                const baseAmount = parseFloat(ing.amount) || 0;
                addAmount(ing.product_id, baseAmount * subMultiplier);
            }

            // Samme rettelse som i resolveSubRecipesRaw: argumentet er batch-
            // multiplieren, ikke servings. subMultiplier bærer også en evt.
            // buffer-faktor videre til dybere niveauer (som før).
            resolveNestings(subRecipeId, subMultiplier, stack);
        }

        stack.delete(recipeId);
    }

    // Behandl bon-linjer
    for (const line of recipeLines) {
        const recipe = recipeMap.get(line.grocy_recipe_id);
        const unitNumber = recipe ? recipe.unit_number : 1;
        const scaleFactor = line.quantity / unitNumber;

        // Direkte ingredienser (inkl. emballage)
        const ings = posByRecipe[line.grocy_recipe_id] || [];
        for (const ing of ings) {
            const baseAmount = parseFloat(ing.amount) || 0;
            addAmount(ing.product_id, baseAmount * scaleFactor);
        }

        // Underopskrifter rekursivt
        // Batch-multiplier for bon-linjens egen opskrift = scaleFactor. Se noten
        // i resolveIngredients ovenfor.
        resolveNestings(line.grocy_recipe_id, scaleFactor, new Set());
    }

    return [...aggregated.values()];
}

// De tre primitiver eksponeres så `services/autoBatch.js` (#267) kan bygge på
// PRÆCIS samme fortolkning af udbytte og råvarebehov som visningen bruger.
// En parallel implementering ville drive fra denne — det er nøjagtig sådan
// #349 og #353 opstod.
module.exports = {
    resolveIngredients, resolveConsumeItems, expandProducedToRaw,
    buildProducerIndex, yieldPerBatchStockOf, collectRecipeNeedsFlat,
    // Produktionspolitik (#329) — ÉN kilde, delt med services/autoBatch.js.
    HURTIG_GROUP, recipeGroupOf, productionTypeOf, buildProductionPolicy,
};
