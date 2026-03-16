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
   NORMALISERING
   ══════════════════════════════════════════════════════════════ */

/**
 * Normalisér et Smartplan shift-objekt til vores faste format.
 * Smartplan v2 returnerer: owner.first_name/last_name, jobtype.title, location.title
 */
function _normalizeShift(shift) {
    const startDt = shift.start_dt || '';
    const endDt   = shift.end_dt   || '';
    const owner   = shift.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        date:          shift.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      shift.jobtype?.title || '',
        location:      shift.location?.title || '',
    };
}

/**
 * Normalisér et Smartplan worklog-objekt (arkiverede vagter).
 * Bruger planned_start_dt/planned_end_dt i stedet for start_dt/end_dt.
 */
function _normalizeWorklog(wl) {
    const startDt = wl.planned_start_dt || '';
    const endDt   = wl.planned_end_dt   || '';
    const owner   = wl.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        date:          wl.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      wl.jobtype?.title || '',
        location:      wl.location?.title || '',
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

    const normalizedShifts = shifts.map(_normalizeShift);
    const normalizedWorklogs = worklogs.map(_normalizeWorklog);

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
 * Hent medarbejderliste.
 * @returns {Promise<Array>}
 */
async function getEmployees() {
    const cacheKey = 'employees';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const employees = await smartplanFetch('/employees/');
    setCached(cacheKey, employees);
    return employees;
}

/* ══════════════════════════════════════════════════════════════ */

module.exports = {
    getShifts,
    getEmployees,
    clearCache,
};
