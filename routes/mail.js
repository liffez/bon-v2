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

// PATCH /api/mail/templates/:key (admin)
router.patch('/templates/:key', requireAuth('admin'), handle((req, res) => {
    const { subject, body_text } = req.body;
    const db = getDb();
    const tmpl = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });

    const updates = [];
    const params = [];
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
