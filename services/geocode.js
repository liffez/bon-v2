// services/geocode.js
// ==========================================
// Geokodning af danske adresser via DAWA
// (Danmarks Adressers Web API — api.dataforsyningen.dk).
//
// Ingen API-nøgle. Samme tjeneste som v1's leveringsberegner og
// v2's embed-bestillingsformular allerede bruger.
//
// Routing (services/routing.js) kræver lat/lon på leveringsadresser.
// addresses-tabellen har lat/lon-kolonner (migration 001) men de er
// typisk NULL for v1-synkede adresser — denne service fylder dem.
//
// Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 3.
// ==========================================

const { getDb } = require('../db/database');

const DAWA_BASE = 'https://api.dataforsyningen.dk';
const TIMEOUT_MS = 6000;
// DAWA beder klienter identificere sig (Fair Use). Uden User-Agent struber/
// blokerer de IP'en efter en byge — det var årsagen til at en backfill kunne
// fejle på ~alle adresser efter de første par. Sæt en sigende UA.
const USER_AGENT = 'bon-v2/2.0 (+https://ristetrug.dk; kontakt@ristetrug.dk)';
const MAX_RETRIES = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class DawaError extends Error {
    constructor(message, { status = null, throttled = false } = {}) {
        super(message);
        this.name = 'DawaError';
        this.status = status;
        this.throttled = throttled;
    }
}

// ==========================================
// Fetch-wrapper med timeout, User-Agent og retry-med-backoff.
// Throttling (HTTP 429/503) og transiente netværksfejl prøves igen med
// eksponentiel backoff (respekterer Retry-After). Vedvarende fejl kastes
// som DawaError med .status/.throttled så kaldere kan skelne throttling
// fra "ingen match".
// ==========================================
async function dawaFetch(path) {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(`${DAWA_BASE}${path}`, {
                signal: controller.signal,
                headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
            });
            if (res.ok) return await res.json();

            // 429 (rate limit) + 503 (midlertidigt overbelastet) → vent og prøv igen
            if (res.status === 429 || res.status === 503) {
                const retryAfter = parseInt(res.headers.get('retry-after'), 10);
                const wait = Number.isFinite(retryAfter)
                    ? retryAfter * 1000
                    : Math.min(8000, 500 * 2 ** attempt);  // 500, 1000, 2000, 4000, 8000
                lastErr = new DawaError(`DAWA svarede ${res.status}`, { status: res.status, throttled: true });
                if (attempt < MAX_RETRIES) { await sleep(wait); continue; }
                throw lastErr;
            }
            // Andre HTTP-fejl: ikke transiente → kast med det samme
            throw new DawaError(`DAWA svarede ${res.status}`, { status: res.status });
        } catch (e) {
            if (e instanceof DawaError && !e.throttled) throw e;     // permanent HTTP-fejl
            // Netværksfejl/timeout/abort → transient, prøv igen
            lastErr = e instanceof DawaError ? e : new DawaError(e.message || 'netværksfejl', { throttled: true });
            if (attempt < MAX_RETRIES) { await sleep(Math.min(8000, 500 * 2 ** attempt)); continue; }
            throw lastErr;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new DawaError('ukendt fejl');
}

// ==========================================
// Trækker {lat,lon} ud af en DAWA mini-struktur-række.
// I struktur=mini er x = længdegrad, y = breddegrad (WGS84).
// ==========================================
function coordsFromRow(row) {
    if (!row) return null;
    const lon = Number(row.x);
    const lat = Number(row.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

// ==========================================
// Kald DAWA. Throttling (efter retries opbrugt) re-kastes så kaldere kan
// skelne "DAWA blokerer os" fra "ingen match" — alt andet (no-match,
// permanent HTTP-fejl) bliver til null så vi kan falde videre til næste
// strategi.
// ==========================================
async function tryFetch(path) {
    try {
        return await dawaFetch(path);
    } catch (e) {
        if (e instanceof DawaError && e.throttled) throw e;
        return null;
    }
}

// ==========================================
// geocodeViaDatavask({ street, nr, zip, city }) → { lat, lon } | null
//
// Sidste fallback for v1-synkede adresser med fejlskrevne/ikke-
// kanoniske vejnavne. DAWA's datavask-tjeneste retter input mod den
// officielle vejdatabase, fx:
//   "Prinsesse Charlottesgade 16" → "Prinsesse Charlottes Gade 16"
//   "HC Andersens Boulevard 2"    → "H.C. Andersens Boulevard 2"
//
// Kvalitets-gate: vi accepterer KUN match hvor husnr OG postnr er
// uændrede (forskelle.husnr===0 && forskelle.postnr===0). Vejnavnet
// må gerne rettes — det er hele pointen. Gaten afviser vilde gæt på
// junk-input (fx "Afhentes ved afhentning, 2650" → en tilfældig vej),
// hvor datavask må ændre husnr/postnr for at finde noget.
// ==========================================
async function geocodeViaDatavask({ street, nr, zip, city } = {}) {
    // V1-data propper ofte etage/dør-junk ind i vej- og husnr-felterne
    // efter et komma ("Farvergade , 2. sal" + "27 D", "Glasvej" + "3,1").
    // Danske vejnavne og husnumre indeholder aldrig komma, så vi afkorter
    // begge ved første komma — det fjerner junk uden at tabe ægte data.
    const clean = s => (s == null ? '' : String(s).split(',')[0].trim());
    const streetPart = [clean(street), clean(nr)].filter(Boolean).join(' ');
    const zipPart = [zip, city]
        .map(s => (s == null ? '' : String(s).trim()))
        .filter(Boolean).join(' ');
    const betegnelse = [streetPart, zipPart].filter(Boolean).join(', ').trim();
    if (!betegnelse) return null;

    const washed = await tryFetch(`/datavask/adresser?${new URLSearchParams({ betegnelse }).toString()}`);
    const first = washed && Array.isArray(washed.resultater) ? washed.resultater[0] : null;
    const adr = first && first.aktueladresse;
    const diff = first && first.vaskeresultat && first.vaskeresultat.forskelle;
    if (!adr || !diff) return null;

    // Gate: husnr + postnr SKAL matche eksakt; vejnavnet må rettes.
    if (diff.husnr !== 0 || diff.postnr !== 0) return null;

    const aid = adr.adgangsadresseid;
    if (!aid) return null;

    const mini = await tryFetch(`/adgangsadresser/${encodeURIComponent(aid)}?struktur=mini`);
    return coordsFromRow(mini);
}

// ==========================================
// geocodeRaw({ street, nr, zip, city }) → { lat, lon } | null
//
// Primær: struktureret opslag (vejnavn + husnr + postnr).
// Fallback 1: fri-tekst q-søgning hvis det strukturerede giver 0 hits.
// Fallback 2: datavask (retter fejlskrevne vejnavne mod officiel
//   vejdatabase) — fanger v1-synkede adresser hvor de to første fejler.
// ==========================================
async function geocodeRaw({ street, nr, zip, city } = {}) {
    if (!street || !String(street).trim()) return null;

    // 1) Struktureret opslag
    const params = new URLSearchParams({ struktur: 'mini', per_side: '1' });
    params.set('vejnavn', String(street).trim());
    if (nr) params.set('husnr', String(nr).trim());
    if (zip) params.set('postnr', String(zip).trim());

    let results = await tryFetch(`/adgangsadresser?${params.toString()}`);
    let coords = coordsFromRow(Array.isArray(results) ? results[0] : null);
    if (coords) return coords;

    // 2) Fri-tekst fallback
    const q = [street, nr, zip].filter(Boolean).join(' ').trim();
    const fp = new URLSearchParams({ struktur: 'mini', per_side: '1', q });
    results = await tryFetch(`/adgangsadresser?${fp.toString()}`);
    coords = coordsFromRow(Array.isArray(results) ? results[0] : null);
    if (coords) return coords;

    // 3) Datavask — retter fejlskrevne/ikke-kanoniske vejnavne
    return geocodeViaDatavask({ street, nr, zip, city });
}

// ==========================================
// geocodeAddress(addressId) → { lat, lon } | null
//
// Læser addresses-rækken, geokoder hvis lat/lon mangler, og skriver
// coords tilbage til addresses. Returnerer eksisterende coords uændret
// hvis rækken allerede er geokodet.
// ==========================================
async function geocodeAddress(addressId) {
    const db = getDb();
    const addr = db.prepare(`
        SELECT id, street_name, street_nr, postal_code, city, lat, lon
        FROM addresses WHERE id = ?
    `).get(addressId);
    if (!addr) return null;

    if (addr.lat != null && addr.lon != null) {
        return { lat: addr.lat, lon: addr.lon };
    }

    // Live fire-and-forget-sti: throttling må aldrig boble op og crashe
    // kalderen (routes/addresses.js) — sluk den til null her. Backfill-
    // scriptet kalder geocodeRaw direkte og kan stadig se throttling.
    let coords = null;
    try {
        coords = await geocodeRaw({
            street: addr.street_name,
            nr: addr.street_nr,
            zip: addr.postal_code,
            city: addr.city
        });
    } catch (e) {
        if (e instanceof DawaError && e.throttled) return null;
        throw e;
    }
    if (!coords) return null;

    db.prepare('UPDATE addresses SET lat = ?, lon = ? WHERE id = ?')
        .run(coords.lat, coords.lon, addressId);
    return coords;
}

module.exports = { geocodeRaw, geocodeAddress, DawaError };
