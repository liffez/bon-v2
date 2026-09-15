/**
 * services/economicCustomerLookup.js
 * ────────────────────────────────────────────────────────────────────────
 * Find et Bon-firmas kunde i e-conomic: CVR → EAN → navn. KUN læsning.
 *
 * Bruges af to steder der før havde hver sin kopi:
 *   - GET /api/invoices/:bonId/economic-customer-suggest (faktureringen)
 *   - GET /api/companies/:id/economic-suggest            (Firma 360°, #502)
 *
 * Navnesøgningen spørger e-conomic på det LÆNGSTE ord i navnet, ikke det
 * første: "Institut for Fødevarevidenskab" → "Fødevarevidenskab", ikke
 * "Institut" (som rammer 40 institutter). Er navnet flere ord, spørges også
 * på det første betydende ord, så "Den Hirschsprungske Samling" findes både
 * på "Hirschsprungske" og — hvis e-conomic staver anderledes — "Samling".
 * Kandidaterne rangeres efter navnelighed, så det bedste bud står øverst.
 *
 * `match` fortæller HVORFOR kandidaten er med. `ean` og `cvr` (ét kort) er
 * facts; `cvr_shared` (paraply-CVR med flere kort) og `name` er forslag.
 * ────────────────────────────────────────────────────────────────────────
 */
'use strict';

const eco = require('./economicAdapter');

const digits = (s) => String(s || '').replace(/\D/g, '');

const STOP = new Set(['aps', 'as', 'a/s', 'ivs', 'i/s', 'og', 'for', 'af', 'the', 'den', 'det', 'de', 'ved', 'til', 'kommune', 'københavns', 'copenhagen', 'university', 'universitet']);

/** Navn uden fyldord — "Københavns Universitet, Institut for Psykologi" → "institut psykologi". Tomt → hele navnet. */
function coreName(s) {
    const norm = String(s || '').toLowerCase().replace(/[^a-zæøå0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
    const core = norm.split(' ').filter(w => w && !STOP.has(w)).join(' ');
    return core || norm;
}

/** Bigram-lighed 0..1 på navnenes KERNE. Uden fyldord-strippet ville "Københavns
 *  Universitet Plen" ligne "Københavns Universitet, Institut for Psykologi" mere
 *  end "Institut for Psykologi" gør — paraplyens navn druknede afdelingens. */
function nameScore(a, b) {
    a = coreName(a);
    b = coreName(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1); return m; };
    const A = bg(a), B = bg(b);
    let i = 0, sa = 0, sb = 0;
    for (const v of A.values()) sa += v;
    for (const [g, v] of B) { sb += v; if (A.has(g)) i += Math.min(v, A.get(g)); }
    return sa + sb ? 2 * i / (sa + sb) : 0;
}

/** Ord vi spørger e-conomic på: længste betydende ord + første betydende ord. */
function searchWords(name) {
    const words = String(name || '').split(/[\s,/()\-–]+/)
        .map(w => w.replace(/[^\wæøåÆØÅ]/g, ''))
        .filter(w => w.length >= 3 && !STOP.has(w.toLowerCase()));
    if (!words.length) return [];
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    const out = [longest];
    if (words[0] !== longest) out.push(words[0]);
    return out;
}

/**
 * @param {{cvr?, ean?, name?}} q
 * @param {{rest?: Function}} [deps] — testsøm; produktionen bruger economicAdapter.rest
 * @returns {Promise<Array<{number, name, cvr, ean, match, score}>>}
 */
async function searchEconomicCustomers({ cvr, ean, name, altName }, deps = {}) {
    const rest = deps.rest || eco.rest;
    const enc = encodeURIComponent;
    // Lighed måles mod BÅDE kaldenavn og juridisk navn — "KU FOOD" ligner
    // ingenting, men legal_name "Institut for Fødevarevidenskab" rammer.
    const names = [name, altName].filter(n => n && String(n).trim());
    const score = (k) => names.length ? Number(Math.max(...names.map(n => nameScore(n, k.name))).toFixed(2)) : 0;
    const out = [], seen = new Set();
    const add = (arr, match) => {
        for (const k of (arr || [])) {
            const n = String(k.customerNumber);
            if (seen.has(n)) continue;
            seen.add(n);
            out.push({ number: n, name: k.name || '', cvr: k.corporateIdentificationNumber || '', ean: k.ean || '', match, score: score(k) });
        }
    };
    // EAN først: det er fakturamodtageren og entydigt pr. afdeling.
    const e = digits(ean);
    if (e) { const r = await rest('/customers?filter=' + enc('ean$eq:' + e)).catch(() => null); add(r?.collection, 'ean'); }
    const d = digits(cvr);
    if (d) {
        const r = await rest('/customers?filter=' + enc('corporateIdentificationNumber$eq:' + d)).catch(() => null);
        const hits = (r?.collection || []);
        // Ét kort med CVR'et = et fact. Flere kort = et PARAPLY-CVR (KU, Region H,
        // Københavns Kommune): CVR'et udpeger så organisationen, ikke afdelingen,
        // og kortene rangeres som navneforslag. Målt live: KU's CVR gav "Plen"
        // som første bud for både Farmaci, Psykologi og Geo.
        add(hits, hits.length > 1 ? 'cvr_shared' : 'cvr');
    }
    const hasFact = out.some(c => c.match === 'ean' || c.match === 'cvr');
    if (!hasFact && names.length) {
        const words = new Set(names.flatMap(searchWords));
        for (const w of words) {
            const r = await rest('/customers?filter=' + enc('name$like:' + w) + '&pagesize=20').catch(() => null);
            add(r?.collection, 'name');
        }
    }
    // Facts øverst (EAN før CVR), derefter forslag efter navnelighed.
    const rank = { ean: 0, cvr: 1 };
    out.sort((a, b) => (rank[a.match] ?? 2) - (rank[b.match] ?? 2) || b.score - a.score);
    return out;
}

module.exports = { searchEconomicCustomers, nameScore, searchWords, coreName };
