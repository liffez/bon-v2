/**
 * services/byExpressenAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Byekspressen via Lobo API v3.1.
 *
 * Søskende til grocyAdapter.js / hokaAdapter.js — ENESTE sted der taler
 * med Lobo. Resten af systemet kender kun dette interface.
 *
 * Spec:      docs/CLAUDE_LEVERING_LOBO.md (rev. 2)
 * Reference: tests/fixtures/lobo/lobo_api_docs.json (alle shapes verificeret herfra)
 *
 * Designet som FACTORY (createByExpressenAdapter) så HTTP kan mockes i unit-tests
 * uden live-API. routes/-laget bruger getByExpressenAdapter() der bygger en
 * instans fra delivery_vehicles.booking_api_config_json + .env-creds.
 *
 * Auth:   POST /token (HTTP Basic Auth) → { status:'ok', token } (JWT).
 *         Bearer-token på alt øvrigt. Token caches til ~30s før expiry.
 * Konv.:  svar pakkes i { data:[...], meta:{count,totalcount} }. Bool = int 0/1.
 * ════════════════════════════════════════════════════════════
 */

const crypto = require('node:crypto');

/* ══════════════════════════════════════════════════════════════
   FEJL
   ══════════════════════════════════════════════════════════════ */

class ByExpressenError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'ByExpressenError';
        this.status = status;     // HTTP-status
        this.code = code;         // fx 'no_scope', 'timeout', 'auth_failed'
        this.body = body;         // rå svar-body (til debugging)
    }
}

/* ══════════════════════════════════════════════════════════════
   JWT-HJÆLP — læs exp ud af token (signatur verificeres ikke; det er
   Lobo's eget token, vi cacher det bare til udløb).
   ══════════════════════════════════════════════════════════════ */

function decodeJwtPayload(token) {
    try {
        const part = token.split('.')[1];
        const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

/* ══════════════════════════════════════════════════════════════
   SCOPES — anmodes i /token-body'en. Serveren giver snittet af (anmodet,
   tilladt-i-LOBO-frontend). Live-tjek 4. juni 2026: 31/38 tilladt;
   `order.delete`, `payment.read`, `statistic.read`, `place.read:all` m.fl. var
   IKKE slået til (skal bedes om hos Lobo før cancel-via-API virker).
   ══════════════════════════════════════════════════════════════ */

const DEFAULT_BOOKING_SCOPES = [
    'embed.order:accounting', 'embed.order:downloadlinks',
    'address.verify', 'address.autocomplete:streets_and_places',
    'product.read', 'surcharge.read', 'pricescale.read',
    'order.read', 'order.create', 'order.edit', 'order.delete',
    'orderdraft.read', 'orderdraft.create', 'orderdraft.order', 'orderdraft.delete',
    'ordersurchargequantity.read', 'ordersurchargequantity.set',
    'orderpricescalequantity.read',
    'stop.read', 'stop.create',
    'customer.read', 'place.read:used_before',
    'webhook.read', 'webhook.create', 'webhook.delete', 'webhookevent.read',
];

/* ══════════════════════════════════════════════════════════════
   FACTORY
   ══════════════════════════════════════════════════════════════ */

/**
 * @param {object}   opts
 * @param {object}   opts.config       — { base_url, sandbox_url, use_sandbox, fkcustomer, fkproduct, fkpayment, hq_fkplace }
 * @param {object}   opts.credentials  — { user, pass }
 * @param {function} [opts.fetchImpl]  — fetch-impl (injiceres i tests; default global fetch)
 * @param {function} [opts.now]        — () => ms (injiceres i tests; default Date.now)
 */
function createByExpressenAdapter({ config, credentials, fetchImpl = fetch, now = Date.now } = {}) {
    if (!config) throw new ByExpressenError('config mangler');
    if (!credentials || !credentials.user || !credentials.pass) {
        throw new ByExpressenError('credentials mangler (user/pass)');
    }

    const base = String(config.use_sandbox ? config.sandbox_url : config.base_url || '')
        .replace(/\/?$/, '/');
    if (!base || base === '/') throw new ByExpressenError('base/sandbox url mangler i config');

    // Token-cache på instans-niveau
    let _token = null;
    let _expiresAt = 0;

    /* ── AUTH ─────────────────────────────────────────────── */

    async function getToken() {
        if (_token && now() < _expiresAt - 30_000) return _token;

        const basic = 'Basic ' + Buffer.from(`${credentials.user}:${credentials.pass}`).toString('base64');
        // VIGTIGT: scopes ANMODES i body'en. Uden body → token får scope:[] → 403
        // på alt. Serveren giver snittet af (anmodet, tilladt-i-frontend).
        const scopes = config.scopes || DEFAULT_BOOKING_SCOPES;
        let res;
        try {
            res = await fetchImpl(base + 'token', {
                method: 'POST',
                headers: { Authorization: basic, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(scopes),
            });
        } catch (e) {
            throw new ByExpressenError('Netværksfejl ved /token: ' + e.message, { code: 'network' });
        }

        const body = await safeJson(res);
        if (res.status === 401) {
            throw new ByExpressenError('Authentication failed mod /token', { status: 401, code: 'auth_failed', body });
        }
        if (!res.ok || !body || !body.token) {
            throw new ByExpressenError('Uventet svar fra /token (status ' + res.status + ')', { status: res.status, body });
        }

        _token = body.token;
        const payload = decodeJwtPayload(_token);
        _expiresAt = payload && payload.exp ? payload.exp * 1000 : now() + 9 * 60 * 1000; // fallback 9 min
        return _token;
    }

    /* ── GENERISK AUTH'ET KALD (Bearer) med 401-retry-én-gang ── */

    async function authedFetch(method, path, { body = null, _isRetry = false } = {}) {
        const token = await getToken();
        const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
        const init = { method, headers };
        if (body !== null) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let res;
        try {
            res = await fetchImpl(base + path.replace(/^\//, ''), init);
        } catch (e) {
            throw new ByExpressenError(`Netværksfejl ved ${method} ${path}: ${e.message}`, { code: 'network' });
        }

        // Token udløbet midt i — re-auth én gang
        if (res.status === 401 && !_isRetry) {
            _token = null; _expiresAt = 0;
            return authedFetch(method, path, { body, _isRetry: true });
        }

        // 204 = tom body (fx DELETE)
        if (res.status === 204) return { ok: true, status: 204, data: null };

        const parsed = await safeJson(res);
        if (res.status === 403) {
            const msg = (parsed && parsed.message) || 'Forbidden';
            throw new ByExpressenError(msg, { status: 403, code: 'no_scope', body: parsed });
        }
        if (!res.ok) {
            const msg = (parsed && parsed.message) || `HTTP ${res.status}`;
            throw new ByExpressenError(`${method} ${path}: ${msg}`, { status: res.status, body: parsed });
        }
        return { ok: true, status: res.status, data: parsed && parsed.data, meta: parsed && parsed.meta, raw: parsed };
    }

    /* ── ADRESSE ──────────────────────────────────────────── */

    // POST /addresses/verify → LOBO-internt format inkl. fkplace (krævet før stop)
    async function verifyAddress({ street, housenumber, zip, city, isocode = 'DNK' }) {
        const r = await authedFetch('POST', 'addresses/verify', {
            body: { street, housenumber, zip, city, isocode },
        });
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    // GET /addresses/autocomplete/streetsandplaces?querystring=
    async function autocomplete(querystring) {
        const r = await authedFetch('GET', 'addresses/autocomplete/streetsandplaces?querystring=' + encodeURIComponent(querystring));
        return r.data;
    }

    /* ── PRODUKTER / BETALING (V2) ────────────────────────── */

    async function getProducts() {
        const r = await authedFetch('GET', 'products?_embed=timemodel,surcharges,pricescales');
        return r.data;
    }

    async function getPayments() {
        const r = await authedFetch('GET', 'payments');
        return r.data;
    }

    /* ── ORDRE-BODY (ren funktion — testbar) ──────────────── */

    /**
     * Byg en Lobo ordre-/orderdraft-body for ÉN bon (HQ pickup + ét kunde-stop).
     * Verificeret mod RR's egen eksempel-body (tests/fixtures/lobo/rr_order_example.json):
     * de bruger `customernumber` (ikke `fkcustomer`), `external_api_id` til vores
     * reference, og et stop kan gives som `fkplace` ELLER inline-adresse (Lobo
     * resolver selv — `verifyAddress` er valgfri, ikke påkrævet).
     *
     * @param {object} input
     *   { reftime?, external_api_id?, notepublic?,
     *     pickup?:  { fkplace } | { street,housenumber,zip,city,... },   // default: config.hq_fkplace
     *     pickupNote?,
     *     delivery: { fkplace } | { street,housenumber,zip,city,contactperson?,isocode? },
     *     deliveryDeadlineIso?, deliveryNote?,
     *     surcharges?: [{ fksurcharge, quantity }] }
     */
    function buildOrderPayload(input) {
        const cfg = config;
        const body = {
            customernumber: cfg.customernumber ?? cfg.fkcustomer,
            fkproduct: cfg.fkproduct,
            ...(cfg.fkpayment != null ? { fkpayment: cfg.fkpayment } : {}),
            ...(input.reftime ? { reftime: input.reftime } : {}),
            ...(input.external_api_id != null ? { external_api_id: String(input.external_api_id) } : {}),
            ...(input.notepublic ? { notepublic: input.notepublic } : {}),
            stops: [],
        };

        const pickup = input.pickup || { fkplace: cfg.hq_fkplace };
        body.stops.push({
            position: 1,
            ...stopFields(pickup),
            ...(input.pickupNote ? { notepublic: input.pickupNote } : {}),
        });

        const d = input.delivery || {};
        body.stops.push({
            position: 2,
            ...stopFields(d),
            ...(input.deliveryDeadlineIso ? { tw_fixed_end: input.deliveryDeadlineIso } : {}),
            ...(input.deliveryNote ? { notepublic: input.deliveryNote } : {}),
        });

        if (Array.isArray(input.surcharges) && input.surcharges.length) {
            const sc = input.surcharges.filter(s => s && s.quantity > 0)
                .map(s => ({ fksurcharge: s.fksurcharge, quantity: s.quantity }));
            if (sc.length) body.ordersurchargequantities = sc;
        }
        return body;
    }

    // Et stop kan refereres med fkplace (gemt sted) eller inline-adresse.
    function stopFields(s) {
        if (s.fkplace) return { fkplace: s.fkplace };
        const out = {};
        for (const k of ['full_address', 'street', 'housenumber', 'addition', 'suffix',
            'hnr_add_sfx', 'zip', 'city', 'isocode', 'contactperson']) {
            if (s[k] != null) out[k] = s[k];
        }
        return out;
    }

    /* ── PRIS-TILBUD via orderdraft (§8) ──────────────────── */

    /**
     * Opret en orderdraft og læs Lobos beregnede kostpris (`costtotal_net`, ex moms)
     * direkte fra svaret. Drafts udløber selv efter ~5 min — kalderen kan enten
     * convertDraftToOrder(uuid) (committer) eller deleteOrderDraft(uuid).
     *
     * Lobo returnerer kostprisen som et færdigt felt (verificeret mod RR's egen
     * ordre: costtotal_net=90, costtotal_gross=112.5, vatrate=25). Ingen formel
     * eller kalibrering nødvendig. Hvis create-svaret mod forventning ikke bærer
     * cost-feltet, hentes draften med ?_embed=...,accounting.
     */
    async function priceQuote(payload) {
        let order = await createOrderDraft(payload);
        const uuid = order && order.uuid;
        if (extractCostEx(order) === null && uuid) {
            order = await getOrderDraft(uuid);   // sikrer accounting-felter
        }
        return {
            uuid,
            order,
            cost_ex: extractCostEx(order),                       // det vi betaler Lobo (ex moms)
            cost_incl: order && (order.costtotal_gross ?? (order.accounting && order.accounting.costtotal_gross)) || null,
            routedistance: (order && (order.routedistance ?? (order.accounting && order.accounting.routedistance))) ?? null,
            co2saving: (order && (order.co2saving ?? (order.accounting && order.accounting.co2saving))) ?? null,
        };
    }

    async function createOrderDraft(payload) {
        const r = await authedFetch('POST', 'orderdrafts', { body: payload });
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function getOrderDraft(uuid) {
        const r = await authedFetch('GET', `orderdrafts/${uuid}?_embed=stops,ordersurchargequantities,downloadlinks,accounting`);
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function convertDraftToOrder(uuid) {
        const r = await authedFetch('PUT', `orderdrafts/${uuid}/order`);
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function deleteOrderDraft(uuid) {
        await authedFetch('DELETE', `orderdrafts/${uuid}`);
        return true;
    }

    /* ── ORDRE (atomisk) ──────────────────────────────────── */

    async function bookOrder(payload) {
        const r = await authedFetch('POST', 'orders', { body: payload });
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function getOrder(uuid) {
        const r = await authedFetch('GET', `orders/${uuid}?_embed=stops,downloadlinks,dispatchedto`);
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function cancelOrder(uuid) {
        await authedFetch('DELETE', `orders/${uuid}`);
        return true;
    }

    /* ── POD / downloads ──────────────────────────────────── */

    // Returnerer rå Response (pdf-binær) — kalderen streamer/gemmer.
    async function downloadPod(uuid) {
        const token = await getToken();
        const res = await fetchImpl(base + `downloads/order/pod/${uuid}`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new ByExpressenError(`POD-download fejlede (${res.status})`, { status: res.status });
        return res;
    }

    /* ── WEBHOOKS ─────────────────────────────────────────── */

    // POST /webhooks → { id, hmac_key, hmac_algorithm } — GEM hmac_key!
    async function registerWebhook(event, url, headerAuthorization = '') {
        const body = { target: 'order', event, url };
        if (headerAuthorization) body.header_authorization = headerAuthorization;
        const r = await authedFetch('POST', 'webhooks', { body });
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function listWebhooks() {
        const r = await authedFetch('GET', 'webhooks');
        return r.data;
    }

    async function deleteWebhook(id) {
        await authedFetch('DELETE', `webhooks/${id}`);
        return true;
    }

    return {
        config,
        getToken,
        verifyAddress,
        autocomplete,
        getProducts,
        getPayments,
        buildOrderPayload,
        priceQuote,
        createOrderDraft,
        getOrderDraft,
        convertDraftToOrder,
        deleteOrderDraft,
        bookOrder,
        getOrder,
        cancelOrder,
        downloadPod,
        registerWebhook,
        listWebhooks,
        deleteWebhook,
        // til tests/diagnostik
        _peekToken: () => ({ token: _token, expiresAt: _expiresAt }),
    };
}

/* ══════════════════════════════════════════════════════════════
   KOSTPRIS-EKSTRAKTION (ren funktion)
   ══════════════════════════════════════════════════════════════
   Lobo leverer kostprisen som et færdigt felt på ordren/draften:
     costtotal_net   = kostpris EX moms  (det vi betaler Lobo → bons.delivery_cost)
     costtotal_gross = incl moms
     vatrate / vat   = momssats / momsbeløb
   Feltet ligger enten på top-niveau (set i RR's ordre) eller under et embedded
   `accounting`-objekt (set i de generiske docs). Vi tjekker begge.
   ══════════════════════════════════════════════════════════════ */

function extractCostEx(order) {
    if (!order || typeof order !== 'object') return null;
    const net = order.costtotal_net ?? (order.accounting && order.accounting.costtotal_net);
    return typeof net === 'number' ? net : null;
}

/* ══════════════════════════════════════════════════════════════
   WEBHOOK HMAC-VERIFIKATION (ren funktion)
   ══════════════════════════════════════════════════════════════
   Lobo signerer indgående webhook med HMAC (hmac_algorithm, default sha256)
   over en payload-streng, med den per-webhook hmac_key vi fik ved registrering.
   Den PRÆCISE signerede streng + header-navn skal verificeres live (sandbox),
   men selve HMAC-tjekket er ren krypto og fuldt testbart her.
   ══════════════════════════════════════════════════════════════ */

function computeHmac(payloadString, hmacKey, algorithm = 'sha256') {
    return crypto.createHmac(algorithm, hmacKey).update(payloadString, 'utf8').digest('hex');
}

function verifyWebhookSignature(payloadString, signatureHex, hmacKey, algorithm = 'sha256') {
    if (!signatureHex || !hmacKey) return false;
    const expected = computeHmac(payloadString, hmacKey, algorithm);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(signatureHex).toLowerCase().replace(/^.*=/, ''), 'hex'); // tål "sha256=..."
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
}

/* ══════════════════════════════════════════════════════════════
   LOBO WEBHOOK-EVENT → delivery_events.event_type (autoritativ mapping)
   ══════════════════════════════════════════════════════════════ */

// Live-tjek 4. juni 2026 (GET /webhookevents productive) gav 7 events:
//   order.trashed, order.dispatched, order.withdrawn, order.changed,
//   order.stopvisitedorsigned, order.finished, order.accounted
// (ingen order.created/deleted/approved live — vi logger selv 'booked' ved oprettelse).
// Doc-varianterne bevares som harmløs fallback hvis miljøer afviger.
const EVENT_MAP = {
    'order.dispatched':          'assigned',
    'order.stopvisitedorsigned': null,   // disambiguér via GET /orders/{uuid} stops → picked_up | delivered
    'order.finished':            'delivered',
    'order.trashed':             'cancelled',
    'order.withdrawn':           'cancelled',
    'order.changed':             null,     // note-event — opdatér snapshot, ingen status-skift
    'order.accounted':           null,
    // fallback (doc-navne, ikke set live):
    'order.created':             'booked',
    'order.deleted':             'cancelled',
    'order.approved':            null,
};

function mapLoboEvent(target, event) {
    return EVENT_MAP[`${target}.${event}`] ?? null;
}

/* ── intern: parse json uden at kaste ── */
async function safeJson(res) {
    try { return await res.json(); } catch { return null; }
}

module.exports = {
    createByExpressenAdapter,
    ByExpressenError,
    DEFAULT_BOOKING_SCOPES,
    extractCostEx,
    computeHmac,
    verifyWebhookSignature,
    mapLoboEvent,
    EVENT_MAP,
    decodeJwtPayload,
};
