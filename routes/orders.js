/**
 * routes/orders.js
 * ════════════════════════════════════════════════════════════
 * Purchase orders — CRUD for bestillinger.
 * Bruger purchase_orders + purchase_order_lines tabeller (migration 005).
 *
 * Monteres i server.js som:
 *   app.use('/api/orders', require('./routes/orders'));
 *
 * Endpoints:
 *   GET    /api/orders/pending          Ventende ordrer
 *   GET    /api/orders/pending/:id      Én ordre med linjer
 *   POST   /api/orders/pending          Opret ny ordre
 *   PUT    /api/orders/pending/:id      Opdatér ordre
 *   DELETE /api/orders/pending/:id      Marker som modtaget
 *   GET    /api/orders/archive          Modtagne/afsluttede ordrer
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

/* ── Helpers ─────────────────────────────────────────────── */

function getOrderWithLines(db, orderId) {
    const order = db.prepare(`
        SELECT po.*, s.name as supplier_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = ?
    `).get(orderId);
    if (!order) return null;

    order.lines = db.prepare(`
        SELECT pol.*, sp.product_name as supplier_product_name, sp.supplier_sku
        FROM purchase_order_lines pol
        LEFT JOIN supplier_products sp ON pol.supplier_product_id = sp.id
        WHERE pol.purchase_order_id = ?
    `).all(orderId);

    return order;
}

/* ── GET /pending ────────────────────────────────────────── */

router.get('/pending', handle((req, res) => {
    const db = getDb();
    const orders = db.prepare(`
        SELECT po.*, s.name as supplier_name,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = po.id) as line_count
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status IN ('draft', 'sent', 'confirmed', 'partially_received')
        ORDER BY po.expected_delivery_date ASC, po.created_at DESC
    `).all();

    res.json(orders);
}));

/* ── GET /pending/:id ────────────────────────────────────── */

router.get('/pending/:id', handle((req, res) => {
    const db = getDb();
    const order = getOrderWithLines(db, parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });
    res.json(order);
}));

/* ── POST /pending ───────────────────────────────────────── */

router.post('/pending', handle((req, res) => {
    const db = getDb();
    const {
        supplier_id, supplier_name, location_id,
        order_reference, expected_delivery_date,
        notes, items, sent_via,
    } = req.body;

    // Find eller opret leverandør
    let supId = supplier_id;
    if (!supId && supplier_name) {
        let sup = db.prepare(`SELECT id FROM suppliers WHERE name = ?`).get(supplier_name);
        if (!sup) {
            const result = db.prepare(`INSERT INTO suppliers (name, integration_type) VALUES (?, 'manual')`).run(supplier_name);
            supId = result.lastInsertRowid;
        } else {
            supId = sup.id;
        }
    }

    const locId = location_id || null;
    const userId = req.session?.user?.id || null;

    const result = db.prepare(`
        INSERT INTO purchase_orders (
            location_id, supplier_id, order_reference, status,
            expected_delivery_date, notes, sent_via,
            created_by_user_id, sent_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
        locId, supId, order_reference || null,
        expected_delivery_date || null,
        notes || null, sent_via || 'manual', userId
    );

    const orderId = result.lastInsertRowid;

    // Indsæt linjer
    if (Array.isArray(items) && items.length > 0) {
        const insertLine = db.prepare(`
            INSERT INTO purchase_order_lines (
                purchase_order_id, supplier_product_id, item_id,
                quantity_ordered, unit_quantity, price_per_pack, line_total,
                shopping_list_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of items) {
            insertLine.run(
                orderId,
                item.supplier_product_id || null,
                item.item_id || item.product_id || null,
                item.quantity_ordered || item.quantity || 0,
                item.unit_quantity || null,
                item.price_per_pack || null,
                item.line_total || null,
                item.shopping_list_id || null
            );
        }
    }

    logChange({ entityType: 'purchase_order', entityId: orderId, action: 'create', userId });
    broadcast('order_created', { id: orderId });

    const order = getOrderWithLines(db, orderId);
    res.status(201).json(order);
}));

/* ── PUT /pending/:id ────────────────────────────────────── */

router.put('/pending/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });

    const { status, notes, expected_delivery_date, order_reference } = req.body;
    const fields = [];
    const vals = [];

    if (status !== undefined)                { fields.push('status = ?'); vals.push(status); }
    if (notes !== undefined)                 { fields.push('notes = ?'); vals.push(notes); }
    if (expected_delivery_date !== undefined) { fields.push('expected_delivery_date = ?'); vals.push(expected_delivery_date); }
    if (order_reference !== undefined)        { fields.push('order_reference = ?'); vals.push(order_reference); }

    if (fields.length > 0) {
        fields.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(id);
        db.prepare(`UPDATE purchase_orders SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }

    logChange({ entityType: 'purchase_order', entityId: id, action: 'update', fieldName: 'status', oldValue: order.status, newValue: status || order.status });

    const updated = getOrderWithLines(db, id);
    res.json(updated);
}));

/* ── DELETE /pending/:id ─────────────────────────────────── */

router.delete('/pending/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Ordre ikke fundet' });

    // Marker som modtaget (slet ikke fra DB — behold til historik)
    db.prepare(`UPDATE purchase_orders SET status = 'received', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    logChange({ entityType: 'purchase_order', entityId: id, action: 'update', fieldName: 'status', oldValue: order.status, newValue: 'received' });

    res.json({ ok: true, id, previous_status: order.status });
}));

/* ── GET /archive ────────────────────────────────────────── */

router.get('/archive', handle((req, res) => {
    const db = getDb();
    const days = parseInt(req.query.days) || 30;
    const supplier = req.query.supplier || null;

    let sql = `
        SELECT po.*, s.name as supplier_name,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = po.id) as line_count
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status IN ('received', 'cancelled')
          AND po.updated_at >= datetime('now', '-' || ? || ' days')
    `;
    const params = [days];

    if (supplier) {
        sql += ` AND s.name LIKE ?`;
        params.push('%' + supplier + '%');
    }

    sql += ` ORDER BY po.updated_at DESC`;

    const orders = db.prepare(sql).all(...params);
    res.json(orders);
}));

module.exports = router;
