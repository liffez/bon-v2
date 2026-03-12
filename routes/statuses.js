const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');

// GET /api/statuses
router.get('/', handle((req, res) => {
    const rows = getDb().prepare(`
        SELECT id, code, label, color, icon, sort_order, is_active, is_terminal, category
        FROM status_definitions WHERE is_active = 1 ORDER BY sort_order
    `).all();
    res.json(rows);
}));

// GET /api/statuses/:code/transitions
router.get('/:code/transitions', handle((req, res) => {
    const db   = getDb();
    const from = db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(req.params.code);
    if (!from) return res.status(404).json({ error: 'Status ikke fundet' });

    const rows = db.prepare(`
        SELECT sd.id, sd.code, sd.label, sd.color, sd.icon,
               st.requires_confirmation, st.confirmation_message, st.triggers_json
        FROM status_transitions st
        JOIN status_definitions sd ON st.to_status_id = sd.id
        WHERE st.from_status_id = ? AND st.is_active = 1
        ORDER BY sd.sort_order
    `).all(from.id);
    res.json(rows);
}));

module.exports = router;
