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
    const stockMap = {};
    stockArr.forEach(s => { stockMap[s.product_id] = parseFloat(s.amount) || 0; });
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
    function calcSubRecipeWeightGrams(subRecipeId, scaledServings) {
        const subRaw = rawRecipeMap.get(subRecipeId);
        if (!subRaw) return 0;
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
            totalG += calcSubRecipeWeightGrams(sn.includes_recipe_id, snServings);
        }

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

    function resolveSubRecipesRaw(recipeId, parentMultiplier, visited) {
        if (visited.has(recipeId)) return;
        visited.add(recipeId);

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

            resolveSubRecipesRaw(subRecipeId, subMultiplier * subBaseServings, visited);
        }
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

        // Underopskrifter
        const rawRecipe = rawRecipeMap.get(line.grocy_recipe_id);
        const baseServings = rawRecipe ? (parseInt(rawRecipe.base_servings) || 1) : 1;

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

        // RÅVARER: fuld rekursiv opløsning
        const parentMultiplier = scaleFactor * baseServings;
        resolveSubRecipesRaw(line.grocy_recipe_id, parentMultiplier / baseServings, new Set());
    }

    // ── Format & klassificér ──
    const production = formatLevel(prodAgg, stockMap, quConversions, unitMap, subRecipeAgg);
    const raw        = formatLevel(rawAgg, stockMap, quConversions, unitMap, null);

    return { production, raw };
}

/**
 * Formatér et aggregeringsniveau til gruppestruktur med statusser.
 */
function formatLevel(aggregated, stockMap, quConversions, unitMap, subRecipeAgg) {
    const ingredients = [...aggregated.values()].map(ing => {
        const stockAmount = stockMap[ing.product_id] || 0;

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

        if (ing.qu_id_purchase && ing.qu_id_purchase !== ing.qu_id_stock) {
            const toPurchaseFactor = findConversionFactor(
                quConversions, ing.product_id, ing.qu_id_stock, ing.qu_id_purchase
            );
            if (toPurchaseFactor !== null) shortfallPurchase = shortfallStock * toPurchaseFactor;
            const puUnit = unitMap.get(ing.qu_id_purchase);
            purchaseUnitName = puUnit ? (puUnit.name_short || puUnit.name || '') : '';
        } else {
            const stUnit = unitMap.get(ing.qu_id_stock);
            purchaseUnitName = stUnit ? (stUnit.name_short || stUnit.name || '') : '';
        }

        return {
            product_id:       ing.product_id,
            product_name:     ing.product_name,
            amount_needed:    fmtNeeded.amount,
            amount_stock:     fmtStock.amount,
            unit:             fmtNeeded.unit,
            stock_unit:       fmtStock.unit,
            status,
            ingredient_group: ing.ingredient_group,
            shortfall_purchase: Math.ceil(shortfallPurchase * 100) / 100,
            purchase_unit:      purchaseUnitName,
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
                recipe_id:   sr.recipe_id,
                recipe_name: sr.recipe_name,
                amount:      display,
                servings:    sr.servings,
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
async function resolveConsumeItems(recipeLines) {
    if (!recipeLines.length) return [];

    const [
        recipes,
        allRecipesPos,
        nestings,
        rawRecipeMap,
        products,
    ] = await Promise.all([
        grocy.getRecipes(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getRecipesRawMap(),
        grocy.getProducts(),
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
            aggregated.set(pid, {
                product_id:   pid,
                product_name: product.name || `Produkt #${pid}`,
                amount_stock: amount,
            });
        }
    }

    function resolveNestings(recipeId, parentMultiplier, visited) {
        if (visited.has(recipeId)) return;
        visited.add(recipeId);

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
                const baseAmount = parseFloat(ing.amount) || 0;
                addAmount(ing.product_id, baseAmount * subMultiplier);
            }

            resolveNestings(subRecipeId, subMultiplier * subBaseServings, visited);
        }
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
        const rawRecipe = rawRecipeMap.get(line.grocy_recipe_id);
        const baseServings = rawRecipe ? (parseInt(rawRecipe.base_servings) || 1) : 1;
        resolveNestings(line.grocy_recipe_id, scaleFactor * baseServings / baseServings, new Set());
    }

    return [...aggregated.values()];
}

module.exports = { resolveIngredients, resolveConsumeItems };
