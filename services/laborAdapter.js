/**
 * services/laborAdapter.js
 * ════════════════════════════════════════════════════════════
 * Abstraktionen der gør Smartplans løn-payload ligegyldigt for resten af
 * driftsregnskabet. Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §5/§6a/§9.
 *
 * Smartplan bærer KUN timer (verificeret 2. juni 2026) — ingen sats. Derfor
 * join'er denne adapter timer fra Smartplan mod lokale tabeller:
 *   wage_rates          — timeløn per medarbejder (owner.uuid), tidsversioneret
 *   smartplan_role_map  — jobtype.uuid → {production|delivery|other}
 *
 * Resten af systemet kalder kun getLabor(dato, mode). Output er ex moms.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');
const { todayISO } = require('../db/helpers');
const smartplan = require('./smartplanAdapter');

/* ── Opslag ───────────────────────────────────────────────── */

/**
 * Timeløn for en medarbejder gældende på en given dato.
 * Tidsversioneret: valid_from <= dato AND (valid_to IS NULL OR dato < valid_to).
 * @returns {number|null} sats ex moms, eller null hvis ingen gyldig sats.
 */
function _wageRate(db, smartplanRef, dato) {
    if (!smartplanRef) return null;
    const row = db.prepare(`
        SELECT hourly_rate
          FROM wage_rates
         WHERE smartplan_ref = ?
           AND valid_from <= ?
           AND (valid_to IS NULL OR ? < valid_to)
         ORDER BY valid_from DESC
         LIMIT 1
    `).get(smartplanRef, dato, dato);
    return row ? Number(row.hourly_rate) : null;
}

/** jobtype.uuid → role_class (Map). Ukendte jobtyper findes ikke her. */
function _roleMap(db) {
    const map = new Map();
    for (const r of db.prepare('SELECT jobtype_uuid, role_class FROM smartplan_role_map').all()) {
        map.set(r.jobtype_uuid, r.role_class);
    }
    return map;
}

/* ── Hoved-API ────────────────────────────────────────────── */

/**
 * Hent løn-/bemandingsrækker for én dato.
 * @param {string} dato  'YYYY-MM-DD'
 * @param {'realiseret'|'forecast'} mode
 *        realiseret → attendance_* (faktisk fremmøde; kun arkiverede dage)
 *        forecast   → planned_*    (planlagt vagt; eneste data på fremtid)
 * @returns {Promise<Array>} [{
 *   employee_id, employee_name, jobtype_uuid, jobtype_title, role_class,
 *   start, slut, timer, sats, kostpris, rate_missing, role_unmapped,
 *   used_fallback_hours, mode
 * }]
 */
/**
 * Map én rå Smartplan-række til en løn-/bemandingsrække. Ren funktion —
 * deler logik mellem getLabor (én dag) og getLaborMap (helt interval).
 */
function _transformRow(r, dato, m, db, roleMap) {
    // Tid efter mode. Realiseret falder tilbage til planlagt hvis fremmøde
    // endnu ikke er registreret (markeres med used_fallback_hours).
    let timer, start, slut, usedFallback = false;
    if (m === 'forecast') {
        timer = r.planned_hours;
        start = r.planned_start;
        slut  = r.planned_end;
    } else {
        if (r.attendance_hours != null) {
            timer = r.attendance_hours;
            start = r.attendance_start;
            slut  = r.attendance_end;
        } else {
            timer = r.planned_hours;
            start = r.planned_start;
            slut  = r.planned_end;
            usedFallback = true;
        }
    }

    const sats = _wageRate(db, r.employee_id, dato);
    const rateMissing = sats == null;
    const kostpris = (rateMissing || timer == null) ? null : timer * sats;

    const roleUnmapped = !roleMap.has(r.jobtype_uuid);
    const roleClass = roleMap.get(r.jobtype_uuid) || 'other';

    return {
        employee_id:        r.employee_id,
        employee_name:      r.employee_name,
        jobtype_uuid:       r.jobtype_uuid,
        jobtype_title:      r.jobtype_title,
        role_class:         roleClass,
        start, slut,
        timer:              timer != null ? Number(timer) : null,
        sats,
        kostpris,
        rate_missing:       rateMissing,
        role_unmapped:      roleUnmapped,
        used_fallback_hours: usedFallback,
        mode:               m,
    };
}

async function getLabor(dato, mode = 'realiseret') {
    const m = mode === 'forecast' ? 'forecast' : 'realiseret';
    const rows = await smartplan.getLaborRows(dato, dato);
    const db = getDb();
    const roleMap = _roleMap(db);

    return rows
        .filter(r => r.date === dato)
        .map(r => _transformRow(r, dato, m, db, roleMap));
}

/**
 * Batch: hent labor for et helt interval i ÉT Smartplan-kald, grupperet pr.
 * dato. Bruges af driftens periode-/uge-visning, så lange perioder ikke koster
 * ét netværkskald pr. dag. De per-dato lokale opslag (sats, role_map) er rene
 * SQLite-kald og er billige.
 * @returns {Promise<Object>} { 'YYYY-MM-DD': [labor-rækker], ... }
 */
async function getLaborMap(fromDate, toDate, mode = 'realiseret') {
    const m = mode === 'forecast' ? 'forecast' : 'realiseret';
    const rows = await smartplan.getLaborRows(fromDate, toDate);   // ét kald, cachet
    const db = getDb();
    const roleMap = _roleMap(db);
    const out = {};
    for (const r of rows) {
        if (!r.date) continue;
        (out[r.date] || (out[r.date] = [])).push(_transformRow(r, r.date, m, db, roleMap));
    }
    return out;
}

/** Bagudkompat-alias — gammelt navn, samme batch-adfærd. */
const getLaborPeriod = getLaborMap;

/**
 * Synkronisér jobtyper set i Smartplan ind i smartplan_role_map, så Settings
 * har rækker at redigere. Nye jobtyper indsættes med role_class='other'
 * (jf. spec §6a — ukendte tæller ikke før de er mappet). Rører ikke
 * eksisterende rækker (bevarer Leifs manuelle mapping).
 * @returns {Promise<{ added: number, total: number }>}
 */
async function syncRoleMap(fromDate, toDate) {
    const rows = await smartplan.getLaborRows(fromDate, toDate);
    const db = getDb();
    const ins = db.prepare(`
        INSERT OR IGNORE INTO smartplan_role_map (jobtype_uuid, jobtype_title, role_class)
        VALUES (?, ?, 'other')
    `);
    const seen = new Map();
    for (const r of rows) {
        if (r.jobtype_uuid && !seen.has(r.jobtype_uuid)) seen.set(r.jobtype_uuid, r.jobtype_title);
    }
    let added = 0;
    for (const [uuid, title] of seen) {
        const res = ins.run(uuid, title);
        if (res.changes) added++;
    }
    return { added, total: seen.size };
}

/**
 * "Standard-medarbejder"-timeløn: gennemsnit af de rater der er gyldige på en
 * given dato, ét beløb pr. medarbejder (nyeste valid_from der dækker datoen).
 * Bruges af opskrifts-kalkulationen, hvor vi ikke ved hvem der laver retten.
 * Overhead lægges IKKE på her — kalderen ganger labor_overhead_pct på selv.
 * @param {string} [dato] 'YYYY-MM-DD' (default: i dag, dansk)
 * @returns {{ rate: number|null, count: number }} rate ex moms, eller null hvis ingen rater.
 */
function getStandardHourlyRate(dato) {
    const db = getDb();
    const d = dato || todayISO();
    const row = db.prepare(`
        SELECT AVG(rate) AS avg_rate, COUNT(*) AS n FROM (
            SELECT w.smartplan_ref, w.hourly_rate AS rate
              FROM wage_rates w
             WHERE w.valid_from <= ?
               AND (w.valid_to IS NULL OR ? < w.valid_to)
               AND w.valid_from = (
                   SELECT MAX(w2.valid_from) FROM wage_rates w2
                    WHERE w2.smartplan_ref = w.smartplan_ref
                      AND w2.valid_from <= ?
                      AND (w2.valid_to IS NULL OR ? < w2.valid_to)
               )
        )
    `).get(d, d, d, d);
    if (!row || !row.n) return { rate: null, count: 0 };
    return { rate: Number(row.avg_rate), count: row.n };
}

module.exports = {
    getLabor,
    getLaborMap,
    getLaborPeriod,
    syncRoleMap,
    getStandardHourlyRate,
};
