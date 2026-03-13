const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');

// GET /api/notifications/unread?client_id=xxx
router.get('/unread', handle((req, res) => {
    const db       = getDb();
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id er påkrævet' });

    const rows = db.prepare(`
        SELECT n.*, b.bon_number
        FROM notifications n
        JOIN bons b ON n.bon_id = b.id
        WHERE n.type = 'flyver'
          AND n.id NOT IN (
              SELECT notification_id FROM notification_reads WHERE client_id = ?
          )
        ORDER BY n.created_at DESC
    `).all(clientId);

    res.json(rows);
}));

module.exports = router;
