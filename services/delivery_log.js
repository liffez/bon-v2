// services/delivery_log.js
// ==========================================
// Logger booking-events til delivery_events
// + opdaterer bons med valgt vehicle + cost-estimat.
//
// Wraps:
//   - INSERT i delivery_events (audit-log)
//   - UPDATE bons (vehicle_id + cost_source + cost_estimated)
//   - logChange() i changelog
//   - SSE broadcast bon_updated
//
// Bruges af routes/delivery.js. Indkapsler hele transaction-logikken
// så routes-filen er tynd.
// ==========================================

const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');
const { logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { getVehicleById, estimateCost } = require('./booking_template');

const VALID_BOOKING_STATUSES = new Set(['booked', 'in_progress', 'failed']);

// Mapping fra vehicle.type → bons.delivery_method (CHECK constraint)
// Eksisterende dropdown havde værdier 'cykel'/'taxa'/'volvo'/'afhentning'
// men DB CHECK siger 'bike'/'taxi'/'volvo'/'pickup'. Vi bruger DB-værdierne.
function deliveryMethodFromVehicleType(type) {
    switch (type) {
        case 'volvo':    return 'volvo';
        case 'bike':     return 'bike';
        case 'own-bike': return 'bike';
        case 'taxi':     return 'taxi';
        default:         return null;
    }
}

// ==========================================
// Marker bon som booket hos en vehicle.
//
// args:
//   bonId             — påkrævet
//   vehicleId         — påkrævet
//   reference         — booking-ref fra leverandør (valgfri)
//   status            — 'booked' | 'in_progress' | 'failed'  (default 'booked')
//   userId            — login-bruger (valgfri)
//   note              — fritekst (valgfri)
//
// Returnerer det oprettede event (med id).
// ==========================================
function logBookingEvent({ bonId, vehicleId, reference = null, status = 'booked', userId = null, note = null }) {
    if (!bonId) throw new Error('bonId påkrævet');
    if (!vehicleId) throw new Error('vehicleId påkrævet');
    if (!VALID_BOOKING_STATUSES.has(status)) {
        throw new Error(`Ugyldig status: ${status}. Skal være en af: ${[...VALID_BOOKING_STATUSES].join(', ')}`);
    }

    const db = getDb();
    const vehicle = getVehicleById(vehicleId);
    if (!vehicle) throw new Error(`Vehicle ${vehicleId} ikke fundet`);

    const bon = db.prepare(`
        SELECT id, bon_number, delivery_vehicle_id, delivery_cost_estimated, boxes, pax
        FROM bons WHERE id = ?
    `).get(bonId);
    if (!bon) throw new Error(`Bon ${bonId} ikke fundet`);

    return transaction(db, () => {
        // event_type mapping:
        //   'booked'      → 'booked'  (faktisk booking gennemført)
        //   'in_progress' → 'booked'  (Spring over — markér som booket men afventer ref)
        //   'failed'      → 'failed'
        // Vi bruger eksisterende event_type CHECK uden migration.
        const eventType = status === 'failed' ? 'failed' : 'booked';

        const noteWithStatus = status === 'in_progress'
            ? `[afventer ref] ${note || ''}`.trim()
            : (note || null);

        const insertResult = db.prepare(`
            INSERT INTO delivery_events
                (bon_id, event_type, provider, external_reference,
                 vehicle_id, booked_by_user_id, notes, event_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            bonId,
            eventType,
            vehicle.code,
            reference,
            vehicleId,
            userId,
            noteWithStatus
        );

        const eventId = insertResult.lastInsertRowid;

        // Opdater bonnen — vehicle_id sættes altid (sidste valgte vehicle)
        // delivery_method synkroniseres fra vehicle.type så lister/filtre stadig virker
        // Estimat skrives kun hvis bonnen ikke allerede har faktisk pris
        const estimated = estimateCost(vehicle, bon);
        const newMethod = deliveryMethodFromVehicleType(vehicle.type);
        if (bon.delivery_vehicle_id !== vehicleId) {
            db.prepare(`
                UPDATE bons
                SET delivery_vehicle_id = ?,
                    delivery_method = COALESCE(?, delivery_method),
                    courier_provider = ?,
                    delivery_cost_estimated = COALESCE(?, delivery_cost_estimated),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(vehicleId, newMethod, vehicle.code, estimated, bonId);

            logChange({
                entityType: 'bon',
                entityId: bonId,
                action: 'update',
                fieldName: 'delivery_vehicle_id',
                oldValue: bon.delivery_vehicle_id,
                newValue: vehicleId,
                userId,
                notes: `Bestilt hos ${vehicle.label}${reference ? ` (ref: ${reference})` : ''}${status === 'in_progress' ? ' — afventer ref' : ''}`
            });
        } else if (reference) {
            // Samme vehicle, ny ref — log kun changelog-note
            logChange({
                entityType: 'bon',
                entityId: bonId,
                action: 'update',
                fieldName: 'delivery_booking',
                oldValue: null,
                newValue: reference,
                userId,
                notes: `Ny booking-ref hos ${vehicle.label}: ${reference}`
            });
        }

        // Ekskluderer bevidst IKKE aktøren — bookingen sker ofte i et popout-
        // vindue, og hoveddrawer'en (samme bruger) skal opdatere.
        broadcast('bon_updated', { id: bonId });

        return {
            id: eventId,
            bon_id: bonId,
            vehicle_id: vehicleId,
            event_type: eventType,
            external_reference: reference,
            booking_status: status,
            estimated_cost_dkk: estimated
        };
    });
}

// ==========================================
// Sæt faktisk omkostning på bonnen (delivery_cost).
//
// args:
//   bonId, amount, source ('manual' | 'api'), userId, note
//
// Opdaterer:
//   - bons.delivery_cost
//   - bons.delivery_cost_source
//   - changelog
//   - SSE
// ==========================================
function setActualCost({ bonId, amount, source = 'manual', userId = null, note = null }) {
    if (!bonId) throw new Error('bonId påkrævet');
    if (amount == null || isNaN(Number(amount))) throw new Error('amount skal være et tal');
    if (!['manual', 'api'].includes(source)) throw new Error(`Ugyldig source: ${source}`);

    const db = getDb();
    const bon = db.prepare(`
        SELECT id, delivery_cost, delivery_cost_source FROM bons WHERE id = ?
    `).get(bonId);
    if (!bon) throw new Error(`Bon ${bonId} ikke fundet`);

    const numAmount = Math.round(Number(amount) * 100) / 100;

    return transaction(db, () => {
        db.prepare(`
            UPDATE bons
            SET delivery_cost = ?,
                delivery_cost_source = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(numAmount, source, bonId);

        logChange({
            entityType: 'bon',
            entityId: bonId,
            action: 'update',
            fieldName: 'delivery_cost',
            oldValue: bon.delivery_cost,
            newValue: numAmount,
            userId,
            notes: note || `Faktisk omkostning sat (${source})`
        });

        // Ekskluderer bevidst IKKE aktøren — bookingen sker ofte i et popout-
        // vindue, og hoveddrawer'en (samme bruger) skal opdatere.
        broadcast('bon_updated', { id: bonId });

        return {
            bon_id: bonId,
            delivery_cost: numAmount,
            delivery_cost_source: source
        };
    });
}

// ==========================================
// Annullér den aktive booking på en bon.
//
// Rydder vehicle-tildelingen (tilbage til "ikke planlagt") og logger
// en 'cancelled'-event i delivery_events. delivery_cost (faktisk pris)
// røres IKKE — hvis en faktura allerede er bogført beholdes den, og
// brugeren kan rydde den manuelt i draweren.
//
// args:
//   bonId  — påkrævet
//   userId — login-bruger (valgfri)
//   note   — fritekst-begrundelse (valgfri)
//
// Returnerer { bon_id, event_id, cancelled_vehicle_id }.
// ==========================================
function cancelBooking({ bonId, userId = null, note = null }) {
    if (!bonId) throw new Error('bonId påkrævet');

    const db = getDb();
    const bon = db.prepare(`
        SELECT id, bon_number, delivery_vehicle_id, courier_provider
        FROM bons WHERE id = ?
    `).get(bonId);
    if (!bon) throw new Error(`Bon ${bonId} ikke fundet`);
    if (!bon.delivery_vehicle_id) {
        throw new Error('Bonen har ingen aktiv booking at annullere');
    }

    const vehicle = getVehicleById(bon.delivery_vehicle_id);
    const vehicleLabel = vehicle ? vehicle.label : (bon.courier_provider || 'ukendt leverandør');
    const vehicleCode = vehicle ? vehicle.code : (bon.courier_provider || null);

    return transaction(db, () => {
        const insertResult = db.prepare(`
            INSERT INTO delivery_events
                (bon_id, event_type, provider, external_reference,
                 vehicle_id, booked_by_user_id, notes, event_time)
            VALUES (?, 'cancelled', ?, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(bonId, vehicleCode, bon.delivery_vehicle_id, userId, note);

        db.prepare(`
            UPDATE bons
            SET delivery_vehicle_id = NULL,
                delivery_method = NULL,
                courier_provider = NULL,
                delivery_cost_estimated = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(bonId);

        logChange({
            entityType: 'bon',
            entityId: bonId,
            action: 'update',
            fieldName: 'delivery_vehicle_id',
            oldValue: bon.delivery_vehicle_id,
            newValue: null,
            userId,
            notes: `Booking hos ${vehicleLabel} annulleret${note ? ` — ${note}` : ''}`
        });

        // Ekskluderer bevidst IKKE aktøren — bookingen sker ofte i et popout-
        // vindue, og hoveddrawer'en (samme bruger) skal opdatere.
        broadcast('bon_updated', { id: bonId });

        return {
            bon_id: bonId,
            event_id: Number(insertResult.lastInsertRowid),
            cancelled_vehicle_id: bon.delivery_vehicle_id
        };
    });
}

// ==========================================
// Hent booking-historik for en bon.
// Returnerer events nyeste først.
// ==========================================
function getBookingEvents(bonId) {
    return getDb().prepare(`
        SELECT
            e.id,
            e.bon_id,
            e.event_type,
            e.provider,
            e.external_reference,
            e.notes,
            e.user_id,
            e.event_time,
            e.vehicle_id,
            e.booked_by_user_id,
            v.label  AS vehicle_label,
            v.code   AS vehicle_code,
            v.type   AS vehicle_type,
            u.name   AS booked_by_name
        FROM delivery_events e
        LEFT JOIN delivery_vehicles v ON v.id = e.vehicle_id
        LEFT JOIN users u             ON u.id = e.booked_by_user_id
        WHERE e.bon_id = ?
        ORDER BY e.event_time DESC, e.id DESC
    `).all(bonId);
}

module.exports = {
    logBookingEvent,
    setActualCost,
    cancelBooking,
    getBookingEvents,
    deliveryMethodFromVehicleType,
    VALID_BOOKING_STATUSES
};
