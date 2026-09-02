const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle, getUserId, logChange, transaction } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { deactivateCompanies } = require('../services/companyCleanup');

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

// PATCH /api/customers/:id   { first_name?, last_name?, company_id? }
//
// Retteventilen for en kontaktperson. Indtil nu kunne hverken navnet eller
// firmaet ændres: der fandtes kun /economic, /stage og /consent, og company_id
// kunne kun flyttes af merge-guiden (som kræver TO firmaer) eller af et script.
//
// Det ramte hver gang "Opret som lead" havde gættet — leadet får mailens
// afsendernavn og INTET firma (createPrivateLead), så en mail fra
// "Communication <communication@iuno.law>" blev til en kontakt ved navn
// Communication uden forbindelse til det IUNO-firma vi allerede kendte.
// Eneste udvej var at oprette personen forfra og lade leadet ligge.
//
// requireAuth() og ikke admin — samme begrundelse som mailtrådens /move: den
// der opdager at en kontakt sidder forkert, skal kunne rette det med det samme.
router.patch('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = getUserId(req);

    const cust = db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.company_id, co.is_personal
        FROM customers c LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = ? AND c.is_active = 1
    `).get(id);
    if (!cust) return res.status(404).json({ error: 'Kunde ikke fundet' });

    // Feltnavnet interpoleres ind i UPDATE'en nedenfor. Nøglerne kan kun komme
    // herfra og er dermed lukkede — men listen står eksplicit, så en fremtidig
    // udvidelse ikke kan åbne hullet ved et uheld (samme greb som SORT_WHITELIST
    // i routes/bons.js).
    const EDITABLE = ['first_name', 'last_name', 'company_id'];

    const b = req.body || {};
    const patch = {};

    if (b.first_name !== undefined) {
        const v = String(b.first_name || '').trim();
        // Fornavnet er kundens identitet i enhver liste og på enhver bon. Et tomt
        // felt ville efterlade en navnløs række der kun kan findes på sit id.
        if (!v) return res.status(400).json({ error: 'Fornavn må ikke være tomt' });
        patch.first_name = v;
    }
    if (b.last_name !== undefined) patch.last_name = String(b.last_name || '').trim() || null;

    if (b.company_id !== undefined) {
        if (b.company_id === null || b.company_id === '') {
            patch.company_id = null;                    // privatkunde
        } else {
            const cid = parseInt(b.company_id);
            if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Ugyldigt firma' });
            const co = db.prepare('SELECT id FROM companies WHERE id = ? AND is_active = 1').get(cid);
            if (!co) return res.status(400).json({ error: 'Firma ikke fundet' });
            patch.company_id = cid;
        }
    }

    // Kun felter der faktisk flytter sig. Ellers ville et Gem uden ændringer
    // fylde historikken med rækker der intet fortæller.
    const changed = Object.keys(patch).filter(k => (patch[k] ?? null) !== (cust[k] ?? null));
    if (!changed.length) return res.json({ ok: true, changed: [], company_cleanup: null });

    const oldCompanyId = cust.company_id;
    let cleanup = null;

    transaction(db, () => {
        for (const field of changed) {
            if (!EDITABLE.includes(field)) continue;   // kan ikke ske — se EDITABLE
            db.prepare(`UPDATE customers SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(patch[field], id);
            logChange({
                entityType: 'customer', entityId: id, action: 'update',
                fieldName: field,
                oldValue: cust[field] == null ? null : String(cust[field]),
                newValue: patch[field] == null ? null : String(patch[field]),
                userId,
                notes: field === 'company_id' ? 'flyttet til andet firma' : null,
            });
        }

        // Efterlader vi et PERSONLIGT firma tomt, lægges det væk. De rækker er
        // ikke tastet af nogen — ensurePersonalCompanies (services/rfm.js) laver
        // et pr. kunde uden firma, så uden dette hober de sig op som spøgelser
        // med den flyttede persons navn.
        //
        // Kun is_personal. Et RIGTIGT firma må aldrig forsvinde som bivirkning
        // af at en kontaktperson flyttes — dertil findes CRM → Værktøjer →
        // "Ryd tomme firmaer", hvor det er en bevidst handling. deactivateCompanies
        // gentjekker desuden hele tom-reglen, så en bon eller en mailtråd på
        // rækken freder den.
        if (changed.includes('company_id') && oldCompanyId && cust.is_personal) {
            cleanup = deactivateCompanies(db, [oldCompanyId], userId);
        }
    });

    broadcast('customer_updated', { customer_id: id, changed });
    res.json({ ok: true, changed, company_cleanup: cleanup });
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
            userId: getUserId(req),
        });
    }

    if (economic_customer_id !== undefined) {
        db.prepare('UPDATE customers SET economic_customer_id = ? WHERE id = ?')
          .run(economic_customer_id || null, id);
        logChange({
            entityType: 'customer', entityId: Number(id), action: 'update',
            fieldName: 'economic_customer_id',
            oldValue: existing.economic_customer_id, newValue: economic_customer_id,
            userId: getUserId(req),
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
            SELECT mm.*,
                   (SELECT json_group_array(json_object('id', ma.id, 'filename', ma.filename, 'mime_type', ma.mime_type, 'size_bytes', ma.size_bytes, 'content_id', ma.content_id, 'is_inline', ma.is_inline))
                    FROM mail_attachments ma WHERE ma.message_id = mm.id) as attachments_json
            FROM mail_messages mm WHERE mm.thread_id = ? ORDER BY mm.created_at ASC
        `).all(t.id);
        t.messages.forEach(m => {
            m.attachments = m.attachments_json ? JSON.parse(m.attachments_json) : [];
            delete m.attachments_json;
        });
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
    const { to, subject, text, booking_flow, booking_intent_meeting_type, attachments } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to og text er påkrævet' });

    const { sendMail, renderTemplate, validateAttachments } = require('../services/mailService');

    const att = validateAttachments(attachments);
    if (att.error) return res.status(400).json({ error: att.error });

    const context = { type: 'customer', number: customerId };
    const userId = getUserId(req);

    // Validér booking-flow whitelist
    const flow = (booking_flow === 'kontakt') ? 'kontakt' : 'smagning';

    // Process body for {{booking_link}} (og evt. fremtidige universelle vars).
    // Signaturen sættes på i sendMail — ikke her.
    const renderedText = renderTemplate(text, {}, {
        customerId,
        userId,
        bookingFlow:   flow,
        bookingIntent: booking_intent_meeting_type || null
    });
    const renderedSubject = renderTemplate(subject || '', {}, {
        customerId, userId, bookingFlow: flow,
        bookingIntent: booking_intent_meeting_type || null
    });

    const result = await sendMail({
        to, subject: renderedSubject, text: renderedText,
        customerId, context, smtpPrefix: 'smtp_kontakt', userId,
        attachments: att.list
    });
    res.json({ ok: true, messageId: result.messageId, threadId: result.threadId });
}));

module.exports = router;
