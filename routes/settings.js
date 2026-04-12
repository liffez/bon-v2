const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth, invalidatePermCache } = require('../shared/auth');

// GET /api/settings
router.get('/', handle((req, res) => {
    res.json(getDb().prepare(`SELECT key, value, description FROM settings`).all());
}));

// GET /api/settings/locations
router.get('/locations', handle((req, res) => {
    const rows = getDb().prepare('SELECT id, name, code, grocy_api_url, address, is_active FROM locations ORDER BY id').all();
    res.json(rows);
}));

// PATCH /api/settings/:key
router.patch('/:key', handle((req, res) => {
    const { value } = req.body;
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`).run(req.params.key, value, value);
    res.json({ key: req.params.key, value });
}));

/* ── Rollerettigheder (admin) ────────────────────────── */

// GET /api/settings/role-permissions
router.get('/role-permissions', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const roles = ['admin', 'office', 'kitchen', 'kitchen_personal', 'delivery'];
    const result = {};
    roles.forEach(role => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?')
            .get(`role_permissions_${role}`);
        try { result[role] = row ? JSON.parse(row.value) : {}; }
        catch { result[role] = {}; }
    });
    res.json(result);
}));

// PATCH /api/settings/role-permissions/:role
router.patch('/role-permissions/:role', requireAuth('admin'), handle((req, res) => {
    const VALID_ROLES = ['office', 'kitchen', 'kitchen_personal', 'delivery'];
    if (!VALID_ROLES.includes(req.params.role)) {
        return res.status(400).json({ error: 'Ugyldig rolle eller admin kan ikke begrænses' });
    }
    const db = getDb();
    db.prepare(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
    ).run(JSON.stringify(req.body), `role_permissions_${req.params.role}`);

    invalidatePermCache();
    res.json({ ok: true });
}));

/* ── Duplikat-kandidater (admin) ──────────────────────── */

// GET /api/settings/duplicates
router.get('/duplicates', handle((req, res) => {
    const db = getDb();
    const status = req.query.status || 'pending';
    const rows = db.prepare(`
        SELECT * FROM duplicate_candidates
        WHERE status = ?
        ORDER BY created_at DESC
    `).all(status);
    res.json(rows);
}));

// GET /api/settings/duplicates/all
router.get('/duplicates/all', handle((req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM duplicate_candidates
        ORDER BY status, created_at DESC
    `).all();
    res.json(rows);
}));

// POST /api/settings/duplicates — log nyt duplikat-fund
router.post('/duplicates', handle((req, res) => {
    const db = getDb();
    const { product_id_a, product_name_a, product_id_b, product_name_b, barcode, barcode_name } = req.body;

    // Tjek om dette par allerede er logget
    const existing = db.prepare(`
        SELECT id FROM duplicate_candidates
        WHERE ((product_id_a = ? AND product_id_b = ?) OR (product_id_a = ? AND product_id_b = ?))
          AND barcode = ?
    `).get(product_id_a, product_id_b, product_id_b, product_id_a, barcode);

    if (existing) {
        return res.json({ ok: true, id: existing.id, already_logged: true });
    }

    const result = db.prepare(`
        INSERT INTO duplicate_candidates (product_id_a, product_name_a, product_id_b, product_name_b, barcode, barcode_name)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(product_id_a, product_name_a || null, product_id_b, product_name_b || null, barcode, barcode_name || null);

    res.json({ ok: true, id: result.lastInsertRowid });
}));

// PATCH /api/settings/duplicates/:id — opdater status
router.patch('/duplicates/:id', handle((req, res) => {
    const db = getDb();
    const { status, notes } = req.body;
    const userId = req.session?.user?.id || null;

    db.prepare(`
        UPDATE duplicate_candidates
        SET status = ?, notes = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_user_id = ?
        WHERE id = ?
    `).run(status, notes || null, userId, parseInt(req.params.id));

    res.json({ ok: true });
}));

module.exports = router;
