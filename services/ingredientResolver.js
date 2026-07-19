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

    // ── Format & klassificér ──
    const production = formatLevel(prodAgg, effectiveStock, quConversions, unitMap, subRecipeAgg);
    const raw        = formatLevel(rawAgg, effectiveStock, quConversions, unitMap, null);

    // Rul råvare-status op på underopskrifterne, så Produktion-visningen ikke
    // kan vise en grøn "Æggesalat" mens Råvarer-visningen siger at æggene mangler.
    attachSubRecipeStatus(production.sub_recipes, raw.ingredients, posByRecipe, nestingsByRecipe);

    return { production, raw };
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
        const shortfalls = [];

        for (const pid of pids) {
            const ing = byPid.get(pid);
            if (!ing) continue;   // mængde ≤ 0 eller ikke aggregeret
            if (STATUS_RANK[ing.status] > STATUS_RANK[worst]) worst = ing.status;
            if (ing.status !== 'ok') {
                shortfalls.push({
                    product_id:   ing.product_id,
                    product_name: ing.product_name,
                    amount_needed: ing.amount_needed,
                    unit:          ing.unit,
                    amount_stock:  ing.amount_stock,
                    stock_unit:    ing.stock_unit,
                    status:        ing.status,
                });
            }
        }

        shortfalls.sort((a, b) =>
            (STATUS_RANK[b.status] - STATUS_RANK[a.status]) ||
            a.product_name.localeCompare(b.product_name, 'da')
        );

        sr.status = worst;
        sr.shortfalls = shortfalls;
    }
}

/**
 * Formatér et aggregeringsniveau til gruppestruktur med statusser.
 *
 * @param {Function} effectiveStock  (product_id) → lager i stock-units inkl.
 *   parent/child-substitution (fra grocy.makeEffectiveStock).
 */
function formatLevel(aggregated, effectiveStock, quConversions, unitMap, subRecipeAgg) {
    const ingredients = [...aggregated.values()].map(ing => {
        const stockAmount = effectiveStock(ing.product_id);

        let status;
        if (stockAmount >= ing.needed_stock)       status = 'ok';
        else if (stockAmount > 0)                  status = 'lav';
        else                                       status = 'mangler';

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
            shortfall_purchase: purchaseIsRealUnit
                ? Math.ceil(shortfallPurchase)
                : Math.ceil(shortfallPurchase * 100) / 100,
            purchase_unit:      purchaseUnitName,
            // Rå bygge-klodser til enheds-konvertering hos kalderen:
            needed_stock:       ing.needed_stock,
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
            const weightG = sr.weight_grams;
            let display;
            if (weightG > 0) {
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
                // Numerisk standard-vægt (ekskl. emballage) — bruges af pakkelisten
                // til redigerbar buffer (factor = ønsket / weight_grams).
                weight_grams: weightG,
                servings:     sr.servings,
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

    return findConversionFactor(conversions, productId, fromQuId, gramQuId);
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

module.exports = { resolveIngredients, resolveConsumeItems };
