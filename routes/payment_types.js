const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, invalidateNonRevenueCache } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

// GET /api/payment-types
router.get('/', (req, res) => {
    const db = getDb();
    const types = db.prepare(
        'SELECT id, code, label, sort_order, COALESCE(counts_as_revenue, 1) AS counts_as_revenue FROM payment_types WHERE is_active = 1 ORDER BY sort_order'
    ).all();
    res.json(types);
});

// POST /api/payment-types
router.post('/', requireAuth('admin'), handle((req, res) => {
    const { code, label, sort_order, counts_as_revenue } = req.body;
    if (!code || !label) return res.status(400).json({ error: 'code og label er påkrævet' });

    const db = getDb();
    const existing = db.prepare('SELECT id FROM payment_types WHERE code = ?').get(code);
    if (existing) return res.status(409).json({ error: 'Kode findes allerede' });

    const cr = counts_as_revenue === 0 || counts_as_revenue === false || counts_as_revenue === '0' ? 0 : 1;
    const result = db.prepare(
        'INSERT INTO payment_types (code, label, sort_order, is_active, counts_as_revenue) VALUES (?, ?, ?, 1, ?)'
    ).run(code, label, sort_order || 0, cr);
    invalidateNonRevenueCache();

    res.status(201).json({ id: Number(result.lastInsertRowid), code, label, sort_order: sort_order || 0, counts_as_revenue: cr });
}));

// PATCH /api/payment-types/:id
router.patch('/:id', requireAuth('admin'), handle((req, res) => {
    const { label, counts_as_revenue } = req.body;
    const db = getDb();
    const type = db.prepare('SELECT id FROM payment_types WHERE id = ?').get(req.params.id);
    if (!type) return res.status(404).json({ error: 'Betalingstype ikke fundet' });

    if (label !== undefined) {
        db.prepare('UPDATE payment_types SET label = ? WHERE id = ?').run(label, req.params.id);
    }
    if (counts_as_revenue !== undefined) {
        const cr = counts_as_revenue === 0 || counts_as_revenue === false || counts_as_revenue === '0' ? 0 : 1;
        db.prepare('UPDATE payment_types SET counts_as_revenue = ? WHERE id = ?').run(cr, req.params.id);
        invalidateNonRevenueCache();
    }

    const updated = db.prepare('SELECT id, code, label, sort_order, COALESCE(counts_as_revenue, 1) AS counts_as_revenue FROM payment_types WHERE id = ?').get(req.params.id);
    res.json(updated);
}));

module.exports = router;
