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

module.exports = { computeAll, computeRecipe, stockToKg, readFactor, findKiloId };
