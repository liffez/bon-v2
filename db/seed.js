/**
 * seed.js — Realistiske testdata til Bon v2
 * Kør: node db/seed.js
 *
 * Forudsætter at migrate.js allerede er kørt.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const run = db.transaction(() => {

  // Ryd eksisterende seed-data (sikker rækkefølge)
  db.exec(`
    DELETE FROM bon_lines;
    DELETE FROM changelog;
    DELETE FROM notifications;
    DELETE FROM bons;
    DELETE FROM customers;
    DELETE FROM companies;
    DELETE FROM addresses;
  `);

  // ── ADRESSER ────────────────────────────────────────────────────
  const insertAddr = db.prepare(`
    INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
    VALUES (?,?,?,?,?,?)
  `);

  const addr = {
    finansforbundet: insertAddr.run('Applebys Plads', '5',  '1411', 'København K',   55.6706, 12.5766).lastInsertRowid,
    maersk:          insertAddr.run('Blegdamsvej',    '9',  '2100', 'København N',   55.6965, 12.5686).lastInsertRowid,
    kk:              insertAddr.run('Rådhuspladsen',  '1',  '1550', 'København V',   55.6761, 12.5683).lastInsertRowid,
    nora:            insertAddr.run('Stigbøjlen',     '4',  '1870', 'Frederiksberg', 55.6731, 12.5195).lastInsertRowid,
    rr_hq:           insertAddr.run('Rantzausgade',   '62', '2200', 'København N',   55.6922, 12.5558).lastInsertRowid,
  };

  // ── FIRMAER ─────────────────────────────────────────────────────
  const insertCo = db.prepare(`
    INSERT INTO companies (name, cvr, ean, address_id, phone, email, invoice_email,
      invoice_method, default_payment_type, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,1)
  `);

  const co = {
    finansforbundet: insertCo.run('Finansforbundet', '10123456', null,         addr.finansforbundet, '38 39 40 00', 'bestilling@finansforbundet.dk', null, 'email', 'invoice').lastInsertRowid,
    maersk:          insertCo.run('A.P. Møller - Mærsk A/S', '22756214', null, addr.maersk,          '33 63 33 63', 'events@maersk.com',             null, 'email', 'invoice').lastInsertRowid,
    kk:              insertCo.run('Københavns Kommune',  '64942212', '5798009811578', addr.kk,        '33 66 33 66', 'events@kk.dk',                  'ean@kk.dk', 'ean', 'invoice').lastInsertRowid,
  };

  // ── KUNDER ──────────────────────────────────────────────────────
  const insertC = db.prepare(`
    INSERT INTO customers (company_id, first_name, last_name, phone, email, is_primary_contact, is_active)
    VALUES (?,?,?,?,?,?,1)
  `);

  const cust = {
    rasmus: insertC.run(co.finansforbundet, 'Rasmus', 'Vinther-Schmidt', '23 81 83 29', 'rasmus@finansforbundet.dk', 1).lastInsertRowid,
    sara:   insertC.run(co.maersk,         'Sara',   'Hanson',          '40 50 60 70', 'sara@maersk.com',           1).lastInsertRowid,
    jens:   insertC.run(co.kk,             'Jens',   'Holm',            '29 81 20 11', 'jens.holm@kk.dk',           1).lastInsertRowid,
    nora:   insertC.run(null,              'Nora',   'Ottens',          '20 30 40 50', 'nora@example.dk',           0).lastInsertRowid,
  };

  // ── STATUS IDs ──────────────────────────────────────────────────
  const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
  const locId    = db.prepare(`SELECT id FROM locations WHERE code = 'hq'`).get()?.id ?? 1;
  const catId    = db.prepare(`SELECT id FROM price_categories WHERE code = 'catering'`).get()?.id ?? 1;

  const today = new Date().toISOString().slice(0, 10);

  // ── BONNER ──────────────────────────────────────────────────────
  const insertBon = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id, customer_id, company_id, price_category_id,
      order_date, delivery_date, pickup_time, delivery_time,
      delivery_type, delivery_method, delivery_address_id,
      pax, total_units, kitchen_info,
      prep_ingredients_ready, prep_supplies_ready,
      payment_type, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `);

  const bon3288 = insertBon.run(
    '3288', statusId('IGANG'), locId, cust.nora,   null,       catId,
    today,  today, '12:30', '12:12',
    'delivery', 'bike', addr.nora,
    28, 70, null,
    0, 0, 'invoice'
  ).lastInsertRowid;

  const bon3291 = insertBon.run(
    '3291', statusId('IGANG'), locId, cust.sara,   co.maersk,  catId,
    today,  today, '11:00', '11:45',
    'delivery', 'bike', addr.maersk,
    20, 20, null,
    1, 0, 'invoice'
  ).lastInsertRowid;

  const bon3295 = insertBon.run(
    '3295', statusId('GODKENDT'), locId, cust.rasmus, co.finansforbundet, catId,
    today,  today, '13:00', '13:30',
    'delivery', 'bike', addr.finansforbundet,
    40, 100, 'Æggepandekager mangler – erstat med ekstra hønsesalat',
    0, 0, 'invoice'
  ).lastInsertRowid;

  const bon3301 = insertBon.run(
    '3301', statusId('GODKENDT'), locId, cust.jens, co.kk, catId,
    today,  today, '14:30', '15:00',
    'delivery', 'taxi', addr.kk,
    15, 30, null,
    0, 0, 'invoice'
  ).lastInsertRowid;

  // ── BON LINES ────────────────────────────────────────────────────
  const insertLine = db.prepare(`
    INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, sort_order, is_accessory, co2e)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  // B3288
  [[4,'Falaflen GF slider','mad',0,1.44],
   [4,'Kyllingen GF slider','mad',0,1.21],
   [4,'Ægget GF slider','mad',0,1.02],
   [7,'"Tunen" Spicy slider','mad',0,0.82],
   [7,'Kyllingen slider','mad',0,1.21],
   [10,'Receptions Skinner','mad',0,0.44],
   [2,'Transportkasse m låg','emballage',1,0],
   [1,'Byekspressen leverer','levering',1,0.02]
  ].forEach(([qty,name,cat,acc,co2e],i) => insertLine.run(bon3288,name,cat,qty,'stk',i+1,acc,co2e));

  // B3291
  [[5,'Falaflen slider','mad',0,1.44],
   [5,'"Tunen" slider','mad',0,0.82],
   [5,'Kyllingen slider','mad',0,1.21],
   [5,'Ægget slider','mad',0,1.02],
   [1,'Transportkasse m låg','emballage',1,0],
   [1,'Byekspressen leverer','levering',1,0.02]
  ].forEach(([qty,name,cat,acc,co2e],i) => insertLine.run(bon3291,name,cat,qty,'stk',i+1,acc,co2e));

  // B3295
  [[15,'Falaflen slider','mad',0,1.44],
   [15,'Kyllingen slider','mad',0,1.21],
   [15,'"Tunen" Spicy slider','mad',0,0.82],
   [15,'Ægget slider','mad',0,1.02],
   [20,'Receptions Skinner','mad',0,0.44],
   [3,'Transportkasse m låg','emballage',1,0],
   [1,'Byekspressen leverer','levering',1,0.02]
  ].forEach(([qty,name,cat,acc,co2e],i) => insertLine.run(bon3295,name,cat,qty,'stk',i+1,acc,co2e));

  // B3301
  [[10,'Smørrebrød mix','mad',0,0.90],
   [10,'Vegansk wrap','mad',0,0.65],
   [10,'Kyllingesalat','mad',0,1.10],
   [2,'Transportkasse m låg','emballage',1,0],
   [1,'Taxa leverer','levering',1,0.80]
  ].forEach(([qty,name,cat,acc,co2e],i) => insertLine.run(bon3301,name,cat,qty,'stk',i+1,acc,co2e));

  // ── CHANGELOG ────────────────────────────────────────────────────
  const logStmt = db.prepare(`
    INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id)
    VALUES (?,?,?,?,?,?,1)
  `);
  logStmt.run('bon', bon3288, 'status_change', 'status', 'GODKENDT', 'IGANG');
  logStmt.run('bon', bon3291, 'status_change', 'status', 'GODKENDT', 'IGANG');
  logStmt.run('bon', bon3295, 'create', null, null, '3295');
  logStmt.run('bon', bon3301, 'create', null, null, '3301');

  // ── FLYVER ───────────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
    VALUES (?,?,?,?,1)
  `).run(bon3295, 'flyver', 'Æggepandekager udgået – se køkken info', 'urgent');

  console.log('✅ Seed data indsat:');
  console.log(`   Adresser: ${Object.keys(addr).length}`);
  console.log(`   Firmaer:  ${Object.keys(co).length}`);
  console.log(`   Kunder:   ${Object.keys(cust).length}`);
  console.log(`   Bonner:   4 (dagens dato: ${today})`);
});

try {
  run();
} catch (e) {
  console.error('❌ Seed fejlede:', e.message);
  process.exit(1);
}
