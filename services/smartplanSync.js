/**
 * services/smartplanSync.js
 * ════════════════════════════════════════════════════════════
 * ÉN ejer af "hvornår taler vi med Smartplan".
 *
 * Før dette hentede seks kaldesteder hver for sig, med hver sin cache-nøgle, og
 * fire skærme hentede oven i købet ved HVER SSE-hændelse. Kald-frekvensen var
 * altså en funktion af hvor mange skærme der stod tændt — ikke af noget nogen
 * havde besluttet. Så længe alt virkede, opslugte cachen det; men cachen fyldes
 * kun ved succes, så i det sekund Smartplan fejlede, forsvandt vores eneste
 * bremse. Resultatet var en throttling der holdt sig selv i live.
 *
 * Nu: synkroniseringen henter ét vindue ad gangen på en fast rytme og skriver
 * til `smartplan_shifts`. ALT læsning sker fra spejlet. Læsning koster nul
 * udgående kald, og en Smartplan der er nede betyder "vagtplanen er fra kl.
 * 14.05" i stedet for "der er ingen vagter".
 *
 * Rå records gemmes; normaliseringen sker ved læsning med adapterens egne
 * funktioner, så der ikke findes to udpakninger der kan skride fra hinanden.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');
const { todayISO, offsetISO } = require('../db/helpers');
const smartplan = require('./smartplanAdapter');

const nowIso = () => new Date().toISOString();   // utc-ok: teknisk tidsstempel

/* ── Indstillinger ───────────────────────────────────────── */

function _setting(key, fallback) {
    try {
        const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (row && String(row.value).trim() !== '') return String(row.value).trim();
    } catch { /* ingen DB endnu */ }
    return fallback;
}

/** Vinduet spejlet dækker. Bagud fanger arkiverede worklogs, frem fanger planlagte vagter. */
function syncWindow() {
    const back    = Math.max(1, parseInt(_setting('smartplan_window_back_days', '180'), 10) || 180);
    const forward = Math.max(1, parseInt(_setting('smartplan_window_forward_days', '60'), 10) || 60);
    return { from: offsetISO(-back), to: offsetISO(forward) };
}

function syncIntervalMs() {
    const min = parseInt(_setting('smartplan_sync_interval_min', '20'), 10);
    return Math.max(5, Number.isFinite(min) ? min : 20) * 60 * 1000;
}

/* ── Tilstand ────────────────────────────────────────────── */

function getSyncState() {
    const db = getDb();
    const row = db.prepare('SELECT * FROM smartplan_sync_state WHERE id = 1').get() || {};
    const counts = db.prepare('SELECT COUNT(*) AS n FROM smartplan_shifts').get();
    const ageMin = row.last_success_at
        ? Math.round((Date.now() - Date.parse(row.last_success_at)) / 60000)
        : null;
    return {
        ...row,
        rows_in_mirror: counts ? counts.n : 0,
        age_min: ageMin,
        // "Forældet" er ikke en fejl — det er en oplysning. Vagtplanen ændrer sig
        // sjældent, så tal fra i formiddags er som regel helt rigtige. Men det
        // skal STÅ der, ellers præsenterer vi et gammelt svar som et friskt.
        stale: ageMin == null || ageMin > (syncIntervalMs() / 60000) * 3,
        interval_min: Math.round(syncIntervalMs() / 60000),
        enabled: smartplan.isEnabled(),
    };
}

function _recordAttempt(db, reason) {
    db.prepare('UPDATE smartplan_sync_state SET last_attempt_at = ?, last_reason = ? WHERE id = 1')
      .run(nowIso(), reason || null);
}

/* ── Synkronisering ──────────────────────────────────────── */

let _running = null;   // sammenfald: to kald må ikke hente det samme to gange

/**
 * Hent vinduet og skriv det til spejlet.
 * @param {string} reason  hvem/hvad udløste den — ryger i sync-state og i loggen
 * @returns {Promise<{ok:boolean, rows?:number, error?:string, skipped?:string}>}
 */
async function syncNow(reason = 'manuel') {
    // Kører der allerede en, så vent på DEN i stedet for at starte nummer to.
    // Ellers kunne to samtidige udløsere fordoble forbruget uden at nogen bad om det.
    if (_running) return _running;
    _running = (async () => {
        const db = getDb();
        const { from, to } = syncWindow();
        _recordAttempt(db, reason);

        if (!smartplan.isEnabled()) {
            const msg = 'Integrationen er slået fra';
            db.prepare('UPDATE smartplan_sync_state SET last_error = ? WHERE id = 1').run(msg);
            return { ok: false, skipped: msg };
        }

        try {
            const raw = await smartplan.withCaller(`sync:${reason}`, () => smartplan.getRawWindow(from, to));
            const stamp = nowIso();
            const seen = new Set();

            const up = db.prepare(`
                INSERT INTO smartplan_shifts (uuid, source, date, raw_json, synced_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(uuid, source) DO UPDATE SET
                    date = excluded.date, raw_json = excluded.raw_json, synced_at = excluded.synced_at
            `);

            db.exec('BEGIN IMMEDIATE');
            try {
                for (const { source, rec } of raw) {
                    const uuid = rec.uuid || rec.id;
                    const date = rec.display_date
                        || (rec.planned_start_dt ? String(rec.planned_start_dt).slice(0, 10) : null);
                    if (!uuid || !date) continue;
                    up.run(String(uuid), source, date, JSON.stringify(rec), stamp);
                    seen.add(source + '|' + uuid);
                }
                // Ryd vagter der er FORSVUNDET fra Smartplan i vinduet — en aflyst
                // vagt skal ikke blive stående som et spøgelse. Kun inden for
                // vinduet: uden for det ved vi ingenting, og så rører vi ikke noget.
                const inWindow = db.prepare(
                    'SELECT uuid, source FROM smartplan_shifts WHERE date BETWEEN ? AND ?').all(from, to);
                const del = db.prepare('DELETE FROM smartplan_shifts WHERE uuid = ? AND source = ?');
                let pruned = 0;
                for (const r of inWindow) {
                    if (!seen.has(r.source + '|' + r.uuid)) { del.run(r.uuid, r.source); pruned++; }
                }
                db.prepare(`
                    UPDATE smartplan_sync_state
                       SET last_success_at = ?, last_error = NULL,
                           window_from = ?, window_to = ?, rows_synced = ?
                     WHERE id = 1
                `).run(stamp, from, to, seen.size);
                db.exec('COMMIT');
                console.log(`[smartplan-sync] ${reason}: ${seen.size} vagter, ${pruned} fjernet (${from} → ${to})`);
                return { ok: true, rows: seen.size, pruned };
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        } catch (err) {
            // Spejlet står urørt. Et mislykket forsøg må ALDRIG tømme det —
            // gamle tal er uendeligt meget bedre end ingen tal.
            db.prepare('UPDATE smartplan_sync_state SET last_error = ? WHERE id = 1').run(err.message);
            console.error('[smartplan-sync]', reason, '→', err.message);
            return { ok: false, error: err.message };
        }
    })();
    try { return await _running; } finally { _running = null; }
}

/* ── Læsning — koster nul udgående kald ──────────────────── */

/**
 * Rå records fra spejlet for et datointerval.
 * @returns {Array<{source:string, rec:object}>}
 */
function readWindow(fromDate, toDate) {
    const rows = getDb().prepare(
        'SELECT source, raw_json FROM smartplan_shifts WHERE date BETWEEN ? AND ?'
    ).all(fromDate, toDate);
    const out = [];
    for (const r of rows) {
        try { out.push({ source: r.source, rec: JSON.parse(r.raw_json) }); }
        catch { /* en ulæselig række må ikke vælte hele vagtplanen */ }
    }
    return out;
}

/** Er spejlet overhovedet fyldt? Tomt spejl ≠ ingen vagter. */
function isEmpty() {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM smartplan_shifts').get();
    return !row || !row.n;
}

/* ── Rytmen ──────────────────────────────────────────────── */

let _timer = null;

/** Start den faste synkronisering. Kaldes fra server.js. */
function startScheduler() {
    if (_timer) return;
    const tick = () => {
        syncNow('planlagt').catch(err => console.error('[smartplan-sync] planlagt:', err.message));
    };
    // Første synk kort efter opstart, så et tomt spejl fyldes uden at vente
    // et helt interval — men ikke i samme sekund som serveren starter, hvor
    // alt andet også kæmper om opmærksomheden.
    setTimeout(tick, 20_000).unref?.();
    _timer = setInterval(tick, syncIntervalMs());
    _timer.unref?.();
    console.log(`[smartplan-sync] rytme: hvert ${Math.round(syncIntervalMs() / 60000)}. minut`);
}

function stopScheduler() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
    syncNow, readWindow, isEmpty, getSyncState, syncWindow,
    startScheduler, stopScheduler,
};
