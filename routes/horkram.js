/**
 * routes/horkram.js
 * ════════════════════════════════════════════════════════════
 * Proxy-routes til Hørkram (hoka.dk) API.
 * Monteres som /api/horkram i server.js.
 *
 * Wrapper rundt om services/hokaAdapter.js.
 * Alle endpoints kræver auth (kitchen/admin).
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { handle } = require('../db/helpers');
const hoka    = require('../services/hokaAdapter');

/* ── Health check ────────────────────────────────────────── */

router.get('/health', handle(async (req, res) => {
    if (!hoka.isConfigured()) {
        return res.json({ ok: false, configured: false, message: 'HOKA_USERNAME/HOKA_PASSWORD ikke sat i .env' });
    }
    try {
        const me = await hoka.getMe();
        res.json({
            ok: true,
            configured: true,
            user: me?.User?.DisplayName || 'Ukendt',
            authenticated: !!me?.User?.IsAuthenticated,
        });
    } catch (err) {
        res.json({ ok: false, configured: true, error: err.message });
    }
}));

/* ── Produkter ───────────────────────────────────────────── */

router.get('/search', handle(async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q parameter påkrævet' });
    res.json(await hoka.searchProducts(q));
}));

router.get('/products/snapshots', handle(async (req, res) => {
    const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0);
    const date = req.query.date || null;
    if (!ids.length) return res.status(400).json({ error: 'ids parameter påkrævet' });
    res.json(await hoka.getProductSnapshots(ids, date));
}));

router.get('/products/:id/history', handle(async (req, res) => {
    res.json(await hoka.getPurchaseHistory(parseInt(req.params.id)));
}));

router.get('/stock', handle(async (req, res) => {
    res.json(await hoka.getStock(req.query.date || null));
}));

/* ── Kurv ────────────────────────────────────────────────── */

router.get('/basket', handle(async (req, res) => {
    res.json(await hoka.getBasket());
}));

router.put('/basket', handle(async (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.status(400).json({ error: 'products[] påkrævet' });
    res.json(await hoka.putBasketProducts(products));
}));

/* ── Levering ────────────────────────────────────────────── */

router.get('/delivery-dates', handle(async (req, res) => {
    res.json(await hoka.getDeliveryDates());
}));

router.put('/delivery-date', handle(async (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date påkrævet' });
    res.json(await hoka.setDeliveryDate(date));
}));

router.get('/dropsize', handle(async (req, res) => {
    const subtotal = parseFloat(req.query.subtotal) || 0;
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date påkrævet' });
    res.json(await hoka.getDropsize(subtotal, date));
}));

/* ── Ordre ───────────────────────────────────────────────── */

router.post('/order', handle(async (req, res) => {
    const { deliveryDate, message } = req.body;
    if (!deliveryDate) return res.status(400).json({ error: 'deliveryDate påkrævet' });
    res.json(await hoka.submitOrder(deliveryDate, message || null));
}));

router.get('/orders', handle(async (req, res) => {
    res.json(await hoka.getOrders());
}));

router.get('/orders/:id', handle(async (req, res) => {
    res.json(await hoka.getOrder(req.params.id));
}));

router.get('/order-confirmation/:basketId', handle(async (req, res) => {
    res.json(await hoka.getOrderConfirmation(req.params.basketId));
}));

/* ── Favoritter ──────────────────────────────────────────── */

router.get('/favorites', handle(async (req, res) => {
    res.json(await hoka.getFavoriteLists());
}));

router.get('/favorites/:listId', handle(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    res.json(await hoka.getFavoriteList(req.params.listId, page));
}));

/* ── CO2 ─────────────────────────────────────────────────── */

router.get('/co2', handle(async (req, res) => {
    res.json(await hoka.getBasketCO2());
}));

module.exports = router;
