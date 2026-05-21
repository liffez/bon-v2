// scripts/test-delivery-spor2-routes.js
// ==========================================
// Unit-tests for route_planner.js (Delivery Spor 2 — S2.1).
//
// ORS-kaldet (routing.getRoute) stubbes, så ETA-/pickup-/constraint-logikken
// kan testes deterministisk uden netværk.
//
// Kør med:
//   node --experimental-sqlite scripts/test-delivery-spor2-routes.js
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-spor2r-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
delete process.env.ORS_API_KEY;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const routing = require('../services/routing');
const { computeRoute, applyRouteProposal } = require('../services/route_planner');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEq(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      faktisk:  ', actual); fail++; }
}

const db = getDb();

// ─── ORS-stub ─────────────────────────────────────────────
// stubLegs sættes pr. test; stubben bygger en GeoJSON-agtig respons.
let stubLegs = [];
let stubDistanceM = 0;
routing.getRoute = async () => ({
    distance_m: stubDistanceM,
    duration_s: stubLegs.reduce((s, l) => s + l.duration_s, 0),
    legs: stubLegs,
    geometry_geojson: { type: 'LineString', coordinates: [[12.55, 55.69], [12.56, 55.70]] }
});

// ─── Setup ────────────────────────────────────────────────
console.log('\n=== Setup ===');
const statusNY = db.prepare("SELECT id FROM status_definitions WHERE code='NY'").get().id;
const statusKLAR = db.prepare("SELECT id FROM status_definitions WHERE code='KLAR'").get().id;
const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

function insertAddr() {
    return Number(db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
        VALUES ('Testvej', '1', '2200', 'KBH', 55.70, 12.56)
    `).run().lastInsertRowid);
}
function insertBon(deliveryTime, boxes, statusId) {
    return Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                          delivery_time, delivery_type, delivery_address_id, pax, boxes, total_units)
        VALUES (?, ?, ?, '2026-05-20', '2026-05-22', ?, 'delivery', ?, 10, ?, 0)
    `).run('TR' + Math.random().toString(36).slice(2, 8), statusId, locId,
           deliveryTime, insertAddr(), boxes).lastInsertRowid);
}
function insertVehicle(code, maxBoxes, maxKm) {
    return Number(db.prepare(`
        INSERT INTO delivery_vehicles
            (code, label, type, is_internal, max_capacity_boxes, max_distance_km,
             cost_formula_json, booking_method, is_active, sort_order)
        VALUES (?, ?, 'volvo', 1, ?, ?, '{"base":100,"per_km":5}', 'calendar', 1, 99)
    `).run(code, code, maxBoxes, maxKm).lastInsertRowid);
}
function makeRoute(vehicleId, stopsSpec) {
    // stopsSpec: [{ deliveryTime, boxes, statusId? }]
    const routeId = Number(db.prepare(
        "INSERT INTO delivery_routes (route_date, vehicle_id) VALUES ('2026-05-22', ?)"
    ).run(vehicleId).lastInsertRowid);
    stopsSpec.forEach((sp, i) => {
        const bonId = insertBon(sp.deliveryTime, sp.boxes, sp.statusId || statusNY);
        db.prepare('INSERT INTO delivery_route_stops (route_id, bon_id, sequence) VALUES (?, ?, ?)')
            .run(routeId, bonId, i + 1);
    });
    return routeId;
}
console.log('  Status/lokation hentet, helpers klar');

(async () => {
    // ─── computeRoute — happy 2-stop ──────────────────────
    console.log('\n=== computeRoute — 2 stop, feasible ===');
    // cum[0]=600, cum[1]=600+300(service)+300=1200, margin=600
    // stop1 12:00 → cand 43200-600-600=42000 (11:40)
    // stop2 12:30 → cand 45000-1200-600=43200 (12:00)  →  pickup=MIN=11:40
    stubLegs = [
        { distance_m: 3000, duration_s: 600 },
        { distance_m: 2000, duration_s: 300 },
        { distance_m: 3000, duration_s: 700 }
    ];
    stubDistanceM = 8000;
    const vBig = insertVehicle('T_S2R_big', 20, null);
    const r1 = makeRoute(vBig, [
        { deliveryTime: '12:00', boxes: 4 },
        { deliveryTime: '12:30', boxes: 6 }
    ]);
    const p1 = await computeRoute(r1);
    assertEq(p1.pickup_time, '11:40', 'pickup_time = MIN over stop (11:40)');
    assertEq(p1.ordered_stops[0].eta, '11:50', 'stop 1 ETA = pickup + 10 min kørsel');
    assertEq(p1.ordered_stops[1].eta, '12:00', 'stop 2 ETA = pickup + 20 min');
    assertEq(p1.total_km, 8, 'total_km fra ORS-distance');
    assert(p1.feasible === true, 'feasible = true (ingen errors)');
    assert(p1.warnings.some(w => w.code === 'tight_buffer'), 'tight_buffer-advarsel på stop 1 (10 min margin)');
    assert(p1.errors.length === 0, 'ingen errors');

    // ─── capacity_exceeded ────────────────────────────────
    console.log('\n=== computeRoute — capacity_exceeded ===');
    stubLegs = [
        { distance_m: 1000, duration_s: 300 },
        { distance_m: 1000, duration_s: 300 },
        { distance_m: 1000, duration_s: 300 }
    ];
    stubDistanceM = 3000;
    const vSmall = insertVehicle('T_S2R_small', 8, null);   // kapacitet 8
    const r2 = makeRoute(vSmall, [
        { deliveryTime: '13:00', boxes: 4 },
        { deliveryTime: '13:30', boxes: 6 }     // 4+6 = 10 > 8
    ]);
    const p2 = await computeRoute(r2);
    assert(p2.errors.some(e => e.code === 'capacity_exceeded'), 'capacity_exceeded ved 10 kasser > 8');
    assert(p2.feasible === false, 'feasible = false ved kapacitetsbrud');

    // ─── distance_exceeded ────────────────────────────────
    console.log('\n=== computeRoute — distance_exceeded ===');
    stubLegs = [{ distance_m: 4000, duration_s: 600 }, { distance_m: 4000, duration_s: 600 }];
    stubDistanceM = 8000;   // 8 km
    const vShort = insertVehicle('T_S2R_short', 50, 5);     // rækkevidde 5 km
    const r3 = makeRoute(vShort, [{ deliveryTime: '14:00', boxes: 2 }]);
    const p3 = await computeRoute(r3);
    assert(p3.errors.some(e => e.code === 'distance_exceeded'), 'distance_exceeded ved 8 km > 5 km');

    // ─── cant_meet_deadline (negativt pickup klampes) ─────
    console.log('\n=== computeRoute — cant_meet_deadline ===');
    stubLegs = [{ distance_m: 1000, duration_s: 22000 }, { distance_m: 1000, duration_s: 500 }];
    stubDistanceM = 2000;
    const r4 = makeRoute(vBig, [{ deliveryTime: '06:00', boxes: 2 }]);
    const p4 = await computeRoute(r4);
    assertEq(p4.pickup_time, '00:00', 'pickup klampes til 00:00 (negativt råtal)');
    assert(p4.errors.some(e => e.code === 'cant_meet_deadline'), 'cant_meet_deadline når ETA > deadline');
    assert(p4.feasible === false, 'feasible = false ved deadline-brud');

    // ─── no_stops ─────────────────────────────────────────
    console.log('\n=== computeRoute — no_stops ===');
    const rEmpty = Number(db.prepare(
        "INSERT INTO delivery_routes (route_date, vehicle_id) VALUES ('2026-05-22', ?)"
    ).run(vBig).lastInsertRowid);
    const pEmpty = await computeRoute(rEmpty);
    assert(pEmpty.errors.some(e => e.code === 'no_stops'), 'tom rute → no_stops');
    assert(pEmpty.feasible === false, 'tom rute → feasible false');

    // ─── applyRouteProposal ───────────────────────────────
    console.log('\n=== applyRouteProposal ===');
    const applied = applyRouteProposal(r1, p1);
    assertEq(applied.status, 'computed', 'apply sætter route-status = computed');
    const routeRow = db.prepare('SELECT * FROM delivery_routes WHERE id=?').get(r1);
    assertEq(routeRow.pickup_time, '11:40', 'route.pickup_time skrevet');
    assertEq(routeRow.status, 'computed', 'route-status persisteret');
    assert(routeRow.route_geojson != null, 'route_geojson skrevet');
    const stopRows = db.prepare('SELECT * FROM delivery_route_stops WHERE route_id=? ORDER BY sequence').all(r1);
    assertEq(stopRows[0].eta, '11:50', 'stop 1 ETA persisteret');
    assertEq(stopRows[1].eta, '12:00', 'stop 2 ETA persisteret');
    // bons.pickup_time opdateret (begge bons er status NY)
    const bonPickups = stopRows.map(s =>
        db.prepare('SELECT pickup_time FROM bons WHERE id=?').get(s.bon_id).pickup_time);
    assertEq(bonPickups, ['11:40', '11:40'], 'begge bons fik pickup_time = 11:40');

    // ─── applyRouteProposal — PICKUP_LOCKED status ────────
    console.log('\n=== applyRouteProposal — KLAR-bon røres ikke ===');
    stubLegs = [
        { distance_m: 3000, duration_s: 600 },
        { distance_m: 2000, duration_s: 300 },
        { distance_m: 3000, duration_s: 700 }
    ];
    stubDistanceM = 8000;
    const r5 = makeRoute(vBig, [
        { deliveryTime: '12:00', boxes: 4, statusId: statusNY },
        { deliveryTime: '12:30', boxes: 6, statusId: statusKLAR }   // KLAR = låst
    ]);
    const p5 = await computeRoute(r5);
    applyRouteProposal(r5, p5);
    const r5stops = db.prepare('SELECT * FROM delivery_route_stops WHERE route_id=? ORDER BY sequence').all(r5);
    const ny = db.prepare('SELECT pickup_time FROM bons WHERE id=?').get(r5stops[0].bon_id);
    const klar = db.prepare('SELECT pickup_time FROM bons WHERE id=?').get(r5stops[1].bon_id);
    assert(ny.pickup_time === p5.pickup_time, 'NY-bon fik ny pickup_time');
    assert(klar.pickup_time == null, 'KLAR-bon blev IKKE rørt (køkkenet har disponeret)');

    console.log(`\n${pass} passed, ${fail} failed`);
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch (e) {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch (e) {}
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FEJL:', e); process.exit(1); });
