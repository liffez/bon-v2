const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle, logChange } = require('../db/helpers');

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
            co.discount_percent,
            a.city AS company_city
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN addresses  a  ON co.address_id = a.id
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

// PATCH /api/customers/:id/economic — opdater e-conomic kontakt/kunde-nr
router.patch('/:id/economic', handle((req, res) => {
    const db = getDb();
    const { id } = req.params;
    const { economic_contact_id, economic_customer_id } = req.body;

    const existing = db.prepare('SELECT economic_contact_id, economic_customer_id FROM customers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Kunde ikke fundet' });

    if (economic_contact_id !== undefined) {
        db.prepare('UPDATE customers SET economic_contact_id = ? WHERE id = ?')
          .run(economic_contact_id || null, id);
        logChange({
            entityType: 'customer', entityId: Number(id), action: 'update',
            fieldName: 'economic_contact_id',
            oldValue: existing.economic_contact_id, newValue: economic_contact_id,
            userId: req.session?.user?.id,
        });
    }

    if (economic_customer_id !== undefined) {
        db.prepare('UPDATE customers SET economic_customer_id = ? WHERE id = ?')
          .run(economic_customer_id || null, id);
        logChange({
            entityType: 'customer', entityId: Number(id), action: 'update',
            fieldName: 'economic_customer_id',
            oldValue: existing.economic_customer_id, newValue: economic_customer_id,
            userId: req.session?.user?.id,
        });
    }

    res.json({ ok: true });
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
//
// Body kan indeholde {{booking_link}} — substitueres server-side via
// renderTemplate så token genereres bundet til (customer, user, flow, intent).
// Signatur appendes IKKE — fritekst-mailen er fuldt brugerstyret.
router.post('/:id/mail', handle(async (req, res) => {
    const customerId = parseInt(req.params.id);
    const { to, subject, text, booking_flow, booking_intent_meeting_type } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to og text er påkrævet' });

    const { sendMail, renderTemplate } = require('../services/mailService');
    const context = { type: 'customer', number: customerId };
    const userId = req.session?.user?.id || null;

    // Validér booking-flow whitelist
    const flow = (booking_flow === 'kontakt') ? 'kontakt' : 'smagning';

    // Process body for {{booking_link}} (og evt. fremtidige universelle vars)
    const renderedText = renderTemplate(text, {}, {
        customerId,
        userId,
        bookingFlow:   flow,
        bookingIntent: booking_intent_meeting_type || null,
        appendSignature: false
    });
    const renderedSubject = renderTemplate(subject || '', {}, {
        customerId, userId, bookingFlow: flow,
        bookingIntent: booking_intent_meeting_type || null,
        appendSignature: false
    });

    const result = await sendMail({
        to, subject: renderedSubject, text: renderedText,
        customerId, context, smtpPrefix: 'smtp_kontakt', userId
    });
    res.json({ ok: true, messageId: result.messageId, threadId: result.threadId });
}));

module.exports = router;
