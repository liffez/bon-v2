const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');

// GET /api/settings
router.get('/', handle((req, res) => {
    res.json(getDb().prepare(`SELECT key, value, description FROM settings`).all());
}));

// PATCH /api/settings/:key
router.patch('/:key', handle((req, res) => {
    const { value } = req.body;
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`).run(req.params.key, value, value);
    res.json({ key: req.params.key, value });
}));

module.exports = router;
