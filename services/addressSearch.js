// services/addressSearch.js
//
// Adresseforslag fra DAWA — ÉN kopi af reglen, kaldt af alle skærme gennem
// GET /embed/adresse/soeg.
//
// Hvorfor på serveren: kundens browser talte før direkte med
// api.dataforsyningen.dk. En firma-firewall der ikke kender domænet (Danner,
// sep. 2026) blokerede det lydløst — adresselisten kom aldrig frem, og
// bestillingen kunne ikke sendes. Bestillingssiden selv ligger på vores
// domæne, så den kan kunden nå; opslaget går nu samme vej.
//
// Reglen lå desuden i tre kopier (shared/utils.js, bestillingssiden,
// smagsprøven), holdt ens af en test. Nu er der én.
//
// Rangering:
//   1. DAWA rangerer ikke efter nærhed ("Vesterbrogade 10" giver Viborg og
//      Kolding). Der spørges derfor to gange: afgrænset til hovedstadsområdet
//      og uden filter. Lokale hits først, hver blok efter postnummer.
//   2. Står der et husnummer i søgningen, kommer adresser med PRÆCIS det
//      nummer først. DAWA matcher på starten af teksten, så "Nansensgade 1"
//      rammer også 10, 12, 14 og alle deres etager — og nr. 1 selv lå på
//      plads 11, uden for listen.
//
// Fælde: DAWA svarer 0 hits når fuzzy kombineres med et filter, så den
// lokale forespørgsel er aldrig fuzzy.

const DAWA_BASE = 'https://api.dataforsyningen.dk';

/** Hovedstadsområdet som DAWA-kommunekoder — det "nære" i søgningen. */
const DAWA_LOCAL_KOMMUNER = [
    '0101', // København
    '0147', // Frederiksberg
    '0151', // Ballerup
    '0153', // Brøndby
    '0155', // Dragør
    '0157', // Gentofte
    '0159', // Gladsaxe
    '0161', // Glostrup
    '0163', // Herlev
    '0165', // Albertslund
    '0167', // Hvidovre
    '0169', // Høje-Taastrup
    '0173', // Lyngby-Taarbæk
    '0175', // Rødovre
    '0183', // Ishøj
    '0185', // Tårnby
    '0187', // Vallensbæk
    '0190', // Furesø
    '0230', // Rudersdal
    '0240', // Egedal
];

const MAX_LIMIT = 20;
/** Når der står et husnummer, hentes flere så det præcise nummer kan findes. */
const FETCH_WITH_NUMBER = 50;
const TIMEOUT_MS = 6000;

/**
 * Husnummeret i søgningen: første tal-token EFTER gadenavnet.
 * "Nansensgade 1" → "1", "Nansensgade 1, 1366" → "1", "Vesterbrogade 5A" → "5a".
 * Et postnummer alene ("2200") er ikke et husnummer.
 */
function houseNumberOf(q) {
    const tokens = String(q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
        if (/^\d{1,3}[a-zæøå]?$/.test(tokens[i])) return tokens[i];
    }
    return null;
}

/** Stabil sortering efter postnummer; ukendt postnr sidst. */
function sortByPostnr(items) {
    return (items || [])
        .map((it, i) => ({ it, i }))
        .sort((a, b) => {
            let pa = parseInt((a.it.adresse || {}).postnr, 10);
            let pb = parseInt((b.it.adresse || {}).postnr, 10);
            if (isNaN(pa)) pa = 99999;
            if (isNaN(pb)) pb = 99999;
            return (pa - pb) || (a.i - b.i);
        })
        .map(x => x.it);
}

/**
 * Præcist husnummer først — og blandt dem opgangen uden etage (selve
 * gadedøren) før lejlighederne. Resten beholder sin rækkefølge.
 */
function exactNumberFirst(items, nr) {
    if (!nr) return items;
    const rank = it => {
        const a = it.adresse || {};
        if (String(a.husnr || '').toLowerCase() !== nr) return 2;
        return a.etage ? 1 : 0;
    };
    return items.map((it, i) => ({ it, i }))
        .sort((a, b) => (rank(a.it) - rank(b.it)) || (a.i - b.i))
        .map(x => x.it);
}

/**
 * Ren flette-regel: lokale hits først, så resten — begge efter postnr
 * (og præcist husnummer først), uden dubletter, højst `limit`.
 */
function mergeSuggestions(local, global, limit, nr) {
    const seen = {};
    const out = [];
    const take = list => {
        exactNumberFirst(sortByPostnr(list), nr).forEach(it => {
            const key = (it && it.adresse && it.adresse.id) || (it && it.tekst);
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(it);
        });
    };
    take(local);
    take(global);
    return out.slice(0, limit);
}

function clampLimit(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return 10;
    return Math.min(n, MAX_LIMIT);
}

/**
 * Søg adresser. Returnerer DAWA's autocomplete-form
 * (`{ tekst, adresse: { id, vejnavn, husnr, etage, dør, postnr, postnrnavn, x, y } }`),
 * så kaldere kan bruge item.adresse direkte uden et opslag mere.
 *
 * Fejler den lokale forespørgsel, bruges den globale alene. Fejler den
 * globale, kastes — kalderen skal kunne se at opslaget ikke svarede.
 */
async function searchAddresses(q, opts = {}) {
    const fetchImpl = opts.fetch || fetch;
    const limit = clampLimit(opts.limit);
    const nr = houseNumberOf(q);
    const perSide = nr ? Math.max(limit, FETCH_WITH_NUMBER) : limit;
    const enc = encodeURIComponent(q);
    const localUrl = `${DAWA_BASE}/adresser/autocomplete?q=${enc}&per_side=${perSide}`
        + `&kommunekode=${DAWA_LOCAL_KOMMUNER.join('|')}`;
    const globalUrl = `${DAWA_BASE}/adresser/autocomplete?q=${enc}&per_side=${perSide}`
        + (opts.fuzzy ? '&fuzzy=true' : '');

    const get = async url => {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
        try {
            const r = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (!r.ok) throw new Error('DAWA ' + r.status);
            const d = await r.json();
            return Array.isArray(d) ? d : [];
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
    const [local, global] = await Promise.all([
        get(localUrl).catch(() => []),
        get(globalUrl),
    ]);
    return mergeSuggestions(local, global, limit, nr);
}

module.exports = {
    DAWA_BASE,
    DAWA_LOCAL_KOMMUNER,
    houseNumberOf,
    sortByPostnr,
    exactNumberFirst,
    mergeSuggestions,
    clampLimit,
    searchAddresses,
};
