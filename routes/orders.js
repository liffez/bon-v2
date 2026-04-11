/**
 * routes/orders.js
 * ════════════════════════════════════════════════════════════
 * Purchase orders — CRUD for bestillinger + mail-tråd per PO.
 * Bruger purchase_orders + purchase_order_lines tabeller (migration 005).
 * Mail-tråde via mail_threads + mail_messages (migration 018 + 034).
 *
 * Monteres i server.js som:
 *   app.use('/api/orders', require('./routes/orders'));
 *
 * Endpoints:
 *   GET    /api/orders/pending              Ventende ordrer (med unread_mail)
 *   GET    /api/orders/pending/:id          Én ordre med linjer
 *   POST   /api/orders/pending              Opret ny ordre (+ mail-tråd)
 *   PUT    /api/orders/pending/:id          Opdatér ordre
 *   DELETE /api/orders/pending/:id          Marker som modtaget
 *   GET    /api/orders/archive              Modtagne/afsluttede ordrer
 *   GET    /api/orders/pending/:id/mail     Hent mail-tråd for PO
 *   POST   /api/orders/pending/:id/mail     Send svar i PO-tråd
 *   PATCH  /api/orders/pending/:id/mail/read  Markér PO-mails som læst
 *   GET    /api/orders/mail-threads         Alle PO-tråde med mail
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

/* ── Helpers ─────────────────────────────────────────────── */

function getOrderWithLines(db, orderId) {
    const order = db.prepare(`
        SELECT po.*, s.name as supplier_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = ?
    `).get(orderId);
    if (!order) return null;

    order.lines = db.prepare(`
        SELECT pol.*, sp.product_name as supplier_product_name, sp.supplier_sku
        FROM purchase_order_lines pol
        LEFT JOIN supplier_products sp ON pol.supplier_product_id = sp.id
        WHERE pol.purchase_order_id = ?
    `).all(orderId);

    return order;
}

/* ── GET /pending ────────────────────────────────────────── */

router.get('/pending', handle((req, res) => {
    const db = getDb();
    const orders = db.prepare(`
        SELECT po.*, s.name as supplier_name, s.contact_email as supplier_email,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = po.id) as line_count,
               COALESCE((
                   SELECT COUNT(*) FROM mail_messages mm
                   JOIN mail_threads mt ON mm.thread_id = mt.id
                   WHERE mt.purchase_order_id = po.id
                     AND mm.direction = 'in'
                     AND mm.is_read = 0
               ), 0) as unread_mail
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status IN ('draft', 'sent', 'confirmed', 'partially_received')
        ORDER BY po.expected_delivery_date ASC, po.created_at DESC
    `).all();

    res.json(orders);
}));

/* ── GET /pending/:id ────────────────────────────────────── */

router.get('/pending/:id', handle((req, res) => {
    const db = getDb();
    const order = getOrderWithLines(db, parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });
    res.json(order);
}));

/* ── POST /pending ───────────────────────────────────────── */

router.post('/pending', handle(async (req, res) => {
    const db = getDb();
    const {
        supplier_id, supplier_name, location_id,
        grocy_location_id,
        order_reference, expected_delivery_date,
        notes, items, sent_via, send_email,
    } = req.body;

    // Find eller opret leverandør
    let supId = supplier_id;
    if (!supId && supplier_name) {
        let sup = db.prepare(`SELECT id FROM suppliers WHERE name = ?`).get(supplier_name);
        if (!sup) {
            const result = db.prepare(`INSERT INTO suppliers (name, integration_type) VALUES (?, 'manual')`).run(supplier_name);
            supId = result.lastInsertRowid;
        } else {
            supId = sup.id;
        }
    }

    // location_id = Ristet Rugs siteId (HQ/Trailer). NOT NULL i DB.
    // Fald-back til default_grocy_location_id fra settings hvis ikke angivet.
    let locId = location_id || null;
    if (!locId) {
        const setting = db.prepare(`SELECT value FROM settings WHERE key = 'default_grocy_location_id'`).get();
        locId = setting ? parseInt(setting.value) : 1; // 1 = HQ fallback
    }
    const userId = req.session?.user?.id || null;

    const result = db.prepare(`
        INSERT INTO purchase_orders (
            location_id, supplier_id, grocy_location_id, order_reference, status,
            expected_delivery_date, notes, sent_via,
            created_by_user_id, sent_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
        locId, supId, grocy_location_id || null, order_reference || null,
        expected_delivery_date || null,
        notes || null, sent_via || 'manual', userId
    );

    const orderId = result.lastInsertRowid;

    // Indsæt linjer
    if (Array.isArray(items) && items.length > 0) {
        const insertLine = db.prepare(`
            INSERT INTO purchase_order_lines (
                purchase_order_id, supplier_product_id, item_id,
                quantity_ordered, unit_quantity, price_per_pack, line_total,
                shopping_list_id, grocy_product_id, grocy_shopping_list_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of items) {
            insertLine.run(
                orderId,
                item.supplier_product_id || null,
                item.item_id || item.product_id || item.grocy_product_id || null,
                item.quantity_ordered || item.quantity || 0,
                item.unit_quantity || null,
                item.price_per_pack || null,
                item.line_total || null,
                null, // shopping_list_id (v2 lokal tabel — bruges ikke, har FK)
                item.grocy_product_id || null,
                item.grocy_shopping_list_id || null
            );
        }
    }

    logChange({ entityType: 'purchase_order', entityId: orderId, action: 'create', userId });
    broadcast('order_created', { id: orderId });

    const order = getOrderWithLines(db, orderId);

    // Send email if requested
    let emailSent = false;
    if (send_email && supId) {
        try {
            const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supId);
            if (supplier && supplier.contact_email) {
                const mail = require('../services/mailService');
                const today = new Date().toISOString().slice(0, 10);

                // Build vareliste
                const vareliste = (items || []).map(it => {
                    const name = it.product_name || it.name || 'Ukendt';
                    const qty  = it.quantity_ordered || it.quantity || 0;
                    const unit = it.unit || 'stk';
                    const nr   = it.barcode || it.varenr || '';
                    return `• ${name} — ${qty} ${unit}${nr ? ' (nr. ' + nr + ')' : ''}`;
                }).join('\n');

                const mailResult = await mail.sendFromTemplate({
                    templateKey: 'order_email',
                    to: supplier.contact_email,
                    vars: {
                        leverandoer: supplier.name,
                        dato: today,
                        vareliste: vareliste,
                        leveringsdato: expected_delivery_date || 'Hurtigst muligt',
                    },
                    purchaseOrderId: orderId,
                    context: { type: 'purchase_order', number: orderId },
                    userId,
                    smtpPrefix: 'smtp_kontakt',
                });

                // Update order: sent_via = email, sent_at + mail_thread_id
                db.prepare(`UPDATE purchase_orders SET sent_via = 'email', sent_at = CURRENT_TIMESTAMP, mail_thread_id = ? WHERE id = ?`)
                    .run(mailResult.threadId, orderId);
                emailSent = true;
            }
        } catch (mailErr) {
            console.error('[orders] Mail fejl:', mailErr.message);
            // Order is still created — mail failure is non-fatal
        }
    }

    // Re-fetch to include mail_thread_id
    const finalOrder = getOrderWithLines(db, orderId);
    finalOrder.email_sent = emailSent;
    res.status(201).json(finalOrder);
}));

/* ── PUT /pending/:id ────────────────────────────────────── */

router.put('/pending/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });

    const { status, notes, expected_delivery_date, order_reference } = req.body;
    const fields = [];
    const vals = [];

    if (status !== undefined)                { fields.push('status = ?'); vals.push(status); }
    if (notes !== undefined)                 { fields.push('notes = ?'); vals.push(notes); }
    if (expected_delivery_date !== undefined) { fields.push('expected_delivery_date = ?'); vals.push(expected_delivery_date); }
    if (order_reference !== undefined)        { fields.push('order_reference = ?'); vals.push(order_reference); }

    if (fields.length > 0) {
        fields.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(id);
        db.prepare(`UPDATE purchase_orders SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }

    logChange({ entityType: 'purchase_order', entityId: id, action: 'update', fieldName: 'status', oldValue: order.status, newValue: status || order.status });

    const updated = getOrderWithLines(db, id);
    res.json(updated);
}));

/* ── DELETE /pending/:id ─────────────────────────────────── */

router.delete('/pending/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });

    // Marker som modtaget (slet ikke fra DB — behold til historik)
    db.prepare(`UPDATE purchase_orders SET status = 'received', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    logChange({ entityType: 'purchase_order', entityId: id, action: 'update', fieldName: 'status', oldValue: order.status, newValue: 'received' });

    res.json({ ok: true, id, previous_status: order.status });
}));

/* ── GET /pending/:id/mail ───────────────────────────────── */

router.get('/pending/:id/mail', handle((req, res) => {
    const db = getDb();
    const poId = parseInt(req.params.id);
    const po = db.prepare('SELECT mail_thread_id FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return res.status(404).json({ error: 'Ordre ikke fundet' });

    if (!po.mail_thread_id) {
        return res.json({ thread: null, messages: [] });
    }

    const thread = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(po.mail_thread_id);
    const messages = db.prepare(`
        SELECT id, thread_id, direction, from_email, from_name, to_email, subject,
               body_text, is_read, has_attachments, sent_at, received_at, created_at
        FROM mail_messages
        WHERE thread_id = ?
        ORDER BY COALESCE(sent_at, received_at, created_at) ASC
    `).all(po.mail_thread_id);

    res.json({ thread, messages });
}));

/* ── POST /pending/:id/mail ─────────────────────────────── */

router.post('/pending/:id/mail', handle(async (req, res) => {
    const db = getDb();
    const poId = parseInt(req.params.id);
    const { body_text } = req.body;

    if (!body_text || !body_text.trim()) {
        return res.status(400).json({ error: 'body_text er påkrævet' });
    }

    const po = db.prepare(`
        SELECT po.*, s.name as supplier_name, s.contact_email
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = ?
    `).get(poId);
    if (!po) return res.status(404).json({ error: 'Ordre ikke fundet' });
    if (!po.contact_email) return res.status(400).json({ error: 'Leverandøren har ingen e-mail' });

    const userId = req.session?.user?.id || null;

    // Find latest inbound message_id for In-Reply-To header
    let inReplyTo = null;
    if (po.mail_thread_id) {
        const latest = db.prepare(`
            SELECT message_id FROM mail_messages
            WHERE thread_id = ? AND direction = 'in' AND message_id IS NOT NULL
            ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1
        `).get(po.mail_thread_id);
        if (latest) inReplyTo = latest.message_id;
    }

    const mail = require('../services/mailService');
    const result = await mail.sendMail({
        to: po.contact_email,
        subject: `Re: Bestilling fra Ristet Rug`,
        text: body_text.trim(),
        context: { type: 'purchase_order', number: poId },
        purchaseOrderId: poId,
        inReplyTo,
        smtpPrefix: 'smtp_kontakt',
        userId,
    });

    // Ensure mail_thread_id is set on PO
    if (!po.mail_thread_id && result.threadId) {
        db.prepare('UPDATE purchase_orders SET mail_thread_id = ? WHERE id = ?').run(result.threadId, poId);
    }

    res.json({ ok: true, messageId: result.messageId, threadId: result.threadId });
}));

/* ── PATCH /pending/:id/mail/read ───────────────────────── */

router.patch('/pending/:id/mail/read', handle((req, res) => {
    const db = getDb();
    const poId = parseInt(req.params.id);
    const po = db.prepare('SELECT mail_thread_id FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return res.status(404).json({ error: 'Ordre ikke fundet' });
    if (!po.mail_thread_id) return res.json({ ok: true, updated: 0 });

    const result = db.prepare(`
        UPDATE mail_messages SET is_read = 1
        WHERE thread_id = ? AND direction = 'in' AND is_read = 0
    `).run(po.mail_thread_id);

    res.json({ ok: true, updated: result.changes });
}));

/* ── GET /mail-threads ──────────────────────────────────── */

router.get('/mail-threads', handle((req, res) => {
    const db = getDb();
    const unreadOnly = req.query.unread_only === '1';

    let sql = `
        SELECT po.id as purchase_order_id,
               po.expected_delivery_date,
               po.status as po_status,
               po.sent_at,
               s.name as supplier_name,
               s.contact_email as supplier_email,
               mt.id as thread_id,
               mt.subject as thread_subject,
               mt.updated_at as thread_updated_at,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = po.id) as line_count,
               (SELECT COUNT(*) FROM mail_messages mm WHERE mm.thread_id = mt.id AND mm.direction = 'in' AND mm.is_read = 0) as unread_count,
               (SELECT mm2.body_text FROM mail_messages mm2 WHERE mm2.thread_id = mt.id ORDER BY COALESCE(mm2.sent_at, mm2.received_at, mm2.created_at) DESC LIMIT 1) as latest_snippet,
               (SELECT COUNT(*) FROM mail_messages mm3 WHERE mm3.thread_id = mt.id) as message_count
        FROM purchase_orders po
        JOIN mail_threads mt ON mt.purchase_order_id = po.id
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE mt.status = 'active'
    `;

    if (unreadOnly) {
        sql += ` AND (SELECT COUNT(*) FROM mail_messages mm WHERE mm.thread_id = mt.id AND mm.direction = 'in' AND mm.is_read = 0) > 0`;
    }

    sql += ` ORDER BY
        (SELECT COUNT(*) FROM mail_messages mm WHERE mm.thread_id = mt.id AND mm.direction = 'in' AND mm.is_read = 0) > 0 DESC,
        mt.updated_at DESC`;

    const threads = db.prepare(sql).all();

    // Truncate snippets
    for (const t of threads) {
        if (t.latest_snippet && t.latest_snippet.length > 120) {
            t.latest_snippet = t.latest_snippet.slice(0, 117) + '...';
        }
    }

    res.json(threads);
}));

/* ── GET /archive ────────────────────────────────────────── */

router.get('/archive', handle((req, res) => {
    const db = getDb();
    const days = parseInt(req.query.days) || 30;
    const supplier = req.query.supplier || null;

    let sql = `
        SELECT po.*, s.name as supplier_name,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = po.id) as line_count
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status IN ('received', 'cancelled')
          AND po.updated_at >= datetime('now', '-' || ? || ' days')
    `;
    const params = [days];

    if (supplier) {
        sql += ` AND s.name LIKE ?`;
        params.push('%' + supplier + '%');
    }

    sql += ` ORDER BY po.updated_at DESC`;

    const orders = db.prepare(sql).all(...params);
    res.json(orders);
}));

module.exports = router;
