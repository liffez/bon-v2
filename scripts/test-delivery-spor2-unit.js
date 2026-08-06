// scripts/test-delivery-spor2-unit.js
// ==========================================
// Unit-tests for Delivery Spor 2 — Fundament (S2.0):
//   routing.js, delivery_calc.js, booking_template.estimateCost-udvidelse.
//
// Bruger en isoleret temp-DB. ORS-kald undgås ved at seede
// geo_calculations-cachen — så constraint-/pris-/forslags-logikken
// kan testes uden en ORS-nøgle.
//
// Kør med:
//   node --experimental-sqlite scripts/test-delivery-spor2-unit.js
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-spor2-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
// Sørg for at ORS er ukonfigureret — testen må ikke ramme et rigtigt API.
delete process.env.ORS_API_KEY;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { getDistance, healthCheck, RoutingError } = require('../services/routing');
const { calculateForBon, shiftTime } = require('../services/delivery_calc');
const { estimateCost } = require('../services/booking_template');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      faktisk:  ', actual); fail++; }
}
async function assertThrowsCode(fn, code, msg) {
    try {
        await fn();
        console.error('  ✗', msg, '— kastede ingen fejl');
        fail++;
    } catch (e) {
        if (e instanceof RoutingError && e.code === code) {
            console.log('  ✓', msg);
            pass++;
        } else {
            console.error('  ✗', msg, `— forventet code='${code}', fik`, e.code || e.message);
            fail++;
        }
    }
}

const db = getDb();
const HQ = { lat: 55.69345859, lon: 12.55234495 };

// ─── Setup ────────────────────────────────────────────────
console.log('\n=== Setup ===');

// Test-adresser
function insertAddr(street) {
    return Number(db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
        VALUES (?, '1', '2200', 'København N', 55.70, 12.56)
    `).run(street).lastInsertRowid);
}
const addrA = insertAddr('Testvej A');   // caches 5 km
const addrB = insertAddr('Testvej B');   // caches 12 km
const addrC = insertAddr('Testvej C');   // cache udløbet (TTL-test)
const addrUncached = insertAddr('Testvej U'); // ingen cache

// Seed geo_calculations-cache (bon_id NULL = routing-cache)
function seedCache(addressId, meters, seconds, ageExpr = "datetime('now')") {
    db.prepare(`
        INSERT INTO geo_calculations (bon_id, address_id, distance_meters, duration_seconds, calculated_at)
        VALUES (NULL, ?, ?, ?, ${ageExpr})
    `).run(addressId, meters, seconds);
}
seedCache(addrA, 5000, 600);                                   // 5 km, 10 min
seedCache(addrB, 12000, 1400);                                 // 12 km
seedCache(addrC, 4000, 500, "datetime('now','-40 days')");     // udløbet
console.log('  Adresser + cache seedet');

// Test-vehicles med kendte constraints
function insertVehicle(code, label, type, isInternal, maxBoxes, maxKm, formula) {
    return Number(db.prepare(`
        INSERT INTO delivery_vehicles
            (code, label, type, is_internal, max_capacity_boxes, max_distance_km,
             cost_formula_json, booking_method, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'calendar', 1, 99)
    `).run(code, label, type, isInternal, maxBoxes, maxKm, formula).lastInsertRowid);
}
const vBike  = insertVehicle('T_S2_bike',  'Test Cykel',  'bike',  1, 6,    8,    '{"base":0}');
const vTaxa  = insertVehicle('T_S2_taxa',  'Test Taxa',   'taxi',  0, null, null, '{"standard_inner_city":250}');
const vVolvo = insertVehicle('T_S2_volvo', 'Test Volvo',  'volvo', 1, 30,   null, '{"base":100,"per_km":8}');
console.log('  Test-vehicles oprettet');

function findAlt(result, code) {
    return (result.alternatives || []).find(a => a.code === code);
}

// ─── routing.js ───────────────────────────────────────────
(async () => {
    console.log('\n=== routing.js ===');

    // Cache-hit: returnerer cachet værdi UDEN ORS-kald (ingen nøgle sat,
    // så hvis den ramte ORS ville den kaste).
    const hit = await getDistance(HQ, { lat: 55.70, lon: 12.56 }, { addressId: addrA });
    assertEqual({ d: hit.distance_m, t: hit.duration_s, c: hit.cached },
                { d: 5000, t: 600, c: true }, 'cache-hit returnerer cachet afstand');

    // Cache-miss (udløbet TTL) → falder til ORS → no_api_key
    await assertThrowsCode(
        () => getDistance(HQ, { lat: 55.70, lon: 12.56 }, { addressId: addrC }),
        'no_api_key', 'udløbet cache (40 dage) ignoreres → cache-miss');

    // Ingen addressId + ingen nøgle → no_api_key
    await assertThrowsCode(
        () => getDistance(HQ, { lat: 55.70, lon: 12.56 }),
        'no_api_key', 'ingen ORS-nøgle → RoutingError no_api_key');

    // Ugyldige koordinater → bad_input
    await assertThrowsCode(
        () => getDistance({ lat: 'xx' }, { lat: 55.70, lon: 12.56 }),
        'bad_input', 'ugyldige koordinater → RoutingError bad_input');

    // healthCheck uden nøgle
    assertEqual(await healthCheck(), { up: false, reason: 'no_api_key' },
                'healthCheck uden nøgle → up:false');

    // ─── estimateCost-udvidelse ───────────────────────────
    console.log('\n=== estimateCost (per_km-udvidelse) ===');
    const volvoFormula = { code: 'v', cost_formula_json: '{"base":100,"per_km":8}' };
    const taxaFormula  = { code: 't', cost_formula_json: '{"standard_inner_city":250}' };

    assertEqual(estimateCost(volvoFormula, { boxes: 0 }), 100,
                'estimateCost uden distance → base (bagudkompatibelt)');
    assertEqual(estimateCost(volvoFormula, { boxes: 0 }, { distance_km: 5 }), 140,
                'estimateCost med distance → base + per_km × km (100 + 8×5)');
    assertEqual(estimateCost(taxaFormula, { boxes: 0 }, { distance_km: 99 }), 250,
                'standard_inner_city ignorerer distance');

    // ─── Bypris er et GULV, ikke et loft ──────────────────
    // Taxaen som den står i drift: bytakst 250, men også 136 + 19/km.
    // Kort tur → bytaksten. Lang tur → km-taksten, ellers ville vi
    // prissætte en tur til Roskilde til bytakst.
    const taxaReal = { code: 't', cost_formula_json: '{"base":136,"per_km":19,"standard_inner_city":250}' };
    assertEqual(estimateCost(taxaReal, { boxes: 0 }, { distance_km: 5.1 }), 250,
                'bypris vinder på kort tur (136 + 19×5,1 = 233 < 250)');
    assertEqual(estimateCost(taxaReal, { boxes: 0 }, { distance_km: 35 }), 801,
                'km-takst vinder på lang tur (136 + 19×35 = 801 > 250)');
    assertEqual(estimateCost(taxaReal, { boxes: 0 }), 250,
                'uden afstand står bypris alene (bagudkompatibelt)');

    // By-expressen har INGEN km-takst — prisen forbliver flad uanset afstand.
    // (max_distance_km = 8 er værnet mod at bruge den for langt ude.)
    const byexReal = { code: 'b', cost_formula_json: '{"base":100,"included_boxes":2,"extra_box_cost":50,"standard_inner_city":154}' };
    assertEqual(estimateCost(byexReal, { boxes: 2 }, { distance_km: 40 }), 154,
                'vogn uden km-takst er flad uanset afstand');
    assertEqual(estimateCost(byexReal, { boxes: 4 }, { distance_km: 5 }), 254,
                'kasse-tillæg oveni bypris (154 + 2×50)');
    // Kasse-tillægget skal følge med når km-taksten vinder — ikke falde bort.
    const boxedKm = { code: 'x', cost_formula_json: '{"base":100,"per_km":19,"included_boxes":2,"extra_box_cost":50,"standard_inner_city":154}' };
    assertEqual(estimateCost(boxedKm, { boxes: 4 }, { distance_km: 30 }), 770,
                'kasse-tillæg oveni km-takst (100 + 19×30 + 2×50)');

    // ─── shiftTime ────────────────────────────────────────
    console.log('\n=== delivery_calc.shiftTime ===');
    assertEqual(shiftTime('12:30', -20), '12:10', 'shiftTime træk 20 min fra');
    assertEqual(shiftTime('12:30', 90), '14:00', 'shiftTime læg 90 min til');
    assertEqual(shiftTime('ugyldig', -10), null, 'shiftTime ugyldigt input → null');

    // ─── delivery_calc.calculateForBon ────────────────────
    console.log('\n=== delivery_calc.calculateForBon ===');

    // Addr A: 5 km, 2 kasser, levering 12:30
    const rA = await calculateForBon({
        addressId: addrA, lat: 55.70, lon: 12.56,
        delivery_time: '12:30', boxes: 2
    });
    assert(rA.ok === true, 'calculateForBon (cachet adresse) → ok:true');
    assertEqual(rA.distance_km, 5, 'distance_km = 5.0 fra cache');
    assertEqual(rA.estimated_pickup_time, '12:10',
                'estimated_pickup_time = 12:30 − (10 min kørsel + 10 min margin)');

    const bikeA = findAlt(rA, 'T_S2_bike');
    assert(bikeA && bikeA.suitable === true, 'cykel egnet ved 5 km / 2 kasser');
    const taxaA = findAlt(rA, 'T_S2_taxa');
    assert(taxaA && taxaA.suitable === true, 'taxa egnet (ingen constraints)');
    const volvoA = findAlt(rA, 'T_S2_volvo');
    assertEqual(volvoA && volvoA.cost_dkk, 140, 'volvo-pris = base + per_km × 5 km');

    // Forslag = billigste egnede (invariant — robust mod seedede vehicles)
    const suitableCosts = rA.alternatives
        .filter(a => a.suitable)
        .map(a => a.cost_dkk == null ? Infinity : a.cost_dkk);
    const suggestion = rA.alternatives.find(a => a.vehicle_id === rA.suggested_vehicle_id);
    assert(suggestion && suggestion.suitable, 'suggested_vehicle_id peger på en egnet vogn');
    assert(suggestion && (suggestion.cost_dkk == null ? Infinity : suggestion.cost_dkk)
           === Math.min(...suitableCosts), 'suggested_vehicle_id er billigste egnede');

    // Addr B: 12 km → cykel for langt (max 8 km)
    const rB = await calculateForBon({
        addressId: addrB, lat: 55.70, lon: 12.56, boxes: 2
    });
    const bikeB = findAlt(rB, 'T_S2_bike');
    assert(bikeB && bikeB.suitable === false, 'cykel uegnet ved 12 km');
    assert(bikeB && /langt/.test(bikeB.reason || ''), 'cykel-reason nævner afstand');

    // Addr A: 10 kasser → cykel over kapacitet (max 6)
    const rCap = await calculateForBon({
        addressId: addrA, lat: 55.70, lon: 12.56, boxes: 10
    });
    const bikeCap = findAlt(rCap, 'T_S2_bike');
    assert(bikeCap && bikeCap.suitable === false, 'cykel uegnet ved 10 kasser');
    assert(bikeCap && /kasser/.test(bikeCap.reason || ''), 'cykel-reason nævner kasser');

    // Manglende koordinater → degraderer pænt
    const rMissing = await calculateForBon({ addressId: null, lat: null, lon: null });
    assertEqual({ ok: rMissing.ok, reason: rMissing.reason },
                { ok: false, reason: 'missing_coords' },
                'manglende coords → ok:false, reason missing_coords');

    // Ucachet adresse uden ORS-nøgle → degraderer med routing-reason
    const rNoOrs = await calculateForBon({
        addressId: addrUncached, lat: 55.70, lon: 12.56, boxes: 2
    });
    assertEqual({ ok: rNoOrs.ok, reason: rNoOrs.reason },
                { ok: false, reason: 'no_api_key' },
                'ucachet adresse uden ORS-nøgle → ok:false, reason no_api_key');

    // ─── Resultat ─────────────────────────────────────────
    console.log(`\n${pass} passed, ${fail} failed`);
    try { fs.unlinkSync(TEST_DB); } catch (e) {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch (e) {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch (e) {}
    process.exit(fail > 0 ? 1 : 0);
})();
