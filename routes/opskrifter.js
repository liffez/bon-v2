/**
 * routes/opskrifter.js
 * ════════════════════════════════════════════════════════════
 * Opskrift-editoren (CLAUDE_OPSKRIFT_DESIGNER.md §13).
 *
 * POST /api/opskrifter/beregn   — overbliksberegning på en UGEMT kladde
 * GET  /api/opskrifter/:id/editor — en gemt opskrift som kladde + dens tal
 * GET  /api/opskrifter/soeg     — ét søgefelt, tre slags træf (§6.1)
 * GET  /api/opskrifter/sektionsskabelon — foreslåede sektioner (§7)
 *
 * De to deler serialiseringsformat med vilje: `/editor` returnerer præcis det
 * objekt `/beregn` tager imod, og det er også det importeren leverer (§15).
 * Ét format betyder at editoren ikke skal kende forskel på en opskrift der
 * kommer fra Grocy, fra importen eller fra brugerens egne tastetryk.
 *
 * Beregningen har ingen egen motor — se services/recipeDraft.js for hvorfor.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const { handle } = require('../db/helpers');
const { getDb } = require('../db/database');
const grocy = require('../services/grocyAdapter');
const recipeDraft = require('../services/recipeDraft');
const recipeSearch = require('../services/recipeSearch');
const RecipeLines = require('../shared/recipe_lines');
const { writeRecipe, WriterError } = require('../services/recipeWriter');

const router = express.Router();

/**
 * Gem gennem den fælles writer.
 *
 * `WriterError` er brugerens fejl, ikke serverens — en ny vare uden lagerenhed
 * er noget man kan rette på skærmen. Den svarer 400 med `details`, så linjen
 * kan markeres dér hvor den står. Alt andet er 500.
 */
async function gem(req, res, origId) {
    const kladde = req.body || {};
    if (!Array.isArray(kladde.lines)) {
        return res.status(400).json({ error: 'kladden mangler `lines`' });
    }

    let orig = null;
    if (origId != null) {
        const g = await recipeDraft.loadGrocy();
        orig = recipeDraft.draftFromSaved(origId, g);
        if (!orig) return res.status(404).json({ error: 'opskriften findes ikke' });
    }

    // Nye varer skal have en lokation. Grocy kræver den, og kladden bærer den
    // ikke — den hører til opsætningen, ikke til opskriften.
    const lokationer = await grocy.getLocations().catch(() => []);
    const defaultLocationId = lokationer.length ? lokationer[0].id : null;

    try {
        const r = await writeRecipe(kladde, orig, { defaultLocationId });
        res.json({
            recipe_id: r.recipeId,
            wrote: r.wrote,
            change_count: r.changeCount,
            created_products: r.createdProducts,
        });
    } catch (err) {
        if (err instanceof WriterError) {
            return res.status(400).json({
                error: err.message, code: err.code, details: err.details,
                rolled_back: err.rolledBack ?? 0,
                // Det fortrydelsen IKKE kunne rydde. Tomt er det normale; står
                // der noget, skal nogen rydde op i hånden — og så skal det ses.
                orphans: err.orphans || [],
            });
        }
        throw err;
    }
}

router.post('/:id/gem', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt opskrift-id' });
    await gem(req, res, id);
}));

router.post('/ny', handle(async (req, res) => { await gem(req, res, null); }));

/**
 * Foreslåede sektioner for en opskriftsgruppe (R7.3/R7.4).
 *
 * Forslaget UDLEDES af hvad gruppens opskrifter faktisk gør — målt på
 * grocy-hq bruger 7 af 7 slidere «Emballage», mens de øvrige grupper stort
 * set ingen sektioner har. En hårdkodet liste ville foreslå noget køkkenet
 * ikke gør.
 *
 * `settings.recipe_section_templates` (JSON: gruppe → liste) overtrumfer, så
 * en ny standard kan sættes uden en kodeændring. Nøglen behøver ikke findes;
 * mangler den, gælder driften. Derfor ingen migration for en feature der skal
 * kunne være tom.
 *
 * Svaret bærer `source` og `basis`, så skærmen kan sige HVOR forslaget kommer
 * fra. Et forslag bygget på én opskrift er svagere end et bygget på syv, og
 * det skal kunne ses frem for at blive præsenteret som en regel.
 */
router.get('/sektionsskabelon', handle(async (req, res) => {
    const gruppe = String(req.query.gruppe || '');

    let templates = null;
    try {
        const raw = getDb().prepare('SELECT value FROM settings WHERE key = ?')
            .get('recipe_section_templates')?.value;
        if (raw) templates = JSON.parse(raw);
    } catch (e) {
        // En ulæselig indstilling må ikke koste forslaget — driften kan stadig
        // svare. Men den skal ses i loggen, ikke gættes om.
        console.warn('[opskrifter] recipe_section_templates kunne ikke læses:', e.message);
    }

    const [recipes, pos] = await Promise.all([
        grocy.getRecipesRaw(),
        grocy.getAllRecipesPos(),
    ]);

    res.json(Object.assign({ gruppe },
        RecipeLines.sectionTemplate(gruppe, { recipes, pos, templates })));
}));

/**
 * Ét søgefelt (§6.1). Varer, halvfabrikata og nestings i ét svar.
 *
 * Grupperingen ER beslutningen: brugeren vælger aldrig mellem "ingrediens" og
 * "underopskrift", systemet afgør det efter #270-reglen. Derfor ligger den i
 * `services/recipeSearch.js` sammen med `productionTypeOf`, ikke i browseren.
 *
 * Henter bevidst IKKE priser: søgningen fyrer ved hvert tastetryk, og
 * `getProductUnitCostDetails` spørger Grocy pr. produkt. Resten er cachet i
 * adapteren, så et opslag koster ingen netværkskald i praksis.
 */
router.get('/soeg', handle(async (req, res) => {
    const q = String(req.query.q || '');
    const exclude = req.query.exclude == null || req.query.exclude === ''
        ? null : parseInt(req.query.exclude, 10);
    if (exclude != null && !Number.isFinite(exclude)) {
        return res.status(400).json({ error: 'ugyldigt `exclude`' });
    }

    const [recipes, pos, nestings, products, units] = await Promise.all([
        grocy.getRecipesRaw(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
    ]);

    res.json(recipeSearch.searchTargets(q, { recipes, pos, nestings, products, units },
                                        { excludeRecipeId: exclude }));
}));

/**
 * Regn en kladde. Kroppen er kladden selv (§13).
 *
 * Svaret bærer `complete`-flag pr. tal. Et tal med `complete: false` er et
 * MINDSTETAL, ikke et forkert tal — frontenden skal vise det med `≥` (I3).
 */
router.post('/beregn', handle(async (req, res) => {
    const kladde = req.body || {};
    if (!Array.isArray(kladde.lines)) {
        return res.status(400).json({ error: 'kladden mangler `lines`' });
    }
    res.json(await recipeDraft.computeDraft(kladde));
}));

/**
 * Udfoldning af en underopskrift (§6.3) — skaleret til det linjen bruger.
 *
 * `brug` er linjens mængde og hvad den betyder: portioner for en nesting,
 * lager-enhed for et halvfabrikat. Faktoren udledes på serveren, fordi den er
 * den SAMME som kostprisen og lagertrækket skalerer med — en kopi i browseren
 * ville kunne skride fra dem uden at nogen opdagede det.
 *
 * Svaret siger selv om det er skaleret (`scaled`), så frontenden ikke skal
 * gætte hvilket af de to tal den har fået.
 */
router.get('/:id/indhold', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt opskrift-id' });

    const kind = req.query.kind === 'nesting' ? 'nesting' : 'semi';

    // Henter bevidst IKKE priser. Udfoldningen viser mængder, og den fyres igen
    // hver gang linjens antal ændrer sig — `loadGrocy()` ville trække
    // `getProductUnitCostDetails` med hver gang, uden at et eneste tal brugte den.
    const [recipes, pos, nestings, products, units, conversions] = await Promise.all([
        grocy.getRecipesRaw(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]);

    const ud = recipeDraft.expandUsage(id, { kind, amount: req.query.bruger },
                                       { recipes, pos, nestings, products, units, conversions });
    if (!ud) return res.status(404).json({ error: 'opskriften findes ikke' });
    res.json(ud);
}));

/**
 * En gemt opskrift som kladde. Samme form som `/beregn` tager imod, så
 * editoren kan åbne, redigere og regne uden at oversætte undervejs.
 */
router.get('/:id/editor', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt opskrift-id' });

    const g = await recipeDraft.loadGrocy();
    const kladde = recipeDraft.draftFromSaved(id, g);
    if (!kladde) return res.status(404).json({ error: 'opskriften findes ikke' });

    res.json({ draft: kladde, overview: await recipeDraft.computeDraft(kladde, g) });
}));

module.exports = router;
