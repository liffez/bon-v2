/**
 * services/smartplanAdapter.js
 * ════════════════════════════════════════════════════════════
 * Adapter til Smartplan.dk vagtplan-API (OAuth2).
 *
 * Eksporterer funktioner der kaldes fra routes/smartplan.js.
 * Henter credentials fra .env (SMARTPLAN_CLIENT_ID, SMARTPLAN_CLIENT_SECRET).
 * In-memory cache med 5 min TTL for shifts, 9 min for token, 1 time for account.
 *
 * Readonly — læser kun vagter og medarbejdere.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

/* ══════════════════════════════════════════════════════════════
   CACHE
   ══════════════════════════════════════════════════════════════ */

const _cache = new Map(); // key → { data, expires }

function getCached(key) {
    const entry = _cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.data;
    return null;
}

function setCached(key, data, ttlMs = 5 * 60 * 1000) {
    _cache.set(key, { data, expires: Date.now() + ttlMs });
}

/** Ryd hele cachen */
function clearCache() {
    _cache.clear();
}

/* ══════════════════════════════════════════════════════════════
   OAUTH2 TOKEN
   ══════════════════════════════════════════════════════════════ */

// Hvor mange HTTP-kald bruger vi egentlig? Smartplan paginerer, så ÉT logisk
// opslag ("hent et år") kan være mange kald — og rammer man grænsen, ser
// vagtplanen tom ud. Uden et tal er "vi henter vel ikke så tit" en fornemmelse
// og ikke en oplysning. Token- og konto-kald tælles med, ellers ville tallet
// være pænere end virkeligheden. In-memory; nulstilles ved genstart.
const _stats = { requests: 0, pages: 0, throttled: 0, lastThrottleAt: null, startedAt: Date.now(),
                 today: null, requestsToday: 0, rateAtThrottle: 0 };

/* ══════════════════════════════════════════════════════════════
   RATE LIMIT — Smartplan tillader 60 kald/minut og 2000/dag
   ══════════════════════════════════════════════════════════════
   Minut-grænsen er den bindende. Smartplan paginerer, så ét logisk opslag
   ("hent et år") kan være 20-80 kald afsendt i træk — altså et burst der alene
   kan ramme loftet.

   Og vigtigere: en afvisning forlænger sig selv. Målt 23. august gik
   `availableIn` fra 161 til 243 sekunder, fordi vi blev ved med at spørge.
   En throttling kan derfor holde sig selv i live så længe nogen klikker rundt,
   og så ser vagtplanen tom ud i meget længere tid end nødvendigt.

   Derfor to ting, som gør 429 strukturelt usandsynlig i stedet for blot ærlig:
     1. Vi holder selv en glidende grænse under Smartplans, og venter når vi
        nærmer os — i stedet for at blive afvist.
     2. Bliver vi alligevel afvist, holder vi HELT op med at spørge indtil det
        tidspunkt Smartplan selv oplyser. Ellers forlænger vi vores egen straf.
*/
const RATE_PER_MIN  = 50;      // margin ned til Smartplans 60
const RATE_PER_DAY  = 1900;    // margin ned til 2000
const MAX_WAIT_MS   = 15000;   // et request må vente så længe — ikke længere

const _recent = [];            // tidsstempler for kald i det seneste minut
let _blockedUntil = 0;         // sat af 429 (epoch ms)
let _strikes = 0;              // 429'er i træk uden et vellykket kald imellem

// Eksponentiel backoff. Når karantænen udløber, sender vi ét prøve-kald for at
// se om vi må igen — det er den eneste måde at opdage at blokeringen er hævet.
// Men får DET også 429, må vi vente længere næste gang: ellers holder en
// stribe prøve-kald blokeringen åben i det uendelige. Ét minut, så to, fire …
// op til et kvarter.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS  = 15 * 60_000;
// Smartplans eget `availableIn` er åbenlyst ikke nok: prøver vi præcis når det
// udløber, bliver vi afvist igen med det samme. Læg et minut oveni, så
// prøve-kaldet har en chance for at lykkes i stedet for at forlænge straffen.
const QUARANTINE_GRACE_MS = 60_000;
function _backoffMs() {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, _strikes - 1)), BACKOFF_MAX_MS);
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── Dags-forbruget skal overleve en genstart ────────────────
   Tælleren lå kun i hukommelsen, og serveren genstartes ved hver udrulning.
   Vores egen dagsgrænse (1900) har derfor aldrig kunnet fyre: den stod
   reelt altid på nul. Dagskvoten på 2000 kunne brændes uden at noget sagde
   fra — hvilket er præcis hvad der skete 23. august 2026.

   Ét lille skriv pr. kald i `settings`. Kaldene er få (titals pr. handling),
   og at kende sit eget forbrug er hele forudsætningen for at holde igen. */
const USAGE_KEY = 'smartplan_daily_usage';
let _usageLoaded = false;

function _loadUsage() {
    if (_usageLoaded) return;
    _usageLoaded = true;
    try {
        const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(USAGE_KEY);
        if (row && row.value) {
            const v = JSON.parse(row.value);
            if (v && v.date === _dayKey() && Number.isFinite(v.count)) {
                _stats.today = v.date;
                _stats.requestsToday = v.count;
            }
        }
    } catch { /* ingen DB endnu → start på nul, ikke et crash */ }
}

function _saveUsage() {
    try {
        getDb().prepare(`
            INSERT INTO settings (key, value, description)
            VALUES (?, ?, 'Smartplan-kald brugt i dag (overlever genstart)')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).run(USAGE_KEY, JSON.stringify({ date: _stats.today, count: _stats.requestsToday }));
    } catch { /* et fejlet tælle-skriv må aldrig vælte et opslag */ }
}

/** HH:MM i dansk tid — til beskeder mennesker skal kunne handle på. */
function _clock(ms) {
    return new Intl.DateTimeFormat('da-DK', {
        timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms));
}

/** Dansk kalenderdato — dags-kvoten følger døgnet, ikke UTC. */
function _dayKey() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
}

/**
 * Reservér plads til ét HTTP-kald. Venter hvis vi er tæt på minut-grænsen,
 * kaster hvis ventetiden er urimelig eller vi er i karantæne efter en 429.
 */
async function _reserveSlot() {
    const now = Date.now();

    if (now < _blockedUntil) {
        // Klokkeslæt, ikke "om 46 sekunder". Beskeden bliver stående på skærmen
        // og i loggen, og et relativt tal er forkert to minutter senere — så
        // ville det se ud som om vi hænger fast for evigt.
        throw new Error(`Smartplan afviste os for lidt siden (429) — vi venter med at spørge igen `
            + `til kl. ${_clock(_blockedUntil)}, så blokeringen ikke forlænges. Timerne er der stadig.`);
    }

    _loadUsage();
    const day = _dayKey();
    if (_stats.today !== day) { _stats.today = day; _stats.requestsToday = 0; }
    if (_stats.requestsToday >= RATE_PER_DAY) {
        throw new Error(`Smartplans dagsgrænse er ved at være brugt (${_stats.requestsToday} kald i dag, `
            + 'grænsen er 2000). Vi holder igen resten af døgnet.');
    }

    while (_recent.length && now - _recent[0] > 60_000) _recent.shift();
    if (_recent.length >= RATE_PER_MIN) {
        const waitMs = 60_000 - (now - _recent[0]) + 50;
        if (waitMs > MAX_WAIT_MS) {
            throw new Error(`For mange opslag på kort tid — Smartplan tillader 60 kald i minuttet. `
                + `Prøv igen fra kl. ${_clock(now + waitMs)}.`);
        }
        await _sleep(waitMs);
        return _reserveSlot();
    }

    _recent.push(Date.now());
    _stats.requests++;
    _stats.requestsToday++;
    _saveUsage();
}

function getStats() {
    return {
        ...(_stats),
        uptime_min: Math.round((Date.now() - _stats.startedAt) / 60000),
        per_minute_limit: RATE_PER_MIN,
        per_day_limit: RATE_PER_DAY,
        in_last_minute: _recent.filter(t => Date.now() - t <= 60_000).length,
        strikes: _strikes,
        blocked_for_sec: _blockedUntil > Date.now() ? Math.ceil((_blockedUntil - Date.now()) / 1000) : 0,
        // Absolut tidspunkt, så en visning kan tælle ned selv i stedet for at
        // vise et tal der var rigtigt da svaret blev hentet.
        blocked_until: _blockedUntil > Date.now() ? new Date(_blockedUntil).toISOString() : null,   // utc-ok: maskin-tidsstempel
        blocked_until_clock: _blockedUntil > Date.now() ? _clock(_blockedUntil) : null,
        // 'minute' | 'daily' | null — vores bedste bud på HVILKEN grænse der ramte.
        likely_limit: _stats.throttled === 0 ? null
            : (_stats.rateAtThrottle >= RATE_PER_MIN - 5 ? 'minute' : 'daily'),
        rate_at_throttle: _stats.rateAtThrottle,
    };
}

/** Kun til test — lader som om karantænens ventetid er gået, uden at nulstille
 *  backoff-trappen (det er netop trappen scenariet handler om). */
function _expireQuarantine() { _blockedUntil = 0; }

/** Kun til test — nulstiller grænse-tilstanden mellem scenarier. */
function _resetRateLimit() {
    _recent.length = 0;
    _blockedUntil = 0;
    _strikes = 0;
    _stats.requests = 0; _stats.pages = 0; _stats.throttled = 0;
    _stats.lastThrottleAt = null; _stats.today = null; _stats.requestsToday = 0;
    _stats.rateAtThrottle = 0; _usageLoaded = true;   // test styrer selv tælleren
}

const TOKEN_URL = process.env.SMARTPLAN_TOKEN_URL || 'https://api.smartplanapp.io/o/token/';
const API_BASE  = process.env.SMARTPLAN_API_BASE  || 'https://api.smartplanapp.io/v2';

/**
 * Hent OAuth2 access token via client_credentials grant.
 */
async function getAccessToken() {
    const cached = getCached('_token');
    if (cached) return cached;

    const clientId     = process.env.SMARTPLAN_CLIENT_ID;
    const clientSecret = process.env.SMARTPLAN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Smartplan ikke konfigureret. Sæt SMARTPLAN_CLIENT_ID og SMARTPLAN_CLIENT_SECRET i .env.');
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });

    await _reserveSlot();   // token-kald tæller også med i Smartplans kvote
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Smartplan token fejl ${res.status}: ${text.slice(0, 300)}`);
    }

    let json;
    try { json = JSON.parse(text); } catch {
        throw new Error(`Smartplan token: uventet ikke-JSON svar: ${text.slice(0, 300)}`);
    }

    const token = json?.access_token;
    if (!token) throw new Error('Smartplan: access_token mangler i svar');

    // Token gyldighed ~10 min, cache i 9 min
    setCached('_token', token, 9 * 60 * 1000);
    return token;
}

/* ══════════════════════════════════════════════════════════════
   ACCOUNT UUID
   ══════════════════════════════════════════════════════════════ */

async function getAccountUUID() {
    const cached = getCached('_accountUUID');
    if (cached) return cached;

    const token = await getAccessToken();
    await _reserveSlot();
    const res = await fetch(`${API_BASE}/accounts/`, {
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
        },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Smartplan accounts fejl ${res.status}: ${text.slice(0, 300)}`);

    let json;
    try { json = JSON.parse(text); } catch {
        throw new Error(`Smartplan accounts: uventet svar: ${text.slice(0, 300)}`);
    }

    const uuid = json?.results?.[0]?.uuid;
    if (!uuid) throw new Error('Smartplan: ingen account UUID fundet');

    // Cache 1 time
    setCached('_accountUUID', uuid, 60 * 60 * 1000);
    return uuid;
}

/* ══════════════════════════════════════════════════════════════
   HTTP
   ══════════════════════════════════════════════════════════════ */

/**
 * Authenticated fetch mod Smartplan API med pagination.
 * Returnerer alle results samlet.
 */
// Hvor mange HTTP-kald bruger vi egentlig? Smartplan paginerer, så ÉT logisk
// opslag ("hent et år") kan være mange kald — og rammer man grænsen, ser
// vagtplanen tom ud. Uden et tal er "vi henter vel ikke så tit" en fornemmelse
// og ikke en oplysning. Tælleren er in-memory og nulstilles ved genstart; det
// er nok til at se et mønster over en arbejdsdag.
async function smartplanFetch(path) {
    const token = await getAccessToken();
    const accountUUID = await getAccountUUID();

    let url = `${API_BASE}/accounts/${accountUUID}${path}`;
    const all = [];

    let firstPage = true;
    while (url) {
        await _reserveSlot();
        if (!firstPage) _stats.pages++;   // ekstra sider ud over det første kald
        firstPage = false;
        const res = await fetch(url, {
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
            },
        });

        const text = await res.text();
        if (!res.ok) {
            // 429 er den ENESTE fejl der går over af sig selv, og den er den
            // hyppigste: et år med vagter er mange sider, og hver side er et
            // kald. Den skal derfor kunne læses uden at slå statuskoder op —
            // ellers ser en midlertidig throttling ud som om vagtplanen er væk.
            if (res.status === 429) {
                _stats.throttled++;
                _stats.lastThrottleAt = new Date().toISOString();   // utc-ok: teknisk tidsstempel
                // Hvor travlt havde vi det, da vi blev afvist? Det er dét der
                // skiller de to grænser ad: bliver vi afvist efter en håndfuld
                // kald, er det ikke minut-grænsen på 60 — så er dagskvoten brugt.
                // Uden tallet ligner de to hinanden, og man leder det forkerte sted.
                _stats.rateAtThrottle = _recent.filter(t => Date.now() - t <= 60_000).length;
                let wait = null;
                try { wait = Math.ceil(Number(JSON.parse(text).availableIn)); } catch { /* ikke JSON */ }
                // Karantæne: bliv væk til det tidspunkt Smartplan selv oplyser.
                // Uden det forlænger vores egne forsøg blokeringen (målt: 161 → 243 s).
                //
                // Smartplans eget tal er autoritativt, men aldrig kortere end vores
                // backoff: oplyser den 60 sekunder tre gange i træk, er 60 sekunder
                // åbenlyst ikke nok, og så skal vi holde os længere væk.
                // Tæl karantæne-PERIODER, ikke kald. Ét opslag sender to kald
                // parallelt (shifts + worklogs), så begge rammer 429 samtidig —
                // uden denne skelnen ville én mislykket visning tælle som to
                // strikes, og to visninger ville give otte minutters karantæne.
                const alreadyBlocked = Date.now() < _blockedUntil;
                if (!alreadyBlocked) _strikes++;
                const fromApi = (Number.isFinite(wait) && wait > 0) ? wait * 1000 : 0;
                _blockedUntil = Math.max(_blockedUntil,
                    Date.now() + Math.max(fromApi, _backoffMs()) + QUARANTINE_GRACE_MS);
                throw new Error('Smartplan begrænser antallet af kald (429)'
                    + (Number.isFinite(wait) && wait > 0 ? ` — prøv igen om ca. ${wait} sekunder.` : '.')
                    + ' Timerne er der stadig; vi må bare ikke spørge lige nu.');
            }
            throw new Error(`Smartplan API fejl ${res.status}: ${text.slice(0, 200)}`);
        }

        const json = JSON.parse(text);
        if (Array.isArray(json.results)) {
            all.push(...json.results);
        }
        // Smartplan paginerer med next-URL
        url = json.next || null;
    }

    // Straffen nulstilles først når HELE opslaget er i hus. Lå nulstillingen
    // pr. side, ville en delvis vellykket paginering — side 1 ok, side 2 afvist —
    // nulstille trappen hver gang, og backoff'en ville stå på 60 sekunder for
    // evigt. Det var præcis hvad der skete i drift 23. august: afvisningerne
    // steg, mens ventetiden blev ved med at være et minut.
    _strikes = 0;
    return all;
}

/* ══════════════════════════════════════════════════════════════
   LOKATIONS-KLASSIFIKATION (HQ vs. Festival & Events)
   ══════════════════════════════════════════════════════════════ */

/**
 * Navnet på HQ-lokationen i Smartplan (setting `smartplan_hq_location`,
 * default 'Ristet Rug'). Cachet 1 time — læses via samme _cache som resten.
 */
function _hqLocationName() {
    const cached = getCached('_hqLoc');
    if (cached != null) return cached;
    let name = 'Ristet Rug';
    try {
        const row = getDb().prepare("SELECT value FROM settings WHERE key = 'smartplan_hq_location'").get();
        if (row && row.value && String(row.value).trim()) name = String(row.value).trim();
    } catch { /* ingen DB / setting → default */ }
    setCached('_hqLoc', name, 60 * 60 * 1000);
    return name;
}

/**
 * Klassificér en lokations-titel som 'hq' | 'events'.
 * Tom/ukendt lokation → 'hq' (vises i den primære driftsvisning, skjules ikke).
 */
function _classifyLocation(locTitle, hqName) {
    const t = (locTitle || '').trim().toLowerCase();
    if (!t) return 'hq';
    return t === (hqName || '').trim().toLowerCase() ? 'hq' : 'events';
}

/* ══════════════════════════════════════════════════════════════
   NORMALISERING
   ══════════════════════════════════════════════════════════════ */

/**
 * Er vagten LEDIG — udlagt, men endnu ikke taget af nogen?
 *
 * Ét sted, fordi tre normaliseringer og fire forbrugere skal være enige.
 * Ugeoversigten udledte den selv på navnet, driften og eventets løn slet ikke,
 * og så talte de samme vagt forskelligt: 7 timer der hverken var mandetimer
 * eller løn, men trak kapacitetsraten ned og bad om en timeløn for en person
 * der ikke findes.
 *
 * `owner.uuid` er signalet, ikke navnet: en vagt KAN have en ejer uden at
 * for- og efternavn er udfyldt, og så er den taget — bare af en vi ikke kan
 * navngive.
 */
function _isOpenShift(owner) {
    return !(owner && owner.uuid);
}

/**
 * Normalisér et Smartplan shift-objekt til vores faste format.
 * Smartplan v2 returnerer: owner.first_name/last_name, jobtype.title, location.title
 */
function _normalizeShift(shift, hqName) {
    const startDt = shift.start_dt || '';
    const endDt   = shift.end_dt   || '';
    const owner   = shift.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;
    const location = shift.location?.title || '';

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        is_open:       _isOpenShift(owner),
        date:          shift.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      shift.jobtype?.title || '',
        location,
        location_class: _classifyLocation(location, hqName),
    };
}

/**
 * Normalisér et Smartplan worklog-objekt (arkiverede vagter).
 * Bruger planned_start_dt/planned_end_dt i stedet for start_dt/end_dt.
 */
function _normalizeWorklog(wl, hqName) {
    const startDt = wl.planned_start_dt || '';
    const endDt   = wl.planned_end_dt   || '';
    const owner   = wl.owner || {};

    const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null;
    const location = wl.location?.title || '';

    return {
        employee_id:   owner.uuid || null,
        employee_name: name,
        first_name:    owner.first_name || null,
        is_open:       _isOpenShift(owner),
        date:          wl.display_date || (startDt ? startDt.slice(0, 10) : null),
        start_time:    _extractTime(startDt),
        end_time:      _extractTime(endDt),
        job_type:      wl.jobtype?.title || '',
        location,
        location_class: _classifyLocation(location, hqName),
    };
}

/** Ekstrahér HH:MM fra ISO datetime eller "HH:MM" */
function _extractTime(val) {
    if (!val) return '';
    if (val.includes('T')) {
        const match = val.match(/T(\d{2}:\d{2})/);
        return match ? match[1] : val;
    }
    return val;
}

/* ══════════════════════════════════════════════════════════════
   EKSPORTEREDE FUNKTIONER
   ══════════════════════════════════════════════════════════════ */

/**
 * Hent vagter for et datointerval.
 * Kombinerer fremtidige shifts + arkiverede worklogs for at dække alle datoer.
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @returns {Promise<Array>} Normaliserede vagt-objekter
 */
async function getShifts(fromDate, toDate) {
    const cacheKey = `shifts_${fromDate}_${toDate}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Hent begge parallelt: shifts (fremtidige) + worklogs (arkiverede/fortidige)
    // Ingen .catch(() => []) her — og det er med vilje. "Vi kunne ikke spørge"
// og "der er ingen vagter" er to forskellige svar, og det ene af dem er et
// beløb på nul kroner der bliver frosset ind i regnskabet. Fejlen kastes, så
// kaldernes egne værn (drift fryser ikke, eventet fryser ikke, viewet skriver
// "vagtplan ikke tilgængelig") rent faktisk kan fyre.
    const [shifts, worklogs] = await Promise.all([
        smartplanFetch(`/shifts/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}`),
        smartplanFetch(`/worklogs/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}&ordering=planned_start_dt`),
    ]);

    const hqName = _hqLocationName();
    const normalizedShifts = shifts.map(s => _normalizeShift(s, hqName));
    const normalizedWorklogs = worklogs.map(w => _normalizeWorklog(w, hqName));

    // Kombiner — worklogs dækker fortid, shifts dækker fremtid.
    // Dedupliker via employee_id+date (shifts har forrang)
    const seen = new Set();
    const all = [];
    for (const s of normalizedShifts) {
        if (!s.date) continue;
        const key = (s.employee_id || '') + '_' + s.date + '_' + s.start_time;
        seen.add(key);
        all.push(s);
    }
    for (const w of normalizedWorklogs) {
        if (!w.date) continue;
        const key = (w.employee_id || '') + '_' + w.date + '_' + w.start_time;
        if (!seen.has(key)) all.push(w);
    }

    setCached(cacheKey, all);
    return all;
}

/**
 * Hent medarbejderliste (udtrukket fra shifts de seneste 30 dage).
 * Smartplan har intet dedikeret /employees/ endpoint — vi udtrækker
 * unikke medarbejdere fra shifts/worklogs i stedet.
 * @returns {Promise<Array>} [{ uuid, first_name, last_name, name }, ...]
 */
async function getEmployees() {
    const cacheKey = 'employees';
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 14);
    const to = new Date(now);
    to.setDate(to.getDate() + 14);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const shifts = await getShifts(fromStr, toStr);

    const seen = new Map();
    for (const s of shifts) {
        const id = s.employee_id;
        if (id && !seen.has(id)) {
            seen.set(id, {
                uuid: id,
                first_name: s.first_name || s.name || null,
                name: s.name || s.first_name || null,
            });
        }
    }

    const employees = Array.from(seen.values()).sort((a, b) =>
        (a.first_name || '').localeCompare(b.first_name || ''));

    setCached(cacheKey, employees);
    return employees;
}

/* ══════════════════════════════════════════════════════════════
   LABOR-RÆKKER (til driftsregnskab / laborAdapter)
   ══════════════════════════════════════════════════════════════ */

/** Sekunder → timer (eller null). */
function _secToHours(sec) {
    return (sec != null && !Number.isNaN(Number(sec))) ? Number(sec) / 3600 : null;
}

/** Timer mellem to ISO-datetimes (fallback når *_shift_duration mangler). */
function _hoursBetween(startDt, endDt) {
    if (!startDt || !endDt) return null;
    const a = Date.parse(startDt);
    const b = Date.parse(endDt);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return (b - a) / 3600000;
}

/**
 * Berig et Smartplan-record (worklog eller shift) til en labor-række.
 * Bevarer BEGGE tidssæt (planned + attendance) + owner.uuid + jobtype.uuid,
 * så laborAdapter kan vælge mode og join'e mod wage_rates / role_map.
 * Timer = fuld vagtlængde (shift_duration), ikke fratrukket pause — jf. spec §5.
 */
function _normalizeLabor(rec, isShift, hqName) {
    const owner = rec.owner || {};
    const jt    = rec.jobtype || {};
    const startDt = rec.planned_start_dt || '';
    const location = rec.location?.title || '';

    const plannedHours    = _secToHours(rec.planned_shift_duration)
                          ?? _hoursBetween(rec.planned_start_dt, rec.planned_end_dt);
    const attendanceHours = _secToHours(rec.attendance_shift_duration)
                          ?? _hoursBetween(rec.attendance_start_dt, rec.attendance_end_dt);

    return {
        employee_id:       owner.uuid || null,
        employee_name:     [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null,
        is_open:           _isOpenShift(owner),
        jobtype_uuid:      jt.uuid || null,
        jobtype_title:     jt.title || '',
        date:              rec.display_date || (startDt ? startDt.slice(0, 10) : null),
        planned_start:     _extractTime(rec.planned_start_dt),
        planned_end:       _extractTime(rec.planned_end_dt),
        planned_hours:     plannedHours,
        attendance_start:  _extractTime(rec.attendance_start_dt),
        attendance_end:    _extractTime(rec.attendance_end_dt),
        attendance_hours:  attendanceHours,
        attendance_status: rec.attendance_status || null,
        location,
        location_class:    _classifyLocation(location, hqName),
        is_shift:          !!isShift,
    };
}

/**
 * Hent berigede labor-rækker for et datointerval.
 * Worklogs (fortid) bærer både planned_* og attendance_*; shifts (fremtid)
 * kun planned_*. Worklogs har forrang ved overlap (de er rigere — har faktisk
 * fremmøde), modsat getShifts() der prioriterer shifts.
 * @returns {Promise<Array>} labor-rækker (se _normalizeLabor)
 */
async function getLaborRows(fromDate, toDate, ttlMs) {
    const cacheKey = `labor_${fromDate}_${toDate}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [shifts, worklogs] = await Promise.all([
        smartplanFetch(`/shifts/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}`),
        smartplanFetch(`/worklogs/?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}&ordering=planned_start_dt`),
    ]);

    const hqName = _hqLocationName();
    const rows = [];
    const seen = new Set();
    const keyOf = (r) => (r.employee_id || '') + '_' + r.date + '_' + r.planned_start;

    // Worklogs først (forrang) — de bærer attendance.
    for (const w of worklogs.map(r => _normalizeLabor(r, false, hqName))) {
        if (!w.date) continue;
        seen.add(keyOf(w));
        rows.push(w);
    }
    // Shifts udfylder huller (fremtidige dage uden worklog).
    for (const s of shifts.map(r => _normalizeLabor(r, true, hqName))) {
        if (!s.date) continue;
        if (!seen.has(keyOf(s))) rows.push(s);
    }

    // Kaldere med et STORT vindue (diagnostik-siden trækker 425 dage) kan bede
    // om en længere levetid. Smartplan paginerer, så et år er mange kald, og
    // med 5 minutters cache brænder gentagne Settings-besøg kvoten — hvorefter
    // 429 gør at vagtplanen ser tom ud. Default er uændret.
    setCached(cacheKey, rows, ttlMs);
    return rows;
}

/**
 * Hent den fulde medarbejder-roster fra Smartplans /members/-endpoint.
 * Modsat getEmployees() (der udleder fra nylige shifts) giver dette ALLE
 * medlemmer + initialer + email — bruges til at matche løn-CSV-rækker
 * (navn/initialer) til owner.uuid, så wage_rates kan join'es på worklogs.
 * @returns {Promise<Array>} [{ uuid, first_name, last_name, name, initials, email, user_type }]
 */
async function getMembers() {
    const cached = getCached('members_full');
    if (cached) return cached;

    const rows = await smartplanFetch('/members/');
    const members = rows.map(m => ({
        uuid:       m.uuid || null,
        first_name: m.first_name || null,
        last_name:  m.last_name || null,
        name:       [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
        initials:   m.initials || null,
        email:      m.email || null,
        user_type:  m.user_type || null,
    }));

    setCached('members_full', members, 60 * 60 * 1000); // 1 time
    return members;
}

/**
 * Komplet løn-roster: nuværende medlemmer (/members/) FLETTET med medarbejdere
 * der optræder i historiske worklogs siden `sinceDate`. Stoppede medarbejdere
 * (ikke længere på /members/) har stadig brug for en sats til bagudrettede
 * driftsregnskaber. owner i worklogs bærer uuid+navn+initialer, så de kan matches.
 * @param {string} sinceDate  'YYYY-MM-DD' — hvor langt tilbage worklogs scannes
 * @returns {Promise<Array>} [{ uuid, name, first_name, last_name, initials, email, active, last_shift }]
 */
async function getLaborRoster(sinceDate) {
    // Dansk kalenderdato, ikke UTC. `today` er ikke kun en cache-nøgle — den er
    // også `end_date` på worklog-forespørgslen, så mellem midnat og kl. 02 dansk
    // sommertid ville UTC-datoen udelade dagens vagter fra rosteren. (Fanget af
    // pre-commit-hooken; linjen er fra #117 og ældre end dette arbejde.)
    const { todayISO } = require('../db/helpers');
    const today = todayISO();
    const cacheKey = `roster_${sinceDate}_${today}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [members, worklogs] = await Promise.all([
        smartplanFetch('/members/'),
        smartplanFetch(`/worklogs/?start_date=${encodeURIComponent(sinceDate)}&end_date=${encodeURIComponent(today)}`),
    ]);

    const map = new Map();
    for (const m of members) {
        if (!m.uuid) continue;
        map.set(m.uuid, {
            uuid: m.uuid,
            first_name: m.first_name || null,
            last_name:  m.last_name || null,
            name:       [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
            initials:   m.initials || null,
            email:      m.email || null,
            active:     true,
            last_shift: null,
        });
    }
    for (const w of worklogs) {
        const o = w.owner || {};
        if (!o.uuid) continue;
        const d = w.display_date || (w.planned_start_dt ? w.planned_start_dt.slice(0, 10) : null);
        let e = map.get(o.uuid);
        if (!e) {
            e = {
                uuid: o.uuid,
                first_name: o.first_name || null,
                last_name:  o.last_name || null,
                name:       [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
                initials:   o.initials || null,
                email:      null,
                active:     false,           // ikke på nuværende roster → stoppet
                last_shift: null,
            };
            map.set(o.uuid, e);
        }
        if (d && (!e.last_shift || d > e.last_shift)) e.last_shift = d;
    }

    const roster = [...map.values()].sort((a, b) =>
        (Number(b.active) - Number(a.active)) || (a.name || '').localeCompare(b.name || '', 'da'));

    setCached(cacheKey, roster, 60 * 60 * 1000); // 1 time
    return roster;
}

/* ══════════════════════════════════════════════════════════════ */

// Eksponeret til test: reglen er ét udtryk, men fire forbrugere afhænger af
// den, og en ændring her flytter både kapacitetsrater og lønsummer.
module.exports = {
    _isOpenShift,
    getShifts,
    getEmployees,
    getLaborRows,
    getStats,
    _resetRateLimit,
    _expireQuarantine,
    getMembers,
    getLaborRoster,
    clearCache,
};
