// tests/lobo_booking.test.js
// Unit-tests for services/lobo_booking.js — quote + book med injiceret adapter/deps.
// Ingen DB, intet netværk.  Køres via: node --test tests/lobo_booking.test.js

const test = require('node:test');
const assert = require('node:assert');

const { quoteForBon, bookForBon, buildSurcharges } = require('../services/lobo_booking');
const { createByExpressenAdapter } = require('../services/byExpressenAdapter');

const CONFIG = {
    base_url: 'https://x/', use_sandbox: false,
    customernumber: 18062101, fkproduct: 39, hq_fkplace: 3233,
    extra_box_surcharge_id: 389, included_boxes: 2,
};

// En adapter med ægte buildOrderPayload, men stubbet HTTP-lag.
function fakeAdapter(handlers = {}) {
    const a = createByExpressenAdapter({
        config: CONFIG, credentials: { user: 'u', pass: 'p' },
        fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    });
    return { ...a, ...handlers, config: CONFIG };
}

const VEHICLE = { code: 'byekspressen', id: 7, cost_formula_json: JSON.stringify({ standard_inner_city: 154, included_boxes: 2, extra_box_cost: 50 }) };
const BON = {
    id: 3248, bon_number: 'B3248', boxes: 3, delivery_notes: 'opg. 6',
    day_contact_name: 'Anne',
    delivery_address: { street_name: 'Bryghuspladsen', street_nr: '8', postal_code: '1473', city: 'København' },
};

/* ── buildSurcharges ──────────────────────────────────────── */

test('buildSurcharges: ekstra kasser ud over included → surcharge 389', () => {
    assert.deepStrictEqual(buildSurcharges({ boxes: 3 }, CONFIG), [{ fksurcharge: 389, quantity: 1 }]);
    assert.deepStrictEqual(buildSurcharges({ boxes: 2 }, CONFIG), []); // = included → ingen
    assert.deepStrictEqual(buildSurcharges({ boxes: 1 }, CONFIG), []);
    assert.deepStrictEqual(buildSurcharges({ boxes: 5 }, { extra_box_surcharge_id: 389, included_boxes: 0 }), [{ fksurcharge: 389, quantity: 5 }]);
});

/* ── quoteForBon ──────────────────────────────────────────── */

test('quoteForBon: kostpris fra Lobo + kundepris fra vogn + margin, og kladde slettes', async () => {
    let deleted = null, priced = null;
    const adapter = fakeAdapter({
        priceQuote: async (payload) => { priced = payload; return { uuid: 'draft-1', cost_ex: 100, cost_incl: 125, routedistance: 3464, co2saving: 450 }; },
        deleteOrderDraft: async (uuid) => { deleted = uuid; return true; },
    });
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter });
    assert.strictEqual(q.cost_ex, 100);
    assert.strictEqual(q.customer_ex, 204);          // 154 + 1 ekstra kasse × 50
    assert.strictEqual(q.margin, 104);               // 204 − 100
    assert.strictEqual(q.routedistance, 3464);
    assert.strictEqual(deleted, 'draft-1', 'kladden blev slettet');
    // payloaden indeholdt surcharge for den ekstra kasse
    assert.deepStrictEqual(priced.ordersurchargequantities, [{ fksurcharge: 389, quantity: 1 }]);
    assert.strictEqual(priced.stops[0].fkplace, 3233);
});

test('quoteForBon: negativ margin rapporteres (men intet blokeres)', async () => {
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 300, cost_incl: 375 }),
        deleteOrderDraft: async () => true,
    });
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter });
    assert.strictEqual(q.margin, -96); // 204 − 300
});

/* ── bookForBon ───────────────────────────────────────────── */

test('bookForBon: booker, skriver delivery_event(booked+snapshot) + actual cost + SSE', async () => {
    const calls = { log: [], cost: null, sse: null };
    const adapter = fakeAdapter({ bookOrder: async () => ({ uuid: 'ord-9', costtotal_net: 100, status: 'open' }) });
    const deps = {
        logBookingEvent: async (a) => { calls.log.push(a); },
        setActualCost: (a) => { calls.cost = a; },
        broadcast: (ev, d) => { calls.sse = { ev, d }; },
    };
    const r = await bookForBon({ bon: BON, vehicle: VEHICLE, adapter, userId: 5, deps });
    assert.strictEqual(r.uuid, 'ord-9');
    assert.strictEqual(r.cost_ex, 100);
    assert.strictEqual(calls.log.length, 1);
    assert.strictEqual(calls.log[0].status, 'booked');
    assert.strictEqual(calls.log[0].reference, 'ord-9');
    assert.ok(calls.log[0].snapshot, 'snapshot gemmes');
    assert.deepStrictEqual(calls.cost, { bonId: 3248, amount: 100, source: 'api', userId: 5 });
    assert.strictEqual(calls.sse.ev, 'delivery_event');
    assert.strictEqual(calls.sse.d.bon_id, 3248);
});

test('bookForBon: Lobo-fejl → logger failed-event og kaster videre', async () => {
    const logged = [];
    const adapter = fakeAdapter({ bookOrder: async () => { const e = new Error('boom'); throw e; } });
    const deps = { logBookingEvent: async (a) => { logged.push(a); }, setActualCost: () => {}, broadcast: () => {} };
    await assert.rejects(() => bookForBon({ bon: BON, vehicle: VEHICLE, adapter, userId: 1, deps }), /boom/);
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].status, 'failed');
});
