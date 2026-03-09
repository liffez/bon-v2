// kitchen/api.js
// ==========================================
// Kitchen API-routes
// Monteret på /api/kitchen i server.js
//
// NB: hedder api.js — ikke orders.js — for
// ikke at kollidere med kitchen/orders.html
// ==========================================

const express          = require('express');
const router           = express.Router();
const { getDb }        = require('../db/database');
const { logChange, handle } = require('../db/helpers');
const sse              = require('../shared/sse');

// ── GET /api/kitchen/today ────────────────
router.get('/today', handle((req, res) => {
    const db   = getDb();
    const bons = db.prepare(`SELECT * FROM v_kitchen_today`).all();

    if (bons.length === 0) return res.json([]);

    const ids   = bons.map(b => b.id);
    const lines = db.prepare(
        `SELECT * FROM bon_lines WHERE bon_id IN (${ids.map(() => '?').join(',')}) ORDER BY bon_id, sort_order`
    ).all(...ids);

    const byBon = {};
    for (const l of lines) {
        (byBon[l.bon_id] ??= []).push(l);
    }

    res.json(bons.map(b => ({ ...b, lines: byBon[b.id] ?? [] })));
}));

// ── GET /api/kitchen/today/totals ─────────
router.get('/today/totals', handle((req, res) => {
    res.json(getDb().prepare(`SELECT * FROM v_category_totals_today`).all());
}));

// ── GET /api/kitchen/later ────────────────
router.get('/later', handle((req, res) => {
    const db   = getDb();
    const bons = db.prepare(`SELECT * FROM v_kitchen_later`).all();

    if (bons.length === 0) return res.json([]);

    const ids   = bons.map(b => b.id);
    const lines = db.prepare(
        `SELECT * FROM bon_lines WHERE bon_id IN (${ids.map(() => '?').join(',')}) ORDER BY bon_id, sort_order`
    ).all(...ids);

    const byBon = {};
    for (const l of lines) {
        (byBon[l.bon_id] ??= []).push(l);
    }

    res.json(bons.map(b => ({ ...b, lines: byBon[b.id] ?? [] })));
}));

// ── GET /api/kitchen/bons/:id ─────────────
router.get('/bons/:id', handle((req, res) => {
    const db  = getDb();
    const bon = db.prepare(`
        SELECT b.*, s.code AS status_code, s.label AS status_label, s.color AS status_color,
               c.first_name || ' ' || COALESCE(c.last_name,'') AS customer_name,
               co.name AS company_name
        FROM bons b
        JOIN status_definitions s ON b.status_id = s.id
        LEFT JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE b.id = ?
    `).get(req.params.id);

    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const lines = db.prepare(
        `SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order`
    ).all(bon.id);

    // Tilladte transitions fra nuværende status
    const transitions = db.prepare(`
        SELECT sd.code, sd.label, sd.color,
               st.requires_confirmation, st.confirmation_message, st.triggers_json
        FROM status_transitions st
        JOIN status_definitions sd ON st.to_status_id = sd.id
        WHERE st.from_status_id = (SELECT id FROM status_definitions WHERE code = ?)
          AND st.is_active = 1
        ORDER BY sd.sort_order
    `).all(bon.status_code);

    res.json({ ...bon, lines, transitions });
}));

// ── POST /api/kitchen/bons/:id/status ─────
router.post('/bons/:id/status', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const { to_status_code, user_id } = req.body;

    const bon = db.prepare(`
        SELECT b.id, b.bon_number, s.code AS status_code
        FROM bons b JOIN status_definitions s ON b.status_id = s.id
        WHERE b.id = ?
    `).get(bonId);

    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const transition = db.prepare(`
        SELECT st.requires_confirmation, sd.id AS new_status_id, sd.code
        FROM status_transitions st
        JOIN status_definitions sd ON st.to_status_id = sd.id
        WHERE st.from_status_id = (SELECT id FROM status_definitions WHERE code = ?)
          AND sd.code = ?
          AND st.is_active = 1
    `).get(bon.status_code, to_status_code);

    if (!transition) {
        return res.status(400).json({
            error: `Ugyldig transition: ${bon.status_code} → ${to_status_code}`
        });
    }

    db.prepare(`UPDATE bons SET status_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(transition.new_status_id, bonId);

    logChange({
        entityType: 'bon', entityId: bonId,
        action: 'status_change',
        fieldName: 'status', oldValue: bon.status_code, newValue: to_status_code,
        userId: user_id
    });

    sse.broadcast('bon_updated', {
        bon_id: bonId, bon_number: bon.bon_number, new_status: to_status_code
    }, String(user_id));

    res.json({ ok: true, new_status: to_status_code });
}));

// ── POST /api/kitchen/bons/:id/prep ───────
router.post('/bons/:id/prep', handle((req, res) => {
    const db    = getDb();
    const bonId = parseInt(req.params.id);
    const { ingredients_ready, supplies_ready, user_id } = req.body;

    db.prepare(`
        UPDATE bons SET prep_ingredients_ready=?, prep_supplies_ready=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
    `).run(ingredients_ready ? 1 : 0, supplies_ready ? 1 : 0, bonId);

    sse.broadcast('bon_updated', { bon_id: bonId, prep: true }, String(user_id));
    res.json({ ok: true });
}));

// ── GET /api/kitchen/notifications ────────
router.get('/notifications', handle((req, res) => {
    const db     = getDb();
    const userId = req.query.user_id;

    const rows = db.prepare(`
        SELECT n.id, n.bon_id, b.bon_number, n.message, n.priority, n.created_at,
               u.name AS sent_by
        FROM notifications n
        LEFT JOIN bons b ON n.bon_id = b.id
        LEFT JOIN users u ON n.sent_by_user_id = u.id
        WHERE n.id NOT IN (
            SELECT notification_id FROM notification_reads WHERE user_id = ?
        )
        ORDER BY n.created_at DESC
    `).all(userId);

    res.json(rows);
}));

// ── POST /api/kitchen/notifications ───────
router.post('/notifications', handle((req, res) => {
    const db = getDb();
    const { bon_id, message, priority = 'normal', sent_by_user_id } = req.body;

    const result = db.prepare(`
        INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
        VALUES (?, 'flyver', ?, ?, ?)
    `).run(bon_id, message, priority, sent_by_user_id);

    const bon = bon_id ? db.prepare(`SELECT bon_number FROM bons WHERE id=?`).get(bon_id) : null;

    sse.broadcast('flyver', {
        id: result.lastInsertRowid,
        bon_id, bon_number: bon?.bon_number,
        message, priority
    }, String(sent_by_user_id));

    res.status(201).json({ id: result.lastInsertRowid });
}));

// ── POST /api/kitchen/notifications/:id/read
router.post('/notifications/:id/read', handle((req, res) => {
    const { user_id } = req.body;
    getDb().prepare(`
        INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)
    `).run(req.params.id, user_id);
    res.json({ ok: true });
}));

module.exports = router;
