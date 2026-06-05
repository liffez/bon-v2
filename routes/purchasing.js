/**
 * routes/purchasing.js
 * ════════════════════════════════════════════════════════════
 * Leverandør- og Grocy-lokations-management.
 *
 * Monteres i server.js som:
 *   app.use('/api/purchasing', require('./routes/purchasing'));
 *
 * VIGTIGT: /suppliers/grocy-locations routes SKAL stå FØR /suppliers/:id
 * ellers matcher Express ":id" = "grocy-locations".
 *
 * Endpoints:
 *   GET    /api/purchasing/suppliers                         Leverandører med grocy-locations
 *   GET    /api/purchasing/suppliers/grocy-locations          Grocy shopping_locations + link-status
 *   POST   /api/purchasing/suppliers/grocy-locations          Link grocy-location til supplier
 *   DELETE /api/purchasing/suppliers/grocy-locations/:id      Unlink
 *   GET    /api/purchasing/suppliers/:id                      Enkelt leverandør
 *   POST   /api/purchasing/suppliers                          Opret leverandør
 *   PATCH  /api/purchasing/suppliers/:id                      Opdater leverandør
 *   DELETE /api/purchasing/suppliers/:id                      Deaktiver leverandør
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');
const grocy = require('../services/grocyAdapter');

/* ── GET /suppliers ─────────────────────────────────────── */

/**
 * Returnerer leverandører med Grocy-handelssteder.
 * Én række pr. grocy_location_id (Inco giver 2 rækker).
 * Query: ?location_id= (Ristet Rugs siteId, fx HQ=1)
 */
router.get('/suppliers', handle((req, res) => {
    const db = getDb();
    const siteId = req.query.location_id ? parseInt(req.query.location_id) : null;

    let sql = `
        SELECT
            s.id              AS supplier_id,
            s.name            AS supplier_name,
            s.integration_type,
            s.contact_email,
            s.contact_phone,
            s.webshop_url,
            s.notes           AS supplier_notes,
            s.is_active,
            sgl.grocy_location_id,
            sgl.display_name  AS grocy_location_display_name
        FROM suppliers s
    `;

    const params = [];

    if (siteId) {
        sql += `
            INNER JOIN supplier_locations sl ON sl.supplier_id = s.id AND sl.location_id = ?
        `;
        params.push(siteId);
    }

    sql += `
        LEFT JOIN supplier_grocy_locations sgl ON sgl.supplier_id = s.id
        WHERE s.is_active = 1
        ORDER BY s.name, sgl.grocy_location_id
    `;

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
}));

/* ══════════════════════════════════════════════════════════════
   GROCY-LOCATION ROUTES — SKAL stå FØR /suppliers/:id
   ══════════════════════════════════════════════════════════════ */

/* ── GET /suppliers/grocy-locations ─────────────────────── */

/**
 * Henter alle Grocy shopping_locations + eksisterende koblings-status.
 * Bruges af bestillings-tabbens inline setup-bar.
 */
router.get('/suppliers/grocy-locations', handle(async (req, res) => {
    const db = getDb();

    // Hent fra Grocy
    const grocyLocs = await grocy.getShoppingLocations();

    // Hent eksisterende koblinger
    const linked = db.prepare(`
        SELECT sgl.*, s.name AS supplier_name
        FROM supplier_grocy_locations sgl
        JOIN suppliers s ON s.id = sgl.supplier_id
    `).all();

    const linkedMap = {};
    for (const l of linked) {
        linkedMap[l.grocy_location_id] = l;
    }

    // Hent alle suppliers til dropdown
    const suppliers = db.prepare(`
        SELECT id, name, integration_type FROM suppliers WHERE is_active = 1 ORDER BY name
    `).all();

    // Merge
    const result = grocyLocs.map(gl => {
        const link = linkedMap[gl.id] || null;
        return {
            grocy_location_id: gl.id,
            grocy_location_name: gl.name || gl.description || `Lokation ${gl.id}`,
            linked_supplier_id: link ? link.supplier_id : null,
            linked_supplier_name: link ? link.supplier_name : null,
            display_name: link ? link.display_name : null,
        };
    });

    res.json({ locations: result, suppliers });
}));

/* ── POST /suppliers/grocy-locations ────────────────────── */

/**
 * Link en Grocy shopping_location til en v2 supplier.
 * Body: { grocy_location_id, supplier_id, display_name? }
 */
router.post('/suppliers/grocy-locations', handle((req, res) => {
    const db = getDb();
    const { grocy_location_id, supplier_id, display_name } = req.body;

    if (!grocy_location_id || !supplier_id) {
        return res.status(400).json({ error: 'grocy_location_id og supplier_id er påkrævet' });
    }

    // Patch C #014 (v2): 409 ved duplikat (i stedet for silent INSERT OR REPLACE).
    // Returnerer hele eksisterende række så klient kan vise den til brugeren.
    const existing = db.prepare(`
        SELECT supplier_id, grocy_location_id, display_name
        FROM supplier_grocy_locations
        WHERE supplier_id = ? AND grocy_location_id = ?
    `).get(supplier_id, grocy_location_id);

    if (existing) {
        return res.status(409).json({
            error: 'Kobling eksisterer allerede',
            existing
        });
    }

    db.prepare(`
        INSERT INTO supplier_grocy_locations (supplier_id, grocy_location_id, display_name)
        VALUES (?, ?, ?)
    `).run(supplier_id, grocy_location_id, display_name || null);

    res.json({ ok: true, grocy_location_id, supplier_id });
}));

/* ── DELETE /suppliers/grocy-locations/:id ───────────────── */

/**
 * Fjern kobling mellem Grocy shopping_location og supplier.
 * :id er grocy_location_id (ikke tabel-PK).
 */
router.delete('/suppliers/grocy-locations/:id', handle((req, res) => {
    const db = getDb();
    const grocyLocId = parseInt(req.params.id);

    const result = db.prepare(`
        DELETE FROM supplier_grocy_locations WHERE grocy_location_id = ?
    `).run(grocyLocId);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Kobling ikke fundet' });
    }

    res.json({ ok: true, grocy_location_id: grocyLocId });
}));

/* ══════════════════════════════════════════════════════════════
   SUPPLIER :id ROUTES — EFTER grocy-locations
   ══════════════════════════════════════════════════════════════ */

/* ── GET /suppliers/mail-overview ───────────────────────────
   Skal mountes FØR /suppliers/:id for at undgå route-konflikt.
   Liste over alle aktive supplier-tråde + ulæst-tæller.
   ───────────────────────────────────────────────────────── */

router.get('/suppliers/mail-overview', handle((req, res) => {
    const db = getDb();
    const onlyUnread = req.query.unread_only === '1';

    const sql = `
        SELECT s.id AS supplier_id, s.name AS supplier_name, s.contact_email AS supplier_email,
               mt.id AS thread_id, mt.subject, mt.updated_at,
               (SELECT COUNT(*) FROM mail_messages WHERE thread_id = mt.id AND is_read = 0 AND direction = 'in') AS unread_count,
               (SELECT body_text FROM mail_messages WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1) AS last_body,
               (SELECT direction FROM mail_messages WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1) AS last_direction,
               (SELECT created_at FROM mail_messages WHERE thread_id = mt.id ORDER BY created_at DESC LIMIT 1) AS last_at
        FROM mail_threads mt
        JOIN suppliers s ON s.id = mt.supplier_id
        WHERE mt.supplier_id IS NOT NULL
          AND mt.purchase_order_id IS NULL
          AND mt.status = 'active'
        ${onlyUnread ? 'AND (SELECT COUNT(*) FROM mail_messages WHERE thread_id = mt.id AND is_read = 0 AND direction = \'in\') > 0' : ''}
        ORDER BY mt.updated_at DESC
    `;
    res.json({ threads: db.prepare(sql).all() });
}));

/* ── GET /suppliers/:id ─────────────────────────────────── */

router.get('/suppliers/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!supplier) return res.status(404).json({ error: 'Leverandør ikke fundet' });

    // Include grocy-location links
    const links = db.prepare(`
        SELECT grocy_location_id, display_name
        FROM supplier_grocy_locations WHERE supplier_id = ?
    `).all(id);
    supplier.grocy_locations = links;

    res.json(supplier);
}));

/* ── POST /suppliers ───────────────────────────────────── */

router.post('/suppliers', handle((req, res) => {
    const db = getDb();
    const { name, integration_type, contact_email, contact_phone, webshop_url, notes } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Navn er påkrævet' });
    }

    // Patch C #013: eksplicit 400 ved ugyldig integration_type (i stedet for
    // silent fallback til 'manual'). undefined/null tillades — defaulter til DB-default.
    const VALID_INTEGRATION_TYPES = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];
    if (integration_type && !VALID_INTEGRATION_TYPES.includes(integration_type)) {
        return res.status(400).json({
            error: `Ugyldig integration_type: '${integration_type}'. Tilladte værdier: ${VALID_INTEGRATION_TYPES.join(', ')}`
        });
    }
    const type = integration_type || 'manual';

    const result = db.prepare(`
        INSERT INTO suppliers (name, integration_type, contact_email, contact_phone, webshop_url, notes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), type, contact_email || null, contact_phone || null, webshop_url || null, notes || null);

    const newSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(newSupplier);
}));

/* ── PATCH /suppliers/:id ──────────────────────────────── */

router.patch('/suppliers/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Leverandør ikke fundet' });

    const VALID_INTEGRATION_TYPES = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];

    // Patch C #013: eksplicit 400 ved ugyldig integration_type (i stedet for at
    // springe feltet silently over). Tjekkes før loopet så fejlen er tydelig.
    if (req.body.integration_type !== undefined
        && !VALID_INTEGRATION_TYPES.includes(req.body.integration_type)) {
        return res.status(400).json({
            error: `Ugyldig integration_type: '${req.body.integration_type}'. Tilladte værdier: ${VALID_INTEGRATION_TYPES.join(', ')}`
        });
    }

    // Patch C v2: name='' eller non-string → eksplicit 400 (ikke silent-skip)
    if (req.body.name !== undefined
        && (typeof req.body.name !== 'string' || !req.body.name.trim())) {
        return res.status(400).json({ error: 'Navn skal være en ikke-tom streng' });
    }

    const fields = {};
    const allowed = ['name', 'integration_type', 'contact_email', 'contact_phone', 'webshop_url', 'notes', 'is_active'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            fields[key] = req.body[key];
        }
    }

    if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'Ingen gyldige felter at opdatere' });
    }

    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(fields);
    db.prepare(`UPDATE suppliers SET ${sets} WHERE id = ?`).run(...vals, id);

    const updated = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    res.json(updated);
}));

/* ── DELETE /suppliers/:id ─────────────────────────────── */

router.delete('/suppliers/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Leverandør ikke fundet' });

    // Count linked grocy-locations for warning
    const linkCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM supplier_grocy_locations WHERE supplier_id = ?'
    ).get(id).cnt;

    // Soft delete
    db.prepare('UPDATE suppliers SET is_active = 0 WHERE id = ?').run(id);

    res.json({ ok: true, deactivated: true, linked_locations: linkCount });
}));

/* ──────────────────────────────────────────────────────────
   SUPPLIER MAIL — fri kommunikation med leverandøren
   (uafhængigt af PO — fx forespørgsler, reklamationer, aftaler)
   ────────────────────────────────────────────────────────── */

const mailService = require('../services/mailService');

/**
 * GET /suppliers/:id/mail
 * Hent den aktive supplier-tråd (eller {thread:null} hvis ingen).
 */
router.get('/suppliers/:id/mail', handle((req, res) => {
    const db = getDb();
    const supplierId = parseInt(req.params.id);

    const supplier = db.prepare('SELECT id, name, contact_email, notes FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) return res.status(404).json({ error: 'Leverandør ikke fundet' });

    const thread = db.prepare(
        `SELECT id, subject, created_at, updated_at FROM mail_threads
         WHERE supplier_id = ? AND purchase_order_id IS NULL AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`
    ).get(supplierId);

    if (!thread) {
        return res.json({ supplier, thread: null, messages: [] });
    }

    const messages = db.prepare(
        `SELECT mm.id, mm.direction, mm.from_email, mm.from_name, mm.to_email, mm.subject, mm.body_text, mm.body_html,
                mm.is_read, mm.sent_at, mm.received_at, mm.created_at, mm.has_attachments,
                (SELECT json_group_array(json_object('id', ma.id, 'filename', ma.filename, 'mime_type', ma.mime_type, 'size_bytes', ma.size_bytes, 'content_id', ma.content_id, 'is_inline', ma.is_inline))
                 FROM mail_attachments ma WHERE ma.message_id = mm.id) as attachments_json
         FROM mail_messages mm WHERE mm.thread_id = ? ORDER BY mm.created_at ASC`
    ).all(thread.id);
    messages.forEach(m => {
        m.attachments = m.attachments_json ? JSON.parse(m.attachments_json) : [];
        delete m.attachments_json;
    });

    res.json({ supplier, thread, messages });
}));

/**
 * GET /suppliers/:id/mail-threads
 * Liste over alle (også arkiverede) supplier-tråde for én leverandør.
 */
router.get('/suppliers/:id/mail-threads', handle((req, res) => {
    const db = getDb();
    const supplierId = parseInt(req.params.id);

    const threads = db.prepare(
        `SELECT mt.id, mt.subject, mt.status, mt.created_at, mt.updated_at,
                (SELECT COUNT(*) FROM mail_messages WHERE thread_id = mt.id) AS msg_count,
                (SELECT COUNT(*) FROM mail_messages WHERE thread_id = mt.id AND is_read = 0 AND direction = 'in') AS unread_count
         FROM mail_threads mt
         WHERE mt.supplier_id = ? AND mt.purchase_order_id IS NULL
         ORDER BY mt.updated_at DESC`
    ).all(supplierId);

    res.json({ threads });
}));

/**
 * POST /suppliers/:id/mail
 * Send mail til leverandøren via kontakt@-transport.
 * Body: { subject, body, attachments?, to? (override) }
 */
router.post('/suppliers/:id/mail', handle(async (req, res) => {
    const db = getDb();
    const supplierId = parseInt(req.params.id);
    const { subject, body, attachments, to } = req.body || {};

    const supplier = db.prepare('SELECT id, name, contact_email, notes FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) return res.status(404).json({ error: 'Leverandør ikke fundet' });

    const recipient = (to && to.trim()) || supplier.contact_email;
    if (!recipient) {
        return res.status(400).json({ error: 'Ingen modtager — leverandøren har ikke en email-adresse, og ingen "to" blev angivet.' });
    }
    if (!subject || !body) return res.status(400).json({ error: 'subject og body er påkrævet' });

    const userId = req.session?.user?.id || null;

    const result = await mailService.sendMail({
        to: recipient,
        subject,
        text: body,
        context: { type: 'supplier', number: supplierId },
        supplierId,
        smtpPrefix: 'smtp_kontakt',
        userId,
        attachments: attachments || []
    });

    res.json({ ok: true, thread_id: result.threadId, message_id: result.messageId, subject: result.subject });
}));

/**
 * PATCH /suppliers/:id/mail/read
 * Markér alle indgående beskeder i den aktive supplier-tråd som læst.
 */
router.patch('/suppliers/:id/mail/read', handle((req, res) => {
    const db = getDb();
    const supplierId = parseInt(req.params.id);

    const thread = db.prepare(
        `SELECT id FROM mail_threads
         WHERE supplier_id = ? AND purchase_order_id IS NULL AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`
    ).get(supplierId);

    if (!thread) return res.json({ ok: true, updated: 0 });

    const result = db.prepare(
        `UPDATE mail_messages SET is_read = 1
         WHERE thread_id = ? AND is_read = 0 AND direction = 'in'`
    ).run(thread.id);

    res.json({ ok: true, updated: result.changes });
}));

module.exports = router;
