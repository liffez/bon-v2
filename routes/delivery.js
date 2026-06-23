// routes/delivery.js
// ==========================================
// Spor 1 endpoints: manuel bestilling.
//
// Vehicles management (admin) + booking-payload + book + actual-cost.
// ==========================================

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getStatusId, autoConsumeBonInventory, todayISO } = require('../db/helpers');
const { transaction } = require('../db/compat');
const { broadcast } = require('../shared/sse');
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
    cancelBooking,
    getBookingEvents,
    deliveryMethodFromVehicleType
} = require('../services/delivery_log');
const { calculateForBon, getHqCoords } = require('../services/delivery_calc');
const { healthCheck } = require('../services/routing');
const { geocodeAddress } = require('../services/geocode');
const { computeRoute, applyRouteProposal, PICKUP_LOCKED_STATUSES } = require('../services/route_planner');
const { getByExpressenAdapter, ByExpressenError } = require('../services/byExpressenAdapter');
const { quoteForBon, bookForBon, previewBooking, normalizeLoboOrder } = require('../services/lobo_booking');

// Felter office må overstyre i se-og-ret-panelet (whitelist mod payload-injection).
function pickLoboOverrides(src = {}) {
    const out = {};
    for (const k of ['pickup_time', 'boxes', 'fkproduct', 'contact', 'note', 'reference']) {
        if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
    }
    return out;
}

// Seneste By-expressen-ordre-uuid for en bon (fra delivery_events 'booked'-event).
function loboOrderUuidForBon(bonId) {
    const row = getDb().prepare(
        `SELECT external_reference FROM delivery_events
         WHERE bon_id = ? AND provider = 'byekspressen'
           AND external_reference IS NOT NULL AND event_type = 'booked'
         ORDER BY id DESC LIMIT 1`
    ).get(bonId);
    return row ? row.external_reference : null;
}

// ==========================================
// GET /api/delivery/vehicles
// Liste over aktive vehicles. Bruges af modal + bon-drawer.
// ==========================================
router.get('/vehicles', requireAuth(), handle((req, res) => {
    const includeInactive = req.query.include_inactive === '1';
    const db = getDb();

    const sql = `
        SELECT
            id, code, label, type, is_internal, color,
            max_capacity_boxes, max_distance_km, pickup_lead_min,
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
        'label', 'type', 'is_internal', 'color',
        'max_capacity_boxes', 'max_distance_km', 'pickup_lead_min',
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
router.post('/book', requireAuth(), handle(async (req, res) => {
    const { bon_id, vehicle_id, reference = null, status = 'booked', note = null } = req.body;
    if (!bon_id || !vehicle_id) {
        return res.status(400).json({ error: 'bon_id og vehicle_id er påkrævet' });
    }

    try {
        const event = await logBookingEvent({
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
// POST /api/delivery/cancel
// Body: { bon_id, note? }
// Annullerer den aktive booking — rydder vehicle-tildelingen
// så bonen er tilbage til "ikke planlagt".
// ==========================================
router.post('/cancel', requireAuth(), handle((req, res) => {
    const { bon_id, note = null } = req.body;
    if (!bon_id) {
        return res.status(400).json({ error: 'bon_id er påkrævet' });
    }

    try {
        const result = cancelBooking({
            bonId: Number(bon_id),
            userId: req.session?.userId || null,
            note
        });
        res.json(result);
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

// ==========================================
// POST /api/delivery/calculate
// Single-bon leverings-forslag (Workflow B — daglig triage).
//
// Body: { bon_id }  ELLER  { lat, lng, delivery_time?, boxes?, pax? }
//
// Med bon_id geokodes adressen synkront hvis den mangler coords
// (office venter på svaret). Returnerer altid 200 — { ok:false, reason }
// ved manglende grundlag, så frontenden kan degradere pænt.
// ==========================================
router.post('/calculate', requireAuth(), handle(async (req, res) => {
    const { bon_id, lat, lng, lon, delivery_time, boxes, pax } = req.body || {};

    let input;
    if (bon_id) {
        const bon = getBon(Number(bon_id));
        if (!bon) return res.status(404).json({ error: `Bon ${bon_id} ikke fundet` });

        const addr = bon.delivery_address || {};
        let aLat = addr.lat;
        let aLon = addr.lon;

        // Geokod synkront hvis adressen endnu ikke har coords.
        if ((aLat == null || aLon == null) && bon.delivery_address_id) {
            try {
                const c = await geocodeAddress(bon.delivery_address_id);
                if (c) { aLat = c.lat; aLon = c.lon; }
            } catch (e) {
                // degraderer til reason='missing_coords' i calculateForBon
            }
        }

        input = {
            addressId: bon.delivery_address_id || null,
            lat: aLat,
            lon: aLon,
            delivery_time: bon.delivery_time || null,
            boxes: bon.boxes,
            pax: bon.pax
        };
    } else {
        const rawLon = (lng != null ? lng : lon);
        if (lat == null || rawLon == null) {
            return res.status(400).json({ error: 'Angiv enten bon_id eller lat + lng' });
        }
        input = {
            addressId: null,
            lat,
            lon: rawLon,
            delivery_time: delivery_time || null,
            boxes: boxes || 0,
            pax: pax || 0
        };
    }

    res.json(await calculateForBon(input));
}));

// ==========================================
// GET /api/delivery/health
// ORS up/down — bruges af logistik-view til at vise routing-status.
// ==========================================
router.get('/health', requireAuth(), handle(async (req, res) => {
    res.json(await healthCheck());
}));

// ==========================================
// Spor 2 — RUTER (Workflow B + A)
// ==========================================

// Synkronisering af bons-cachen (spec sektion 5): delivery_route_stops er
// autoritativ; bons.delivery_vehicle_id/delivery_method holdes i sync her.
function syncBonToRoute(db, bonId, vehicle) {
    const method = vehicle ? deliveryMethodFromVehicleType(vehicle.type) : null;
    db.prepare(`
        UPDATE bons
        SET delivery_vehicle_id = ?,
            delivery_method = COALESCE(?, delivery_method),
            courier_provider = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(vehicle ? vehicle.id : null, method, vehicle ? vehicle.code : null, bonId);
}
function clearBonRouteCache(db, bonId) {
    db.prepare(`
        UPDATE bons
        SET delivery_vehicle_id = NULL,
            delivery_method = NULL,
            courier_provider = NULL,
            delivery_cost_estimated = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(bonId);
}

// Ekstern vogn (By-expressen/taxa, manual_clipboard/api) → 'pending' (skal bookes).
// Intern vogn (Volvo/egen cykel, calendar) → 'not_required' — ingen ekstern booking.
function bookingStatusForVehicle(vehicle) {
    if (!vehicle) return 'pending';
    return (vehicle.booking_method === 'manual_clipboard' || vehicle.booking_method === 'api')
        ? 'pending' : 'not_required';
}

// Kaldes efter en stop-ændring. En IKKE-afgået rute får planen nulstillet
// (status → draft): ETA/afhentningstid er nu forældet og skal genberegnes,
// og var ruten booket eksternt, skal den bookes igen. En afgået rute
// (status 'active') røres ikke — afhentningstiden er allerede historie.
function reconcileRouteAfterStopChange(db, route) {
    if (['active', 'completed', 'cancelled'].includes(route.status)) return;
    const sets = ["status = 'draft'", 'updated_at = CURRENT_TIMESTAMP'];
    if (route.booking_status === 'booked') sets.push("booking_status = 'pending'");
    db.prepare('UPDATE delivery_routes SET ' + sets.join(', ') + ' WHERE id = ?').run(route.id);
}

// Henter ruter (valgfrit filtreret på dato) med stops + parset geometri.
function getRoutesWithStops(date) {
    const db = getDb();
    let sql = `
        SELECT r.*, v.label AS vehicle_label, v.type AS vehicle_type,
               v.code AS vehicle_code, v.color AS vehicle_color,
               v.booking_method AS vehicle_booking_method, u.name AS courier_name
        FROM delivery_routes r
        JOIN delivery_vehicles v  ON v.id = r.vehicle_id
        LEFT JOIN users u         ON u.id = r.courier_user_id
    `;
    const params = [];
    if (date) { sql += ' WHERE r.route_date = ?'; params.push(date); }
    sql += ' ORDER BY r.route_date, r.pickup_time, r.id';
    const routes = db.prepare(sql).all(...params);

    const stopStmt = db.prepare(`
        SELECT s.id AS stop_id, s.bon_id, s.sequence, s.eta, s.status,
               s.distance_from_prev_m, s.duration_from_prev_s, s.completed_at,
               b.bon_number, b.delivery_time, b.boxes, b.pax,
               b.delivery_address_id,
               sd.code AS status_code,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
               co.name AS company_name,
               a.street_name, a.street_nr, a.postal_code, a.city, a.lat, a.lon
        FROM delivery_route_stops s
        JOIN bons b                ON b.id = s.bon_id
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN customers c      ON c.id = b.customer_id
        LEFT JOIN companies co     ON co.id = b.company_id
        LEFT JOIN addresses a      ON a.id = b.delivery_address_id
        WHERE s.route_id = ?
        ORDER BY s.sequence
    `);
    for (const r of routes) {
        r.stops = stopStmt.all(r.id);
        if (r.route_geojson) {
            try { r.route_geojson = JSON.parse(r.route_geojson); }
            catch (e) { r.route_geojson = null; }
        }
    }
    return routes;
}

// ──────────────────────────────────────────
// GET /api/delivery/routes?date=
// ──────────────────────────────────────────
router.get('/routes', requireAuth(), handle((req, res) => {
    res.json(getRoutesWithStops(req.query.date || null));
}));

// ──────────────────────────────────────────
// GET /api/delivery/overview?date=
// Leveringsoversigt: dagens delivery-bons + dagens ruter.
// Afstand/forslag pr. bon hentes af frontenden via POST /calculate.
// ──────────────────────────────────────────
router.get('/overview', requireAuth(), handle((req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date er påkrævet' });
    const db = getDb();

    const bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_time, b.pickup_time,
               b.boxes, b.pax, b.delivery_type, b.delivery_method,
               b.delivery_vehicle_id, b.delivery_notes,
               sd.code AS status_code,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
               co.name AS company_name,
               a.street_name, a.street_nr, a.postal_code, a.city, a.lat, a.lon,
               r.id AS on_route_id, st.sequence AS route_sequence,
               bv.label AS delivery_vehicle_label, bv.type AS delivery_vehicle_type
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN customers c      ON c.id = b.customer_id
        LEFT JOIN companies co     ON co.id = b.company_id
        LEFT JOIN addresses a      ON a.id = b.delivery_address_id
        LEFT JOIN delivery_route_stops st ON st.bon_id = b.id
        LEFT JOIN delivery_routes r ON r.id = st.route_id AND r.status != 'cancelled'
        LEFT JOIN delivery_vehicles bv ON bv.id = b.delivery_vehicle_id
        WHERE b.delivery_date = ?
          AND b.delivery_type IN ('delivery', 'event')
          AND b.is_offer = 0 AND b.is_internal = 0
          AND sd.code != 'AFLYST'
        ORDER BY b.delivery_time, b.id
    `).all(date);

    res.json({ date, bons, routes: getRoutesWithStops(date), hq: getHqCoords() });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes   { route_date, vehicle_id, courier_user_id?, notes? }
// ──────────────────────────────────────────
router.post('/routes', requireAuth(), handle((req, res) => {
    const { route_date, vehicle_id, courier_user_id = null, notes = null } = req.body || {};
    if (!route_date || !vehicle_id) {
        return res.status(400).json({ error: 'route_date og vehicle_id er påkrævet' });
    }
    const db = getDb();
    const newVehicle = getVehicleById(Number(vehicle_id));
    if (!newVehicle) {
        return res.status(404).json({ error: 'Vogn ikke fundet' });
    }
    const result = db.prepare(`
        INSERT INTO delivery_routes
            (route_date, vehicle_id, courier_user_id, notes, booking_status, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(route_date, Number(vehicle_id), courier_user_id, notes,
           bookingStatusForVehicle(newVehicle), req.session?.userId || null);

    res.status(201).json(getRoutesWithStops(null).find(r => r.id === Number(result.lastInsertRowid))
        || { id: Number(result.lastInsertRowid), route_date, vehicle_id: Number(vehicle_id), status: 'draft' });
}));

// ──────────────────────────────────────────
// PUT /api/delivery/routes/:id   (vehicle, courier, notes, route_date)
// ──────────────────────────────────────────
router.put('/routes/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });

    const allowed = ['route_date', 'vehicle_id', 'courier_user_id', 'notes', 'pickup_time'];
    const fields = [], params = [];
    for (const k of allowed) {
        if (req.body[k] !== undefined) { fields.push(`${k} = ?`); params.push(req.body[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Ingen felter at opdatere' });

    // Skifter vognen → bons-cachen på alle stop skal re-synkes.
    const vehicleChanged = req.body.vehicle_id !== undefined
        && Number(req.body.vehicle_id) !== route.vehicle_id;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    transaction(db, () => {
        db.prepare(`UPDATE delivery_routes SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        if (vehicleChanged) {
            const vehicle = getVehicleById(Number(req.body.vehicle_id));
            const stops = db.prepare('SELECT bon_id FROM delivery_route_stops WHERE route_id = ?').all(id);
            for (const s of stops) syncBonToRoute(db, s.bon_id, vehicle);
            db.prepare('UPDATE delivery_routes SET booking_status = ? WHERE id = ?')
                .run(bookingStatusForVehicle(vehicle), id);
        }
    });
    res.json(getRoutesWithStops(null).find(r => r.id === id));
}));

// ──────────────────────────────────────────
// DELETE /api/delivery/routes/:id   (kun draft/computed)
// ──────────────────────────────────────────
router.delete('/routes/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (!['draft', 'computed'].includes(route.status)) {
        return res.status(409).json({ error: 'Kun kladde-ruter kan slettes' });
    }
    const stops = db.prepare('SELECT bon_id FROM delivery_route_stops WHERE route_id = ?').all(id);
    transaction(db, () => {
        for (const s of stops) clearBonRouteCache(db, s.bon_id);
        db.prepare('DELETE FROM delivery_routes WHERE id = ?').run(id);  // stops cascader
    });
    for (const s of stops) {
        broadcast('delivery_route_stop_removed', { bon_id: s.bon_id, route_id: id });
        broadcast('bon_updated', { id: s.bon_id });
    }
    res.json({ id, deleted: true });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/stops   { bon_id }
// ──────────────────────────────────────────
router.post('/routes/:id/stops', requireAuth(), handle((req, res) => {
    const db = getDb();
    const routeId = Number(req.params.id);
    const bonId = Number(req.body && req.body.bon_id);
    if (!bonId) return res.status(400).json({ error: 'bon_id er påkrævet' });

    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(routeId);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (['completed', 'cancelled'].includes(route.status)) {
        return res.status(409).json({ error: 'Ruten er afsluttet og kan ikke ændres' });
    }
    if (!db.prepare('SELECT id FROM bons WHERE id = ?').get(bonId)) {
        return res.status(404).json({ error: 'Bon ikke fundet' });
    }
    const onOther = db.prepare(
        'SELECT route_id FROM delivery_route_stops WHERE bon_id = ? AND route_id != ?'
    ).get(bonId, routeId);
    if (onOther) {
        return res.status(409).json({ error: `Bonen er allerede på rute #${onOther.route_id}` });
    }
    if (db.prepare('SELECT id FROM delivery_route_stops WHERE route_id = ? AND bon_id = ?').get(routeId, bonId)) {
        return res.status(409).json({ error: 'Bonen er allerede på ruten' });
    }

    const vehicle = getVehicleById(route.vehicle_id);
    const seq = db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS m FROM delivery_route_stops WHERE route_id = ?'
    ).get(routeId).m + 1;

    transaction(db, () => {
        db.prepare('INSERT INTO delivery_route_stops (route_id, bon_id, sequence) VALUES (?, ?, ?)')
            .run(routeId, bonId, seq);
        // Et nyt stop gør planen forældet — nulstil (medmindre ruten er afgået).
        reconcileRouteAfterStopChange(db, route);
        syncBonToRoute(db, bonId, vehicle);
        logChange({
            entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'delivery_route',
            oldValue: null, newValue: routeId, userId: req.session?.userId || null,
            notes: `Tilføjet til rute #${routeId}${vehicle ? ' (' + vehicle.label + ')' : ''}`
        });
    });
    broadcast('delivery_route_stop_added', { bon_id: bonId, route_id: routeId });
    broadcast('bon_updated', { id: bonId });
    res.status(201).json({ route_id: routeId, bon_id: bonId, sequence: seq });
}));

// ──────────────────────────────────────────
// DELETE /api/delivery/routes/:id/stops/:bon_id
// ──────────────────────────────────────────
router.delete('/routes/:id/stops/:bon_id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const routeId = Number(req.params.id);
    const bonId = Number(req.params.bon_id);

    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(routeId);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (['completed', 'cancelled'].includes(route.status)) {
        return res.status(409).json({ error: 'Ruten er afsluttet og kan ikke ændres' });
    }
    const stop = db.prepare('SELECT id FROM delivery_route_stops WHERE route_id = ? AND bon_id = ?').get(routeId, bonId);
    if (!stop) return res.status(404).json({ error: 'Stop ikke fundet på ruten' });

    transaction(db, () => {
        db.prepare('DELETE FROM delivery_route_stops WHERE id = ?').run(stop.id);
        // Kompaktér sequence på de resterende stop.
        const remaining = db.prepare(
            'SELECT id FROM delivery_route_stops WHERE route_id = ? ORDER BY sequence'
        ).all(routeId);
        remaining.forEach((s, i) => {
            db.prepare('UPDATE delivery_route_stops SET sequence = ? WHERE id = ?').run(i + 1, s.id);
        });
        reconcileRouteAfterStopChange(db, route);
        clearBonRouteCache(db, bonId);
        logChange({
            entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'delivery_route',
            oldValue: routeId, newValue: null, userId: req.session?.userId || null,
            notes: `Fjernet fra rute #${routeId}`
        });
    });
    broadcast('delivery_route_stop_removed', { bon_id: bonId, route_id: routeId });
    broadcast('bon_updated', { id: bonId });
    res.json({ route_id: routeId, bon_id: bonId, removed: true });
}));

// ──────────────────────────────────────────
// PUT /api/delivery/routes/:id/stops/reorder   { bon_ids: [...] }
// Office bestemmer stop-rækkefølgen — re-sekvenserer efter den givne orden.
// ──────────────────────────────────────────
router.put('/routes/:id/stops/reorder', requireAuth(), handle((req, res) => {
    const db = getDb();
    const routeId = Number(req.params.id);
    const bonIds = ((req.body && req.body.bon_ids) || []).map(Number);

    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(routeId);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (['completed', 'cancelled'].includes(route.status)) {
        return res.status(409).json({ error: 'Ruten er afsluttet og kan ikke ændres' });
    }

    const current = db.prepare('SELECT bon_id FROM delivery_route_stops WHERE route_id = ?')
        .all(routeId).map(r => r.bon_id);
    const sameSet = bonIds.length === current.length
        && bonIds.every(b => current.includes(b))
        && current.every(b => bonIds.includes(b));
    if (!sameSet) {
        return res.status(400).json({ error: 'bon_ids skal indeholde præcis rutens stop' });
    }

    transaction(db, () => {
        // Forskyd alle sequence ud af vejen så UNIQUE(route_id,sequence) ikke kolliderer.
        db.prepare('UPDATE delivery_route_stops SET sequence = sequence + 10000 WHERE route_id = ?')
            .run(routeId);
        bonIds.forEach((bonId, i) => {
            db.prepare('UPDATE delivery_route_stops SET sequence = ? WHERE route_id = ? AND bon_id = ?')
                .run(i + 1, routeId, bonId);
        });
        reconcileRouteAfterStopChange(db, route);
    });
    broadcast('delivery_route_stop_added', { route_id: routeId });
    res.json({ route_id: routeId, order: bonIds });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/compute
// Kører route_planner, returnerer forslag (skriver ikke til DB).
// ──────────────────────────────────────────
router.post('/routes/:id/compute', requireAuth(), handle(async (req, res) => {
    try {
        res.json(await computeRoute(Number(req.params.id)));
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        throw err;
    }
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/apply
// Genberegner server-side og skriver forslaget til DB.
// Constraint-brud blokerer ikke — office har besluttet at anvende det.
// ──────────────────────────────────────────
router.post('/routes/:id/apply', requireAuth(), handle(async (req, res) => {
    const id = Number(req.params.id);
    try {
        const proposal = await computeRoute(id);
        const result = applyRouteProposal(id, proposal);
        res.json({ ...result, proposal });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        throw err;
    }
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/pickup-time
// Body: { pickup_time }  ("HH:MM" = manuel, null/tom = nulstil til auto)
//
// Vi regner altid baglæns: leveringstid − lead = afhentningstid. Her kan
// office tilsidesætte den beregnede afhentningstid manuelt — den skrives
// til rutens bons og overskrives ikke af en senere genberegning.
// ──────────────────────────────────────────
router.post('/routes/:id/pickup-time', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });

    const raw = req.body && req.body.pickup_time;
    const manual = raw != null && String(raw).trim() !== '';
    const pickup = manual ? String(raw).trim() : null;
    if (manual && !/^\d{1,2}:\d{2}$/.test(pickup)) {
        return res.status(400).json({ error: 'Ugyldigt klokkeslæt — brug HH:MM' });
    }

    const changedBons = [];
    transaction(db, () => {
        if (manual) {
            db.prepare(`
                UPDATE delivery_routes
                SET pickup_time = ?, pickup_time_source = 'manual', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(pickup, id);
            // Skriv den manuelle tid til rutens bons — undtagen dem køkkenet
            // allerede har disponeret efter (status >= KLAR).
            const stops = db.prepare('SELECT bon_id FROM delivery_route_stops WHERE route_id = ?').all(id);
            for (const s of stops) {
                const bon = db.prepare(
                    `SELECT b.id, b.pickup_time, sd.code AS status_code
                     FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
                     WHERE b.id = ?`
                ).get(s.bon_id);
                if (bon && !PICKUP_LOCKED_STATUSES.has(bon.status_code)
                    && bon.pickup_time !== pickup) {
                    db.prepare('UPDATE bons SET pickup_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(pickup, s.bon_id);
                    logChange({
                        entityType: 'bon', entityId: s.bon_id, action: 'update',
                        fieldName: 'pickup_time', oldValue: bon.pickup_time, newValue: pickup,
                        userId: req.session?.userId || null,
                        notes: `Afhentningstid sat manuelt på rute #${id}`
                    });
                    changedBons.push(s.bon_id);
                }
            }
        } else {
            db.prepare(`
                UPDATE delivery_routes
                SET pickup_time_source = 'auto', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(id);
        }
    });

    for (const bonId of changedBons) broadcast('bon_updated', { id: bonId });
    broadcast('delivery_route_status_changed', {
        route_id: id, pickup_time_source: manual ? 'manual' : 'auto'
    });
    res.json({
        id,
        pickup_time: manual ? pickup : route.pickup_time,
        pickup_time_source: manual ? 'manual' : 'auto'
    });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/actual-cost   { amount_dkk, source? }
// ──────────────────────────────────────────
router.post('/routes/:id/actual-cost', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { amount_dkk, source = 'manual' } = req.body || {};
    if (amount_dkk == null || isNaN(Number(amount_dkk))) {
        return res.status(400).json({ error: 'amount_dkk skal være et tal' });
    }
    if (!['manual', 'api'].includes(source)) {
        return res.status(400).json({ error: 'source skal være manual eller api' });
    }
    const route = db.prepare('SELECT id FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });

    db.prepare(`
        UPDATE delivery_routes
        SET actual_cost_dkk = ?, actual_cost_source = ?,
            actual_cost_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(Math.round(Number(amount_dkk)), source, id);
    broadcast('delivery_route_status_changed', { route_id: id, status: 'cost_updated' });
    res.json({ id, actual_cost_dkk: Math.round(Number(amount_dkk)), actual_cost_source: source });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/book
// Body: { external_reference?, status? }  (status: pending|in_progress|booked|failed)
// Markerer rutens eksterne booking. Office kalder dette efter at have sendt
// bestillingen via popout-vinduet. Interne ruter bookes ikke eksternt.
// ──────────────────────────────────────────
router.post('/routes/:id/book', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { external_reference = null, status = 'booked' } = req.body || {};
    const VALID = ['pending', 'in_progress', 'booked', 'failed', 'not_required'];
    if (!VALID.includes(status)) {
        return res.status(400).json({ error: 'Ugyldig booking-status' });
    }
    const route = db.prepare('SELECT id FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });

    db.prepare(`
        UPDATE delivery_routes
        SET booking_status = ?,
            external_reference = COALESCE(?, external_reference),
            booked_at = CURRENT_TIMESTAMP,
            booked_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, external_reference, req.session?.userId || null, id);

    broadcast('delivery_route_status_changed', { route_id: id, booking_status: status });
    res.json({ id, booking_status: status, external_reference });
}));

// ──────────────────────────────────────────
// GET /api/delivery/history-map?from=&to=&method=
// Historiske leveringer som kort-punkter — geokodede adresser for
// faktiske leveringer i perioden. Bruges af logistik-historik-viewet.
// ──────────────────────────────────────────
router.get('/history-map', requireAuth(), handle((req, res) => {
    const db = getDb();
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) {
        return res.status(400).json({ error: 'from og to er påkrævet (YYYY-MM-DD)' });
    }
    const method = req.query.method || null;

    const params = [from, to];
    let methodClause = '';
    if (method && ['bike', 'taxi', 'volvo'].includes(method)) {
        methodClause = ' AND b.delivery_method = ?';
        params.push(method);
    }

    const points = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.delivery_time,
               b.delivery_method, b.total_units, b.pax,
               a.lat, a.lon, a.postal_code, a.city,
               co.name AS company_name,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
               v.label AS vehicle_label, v.color AS vehicle_color, v.type AS vehicle_type,
               sd.code AS status_code
        FROM bons b
        JOIN addresses a            ON a.id = b.delivery_address_id
        JOIN status_definitions sd  ON sd.id = b.status_id
        LEFT JOIN companies co      ON co.id = b.company_id
        LEFT JOIN customers c       ON c.id = b.customer_id
        LEFT JOIN delivery_vehicles v ON v.id = b.delivery_vehicle_id
        WHERE b.delivery_type = 'delivery'
          AND b.is_offer = 0 AND b.is_internal = 0
          AND sd.code != 'AFLYST'
          AND a.lat IS NOT NULL AND a.lon IS NOT NULL
          AND b.delivery_date BETWEEN ? AND ?
          ${methodClause}
        ORDER BY b.delivery_date DESC
        LIMIT 5000
    `).all(...params);

    const byMethod = {};
    for (const p of points) {
        const m = p.delivery_method || 'ukendt';
        byMethod[m] = (byMethod[m] || 0) + 1;
    }

    res.json({ from, to, total: points.length, by_method: byMethod, points });
}));

// ══════════════════════════════════════════════════════════════════
// S2.3 — COURIER (intern chauffør)
// ══════════════════════════════════════════════════════════════════

// Statusser hvor bonen ikke skal flyttes til LEVERET af courieren
// (allerede leveret eller forbi det punkt).
const BON_POST_DELIVERY = new Set(['LEVERET', 'FAKTURERET', 'AFSLUTTET', 'BETALT', 'AFLYST']);

// Når courieren markerer et stop leveret rykkes bonen til LEVERET (hvis den
// ikke allerede er der) — så køkken/kontor ser leveringen uden dobbeltarbejde.
function markBonDeliveredFromStop(db, bonId, userId) {
    const bon = db.prepare(
        `SELECT sd.code AS status_code FROM bons b
         JOIN status_definitions sd ON sd.id = b.status_id WHERE b.id = ?`
    ).get(bonId);
    if (!bon || BON_POST_DELIVERY.has(bon.status_code)) return false;

    const leveretId = getStatusId('LEVERET');
    if (!leveretId) return false;
    db.prepare(`UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(leveretId, bonId);
    logChange({
        entityType: 'bon', entityId: bonId, action: 'status_change', fieldName: 'status_id',
        oldValue: bon.status_code, newValue: 'LEVERET', userId: userId || null,
        notes: 'Leveret af bud'
    });
    broadcast('bon_status', { id: bonId, old: bon.status_code, new: 'LEVERET' });
    autoConsumeBonInventory(bonId);
    return true;
}

// Auto-afslut ruten når intet stop er 'planlagt' længere.
function maybeCompleteRoute(db, routeId) {
    const open = db.prepare(
        `SELECT COUNT(*) AS n FROM delivery_route_stops
         WHERE route_id = ? AND status = 'planlagt'`
    ).get(routeId).n;
    if (open > 0) return false;
    const route = db.prepare('SELECT status FROM delivery_routes WHERE id = ?').get(routeId);
    if (!route || ['completed', 'cancelled'].includes(route.status)) return false;
    db.prepare(`
        UPDATE delivery_routes
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(routeId);
    return true;
}

// ──────────────────────────────────────────
// GET /api/delivery/couriers
// Aktive brugere der kan tildeles en rute som chauffør. Bruges af
// logistik-viewets chauffør-dropdown — derfor åben for alle (ikke
// admin-only som /api/users).
// ──────────────────────────────────────────
router.get('/couriers', requireAuth(), handle((req, res) => {
    const db = getDb();
    res.json(db.prepare(
        'SELECT id, name FROM users WHERE is_active = 1 ORDER BY name'
    ).all());
}));

// ──────────────────────────────────────────
// GET /api/delivery/courier/today?date=YYYY-MM-DD
// Den indloggede chaufførs egne ruter — med stop, adresse,
// kontakt og indhold. Driver courier-mobilen.
// Uden ?date= vises i dag. Med ?date= kan chaufføren bladre frem
// (og tilbage) i dagene. `next_date` peger på den næste dag efter
// den viste med en tildelt tur, så mobilen kan hoppe direkte derhen.
// ──────────────────────────────────────────
router.get('/courier/today', requireAuth(), handle((req, res) => {
    const db = getDb();
    const userId = req.session?.userId || null;
    const today = todayISO();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;

    const routes = db.prepare(`
        SELECT r.id, r.route_date, r.status, r.pickup_time, r.actual_departure,
               r.completed_at, r.total_km, r.total_minutes, r.notes,
               v.label AS vehicle_label, v.type AS vehicle_type, v.color AS vehicle_color
        FROM delivery_routes r
        JOIN delivery_vehicles v ON v.id = r.vehicle_id
        WHERE r.route_date = ? AND r.courier_user_id = ? AND r.status != 'cancelled'
        ORDER BY r.pickup_time, r.id
    `).all(date, userId);

    const stopStmt = db.prepare(`
        SELECT s.id AS stop_id, s.bon_id, s.sequence, s.eta, s.status, s.completed_at,
               b.bon_number, b.delivery_time, b.boxes, b.pax, b.delivery_notes,
               b.day_contact_name, b.day_contact_phone, b.payment_type,
               sd.code AS status_code,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
               c.phone AS customer_phone,
               co.name AS company_name,
               a.street_name, a.street_nr, a.postal_code, a.city, a.lat, a.lon
        FROM delivery_route_stops s
        JOIN bons b                ON b.id = s.bon_id
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN customers c      ON c.id = b.customer_id
        LEFT JOIN companies co     ON co.id = b.company_id
        LEFT JOIN addresses a      ON a.id = b.delivery_address_id
        WHERE s.route_id = ?
        ORDER BY s.sequence
    `);
    const incStmt = db.prepare(`
        SELECT incident_type, description, logged_at
        FROM delivery_incidents WHERE route_stop_id = ? ORDER BY logged_at
    `);
    for (const r of routes) {
        r.stops = stopStmt.all(r.id);
        for (const s of r.stops) {
            s.items = getBonLines(s.bon_id)
                .filter(l => !l.is_accessory)
                .map(l => ({ quantity: l.quantity, product_name: l.product_name }));
            s.incidents = incStmt.all(s.stop_id);
        }
    }

    const nextDate = db.prepare(`
        SELECT MIN(route_date) AS d
        FROM delivery_routes
        WHERE courier_user_id = ? AND status != 'cancelled' AND route_date > ?
    `).get(userId, date).d || null;

    res.json({ date, today, next_date: nextDate, routes });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/depart
// Courieren kører fra HQ — ruten bliver 'active'.
// ──────────────────────────────────────────
router.post('/routes/:id/depart', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (['completed', 'cancelled'].includes(route.status)) {
        return res.status(409).json({ error: 'Ruten er afsluttet' });
    }
    db.prepare(`
        UPDATE delivery_routes
        SET status = 'active', actual_departure = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(id);
    broadcast('delivery_route_status_changed', { route_id: id, status: 'active' });
    res.json({ id, status: 'active' });
}));

// ──────────────────────────────────────────
// POST /api/delivery/routes/:id/undo-depart
// Fortryd "Kør fra HQ" — kun hvis ingen stop er markeret endnu.
// Ruten ruller tilbage til 'computed' (den eneste reelle pre-active-status),
// og actual_departure ryddes så timestamps ikke forfalskes.
// ──────────────────────────────────────────
router.post('/routes/:id/undo-depart', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const route = db.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ error: 'Rute ikke fundet' });
    if (route.status !== 'active') {
        return res.status(409).json({ error: 'Ruten er ikke startet' });
    }
    const touched = db.prepare(`
        SELECT COUNT(*) AS n FROM delivery_route_stops
        WHERE route_id = ? AND status != 'planlagt'
    `).get(id).n;
    if (touched > 0) {
        return res.status(409).json({
            error: 'Kan ikke fortryde — der er allerede markeret stop på turen'
        });
    }
    db.prepare(`
        UPDATE delivery_routes
        SET status = 'computed', actual_departure = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(id);
    broadcast('delivery_route_status_changed', { route_id: id, status: 'computed' });
    res.json({ id, status: 'computed' });
}));

// ──────────────────────────────────────────
// POST /api/delivery/stops/:id/status
// Body: { status: 'leveret' | 'problem', lat?, lng? }
// Courier markerer et stop. 'leveret' rykker også bonen til LEVERET.
// Problem-flowet bruger normalt /incidents (som også sætter 'problem').
// ──────────────────────────────────────────
router.post('/stops/:id/status', requireAuth(), handle((req, res) => {
    const db = getDb();
    const stopId = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!['leveret', 'problem'].includes(status)) {
        return res.status(400).json({ error: "status skal være 'leveret' eller 'problem'" });
    }
    const stop = db.prepare('SELECT * FROM delivery_route_stops WHERE id = ?').get(stopId);
    if (!stop) return res.status(404).json({ error: 'Stop ikke fundet' });

    const userId = req.session?.userId || null;
    let bonChanged = false;
    let routeCompleted = false;
    transaction(db, () => {
        db.prepare(`
            UPDATE delivery_route_stops SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(status, stopId);
        if (status === 'leveret') {
            bonChanged = markBonDeliveredFromStop(db, stop.bon_id, userId);
        }
        routeCompleted = maybeCompleteRoute(db, stop.route_id);
    });

    broadcast('delivery_stop_status_changed', {
        stop_id: stopId, route_id: stop.route_id, bon_id: stop.bon_id, status
    });
    if (routeCompleted) {
        broadcast('delivery_route_status_changed', { route_id: stop.route_id, status: 'completed' });
    }
    res.json({ stop_id: stopId, status, bon_delivered: bonChanged, route_completed: routeCompleted });
}));

// ──────────────────────────────────────────
// POST /api/delivery/incidents   (multipart/form-data)
// Felter: route_stop_id?, bon_id, incident_type, description?,
//         location_lat?, location_lng?  + valgfri fil 'photo'.
// Logger et leveringsproblem og sætter stoppet til 'problem'.
// ──────────────────────────────────────────
const INCIDENT_TYPES = new Set([
    'no_answer', 'wrong_address', 'left_at_door', 'returned_to_kitchen', 'damage', 'other'
]);
const INCIDENT_MAX_PHOTO = 10 * 1024 * 1024;

router.post('/incidents', requireAuth(), (req, res) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: INCIDENT_MAX_PHOTO, files: 1 } });
    const fields = {};
    let photo = null;          // { buffer, mime, ext, truncated, error }

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, stream, info) => {
        if (name !== 'photo') { stream.resume(); return; }
        const mime = info.mimeType || '';
        if (!mime.startsWith('image/')) {
            stream.resume();
            photo = { error: 'Kun billeder kan vedhæftes' };
            return;
        }
        const chunks = [];
        let truncated = false;
        stream.on('data', c => chunks.push(c));
        stream.on('limit', () => { truncated = true; });
        stream.on('end', () => {
            photo = {
                buffer: Buffer.concat(chunks),
                mime,
                ext: mime.split('/')[1] === 'png' ? 'png' : 'jpg',
                truncated
            };
        });
    });

    bb.on('error', (err) => {
        console.error('[delivery/incidents] busboy:', err.message);
        res.status(500).json({ error: 'Upload fejlede' });
    });

    bb.on('close', () => {
        try {
            const db = getDb();
            const bonId = Number(fields.bon_id);
            const incidentType = fields.incident_type;
            const routeStopId = fields.route_stop_id ? Number(fields.route_stop_id) : null;
            const lat = fields.location_lat != null && fields.location_lat !== ''
                ? Number(fields.location_lat) : null;
            const lng = fields.location_lng != null && fields.location_lng !== ''
                ? Number(fields.location_lng) : null;

            if (!bonId || !db.prepare('SELECT id FROM bons WHERE id = ?').get(bonId)) {
                return res.status(400).json({ error: 'Gyldigt bon_id er påkrævet' });
            }
            if (!INCIDENT_TYPES.has(incidentType)) {
                return res.status(400).json({ error: 'Ukendt incident_type' });
            }
            if (photo && photo.error) {
                return res.status(400).json({ error: photo.error });
            }
            if (photo && photo.truncated) {
                return res.status(413).json({ error: 'Billedet er for stort (maks 10 MB)' });
            }

            const userId = req.session?.userId || null;
            let photoAttachmentId = null;

            if (photo && photo.buffer && photo.buffer.length) {
                const dir = path.join(__dirname, '..', 'data', 'attachments', 'incident', String(bonId));
                fs.mkdirSync(dir, { recursive: true });
                const fileName = `incident-${Date.now()}.${photo.ext}`;
                const filePath = path.join(dir, fileName);
                fs.writeFileSync(filePath, photo.buffer);
                const att = db.prepare(`
                    INSERT INTO attachments (entity_type, entity_id, file_name, file_path, file_type, uploaded_by_user_id, created_at)
                    VALUES ('delivery_incident', ?, ?, ?, 'image', ?, datetime('now'))
                `).run(bonId, fileName, filePath, userId);
                photoAttachmentId = Number(att.lastInsertRowid);
            }

            let routeId = null;
            const result = transaction(db, () => {
                const ins = db.prepare(`
                    INSERT INTO delivery_incidents
                        (route_stop_id, bon_id, incident_type, description,
                         photo_attachment_id, location_lat, location_lng, logged_by_user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(routeStopId, bonId, incidentType, fields.description || null,
                       photoAttachmentId, lat, lng, userId);
                // Sæt stoppet til 'problem' og afslut evt. ruten.
                if (routeStopId) {
                    const stop = db.prepare('SELECT route_id FROM delivery_route_stops WHERE id = ?').get(routeStopId);
                    if (stop) {
                        routeId = stop.route_id;
                        db.prepare(`
                            UPDATE delivery_route_stops
                            SET status = 'problem', completed_at = CURRENT_TIMESTAMP WHERE id = ?
                        `).run(routeStopId);
                        maybeCompleteRoute(db, routeId);
                    }
                }
                logChange({
                    entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'delivery_incident',
                    oldValue: null, newValue: incidentType, userId,
                    notes: `Leveringsproblem logget${fields.description ? ': ' + fields.description : ''}`
                });
                return Number(ins.lastInsertRowid);
            });

            broadcast('delivery_incident_logged', {
                incident_id: result, bon_id: bonId, route_stop_id: routeStopId,
                route_id: routeId, incident_type: incidentType
            });
            if (routeStopId) {
                broadcast('delivery_stop_status_changed', {
                    stop_id: routeStopId, route_id: routeId, bon_id: bonId, status: 'problem'
                });
            }
            res.status(201).json({
                incident_id: result, bon_id: bonId, incident_type: incidentType,
                photo_attachment_id: photoAttachmentId
            });
        } catch (err) {
            console.error('[delivery/incidents]', err.message);
            res.status(500).json({ error: 'Kunne ikke logge problem' });
        }
    });

    req.pipe(bb);
});

// ==========================================
// LOBO / BYEKSPRESSEN — pris + booking (Fase B)
// ==========================================

// Hjælp: hent bon + By-expressen-vogn + adapter, eller send fejl-respons.
function loadLoboContext(req, res) {
    const bonId = parseInt(req.query.bon_id || req.body.bon_id, 10);
    if (!bonId) { res.status(400).json({ error: 'bon_id påkrævet' }); return null; }
    const bon = getBon(bonId);
    if (!bon) { res.status(404).json({ error: 'Bon ikke fundet' }); return null; }
    if (!bon.delivery_address || !bon.delivery_address.street_name) {
        res.status(400).json({ error: 'Bon mangler leveringsadresse' }); return null;
    }
    const vehicle = getDb().prepare(
        `SELECT * FROM delivery_vehicles WHERE code = 'byekspressen'`
    ).get();
    let adapter;
    try { adapter = getByExpressenAdapter(); }
    catch (e) { res.status(503).json({ error: e.message, code: e.code || 'config' }); return null; }
    // pax_per_box til default-kasse-udledning når bonen ikke har boxes sat
    const ppbRow = getDb().prepare(`SELECT value FROM settings WHERE key = 'default_pax_per_box'`).get();
    const paxPerBox = ppbRow && Number(ppbRow.value) > 0 ? Number(ppbRow.value) : 16;
    return { bon, vehicle, adapter, paxPerBox };
}

// GET /api/delivery/lobo/quote?bon_id=
// Live pris-tilbud (opretter + sletter en orderdraft — INGEN ordre, intet bud).
router.get('/lobo/quote', requireAuth(), handle(async (req, res) => {
    const ctx = loadLoboContext(req, res);
    if (!ctx) return;
    try {
        const quote = await quoteForBon({ ...ctx, boxes: req.query.boxes });
        res.json(quote);
    } catch (e) {
        const status = e instanceof ByExpressenError ? (e.status || 502) : 502;
        res.status(status).json({ error: e.message, code: e.code, body: e.body });
    }
}));

// POST /api/delivery/lobo/preview  { bon_id, ...overrides }
// Se-og-ret-panelet: viser de felter By-expressen modtager + Lobos leveringsvindue
// + pris (opretter + sletter en orderdraft — INGEN ordre, intet bud).
router.post('/lobo/preview', requireAuth(), handle(async (req, res) => {
    const ctx = loadLoboContext(req, res);
    if (!ctx) return;
    try {
        const result = await previewBooking({ ...ctx, overrides: pickLoboOverrides(req.body) });
        res.json(result);
    } catch (e) {
        const status = e instanceof ByExpressenError ? (e.status || 502) : 502;
        res.status(status).json({ error: e.message, code: e.code, body: e.body });
    }
}));

// POST /api/delivery/lobo/book  { bon_id, confirm?, ...overrides }
// Rigtig booking (dispatch). GATE: mod productive kræves confirm:true, da et
// rigtigt bud sendes og order.delete-scope (cancel via API) ikke er aktiv endnu.
// overrides (samme som /preview) sikrer at det bookede = det office så.
router.post('/lobo/book', requireAuth(), handle(async (req, res) => {
    const ctx = loadLoboContext(req, res);
    if (!ctx) return;
    const cfg = ctx.adapter.config || {};
    if (!cfg.use_sandbox && req.body.confirm !== true) {
        return res.status(412).json({
            error: 'Booking mod produktion sender et rigtigt bud og kan ikke afbestilles via API (order.delete mangler). Send confirm:true for at fortsætte.',
            code: 'confirm_required',
        });
    }
    try {
        const result = await bookForBon({ ...ctx, userId: req.session.userId, overrides: pickLoboOverrides(req.body) });
        res.status(201).json({ ok: true, ...result });
    } catch (e) {
        const status = e instanceof ByExpressenError ? (e.status || 502) : 502;
        res.status(status).json({ error: e.message, code: e.code, body: e.body });
    }
}));

// GET /api/delivery/lobo/status
// Sandkasse-tilstand + om By-expressen er konfigureret. Bruges af bon-drawer +
// logistik til at vise SANDKASSE-badgen og af Settings til at vise master-kontakten.
router.get('/lobo/status', requireAuth(), handle((req, res) => {
    const row = getDb().prepare(
        `SELECT booking_method, booking_api_config_json FROM delivery_vehicles WHERE code = 'byekspressen'`
    ).get();
    let cfg = null;
    if (row && row.booking_api_config_json) {
        try { cfg = JSON.parse(row.booking_api_config_json); } catch { cfg = null; }
    }
    const host = cfg ? (cfg.use_sandbox ? cfg.sandbox_url : cfg.base_url) || null : null;
    res.json({
        configured: !!cfg,
        use_sandbox: !!(cfg && cfg.use_sandbox),
        booking_method: row ? row.booking_method : null,
        host,
    });
}));

// POST /api/delivery/lobo/sandbox  { enabled }  (admin)
// Master-kontakt: vender use_sandbox i By-expressen-vognens config. json_set bevarer
// alle øvrige nøgler. Slår igennem med det samme (adapteren bygges pr. kald fra DB).
router.post('/lobo/sandbox', requireAuth('admin'), handle((req, res) => {
    const enabled = req.body.enabled ? 1 : 0;
    const db = getDb();
    const row = db.prepare(
        `SELECT id, booking_api_config_json FROM delivery_vehicles WHERE code = 'byekspressen'`
    ).get();
    if (!row) return res.status(404).json({ error: 'By-expressen-vogn ikke fundet' });
    db.prepare(
        `UPDATE delivery_vehicles
         SET booking_api_config_json = json_set(booking_api_config_json, '$.use_sandbox', json(?))
         WHERE id = ?`
    ).run(enabled ? 'true' : 'false', row.id);
    logChange({
        entityType: 'delivery_vehicle', entityId: row.id, action: 'update',
        fieldName: 'use_sandbox', newValue: String(!!enabled), userId: req.session.userId,
    });
    broadcast('lobo_sandbox_changed', { use_sandbox: !!enabled });
    res.json({ ok: true, use_sandbox: !!enabled });
}));

// GET /api/delivery/lobo/order-status?bon_id=
// Trin 3: on-demand status for en booket By-expressen-ordre (status, bud, ETA,
// kvittering, endelig pris). Bruger ingen webhooks — poller GET /orders/{uuid}.
router.get('/lobo/order-status', requireAuth(), handle(async (req, res) => {
    const bonId = parseInt(req.query.bon_id, 10);
    if (!bonId) return res.status(400).json({ error: 'bon_id påkrævet' });
    const uuid = loboOrderUuidForBon(bonId);
    if (!uuid) return res.json({ booked: false });
    let adapter;
    try { adapter = getByExpressenAdapter(); }
    catch (e) { return res.status(503).json({ error: e.message, code: e.code || 'config' }); }
    try {
        const order = await adapter.getOrder(uuid);
        const norm = normalizeLoboOrder(order);
        // Når leveret + Lobo har en endelig pris: gem den som faktisk omkostning.
        if (norm && norm.delivered && norm.cost_ex != null) {
            try { setActualCost({ bonId, amount: norm.cost_ex, source: 'api', userId: req.session.userId }); }
            catch (e) { console.warn('[lobo/order-status] setActualCost:', e.message); }
        }
        res.json({ booked: true, ...norm });
    } catch (e) {
        const status = e instanceof ByExpressenError ? (e.status || 502) : 502;
        res.status(status).json({ error: e.message, code: e.code });
    }
}));

// GET /api/delivery/lobo/pod?bon_id=
// Proxy af kvitterings-PDF (POD) — Lobos download-URL kræver bearer-token, så vi
// henter den server-side og streamer den til browseren.
router.get('/lobo/pod', requireAuth(), handle(async (req, res) => {
    const bonId = parseInt(req.query.bon_id, 10);
    if (!bonId) return res.status(400).send('bon_id påkrævet');
    const uuid = loboOrderUuidForBon(bonId);
    if (!uuid) return res.status(404).send('Ingen By-expressen-ordre på bonen');
    let adapter;
    try { adapter = getByExpressenAdapter(); }
    catch (e) { return res.status(503).send(e.message); }
    try {
        const podRes = await adapter.downloadPod(uuid);
        res.setHeader('Content-Type', podRes.headers.get('content-type') || 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="pod-${uuid}.pdf"`);
        res.send(Buffer.from(await podRes.arrayBuffer()));
    } catch (e) {
        res.status(502).send('Kvittering ikke tilgængelig: ' + e.message);
    }
}));

// ── Webhook-registrering + selvkalibrering (trin "live-push") ──────────────
const LOBO_WEBHOOK_EVENTS = ['dispatched', 'stopvisitedorsigned', 'finished', 'changed', 'trashed', 'withdrawn'];

function _settingsGetter(db) {
    return (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
}
function _settingsSetter(db) {
    return (k, v) => db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(k, v == null ? null : String(v));
}

// GET /api/delivery/lobo/webhooks  (admin) — registrerings- + kalibrerings-status.
router.get('/lobo/webhooks', requireAuth('admin'), handle((req, res) => {
    const get = _settingsGetter(getDb());
    let events = []; try { events = Object.keys(JSON.parse(get('lobo_webhook_keys') || '{}')); } catch { /* */ }
    res.json({
        url: get('lobo_webhook_url'),
        events,
        registered: events.length > 0,
        verify: get('lobo_webhook_verify') || '0',
        calibrated: (get('lobo_webhook_verify') || '0') === '1',
        sig_header: get('lobo_webhook_sig_header'),
        sign_target: get('lobo_webhook_sign_target'),
    });
}));

// POST /api/delivery/lobo/webhooks/register  (admin)
// Registrér webhooks hos By-expressen pegende på vores modtager + gem per-event
// hmac-nøgler. Verifikation forbliver FRA indtil første callback selvkalibrerer.
router.post('/lobo/webhooks/register', requireAuth('admin'), handle(async (req, res) => {
    const db = getDb();
    const get = _settingsGetter(db), setS = _settingsSetter(db);
    const base = String(req.body.public_base_url || get('lobo_webhook_public_url') || get('booking_public_url_base') || '')
        .trim().replace(/\/+$/, '');
    if (!base) return res.status(400).json({ error: 'public_base_url mangler (sæt lobo_webhook_public_url i settings eller send public_base_url)', code: 'no_url' });
    const url = base + '/api/webhooks/lobo';
    let adapter;
    try { adapter = getByExpressenAdapter(); }
    catch (e) { return res.status(503).json({ error: e.message, code: e.code || 'config' }); }

    const keys = {}, ids = {}, errors = {};
    for (const ev of LOBO_WEBHOOK_EVENTS) {
        try { const w = await adapter.registerWebhook(ev, url); keys[ev] = w.hmac_key; ids[ev] = w.id; }
        catch (e) { errors[ev] = e.message; }
    }
    if (!Object.keys(keys).length) {
        return res.status(502).json({ error: 'Ingen webhooks kunne registreres', errors });
    }
    setS('lobo_webhook_url', url);
    setS('lobo_webhook_keys', JSON.stringify(keys));
    setS('lobo_webhook_ids', JSON.stringify(ids));
    setS('lobo_webhook_algorithm', 'sha256');
    if (get('lobo_webhook_verify') == null) setS('lobo_webhook_verify', '0');
    res.json({
        ok: true, url, registered: Object.keys(keys), errors,
        sandbox: !!(adapter.config && adapter.config.use_sandbox),
        note: 'Verifikation slås automatisk til når første rigtige callback kalibrerer signatur-formatet.',
    });
}));

// DELETE /api/delivery/lobo/webhooks  (admin) — afregistrér + nulstil kalibrering.
router.delete('/lobo/webhooks', requireAuth('admin'), handle(async (req, res) => {
    const db = getDb();
    const get = _settingsGetter(db);
    let ids = {}; try { ids = JSON.parse(get('lobo_webhook_ids') || '{}'); } catch { /* */ }
    let deleted = [];
    try {
        const adapter = getByExpressenAdapter();
        for (const [ev, id] of Object.entries(ids)) { try { await adapter.deleteWebhook(id); deleted.push(ev); } catch { /* */ } }
    } catch (e) { /* afregistrér best-effort — ryd settings uanset */ }
    for (const k of ['lobo_webhook_url', 'lobo_webhook_keys', 'lobo_webhook_ids', 'lobo_webhook_sig_header', 'lobo_webhook_sign_target']) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    }
    _settingsSetter(db)('lobo_webhook_verify', '0');
    res.json({ ok: true, deleted });
}));

module.exports = router;
