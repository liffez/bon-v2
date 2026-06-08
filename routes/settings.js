const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle, getUserId, invalidateUnitCountCache } = require('../db/helpers');
const { requireAuth, invalidatePermCache } = require('../shared/auth');

// GET /api/settings
router.get('/', handle((req, res) => {
    res.json(getDb().prepare(`SELECT key, value, description FROM settings`).all());
}));

// GET /api/settings/delivery-icons — parset JSON, public (alle inde-loggede)
//
// Returnerer { bike: {icon, label}, taxi: {...}, ... }. Frontends bruger denne
// til at vise leveringsmetode-ikoner ét sted, så ikoner kan ændres uden kode-deploy.
router.get('/delivery-icons', handle((req, res) => {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key='delivery_method_icons'`).get();
    if (!row) return res.json({});
    try {
        res.json(JSON.parse(row.value));
    } catch {
        res.json({});
    }
}));

// GET /api/settings/locations
router.get('/locations', handle((req, res) => {
    const rows = getDb().prepare('SELECT id, name, code, grocy_api_url, address, is_active FROM locations ORDER BY id').all();
    res.json(rows);
}));

// POST /api/settings/locations/:id/test-grocy — test forbindelse til en specifik lokation
router.post('/locations/:id/test-grocy', requireAuth('admin'), handle(async (req, res) => {
    const { getGrocyConfig } = require('../services/grocyAdapter');
    const locId = parseInt(req.params.id);
    let url, key, locationName;
    try {
        ({ url, key, locationName } = getGrocyConfig(locId));
    } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }
    try {
        const base = url.replace(/\/+$/, '');
        const r = await fetch(base + '/system/info', {
            headers: { 'GROCY-API-KEY': key, 'Accept': 'application/json' },
        });
        if (!r.ok) {
            return res.json({ ok: false, status: r.status, error: 'HTTP ' + r.status });
        }
        const info = await r.json();
        res.json({ ok: true, version: info.grocy_version?.Version || 'ukendt', locationName });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
}));

// PATCH /api/settings/:key
router.patch('/:key', handle((req, res) => {
    const { value } = req.body;
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`).run(req.params.key, value, value);
    // Invalidér cache for helpers der læser settings ved hver bon-recalc
    if (req.params.key === 'unit_count_categories') invalidateUnitCountCache();
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
    const userId = getUserId(req);

    db.prepare(`
        UPDATE duplicate_candidates
        SET status = ?, notes = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_user_id = ?
        WHERE id = ?
    `).run(status, notes || null, userId, parseInt(req.params.id));

    res.json({ ok: true });
}));

/* ── Bestilling: menu CRUD (admin) ────────────────────── */

const ALLOWED_MENU_IDS = ['standard'];

// GET /api/settings/bestilling/menu/:id — hent menu-JSON parsed
router.get('/bestilling/menu/:id', requireAuth('admin'), handle((req, res) => {
    const id = req.params.id;
    if (!ALLOWED_MENU_IDS.includes(id)) {
        return res.status(404).json({ error: 'menu_not_allowed' });
    }
    const row = getDb().prepare(
        'SELECT value FROM settings WHERE key = ?'
    ).get(`bestilling.menu_${id}`);
    if (!row) return res.status(404).json({ error: 'menu_not_found' });

    try {
        res.json(JSON.parse(row.value));
    } catch (e) {
        res.status(500).json({ error: 'menu_invalid_json', detail: e.message });
    }
}));

// PUT /api/settings/bestilling/menu/:id — gem menu-JSON med validering
router.put('/bestilling/menu/:id', requireAuth('admin'), handle((req, res) => {
    const id = req.params.id;
    if (!ALLOWED_MENU_IDS.includes(id)) {
        return res.status(404).json({ error: 'menu_not_allowed' });
    }

    const menu = req.body;
    if (!menu || typeof menu !== 'object') {
        return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) {
        return res.status(400).json({ error: 'missing_categories_or_items' });
    }

    // Valider kategori-ids
    const catIds = new Set();
    for (const c of menu.categories) {
        if (!c.id || !c.name) return res.status(400).json({ error: 'category_missing_id_or_name' });
        if (catIds.has(c.id)) return res.status(400).json({ error: 'duplicate_category_id', id: c.id });
        catIds.add(c.id);
    }

    // Valider items
    const itemIds = new Set();
    for (const it of menu.items) {
        if (!it.id || !it.name) return res.status(400).json({ error: 'item_missing_id_or_name' });
        if (itemIds.has(it.id)) return res.status(400).json({ error: 'duplicate_item_id', id: it.id });
        if (!catIds.has(it.category)) return res.status(400).json({ error: 'item_unknown_category', id: it.id, category: it.category });
        itemIds.add(it.id);
    }

    // Auto-bump version + sæt menu_id
    menu.menu_id = id;
    menu.version = new Date().toISOString().slice(0, 10);

    const json = JSON.stringify(menu);
    getDb().prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
    ).run(`bestilling.menu_${id}`, json, json);

    res.json({ ok: true, version: menu.version });
}));

module.exports = router;
