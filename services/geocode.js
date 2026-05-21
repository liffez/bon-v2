// services/geocode.js
// ==========================================
// Geokodning af danske adresser via DAWA
// (Danmarks Adressers Web API — api.dataforsyningen.dk).
//
// Ingen API-nøgle. Samme tjeneste som v1's leveringsberegner og
// v2's embed-bestillingsformular allerede bruger.
//
// Routing (services/routing.js) kræver lat/lon på leveringsadresser.
// addresses-tabellen har lat/lon-kolonner (migration 001) men de er
// typisk NULL for v1-synkede adresser — denne service fylder dem.
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 3.
// ==========================================

const { getDb } = require('../db/database');

const DAWA_BASE = 'https://api.dataforsyningen.dk';
const TIMEOUT_MS = 6000;

// ==========================================
// Tynd fetch-wrapper med timeout.
// ==========================================
async function dawaFetch(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${DAWA_BASE}${path}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
        });
        if (!res.ok) throw new Error(`DAWA svarede ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ==========================================
// Trækker {lat,lon} ud af en DAWA mini-struktur-række.
// I struktur=mini er x = længdegrad, y = breddegrad (WGS84).
// ==========================================
function coordsFromRow(row) {
    if (!row) return null;
    const lon = Number(row.x);
    const lat = Number(row.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

// ==========================================
// geocodeRaw({ street, nr, zip }) → { lat, lon } | null
//
// Primær: struktureret opslag (vejnavn + husnr + postnr).
// Fallback: fri-tekst q-søgning hvis det strukturerede giver 0 hits
// (fanger v1-synkede adresser med skæve husnumre/stavemåder).
// ==========================================
async function geocodeRaw({ street, nr, zip } = {}) {
    if (!street || !String(street).trim()) return null;

    // 1) Struktureret opslag
    const params = new URLSearchParams({ struktur: 'mini', per_side: '1' });
    params.set('vejnavn', String(street).trim());
    if (nr) params.set('husnr', String(nr).trim());
    if (zip) params.set('postnr', String(zip).trim());

    let results = null;
    try {
        results = await dawaFetch(`/adgangsadresser?${params.toString()}`);
    } catch (e) {
        results = null;
    }
    let coords = coordsFromRow(Array.isArray(results) ? results[0] : null);
    if (coords) return coords;

    // 2) Fri-tekst fallback
    const q = [street, nr, zip].filter(Boolean).join(' ').trim();
    try {
        const fp = new URLSearchParams({ struktur: 'mini', per_side: '1', q });
        results = await dawaFetch(`/adgangsadresser?${fp.toString()}`);
    } catch (e) {
        return null;
    }
    return coordsFromRow(Array.isArray(results) ? results[0] : null);
}

// ==========================================
// geocodeAddress(addressId) → { lat, lon } | null
//
// Læser addresses-rækken, geokoder hvis lat/lon mangler, og skriver
// coords tilbage til addresses. Returnerer eksisterende coords uændret
// hvis rækken allerede er geokodet.
// ==========================================
async function geocodeAddress(addressId) {
    const db = getDb();
    const addr = db.prepare(`
        SELECT id, street_name, street_nr, postal_code, city, lat, lon
        FROM addresses WHERE id = ?
    `).get(addressId);
    if (!addr) return null;

    if (addr.lat != null && addr.lon != null) {
        return { lat: addr.lat, lon: addr.lon };
    }

    const coords = await geocodeRaw({
        street: addr.street_name,
        nr: addr.street_nr,
        zip: addr.postal_code
    });
    if (!coords) return null;

    db.prepare('UPDATE addresses SET lat = ?, lon = ? WHERE id = ?')
        .run(coords.lat, coords.lon, addressId);
    return coords;
}

module.exports = { geocodeRaw, geocodeAddress };
