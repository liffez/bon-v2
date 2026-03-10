/**
 * Bon v2 — Backend Server
 * Node.js / Express / better-sqlite3
 *
 * Start: node server.js
 * Kræver: npm install express better-sqlite3 dotenv
 */

require('dotenv').config({ quiet: true });

const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 4321;
const DB   = process.env.DB_PATH || path.join(__dirname, 'data', 'bon.db');

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));          // server alle zone-filer statisk

// SSE-klienter (flyver + statusopdateringer)
const sseClients = new Set();

// ─── DATABASE ─────────────────────────────────────────────────────────────────

const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function log(bonId, entityType, action, field, oldVal, newVal, userId, notes) {
  db.prepare(`
    INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entityType, bonId, action, field ?? null, oldVal ?? null, newVal ?? null, userId ?? null, notes ?? null);
}

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

function getBonLines(bonId) {
  return db.prepare(`
    SELECT id, bon_id, grocy_recipe_id, product_name, category, quantity, unit,
           cost_price, unit_price, line_total, sort_order,
           is_accessory, special_request, co2e, pos_product_id, notes
    FROM bon_lines
    WHERE bon_id = ?
    ORDER BY sort_order, id
  `).all(bonId);
}

function getBon(id) {
  const bon = db.prepare(`
    SELECT
      b.*,
      sd.code   AS status_code,
      sd.label  AS status_label,
      sd.color  AS status_color,
      sd.icon   AS status_icon,
      l.name    AS location_name,
      l.code    AS location_code,
      c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
      c.phone   AS contact_phone,
      c.email   AS contact_email,
      co.name   AS company_name
    FROM bons b
    JOIN   status_definitions sd ON b.status_id  = sd.id
    JOIN   locations l           ON b.location_id = l.id
    LEFT JOIN customers c        ON b.customer_id = c.id
    LEFT JOIN companies co       ON b.company_id  = co.id
    WHERE b.id = ?
  `).get(id);
  if (!bon) return null;

  // Leveringsadresse
  if (bon.delivery_address_id) {
    bon.delivery_address = db.prepare(`
      SELECT street_name, street_name2, street_nr, postal_code, city, lat, lon
      FROM addresses WHERE id = ?
    `).get(bon.delivery_address_id);
  }

  bon.lines = getBonLines(id);
  return bon;
}

function getStatusId(code) {
  return db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}

function getDefaultLocationId() {
  return db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id;
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── STATUS DEFINITIONS ──────────────────────────────────────────────────────

// GET /api/statuses
app.get('/api/statuses', (req, res) => {
  const rows = db.prepare(`
    SELECT id, code, label, color, icon, sort_order, is_active, is_terminal, category
    FROM status_definitions WHERE is_active = 1 ORDER BY sort_order
  `).all();
  res.json(rows);
});

// GET /api/statuses/:code/transitions  — hvilke statusser kan man skifte til?
app.get('/api/statuses/:code/transitions', (req, res) => {
  const from = db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(req.params.code);
  if (!from) return res.status(404).json({ error: 'Status ikke fundet' });

  const rows = db.prepare(`
    SELECT sd.id, sd.code, sd.label, sd.color, sd.icon,
           st.requires_confirmation, st.confirmation_message, st.triggers_json
    FROM status_transitions st
    JOIN status_definitions sd ON st.to_status_id = sd.id
    WHERE st.from_status_id = ? AND st.is_active = 1
    ORDER BY sd.sort_order
  `).all(from.id);
  res.json(rows);
});

// ─── BONNER ──────────────────────────────────────────────────────────────────

// GET /api/bons/today  — køkken i dag
app.get('/api/bons/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const bons = db.prepare(`
    SELECT
      b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
      b.pax, b.total_units, b.kitchen_info, b.delivery_type, b.delivery_method,
      b.prep_ingredients_ready, b.prep_supplies_ready,
      b.kitchen_selects, b.customer_collects,
      sd.code  AS status_code,
      sd.label AS status_label,
      sd.color AS status_color,
      sd.icon  AS status_icon,
      c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
      c.phone  AS contact_phone,
      co.name  AS company_name,
      a.street_name || ' ' || COALESCE(a.street_nr,'') AS delivery_street,
      a.city   AS delivery_city,
      a.postal_code AS delivery_postal
    FROM bons b
    JOIN   status_definitions sd ON b.status_id  = sd.id
    LEFT JOIN customers c        ON b.customer_id = c.id
    LEFT JOIN companies co       ON b.company_id  = co.id
    LEFT JOIN addresses a        ON b.delivery_address_id = a.id
    WHERE b.delivery_date = ?
      AND sd.code NOT IN ('AFLYST', 'FAKTURERET', 'BETALT', 'AFSLUTTET')
    ORDER BY b.pickup_time, b.id
  `).all(today);

  for (const bon of bons) {
    bon.lines = getBonLines(bon.id);
    // Aktive flyver-notifikationer
    bon.notifications = db.prepare(`
      SELECT id, type, message, priority, created_at
      FROM notifications WHERE bon_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(bon.id);
  }

  res.json(bons);
});

// GET /api/bons  — liste med filter
app.get('/api/bons', (req, res) => {
  const { status, date, from, to, q, location } = req.query;
  const where = ['1=1'];
  const args  = [];

  if (status)   { where.push('sd.code = ?');          args.push(status); }
  if (date)     { where.push('b.delivery_date = ?');   args.push(date); }
  if (from)     { where.push('b.delivery_date >= ?');  args.push(from); }
  if (to)       { where.push('b.delivery_date <= ?');  args.push(to); }
  if (location) { where.push('l.code = ?');            args.push(location); }
  if (q) {
    where.push('(b.bon_number LIKE ? OR co.name LIKE ? OR c.first_name LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = db.prepare(`
    SELECT
      b.id, b.bon_number, b.delivery_date, b.pickup_time,
      b.pax, b.total_units, b.delivery_type,
      sd.code AS status_code, sd.label AS status_label, sd.color AS status_color,
      co.name AS company_name,
      c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
      l.name AS location_name
    FROM bons b
    JOIN   status_definitions sd ON b.status_id  = sd.id
    JOIN   locations l           ON b.location_id = l.id
    LEFT JOIN customers c        ON b.customer_id = c.id
    LEFT JOIN companies co       ON b.company_id  = co.id
    WHERE ${where.join(' AND ')}
    ORDER BY b.delivery_date DESC, b.pickup_time
    LIMIT 200
  `).all(...args);

  res.json(rows);
});

// GET /api/bons/:id
app.get('/api/bons/:id', (req, res) => {
  const bon = getBon(parseInt(req.params.id));
  if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });
  res.json(bon);
});

// POST /api/bons  — opret ny bon
app.post('/api/bons', (req, res) => {
  const b = req.body;
  if (!b.delivery_date) return res.status(400).json({ error: 'delivery_date er påkrævet' });

  // Auto-bonnummer
  const settings = db.prepare(`SELECT value FROM settings WHERE key = 'bon_number_prefix'`).get();
  const prefix   = settings?.value ?? '';
  const last     = db.prepare(`SELECT MAX(CAST(REPLACE(bon_number, ?, '') AS INTEGER)) as mx FROM bons WHERE bon_number LIKE ?`).get(prefix, `${prefix}%`);
  const next     = (last?.mx ?? 3259) + 1;
  const bonNumber = `${prefix}${next}`;

  const statusId   = b.status_id   ?? getStatusId('NY');
  const locationId = b.location_id ?? getDefaultLocationId();

  const result = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id, customer_id, company_id, price_category_id,
      order_date, delivery_date, pickup_time, delivery_time,
      delivery_type, delivery_method, delivery_address_id,
      delivery_notes, delivery_cost, delivery_price,
      courier_arrival_time, courier_provider,
      pax, total_units, boxes, total_price, total_with_delivery,
      payment_type, kitchen_selects, customer_collects,
      kitchen_info, customer_wishes, internal_notes, invoice_info,
      prep_ingredients_ready, prep_supplies_ready,
      created_by_user_id
    ) VALUES (
      ?,?,?,?,?,?,
      ?,?,?,?,
      ?,?,?,
      ?,?,?,
      ?,?,
      ?,?,?,?,?,
      ?,?,?,
      ?,?,?,?,
      ?,?,
      ?
    )
  `).run(
    bonNumber, statusId, locationId,
    b.customer_id ?? null, b.company_id ?? null, b.price_category_id ?? null,
    b.order_date ?? new Date().toISOString().slice(0,10),
    b.delivery_date, b.pickup_time ?? null, b.delivery_time ?? null,
    b.delivery_type ?? 'delivery', b.delivery_method ?? null, b.delivery_address_id ?? null,
    b.delivery_notes ?? null, b.delivery_cost ?? null, b.delivery_price ?? null,
    b.courier_arrival_time ?? null, b.courier_provider ?? null,
    b.pax ?? 0, b.total_units ?? 0, b.boxes ?? null,
    b.total_price ?? null, b.total_with_delivery ?? null,
    b.payment_type ?? null, b.kitchen_selects ? 1 : 0, b.customer_collects ? 1 : 0,
    b.kitchen_info ?? null, b.customer_wishes ?? null,
    b.internal_notes ?? null, b.invoice_info ?? null,
    0, 0,
    b.created_by_user_id ?? null
  );

  log(result.lastInsertRowid, 'bon', 'create', null, null, bonNumber, b.created_by_user_id, null);
  res.status(201).json(getBon(result.lastInsertRowid));
});

// PATCH /api/bons/:id/status  — skift status
app.patch('/api/bons/:id/status', (req, res) => {
  const id        = parseInt(req.params.id);
  const { status_code, user_id } = req.body;
  if (!status_code) return res.status(400).json({ error: 'status_code er påkrævet' });

  const bon = db.prepare(`SELECT b.id, sd.code as current_code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`).get(id);
  if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

  const newStatus = db.prepare(`SELECT id, code FROM status_definitions WHERE code = ?`).get(status_code);
  if (!newStatus) return res.status(400).json({ error: `Ukendt status: ${status_code}` });

  // Tjek at transition er tilladt
  const transition = db.prepare(`
    SELECT st.* FROM status_transitions st
    JOIN status_definitions from_sd ON st.from_status_id = from_sd.id
    JOIN status_definitions to_sd   ON st.to_status_id   = to_sd.id
    WHERE from_sd.code = ? AND to_sd.code = ? AND st.is_active = 1
  `).get(bon.current_code, status_code);

  if (!transition) {
    return res.status(400).json({ error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt` });
  }

  db.prepare(`UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus.id, id);
  log(id, 'bon', 'status_change', 'status_id', bon.current_code, status_code, user_id ?? null, null);

  broadcastSSE({ type: 'bon_status', bon_id: id, old: bon.current_code, new: status_code });

  res.json({
    id,
    status_code,
    requires_confirmation: transition.requires_confirmation === 1,
    confirmation_message:  transition.confirmation_message,
    triggers:              transition.triggers_json ? JSON.parse(transition.triggers_json) : []
  });
});

// PATCH /api/bons/:id/prep  — opdater prep-checks
app.patch('/api/bons/:id/prep', (req, res) => {
  const id = parseInt(req.params.id);
  const { ingredients_ready, supplies_ready } = req.body;

  const fields = [];
  const vals   = [];
  if (ingredients_ready !== undefined) { fields.push('prep_ingredients_ready = ?'); vals.push(ingredients_ready ? 1 : 0); }
  if (supplies_ready    !== undefined) { fields.push('prep_supplies_ready = ?');    vals.push(supplies_ready    ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Ingen felter at opdatere' });

  db.prepare(`UPDATE bons SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, id);
  const bon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(id);
  res.json({ id, prep_ingredients_ready: !!bon.prep_ingredients_ready, prep_supplies_ready: !!bon.prep_supplies_ready });
});

// PATCH /api/bons/:id/kitchen-info
app.patch('/api/bons/:id/kitchen-info', (req, res) => {
  const id   = parseInt(req.params.id);
  const text = req.body.text ?? null;
  const old  = db.prepare(`SELECT kitchen_info FROM bons WHERE id = ?`).get(id);
  if (!old) return res.status(404).json({ error: 'Bon ikke fundet' });
  db.prepare(`UPDATE bons SET kitchen_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(text, id);
  log(id, 'bon', 'update', 'kitchen_info', old.kitchen_info, text, req.body.user_id ?? null, null);
  res.json({ id, kitchen_info: text });
});

// ─── BON LINES ───────────────────────────────────────────────────────────────

// POST /api/bons/:id/lines
app.post('/api/bons/:id/lines', (req, res) => {
  const bonId = parseInt(req.params.id);
  const l     = req.body;
  if (!l.product_name) return res.status(400).json({ error: 'product_name er påkrævet' });

  const maxSort = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) as mx FROM bon_lines WHERE bon_id = ?`).get(bonId).mx;

  const result = db.prepare(`
    INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
      cost_price, unit_price, line_total, sort_order, is_accessory, special_request, co2e, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    bonId, l.grocy_recipe_id ?? null, l.product_name,
    l.category ?? null, l.quantity ?? 1, l.unit ?? 'stk',
    l.cost_price ?? null, l.unit_price ?? null,
    l.line_total ?? null, maxSort + 1,
    l.is_accessory ? 1 : 0, l.special_request ?? null,
    l.co2e ?? null, l.notes ?? null
  );

  // Genberegn total_units
  const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
  db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);

  log(bonId, 'bon', 'update', 'bon_lines', null, `tilføjet: ${l.quantity}x ${l.product_name}`, l.user_id ?? null, null);
  res.status(201).json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(result.lastInsertRowid));
});

// PUT /api/bons/:id/lines/:lid
app.put('/api/bons/:id/lines/:lid', (req, res) => {
  const bonId  = parseInt(req.params.id);
  const lineId = parseInt(req.params.lid);
  const l = req.body;

  const allowed = ['product_name','category','quantity','unit','cost_price','unit_price','line_total','sort_order','is_accessory','special_request','co2e','notes'];
  const updates = Object.entries(l).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'Ingen gyldige felter' });

  const sets = updates.map(([k]) => `${k} = ?`).join(', ');
  const vals = updates.map(([, v]) => v);
  db.prepare(`UPDATE bon_lines SET ${sets} WHERE id = ? AND bon_id = ?`).run(...vals, lineId, bonId);

  const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
  db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);

  res.json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
});

// DELETE /api/bons/:id/lines/:lid
app.delete('/api/bons/:id/lines/:lid', (req, res) => {
  const bonId  = parseInt(req.params.id);
  const lineId = parseInt(req.params.lid);
  const line = db.prepare(`SELECT product_name, quantity FROM bon_lines WHERE id = ? AND bon_id = ?`).get(lineId, bonId);
  if (!line) return res.status(404).json({ error: 'Linje ikke fundet' });
  db.prepare(`DELETE FROM bon_lines WHERE id = ?`).run(lineId);
  const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
  db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);
  log(bonId, 'bon', 'update', 'bon_lines', `${line.quantity}x ${line.product_name}`, null, null, 'linje slettet');
  res.json({ deleted: lineId });
});

// ─── CHANGELOG ───────────────────────────────────────────────────────────────

app.get('/api/bons/:id/changelog', (req, res) => {
  const id = parseInt(req.params.id);
  const rows = db.prepare(`
    SELECT c.*, u.name as user_name
    FROM changelog c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.entity_type = 'bon' AND c.entity_id = ?
    ORDER BY c.created_at DESC
  `).all(id);
  res.json(rows);
});

// ─── FLYVER / NOTIFIKATIONER ─────────────────────────────────────────────────

app.post('/api/bons/:id/notifications', (req, res) => {
  const bonId = parseInt(req.params.id);
  const { type, message, priority, sent_by_user_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message er påkrævet' });

  const result = db.prepare(`
    INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
    VALUES (?,?,?,?,?)
  `).run(bonId, type ?? 'flyver', message, priority ?? 'normal', sent_by_user_id ?? null);

  const notif = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(result.lastInsertRowid);
  broadcastSSE({ type: 'notification', bon_id: bonId, notification: notif });
  res.status(201).json(notif);
});

app.get('/api/bons/:id/notifications', (req, res) => {
  res.json(db.prepare(`SELECT * FROM notifications WHERE bon_id = ? ORDER BY created_at DESC`).all(parseInt(req.params.id)));
});

// ─── KUNDER ──────────────────────────────────────────────────────────────────

app.get('/api/customers', (req, res) => {
  const { q } = req.query;
  const where = q ? `WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR co.name LIKE ? OR c.email LIKE ?` : '';
  const args  = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : [];
  res.json(db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.is_active,
           co.name AS company_name, co.id AS company_id
    FROM customers c
    LEFT JOIN companies co ON c.company_id = co.id
    ${where}
    ORDER BY c.first_name LIMIT 100
  `).all(...args));
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare(`
    SELECT c.*, co.name AS company_name, co.cvr, co.ean, co.invoice_method
    FROM customers c LEFT JOIN companies co ON c.company_id = co.id
    WHERE c.id = ?
  `).get(parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Kunde ikke fundet' });

  c.recent_bons = db.prepare(`
    SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code, b.total_units
    FROM bons b JOIN status_definitions sd ON b.status_id = sd.id
    WHERE b.customer_id = ? ORDER BY b.delivery_date DESC LIMIT 10
  `).all(c.id);

  res.json(c);
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(db.prepare(`SELECT key, value, description FROM settings`).all());
});

app.patch('/api/settings/:key', (req, res) => {
  const { value } = req.body;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`).run(req.params.key, value, value);
  res.json({ key: req.params.key, value });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              Bon v2 Server                               ║
╠══════════════════════════════════════════════════════════╣
║  http://localhost:${PORT}                                    ║
║  http://localhost:${PORT}/kitchen/today.html                 ║
║  Database: ${DB.padEnd(44)} ║
╠══════════════════════════════════════════════════════════╣
║  GET  /api/bons/today                                    ║
║  GET  /api/bons?date=&status=&q=                         ║
║  GET  /api/bons/:id                                      ║
║  POST /api/bons                                          ║
║  PATCH /api/bons/:id/status  { status_code }             ║
║  PATCH /api/bons/:id/prep                                ║
║  GET  /api/statuses                                      ║
║  GET  /api/sse                                           ║
╚══════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, db };
