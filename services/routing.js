// services/routing.js
// ==========================================
// Vej-routing via OpenRouteService (ORS) — api.openrouteservice.org.
//
// Engine-agnostisk navn: hvis ORS senere skal erstattes af self-hostet
// OSRM ændres kun implementeringen, ikke interfacet (getDistance/getRoute).
//
// Rigtig vej-routing er påkrævet — København har vand overalt, så
// fugleflugt ≠ køreafstand (Refshaleøen: ~3 km i fugleflugt, ~9 km i bil).
//
// getDistance() cacher HQ→adresse-afstande i geo_calculations nøglet på
// address_id (HQ er fast, så afstanden afhænger kun af leverings-adressen).
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 2 + 7.
// ==========================================

const { getDb } = require('../db/database');

const ORS_BASE = process.env.ORS_BASE_URL || 'https://api.openrouteservice.org';
const ORS_KEY = process.env.ORS_API_KEY || '';
const TIMEOUT_MS = 5000;
const CACHE_TTL_DAYS = 30;

// ==========================================
// RoutingError — bærer en .code så kaldere kan skelne:
//   'no_api_key' — ORS_API_KEY mangler i .env
//   'timeout'    — ORS svarede ikke inden for 5s
//   'no_route'   — coords findes men ORS kan ikke finde en vej
//   'ors_error'  — andet (HTTP-fejl, netværk, ugyldigt svar)
//   'bad_input'  — ugyldige koordinater givet til funktionen
// ==========================================
class RoutingError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'RoutingError';
        this.code = code || 'ors_error';
    }
}

// ==========================================
// Normaliserer et punkt til [lng, lat] (ORS-rækkefølge).
// Accepterer både {lat,lon} (addresses-tabellen) og {lat,lng}.
// ==========================================
function toLngLat(p) {
    if (!p) return null;
    const rawLat = p.lat;
    const rawLng = (p.lng != null && p.lng !== '') ? p.lng : p.lon;
    // null/undefined/'' må IKKE coerce'es — Number(null) er 0, ikke NaN.
    if (rawLat == null || rawLat === '' || rawLng == null || rawLng === '') return null;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lng, lat];
}

// ==========================================
// POST /v2/directions/driving-car/geojson
// coords: [[lng,lat], ...] (mindst 2 punkter)
// Returnerer ORS GeoJSON FeatureCollection.
// ==========================================
async function orsDirections(coords) {
    if (!ORS_KEY) {
        throw new RoutingError('ORS_API_KEY mangler i .env — routing er ikke konfigureret', 'no_api_key');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
        res = await fetch(`${ORS_BASE}/v2/directions/driving-car/geojson`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                Authorization: ORS_KEY,
                'Content-Type': 'application/json',
                // /geojson-endpointet kræver geo+json — application/json giver HTTP 406.
                Accept: 'application/geo+json'
            },
            body: JSON.stringify({ coordinates: coords })
        });
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new RoutingError('ORS svarede ikke inden for 5 sekunder', 'timeout');
        }
        throw new RoutingError(`ORS-forbindelse fejlede: ${e.message}`, 'ors_error');
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch (e) { /* ikke-JSON fejlsvar */ }
        const orsCode = body && body.error && body.error.code;
        const orsMsg = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        // ORS-fejlkode 2010 = intet routbart punkt tæt på koordinaten
        const code = orsCode === 2010 ? 'no_route' : 'ors_error';
        throw new RoutingError(`ORS: ${orsMsg}`, code);
    }

    return res.json();
}

// ==========================================
// Cache-opslag — geo_calculations nøglet på address_id.
// Returnerer null ved miss eller udløbet TTL.
// ==========================================
function readCache(addressId) {
    const row = getDb().prepare(`
        SELECT distance_meters, duration_seconds
        FROM geo_calculations
        WHERE address_id = ?
          AND bon_id IS NULL
          AND distance_meters IS NOT NULL
          AND calculated_at >= datetime('now', ?)
        ORDER BY calculated_at DESC
        LIMIT 1
    `).get(addressId, `-${CACHE_TTL_DAYS} days`);
    if (!row) return null;
    return {
        distance_m: Math.round(row.distance_meters),
        duration_s: Math.round(row.duration_seconds),
        cached: true
    };
}

// ==========================================
// Skriver cache — én routing-række pr. address_id (bon_id IS NULL).
// Gamle rækker for samme adresse ryddes så tabellen ikke vokser.
// ==========================================
function writeCache(addressId, result) {
    try {
        const db = getDb();
        db.prepare('DELETE FROM geo_calculations WHERE address_id = ? AND bon_id IS NULL').run(addressId);
        db.prepare(`
            INSERT INTO geo_calculations
                (bon_id, address_id, distance_meters, duration_seconds, route_geojson, calculated_at)
            VALUES (NULL, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
        `).run(addressId, result.distance_m, result.duration_s);
    } catch (e) {
        console.warn('[routing] kunne ikke skrive cache:', e.message);
    }
}

// ==========================================
// getDistance(from, to, { addressId }) → { distance_m, duration_s, cached? }
//
// from/to: {lat,lon} eller {lat,lng}.
// addressId (valgfri): aktiverer cache. Antager from = HQ — kald kun med
// addressId for HQ→adresse-opslag, ellers bliver cachen forkert.
// ==========================================
async function getDistance(from, to, { addressId = null } = {}) {
    const a = toLngLat(from);
    const b = toLngLat(to);
    if (!a || !b) throw new RoutingError('Ugyldige koordinater til getDistance', 'bad_input');

    if (addressId) {
        const hit = readCache(addressId);
        if (hit) return hit;
    }

    const data = await orsDirections([a, b]);
    const feat = data && data.features && data.features[0];
    const summary = feat && feat.properties && feat.properties.summary;
    if (!summary) throw new RoutingError('ORS returnerede ingen rute', 'no_route');

    const result = {
        distance_m: Math.round(summary.distance),
        duration_s: Math.round(summary.duration)
    };
    if (addressId) writeCache(addressId, result);
    return result;
}

// ==========================================
// getRoute(coords) → { distance_m, duration_s, legs[], geometry_geojson }
//
// coords: [{lat,lng}, ...] inkl. HQ som start/slut. ÉT directions-kald
// giver alle legs + geometri. Office bestemmer stop-rækkefølgen — ORS
// respekterer den givne rækkefølge (ingen auto-optimering).
// Caches ikke (geometri ændrer sig med stop, lav volumen).
// ==========================================
async function getRoute(coords) {
    const pts = (coords || []).map(toLngLat);
    if (pts.length < 2 || pts.some(p => !p)) {
        throw new RoutingError('getRoute kræver mindst 2 gyldige punkter', 'bad_input');
    }

    const data = await orsDirections(pts);
    const feat = data && data.features && data.features[0];
    const summary = feat && feat.properties && feat.properties.summary;
    if (!summary) throw new RoutingError('ORS returnerede ingen rute', 'no_route');

    const segments = (feat.properties.segments || []).map(s => ({
        distance_m: Math.round(s.distance),
        duration_s: Math.round(s.duration)
    }));

    return {
        distance_m: Math.round(summary.distance),
        duration_s: Math.round(summary.duration),
        legs: segments,
        geometry_geojson: feat.geometry || null
    };
}

// ==========================================
// healthCheck() → { up: bool, reason?, message? }
// Pinger ORS med et lille directions-kald i HQ-området.
// ==========================================
async function healthCheck() {
    if (!ORS_KEY) return { up: false, reason: 'no_api_key' };
    try {
        await orsDirections([[12.5523, 55.6934], [12.5613, 55.6875]]);
        return { up: true };
    } catch (e) {
        return { up: false, reason: e.code || 'error', message: e.message };
    }
}

module.exports = { getDistance, getRoute, healthCheck, RoutingError };
