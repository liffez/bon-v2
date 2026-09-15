// services/cvrEnrichment.js
// ==========================================
// Runtime CVR enrichment service. Extrakt af logikken fra scripts/enrich-cvr.js.
// Strategier (prioriteret):
//   1. CVR direkte → Virk ES (mest præcist hvis CVR allerede er sat)
//   2. EAN → NemHandel (GLN→CVR, sikrest for institutioner)
//   3. Kendte institutioner via email-domæne
//   4. Virk ES navnesøgning med fuzzy matching
//
// Kræver VIRK_ES_USER + VIRK_ES_PASS i env.
// Returns: { found, konfidens, kilde, data } eller { found: false, besked }
// ==========================================

const { normalizeName, similarity } = require('./companyMatcher');

const VIRK_USER = process.env.VIRK_ES_USER;
const VIRK_PASS = process.env.VIRK_ES_PASS;
const VIRK_URL = 'http://distribution.virk.dk/cvr-permanent/_search';

const KENDTE = {
    'kk.dk':            { cvr: '64942212', navn: 'Københavns Kommune' },
    'rh.dk':            { cvr: '33657598', navn: 'Rigshospitalet' },
    'regionh.dk':       { cvr: '29190623', navn: 'Region Hovedstaden' },
    'ku.dk':            { cvr: '29979812', navn: 'Københavns Universitet' },
    'dtu.dk':           { cvr: '30060946', navn: 'Danmarks Tekniske Universitet' },
    'sdu.dk':           { cvr: '29283958', navn: 'Syddansk Universitet' },
    'frederiksberg.dk': { cvr: '11259979', navn: 'Frederiksberg Kommune' },
};

// ─── Hjælpere ────────────────────────────────────────────────

function basicAuth() {
    return 'Basic ' + Buffer.from(`${VIRK_USER}:${VIRK_PASS}`).toString('base64');
}

function parseVirkHit(hit) {
    const v = hit?._source?.Vrvirksomhed;
    if (!v) return null;
    const meta = v.virksomhedMetadata || {};
    const adr = meta.nyesteBeliggenhedsadresse;
    const branche = meta.nyesteHovedbranche || {};
    const ansatte = meta.nyesteAarsbeskaeftigelse || meta.nyesteKvartalsbeskaeftigelse || {};

    // Hjemmeside fra elektroniskpost-array (hvis nogen)
    let website = null;
    const epost = v.elektroniskPost || [];
    for (const ep of epost) {
        const k = (ep.kontaktoplysning || '').toLowerCase();
        if (/^(https?:\/\/|www\.)/.test(k) || /\.[a-z]{2,}$/.test(k.split('@')[0]) === false && k.includes('.')) {
            // simpel heuristik: indeholder . men ikke @
            if (!k.includes('@')) { website = ep.kontaktoplysning; break; }
        }
    }

    // Officielle emails + telefoner (kommer fra grunddata)
    const public_emails = [];
    const public_phones = [];
    for (const ep of epost) {
        const k = ep.kontaktoplysning;
        if (k && k.includes('@')) public_emails.push(k);
    }
    const tlfArr = v.telefonNummer || [];
    for (const t of tlfArr) {
        if (t.kontaktoplysning) public_phones.push(t.kontaktoplysning);
    }

    return {
        cvr: v.cvrNummer ? String(v.cvrNummer) : null,
        name: meta.nyesteNavn?.navn || null,
        legal_name: meta.nyesteNavn?.navn || null,
        address: adr ? `${adr.vejnavn || ''} ${adr.husnummerFra || ''}`.trim() || null : null,
        zipcode: adr?.postnummer ? String(adr.postnummer) : null,
        city: adr?.postdistrikt || null,
        industry: branche.branchetekst || null,
        industry_code: branche.branchekode || null,
        employees: ansatte.antalAnsatte || ansatte.intervalKodeAntalAnsatte || null,
        website,
        status: meta.sammensatStatus || null,
        public_emails,
        public_phones,
        score: hit._score,
    };
}

// ─── Eksterne kald ──────────────────────────────────────────

async function virkLookupByCvr(cvr) {
    if (!VIRK_USER || !VIRK_PASS) return null;
    const body = {
        query: { term: { 'Vrvirksomhed.cvrNummer': parseInt(cvr, 10) } },
        size: 1,
    };
    try {
        const r = await fetch(VIRK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': basicAuth() },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        const data = await r.json();
        const hit = data.hits?.hits?.[0];
        return hit ? parseVirkHit(hit) : null;
    } catch {
        return null;
    }
}

async function virkSearchByName(query) {
    if (!VIRK_USER || !VIRK_PASS) return [];
    const body = {
        query: {
            bool: {
                must: {
                    match: {
                        'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn': {
                            query, fuzziness: 'AUTO',
                        }
                    }
                }
            }
        },
        size: 5,
    };
    try {
        const r = await fetch(VIRK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': basicAuth() },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return [];
        const data = await r.json();
        return (data.hits?.hits || []).map(parseVirkHit).filter(Boolean);
    } catch {
        return [];
    }
}

async function nemhandelLookup(ean) {
    const url = `https://registration.nemhandel.dk/NemHandelRegisterWeb/public/participant/info?keytype=GLN&key=${ean}&lang=da`;
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        const html = await r.text();
        const relevant = html.split(/Registrering foretaget af/i)[0];
        const navnMatch = relevant.match(/<h[456][^>]*>\s*([^<]{2,120})\s*<\/h[456]>/i);
        const cvrMatch  = relevant.match(/unitcvr=(\d{8})/i)
                       || relevant.match(/CVR[:\s]*(\d{8})/i);
        if (!navnMatch && !cvrMatch) return null;
        return {
            enhedsnavn: navnMatch?.[1]?.trim() || null,
            cvr: cvrMatch?.[1] || null,
        };
    } catch {
        return null;
    }
}

// ─── Hovedfunktion ───────────────────────────────────────────

/**
 * Berig firma med data fra CVR/NemHandel.
 *
 * @param {object} input
 * @param {string} [input.cvr]   8-cifret CVR-nummer
 * @param {string} [input.ean]   13-cifret EAN/GLN
 * @param {string} [input.email] kontaktemail (bruges til kendt-domæne lookup)
 * @param {string} [input.navn]  firmanavn (bruges til Virk ES fuzzy search)
 *
 * @returns {Promise<{
 *   found: boolean,
 *   konfidens?: number,
 *   kilde?: string,
 *   data?: object,
 *   besked?: string
 * }>}
 */
async function enrich({ cvr, ean, email, navn } = {}) {
    // 1. CVR direkte → Virk ES
    if (cvr && /^\d{8}$/.test(String(cvr).replace(/\D/g, ''))) {
        const cleanCvr = String(cvr).replace(/\D/g, '');
        const virk = await virkLookupByCvr(cleanCvr);
        if (virk && virk.cvr) {
            return {
                found: true,
                konfidens: 1.0,
                kilde: 'Virk ElasticSearch (CVR direkte)',
                data: virk,
            };
        }
    }

    // 2. EAN → NemHandel
    if (ean) {
        const cleanEan = String(ean).replace(/\s/g, '');
        if (cleanEan.length === 13 && /^\d+$/.test(cleanEan)) {
            const nh = await nemhandelLookup(cleanEan);
            if (nh && nh.cvr) {
                // Hent også Virk ES-data for fuld stamdata
                const virk = await virkLookupByCvr(nh.cvr);
                const data = virk || {
                    cvr: nh.cvr,
                    name: nh.enhedsnavn,
                    legal_name: nh.enhedsnavn,
                };
                data.ean = cleanEan;
                return {
                    found: true,
                    konfidens: 0.99,
                    kilde: 'NemHandel (EAN)',
                    data,
                };
            }
        }
    }

    // 3. Kendt institution via email-domæne
    if (email && email.includes('@')) {
        const domain = email.split('@')[1].toLowerCase();
        const known = KENDTE[domain];
        if (known) {
            const virk = await virkLookupByCvr(known.cvr);
            const data = virk || {
                cvr: known.cvr,
                name: known.navn,
                legal_name: known.navn,
            };
            return {
                found: true,
                konfidens: 0.95,
                kilde: `Kendt institution (${domain})`,
                data,
            };
        }
    }

    // 4. Virk ES navnesøgning (fuzzy)
    if (navn && navn.length >= 2) {
        let searchName = navn.replace(/\(.*?\)/g, '').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
        const words = searchName.split(' ');
        if (words.length > 6) searchName = words.slice(0, 6).join(' ');

        const results = await virkSearchByName(searchName);
        if (results.length > 0) {
            const scored = results.map(r => ({ ...r, sim: similarity(navn, r.name) }))
                                  .sort((a, b) => b.sim - a.sim);
            const best = scored[0];
            const normWords = normalizeName(navn).split(' ').filter(w => w.length > 1).length;
            const threshold = normWords <= 1 ? 0.90 : 0.75;

            if (best.sim >= threshold) {
                return {
                    found: true,
                    konfidens: Math.round(best.sim * 100) / 100,
                    kilde: 'Virk ElasticSearch (navnesøg)',
                    data: best,
                };
            }
            return {
                found: false,
                besked: `Bedste match "${best.name}" har for lav konfidens (${Math.round(best.sim * 100)}%)`,
                low_match: { name: best.name, cvr: best.cvr, score: best.sim },
            };
        }
    }

    return {
        found: false,
        besked: 'Ingen virksomhed fundet (CVR ikke sat, EAN ikke i NemHandel, email ikke i kendt-listen, ingen navn-match i Virk ES)',
    };
}

module.exports = { enrich, similarity, normalizeName, nemhandelLookup };
