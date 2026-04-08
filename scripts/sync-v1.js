#!/usr/bin/env node
/**
 * sync-v1.js — Synkroniser data fra Bon v1 til v2
 *
 * Brug:
 *   node scripts/sync-v1.js --full      # Første kørsel: alt data
 *   node scripts/sync-v1.js             # Delta: kun ændringer siden sidst
 *   node scripts/sync-v1.js --dry-run   # Test uden at skrive
 *
 * Kræver:
 *   V1_DB_PATH i .env (eller som argument)
 *   v2-database i data/bon.db (standard)
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, transaction } = require('../db/compat');

// ── Konfiguration ────────────────────────────────────────────
const args = process.argv.slice(2);
const FULL_MODE = args.includes('--full');
const DRY_RUN   = args.includes('--dry-run');

const V1_DB_PATH = process.env.V1_DB_PATH
  || args.find(a => !a.startsWith('--'))
  || null;

if (!V1_DB_PATH) {
  console.error('Fejl: Angiv V1_DB_PATH i .env eller som argument.');
  console.error('Brug: V1_DB_PATH=/path/to/v1.db node scripts/sync-v1.js [--full] [--dry-run]');
  process.exit(1);
}

const V2_DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

// ── Åbn databaser ────────────────────────────────────────────
let v1, db;
try {
  v1 = new DatabaseSync(V1_DB_PATH, { readOnly: true });
} catch (e) {
  console.error(`Fejl: Kan ikke åbne v1-database: ${V1_DB_PATH}`);
  console.error(e.message);
  process.exit(1);
}

db = openDb(V2_DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// ── Statistik ────────────────────────────────────────────────
const stats = {
  companies:  { total: 0, inserted: 0, updated: 0 },
  customers:  { total: 0, inserted: 0, updated: 0 },
  addresses:  { total: 0, inserted: 0, updated: 0 },
  bons:       { total: 0, inserted: 0, updated: 0, byStatus: {} },
  bon_lines:  { total: 0, inserted: 0, deleted: 0 },
};

// ── Lookup-tabeller (v2) ─────────────────────────────────────
const STATUS_MAP = {
  'new':       1,   // NY
  'needInfo':  2,   // VENTER
  'approved':  3,   // GODKENDT
  'preparing': 4,   // IGANG
  'delivered': 6,   // LEVERET
  'invoiced':  7,   // FAKTURERET
  'payed':     8,   // BETALT
  'closed':    9,   // AFSLUTTET
};

const PAYMENT_MAP = {
  'Faktura':     'invoice',
  'EAN nr':      'invoice',
  'Kontant':     'cash',
  'Betaling...': 'card',
  'Produktion':  'invoice',
};

const PRICE_CAT_MAP = {
  'Store':      3,  // store (id=3)
  'Catering':   1,  // catering (id=1)
  'Festival':   2,  // festival (id=2)
  'Produktion': 4,  // produktion (id=4)
};

const DEFAULT_LOCATION_ID = 1; // HQ

// ── Helpers ──────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || null;
}

function setSetting(key, value) {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
}

function log(msg) {
  console.log(msg);
}

function parseV1Date(dt) {
  if (!dt) return { date: null, time: null };
  const d = new Date(dt);
  if (isNaN(d.getTime())) return { date: null, time: null };
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
  };
}

// ── Generisk upsert helper ───────────────────────────────────
// Bruger SELECT + INSERT/UPDATE i stedet for ON CONFLICT
// (partielle UNIQUE indeks virker ikke med ON CONFLICT i node:sqlite)
function upsertByV1Id(table, v1Id, insertFn, updateFn) {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE v1_id = ?`).get(v1Id);
  if (existing) {
    updateFn(existing.id);
    return { id: existing.id, wasInsert: false };
  } else {
    const id = insertFn();
    return { id, wasInsert: true };
  }
}

// ── Sync: Addresses ──────────────────────────────────────────
function syncAddresses() {
  log('  Synkroniserer adresser...');

  const v1Rows = v1.prepare('SELECT * FROM addresses').all();

  const insertStmt = db.prepare(`
    INSERT INTO addresses (v1_id, street_name, street_name2, street_nr, postal_code, city, lat, lon)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE addresses SET street_name=?, street_name2=?, street_nr=?, postal_code=?, city=?, lat=?, lon=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  for (const r of v1Rows) {
    if (DRY_RUN) { stats.addresses.total++; continue; }

    const vals = [
      r.street_name || null,
      r.street_name2 || null,
      r.street_nr || null,
      r.zip_code ? String(r.zip_code) : null,
      r.city || null,
      r.lat || null,
      r.lon || null,
    ];

    const { wasInsert } = upsertByV1Id('addresses', r.id,
      () => insertStmt.run(r.id, ...vals).lastInsertRowid,
      (id) => updateStmt.run(...vals, id)
    );

    stats.addresses.total++;
    if (wasInsert) { stats.addresses.inserted++; } else { stats.addresses.updated++; }
  }
}

// ── v1_company_id → v2_company_id mapping ────────────────────
// Håndterer at EAN-merge har slettet firmaer og samlet dem under ét
const v1CompanyMap = {}; // v1_id → v2_id

function resolveV2CompanyId(v1CompanyId) {
  if (!v1CompanyId) return null;
  if (v1CompanyMap[v1CompanyId]) return v1CompanyMap[v1CompanyId];
  // Fallback: direkte v1_id lookup (for firmaer der ikke er merget)
  const row = db.prepare('SELECT id FROM companies WHERE v1_id = ?').get(v1CompanyId);
  if (row) {
    v1CompanyMap[v1CompanyId] = row.id;
    return row.id;
  }
  return null;
}

// ── Sync: Companies ──────────────────────────────────────────
function syncCompanies() {
  log('  Synkroniserer firmaer...');

  const v1Rows = v1.prepare('SELECT * FROM companies').all();

  const insertStmt = db.prepare(`
    INSERT INTO companies (v1_id, name, ean, address_id, is_active)
    VALUES (?, ?, ?, ?, 1)
  `);
  // Update bevarer cvr, legal_name og notes (rør dem ikke)
  const updateStmt = db.prepare(`
    UPDATE companies SET name=?, ean=?, address_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND cvr IS NULL
  `);
  // For firmaer med CVR: opdater kun adresse, ikke navn/ean (de er beriget)
  const updateCvrStmt = db.prepare(`
    UPDATE companies SET address_id=COALESCE(?, address_id), updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND cvr IS NOT NULL
  `);

  for (const r of v1Rows) {
    const companyName = (r.name || '').trim();
    if (!companyName) {
      stats.companies.total++;
      stats.companies.updated++;
      continue;
    }

    if (DRY_RUN) { stats.companies.total++; continue; }

    let addressId = null;
    if (r.address_id) {
      const addrRow = db.prepare('SELECT id FROM addresses WHERE v1_id = ?').get(r.address_id);
      addressId = addrRow?.id || null;
    }

    const ean = r.ean_nr || null;

    // 1. Prøv v1_id match (normal case)
    const existingByV1 = db.prepare('SELECT id, cvr FROM companies WHERE v1_id = ?').get(r.id);
    if (existingByV1) {
      // Firmaet eksisterer — opdater forsigtigt
      if (existingByV1.cvr) {
        updateCvrStmt.run(addressId, existingByV1.id);
      } else {
        updateStmt.run(companyName, ean, addressId, existingByV1.id);
      }
      v1CompanyMap[r.id] = existingByV1.id;
      stats.companies.total++;
      stats.companies.updated++;
      continue;
    }

    // 2. Prøv EAN match (firmaet blev merget og v1_id er væk)
    if (ean) {
      const existingByEan = db.prepare("SELECT id FROM companies WHERE ean = ? AND ean != ''").get(ean);
      if (existingByEan) {
        v1CompanyMap[r.id] = existingByEan.id;
        stats.companies.total++;
        stats.companies.updated++;
        continue; // Rør ikke det mergede firma
      }
    }

    // 3. Nyt firma — insert
    const newId = insertStmt.run(r.id, companyName, ean, addressId).lastInsertRowid;
    v1CompanyMap[r.id] = newId;
    stats.companies.total++;
    stats.companies.inserted++;
  }
}

// ── Sync: Customers ──────────────────────────────────────────
function syncCustomers() {
  log('  Synkroniserer kunder...');

  const v1Rows = v1.prepare('SELECT * FROM customers').all();

  const insertStmt = db.prepare(`
    INSERT INTO customers (v1_id, company_id, first_name, last_name, email, phone, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const updateStmt = db.prepare(`
    UPDATE customers SET company_id=?, first_name=?, last_name=?, email=?, phone=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  for (const r of v1Rows) {
    if (DRY_RUN) { stats.customers.total++; continue; }

    let v2CompanyId = null;
    if (r.company_id) {
      v2CompanyId = resolveV2CompanyId(r.company_id);
    }

    const firstName = r.forename || 'Ukendt';
    const lastName = r.surname || null;
    const email = r.email || null;
    const phone = r.phone_nr || null;

    const { wasInsert } = upsertByV1Id('customers', r.id,
      () => insertStmt.run(r.id, v2CompanyId, firstName, lastName, email, phone).lastInsertRowid,
      (id) => updateStmt.run(v2CompanyId, firstName, lastName, email, phone, id)
    );

    stats.customers.total++;
    if (wasInsert) { stats.customers.inserted++; } else { stats.customers.updated++; }
  }
}

// ── Sync: Bons ───────────────────────────────────────────────
function syncBons() {
  log('  Synkroniserer boner...');

  const v1Rows = v1.prepare('SELECT * FROM bons').all();

  const insertStmt = db.prepare(`
    INSERT INTO bons (
      v1_id, sync_source, bon_number, status_id, location_id,
      customer_id, company_id, price_category_id,
      order_date, delivery_date, pickup_time, delivery_time,
      delivery_type, delivery_address_id,
      pax, total_units, payment_type,
      kitchen_selects, customer_collects,
      invoice_info, kitchen_info, customer_wishes, internal_notes,
      is_internal, price_category,
      prep_ingredients_ready, prep_supplies_ready
    ) VALUES (
      ?, 'v1', ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE bons SET
      status_id=?, customer_id=?, company_id=?, price_category_id=?,
      delivery_date=?, pickup_time=?, delivery_time=?,
      delivery_address_id=?,
      pax=?, total_units=?, payment_type=?,
      kitchen_selects=?, customer_collects=?,
      invoice_info=?, kitchen_info=?, customer_wishes=?, internal_notes=?,
      is_internal=?, price_category=?,
      prep_ingredients_ready=?, prep_supplies_ready=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  for (const r of v1Rows) {
    const statusId = STATUS_MAP[r.status];
    if (!statusId) {
      log(`    ⚠ Ukendt v1-status "${r.status}" på bon ${r.id} — springer over`);
      continue;
    }

    if (DRY_RUN) {
      stats.bons.total++;
      stats.bons.byStatus[r.status] = (stats.bons.byStatus[r.status] || 0) + 1;
      continue;
    }

    // FK lookups
    let v2CustomerId = null;
    if (r.customer_id) {
      const cust = db.prepare('SELECT id FROM customers WHERE v1_id = ?').get(r.customer_id);
      v2CustomerId = cust?.id || null;
    }

    // Hent company_id fra kunden (v1 bons har ikke company_id direkte)
    let v2CompanyId = null;
    if (v2CustomerId) {
      const custRow = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(v2CustomerId);
      v2CompanyId = custRow?.company_id || null;
    }

    let v2DeliveryAddrId = null;
    if (r.delivery_address_id) {
      const addr = db.prepare('SELECT id FROM addresses WHERE v1_id = ?').get(r.delivery_address_id);
      v2DeliveryAddrId = addr?.id || null;
    }

    const delivery = parseV1Date(r.delivery_date);
    const pickup = parseV1Date(r.pickup_time);
    const orderDate = delivery.date || new Date().toISOString().slice(0, 10);

    const priceCatCode = (r.price_category || 'Store').trim();
    const priceCatId = PRICE_CAT_MAP[priceCatCode] || 3;
    const priceCatLower = priceCatCode.toLowerCase();

    const paymentType = PAYMENT_MAP[r.status2] || 'invoice';
    const isInternal = (r.status2 === 'Produktion' || priceCatCode === 'Produktion') ? 1 : 0;

    let pax = r.nr_of_servings || null;
    let totalUnits = null;
    if (r.pax_units) {
      const parsed = parseInt(r.pax_units);
      if (!isNaN(parsed)) totalUnits = parsed;
    }

    const bonNumber = `cafe-${r.id}`;

    const { wasInsert } = upsertByV1Id('bons', r.id,
      () => insertStmt.run(
        r.id, bonNumber, statusId, DEFAULT_LOCATION_ID,
        v2CustomerId, v2CompanyId, priceCatId,
        orderDate, delivery.date, pickup.time, delivery.time,
        'delivery', v2DeliveryAddrId,
        pax, totalUnits, paymentType,
        r.kitchen_selects || 0, r.customer_collects || 0,
        r.invoice_info || null, r.kitchen_info || null,
        r.customer_info || null, r.delivery_info || null,
        isInternal, priceCatLower,
        r.kitchen_ingredients_exists || 0, r.kitchen_supplies_exists || 0
      ).lastInsertRowid,
      (id) => updateStmt.run(
        statusId, v2CustomerId, v2CompanyId, priceCatId,
        delivery.date, pickup.time, delivery.time,
        v2DeliveryAddrId,
        pax, totalUnits, paymentType,
        r.kitchen_selects || 0, r.customer_collects || 0,
        r.invoice_info || null, r.kitchen_info || null,
        r.customer_info || null, r.delivery_info || null,
        isInternal, priceCatLower,
        r.kitchen_ingredients_exists || 0, r.kitchen_supplies_exists || 0,
        id
      )
    );

    stats.bons.total++;
    stats.bons.byStatus[r.status] = (stats.bons.byStatus[r.status] || 0) + 1;
    if (wasInsert) { stats.bons.inserted++; } else { stats.bons.updated++; }
  }
}

// ── Sync: Bon Lines (orders → bon_lines) ─────────────────────
function syncBonLines() {
  log('  Synkroniserer ordrelinjer...');

  const v1Rows = v1.prepare(`
    SELECT o.*, i.name as item_name, i.category as item_category,
           i.external_id as grocy_recipe_id
    FROM orders o
    LEFT JOIN items i ON o.item_id = i.id
  `).all();

  const byBon = {};
  for (const r of v1Rows) {
    if (!byBon[r.bon_id]) byBon[r.bon_id] = [];
    byBon[r.bon_id].push(r);
  }

  const deleteSql = db.prepare(`DELETE FROM bon_lines WHERE bon_id = ? AND EXISTS (SELECT 1 FROM bons WHERE id = ? AND sync_source = 'v1')`);
  const insertLine = db.prepare(`
    INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
      cost_price, unit_price, line_total, sort_order, special_request, co2e)
    VALUES (?, ?, ?, ?, ?, 'stk', ?, ?, ?, ?, ?, ?)
  `);

  for (const [v1BonId, lines] of Object.entries(byBon)) {
    if (DRY_RUN) {
      stats.bon_lines.total += lines.length;
      stats.bon_lines.inserted += lines.length;
      continue;
    }

    const v2Bon = db.prepare('SELECT id FROM bons WHERE v1_id = ?').get(parseInt(v1BonId));
    if (!v2Bon) continue;

    const deleteResult = deleteSql.run(v2Bon.id, v2Bon.id);
    stats.bon_lines.deleted += deleteResult.changes;

    for (const l of lines) {
      const quantity = l.quantity || 1;
      const unitPrice = l.price || 0;
      const lineTotal = quantity * unitPrice;

      insertLine.run(
        v2Bon.id,
        l.grocy_recipe_id || null,
        l.item_name || 'Ukendt vare',
        l.item_category || null,
        quantity,
        l.cost_price || null,
        unitPrice,
        lineTotal,
        l.sorting_order || 0,
        l.special_request || null,
        l.co2e || null
      );
      stats.bon_lines.total++;
      stats.bon_lines.inserted++;
    }
  }
}

// ── Udtræk leveringsinfo fra bon_lines ───────────────────────
function extractDeliveryFromLines() {
  log('  Udtrækker leveringsinfo fra x-Levering linjer...');
  if (DRY_RUN) return;

  // Find alle x-Levering linjer på v1-bons
  const deliveryLines = db.prepare(`
    SELECT bl.bon_id, bl.product_name, bl.unit_price, bl.line_total
    FROM bon_lines bl
    JOIN bons b ON b.id = bl.bon_id
    WHERE b.sync_source = 'v1'
      AND bl.category = 'x-Levering'
  `).all();

  const updateBon = db.prepare(`
    UPDATE bons SET courier_provider = ?, delivery_method = ?, delivery_cost = ?
    WHERE id = ?
  `);

  // Grupper per bon (tag første leveringslinje hvis flere)
  const byBon = {};
  for (const dl of deliveryLines) {
    if (!byBon[dl.bon_id]) byBon[dl.bon_id] = dl;
  }

  let count = 0;
  for (const [bonId, dl] of Object.entries(byBon)) {
    const name = (dl.product_name || '').toLowerCase();
    let provider, method;

    if (name.includes('by-ekspressen') || name.includes('byekspressen')) {
      provider = 'byekspressen';
      method = 'bike';
    } else if (name.includes('taxa') || name.includes('el-taxa')) {
      provider = 'taxa';
      method = 'taxi';
    } else if (name.includes('rr leverer')) {
      provider = 'intern';
      method = 'volvo';
    } else {
      provider = 'andet';
      method = 'bike';
    }

    updateBon.run(provider, method, dl.line_total || dl.unit_price || 0, parseInt(bonId));
    count++;
  }

  log(`    ${count} boner opdateret med leveringsinfo`);
}

// ── Beregn total_price på bons ───────────────────────────────
function updateBonTotals() {
  log('  Beregner bon-totaler...');
  if (DRY_RUN) return;

  db.prepare(`
    UPDATE bons SET total_price = (
      SELECT COALESCE(SUM(line_total), 0) FROM bon_lines WHERE bon_id = bons.id
    )
    WHERE sync_source = 'v1'
  `).run();
}

// ── Main ─────────────────────────────────────────────────────
function main() {
  const startTime = Date.now();
  const mode = FULL_MODE ? 'full' : 'delta';

  log(`=== Bon v1 → v2 sync [${new Date().toISOString()}] (${mode}${DRY_RUN ? ', dry-run' : ''}) ===`);
  log(`  v1: ${V1_DB_PATH}`);
  log(`  v2: ${V2_DB_PATH}`);
  log('');

  if (DRY_RUN) {
    syncAddresses();
    syncCompanies();
    syncCustomers();
    syncBons();
    syncBonLines();
  } else {
    transaction(db, () => {
      syncAddresses();
      syncCompanies();
      syncCustomers();
      syncBons();
      syncBonLines();
      extractDeliveryFromLines();
      updateBonTotals();
      setSetting('v1_sync_last_run', new Date().toISOString());
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log('');
  log(`addresses  : ${stats.addresses.total} behandlet  (${stats.addresses.inserted} nye, ${stats.addresses.updated} opdateret)`);
  log(`companies  : ${stats.companies.total} behandlet  (${stats.companies.inserted} nye, ${stats.companies.updated} opdateret)`);
  log(`customers  : ${stats.customers.total} behandlet  (${stats.customers.inserted} nye, ${stats.customers.updated} opdateret)`);
  log(`bons       : ${stats.bons.total} behandlet   (${stats.bons.inserted} nye, ${stats.bons.updated} opdateret)`);
  for (const [status, count] of Object.entries(stats.bons.byStatus).sort((a,b) => b[1] - a[1])) {
    log(`  ${status}: ${count}`);
  }
  log(`bon_lines  : ${stats.bon_lines.total} behandlet  (${stats.bon_lines.inserted} nye, ${stats.bon_lines.deleted} slettet)`);
  log('');

  if (!DRY_RUN) {
    log(`last_run opdateret: ${getSetting('v1_sync_last_run')}`);
  }
  log(`=== Sync færdig (${elapsed} sek) ===`);
}

main();
