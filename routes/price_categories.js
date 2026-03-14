const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
    const rows = getDb().prepare(
        'SELECT id, code, label FROM price_categories WHERE is_active = 1 ORDER BY id'
    ).all();
    res.json(rows);
});

module.exports = router;
