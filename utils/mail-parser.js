/**
 * utils/mail-parser.js
 * ════════════════════════════════════════════════════════════
 * Subject-parser og forward-parser til Bon v2 mail-system.
 * Portet fra mail-prototype/utils/parser.js.
 *
 * Prefixes læses fra settings-tabellen via getPrefixes().
 * Ingen eksterne afhængigheder — ren logik, kan testes isoleret.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

const BON_V1_PATTERN = /#Bon:/i;

/**
 * Tjek om emne er Bon v1 format (skal ignoreres).
 */
function isBonV1(subject) {
    return BON_V1_PATTERN.test(subject || '');
}

/**
 * Hent mail-tag prefixes fra settings-tabellen.
 * Returnerer defaults hvis settings ikke findes.
 */
function getPrefixes() {
    const db = getDb();
    const rows = db.prepare(
        `SELECT key, value FROM settings
         WHERE key IN ('mail_tag_bon_prefix', 'mail_tag_offer_prefix', 'mail_tag_customer_prefix', 'mail_tag_purchase_order_prefix', 'mail_tag_supplier_prefix')`
    ).all();
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
        bon:            map.mail_tag_bon_prefix            || 'b-',
        offer:          map.mail_tag_offer_prefix          || 't-',
        customer:       map.mail_tag_customer_prefix       || 'k-',
        purchase_order: map.mail_tag_purchase_order_prefix || 'po-',
        supplier:       map.mail_tag_supplier_prefix       || 's-',
    };
}

/**
 * Parser et emne-felt for Bon v2 tags.
 * # er fast markør, prefix er konfigurerbart.
 *
 * @param {string} subject
 * @param {object} [prefixes] - { bon, offer, customer, purchase_order } — hentes fra DB hvis udeladt
 * @returns {{ isV1: boolean, routing: string, bonNumber: number|null, offerNumber: number|null, customerNumber: number|null, purchaseOrderNumber: number|null, raw: string }}
 */
function parseSubject(subject, prefixes) {
    if (!subject) {
        return { isV1: false, routing: 'unmatched', bonNumber: null, offerNumber: null, customerNumber: null, purchaseOrderNumber: null, supplierNumber: null, raw: '' };
    }

    if (isBonV1(subject)) {
        return { isV1: true, routing: 'ignore', bonNumber: null, offerNumber: null, customerNumber: null, purchaseOrderNumber: null, supplierNumber: null, raw: subject };
    }

    const p = prefixes || getPrefixes();
    const esc = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

    const bonMatch      = new RegExp(`#${esc(p.bon)}(\\d+)`, 'i').exec(subject);
    const offerMatch    = new RegExp(`#${esc(p.offer)}(\\d+)`, 'i').exec(subject);
    const customerMatch = new RegExp(`#${esc(p.customer)}(\\d+)`, 'i').exec(subject);
    const poMatch       = new RegExp(`#${esc(p.purchase_order)}(\\d+)`, 'i').exec(subject);
    const supplierMatch = new RegExp(`#${esc(p.supplier)}(\\d+)`, 'i').exec(subject);

    const bonNumber            = bonMatch      ? parseInt(bonMatch[1])      : null;
    const offerNumber          = offerMatch    ? parseInt(offerMatch[1])    : null;
    const customerNumber       = customerMatch ? parseInt(customerMatch[1]) : null;
    const purchaseOrderNumber  = poMatch       ? parseInt(poMatch[1])      : null;
    const supplierNumber       = supplierMatch ? parseInt(supplierMatch[1]) : null;

    let routing;
    if (bonNumber && customerNumber) {
        routing = 'bon+customer';
    } else if (bonNumber) {
        routing = 'bon';
    } else if (offerNumber) {
        routing = 'offer';
    } else if (purchaseOrderNumber) {
        routing = 'purchase_order';
    } else if (supplierNumber) {
        routing = 'supplier';
    } else if (customerNumber) {
        routing = 'customer';
    } else {
        routing = 'unmatched';
    }

    return { isV1: false, routing, bonNumber, offerNumber, customerNumber, purchaseOrderNumber, supplierNumber, raw: subject };
}

/**
 * Byg et mail-tag fra kontekst.
 * @param {{ type: 'bon'|'offer'|'customer', number: number }} context
 * @param {object} [prefixes] - hentes fra DB hvis udeladt
 * @returns {string} f.eks. '#b-3001'
 */
function buildTag(context, prefixes) {
    if (!context || !context.type || !context.number) return '';
    const p = prefixes || getPrefixes();
    const prefixMap = { bon: p.bon, offer: p.offer, customer: p.customer, purchase_order: p.purchase_order, supplier: p.supplier };
    const prefix = prefixMap[context.type];
    if (!prefix) return '';
    return `#${prefix}${context.number}`;
}

// ── Forward-parsing ─────────────────────────────────────────

const FREE_DOMAINS = ['gmail', 'hotmail', 'outlook', 'yahoo', 'icloud', 'live', 'me', 'protonmail'];

/**
 * Forsøger at parse afsender fra forwarded-blok i brødtekst.
 * Bruges KUN til præudfyldning — aldrig til automatisk handling.
 *
 * @param {string} bodyText
 * @returns {{ email: string, name: string|null, firstName: string|null, lastName: string|null, company: string|null, source: string }|null}
 */
function parseForwardedSender(bodyText) {
    if (!bodyText) return null;

    const forwardMarkers = [
        /[-─]{4,}\s*(?:Forwarded (?:message|email)|Videresendt besked|Original Message)/i,
        /Begin forwarded message/i,
    ];

    let block = bodyText;
    for (const marker of forwardMarkers) {
        const m = marker.exec(bodyText);
        if (m) { block = bodyText.slice(m.index); break; }
    }

    const fromLine = /^(?:From|Fra):\s*(.+)$/im.exec(block);
    if (!fromLine) return null;

    const fromRaw = fromLine[1].trim();

    // "Navn <email>"
    const namedEmail = /^(.+?)\s*<([^>]+)>/.exec(fromRaw);
    if (namedEmail) {
        const name  = namedEmail[1].trim().replace(/^["']|["']$/g, '');
        const email = namedEmail[2].trim().toLowerCase();
        return {
            name,
            firstName: name.split(' ')[0] || null,
            lastName:  name.split(' ').slice(1).join(' ') || null,
            email,
            company: _guessCompany(email),
            source: 'forward_parsed',
        };
    }

    // Bare email
    const bareEmail = /[\w.+-]+@[\w.-]+\.\w+/.exec(fromRaw);
    if (bareEmail) {
        const email = bareEmail[0].toLowerCase();
        return { name: null, firstName: null, lastName: null, email, company: _guessCompany(email), source: 'forward_parsed' };
    }

    return null;
}

function _guessCompany(email) {
    if (!email) return null;
    const domain = email.split('@')[1];
    if (!domain) return null;
    const base = domain.split('.')[0];
    if (FREE_DOMAINS.includes(base)) return null;
    return base.charAt(0).toUpperCase() + base.slice(1);
}

module.exports = { parseSubject, parseForwardedSender, isBonV1, getPrefixes, buildTag };
