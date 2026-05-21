// services/delivery_calc.js
// ==========================================
// Single-bon leverings-forslag (Workflow B — daglig triage).
//
// For én leveringsadresse: hvor langt er der, hvilken vogn passer,
// og hvad koster hvert alternativ? Office bedømmer selv — dette er
// kun et beslutningsgrundlag.
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 7.
// ==========================================

const { getDb } = require('../db/database');
const { getDistance, RoutingError } = require('./routing');
const { getActiveVehicles, estimateCost } = require('./booking_template');

// ==========================================
// HQ-koordinater fra settings (sat i migration 073).
// ==========================================
function getHqCoords() {
    const rows = getDb().prepare(`
        SELECT key, value FROM settings
        WHERE key IN ('delivery_hq_lat', 'delivery_hq_lon')
    `).all();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    const lat = Number(map.delivery_hq_lat);
    const lon = Number(map.delivery_hq_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

// ==========================================
// Sikkerhedsmargin (minutter) fra settings — default 10.
// ==========================================
function getSafetyMargin() {
    const row = getDb().prepare(
        "SELECT value FROM settings WHERE key = 'delivery_safety_margin_minutes'"
    ).get();
    const n = row ? parseInt(row.value, 10) : 10;
    return Number.isFinite(n) ? n : 10;
}

// ==========================================
// "12:30" forskudt med deltaMinutes → "HH:MM" (negativ = træk fra).
// Returnerer null hvis input ikke er et gyldigt klokkeslæt.
// ==========================================
function shiftTime(hhmm, deltaMinutes) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    let total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + deltaMinutes;
    total = ((total % 1440) + 1440) % 1440;
    const h = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ==========================================
// calculateForBon(input)
//
// input: {
//   addressId?    — leverings-address_id (aktiverer afstands-cache)
//   lat, lon      — leveringskoordinater
//   delivery_time? — leveringstid ("HH:MM") til pickup-beregning
//   boxes?        — antal kasser (kapacitets-constraint + pris)
//   pax?
// }
//
// Returnerer ved succes:
//   { ok:true, distance_m, distance_km, duration_s, duration_min, cached,
//     estimated_pickup_time, suggested_vehicle_id, alternatives:[...] }
//
// Returnerer ved manglende grundlag (ikke en fejl — frontend degraderer):
//   { ok:false, reason, message }
//   reason: 'missing_coords' | 'no_route' | 'no_api_key' | 'timeout' | 'ors_error'
// ==========================================
async function calculateForBon(input) {
    const {
        addressId = null,
        lat, lon,
        delivery_time = null,
        boxes = 0,
        pax = 0
    } = input || {};

    const hq = getHqCoords();
    if (!hq) {
        return { ok: false, reason: 'hq_not_configured',
                 message: 'HQ-koordinater er ikke konfigureret (delivery_hq_lat/lon)' };
    }

    // null/undefined/'' må IKKE coerce'es — Number(null) er 0, ikke NaN.
    const destLat = (lat == null || lat === '') ? NaN : Number(lat);
    const destLon = (lon == null || lon === '') ? NaN : Number(lon);
    if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) {
        return { ok: false, reason: 'missing_coords',
                 message: 'Leveringsadressen mangler koordinater' };
    }
    const dest = { lat: destLat, lon: destLon };

    let distance;
    try {
        distance = await getDistance(hq, dest, { addressId });
    } catch (e) {
        const reason = (e instanceof RoutingError) ? e.code : 'ors_error';
        return { ok: false, reason, message: e.message };
    }

    const km = distance.distance_m / 1000;
    const durationMin = Math.ceil(distance.duration_s / 60);
    const safetyMargin = getSafetyMargin();
    const estimated_pickup_time = delivery_time
        ? shiftTime(delivery_time, -(durationMin + safetyMargin))
        : null;

    const numBoxes = Number(boxes) || 0;
    const bonShape = { boxes: numBoxes, pax: Number(pax) || 0 };
    const alternatives = [];

    for (const v of getActiveVehicles()) {
        const reasons = [];
        let suitable = true;

        if (v.max_distance_km != null && km > Number(v.max_distance_km)) {
            suitable = false;
            reasons.push(`for langt (${km.toFixed(1)} km > ${v.max_distance_km} km)`);
        }
        if (v.max_capacity_boxes != null && numBoxes > Number(v.max_capacity_boxes)) {
            suitable = false;
            reasons.push(`for mange kasser (${numBoxes} > ${v.max_capacity_boxes})`);
        }

        alternatives.push({
            vehicle_id: v.id,
            code: v.code,
            label: v.label,
            type: v.type,
            is_internal: !!v.is_internal,
            cost_dkk: estimateCost(v, bonShape, { distance_km: km }),
            suitable,
            reason: reasons.join(' · ') || null
        });
    }

    // Forslag = billigste egnede vogn. Ukendt pris (intern vogn uden
    // formel) sorteres bagest, men er stadig et gyldigt forslag.
    const suggested = alternatives
        .filter(a => a.suitable)
        .sort((a, b) => (a.cost_dkk ?? Infinity) - (b.cost_dkk ?? Infinity))[0];

    return {
        ok: true,
        distance_m: distance.distance_m,
        distance_km: Math.round(km * 10) / 10,
        duration_s: distance.duration_s,
        duration_min: durationMin,
        cached: !!distance.cached,
        estimated_pickup_time,
        suggested_vehicle_id: suggested ? suggested.vehicle_id : null,
        alternatives
    };
}

module.exports = { calculateForBon, getHqCoords, getSafetyMargin, shiftTime };
