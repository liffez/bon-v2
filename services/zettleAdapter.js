/**
 * services/zettleAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Zettle (PayPal POS).
 *
 * Søskende til grocyAdapter.js / byExpressenAdapter.js — ENESTE sted der taler
 * med Zettle. Resten af systemet kender kun dette interface.
 *
 * Spec:      docs/CLAUDE_ZETTLE_POS.md  (§5 adapter, §15 målte payload-former)
 * Reference: tests/fixtures/zettle/*.json — alle shapes er verificeret mod
 *            produktionskontoen 21. august 2026, ikke gættet fra dokumentation.
 *
 * LÆSER KUN. Ingen funktion her skriver til Zettle. `WRITE:PRODUCT` er tildelt
 * vores nøgle, men bruges ikke — produkt-push er en selvstændig opgave (§7 niveau C).
 *
 * Designet som FACTORY (createZettleAdapter) så HTTP kan mockes i unit-tests
 * uden live-API — samme mønster som byExpressenAdapter. `getZettleAdapter()`
 * bygger en delt instans fra .env.
 *
 * Auth:  POST oauth.zettle.com/token med JWT-bearer-grant (API-nøgle som
 *        `assertion`). Ingen OAuth-dans — nøglen er til egen organisation.
 *        Token holder 7200 sek; caches til 60 sek før udløb.
 *
 * ── Kvirks der koster tid at genopdage (alle målt, §15) ──────────────────
 *   • `endDate` i purchases-API'et er EKSKLUSIV. Denne adapter tager et
 *     INKLUSIVT `to` og lægger dagen til selv — kaldere skal ikke kende det.
 *   • Token-svaret har hverken `scope` eller `token_type`; scopes ligger i
 *     JWT-payloadens `scope`.
 *   • Beløb kommer i ØRE. Konverteringen til kroner sker HER og kun her, så
 *     resten af systemet regner i samme enhed som bon_lines.
 *   • Priser er INCL moms (`taxationMode: "INCLUSIVE"`). Verificeret på ægte
 *     data: nettoen udregnet med Moms.inclToExcl rammer `brutto − vatAmount`
 *     på kronen. Matcher bon_lines.unit_price direkte — der må ALDRIG
 *     momsomregnes her.
 * ════════════════════════════════════════════════════════════
 */

const TOKEN_URL    = process.env.ZETTLE_TOKEN_URL    || 'https://oauth.zettle.com/token';
const PURCHASE_URL = process.env.ZETTLE_PURCHASE_URL || 'https://purchase.izettle.com';
const FINANCE_URL  = process.env.ZETTLE_FINANCE_URL  || 'https://finance.izettle.com';

const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/* ══════════════════════════════════════════════════════════════
   FEJL
   ══════════════════════════════════════════════════════════════ */

class ZettleError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'ZettleError';
        this.status = status;   // HTTP-status
        this.code = code;       // 'not_configured' | 'auth_failed' | 'timeout' | 'http_error' | 'bad_input'
        this.body = body;       // rå svar (afkortet) til fejlsøgning
    }
}

/* ══════════════════════════════════════════════════════════════
   RENE HJÆLPERE — eksporteres, så de kan testes uden adapter-instans
   ══════════════════════════════════════════════════════════════ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Læs JWT-payload uden at verificere signaturen (det er Zettles eget token). */
function decodeJwtPayload(token) {
    try {
        return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

/** Scopes fra access-tokenet. Token-SVARET har dem ikke — kun JWT'en. */
function scopesFromToken(token) {
    const p = decodeJwtPayload(token);
    if (!p) return [];
    const raw = p.scope ?? p.scopes ?? '';
    return (Array.isArray(raw) ? raw : String(raw).split(/\s+/)).filter(Boolean);
}

/**
 * Læg n dage til en ren datostreng. Bruges KUN til at gøre adapterens
 * inklusive `to` om til API'ets eksklusive `endDate` — aldrig til "i dag".
 * `new Date(<streng>)` på en dato-only-værdi er UTC-midnat i begge ender,
 * så aritmetikken er eksakt og uafhængig af maskinens tidszone.
 */
function addDays(dateStr, n) {
    if (!DATE_RE.test(String(dateStr || ''))) {
        throw new ZettleError(`dato skal være YYYY-MM-DD, fik "${dateStr}"`, { code: 'bad_input' });
    }
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);   // utc-ok: ren datoaritmetik på en given dato, ikke "i dag"
}

/** Øre → kroner. Ét sted, så afrundingen ikke kan drive fra hinanden. */
function oereToKr(oere) {
    const n = Number(oere);
    return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

/**
 * Rå Zettle-køb → den form resten af systemet arbejder i.
 *
 * Beløb i kroner INCL moms. Ingen momsomregning — se filhovedet.
 *
 * ⚠️ Refunderinger er DEFENSIVT håndteret: der fandtes ikke én eneste i de
 * 12 måneder Fase 1 scannede (§15), så det præcise format er uverificeret.
 * Vi accepterer derfor både "negativt beløb" og "positivt beløb + refund-flag"
 * og normaliserer til et negativt beløb. Den første ægte refundering skal
 * efterprøves i hånden mod bonnen.
 */
function normalizePurchase(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new ZettleError('normalizePurchase kaldt uden køb', { code: 'bad_input' });
    }
    const isRefund = raw.refund === true;
    const sign = isRefund ? -1 : 1;
    const abs = v => Math.abs(oereToKr(v));

    const payments = (raw.payments || []).map(p => ({
        type: p.type || null,
        amount_incl: sign * abs(p.amount),
    }));

    const lines = (raw.products || []).map(p => {
        const qty = Math.abs(Number(p.quantity) || 0);
        const unit = abs(p.unitPrice);
        return {
            name: p.name ?? null,
            variant_name: p.variantName || null,
            quantity: sign * qty,
            unit_price_incl: unit,
            line_total_incl: Math.round(sign * qty * unit * 100) / 100,
            product_uuid: p.productUuid ?? null,   // null = løssalg / vare uden produktkort
            variant_uuid: p.variantUuid ?? null,
            vat_percentage: p.vatPercentage ?? null,
            sku: p.sku || null,
        };
    });

    return {
        source: 'zettle',
        purchase_uuid: raw.purchaseUUID ?? null,
        purchase_no: raw.purchaseNumber ?? null,
        occurred_at: raw.timestamp ?? null,          // som Zettle leverer den (UTC-mærket)
        amount_incl: sign * abs(raw.amount),
        vat_amount: sign * abs(raw.vatAmount),
        currency: raw.currency ?? null,
        taxation_mode: raw.taxationMode ?? null,     // "INCLUSIVE" forventet — se assertInclusiveVat
        payment_type: payments[0]?.type ?? null,
        payments,
        is_refund: isRefund,
        was_refunded: raw.refunded === true,
        refunds_purchase_uuid: raw.refundsPurchaseUUID ?? null,
        custom_amount_sale: raw.customAmountSale === true,
        site_uuid: raw.site?.uuid ?? null,           // → events.pos_store_ref
        site_name: raw.site?.displayName ?? null,
        user_name: raw.userDisplayName ?? null,
        lines,
        raw,
    };
}

/**
 * Vagt mod at momsgrundlaget skifter under os. Hele designet hviler på at
 * Zettle-priser er incl moms; ville et køb komme EXCLUSIVE, ville bonnen få
 * for lave priser uden at nogen kunne se det på tallet.
 * Returnerer de køb der IKKE er inklusive (tom liste = alt vel).
 */
function findExclusiveVat(purchases) {
    return (purchases || []).filter(p => {
        const m = p.taxation_mode ?? p.taxationMode;
        return m && String(m).toUpperCase() !== 'INCLUSIVE';
    });
}

/* ══════════════════════════════════════════════════════════════
   FACTORY
   ══════════════════════════════════════════════════════════════ */

/**
 * @param {object} cfg
 * @param {string} cfg.clientId    ZETTLE_CLIENT_ID (organisations-UUID)
 * @param {string} cfg.apiKey      ZETTLE_API_KEY
 * @param {function} [cfg.fetchImpl]  injiceres i test
 * @param {function} [cfg.now]        injiceres i test (ms siden epoch)
 * @param {number} [cfg.timeoutMs]
 * @param {number} [cfg.maxPages]  værn mod en paginering der aldrig slutter
 */
function createZettleAdapter({
    clientId,
    apiKey,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = 30000,
    maxPages = 60,
} = {}) {

    let tokenCache = null;   // { token, expiresAt }

    function isConfigured() {
        return Boolean(clientId && apiKey);
    }

    function requireConfig() {
        if (!isConfigured()) {
            throw new ZettleError(
                'Zettle ikke konfigureret. Sæt ZETTLE_CLIENT_ID og ZETTLE_API_KEY i .env.',
                { code: 'not_configured' });
        }
    }

    function clearCache() { tokenCache = null; }

    async function request(url, { headers = {}, method = 'GET' } = {}) {
        let res;
        try {
            res = await fetchImpl(url, {
                method,
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
            throw new ZettleError(
                timedOut ? `Zettle svarede ikke inden ${timeoutMs} ms` : `Zettle utilgængelig: ${err.message}`,
                { code: timedOut ? 'timeout' : 'http_error' });
        }
        return res;
    }

    async function getAccessToken() {
        requireConfig();
        if (tokenCache && tokenCache.expiresAt > now()) return tokenCache.token;

        let res;
        try {
            res = await fetchImpl(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: JWT_GRANT,
                    client_id: clientId,
                    assertion: apiKey,
                }).toString(),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
            throw new ZettleError(
                timedOut ? 'Zettle-login svarede ikke i tide' : `Zettle-login utilgængeligt: ${err.message}`,
                { code: timedOut ? 'timeout' : 'http_error' });
        }

        const body = await res.text();
        if (!res.ok) {
            throw new ZettleError(`Zettle afviste API-nøglen (HTTP ${res.status})`,
                { status: res.status, code: 'auth_failed', body: body.slice(0, 400) });
        }

        let json;
        try { json = JSON.parse(body); } catch {
            throw new ZettleError('Zettle-login gav ikke JSON', { code: 'auth_failed', body: body.slice(0, 200) });
        }
        if (!json.access_token) {
            throw new ZettleError('Zettle-login gav intet access_token', { code: 'auth_failed' });
        }

        // 60 sek margin, så et token ikke udløber mellem tjek og brug.
        const ttl = Math.max(0, (Number(json.expires_in) || 0) - 60) * 1000;
        tokenCache = { token: json.access_token, expiresAt: now() + ttl };
        return json.access_token;
    }

    async function authHeaders() {
        return { Authorization: 'Bearer ' + await getAccessToken() };
    }

    /**
     * Køb i et INKLUSIVT datointerval. Adapteren lægger selv dagen til, fordi
     * API'ets `endDate` er eksklusiv (målt — se filhovedet).
     * Returnerer normaliserede køb; `{ raw: true }` giver dem urørte.
     */
    async function getPurchases({ from, to, raw = false } = {}) {
        if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
            throw new ZettleError('from og to skal være YYYY-MM-DD', { code: 'bad_input' });
        }
        if (from > to) {
            throw new ZettleError(`from (${from}) er efter to (${to})`, { code: 'bad_input' });
        }
        const headers = await authHeaders();
        const out = [];
        const seen = new Set();
        let hash = null;
        let pages = 0;

        while (pages < maxPages) {
            const u = new URL('/purchases/v2', PURCHASE_URL);
            u.searchParams.set('startDate', from);
            u.searchParams.set('endDate', addDays(to, 1));   // API'et er eksklusivt
            u.searchParams.set('limit', '1000');
            if (hash) u.searchParams.set('lastPurchaseHash', hash);

            const res = await request(u.toString(), { headers });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new ZettleError(`Kunne ikke hente køb (HTTP ${res.status})`,
                    { status: res.status, code: 'http_error', body: body.slice(0, 400) });
            }
            const page = await res.json();
            const list = page.purchases || [];
            if (list.length === 0) break;

            // Værn: en paginering der giver samme side igen ville ellers loope
            // til maxPages og tælle hvert køb 60 gange.
            let fresh = 0;
            for (const p of list) {
                const key = p.purchaseUUID || `${p.purchaseNumber}:${p.timestamp}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(p);
                fresh++;
            }
            pages++;
            if (fresh === 0) break;
            if (!page.lastPurchaseHash || page.lastPurchaseHash === hash) break;
            hash = page.lastPurchaseHash;
        }

        return raw ? out : out.map(normalizePurchase);
    }

    /**
     * Finance-transaktioner (udbetalinger + faktiske gebyrer) — Fase 3.
     * ⚠️ Endnu ikke afprøvet mod ægte data; svaret returneres urørt indtil
     * formen er verificeret, netop for ikke at bygge en normalisering på et gæt.
     */
    async function getFinanceTransactions({ from, to, account = 'liquid' } = {}) {
        if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
            throw new ZettleError('from og to skal være YYYY-MM-DD', { code: 'bad_input' });
        }
        const headers = await authHeaders();
        const u = new URL(`/v2/accounts/${encodeURIComponent(account)}/transactions`, FINANCE_URL);
        u.searchParams.set('start', from);
        u.searchParams.set('end', addDays(to, 1));
        const res = await request(u.toString(), { headers });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new ZettleError(`Kunne ikke hente finans-transaktioner (HTTP ${res.status})`,
                { status: res.status, code: 'http_error', body: body.slice(0, 400) });
        }
        return res.json();
    }

    /** Til Settings-panelet: virker nøglen, og har den de scopes vi skal bruge? */
    async function healthCheck() {
        if (!isConfigured()) {
            return { ok: false, configured: false, reason: 'ZETTLE_CLIENT_ID/ZETTLE_API_KEY mangler i .env' };
        }
        try {
            const token = await getAccessToken();
            const scopes = scopesFromToken(token);
            const required = ['READ:PURCHASE', 'READ:FINANCE'];
            const missing = required.filter(s => !scopes.includes(s));
            return {
                ok: missing.length === 0,
                configured: true,
                scopes,
                missing_scopes: missing,
                ...(missing.length ? { reason: 'API-nøglen mangler scope: ' + missing.join(', ') } : {}),
            };
        } catch (err) {
            return { ok: false, configured: true, reason: err.message, code: err.code || null };
        }
    }

    return {
        isConfigured, clearCache, getAccessToken,
        getPurchases, getFinanceTransactions, healthCheck,
    };
}

/* ══════════════════════════════════════════════════════════════
   DELT INSTANS (fra .env)
   ══════════════════════════════════════════════════════════════ */

let _shared = null;
function getZettleAdapter() {
    if (!_shared) {
        _shared = createZettleAdapter({
            clientId: process.env.ZETTLE_CLIENT_ID,
            apiKey: process.env.ZETTLE_API_KEY,
        });
    }
    return _shared;
}
function resetSharedAdapter() { _shared = null; }

module.exports = {
    createZettleAdapter,
    getZettleAdapter,
    resetSharedAdapter,
    ZettleError,
    // rene hjælpere (testes direkte)
    normalizePurchase,
    findExclusiveVat,
    decodeJwtPayload,
    scopesFromToken,
    addDays,
    oereToKr,
};
