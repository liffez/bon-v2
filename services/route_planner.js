// services/route_planner.js
// ==========================================
// Rute-orchestrator for Delivery Spor 2.
//
// computeRoute(routeId)       — beregner ETA pr. stop, afhentningstid,
//                               constraints. SKRIVER IKKE til DB.
// applyRouteProposal(id, p)   — skriver et beregnet forslag til DB.
//
// Office bestemmer stop-rækkefølgen ved drag — ORS respekterer den givne
// rækkefølge (ingen auto-optimering, jf. spec sektion 13).
//
// Constraint-brud er ADVARSLER, ikke spærringer. computeRoute markerer
// dem i errors/warnings + feasible-flaget, men apply/confirm nægter
// aldrig — office har sidste ord (kunder betaler gerne for cykellevering
// langt ude).
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 7.
// ==========================================

const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');
const { logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const routing = require('./routing');
const { getVehicleById, estimateCost } = require('./booking_template');
const { geocodeAddress } = require('./geocode');
const { getHqCoords, getSafetyMargin } = require('./delivery_calc');

// Bons hvor køkkenet allerede har disponeret efter afhentningstiden —
// apply må ikke overskrive deres pickup_time.
const PICKUP_LOCKED_STATUSES = new Set([
    'KLAR', 'LEVERET', 'FAKTURERET', 'AFSLUTTET', 'BETALT'
]);

const TIGHT_BUFFER_MIN = 15;

// ─── tid-helpers ──────────────────────────────────────────
// "HH:MM" → sekunder siden midnat. null hvis ugyldigt.
function hhmmToSec(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 60;
}
// sekunder → "HH:MM" (wrapper rundt om døgnet).
function secToHhmm(sec) {
    let s = Math.round(sec);
    s = ((s % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getServiceTimeMin() {
    const row = getDb().prepare(
        "SELECT value FROM settings WHERE key = 'delivery_default_service_time_min'"
    ).get();
    const n = row ? parseInt(row.value, 10) : 5;
    return Number.isFinite(n) ? n : 5;
}

// ─── route + stops fra DB ─────────────────────────────────
function getRouteRow(routeId) {
    return getDb().prepare('SELECT * FROM delivery_routes WHERE id = ?').get(routeId);
}

function getRouteStops(routeId) {
    return getDb().prepare(`
        SELECT s.id AS stop_id, s.bon_id, s.sequence,
               b.bon_number, b.delivery_time, b.boxes, b.pax,
               b.delivery_address_id, b.pickup_time AS bon_pickup_time,
               sd.code AS status_code,
               a.lat, a.lon
        FROM delivery_route_stops s
        JOIN bons b               ON b.id = s.bon_id
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN addresses a     ON a.id = b.delivery_address_id
        WHERE s.route_id = ?
        ORDER BY s.sequence
    `).all(routeId);
}

// ==========================================
// computeRoute(routeId)
// → { feasible, pickup_time, ordered_stops[], total_km, total_minutes,
//     estimated_cost_dkk, geometry_geojson, warnings[], errors[] }
// SKRIVER IKKE til DB.
// ==========================================
async function computeRoute(routeId) {
    const route = getRouteRow(routeId);
    if (!route) {
        const err = new Error(`Rute ${routeId} ikke fundet`);
        err.statusCode = 404;
        throw err;
    }

    const vehicle = getVehicleById(route.vehicle_id);
    if (!vehicle) {
        const err = new Error(`Vogn ${route.vehicle_id} ikke fundet`);
        err.statusCode = 404;
        throw err;
    }

    const stops = getRouteStops(routeId);
    const errors = [];
    const warnings = [];

    if (stops.length === 0) {
        return {
            feasible: false, pickup_time: null, ordered_stops: [],
            total_km: 0, total_minutes: 0, estimated_cost_dkk: null,
            geometry_geojson: null,
            warnings: [], errors: [{ code: 'no_stops', message: 'Ruten har ingen stop' }]
        };
    }

    const hq = getHqCoords();
    if (!hq) {
        return {
            feasible: false, pickup_time: null, ordered_stops: [],
            total_km: 0, total_minutes: 0, estimated_cost_dkk: null,
            geometry_geojson: null, warnings: [],
            errors: [{ code: 'hq_not_configured', message: 'HQ-koordinater er ikke konfigureret' }]
        };
    }

    // Geokod stop-adresser der mangler coords (synkront — office venter).
    for (const s of stops) {
        if ((s.lat == null || s.lon == null) && s.delivery_address_id) {
            try {
                const c = await geocodeAddress(s.delivery_address_id);
                if (c) { s.lat = c.lat; s.lon = c.lon; }
            } catch (e) { /* fanges nedenfor */ }
        }
    }
    const missing = stops.filter(s => s.lat == null || s.lon == null);
    if (missing.length) {
        return {
            feasible: false, pickup_time: null, ordered_stops: [],
            total_km: 0, total_minutes: 0, estimated_cost_dkk: null,
            geometry_geojson: null, warnings: [],
            errors: missing.map(s => ({
                code: 'missing_coords', stop_id: s.stop_id, bon_id: s.bon_id,
                message: `Bon ${s.bon_number} mangler koordinater på leveringsadressen`
            }))
        };
    }

    // ORS-rute: HQ → stop1 → ... → HQ. ÉT directions-kald.
    const coords = [hq, ...stops.map(s => ({ lat: s.lat, lon: s.lon })), hq];
    let routed;
    try {
        routed = await routing.getRoute(coords);
    } catch (e) {
        return {
            feasible: false, pickup_time: null, ordered_stops: [],
            total_km: 0, total_minutes: 0, estimated_cost_dkk: null,
            geometry_geojson: null, warnings: [],
            errors: [{ code: e.code || 'ors_error', message: e.message }]
        };
    }

    const legs = routed.legs || [];
    const serviceSec = getServiceTimeMin() * 60;
    const marginSec = getSafetyMargin() * 60;

    // Kumulativ tid fra HQ-afgang til ankomst ved hvert stop.
    // cum[0] = leg[0]; cum[i] = cum[i-1] + service + leg[i].
    const cum = [];
    for (let i = 0; i < stops.length; i++) {
        const legDur = legs[i] ? legs[i].duration_s : 0;
        cum[i] = (i === 0 ? 0 : cum[i - 1] + serviceSec) + legDur;
    }

    // Fælles afhentnings-model: lead pr. stop er enten et fast tal
    // (vehicle.pickup_lead_min — fx By-expressen 45 min, de ruter selv) eller
    // køretidsbaseret (kumulativ køretid + handover-margin).
    const fixedLeadSec = (vehicle.pickup_lead_min != null)
        ? Number(vehicle.pickup_lead_min) * 60 : null;
    const pickupCandidates = [];
    for (let i = 0; i < stops.length; i++) {
        const dtSec = hhmmToSec(stops[i].delivery_time);
        if (dtSec == null) continue;
        const leadSec = fixedLeadSec != null ? fixedLeadSec : (cum[i] + marginSec);
        pickupCandidates.push(dtSec - leadSec);
    }
    const rawComputed = pickupCandidates.length ? Math.min(...pickupCandidates) : null;
    // Negativt pickup = ruten kan ikke nå deadlines selv ved tidligst mulige
    // afgang. Klamp til 0; constraint 3 (cant_meet_deadline) fanger så bruddet.
    const computedPickupSec = rawComputed == null ? null : Math.max(0, rawComputed);

    // Office kan have sat afhentningstiden manuelt — den vinder, og ETA'er
    // beregnes ud fra den (så constraint-tjek fanger en for stram manuel tid).
    const manualPickupSec = (route.pickup_time_source === 'manual')
        ? hhmmToSec(route.pickup_time) : null;
    const pickupSec = (manualPickupSec != null) ? manualPickupSec : computedPickupSec;
    const pickup_time = pickupSec != null ? secToHhmm(pickupSec) : null;
    const suggested_pickup_time = computedPickupSec != null ? secToHhmm(computedPickupSec) : null;

    // ordered_stops + deadline-constraints pr. stop.
    const ordered_stops = stops.map((s, i) => {
        const etaSec = pickupSec != null ? pickupSec + cum[i] : null;
        const dtSec = hhmmToSec(s.delivery_time);

        if (etaSec != null && dtSec != null) {
            if (etaSec > dtSec) {
                errors.push({
                    code: 'cant_meet_deadline', stop_id: s.stop_id, bon_id: s.bon_id,
                    message: `Bon ${s.bon_number}: ankomst ${secToHhmm(etaSec)} efter deadline ${s.delivery_time}`
                });
            } else if (dtSec - etaSec < TIGHT_BUFFER_MIN * 60) {
                warnings.push({
                    code: 'tight_buffer', stop_id: s.stop_id, bon_id: s.bon_id,
                    message: `Bon ${s.bon_number}: kun ${Math.round((dtSec - etaSec) / 60)} min margin til deadline`
                });
            }
        }

        return {
            stop_id: s.stop_id,
            bon_id: s.bon_id,
            bon_number: s.bon_number,
            sequence: i + 1,
            eta: etaSec != null ? secToHhmm(etaSec) : null,
            delivery_time: s.delivery_time || null,
            distance_from_prev_m: legs[i] ? legs[i].distance_m : null,
            duration_from_prev_s: legs[i] ? legs[i].duration_s : null,
            boxes: s.boxes || 0
        };
    });

    const total_km = Math.round((routed.distance_m / 1000) * 10) / 10;
    const total_minutes = Math.round(routed.duration_s / 60);
    const totalBoxes = stops.reduce((sum, s) => sum + (Number(s.boxes) || 0), 0);

    // Kapacitet + distance — advarsler, ikke spærringer.
    if (vehicle.max_capacity_boxes != null && totalBoxes > Number(vehicle.max_capacity_boxes)) {
        errors.push({
            code: 'capacity_exceeded',
            message: `${totalBoxes} kasser overstiger ${vehicle.label}s kapacitet på ${vehicle.max_capacity_boxes}`
        });
    }
    if (vehicle.max_distance_km != null && total_km > Number(vehicle.max_distance_km)) {
        errors.push({
            code: 'distance_exceeded',
            message: `${total_km} km overstiger ${vehicle.label}s rækkevidde på ${vehicle.max_distance_km} km`
        });
    }

    const estimated_cost_dkk = estimateCost(
        vehicle, { boxes: totalBoxes }, { distance_km: total_km }
    );

    return {
        feasible: errors.length === 0,
        pickup_time,
        suggested_pickup_time,
        pickup_is_manual: manualPickupSec != null,
        ordered_stops,
        total_km,
        total_minutes,
        estimated_cost_dkk,
        geometry_geojson: routed.geometry_geojson || null,
        warnings,
        errors
    };
}

// ==========================================
// applyRouteProposal(routeId, proposal)
// Skriver et beregnet forslag (fra computeRoute) til DB.
// Constraint-brud blokerer IKKE — office har besluttet at anvende det.
// ==========================================
function applyRouteProposal(routeId, proposal) {
    const db = getDb();
    const route = getRouteRow(routeId);
    if (!route) {
        const err = new Error(`Rute ${routeId} ikke fundet`);
        err.statusCode = 404;
        throw err;
    }
    if (!proposal || !Array.isArray(proposal.ordered_stops)) {
        throw new Error('Ugyldigt forslag');
    }

    const changedBons = [];

    transaction(db, () => {
        db.prepare(`
            UPDATE delivery_routes
            SET pickup_time = ?, total_km = ?, total_minutes = ?,
                estimated_cost_dkk = ?, route_geojson = ?,
                status = 'computed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            proposal.pickup_time || null,
            proposal.total_km != null ? proposal.total_km : null,
            proposal.total_minutes != null ? proposal.total_minutes : null,
            proposal.estimated_cost_dkk != null ? proposal.estimated_cost_dkk : null,
            proposal.geometry_geojson ? JSON.stringify(proposal.geometry_geojson) : null,
            routeId
        );

        for (const s of proposal.ordered_stops) {
            db.prepare(`
                UPDATE delivery_route_stops
                SET sequence = ?, eta = ?,
                    distance_from_prev_m = ?, duration_from_prev_s = ?
                WHERE id = ?
            `).run(
                s.sequence, s.eta || null,
                s.distance_from_prev_m != null ? s.distance_from_prev_m : null,
                s.duration_from_prev_s != null ? s.duration_from_prev_s : null,
                s.stop_id
            );

            // pickup_time på bonnen — kun hvis køkkenet ikke allerede har
            // disponeret efter den (status < KLAR).
            if (proposal.pickup_time) {
                const bon = db.prepare(
                    `SELECT b.id, b.pickup_time, sd.code AS status_code
                     FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
                     WHERE b.id = ?`
                ).get(s.bon_id);
                if (bon && !PICKUP_LOCKED_STATUSES.has(bon.status_code)
                    && bon.pickup_time !== proposal.pickup_time) {
                    db.prepare('UPDATE bons SET pickup_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(proposal.pickup_time, s.bon_id);
                    logChange({
                        entityType: 'bon', entityId: s.bon_id, action: 'update',
                        fieldName: 'pickup_time',
                        oldValue: bon.pickup_time, newValue: proposal.pickup_time,
                        notes: `Afhentningstid sat fra rute #${routeId}`
                    });
                    changedBons.push(s.bon_id);
                }
            }
        }
    });

    // Køkken-/kalender-visninger opdaterer på ændret pickup_time.
    for (const bonId of changedBons) {
        broadcast('bon_updated', { id: bonId });
    }

    return {
        route_id: routeId,
        status: 'computed',
        pickup_time: proposal.pickup_time || null,
        stops_updated: proposal.ordered_stops.length,
        bons_pickup_updated: changedBons.length
    };
}

module.exports = { computeRoute, applyRouteProposal, PICKUP_LOCKED_STATUSES };
