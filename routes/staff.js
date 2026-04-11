/**
 * routes/staff.js
 * ════════════════════════════════════════════════════════════
 * Medarbejder-CRUD. Bruges i varemodtagelse, planlægning m.fl.
 * Adskilt fra auth-brugere (users-tabellen).
 *
 * GET    /api/staff           Aktive medarbejdere (all=1 for inkl. inaktive)
 * POST   /api/staff           Opret ny
 * PATCH  /api/staff/:id       Opdater navn/is_owner/is_active
 * DELETE /api/staff/:id       Soft delete (is_active = 0)
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

/* ── GET / — liste ───────────────────────────────────────── */

router.get('/', requireAuth(), handle((req, res) => {
    const all = req.query.all === '1';
    const sql = all
        ? 'SELECT * FROM staff ORDER BY is_owner DESC, name'
        : 'SELECT * FROM staff WHERE is_active = 1 ORDER BY is_owner DESC, name';
    res.json(getDb().prepare(sql).all());
}));

/* ── POST / — opret ─────────────────────────────────────── */

router.post('/', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const { name, is_owner } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Navn er påkrævet' });
    }

    // Tjek om medarbejder allerede findes (inkl. inaktive)
    const existing = db.prepare('SELECT * FROM staff WHERE name = ?').get(name.trim());
    if (existing) {
        if (!existing.is_active) {
            // Reaktivér
            db.prepare('UPDATE staff SET is_active = 1 WHERE id = ?').run(existing.id);
            const reactivated = db.prepare('SELECT * FROM staff WHERE id = ?').get(existing.id);
            return res.json(reactivated);
        }
        return res.status(409).json({ error: 'Medarbejder findes allerede' });
    }

    const result = db.prepare(
        'INSERT INTO staff (name, is_owner) VALUES (?, ?)'
    ).run(name.trim(), is_owner ? 1 : 0);

    res.status(201).json(
        db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid)
    );
}));

/* ── PATCH /:id — opdater ────────────────────────────────── */

router.patch('/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) return res.status(404).json({ error: 'Ikke fundet' });

    const { name, is_owner, is_active } = req.body;

    if (name !== undefined && (!name || !name.trim())) {
        return res.status(400).json({ error: 'Navn er påkrævet' });
    }

    db.prepare(`
        UPDATE staff SET
            name = COALESCE(?, name),
            is_owner = COALESCE(?, is_owner),
            is_active = COALESCE(?, is_active)
        WHERE id = ?
    `).run(
        name ? name.trim() : null,
        is_owner !== undefined ? (is_owner ? 1 : 0) : null,
        is_active !== undefined ? (is_active ? 1 : 0) : null,
        id
    );

    res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(id));
}));

/* ── DELETE /:id — soft delete ───────────────────────────── */

router.delete('/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) return res.status(404).json({ error: 'Ikke fundet' });

    db.prepare('UPDATE staff SET is_active = 0 WHERE id = ?').run(id);
    res.json({ success: true });
}));

module.exports = router;
