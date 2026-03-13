/**
 * services/smartplanAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Smartplan.dk vagtplan-API.
 *
 * Eksporterer funktioner der kaldes fra routes/smartplan.js.
 * Henter credentials fra settings-tabellen (med .env fallback).
 * In-memory cache med 5 min TTL.
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
   SMARTPLAN CONFIG
   ══════════════════════════════════════════════════════════════ */

/**
 * Hent Smartplan-konfiguration fra settings-tabellen.
 * Fallback til .env-variabler (SMARTPLAN_API_URL, SMARTPLAN_API_KEY).
 */
function getSmartplanConfig() {
    const db = getDb();

    const urlSetting = db.prepare(`SELECT value FROM settings WHERE key = 'smartplan_api_url'`).get();
    const keySetting = db.prepare(`SELECT value FROM settings WHERE key = 'smartplan_api_key'`).get();

    const url = (urlSetting?.value) || process.env.SMARTPLAN_API_URL || '';
    const key = (keySetting?.value) || process.env.SMARTPLAN_API_KEY || '';

    if (!url) {
        throw new Error('Smartplan API ikke konfigureret. Sæt smartplan_api_url i settings eller SMARTPLAN_API_URL i .env.');
    }
    if (!key) {
        throw new Error('Smartplan API-nøgle mangler. Sæt smartplan_api_key i settings eller SMARTPLAN_API_KEY i .env.');
    }

    return { url, key };
}

/* ══════════════════════════════════════════════════════════════
   HTTP
   ══════════════════════════════════════════════════════════════ */

/**
 * Fetch fra Smartplan API med autentificering.
 * @param {string} path  Sti relativt til API-rod
 */
async function smartplanFetch(path) {
    const { url, key } = getSmartplanConfig();

    const base = url.replace(/\/+$/, '');
    const route = path.startsWith('/') ? path : '/' + path;

    const res = await fetch(base + route, {
        headers: {
            'Authorization': `Bearer ${key}`,
            'Accept': 'application/json',
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Smartplan API fejl ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json();
}

/**
 * Fetch med cache-lag.
 */
async function cachedFetch(cacheKey, path) {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await smartplanFetch(path);
    setCached(cacheKey, data);
    return data;
}

/* ══════════════════════════════════════════════════════════════
   NORMALISERINGSLAG
   ══════════════════════════════════════════════════════════════
   Smartplan API-formatet er ikke fuldt dokumenteret.
   Normaliseringen mapper response → fast format.
   Kun dette lag skal justeres når det faktiske API-format kendes.
   ══════════════════════════════════════════════════════════════ */

/**
 * Normalisér et enkelt vagt-objekt til vores faste format.
 * Felterne forsøges i flere varianter for at håndtere API-ændringer.
 */
function _normalizeShift(shift) {
    return {
        employee_id:   shift.employee_id || shift.member_id || shift.id || null,
        employee_name: shift.employee_name || shift.member_name || shift.name || 'Ukendt',
        date:          shift.date || (shift.start_time ? shift.start_time.slice(0, 10) : null),
        start_time:    _extractTime(shift.start || shift.start_time || shift.from || ''),
        end_time:      _extractTime(shift.end || shift.end_time || shift.to || ''),
        job_type:      shift.job_type || shift.position || shift.role || '',
        location:      shift.location || shift.department || '',
    };
}

/** Ekstrahér HH:MM fra enten "HH:MM" eller ISO datetime */
function _extractTime(val) {
    if (!val) return '';
    if (val.includes('T')) {
        // ISO format: "2026-03-13T09:00:00"
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
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @returns {Promise<Array>} Normaliserede vagt-objekter
 */
async function getShifts(fromDate, toDate) {
    const cacheKey = `shifts_${fromDate}_${toDate}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Endpoint-sti tilpasses efter faktisk Smartplan API
    const data = await smartplanFetch(`/shifts?from=${fromDate}&to=${toDate}`);

    const shifts = (Array.isArray(data) ? data : data.shifts || data.hours || data.data || []);
    const normalized = shifts.map(_normalizeShift).filter(s => s.date);

    setCached(cacheKey, normalized);
    return normalized;
}

/**
 * Hent medarbejderliste.
 * @returns {Promise<Array>}
 */
async function getEmployees() {
    return cachedFetch('employees', '/employees');
}

/* ══════════════════════════════════════════════════════════════ */

module.exports = {
    getShifts,
    getEmployees,
    clearCache,
};
