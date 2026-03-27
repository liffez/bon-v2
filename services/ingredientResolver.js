/**
 * services/ingredientResolver.js
 * ════════════════════════════════════════════════════════════
 * Aggregerer ingrediensbehov for bon-linjer med fuld
 * opløsning af underopskrifter (recipes_nestings).
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
 * Løser underopskrifter rekursivt via recipes_nestings.
 *
 * @param {Array} recipeLines  Bon-linjer med grocy_recipe_id + quantity
 * @returns {Object} { ingredients, groups, lines_without_recipe? }
 */
async function resolveIngredients(recipeLines) {
    if (!recipeLines.length) {
        return { ingredients: [], groups: [] };
    }

    // Hent ALT parallelt
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

    // Lookup-maps
    const recipeMap = new Map(recipes.map(r => [r.id, r]));
    const stockMap = {};
    stockArr.forEach(s => { stockMap[s.product_id] = parseFloat(s.amount) || 0; });
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(quantityUnits.map(u => [u.id, u]));

    // Gruppér recipes_pos per recipe_id for hurtig lookup
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

    // ── Aggregér ingredienser: key = product_id ──
    const aggregated = new Map();

    /**
     * Tilføj ingrediens til aggregated map.
     * @param {number} pid         Produkt-ID
     * @param {number} scaledStock Behov i stock-unit
     * @param {Object} ing         Rå ingredient position
     */
    function addIngredient(pid, scaledStock, ing) {
        if (aggregated.has(pid)) {
            aggregated.get(pid).needed_stock += scaledStock;
        } else {
            const product = productMap.get(pid) || {};
            aggregated.set(pid, {
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
     * Rekursiv opløsning af underopskrifter.
     * Mønstret fra recipe-viewer: collectSubRecipeIngredients()
     *
     * @param {number} recipeId        Recipe ID at resolve
     * @param {number} parentMultiplier  Skaleringsmultiplikator
     * @param {Set}    visited          Forhindrer cirkulære referencer
     */
    function resolveSubRecipes(recipeId, parentMultiplier, visited) {
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

            // Tilføj underopskriftens direkte ingredienser
            const subIngs = posByRecipe[subRecipeId] || [];
            for (const ing of subIngs) {
                const pid = ing.product_id;
                const baseAmount = parseFloat(ing.amount) || 0;
                const scaledStock = baseAmount * subMultiplier;
                if (scaledStock <= 0) continue;
                addIngredient(pid, scaledStock, ing);
            }

            // Rekursér videre
            resolveSubRecipes(subRecipeId, subMultiplier * subBaseServings, visited);
        }
    }

    // ── Behandl bon-linjer ──
    for (const line of recipeLines) {
        const recipe = recipeMap.get(line.grocy_recipe_id);
        const unitNumber = recipe ? recipe.unit_number : 1;
        const scaleFactor = line.quantity / unitNumber;

        // 1. Direkte ingredienser
        const ings = posByRecipe[line.grocy_recipe_id] || [];
        for (const ing of ings) {
            const pid = ing.product_id;
            const baseAmount = parseFloat(ing.amount) || 0;
            const scaledStock = baseAmount * scaleFactor;
            if (scaledStock <= 0) continue;
            addIngredient(pid, scaledStock, ing);
        }

        // 2. Underopskrifter (rekursivt)
        const rawRecipe = rawRecipeMap.get(line.grocy_recipe_id);
        const baseServings = rawRecipe ? (parseInt(rawRecipe.base_servings) || 1) : 1;
        const parentMultiplier = scaleFactor * baseServings;
        resolveSubRecipes(line.grocy_recipe_id, parentMultiplier / baseServings, new Set());
    }

    // ── Konvertér til display-units og klassificér ──
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

        // Shortfall → purchase-unit for indkøbsliste
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

    // ── Byg grupperet struktur ──
    // Sortér grupper: tom først, derefter alfabetisk, 'emballage' sidst
    const groupsMap = {};
    for (const ing of ingredients) {
        const g = ing.ingredient_group || '';
        if (!groupsMap[g]) groupsMap[g] = [];
        groupsMap[g].push(ing);
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

    return { ingredients, groups };
}

module.exports = { resolveIngredients };
