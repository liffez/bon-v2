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

/* ── Cache-styring ────────────────────────────────────────── */

router.delete('/cache', handle(async (req, res) => {
    grocy.clearCache();
    res.json({ ok: true, message: 'Grocy cache ryddet' });
}));

module.exports = router;
