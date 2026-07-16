// services/bonTransportCo2.js
// ==========================================
// Per-bon transport-CO₂ (Fase 3) — DB-wrapper omkring den rene co2Transport-service.
// Loader vogn-faktorer + rute/geo/haversine for en given liste bons og returnerer
// { grams, kg, source, vehicle_label } pr. bon. Genbruger PRÆCIS samme logik
// (resolveVehicle → hierarki → haversine-fallback) som /api/co2/transport.
//
// Bruges af GET /api/bons/:id + kitchen today/later, så bon-kort + kundemail
// kan vise "Mad X · Transport Y · I alt Z".
// ==========================================

const transport = require('./co2Transport');

function _placeholder(id) {
    return [id, { grams: 0, kg: 0, source: 'none', vehicle_label: null }];
}

/**
 * @param {Database} db  node:sqlite handle (getDb())
 * @param {Array} bons   [{ id, delivery_type, delivery_method, delivery_vehicle_id, delivery_address_id }]
 * @returns {Map} Map(bon_id → { grams, kg, source, vehicle_label })
 */
function computeForBons(db, bons) {
    const out = new Map();
    if (!Array.isArray(bons) || !bons.length) return out;
    for (const b of bons) out.set(b.id, _placeholder(b.id)[1]);

    // Vogne → byId + byType (default pr. type = aktiv, laveste sort_order).
    const vehicles = db.prepare(`
        SELECT id, label, type, color, sort_order, is_active,
               co2_g_per_km, co2_g_fixed, co2_distance_multiplier, co2_positioning_km
        FROM delivery_vehicles ORDER BY is_active DESC, sort_order, id
    `).all();
    const byId = new Map(vehicles.map(v => [v.id, v]));
    const byType = new Map();
    for (const v of vehicles) if (!byType.has(v.type)) byType.set(v.type, v);

    // Ruter der indeholder mindst én af disse bons → fuld stop-liste (til §3-fordeling).
    const bonIds = bons.map(b => b.id);
    const idPh = bonIds.map(() => '?').join(',');
    const routeIdRows = bonIds.length
        ? db.prepare(`SELECT DISTINCT route_id FROM delivery_route_stops WHERE bon_id IN (${idPh})`).all(...bonIds)
        : [];
    const routeById = new Map();
    const bonToRoute = new Map();
    if (routeIdRows.length) {
        const rIds = routeIdRows.map(r => r.route_id);
        const rPh = rIds.map(() => '?').join(',');
        const stops = db.prepare(`
            SELECT rs.bon_id, rs.route_id, rs.distance_from_prev_m, r.total_km
            FROM delivery_route_stops rs
            JOIN delivery_routes r ON r.id = rs.route_id
            WHERE rs.route_id IN (${rPh})
        `).all(...rIds);
        for (const s of stops) {
            if (!routeById.has(s.route_id)) routeById.set(s.route_id, { total_km: s.total_km, stops: [] });
            routeById.get(s.route_id).stops.push({ bon_id: s.bon_id, distance_from_prev_m: s.distance_from_prev_m });
            bonToRoute.set(s.bon_id, s.route_id);
        }
    }

    // Geo-afstand (ORS-cache) + adresse-koordinater (haversine-fallback) for de relevante adresser.
    const addrIds = [...new Set(bons.map(b => b.delivery_address_id).filter(x => x != null))];
    const addrDist = new Map();
    const addrCoords = new Map();
    if (addrIds.length) {
        const aPh = addrIds.map(() => '?').join(',');
        for (const g of db.prepare(`
            SELECT address_id, distance_meters FROM geo_calculations
            WHERE distance_meters IS NOT NULL AND address_id IN (${aPh})
            ORDER BY calculated_at DESC, id DESC
        `).all(...addrIds)) {
            if (!addrDist.has(g.address_id)) addrDist.set(g.address_id, g.distance_meters);
        }
        for (const a of db.prepare(`
            SELECT id, lat, lon FROM addresses
            WHERE lat IS NOT NULL AND lon IS NOT NULL AND id IN (${aPh})
        `).all(...addrIds)) {
            addrCoords.set(a.id, { lat: Number(a.lat), lon: Number(a.lon) });
        }
    }

    const hqRows = db.prepare(
        `SELECT key, value FROM settings WHERE key IN ('delivery_hq_lat','delivery_hq_lon')`
    ).all();
    const hqMap = {};
    for (const r of hqRows) hqMap[r.key] = Number(r.value);
    const hq = (Number.isFinite(hqMap.delivery_hq_lat) && Number.isFinite(hqMap.delivery_hq_lon))
        ? { lat: hqMap.delivery_hq_lat, lon: hqMap.delivery_hq_lon } : null;

    for (const bon of bons) {
        // Afhentning / event-uden-vogn tæller 0 (kundens transport uden for scope).
        if (bon.delivery_type === 'pickup' || bon.delivery_method === 'pickup') {
            out.set(bon.id, { grams: 0, kg: 0, source: 'none', vehicle_label: null });
            continue;
        }
        const vehicle = transport.resolveVehicle(bon, byId, byType);
        const route = bonToRoute.has(bon.id) ? routeById.get(bonToRoute.get(bon.id)) : null;

        let geoCalc = null;
        const cached = bon.delivery_address_id != null ? addrDist.get(bon.delivery_address_id) : undefined;
        if (cached != null) {
            geoCalc = { distance_meters: cached };
        } else if (hq && bon.delivery_address_id != null && addrCoords.has(bon.delivery_address_id)) {
            const c = addrCoords.get(bon.delivery_address_id);
            if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
                geoCalc = { distance_meters: transport.haversineKm(hq.lat, hq.lon, c.lat, c.lon) * 1000 * transport.ROAD_FACTOR };
            }
        }

        const r = transport.transportCo2ForBon({ bon, vehicle, route, geoCalc });
        out.set(bon.id, {
            grams: r.grams,
            kg: Math.round(r.grams / 1000 * 100) / 100,
            source: r.source,
            vehicle_label: r.vehicleLabel,
        });
    }

    return out;
}

/** Bekvemmeligheds-wrapper for én bon. */
function computeForBon(db, bon) {
    return computeForBons(db, [bon]).get(bon.id);
}

module.exports = { computeForBons, computeForBon };
