const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.post('/', (req, res) => {
    const { street_name, street_nr, postal_code, city, lat, lon, label } = req.body;
    if (!street_name) return res.status(400).json({ error: 'street_name mangler' });

    const db = getDb();
    const result = db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon, label)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        street_name,
        street_nr || null,
        postal_code || null,
        city || null,
        lat || null,
        lon || null,
        label || null
    );
    res.json({ id: Number(result.lastInsertRowid) });
});

module.exports = router;
