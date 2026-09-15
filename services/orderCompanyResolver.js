// services/orderCompanyResolver.js
// ==========================================
// Hvilket firma skal en indkommende bestilling ligge på?
//
// Bestillingsformularens Firma-felt er fri tekst. De to indgange der opretter
// bons fra formularen (routes/web-orders.js og routes/webhooks.js) slog begge
// firmaet op på EKSAKT navn og oprettede en ny række når strengen ikke ramte
// tegn for tegn. Resultatet (#567 + #607): 39 af 114 web-bons lå på et andet
// firma end bestillerens eget, og "Landbrug & Fødevarer" fandtes 13 gange —
// heraf flere som det bogstavelige `LANDBRUG &amp; FØDEVARER`.
//
// Reglen bor ÉT sted, fordi de to ruter ellers driver fra hinanden — det var
// præcis sådan forhandler-undtagelsen (migration 167) kun landede i den ene.
//
// Rækkefølgen (beslutning, Leif, 13. september 2026):
//
//   1. Forhandler (is_reseller) vinder. Bestiller en kendt kunde hos en
//      forhandler, er det tastede navn SLUTKUNDEN, ikke den der betaler.
//   2. Kender vi bestilleren, og har hun et aktivt firma, beholdes det.
//      Ingen ny række. Det tastede navn gemmes i kundeønskerne ("Firma: X")
//      og i changelog'en, så office kan se hvad kunden skrev — og opdage den
//      dag en person reelt har skiftet arbejdsgiver.
//   3. Ellers: services/companyMatcher.js (CVR → EAN → e-mail → navnelighed)
//      FØR der oprettes noget. EAN og CVR trækkes ud af faktura-teksten.
//   4. Kun ved intet match oprettes en ny række — med et afkodet navn.
//
// HTML-entiteter afkodes FØR alt andet. `normalizeName()` redder ikke `&amp;`:
// den fjerner ikke-alfanumeriske tegn, så entiteten bliver til tokenet `amp`,
// som overlever normaliseringen. Og et escapet navn må aldrig gemmes.
// ==========================================

'use strict';

const { matchCompany, normalizeName } = require('./companyMatcher');

// ─── HTML-entiteter ──────────────────────────────────────────
// Numeriske (&#38; &#x26;) + de navngivne der forekommer i firmanavne. Dansk
// tekst kan komme escapet som &aelig;/&oslash;/&aring;, så de er med.
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å',
    eacute: 'é', Eacute: 'É', uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä',
    ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', middot: '·',
};

function decodeEntities(s) {
    if (s == null) return '';
    let out = String(s);
    // Afkod op til to lag (&amp;amp; forekommer når en tekst er escapet to gange).
    for (let i = 0; i < 2 && /&(#x?[0-9a-f]+|[a-z]+);/i.test(out); i++) {
        out = out
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES) ? NAMED_ENTITIES[name] : m);
    }
    return out;
}

/** Afkodet + trimmet + ét mellemrum. Tom streng hvis intet. */
function cleanTypedName(raw) {
    return decodeEntities(raw).replace(/\s+/g, ' ').trim();
}

// ─── Nøgler i faktura-teksten ────────────────────────────────
// EAN: 13 cifre. CVR: 8 cifre, men KUN med "CVR" foran — et nøgent 8-cifret
// tal i et fritekstfelt er lige så tit et telefonnummer.
function extractEan(text) {
    const m = String(text || '').match(/\b\d{13}\b/);
    return m ? m[0] : null;
}
function extractCvr(text) {
    const m = String(text || '').match(/\bCVR(?:-?nr\.?|-?nummer)?[\s.:#-]*(?:DK[\s-]?)?(\d{8})\b/i);
    return m ? m[1] : null;
}

function sameName(a, b) {
    const na = normalizeName(a), nb = normalizeName(b);
    return !!na && na === nb;
}

/**
 * Afgør firma for en bestilling. Skriver KUN til companies ved oprettelse.
 *
 * @param {object} db
 * @param {object} p
 * @param {string}  [p.typedName]         Firma-feltet, rå fra formularen
 * @param {string}  [p.email]             Bestillerens e-mail
 * @param {string}  [p.invoiceInfo]       Faktura-/EAN-fritekst (EAN + CVR trækkes ud)
 * @param {string}  [p.cvr]               Eksplicit CVR (vinder over teksten)
 * @param {string}  [p.ean]               Eksplicit EAN (vinder over teksten)
 * @param {string}  [p.city]              By (tiebreaker ved navnelighed)
 * @param {object}  [p.existingCustomer]  { id, company_id } | null — bestilleren hvis kendt
 *
 * @returns {{
 *   companyId: number|null, companyName: string|null,
 *   reseller: {id,name}|null, endCustomerName: string|null,
 *   typedName: string, ean: string|null, cvr: string|null,
 *   decision: 'reseller'|'customer_company'|'matched'|'created'|'none',
 *   match: object|null, created: boolean,
 *   typedDiffers: boolean, wishesLine: string|null, note: string|null
 * }}
 */
function resolveOrderCompany(db, p = {}) {
    const typedName = cleanTypedName(p.typedName);
    const ean = p.ean ? String(p.ean).replace(/\s/g, '') : extractEan(p.invoiceInfo);
    const cvr = p.cvr ? String(p.cvr).replace(/\D/g, '') : extractCvr(p.invoiceInfo);
    const email = (p.email || '').trim().toLowerCase() || null;

    const out = {
        companyId: null, companyName: null, reseller: null, endCustomerName: null,
        typedName, ean, cvr, decision: 'none', match: null, created: false,
        typedDiffers: false, wishesLine: null, note: null,
    };

    // Bestillerens eget firma — kun hvis det stadig er aktivt. En række lagt væk
    // af "Ryd tomme firmaer" må ikke få nye bons via en gammel kundekobling.
    const ownCompany = p.existingCustomer?.company_id
        ? db.prepare('SELECT id, name, is_reseller FROM companies WHERE id = ? AND is_active = 1')
            .get(p.existingCustomer.company_id) || null
        : null;

    let company = null;

    if (ownCompany) {
        company = ownCompany;
        out.decision = ownCompany.is_reseller ? 'reseller' : 'customer_company';
    } else if (typedName || cvr || ean) {
        // Matcheren, aktive firmaer kun. Bestillerens e-mail tæller med, fordi
        // den kan stå som firmaets kontaktpunkt selvom personen er ukendt.
        const m = matchCompany(db, { name: typedName || undefined, cvr, ean, email, city: p.city }, { activeOnly: true });
        if (m) {
            company = db.prepare('SELECT id, name, is_reseller FROM companies WHERE id = ?').get(m.company_id);
            out.match = m;
            out.decision = company?.is_reseller ? 'reseller' : 'matched';
        } else if (typedName) {
            const res = db.prepare('INSERT INTO companies (name, is_active) VALUES (?, 1)').run(typedName);
            company = { id: Number(res.lastInsertRowid), name: typedName, is_reseller: 0 };
            out.decision = 'created';
            out.created = true;
        }
    }

    if (!company) return out;

    out.companyId = company.id;
    out.companyName = company.name;
    out.typedDiffers = !!typedName && !sameName(typedName, company.name);

    // Hvordan matcheren fandt firmaet — til changelog'en, så et navnelighed-match
    // kan efterprøves af et menneske. Et forkert match skal kunne SES.
    const m = out.match;
    const how = m
        ? ({ cvr_exact: 'CVR', ean_exact: 'EAN', email_match: 'e-mail', name_fuzzy: 'navnelighed' }[m.match_type] || m.match_type) +
          (m.match_type === 'name_fuzzy' ? ` ${Math.round(m.confidence * 100)} %` : '')
        : null;

    if (company.is_reseller) {
        // Forhandler: det tastede navn er slutkunden — medmindre de bestiller
        // til sig selv.
        out.reseller = { id: company.id, name: company.name };
        out.endCustomerName = out.typedDiffers ? typedName : null;
        out.note = `lagt på formidleren ${company.name}` +
            (how ? ` (matchet på ${how})` : '') +
            (out.endCustomerName ? `, slutkunde: ${out.endCustomerName}` : '');
        return out;
    }

    if (out.decision === 'customer_company') {
        if (out.typedDiffers) {
            // Kunden skrev noget andet end det firma hun står på. Vi opretter
            // ikke en række på det — men vi skjuler det heller ikke.
            out.wishesLine = `Firma: ${typedName}`;
            out.note = `kunden skrev firma "${typedName}" — beholdt kundens firma ${company.name}, intet nyt firma oprettet`;
        }
        return out;
    }

    if (out.decision === 'matched') {
        if (out.typedDiffers) {
            out.wishesLine = `Firma: ${typedName}`;
            out.note = `firma "${typedName}" matchet på ${how} → ${company.name}, intet nyt firma oprettet`;
        } else if (m.match_type !== 'name_fuzzy') {
            out.note = `firma matchet på ${how} → ${company.name}`;
        }
        return out;
    }

    // created
    out.note = `nyt firma oprettet: ${company.name}`;
    return out;
}

/**
 * Læg "Firma: X"-linjen i kundeønskerne (over evt. form-markør, så den
 * bliver læst). Tom linje ⇒ teksten er urørt.
 */
function appendWishesLine(wishes, line) {
    if (!line) return wishes ?? null;
    const base = (wishes || '').trim();
    if (!base) return line;
    const marker = base.match(/\n\n\[Form:[^\]]*\]$/);
    if (marker) return base.slice(0, marker.index) + '\n\n' + line + marker[0];
    return base + '\n\n' + line;
}

module.exports = { resolveOrderCompany, decodeEntities, cleanTypedName, extractEan, extractCvr, appendWishesLine };
