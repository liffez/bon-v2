/**
 * Adresseopslag gennem vores egen server — public, monteret på /embed/adresse.
 *
 * GET /embed/adresse/soeg?q=&limit=&fuzzy=1   adresseforslag (DAWA, København først)
 * GET /embed/adresse/afstand?lat=&lon=        køreafstand fra huset (OSRM), til
 *                                             bestillingssidens leveringsestimat
 *
 * Kundens browser skal kun kunne nå vores domæne. Før talte den direkte med
 * api.dataforsyningen.dk og router.project-osrm.org, og en firma-firewall der
 * blokerede dem, gjorde bestillingsformularen umulig at sende — uden en fejl.
 *
 * Ingen login: bestillingssiden og smagsprøven er offentlige. Derfor en
 * grænse pr. IP, så ruterne ikke kan bruges som gratis gateway, og en kort
 * cache så den samme søgning ikke rammer DAWA igen og igen.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { searchAddresses } = require('../services/addressSearch');

// ── Grænse pr. IP ─────────────────────────────────────────────────────────
// Et menneske der skriver en adresse, laver højst et par opslag i sekundet
// (klienterne venter 250–300 ms mellem tastetryk). Hele kontoret deler én IP,
// så grænsen er sat med god luft.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 120;
const hits = new Map(); // ip → { start, count }

function rateLimited(req) {
    const ip = req.ip || req.socket?.remoteAddress || '?';
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start > WINDOW_MS) {
        h = { start: now, count: 0 };
        hits.set(ip, h);
    }
    h.count++;
    if (hits.size > 5000) {
        // Ryd udløbne, så kortet ikke vokser uden grænse.
        for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    }
    return h.count > MAX_PER_WINDOW;
}

// ── Kort cache ────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map(); // key → { at, value }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.value;
}
function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
}

// ─── GET /embed/adresse/soeg ──────────────────────────────────────────────
router.get('/soeg', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.json([]);
    if (rateLimited(req)) return res.status(429).json({ error: 'for_mange_opslag' });

    const fuzzy = req.query.fuzzy === '1' || req.query.fuzzy === 'true';
    const limit = req.query.limit;
    const key = `s|${fuzzy ? 1 : 0}|${limit || ''}|${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    try {
        const list = await searchAddresses(q, { fuzzy, limit });
        cacheSet(key, list);
        res.json(list);
    } catch (e) {
        // 502, ikke 500: det er DAWA der ikke svarede, ikke os. Klienten
        // viser så nødudgangen i stedet for en tom liste.
        console.warn('[adresse/soeg] DAWA svarede ikke:', e.message);
        res.status(502).json({ error: 'adresseopslag_utilgaengeligt' });
    }
});

// ─── GET /embed/adresse/afstand ───────────────────────────────────────────
// Kun fra huset (bestilling.base_lat/lon) — ruten tager ikke et vilkårligt
// startpunkt, så den ikke kan bruges som åben ruteplanlægger.
router.get('/afstand', async (req, res) => {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: 'ugyldige_koordinater' });
    }
    if (rateLimited(req)) return res.status(429).json({ error: 'for_mange_opslag' });

    const rows = getDb().prepare(
        "SELECT key, value FROM settings WHERE key IN ('bestilling.base_lat','bestilling.base_lon')"
    ).all();
    const base = {};
    for (const r of rows) base[r.key] = parseFloat(r.value);
    const bLat = base['bestilling.base_lat'], bLon = base['bestilling.base_lon'];
    if (!Number.isFinite(bLat) || !Number.isFinite(bLon)) {
        return res.status(503).json({ error: 'udgangspunkt_ikke_sat' });
    }

    const key = `a|${lat.toFixed(5)}|${lon.toFixed(5)}|${bLat}|${bLon}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const r = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${bLon},${bLat};${lon},${lat}?overview=false`,
            { signal: ctrl.signal });
        if (!r.ok) throw new Error('OSRM ' + r.status);
        const d = await r.json();
        const m = d.routes && d.routes[0] && d.routes[0].distance;
        if (!Number.isFinite(m)) throw new Error('OSRM uden rute');
        const out = { km: Math.round(m / 100) / 10 };
        cacheSet(key, out);
        res.json(out);
    } catch (e) {
        console.warn('[adresse/afstand] OSRM svarede ikke:', e.message);
        res.status(502).json({ error: 'afstand_utilgaengelig' });
    } finally {
        clearTimeout(timer);
    }
});

// Til tests.
router._reset = () => { hits.clear(); cache.clear(); };

module.exports = router;
