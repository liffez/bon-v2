/**
 * services/smartplanAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Smartplan.dk vagtplan-API (OAuth2).
 *
 * Eksporterer funktioner der kaldes fra routes/smartplan.js.
 * Henter credentials fra .env (SMARTPLAN_CLIENT_ID, SMARTPLAN_CLIENT_SECRET).
 * In-memory cache med 5 min TTL for shifts, 9 min for token, 1 time for account.
 *
 * Readonly — læser kun vagter og medarbejdere.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

/* ══════════════════════════════════════════════════════════════
   CACHE
   ══════════════════════════════════════════════════════════════ */

const _cache = new Map(); // key → { data, expires }

function getCached(key) {
    const entry = _cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.data;
    return null;
}

function setCached(key, data, ttlMs = 5 * 60 * 1000) {
    _cache.set(key, { data, expires: Date.now() + ttlMs });
}

/** Ryd hele cachen */
function clearCache() {
    _cache.clear();
}

/* ══════════════════════════════════════════════════════════════
   OAUTH2 TOKEN
   ══════════════════════════════════════════════════════════════ */

const TOKEN_URL = process.env.SMARTPLAN_TOKEN_URL || 'https://api.smartplanapp.io/o/token/';
const API_BASE  = process.env.SMARTPLAN_API_BASE  || 'https://api.smartplanapp.io/v2';

/**
 * Hent OAuth2 access token via client_credentials grant.
 */
async function getAccessToken() {
    const cached = getCached('_token');
    if (cached) return cached;

    const clientId     = process.env.SMARTPLAN_CLIENT_ID;
    const clientSecret = process.env.SMARTPLAN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Smartplan ikke konfigureret. Sæt SMARTPLAN_CLIENT_ID og SMARTPLAN_CLIENT_SECRET i .env.');
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Smartplan token fejl ${res.status}: ${text.slice(0, 300)}`);
    }

    let json;
    try { json = JSON.parse(text); } catch {
        throw new Error(`Smartplan token: uventet ikke-JSON svar: ${text.slice(0, 300)}`);
    }

    const token = json?.access_token;
    if (!token) throw new Error('Smartplan: access_token mangler i svar');

    // Token gyldighed ~10 min, cache i 9 min
    setCached('_token', token, 9 * 60 * 1000);
    return token;
}

/* ══════════════════════════════════════════════════════════════
   ACCOUNT UUID
   ══════════════════════════════════════════════════════════════ */

async function getAccountUUID() {
    const cached = getCached('_accountUUID');
    if (cached) return cached;

    const token = await getAccessToken();
    const res = await fetch(`${API_BASE}/accounts/`, {
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
        },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Smartplan accounts fejl ${res.status}: ${text.slice(0, 300)}`);

    let json;
    try { json = JSON.parse(text); } catch {
        throw new Error(`Smartplan accounts: uventet svar: ${text.slice(0, 300)}`);
    }

    const uuid = json?.results?.[0]?.uuid;
    if (!uuid) throw new Error('Smartplan: ingen account UUID fundet');

    // Cache 1 time
    setCached('_accountUUID', uuid, 60 * 60 * 1000);
    return uuid;
}

/* ══════════════════════════════════════════════════════════════
   HTTP
   ══════════════════════════════════════════════════════════════ */

/**
 * Authenticated fetch mod Smartplan API med pagination.
 * Returnerer alle results samlet.
 */
async function smartplanFetch(path) {
    const token = await getAccessToken();
    const accountUUID = await getAccountUUID();

    let url = `${API_BASE}/accounts/${accountUUID}${path}`;
    const all = [];

    while (url) {
        const res = await fetch(url, {
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
            },
        });

        const text = await res.text();
        if (!res.ok) {
            throw new Error(`Smartplan API fejl ${res.status}: ${text.slice(0, 200)}`);
        }

        const json = JSON.parse(text);
        if (Array.isArray(json.results)) {
            all.push(...json.results);
        }
        // Smartplan paginerer med next-URL
        url = json.next || null;
    }

    return all;
}

/* ══════════════════════════════════════════════════════════════
   LOKATIONS-KLASSIFIKATION (HQ vs. Festival & Events)
   ══════════════════════════════════════════════════════════════ */

/**
 * Navnet på HQ-lokationen i Smartplan (setting `smartplan_hq_location`,
 * default 'Ristet Rug'). Cachet 1 time — læses via samme _cache som resten.
 */
function _hqLocationName() {
    const cached = getCached('_hqLoc');
    if (cached != null) return cached;
    let name = 'Ristet Rug';
    try {
        const row = getDb().prepare("SELECT value FROM settings WHERE key = 'smartplan_hq_location'").get();
        if (row && row.value && String(row.value).trim()) name = String(row.value).trim();
    } catch { /* ingen DB / setting → default */ }
    setCached('_hqLoc', name, 60 * 60 * 1000);
    return name;
}

/**
 * Klassificér en lokations-titel som 'hq' | 'events'.
 * Tom/ukendt lokation → 'hq' (vises i den primære driftsvisning, skjules ikke).
 */
function _classifyLocation(locTitle, hqName) {
    const t = (locTitle || '').trim().toLowerCase();
    if (!t) return 'hq';
    return t === (hqName || '').trim().toLowerCase() ? 'hq' : 'events';
}

/* ══════════════════════════════════════════════════════════════
   NORMALISERING
   ══════════════════════════════════════════════════════════════ */

/**
 * Normalisér et Smartplan shift-objekt til vores faste format.
 * Smartplan v2 returnerer: owner.first_name/last_name, jobtype.title, location.title
 */
function _normalizeShift(shift, hqName) {
    const startDt = shift.start_dt || '';
    const endDt   = shift.end_dt   || '';
    const owner   = shift.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;
    const location = shift.location?.title || '';

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        date:          shift.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      shift.jobtype?.title || '',
        location,
        location_class: _classifyLocation(location, hqName),
    };
}

/**
 * Normalisér et Smartplan worklog-objekt (arkiverede vagter).
 * Bruger planned_start_dt/planned_end_dt i stedet for start_dt/end_dt.
 */
function _normalizeWorklog(wl, hqName) {
    const startDt = wl.planned_start_dt || '';
    const endDt   = wl.planned_end_dt   || '';
    const owner   = wl.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;
    const location = wl.location?.title || '';

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        date:          wl.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      wl.jobtype?.title || '',
        location,
        location_class: _classifyLocation(location, hqName),
    };
}

/** Ekstrahér HH:MM fra ISO datetime eller "HH:MM" */
function _extractTime(val) {
    if (!val) return '';
    if (val.includes('T')) {
        const match = val.match(/T(\d{2}:\d{2})/);
        return match ? match[1] : val;
    }
    return val;
}

/* ══════════════════════════════════════════════════════════════
   EKSPORTEREDE FUNKTIONER
   ══════════════════════════════════════════════════════════════ */

/**
 * Hent vagter for et datointerval.
 * Kombinerer fremtidige shifts + arkiverede worklogs for at dække alle datoer.
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @returns {Promise<Array>} Normaliserede vagt-objekter
 */
async function getShifts(fromDate, toDate) {
    const cacheKey = `shifts_${fromDate}_${toDate}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Hent begge parallelt: shifts (fremtidige) + worklogs (arkiverede/fortidige)
    const [shifts, worklogs] = await Promise.all([
        smartplanFetch(
            `/shifts/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}`
        ).catch(() => []),
        smartplanFetch(
            `/worklogs/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}&ordering=planned_start_dt`
        ).catch(() => []),
    ]);

    const hqName = _hqLocationName();
    const normalizedShifts = shifts.map(s => _normalizeShift(s, hqName));
    const normalizedWorklogs = worklogs.map(w => _normalizeWorklog(w, hqName));

    // Kombiner — worklogs dækker fortid, shifts dækker fremtid.
    // Dedupliker via employee_id+date (shifts har forrang)
    const seen = new Set();
    const all = [];
    for (const s of normalizedShifts) {
        if (!s.date) continue;
        const key = (s.employee_id || '') + '_' + s.date + '_' + s.start_time;
        seen.add(key);
        all.push(s);
    }
    for (const w of normalizedWorklogs) {
        if (!w.date) continue;
        const key = (w.employee_id || '') + '_' + w.date + '_' + w.start_time;
        if (!seen.has(key)) all.push(w);
    }

    setCached(cacheKey, all);
    return all;
}

/**
 * Hent medarbejderliste (udtrukket fra shifts de seneste 30 dage).
 * Smartplan har intet dedikeret /employees/ endpoint — vi udtrækker
 * unikke medarbejdere fra shifts/worklogs i stedet.
 * @returns {Promise<Array>} [{ uuid, first_name, last_name, name }, ...]
 */
async function getEmployees() {
    const cacheKey = 'employees';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 14);
    const to = new Date(now);
    to.setDate(to.getDate() + 14);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const shifts = await getShifts(fromStr, toStr);

    const seen = new Map();
    for (const s of shifts) {
        const id = s.employee_id;
        if (id && !seen.has(id)) {
            seen.set(id, {
                uuid: id,
                first_name: s.first_name || s.name || null,
                name: s.name || s.first_name || null,
            });
        }
    }

    const employees = Array.from(seen.values()).sort((a, b) =>
        (a.first_name || '').localeCompare(b.first_name || ''));

    setCached(cacheKey, employees);
    return employees;
}

/* ══════════════════════════════════════════════════════════════
   LABOR-RÆKKER (til driftsregnskab / laborAdapter)
   ══════════════════════════════════════════════════════════════ */

/** Sekunder → timer (eller null). */
function _secToHours(sec) {
    return (sec != null && !Number.isNaN(Number(sec))) ? Number(sec) / 3600 : null;
}

/** Timer mellem to ISO-datetimes (fallback når *_shift_duration mangler). */
function _hoursBetween(startDt, endDt) {
    if (!startDt || !endDt) return null;
    const a = Date.parse(startDt);
    const b = Date.parse(endDt);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return (b - a) / 3600000;
}

/**
 * Berig et Smartplan-record (worklog eller shift) til en labor-række.
 * Bevarer BEGGE tidssæt (planned + attendance) + owner.uuid + jobtype.uuid,
 * så laborAdapter kan vælge mode og join'e mod wage_rates / role_map.
 * Timer = fuld vagtlængde (shift_duration), ikke fratrukket pause — jf. spec §5.
 */
function _normalizeLabor(rec, isShift, hqName) {
    const owner = rec.owner || {};
    const jt    = rec.jobtype || {};
    const startDt = rec.planned_start_dt || '';
    const location = rec.location?.title || '';

    const plannedHours    = _secToHours(rec.planned_shift_duration)
                          ?? _hoursBetween(rec.planned_start_dt, rec.planned_end_dt);
    const attendanceHours = _secToHours(rec.attendance_shift_duration)
                          ?? _hoursBetween(rec.attendance_start_dt, rec.attendance_end_dt);

    return {
        employee_id:       owner.uuid || null,
        employee_name:     [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null,
        jobtype_uuid:      jt.uuid || null,
        jobtype_title:     jt.title || '',
        date:              rec.display_date || (startDt ? startDt.slice(0, 10) : null),
        planned_start:     _extractTime(rec.planned_start_dt),
        planned_end:       _extractTime(rec.planned_end_dt),
        planned_hours:     plannedHours,
        attendance_start:  _extractTime(rec.attendance_start_dt),
        attendance_end:    _extractTime(rec.attendance_end_dt),
        attendance_hours:  attendanceHours,
        attendance_status: rec.attendance_status || null,
        location,
        location_class:    _classifyLocation(location, hqName),
        is_shift:          !!isShift,
    };
}

/**
 * Hent berigede labor-rækker for et datointerval.
 * Worklogs (fortid) bærer både planned_* og attendance_*; shifts (fremtid)
 * kun planned_*. Worklogs har forrang ved overlap (de er rigere — har faktisk
 * fremmøde), modsat getShifts() der prioriterer shifts.
 * @returns {Promise<Array>} labor-rækker (se _normalizeLabor)
 */
async function getLaborRows(fromDate, toDate) {
    const cacheKey = `labor_${fromDate}_${toDate}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [shifts, worklogs] = await Promise.all([
        smartplanFetch(
            `/shifts/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}`
        ).catch(() => []),
        smartplanFetch(
            `/worklogs/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}&ordering=planned_start_dt`
        ).catch(() => []),
    ]);

    const hqName = _hqLocationName();
    const rows = [];
    const seen = new Set();
    const keyOf = (r) => (r.employee_id || '') + '_' + r.date + '_' + r.planned_start;

    // Worklogs først (forrang) — de bærer attendance.
    for (const w of worklogs.map(r => _normalizeLabor(r, false, hqName))) {
        if (!w.date) continue;
        seen.add(keyOf(w));
        rows.push(w);
    }
    // Shifts udfylder huller (fremtidige dage uden worklog).
    for (const s of shifts.map(r => _normalizeLabor(r, true, hqName))) {
        if (!s.date) continue;
        if (!seen.has(keyOf(s))) rows.push(s);
    }

    setCached(cacheKey, rows);
    return rows;
}

/**
 * Hent den fulde medarbejder-roster fra Smartplans /members/-endpoint.
 * Modsat getEmployees() (der udleder fra nylige shifts) giver dette ALLE
 * medlemmer + initialer + email — bruges til at matche løn-CSV-rækker
 * (navn/initialer) til owner.uuid, så wage_rates kan join'es på worklogs.
 * @returns {Promise<Array>} [{ uuid, first_name, last_name, name, initials, email, user_type }]
 */
async function getMembers() {
    const cached = getCached('members_full');
    if (cached) return cached;

    const rows = await smartplanFetch('/members/').catch(() => []);
    const members = rows.map(m => ({
        uuid:       m.uuid || null,
        first_name: m.first_name || null,
        last_name:  m.last_name || null,
        name:       [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
        initials:   m.initials || null,
        email:      m.email || null,
        user_type:  m.user_type || null,
    }));

    setCached('members_full', members, 60 * 60 * 1000); // 1 time
    return members;
}

/**
 * Komplet løn-roster: nuværende medlemmer (/members/) FLETTET med medarbejdere
 * der optræder i historiske worklogs siden `sinceDate`. Stoppede medarbejdere
 * (ikke længere på /members/) har stadig brug for en sats til bagudrettede
 * driftsregnskaber. owner i worklogs bærer uuid+navn+initialer, så de kan matches.
 * @param {string} sinceDate  'YYYY-MM-DD' — hvor langt tilbage worklogs scannes
 * @returns {Promise<Array>} [{ uuid, name, first_name, last_name, initials, email, active, last_shift }]
 */
async function getLaborRoster(sinceDate) {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `roster_${sinceDate}_${today}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [members, worklogs] = await Promise.all([
        smartplanFetch('/members/').catch(() => []),
        smartplanFetch(`/worklogs/?start_date=${encodeURIComponent(sinceDate)}&end_date=${encodeURIComponent(today)}`).catch(() => []),
    ]);

    const map = new Map();
    for (const m of members) {
        if (!m.uuid) continue;
        map.set(m.uuid, {
            uuid: m.uuid,
            first_name: m.first_name || null,
            last_name:  m.last_name || null,
            name:       [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
            initials:   m.initials || null,
            email:      m.email || null,
            active:     true,
            last_shift: null,
        });
    }
    for (const w of worklogs) {
        const o = w.owner || {};
        if (!o.uuid) continue;
        const d = w.display_date || (w.planned_start_dt ? w.planned_start_dt.slice(0, 10) : null);
        let e = map.get(o.uuid);
        if (!e) {
            e = {
                uuid: o.uuid,
                first_name: o.first_name || null,
                last_name:  o.last_name || null,
                name:       [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
                initials:   o.initials || null,
                email:      null,
                active:     false,           // ikke på nuværende roster → stoppet
                last_shift: null,
            };
            map.set(o.uuid, e);
        }
        if (d && (!e.last_shift || d > e.last_shift)) e.last_shift = d;
    }

    const roster = [...map.values()].sort((a, b) =>
        (Number(b.active) - Number(a.active)) || (a.name || '').localeCompare(b.name || '', 'da'));

    setCached(cacheKey, roster, 60 * 60 * 1000); // 1 time
    return roster;
}

/* ══════════════════════════════════════════════════════════════ */

module.exports = {
    getShifts,
    getEmployees,
    getLaborRows,
    getMembers,
    getLaborRoster,
    clearCache,
};
