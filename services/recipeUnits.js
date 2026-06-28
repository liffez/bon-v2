/**
 * services/recipeUnits.js
 * ════════════════════════════════════════════════════════════
 * Boks-aware enheds-tælling.
 *
 * Bygger en map: Grocy recipe_id → hvor mange tællelige enheder ÉT styk
 * svarer til. En "kombo-boks" (fx recipe 77 "Alm slider Boks") nester 3
 * sliders i Grocy → 3 enheder. En almindelig slider nester kun ingredienser
 * → 1 enhed. Emballage/levering/drikke → 0. Børne Bokse (ingen nestings,
 * forkert kategori) løftes til 1 via unit_count_extra_recipes-settingen.
 *
 * Resultatet persisteres i recipe_unit_counts så recalcBonTotalUnits kan
 * joine synkront uden at røre Grocy i hot-path (samme mønster som
 * recipe_cost_cache). Genopbygges ved server-start, ved Grocy recipe/nesting
 * writes, og af backfill-scriptet.
 *
 * computeUnitsMap() er ren (ingen I/O) så den kan unit-testes mod fixtures.
 * ════════════════════════════════════════════════════════════
 */

const grocy = require('./grocyAdapter');
const { transaction } = require('../db/compat');

/**
 * Ren beregning: → Map<recipeId:number, unitCount:number>.
 *
 * @param {Array}  rawRecipes  Grocy recipes (getRecipesRaw): { id, userfields:{grupper} }
 * @param {Array}  nestings    Grocy recipes_nestings: { recipe_id, includes_recipe_id }
 * @param {Set}    whitelist   kategori-strenge der tæller (unit_count_categories)
 * @param {Set}    extraIds    recipe-id (number) der tæller som 1 trods kategori
 */
function computeUnitsMap(rawRecipes, nestings, whitelist, extraIds) {
    const cat = new Map();          // recipeId → grupper-kategori
    for (const r of rawRecipes) {
        const uf = r.userfields || {};
        cat.set(Number(r.id), uf.grupper || null);
    }

    const children = new Map();     // parentId → [childId]
    for (const n of nestings || []) {
        const p = Number(n.recipe_id);
        const c = Number(n.includes_recipe_id);
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(c);
    }

    const isCountable = id => whitelist.has(cat.get(id)) || extraIds.has(id);

    const memo = new Map();
    function unitsPer(id, seen) {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return isCountable(id) ? 1 : 0;   // cyklus-værn
        seen.add(id);
        const kids = children.get(id) || [];
        const countableKids = kids.filter(isCountable);
        let u;
        if (countableKids.length) {
            // En boks: tæl indholdet (rekursivt), ikke boksen selv.
            u = countableKids.reduce((s, k) => s + unitsPer(k, seen), 0);
        } else {
            u = isCountable(id) ? 1 : 0;
        }
        seen.delete(id);
        memo.set(id, u);
        return u;
    }

    const out = new Map();
    for (const r of rawRecipes) {
        const id = Number(r.id);
        out.set(id, unitsPer(id, new Set()));
    }
    return out;
}

/**
 * Hent whitelist + extra-recipes fra settings (rå DB-læsning, ingen cache —
 * kaldes sjældent: kun ved refresh).
 */
function readSettings(db) {
    const parse = (key, fallback) => {
        const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
        if (!row?.value) return fallback;
        try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : fallback; }
        catch { return fallback; }
    };
    const whitelist = new Set(parse('unit_count_categories', []));
    const extraIds = new Set(parse('unit_count_extra_recipes', []).map(Number));
    return { whitelist, extraIds };
}

/**
 * Genopbyg recipe_unit_counts fra live Grocy-data.
 * Returnerer { count } eller kaster (kald-stedet beslutter om fejl er fatal).
 */
async function refreshRecipeUnitCounts(db) {
    const [rawRecipes, nestings] = await Promise.all([
        grocy.getRecipesRaw(),
        grocy.getRecipeNestings(),
    ]);
    const { whitelist, extraIds } = readSettings(db);
    const map = computeUnitsMap(rawRecipes, nestings, whitelist, extraIds);

    const upsert = db.prepare(`
        INSERT INTO recipe_unit_counts (grocy_recipe_id, unit_count, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(grocy_recipe_id) DO UPDATE SET
            unit_count = excluded.unit_count,
            updated_at = excluded.updated_at
    `);
    transaction(db, () => {
        for (const [id, units] of map) upsert.run(id, units);
    });
    return { count: map.size };
}

/** Som ovenfor, men sluger fejl (til ikke-blokerende server-start/hooks). */
async function refreshRecipeUnitCountsSafe(db, label = 'recipeUnits') {
    try {
        const { count } = await refreshRecipeUnitCounts(db);
        return count;
    } catch (e) {
        console.warn(`[${label}] kunne ikke opdatere recipe_unit_counts: ${e.message}`);
        return 0;
    }
}

module.exports = { computeUnitsMap, refreshRecipeUnitCounts, refreshRecipeUnitCountsSafe };
