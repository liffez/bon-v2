/**
 * routes/smartplan.js
 * ════════════════════════════════════════════════════════════
 * Readonly proxy til Smartplan vagtplan-API.
 * Monteres som /api/smartplan i server.js.
 *
 * Alle endpoints bruger services/smartplanAdapter.js
 * der håndterer credentials, caching og fejlhåndtering.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { handle } = require('../db/helpers');
const smartplan = require('../services/smartplanAdapter');

/* ── Vagter ──────────────────────────────────────────────── */

router.get('/shifts', handle(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) {
        return res.status(400).json({ error: 'from og to parametre er påkrævet (YYYY-MM-DD)' });
    }
    res.json(await smartplan.getShifts(from, to));
}));

/* ── Medarbejdere ────────────────────────────────────────── */

router.get('/employees', handle(async (req, res) => {
    res.json(await smartplan.getEmployees());
}));

/* ── Cache-styring ───────────────────────────────────────── */

router.delete('/cache', handle(async (req, res) => {
    smartplan.clearCache();
    res.json({ ok: true, message: 'Smartplan cache ryddet' });
}));

module.exports = router;
