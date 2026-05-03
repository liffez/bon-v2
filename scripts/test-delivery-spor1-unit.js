// scripts/test-delivery-spor1-unit.js
// ==========================================
// Unit-tests for booking_template og delivery_log.
//
// Bruger en isoleret in-memory DB så vi ikke rører prod-data.
//
// Kør med:
//   node --experimental-sqlite scripts/test-delivery-spor1-unit.js
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');

// Brug temp DB så vi ikke rører prod
const TEST_DB = path.join(os.tmpdir(), `bon-test-spor1-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const {
    renderTemplate,
    buildContext,
    buildAddressString,
    buildPackagingLines,
    formatDate,
    estimateCost,
    buildBookingPayload,
    getActiveVehicles
} = require('../services/booking_template');
const {
    logBookingEvent,
    setActualCost,
    getBookingEvents
} = require('../services/delivery_log');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      expected:', expected, '\n      actual:  ', actual); fail++; }
}

const db = getDb();

// ─── Setup test-bon ───────────────────────────────────────
console.log('\n=== Setup ===');
const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code = 'NY'`).get()?.id
              || db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get()?.id;
const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get()?.id;

const addrResult = db.prepare(`
    INSERT INTO addresses (street_name, street_nr, postal_code, city)
    VALUES ('Nørre Allé', '7', '2200', 'København N')
`).run();
const addrId = Number(addrResult.lastInsertRowid);

const customerResult = db.prepare(`
    INSERT INTO customers (first_name, last_name, email, phone)
    VALUES ('Anne', 'Lindhardt', 'anne@test.dk', '+4512345678')
`).run();
const customerId = Number(customerResult.lastInsertRowid);

const companyResult = db.prepare(`
    INSERT INTO companies (name, phone)
    VALUES ('Nordic Fast Food', '+4533445566')
`).run();
const companyId = Number(companyResult.lastInsertRowid);

const bonResult = db.prepare(`
    INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                      order_date, delivery_date, delivery_time, pickup_time,
                      delivery_type, delivery_address_id, delivery_notes,
                      day_contact_name, day_contact_phone,
                      pax, boxes, total_units)
    VALUES ('TEST-1', ?, ?, ?, ?,
            '2026-05-03', '2026-05-15', '12:30', '12:00',
            'delivery', ?, 'Ring på dørtelefon',
            'Lene', '+4522113344',
            15, 4, 60)
`).run(statusId, locId, customerId, companyId, addrId);
const bonId = Number(bonResult.lastInsertRowid);

db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price)
    VALUES (?, 'Sandwich-kasse', 'Sandwich', 4, 'stk', 100)`).run(bonId);
db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price)
    VALUES (?, 'Drikke', 'Drikke', 1, 'kasse', 50)`).run(bonId);

console.log(`  Test-bon oprettet: id=${bonId}`);

// ─── Test 1: formatDate ───────────────────────────────────
console.log('\n=== formatDate ===');
assertEqual(formatDate('2026-05-15'), '15-05-2026', 'ISO → DD-MM-YYYY');
assertEqual(formatDate('2026-05-15T10:00:00Z'), '15-05-2026', 'ISO med tid → DD-MM-YYYY');
assertEqual(formatDate(''), '', 'Tom streng → tom');
assertEqual(formatDate(null), '', 'null → tom');
assertEqual(formatDate('ugyldig'), 'ugyldig', 'Ugyldig værdi returneres som-er');

// ─── Test 2: buildAddressString ───────────────────────────
console.log('\n=== buildAddressString ===');
assertEqual(
    buildAddressString({ street_name: 'Nørre Allé', street_nr: '7', postal_code: '2200', city: 'København N' }),
    'Nørre Allé 7, 2200 København N',
    'Komplet adresse'
);
assertEqual(buildAddressString({ street_name: 'Foo', city: 'Bar' }), 'Foo, Bar', 'Manglende post-felter');
assertEqual(buildAddressString(null), '', 'null → tom');
assertEqual(buildAddressString({}), '', 'Tomt object → tom');

// ─── Test 3: buildPackagingLines ──────────────────────────
console.log('\n=== buildPackagingLines ===');
assertEqual(
    buildPackagingLines([
        { category: 'Sandwich', quantity: 4 },
        { category: 'Drikke', quantity: 1 },
        { category: 'Sandwich', quantity: 2 } // skal aggregeres
    ]),
    '6× Sandwich · 1× Drikke',
    'Aggregerer per kategori'
);
assertEqual(buildPackagingLines([]), '', 'Tom liste → tom streng');
assertEqual(buildPackagingLines(null), '', 'null → tom');

// ─── Test 4: renderTemplate ──────────────────────────────
console.log('\n=== renderTemplate ===');
assertEqual(
    renderTemplate('Hej {customer_name}', { customer_name: 'Anne' }),
    'Hej Anne',
    'Simpel substitution'
);
assertEqual(
    renderTemplate('{customer_name} bestiller til {delivery_address}', {
        customer_name: 'Anne',
        delivery_address: 'Nørre Allé 7'
    }),
    'Anne bestiller til Nørre Allé 7',
    'Multiple variabler'
);
assertEqual(
    renderTemplate('Tlf: {delivery_contact_phone}', {}),
    'Tlf: [mangler]',
    'Manglende felt → [mangler]'
);
assertEqual(
    renderTemplate('Tlf: {delivery_contact_phone}', {}, { markMissing: false }),
    'Tlf: ',
    'markMissing=false fjerner placeholder'
);
assertEqual(
    renderTemplate('Æøå Anne — {customer_name}!', { customer_name: 'Søren' }),
    'Æøå Anne — Søren!',
    'Special chars (æøå)'
);

// ─── Test 5: buildContext ─────────────────────────────────
console.log('\n=== buildContext ===');
const { getBon } = require('../db/helpers');
const bon = getBon(bonId);
const ctx = buildContext(bon);

assertEqual(ctx.vars.bon_number, 'TEST-1', 'bon_number');
assertEqual(ctx.vars.customer_name, 'Anne Lindhardt', 'customer_name');
assertEqual(ctx.vars.company_name, 'Nordic Fast Food', 'company_name');
assertEqual(ctx.vars.delivery_address, 'Nørre Allé 7, 2200 København N', 'delivery_address sammensat');
assertEqual(ctx.vars.delivery_contact_name, 'Lene', 'delivery_contact_name fra day_contact_name');
assertEqual(ctx.vars.delivery_contact_phone, '+4522113344', 'delivery_contact_phone fra day_contact_phone');
assertEqual(ctx.vars.delivery_date, '15-05-2026', 'delivery_date formatteret');
assertEqual(ctx.vars.delivery_time, '12:30', 'delivery_time');
assertEqual(ctx.vars.pickup_time, '12:00', 'pickup_time');
assertEqual(ctx.vars.total_boxes, '4', 'total_boxes som streng');
assertEqual(ctx.vars.total_pax, '15', 'total_pax');
assertEqual(ctx.vars.delivery_notes, 'Ring på dørtelefon', 'delivery_notes');
assert(ctx.vars.packaging_lines.includes('Sandwich'), 'packaging_lines inkluderer Sandwich');

// ─── Test 6: estimateCost ────────────────────────────────
console.log('\n=== estimateCost ===');
const taxa = db.prepare(`SELECT * FROM delivery_vehicles WHERE code = 'taxa-4x35'`).get();
const byekspressen = db.prepare(`SELECT * FROM delivery_vehicles WHERE code = 'byekspressen'`).get();
const cykel = db.prepare(`SELECT * FROM delivery_vehicles WHERE code = 'cykel-egen'`).get();

assertEqual(estimateCost(taxa, { boxes: 4 }), 250, 'Taxa standard inner_city = 250');
// By-expressen: standard 154 + (boxes 4 - included 2) × 50 = 154 + 100 = 254
assertEqual(estimateCost(byekspressen, { boxes: 4 }), 254, 'By-expressen 4 kasser: 154 + 2×50 = 254');
assertEqual(estimateCost(byekspressen, { boxes: 2 }), 154, 'By-expressen 2 kasser (inkluderet) = 154');
assertEqual(estimateCost(cykel, { boxes: 4 }), 0, 'Egen cykel = 0');
assertEqual(estimateCost(null, { boxes: 4 }), null, 'Null vehicle → null');
assertEqual(estimateCost({ cost_formula_json: 'ugyldig json' }, {}), null, 'Ugyldig JSON → null');

// ─── Test 7: buildBookingPayload ──────────────────────────
console.log('\n=== buildBookingPayload ===');

// Sæt en simpel template på taxa
db.prepare(`UPDATE delivery_vehicles SET booking_template = ? WHERE id = ?`)
    .run('Bon: {bon_number}\nAdresse: {delivery_address}\nDato: {delivery_date}', taxa.id);

const payload = buildBookingPayload(bonId, taxa.id);
assertEqual(payload.booking_method, 'manual_clipboard', 'Korrekt booking_method');
assertEqual(payload.booking_url, 'https://taxa.nu/', 'Korrekt URL');
assert(payload.clipboard_text.includes('TEST-1'), 'Clipboard inkluderer bon_number');
assert(payload.clipboard_text.includes('Nørre Allé 7'), 'Clipboard inkluderer adresse');
assert(payload.clipboard_text.includes('15-05-2026'), 'Clipboard inkluderer formatteret dato');
assertEqual(payload.estimated_cost_dkk, 250, 'Estimat = 250 (taxa standard)');
assertEqual(payload.warnings, [], 'Ingen warnings når template er sat');

// Test uden template → warning
db.prepare(`UPDATE delivery_vehicles SET booking_template = NULL WHERE id = ?`).run(byekspressen.id);
const payloadNoTemplate = buildBookingPayload(bonId, byekspressen.id);
assert(payloadNoTemplate.warnings.includes('template_not_configured'), 'Manglende template → warning');
assertEqual(payloadNoTemplate.clipboard_text, null, 'Manglende template → clipboard_text=null');

// Test ugyldig vehicle
let threwBon = false;
try { buildBookingPayload(99999, taxa.id); } catch (e) { threwBon = e.statusCode === 404; }
assert(threwBon, 'Ugyldig bon_id → 404');

let threwVehicle = false;
try { buildBookingPayload(bonId, 99999); } catch (e) { threwVehicle = e.statusCode === 404; }
assert(threwVehicle, 'Ugyldig vehicle_id → 404');

// ─── Test 8: logBookingEvent ──────────────────────────────
console.log('\n=== logBookingEvent ===');
const event1 = logBookingEvent({
    bonId, vehicleId: taxa.id, reference: 'TEST-REF-1', status: 'booked'
});
assert(event1.id > 0, 'Event oprettet med id');
assertEqual(event1.event_type, 'booked', 'event_type=booked');
assertEqual(event1.external_reference, 'TEST-REF-1', 'reference gemt');

// Tjek at bonnen er opdateret
const bonAfter = db.prepare(`SELECT delivery_vehicle_id, courier_provider, delivery_cost_estimated FROM bons WHERE id = ?`).get(bonId);
assertEqual(bonAfter.delivery_vehicle_id, taxa.id, 'bon.delivery_vehicle_id sat');
assertEqual(bonAfter.courier_provider, 'taxa-4x35', 'bon.courier_provider sat');
assert(bonAfter.delivery_cost_estimated > 0, 'bon.delivery_cost_estimated sat');

// Skift til By-expressen
const event2 = logBookingEvent({
    bonId, vehicleId: byekspressen.id, status: 'in_progress'
});
assertEqual(event2.booking_status, 'in_progress', 'in_progress status');

const bonAfter2 = db.prepare(`SELECT delivery_vehicle_id FROM bons WHERE id = ?`).get(bonId);
assertEqual(bonAfter2.delivery_vehicle_id, byekspressen.id, 'vehicle skiftet');

// Failed status
const event3 = logBookingEvent({ bonId, vehicleId: taxa.id, status: 'failed', note: 'API timeout' });
assertEqual(event3.event_type, 'failed', 'failed → event_type=failed');

// Ugyldig status
let invalidStatus = false;
try { logBookingEvent({ bonId, vehicleId: taxa.id, status: 'completed' }); } catch (e) { invalidStatus = true; }
assert(invalidStatus, 'Ugyldig status → throws');

// ─── Test 9: setActualCost ────────────────────────────────
console.log('\n=== setActualCost ===');
const result = setActualCost({ bonId, amount: 275 });
assertEqual(result.delivery_cost, 275, 'Cost gemt');
assertEqual(result.delivery_cost_source, 'manual', 'Source = manual');

const bonCost = db.prepare(`SELECT delivery_cost, delivery_cost_source FROM bons WHERE id = ?`).get(bonId);
assertEqual(bonCost.delivery_cost, 275, 'bon.delivery_cost opdateret');

// API source
const result2 = setActualCost({ bonId, amount: 280, source: 'api' });
assertEqual(result2.delivery_cost_source, 'api', 'Source = api');

// Ugyldig amount
let invalidAmount = false;
try { setActualCost({ bonId, amount: 'ikke et tal' }); } catch (e) { invalidAmount = true; }
assert(invalidAmount, 'Ugyldig amount → throws');

// ─── Test 10: getBookingEvents ────────────────────────────
console.log('\n=== getBookingEvents ===');
const events = getBookingEvents(bonId);
assert(events.length === 3, `3 events oprettet (fik ${events.length})`);
assert(events[0].event_time >= events[events.length - 1].event_time, 'Events sorteret nyeste først');
assert(events.some(e => e.vehicle_label === 'Taxa 4×35'), 'vehicle_label joinet');

// ─── Cleanup ──────────────────────────────────────────────
console.log('\n=== Resultat ===');
console.log(`✓ ${pass} passed,  ✗ ${fail} failed`);

// Slet test-DB
try { fs.unlinkSync(TEST_DB); } catch (e) {}
try { fs.unlinkSync(TEST_DB + '-wal'); } catch (e) {}
try { fs.unlinkSync(TEST_DB + '-shm'); } catch (e) {}

process.exit(fail > 0 ? 1 : 0);
