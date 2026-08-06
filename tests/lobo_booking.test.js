// tests/lobo_booking.test.js
// Unit-tests for services/lobo_booking.js — quote + book med injiceret adapter/deps.
// Ingen DB, intet netværk.  Køres via: node --test tests/lobo_booking.test.js

const test = require('node:test');
const assert = require('node:assert');

const { quoteForBon, bookForBon, buildSurcharges, defaultBoxesForBon, composeCostEx, normalizeLoboOrder, suggestCustomerPrice } = require('../services/lobo_booking');
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

/* ── composeCostEx (grundpris + 50/kasse over inkluderede) ── */

test('composeCostEx: Lobo-grundpris + extra_box_cost × ekstra kasser', () => {
    assert.strictEqual(composeCostEx(100, 2, CONFIG, VEHICLE), 100);   // = inkl. → +0
    assert.strictEqual(composeCostEx(100, 3, CONFIG, VEHICLE), 150);   // +1×50
    assert.strictEqual(composeCostEx(100, 5, CONFIG, VEHICLE), 250);   // +3×50
    assert.strictEqual(composeCostEx(100, 1, CONFIG, VEHICLE), 100);   // under inkl. → +0
    assert.strictEqual(composeCostEx(null, 5, CONFIG, VEHICLE), null); // ingen grundpris
});

test('composeCostEx: ikke-Food (applyBoxSurcharge=false) → Lobos pris uændret (pr. km)', () => {
    // Lange ture (Medium/Large) prissættes pr. km af Lobo — INGEN 50/kasse oveni.
    assert.strictEqual(composeCostEx(358.4, 7, CONFIG, VEHICLE, false), 358.4);
    assert.strictEqual(composeCostEx(196, 5, CONFIG, VEHICLE, false), 196);
    // Food (true/default) lægger stadig kasse-tillæg til.
    assert.strictEqual(composeCostEx(196, 7, CONFIG, VEHICLE, true), 196 + 5 * 50);
});

/* ── defaultBoxesForBon ───────────────────────────────────── */

test('defaultBoxesForBon: bons.boxes har forrang når sat', () => {
    assert.strictEqual(defaultBoxesForBon({ boxes: 4, total_units: 99 }, 16), 4);
});

test('defaultBoxesForBon: udledt fra total_units / pax_per_box (rundet op, min 1)', () => {
    assert.strictEqual(defaultBoxesForBon({ total_units: 60 }, 16), 4);   // ceil(60/16)=4
    assert.strictEqual(defaultBoxesForBon({ total_units: 16 }, 16), 1);
    assert.strictEqual(defaultBoxesForBon({ total_units: 1 }, 16), 1);    // min 1
    assert.strictEqual(defaultBoxesForBon({ pax: 32 }, 16), 2);           // fallback til pax
    assert.strictEqual(defaultBoxesForBon({ total_units: 0, pax: 0 }, 16), 0); // ingen arbejdsmængde
    assert.strictEqual(defaultBoxesForBon({ boxes: 0, total_units: 50 }, 25), 2); // boxes=0 → udled
});

test('quoteForBon: uden boxes-override udledes kasse-antal fra bonen', async () => {
    let priced = null;
    const adapter = fakeAdapter({
        priceQuote: async (p) => { priced = p; return { uuid: 'd', cost_ex: 100 }; },
        deleteOrderDraft: async () => true,
    });
    // bon uden boxes, 80 enheder, 16/kasse → 5 kasser → 3 ekstra ud over 2 inkl.
    const bon = { id: 1, total_units: 80, delivery_address: { street_name: 'X', street_nr: '1', postal_code: '2200', city: 'Kbh' } };
    const q = await quoteForBon({ bon, vehicle: VEHICLE, adapter, paxPerBox: 16 });
    assert.strictEqual(q.boxes, 5);
    assert.strictEqual(q.cost_ex, 250);  // Lobo grundpris 100 + 3×50
    assert.ok(!priced.ordersurchargequantities, 'intet kasse-tillæg sendt til Lobo (vi lægger selv til)');
});

/* ── quoteForBon ──────────────────────────────────────────── */

test('quoteForBon: kostpris fra Lobo + kundepris fra vogn + margin, og kladde slettes', async () => {
    let deleted = null, priced = null;
    const adapter = fakeAdapter({
        priceQuote: async (payload) => { priced = payload; return { uuid: 'draft-1', cost_ex: 100, cost_incl: 125, routedistance: 3464, co2saving: 450 }; },
        deleteOrderDraft: async (uuid) => { deleted = uuid; return true; },
    });
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter });
    assert.strictEqual(q.cost_ex, 150);              // grundpris 100 + 1 ekstra kasse × 50
    assert.strictEqual(q.cost_incl, 187.5);          // exclToIncl(150)
    assert.strictEqual(q.customer_ex, 204);          // 154 + 1 ekstra kasse × 50
    assert.strictEqual(q.margin, 54);                // 204 − 150 (konstant base-markup)
    assert.strictEqual(q.routedistance, 3464);
    assert.strictEqual(deleted, 'draft-1', 'kladden blev slettet');
    assert.ok(!priced.ordersurchargequantities, 'intet kasse-tillæg sendt til Lobo');
    assert.strictEqual(priced.stops[0].fkplace, 3233);
});

test('quoteForBon: kasse-override → 50/kasse lægges til BÅDE kost og kundepris', async () => {
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 100, cost_incl: 125 }),
        deleteOrderDraft: async () => true,
    });
    // 5 kasser, 2 inkluderet → 3 ekstra
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter, boxes: 5 });
    assert.strictEqual(q.boxes, 5);
    assert.strictEqual(q.included_boxes, 2);
    assert.strictEqual(q.cost_ex, 250);     // 100 + 3×50 (det By-ex tager)
    assert.strictEqual(q.customer_ex, 304); // 154 + 3×50
    assert.strictEqual(q.margin, 54);       // konstant — ekstra kasser er gennemstik
});

test('quoteForBon: kasse-antal under/lig inkluderet → ingen surcharge', async () => {
    let priced = null;
    const adapter = fakeAdapter({
        priceQuote: async (p) => { priced = p; return { uuid: 'd', cost_ex: 100 }; },
        deleteOrderDraft: async () => true,
    });
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter, boxes: 2 });
    assert.strictEqual(q.boxes, 2);
    assert.strictEqual(q.cost_ex, 100);  // = inkluderede → intet kasse-tillæg
    assert.ok(!priced.ordersurchargequantities, 'intet kasse-tillæg sendt til Lobo');
});

test('quoteForBon: negativ margin rapporteres (men intet blokeres)', async () => {
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 300, cost_incl: 375 }),
        deleteOrderDraft: async () => true,
    });
    // BON = 3 kasser → 1 ekstra: kost 300+50=350, kunde 204 → margin -146
    const q = await quoteForBon({ bon: BON, vehicle: VEHICLE, adapter });
    assert.strictEqual(q.cost_ex, 350);
    assert.strictEqual(q.margin, -146);
    // Bynær tur: bytaksten gælder, så margin ER det rigtige mål.
    assert.strictEqual(q.standard_price_applies, true);
});

test('quoteForBon: uden for leveringsområdet er der ingen bypris — margin er null, forslag i stedet', async () => {
    // Drifts-tilfældet: Høje Taastrup, 18,9 km målt af Lobo, vogn dækker 8 km.
    // Før viste vi "margin −174,8 kr" målt mod bytaksten på 154 kr — et opdigtet
    // tab, for vi ville aldrig have tilbudt bytaksten så langt ude.
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 328.8, routedistance: 18900 }),
        deleteOrderDraft: async () => true,
    });
    const vehicle = { ...VEHICLE, max_distance_km: 8 };
    const q = await quoteForBon({ bon: { ...BON, boxes: 2 }, vehicle, adapter, pricing: { markup_pct: 10, round_to: 25 } });

    assert.strictEqual(q.standard_price_applies, false);
    assert.strictEqual(q.margin, null, 'ingen margin mod en pris der ikke gælder');
    assert.strictEqual(q.customer_ex, 154, 'bytaksten oplyses stadig — men gælder ikke');
    assert.strictEqual(q.suggested_customer_ex, 375, '328,80 + 10 % = 361,68 → rundet op til 375');
    assert.strictEqual(q.suggested_margin, 46.2);
});

test('quoteForBon: inden for området med positiv margin → intet forslag (bytaksten dækker)', async () => {
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 100, routedistance: 5100 }),
        deleteOrderDraft: async () => true,
    });
    const vehicle = { ...VEHICLE, max_distance_km: 8 };
    const q = await quoteForBon({ bon: { ...BON, boxes: 2 }, vehicle, adapter, pricing: { markup_pct: 10, round_to: 25 } });

    assert.strictEqual(q.standard_price_applies, true);
    assert.strictEqual(q.margin, 54);                      // 154 − 100
    assert.strictEqual(q.suggested_customer_ex, null, 'bytaksten dækker allerede — intet at foreslå');
});

test('quoteForBon: vogn uden max_distance_km → bytaksten gælder altid (bagudkompatibelt)', async () => {
    const adapter = fakeAdapter({
        priceQuote: async () => ({ uuid: 'd', cost_ex: 100, routedistance: 99000 }),
        deleteOrderDraft: async () => true,
    });
    const q = await quoteForBon({ bon: { ...BON, boxes: 2 }, vehicle: VEHICLE, adapter });
    assert.strictEqual(q.standard_price_applies, true);
    assert.strictEqual(q.margin, 54);
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
    assert.strictEqual(r.cost_ex, 150);  // grundpris 100 + 1 ekstra kasse × 50 (BON = 3 kasser)
    assert.strictEqual(calls.log.length, 1);
    assert.strictEqual(calls.log[0].status, 'booked');
    assert.strictEqual(calls.log[0].reference, 'ord-9');
    assert.ok(calls.log[0].snapshot, 'snapshot gemmes');
    assert.deepStrictEqual(calls.cost, { bonId: 3248, amount: 150, source: 'api', userId: 5 });
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

// ── normalizeLoboOrder (trin 3 — status-panel) ──
test('normalizeLoboOrder: leveret ordre → delivered + endelig pris + ETA + POD', () => {
    const n = normalizeLoboOrder({
        uuid: 'ord-1', numberformatted: '262.600.016', status: 'finished', fkcarrier: 42,
        costtotal_net: 100, costtotal_gross: 125, routedistance: 684,
        downloadlinks: { download_pod: 'https://x/pod' },
        stops: [
            { position: 1, tw_estimated_begin: 'A', tw_estimated_end: 'B' },
            { position: 2, tw_estimated_begin: 'C', tw_estimated_end: 'D' },
        ],
    });
    assert.strictEqual(n.delivered, true);
    assert.strictEqual(n.status, 'finished');
    assert.strictEqual(n.carrier, 'Bud #42');       // fkcarrier-fallback (carrier.read ikke tildelt)
    assert.strictEqual(n.cost_ex, 100);
    assert.strictEqual(n.cost_incl, 125);
    assert.strictEqual(n.has_pod, true);
    assert.deepStrictEqual(n.eta, { begin: 'C', end: 'D' });       // leverings-stop (position 2)
    assert.deepStrictEqual(n.pickup_eta, { begin: 'A', end: 'B' });
});

test('normalizeLoboOrder: planlagt ordre → ikke leveret, pris fra accounting-embed', () => {
    const n = normalizeLoboOrder({
        uuid: 'ord-2', status: 'planned',
        accounting: { costtotal_net: 150, costtotal_gross: 187.5 },
        stops: [{ position: 1 }, { position: 2, tw_estimated_end: 'E' }],
    });
    assert.strictEqual(n.delivered, false);
    assert.strictEqual(n.cost_ex, 150);             // fallback til accounting.costtotal_net
    assert.strictEqual(n.has_pod, false);
    assert.strictEqual(n.carrier, null);
});

test('normalizeLoboOrder: signeret leverings-stop tæller som leveret', () => {
    const n = normalizeLoboOrder({ uuid: 'ord-3', status: 'open', stops: [{ position: 1 }, { position: 2, signed: 1 }] });
    assert.strictEqual(n.delivered, true);
});

test('normalizeLoboOrder: null/tom → null', () => {
    assert.strictEqual(normalizeLoboOrder(null), null);
    assert.strictEqual(normalizeLoboOrder(undefined), null);
});

test('suggestCustomerPrice: lange ture → kostpris + markup rundet op (positiv margin)', () => {
    assert.strictEqual(suggestCustomerPrice(358.4, 200, 10, 25), 400);  // 358.4×1.1=394.2 → op til 400
    assert.strictEqual(suggestCustomerPrice(196, 100, 10, 25), 225);    // 215.6 → 225
    assert.strictEqual(suggestCustomerPrice(200, 200, 10, 25), 225);    // = → 220 → 225
    assert.strictEqual(suggestCustomerPrice(100, 200, 10, 25), null);   // standard dækker → ingen anbefaling
    assert.strictEqual(suggestCustomerPrice(null, 200, 10, 25), null);  // ingen kostpris
});
