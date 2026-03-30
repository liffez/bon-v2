const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange } = require('../db/helpers');

// GET /api/companies?q=
router.get('/', handle((req, res) => {
    const db = getDb();
    const q = req.query.q || '';
    if (q.length < 2) return res.json([]);
    const rows = db.prepare(`
        SELECT id, name, cvr, ean, phone, email,
               default_payment_type, default_price_category_id,
               discount_percent, invoice_method
        FROM companies
        WHERE is_active = 1
          AND (name LIKE '%'||?||'%' OR cvr LIKE '%'||?||'%')
        ORDER BY name LIMIT 20
    `).all(q, q);
    res.json(rows);
}));

// GET /api/companies/:id
router.get('/:id', handle((req, res) => {
    const db = getDb();
    const row = db.prepare(`
        SELECT c.*, a.street_name, a.street_nr, a.postal_code, a.city
        FROM companies c
        LEFT JOIN addresses a ON c.address_id = a.id
        WHERE c.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Ikke fundet' });
    res.json(row);
}));

// POST /api/companies — opret ny
router.post('/', handle((req, res) => {
    const db = getDb();
    const { name, cvr, ean, phone, email, invoice_method,
            default_payment_type, default_price_category_id, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Firmanavn mangler' });

    const result = db.prepare(`
        INSERT INTO companies (name, cvr, ean, phone, email, invoice_method,
                               default_payment_type, default_price_category_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, cvr || null, ean || null, phone || null, email || null,
           invoice_method || null, default_payment_type || null,
           default_price_category_id || null, notes || null);

    res.json({ id: result.lastInsertRowid });
}));

// PATCH /api/companies/:id/economic — opdater e-conomic firma-nr
router.patch('/:id/economic', handle((req, res) => {
    const db = getDb();
    const { id } = req.params;
    const { economic_customer_id } = req.body;

    const existing = db.prepare('SELECT economic_customer_id FROM companies WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Firma ikke fundet' });

    db.prepare('UPDATE companies SET economic_customer_id = ? WHERE id = ?')
      .run(economic_customer_id || null, id);

    logChange({
        entityType: 'company',
        entityId: Number(id),
        action: 'update',
        fieldName: 'economic_customer_id',
        oldValue: existing.economic_customer_id,
        newValue: economic_customer_id,
        userId: req.session?.user?.id,
    });

    res.json({ ok: true });
}));

module.exports = router;
