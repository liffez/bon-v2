// scripts/test-co2-transport.js
// ==========================================
// Unit-tests for transport-CO₂ beregningslogik (services/co2Transport.js).
// Ren logik — ingen DB, ingen ORS. Dækker spec Fase 1's testtabel +
// legacy-resolver (§1b) + positionering (§1) + rutefordeling (§3).
//
// Kør med:  node scripts/test-co2-transport.js
// ==========================================

const {
    num,
    resolveVehicle,
    distributeRouteCo2,
    transportCo2ForBon,
    aggregateMethods,
} = require('../services/co2Transport');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function approx(actual, expected, msg, eps = 0.5) {
    const ok = Math.abs(actual - expected) <= eps;
    if (ok) { console.log('  ✓', msg, `(${actual})`); pass++; }
    else    { console.error('  ✗', msg, `\n      forventet: ${expected}\n      faktisk:   ${actual}`); fail++; }
}

// Vogne (som rækker fra delivery_vehicles) ------------------------------------
const VOLVO   = { id: 1, label: 'Volvo Duett', type: 'volvo',    co2_g_per_km: 250, co2_g_fixed: 0,  co2_distance_multiplier: 2.0, co2_positioning_km: 0 };
const CYKEL   = { id: 2, label: 'Egen cykel',  type: 'own-bike', co2_g_per_km: 0,   co2_g_fixed: 0,  co2_distance_multiplier: 1.0, co2_positioning_km: 0 };
const BYEXP   = { id: 3, label: 'By-expressen',type: 'bike',     co2_g_per_km: 60,  co2_g_fixed: 25, co2_distance_multiplier: 1.0, co2_positioning_km: 8 };
const TAXA    = { id: 4, label: 'Taxa 4×35',   type: 'taxi',     co2_g_per_km: 60,  co2_g_fixed: 0,  co2_distance_multiplier: 1.0, co2_positioning_km: 5 };
const UNCONF  = { id: 5, label: 'Ukonfig',     type: 'taxi',     co2_g_per_km: 0,   co2_g_fixed: 0,  co2_distance_multiplier: 1.0, co2_positioning_km: 0 };

const byId   = new Map([VOLVO, CYKEL, BYEXP, TAXA, UNCONF].map(v => [v.id, v]));
const byType = new Map([['volvo', VOLVO], ['own-bike', CYKEL], ['bike', BYEXP], ['taxi', TAXA]]);

// --- num() ------------------------------------------------------------------
console.log('\nnum() — dansk decimalkomma');
assert(num('1,5') === 1.5, "'1,5' → 1.5");
assert(num('1.234,5') === 1234.5, "'1.234,5' → 1234.5");
assert(num('') === 0 && num(null) === 0, 'tom/null → 0');
assert(num(250) === 250, 'tal passerer uændret');

// --- resolveVehicle (§1b legacy) --------------------------------------------
console.log('\nresolveVehicle — §1b legacy-mapping');
assert(resolveVehicle({ delivery_vehicle_id: 3 }, byId, byType) === BYEXP, 'vehicle_id vinder');
assert(resolveVehicle({ delivery_method: 'bike' }, byId, byType) === BYEXP, "legacy 'bike' → By-expressen");
assert(resolveVehicle({ delivery_method: 'volvo' }, byId, byType) === VOLVO, "legacy 'volvo' → Volvo");
assert(resolveVehicle({ delivery_method: 'taxi' }, byId, byType) === TAXA, "legacy 'taxi' → Taxa");
assert(resolveVehicle({ delivery_method: 'pickup' }, byId, byType) === null, "'pickup' → null (afhentning)");
assert(resolveVehicle({ delivery_method: null }, byId, byType) === null, 'manglende metode → null');
assert(resolveVehicle({ delivery_vehicle_id: 999, delivery_method: 'volvo' }, byId, byType) === VOLVO,
    'ukendt vehicle_id → falder tilbage til method');

// --- distributeRouteCo2 (§3) ------------------------------------------------
console.log('\ndistributeRouteCo2 — §3 km-vægtet fordeling');
{
    // Rute 30 km total, to stop med ben 10 + 15 km, faktor 250 g/km → 7500 g.
    const route = { total_km: 30, stops: [{ bon_id: 100, distance_from_prev_m: 10000 }, { bon_id: 200, distance_from_prev_m: 15000 }] };
    const d = distributeRouteCo2(route, 250);
    approx(d.get(100).grams, 3000, 'stop A = 40% af 7500 = 3000', 0.01);
    approx(d.get(200).grams, 4500, 'stop B = 60% af 7500 = 4500', 0.01);
    approx(d.get(100).grams + d.get(200).grams, 7500, 'sum grams = præcis 7500', 0.0001);
    approx(d.get(100).km, 12, 'stop A km = 40% af 30 = 12', 0.01);
    approx(d.get(100).km + d.get(200).km, 30, 'sum km = præcis 30', 0.0001);
}
{
    // Ben-km mangler alle → ligelig fordeling.
    const route = { total_km: 10, stops: [{ bon_id: 1, distance_from_prev_m: 0 }, { bon_id: 2, distance_from_prev_m: 0 }] };
    const d = distributeRouteCo2(route, 100); // 1000 g
    approx(d.get(1).grams, 500, 'ben-km mangler → ligelig (500)', 0.01);
    approx(d.get(1).grams + d.get(2).grams, 1000, 'ligelig sum = 1000', 0.0001);
}

// --- transportCo2ForBon (§2 hierarki) — spec Fase 1 testtabel ---------------
console.log('\ntransportCo2ForBon — §2 hierarki (spec Fase 1)');

// Bon på 1-stop-rute, 181 km, faktor 250 g/km → 45,25 kg, source route.
{
    const route = { total_km: 181, stops: [{ bon_id: 500, distance_from_prev_m: 181000 }] };
    const r = transportCo2ForBon({ bon: { id: 500, delivery_vehicle_id: 1 }, vehicle: VOLVO, route });
    approx(r.grams, 45250, '1-stop-rute 181 km × 250 = 45,25 kg', 1);
    assert(r.source === 'route', "source = 'route'");
}

// Bon uden rute, geo 6,2 km, multiplier 2,0, faktor 250, positioning 0 → 3,1 kg, p2p.
{
    const r = transportCo2ForBon({ bon: { id: 1 }, vehicle: VOLVO, geoCalc: { distance_meters: 6200 } });
    approx(r.grams, 3100, 'p2p 6,2 km × 2,0 × 250 = 3,1 kg', 1);
    assert(r.source === 'p2p', "source = 'p2p'");
}

// Bon uden rute, geo 6,2 km, multiplier 1,0, faktor 60, positioning 8 km (By-expressen) → 852 g, p2p.
{
    const r = transportCo2ForBon({ bon: { id: 1, delivery_method: 'bike' }, vehicle: BYEXP, geoCalc: { distance_meters: 6200 } });
    approx(r.grams, 852, 'positionering: (8 + 6,2)×60 = 852 g', 1);
    assert(r.source === 'p2p', "source = 'p2p' (m. positionering)");
}

// Bon uden km-data, fixed 25 g → 25 g, fixed.
{
    const r = transportCo2ForBon({ bon: { id: 1, delivery_method: 'bike' }, vehicle: BYEXP });
    approx(r.grams, 25, 'ingen km → fixed 25 g', 0.01);
    assert(r.source === 'fixed', "source = 'fixed'");
}

// Afhentning → 0, none.
{
    const r = transportCo2ForBon({ bon: { id: 1, delivery_method: 'pickup' }, vehicle: null });
    assert(r.grams === 0 && r.source === 'none', 'afhentning = 0, none');
}

// Metode med alle faktorer = 0 (ukonfigureret) → 0, none, selv med geo.
{
    const r = transportCo2ForBon({ bon: { id: 1 }, vehicle: UNCONF, geoCalc: { distance_meters: 9999 } });
    assert(r.grams === 0 && r.source === 'none', 'ukonfigureret vogn → 0, none');
}

// Cykel (bevidst 0 g/km) MED geo → 0 kg men source p2p (tæller som dækket, ikke none).
{
    const r = transportCo2ForBon({ bon: { id: 1, delivery_vehicle_id: 2 }, vehicle: CYKEL, geoCalc: { distance_meters: 3000 } });
    // CYKEL har gPerKm=0 og gFixed=0 → isConfigured=false → none. Bekræft bevidst valg:
    assert(r.source === 'none', 'cykel uden faktorer = none (skal have g/km sat for at tælle som dækket)');
}

// Cykel MED et lille g/km (fx 5) + geo → dækket p2p, lille tal.
{
    const cykel5 = { ...CYKEL, co2_g_per_km: 5 };
    const r = transportCo2ForBon({ bon: { id: 1, delivery_vehicle_id: 2 }, vehicle: cykel5, geoCalc: { distance_meters: 4000 } });
    approx(r.grams, 20, 'cykel 5 g/km × 4 km = 20 g', 0.01);
    assert(r.source === 'p2p', 'cykel m. faktor + geo → p2p (dækket)');
}

// Legacy volvo (ingen vehicle_id) via geo — multiplier 2,0 slår igennem.
{
    const veh = resolveVehicle({ delivery_method: 'volvo' }, byId, byType);
    const r = transportCo2ForBon({ bon: { id: 1, delivery_method: 'volvo' }, vehicle: veh, geoCalc: { distance_meters: 10000 } });
    approx(r.grams, 5000, 'legacy volvo: 10 km × 2,0 × 250 = 5,0 kg', 1);
}

// --- aggregateMethods (§4 Fase 1.4 shape) -----------------------------------
console.log('\naggregateMethods — bucketing, dækning, afhentning, total');
{
    // Bon 1: By-expressen, geo 5 km → p2p, dækket.  (5 + 5×1)×60 = ... positioning 8: (8+5)×60=780 g
    // Bon 2: By-expressen, ingen geo → fixed 25 g, IKKE dækket.
    // Bon 3: Volvo på rute 20 km (1 stop) → route, dækket. 20×250 = 5000 g.
    // Bon 4: Afhentning → pickup-bucket, 0.
    const bons = [
        { id: 1, delivery_method: 'bike', delivery_address_id: 10 },
        { id: 2, delivery_method: 'bike', delivery_address_id: null },
        { id: 3, delivery_vehicle_id: 1, delivery_address_id: 30 },
        { id: 4, delivery_method: 'pickup', delivery_address_id: 40 },
    ];
    const routeById = new Map([[7, { total_km: 20, stops: [{ bon_id: 3, distance_from_prev_m: 20000 }] }]]);
    const bonToRoute = new Map([[3, 7]]);
    const addrDist = new Map([[10, 5000], [30, 8000]]);

    const out = aggregateMethods({ bons, byId, byType, routeById, bonToRoute, addrDist });
    const byLabel = new Map(out.methods.map(m => [m.label, m]));

    assert(byLabel.has('By-expressen') && byLabel.has('Volvo Duett') && byLabel.has('Afhentning'), 'tre buckets dannet');
    const bx = byLabel.get('By-expressen');
    assert(bx.deliveries === 2, 'By-expressen: 2 leveringer');
    assert(bx.coverage_pct === 50, 'By-expressen: 50% km-dækning (1 p2p, 1 fixed)');
    approx(bx.co2_kg, 0.8, 'By-expressen co2 = (780 + 25)/1000 ≈ 0,8 kg', 0.05);
    const vo = byLabel.get('Volvo Duett');
    approx(vo.co2_kg, 5.0, 'Volvo route 20 km × 250 = 5,0 kg', 0.05);
    assert(vo.coverage_pct === 100, 'Volvo: 100% dækning');
    const af = byLabel.get('Afhentning');
    assert(af.is_pickup && af.co2_kg === 0 && af.km === null, 'Afhentning: pickup, 0 kg, km null');
    assert(out.methods[out.methods.length - 1].is_pickup, 'Afhentning sorteret nederst');

    assert(out.total.deliveries === 3, 'total ekskl. afhentning = 3');
    assert(out.missing_km_count === 1, '1 levering mangler km-data (den fixed)');
    approx(out.total.co2_kg, 5.8, 'total co2 ≈ 5,8 kg', 0.1);
}

// --- resultat ---------------------------------------------------------------
console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
