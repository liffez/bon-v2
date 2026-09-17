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
 * TO SLAGS TVIVL, TO SPOR
 * `missing_price` = "vi kender ikke prisen" → kostprisen er et MINIMUM.
 * `warnings`      = "vi kender den, men den ser forkert ud" → kostprisen er
 * komplet, men bør ses efter. De holdes adskilt, fordi kun det første må gøre
 * en opskrift ufuldstændig; en advarsel der smittede af på `complete` ville
 * sætte et "≤" på et tal der ikke er et minimum.
 *
 * ALT ER EX MOMS. Grocys indkøbspriser er ex moms (CLAUDE.md §6b), og
 * kostpriser er ex moms hele vejen igennem bon-domænet.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

// Udbytte-reglen bor i `shared/recipe_yield.js`, fordi produktions-batchen i
// browseren skal svare det samme som kostpris-beregningen her. To kopier af
// "hvad kom der ud af opskriften" ville drive fra hinanden, og forskellen
// ville først vise sig ved en optælling.
const { yieldInStockUnits, unitIdByName } = require('../shared/recipe_yield');

// Tærskler for de to advarsler. De VÆLGER ikke noget — de gør en uenighed
// synlig i Opskrifter & priser, så et tal man ikke kan stole på kan kendes
// fra et man kan.
const WARN_LAST_VS_AVG_PCT      = 30;   // #557
const WARN_STOCK_VS_RECIPE_PCT  = 20;   // #558

/** Et positivt tal, eller null. 0 er ikke en pris (kål stod til 0). */
function _pos(v) {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
}

/**
 * Enhedskost ex moms pr. LAGER-enhed for ét produkt — med ophav.
 *
 * GENNEMSNITTET ER ANKERET (#557)
 * `last_price` er prisen på ÉT bilag. Køber køkkenet en enkelt billig 5 kg-spand
 * mayo som nødløsning, falder kostprisen på hver eneste mayo-ret 63 % indtil
 * næste pose bliver købt — spanden er brugt op længe inden. Mayo ligger i seks
 * af de otte `RR produktion Hurtig`-blandinger, så udsvinget rammer bredt.
 * Gennemsnittet svinger ikke med den seneste kvittering.
 *
 * Men gennemsnittet er STABILT, ikke RIGTIGT. Har varen flere varenumre — mayo
 * har en 1 kg-pose til 114,56 kr/kg og en 5 kg-spand til 42,01 — lander snittet
 * mellem dem og passer på ingen af dem. Den rigtige pris kræver pris pr.
 * stregkode plus et udpeget standard-varenummer (fejl 1 og 3 i #557). Indtil da
 * advarer vi når de to tal er langt fra hinanden, frem for at vælge i stilhed.
 *
 * @returns {{cost, source, last_price, avg_price, deviation_pct, warn}|null}
 */
function unitCostDetail(row) {
    if (!row) return null;

    const last = _pos(row.last_price);
    const avg  = _pos(row.avg_price ?? row.average_price);

    if (avg != null) {
        const dev = (last != null) ? (last - avg) / avg * 100 : null;
        return {
            cost: avg, source: 'avg',
            last_price: last, avg_price: avg,
            deviation_pct: dev,
            warn: dev != null && Math.abs(dev) > WARN_LAST_VS_AVG_PCT,
        };
    }
    if (last != null) {
        // Kun ét køb registreret — så ER seneste køb gennemsnittet.
        return { cost: last, source: 'last', last_price: last, avg_price: null,
                 deviation_pct: null, warn: false };
    }
    const value = Number(row.value), amount = Number(row.amount);
    if (Number.isFinite(value) && Number.isFinite(amount) && amount > 1e-9) {
        return { cost: value / amount, source: 'stock_value', last_price: null,
                 avg_price: null, deviation_pct: null, warn: false };
    }
    return null;
}

/**
 * Enhedskost ex moms pr. LAGER-enhed. Tyndt lag over `unitCostDetail`, så de
 * kaldere der kun skal bruge tallet ikke også skal kende ophavet.
 * Prisen bevares i Grocys historik uanset lager, så udsolgte varer også tæller.
 */
function unitCostFromRow(row) {
    const d = unitCostDetail(row);
    return d ? d.cost : null;
}


/**
 * Beregn kostpris for ALLE opskrifter.
 *
 * @param data { recipes, pos, nestings, products, units, conversions,
 *               priceByProduct, priceDetailByProduct }
 *   priceByProduct:       Map(product_id → kr pr. lager-enhed, ex moms)
 *   priceDetailByProduct: Map(product_id → unitCostDetail()) — valgfri. Uden
 *                         den regnes alt som før, bare uden #557-advarslerne.
 * @returns Map(recipe_id → {
 *   cost,            // kr for opskriften som indtastet (base_servings portioner)
 *   cost_per_unit,   // kr pr. recipe-enhed (kr/kg for produktion, kr/stk for menu)
 *   yield_amount, yield_unit,
 *   missing_price,   // Set<navn> — varer uden kendt pris
 *   warnings,        // Map(nøgle → advarsel) — priser der ser forkerte ud
 *   complete,        // true når intet MANGLER (advarsler tæller ikke med)
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
                  prices: data.priceByProduct || new Map(),
                  priceDetails: data.priceDetailByProduct || new Map() };

    const memo = new Map();
    const out = new Map();
    for (const r of (data.recipes || [])) out.set(r.id, compute(r.id, ctx, memo, new Set()));
    return out;
}

function compute(recipeId, ctx, memo, stack) {
    if (memo.has(recipeId)) return memo.get(recipeId);
    if (stack.has(recipeId)) {
        return { cost: 0, cost_per_unit: null, missing_price: new Set(),
                 warnings: new Map(), complete: true };
    }
    stack.add(recipeId);

    const recipe = ctx.recipeById.get(String(recipeId)) || {};
    const missing_price = new Set();
    const warnings = new Map();
    let cost = 0;

    for (const p of (ctx.posBy.get(recipeId) || [])) {
        const product = ctx.productById.get(String(p.product_id));
        const amount = parseFloat(p.amount) || 0;   // ALTID i lager-enhed
        if (!product) { missing_price.add(`#${p.product_id}`); continue; }
        if (amount <= 0) continue;

        const pid  = String(product.id);
        const name = product.name || `#${product.id}`;
        const stockPrice = _pos(ctx.prices.get(pid));

        let unitCost = null;

        // ── Produceret gode: OPSKRIFTEN VINDER ALTID (#558) ───────────────
        // Et gode vi selv laver har ingen købspris. Står der alligevel en, er
        // den et artefakt: `setInventory()` sender ingen pris, så Grocy bærer
        // den forrige videre fra optælling til optælling. Rødløg - Sylt stod
        // til 34,99 mens råvarerne kostede 17,81 — 96 % ved siden af.
        //
        // Det er også dét der lukker hullet i gaten (#269): FØR konverteringen
        // arves prisen fra opskriften, EFTER arves den også. Springet flytter
        // ikke kostprisen — hverken ved konverteringen eller næste gang nogen
        // tæller op. Gaten kan ikke længere være grøn ved springet og forkert
        // bagefter.
        const producer = ctx.producedBy.get(pid);
        if (producer && Number(producer.id) !== Number(recipeId)) {
            const y   = yieldInStockUnits(producer, product, ctx.units, ctx.conversions);
            const sub = (y && y > 0) ? compute(producer.id, ctx, memo, stack) : null;
            const fromRecipe = (sub && sub.cost > 0) ? sub.cost / y : null;

            if (fromRecipe != null) {
                unitCost = fromRecipe;
                sub.missing_price.forEach(x => missing_price.add(x));
                sub.warnings.forEach((w, k) => warnings.set(k, w));

                if (stockPrice != null) {
                    const dev = (stockPrice - fromRecipe) / fromRecipe * 100;
                    if (Math.abs(dev) > WARN_STOCK_VS_RECIPE_PCT) {
                        warnings.set(`produced:${pid}`, {
                            kind: 'produced_stock_price_differs',
                            product_id: pid, product: name,
                            stock_price: stockPrice, recipe_cost: fromRecipe,
                            deviation_pct: dev,
                        });
                    }
                }
            } else if (stockPrice != null) {
                // Opskriften KAN ikke regnes — intet erklæret udbytte (#372),
                // eller ingen af dens råvarer har en pris. Så er lagerprisen
                // det eneste tal der findes, og vi bruger det. Men reglen
                // ovenfor gælder ikke her, og det skal kunne ses frem for at
                // ligne en almindelig købt vare.
                warnings.set(`fallback:${pid}`, {
                    kind: 'produced_recipe_cost_unavailable',
                    product_id: pid, product: name,
                    stock_price: stockPrice,
                    reason: (y && y > 0) ? 'ingen priser på opskriftens råvarer'
                                         : 'intet erklæret udbytte på opskriften',
                });
            }
        }

        // ── Købt vare: uændret. Lagerprisen ER hvad varen kostede. ─────────
        if (unitCost == null && stockPrice != null) {
            unitCost = stockPrice;
            const d = ctx.priceDetails.get(pid);
            if (d && d.warn) {
                warnings.set(`price:${pid}`, {
                    kind: 'last_vs_avg',
                    product_id: pid, product: name,
                    last_price: d.last_price, avg_price: d.avg_price,
                    deviation_pct: d.deviation_pct,
                });
            }
        }

        if (unitCost == null) { missing_price.add(name); continue; }
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
        sub.warnings.forEach((w, k) => warnings.set(k, w));
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
        warnings,
        // Advarsler gør IKKE en opskrift ufuldstændig — se hovedet.
        complete: missing_price.size === 0,
    };
    memo.set(recipeId, result);
    return result;
}


/**
 * Pris på en FORÆLDRE-vare, arvet som gennemsnit af de børn der har en pris.
 *
 * Grocy ruller børnenes LAGER op på forælderen (derfor `makeEffectiveStock`),
 * men ikke deres PRIS — forælderen står bare til 0. `kål` har ingen egen pris;
 * Spidskål og Hvidkål har. Uden denne regel bliver et halvt kilo kål gratis i
 * Frisk Grønt, som ligger i 26 menuer.
 *
 * Reglen bor her, fordi to steder skal være enige om den: bulk-opslaget der
 * fylder cachen, og drill-down-panelet der viser prisen linje for linje.
 * Var de uenige, ville linjen stå som "—" mens totalen indeholdt beløbet.
 *
 * @param products  hele produktlisten (til at finde børnene)
 * @param parentId  forælderens id
 * @param priceOf   (childId) => pris | null
 * @returns gennemsnit, eller null hvis intet barn har en pris
 */
function parentPriceFromChildren(products, parentId, priceOf) {
    const priser = (products || [])
        .filter(x => String(x.parent_product_id) === String(parentId))
        .map(x => priceOf(String(x.id)))
        .filter(v => Number.isFinite(v) && v > 0);
    if (!priser.length) return null;
    return priser.reduce((a, b) => a + b, 0) / priser.length;
}


/**
 * Advarsel → én linje dansk tekst. Bor her, så serveren, `audit:kostpris-kilder`
 * og Opskrifter & priser siger det samme om det samme tal.
 */
function describeWarning(w) {
    if (!w) return '';
    const kr = n => (Number(n) || 0).toLocaleString('da-DK',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
    const pct = n => (n > 0 ? '+' : '') + (Number(n) || 0).toFixed(0) + ' %';

    switch (w.kind) {
        case 'produced_stock_price_differs':
            return `${w.product}: lagerprisen ${kr(w.stock_price)} afviger ${pct(w.deviation_pct)} `
                 + `fra hvad opskriften koster at lave (${kr(w.recipe_cost)}). Opskriften er brugt.`;
        case 'produced_recipe_cost_unavailable':
            return `${w.product}: kostprisen kunne ikke regnes (${w.reason}), `
                 + `så lagerprisen ${kr(w.stock_price)} er brugt.`;
        case 'last_vs_avg':
            return `${w.product}: seneste køb ${kr(w.last_price)} ligger ${pct(w.deviation_pct)} `
                 + `fra gennemsnittet ${kr(w.avg_price)}. Gennemsnittet er brugt.`;
        default:
            return `${w.product || 'ukendt vare'}: prisen bør ses efter.`;
    }
}

module.exports = {
    computeAll, unitCostFromRow, unitCostDetail, yieldInStockUnits, unitIdByName,
    parentPriceFromChildren, describeWarning,
    WARN_LAST_VS_AVG_PCT, WARN_STOCK_VS_RECIPE_PCT,
};
