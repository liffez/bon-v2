// services/co2Transport.js
// ==========================================
// Transport-CO₂ pr. levering — REN beregningslogik (ingen DB, ingen ORS).
// Spec: docs/CLAUDE_CO2_TRANSPORT.md §1b (legacy-resolver) + §2 (hierarki) + §3 (rutefordeling).
//
// Intet snapshot i v1 — routes/co2.js kalder dette on-the-fly og aggregerer.
// Km ligger fast i geo-data (geo_calculations / delivery_routes); kun
// faktorerne på delivery_vehicles er "live".
// ==========================================

// Legacy: bons uden delivery_vehicle_id har kun delivery_method-enum'en.
// bike = altid By-expressen historisk (Leif). type↔vogn er 1:1 blandt disse.
// 'own-bike' (Egen cykel) nås aldrig via legacy — kun via delivery_vehicle_id.
const METHOD_TO_TYPE = { volvo: 'volvo', bike: 'bike', taxi: 'taxi' };

// Vej-detour-faktor: haversine (fugleflugt) undervurderer vejafstand. ×1,3 er en
// standard-tilnærmelse når ORS-vejcachen mangler (gamle bons uden ruteberegning).
const ROAD_FACTOR = 1.3;
const _RAD = Math.PI / 180;

/** Fugleflugt-afstand i km mellem to koordinater (til estimat-fallback). */
function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * _RAD;
    const dLon = (lon2 - lon1) * _RAD;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * _RAD) * Math.cos(lat2 * _RAD) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Robust tal-parse (accepterer dansk decimalkomma). Tom/ugyldig → 0. */
function num(raw) {
    if (raw == null || raw === '') return 0;
    let s = String(raw).trim();
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Resolv hvilken vogn en bon skal bruge (§1b).
 * @param {object} bon  { delivery_vehicle_id?, delivery_method? }
 * @param {Map} byId    Map(vehicle_id → vehicle)
 * @param {Map} byType  Map(type → vehicle) — udpeget default pr. type
 * @returns {object|null} vogn, eller null for afhentning/ukendt
 */
function resolveVehicle(bon, byId, byType) {
    if (bon.delivery_vehicle_id != null) {
        const v = byId.get(Number(bon.delivery_vehicle_id));
        if (v) return v;
    }
    const method = bon.delivery_method;
    if (method === 'pickup' || method == null) return null;
    const type = METHOD_TO_TYPE[method];
    return type ? (byType.get(type) || null) : null;
}

/** Udtræk CO₂-faktorer fra en vogn-række (defensivt mod manglende felter). */
function factorsOf(vehicle) {
    return {
        gPerKm: num(vehicle.co2_g_per_km),
        gFixed: num(vehicle.co2_g_fixed),
        multiplier: vehicle.co2_distance_multiplier == null ? 1 : num(vehicle.co2_distance_multiplier),
        positioningKm: num(vehicle.co2_positioning_km),
    };
}

/** Om vognen har nogen CO₂-konfiguration overhovedet (ellers = "none"). */
function isConfigured(f) {
    return f.gPerKm !== 0 || f.gFixed !== 0;
}

/**
 * Fordel en beregnet rutes CO₂ + km km-vægtet pr. stop (§3).
 * @param {object} route { total_km, stops: [{ bon_id, distance_from_prev_m }] }
 * @param {number} gPerKm
 * @returns {Map} Map(bon_id → { grams, km }) — Σ grams/km eksakt (rest på sidste stop)
 */
function distributeRouteCo2(route, gPerKm) {
    const out = new Map();
    const stops = Array.isArray(route.stops) ? route.stops : [];
    if (!stops.length) return out;

    const routeKm = num(route.total_km);
    const routeGrams = routeKm * num(gPerKm); // km × g/km = gram

    // Vægt = ben-km (distance_from_prev_m). Mangler alle → ligelig fordeling.
    const weights = stops.map(s => Math.max(0, num(s.distance_from_prev_m)));
    let sumW = weights.reduce((a, b) => a + b, 0);
    const useEqual = sumW <= 0;
    if (useEqual) sumW = stops.length;

    let allocG = 0, allocKm = 0;
    stops.forEach((s, i) => {
        const isLast = i === stops.length - 1;
        let g, km;
        if (isLast) {
            g = routeGrams - allocG;                 // rest → eksakt sum
            km = routeKm - allocKm;
        } else {
            const share = useEqual ? (1 / sumW) : (weights[i] / sumW);
            g = routeGrams * share;
            km = routeKm * share;
            allocG += g; allocKm += km;
        }
        out.set(Number(s.bon_id), { grams: g, km });
    });
    return out;
}

/**
 * Transport-CO₂ for én bon (§2 hierarki).
 * @param {object} args
 * @param {object} args.bon      { id, delivery_vehicle_id?, delivery_method? }
 * @param {object|null} args.vehicle  resolvet vogn (fra resolveVehicle) eller null
 * @param {object|null} args.route    { total_km, stops:[{bon_id, distance_from_prev_m}] } hvis bon er på beregnet rute
 * @param {object|null} args.geoCalc  { distance_meters } hvis HQ→adresse-afstand findes
 * @returns {{ grams:number, km:number, source:'route'|'p2p'|'fixed'|'none', vehicleLabel:string|null }}
 */
function transportCo2ForBon({ bon, vehicle, route = null, geoCalc = null }) {
    if (!vehicle) {
        return { grams: 0, km: 0, source: 'none', vehicleLabel: null };
    }
    const label = vehicle.label || null;
    const f = factorsOf(vehicle);

    // Uden nogen konfiguration = ingen data (skelnes fra bevidst 0, se nedenfor).
    if (!isConfigured(f)) {
        return { grams: 0, km: 0, source: 'none', vehicleLabel: label };
    }

    // 1) Bon på beregnet rute → km-vægtet andel af rutens CO₂ + km.
    if (route && Array.isArray(route.stops) && route.stops.length) {
        const dist = distributeRouteCo2(route, f.gPerKm);
        if (dist.has(Number(bon.id))) {
            const { grams, km } = dist.get(Number(bon.id));
            return { grams, km, source: 'route', vehicleLabel: label };
        }
    }

    // 2) Punkt-til-punkt via geo-data (typisk eksterne bud + ikke-rutede interne).
    //    Positionerings-tillæg lægges oveni som konstant (ikke × multiplier).
    if (geoCalc && geoCalc.distance_meters != null) {
        const km = f.positioningKm + (num(geoCalc.distance_meters) / 1000) * f.multiplier;
        return { grams: km * f.gPerKm, km, source: 'p2p', vehicleLabel: label };
    }

    // 3) Ingen km-data → fast fallback pr. tur (hvis sat).
    if (f.gFixed > 0) {
        return { grams: f.gFixed, km: 0, source: 'fixed', vehicleLabel: label };
    }

    // 4) Konfigureret (gPerKm sat) men hverken km-data eller fixed → ingen data.
    return { grams: 0, km: 0, source: 'none', vehicleLabel: label };
}

/**
 * Aggregér transport-CO₂ pr. leveringsmetode (ren — data leveres af kalderen).
 * @param {object} args
 * @param {Array}  args.bons       [{ id, delivery_method, delivery_vehicle_id, delivery_address_id }]
 * @param {Map}    args.byId       Map(vehicle_id → vehicle)
 * @param {Map}    args.byType     Map(type → default-vehicle)
 * @param {Map}    args.routeById  Map(route_id → { total_km, stops:[{bon_id, distance_from_prev_m}] })
 * @param {Map}    args.bonToRoute Map(bon_id → route_id)
 * @param {Map}    args.addrDist   Map(address_id → distance_meters)
 * @returns {{ methods:Array, total:object, missing_km_count:number }}
 */
function aggregateMethods({ bons, byId, byType, routeById, bonToRoute, addrDist,
                           addrCoords = new Map(), hq = null, roadFactor = ROAD_FACTOR }) {
    const buckets = new Map();
    const bucketFor = (key, seed) => {
        if (!buckets.has(key)) buckets.set(key, Object.assign(
            { deliveries: 0, grams: 0, km: 0, covered: 0, fixed: 0, none: 0 }, seed));
        return buckets.get(key);
    };

    for (const bon of bons) {
        // Afhentning: primært delivery_type (gamle bons har method=NULL), sekundært method.
        if (bon.delivery_type === 'pickup' || bon.delivery_method === 'pickup') {
            bucketFor('__pickup__', { label: 'Afhentning', color: '#c9c2b8', type: 'pickup', is_pickup: true }).deliveries++;
            continue;
        }
        const vehicle = resolveVehicle(bon, byId, byType);
        const route = bonToRoute.has(bon.id) ? routeById.get(bonToRoute.get(bon.id)) : null;

        // Effektiv afstand: ORS-vejcache først, ellers haversine-estimat fra adressens
        // egne koordinater × vej-faktor (så gamle bons uden ORS-kald stadig får km).
        let geoCalc = null;
        const cached = bon.delivery_address_id != null ? addrDist.get(bon.delivery_address_id) : undefined;
        if (cached != null) {
            geoCalc = { distance_meters: cached };
        } else if (hq && bon.delivery_address_id != null && addrCoords.has(bon.delivery_address_id)) {
            const c = addrCoords.get(bon.delivery_address_id);
            if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
                geoCalc = { distance_meters: haversineKm(hq.lat, hq.lon, c.lat, c.lon) * 1000 * roadFactor };
            }
        }

        const r = transportCo2ForBon({ bon, vehicle, route, geoCalc });
        const key = vehicle ? `v${vehicle.id}` : '__unknown__';
        const b = bucketFor(key, vehicle
            ? { label: vehicle.label, color: vehicle.color || null, type: vehicle.type, is_pickup: false }
            : { label: 'Ukendt', color: null, type: null, is_pickup: false });
        b.deliveries++;
        b.grams += r.grams;
        b.km += r.km;
        if (r.source === 'route' || r.source === 'p2p') b.covered++;
        else if (r.source === 'fixed') b.fixed++;   // konfigureret, men ingen afstand = "mangler km-data"
        else b.none++;                              // ukonfigureret faktor / umappet metode = "ikke opsat"
    }

    // Dækning måles KUN blandt leveringer med en konfigureret vogn (covered + fixed).
    // 'none' (Ukendt/uden faktor) trækker ikke dækningen ned — det er et andet problem.
    const covPct = (b) => {
        const denom = b.covered + b.fixed;
        return denom ? Math.round(b.covered / denom * 100) : null;
    };

    const methods = [...buckets.values()].map(b => ({
        label: b.label,
        color: b.color,
        type: b.type,
        is_pickup: !!b.is_pickup,
        deliveries: b.deliveries,
        km: b.is_pickup ? null : Math.round(b.km),
        co2_kg: b.is_pickup ? 0 : Math.round(b.grams / 1000 * 10) / 10,
        avg_g: (b.is_pickup || !b.deliveries) ? null : Math.round(b.grams / b.deliveries),
        coverage_pct: b.is_pickup ? null : covPct(b),
    })).sort((a, b) => {
        if (a.is_pickup !== b.is_pickup) return a.is_pickup ? 1 : -1;
        return b.co2_kg - a.co2_kg;
    });

    const real = [...buckets.values()].filter(b => !b.is_pickup);
    const sum = (f) => real.reduce((s, b) => s + f(b), 0);
    const totalCovered = sum(b => b.covered);
    const totalFixed = sum(b => b.fixed);
    const denom = totalCovered + totalFixed;

    return {
        methods,
        total: {
            deliveries: sum(b => b.deliveries),
            km: Math.round(sum(b => b.km)),
            co2_kg: Math.round(sum(b => b.grams) / 1000 * 10) / 10,
            coverage_pct: denom ? Math.round(totalCovered / denom * 100) : 0,
        },
        missing_km_count: totalFixed,          // kun konfigureret-uden-afstand
        unmapped_count: sum(b => b.none),      // Ukendt / uden faktor (separat signal)
    };
}

module.exports = {
    METHOD_TO_TYPE,
    ROAD_FACTOR,
    num,
    haversineKm,
    resolveVehicle,
    factorsOf,
    isConfigured,
    distributeRouteCo2,
    transportCo2ForBon,
    aggregateMethods,
};
