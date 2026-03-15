const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

router.get('/', (req, res) => {
    const rows = getDb().prepare(
        'SELECT id, code, label FROM price_categories WHERE is_active = 1 ORDER BY id'
    ).all();
    res.json(rows);
});

// POST /api/price-categories
router.post('/', requireAuth('admin'), handle((req, res) => {
    const { code, label, sort_order } = req.body;
    if (!code || !label) return res.status(400).json({ error: 'code og label er påkrævet' });

    const db = getDb();
    const existing = db.prepare('SELECT id FROM price_categories WHERE code = ?').get(code);
    if (existing) return res.status(409).json({ error: 'Kode findes allerede' });

    const result = db.prepare(
        'INSERT INTO price_categories (code, label, is_default, is_active) VALUES (?, ?, 0, 1)'
    ).run(code, label);

    res.status(201).json({ id: Number(result.lastInsertRowid), code, label });
}));

// PATCH /api/price-categories/:id
router.patch('/:id', requireAuth('admin'), handle((req, res) => {
    const { label } = req.body;
    const db = getDb();
    const cat = db.prepare('SELECT id FROM price_categories WHERE id = ?').get(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Priskategori ikke fundet' });

    if (label !== undefined) {
        db.prepare('UPDATE price_categories SET label = ? WHERE id = ?').run(label, req.params.id);
    }

    const updated = db.prepare('SELECT id, code, label FROM price_categories WHERE id = ?').get(req.params.id);
    res.json(updated);
}));

module.exports = router;
