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
const packSizeGuard = require('../services/packSizeGuard');
const { getDb } = require('../db/database');
const { refreshRecipeUnitCountsSafe } = require('../services/recipeUnits');

// Genopbyg recipe_unit_counts efter recipe-grupper-/nesting-ændringer (boks-aware
// enheds-tælling). Fire-and-forget — grocyAdapter har allerede ryddet sin cache.
function bumpRecipeUnits() { refreshRecipeUnitCountsSafe(getDb(), 'grocy-write'); }

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
//
// #361: begge endpoints trak lager uden nogen form for idempotens. To klik, en
// dobbelt-submit eller et netværks-retry gav dobbelt træk — og trækket var
// usynligt bagefter, så det først blev opdaget ved næste fysiske optælling, og da
// som en uforklarlig difference. De to andre træk-stier var beskyttet
// (autoConsumeBonInventory via inventory_deducted, produktionsbatch via
// batch_nonce); det var kun denne der stod åben.
//
// Mønstret er produktionsbatchens: klienten genererer én nonce pr. HANDLING (ikke
// pr. forsøg). Rækken indsættes FØR trækket og virker dermed også som lock —
// UNIQUE-constrainten afgør hvem der vinder ved to samtidige klik, og taberen får
// vinderens svar frem for at trække igen.

// Reservér en nonce. Returnerer { claimed:true, logId } hvis vi ejer trækket,
// ellers { claimed:false, existing } med den rækkefølge et gentaget kald skal se.
function claimConsumeNonce(nonce, endpoint, userId, request) {
    const db = getDb();
    try {
        const r = db.prepare(`
            INSERT INTO grocy_consume_log (nonce, endpoint, user_id, state, request_json)
            VALUES (?, ?, ?, 'in_progress', ?)
        `).run(nonce, endpoint, userId || null, JSON.stringify(request));
        return { claimed: true, logId: r.lastInsertRowid };
    } catch (err) {
        // UNIQUE-brud = nonce kendt. Alt andet er en ægte DB-fejl og skal boble op:
        // vi må ALDRIG falde igennem til et træk fordi journalen svigtede.
        if (!/UNIQUE|constraint/i.test(err.message)) throw err;
        return { claimed: false, existing: db.prepare(`SELECT * FROM grocy_consume_log WHERE nonce = ?`).get(nonce) };
    }
}

function finishConsumeNonce(logId, state, response) {
    getDb().prepare(`
        UPDATE grocy_consume_log SET state = ?, response_json = ?, completed_at = datetime('now')
        WHERE id = ?
    `).run(state, JSON.stringify(response), logId);
}

// Fælles svar når nonce'en allerede er kendt.
function respondIdempotent(res, existing) {
    if (existing && existing.response_json) {
        return res.json({ ...JSON.parse(existing.response_json), idempotent: true });
    }
    // Trækket kører lige nu i en anden request. At svare 200 med et gæt ville
    // være at opfinde et resultat; 409 fortæller sandheden.
    return res.status(409).json({
        error: 'Trækket er allerede i gang for denne handling — vent på svaret.',
        code: 'CONSUME_IN_PROGRESS',
        idempotent: true,
    });
}

const NONCE_HINT = 'consume_nonce er påkrævet (idempotens mod dobbelt lagertræk). '
                 + 'Ser du denne fejl i browseren, så genindlæs siden med Cmd+Shift+R.';

// Consume via recipe lines (resolver-based: bruges af auto-consume ved LEVERET)
router.post('/consume', handle(async (req, res) => {
    const { lines, consume_nonce } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: 'lines[] er påkrævet (grocy_recipe_id + quantity)' });
    }
    if (!consume_nonce) return res.status(400).json({ error: NONCE_HINT, code: 'NONCE_REQUIRED' });

    const claim = claimConsumeNonce(consume_nonce, 'consume', req.session?.userId, { lines });
    if (!claim.claimed) return respondIdempotent(res, claim.existing);

    let payload;
    try {
        const results = await grocy.consumeRecipes(lines);
        const success = results.filter(r => r.success).length;
        const failed  = results.filter(r => !r.success).length;
        payload = { ok: failed === 0, consumed: success, failed, results };
    } catch (err) {
        // Journalen skal afspejle at trækket IKKE lykkedes, ellers ville en
        // gentagelse med samme nonce få et falsk "allerede gjort".
        finishConsumeNonce(claim.logId, 'failed', { error: err.message });
        throw err;
    }
    finishConsumeNonce(claim.logId, 'done', payload);
    res.json(payload);
}));

// Consume via per-produkt mængder (bruges af recipe-viewer frontend).
// `amount` er i LAGER-enhed: recipes_pos.amount er allerede stock-units, og
// frontenden skalerer kun med portions-multiplieren. Der er derfor intet at
// omregne her — modsat varemodtagelsen (#358), hvor tallet kom fra indkøbslisten.
router.post('/consume-products', handle(async (req, res) => {
    const { items, consume_nonce } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet (product_id + amount)' });
    }
    if (!consume_nonce) return res.status(400).json({ error: NONCE_HINT, code: 'NONCE_REQUIRED' });

    const claim = claimConsumeNonce(consume_nonce, 'consume-products', req.session?.userId, { items });
    if (!claim.claimed) return respondIdempotent(res, claim.existing);

    let payload;
    try {
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
        payload = { ok: failed === 0, consumed: success, failed, results };
    } catch (err) {
        finishConsumeNonce(claim.logId, 'failed', { error: err.message });
        throw err;
    }
    finishConsumeNonce(claim.logId, 'done', payload);
    res.json(payload);
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
    bumpRecipeUnits();   // grupper kan have ændret sig → påvirker tællbarhed
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
    const r = await grocy.createRecipeNesting(req.body);
    bumpRecipeUnits();   // ny underopskrift → kan gøre en recipe til en boks
    res.json(r);
}));

router.put('/recipes-nestings/:id', handle(async (req, res) => {
    await grocy.updateRecipeNesting(parseInt(req.params.id), req.body);
    bumpRecipeUnits();
    res.json({ ok: true });
}));

router.delete('/recipes-nestings/:id', handle(async (req, res) => {
    await grocy.deleteRecipeNesting(parseInt(req.params.id));
    bumpRecipeUnits();
    res.json({ ok: true });
}));

/* ── Lokationer + produktgrupper ──────────────────────────── */

router.get('/locations', handle(async (req, res) => {
    res.json(await grocy.getLocations());
}));

router.get('/product-groups', handle(async (req, res) => {
    res.json(await grocy.getProductGroups());
}));

/* ── Userfields meta (alle entiteter) ─────────────────────── */

router.get('/userfields', handle(async (req, res) => {
    res.json(await grocy.getUserfields());
}));

/* ── Opret produkt + QU-konvertering ─────────────────────── */

router.post('/products', handle(async (req, res) => {
    const { name, qu_id_purchase, qu_id_stock, location_id } = req.body || {};
    if (!name || !qu_id_purchase || !qu_id_stock || !location_id) {
        return res.status(400).json({ error: 'name, qu_id_purchase, qu_id_stock og location_id er påkrævet' });
    }
    const result = await grocy.createProduct(req.body);
    res.json(result);
}));

router.post('/quantity-unit-conversions', handle(async (req, res) => {
    const { product_id, from_qu_id, to_qu_id, factor } = req.body || {};
    if (!product_id || !from_qu_id || !to_qu_id || !factor) {
        return res.status(400).json({ error: 'product_id, from_qu_id, to_qu_id og factor er påkrævet' });
    }
    const result = await grocy.createQuConversion(req.body);
    // F13-guard: advar hvis den nye konvertering divergerer fra
    // pack_size_stock_unit på produktets barcodes (blokerer ikke writet).
    let packSizeWarning = null;
    try {
        packSizeWarning = await packSizeGuard.checkConversionFactor(grocy, req.body);
    } catch (err) {
        console.warn('[packSizeGuard] konverterings-tjek fejlede:', err.message);
    }
    res.json(Object.assign({}, result, { pack_size_warning: packSizeWarning }));
}));

/* ── Stock inventory (sæt eksakt mængde) ─────────────────── */

router.post('/stock/:id/inventory', handle(async (req, res) => {
    const productId = parseInt(req.params.id);
    const { amount, best_before_date } = req.body;
    if (amount == null) return res.status(400).json({ error: 'amount er påkrævet' });
    await grocy.setInventory(productId, amount, best_before_date || null);
    res.json({ ok: true, product_id: productId, new_amount: amount });
}));

/* ── Stock add (initial lagerbeholdning ved opret-produkt) ── */

router.post('/stock/:id/add', handle(async (req, res) => {
    const productId = parseInt(req.params.id);
    const { amount } = req.body || {};
    if (amount == null || amount <= 0) {
        return res.status(400).json({ error: 'amount > 0 er påkrævet' });
    }
    await grocy.addToStockFull(productId, req.body);
    res.json({ ok: true, product_id: productId, amount });
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
    const { product_id, product_amount, list_id, note } = req.body;
    if (!product_id || !product_amount) {
        return res.status(400).json({ error: 'product_id og product_amount er påkrævet' });
    }
    await grocy.addShoppingListProduct(product_id, product_amount, list_id, note);
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
    // Patch C #015: respektér err.status og err.code fra adapter
    // (createProductBarcode mapper Grocy 500-duplikater til 409+BARCODE_DUPLICATE).
    try {
        const result = await grocy.createProductBarcode(req.body);
        res.json(result);
    } catch (err) {
        if (err.status && err.status >= 400 && err.status < 600) {
            return res.status(err.status).json({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
            });
        }
        throw err; // lad handle()-wrapperen fange uventede fejl som 500
    }
}));

router.put('/product-barcodes/:id', handle(async (req, res) => {
    await grocy.updateProductBarcode(parseInt(req.params.id), req.body);
    res.json({ ok: true });
}));

router.delete('/product-barcodes/:id', handle(async (req, res) => {
    await grocy.deleteProductBarcode(parseInt(req.params.id));
    res.json({ ok: true });
}));

router.put('/userfields/product_barcodes/:id', handle(async (req, res) => {
    const id = parseInt(req.params.id);
    await grocy.updateProductBarcodeUserfields(id, req.body);
    // F13-guard: advar hvis pack_size_stock_unit divergerer fra
    // produktets enhedskonvertering (blokerer ikke writet).
    let packSizeWarning = null;
    const packSize = req.body && req.body.pack_size_stock_unit;
    if (packSize != null && packSize !== '') {
        try {
            packSizeWarning = await packSizeGuard.checkBarcodePackSize(grocy, id, packSize);
        } catch (err) {
            console.warn('[packSizeGuard] barcode-tjek fejlede:', err.message);
        }
    }
    res.json({ ok: true, pack_size_warning: packSizeWarning });
}));

router.put('/products/:id', handle(async (req, res) => {
    await grocy.updateProduct(parseInt(req.params.id), req.body);
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
