// services/co2Engine.js
// ==========================================
// CO₂ F5 — beregningsmotor: opskrift-CO₂ = Σ(ingrediens-kg × co2e_per_kg).
// Spec: docs/CLAUDE_CO2.md §7 + §10 + §12 trin 5.
//
// Ren funktion (al Grocy-data injiceres) → fuldt unit-testbar. Deler kg-
// konverteringen med kostpris via samme quConvert.findConversionFactor (§10:
// "ét fejlpunkt, ét audit"). Underopskrifter (recipes_nestings) opløses
// rekursivt med memo + cyklus-vagt.
//
// Enhedsdisciplin (§3): recipes_pos.amount er i STOCK-enhed. Konverteres til kg
// via produkt-specifik stock→Kilo (kg-vej / densitet) eller global Gram→Kilo.
// Mangler konverteringen → ingrediensen tælles ikke, men flages (missing_kgvej).
// Mangler co2e_per_kg → flages (missing_factor). Faktor 0 (fx vand) er gyldig.
// ==========================================

'use strict';

const { findConversionFactor } = require('./quConvert');

/** Find Kilo-enhedens id (fald tilbage til 4 = Grocy-standard). */
function findKiloId(units) {
    const k = units.find(u => {
        const n = (u.name || '').toLowerCase();
        return n === 'kilo' || n === 'kilogram' || (u.name_short || '').toLowerCase() === 'kg';
    });
    return k ? k.id : 4;
}

/** Faktor (number) eller null. Tom/NaN → null. 0 er gyldigt (fx vand). */
function readFactor(product) {
    const raw = (product.userfields || {}).co2e_per_kg;
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/** Mængde (stock-enhed) → kg for ét produkt. null hvis ingen kg-konvertering. */
function stockToKg(product, amount, conversions, kiloId) {
    const from = product.qu_id_stock;
    const factor = findConversionFactor(conversions, product.id, from, kiloId);
    if (factor == null) return null;
    return amount * factor;
}

/**
 * Beregn CO₂ for ÉN opskrift (for dens base_servings), rekursivt.
 * @returns { total, missing_factor:Set, missing_kgvej:Set }
 */
function computeRecipe(recipeId, ctx, memo, stack) {
    if (memo.has(recipeId)) return memo.get(recipeId);
    if (stack.has(recipeId)) return { total: 0, missing_factor: new Set(), missing_kgvej: new Set() }; // cyklus
    stack.add(recipeId);

    const missing_factor = new Set();
    const missing_kgvej = new Set();
    let total = 0;

    for (const p of (ctx.posByRecipe.get(recipeId) || [])) {
        const product = ctx.productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;
        if (!product) { missing_factor.add(`#${p.product_id}`); continue; }

        const kg = stockToKg(product, amount, ctx.conversions, ctx.kiloId);
        if (kg == null) { missing_kgvej.add(product.name); continue; }

        const factor = readFactor(product);
        if (factor == null) { missing_factor.add(product.name); continue; }

        total += kg * factor;
    }

    for (const n of (ctx.nestByRecipe.get(recipeId) || [])) {
        const sub = computeRecipe(n.includes_recipe_id, ctx, memo, stack);
        const subBase = ctx.baseServings.get(n.includes_recipe_id) || 1;
        const perServing = subBase ? sub.total / subBase : 0;
        total += perServing * (parseFloat(n.servings) || 0);
        sub.missing_factor.forEach(x => missing_factor.add(x));
        sub.missing_kgvej.forEach(x => missing_kgvej.add(x));
    }

    stack.delete(recipeId);
    const result = { total, missing_factor, missing_kgvej };
    memo.set(recipeId, result);
    return result;
}

/**
 * Beregn CO₂ for ALLE opskrifter.
 * @param data { recipes, pos, nestings, products, conversions, units }
 * @returns Map<recipeId, { co2e_per_serving, total, base_servings, missing_factor[], missing_kgvej[], complete }>
 */
function computeAll(data) {
    const kiloId = findKiloId(data.units || []);
    const posByRecipe = new Map();
    for (const p of (data.pos || [])) {
        if (!posByRecipe.has(p.recipe_id)) posByRecipe.set(p.recipe_id, []);
        posByRecipe.get(p.recipe_id).push(p);
    }
    const nestByRecipe = new Map();
    for (const n of (data.nestings || [])) {
        if (!nestByRecipe.has(n.recipe_id)) nestByRecipe.set(n.recipe_id, []);
        nestByRecipe.get(n.recipe_id).push(n);
    }
    const productById = new Map((data.products || []).map(p => [String(p.id), p]));
    const baseServings = new Map((data.recipes || []).map(r => [r.id, parseFloat(r.base_servings) || 1]));

    const ctx = { posByRecipe, nestByRecipe, productById, conversions: data.conversions || [], kiloId, baseServings };
    const memo = new Map();

    const out = new Map();
    for (const r of (data.recipes || [])) {
        const res = computeRecipe(r.id, ctx, memo, new Set());
        const base = baseServings.get(r.id) || 1;
        out.set(r.id, {
            recipe_id: r.id,
            name: r.name,
            base_servings: base,
            total: res.total,
            co2e_per_serving: base ? res.total / base : res.total,
            missing_factor: [...res.missing_factor],
            missing_kgvej: [...res.missing_kgvej],
            complete: res.missing_factor.size === 0 && res.missing_kgvej.size === 0,
        });
    }
    return out;
}

/**
 * Detaljeret nedbrydning for ÉN opskrift (pr. enhed/serving) — til drill-down.
 * Eksponerer det computeAll allerede regner internt: hver ingrediens' bidrag
 * (kg × faktor) + andel, underopskrifter som klikbare rækker med deres bidrag.
 * Alt divideres med base_servings → summen matcher co2e_per_serving i tabellen.
 * Ufuldstændige ingredienser tælles ikke i totalen men medtages med status,
 * så man ser præcis hvad der mangler.
 *
 * @param data { recipes, pos, nestings, products, conversions, units, groups }
 * @returns { recipe_id, base_servings, total_per_serving, complete,
 *            ingredients:[{product_id,name,amount_per_serving,unit,kg,factor,source,
 *                          contribution,pct,status,is_packaging}],
 *            sub_recipes:[{recipe_id,name,servings_per_serving,per_serving,
 *                          contribution,pct,complete}] }
 */
function breakdownRecipe(recipeId, data) {
    const kiloId = findKiloId(data.units || []);
    const unitName = new Map((data.units || []).map(u => [u.id, u.name_short || u.name]));
    const groupName = new Map((data.groups || []).map(g => [String(g.id), g.name]));

    const posByRecipe = new Map();
    for (const p of (data.pos || [])) {
        if (!posByRecipe.has(p.recipe_id)) posByRecipe.set(p.recipe_id, []);
        posByRecipe.get(p.recipe_id).push(p);
    }
    const nestByRecipe = new Map();
    for (const n of (data.nestings || [])) {
        if (!nestByRecipe.has(n.recipe_id)) nestByRecipe.set(n.recipe_id, []);
        nestByRecipe.get(n.recipe_id).push(n);
    }
    const productById  = new Map((data.products || []).map(p => [String(p.id), p]));
    const recipeById   = new Map((data.recipes  || []).map(r => [r.id, r]));
    const baseServings = new Map((data.recipes  || []).map(r => [r.id, parseFloat(r.base_servings) || 1]));

    const ctx = { posByRecipe, nestByRecipe, productById, conversions: data.conversions || [], kiloId, baseServings };
    const memo = new Map();
    const div = baseServings.get(recipeId) || 1;

    const ingredients = [];
    for (const p of (posByRecipe.get(recipeId) || [])) {
        const product = productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;
        if (!product) {
            ingredients.push({ product_id: null, name: `#${p.product_id}`, amount_per_serving: amount / div,
                unit: null, kg: null, factor: null, source: null, contribution: null,
                status: 'unknown_product', is_packaging: false });
            continue;
        }
        const kgFull = stockToKg(product, amount, ctx.conversions, kiloId);
        const factor = readFactor(product);
        const uf = product.userfields || {};
        const grp = groupName.get(String(product.product_group_id)) || '';
        const kg = kgFull == null ? null : kgFull / div;
        let status = 'ok', contribution = null;
        if (kgFull == null) status = 'missing_kgvej';
        else if (factor == null) status = 'missing_factor';
        else contribution = kg * factor;
        ingredients.push({
            product_id: product.id, name: product.name, amount_per_serving: amount / div,
            unit: unitName.get(product.qu_id_stock) || null, kg, factor,
            source: uf.co2e_source || null, contribution, status, is_packaging: /emballage/i.test(grp),
        });
    }

    const sub_recipes = [];
    for (const n of (nestByRecipe.get(recipeId) || [])) {
        const sub = computeRecipe(n.includes_recipe_id, ctx, memo, new Set());
        const subBase = baseServings.get(n.includes_recipe_id) || 1;
        const perServing = subBase ? sub.total / subBase : 0;
        const servings = parseFloat(n.servings) || 0;
        const complete = sub.missing_factor.size === 0 && sub.missing_kgvej.size === 0;
        const r = recipeById.get(n.includes_recipe_id);
        sub_recipes.push({
            recipe_id: n.includes_recipe_id, name: r ? r.name : `#${n.includes_recipe_id}`,
            servings_per_serving: servings / div, per_serving: perServing,
            contribution: complete ? (perServing * servings) / div : null, complete,
        });
    }

    const total = [...ingredients, ...sub_recipes].reduce((a, x) => a + (x.contribution || 0), 0);
    const withPct = (arr) => arr.map(x => ({
        ...x, pct: (total > 0 && x.contribution != null) ? (x.contribution / total) * 100 : null,
    }));

    return {
        recipe_id: recipeId,
        base_servings: div,
        total_per_serving: total,
        complete: ingredients.every(i => i.status === 'ok') && sub_recipes.every(s => s.complete),
        ingredients: withPct(ingredients),
        sub_recipes: withPct(sub_recipes),
    };
}

module.exports = { computeAll, computeRecipe, breakdownRecipe, stockToKg, readFactor, findKiloId };
