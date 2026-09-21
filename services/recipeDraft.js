// services/recipeDraft.js
// ════════════════════════════════════════════════════════════
// En UGEMT opskrift-kladde, regnet med de motorer der allerede findes.
//
// HVORFOR DEN FINDES
// Designerens kostpris kommer i dag fra Grocys fulfillment-endpoint
// (`_rdLoadComposition`). Det kan kun svare på en opskrift der ER gemt — og
// slet ikke på en linje hvis vare ikke er oprettet endnu. Editoren skal vise
// tallene MENS man skriver, så den har brug for en beregning der tager en
// kladde frem for et id.
//
// HVORFOR DER IKKE KOMMER EN NY MOTOR
// `recipeCost.computeAll` og `co2Engine.computeAll` tager begge rene arrays —
// opskrifter, linjer, nestings, produkter, enheder, omregninger — ikke id'er.
// Kladden kan derfor fodres ind som ét syntetisk sæt rækker. To parallelle
// regnestykker ville drive fra hinanden, og så ville designeren vise ét tal
// mens Opskrifter & priser viste et andet (#360's fejlklasse).
//
// DE TO SENTINEL-REGLER, OG HVORFOR DE ER SÅDAN
//   1. Redigerer kladden en EKSISTERENDE opskrift, ERSTATTER den opskriftens
//      rækker. Id'et er uændret, så alt der afhænger af id — først og fremmest
//      `buildProducedByIndex`, der lader LAVESTE id bestemme en vares kostpris
//      (#558) — opfører sig præcis som i drift.
//   2. En NY kladde får et id HØJERE end alle eksisterende. Et nyt id er i
//      virkeligheden altid højere, så en ny opskrift kan ikke vinde
//      producent-konkurrencen. Gav vi den et lavt (eller negativt) id, ville
//      en kladde der erklærer at den producerer Chili Mayo overtage prisen på
//      Chili Mayo for hele beregningen — også for kladden selv.
//
// `≥`-REGLEN ER IKKE NY
// `computeAll` returnerer allerede `missing_price` og `complete`; co2Engine
// returnerer `missing_factor`/`missing_kgvej`/`complete`. Kladden videregiver
// dem som `complete`-flag pr. tal, så et mindstetal aldrig kan se ud som et
// færdigt tal (designer-spec I3).
// ════════════════════════════════════════════════════════════

'use strict';

const grocy = require('./grocyAdapter');
const recipeCost = require('./recipeCost');
const co2Engine = require('./co2Engine');
const { isPackagingGroup } = require('./co2Materials');
const RecipeYield = require('../shared/recipe_yield');
const { autoFormatAmount } = require('./quConvert');

/** Id'er over denne grænse er kladdens egne — de findes ikke i Grocy. */
const SENTINEL_BASE = 1000000;

function num(v) {
    const n = Number(String(v == null ? '' : v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════
   Kladden → det sæt rækker motorerne forventer
   ══════════════════════════════════════════════════════════════ */

/**
 * @param draft {
 *   recipe_id,            // null = ny opskrift
 *   name, group,
 *   base_servings,
 *   yield: { amount, unit, product_id },      // udbyttesætningen (§5)
 *   target_weight_g,
 *   lines: [
 *     { product_id, amount, section },                    // eksisterende vare
 *     { includes_recipe_id, servings, section },          // nesting
 *     { new_product: { key, name, qu_id_stock, product_group_id,
 *                      price_per_unit, co2e_per_unit },
 *       amount, section },                                // uafklaret linje (§8)
 *   ]
 * }
 * @param g  { recipes, pos, nestings, products, units, conversions, groups,
 *             priceByProduct, priceDetailByProduct }
 */
function buildInputs(draft, g) {
    const eksisterende = (g.recipes || []).map(r => Number(r.id)).filter(Number.isFinite);
    const højeste = eksisterende.length ? Math.max(...eksisterende) : 0;
    const redigerer = draft.recipe_id != null && draft.recipe_id !== '';
    const draftId = redigerer ? Number(draft.recipe_id) : Math.max(højeste + 1, SENTINEL_BASE);

    const y = draft.yield || {};
    const draftRecipe = {
        id: draftId,
        name: draft.name || '(kladde)',
        base_servings: num(draft.base_servings) || 1,
        product_id: y.product_id == null || y.product_id === '' ? null : Number(y.product_id),
        description: draft.description || null,
        userfields: {
            grupper: draft.group || '',
            recipeunit: y.unit || '',
            recipeunitnumber: y.amount == null || y.amount === '' ? '' : String(y.amount),
        },
    };

    // Kladden ERSTATTER sin egen opskrift — den lægges ikke ved siden af.
    const recipes = (g.recipes || []).filter(r => Number(r.id) !== draftId).concat([draftRecipe]);

    // Nye varer får syntetiske id'er. De har ingen omregninger i Grocy, hvilket
    // er sandt — og derfor bliver deres vægt i kg ukendt med mindre lager-enheden
    // allerede ER kilo eller gram. Det er ærligt, ikke en mangel.
    const nyeProdukter = [];
    const priser = new Map(g.priceByProduct || []);
    let næste = SENTINEL_BASE;
    const idForNy = new Map();

    // ⚠️ Nøglen dannes af KLADDENS INDEKS, ikke af hvor mange nye varer der er
    // set indtil nu. De to falder kun sammen hvis alle linjer før også er nye
    // varer — ellers slår opslaget nedenfor fejl, og linjen faldt tavst ud af
    // beregningen. Én kilde til nøglen, brugt begge steder:
    const nøgleFor = (l, i) => (l.new_product && l.new_product.key != null)
        ? String(l.new_product.key) : String(i);

    (draft.lines || []).forEach((l, i) => {
        if (!l.new_product) return;
        const nøgle = nøgleFor(l, i);
        if (idForNy.has(nøgle)) return;
        const pid = ++næste;
        idForNy.set(nøgle, pid);
        const co2 = num(l.new_product.co2e_per_unit);
        nyeProdukter.push({
            id: pid,
            name: l.new_product.name || '(ny vare)',
            qu_id_stock: l.new_product.qu_id_stock == null ? null : Number(l.new_product.qu_id_stock),
            qu_id_purchase: l.new_product.qu_id_stock == null ? null : Number(l.new_product.qu_id_stock),
            product_group_id: l.new_product.product_group_id == null ? null : Number(l.new_product.product_group_id),
            parent_product_id: null,
            active: '1',
            userfields: co2 == null ? {} : { co2e_per_kg: String(co2) },
            _draft_new: true,
        });
        const pris = num(l.new_product.price_per_unit);
        // `recipeCost` slår op med `String(product.id)` — et tal-nøglet kort
        // rammer aldrig, og prisen ville falde tavst på gulvet.
        if (pris != null && pris > 0) priser.set(String(pid), pris);
    });

    const products = (g.products || []).concat(nyeProdukter);

    // Linjerne. `recipes_pos.amount` er i LAGER-enhed (jf. CLAUDE.md) — det er
    // også dét kladden leverer, så der omregnes ikke her.
    const egnePos = [];
    const egneNest = [];
    let posId = SENTINEL_BASE;
    (draft.lines || []).forEach((l, i) => {
        if (l.includes_recipe_id != null) {
            egneNest.push({
                id: ++posId,
                recipe_id: draftId,
                includes_recipe_id: Number(l.includes_recipe_id),
                servings: num(l.servings) || 0,
                // Kladdens egen plads i `lines[]`. Uden den kan editoren kun
                // koble et beregnet tal til den linje brugeren ser ved at gætte
                // på rækkefølgen — og et tal på den forkerte linje er værre end
                // intet tal. Motorerne ser den aldrig; den følger kun med ud.
                _i: i,
            });
            return;
        }
        const pid = l.new_product ? idForNy.get(nøgleFor(l, i)) : Number(l.product_id);
        if (l.new_product && !pid) {
            // Kan ikke ske nu hvor nøglen dannes ét sted — og netop derfor skal
            // det siges højt hvis det alligevel sker. En linje der forsvinder
            // fra beregningen gør totalen for lille UDEN en fejl.
            throw new Error('recipeDraft: ny vare på linje ' + i + ' kunne ikke opløses');
        }
        if (!pid) return;
        const p = products.find(x => Number(x.id) === Number(pid));
        egnePos.push({
            id: ++posId,
            recipe_id: draftId,
            product_id: pid,
            amount: num(l.amount) || 0,
            qu_id: p && p.qu_id_stock != null ? p.qu_id_stock : null,
            ingredient_group: l.section || null,
            note: l.note || null,
            _i: i,                                   // se kommentaren ved egneNest
        });
    });

    const pos = (g.pos || []).filter(p => Number(p.recipe_id) !== draftId).concat(egnePos);
    const nestings = (g.nestings || []).filter(n => Number(n.recipe_id) !== draftId).concat(egneNest);

    return {
        draftId, draftRecipe,
        data: {
            recipes, pos, nestings, products,
            units: g.units || [],
            conversions: g.conversions || [],
            priceByProduct: priser,
            priceDetailByProduct: g.priceDetailByProduct || new Map(),
        },
        egnePos, egneNest,
    };
}

/* ══════════════════════════════════════════════════════════════
   Vægt — mad, emballage, batch
   ══════════════════════════════════════════════════════════════ */

/**
 * Emballage genkendes på VAREGRUPPEN, ikke på sektionsnavnet (designer-spec
 * R7.5) — ellers ødelægger en omdøbt sektion madvægten. Reglen lånes fra
 * `co2Materials.isPackagingGroup`, så CO₂-modulet og editoren er enige.
 */
function buildPackagingLookup(products, groups) {
    const navn = new Map((groups || []).map(gr => [String(gr.id), gr.name]));
    return function erEmballage(product) {
        if (!product) return false;
        return isPackagingGroup(navn.get(String(product.product_group_id)) || '');
    };
}

/**
 * En underopskrifts madvægt i gram ud fra dens EGNE råvarer, skaleret.
 *
 * Bruges kun når udbyttet ikke kan bestemmes. Det er husets etablerede
 * fald-tilbage — `ingredientResolver` skriver det selv:
 *
 *   «Erklæret yield vinder over summen af input. Findes intet yield, falder
 *    vi tilbage på summen — den er stadig bedre end ingenting, men den
 *    overvurderer alt hvor der hældes fra eller svinder.»
 *
 * Editoren var den eneste flade der gav op og skrev «—», mens den lige ved
 * siden af skrev «≥ 11,87» for en ufuldstændig kostpris. Tallet markeres
 * derfor som et SKØN (`estimated`), ikke som en måling: for en slider er
 * summen reelt vægten, for en syltet løg er den 57 % for høj.
 *
 * Emballage tælles ikke med — madvægten er mad (R7.5).
 *
 * Stak, ikke sæt: en opskrift der optræder i to grene skal tælles begge
 * gange; kun en ægte cyklus stoppes (#354).
 */
function subRecipeInputGrams(recipeId, servings, built, g, erEmballage, kiloId, stack) {
    const rid = Number(recipeId);
    if (stack.has(rid)) return null;              // cyklus — ikke et tal vi kan stå inde for
    const sub = built.data.recipes.find(r => Number(r.id) === rid);
    if (!sub) return null;

    const base = num(sub.base_servings) > 0 ? num(sub.base_servings) : 1;
    const mult = num(servings) > 0 ? num(servings) / base : 1 / base;
    const byId = new Map(built.data.products.map(x => [String(x.id), x]));

    stack.add(rid);
    let gram = 0, ukendt = false;

    for (const pos of built.data.pos) {
        if (Number(pos.recipe_id) !== rid) continue;
        const prod = byId.get(String(pos.product_id));
        if (!prod || erEmballage(prod)) continue;
        const kg = co2Engine.stockToKg(prod, num(pos.amount) * mult,
                                       built.data.conversions, kiloId);
        if (kg == null) { ukendt = true; continue; }
        gram += kg * 1000;
    }

    for (const n of built.data.nestings) {
        if (Number(n.recipe_id) !== rid) continue;
        const dyb = subRecipeInputGrams(n.includes_recipe_id, num(n.servings) * mult,
                                        built, g, erEmballage, kiloId, stack);
        if (dyb == null) { ukendt = true; continue; }
        gram += dyb;
    }

    stack.delete(rid);
    // Intet kendt og intet at gå efter: sig det, frem for at kalde 0 for en vægt.
    if (gram <= 0 && ukendt) return null;
    return gram > 0 ? gram : null;
}

function weights(built, g) {
    const kiloId = co2Engine.findKiloId(g.units || []);
    const erEmballage = buildPackagingLookup(built.data.products, g.groups);
    const byId = new Map(built.data.products.map(p => [String(p.id), p]));

    let food = 0, pack = 0;
    const missing = [];
    // Linjer hvor vægten er summen af underopskriftens råvarer, ikke et
    // erklæret udbytte. Overblikket viser dem med ~ — tallet er et skøn.
    const estimeret = [];
    const estimatLinjer = new Set();
    // Gram pr. linje — samme gennemgang som totalen, så de to ikke kan blive
    // uenige. Nulstilles aldrig: en linje uden kendt vægt står som null, ikke 0.
    const perLinje = new Map();
    // Hvilke LINJER er emballage. Uden den ville browseren skulle holde sin
    // egen kopi af `co2Materials`-listen — og så kunne R7.5 skride uden at
    // nogen opdagede det. Reglen afgøres her, hvor madvægten også afgøres.
    const emballageLinjer = new Set();

    for (const p of built.egnePos) {
        const prod = byId.get(String(p.product_id));
        const kg = prod ? co2Engine.stockToKg(prod, p.amount, built.data.conversions, kiloId) : null;
        if (prod && erEmballage(prod)) emballageLinjer.add(p.id);
        if (kg == null) { missing.push((prod && prod.name) || ('#' + p.product_id)); perLinje.set(p.id, null); continue; }
        perLinje.set(p.id, Math.round(kg * 1000 * 100) / 100);
        if (erEmballage(prod)) pack += kg * 1000; else food += kg * 1000;
    }

    // En nesting vejer sit UDBYTTE, ikke summen af sine råvarer — samme regel
    // som ingredientResolver og opskrift-vieweren bruger siden yield-modellen.
    // Kan udbyttet ikke bestemmes, bliver vægten et mindstetal.
    for (const n of built.egneNest) {
        const sub = built.data.recipes.find(r => Number(r.id) === Number(n.includes_recipe_id));
        if (!sub) { missing.push('#' + n.includes_recipe_id); continue; }
        const subProd = sub.product_id ? byId.get(String(sub.product_id)) : null;
        const stock = subProd
            ? RecipeYield.plannedYieldStock(sub, subProd, g.units, built.data.conversions, n.servings)
            : null;
        const kg = (stock != null && subProd)
            ? co2Engine.stockToKg(subProd, stock, built.data.conversions, kiloId) : null;
        if (kg != null) {
            perLinje.set(n.id, Math.round(kg * 1000 * 100) / 100);
            food += kg * 1000;
            continue;
        }
        // Intet erklæret udbytte — summen af underopskriftens egne råvarer er
        // et skøn, og et skøn er bedre end et tomt felt. Det MARKERES, så et
        // overslag aldrig kan forveksles med noget der er vejet.
        const skøn = subRecipeInputGrams(n.includes_recipe_id, n.servings,
                                         built, g, erEmballage, kiloId, new Set());
        if (skøn == null) { missing.push(sub.name); perLinje.set(n.id, null); continue; }
        perLinje.set(n.id, Math.round(skøn * 100) / 100);
        estimatLinjer.add(n.id);
        estimeret.push(sub.name);
        food += skøn;
    }

    return {
        food_g: Math.round(food * 100) / 100,
        packaging_g: Math.round(pack * 100) / 100,
        batch_g: Math.round((food + pack) * 100) / 100,
        complete: missing.length === 0,
        missing,
        estimated: estimeret,
        per_line_g: perLinje,
        estimated_lines: estimatLinjer,
        packaging_lines: emballageLinjer,
    };
}

/* ══════════════════════════════════════════════════════════════
   Beregningen
   ══════════════════════════════════════════════════════════════ */

/** Alt motorerne skal bruge, hentet én gang. Adapterens cache bærer gentagne kald. */
async function loadGrocy() {
    const [recipes, pos, nestings, products, units, conversions, groups] = await Promise.all([
        grocy.getRecipesRaw(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
        grocy.getProductGroups(),
    ]);
    const priceDetailByProduct = await grocy.getProductUnitCostDetails(6);
    const priceByProduct = new Map();
    for (const [pid, d] of priceDetailByProduct) if (d && d.cost > 0) priceByProduct.set(pid, d.cost);
    return { recipes, pos, nestings, products, units, conversions, groups,
             priceByProduct, priceDetailByProduct };
}

/**
 * Regn en kladde. `g` kan injiceres (test); ellers hentes den fra Grocy.
 * @returns overblikket i designer-spec §10
 */
async function computeDraft(draft, g) {
    const grocyData = g || await loadGrocy();
    const built = buildInputs(draft, grocyData);

    const kostAlle = recipeCost.computeAll(built.data);
    const co2Alle = co2Engine.computeAll(built.data);
    const k = kostAlle.get(built.draftId) || null;
    const c = co2Alle.get(built.draftId) || null;

    const servings = num(draft.base_servings) || 1;
    const v = weights(built, grocyData);

    const kost = {
        total: k ? k.cost : null,
        per_serving: k && servings ? k.cost / servings : null,
        // `complete: false` betyder at tallet er et MINDSTETAL (I3) — aldrig at
        // det er forkert. Advarsler gør ikke en beregning ufuldstændig (#557).
        complete: !!(k && k.complete),
        missing: k ? [...k.missing_price] : [],
        warnings: k ? [...k.warnings.values()] : [],
    };
    const co2 = {
        total: c ? c.total : null,
        per_serving: c && servings ? c.total / servings : null,
        complete: !!(c && c.complete),
        missing: c ? [...c.missing_factor, ...c.missing_kgvej] : [],
    };

    // ── Linje for linje: gram, kostpris, CO₂e ─────────────────────────
    // De tre tal kommer fra de SAMME motorer som totalerne ovenfor — ikke fra
    // et regnestykke der ligner. Det er hele grunden til at editoren ikke har
    // sin egen beregning: en tabel hvis linjer ikke lægger sammen til
    // overskriften er værre end ingen tabel.
    const kostLinjer = recipeCost.breakdownRecipe(built.draftId, built.data);
    const co2Linjer = co2Engine.breakdownRecipe(built.draftId, built.data);
    const kostVed = new Map(kostLinjer.ingredients.map(i => [i.line_id, i]));
    const kostSub = new Map(kostLinjer.sub_recipes.map(i => [i.line_id, i]));
    // co2Engine regner PR. PORTION; her vises hele holdet, som kost og vægt gør.
    const co2Ved = new Map(co2Linjer.ingredients.map(i => [i.line_id, i]));
    const co2Sub = new Map(co2Linjer.sub_recipes.map(i => [i.line_id, i]));
    const co2Hold = (x) => (x && x.contribution != null) ? x.contribution * (co2Linjer.base_servings || 1) : null;
    const navnP = new Map(built.data.products.map(p => [String(p.id), p.name]));
    // Enheden hører til tallet og skal komme samme sted fra. Slog editoren den
    // op selv, kunne en cachet browser vise en anden enhed end den mængden er
    // regnet i — og så står der et rigtigt tal med en forkert etiket.
    const enhedNavn = new Map((built.data.units || []).map(u => [String(u.id), u.name]));
    const navnR = new Map(built.data.recipes.map(r => [Number(r.id), r.name]));

    const linjer = [
        ...built.egnePos.map((p) => {
            const k = kostVed.get(p.id) || {};
            return {
                line_id: p.id,
                draft_index: p._i,
                kind: 'product',
                is_packaging: v.packaging_lines.has(p.id),
                product_id: p.product_id,
                qu_id_stock: p.qu_id == null ? null : Number(p.qu_id),
                unit: p.qu_id == null ? null : (enhedNavn.get(String(p.qu_id)) || null),
                name: navnP.get(String(p.product_id)) || ('#' + p.product_id),
                amount_stock: p.amount,
                section: p.ingredient_group || '',
                weight_g: v.per_line_g.get(p.id) ?? null,
                weight_estimated: false,
                cost: k.cost ?? null,
                unit_cost: k.unit_cost ?? null,
                // Prisen kommer fra opskriften bag varen, ikke fra et køb (#558).
                cost_source: k.source ?? null,
                producer_recipe_id: k.producer_recipe_id ?? null,
                co2e: co2Hold(co2Ved.get(p.id)),
                // `missing` er ikke en fejl — det gør linjens tal til et mindstetal (I3).
                missing_cost: !!k.missing,
                missing_co2: (co2Ved.get(p.id) || {}).status ? (co2Ved.get(p.id).status !== 'ok' && co2Ved.get(p.id).status !== 'na') : true,
            };
        }),
        ...built.egneNest.map((n) => {
            const k = kostSub.get(n.id) || {};
            return {
                line_id: n.id,
                draft_index: n._i,
                kind: 'sub_recipe',
                // En underopskrift tæller som mad — dens emballage hører til
                // dér hvor den bruges, ikke her.
                is_packaging: false,
                includes_recipe_id: n.includes_recipe_id,
                name: navnR.get(Number(n.includes_recipe_id)) || ('#' + n.includes_recipe_id),
                servings: n.servings,
                base_servings: k.base_servings ?? null,
                // Enheden ved mængden kommer HERFRA, ikke fra et opslag i
                // browseren (B5) — etiketten skal komme samme sted fra som
                // tallet. Opskriften siger selv hvad én portion er; er det
                // «1 antal», står der «stk» i stedet for det abstrakte
                // «portion». Er det ikke 1:1, sender vi ingen enhed, og
                // browseren bliver ved «portion» frem for at lyve om tallet.
                ...(() => {
                    const sub = built.data.recipes.find(
                        r => Number(r.id) === Number(n.includes_recipe_id));
                    const pu = RecipeYield.portionUnit(sub);
                    return { unit: pu.exact ? pu.unit : null, portion_per: pu.per };
                })(),
                // Halvfabrikatet vejer sit UDBYTTE, ikke summen af sine råvarer.
                // Er udbyttet ikke erklæret, ER tallet summen — og så siger
                // flaget det, så et skøn ikke kan læses som en måling.
                weight_g: v.per_line_g.get(n.id) ?? null,
                weight_estimated: v.estimated_lines.has(n.id),
                cost: k.cost ?? null,
                cost_source: 'sub_recipe',
                co2e: co2Hold(co2Sub.get(n.id)),
                missing_cost: !(k.complete ?? true),
                missing_co2: !((co2Sub.get(n.id) || {}).complete),
            };
        }),
    ];

    const y = draft.yield || {};
    const målvægt = num(draft.target_weight_g);

    return {
        recipe_id: built.draftId,
        is_new: draft.recipe_id == null || draft.recipe_id === '',
        servings,
        yield: {
            amount: num(y.amount),
            unit: y.unit || '',
            product_id: y.product_id == null || y.product_id === '' ? null : Number(y.product_id),
            stock_amount: k ? k.yield_amount : null,
            stock_unit: k ? k.yield_unit : null,
        },
        weight: { food_g: v.food_g, packaging_g: v.packaging_g, batch_g: v.batch_g,
                  complete: v.complete, missing: v.missing,
                  // Navnene på de underopskrifter hvis vægt er summen af deres
                  // råvarer. Tom liste = hele madvægten er erklærede udbytter.
                  estimated: v.estimated },
        target_weight_g: målvægt,
        target_weight_pct: (målvægt && målvægt > 0 && v.food_g)
            ? Math.round(v.food_g / målvægt * 1000) / 10 : null,
        cost: kost,
        co2: co2,
        lines: linjer,
        per_serving: {
            weight_g: servings ? Math.round(v.food_g / servings * 100) / 100 : null,
            cost: kost.per_serving,
            co2: co2.per_serving,
        },
        unresolved: (draft.lines || []).filter(l => l.new_product).map(l => ({
            name: l.new_product.name || '',
            blocks_save: l.new_product.qu_id_stock == null || l.new_product.qu_id_stock === '',
        })),
    };
}

/** En gemt opskrift som kladde — bruges af ækvivalenstesten og af `/editor`. */
function draftFromSaved(recipeId, g) {
    const r = (g.recipes || []).find(x => Number(x.id) === Number(recipeId));
    if (!r) return null;
    const uf = r.userfields || {};
    return {
        recipe_id: r.id,
        name: r.name,
        group: uf.grupper || '',
        base_servings: r.base_servings,
        description: r.description,
        yield: { amount: uf.recipeunitnumber, unit: uf.recipeunit, product_id: r.product_id },
        // `id` skal med: diffen kender en linje på den, og uden id ville hvert
        // Gem slette alt og oprette det forfra (#680's fejl i en ny forklædning).
        lines: (g.pos || []).filter(p => Number(p.recipe_id) === Number(recipeId))
            .map(p => ({ id: p.id, product_id: p.product_id, amount: p.amount,
                         section: p.ingredient_group, note: p.note }))
            .concat((g.nestings || []).filter(n => Number(n.recipe_id) === Number(recipeId))
                .map(n => ({ id: n.id, includes_recipe_id: n.includes_recipe_id, servings: n.servings }))),
    };
}

/* ══════════════════════════════════════════════════════════════
   Udfoldning (§6.3) — hvad bruger DENNE linje?
   ══════════════════════════════════════════════════════════════ */

/**
 * En underopskrifts råvarer, skaleret til det linjen faktisk bruger.
 *
 * Opskriften som den STÅR er sjældent det man vil vide: står der 2,75 kg
 * rødkål i batchen, men linjen bruger 25 g af udbyttet, er de 2,75 kg et
 * tal man skal regne om i hovedet for at kunne bruge til noget.
 *
 * Faktoren er IKKE en ny regel. Det er præcis den de to motorer allerede
 * skalerer med, og den udledes derfor af de samme funktioner:
 *
 *   nesting        faktor = portioner / base_servings
 *                  (`recipeCost.compute` + `resolveConsumeItems`)
 *   halvfabrikat   faktor = mængde / udbytte-i-lager-enhed
 *                  (`lineUnitCost` → `RecipeYield.yieldInStockUnits`, #558)
 *
 * ⚠️ Kan faktoren ikke bestemmes — typisk et manglende udbytte (#372) —
 * returneres `factor: null` og opskriftens EGNE mængder, med grunden.
 * Et gæt ville se ud som en måling, og udfoldningen ville vise noget andet
 * end lagertrækket gør. I3: ukendt er ikke nul.
 *
 * @param recipeId  opskriften der skal foldes ud
 * @param brug      { kind: 'nesting'|'semi', amount }  — linjen der bruger den
 * @param g         loadGrocy()-data
 * @returns null hvis opskriften ikke findes
 */
function expandUsage(recipeId, brug, g) {
    const rid = Number(recipeId);
    const recipe = (g.recipes || []).find(r => Number(r.id) === rid);
    if (!recipe) return null;

    const enhedNavn = new Map((g.units || []).map(u => [String(u.id), u.name_short || u.name]));
    const navnP = new Map((g.products || []).map(p => [String(p.id), p.name]));
    const navnR = new Map((g.recipes || []).map(r => [Number(r.id), r.name]));
    const varerById = new Map((g.products || []).map(p => [String(p.id), p]));

    const base = num(recipe.base_servings) > 0 ? num(recipe.base_servings) : 1;

    // Udbyttet i lager-enhed — SAMME kald som kostprisen bruger.
    const vare = recipe.product_id ? varerById.get(String(recipe.product_id)) : null;
    const udbytte = vare
        ? RecipeYield.yieldInStockUnits(recipe, vare, g.units, g.conversions) : null;

    let factor = null, basis = null, reason = null;
    const mængde = num(brug && brug.amount);
    if (!(Number.isFinite(mængde) && mængde > 0)) {
        reason = 'linjen har ingen mængde endnu';
    } else if (brug && brug.kind === 'nesting') {
        factor = mængde / base;
        basis = 'servings';
    } else if (udbytte != null && udbytte > 0) {
        factor = mængde / udbytte;
        basis = 'yield';
    } else {
        reason = vare
            ? 'opskriften har intet erklæret udbytte — udfyld «1 portion er»'
            : 'opskriften lægger ingen vare på lager';
    }

    const skalér = (v) => (v == null ? null : (factor == null ? v : v * factor));

    /**
     * Et skaleret tal er lille: 0,0081 kg hvidløg. Det er både ulæseligt og
     * bredt. `autoFormatAmount` er den regel råvare-modalen allerede bruger
     * (kg→g og l→ml under 1), så udfoldningen viser 8,1 g — samme sprog som
     * resten af huset, og kortere.
     *
     * `amount`/`unit` bliver stående i LAGER-enhed. Visningen lægges ved siden
     * af, for de to betyder ikke det samme: det er lager-enheden lagertrækket
     * og kostprisen regner i (B7), og et felt med to betydninger er præcis
     * dét #352 kostede.
     */
    const vis = (v, enhed) => {
        if (v == null) return null;
        const f = autoFormatAmount(v, enhed || '');
        return { amount: f.amount, unit: f.unit || enhed || null };
    };

    const lines = [
        ...(g.pos || []).filter(p => Number(p.recipe_id) === rid).map(p => ({
            kind: 'product',
            product_id: Number(p.product_id),
            name: navnP.get(String(p.product_id)) || ('#' + p.product_id),
            amount: skalér(num(p.amount)),
            unit: (() => {
                const v = varerById.get(String(p.product_id));
                return v && v.qu_id_stock != null ? (enhedNavn.get(String(v.qu_id_stock)) || null) : null;
            })(),
            section: p.ingredient_group || '',
        })),
        ...(g.nestings || []).filter(n => Number(n.recipe_id) === rid).map(n => ({
            kind: 'sub_recipe',
            includes_recipe_id: Number(n.includes_recipe_id),
            name: navnR.get(Number(n.includes_recipe_id)) || ('#' + n.includes_recipe_id),
            amount: skalér(num(n.servings)),
            unit: 'portion',
            section: '',
        })),
    ];

    for (const x of lines) {
        const d = vis(x.amount, x.unit);
        x.display_amount = d ? d.amount : null;
        x.display_unit = d ? d.unit : x.unit;
    }

    const brugtVis = vis(Number.isFinite(mængde) ? mængde : null,
                         basis === 'servings' ? '' : (vare && vare.qu_id_stock != null
                             ? (enhedNavn.get(String(vare.qu_id_stock)) || '') : ''));
    const udbytteVis = vis(udbytte, vare && vare.qu_id_stock != null
                           ? (enhedNavn.get(String(vare.qu_id_stock)) || '') : '');

    return {
        recipe_id: rid,
        name: recipe.name || ('#' + rid),
        base_servings: base,
        // Skaleret eller ej — frontenden må ALDRIG selv gætte hvilket af de to
        // den har fået. Derfor står det på svaret og ikke i en README.
        scaled: factor != null,
        factor,
        factor_basis: basis,
        reason,
        used_amount: Number.isFinite(mængde) ? mængde : null,
        used_display: brugtVis,
        yield: { stock_amount: udbytte, stock_unit: vare && vare.qu_id_stock != null
                 ? (enhedNavn.get(String(vare.qu_id_stock)) || null) : null,
                 display: udbytteVis },
        lines,
    };
}

module.exports = { buildInputs, computeDraft, draftFromSaved, expandUsage,
                   loadGrocy, weights, SENTINEL_BASE };
