/**
 * routes/horkram.js
 * ════════════════════════════════════════════════════════════
 * Proxy-routes til Hørkram (hoka.dk).
 * Monteres i server.js som:
 *   app.use('/api/horkram', require('./routes/horkram'));
 *
 * Direkte port af bontools/horkram/proxy.js (ESM → CommonJS).
 * Al auth-logik er selvstændig — ingen afhængighed af hokaAdapter.
 * Parser: services/hokaParser.js (port af parser.js).
 *
 * Env-variabler (.env):
 *   HORKRAM_USER=din@email.dk
 *   HORKRAM_PASS=ditpassword
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const router  = express.Router();
const parser  = require('../services/hokaParser');

const HOKA_BASE = 'https://www.hoka.dk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ══════════════════════════════════════════════════════════
   SESSION CACHE
   ══════════════════════════════════════════════════════════ */

let sessionCache = { cookies: null, exp: 0, antiForgeryToken: null, antiForgeryHeader: null };

function getCredentials() {
    const user = process.env.HORKRAM_USER;
    const pass = process.env.HORKRAM_PASS;
    return { user, pass, configured: !!(user && pass) };
}

/* ══════════════════════════════════════════════════════════
   COOKIE HELPERS
   ══════════════════════════════════════════════════════════ */

function collectCookies(response, cookieMap) {
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length === 0) {
        const raw = response.headers.get('set-cookie');
        if (raw) setCookies.push(raw);
    }
    for (const sc of setCookies) {
        const nameValue = sc.split(';')[0];
        const eqIdx = nameValue.indexOf('=');
        if (eqIdx > 0) {
            const name = nameValue.substring(0, eqIdx).trim();
            cookieMap.set(name, nameValue);
        }
    }
}

function cookiesToStr(cookieMap) {
    return [...cookieMap.values()].join('; ');
}

/* ══════════════════════════════════════════════════════════
   LOGIN
   Testet og verificeret login-flow fra proxy.js.
   AngularJS SPA med anti-forgery token + cookie-session.
   ══════════════════════════════════════════════════════════ */

async function login() {
    const { user, pass } = getCredentials();
    if (!user || !pass) throw new Error('HORKRAM_USER/HORKRAM_PASS mangler i .env');

    console.log(`[Hørkram] Logger ind som ${user}...`);

    const allCookies = new Map();

    // Trin 1: GET login-side → anti-forgery token + initial cookies
    const pageRes = await fetch(`${HOKA_BASE}/da-dk/login`, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
    });
    collectCookies(pageRes, allCookies);
    const pageBody = await pageRes.text();

    const tokenMatch  = pageBody.match(/"antiForgery"\s*:\s*\{[^}]*"token"\s*:\s*"([^"]+)"/);
    const headerMatch = pageBody.match(/"antiForgery"\s*:\s*\{[^}]*"headerName"\s*:\s*"([^"]+)"/);
    const antiForgeryToken  = tokenMatch?.[1];
    const antiForgeryHeader = headerMatch?.[1] || 'RequestVerificationToken';

    if (!antiForgeryToken) {
        console.log('[Hørkram] ⚠ Kunne ikke finde anti-forgery token');
    } else {
        console.log(`[Hørkram] ✓ Anti-forgery token: ${antiForgeryToken.substring(0, 20)}...`);
    }

    // Trin 2: POST /api/auth/login
    const loginRes = await fetch(`${HOKA_BASE}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            Cookie: cookiesToStr(allCookies),
            ...(antiForgeryToken ? { [antiForgeryHeader]: antiForgeryToken } : {}),
            'X-Validation-Group': 'login',
            Origin: HOKA_BASE,
            Referer: `${HOKA_BASE}/da-dk/login`,
        },
        body: JSON.stringify({ EmailAddress: user, Password: pass, RememberMe: true, ReturnUrl: '/da-dk' }),
        redirect: 'manual',
    });

    collectCookies(loginRes, allCookies);
    const loginStatus  = loginRes.status;
    const loginBodyRaw = await loginRes.text();

    console.log(`[Hørkram] POST /api/auth/login → HTTP ${loginStatus}, ${allCookies.size} cookies`);

    if (loginStatus === 200) {
        console.log(`[Hørkram] Login OK`);
    } else if (loginStatus >= 300 && loginStatus < 400) {
        const loc = loginRes.headers.get('location');
        if (loc) {
            const redirectUrl = loc.startsWith('http') ? loc : `${HOKA_BASE}${loc}`;
            const followRes = await fetch(redirectUrl, {
                headers: { Cookie: cookiesToStr(allCookies), 'User-Agent': UA },
                redirect: 'manual',
            });
            collectCookies(followRes, allCookies);
            console.log(`[Hørkram] Redirect → HTTP ${followRes.status}, ${allCookies.size} cookies`);
        }
    } else if (loginStatus === 400) {
        let errMsg = loginBodyRaw;
        try {
            const errObj = JSON.parse(loginBodyRaw);
            errMsg = errObj.Message || errObj.message || errObj.error || JSON.stringify(errObj);
        } catch {}
        throw new Error(`Hørkram login fejlede: ${errMsg}`);
    }

    if (allCookies.size === 0) throw new Error('Login fejlede: Ingen cookies modtaget');

    const cookieStr = cookiesToStr(allCookies);
    console.log(`[Hørkram] ✓ Login afsluttet — ${allCookies.size} cookies`);

    // Cache 30 min
    sessionCache = { cookies: cookieStr, exp: Date.now() + 30 * 60 * 1000, antiForgeryToken, antiForgeryHeader };
    return cookieStr;
}

async function getSession() {
    if (sessionCache.cookies && sessionCache.exp > Date.now()) return sessionCache.cookies;
    return login();
}

async function fetchWithAuth(url, options = {}) {
    let cookies = await getSession();

    const doFetch = (c) => fetch(url, {
        ...options,
        headers: { ...options.headers, Cookie: c, 'User-Agent': UA, Accept: 'application/json' },
    });

    let res = await doFetch(cookies);

    if (res.status === 401 || res.status === 403) {
        console.log('[Hørkram] Session udløbet — logger ind igen');
        sessionCache = { cookies: null, exp: 0 };
        cookies = await login();
        res = await doFetch(cookies);
    }

    return res;
}

function deliveryDate() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0] + 'T00:00:00';
}

/* ══════════════════════════════════════════════════════════
   SNAPSHOT BERIGING
   Tilføjer isAgreementItem til produktlister.
   Søg og favorit-endpoints inkluderer ikke SalesPriceSource —
   vi henter det via snapshots (chunks af 20, hoka.dk's limit).
   ══════════════════════════════════════════════════════════ */

async function enrichWithAftale(products) {
    if (!products || products.length === 0) return;
    const dd = deliveryDate();
    try {
        const ids = products.map(p => p.varenummer).filter(Boolean);
        for (let i = 0; i < ids.length; i += 20) {
            const chunk = ids.slice(i, i + 20);
            const url = `${HOKA_BASE}/api/catalog/products/snapshots?${chunk.map(id => `id=${id}`).join('&')}&expectedDeliveryDate=${encodeURIComponent(dd)}`;
            const snapRes = await fetchWithAuth(url);
            if (!snapRes.ok) continue;
            const snapshots = await snapRes.json();
            const snapArr = Array.isArray(snapshots) ? snapshots
                : Array.isArray(snapshots?.Model) ? snapshots.Model : [];
            const snapMap = new Map();
            for (const s of snapArr) snapMap.set(String(s.Id), s);
            for (const p of products) {
                const snap = snapMap.get(p.varenummer);
                if (snap?.SalesPriceSource) {
                    p.salesPriceSource = snap.SalesPriceSource.Text || null;
                    p.isAgreementItem  = snap.SalesPriceSource.TrackingId === 'Fixed';
                }
            }
        }
    } catch (err) {
        console.log(`[Hørkram] ⚠ Snapshot enrichment fejlede: ${err.message}`);
    }
}

/* ══════════════════════════════════════════════════════════
   ROUTES — HEALTH
   ══════════════════════════════════════════════════════════ */

router.get('/health', (req, res) => {
    const creds = getCredentials();
    res.json({
        ok: true,
        configured: creds.configured,
        hasSession: !!(sessionCache.cookies && sessionCache.exp > Date.now()),
        sessionExpiresIn: sessionCache.exp > Date.now()
            ? Math.round((sessionCache.exp - Date.now()) / 1000) + 's'
            : null,
    });
});

// Tving re-login (bruges til fejlfinding)
router.post('/login', async (req, res) => {
    try {
        sessionCache = { cookies: null, exp: 0 };
        await login();
        res.json({ ok: true, message: 'Login OK' });
    } catch (err) {
        console.error('[Hørkram login]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — PRODUKTER
   ══════════════════════════════════════════════════════════ */

// Enkelt produkt (fuldt parsed inkl. ernæring, salesUnits, isAgreementItem)
router.get('/product/:varenr', async (req, res) => {
    try {
        const { varenr } = req.params;
        console.log(`[Hørkram] → GET product/${varenr}`);
        const url = `${HOKA_BASE}/api/catalog/products/${varenr}?expectedDeliveryDate=${encodeURIComponent(deliveryDate())}`;
        const apiRes = await fetchWithAuth(url);
        if (!apiRes.ok) {
            const text = await apiRes.text();
            return res.status(apiRes.status).json({ error: `Hørkram API fejl: HTTP ${apiRes.status}`, detail: text.substring(0, 500) });
        }
        const raw    = await apiRes.json();
        const parsed = parser.parseProduct(raw);
        console.log(`[Hørkram] ← ${parsed.name} — aftale: ${parsed.isAgreementItem}`);
        res.json(parsed);
    } catch (err) {
        console.error('[Hørkram product]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Søgning — parsed + aftale-enriched via snapshots
router.get('/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q parameter påkrævet' });
        console.log(`[Hørkram] → SEARCH "${q}"`);

        const today = new Date().toISOString().split('T')[0] + 'T00:00:00';
        const url = `${HOKA_BASE}/api/catalog/search?q=${encodeURIComponent(q)}&Last=q&term=${encodeURIComponent(q)}&expectedDeliveryDate=${encodeURIComponent(today)}`;
        const apiRes = await fetchWithAuth(url);
        if (!apiRes.ok) {
            const text = await apiRes.text();
            return res.status(apiRes.status).json({ error: `Hørkram API fejl: HTTP ${apiRes.status}`, detail: text.substring(0, 500) });
        }

        const raw    = await apiRes.json();
        const parsed = parser.parseSearchResults(raw);
        await enrichWithAftale(parsed.results);

        console.log(`[Hørkram] ← ${parsed.totalResults} resultater for "${q}"`);
        res.json(parsed);
    } catch (err) {
        console.error('[Hørkram search]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Batch snapshots — til live beriging i indkøbs-UI (shared/indkob.js)
// GET /api/horkram/snapshots?ids=1234,5678,...
router.get('/snapshots', async (req, res) => {
    try {
        const idsParam = req.query.ids || '';
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (!ids.length) return res.status(400).json({ error: 'ids parameter påkrævet (komma-separeret)' });
        if (ids.length > 60) return res.status(400).json({ error: `Max 60 IDs pr. kald (modtog ${ids.length})` });

        console.log(`[Hørkram] → SNAPSHOTS ${ids.length} produkter`);

        const dd       = deliveryDate();
        const products = [];
        const errors   = [];

        for (let i = 0; i < ids.length; i += 20) {
            const chunk = ids.slice(i, i + 20);
            const url = `${HOKA_BASE}/api/catalog/products/snapshots?${chunk.map(id => `id=${id}`).join('&')}&expectedDeliveryDate=${encodeURIComponent(dd)}`;
            try {
                const snapRes = await fetchWithAuth(url);
                if (!snapRes.ok) { errors.push({ chunk: chunk.join(','), error: `HTTP ${snapRes.status}` }); continue; }
                const snapshots = await snapRes.json();
                const snapArr = Array.isArray(snapshots) ? snapshots
                    : Array.isArray(snapshots?.Model) ? snapshots.Model : [];
                for (const snap of snapArr) {
                    try {
                        const summary = parser.parseSnapshotToSummary(snap);
                        if (summary) products.push(summary);
                    } catch (e) { errors.push({ id: snap?.Id, error: e.message }); }
                }
            } catch (e) { errors.push({ chunk: chunk.join(','), error: e.message }); }
        }

        console.log(`[Hørkram] ← ${products.length}/${ids.length} snapshots OK${errors.length ? `, ${errors.length} fejl` : ''}`);
        res.json({ products, requested: ids.length, returned: products.length, ...(errors.length ? { errors } : {}) });
    } catch (err) {
        console.error('[Hørkram snapshots]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — FAVORIT-LISTER
   ══════════════════════════════════════════════════════════ */

// Alle favoritlister (custom + navigation/genererede)
router.get('/favorites', async (req, res) => {
    try {
        console.log('[Hørkram] → GET favorites lists');
        const [customRes, navRes] = await Promise.all([
            fetchWithAuth(`${HOKA_BASE}/api/favorites`),
            fetchWithAuth(`${HOKA_BASE}/api/navigation/favorites`),
        ]);
        const customData = customRes.ok ? await customRes.json() : { Model: [] };
        const navData    = navRes.ok    ? await navRes.json()    : { Model: [] };
        const parsed = parser.parseFavoriteLists(customData, navData);
        console.log(`[Hørkram] ← ${parsed.lists.length} favoritlister`);
        res.json(parsed);
    } catch (err) {
        console.error('[Hørkram favorites]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Produkter i favorit-liste — enkelt side, enriched med isAgreementItem
router.get('/favorites/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const page   = parseInt(req.query.page) || 1;
        console.log(`[Hørkram] → GET favorites/${id} page=${page}`);

        const url = id === 'salesstatistics'
            ? `${HOKA_BASE}/api/accounting/salesstatistics?page=${page}`
            : `${HOKA_BASE}/api/favorites/${id}?page=${page}`;

        const apiRes = await fetchWithAuth(url);
        if (!apiRes.ok) {
            const text = await apiRes.text();
            return res.status(apiRes.status).json({ error: `Hørkram API fejl: HTTP ${apiRes.status}`, detail: text.substring(0, 500) });
        }

        const raw    = await apiRes.json();
        const parsed = parser.parseFavoriteProducts(raw, id);
        await enrichWithAftale(parsed.products);

        console.log(`[Hørkram] ← ${parsed.products.length}/${parsed.totalResults} fra favorites/${id}`);
        res.json(parsed);
    } catch (err) {
        console.error('[Hørkram favorites/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ALLE produkter i favorit-liste — auto-pagineret + enriched
// Bruges af initial bulk-scrape i settings admin
router.get('/favorites/:id/all', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[Hørkram] → GET favorites/${id}/all (auto-pagineret)`);

        let allProducts = [];
        let listName    = '';
        let page        = 1;
        let totalPages  = 1;

        while (page <= totalPages) {
            const url = id === 'salesstatistics'
                ? `${HOKA_BASE}/api/accounting/salesstatistics?page=${page}`
                : `${HOKA_BASE}/api/favorites/${id}?page=${page}`;

            const apiRes = await fetchWithAuth(url);
            if (!apiRes.ok) {
                const text = await apiRes.text();
                return res.status(apiRes.status).json({ error: `Hørkram API fejl: HTTP ${apiRes.status}`, detail: text.substring(0, 500) });
            }

            const raw    = await apiRes.json();
            const parsed = parser.parseFavoriteProducts(raw, id);
            if (page === 1) { listName = parsed.listName; totalPages = parsed.totalPages; }
            allProducts.push(...parsed.products);
            console.log(`[Hørkram] favorites/${id}/all: side ${page}/${totalPages} — ${parsed.products.length} produkter`);
            page++;
        }

        await enrichWithAftale(allProducts);

        console.log(`[Hørkram] ← ${allProducts.length} total produkter fra favorites/${id}/all`);
        res.json({ listId: id, listName, totalProducts: allProducts.length, products: allProducts });
    } catch (err) {
        console.error('[Hørkram favorites/:id/all]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — KURV (BASKET)
   OBS: Kræver CSRF-token fra session. Bruger antiForgeryToken
   fra sessionCache — sættes under login.
   ══════════════════════════════════════════════════════════ */

// Hent aktiv kurv. Default til sessionCache.basketId (sat af PUT) så GET
// efter PUT returnerer samme kurv — ellers ville Hoka skabe en ny tom basket
// hver gang og UI'en ville ikke se de varer der lige blev lagt i.
router.get('/basket', async (req, res) => {
    try {
        const basketId = req.query.id || sessionCache.basketId || '0';
        console.log(`[Hørkram] → GET basket (id=${basketId})`);
        const url = `${HOKA_BASE}/api/checkout/basket?id=${basketId}`;
        const apiRes = await fetchWithAuth(url);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });

        const data   = await apiRes.json();
        const basket = data?.Model;
        console.log(`[Hørkram] ← Kurv id=${basket?.Id}, ${basket?.LineItems?.length || 0} linjer`);
        // Debug: log first line item structure
        if (basket?.LineItems?.length > 0) {
            console.log('[Hørkram] LineItem[0] keys:', Object.keys(basket.LineItems[0]).join(', '));
            var li0 = basket.LineItems[0];
            console.log('[Hørkram] LineItem[0] Product:', JSON.stringify(li0.Product).substring(0, 200));
            console.log('[Hørkram] LineItem[0] Packing:', JSON.stringify(li0.Packing).substring(0, 200));
            console.log('[Hørkram] LineItem[0] SalesUnitTextSingular:', li0.SalesUnitTextSingular, 'SalesUnitIndex:', li0.SalesUnitIndex);
        }
        // Also check InvalidLineItems
        if (basket?.InvalidLineItems?.length > 0) {
            console.log('[Hørkram] InvalidLineItems:', JSON.stringify(basket.InvalidLineItems).substring(0, 500));
        }
        res.json({
            id:           basket?.Id,
            lineCount:    basket?.LineItems?.length || 0,
            invalidCount: basket?.InvalidLineItems?.length || 0,
            subtotal:     basket?.Subtotal,
            deliveryDate: basket?.DeliveryDate,
            deadline:     basket?.OrderDeadline,
            lines: (basket?.LineItems || []).map(li => ({
                productId: li.Product?.Id,
                name:      li.Product?.DisplayName,
                quantity:  li.Quantity,
                salesUnit: li.SalesUnitTextSingular,
                salesUnitIndex: li.SalesUnitIndex,
                lineTotal: li.LineSubtotal,
                packing:   li.Packing,
            })),
            invalidLines: (basket?.InvalidLineItems || []).slice(0, 5),
        });
    } catch (err) {
        console.error('[Hørkram basket]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Tilføj/opdater varer i kurv.
 * PUT /api/horkram/basket/add
 *
 * Body: {
 *   products: [{
 *     varenummer:       string | number,  // Hokas produkt-ID
 *     quantity:         number,
 *     salesUnitCode:    string,  // fra bc.userfields.supplier_unit_code, fx 'ks', 'st'
 *     salesUnitQuantity: number, // fra bc.userfields.supplier_unit_qty
 *   }]
 * }
 *
 * Kaldt af shared/indkob.js via putHokaBasket() i shared/api.js.
 */
router.put('/basket/add', async (req, res) => {
    try {
        const { products, basketId } = req.body;
        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'products array påkrævet' });
        }

        console.log(`[Hørkram] → PUT basket/add: ${products.length} varer`);

        // Sørg for at vi har session + CSRF-token
        await getSession();
        const { antiForgeryToken, antiForgeryHeader } = sessionCache;

        if (!antiForgeryToken) {
            return res.status(500).json({ error: 'Ingen CSRF-token — prøv POST /api/horkram/login' });
        }

        // Find aktiv kurv-ID — cache for genbrug
        let targetBasketId = basketId || sessionCache.basketId;
        if (!targetBasketId) {
            // Hent alle kurve og brug den aktive (ikke id=0 som opretter ny)
            const basketRes = await fetchWithAuth(`${HOKA_BASE}/api/checkout/basket`);
            if (basketRes.ok) {
                const basketData = await basketRes.json();
                // Model kan være en enkelt kurv eller have AllBaskets
                const model = basketData?.Model;
                targetBasketId = model?.Id;
                // Hvis AllBaskets eksisterer, brug den første aktive
                if (!targetBasketId && model?.AllBaskets?.length) {
                    targetBasketId = model.AllBaskets[0]?.Id;
                }
            }
            // Fallback: opret ny kurv
            if (!targetBasketId) {
                const newRes = await fetchWithAuth(`${HOKA_BASE}/api/checkout/basket?id=0`);
                if (newRes.ok) {
                    const newData = await newRes.json();
                    targetBasketId = newData?.Model?.Id;
                }
            }
            // Cache basket-ID for denne session
            if (targetBasketId) sessionCache.basketId = targetBasketId;
        }
        if (!targetBasketId) return res.status(500).json({ error: 'Kunne ikke finde aktiv kurv' });

        // Resolve SalesUnitIndex for alle varer via snapshot
        // Hoka bruger SalesUnitIndex (0, 1, ...) i PUT — ikke Code/Quantity
        for (const p of products) {
            try {
                const dd = deliveryDate();
                const snapUrl = `${HOKA_BASE}/api/catalog/products/snapshots?id=${parseInt(p.varenummer || p.productId)}&expectedDeliveryDate=${encodeURIComponent(dd)}`;
                const snapRes = await fetchWithAuth(snapUrl);
                if (snapRes.ok) {
                    const snapData = await snapRes.json();
                    const snapArr = Array.isArray(snapData) ? snapData : Array.isArray(snapData?.Model) ? snapData.Model : [];
                    if (snapArr.length > 0) {
                        const su = snapArr[0].SalesUnits?.Values;
                        if (su && su.length > 0) {
                            // Find matching unit by code, eller brug default
                            let match;
                            if (p.salesUnitCode && p.salesUnitCode !== 'st') {
                                match = su.find(u => u.Code === p.salesUnitCode);
                            }
                            if (!match) {
                                match = su.find(u => u.IsDefault) || su[0];
                            }
                            const idx = su.findIndex(u => u.Code === match.Code);
                            p._salesUnitIndex = idx >= 0 ? idx : 0;
                            p.salesUnitCode = match.Code;
                            p.salesUnitQuantity = match.Quantity || 1;
                            console.log(`[Hørkram] SalesUnit for ${p.varenummer}: ${match.Code} idx=${p._salesUnitIndex} (${match.TextSingular || ''})`);
                        }
                    }
                }
            } catch (e) {
                console.log(`[Hørkram] ⚠ Snapshot lookup for salesUnit fejlede: ${e.message}`);
            }
        }

        // ── Hent eksisterende kurv og re-send med nye varer ──
        // Hoka PUT erstatter hele kurven → vi SKAL inkludere eksisterende.
        // Format: SalesUnit { Code, Quantity } — bekræftet fra Hokas egen frontend.
        // For eksisterende varer: omit SalesUnit (Hoka bevarer den valgte enhed).
        let existingProducts = [];
        try {
            const curRes = await fetchWithAuth(`${HOKA_BASE}/api/checkout/basket?id=${targetBasketId}`);
            if (curRes.ok) {
                const curData = await curRes.json();
                const curLines = curData?.Model?.LineItems || [];
                existingProducts = curLines.map(li => ({
                    ProductId:         li.Product?.Id,
                    Quantity:          li.Quantity,
                    SalesUnitIndex:    li.SalesUnitIndex ?? 0,
                    SalesUnitQuantity: li.SalesUnitQuantity ?? 1,
                })).filter(p => p.ProductId);
                console.log(`[Hørkram] Eksisterende kurv: ${existingProducts.length} gyldige linjer`);
            }
        } catch (e) {
            console.log('[Hørkram] ⚠ Kunne ikke hente eksisterende kurv:', e.message);
        }

        // Byg nye varer. Hoka forventer SalesUnit som nested objekt med
        // { Code, Quantity } — ikke kun SalesUnitIndex. Felt-navnet
        // SalesUnitQuantity på line-niveau ignoreres af Hokas validator
        // (verificeret: InvalidLineItem.HasSalesUnitQuantity=false selvom
        // SalesUnitQuantity er sendt). Korrekte format er nested SalesUnit.
        const newProducts = [];
        for (const p of products) {
            const pid = parseInt(p.varenummer || p.productId);
            if (!pid || isNaN(pid)) {
                console.warn('[Hørkram] ⚠ Springer over produkt med ugyldigt varenummer:', p.varenummer, p.productId);
                continue;
            }
            newProducts.push({
                ProductId:      pid,
                Quantity:       parseFloat(p.quantity) || 1,
                SalesUnitIndex: p._salesUnitIndex ?? 0,
                SalesUnit: {
                    Code:     p.salesUnitCode || 'st',
                    Quantity: parseFloat(p.salesUnitQuantity) || 1,
                },
            });
        }

        // Merge: eksisterende + nye — begge bruger SalesUnitIndex-format
        const newIds = new Set(newProducts.map(p => p.ProductId));
        const merged = existingProducts
            .filter(p => !newIds.has(p.ProductId))
            .concat(newProducts);

        console.log(`[Hørkram] Sender ${merged.length} varer (${existingProducts.length} eksisterende + ${newProducts.length} nye)`);

        const body = {
            Products: merged,
            triggerValidation: false,
        };

        const url = `${HOKA_BASE}/api/checkout/basket?id=${targetBasketId}&validate=false`;
        const apiRes = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Cookie:         sessionCache.cookies,
                'User-Agent':   UA,
                Accept:         'application/json',
                [antiForgeryHeader]: antiForgeryToken,
                Origin:  HOKA_BASE,
                Referer: `${HOKA_BASE}/da-dk/checkout/basket`,
            },
            body: JSON.stringify(body),
        });

        if (!apiRes.ok) {
            // Basket-ID kan være udløbet — opret ny kurv og prøv igen
            if (apiRes.status === 404 && targetBasketId) {
                console.log(`[Hørkram] ← Basket ${targetBasketId} ikke fundet (404) — opretter ny kurv`);
                sessionCache.basketId = null;
                const newRes = await fetchWithAuth(`${HOKA_BASE}/api/checkout/basket?id=0`);
                if (newRes.ok) {
                    const newData = await newRes.json();
                    targetBasketId = newData?.Model?.Id;
                    if (targetBasketId) {
                        sessionCache.basketId = targetBasketId;
                        // Retry PUT med ny kurv (kun nye varer, eksisterende er tabt)
                        const retryBody = { Products: newProducts, triggerValidation: false };
                        const retryUrl = `${HOKA_BASE}/api/checkout/basket?id=${targetBasketId}&validate=false`;
                        const retryRes = await fetch(retryUrl, {
                            method: 'PUT',
                            headers: {
                                'Content-Type': 'application/json',
                                Cookie: sessionCache.cookies,
                                'User-Agent': UA,
                                Accept: 'application/json',
                                [antiForgeryHeader]: antiForgeryToken,
                                Origin: HOKA_BASE,
                                Referer: `${HOKA_BASE}/da-dk/checkout/basket`,
                            },
                            body: JSON.stringify(retryBody),
                        });
                        if (retryRes.ok) {
                            const retryResult = await retryRes.json();
                            const retryUpdated = retryResult?.Model;
                            if (retryUpdated?.Id) sessionCache.basketId = retryUpdated.Id;
                            console.log(`[Hørkram] ← Ny kurv oprettet: ${retryUpdated?.LineItems?.length || '?'} linjer`);
                            return res.json({
                                ok: true, basketId: retryUpdated?.Id,
                                lineCount: retryUpdated?.LineItems?.length || 0,
                                addedProducts: newProducts.length,
                            });
                        }
                    }
                }
            }
            const errText = await apiRes.text().catch(() => '');
            console.error(`[Hørkram] ← Basket PUT fejl: HTTP ${apiRes.status}`, errText.substring(0, 300));
            return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}`, detail: errText.substring(0, 300) });
        }

        const result = await apiRes.json();
        const updated = result?.Model;
        console.log(`[Hørkram] ← Kurv opdateret: ${updated?.LineItems?.length || '?'} linjer, total=${updated?.Subtotal}`);
        // Opdater cached basket-ID (PUT kan returnere ny ID)
        if (updated?.Id) sessionCache.basketId = updated.Id;

        if (!updated?.LineItems?.length) {
            console.log('[Hørkram] ← Basket response keys:', Object.keys(result || {}));
            console.log('[Hørkram] ← Model keys:', Object.keys(updated || {}));
            console.log('[Hørkram] ← BasketId brugt:', targetBasketId);
            console.log('[Hørkram] ← Body sendt:', JSON.stringify(body).substring(0, 300));
            // Check InvalidLineItems
            if (updated?.InvalidLineItems?.length) {
                console.log('[Hørkram] ← InvalidLineItems:', JSON.stringify(updated.InvalidLineItems).substring(0, 500));
            }
        }

        res.json({
            ok:            true,
            basketId:      updated?.Id,
            lineCount:     updated?.LineItems?.length || 0,
            subtotal:      updated?.Subtotal,
            addedProducts: products.length,
        });
    } catch (err) {
        console.error('[Hørkram basket/add]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — LEVERING
   ══════════════════════════════════════════════════════════ */

router.get('/delivery-dates', async (req, res) => {
    try {
        const apiRes = await fetchWithAuth(`${HOKA_BASE}/api/delivery/dates`);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });
        res.json(await apiRes.json());
    } catch (err) {
        console.error('[Hørkram delivery-dates]', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/dropsize', async (req, res) => {
    try {
        const subtotal = parseFloat(req.query.subtotal) || 0;
        const date = req.query.date || new Date().toISOString();
        const dateStr = encodeURIComponent(new Date(date).toISOString());
        const apiRes = await fetchWithAuth(
            `${HOKA_BASE}/api/delivery/dropsize/ofbasket?basketSubTotal=${subtotal}&expectedDeliveryDate=${dateStr}`
        );
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });
        const data = await apiRes.json();
        res.json(data);
    } catch (err) {
        console.error('[Hørkram dropsize]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — ORDREHISTORIK
   ══════════════════════════════════════════════════════════ */

router.get('/orders', async (req, res) => {
    try {
        const apiRes = await fetchWithAuth(`${HOKA_BASE}/api/accounting/orders`);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });
        res.json(await apiRes.json());
    } catch (err) {
        console.error('[Hørkram orders]', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/orders/:id', async (req, res) => {
    try {
        const apiRes = await fetchWithAuth(`${HOKA_BASE}/api/accounting/orders/${req.params.id}`);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });
        res.json(await apiRes.json());
    } catch (err) {
        console.error('[Hørkram orders/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Købshistorik for enkelt produkt
router.get('/products/:id/history', async (req, res) => {
    try {
        console.log(`[Hørkram] → GET history/${req.params.id}`);
        const apiRes = await fetchWithAuth(`${HOKA_BASE}/api/accounting/purchasehistory/${req.params.id}`);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: `HTTP ${apiRes.status}` });
        res.json(await apiRes.json());
    } catch (err) {
        console.error('[Hørkram history]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ══════════════════════════════════════════════════════════
   ROUTES — DEBUG (behold til fejlfinding)
   ══════════════════════════════════════════════════════════ */

router.get('/debug/:varenr', async (req, res) => {
    try {
        const url = `${HOKA_BASE}/api/catalog/products/${req.params.varenr}?expectedDeliveryDate=${encodeURIComponent(deliveryDate())}`;
        const apiRes = await fetchWithAuth(url);
        const raw = await apiRes.json();
        const m = raw?.Model || {};
        res.json({
            httpStatus:         apiRes.status,
            hasModel:           !!raw.Model,
            salesUnits:         m.SalesUnits,
            salesPriceSource:   m.SalesPriceSource,
            isOnFavoriteList:   m.IsOnFavoriteList,
            supplierItemNumber: m.SupplierItemNumber,
            availableForOrder:  m.AvailableForOrder ?? null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
