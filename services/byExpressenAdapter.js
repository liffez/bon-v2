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
        let res;
        try {
            res = await fetchImpl(base + 'token', {
                method: 'POST',
                headers: { Authorization: basic, Accept: 'application/json' },
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
     * @param {object} input
     *   { reftime, customerreferenceorder, notepublic, hqFkplace,
     *     deliveryFkplace, deliveryDeadlineIso, deliveryNote,
     *     surcharges: [{ fksurcharge, quantity }] }
     */
    function buildOrderPayload(input) {
        const cfg = config;
        const body = {
            fkcustomer: cfg.fkcustomer,
            fkproduct: cfg.fkproduct,
            fkpayment: cfg.fkpayment,
            reftime: input.reftime,
            customerreferenceorder: String(input.customerreferenceorder ?? ''),
            notepublic: input.notepublic ?? '',
            noteinhouse: input.noteinhouse ?? '',
            stops: [
                { position: 1, fkplace: input.hqFkplace },
                {
                    position: 2,
                    fkplace: input.deliveryFkplace,
                    ...(input.deliveryDeadlineIso ? { tw_fixed_end: input.deliveryDeadlineIso } : {}),
                    notepublic: input.deliveryNote ?? '',
                },
            ],
        };
        if (Array.isArray(input.surcharges) && input.surcharges.length) {
            body.ordersurchargequantities = input.surcharges
                .filter(s => s && s.quantity > 0)
                .map(s => ({ fksurcharge: s.fksurcharge, quantity: s.quantity }));
        }
        // To-vejs kobling: gem vores bon-reference hos Lobo
        if (input.external_api_data != null) body.external_api_data = String(input.external_api_data);
        return body;
    }

    /* ── PRIS-TILBUD via orderdraft (§8) ──────────────────── */

    /**
     * Opret en orderdraft, læs pris-komponenterne tilbage, og returnér et
     * estimat. Drafts udløber selv efter ~5 min — kalderen kan enten
     * convertDraftToOrder(uuid) (committer) eller deleteOrderDraft(uuid).
     *
     * VIGTIGT: Lobo returnerer IKKE et samlet pris-felt på ordren. Kostprisen
     * udledes af pricescale-graduations + surcharges. Den eksakte formel
     * (især `percentageofroutecost`) SKAL kalibreres mod en rigtig booking
     * før go-live → estimatet er markeret `_needs_calibration: true`.
     */
    async function priceQuote(payload) {
        const draft = await createOrderDraft(payload);
        const uuid = draft && draft.uuid;
        // Hent pris-komponenter (separate ressourcer)
        const [psq, ssq] = await Promise.all([
            authedFetch('GET', `orderpricescalequantities?fkorder[eq]=${encodeURIComponent(uuid)}`).then(r => r.data).catch(() => null),
            authedFetch('GET', `ordersurchargequantities?fkorder[eq]=${encodeURIComponent(uuid)}`).then(r => r.data).catch(() => null),
        ]);
        const estimate = estimateCostEx({ pricescaleQuantities: psq, surchargeQuantities: ssq, products: null });
        return {
            uuid,
            draft,
            pricescaleQuantities: psq,
            surchargeQuantities: ssq,
            cost_ex_estimate: estimate.cost_ex,
            _needs_calibration: estimate._needs_calibration,
        };
    }

    async function createOrderDraft(payload) {
        const r = await authedFetch('POST', 'orderdrafts', { body: payload });
        return Array.isArray(r.data) ? r.data[0] : r.data;
    }

    async function getOrderDraft(uuid) {
        const r = await authedFetch('GET', `orderdrafts/${uuid}?_embed=stops,ordersurchargequantities,downloadlinks`);
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
   PRIS-ESTIMAT (ren funktion)
   ══════════════════════════════════════════════════════════════
   Best-effort kostpris ex moms ud fra Lobo-komponenter.
   Lobo har INTET samlet pris-felt; dette er den oplagte fortolkning:
     Σ(graduation.unitcost × pricescaleQuantity.quantity) + Σ(surcharge.unitcost × ssq.quantity)
   MEN `percentageofroutecost` + graduations-valg er ikke fuldt afdækket fra
   docs → markeres `_needs_calibration: true` indtil verificeret mod en rigtig
   booking. Margin-vagten bruger estimatet KUN som advarsel (§9), aldrig blokering.
   ══════════════════════════════════════════════════════════════ */

function estimateCostEx({ pricescaleQuantities, surchargeQuantities, products } = {}) {
    // Uden komponenter kan vi ikke estimere
    if (!pricescaleQuantities && !surchargeQuantities) {
        return { cost_ex: null, _needs_calibration: true };
    }
    // Bevidst konservativ: vi returnerer null-cost + flag indtil formlen er
    // kalibreret mod en rigtig faktura. (Komponenterne returneres af priceQuote
    // så UI kan vise dem, men vi påstår ikke en præcis kr-værdi endnu.)
    return { cost_ex: null, _needs_calibration: true };
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

const EVENT_MAP = {
    'order.created':            'booked',
    'order.dispatched':        'assigned',
    'order.stopvisitedorsigned': null,   // disambiguér via GET /orders/{uuid} stops → picked_up | delivered
    'order.finished':          'delivered',
    'order.deleted':           'cancelled',
    'order.changed':           null,     // note-event — opdatér snapshot, ingen status-skift
    'order.approved':          null,
    'order.accounted':         null,
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
    estimateCostEx,
    computeHmac,
    verifyWebhookSignature,
    mapLoboEvent,
    EVENT_MAP,
    decodeJwtPayload,
};
