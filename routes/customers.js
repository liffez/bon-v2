const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');

// GET /api/customers?q=&company_id=
router.get('/', handle((req, res) => {
    const db = getDb();
    const { q, company_id } = req.query;

    let where = 'WHERE c.is_active = 1';
    const args = [];

    if (q && q.length >= 2) {
        where += ` AND (
            c.first_name LIKE '%'||?||'%' OR
            c.last_name  LIKE '%'||?||'%' OR
            c.email      LIKE '%'||?||'%' OR
            co.name      LIKE '%'||?||'%' OR
            co.cvr       LIKE '%'||?||'%'
        )`;
        args.push(q, q, q, q, q);
    }

    if (company_id) {
        where += ' AND c.company_id = ?';
        args.push(parseInt(company_id));
    }

    res.json(db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name, c.last_name,
            c.phone, c.email,
            co.id AS company_id,
            co.name AS company_name,
            co.cvr, co.ean,
            co.default_payment_type,
            co.default_price_category_id,
            co.discount_percent
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        ${where}
        ORDER BY co.name, c.last_name, c.first_name
        LIMIT 20
    `).all(...args));
}));

// POST /api/customers — opret ny
router.post('/', handle((req, res) => {
    const db = getDb();
    const { first_name, last_name, phone, email, company_id, notes } = req.body;
    if (!first_name) return res.status(400).json({ error: 'Fornavn mangler' });

    const result = db.prepare(`
        INSERT INTO customers (first_name, last_name, phone, email, company_id, notes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(first_name, last_name || null, phone || null, email || null,
           company_id || null, notes || null);

    res.json({ id: result.lastInsertRowid });
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
