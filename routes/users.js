const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, hashPassword } = require('../db/helpers');
const { requireAuth, invalidatePermCache } = require('../shared/auth');

router.use(requireAuth('admin'));

const USER_COLS = 'id, name, email, role, pin, mobile_pin, modules_json, is_active';

// GET /api/users
router.get('/', handle((req, res) => {
    const rows = getDb().prepare(
        `SELECT ${USER_COLS} FROM users ORDER BY id`
    ).all();
    res.json(rows);
}));

// POST /api/users
router.post('/', handle(async (req, res) => {
    const { name, email, role, password, pin, mobile_pin } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name og role er påkrævet' });

    const db = getDb();
    let passwordHash = null;
    if (password) {
        passwordHash = await hashPassword(password);
    }

    const result = db.prepare(`
        INSERT INTO users (name, email, role, pin, mobile_pin, password_hash, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(name, email || null, role, pin || null, mobile_pin || null, passwordHash);

    const user = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
        .get(Number(result.lastInsertRowid));
    res.status(201).json(user);
}));

// PATCH /api/users/:id
router.patch('/:id', handle((req, res) => {
    const { name, email, role, is_active, pin, mobile_pin, modules } = req.body;
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });

    const updates = [];
    const params = [];

    if (name !== undefined)      { updates.push('name = ?');      params.push(name); }
    if (email !== undefined)     { updates.push('email = ?');     params.push(email); }
    if (role !== undefined)      { updates.push('role = ?');      params.push(role); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (pin !== undefined)        { updates.push('pin = ?');        params.push(pin || null); }
    if (mobile_pin !== undefined) { updates.push('mobile_pin = ?'); params.push(mobile_pin || null); }

    // Per-bruger evne-overrides. `modules` er et delvist objekt af key→bool der
    // merges ind i modules_json. Værdi null fjerner override'et (falder tilbage
    // til rolle-default). Bruges bl.a. til 'modtag_backdate'.
    if (modules !== undefined && modules !== null && typeof modules === 'object') {
        let current = {};
        try { current = user.modules_json ? JSON.parse(user.modules_json) : {}; } catch { current = {}; }
        for (const [k, v] of Object.entries(modules)) {
            if (v === null) delete current[k];
            else current[k] = !!v;
        }
        updates.push('modules_json = ?');
        params.push(Object.keys(current).length > 0 ? JSON.stringify(current) : null);
    }

    if (updates.length === 0) return res.json({ ok: true });

    params.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Rettigheds-cachen (60s) skal ryddes så override slår igennem med det samme.
    invalidatePermCache();

    const updated = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
        .get(req.params.id);
    res.json(updated);
}));

// POST /api/users/:id/password
router.post('/:id/password', handle(async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password er påkrævet' });

    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });

    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    res.json({ ok: true });
}));

module.exports = router;
