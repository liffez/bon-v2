// services/companyMatcher.js
// ==========================================
// Kanonisk firma-matcher mod companies-tabellen.
//
// Bruges af:
//   - services/cvrEnrichment.js (CVR/Virk-berigelse)        — re-eksporterer similarity/normalizeName
//   - scripts/enrich-cvr.js     (CLI CVR-berigelse)         — bruger similarity/normalizeName
//   - routes/campaigns.js       (Fase 3 paste-import)       — bruger matchCompany
//
// PRODUKTNAVN-matching (Hørkram ↔ Grocy) i shared/indkob_settings.js har sin egen
// dice-bigram-implementering og deler IKKE kode med denne fil. Andet domæne,
// andre constraints. Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 0.
// ==========================================

const LEGAL_SUFFIXES = /\b(i\/s|a\/s|aps|s\/i|a\.m\.b\.a|f\.m\.b\.a|fond|forening|smba|ivs|p\/s|k\/s|holding|group|as|is)\b/gi;
const PARENS = /\(.*?\)/g;

/**
 * Normalisér firmanavn for sammenligning.
 * Fjerner parenteser, juridiske suffixer, ikke-alfanumeriske tegn.
 * Bevaret 1:1 fra scripts/enrich-cvr.js + services/cvrEnrichment.js (begge identiske).
 */
function normalizeName(name) {
    return (name || '').toLowerCase()
        .replace(PARENS, '')
        .replace(LEGAL_SUFFIXES, '')
        .replace(/[^a-zæøåé0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Similarity-score 0.0-1.0 mellem to firmanavne.
 * Token-set Jaccard + substring-check efter suffix-normalisering.
 * Bevaret 1:1 fra services/cvrEnrichment.js (inkl. !na||!nb-guard).
 */
function similarity(a, b) {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.95;
    const tokA = new Set(na.split(' ').filter(t => t.length > 1));
    const tokB = new Set(nb.split(' ').filter(t => t.length > 1));
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokA) if (tokB.has(t)) overlap++;
    const smaller = Math.min(tokA.size, tokB.size);
    if (overlap === smaller && smaller >= 1) return 0.90;
    return (2 * overlap) / (tokA.size + tokB.size);
}

/**
 * Match input mod companies-tabellen.
 *
 * @param {object} db - node:sqlite DatabaseSync-instans (fra getDb() eller :memory:)
 * @param {object} input
 * @param {string} [input.name]   firmanavn
 * @param {string} [input.cvr]    8-cifret CVR
 * @param {string} [input.ean]    13-cifret EAN/GLN
 * @param {string} [input.email]  kontaktemail
 * @param {string} [input.city]   bynavn (bruges som tiebreaker ved fuzzy navn-match)
 *
 * @returns {object|null}
 *   { match_type, company_id, confidence, company_name } eller null hvis intet match.
 *
 * Prioritet:
 *   1. CVR exact   → confidence 1.0, match_type 'cvr_exact'
 *   2. EAN exact   → confidence 1.0, match_type 'ean_exact'
 *   3. Email mod contact_points → confidence 0.95, match_type 'email_match'
 *   4. Navn fuzzy (similarity ≥ 0.85) → confidence = similarity, match_type 'name_fuzzy'
 *   5. Ingen → null
 *
 * Bemærk: ekskluderer altid firmaer med is_internal = 1.
 */
function matchCompany(db, { name, cvr, ean, email, city } = {}) {
    if (cvr) {
        const cleanCvr = String(cvr).replace(/\D/g, '');
        if (cleanCvr.length === 8) {
            const r = db.prepare('SELECT id, name FROM companies WHERE cvr = ? AND is_internal = 0').get(cleanCvr);
            if (r) return { match_type: 'cvr_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
        }
    }
    if (ean) {
        const cleanEan = String(ean).replace(/\s/g, '');
        if (cleanEan.length === 13) {
            const r = db.prepare('SELECT id, name FROM companies WHERE ean = ? AND is_internal = 0').get(cleanEan);
            if (r) return { match_type: 'ean_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
        }
    }
    if (email && email.includes('@')) {
        const r = db.prepare(`
            SELECT co.id, co.name
            FROM contact_points cp
            JOIN companies co ON co.id = cp.entity_id
            WHERE cp.entity_type = 'company'
              AND cp.kind = 'email'
              AND cp.value = ?
              AND cp.is_active = 1
              AND co.is_internal = 0
            LIMIT 1
        `).get(email.toLowerCase());
        if (r) return { match_type: 'email_match', company_id: r.id, confidence: 0.95, company_name: r.name };
    }
    if (name) {
        // Scanner alle ikke-interne companies. På nuværende skala (~1.2k firmaer)
        // er det <10ms. Hvis basen vokser markant, tilføj prefix-filter på normaliseret navn.
        // City ligger på addresses (via companies.address_id) — JOIN'es ind for at kunne
        // bruges som tiebreaker. LEFT JOIN så firmaer uden adresse stadig vurderes.
        const candidates = db.prepare(`
            SELECT co.id, co.name, addr.city AS city
            FROM companies co
            LEFT JOIN addresses addr ON addr.id = co.address_id
            WHERE co.is_internal = 0
        `).all();
        const cityLower = city ? city.toLowerCase() : null;
        let best = null;
        for (const c of candidates) {
            const s = similarity(name, c.name);
            if (s < 0.85) continue;
            // City er kun tiebreaker — manglende city på enten side disqualificerer ikke
            if (cityLower && c.city && c.city.toLowerCase() !== cityLower) continue;
            if (!best || s > best.confidence) {
                best = { match_type: 'name_fuzzy', company_id: c.id, confidence: s, company_name: c.name };
            }
        }
        if (best) return best;
    }
    return null;
}

module.exports = { normalizeName, similarity, matchCompany };
