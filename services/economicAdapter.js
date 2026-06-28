/**
 * services/economicAdapter.js
 * ════════════════════════════════════════════════════════════
 * Auth-/forbindelseslag til e-conomic (Spor 1).
 *
 * Spec: docs/economics/CLAUDE_ECONOMIC_AUTH.md (tokens, API-baser, fejl).
 * Dette modul dækker KUN forbindelsen — payload/bon→faktura-mapning hører i
 * en senere fil (jf. CLAUDE_ECONOMIC_ADAPTER.md, Spor 2).
 *
 * To tokens, to logins (AUTH §1) — begge sendes som HTTP-headers på hvert kald:
 *   X-AppSecretToken       = vores integration (developer agreement)
 *   X-AgreementGrantToken  = Ristet Rugs regnskabsdata (installation URL)
 *
 * Env-navne (begge varianter accepteres — det deployede navn uden _TOKEN først):
 *   ECONOMIC_APP_SECRET       (alias: ECONOMIC_APP_SECRET_TOKEN)
 *   ECONOMIC_AGREEMENT_GRANT  (alias: ECONOMIC_AGREEMENT_GRANT_TOKEN)
 *
 * To API-baser (AUTH §2):
 *   REST    = restapi.e-conomic.com  (kunder, fakturaudkast, bogførte fakturaer)
 *   OpenAPI = apis.e-conomic.com     (bogførte poster / betalingsafstemning)
 *
 * Bruger global fetch (Node 22+) — ingen npm-pakke (stdlib-first).
 * Readonly i Spor 1; skrive-kald (drafts) bygges i Spor 2.
 * ════════════════════════════════════════════════════════════
 */

const REST_BASE    = process.env.ECONOMIC_REST_BASE    || 'https://restapi.e-conomic.com';
const OPENAPI_BASE = process.env.ECONOMIC_OPENAPI_BASE || 'https://apis.e-conomic.com';

// Timeout pr. kald — e-conomic er normalt hurtig; undgå at hænge på netværksfejl.
const REQUEST_TIMEOUT_MS = 20_000;

/* ══════════════════════════════════════════════════════════════
   FEJLKLASSER (AUTH §5)
   ══════════════════════════════════════════════════════════════ */

class EconomicError extends Error {
    constructor(message, { status = null, body = null } = {}) {
        super(message);
        this.name = 'EconomicError';
        this.status = status;
        this.body = body;
    }
}

/** Manglende/ufuldstændig konfiguration — kald aldrig forsøgt. */
class EconomicConfigError extends EconomicError {
    constructor(message) {
        super(message);
        this.name = 'EconomicConfigError';
        this.code = 'not_configured';
    }
}

/** 401 — grant token tilbagekaldt/ugyldig. Kræver manuel ny grant (AUTH §5). */
class EconomicAuthError extends EconomicError {
    constructor(message, opts) {
        super(message, opts);
        this.name = 'EconomicAuthError';
        this.code = 'auth';
    }
}

/** 429 — over rate limit (fair use 50.000 kald/24t pr. agreement). */
class EconomicRateError extends EconomicError {
    constructor(message, opts) {
        super(message, opts);
        this.name = 'EconomicRateError';
        this.code = 'rate_limit';
    }
}

/* ══════════════════════════════════════════════════════════════
   AUTH-HEADERS
   ══════════════════════════════════════════════════════════════ */

function getTokens() {
    return {
        appSecret: process.env.ECONOMIC_APP_SECRET || process.env.ECONOMIC_APP_SECRET_TOKEN,
        grant:     process.env.ECONOMIC_AGREEMENT_GRANT || process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN,
    };
}

/** Er begge tokens sat? Bruges af UI/health til at vise "ikke konfigureret". */
function isConfigured() {
    const { appSecret, grant } = getTokens();
    return Boolean(appSecret && grant);
}

function authHeaders() {
    const { appSecret, grant } = getTokens();
    if (!appSecret || !grant) {
        throw new EconomicConfigError(
            'e-conomic er ikke konfigureret — sæt ECONOMIC_APP_SECRET + ' +
            'ECONOMIC_AGREEMENT_GRANT i .env (se docs/economics/CLAUDE_ECONOMIC_AUTH.md).'
        );
    }
    return {
        'X-AppSecretToken': appSecret,
        'X-AgreementGrantToken': grant,
        'Content-Type': 'application/json',
    };
}

/* ══════════════════════════════════════════════════════════════
   KERNE-FETCH (AUTH §4)
   ══════════════════════════════════════════════════════════════ */

/**
 * Lav ét kald mod en e-conomic-base.
 * @param {string} base  REST_BASE eller OPENAPI_BASE
 * @param {string} path  fx '/self' eller '/invoices/drafts'
 * @param {object} opts  { method, body, idempotencyKey }
 * @returns parsed JSON (eller null ved 204)
 */
async function ecoFetch(base, path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = authHeaders();
    // Idempotency kun relevant ved POST (AUTH §4) — caches 1 time hos e-conomic.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(`${base}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new EconomicError(`e-conomic timeout efter ${REQUEST_TIMEOUT_MS} ms (${method} ${path})`);
        }
        throw new EconomicError(`e-conomic netværksfejl: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401) {
        throw new EconomicAuthError('e-conomic-adgang skal genetableres (401) — grant token tilbagekaldt/ugyldig', { status: 401 });
    }
    if (res.status === 403) {
        const text = await res.text().catch(() => '');
        throw new EconomicError(`e-conomic 403 — tjek app-rolle (SuperUser/Sales): ${text}`, { status: 403, body: text });
    }
    if (res.status === 429) {
        throw new EconomicRateError('e-conomic rate limit ramt (429)', { status: 429 });
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new EconomicError(`e-conomic ${res.status}: ${text}`, { status: res.status, body: text });
    }
    if (res.status === 204) return null;
    return res.json();
}

/** Bekvem indgang mod REST-API'et (restapi.e-conomic.com). */
const rest = (path, opts) => ecoFetch(REST_BASE, path, opts);

/** Bekvem indgang mod OpenAPI (apis.e-conomic.com) — bruges af reconciliation senere. */
const openapi = (path, opts) => ecoFetch(OPENAPI_BASE, path, opts);

/* ══════════════════════════════════════════════════════════════
   VERIFIKATION (AUTH §6) — gate før Spor 2
   ══════════════════════════════════════════════════════════════ */

/** Rå /self — fuldt objekt. */
function getSelf() {
    return rest('/self');
}

/**
 * Tjek forbindelsen. Returnerer et roligt status-objekt frem for at kaste,
 * så et health-endpoint/CLI kan vise resultatet pænt.
 * @returns {Promise<{ok:boolean, configured:boolean, companyName?:string, reason?:string, code?:string}>}
 */
async function verifyConnection() {
    if (!isConfigured()) {
        return { ok: false, configured: false, reason: 'Tokens mangler i .env', code: 'not_configured' };
    }
    try {
        const self = await getSelf();
        return {
            ok: true,
            configured: true,
            // /self har historisk haft companyName direkte; nyere kan have company.name.
            companyName: self?.company?.name || self?.companyName || null,
            agreementNumber: self?.agreementNumber ?? null,
        };
    } catch (err) {
        return {
            ok: false,
            configured: true,
            reason: err.message,
            code: err.code || 'error',
            status: err.status || null,
        };
    }
}

module.exports = {
    // fetch-indgange
    rest,
    openapi,
    ecoFetch,
    // verifikation
    getSelf,
    verifyConnection,
    isConfigured,
    // baser (til debugging/health)
    REST_BASE,
    OPENAPI_BASE,
    // fejlklasser
    EconomicError,
    EconomicConfigError,
    EconomicAuthError,
    EconomicRateError,
};
