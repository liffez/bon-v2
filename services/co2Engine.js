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
//
// Undtagelse (§1): co2e_source='na' = varen er bevidst markeret IKKE relevant for
// CO₂ (skjult i emballage-tildeleren). Den udelades HELT — hverken dækket eller
// manglende masse, ingen mangel-flag. Ellers ville "skjul" i ét værktøj få
// rapporten til at nage om præcis den vare, man lige har skjult.
// ==========================================

'use strict';

const { findConversionFactor } = require('./quConvert');

/** §1: co2e_source='na' → bevidst udeladt fra CO₂-regnskabet (ikke en mangel). */
function isExcluded(product) {
    return ((product.userfields || {}).co2e_source || '').trim() === 'na';
}

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
    if (stack.has(recipeId)) return { total: 0, covered_kg: 0, missing_kg: 0, missing_factor: new Set(), missing_kgvej: new Set() }; // cyklus
    stack.add(recipeId);

    const missing_factor = new Set();
    const missing_kgvej = new Set();
    let total = 0;
    // Masse-dækning (til nøjagtigheds-tal): covered_kg = råvarer med både vægt og
    // faktor · missing_kg = råvarer MED vægt men UDEN faktor. Råvarer uden kg-vej
    // (missing_kgvej) har ukendt masse og tælles ikke med i nogen af dem.
    let covered_kg = 0, missing_kg = 0;

    for (const p of (ctx.posByRecipe.get(recipeId) || [])) {
        const product = ctx.productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;
        if (!product) { missing_factor.add(`#${p.product_id}`); continue; }
        if (isExcluded(product)) continue;   // §1 'na' — udelades helt, ikke en mangel

        // ── Produceret mellemprodukt: rul ned i opskriften bag det (§7.3) ──
        //
        // Når en blanding bliver et rigtigt produkt (#268), holder menuen op med
        // at neste den og peger i stedet på produktet. Uden det her ville
        // remouladens CO₂ forsvinde tavst i samme øjeblik — det nye produkt har
        // ingen `co2e_per_kg`, og et manglende bidrag ser ud som nul.
        //
        // En egen faktor på produktet vinder altid: den er sat af et menneske,
        // og at lægge den oveni opskriften ville dobbelt-tælle.
        const ownFactor = readFactor(product);
        const producer = (ownFactor == null && ctx.producedBy)
            ? ctx.producedBy.get(String(product.id)) : null;
        if (producer) {
            const perBatch = producedYieldStock(producer, product, ctx);
            if (perBatch > 0) {
                const sub = computeRecipe(producer.id, ctx, memo, stack);
                // Brøkdele er rigtige her: spørgsmålet er hvor meget CO₂ der
                // ligger bag mængden, ikke hvor mange hele batches nogen rører.
                const scale = amount / perBatch;
                total       += sub.total * scale;
                covered_kg  += sub.covered_kg * scale;
                missing_kg  += sub.missing_kg * scale;
                sub.missing_factor.forEach(x => missing_factor.add(x));
                sub.missing_kgvej.forEach(x => missing_kgvej.add(x));
                continue;
            }
            // Uden erklæret udbytte kan bidraget ikke skaleres. Så er varen en
            // ægte mangel — ikke et gæt.
        }

        const kg = stockToKg(product, amount, ctx.conversions, ctx.kiloId);
        if (kg == null) { missing_kgvej.add(product.name); continue; }

        const factor = ownFactor;
        if (factor == null) { missing_factor.add(product.name); missing_kg += kg; continue; }

        total += kg * factor;
        covered_kg += kg;
    }

    for (const n of (ctx.nestByRecipe.get(recipeId) || [])) {
        const sub = computeRecipe(n.includes_recipe_id, ctx, memo, stack);
        const subBase = ctx.baseServings.get(n.includes_recipe_id) || 1;
        const scale = subBase ? (parseFloat(n.servings) || 0) / subBase : 0;
        total += sub.total * scale;
        covered_kg += sub.covered_kg * scale;
        missing_kg += sub.missing_kg * scale;
        sub.missing_factor.forEach(x => missing_factor.add(x));
        sub.missing_kgvej.forEach(x => missing_kgvej.add(x));
    }

    stack.delete(recipeId);
    const result = { total, covered_kg, missing_kg, missing_factor, missing_kgvej };
    memo.set(recipeId, result);
    return result;
}

/** Nøjagtighed pr. masse: dækket kg / kendt kg. null hvis ingen kendt masse. */
/**
 * Udbytte for en producerende opskrift, i produktets lager-enhed.
 * null/0 = kan ikke bestemmes → intet rulles ned.
 *
 * Samme fortolkning som `ingredientResolver`: `recipeunitnumber` er udbytte PR
 * PORTION, og `recipes_pos.amount` hører til opskriften som indtastet, altså
 * til `base_servings` portioner.
 */
function producedYieldStock(recipeRaw, product, ctx) {
    const uf = recipeRaw.userfields || {};
    const perServing = parseFloat(uf.recipeunitnumber);
    if (!Number.isFinite(perServing) || perServing <= 0) return null;
    const base = parseFloat(recipeRaw.base_servings);
    const total = perServing * (Number.isFinite(base) && base > 0 ? base : 1);

    const want = String(uf.recipeunit || '').trim().toLowerCase();
    const unit = (ctx.units || []).find(u => String(u.name || '').trim().toLowerCase() === want
        || UNIT_ALIAS[want] === String(u.name || '').trim().toLowerCase());
    if (!unit) return null;
    if (Number(unit.id) === Number(product.qu_id_stock)) return total;

    const conv = (ctx.conversions || []).find(c =>
        String(c.product_id) === String(product.id)
        && Number(c.from_qu_id) === Number(unit.id)
        && Number(c.to_qu_id) === Number(product.qu_id_stock));
    return conv ? total * parseFloat(conv.factor) : null;
}

const UNIT_ALIAS = { kg: 'kilo', g: 'gram', l: 'liter', stk: 'antal', 'stk.': 'antal', styk: 'antal' };

function accuracyPct(res) {
    const known = res.covered_kg + res.missing_kg;
    if (known > 0) return Math.round((res.covered_kg / known) * 100);
    return (res.missing_factor.size === 0 && res.missing_kgvej.size === 0) ? 100 : null;
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

    // product_id → producerende opskrift. Deterministisk ved flere producenter
    // (Falaffel har tre), så to kørsler ikke kan give hver sit CO₂-tal.
    const producedBy = new Map();
    for (const r of (data.recipes || [])) {
        const pid = Number(r.product_id);
        if (!pid) continue;
        const cur = producedBy.get(String(pid));
        if (!cur || Number(r.id) < Number(cur.id)) producedBy.set(String(pid), r);
    }

    const ctx = { posByRecipe, nestByRecipe, productById, conversions: data.conversions || [], kiloId, baseServings,
                  producedBy, units: data.units || [] };
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
            covered_kg: res.covered_kg,
            missing_kg: res.missing_kg,               // masse uden faktor (kendt vægt)
            accuracy_pct: accuracyPct(res),           // dækket / kendt masse
            missing_kgvej_count: res.missing_kgvej.size, // råvarer m. ukendt vægt
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
    // Rekursiv masse-dækning for HELE opskriften (til nøjagtigheds-tallet).
    const full = computeRecipe(recipeId, ctx, memo, new Set());

    const ingredients = [];
    for (const p of (posByRecipe.get(recipeId) || [])) {
        const product = productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;
        if (!product) {
            ingredients.push({ product_id: null, name: `#${p.product_id}`, amount_per_serving: amount / div,
                unit: null, kg: null, factor: null, source: null, contribution: null,
                mass_kg: null, missing_kg: null, status: 'unknown_product', is_packaging: false });
            continue;
        }
        const kgFull = stockToKg(product, amount, ctx.conversions, kiloId);
        const factor = readFactor(product);
        const uf = product.userfields || {};
        const grp = groupName.get(String(product.product_group_id)) || '';
        const kg = kgFull == null ? null : kgFull / div;
        let status = 'ok', contribution = null;
        if (isExcluded(product)) status = 'na';   // §1 — bevidst udeladt (vises, tælles ikke)
        else if (kgFull == null) status = 'missing_kgvej';
        else if (factor == null) status = 'missing_factor';
        else contribution = kg * factor;
        ingredients.push({
            product_id: product.id, name: product.name, amount_per_serving: amount / div,
            unit: unitName.get(product.qu_id_stock) || null, kg: status === 'na' ? null : kg, factor,
            source: uf.co2e_source || null, contribution, status, is_packaging: /emballage/i.test(grp),
            // 'na' udelades af masse-regnskabet i begge retninger (som computeRecipe).
            mass_kg: status === 'na' ? null : kg,
            missing_kg: status === 'missing_factor' ? kg : (status === 'ok' ? 0 : null),
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
        // Masse pr. top-serving: skalér underopskriftens covered/missing_kg ned.
        const subScale = (subBase ? servings / subBase : 0) / div;
        sub_recipes.push({
            recipe_id: n.includes_recipe_id, name: r ? r.name : `#${n.includes_recipe_id}`,
            servings_per_serving: servings / div, per_serving: perServing,
            contribution: complete ? (perServing * servings) / div : null, complete,
            mass_kg: (sub.covered_kg + sub.missing_kg) * subScale,   // kendt masse i underopskriften
            missing_kg: sub.missing_kg * subScale,                   // heraf uden faktor
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
        complete: ingredients.every(i => i.status === 'ok' || i.status === 'na') && sub_recipes.every(s => s.complete),
        // Nøjagtighed pr. masse (rekursivt) — hvor stor en andel af de kendte kg har en faktor.
        accuracy_pct: accuracyPct(full),
        covered_kg_per_serving: full.covered_kg / div,
        missing_kg_per_serving: full.missing_kg / div,          // masse uden faktor (kendt vægt)
        missing_kgvej_count: full.missing_kgvej.size,           // råvarer m. ukendt vægt
        ingredients: withPct(ingredients),
        sub_recipes: withPct(sub_recipes),
    };
}

module.exports = { computeAll, computeRecipe, breakdownRecipe, stockToKg, readFactor, isExcluded, findKiloId };
