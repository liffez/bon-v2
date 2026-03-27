/**
 * routes/grocy.js
 * ════════════════════════════════════════════════════════════
 * Readonly proxy til Grocy API.
 * Monteres som /api/grocy i server.js.
 *
 * Alle endpoints bruger services/grocyAdapter.js
 * der håndterer credentials, caching og fejlhåndtering.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { handle } = require('../db/helpers');
const grocy    = require('../services/grocyAdapter');

/* ── Opskrifter ───────────────────────────────────────────── */

router.get('/recipes', handle(async (req, res) => {
    res.json(await grocy.getRecipes());
}));

router.get('/recipes/raw', handle(async (req, res) => {
    res.json(await grocy.getRecipesRaw());
}));

router.get('/recipes/fulfillment', handle(async (req, res) => {
    res.json(await grocy.getRecipeFulfillment());
}));

router.get('/recipes/:id/ingredients', handle(async (req, res) => {
    res.json(await grocy.getRecipeIngredients(parseInt(req.params.id)));
}));

/* ── Produkter + lager ────────────────────────────────────── */

router.get('/products', handle(async (req, res) => {
    res.json(await grocy.getProducts());
}));

router.get('/stock', handle(async (req, res) => {
    res.json(await grocy.getStock());
}));

router.get('/quantity-units', handle(async (req, res) => {
    res.json(await grocy.getQuantityUnits());
}));

router.get('/quantity-unit-conversions', handle(async (req, res) => {
    res.json(await grocy.getQuantityUnitConversions());
}));

/* ── Opskrift-data (nestings + positions) ────────────────── */

router.get('/recipes-nestings', handle(async (req, res) => {
    res.json(await grocy.getRecipeNestings());
}));

router.get('/recipes-pos/all', handle(async (req, res) => {
    res.json(await grocy.getAllRecipesPos());
}));

/* ── Lager-forbrug (consume) ─────────────────────────────── */

router.post('/consume', handle(async (req, res) => {
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: 'lines[] er påkrævet (grocy_recipe_id + quantity)' });
    }
    const results = await grocy.consumeRecipes(lines);
    const success = results.filter(r => r.success).length;
    const failed  = results.filter(r => !r.success).length;
    res.json({ ok: failed === 0, consumed: success, failed, results });
}));

/* ── Indkøbsliste (write) ────────────────────────────────── */

router.post('/shoppinglist', handle(async (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet' });
    }
    const result = await grocy.addToShoppingList(items);
    res.json({ ok: true, added: result.length });
}));

/* ── Cache-styring ────────────────────────────────────────── */

router.delete('/cache', handle(async (req, res) => {
    grocy.clearCache();
    res.json({ ok: true, message: 'Grocy cache ryddet' });
}));

module.exports = router;
