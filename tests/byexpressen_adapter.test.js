// tests/byexpressen_adapter.test.js
// Unit-tests for services/byExpressenAdapter.js — Fase A.
// Mocker fetch (ingen live-API). Verificerer auth, token-cache, request-shapes,
// HMAC-webhook-verifikation og event-mapping mod den rigtige Lobo-fixture.
//
// Køres via:  node --test tests/byexpressen_adapter.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    createByExpressenAdapter,
    ByExpressenError,
    extractCostEx,
    computeHmac,
    verifyWebhookSignature,
    mapLoboEvent,
    decodeJwtPayload,
} = require('../services/byExpressenAdapter');

/* ── Testhjælpere ─────────────────────────────────────────── */

// Lav et fake (usigneret) JWT med given payload — kun base64url-payload bruges.
function makeJwt(payload) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ typ: 'JWT', alg: 'HS256' })}.${b64(payload)}.sig`;
}

// Response-lignende objekt som adapteren forventer (status/ok/json()).
function resp(status, jsonBody) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => jsonBody,
    };
}

// Stateful mock: handler(url, init, callIndex) → resp(...). Optager alle kald.
function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const i = calls.length;
        calls.push({ url, init });
        return handler(url, init, i);
    };
    fn.calls = calls;
    return fn;
}

const CONFIG = {
    base_url: 'https://byexpressen.lobolink.eu/lobo/api/v3/public/',
    sandbox_url: 'https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/',
    use_sandbox: true,
    customernumber: 18062101,   // RR's kundenummer (de bruger customernumber, ikke fkcustomer)
    fkproduct: 39,              // RR's Kbh-cykelbud (fra RR-eksemplet)
    hq_fkplace: 3233,           // Ristet Rug (Nørrebro) som gemt sted
};
const CREDS = { user: 'ristetrug18062101', pass: 'hemmelig' };

function makeAdapter(handler, { now } = {}) {
    return createByExpressenAdapter({
        config: CONFIG,
        credentials: CREDS,
        fetchImpl: mockFetch(handler),
        now,
    });
}

/* ── AUTH / TOKEN ─────────────────────────────────────────── */

test('getToken bruger Basic Auth mod sandbox-base og returnerer token', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url, init) => {
        assert.ok(url.endsWith('/sandbox/api/v3/public/token'), 'rammer sandbox /token: ' + url);
        assert.strictEqual(init.method, 'POST');
        assert.match(init.headers.Authorization, /^Basic /);
        const decoded = Buffer.from(init.headers.Authorization.slice(6), 'base64').toString();
        assert.strictEqual(decoded, 'ristetrug18062101:hemmelig');
        return resp(201, { status: 'ok', token: tok });
    });
    const t = await adapter.getToken();
    assert.strictEqual(t, tok);
});

test('getToken ANMODER scopes i body (ellers scope:[] → 403 på alt)', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    let body = null;
    const adapter = makeAdapter((url, init) => {
        assert.ok(url.endsWith('/token'));
        body = JSON.parse(init.body);
        return resp(201, { status: 'ok', token: tok });
    });
    await adapter.getToken();
    assert.ok(Array.isArray(body), 'body er et scope-array');
    assert.ok(body.includes('order.create'), 'indeholder booking-scopes');
    assert.ok(body.includes('address.verify'));
    assert.ok(body.includes('webhook.create'));
});

test('getToken bruger config.scopes hvis sat', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    let body = null;
    const adapter = createByExpressenAdapter({
        config: { ...CONFIG, scopes: ['product.read', 'order.read'] },
        credentials: CREDS,
        fetchImpl: mockFetch((url, init) => { body = JSON.parse(init.body); return resp(201, { status: 'ok', token: tok }); }),
    });
    await adapter.getToken();
    assert.deepStrictEqual(body, ['product.read', 'order.read']);
});

test('getToken cacher token og kalder ikke /token igen før udløb', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const fetchImpl = mockFetch(() => resp(201, { status: 'ok', token: tok }));
    const adapter = createByExpressenAdapter({ config: CONFIG, credentials: CREDS, fetchImpl });
    await adapter.getToken();
    await adapter.getToken();
    await adapter.getToken();
    const tokenCalls = fetchImpl.calls.filter(c => c.url.endsWith('/token'));
    assert.strictEqual(tokenCalls.length, 1, 'kun ét /token-kald pga. cache');
});

test('getToken re-auther når cachet token er tæt på udløb', async () => {
    const shortTok = makeJwt({ exp: 1000 });   // for længst udløbet ift. fast now
    const freshTok = makeJwt({ exp: 9_999_999_999 });
    let nowMs = 2000 * 1000;
    const fetchImpl = mockFetch(() => resp(201, { status: 'ok', token: nowMs < 3000 * 1000 ? shortTok : freshTok }));
    const adapter = createByExpressenAdapter({ config: CONFIG, credentials: CREDS, fetchImpl, now: () => nowMs });
    const a = await adapter.getToken();
    nowMs = 5000 * 1000; // ryk tid frem forbi shortTok-udløb
    const b = await adapter.getToken();
    assert.notStrictEqual(a, b, 'nyt token hentet efter udløb');
    assert.strictEqual(fetchImpl.calls.length, 2);
});

test('getToken kaster auth_failed ved 401', async () => {
    const adapter = makeAdapter(() => resp(401, { status: 'error', message: 'Authentication failed' }));
    await assert.rejects(() => adapter.getToken(), (e) => {
        assert.ok(e instanceof ByExpressenError);
        assert.strictEqual(e.status, 401);
        assert.strictEqual(e.code, 'auth_failed');
        return true;
    });
});

/* ── AUTHED FETCH (Bearer, 403, 401-retry, 204) ───────────── */

test('authede kald sender Bearer-token', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        assert.strictEqual(init.headers.Authorization, 'Bearer ' + tok);
        return resp(200, { data: [], meta: { count: 0 } });
    });
    await adapter.getProducts();
});

test('403 oversættes til no_scope-fejl med Lobo-besked', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        return resp(403, { status: 'error [Forbidden]', message: "Not in scope: token is not allowed to 'GET' /products" });
    });
    await assert.rejects(() => adapter.getProducts(), (e) => {
        assert.strictEqual(e.status, 403);
        assert.strictEqual(e.code, 'no_scope');
        assert.match(e.message, /Not in scope/);
        return true;
    });
});

test('401 på resource → re-auth én gang og retry', async () => {
    const tok1 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const tok2 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600, jti: '2' });
    let tokenCalls = 0;
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) { tokenCalls++; return resp(201, { status: 'ok', token: tokenCalls === 1 ? tok1 : tok2 }); }
        // første resource-kald (med tok1) → 401; andet (med tok2) → 200
        if (init.headers.Authorization === 'Bearer ' + tok1) return resp(401, { message: 'expired' });
        return resp(200, { data: [{ id: 1 }] });
    });
    const data = await adapter.getProducts();
    assert.deepStrictEqual(data, [{ id: 1 }]);
    assert.strictEqual(tokenCalls, 2, 're-auth skete én gang');
});

test('204 (DELETE) håndteres uden body-parse', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        return { status: 204, ok: true, json: async () => { throw new Error('ingen body'); } };
    });
    assert.strictEqual(await adapter.cancelOrder('abc'), true);
});

/* ── ADRESSE ──────────────────────────────────────────────── */

test('verifyAddress POSTer korrekt body og returnerer data[0] (med fkplace)', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        assert.ok(url.endsWith('/addresses/verify'));
        assert.strictEqual(init.method, 'POST');
        const b = JSON.parse(init.body);
        assert.deepStrictEqual(b, { street: 'Nørrebrogade', housenumber: 40, zip: '2200', city: 'København', isocode: 'DNK' });
        return resp(200, { data: [{ fkplace: 2409, placetype: 'address', city: 'København' }], meta: { count: 1 } });
    });
    const place = await adapter.verifyAddress({ street: 'Nørrebrogade', housenumber: 40, zip: '2200', city: 'København' });
    assert.strictEqual(place.fkplace, 2409);
});

/* ── ORDRE-BODY (ren funktion) ────────────────────────────── */

test('buildOrderPayload: HQ-fkplace pickup + inline kunde-adresse + external_api_id', () => {
    const adapter = createByExpressenAdapter({ config: CONFIG, credentials: CREDS, fetchImpl: mockFetch(() => resp(200, {})) });
    const body = adapter.buildOrderPayload({
        reftime: '2026-06-10T12:00:00+02:00',
        external_api_id: 3248,
        pickupNote: 'kl. 11, 3 kasser',
        delivery: { street: 'Bryghuspladsen', housenumber: 8, zip: '1473', city: 'København', contactperson: 'Test Jozsi' },
        deliveryDeadlineIso: '2026-06-10T12:00:00+02:00',
        deliveryNote: 'opg. 6',
        surcharges: [{ fksurcharge: 2, quantity: 1 }, { fksurcharge: 9, quantity: 0 }],
    });
    assert.strictEqual(body.customernumber, 18062101);   // RR bruger customernumber
    assert.strictEqual(body.fkproduct, 39);
    assert.strictEqual(body.external_api_id, '3248');    // altid string
    assert.ok(!('fkpayment' in body), 'fkpayment udeladt når ikke sat i config');
    assert.strictEqual(body.stops.length, 2);
    assert.strictEqual(body.stops[0].fkplace, 3233);     // HQ default fra config.hq_fkplace
    assert.strictEqual(body.stops[0].notepublic, 'kl. 11, 3 kasser');
    assert.strictEqual(body.stops[1].street, 'Bryghuspladsen');   // inline-adresse
    assert.strictEqual(body.stops[1].contactperson, 'Test Jozsi');
    assert.strictEqual(body.stops[1].tw_fixed_end, '2026-06-10T12:00:00+02:00');
    assert.strictEqual(body.ordersurchargequantities.length, 1, 'quantity=0 frasorteres');
    assert.strictEqual(body.ordersurchargequantities[0].fksurcharge, 2);
});

test('buildOrderPayload med fkplace-leverings-stop', () => {
    const adapter = createByExpressenAdapter({ config: CONFIG, credentials: CREDS, fetchImpl: mockFetch(() => resp(200, {})) });
    const body = adapter.buildOrderPayload({ delivery: { fkplace: 2409 } });
    assert.strictEqual(body.stops[1].fkplace, 2409);
    assert.ok(!('street' in body.stops[1]));
});

test('buildOrderPayload matcher RR-eksemplets struktur (rr_order_example.json)', () => {
    const rr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lobo/rr_order_example.json'), 'utf8')).request;
    const adapter = createByExpressenAdapter({ config: CONFIG, credentials: CREDS, fetchImpl: mockFetch(() => resp(200, {})) });
    const body = adapter.buildOrderPayload({
        external_api_id: '1008',
        pickupNote: 'kl. 11, 3 kasser',
        delivery: { contactperson: 'Test Jozsi', street: 'Bryghuspladsen', housenumber: 8, addition: '', zip: '1473', city: 'København' },
        deliveryNote: 'Leif',
    });
    assert.strictEqual(body.customernumber, rr.customernumber);
    assert.strictEqual(body.fkproduct, rr.fkproduct);
    assert.strictEqual(body.external_api_id, rr.external_api_id);
    assert.strictEqual(body.stops[0].fkplace, rr.stops[0].fkplace);
    assert.strictEqual(body.stops[1].street, rr.stops[1].street);
    assert.strictEqual(body.stops[1].contactperson, rr.stops[1].contactperson);
});

/* ── ORDRE / WEBHOOK-kald (url+metode) ────────────────────── */

test('bookOrder POSTer mod /orders og returnerer ordren', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        assert.ok(url.endsWith('/orders'));
        assert.strictEqual(init.method, 'POST');
        return resp(201, { data: [{ uuid: 'abc-123', status: 'open' }] });
    });
    const o = await adapter.bookOrder({ fkcustomer: 1 });
    assert.strictEqual(o.uuid, 'abc-123');
});

test('registerWebhook sender target=order + event + url og returnerer hmac_key', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        assert.ok(url.endsWith('/webhooks'));
        const b = JSON.parse(init.body);
        assert.strictEqual(b.target, 'order');
        assert.strictEqual(b.event, 'dispatched');
        assert.strictEqual(b.url, 'https://bon.ristetrug.dk/api/webhooks/lobo');
        return resp(200, { data: [{ id: 3, hmac_key: 'deadbeef', hmac_algorithm: 'sha256' }] });
    });
    const wh = await adapter.registerWebhook('dispatched', 'https://bon.ristetrug.dk/api/webhooks/lobo');
    assert.strictEqual(wh.hmac_key, 'deadbeef');
});

/* ── PRIS / KOSTPRIS (costtotal_net) ──────────────────────── */

test('extractCostEx læser costtotal_net (ex moms) — top-niveau og accounting', () => {
    assert.strictEqual(extractCostEx({ costtotal_net: 90 }), 90);
    assert.strictEqual(extractCostEx({ accounting: { costtotal_net: 55.98 } }), 55.98);
    assert.strictEqual(extractCostEx({}), null);
    assert.strictEqual(extractCostEx(null), null);
});

test('priceQuote opretter draft og returnerer Lobos kostpris (RR: 90 kr ex moms)', async () => {
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    const rr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lobo/rr_order_example.json'), 'utf8'));
    let posted = null;
    const adapter = makeAdapter((url, init) => {
        if (url.endsWith('/token')) return resp(201, { status: 'ok', token: tok });
        if (url.endsWith('/orderdrafts') && init.method === 'POST') {
            posted = JSON.parse(init.body);
            // draft-svar bærer samme cost-felter som en ordre (Lobo beregner ved oprettelse)
            return resp(201, rr.response);
        }
        throw new Error('uventet kald: ' + url);
    });
    const q = await adapter.priceQuote({ external_api_id: '1008', delivery: { fkplace: 1215 } });
    assert.strictEqual(q.cost_ex, 90, 'kostpris ex moms fra costtotal_net');
    assert.strictEqual(q.cost_incl, 112.5);
    assert.strictEqual(q.routedistance, 3531);
    assert.strictEqual(q.co2saving, 459);
    assert.strictEqual(q.uuid, '442499c4-1ed6-4623-bd77-bcb3dc10bfc3');
    assert.ok(posted, 'draft blev POSTet');
});

/* ── HMAC-VERIFIKATION (ren krypto) ───────────────────────── */

test('verifyWebhookSignature accepterer korrekt HMAC og afviser forkert', () => {
    const key = '26d213ff9ebc1992861361951df1341c9b5278acd5fa7dc0acd391ae422ec195';
    const payload = 'ts=1780512440&event=dispatched&target=order&orderuuid=abc-123';
    const sig = computeHmac(payload, key);
    assert.strictEqual(verifyWebhookSignature(payload, sig, key), true);
    assert.strictEqual(verifyWebhookSignature(payload + 'x', sig, key), false, 'manipuleret payload afvises');
    assert.strictEqual(verifyWebhookSignature(payload, sig, 'forkert-nøgle'), false, 'forkert nøgle afvises');
    assert.strictEqual(verifyWebhookSignature(payload, '', key), false, 'tom signatur afvises');
});

test('verifyWebhookSignature tåler "sha256="-præfiks', () => {
    const key = 'abc';
    const payload = 'x=1';
    const sig = computeHmac(payload, key);
    assert.strictEqual(verifyWebhookSignature(payload, 'sha256=' + sig, key), true);
});

/* ── EVENT-MAPPING ────────────────────────────────────────── */

test('mapLoboEvent matcher live-events (4. juni 2026)', () => {
    assert.strictEqual(mapLoboEvent('order', 'dispatched'), 'assigned');
    assert.strictEqual(mapLoboEvent('order', 'finished'), 'delivered');
    assert.strictEqual(mapLoboEvent('order', 'trashed'), 'cancelled');   // live cancel-event
    assert.strictEqual(mapLoboEvent('order', 'withdrawn'), 'cancelled'); // live cancel-event
    assert.strictEqual(mapLoboEvent('order', 'stopvisitedorsigned'), null); // disambigueres via GET /orders
    assert.strictEqual(mapLoboEvent('order', 'changed'), null);
    assert.strictEqual(mapLoboEvent('order', 'accounted'), null);
    assert.strictEqual(mapLoboEvent('order', 'ukendt'), null);
    // doc-fallback bevaret:
    assert.strictEqual(mapLoboEvent('order', 'deleted'), 'cancelled');
});

/* ── JWT-DEKODNING mod den RIGTIGE fixture-token ──────────── */

test('decodeJwtPayload læser scopes ud af det rigtige eksempel-token i fixturen', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lobo/lobo_api_docs.json'), 'utf8'));
    const flat = [];
    (function w(items) { for (const it of items || []) { if (it.item) w(it.item); else flat.push(it); } })(fx.item);
    const tokenReq = flat.find(it => it.name.includes('Request/refresh token'));
    const exampleResp = (tokenReq.response || [])[0];
    const token = JSON.parse(exampleResp.body).token;
    const payload = decodeJwtPayload(token);
    assert.ok(Array.isArray(payload.scope), 'scope er et array');
    // De scopes vi har bedt Lobo om skal findes i eksempel-tokenet med alle scopes
    for (const need of ['order.create', 'order.delete', 'address.verify', 'webhook.create', 'orderdraft.order']) {
        assert.ok(payload.scope.includes(need), `scope "${need}" findes i all-scopes-token`);
    }
});
