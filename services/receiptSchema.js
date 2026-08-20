/**
 * services/receiptSchema.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelsens FVST-skema — hentet fra Whiteboard.
 *
 * ── Hvorfor filen findes ──
 * Skemaet fandtes to steder. Whiteboard ejer definitionen i
 * registration_types.fields og kan redigeres i admin; Bon v2 havde en
 * håndskrevet kopi i shared/varemodtagelse.js:
 *
 *     _vmBuildTempRow('koel', '🧊', 'Kølevarer', 'max. 5°C', 4.5, 0.1, true, 4.7, 5)
 *
 * Det er ikke inspireret af skemaet — det ER skemaet, skrevet af i hånden.
 * Rettede man grænseværdien i tavlens admin, skete der ingenting her, og
 * ingen fik det at vide. To kopier af den samme sandhed driver fra hinanden,
 * og FVST-dokumentation er ikke et sted at have to sandheder.
 *
 * Tavlen er eneste kilde. Bon henter skemaet gennem en maskindør:
 *   GET {origin}/api/registration-types/schema?key=varemodtagelse
 *   X-Webhook-Secret: <GOODS_RECEIPT_WEBHOOK_SECRET>
 *
 * ── Tre kilder, i rækkefølge ──
 *   1. whiteboard — friskt svar fra tavlen
 *   2. cache      — seneste svar, gemt i settings
 *   3. builtin    — kopien nedenfor
 *
 * Fødevarekontrollen er lovpligtig og må ALDRIG blokeres af at tavlen er
 * nede, at koblingen er slukket eller at hemmeligheden mangler. Samme
 * princip som varemodtagelsen allerede følger for Grocy: lageret kan fejle,
 * dokumentationen skal igennem. Derfor kaster ingen funktion her — de
 * returnerer et skema og fortæller hvor det kom fra.
 *
 * ── Om BUILTIN ──
 * Den er kanonisk form fra whiteboards migration 020 + 026. Den er en
 * FALLBACK, ikke sandheden: står `source: 'builtin'` i svaret, er det fordi
 * vi ikke kunne nå tavlen, og det skal være synligt frem for at se ud som
 * om alt er ajour.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

const SCHEMA_KEY = 'varemodtagelse';

/** Hvor længe et hentet skema regnes som friskt (ms). */
const MEMORY_TTL_MS = 5 * 60 * 1000;

/**
 * Hvor længe vi venter på tavlen.
 *
 * Kort med vilje: står nogen med varerne og skal dokumentere en leverance,
 * er en formular der kommer med det samme og et skema fra i går bedre end
 * en spinner. Den lange vej tages kun når vi INTET har at falde tilbage på.
 */
const FETCH_TIMEOUT_MS = 4000;
const COLD_FETCH_TIMEOUT_MS = 8000;

// Kanonisk form fra whiteboard db/migrations/020 + 026.
const BUILTIN = [
    {
        id: 'temperature',
        type: 'number',
        label: '🧊 Kølevarer',
        required: true,
        optional_toggle: true,
        hint: 'max. 5°C',
        warn_above: 4,
        action_above: 5,
        default_value: 4.5,
        unit: '°C',
    },
    {
        id: 'temp_product',
        type: 'text',
        label: 'Målt på (kølevare)',
        required: false,
        hint: 'Hvilken vare blev målt?',
    },
    {
        id: 'temperature_freezer',
        type: 'number',
        label: '❄️ Frysvarer',
        required: true,
        optional_toggle: true,
        toggle_default_off: true,
        hint: 'max. -18°C',
        warn_above: -19,
        action_above: -18,
        default_value: -20,
        unit: '°C',
    },
    {
        id: 'temp_product_freezer',
        type: 'text',
        label: 'Målt på (frostvare)',
        required: false,
        hint: 'Hvilken vare blev målt?',
    },
    { id: 'date_ok',      type: 'checkbox', label: 'Dato/holdbarhed kontrolleret', required: true },
    { id: 'label_ok',     type: 'checkbox', label: 'Mærkning kontrolleret',        required: true },
    { id: 'packaging_ok', type: 'checkbox', label: 'Emballage kontrolleret',       required: true },
    {
        id: 'photo',
        type: 'photo',
        label: 'Foto af følgeseddel',
        required: false,
        hint: 'Anbefalet — gemmes på serveren',
    },
    {
        id: 'deviation',
        type: 'select',
        label: 'Afvigelse — handling',
        required: false,
        hint: 'Udfyldes kun ved afvigelse',
        options: [
            { value: 'none',             label: 'Ingen afvigelse' },
            { value: 'returned',         label: 'Varen er returneret' },
            { value: 'accepted_no_risk', label: 'Vurderet — ingen risiko, anvendes straks' },
            { value: 'discarded',        label: 'Varen er kasseret' },
            { value: 'supplier_contacted', label: 'Leverandøren er kontaktet' },
            { value: 'other',            label: 'Andet' },
        ],
    },
    {
        id: 'deviation_note',
        type: 'textarea',
        label: 'Bemærkning ved afvigelse',
        required: false,
        hint: 'Beskriv afvigelsen og hvad der blev gjort',
    },
];

/**
 * Afvigelses-værdier: tavlens navne ↔ Bon v2's.
 *
 * De to er IKKE ens: tavlen skriver 'accepted_no_risk', Bon v2 'no_risk'.
 * Bons værdi er låst af en CHECK-constraint (migration 036) og kan ikke
 * bare rettes, så oversættelsen skal blive. Men den skal kun stå ét sted —
 * webhooken havde sin egen kopi, og frontenden var ved at få en tredje.
 */
const DEVIATION_TO_WHITEBOARD = Object.freeze({
    returned:           'returned',
    no_risk:            'accepted_no_risk',
    discarded:          'discarded',
    supplier_contacted: 'supplier_contacted',
    other:              'other',
});

const DEVIATION_FROM_WHITEBOARD = Object.freeze(
    Object.fromEntries(Object.entries(DEVIATION_TO_WHITEBOARD).map(([bon, wb]) => [wb, bon]))
);

/**
 * Oversæt et skema til Bon v2's begreber.
 *
 * Kun afvigelses-værdierne oversættes; alt andet går uændret igennem.
 * 'none' fjernes: Bon v2 har et separat has_deviation-flag og viser kun
 * listen når der ER en afvigelse, så "Ingen afvigelse" ville være et valg
 * der modsiger den sektion man står i.
 *
 * En værdi tavlen har fundet på, som Bon v2 ikke kan gemme (CHECK-constraint),
 * udelades — hellere et valg der mangler end et gem der fejler.
 */
function toBonValues(fields) {
    return (fields || []).map(f => {
        if (f?.id !== 'deviation' || !Array.isArray(f.options)) return f;
        return {
            ...f,
            options: f.options
                .filter(o => o?.value !== 'none')
                .map(o => ({ ...o, value: DEVIATION_FROM_WHITEBOARD[o.value] }))
                .filter(o => o.value),
        };
    });
}

/**
 * Skemafelter Bon v2 har en egen kolonne til.
 *
 * Alt andet i skemaet er "ukendt" og havner i goods_receipts.extra_fields_json.
 * Listen er eksporteret OG sendes med i /schema-svaret, så frontenden ikke
 * skal have sin egen kopi — det var præcis dén slags kopi der gjorde hele
 * denne fil nødvendig.
 */
const MAPPED_FIELD_IDS = Object.freeze([
    'temperature',
    'temp_product',
    'temperature_freezer',
    'temp_product_freezer',
    'date_ok',
    'label_ok',
    'packaging_ok',
    'photo',
    'deviation',
    'deviation_note',
]);

/** Maks. længde på en enkelt fri-tekst-værdi vi tager imod. */
const MAX_EXTRA_VALUE_LEN = 500;

/**
 * Rens klientens extra_fields mod skemaet.
 *
 * To grunde til at filtrere frem for at gemme råt: et felt der er FJERNET i
 * admin skal holde op med at blive gemt (ellers vokser kolonnen med data
 * ingen længere kan se), og kolonnen må ikke kunne fyldes med vilkårligt
 * indhold af en klient.
 *
 * @param {*} input   klientens objekt
 * @param {Array} fields  skemaets felter
 * @returns {string|null} JSON til kolonnen, eller null når der intet er
 */
function sanitizeExtraFields(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

    const allowed = new Set(
        (fields || [])
            .map(f => f?.id)
            .filter(id => id && !MAPPED_FIELD_IDS.includes(id))
    );

    const out = {};
    for (const [key, raw] of Object.entries(input)) {
        if (!allowed.has(key)) continue;
        if (raw === null || raw === undefined || raw === '') continue;

        let value = raw;
        if (typeof value === 'string') {
            value = value.trim().slice(0, MAX_EXTRA_VALUE_LEN);
            if (!value) continue;
        } else if (typeof value === 'number') {
            if (!Number.isFinite(value)) continue;
        } else if (typeof value !== 'boolean') {
            continue;   // objekter og arrays hører ikke til i et fladt felt-svar
        }
        out[key] = value;
    }

    return Object.keys(out).length ? JSON.stringify(out) : null;
}

// ── In-memory cache ──
let _mem = null;          // { fields, fetched_at, name }
let _memAt = 0;
let _inflight = null;     // så ti samtidige sideindlæsninger giver ét kald

/* ── Konfiguration ─────────────────────────────────────────── */

/**
 * Tavlens origin, udledt af webhook-URL'en.
 *
 * Bevidst afledt frem for sin egen setting: to felter der peger hver sit
 * sted er en fejl der kun viser sig som "hvorfor virker det ene og ikke det
 * andet". Er webhooken slukket, er koblingen slukket — også for skemaet.
 */
function getOrigin() {
    try {
        const row = getDb().prepare(
            `SELECT value FROM settings WHERE key = 'whiteboard_webhook_url'`
        ).get();
        const url = (row?.value || '').trim();
        if (!url) return null;
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function getSecret() {
    return (process.env.GOODS_RECEIPT_WEBHOOK_SECRET || '').trim() || null;
}

/**
 * Kan vi overhovedet spørge tavlen?
 * @returns {{ok: boolean, reason?: string, origin?: string}}
 */
function connectionStatus() {
    const origin = getOrigin();
    if (!origin) return { ok: false, reason: 'not_configured' };
    if (!getSecret()) return { ok: false, reason: 'no_secret', origin };
    return { ok: true, origin };
}

/* ── Cache i settings ──────────────────────────────────────── */

function readCache() {
    try {
        const db = getDb();
        const raw = db.prepare(
            `SELECT value FROM settings WHERE key = 'whiteboard_schema_cache'`
        ).get()?.value;
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.fields) || parsed.fields.length === 0) return null;
        const at = db.prepare(
            `SELECT value FROM settings WHERE key = 'whiteboard_schema_cache_at'`
        ).get()?.value || null;
        return { fields: parsed.fields, name: parsed.name || null, fetched_at: at };
    } catch {
        return null;
    }
}

function writeCache(payload) {
    try {
        const db = getDb();
        const now = new Date().toISOString();
        db.prepare(`UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'whiteboard_schema_cache'`)
          .run(JSON.stringify({ fields: payload.fields, name: payload.name || null }));
        db.prepare(`UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'whiteboard_schema_cache_at'`)
          .run(now);
        return now;
    } catch (err) {
        console.warn('[receiptSchema] Kunne ikke gemme skema-cache:', err.message);
        return null;
    }
}

/* ── Hentning ──────────────────────────────────────────────── */

/**
 * Hent skemaet fra tavlen. Kaster ved fejl — kun interne kaldere ser det.
 */
async function fetchFromWhiteboard(timeoutMs = FETCH_TIMEOUT_MS) {
    const status = connectionStatus();
    if (!status.ok) {
        const err = new Error(
            status.reason === 'no_secret'
                ? 'GOODS_RECEIPT_WEBHOOK_SECRET mangler i .env'
                : 'Whiteboard-koblingen er slukket (whiteboard_webhook_url er tom)'
        );
        err.reason = status.reason;
        throw err;
    }

    const url = `${status.origin}/api/registration-types/schema?key=${encodeURIComponent(SCHEMA_KEY)}`;
    const res = await fetch(url, {
        headers: { 'X-Webhook-Secret': getSecret() },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
    });

    // Et redirect er login-gaten, ikke et svar. Følger vi den, får vi en
    // login-side med status 200 og ville tro den var et skema — præcis den
    // fælde der lod sytten varemodtagelser se ud som sendt (#21).
    if (res.status >= 300 && res.status < 400) {
        throw new Error(
            `Tavlen svarede ${res.status} (omdirigering) — stien ligger bag login-gaten. ` +
            `Mangler nginx' "location = /api/registration-types/schema"?`
        );
    }
    if (!res.ok) {
        throw new Error(`Tavlen svarede ${res.status}`);
    }

    const body = await res.json();
    if (!Array.isArray(body?.fields) || body.fields.length === 0) {
        throw new Error('Tavlen svarede uden felter');
    }
    return { fields: body.fields, name: body.name || null };
}

/**
 * Hent og gem. Deler ét kald mellem samtidige kaldere.
 * @returns {Promise<{fields, name, fetched_at}>}
 */
function refresh(timeoutMs = FETCH_TIMEOUT_MS) {
    if (_inflight) return _inflight;
    _inflight = fetchFromWhiteboard(timeoutMs)
        .then(payload => {
            const at = writeCache(payload) || new Date().toISOString();
            _mem = { ...payload, fetched_at: at };
            _memAt = Date.now();
            return _mem;
        })
        .finally(() => { _inflight = null; });
    return _inflight;
}

/* ── Offentligt API ────────────────────────────────────────── */

/**
 * Skemaet, uden at vente på nettet.
 *
 * Bruges når svaret skal komme med det samme. Opfrisker i baggrunden hvis
 * hukommelsen er kold eller gammel — det er stale-while-revalidate: brugeren
 * får noget brugbart nu, og næste gang er det friskt.
 *
 * @returns {{fields: Array, source: 'whiteboard'|'cache'|'builtin', fetched_at: string|null, error: string|null}}
 */
function getSchema() {
    const fresh = _mem && (Date.now() - _memAt) < MEMORY_TTL_MS;
    if (!fresh && connectionStatus().ok) {
        // Fejl her er ikke brugerens problem — den næste getSchemaFresh()
        // rapporterer den. Vi må bare ikke lade en afvist promise ryge ud.
        refresh().catch(err => {
            console.warn('[receiptSchema] Baggrundsopfriskning fejlede:', err.message);
        });
    }

    if (_mem) {
        return { fields: toBonValues(_mem.fields), source: fresh ? 'whiteboard' : 'cache', fetched_at: _mem.fetched_at, error: null, known_field_ids: MAPPED_FIELD_IDS };
    }

    const cached = readCache();
    if (cached) {
        return { fields: toBonValues(cached.fields), source: 'cache', fetched_at: cached.fetched_at, error: null, known_field_ids: MAPPED_FIELD_IDS };
    }

    const status = connectionStatus();
    return {
        fields: toBonValues(BUILTIN),
        source: 'builtin',
        fetched_at: null,
        known_field_ids: MAPPED_FIELD_IDS,
        error: status.ok ? 'Skemaet er endnu ikke hentet fra tavlen' :
            status.reason === 'no_secret'
                ? 'GOODS_RECEIPT_WEBHOOK_SECRET mangler — kan ikke hente skema fra tavlen'
                : 'Whiteboard-koblingen er slukket — bruger indbygget skema',
    };
}

/**
 * Skemaet, med et forsøg på at hente det først.
 *
 * Venter kun på nettet når vi ikke har noget i forvejen — ellers er svaret
 * lige så hurtigt som getSchema().
 */
async function getSchemaFresh() {
    const haveSomething = !!_mem || !!readCache();
    if (!connectionStatus().ok) return getSchema();

    const fresh = _mem && (Date.now() - _memAt) < MEMORY_TTL_MS;
    if (fresh) return getSchema();

    try {
        const payload = await refresh(haveSomething ? FETCH_TIMEOUT_MS : COLD_FETCH_TIMEOUT_MS);
        return { fields: toBonValues(payload.fields), source: 'whiteboard', fetched_at: payload.fetched_at, error: null, known_field_ids: MAPPED_FIELD_IDS };
    } catch (err) {
        const fallback = getSchema();
        return { ...fallback, error: `Kunne ikke hente skema fra tavlen: ${err.message}` };
    }
}

/** Ryd hukommelsen — bruges af tests og af Settings når URL'en ændres. */
function invalidate() {
    _mem = null;
    _memAt = 0;
}

module.exports = {
    SCHEMA_KEY,
    BUILTIN,
    DEVIATION_TO_WHITEBOARD,
    DEVIATION_FROM_WHITEBOARD,
    toBonValues,
    MAPPED_FIELD_IDS,
    sanitizeExtraFields,
    getSchema,
    getSchemaFresh,
    refresh,
    invalidate,
    connectionStatus,
    _fetchFromWhiteboard: fetchFromWhiteboard,
};
