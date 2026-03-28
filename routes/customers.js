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

/* ── CUSTOMER MAIL ────────────────────────────────────────── */

// GET /api/customers/:id/mail
router.get('/:id/mail', handle(async (req, res) => {
    const customerId = parseInt(req.params.id);
    const db = getDb();
    const threads = db.prepare(`
        SELECT * FROM mail_threads WHERE customer_id = ? ORDER BY updated_at DESC
    `).all(customerId);

    for (const t of threads) {
        t.messages = db.prepare(`
            SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY created_at ASC
        `).all(t.id);
    }
    res.json({ threads });
}));

// POST /api/customers/:id/mail
router.post('/:id/mail', handle(async (req, res) => {
    const customerId = parseInt(req.params.id);
    const { to, subject, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to og text er påkrævet' });

    const { sendMail } = require('../services/mailService');
    const context = { type: 'customer', number: customerId };
    const userId = req.session?.user?.id || null;

    const result = await sendMail({ to, subject: subject || '', text, customerId, context, smtpPrefix: 'smtp_kontakt', userId });
    res.json({ ok: true, messageId: result.messageId, threadId: result.threadId });
}));

module.exports = router;
