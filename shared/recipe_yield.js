// shared/recipe_yield.js
// ==========================================
// Hvor meget giver en opskrift — udtrykt i produktets LAGER-enhed.
// Dual-export: Node (CommonJS) + browser (window.RecipeYield).
//
// HVORFOR DELT
// Kostpris-beregningen (services/recipeCost.js) og produktions-batchen
// (shared/production_batch.js) skal svare det samme på "hvad kom der ud af
// den her opskrift". Gjorde de ikke det, ville en batch lægge ét tal på
// lageret mens kostprisen regnede med et andet — og forskellen ville være
// usynlig indtil næste optælling.
//
// HVORFOR LAGER-ENHED ER DET ENESTE RIGTIGE SVAR
// Grocys `recipeunit` er et FRITEKST-userfield uden relation til produktets
// `qu_id_stock`. Værdierne i grocy-hq er bl.a. "antal", "kg", "Kr" og "Timer"
// — feltet bruges åbenlyst til mere end enheder. Sender man et tal dertil
// ukonverteret, lander "20 portioner" som 20 kg på lageret (#360).
//
// null betyder "kan ikke bestemmes". Der gættes ALDRIG — en manglende
// konvertering skal give en fejl, ikke et plausibelt tal.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.RecipeYield = api;
})(typeof self !== 'undefined' ? self : this, function () {

    // Køkkenets fritekst mod Grocys enhedsnavne. "stk" og "antal" er samme ting.
    const UNIT_ALIASES = {
        kg: 'kilo', kilo: 'kilo', kilogram: 'kilo',
        g: 'gram', gram: 'gram',
        l: 'liter', liter: 'liter', ml: 'ml',
        stk: 'antal', 'stk.': 'antal', styk: 'antal', antal: 'antal', pcs: 'antal',
    };

    function norm(s) {
        const n = String(s || '').trim().toLowerCase();
        return UNIT_ALIASES[n] || n;
    }

    /** Enhed-id ud fra et fritekst-navn. null når navnet ikke er en enhed. */
    function unitIdByName(units, name) {
        const want = norm(name);
        if (!want) return null;
        for (const u of (units || [])) {
            if (norm(u.name) === want) return u.id;
            if (u.name_plural && norm(u.name_plural) === want) return u.id;
        }
        return null;
    }

    /** Faktor fra enhed `fromQuId` til produktets lager-enhed. null = findes ikke. */
    function factorToStock(product, fromQuId, conversions) {
        if (!product) return null;
        const stockQu = product.qu_id_stock;
        if (stockQu == null) return null;
        if (Number(fromQuId) === Number(stockQu)) return 1;
        const c = (conversions || []).find(x =>
            String(x.product_id) === String(product.id)
            && Number(x.from_qu_id) === Number(fromQuId)
            && Number(x.to_qu_id) === Number(stockQu));
        return c ? parseFloat(c.factor) : null;
    }

    /**
     * Udbytte for opskriften SOM INDTASTET (base_servings), i lager-enhed.
     * null = kan ikke bestemmes.
     */
    function yieldInStockUnits(recipe, product, units, conversions) {
        const uf = (recipe && recipe.userfields) || {};
        const per = parseFloat(uf.recipeunitnumber);
        if (!Number.isFinite(per) || per <= 0) return null;
        const base = parseFloat(recipe && recipe.base_servings);
        const total = per * (Number.isFinite(base) && base > 0 ? base : 1);

        const quId = unitIdByName(units, uf.recipeunit);
        if (quId == null) return null;

        // Falaffel erklærer udbytte i "antal" men lagerføres i Kilo.
        // Konverteringen ligger på produktet og skal bruges, ikke ignoreres.
        const f = factorToStock(product, quId, conversions);
        return f == null ? null : total * f;
    }

    /**
     * Forventet udbytte i lager-enhed når der laves `portions` portioner.
     *
     * `yieldInStockUnits` gælder for opskriftens EGNE base_servings, så der
     * skaleres. Er `base_servings` 4 og man laver 6 portioner, kommer der
     * halvanden opskrift ud.
     *
     * null = kan ikke bestemmes → feltet skal stå tomt og brugeren taste selv.
     */
    function plannedYieldStock(recipe, product, units, conversions, portions) {
        const helt = yieldInStockUnits(recipe, product, units, conversions);
        if (helt == null) return null;
        const base = parseFloat(recipe && recipe.base_servings);
        const b = (Number.isFinite(base) && base > 0) ? base : 1;
        const p = Number(portions);
        if (!Number.isFinite(p) || p <= 0) return null;
        return helt * (p / b);
    }

    /** Navnet på produktets lager-enhed, til visning ved indtastningsfeltet. */
    function stockUnitName(product, units) {
        if (!product || product.qu_id_stock == null) return '';
        const u = (units || []).find(x => Number(x.id) === Number(product.qu_id_stock));
        return u ? (u.name_short || u.name || '') : '';
    }

    return { unitIdByName, factorToStock, yieldInStockUnits, plannedYieldStock, stockUnitName, UNIT_ALIASES };
});
