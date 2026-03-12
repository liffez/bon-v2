const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle, getBonLines } = require('../db/helpers');

// GET /api/bons/today — køkken i dag
router.get('/today', handle((req, res) => {
    const db    = getDb();
    const today = new Date().toISOString().slice(0, 10);

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.kitchen_info, b.delivery_type, b.delivery_method,
            b.prep_ingredients_ready, b.prep_supplies_ready,
            b.kitchen_selects, b.customer_collects,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            sd.icon  AS status_icon,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            c.phone  AS contact_phone,
            co.name  AS company_name,
            a.street_name || ' ' || COALESCE(a.street_nr,'') AS delivery_street,
            a.city   AS delivery_city,
            a.postal_code AS delivery_postal
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST', 'FAKTURERET', 'BETALT', 'AFSLUTTET')
        ORDER BY b.pickup_time, b.id
    `).all(today);

    for (const bon of bons) {
        bon.lines = getBonLines(bon.id);
        bon.notifications = db.prepare(`
            SELECT id, type, message, priority, created_at
            FROM notifications WHERE bon_id = ? ORDER BY created_at DESC LIMIT 5
        `).all(bon.id);
    }

    res.json(bons);
}));

// GET /api/bons/later — køkken senere (fra i morgen + N dage)
router.get('/later', handle((req, res) => {
    const db    = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const days  = parseInt(req.query.days) || 28;

    // Beregn slutdato: today + days
    const end = new Date();
    end.setDate(end.getDate() + days);
    const endDate = end.toISOString().slice(0, 10);

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.kitchen_info, b.delivery_type, b.delivery_method,
            b.prep_ingredients_ready, b.prep_supplies_ready,
            b.kitchen_selects, b.customer_collects, b.is_offer,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            sd.icon  AS status_icon,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            c.phone  AS contact_phone,
            co.name  AS company_name,
            a.street_name || ' ' || COALESCE(a.street_nr,'') AS delivery_street,
            a.city   AS delivery_city,
            a.postal_code AS delivery_postal
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
        WHERE b.delivery_date > ?
          AND b.delivery_date <= ?
          AND sd.code NOT IN ('AFLYST', 'FAKTURERET', 'BETALT', 'AFSLUTTET', 'LEVERET')
        ORDER BY b.is_offer ASC, b.delivery_date ASC, b.pickup_time ASC, b.id ASC
    `).all(today, endDate);

    for (const bon of bons) {
        bon.lines = getBonLines(bon.id);
        bon.notifications = db.prepare(`
            SELECT id, type, message, priority, created_at
            FROM notifications WHERE bon_id = ? ORDER BY created_at DESC LIMIT 5
        `).all(bon.id);
    }

    res.json(bons);
}));

module.exports = router;
