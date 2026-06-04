// tests/lobo_webhook.test.js
// Unit-tests for services/lobo_webhook.js — verifikation + event-anvendelse.
// Fake db (ingen sqlite/netværk).  Køres via: node --test tests/lobo_webhook.test.js

const test = require('node:test');
const assert = require('node:assert');

const { verifyLoboRequest, applyWebhookEvent } = require('../services/lobo_webhook');
const { computeHmac } = require('../services/byExpressenAdapter');

// Minimal fake-db der dækker præcis de queries applyWebhookEvent bruger.
function fakeDb(seed = []) {
    const events = seed.map((e, i) => ({ id: i + 1, ...e }));
    let id = events.length;
    return {
        events,
        prepare(sql) {
            return {
                get: (...a) => {
                    if (sql.includes('SELECT bon_id')) {
                        const e = events.find(x => x.external_reference === a[0]);
                        return e ? { bon_id: e.bon_id } : undefined;
                    }
                    if (sql.includes('SELECT 1')) {
                        return events.find(x => x.external_reference === a[0] && x.notes === a[1]) ? 1 : undefined;
                    }
                    return undefined;
                },
                run: (...a) => {
                    if (sql.includes("'booked', 'byekspressen'")) {
                        events.push({ id: ++id, bon_id: a[0], event_type: 'booked', external_reference: a[1], notes: a[2] });
                    } else {
                        events.push({ id: ++id, bon_id: a[0], event_type: a[1], external_reference: a[2], notes: a[3], snapshot_json: a[4] });
                    }
                    return { lastInsertRowid: id };
                },
            };
        },
    };
}

const seededBooking = [{ bon_id: 3248, event_type: 'booked', external_reference: 'ord-9', notes: null }];
function collectSSE() { const out = []; return { fn: (ev, d) => out.push({ ev, d }), out }; }

/* ── verifyLoboRequest ────────────────────────────────────── */

test('verifyLoboRequest: verifikation slået fra → springes over (ok)', () => {
    const r = verifyLoboRequest({ rawQuery: 'a=1', headers: {}, settings: { verify: '0' } });
    assert.deepStrictEqual([r.ok, r.skipped], [true, true]);
});

test('verifyLoboRequest: korrekt HMAC accepteres, forkert afvises', () => {
    const key = 'deadbeef';
    const rawQuery = 'ts=1&event=dispatched&target=order&orderuuid=ord-9';
    const sig = computeHmac(rawQuery, key);
    const base = { rawQuery, settings: { verify: '1', sig_header: 'x-lobo-signature', hmac_key: key } };
    assert.strictEqual(verifyLoboRequest({ ...base, headers: { 'x-lobo-signature': sig } }).ok, true);
    assert.strictEqual(verifyLoboRequest({ ...base, headers: { 'x-lobo-signature': 'bad' } }).ok, false);
    assert.strictEqual(verifyLoboRequest({ rawQuery, headers: {}, settings: { verify: '1' } }).ok, false); // ingen nøgle
});

/* ── applyWebhookEvent ────────────────────────────────────── */

test('applyWebhookEvent: ukendt ordre afvises', async () => {
    const db = fakeDb([]);
    const r = await applyWebhookEvent({ query: { event: 'dispatched', orderuuid: 'x', ts: '1' }, db, broadcast: () => {} });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'unknown_order']);
});

test('applyWebhookEvent: dispatched → assigned, event indsat + SSE', async () => {
    const db = fakeDb(seededBooking);
    const sse = collectSSE();
    const r = await applyWebhookEvent({ query: { event: 'dispatched', orderuuid: 'ord-9', ts: '100' }, db, broadcast: sse.fn });
    assert.strictEqual(r.status, 'assigned');
    assert.strictEqual(r.bon_id, 3248);
    assert.ok(db.events.some(e => e.event_type === 'assigned'));
    assert.deepStrictEqual(sse.out[0], { ev: 'delivery_event', d: { bon_id: 3248, external_reference: 'ord-9', status: 'assigned' } });
});

test('applyWebhookEvent: idempotens — samme (uuid,event,ts) kun én gang', async () => {
    const db = fakeDb(seededBooking);
    const q = { event: 'dispatched', orderuuid: 'ord-9', ts: '100' };
    await applyWebhookEvent({ query: q, db, broadcast: () => {} });
    const before = db.events.length;
    const r2 = await applyWebhookEvent({ query: q, db, broadcast: () => {} });
    assert.strictEqual(r2.reason, 'duplicate');
    assert.strictEqual(db.events.length, before, 'ingen dublet indsat');
});

test('applyWebhookEvent: trashed → cancelled, finished → delivered', async () => {
    const db1 = fakeDb(seededBooking);
    assert.strictEqual((await applyWebhookEvent({ query: { event: 'trashed', orderuuid: 'ord-9', ts: '1' }, db: db1, broadcast: () => {} })).status, 'cancelled');
    const db2 = fakeDb(seededBooking);
    assert.strictEqual((await applyWebhookEvent({ query: { event: 'finished', orderuuid: 'ord-9', ts: '1' }, db: db2, broadcast: () => {} })).status, 'delivered');
});

test('applyWebhookEvent: stopvisitedorsigned disambigueres via stops', async () => {
    // sidste stop besøgt → delivered
    const dbD = fakeDb(seededBooking);
    const rD = await applyWebhookEvent({
        query: { event: 'stopvisitedorsigned', orderuuid: 'ord-9', ts: '1' }, db: dbD, broadcast: () => {},
        getOrder: async () => ({ stops: [{ position: 1, visited: 'x' }, { position: 2, visited: 'x' }] }),
    });
    assert.strictEqual(rD.status, 'delivered');
    // kun første stop besøgt → picked_up
    const dbP = fakeDb(seededBooking);
    const rP = await applyWebhookEvent({
        query: { event: 'stopvisitedorsigned', orderuuid: 'ord-9', ts: '2' }, db: dbP, broadcast: () => {},
        getOrder: async () => ({ stops: [{ position: 1, visited: 'x' }, { position: 2, visited: '' }] }),
    });
    assert.strictEqual(rP.status, 'picked_up');
});

test('applyWebhookEvent: changed → ingen status-ændring (men markeret behandlet)', async () => {
    const db = fakeDb(seededBooking);
    const sse = collectSSE();
    const r = await applyWebhookEvent({ query: { event: 'changed', orderuuid: 'ord-9', ts: '1' }, db, broadcast: sse.fn });
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.reason, 'no_status_change');
    assert.strictEqual(sse.out.length, 0, 'ingen SSE ved note-event');
});
