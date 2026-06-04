// services/lobo_booking.js
// ==========================================
// Booking-orchestrering for Byekspressen/Lobo (Fase B).
//
// Holder route-laget tyndt og gør logikken unit-testbar: adapter + DB-write-deps
// injiceres, så hele flowet kan testes uden netværk eller DB.
//
// - quoteForBon: pris-tilbud via orderdraft (opretter + sletter kladde — INGEN ordre).
// - bookForBon:  rigtig booking via POST /orders + skriv bon/delivery_events.
//
// Spec: docs/CLAUDE_LEVERING_LOBO.md §7-9.
// ==========================================

const { extractCostEx, bonToOrderInput } = require('./byExpressenAdapter');
const { estimateCost } = require('./booking_template');

// Ekstra-kasse-tillæg → ordersurchargequantities. cfg fra vognens booking_api_config.
function buildSurcharges(bon, cfg = {}) {
    const boxes = Number(bon.boxes) || 0;
    const out = [];
    if (cfg.extra_box_surcharge_id) {
        const included = Number(cfg.included_boxes) || 0;
        const extra = Math.max(0, boxes - included);
        if (extra > 0) out.push({ fksurcharge: cfg.extra_box_surcharge_id, quantity: extra });
    }
    return out;
}

// Pris-tilbud: opret orderdraft → læs Lobos kostpris → slet kladden igen.
// Returnerer kostpris (ex/incl), kundepris (fra vognens cost_formula) + margin.
async function quoteForBon({ bon, vehicle, adapter }) {
    const cfg = adapter.config || {};
    const input = bonToOrderInput(bon, { pickupNote: 'pris-tjek', surcharges: buildSurcharges(bon, cfg) });
    const payload = adapter.buildOrderPayload(input);

    const quote = await adapter.priceQuote(payload);
    if (quote && quote.uuid) {
        try { await adapter.deleteOrderDraft(quote.uuid); } catch { /* kladden udløber selv efter 5 min */ }
    }

    const costEx = quote.cost_ex;
    const customerEx = vehicle ? (estimateCost(vehicle, bon) ?? null) : null;
    const margin = (customerEx != null && costEx != null)
        ? Math.round((customerEx - costEx) * 100) / 100
        : null;

    return {
        cost_ex: costEx,
        cost_incl: quote.cost_incl,
        customer_ex: customerEx,
        margin,                          // advarsel-grundlag (negativ = vi taber) — blokerer ALDRIG
        routedistance: quote.routedistance,
        co2saving: quote.co2saving,
    };
}

// Rigtig booking: POST /orders → skriv delivery_events (booked + snapshot) +
// bons.delivery_cost (api) + SSE. Ved Lobo-fejl logges et 'failed'-event.
async function bookForBon({ bon, vehicle, adapter, userId = null, deps = {} }) {
    const logBookingEvent = deps.logBookingEvent || require('./delivery_log').logBookingEvent;
    const setActualCost = deps.setActualCost || require('./delivery_log').setActualCost;
    const broadcast = deps.broadcast || require('../shared/sse').broadcast;

    const cfg = adapter.config || {};
    const input = bonToOrderInput(bon, { surcharges: buildSurcharges(bon, cfg) });
    const payload = adapter.buildOrderPayload(input);

    let order;
    try {
        order = await adapter.bookOrder(payload);
    } catch (e) {
        try {
            await logBookingEvent({ bonId: bon.id, vehicleId: vehicle.id, status: 'failed', userId, note: `Lobo-fejl: ${e.message}` });
        } catch { /* fejl-logning må ikke skygge for den oprindelige fejl */ }
        throw e;
    }

    const costEx = extractCostEx(order);
    await logBookingEvent({
        bonId: bon.id, vehicleId: vehicle.id, reference: order.uuid,
        status: 'booked', userId, snapshot: order,
    });
    if (costEx != null) {
        setActualCost({ bonId: bon.id, amount: costEx, source: 'api', userId });
    }
    broadcast('delivery_event', { bon_id: bon.id, external_reference: order.uuid, status: 'booked' });

    return { uuid: order.uuid, cost_ex: costEx, order };
}

module.exports = { quoteForBon, bookForBon, buildSurcharges };
