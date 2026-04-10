/**
 * services/hokaAdapter.js
 * ════════════════════════════════════════════════════════════
 * Håndterer autentificering og API-kald til hoka.dk.
 *
 * hoka.dk bruger httpOnly session-cookies — vi holder en
 * cookie-jar i hukommelsen og re-logger ind automatisk
 * hvis sessionen udløber (HTTP 401).
 *
 * Kræver i .env:
 *   HOKA_USERNAME=din@email.dk
 *   HOKA_PASSWORD=ditpassword
 *   HOKA_BASE_URL=https://www.hoka.dk    (valgfri)
 * ════════════════════════════════════════════════════════════
 */

const HOKA_BASE = (process.env.HOKA_BASE_URL || 'https://www.hoka.dk').replace(/\/$/, '');

// ─── Cookie-jar ─────────────────────────────────────────────────────────────

let _cookies            = {};   // { name: { value, expires } }
let _basketId           = null; // caches LastSelectedBasketId
let _loginPromise       = null; // promise-lock mod dobbelt-login
let _antiForgeryToken   = null; // CSRF token fra login-side (nødvendig for basket PUT)
let _antiForgeryHeader  = 'RequestVerificationToken';

function _parseCookies(headers) {
    const raw = headers.getSetCookie?.() ?? [];
    const list = Array.isArray(raw) ? raw
        : typeof raw === 'string'   ? [raw]
        : [];

    for (const header of list) {
        const parts = header.split(';').map(p => p.trim());
        const eqIdx = parts[0].indexOf('=');
        const name  = parts[0].slice(0, eqIdx).trim();
        const value = parts[0].slice(eqIdx + 1);

        let expires = null;
        for (const part of parts.slice(1)) {
            if (part.toLowerCase().startsWith('expires=')) {
                expires = new Date(part.slice(8));
            }
        }
        _cookies[name] = { value, expires };
    }
}

function _cookieHeader() {
    const now = new Date();
    return Object.entries(_cookies)
        .filter(([, v]) => !v.expires || v.expires > now)
        .map(([k, v]) => `${k}=${v.value}`)
        .join('; ');
}

function _clearSession() {
    _cookies   = {};
    _basketId  = null;
}

function _hasSession() {
    return Object.keys(_cookies).length > 0;
}

// ─── Lav-niveau fetch ────────────────────────────────────────────────────────

/**
 * Udfører et autentificeret kald til hoka.dk.
 * Tilføjer automatisk anti-cache query-params (_n, _u, _im)
 * som hoka.dk forventer på alle API-kald.
 */
async function _hokaFetch(path, opts = {}) {
    const nonce = Math.floor(Math.random() * 2_000_000_000);
    const sep   = path.includes('?') ? '&' : '?';
    const url   = `${HOKA_BASE}${path}${sep}_n=1&_u=${nonce}&_im=true`;

    const res = await fetch(url, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json, */*',
            'User-Agent':   'Mozilla/5.0 BonTool/2.0',
            'Cookie':       _cookieHeader(),
            ...opts.headers,
        },
    });

    _parseCookies(res.headers);
    return res;
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function _login() {
    const user = process.env.HOKA_USERNAME;
    const pass = process.env.HOKA_PASSWORD;
    if (!user || !pass) {
        throw new Error('HOKA_USERNAME og HOKA_PASSWORD mangler i .env');
    }

    console.log('[hoka] Logger ind...');
    _clearSession();

    // Hent login-side for initielle cookies + anti-forgery token (CSRF)
    const homeRes = await fetch(`${HOKA_BASE}/da-dk/login`, {
        headers: { 'User-Agent': 'Mozilla/5.0 BonTool/2.0', Accept: 'text/html' },
        redirect: 'follow',
    });
    _parseCookies(homeRes.headers);

    // Udtræk anti-forgery token fra $$ModernClientContext (nødvendig for basket PUT)
    const pageBody = await homeRes.text();
    const tokenMatch = pageBody.match(/"antiForgery"\s*:\s*\{[^}]*"token"\s*:\s*"([^"]+)"/);
    const headerMatch = pageBody.match(/"antiForgery"\s*:\s*\{[^}]*"headerName"\s*:\s*"([^"]+)"/);
    _antiForgeryToken = tokenMatch?.[1] || null;
    _antiForgeryHeader = headerMatch?.[1] || 'RequestVerificationToken';
    if (_antiForgeryToken) {
        console.log(`[hoka] ✓ Anti-forgery token hentet`);
    } else {
        console.log(`[hoka] ⚠ Ingen anti-forgery token fundet — basket PUT kan fejle`);
    }

    // POST login — bekræftet via HAR-analyse 2026-03-28
    // Endpoint: POST /api/auth/login
    // Body: EmailAddress/Password (ikke username/password)
    // RememberMe: true — vigtigt for session-varighed
    const loginPath = process.env.HOKA_LOGIN_PATH || '/api/auth/login';
    const loginRes  = await _hokaFetch(loginPath, {
        method: 'POST',
        body:   JSON.stringify({
            EmailAddress: user,
            Password:     pass,
            RememberMe:   true,
            ReturnUrl:    '',
        }),
    });

    // Verificér — /api/user/information returnerer IsAuthenticated
    const meRes  = await _hokaFetch('/api/user/information');
    const meData = await meRes.json();

    if (!meData?.User?.IsAuthenticated) {
        _clearSession();
        throw new Error(
            `Login fejlede (brugte ${loginPath}). ` +
            'Tjek HOKA_USERNAME/HOKA_PASSWORD. ' +
            'Sæt HOKA_LOGIN_PATH i .env hvis endpoint er forkert.'
        );
    }

    console.log(`[hoka] ✓ Logget ind som ${meData.User.DisplayName} (${meData.User.Email})`);

    // Cache basket ID
    const settingsRes  = await _hokaFetch('/api/user/settings');
    const settingsData = await settingsRes.json();
    _basketId = settingsData?.Model?.Settings?.LastSelectedBasketId ?? null;
    console.log(`[hoka] Aktiv kurv-ID: ${_basketId}`);
}

async function _ensureLoggedIn() {
    if (_hasSession()) return;
    if (_loginPromise) return _loginPromise;
    _loginPromise = _login().finally(() => { _loginPromise = null; });
    return _loginPromise;
}

// ─── Autentificeret kald med auto-retry ──────────────────────────────────────

async function call(path, opts = {}) {
    await _ensureLoggedIn();
    const res = await _hokaFetch(path, opts);

    if (res.status === 401) {
        console.log('[hoka] Session udløbet — re-logger ind');
        _clearSession();
        await _ensureLoggedIn();
        return _hokaFetch(path, opts);
    }

    return res;
}

async function callJson(path, opts = {}) {
    const res = await call(path, opts);
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`hoka.dk ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
}

// ─── Public helpers ──────────────────────────────────────────────────────────

async function getBasketId() {
    if (_basketId) return _basketId;
    await _ensureLoggedIn();
    return _basketId;
}

// ─── Bruger ──────────────────────────────────────────────────────────────────

async function getMe() {
    return callJson('/api/user/information');
}

// ─── Produkter ───────────────────────────────────────────────────────────────

/**
 * Batch-opslag på produkter — returnerer aftalepris, billede, markings m.m.
 * @param {number[]} ids        Hoka produkt-IDs
 * @param {string}   date       ISO dato, fx "2026-04-01" — påvirker pris og tilgængelighed
 */
async function getProductSnapshots(ids, date) {
    if (!ids?.length) return [];
    const idParams = ids.map(id => `id=${id}`).join('&');
    const dateStr  = date
        ? encodeURIComponent(new Date(date).toISOString())
        : encodeURIComponent(new Date().toISOString());
    return callJson(`/api/catalog/products/snapshots?${idParams}&orderByMx=true&expectedDeliveryDate=${dateStr}`);
}

/**
 * Jeres indkøbshistorik for ét produkt.
 * Bruges til at foreslå antal: "sidst bestilte du 8 stk".
 */
async function getPurchaseHistory(productId) {
    return callJson(`/api/accounting/purchasehistory/${productId}`);
}

/**
 * Lagerstatus for leveringsdato.
 */
async function getStock(date) {
    const dateStr = date
        ? encodeURIComponent(new Date(date).toISOString())
        : encodeURIComponent(new Date().toISOString());
    return callJson(`/api/catalog/stock?ExpectedDeliveryDate=${dateStr}`);
}

// ─── Kurv ────────────────────────────────────────────────────────────────────

/**
 * Henter den aktive kurv med alle linjer.
 */
async function getBasket() {
    const id = await getBasketId();
    if (!id) throw new Error('Ingen aktiv kurv fundet');
    return callJson(`/api/checkout/basket?id=${id}&validate=true`);
}

/**
 * Tilføjer eller opdaterer varer i kurven.
 * Sender alle varer i ét kald.
 *
 * @param {Array} products  [{ productId, quantity, salesUnit: { code, quantity } }]
 *                          Sæt quantity: 0 for at fjerne en vare.
 */
async function putBasketProducts(products) {
    const id = await getBasketId();
    if (!id) throw new Error('Ingen aktiv kurv fundet');

    const hokaProducts = products.map(p => ({
        ProductId: p.productId,
        Quantity:  p.quantity,
        ...(p.salesUnit ? {
            SalesUnit: { Code: p.salesUnit.code, Quantity: p.salesUnit.quantity }
        } : {}),
    }));

    // Basket PUT kræver anti-forgery token (CSRF)
    const headers = {};
    if (_antiForgeryToken) {
        headers[_antiForgeryHeader] = _antiForgeryToken;
        headers['Origin'] = HOKA_BASE;
        headers['Referer'] = `${HOKA_BASE}/da-dk/checkout/basket`;
    }

    return callJson(`/api/checkout/basket?id=${id}&validate=false`, {
        method: 'PUT',
        headers,
        body:   JSON.stringify({ Products: hokaProducts }),
    });
}

/**
 * Sætter leveringsdato på kurven.
 * @param {string} date  ISO dato, fx "2026-04-01"
 */
async function setDeliveryDate(date) {
    const id = await getBasketId();
    if (!id) throw new Error('Ingen aktiv kurv fundet');
    return callJson(`/api/checkout/basket?id=${id}&validate=true`, {
        method: 'PUT',
        body:   JSON.stringify({ Delivery: { ExpectedDate: date } }),
    });
}

// ─── Levering ────────────────────────────────────────────────────────────────

async function getDeliveryDates() {
    return callJson('/api/delivery/dates');
}

/**
 * Tjekker om ordre-total møder minimumsgrænsen (dropsize) for leveringsdato.
 */
async function getDropsize(subtotal, date) {
    const dateStr = encodeURIComponent(new Date(date).toISOString());
    return callJson(`/api/delivery/dropsize/ofbasket?basketSubTotal=${subtotal}&expectedDeliveryDate=${dateStr}`);
}

// ─── Ordre ───────────────────────────────────────────────────────────────────

/**
 * Afgiver ordren. Udfører den komplette checkout-sekvens
 * som observeret i HAR-filerne:
 *   1. PUT basket med fuld bekræftelse
 *   2. POST weborder
 *
 * @param {string} deliveryDate  ISO dato
 * @param {string} message       Valgfri note — bruges til at gemme bestillers navn
 */
async function submitOrder(deliveryDate, message = null) {
    const id = await getBasketId();
    if (!id) throw new Error('Ingen aktiv kurv fundet');

    // Trin 1: Final PUT med leveringsdetaljer (bekræftelse)
    await callJson(`/api/checkout/basket?id=${id}&validate=true`, {
        method: 'PUT',
        body: JSON.stringify({
            Delivery:        { ExpectedDate: deliveryDate, PreSaleIndicator: null },
            References:      { OrderReference: null },
            Message:         { Text: null },
            Products:        [],
            SeparateInvoice: false,
        }),
    });

    // Trin 2: POST weborder — afgiver ordren
    const result = await callJson(`/api/checkout/weborder?basketId=${id}`, {
        method: 'POST',
        body:   JSON.stringify({ Message: { Text: message } }),
    });

    return result;
}

/**
 * Henter kvittering for en afgivet ordre.
 */
async function getOrderConfirmation(basketId) {
    return callJson(`/api/checkout/weborder?id=${basketId}`);
}

/**
 * Ordrehistorik — liste over alle ordrer.
 */
async function getOrders() {
    return callJson('/api/accounting/orders');
}

/**
 * Fuld detalje for én ordre inkl. linjer og eventuelle erstatningsvarer.
 */
async function getOrder(orderId) {
    return callJson(`/api/accounting/orders/${orderId}`);
}

// ─── CO2 ─────────────────────────────────────────────────────────────────────

/**
 * CO2-aftryk for den aktive kurv.
 * Gratis integration til fremtidig CO2-rapportering.
 */
async function getBasketCO2() {
    const id = await getBasketId();
    if (!id) throw new Error('Ingen aktiv kurv fundet');
    return callJson(`/api/sustainability/summary/basket/${id}`);
}

// ─── Søgning & favoritter (bruges af horkram-scraper) ───────────────────────

async function searchProducts(query) {
    const today = new Date().toISOString().split('T')[0] + 'T00:00:00';
    return callJson(`/api/catalog/search?q=${encodeURIComponent(query)}&Last=q&term=${encodeURIComponent(query)}&expectedDeliveryDate=${encodeURIComponent(today)}`);
}

async function getFavoriteLists() {
    return callJson('/api/navigation/favorites');
}

async function getCustomFavoriteLists() {
    return callJson('/api/favorites');
}

async function getFavoriteList(listId, page = 1) {
    return callJson(`/api/favorites/${encodeURIComponent(listId)}?page=${page}`);
}

/**
 * Sidst bestilte varer (auto-genereret "favorit-liste" fra Hørkram).
 * Bruges som primær kilde til kobling af umatchede varer.
 * @param {number} page  Sidenummer (default 1)
 */
async function getSalesStatistics(page = 1) {
    return callJson(`/api/accounting/salesstatistics?page=${page}`);
}

/**
 * Hent enkelt produkt med fulde detaljer.
 * @param {string|number} varenr  Hørkram varenummer
 */
async function getProductByVarenr(varenr) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0] + 'T00:00:00';
    return callJson(`/api/catalog/products/${varenr}?expectedDeliveryDate=${encodeURIComponent(tomorrow)}`);
}

// ─── Health ──────────────────────────────────────────────────────────────────

function isConfigured() {
    return !!(process.env.HOKA_USERNAME && process.env.HOKA_PASSWORD);
}

module.exports = {
    // Session
    isConfigured,
    getMe,
    // Produkter
    getProductSnapshots,
    getPurchaseHistory,
    getStock,
    // Kurv
    getBasket,
    putBasketProducts,
    setDeliveryDate,
    // Levering
    getDeliveryDates,
    getDropsize,
    // Ordre
    submitOrder,
    getOrderConfirmation,
    getOrders,
    getOrder,
    // CO2
    getBasketCO2,
    // Scraper-endpoints
    searchProducts,
    getFavoriteLists,
    getCustomFavoriteLists,
    getFavoriteList,
    getSalesStatistics,
    getProductByVarenr,
};
