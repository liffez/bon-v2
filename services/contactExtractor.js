// services/contactExtractor.js
// ==========================================
// Manuel paste-flow (Fase 4 fra docs/CLAUDE_KONTAKTER.md).
// Bruger klistrer HTML eller tekst ind, server kører email/telefon-regex
// + heuristik for offentlig/personlig klassifikation.
//
// Ingen auto-fetch af URL'er — undgår robots.txt-, anti-bot- og GDPR-risici.
// ==========================================

// Generiske email-prefixer som typisk er offentlige (info@, kontakt@ osv.)
const PUBLIC_PREFIXES = new Set([
    'info', 'kontakt', 'contact', 'mail', 'hello', 'post',
    'presse', 'press', 'media', 'journalist',
    'salg', 'sales', 'support', 'service', 'help', 'help-desk',
    'admin', 'office', 'reception', 'sekretariat',
    'whistleblower', 'compliance', 'legal',
    'faktura', 'invoice', 'finance', 'okonomi', 'oekonomi', 'regnskab',
    'hr', 'jobs', 'job', 'karriere', 'career',
    'booking', 'bestilling', 'order', 'reservation',
    'event', 'events', 'arrangement',
]);

// Mønstre der typisk indikerer en personlig email (firstname.lastname@).
// Kræver ALTID en separator (. _ -) mellem to bogstavs-runs så vi ikke
// fanger fx "tilbud@" eller "kontakt@" som personlige.
const PERSONAL_PATTERNS = [
    /^[a-zæøå]{2,}[._-][a-zæøå]{2,}@/i,   // firstname.lastname@ (eller _ / -)
    /^[a-zæøå]\.[a-zæøå]{2,}@/i,           // f.lastname@
];

// Email regex — pragmatisk men dækker de fleste reelle adresser
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Sikkerhedsnet: en kontaktside har aldrig hundredvis af reelle numre/emails.
// Et stort HTML-paste (kildekode med id'er/datoer) kan ellers producere tusindvis
// af falske telefon-kandidater og fryse browseren når de renderes. Cap pr. type.
const MAX_PER_KIND = 100;

// Telefon-regex (DK-format).
// Fanger: 12345678, 12 34 56 78, 12-34-56-78, +45 12 34 56 78, +4512345678
const PHONE_RE = /(?:\+45[\s.\-–—]?)?(?:\d[\s.\-–—]?){7,9}\d/g;

// Strip HTML-tags og collapse whitespace. Bevarer linjeskift som mellemrum
// så context-snippets stadig giver mening.
function stripHtmlAndNormalize(input) {
    if (!input) return '';
    let text = String(input);
    // Fjern <script>/<style>-blokke før tag-strip
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    // HTML-entities (basale)
    text = text.replace(/&nbsp;/gi, ' ')
               .replace(/&amp;/gi, '&')
               .replace(/&lt;/gi, '<')
               .replace(/&gt;/gi, '>')
               .replace(/&quot;/gi, '"')
               .replace(/&#39;/gi, "'");
    // Fjern obfuskerede @ ("info(at)example.com", "info [at] example.com")
    text = text.replace(/\s*[\(\[]\s*at\s*[\)\]]\s*/gi, '@');
    text = text.replace(/\s*[\(\[]\s*snabel(?:-?a)?\s*[\)\]]\s*/gi, '@');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

function classifyEmail(email) {
    const local = email.split('@')[0].toLowerCase();
    if (PUBLIC_PREFIXES.has(local)) return 'public';
    if (PERSONAL_PATTERNS.some(p => p.test(email))) return 'personal';
    // Single-word prefixer uden punktum/bindestreg lader vi være "unknown" —
    // bruger bestemmer (fx "tilbud", "marielouise" — vi kan ikke gætte).
    return 'unknown';
}

function normalizePhone(raw) {
    // Strip ikke-cifre og + (men bevar + foran landekode)
    let digits = raw.replace(/[^\d+]/g, '');
    // Hvis det er 8 cifre, antag DK
    if (/^\d{8}$/.test(digits)) {
        return digits.replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');
    }
    // Med +45-prefix
    if (/^\+45\d{8}$/.test(digits)) {
        const r = digits.slice(3);
        return '+45 ' + r.replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');
    }
    return digits;
}

function looksLikePhone(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 12) return false;
    // 8 cifre uden landekode → DK-format. 10-12 → med landekode.
    return digits.length === 8 || digits.length >= 10;
}

// ±60 tegn omkring fundet i original-tekst
function makeSnippet(text, idx, len, span = 60) {
    const start = Math.max(0, idx - span);
    const end   = Math.min(text.length, idx + len + span);
    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
}

/**
 * Extract email + phone candidates from pasted text/HTML.
 *
 * @param {object} opts
 * @param {string} opts.text       indhold fra brugerens paste
 * @param {string} [opts.sourceUrl] valgfri kilde-URL (gemmes på nye cps)
 *
 * @returns {{
 *   ok: boolean,
 *   source_url: string|null,
 *   candidates: Array<{
 *     kind: 'email'|'phone',
 *     value: string,
 *     classification: 'public'|'personal'|'unknown',
 *     context_snippet: string,
 *     proposed_is_public: 0|1
 *   }>,
 *   stats: object
 * }}
 */
function extractContacts({ text, sourceUrl } = {}) {
    const cleaned = stripHtmlAndNormalize(text || '');
    if (cleaned.length === 0) {
        return { ok: false, candidates: [], stats: { total_emails_found: 0, total_phones_found: 0 } };
    }

    // ── Emails ──
    const emailHits = [];
    const seenEmails = new Set();
    let m;
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(cleaned)) !== null) {
        const raw = m[0].trim();
        const norm = raw.toLowerCase();
        if (seenEmails.has(norm)) continue;
        seenEmails.add(norm);
        const cls = classifyEmail(norm);
        emailHits.push({
            kind: 'email',
            value: norm,
            classification: cls,
            context_snippet: makeSnippet(cleaned, m.index, raw.length),
            proposed_is_public: cls === 'public' ? 1 : 0,
        });
        if (emailHits.length >= MAX_PER_KIND) break;
    }

    // ── Telefoner ──
    const phoneHits = [];
    const seenPhones = new Set();
    let phonesTruncated = false;
    PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(cleaned)) !== null) {
        const raw = m[0].trim();
        // Adjacency-guard: hvis tegnet lige før eller efter matchet er et ciffer,
        // er dette en del af et længere tal-løb (id, timestamp, beløb) — ikke et
        // telefonnummer. Stripper langt de fleste HTML-falske positiver.
        const before = m.index > 0 ? cleaned[m.index - 1] : '';
        const after  = cleaned[m.index + m[0].length] || '';
        if (/\d/.test(before) || /\d/.test(after)) continue;
        // Krydsreferér mod CVR-mønster — kun teksten FØR nummeret tjekkes, fordi
        // CVR/VAT/P-nr altid skrives som "CVR: 12345678" (nøgleord før tallet).
        // Tidligere medtog vi også 5 tegn EFTER, hvilket fejlagtigt undertrykte
        // et rigtigt telefonnummer der tilfældigvis stod lige før "CVR:" på næste linje.
        const ctxStart = Math.max(0, m.index - 20);
        const ctxBefore = cleaned.slice(ctxStart, m.index).toLowerCase();
        if (/\b(cvr|vat|p-?nr|p\.\s*nr|momsnr)\b/.test(ctxBefore)) continue;
        // Eksklusér rene år-formater (fx "2024 — 2026")
        const digitsOnly = raw.replace(/\D/g, '');
        if (digitsOnly.length === 4 && /^(19|20)\d{2}$/.test(digitsOnly)) continue;
        // Eksklusér år-intervaller (fx "2024-2026", "1998–2024") — to årstal
        // skrevet sammen giver 8 cifre og lignede ellers et telefonnummer.
        if (/^(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}$/.test(raw)) continue;
        if (!looksLikePhone(raw)) continue;
        const norm = normalizePhone(raw);
        const dedupKey = norm.replace(/\s/g, '');
        if (seenPhones.has(dedupKey)) continue;
        seenPhones.add(dedupKey);
        phoneHits.push({
            kind: 'phone',
            value: norm,
            classification: 'unknown',  // Telefoner: bruger bestemmer
            context_snippet: makeSnippet(cleaned, m.index, raw.length),
            proposed_is_public: 0,
        });
        if (phoneHits.length >= MAX_PER_KIND) { phonesTruncated = true; break; }
    }

    const candidates = [...emailHits, ...phoneHits];
    const stats = {
        total_emails_found: emailHits.length,
        total_phones_found: phoneHits.length,
        classified_public:   candidates.filter(c => c.classification === 'public').length,
        classified_personal: candidates.filter(c => c.classification === 'personal').length,
        unknown:             candidates.filter(c => c.classification === 'unknown').length,
        truncated:           phonesTruncated,
    };

    return {
        ok: true,
        source_url: sourceUrl || null,
        candidates,
        stats,
    };
}

module.exports = {
    extractContacts,
    classifyEmail,
    normalizePhone,
    stripHtmlAndNormalize,
};
