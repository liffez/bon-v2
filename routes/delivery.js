// routes/delivery.js
// ==========================================
// Spor 1 endpoints: manuel bestilling.
//
// Vehicles management (admin) + booking-payload + book + actual-cost.
// ==========================================

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const {
    buildBookingPayload,
    getActiveVehicles,
    getVehicleById,
    TEMPLATE_VARIABLES
} = require('../services/booking_template');
const {
    logBookingEvent,
    setActualCost,
    getBookingEvents
} = require('../services/delivery_log');

// ==========================================
// GET /api/delivery/vehicles
// Liste over aktive vehicles. Bruges af modal + bon-drawer.
// ==========================================
router.get('/vehicles', requireAuth(), handle((req, res) => {
    const includeInactive = req.query.include_inactive === '1';
    const db = getDb();

    const sql = `
        SELECT
            id, code, label, type, is_internal,
            max_capacity_boxes, max_distance_km,
            cost_formula_json, booking_method, booking_url, booking_template,
            booking_fields_json,
            booking_api_config_json, supplier_id, is_active, sort_order,
            created_at, updated_at
        FROM delivery_vehicles
        ${includeInactive ? '' : 'WHERE is_active = 1'}
        ORDER BY sort_order, label
    `;
    const rows = db.prepare(sql).all();

    // Parse JSON-felter til frontend-bekvemmelighed
    for (const row of rows) {
        if (row.cost_formula_json) {
            try { row.cost_formula = JSON.parse(row.cost_formula_json); } catch (e) { row.cost_formula = null; }
        }
        if (row.booking_api_config_json) {
            try { row.booking_api_config = JSON.parse(row.booking_api_config_json); } catch (e) { row.booking_api_config = null; }
        }
    }

    res.json(rows);
}));

// ==========================================
// GET /api/delivery/vehicles/:id
// ==========================================
router.get('/vehicles/:id', requireAuth(), handle((req, res) => {
    const v = getVehicleById(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vehicle ikke fundet' });
    if (v.cost_formula_json) {
        try { v.cost_formula = JSON.parse(v.cost_formula_json); } catch (e) { v.cost_formula = null; }
    }
    if (v.booking_api_config_json) {
        try { v.booking_api_config = JSON.parse(v.booking_api_config_json); } catch (e) { v.booking_api_config = null; }
    }
    res.json(v);
}));

// ==========================================
// POST /api/delivery/vehicles  (admin)
// ==========================================
router.post('/vehicles', requireAuth('admin'), handle((req, res) => {
    const {
        code, label, type, is_internal = 0,
        max_capacity_boxes = null, max_distance_km = null,
        cost_formula = null, cost_formula_json = null,
        booking_method = 'calendar', booking_url = null, booking_template = null,
        supplier_id = null, sort_order = 0
    } = req.body;

    if (!code || !label || !type) {
        return res.status(400).json({ error: 'code, label og type er påkrævet' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM delivery_vehicles WHERE code = ?').get(code);
    if (existing) return res.status(409).json({ error: 'Kode findes allerede' });

    const formulaStr = cost_formula
        ? JSON.stringify(cost_formula)
        : (cost_formula_json || null);

    const result = db.prepare(`
        INSERT INTO delivery_vehicles
            (code, label, type, is_internal,
             max_capacity_boxes, max_distance_km, cost_formula_json,
             booking_method, booking_url, booking_template,
             supplier_id, sort_order, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        code, label, type, is_internal ? 1 : 0,
        max_capacity_boxes, max_distance_km, formulaStr,
        booking_method, booking_url, booking_template,
        supplier_id, sort_order
    );

    res.status(201).json({ id: Number(result.lastInsertRowid), code, label });
}));

// ==========================================
// PATCH /api/delivery/vehicles/:id  (admin)
// Opdater label, template, URL, cost-formel etc.
// ==========================================
router.patch('/vehicles/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = getVehicleById(id);
    if (!existing) return res.status(404).json({ error: 'Vehicle ikke fundet' });

    const allowed = [
        'label', 'type', 'is_internal',
        'max_capacity_boxes', 'max_distance_km',
        'booking_method', 'booking_url', 'booking_template',
        'booking_fields_json',
        'supplier_id', 'sort_order', 'is_active'
    ];

    const fields = [];
    const params = [];
    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            let val = req.body[key];
            if (key === 'is_internal' || key === 'is_active') val = val ? 1 : 0;
            fields.push(`${key} = ?`);
            params.push(val);
        }
    }

    // Cost-formel håndteres separat (kan komme som object eller string)
    if (req.body.cost_formula !== undefined) {
        fields.push('cost_formula_json = ?');
        params.push(req.body.cost_formula == null ? null : JSON.stringify(req.body.cost_formula));
    } else if (req.body.cost_formula_json !== undefined) {
        fields.push('cost_formula_json = ?');
        params.push(req.body.cost_formula_json);
    }

    if (fields.length === 0) {
        return res.status(400).json({ error: 'Ingen felter at opdatere' });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`UPDATE delivery_vehicles SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    const updated = getVehicleById(id);
    if (updated.cost_formula_json) {
        try { updated.cost_formula = JSON.parse(updated.cost_formula_json); } catch (e) {}
    }
    res.json(updated);
}));

// ==========================================
// DELETE /api/delivery/vehicles/:id  (admin)
// Soft-delete: is_active = 0
// ==========================================
router.delete('/vehicles/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = getVehicleById(id);
    if (!existing) return res.status(404).json({ error: 'Vehicle ikke fundet' });

    db.prepare('UPDATE delivery_vehicles SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ id, is_active: 0 });
}));

// ==========================================
// GET /api/delivery/template-variables
// Returnerer variabel-katalog til Settings UI's chips.
// ==========================================
router.get('/template-variables', requireAuth(), (req, res) => {
    res.json(TEMPLATE_VARIABLES);
});

// ==========================================
// GET /api/delivery/booking-payload?bon_id=&vehicle_id=
// Genererer clipboard-tekst + URL til modal.
// ==========================================
router.get('/booking-payload', requireAuth(), handle((req, res) => {
    const bonId = Number(req.query.bon_id);
    const vehicleId = Number(req.query.vehicle_id);
    if (!bonId || !vehicleId) {
        return res.status(400).json({ error: 'bon_id og vehicle_id er påkrævet' });
    }

    try {
        const payload = buildBookingPayload(bonId, vehicleId);
        res.json(payload);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        throw err;
    }
}));

// ==========================================
// POST /api/delivery/book
// Body: { bon_id, vehicle_id, reference?, status, note? }
// status: 'booked' | 'in_progress' | 'failed'
// ==========================================
router.post('/book', requireAuth(), handle((req, res) => {
    const { bon_id, vehicle_id, reference = null, status = 'booked', note = null } = req.body;
    if (!bon_id || !vehicle_id) {
        return res.status(400).json({ error: 'bon_id og vehicle_id er påkrævet' });
    }

    try {
        const event = logBookingEvent({
            bonId: Number(bon_id),
            vehicleId: Number(vehicle_id),
            reference,
            status,
            userId: req.session?.userId || null,
            note
        });
        res.status(201).json(event);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
}));

// ==========================================
// POST /api/delivery/actual-cost
// Body: { bon_id, amount_dkk, source?, note? }
// ==========================================
router.post('/actual-cost', requireAuth(), handle((req, res) => {
    const { bon_id, amount_dkk, source = 'manual', note = null } = req.body;
    if (!bon_id || amount_dkk == null) {
        return res.status(400).json({ error: 'bon_id og amount_dkk er påkrævet' });
    }

    try {
        const result = setActualCost({
            bonId: Number(bon_id),
            amount: amount_dkk,
            source,
            userId: req.session?.userId || null,
            note
        });
        res.json(result);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
}));

// ==========================================
// GET /api/delivery/events?bon_id=
// Booking-historik for en bon.
// ==========================================
router.get('/events', requireAuth(), handle((req, res) => {
    const bonId = Number(req.query.bon_id);
    if (!bonId) return res.status(400).json({ error: 'bon_id er påkrævet' });
    res.json(getBookingEvents(bonId));
}));

module.exports = router;
