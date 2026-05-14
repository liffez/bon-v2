const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { sendFromTemplate } = require('../services/mailService');

// GET /api/mail/templates — tilgængelig for alle auth'd brugere
router.get('/templates', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare('SELECT id, key, label, subject, body_text, updated_at FROM mail_templates ORDER BY id').all();
    res.json(rows);
}));

router.get('/templates/:key', requireAuth(), handle((req, res) => {
    const tmpl = getDb().prepare('SELECT * FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });
    res.json(tmpl);
}));

// POST /api/mail/templates (admin) — opret ny skabelon
router.post('/templates', requireAuth('admin'), handle((req, res) => {
    const { key, label, subject, body_text } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'key og label er påkrævet' });

    // Validér key-format (kun a-z, _, -)
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
        return res.status(400).json({ error: 'key skal være lowercase bogstaver, tal, _ eller - (start med bogstav)' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(key);
    if (existing) return res.status(409).json({ error: 'Skabelon med denne nøgle findes allerede' });

    db.prepare(`
        INSERT INTO mail_templates (key, label, subject, body_text, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(key, label, subject || '', body_text || '');

    const created = db.prepare('SELECT * FROM mail_templates WHERE key = ?').get(key);
    res.status(201).json(created);
}));

// DELETE /api/mail/templates/:key (admin) — slet skabelon
router.delete('/templates/:key', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    // Beskyt system-skabeloner
    const SYSTEM_KEYS = ['booking_confirmation', 'web_order_confirmation', 'order_email'];
    if (SYSTEM_KEYS.includes(req.params.key)) {
        return res.status(400).json({ error: 'System-skabeloner kan ikke slettes' });
    }

    const tmpl = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });

    db.prepare('DELETE FROM mail_templates WHERE key = ?').run(req.params.key);
    res.json({ ok: true });
}));

// PATCH /api/mail/templates/:key (admin)
router.patch('/templates/:key', requireAuth('admin'), handle((req, res) => {
    const { label, subject, body_text } = req.body;
    const db = getDb();
    const tmpl = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });

    const updates = [];
    const params = [];
    if (label !== undefined)     { updates.push('label = ?');     params.push(label); }
    if (subject !== undefined)   { updates.push('subject = ?');   params.push(subject); }
    if (body_text !== undefined) { updates.push('body_text = ?'); params.push(body_text); }

    if (updates.length === 0) return res.json({ ok: true });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.key);
    db.prepare(`UPDATE mail_templates SET ${updates.join(', ')} WHERE key = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM mail_templates WHERE key = ?').get(req.params.key);
    res.json(updated);
}));

// Admin-only endpoints below
router.post('/test', requireAuth('admin'), handle(async (req, res) => {
    const { to, templateKey } = req.body;
    if (!to) return res.status(400).json({ error: 'to er påkrævet' });

    const key = templateKey || 'booking_confirmation';

    const dummyVars = {
        kundeNavn: 'Test Kunde',
        bonNummer: '9999',
        leveringsDato: '2026-01-01',
        leveringsTidspunkt: '12:00',
        leveringsAdresse: 'Testvej 42, 2200 København N',
        pax: '25',
        ekstraInfo: 'Dette er en testmail.',
        firmanavn: 'Ristet Rug'
    };

    try {
        const info = await sendFromTemplate({ templateKey: key, to, vars: dummyVars });
        res.json({ ok: true, messageId: info.messageId });
    } catch (mailErr) {
        return res.status(400).json({ error: mailErr.message });
    }
}));

/* ── UFORDELT INDBAKKE ────────────────────────────────────── */

// ─── BOUNCE-DETECTION HELPERS ─────────────────────────────
// Bounce-mails fra postmaster/Mailer-Daemon/antispam er kritiske: hver
// indikerer en kunde med forkert email. Vi parser den fejlede modtager
// ud af body og slår op om vi har en kunde med den email — så office
// kan kontakte kunden hurtigt for at få den korrekte adresse.

const BOUNCE_FROM_RE = /^(postmaster@|Mailer-Daemon@|MAILER-DAEMON@|.*antispam@|.*@robot\.simply\.com)/i;

function isBounceMail(fromEmail) {
    return !!fromEmail && BOUNCE_FROM_RE.test(fromEmail);
}

// Find den fejlede modtager-adresse i bounce-body. Prøver flere formater
// i prioritetsrækkefølge (DSN > Postfix > "to <email>" > sidste fallback).
function parseBouncedRecipient(bodyText) {
    if (!bodyText) return null;

    // 1. DSN-format (RFC 3464): "Final-Recipient: rfc822; user@example.com"
    let m = bodyText.match(/Final-Recipient:\s*rfc822;?\s*([^\s<>]+@[^\s<>]+)/i);
    if (m) return m[1].trim().toLowerCase();

    // 2. Original-Recipient: rfc822;...
    m = bodyText.match(/Original-Recipient:\s*rfc822;?\s*([^\s<>]+@[^\s<>]+)/i);
    if (m) return m[1].trim().toLowerCase();

    // 3. Postfix-format: "<user@example.com>: host..." (i starten af linje)
    m = bodyText.match(/\n\s*<([^\s<>]+@[^\s<>]+)>\s*:/i);
    if (m) return m[1].trim().toLowerCase();

    // 4. "could not be delivered to user@example.com"
    m = bodyText.match(/could not be delivered to[:\s]*<?([^\s<>,]+@[^\s<>,]+)>?/i);
    if (m) return m[1].trim().toLowerCase().replace(/[.,;]$/, '');

    // 5. "kunne ikke leveres til user@example.com" (dansk)
    m = bodyText.match(/kunne ikke leveres til[:\s]*<?([^\s<>,]+@[^\s<>,]+)>?/i);
    if (m) return m[1].trim().toLowerCase().replace(/[.,;]$/, '');

    // 6. Fallback: første <email> i body der IKKE er vores egen domæne
    const allEmails = bodyText.match(/<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi) || [];
    for (const e of allEmails) {
        const clean = e.replace(/[<>]/g, '').toLowerCase();
        if (!clean.includes('ristetrug.dk') && !clean.includes('simply.com') &&
            !clean.includes('hubspot.com') && !clean.includes('mailer-daemon')) {
            return clean;
        }
    }

    return null;
}

// Slå kunde op via email — bruger både customers.email (cache) og
// contact_points (autoritativ kilde).
function lookupCustomerByEmail(db, email) {
    if (!email) return null;
    // Først contact_points (mere komplet)
    const cp = db.prepare(`
        SELECT cp.entity_id AS customer_id, c.first_name, c.last_name, c.phone, c.email,
               co.name AS company_name
        FROM contact_points cp
        JOIN customers c ON c.id = cp.entity_id
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE cp.entity_type = 'customer'
          AND cp.kind = 'email'
          AND LOWER(cp.value) = ?
        LIMIT 1
    `).get(email.toLowerCase());
    if (cp) return cp;

    // Fallback til legacy customers.email
    const c = db.prepare(`
        SELECT c.id AS customer_id, c.first_name, c.last_name, c.phone, c.email,
               co.name AS company_name
        FROM customers c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE LOWER(c.email) = ?
        LIMIT 1
    `).get(email.toLowerCase());
    return c || null;
}

router.get('/unmatched', requireAuth('admin'), handle(async (req, res) => {
    const status = req.query.status || 'open';
    const db = getDb();
    const where = ['status = ?'];
    const args = [status];

    if (req.query.from_date) {
        where.push('COALESCE(received_at, created_at) >= ?');
        args.push(req.query.from_date);
    }
    if (req.query.mailbox) {
        where.push('mailbox LIKE ?');
        args.push('%' + req.query.mailbox + '%');
    }

    const items = db.prepare(`
        SELECT * FROM mail_unmatched WHERE ${where.join(' AND ')} ORDER BY COALESCE(received_at, created_at) DESC
    `).all(...args);

    // Enrich bounces med fejlet modtager + kunde-lookup
    for (const item of items) {
        if (isBounceMail(item.from_email)) {
            item.is_bounce = true;
            const recipient = parseBouncedRecipient(item.body_text);
            if (recipient) {
                item.bounce_recipient = recipient;
                const customer = lookupCustomerByEmail(db, recipient);
                if (customer) {
                    item.bounce_customer_id = customer.customer_id;
                    item.bounce_customer_name = [customer.first_name, customer.last_name]
                        .filter(Boolean).join(' ').trim();
                    item.bounce_customer_phone = customer.phone || null;
                    item.bounce_customer_company = customer.company_name || null;
                }
            }
        }
    }

    res.json(items);
}));

router.patch('/unmatched/:id', requireAuth('admin'), handle(async (req, res) => {
    const id = parseInt(req.params.id);
    const { status, linked_customer_id, linked_bon_id } = req.body;
    const db = getDb();
    const userId = req.session?.user?.id || null;

    if (status === 'linked') {
        // Create thread + message from unmatched
        const um = db.prepare('SELECT * FROM mail_unmatched WHERE id = ?').get(id);
        if (!um) return res.status(404).json({ error: 'Ikke fundet' });

        const threadId = db.prepare(`
            INSERT INTO mail_threads (subject, bon_id, customer_id) VALUES (?, ?, ?)
        `).run(um.subject || '', linked_bon_id || null, linked_customer_id || null).lastInsertRowid;

        db.prepare(`
            INSERT INTO mail_messages (thread_id, message_id, direction, from_email, from_name, to_email, subject, body_text, is_read, imap_uid, mailbox, received_at)
            VALUES (?, ?, 'in', ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run(threadId, um.message_id, um.from_email, um.from_name, um.to_email || um.mailbox, um.subject, um.body_text, um.imap_uid, um.mailbox, um.received_at);

        db.prepare(`
            UPDATE mail_unmatched SET status = 'linked', linked_customer_id = ?, linked_bon_id = ?, handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(linked_customer_id || null, linked_bon_id || null, userId, id);

        res.json({ ok: true, thread_id: Number(threadId) });
    } else if (status === 'ignored') {
        db.prepare(`
            UPDATE mail_unmatched SET status = 'ignored', handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(userId, id);
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'status skal være linked eller ignored' });
    }
}));

/* ── POLL KONTROL ─────────────────────────────────────────── */

router.post('/poll', requireAuth('admin'), handle(async (req, res) => {
    const { triggerPoll, getPollState } = require('../services/mailService');
    if (typeof triggerPoll === 'function') {
        await triggerPoll();
    }
    res.json({ ok: true, state: getPollState() });
}));

// POST /api/mail/test-sse — test broadcast (admin, midlertidigt)
router.post('/test-sse', requireAuth('admin'), handle(async (req, res) => {
    const { broadcast } = require('../shared/sse');
    const db = getDb();
    // Brug en bon fra i dag hvis muligt (så badge kan ses i kitchen today)
    const bon = db.prepare(`SELECT id, bon_number FROM bons WHERE delivery_date = date('now') LIMIT 1`).get()
             || db.prepare(`SELECT id, bon_number FROM bons LIMIT 1`).get();
    broadcast('mail_received', { bon_id: bon ? bon.id : 50, bon_number: bon ? bon.bon_number : '0000', customer_id: null, thread_id: 2, unread_count: 5 });
    res.json({ ok: true, broadcasted: 'mail_received' });
}));

router.get('/status', requireAuth('admin'), handle(async (req, res) => {
    const { getPollState } = require('../services/mailService');
    res.json(getPollState());
}));

module.exports = router;
