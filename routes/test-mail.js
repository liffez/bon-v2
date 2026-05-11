/**
 * routes/test-mail.js
 * ════════════════════════════════════════════════════════════
 * Test-only route der eksponerer mailService's in-memory mail-buffer
 * til test-runnere. Kun aktiv når NODE_ENV='test'.
 *
 * Mountes i server.js via:
 *   if (process.env.NODE_ENV === 'test') {
 *       app.use('/api/test', require('./routes/test-mail'));
 *   }
 *
 * GET  /api/test/sent-mails    → returnerer alle fangede mails
 * POST /api/test/clear-mails   → tømmer bufferen
 *
 * Reference: tests/specs/T_INDKOB_HORKRAM.md (mock-transport-strategi)
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const mailService = require('../services/mailService');

const router = express.Router();

router.get('/sent-mails', (req, res) => {
    res.json({ mails: mailService._getSentMails() });
});

router.post('/clear-mails', (req, res) => {
    mailService._clearSentMails();
    res.json({ ok: true });
});

module.exports = router;
