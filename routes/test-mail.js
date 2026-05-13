/**
 * routes/test-mail.js
 * ════════════════════════════════════════════════════════════
 * Test-only route der eksponerer in-memory buffers fra services'
 * auto-mocks til test-runnere. Kun aktiv når NODE_ENV='test'.
 *
 * Mountes i server.js via:
 *   if (process.env.NODE_ENV === 'test') {
 *       app.use('/api/test', require('./routes/test-mail'));
 *   }
 *
 * Mail (services/mailService.js):
 *   GET  /api/test/sent-mails      → returnerer alle fangede mails
 *   POST /api/test/clear-mails     → tømmer mail-bufferen
 *
 * Webhook (services/goodsReceiptWebhook.js):
 *   GET  /api/test/sent-webhooks   → returnerer alle fangede webhook-kald
 *   POST /api/test/clear-webhooks  → tømmer webhook-bufferen
 *
 * Referencer:
 *   - tests/specs/T_INDKOB_HORKRAM.md (mail-mock-strategi)
 *   - tests/specs/T_VAREMODTAGELSE_FULL.md §4.7 (FAIL-gruppen)
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const mailService = require('../services/mailService');
const goodsReceiptWebhook = require('../services/goodsReceiptWebhook');

const router = express.Router();

router.get('/sent-mails', (req, res) => {
    res.json({ mails: mailService._getSentMails() });
});

router.post('/clear-mails', (req, res) => {
    mailService._clearSentMails();
    res.json({ ok: true });
});

router.get('/sent-webhooks', (req, res) => {
    res.json({ webhooks: goodsReceiptWebhook._getSentWebhooks() });
});

router.post('/clear-webhooks', (req, res) => {
    goodsReceiptWebhook._clearSentWebhooks();
    res.json({ ok: true });
});

module.exports = router;
