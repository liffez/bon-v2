const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { geocodeAddress } = require('../services/geocode');

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
    const id = Number(result.lastInsertRowid);

    // Geokod fire-and-forget hvis coords ikke blev sendt med (fx fra DAWA-
    // autocomplete). Et DAWA-kald må aldrig kunne blokere eller fejle
    // adressegemningen — svaret er allerede afsendt når geokodningen kører.
    if (lat == null || lon == null) {
        geocodeAddress(id).catch(err => {
            console.warn(`[addresses] geokodning af #${id} fejlede:`, err.message);
        });
    }

    res.json({ id });
});

module.exports = router;
