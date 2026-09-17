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
        if (!product) { missing_factor.add(`#${p.product_id}`); continue; }
        const r = resolveIngredient(product, parseFloat(p.amount) || 0, ctx, memo, stack);
        total      += r.total;
        covered_kg += r.covered_kg;
        missing_kg += r.missing_kg;
        r.missing_factor.forEach(x => missing_factor.add(x));
        r.missing_kgvej.forEach(x => missing_kgvej.add(x));
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

/**
 * Én ingrediens-linje → bidrag. Delt af computeRecipe og breakdownRecipe, så
 * rapportens total og drill-downens linjer ikke kan være uenige.
 *
 * Rækkefølge — den mest specifikke kilde vinder:
 *   1. §1 'na'            → udelades helt (ikke en mangel)
 *   2. egen co2e_per_kg   → sat af et menneske eller importen; vinder altid
 *   3. producerende opskrift (§7.3) → rul ned i dens råvarer, skaleret efter udbytte
 *   4. familie (parent_product_id) → forælder uden faktor = gennemsnit af
 *      børnenes; barn uden faktor = forælderens
 *   5. ellers             → mangler faktor
 *
 * @returns { total, covered_kg, missing_kg, missing_factor:Set, missing_kgvej:Set,
 *            status, kg, factor, source, source_note, producer_id }
 */
function resolveIngredient(product, amount, ctx, memo, stack) {
    const out = { total: 0, covered_kg: 0, missing_kg: 0,
                  missing_factor: new Set(), missing_kgvej: new Set(),
                  status: 'ok', kg: null, factor: null, source: null, source_note: null, producer_id: null };
    if (isExcluded(product)) { out.status = 'na'; return out; }

    const uf = product.userfields || {};
    const kg = stockToKg(product, amount, ctx.conversions, ctx.kiloId);
    out.kg = kg;
    let factor = readFactor(product);
    out.source = uf.co2e_source || null;

    // ── Produceret mellemprodukt: rul ned i opskriften bag det (§7.3) ──
    //
    // Når en blanding bliver et rigtigt produkt (#268), holder menuen op med at
    // neste den og peger i stedet på produktet (Remoulade, Tahin dressing). Uden
    // det her forsvinder blandingens CO₂ tavst — produktet har ingen egen faktor.
    if (factor == null && ctx.producedBy) {
        const producer = ctx.producedBy.get(String(product.id));
        const perBatch = producer ? producedYieldStock(producer, product, ctx) : null;
        if (producer && perBatch > 0) {
            const sub = computeRecipe(producer.id, ctx, memo, stack);
            // Brøkdele er rigtige her: spørgsmålet er hvor meget CO₂ der ligger
            // bag mængden, ikke hvor mange hele batches nogen rører.
            const scale = amount / perBatch;
            out.total      = sub.total * scale;
            out.covered_kg = sub.covered_kg * scale;
            out.missing_kg = sub.missing_kg * scale;
            sub.missing_factor.forEach(x => out.missing_factor.add(x));
            sub.missing_kgvej.forEach(x => out.missing_kgvej.add(x));
            out.producer_id = producer.id;
            out.source = 'opskrift';
            out.source_note = `beregnet fra opskriften "${producer.name}"`;
            out.status = (sub.missing_factor.size || sub.missing_kgvej.size) ? 'sub_incomplete' : 'ok';
            if (kg) out.factor = out.total / kg;
            return out;
        }
        // Uden erklæret udbytte kan bidraget ikke skaleres — så falder vi videre.
    }

    if (kg == null) { out.status = 'missing_kgvej'; out.missing_kgvej.add(product.name); return out; }

    if (factor == null) {
        const inh = inheritedFactor(product, ctx);
        if (inh) { factor = inh.factor; out.source = 'arvet'; out.source_note = inh.note; }
    }
    if (factor == null) {
        out.status = 'missing_factor';
        out.missing_factor.add(product.name);
        out.missing_kg = kg;
        return out;
    }
    out.factor = factor;
    out.total = kg * factor;
    out.covered_kg = kg;
    return out;
}

/**
 * Faktor arvet via Grocys forælder/barn-relation, eller null.
 *
 * `kål` er forælder til Spidskål og Hvidkål: opskriften bruger `kål`, lageret
 * trækkes fra børnene. Har forælderen ingen egen faktor, er gennemsnittet af
 * børnenes det bedste bud — samme regel som kostprisen bruger
 * (recipeCost.parentPriceFromChildren), så pris og CO₂ ræsonnerer ens.
 * Omvendt arver et barn uden faktor forælderens (Fatdane-varianterne).
 * Kun EGNE faktorer læses — ingen kæder, ingen gæt oven på gæt.
 */
function inheritedFactor(product, ctx) {
    const kids = (ctx.childrenByParent && ctx.childrenByParent.get(String(product.id))) || [];
    const withF = kids.map(c => ({ c, f: readFactor(c) })).filter(x => x.f != null && !isExcluded(x.c));
    if (withF.length) {
        const avg = withF.reduce((a, x) => a + x.f, 0) / withF.length;
        return { factor: avg, note: `gennemsnit af ${withF.map(x => x.c.name).join(', ')}` };
    }
    const pid = product.parent_product_id;
    if (pid && String(pid) !== '0') {
        const parent = ctx.productById.get(String(pid));
        const f = parent && !isExcluded(parent) ? readFactor(parent) : null;
        if (f != null) return { factor: f, note: `arvet fra ${parent.name}` };
    }
    return null;
}

/**
 * Fælles opslagsstruktur for computeAll og breakdownRecipe. Holdes ét sted:
 * drill-downen manglede engang `producedBy`, og så viste panelet "Mangler
 * faktor" på en vare som totalen faktisk regnede med.
 *
 * `data.recipes` SKAL være de rå Grocy-opskrifter (med product_id + userfields)
 * — ellers kan motoren ikke se at en vare produceres, og udbyttet mangler.
 */
function buildCtx(data) {
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

    const childrenByParent = new Map();
    for (const p of (data.products || [])) {
        const par = p.parent_product_id;
        if (!par || String(par) === '0') continue;
        if (!childrenByParent.has(String(par))) childrenByParent.set(String(par), []);
        childrenByParent.get(String(par)).push(p);
    }

    return { posByRecipe, nestByRecipe, productById, conversions: data.conversions || [], kiloId,
             baseServings, producedBy, childrenByParent, units: data.units || [] };
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
    const ctx = buildCtx(data);
    const baseServings = ctx.baseServings;
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
    const unitName = new Map((data.units || []).map(u => [u.id, u.name_short || u.name]));
    const groupName = new Map((data.groups || []).map(g => [String(g.id), g.name]));

    const ctx = buildCtx(data);
    const { posByRecipe, nestByRecipe, productById, baseServings } = ctx;
    const recipeById = new Map((data.recipes || []).map(r => [r.id, r]));
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
        // Samme opløsning som totalen — egen faktor, opskrift eller arv.
        const r = resolveIngredient(product, amount, ctx, memo, new Set([recipeId]));
        const grp = groupName.get(String(product.product_group_id)) || '';
        const na = r.status === 'na';
        const known = r.covered_kg + r.missing_kg;   // kendt masse bag linjen (også ned gennem en opskrift)
        ingredients.push({
            product_id: product.id, name: product.name, amount_per_serving: amount / div,
            unit: unitName.get(product.qu_id_stock) || null,
            kg: (na || r.kg == null) ? null : r.kg / div,
            factor: r.factor, source: r.source, source_note: r.source_note,
            producer_recipe_id: r.producer_id,
            contribution: r.status === 'ok' ? r.total / div : null,
            status: r.status, is_packaging: /emballage/i.test(grp),
            // 'na' udelades af masse-regnskabet i begge retninger (som computeRecipe).
            mass_kg: na ? null : (r.producer_id ? known / div : (r.kg == null ? null : r.kg / div)),
            missing_kg: (r.status === 'ok' || r.status === 'missing_factor' || r.status === 'sub_incomplete')
                ? r.missing_kg / div : null,
            missing_names: r.status === 'sub_incomplete'
                ? [...r.missing_factor, ...r.missing_kgvej] : undefined,
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

module.exports = { computeAll, computeRecipe, breakdownRecipe, buildCtx, inheritedFactor,
                   stockToKg, readFactor, isExcluded, findKiloId };
