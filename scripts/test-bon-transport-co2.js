// scripts/test-bon-transport-co2.js
// ==========================================
// Integration-test for services/bonTransportCo2.computeForBons mod en isoleret
// temp-DB (migreret). Seeder vogn-faktorer + adresse-koordinater og verificerer
// at DB-wrapperen loader korrekt og kalder den (unit-testede) co2Transport-logik.
//
// Kør:  node --experimental-sqlite scripts/test-bon-transport-co2.js
// ==========================================

const path = require('path');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-bontransport-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const bonTransportCo2 = require('../services/bonTransportCo2');

const db = getDb();
let pass = 0, fail = 0;
function assert(c, m) { if (c) { console.log('  ✓', m); pass++; } else { console.error('  ✗', m); fail++; } }
function approx(a, e, m, eps = 0.05) { if (Math.abs(a - e) <= eps) { console.log('  ✓', m, `(${a})`); pass++; } else { console.error('  ✗', m, `forventet ${e}, fik ${a}`); fail++; } }

// Sæt faktorer: By-expressen (bike) 60 g/km, positionering 0, multiplier 1.
db.prepare(`UPDATE delivery_vehicles SET co2_g_per_km = 60, co2_distance_multiplier = 1, co2_positioning_km = 0 WHERE code = 'byekspressen'`).run();
db.prepare(`UPDATE delivery_vehicles SET co2_g_per_km = 250, co2_distance_multiplier = 2 WHERE code = 'volvo'`).run();

// Adresse ~1 km fra HQ (HQ = 55.69345859, 12.55234495 fra migration 073).
const addr = db.prepare(
    `INSERT INTO addresses (street_name, city, postal_code, lat, lon) VALUES ('Testvej','København','2200', 55.6845, 12.5523)`
).run();
const addrId = Number(addr.lastInsertRowid);

console.log('\ncomputeForBons — haversine-fallback + pickup + legacy');

// 1) By-expressen (legacy bike), ingen ORS-cache → haversine fra adressens coords.
{
    const map = bonTransportCo2.computeForBons(db, [
        { id: 1, delivery_type: 'delivery', delivery_method: 'bike', delivery_vehicle_id: null, delivery_address_id: addrId },
    ]);
    const r = map.get(1);
    assert(r.source === 'p2p', "By-expressen m. adresse-coords → source 'p2p' (haversine)");
    assert(r.kg > 0, 'kg > 0 (' + r.kg + ')');
    assert(r.vehicle_label === 'By-expressen', 'vehicle_label = By-expressen');
}

// 2) ORS-cache vinder over haversine.
{
    db.prepare(`INSERT INTO geo_calculations (address_id, distance_meters) VALUES (?, 10000)`).run(addrId);
    const map = bonTransportCo2.computeForBons(db, [
        { id: 2, delivery_type: 'delivery', delivery_method: 'volvo', delivery_vehicle_id: null, delivery_address_id: addrId },
    ]);
    const r = map.get(2);
    // Volvo: 10 km × mult 2 × 250 g/km = 5000 g = 5,0 kg
    approx(r.kg, 5.0, 'Volvo m. ORS-cache 10 km × 2 × 250 = 5,0 kg', 0.05);
    assert(r.source === 'p2p', "source 'p2p'");
}

// 3) Afhentning (delivery_type=pickup) → 0.
{
    const map = bonTransportCo2.computeForBons(db, [
        { id: 3, delivery_type: 'pickup', delivery_method: null, delivery_vehicle_id: null, delivery_address_id: addrId },
    ]);
    const r = map.get(3);
    assert(r.kg === 0 && r.source === 'none', 'afhentning → 0, none');
}

// 4) Ukonfigureret vogn (taxi, faktor 0) → none.
{
    const map = bonTransportCo2.computeForBons(db, [
        { id: 4, delivery_type: 'delivery', delivery_method: 'taxi', delivery_vehicle_id: null, delivery_address_id: addrId },
    ]);
    const r = map.get(4);
    assert(r.source === 'none', 'taxi uden faktor → none');
}

// 5) Adresse uden coords + ingen cache → ingen km-data (fixed/none).
{
    const map = bonTransportCo2.computeForBons(db, [
        { id: 5, delivery_type: 'delivery', delivery_method: 'bike', delivery_vehicle_id: null, delivery_address_id: null },
    ]);
    const r = map.get(5);
    assert(r.source === 'none' || r.source === 'fixed', 'ingen adresse → none/fixed (' + r.source + ')');
}

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
