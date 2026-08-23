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
const { handle, offsetISO } = require('../db/helpers');
const { getDb }       = require('../db/database');
const { requireAuth } = require('../shared/auth');
const smartplan = require('../services/smartplanAdapter');

/* ── Status ──────────────────────────────────────────────── */
// Hvad Smartplan faktisk svarer, og hvordan lokations-splittet lander.
//
// Splittet (migration 122) afgør hvad der er HQ-drift og hvad der er event —
// men indtil nu kunne `smartplan_hq_location` kun ændres med SQL, og der var
// intet sted at SE om navnet stadig matchede. Skiftede Smartplan navn på
// lokationen, faldt alt over i 'events' uden at noget sagde fra.
//
// Derfor: vis lokationerne som Smartplan selv rapporterer dem, med hvor mange
// vagter der ligger på hver. Så er det til at se om indstillingen passer,
// frem for at skulle huske stavemåden.
router.get('/status', requireAuth('admin'), handle(async (req, res) => {
    const hqName = (getDb().prepare(
        "SELECT value FROM settings WHERE key = 'smartplan_hq_location'"
    ).get()?.value || 'Ristet Rug').trim();

    let rows = [], error = null;
    try {
        // Samme vindue som rolle-synken: et år tilbage fanger arkiverede
        // worklogs, 60 dage frem fanger kommende vagter på nye lokationer.
        rows = await smartplan.getLaborRows(offsetISO(-365), offsetISO(60));
    } catch (err) {
        error = err.message;
    }

    const byLoc = new Map();
    for (const r of rows) {
        const key = (r.location || '').trim() || '(uden lokation)';
        if (!byLoc.has(key)) byLoc.set(key, { title: key, shifts: 0, people: new Set() });
        const e = byLoc.get(key);
        e.shifts++;
        if (r.employee_name) e.people.add(r.employee_name);
    }
    const locations = [...byLoc.values()]
        .map(e => ({
            title: e.title,
            shifts: e.shifts,
            people: e.people.size,
            // Tom lokation regnes som HQ (jf. _classifyLocation) — vises som
            // hq, så det ikke ser ud som om den er droppet.
            class: e.title === '(uden lokation)' || e.title === hqName ? 'hq' : 'events',
        }))
        .sort((a, b) => b.shifts - a.shifts);

    res.json({
        connected: !error,
        error,
        hq_location: hqName,
        // Matcher indstillingen overhovedet en lokation Smartplan kender?
        // Gør den ikke, er ALT havnet i 'events' — den fejl er tavs i dag.
        hq_location_found: locations.some(l => l.title === hqName),
        locations,
        jobtypes: new Set(rows.map(r => r.jobtype_uuid).filter(Boolean)).size,
        shifts_total: rows.length,
    });
}));

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
