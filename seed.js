// seed.js
// ==========================================
// Testdata til lokal udvikling.
// Opretter 4-5 bonner for i dag med realistiske
// data så køkken-viewet har noget at vise.
//
// Kør: node seed.js
// OBS: Kør kun én gang — eller slet data/bon.db
//      og kør igen for clean slate.
// ==========================================

const { getDb } = require('./db/database');
const db = getDb();

// Hjælper: hent status-id fra kode
const statusId = code =>
    db.prepare(`SELECT id FROM status_definitions WHERE code=?`).get(code)?.id;

const locationId =
    db.prepare(`SELECT id FROM locations WHERE code='hq'`).get()?.id;

// ── Testbruger ──────────────────────────────

db.prepare(`
    INSERT OR IGNORE INTO users (name, email, role, is_active)
    VALUES ('Test Admin', 'admin@ristetrug.dk', 'admin', 1)
`).run();

// ── Firmaer & kunder ──────────────────────

const firms = db.prepare(`
    INSERT INTO companies (name, cvr, invoice_method, default_payment_type)
    VALUES (?, ?, 'email', 'invoice')
`);

const f1 = firms.run('Novo Nordisk A/S', '24256790').lastInsertRowid;
const f2 = firms.run('Københavns Kommune', '64942212').lastInsertRowid;
const f3 = firms.run('DR Byen', '62786515').lastInsertRowid;

const addCustomer = db.prepare(`
    INSERT INTO customers (company_id, first_name, last_name, email, phone, is_primary_contact)
    VALUES (?, ?, ?, ?, ?, 1)
`);

const c1 = addCustomer.run(f1, 'Mette',  'Hansen',   'mette@novo.dk',  '22334455').lastInsertRowid;
const c2 = addCustomer.run(f2, 'Lars',   'Pedersen', 'lars@kk.dk',     '33445566').lastInsertRowid;
const c3 = addCustomer.run(f3, 'Sofie',  'Larsen',   'sofie@dr.dk',    '44556677').lastInsertRowid;

// ── Leveringsadresser ─────────────────────

const addAddr = db.prepare(`
    INSERT INTO addresses (label, street_name, street_nr, postal_code, city, lat, lon)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const a1 = addAddr.run('Novo Nordisk', 'Novo Allé',        '1',  '2880', 'Bagsværd',  55.757, 12.447).lastInsertRowid;
const a2 = addAddr.run('Rådhuspladsen','Rådhuspladsen',     '1',  '1550', 'København V', 55.676, 12.569).lastInsertRowid;
const a3 = addAddr.run('DR Byen',      'Emil Holms Kanal', '20', '0999', 'København C', 55.647, 12.526).lastInsertRowid;

// ── Bonner for I DAG ──────────────────────

const today = new Date().toISOString().split('T')[0]; // "2026-03-09"

const addBon = db.prepare(`
    INSERT INTO bons (
        bon_number, status_id, location_id,
        customer_id, company_id,
        order_date, delivery_date,
        pickup_time, delivery_time,
        delivery_type, delivery_method,
        delivery_address_id,
        pax, total_units,
        kitchen_info, customer_wishes,
        created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

const b1 = addBon.run(
    '3261', statusId('GODKENDT'), locationId,
    c1, f1, today, today,
    '09:30', '10:00', 'delivery', 'bike', a1,
    24, 24, 'Klassiske smørrebrød — ingen sild', null
).lastInsertRowid;

const b2 = addBon.run(
    '3262', statusId('IGANG'), locationId,
    c2, f2, today, today,
    '11:00', '11:30', 'delivery', 'bike', a2,
    40, 40, null, 'Ingen nødder på nogen retter (allergi)'
).lastInsertRowid;

const b3 = addBon.run(
    '3263', statusId('IGANG'), locationId,
    c3, f3, today, today,
    '12:00', '12:30', 'delivery', 'taxi', a3,
    16, 16, 'Husk ekstra servietter', null
).lastInsertRowid;

const b4 = addBon.run(
    '3264', statusId('KLAR'), locationId,
    c1, f1, today, today,
    '13:00', null, 'pickup', null, null,
    8, 8, null, null
).lastInsertRowid;

const b5 = addBon.run(
    '3265', statusId('NY'), locationId,
    c2, f2, today, today,
    '14:30', '15:00', 'delivery', 'volvo', a2,
    60, 60, 'STORT arrangement — dobbelttjek antal', 'Vegetarisk option til 10 pers.'
).lastInsertRowid;

// ── Bon-linjer ────────────────────────────

const addLine = db.prepare(`
    INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Bon 3261
addLine.run(b1, 'Klassisk smørrebrød sortiment', '01 Smørrebrød', 18, 'stk', 52,  936,  1);
addLine.run(b1, 'Vegansk smørrebrød',             '01 Smørrebrød',  6, 'stk', 55,  330,  2);

// Bon 3262
addLine.run(b2, 'Sandwich sortiment',          '02 Sandwich',  30, 'stk', 48, 1440, 1);
addLine.run(b2, 'Glutenfri sandwich',           '02 Sandwich',   4, 'stk', 58,  232, 2);
addLine.run(b2, 'Salatvariationer (stor skål)', '03 Salat',      6, 'stk', 85,  510, 3);

// Bon 3263
addLine.run(b3, 'Rugbrødssandwich sortiment',   '01 Smørrebrød', 16, 'stk', 50, 800, 1);

// Bon 3264
addLine.run(b4, 'Frokostpakke standard',        '02 Sandwich',   8, 'stk', 75, 600, 1);

// Bon 3265
addLine.run(b5, 'Buffet smørrebrød',            '01 Smørrebrød', 40, 'stk', 48, 1920, 1);
addLine.run(b5, 'Sandwich sortiment',           '02 Sandwich',   10, 'stk', 48,  480, 2);
addLine.run(b5, 'Vegansk sortiment',            '04 Vegansk',    10, 'stk', 55,  550, 3);

// ── Testflyver ────────────────────────────

db.prepare(`
    INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
    VALUES (?, 'flyver', ?, 'urgent', 1)
`).run(b2, 'Kunden ringer — vil tilføje 4 ekstra sandwich. Er det muligt?');

console.log('✓ Testdata indsat');
console.log(`  ${5} bonner oprettet for ${today}`);
console.log(`  1 flyver oprettet på bon 3262`);
console.log(`\nÅbn: http://localhost:3000/kitchen/today.html`);
