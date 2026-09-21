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
const { boxCountSql } = require('./deliveryBoxes');
const { getDistance } = require('./routing');
const { getHqCoords, getSafetyMargin, shiftTime } = require('./delivery_calc');

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
// computePickupTime(bon, vehicle) → "HH:MM" | null
//
// Returnerer den afhentningstid bonen SKAL have for den valgte vogn:
//   - delivery_type='pickup'  → bon.delivery_time (kunden afhenter selv)
//   - vehicle.pickup_lead_min → delivery_time − pickup_lead_min (fx By-expressen 45 min)
//   - ellers (Taxa/Volvo/Egen cykel) → delivery_time − (køretid + sikkerhedsmargin)
//
// Returnerer null hvis grundlaget mangler (ingen delivery_time, ingen coords
// på leveringsadressen, ORS utilgængelig osv.) — kalderen overskriver
// IKKE en eksisterende pickup_time i den situation.
// ==========================================
async function computePickupTime(bon, vehicle) {
    if (!bon || !vehicle) return null;

    // Afhentning: kunden henter selv ved levering_time. Triggeren i
    // migration 076 holder denne invariant ved INSERT/UPDATE af
    // delivery_type/delivery_time, men vi sætter også her for at have
    // én sandhed gennem book-flowet.
    if (bon.delivery_type === 'pickup') {
        return bon.delivery_time || null;
    }

    if (!bon.delivery_time) return null;

    // Fast lead-tid (By-expressen 45 min, etc.)
    if (vehicle.pickup_lead_min != null) {
        return shiftTime(bon.delivery_time, -Number(vehicle.pickup_lead_min));
    }

    // Køretids-baseret: hent afstand. Foretrækker cachet værdi
    // (geo_calculations) så vi ikke laver ORS-kald midt i en booking.
    // getDistance() læser cachen først når addressId er givet.
    if (!bon.delivery_address_id) return null;

    const hq = getHqCoords();
    if (!hq) return null;

    const addr = getDb().prepare(`
        SELECT id, lat, lon FROM addresses WHERE id = ?
    `).get(bon.delivery_address_id);
    if (!addr || addr.lat == null || addr.lon == null) return null;

    let distance;
    try {
        distance = await getDistance(
            { lat: hq.lat, lon: hq.lon },
            { lat: addr.lat, lon: addr.lon },
            { addressId: addr.id }
        );
    } catch (e) {
        // ORS utilgængelig: leave pickup_time alone.
        return null;
    }

    const durationMin = Math.ceil(distance.duration_s / 60);
    return shiftTime(bon.delivery_time, -(durationMin + getSafetyMargin()));
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
async function logBookingEvent({ bonId, vehicleId, reference = null, status = 'booked', userId = null, note = null, snapshot = null }) {
    if (!bonId) throw new Error('bonId påkrævet');
    if (!vehicleId) throw new Error('vehicleId påkrævet');
    if (!VALID_BOOKING_STATUSES.has(status)) {
        throw new Error(`Ugyldig status: ${status}. Skal være en af: ${[...VALID_BOOKING_STATUSES].join(', ')}`);
    }

    const db = getDb();
    const vehicle = getVehicleById(vehicleId);
    if (!vehicle) throw new Error(`Vehicle ${vehicleId} ikke fundet`);

    // Kasse-antallet tælles i queryen: kolonnen bons.boxes er tom i drift, og
    // tallet ligger på bonnens transportkasse-linjer (services/deliveryBoxes.js).
    // Subqueryens parametre står i SELECT-listen og skal derfor bindes FØR bonId.
    const box = boxCountSql('b');
    const bon = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_vehicle_id, b.delivery_cost_estimated,
               ${box.sql} AS boxes,
               b.pax, b.delivery_type, b.delivery_time, b.pickup_time,
               b.delivery_address_id
        FROM bons b WHERE b.id = ?
    `).get(...box.args, bonId);
    if (!bon) throw new Error(`Bon ${bonId} ikke fundet`);

    // Beregn ny pickup_time uden for transaction (async ORS-kald hvis nødvendigt).
    // En fejlet booking (`status='failed'`) skal IKKE flytte afhentningstiden.
    let newPickupTime = null;
    if (status !== 'failed') {
        try {
            newPickupTime = await computePickupTime(bon, vehicle);
        } catch (e) {
            console.warn(`[delivery_log] computePickupTime fejlede for bon ${bonId}: ${e.message}`);
        }
    }

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
                 vehicle_id, booked_by_user_id, notes, snapshot_json, event_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            bonId,
            eventType,
            vehicle.code,
            reference,
            vehicleId,
            userId,
            noteWithStatus,
            snapshot ? JSON.stringify(snapshot) : null
        );

        const eventId = insertResult.lastInsertRowid;

        // Opdater bonnen — vehicle_id sættes altid (sidste valgte vehicle)
        // delivery_method synkroniseres fra vehicle.type så lister/filtre stadig virker
        // Estimat skrives kun hvis bonnen ikke allerede har faktisk pris
        // bon.boxes er her det TALTE antal (se queryen ovenfor), så leverandørens
        // kasse-tillæg fyrer — og det gemte estimat matcher det popoutet viste.
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

        // Auto-sæt afhentningstid hvis vi kunne beregne en. Overskriver
        // eksisterende værdi — bookingen er en bevidst handling, og
        // brugeren kan altid efter-rette i draweren. Springer over hvis:
        //   - status='failed' (newPickupTime sat til null før transaction)
        //   - computePickupTime returnerede null (manglende grundlag)
        //   - værdien er den samme som nu (undgår støj i changelog)
        if (newPickupTime && newPickupTime !== bon.pickup_time) {
            db.prepare(`
                UPDATE bons SET pickup_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).run(newPickupTime, bonId);

            const reason = vehicle.pickup_lead_min != null
                ? `${vehicle.label}: ${vehicle.pickup_lead_min} min før levering`
                : `køretid + sikkerhedsmargin`;
            logChange({
                entityType: 'bon',
                entityId: bonId,
                action: 'update',
                fieldName: 'pickup_time',
                oldValue: bon.pickup_time,
                newValue: newPickupTime,
                userId,
                notes: `Auto-sat ved booking (${reason})`
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
            estimated_cost_dkk: estimated,
            pickup_time: newPickupTime || bon.pickup_time
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
        SELECT id, delivery_cost, delivery_cost_source, delivery_price FROM bons WHERE id = ?
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

        // Auto-udfyld kundepris (delivery_price) = kostpris + markup, så den ikke
        // skal sættes manuelt. Overskriver ALDRIG en allerede sat kundepris med
        // positiv margin (suggestCustomerPrice returnerer null i så fald).
        try {
            const { suggestCustomerPrice } = require('./lobo_booking');
            const { inclToExcl, exclToIncl } = require('../shared/moms');
            const getNum = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r && r.value !== '' ? Number(r.value) : null; };
            const markupPct = getNum('lobo_customer_markup_pct') ?? 10;
            const roundTo   = getNum('lobo_customer_round_to') ?? 25;
            const currentEx = bon.delivery_price > 0 ? inclToExcl(bon.delivery_price) : null;
            const suggestedEx = suggestCustomerPrice(numAmount, currentEx, markupPct, roundTo);  // numAmount = kostpris EX moms
            if (suggestedEx != null) {
                const incl = Math.round(exclToIncl(suggestedEx) * 100) / 100;   // delivery_price er INCL moms
                db.prepare(`UPDATE bons SET delivery_price = ? WHERE id = ?`).run(incl, bonId);
                logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'delivery_price',
                    oldValue: bon.delivery_price, newValue: incl, userId, notes: `Auto-foreslået kundepris (kostpris ${numAmount} + ${markupPct}%)` });
            }
        } catch (e) { /* markup-helper utilgængelig → spring auto-udfyld over */ }

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
    computePickupTime,
    deliveryMethodFromVehicleType,
    VALID_BOOKING_STATUSES
};
