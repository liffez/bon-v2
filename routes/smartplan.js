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
        // Vinduet er 180 dage bagud, ikke et helt år. Spørgsmålet siden skal
        // besvare er "passer HQ-indstillingen med de lokationer der er i brug"
        // — og dét kan et halvt år svare på. Et helt år var 2/3 af Smartplans
        // minut-budget (60 kald) i ét burst, fordi svaret paginerer.
        //
        // 30 minutters cache: det er en diagnose-visning, ikke live data. Med
        // standard-cachen på 5 min kostede hvert Settings-besøg en ny
        // gennemløbning, og det var nok til at ramme grænsen — hvorefter siden
        // viste "0 vagter" og det lignede at timerne var væk.
        rows = await smartplan.getLaborRows(offsetISO(-180), offsetISO(60), 30 * 60 * 1000);
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
        //
        // MEN: kun når vi rent faktisk fik et svar. Uden data er `locations`
        // tom, og så ville vi råde brugeren til at rette en indstilling der er
        // helt rigtig — et forkert råd er værre end intet råd. `null` betyder
        // "vi ved det ikke", og UI'et skal tie i det tilfælde.
        hq_location_found: error ? null : locations.some(l => l.title === hqName),
        locations,
        jobtypes: new Set(rows.map(r => r.jobtype_uuid).filter(Boolean)).size,
        shifts_total: rows.length,
        // Forbrug siden serveren startede. Et logisk opslag kan være mange
        // kald (paginering), så det er tallet der afgør om vi er tæt på
        // Smartplans grænse — ikke hvor tit et menneske har klikket.
        usage: smartplan.getStats(),
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
