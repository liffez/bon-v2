const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getStatusId, getDefaultLocationId, nextBonNumber } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

// ─── GET /api/bons — liste med filter ────────────────────────────────────────

router.get('/', handle((req, res) => {
    const db = getDb();
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
}));

// ─── GET /api/bons/:id ──────────────────────────────────────────────────────

router.get('/:id', handle((req, res) => {
    const bon = getBon(parseInt(req.params.id));
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });
    res.json(bon);
}));

// ─── POST /api/bons — opret ny bon ─────────────────────────────────────────

router.post('/', handle((req, res) => {
    const db = getDb();
    const b  = req.body;
    if (!b.delivery_date) return res.status(400).json({ error: 'delivery_date er påkrævet' });

    const bonNumber  = nextBonNumber();
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
        b.order_date ?? new Date().toISOString().slice(0, 10),
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

    logChange({ entityType: 'bon', entityId: result.lastInsertRowid, action: 'create', newValue: bonNumber, userId: b.created_by_user_id });
    res.status(201).json(getBon(result.lastInsertRowid));
}));

// ─── PATCH /api/bons/:id/status — skift status ─────────────────────────────

router.patch('/:id/status', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
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
    logChange({ entityType: 'bon', entityId: id, action: 'status_change', fieldName: 'status_id', oldValue: bon.current_code, newValue: status_code, userId: user_id ?? null });

    broadcast('bon_status', { bon_id: id, old: bon.current_code, new: status_code });

    // Triggers stub — kobles til Grocy/mail senere
    const triggers = transition.triggers_json
        ? JSON.parse(transition.triggers_json)
        : [];

    for (const trigger of triggers) {
        if (trigger.action === 'grocy_consume') {
            console.log(`[trigger] grocy_consume for bon ${id} — ikke implementeret endnu`);
        }
        if (trigger.action === 'send_mail') {
            console.log(`[trigger] send_mail for bon ${id} — ikke implementeret endnu`);
        }
    }

    res.json({
        id,
        status_code,
        requires_confirmation: transition.requires_confirmation === 1,
        confirmation_message:  transition.confirmation_message,
        triggers
    });
}));

// ─── PATCH /api/bons/:id/prep — opdater prep-checks ────────────────────────

router.patch('/:id/prep', handle((req, res) => {
    const db = getDb();
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
}));

// ─── PATCH /api/bons/:id/kitchen-info ───────────────────────────────────────

router.patch('/:id/kitchen-info', handle((req, res) => {
    const db   = getDb();
    const id   = parseInt(req.params.id);
    const text = req.body.text ?? null;
    const old  = db.prepare(`SELECT kitchen_info FROM bons WHERE id = ?`).get(id);
    if (!old) return res.status(404).json({ error: 'Bon ikke fundet' });
    db.prepare(`UPDATE bons SET kitchen_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(text, id);
    logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'kitchen_info', oldValue: old.kitchen_info, newValue: text, userId: req.body.user_id ?? null });
    res.json({ id, kitchen_info: text });
}));

// ─── BON LINES ──────────────────────────────────────────────────────────────

// POST /api/bons/:id/lines
router.post('/:id/lines', handle((req, res) => {
    const db    = getDb();
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

    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', newValue: `tilføjet: ${l.quantity ?? 1}x ${l.product_name}`, userId: l.user_id ?? null });
    res.status(201).json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(result.lastInsertRowid));
}));

// PUT /api/bons/:id/lines/:lid
router.put('/:id/lines/:lid', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const lineId = parseInt(req.params.lid);
    const l = req.body;

    const allowed = ['product_name', 'category', 'quantity', 'unit', 'cost_price', 'unit_price', 'line_total', 'sort_order', 'is_accessory', 'special_request', 'co2e', 'notes'];
    const updates = Object.entries(l).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'Ingen gyldige felter' });

    const sets = updates.map(([k]) => `${k} = ?`).join(', ');
    const vals = updates.map(([, v]) => v);
    db.prepare(`UPDATE bon_lines SET ${sets} WHERE id = ? AND bon_id = ?`).run(...vals, lineId, bonId);

    const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);

    res.json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
}));

// DELETE /api/bons/:id/lines/:lid
router.delete('/:id/lines/:lid', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const lineId = parseInt(req.params.lid);
    const line = db.prepare(`SELECT product_name, quantity FROM bon_lines WHERE id = ? AND bon_id = ?`).get(lineId, bonId);
    if (!line) return res.status(404).json({ error: 'Linje ikke fundet' });
    db.prepare(`DELETE FROM bon_lines WHERE id = ?`).run(lineId);
    const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet' });
    res.json({ deleted: lineId });
}));

// ─── CHANGELOG ──────────────────────────────────────────────────────────────

router.get('/:id/changelog', handle((req, res) => {
    const id = parseInt(req.params.id);
    const rows = getDb().prepare(`
        SELECT c.*, u.name as user_name
        FROM changelog c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.entity_type = 'bon' AND c.entity_id = ?
        ORDER BY c.created_at DESC
    `).all(id);
    res.json(rows);
}));

// ─── NOTIFIKATIONER ─────────────────────────────────────────────────────────

router.post('/:id/notifications', handle((req, res) => {
    const db    = getDb();
    const bonId = parseInt(req.params.id);
    const { type, message, priority, sent_by_user_id } = req.body;
    if (!message) return res.status(400).json({ error: 'message er påkrævet' });

    const result = db.prepare(`
        INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
        VALUES (?,?,?,?,?)
    `).run(bonId, type ?? 'flyver', message, priority ?? 'normal', sent_by_user_id ?? null);

    const notif = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(result.lastInsertRowid);
    broadcast('notification', { bon_id: bonId, notification: notif });
    res.status(201).json(notif);
}));

router.get('/:id/notifications', handle((req, res) => {
    res.json(getDb().prepare(`SELECT * FROM notifications WHERE bon_id = ? ORDER BY created_at DESC`).all(parseInt(req.params.id)));
}));

module.exports = router;
