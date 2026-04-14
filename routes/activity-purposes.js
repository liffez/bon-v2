// routes/activity-purposes.js
// ==========================================
// CRUD for aktivitetsformål.
// ==========================================

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

router.use(requireAuth());

// ─── GET / ──────────────────────────────────────────────────
router.get('/', handle((req, res) => {
    const db = getDb();
    const includeInactive = req.query.all === '1';

    const where = includeInactive ? '' : 'WHERE is_active = 1';
    const rows = db.prepare(`
        SELECT * FROM activity_purposes ${where} ORDER BY sort_order, id
    `).all();

    res.json(rows);
}));

// ─── POST / ─────────────────────────────────────────────────
router.post('/', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const { key, label, emoji, description, sort_order } = req.body;

    if (!key || !label) return res.status(400).json({ error: 'key og label er påkrævet' });

    // Check for duplikater
    const existing = db.prepare('SELECT 1 FROM activity_purposes WHERE key = ?').get(key);
    if (existing) return res.status(409).json({ error: 'Nøgle eksisterer allerede' });

    const result = db.prepare(`
        INSERT INTO activity_purposes (key, label, emoji, description, sort_order, is_system)
        VALUES (?, ?, ?, ?, ?, 0)
    `).run(key, label, emoji || null, description || null, sort_order || 100);

    res.json({ id: Number(result.lastInsertRowid), ok: true });
}));

// ─── PATCH /:id ─────────────────────────────────────────────
router.patch('/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { label, emoji, description, sort_order, is_active } = req.body;

    const row = db.prepare('SELECT * FROM activity_purposes WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Formål ikke fundet' });

    // System-formål kan ikke deaktiveres
    if (row.is_system && is_active === 0) {
        return res.status(400).json({ error: 'Systemformål kan ikke deaktiveres' });
    }

    const updates = [];
    const params = [];

    if (label !== undefined) { updates.push('label = ?'); params.push(label); }
    if (emoji !== undefined) { updates.push('emoji = ?'); params.push(emoji); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
    if (is_active !== undefined && !row.is_system) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    if (updates.length === 0) return res.json({ ok: true });

    params.push(id);
    db.prepare(`UPDATE activity_purposes SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({ ok: true });
}));

module.exports = router;
