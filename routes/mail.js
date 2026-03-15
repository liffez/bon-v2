const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { sendFromTemplate } = require('../services/mailService');

router.use(requireAuth('admin'));

// GET /api/mail/templates
router.get('/templates', handle((req, res) => {
    const rows = getDb().prepare('SELECT id, key, label, subject, body_text, updated_at FROM mail_templates ORDER BY id').all();
    res.json(rows);
}));

// GET /api/mail/templates/:key
router.get('/templates/:key', handle((req, res) => {
    const tmpl = getDb().prepare('SELECT * FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });
    res.json(tmpl);
}));

// PATCH /api/mail/templates/:key
router.patch('/templates/:key', handle((req, res) => {
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

// POST /api/mail/test
router.post('/test', handle(async (req, res) => {
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

module.exports = router;
