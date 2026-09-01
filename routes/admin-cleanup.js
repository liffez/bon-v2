/**
 * routes/admin-cleanup.js
 * ════════════════════════════════════════════════════════════
 * Oprydning i firma-kartoteket — CRM → Værktøjer → Ryd tomme firmaer.
 *
 *   GET  /api/admin/cleanup/empty-companies
 *   POST /api/admin/cleanup/empty-companies/deactivate   { ids: [] }
 *
 * Reglen for hvad der er "tomt" bor i services/companyCleanup.js og deles med
 * scripts/audit-empty-companies.js — siden og kommandolinjen skal ikke kunne
 * blive uenige om hvad de fjerner.
 *
 * Admin-only, som merge-guiden ved siden af: at lægge hundredvis af firmaer væk
 * er ikke en dagligdags handling.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { transaction } = require('../db/compat');
const { requireAuth } = require('../shared/auth');
const cleanup = require('../services/companyCleanup');

router.use(requireAuth('admin'));

// GET — kandidaterne, grupperet, med tvilling-oplysning
router.get('/empty-companies', handle((req, res) => {
    const db = getDb();
    const rows = cleanup.findEmptyCompanies(db, { keepCvr: req.query.keep_cvr === '1' });
    const spared = cleanup.countSpared(db);
    const activeTotal = db.prepare('SELECT COUNT(*) n FROM companies WHERE is_active = 1').get().n;

    res.json({
        active_total: activeTotal,
        groups: cleanup.GROUPS,
        spared,
        companies: rows,
    });
}));

// POST — læg de valgte væk
router.post('/empty-companies/deactivate', handle((req, res) => {
    const db = getDb();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'Ingen firmaer valgt' });
    // Loft: siden sender det brugeren har krydset af. Et kald med titusinder af
    // id'er er ikke en oprydning, det er en fejl et sted.
    if (ids.length > 2000) return res.status(400).json({ error: 'For mange på én gang (max 2000)' });

    let result;
    transaction(db, () => {
        result = cleanup.deactivateCompanies(db, ids, req.session?.userId ?? null);
    });

    res.json({
        ok: true,
        deactivated: result.deactivated.length,
        // Sprunget over = rækken er ikke længere tom. Det SKAL med i svaret:
        // ellers ser brugeren "42 lagt væk" på en liste hvor hun valgte 43.
        skipped: result.skipped.length,
        skipped_ids: result.skipped,
    });
}));

module.exports = router;
