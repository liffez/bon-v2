const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');

// GET /api/customers
router.get('/', handle((req, res) => {
    const db = getDb();
    const { q } = req.query;
    const where = q ? `WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR co.name LIKE ? OR c.email LIKE ?` : '';
    const args  = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : [];
    res.json(db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.is_active,
               co.name AS company_name, co.id AS company_id
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        ${where}
        ORDER BY c.first_name LIMIT 100
    `).all(...args));
}));

// GET /api/customers/:id
router.get('/:id', handle((req, res) => {
    const db = getDb();
    const c = db.prepare(`
        SELECT c.*, co.name AS company_name, co.cvr, co.ean, co.invoice_method
        FROM customers c LEFT JOIN companies co ON c.company_id = co.id
        WHERE c.id = ?
    `).get(parseInt(req.params.id));
    if (!c) return res.status(404).json({ error: 'Kunde ikke fundet' });

    c.recent_bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code, b.total_units
        FROM bons b JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.customer_id = ? ORDER BY b.delivery_date DESC LIMIT 10
    `).all(c.id);

    res.json(c);
}));

module.exports = router;
