// services/recipeWriter.js
// ════════════════════════════════════════════════════════════
// Den ene vej fra en opskrift-kladde til Grocy.
//
// HVORFOR ÉN WRITER
// Designeren og importeren gemmer det samme: nye varer, en opskrift, linjer og
// nestings. Skrev de hver sin vej, ville de to drive fra hinanden — og
// importen ville lære at skrive ting designeren har lært at lade være med
// (#680's udbytte-ødelæggelse er det dyreste eksempel). Forskellen mellem de
// to er alene hvor loggen lander: ved import i `import_plan_item`, i
// designeren kun under selve gem-kaldet (importspec §4.5, designer-spec §12).
//
// RÆKKEFØLGEN, OG HVORFOR DEN ER SÅDAN
//   1. Validér      — en ny vare uden lagerenhed blokerer gem (R8.4). Intet
//                     skrives, så fejlen koster ingenting.
//   2. Diff         — `shared/recipe_diff.js`. Ingen ændringer ⇒ ingen
//                     skrivninger (I4). Det er #680's værn, flyttet hertil.
//   3. Nye varer    — FØRST, og hver verificeres ved at blive læst tilbage.
//                     Grocy svarer 200 på et POST der ikke fik gemt alt; uden
//                     verifikationen ville linjen pege på en halv vare.
//   4. Opskriften   — felter, userfields, linjer, nestings.
//   5. Fortryd      — fejler noget efter skridt 3, slettes de varer VI netop
//                     oprettede, og intet af opskriften skrives.
//
// HVAD FORTRYDELSEN KAN OG IKKE KAN
// Målt mod en Grocy-instans: en netop oprettet vare kan slettes (204), også
// når en opskriftslinje allerede peger på den. Fortrydelsen er altså ægte.
// Men vi sletter KUN varer fra denne kørsels log — aldrig noget der lå der i
// forvejen. Fejler en sletning, siges det højt som `orphans` frem for at blive
// slugt: en forældreløs vare er til at rydde op i, en tavs fejl er ikke.
// ════════════════════════════════════════════════════════════

'use strict';

const grocy = require('./grocyAdapter');
const { diffRecipe, optNum } = require('../shared/recipe_diff');

/** Fejl brugeren kan gøre noget ved — ikke en serverfejl. */
class WriterError extends Error {
    constructor(message, code, details) {
        super(message);
        this.name = 'WriterError';
        this.code = code;
        this.details = details || null;
    }
}

/**
 * Skriv en kladde.
 *
 * @param draft   kladde-objektet (services/recipeDraft.js)
 * @param orig    samme form, som Grocy har den — null for en ny opskrift
 * @param opts    { defaultLocationId, onLog }
 * @returns {{ recipeId, changeCount, createdProducts, wrote, plan }}
 */
async function writeRecipe(draft, orig, opts = {}) {
    const log = opts.onLog || (() => {});
    const plan = diffRecipe(orig, draft);

    // ── 1. Validér ────────────────────────────────────────────
    if (plan.blockers.length) {
        throw new WriterError(
            plan.blockers.length + ' linje' + (plan.blockers.length === 1 ? '' : 'r') +
            ' mangler en lagerenhed og kan ikke regnes om',
            'missing_unit', plan.blockers);
    }
    const navn = (plan.recipe.name != null ? plan.recipe.name : (orig && orig.name) || '').trim();
    if (!navn) throw new WriterError('Opskriften mangler et navn', 'missing_name');

    // ── 2. Intet ændret ⇒ intet skrevet ───────────────────────
    if (plan.isEmpty) {
        log('ingen ændringer');
        return { recipeId: orig ? Number(orig.recipe_id) : null,
                 changeCount: 0, createdProducts: [], wrote: false, plan };
    }

    const oprettede = [];   // { key, id, name } — logget så de kan fortrydes
    let recipeId = orig ? Number(orig.recipe_id) : null;
    let opskriftOprettet = false;

    try {
        // ── 3. Nye varer først, hver verificeret ──────────────
        for (const np of plan.newProducts) {
            const krop = {
                name: String(np.name || '').trim(),
                qu_id_stock: Number(np.qu_id_stock),
                qu_id_purchase: Number(np.qu_id_purchase != null ? np.qu_id_purchase : np.qu_id_stock),
            };
            if (!krop.name) throw new WriterError('En ny vare mangler navn', 'missing_name', np);
            const loc = np.location_id != null ? np.location_id : opts.defaultLocationId;
            if (loc != null) krop.location_id = Number(loc);
            if (np.product_group_id != null && np.product_group_id !== '') {
                krop.product_group_id = Number(np.product_group_id);
            }

            const svar = await grocy.createProduct(krop);
            const id = svar && Number(svar.created_object_id);
            if (!id) throw new Error('Grocy returnerede intet id for "' + krop.name + '"');

            // Læs tilbage. Et POST der svarer 200 er ikke et bevis på at varen
            // står der med det den skulle have.
            const frisk = await grocy.getProductFresh(id);
            if (!frisk || Number(frisk.id) !== id) {
                throw new Error('Varen "' + krop.name + '" kunne ikke læses tilbage efter oprettelse');
            }
            if (Number(frisk.qu_id_stock) !== krop.qu_id_stock) {
                throw new Error('Varen "' + krop.name + '" fik en anden lagerenhed end den skulle');
            }

            oprettede.push({ key: np.key, id, name: krop.name });
            log('oprettede vare ' + id + ' — ' + krop.name);

            // CO₂ pr. kg hører på varen, ikke på opskriften. Fejler den, er
            // varen stadig rigtig: manglen siges som advarsel, ikke som fald.
            const co2 = optNum(np.co2e_per_unit);
            if (co2 != null) {
                try { await grocy.updateProductUserfields(id, { co2e_per_kg: String(co2) }); }
                catch (e) { log('advarsel: CO₂ blev ikke sat på ' + krop.name + ' — ' + e.message); }
            }
        }
        const idForNy = new Map(oprettede.map(p => [p.key, p.id]));

        // ── 4. Opskriften ─────────────────────────────────────
        if (plan.isNew) {
            const svar = await grocy.createRecipe({
                name: plan.recipe.name,
                description: plan.recipe.description || null,
                base_servings: plan.recipe.base_servings || 1,
                desired_servings: plan.recipe.base_servings || 1,
                not_check_shoppinglist: 0,
                type: 'normal',
                product_id: plan.recipe.product_id != null ? plan.recipe.product_id : null,
            });
            recipeId = svar && Number(svar.created_object_id);
            if (!recipeId) throw new Error('Grocy returnerede intet id for opskriften');
            opskriftOprettet = true;
            log('oprettede opskrift ' + recipeId);
        } else if (Object.keys(plan.recipe).length) {
            await grocy.updateRecipe(recipeId, plan.recipe);
        }

        if (Object.keys(plan.userfields).length) {
            await grocy.updateRecipeUserfields(recipeId, plan.userfields);
        }

        // Sletninger før oprettelser: så en linje der flyttes ikke ligger
        // dobbelt undervejs, hvis noget går galt midt i.
        for (const id of plan.posDelete) await grocy.deleteRecipePos(id);
        for (const id of plan.nestDelete) await grocy.deleteRecipeNesting(id);
        for (const p of plan.posPut) await grocy.updateRecipePos(p.id, p.body);
        for (const n of plan.nestPut) await grocy.updateRecipeNesting(n.id, n.body);

        for (const p of plan.posPost) {
            const pid = p._newProductKey ? idForNy.get(p._newProductKey) : p.product_id;
            if (!pid) throw new Error('Linjen peger ikke på nogen vare');
            const vare = await grocy.getProductFresh(pid).catch(() => null);
            await grocy.createRecipePos({
                recipe_id: recipeId,
                product_id: pid,
                amount: p.amount,
                qu_id: vare && vare.qu_id_stock != null ? vare.qu_id_stock : null,
                only_check_single_unit_in_stock: 0,
                ingredient_group: p.ingredient_group || null,
                not_check_stock_fulfillment: 0,
                variable_amount: null,
                price_factor: 1,
                round_up: 0,
            });
        }
        for (const n of plan.nestPost) {
            await grocy.createRecipeNesting({
                recipe_id: recipeId,
                includes_recipe_id: n.includes_recipe_id,
                servings: n.servings,
            });
        }

        // En ændret produceret vare flytter kostprisen på hver opskrift der
        // bruger varen (#558) — ikke kun på denne.
        if ('product_id' in plan.recipe) grocy.invalidateAllRecipeCosts();

        return { recipeId, changeCount: plan.changeCount, createdProducts: oprettede,
                 wrote: true, plan };

    } catch (err) {
        // ── 5. Fortryd ────────────────────────────────────────
        const orphans = [];
        if (opskriftOprettet && recipeId) {
            // Opskriften er vores egen, netop oprettede — den ryddes med.
            try { await grocy.deleteRecipe(recipeId); }
            catch (e) { orphans.push({ type: 'recipe', id: recipeId, error: e.message }); }
        }
        for (const p of oprettede.slice().reverse()) {
            try { await grocy.deleteProduct(p.id); log('fortrød vare ' + p.id + ' — ' + p.name); }
            catch (e) { orphans.push({ type: 'product', id: p.id, name: p.name, error: e.message }); }
        }
        const e2 = err instanceof WriterError ? err
            : new WriterError('Opskriften blev ikke gemt: ' + err.message, 'write_failed');
        e2.rolledBack = oprettede.length - orphans.filter(o => o.type === 'product').length;
        e2.orphans = orphans;   // det fortrydelsen IKKE kunne rydde — siges højt
        throw e2;
    }
}

module.exports = { writeRecipe, WriterError };
