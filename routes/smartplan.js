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
const sync      = require('../services/smartplanSync');

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

    // Diagnose-siden henter IKKE længere fra Smartplan. Den læser spejlet.
    // Før kostede hvert Settings-besøg en gennemløbning af et halvt til et helt
    // år — 24-80 kald i ét burst — og det var nok til at ramme minut-grænsen.
    // At kigge på en statusside må aldrig kunne forårsage det den viser.
    const state = sync.getSyncState();
    const rows  = smartplan.getLaborRows(state.window_from || offsetISO(-180),
                                         state.window_to   || offsetISO(60));
    const error = !state.enabled ? 'Integrationen er slået fra' : (state.last_error || null);

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
        // "Forbundet" betyder her: spejlet er fyldt, og sidste synkronisering
        // lykkedes. Ikke "vi kan nå Smartplan lige nu" — det spørgsmål stiller
        // vi kun når vi faktisk synkroniserer.
        connected: !error && rows.length > 0,
        sync: state,
        error,
        hq_location: hqName,
        // Matcher indstillingen overhovedet en lokation Smartplan kender?
        // Gør den ikke, er ALT havnet i 'events' — den fejl er tavs i dag.
        //
        // MEN: kun når vi rent faktisk fik et svar. Uden data er `locations`
        // tom, og så ville vi råde brugeren til at rette en indstilling der er
        // helt rigtig — et forkert råd er værre end intet råd. `null` betyder
        // "vi ved det ikke", og UI'et skal tie i det tilfælde.
        hq_location_found: rows.length === 0 ? null : locations.some(l => l.title === hqName),
        locations,
        jobtypes: new Set(rows.map(r => r.jobtype_uuid).filter(Boolean)).size,
        shifts_total: rows.length,
        // Forbrug siden serveren startede. Et logisk opslag kan være mange
        // kald (paginering), så det er tallet der afgør om vi er tæt på
        // Smartplans grænse — ikke hvor tit et menneske har klikket.
        usage: smartplan.getStats(),
    });
}));

/* ── Synkronisering ──────────────────────────────────────── */
// Den ENESTE menneske-udløste vej til at hente fra Smartplan. Alt andet læser
// spejlet. Admin, fordi et kald koster af en kvote hele huset deler.
router.post('/sync', requireAuth('admin'), handle(async (req, res) => {
    const result = await sync.syncNow(`manuel:${req.session.userId}`);
    res.status(result.ok ? 200 : 503).json({ ...result, sync: sync.getSyncState() });
}));

// De seneste udgående kald med afsender. Vi havde et forbrugstal uden afsender —
// 142 kald på 101 minutter, og ingen måde at se hvad der udløste dem.
router.get('/calls', requireAuth('admin'), handle(async (req, res) => {
    res.json({ calls: smartplan.getRecentCalls(40), usage: smartplan.getStats() });
}));

/* ── Vagter ──────────────────────────────────────────────── */

router.get('/shifts', handle(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) {
        return res.status(400).json({ error: 'from og to parametre er påkrævet (YYYY-MM-DD)' });
    }
    // Læser spejlet — nul udgående kald. En SSE-drevet genindlæsning kan
    // derfor ikke længere udløse trafik mod Smartplan.
    res.json(smartplan.getShifts(from, to));
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
