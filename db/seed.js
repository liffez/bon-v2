/**
 * seed.js — Realistiske testdata til Bon v2
 * Kør: node db/seed.js
 *
 * Forudsætter at migrate.js allerede er kørt.
 */

const path     = require('path');
const { openDb, transaction } = require('./compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// ── Dato-helpers ─────────────────────────────────────────────
function dayOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const today     = dayOffset(0);
const yesterday = dayOffset(-1);
const twoDaysAgo = dayOffset(-2);
const threeDaysAgo = dayOffset(-3);
const fourDaysAgo = dayOffset(-4);
const tomorrow  = dayOffset(1);
const in2days   = dayOffset(2);
const in3days   = dayOffset(3);
const in4days   = dayOffset(4);
const in5days   = dayOffset(5);

const run = () => transaction(db, () => { /* seed-transaction */

  // Ryd eksisterende seed-data (sikker rækkefølge, FK-venlig)
  db.exec(`
    DELETE FROM notification_reads;
    DELETE FROM mail_attachments;
    DELETE FROM mail_messages;
    DELETE FROM mail_threads;
    DELETE FROM mail_unmatched;
    DELETE FROM crm_activities;
    DELETE FROM crm_unmatched_emails;
    DELETE FROM delivery_events;
    DELETE FROM geo_calculations;
    DELETE FROM shopping_list;
    DELETE FROM quotes;
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
    novo:            insertAddr.run('Novo Allé',      '1',  '2880', 'Bagsværd',      55.7560, 12.4530).lastInsertRowid,
    dr:              insertAddr.run('Emil Holms Kanal','20', '0999', 'København C',   55.6586, 12.5910).lastInsertRowid,
    tivoli:          insertAddr.run('Vesterbrogade',   '3',  '1630', 'København V',   55.6737, 12.5681).lastInsertRowid,
  };

  // ── FIRMAER ─────────────────────────────────────────────────────
  const insertCo = db.prepare(`
    INSERT INTO companies (name, cvr, ean, address_id, phone, email, invoice_email,
      invoice_method, default_payment_type, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,1)
  `);

  const co = {
    finansforbundet: insertCo.run('Finansforbundet',        '10123456', null,              addr.finansforbundet, '38 39 40 00', 'bestilling@finansforbundet.dk', null,           'email', 'invoice').lastInsertRowid,
    maersk:          insertCo.run('A.P. Møller - Mærsk A/S','22756214', null,              addr.maersk,          '33 63 33 63', 'events@maersk.com',             null,           'email', 'invoice').lastInsertRowid,
    kk:              insertCo.run('Københavns Kommune',     '64942212', '5798009811578',   addr.kk,              '33 66 33 66', 'events@kk.dk',                  'ean@kk.dk',   'ean',   'invoice').lastInsertRowid,
    novo:            insertCo.run('Novo Nordisk A/S',       '24256790', null,              addr.novo,            '44 44 88 88', 'kantine@novonordisk.com',        null,           'email', 'invoice').lastInsertRowid,
    dr:              insertCo.run('DR',                     '62786815', null,              addr.dr,              '35 20 30 40', 'events@dr.dk',                   null,           'email', 'invoice').lastInsertRowid,
  };

  // ── KUNDER ──────────────────────────────────────────────────────
  const insertC = db.prepare(`
    INSERT INTO customers (company_id, first_name, last_name, phone, email, is_primary_contact, is_active)
    VALUES (?,?,?,?,?,?,1)
  `);

  const cust = {
    rasmus: insertC.run(co.finansforbundet, 'Rasmus', 'Vinther-Schmidt', '23 81 83 29', 'rasmus@finansforbundet.dk', 1).lastInsertRowid,
    sara:   insertC.run(co.maersk,          'Sara',   'Hanson',          '40 50 60 70', 'sara@maersk.com',           1).lastInsertRowid,
    jens:   insertC.run(co.kk,              'Jens',   'Holm',            '29 81 20 11', 'jens.holm@kk.dk',           1).lastInsertRowid,
    nora:   insertC.run(null,               'Nora',   'Ottens',          '20 30 40 50', 'nora@example.dk',           0).lastInsertRowid,
    lise:   insertC.run(co.novo,            'Lise',   'Nordstrøm',       '44 88 12 34', 'lise.n@novonordisk.com',    1).lastInsertRowid,
    morten: insertC.run(co.dr,              'Morten', 'Kildegaard',      '35 20 99 01', 'morten.k@dr.dk',            1).lastInsertRowid,
    anna:   insertC.run(null,               'Anna',   'Bjerre',          '28 19 45 67', 'anna.bjerre@gmail.com',     0).lastInsertRowid,
  };

  // ── BRUGERE ─────────────────────────────────────────────────────
  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, name, email, role) VALUES (1, 'System', 'system@ristetrug.dk', 'admin')`).run();

  const bcrypt = require('bcryptjs');
  const adminHash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (id, name, email, role, password_hash) VALUES (2, 'Admin', 'admin@ristetrug.dk', 'admin', ?)`).run(adminHash);
  db.prepare(`INSERT INTO users (id, name, email, role, pin) VALUES (3, 'Køkken', 'kitchen@ristetrug.dk', 'kitchen', '1234')`).run();

  // ── STATUS IDs ──────────────────────────────────────────────────
  const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
  const locId    = db.prepare(`SELECT id FROM locations WHERE code = 'hq'`).get()?.id ?? 1;
  const catId    = db.prepare(`SELECT id FROM price_categories WHERE code = 'catering'`).get()?.id ?? 1;

  // ── BONNER ──────────────────────────────────────────────────────
  const insertBon = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id, customer_id, company_id, price_category_id,
      order_date, delivery_date, pickup_time, delivery_time,
      delivery_type, delivery_method, delivery_address_id,
      pax, total_units, kitchen_info,
      prep_ingredients_ready, prep_supplies_ready,
      kitchen_selects, customer_collects,
      payment_type, price_category, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `);

  // ── I GÅR — leverede ordrer ─────────────────────────────────
  const bon3285 = insertBon.run(
    '3285', statusId('LEVERET'), locId, cust.anna, null, catId,
    yesterday, yesterday, '10:00', null,
    'pickup', null, null,
    8, 16, null,
    1, 1, 0, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  // ── I DAG — blandet status ──────────────────────────────────
  const bon3288 = insertBon.run(
    '3288', statusId('IGANG'), locId, cust.nora, null, catId,
    today, today, '12:30', '12:12',
    'delivery', 'bike', addr.nora,
    28, 70, null,
    1, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3291 = insertBon.run(
    '3291', statusId('IGANG'), locId, cust.sara, co.maersk, catId,
    today, today, '11:00', '11:45',
    'delivery', 'bike', addr.maersk,
    20, 20, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3295 = insertBon.run(
    '3295', statusId('GODKENDT'), locId, cust.rasmus, co.finansforbundet, catId,
    today, today, '13:00', '13:30',
    'delivery', 'bike', addr.finansforbundet,
    40, 100, 'Æggepandekager mangler – erstat med ekstra hønsesalat',
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3301 = insertBon.run(
    '3301', statusId('GODKENDT'), locId, cust.jens, co.kk, catId,
    today, today, '14:30', '15:00',
    'delivery', 'taxi', addr.kk,
    15, 30, null,
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3305 = insertBon.run(
    '3305', statusId('KLAR'), locId, cust.morten, co.dr, catId,
    today, today, '09:30', '10:00',
    'delivery', 'bike', addr.dr,
    12, 24, 'Vegansk fokus — intet kød',
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3308 = insertBon.run(
    '3308', statusId('IGANG'), locId, cust.anna, null, catId,
    today, today, '15:00', null,
    'pickup', null, null,
    6, 12, null,
    1, 0, 1, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  // ── I MORGEN ────────────────────────────────────────────────
  const bon3312 = insertBon.run(
    '3312', statusId('GODKENDT'), locId, cust.lise, co.novo, catId,
    today, tomorrow, '12:00', '12:30',
    'delivery', 'taxi', addr.novo,
    60, 150, 'Stort ledermøde — extra pæn anretning',
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3315 = insertBon.run(
    '3315', statusId('GODKENDT'), locId, cust.rasmus, co.finansforbundet, catId,
    today, tomorrow, '11:00', '11:30',
    'delivery', 'bike', addr.finansforbundet,
    25, 50, null,
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3318 = insertBon.run(
    '3318', statusId('VENTER'), locId, cust.anna, null, catId,
    today, tomorrow, '14:00', null,
    'pickup', null, null,
    10, 20, 'Fødselsdagsfest — skal bekræftes i dag',
    0, 0, 1, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  // ── OM 2-3 DAGE ────────────────────────────────────────────
  const bon3322 = insertBon.run(
    '3322', statusId('GODKENDT'), locId, cust.morten, co.dr, catId,
    today, in2days, '11:30', '12:00',
    'delivery', 'bike', addr.dr,
    30, 60, null,
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3325 = insertBon.run(
    '3325', statusId('NY'), locId, cust.sara, co.maersk, catId,
    today, in3days, '12:00', '12:30',
    'delivery', 'taxi', addr.maersk,
    50, 0, null,
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  // ── HISTORISKE BONS (chart-data) ────────────────────────────
  const storeCatId = db.prepare(`SELECT id FROM price_categories WHERE code = 'store'`).get()?.id ?? catId;
  const festCatId  = db.prepare(`SELECT id FROM price_categories WHERE code = 'festival'`).get()?.id ?? catId;

  // 4 dage siden — 3 bons (leveret)
  const bon3270 = insertBon.run(
    '3270', statusId('LEVERET'), locId, cust.lise, co.novo, catId,
    fourDaysAgo, fourDaysAgo, '11:00', '11:30',
    'delivery', 'bike', addr.novo,
    35, 80, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3271 = insertBon.run(
    '3271', statusId('LEVERET'), locId, cust.anna, null, storeCatId,
    fourDaysAgo, fourDaysAgo, '10:00', null,
    'pickup', null, null,
    8, 16, null,
    1, 1, 0, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  const bon3272 = insertBon.run(
    '3272', statusId('LEVERET'), locId, cust.morten, co.dr, catId,
    fourDaysAgo, fourDaysAgo, '12:00', '12:30',
    'delivery', 'taxi', addr.dr,
    20, 45, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  // 3 dage siden — 4 bons (leveret)
  const bon3275 = insertBon.run(
    '3275', statusId('LEVERET'), locId, cust.rasmus, co.finansforbundet, catId,
    threeDaysAgo, threeDaysAgo, '11:30', '12:00',
    'delivery', 'bike', addr.finansforbundet,
    50, 120, 'Bestyrelsesmøde — stor ordre',
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3276 = insertBon.run(
    '3276', statusId('LEVERET'), locId, cust.sara, co.maersk, catId,
    threeDaysAgo, threeDaysAgo, '12:00', '12:30',
    'delivery', 'taxi', addr.maersk,
    30, 60, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3277 = insertBon.run(
    '3277', statusId('LEVERET'), locId, cust.jens, co.kk, festCatId,
    threeDaysAgo, threeDaysAgo, '10:00', '10:30',
    'delivery', 'bike', addr.tivoli,
    25, 50, 'Festival-priser',
    1, 1, 0, 0, 'invoice', 'festival'
  ).lastInsertRowid;

  const bon3278 = insertBon.run(
    '3278', statusId('LEVERET'), locId, cust.nora, null, storeCatId,
    threeDaysAgo, threeDaysAgo, '14:00', null,
    'pickup', null, null,
    6, 12, null,
    1, 1, 0, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  // 2 dage siden — 3 bons (leveret)
  const bon3280 = insertBon.run(
    '3280', statusId('LEVERET'), locId, cust.lise, co.novo, catId,
    twoDaysAgo, twoDaysAgo, '11:30', '12:00',
    'delivery', 'taxi', addr.novo,
    45, 100, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3281 = insertBon.run(
    '3281', statusId('LEVERET'), locId, cust.morten, co.dr, catId,
    twoDaysAgo, twoDaysAgo, '10:00', '10:30',
    'delivery', 'bike', addr.dr,
    18, 36, null,
    1, 1, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3282 = insertBon.run(
    '3282', statusId('LEVERET'), locId, cust.anna, null, storeCatId,
    twoDaysAgo, twoDaysAgo, '15:00', null,
    'pickup', null, null,
    10, 20, null,
    1, 1, 0, 1, 'mobilepay', 'store'
  ).lastInsertRowid;

  // ── EKSTRA FREMTIDIGE BONS ──────────────────────────────────

  // Om 4 dage — 2 bons
  const bon3330 = insertBon.run(
    '3330', statusId('GODKENDT'), locId, cust.lise, co.novo, catId,
    today, in4days, '11:00', '11:30',
    'delivery', 'taxi', addr.novo,
    40, 90, 'Fredag morgenmøde',
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  const bon3331 = insertBon.run(
    '3331', statusId('GODKENDT'), locId, cust.jens, co.kk, festCatId,
    today, in4days, '12:00', '12:30',
    'delivery', 'bike', addr.kk,
    25, 55, null,
    0, 0, 0, 0, 'invoice', 'festival'
  ).lastInsertRowid;

  // Om 5 dage — 1 bon
  const bon3335 = insertBon.run(
    '3335', statusId('GODKENDT'), locId, cust.rasmus, co.finansforbundet, catId,
    today, in5days, '10:00', '10:30',
    'delivery', 'bike', addr.finansforbundet,
    15, 30, null,
    0, 0, 0, 0, 'invoice', 'catering'
  ).lastInsertRowid;

  // ── BON LINES ────────────────────────────────────────────────────
  const insertLine = db.prepare(`
    INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, sort_order, is_accessory, co2e, unit_price, line_total)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  // Prismap: produkt → { store, catering, festival } salgspriser
  const PRICES = {
    'Kyllingen slider':       { store: 45, catering: 45, festival: 48 },
    'Falaflen slider':        { store: 45, catering: 45, festival: 48 },
    'Falaflen GF slider':     { store: 48, catering: 48, festival: 50 },
    'Kyllingen GF slider':    { store: 48, catering: 48, festival: 50 },
    'Ægget GF slider':        { store: 48, catering: 48, festival: 50 },
    '"Tunen" Spicy slider':   { store: 45, catering: 45, festival: 48 },
    '"Tunen" slider':         { store: 45, catering: 45, festival: 48 },
    'Ægget slider':           { store: 45, catering: 45, festival: 48 },
    'Receptions Skinner':     { store: 35, catering: 35, festival: 38 },
    'Granola shot':           { store: 32, catering: 32, festival: 35 },
    'Frugtsalat bæger':       { store: 38, catering: 38, festival: 40 },
    'Smørrebrød mix':         { store: 89, catering: 89, festival: 95 },
    'Kyllingesalat':          { store: 89, catering: 89, festival: 95 },
    'Vegansk wrap':           { store: 75, catering: 75, festival: 80 },
    'Hummus & grønt wrap':    { store: 75, catering: 75, festival: 80 },
    'Transportkasse m låg':   { store: 0, catering: 0, festival: 0 },
    'Byekspressen leverer':   { store: 0, catering: 0, festival: 0 },
    'Taxa leverer':           { store: 0, catering: 0, festival: 0 },
  };

  // Helper: indsæt linje med pris baseret på bonId → price_category lookup
  const bonPriceCat = {};  // bonId → price_category code
  function addLines(bonId, priceCat, lines) {
    bonPriceCat[bonId] = priceCat;
    lines.forEach(([qty, name, cat, acc, co2e], i) => {
      const prices = PRICES[name] || { store: 0, catering: 0, festival: 0 };
      const unitPrice = prices[priceCat] || prices.catering || 0;
      const lineTotal = qty * unitPrice;
      insertLine.run(bonId, name, cat, qty, 'stk', i + 1, acc, co2e, unitPrice, lineTotal);
    });
  }

  // B3285 (igår, afhentning, store)
  addLines(bon3285, 'store', [
    [8,'Kyllingen slider','mad',0,1.21],
    [8,'Falaflen slider','mad',0,1.44],
  ]);

  // B3288 (i dag, IGANG, catering)
  addLines(bon3288, 'catering', [
    [4,'Falaflen GF slider','mad',0,1.44],
    [4,'Kyllingen GF slider','mad',0,1.21],
    [4,'Ægget GF slider','mad',0,1.02],
    [7,'"Tunen" Spicy slider','mad',0,0.82],
    [7,'Kyllingen slider','mad',0,1.21],
    [10,'Receptions Skinner','mad',0,0.44],
    [2,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3291 (i dag, IGANG, catering)
  addLines(bon3291, 'catering', [
    [5,'Falaflen slider','mad',0,1.44],
    [5,'"Tunen" slider','mad',0,0.82],
    [5,'Kyllingen slider','mad',0,1.21],
    [5,'Ægget slider','mad',0,1.02],
    [1,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3295 (i dag, GODKENDT, catering, stort event)
  addLines(bon3295, 'catering', [
    [15,'Falaflen slider','mad',0,1.44],
    [15,'Kyllingen slider','mad',0,1.21],
    [15,'"Tunen" Spicy slider','mad',0,0.82],
    [15,'Ægget slider','mad',0,1.02],
    [20,'Receptions Skinner','mad',0,0.44],
    [10,'Granola shot','mad',0,0.35],
    [10,'Frugtsalat bæger','mad',0,0.28],
    [3,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3301 (i dag, GODKENDT, catering)
  addLines(bon3301, 'catering', [
    [10,'Smørrebrød mix','mad',0,0.90],
    [10,'Vegansk wrap','mad',0,0.65],
    [10,'Kyllingesalat','mad',0,1.10],
    [2,'Transportkasse m låg','emballage',1,0],
    [1,'Taxa leverer','levering',1,0.80],
  ]);

  // B3305 (i dag, KLAR, catering, vegansk)
  addLines(bon3305, 'catering', [
    [6,'Falaflen slider','mad',0,1.44],
    [6,'Ægget slider','mad',0,1.02],
    [6,'"Tunen" slider','mad',0,0.82],
    [6,'Hummus & grønt wrap','mad',0,0.55],
    [1,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3308 (i dag, IGANG, store, afhentning)
  addLines(bon3308, 'store', [
    [4,'Kyllingen slider','mad',0,1.21],
    [4,'Falaflen slider','mad',0,1.44],
    [4,'Granola shot','mad',0,0.35],
  ]);

  // B3312 (i morgen, catering, stort Novo-møde)
  addLines(bon3312, 'catering', [
    [20,'Kyllingen slider','mad',0,1.21],
    [20,'Falaflen slider','mad',0,1.44],
    [20,'"Tunen" Spicy slider','mad',0,0.82],
    [20,'Ægget slider','mad',0,1.02],
    [30,'Receptions Skinner','mad',0,0.44],
    [20,'Granola shot','mad',0,0.35],
    [20,'Frugtsalat bæger','mad',0,0.28],
    [4,'Transportkasse m låg','emballage',1,0],
    [1,'Taxa leverer','levering',1,0.80],
  ]);

  // B3315 (i morgen, catering, Finansforbundet)
  addLines(bon3315, 'catering', [
    [10,'Falaflen slider','mad',0,1.44],
    [10,'Kyllingen slider','mad',0,1.21],
    [10,'"Tunen" slider','mad',0,0.82],
    [10,'Ægget slider','mad',0,1.02],
    [10,'Smørrebrød mix','mad',0,0.90],
    [2,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3318 (i morgen, store, afhentning, VENTER)
  addLines(bon3318, 'store', [
    [10,'Kyllingen slider','mad',0,1.21],
    [10,'Vegansk wrap','mad',0,0.65],
  ]);

  // B3322 (om 2 dage, catering, DR)
  addLines(bon3322, 'catering', [
    [15,'Falaflen slider','mad',0,1.44],
    [15,'Kyllingen slider','mad',0,1.21],
    [15,'"Tunen" Spicy slider','mad',0,0.82],
    [15,'Receptions Skinner','mad',0,0.44],
    [2,'Transportkasse m låg','emballage',1,0],
    [1,'Byekspressen leverer','levering',1,0.02],
  ]);

  // B3325 (om 3 dage, ny — ingen linjer endnu)

  // ── HISTORISKE BON LINES ─────────────────────────────────────────

  // B3270 (4 dage siden, catering, Novo)
  addLines(bon3270, 'catering', [
    [20,'Kyllingen slider','mad',0,1.21],
    [20,'Falaflen slider','mad',0,1.44],
    [20,'"Tunen" slider','mad',0,0.82],
    [20,'Receptions Skinner','mad',0,0.44],
  ]);

  // B3271 (4 dage siden, store, pickup)
  addLines(bon3271, 'store', [
    [8,'Kyllingen slider','mad',0,1.21],
    [8,'Granola shot','mad',0,0.35],
  ]);

  // B3272 (4 dage siden, catering, DR)
  addLines(bon3272, 'catering', [
    [15,'Falaflen slider','mad',0,1.44],
    [15,'Smørrebrød mix','mad',0,0.90],
    [15,'Kyllingesalat','mad',0,1.10],
  ]);

  // B3275 (3 dage siden, catering, Finansforbundet stor)
  addLines(bon3275, 'catering', [
    [25,'Kyllingen slider','mad',0,1.21],
    [25,'Falaflen slider','mad',0,1.44],
    [25,'"Tunen" Spicy slider','mad',0,0.82],
    [25,'Receptions Skinner','mad',0,0.44],
    [20,'Granola shot','mad',0,0.35],
  ]);

  // B3276 (3 dage siden, catering, Mærsk)
  addLines(bon3276, 'catering', [
    [15,'Falaflen slider','mad',0,1.44],
    [15,'Kyllingen slider','mad',0,1.21],
    [15,'Ægget slider','mad',0,1.02],
    [15,'Vegansk wrap','mad',0,0.65],
  ]);

  // B3277 (3 dage siden, festival, KK)
  addLines(bon3277, 'festival', [
    [25,'Kyllingen slider','mad',0,1.21],
    [25,'Falaflen slider','mad',0,1.44],
  ]);

  // B3278 (3 dage siden, store, pickup)
  addLines(bon3278, 'store', [
    [6,'Kyllingen slider','mad',0,1.21],
    [6,'Granola shot','mad',0,0.35],
  ]);

  // B3280 (2 dage siden, catering, Novo)
  addLines(bon3280, 'catering', [
    [25,'Kyllingen slider','mad',0,1.21],
    [25,'Falaflen slider','mad',0,1.44],
    [25,'"Tunen" slider','mad',0,0.82],
    [25,'Receptions Skinner','mad',0,0.44],
  ]);

  // B3281 (2 dage siden, catering, DR)
  addLines(bon3281, 'catering', [
    [12,'Smørrebrød mix','mad',0,0.90],
    [12,'Kyllingesalat','mad',0,1.10],
    [12,'Falaflen slider','mad',0,1.44],
  ]);

  // B3282 (2 dage siden, store, pickup)
  addLines(bon3282, 'store', [
    [10,'Kyllingen slider','mad',0,1.21],
    [10,'Frugtsalat bæger','mad',0,0.28],
  ]);

  // B3330 (om 4 dage, catering, Novo)
  addLines(bon3330, 'catering', [
    [20,'Kyllingen slider','mad',0,1.21],
    [20,'Falaflen slider','mad',0,1.44],
    [20,'"Tunen" Spicy slider','mad',0,0.82],
    [15,'Granola shot','mad',0,0.35],
    [15,'Frugtsalat bæger','mad',0,0.28],
  ]);

  // B3331 (om 4 dage, festival, KK)
  addLines(bon3331, 'festival', [
    [20,'Kyllingen slider','mad',0,1.21],
    [20,'Falaflen slider','mad',0,1.44],
    [15,'Ægget slider','mad',0,1.02],
  ]);

  // B3335 (om 5 dage, catering, Finansforbundet)
  addLines(bon3335, 'catering', [
    [10,'Kyllingen slider','mad',0,1.21],
    [10,'Falaflen slider','mad',0,1.44],
    [10,'Smørrebrød mix','mad',0,0.90],
  ]);

  // ── CHANGELOG ────────────────────────────────────────────────────
  const logStmt = db.prepare(`
    INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id)
    VALUES (?,?,?,?,?,?,1)
  `);

  // Igår
  logStmt.run('bon', bon3285, 'create',        null,     null,      '3285');
  logStmt.run('bon', bon3285, 'status_change',  'status', 'NY',      'GODKENDT');
  logStmt.run('bon', bon3285, 'status_change',  'status', 'GODKENDT','IGANG');
  logStmt.run('bon', bon3285, 'status_change',  'status', 'IGANG',   'KLAR');
  logStmt.run('bon', bon3285, 'status_change',  'status', 'KLAR',    'LEVERET');

  // I dag
  logStmt.run('bon', bon3288, 'create',        null,     null,      '3288');
  logStmt.run('bon', bon3288, 'status_change',  'status', 'GODKENDT','IGANG');
  logStmt.run('bon', bon3291, 'create',        null,     null,      '3291');
  logStmt.run('bon', bon3291, 'status_change',  'status', 'GODKENDT','IGANG');
  logStmt.run('bon', bon3295, 'create',        null,     null,      '3295');
  logStmt.run('bon', bon3301, 'create',        null,     null,      '3301');
  logStmt.run('bon', bon3305, 'create',        null,     null,      '3305');
  logStmt.run('bon', bon3305, 'status_change',  'status', 'GODKENDT','IGANG');
  logStmt.run('bon', bon3305, 'status_change',  'status', 'IGANG',   'KLAR');
  logStmt.run('bon', bon3308, 'create',        null,     null,      '3308');
  logStmt.run('bon', bon3308, 'status_change',  'status', 'GODKENDT','IGANG');

  // Historiske (4 dage siden)
  logStmt.run('bon', bon3270, 'create',        null,     null,      '3270');
  logStmt.run('bon', bon3270, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3271, 'create',        null,     null,      '3271');
  logStmt.run('bon', bon3271, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3272, 'create',        null,     null,      '3272');
  logStmt.run('bon', bon3272, 'status_change',  'status', 'NY',      'LEVERET');

  // Historiske (3 dage siden)
  logStmt.run('bon', bon3275, 'create',        null,     null,      '3275');
  logStmt.run('bon', bon3275, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3276, 'create',        null,     null,      '3276');
  logStmt.run('bon', bon3276, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3277, 'create',        null,     null,      '3277');
  logStmt.run('bon', bon3277, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3278, 'create',        null,     null,      '3278');
  logStmt.run('bon', bon3278, 'status_change',  'status', 'NY',      'LEVERET');

  // Historiske (2 dage siden)
  logStmt.run('bon', bon3280, 'create',        null,     null,      '3280');
  logStmt.run('bon', bon3280, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3281, 'create',        null,     null,      '3281');
  logStmt.run('bon', bon3281, 'status_change',  'status', 'NY',      'LEVERET');
  logStmt.run('bon', bon3282, 'create',        null,     null,      '3282');
  logStmt.run('bon', bon3282, 'status_change',  'status', 'NY',      'LEVERET');

  // Fremtidige
  logStmt.run('bon', bon3312, 'create',        null,     null,      '3312');
  logStmt.run('bon', bon3315, 'create',        null,     null,      '3315');
  logStmt.run('bon', bon3318, 'create',        null,     null,      '3318');
  logStmt.run('bon', bon3322, 'create',        null,     null,      '3322');
  logStmt.run('bon', bon3325, 'create',        null,     null,      '3325');
  logStmt.run('bon', bon3330, 'create',        null,     null,      '3330');
  logStmt.run('bon', bon3331, 'create',        null,     null,      '3331');
  logStmt.run('bon', bon3335, 'create',        null,     null,      '3335');

  // ── FLYVER ───────────────────────────────────────────────────────
  const insertNotif = db.prepare(`
    INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
    VALUES (?,?,?,?,1)
  `);
  insertNotif.run(bon3295, 'flyver', 'Æggepandekager udgået – se køkken info', 'urgent');
  insertNotif.run(bon3305, 'flyver', 'Bud ankommer kl 09:50', 'normal');

  // ── OPSUMMERING ──────────────────────────────────────────────────
  const totalBons = 1 + 10 + 5 + 3 + 2 + 3;
  console.log(`
✅ Seed data indsat
   Adresser:  ${Object.keys(addr).length}
   Firmaer:   ${Object.keys(co).length}
   Kunder:    ${Object.keys(cust).length}
   Bonner:    ${totalBons} total
     4 dage siden: 3  (LEVERET)
     3 dage siden: 4  (LEVERET)
     2 dage siden: 3  (LEVERET)
     I går:        1  (LEVERET)
     I dag:        5  (3× IGANG, 1× KLAR, 2× GODKENDT)
     I morgen:     3  (2× GODKENDT, 1× VENTER)
     Om 2 dage:    1  (GODKENDT)
     Om 3 dage:    1  (NY)
     Om 4 dage:    2  (GODKENDT)
     Om 5 dage:    1  (GODKENDT)
   Datoer:    ${fourDaysAgo} → ${in5days}
`);
});

try {
  run();
} catch (e) {
  console.error('❌ Seed fejlede:', e.message);
  process.exit(1);
}
