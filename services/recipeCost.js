/**
 * services/recipeCost.js
 * ════════════════════════════════════════════════════════════
 * Kostpris pr. opskrift — regnet af Bon, ikke læst fra Grocy.
 *
 * HVORFOR IKKE GROCYS TAL
 * Grocys `/recipes/fulfillment` → `costs` er skaleret efter `desired_servings`
 * — kokke-UI'ets "hvor mange portioner vil jeg lave nu". Det er en scratch-
 * værdi, ikke en egenskab ved opskriften, og den gør 8 salgbare opskrifters
 * kostpris op til 5× for høj (#517).
 *
 * Og et produkt der PRODUCERES (fx en konverteret blanding) har ingen købspris
 * før nogen har produceret ind i det. Grocy værdisætter linjen til 0, så
 * bidraget forsvinder tavst (#269).
 *
 * ANKERET
 * Opskriften erklærer selv sin enhed i Grocy: `Portioner` (base_servings) og
 * `Antal recipieenheder` × `Recipe Enhed` (recipeunitnumber + recipeunit).
 * Køkkenets norm er én portion = 1 kg. Udbyttet er derfor
 * `base_servings × recipeunitnumber` udtrykt i `recipeunit`.
 *
 * ALT ER EX MOMS. Grocys indkøbspriser er ex moms (CLAUDE.md §6b), og
 * kostpriser er ex moms hele vejen igennem bon-domænet.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

// `recipeunit` er fritekst ("kg"), Grocys enheder hedder "Kilo".
const UNIT_ALIASES = {
    kg: 'kilo', kilo: 'kilo', kilogram: 'kilo',
    g: 'gram', gram: 'gram',
    l: 'liter', liter: 'liter', ml: 'ml',
    stk: 'antal', 'stk.': 'antal', styk: 'antal', antal: 'antal', pcs: 'antal',
};
const norm = (s) => {
    const n = String(s || '').trim().toLowerCase();
    return UNIT_ALIASES[n] || n;
};

/**
 * Enhedskost ex moms pr. LAGER-enhed for ét produkt, ud fra en Grocy-række.
 * Samme rækkefølge som `services/production.js` og `routes/recipes_overview.js`
 * allerede bruger: seneste købspris → gennemsnit → lagerværdi/mængde.
 * Prisen bevares i Grocys historik uanset lager, så udsolgte varer også tæller.
 */
function unitCostFromRow(row) {
    if (!row) return null;
    const last = Number(row.last_price);
    if (Number.isFinite(last) && last > 0) return last;
    const avg = Number(row.avg_price ?? row.average_price);
    if (Number.isFinite(avg) && avg > 0) return avg;
    const value = Number(row.value), amount = Number(row.amount);
    if (Number.isFinite(value) && Number.isFinite(amount) && amount > 1e-9) return value / amount;
    return null;
}

/** Enhed-id ud fra et fritekst-navn. null når navnet ikke er en enhed. */
function unitIdByName(units, name) {
    const want = norm(name);
    if (!want) return null;
    for (const u of units) {
        if (norm(u.name) === want) return u.id;
        if (u.name_plural && norm(u.name_plural) === want) return u.id;
    }
    return null;
}

/**
 * Udbytte for opskriften SOM INDTASTET, i produktets lager-enhed.
 * null = kan ikke bestemmes → der gættes ikke.
 */
function yieldInStockUnits(recipe, product, units, conversions) {
    const uf = recipe.userfields || {};
    const per = parseFloat(uf.recipeunitnumber);
    if (!Number.isFinite(per) || per <= 0) return null;
    const base = parseFloat(recipe.base_servings);
    const total = per * (Number.isFinite(base) && base > 0 ? base : 1);

    const quId = unitIdByName(units, uf.recipeunit);
    if (quId == null) return null;
    if (Number(quId) === Number(product.qu_id_stock)) return total;

    // Falaffel erklærer udbytte i "antal" men lagerføres i Kilo. Konverteringen
    // ligger på produktet og skal bruges, ikke ignoreres.
    const c = (conversions || []).find(x =>
        String(x.product_id) === String(product.id)
        && Number(x.from_qu_id) === Number(quId)
        && Number(x.to_qu_id) === Number(product.qu_id_stock));
    return c ? total * parseFloat(c.factor) : null;
}

/**
 * Beregn kostpris for ALLE opskrifter.
 *
 * @param data { recipes, pos, nestings, products, units, conversions, priceByProduct }
 *   priceByProduct: Map(product_id → kr pr. lager-enhed, ex moms)
 * @returns Map(recipe_id → {
 *   cost,            // kr for opskriften som indtastet (base_servings portioner)
 *   cost_per_unit,   // kr pr. recipe-enhed (kr/kg for produktion, kr/stk for menu)
 *   yield_amount, yield_unit,
 *   missing_price,   // Set<navn> — varer uden kendt pris
 *   complete,        // true når intet mangler
 * })
 */
function computeAll(data) {
    const posBy = new Map();
    for (const p of (data.pos || [])) {
        if (!posBy.has(p.recipe_id)) posBy.set(p.recipe_id, []);
        posBy.get(p.recipe_id).push(p);
    }
    const nestBy = new Map();
    for (const n of (data.nestings || [])) {
        if (!nestBy.has(n.recipe_id)) nestBy.set(n.recipe_id, []);
        nestBy.get(n.recipe_id).push(n);
    }
    const productById = new Map((data.products || []).map(p => [String(p.id), p]));
    const recipeById  = new Map((data.recipes || []).map(r => [String(r.id), r]));

    // product_id → producerende opskrift. Deterministisk ved flere producenter
    // (Falaffel har tre), så to kørsler ikke giver hver sit tal.
    const producedBy = new Map();
    for (const r of (data.recipes || [])) {
        const pid = Number(r.product_id);
        if (!pid) continue;
        const cur = producedBy.get(String(pid));
        if (!cur || Number(r.id) < Number(cur.id)) producedBy.set(String(pid), r);
    }

    const ctx = { posBy, nestBy, productById, recipeById, producedBy,
                  units: data.units || [], conversions: data.conversions || [],
                  prices: data.priceByProduct || new Map() };

    const memo = new Map();
    const out = new Map();
    for (const r of (data.recipes || [])) out.set(r.id, compute(r.id, ctx, memo, new Set()));
    return out;
}

function compute(recipeId, ctx, memo, stack) {
    if (memo.has(recipeId)) return memo.get(recipeId);
    if (stack.has(recipeId)) return { cost: 0, cost_per_unit: null, missing_price: new Set(), complete: true };
    stack.add(recipeId);

    const recipe = ctx.recipeById.get(String(recipeId)) || {};
    const missing_price = new Set();
    let cost = 0;

    for (const p of (ctx.posBy.get(recipeId) || [])) {
        const product = ctx.productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;   // ALTID i lager-enhed
        if (!product) { missing_price.add(`#${p.product_id}`); continue; }
        if (amount <= 0) continue;

        let unitCost = ctx.prices.get(String(product.id));
        if (!(Number.isFinite(unitCost) && unitCost > 0)) unitCost = null;

        // Er varen produceret og uden købspris, arver den kostprisen fra den
        // opskrift der laver den. En rigtig købspris vinder altid — den er
        // hvad varen FAKTISK kostede.
        if (unitCost == null) {
            const producer = ctx.producedBy.get(String(product.id));
            if (producer && Number(producer.id) !== Number(recipeId)) {
                const y = yieldInStockUnits(producer, product, ctx.units, ctx.conversions);
                if (y && y > 0) {
                    const sub = compute(producer.id, ctx, memo, stack);
                    unitCost = sub.cost / y;
                    sub.missing_price.forEach(x => missing_price.add(x));
                }
            }
        }

        if (unitCost == null) { missing_price.add(product.name || `#${product.id}`); continue; }
        cost += amount * unitCost;
    }

    for (const n of (ctx.nestBy.get(recipeId) || [])) {
        const sub = compute(n.includes_recipe_id, ctx, memo, stack);
        const subRecipe = ctx.recipeById.get(String(n.includes_recipe_id)) || {};
        const subBase = parseFloat(subRecipe.base_servings) || 1;
        // `costs` gælder opskriften som indtastet = base_servings portioner.
        const scale = (parseFloat(n.servings) || 0) / subBase;
        cost += sub.cost * scale;
        sub.missing_price.forEach(x => missing_price.add(x));
    }

    stack.delete(recipeId);

    const uf = recipe.userfields || {};
    const per = parseFloat(uf.recipeunitnumber);
    const base = parseFloat(recipe.base_servings);
    const yieldAmount = (Number.isFinite(per) && per > 0)
        ? per * (Number.isFinite(base) && base > 0 ? base : 1) : null;

    const result = {
        cost,
        cost_per_unit: (yieldAmount && yieldAmount > 0) ? cost / yieldAmount : null,
        yield_amount: yieldAmount,
        yield_unit: uf.recipeunit || null,
        missing_price,
        complete: missing_price.size === 0,
    };
    memo.set(recipeId, result);
    return result;
}

module.exports = { computeAll, unitCostFromRow, yieldInStockUnits, unitIdByName };
