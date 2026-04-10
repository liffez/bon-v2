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

router.get('/stock/volatile', handle(async (req, res) => {
    var days = parseInt(req.query.due_soon_days) || 5;
    res.json(await grocy.getStockVolatile(days));
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

// Consume via recipe lines (resolver-based: bruges af auto-consume ved LEVERET)
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

// Consume via per-produkt mængder (bruges af recipe-viewer frontend)
router.post('/consume-products', handle(async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet (product_id + amount)' });
    }
    const results = [];
    for (const item of items) {
        try {
            await grocy.consumeProduct(item.product_id, item.amount);
            results.push({ product_id: item.product_id, success: true });
        } catch (err) {
            results.push({ product_id: item.product_id, success: false, error: err.message });
        }
    }
    grocy.clearCache(); // Ryd stock-cache
    const success = results.filter(r => r.success).length;
    const failed  = results.filter(r => !r.success).length;
    res.json({ ok: failed === 0, consumed: success, failed, results });
}));

/* ── Recipe CRUD (write) ─────────────────────────────────── */

router.post('/recipes', handle(async (req, res) => {
    res.json(await grocy.createRecipe(req.body));
}));

router.put('/recipes/:id', handle(async (req, res) => {
    await grocy.updateRecipe(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

router.put('/recipes/:id/userfields', handle(async (req, res) => {
    await grocy.updateRecipeUserfields(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

/* ── Recipe positions (ingredients) CRUD ─────────────────── */

router.post('/recipes-pos', handle(async (req, res) => {
    res.json(await grocy.createRecipePos(req.body));
}));

router.put('/recipes-pos/:id', handle(async (req, res) => {
    await grocy.updateRecipePos(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

router.delete('/recipes-pos/:id', handle(async (req, res) => {
    await grocy.deleteRecipePos(parseInt(req.params.id));
    res.json({ ok: true });
}));

/* ── Recipe nestings (sub-recipes) CRUD ──────────────────── */

router.post('/recipes-nestings', handle(async (req, res) => {
    res.json(await grocy.createRecipeNesting(req.body));
}));

router.put('/recipes-nestings/:id', handle(async (req, res) => {
    await grocy.updateRecipeNesting(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

router.delete('/recipes-nestings/:id', handle(async (req, res) => {
    await grocy.deleteRecipeNesting(parseInt(req.params.id));
    res.json({ ok: true });
}));

/* ── Lokationer + produktgrupper ──────────────────────────── */

router.get('/locations', handle(async (req, res) => {
    res.json(await grocy.getLocations());
}));

router.get('/product-groups', handle(async (req, res) => {
    res.json(await grocy.getProductGroups());
}));

/* ── Stock inventory (sæt eksakt mængde) ─────────────────── */

router.post('/stock/:id/inventory', handle(async (req, res) => {
    const productId = parseInt(req.params.id);
    const { amount, best_before_date } = req.body;
    if (amount == null) return res.status(400).json({ error: 'amount er påkrævet' });
    await grocy.setInventory(productId, amount, best_before_date || null);
    res.json({ ok: true, product_id: productId, new_amount: amount });
}));

/* ── Produkt userfields (LastCheckedAt etc.) ─────────────── */

router.put('/products/:id/userfields', handle(async (req, res) => {
    await grocy.updateProductUserfields(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

/* ── Indkøbsliste ────────────────────────────────────────── */

router.get('/shopping-list', handle(async (req, res) => {
    res.json(await grocy.getShoppingList());
}));

router.delete('/shopping-list/:id', handle(async (req, res) => {
    await grocy.deleteShoppingListItem(parseInt(req.params.id));
    res.json({ ok: true });
}));

router.post('/shopping-list/add-product', handle(async (req, res) => {
    const { product_id, product_amount, list_id } = req.body;
    if (!product_id || !product_amount) {
        return res.status(400).json({ error: 'product_id og product_amount er påkrævet' });
    }
    await grocy.addShoppingListProduct(product_id, product_amount, list_id);
    res.json({ ok: true });
}));

router.post('/shopping-list/remove-product', handle(async (req, res) => {
    const { product_id, product_amount, list_id } = req.body;
    if (!product_id || !product_amount) {
        return res.status(400).json({ error: 'product_id og product_amount er påkrævet' });
    }
    await grocy.removeShoppingListProduct(product_id, product_amount, list_id);
    res.json({ ok: true });
}));

router.post('/shopping-list/add-missing', handle(async (req, res) => {
    const { list_id } = req.body || {};
    await grocy.addMissingProducts(list_id);
    res.json({ ok: true });
}));

router.post('/shopping-list/add-expired', handle(async (req, res) => {
    const { list_id } = req.body || {};
    await grocy.addExpiredProducts(list_id);
    res.json({ ok: true });
}));

router.post('/shopping-list/add-overdue', handle(async (req, res) => {
    const { list_id } = req.body || {};
    await grocy.addOverdueProducts(list_id);
    res.json({ ok: true });
}));

router.post('/shopping-list/clear', handle(async (req, res) => {
    const { list_id } = req.body || {};
    await grocy.clearShoppingList(list_id);
    res.json({ ok: true });
}));

router.get('/shopping-locations', handle(async (req, res) => {
    res.json(await grocy.getShoppingLocations());
}));

/* ── Produkt-barcodes ────────────────────────────────────── */

router.get('/product-barcodes', handle(async (req, res) => {
    res.json(await grocy.getProductBarcodes());
}));

router.post('/product-barcodes', handle(async (req, res) => {
    const result = await grocy.createProductBarcode(req.body);
    res.json(result);
}));

router.delete('/product-barcodes/:id', handle(async (req, res) => {
    await grocy.deleteProductBarcode(parseInt(req.params.id));
    res.json({ ok: true });
}));

/* ── Shopping list item update ───────────────────────────── */

router.put('/shopping-list/:id', handle(async (req, res) => {
    await grocy.updateShoppingListItem(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

/* ── Indkøbsliste (legacy) ──────────────────────────────── */

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
