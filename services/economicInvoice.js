/**
 * services/economicInvoice.js
 * ════════════════════════════════════════════════════════════
 * Bon → e-conomic fakturaudkast (Spor 2).
 * Spec: docs/economics/CLAUDE_ECONOMIC_ADAPTER.md (payload, moms, rabat, EAN).
 *
 * KUN udkast: createDraftInvoice POST'er til /invoices/drafts. Vi bogfører ALDRIG
 * automatisk — et menneske godkender/bogfører i e-conomic.
 *
 * Moms-doktrin (§6b): bon_lines.unit_price/line_total + bon.delivery_price er INCL moms.
 * e-conomic kræver EX moms pr. linje og beregner selv moms ud fra varens momskode +
 * kundens momszone. Konvertér derfor med shared/moms.js. Vi sender ALDRIG momsbeløb/sats.
 * ════════════════════════════════════════════════════════════
 */

const crypto = require('node:crypto');
const { inclToExcl } = require('../shared/moms');
const { getDb } = require('../db/database');
const eco = require('./economicAdapter');

function round2(n) { return Math.round((n ?? 0) * 100) / 100; }

/* ══════════════════════════════════════════════════════════════
   SETTINGS (key/value i settings-tabellen — ikke hardcoded, ikke .env)
   ══════════════════════════════════════════════════════════════ */

function getEconomicSettings(db = getDb()) {
    const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    const num = (v) => (v == null || v === '' ? null : Number(v));
    return {
        paymentTermsNumber:          num(get('economic_default_payment_terms_number')),
        layoutNumber:                num(get('economic_layout_number')),
        deliveryFallbackProductNumber: num(get('economic_delivery_fallback_product_number')),
        oneoffProductNumber:         num(get('economic_oneoff_product_number')),
    };
}

/* ══════════════════════════════════════════════════════════════
   KUNDE-RESOLVER + REFERENCE
   ══════════════════════════════════════════════════════════════ */

/** Erhverv → firma; ellers privat → kunde. null hvis intet er sat → blokér. */
function resolveEconomicCustomer(bon) {
    const co = bon.company?.economic_customer_id;
    if (co != null && String(co).trim() !== '') return Number(co);
    const cu = bon.customer?.economic_customer_id;
    if (cu != null && String(cu).trim() !== '') return Number(cu);
    return null;
}

/** Synlig reference på fakturaen: bon-nr (+ evt. rekvisition/PSP, se EAN). */
function buildReference(bon) {
    return [bon.bon_number, bon.requisition_ref].filter(Boolean).join(' · ');
}

function recipientName(bon) {
    if (bon.company?.name) return bon.company.name;
    const fn = bon.customer?.first_name || '';
    const ln = bon.customer?.last_name || '';
    return `${fn} ${ln}`.trim() || 'Kunde';
}

/* ══════════════════════════════════════════════════════════════
   FORHÅNDSTJEK (blokerende — recipe-nr, kunde-nr, EAN-kontakt)
   ══════════════════════════════════════════════════════════════ */

/**
 * Tjek om en (beriget) bon kan faktureres. Linjer skal være beriget med
 * economic_product_number (fra grocyAdapter.getEconomicProductMap) før dette kald.
 * @returns {{ok:boolean, missingCustomer:boolean, eanWithoutContact:boolean,
 *            missingProducts:Array<{line_id,product_name,grocy_recipe_id}>}}
 */
function checkReadiness(bon) {
    const lines = bon.lines || [];
    const missingProducts = lines
        .filter(l => !hasProductNumber(l))
        .map(l => ({ line_id: l.id, product_name: l.product_name, grocy_recipe_id: l.grocy_recipe_id }));

    const missingCustomer = resolveEconomicCustomer(bon) == null;

    // EAN-kunde (offentlig) kræver en kontaktperson på e-conomic-kunden, ellers fejler bogføring.
    const isEan = Boolean(bon.company?.ean);
    const hasContact = bon.customer?.economic_contact_id != null
        && String(bon.customer.economic_contact_id).trim() !== '';
    const eanWithoutContact = isEan && !hasContact;

    return {
        ok: missingProducts.length === 0 && !missingCustomer && !eanWithoutContact,
        missingCustomer,
        eanWithoutContact,
        missingProducts,
    };
}

function hasProductNumber(line) {
    return line.economic_product_number != null
        && String(line.economic_product_number).trim() !== '';
}

/* ══════════════════════════════════════════════════════════════
   PAYLOAD-BUILDER (ren funktion — unit-testbar uden DB/e-conomic)
   ══════════════════════════════════════════════════════════════ */

/**
 * Byg e-conomic draft-invoice-payload fra en (beriget) bon.
 * @param {object} bon       beriget bon (nested customer/company/delivery_address; lines med economic_product_number)
 * @param {object} settings  fra getEconomicSettings()
 * @param {object} opts       { invoiceDate?: 'YYYY-MM-DD' (default i dag), oneoffForMissing?: bool }
 */
function buildDraftInvoice(bon, settings, opts = {}) {
    const { todayISO } = require('../db/helpers');
    const invoiceDate = opts.invoiceDate || todayISO();
    const lineDiscount = Number(bon.offer_discount_percent) || 0;
    const oneoff = settings.oneoffProductNumber;

    const lines = (bon.lines || []).map((line, i) => {
        // productNumber SKAL være String pr. e-conomics skema (varenr kan være alfanumerisk).
        let productNumber = hasProductNumber(line) ? String(line.economic_product_number) : null;
        if (productNumber == null) {
            if (opts.oneoffForMissing && oneoff != null) {
                productNumber = String(oneoff);   // engangsvare: overskriv tekst+beløb (de er allerede på linjen)
            } else {
                throw new Error(
                    `Linje "${line.product_name}" mangler economic_product_number — kør forhåndstjek først.`
                );
            }
        }
        const lineObj = {
            lineNumber:   i + 1,
            product:      { productNumber },
            description:  line.special_request
                            ? `${line.product_name} (${line.special_request})`
                            : line.product_name,
            quantity:     line.quantity,
            unitNetPrice: round2(inclToExcl(line.unit_price)),   // EX moms, 2 decimaler
        };
        if (lineDiscount) lineObj.discountPercentage = lineDiscount;
        return lineObj;
    });

    // Leveringslinje KUN når levering ligger på bon.delivery_price uden en x-Levering-linje
    // (det nye logistik-systems linjeløse levering). x-Levering-recipes er allerede normale linjer.
    const hasDeliveryLine = (bon.lines || []).some(l => l.category === 'x-Levering');
    if (Number(bon.delivery_price) > 0 && !hasDeliveryLine) {
        const deliveryNo = bon.delivery_vehicle_economic_product_number
            || settings.deliveryFallbackProductNumber;
        const dl = {
            lineNumber:   lines.length + 1,
            product:      { productNumber: String(deliveryNo) },
            description:  bon.delivery_vehicle_label ? `Levering (${bon.delivery_vehicle_label})` : 'Levering',
            quantity:     1,
            unitNetPrice: round2(inclToExcl(bon.delivery_price)),
        };
        if (lineDiscount) dl.discountPercentage = lineDiscount;
        lines.push(dl);
    }

    const addr = bon.delivery_address;
    const contactNo = bon.customer?.economic_contact_id;

    const payload = {
        date:         invoiceDate,                 // afsendelsesdag — IKKE leveringsdato
        currency:     'DKK',
        customer:     { customerNumber: resolveEconomicCustomer(bon) },
        paymentTerms: { paymentTermsNumber: settings.paymentTermsNumber },
        layout:       { layoutNumber: settings.layoutNumber },
        recipient: {
            name:    recipientName(bon),
            vatZone: { vatZoneNumber: 1 },         // indenlandsk DK (også EAN/offentlige)
        },
        references: { other: buildReference(bon) },
        lines,
    };
    if (contactNo != null && String(contactNo).trim() !== '') {
        // Kontakten sættes BÅDE som modtager-att. og som "Deres reference"
        // (references.customerContact) — matcher RR's bogførte fakturaer 1:1.
        payload.recipient.attention = { customerContactNumber: Number(contactNo) };
        payload.references.customerContact = { customerContactNumber: Number(contactNo) };
    }
    if (addr && (addr.street_name || addr.city)) {
        payload.delivery = {
            deliveryDate: bon.delivery_date || invoiceDate,
            address:      `${addr.street_name || ''} ${addr.street_nr || ''}`.trim(),
            zip:          addr.postal_code || '',
            city:         addr.city || '',
            country:      'Danmark',
        };
    }
    return payload;
}

/* ══════════════════════════════════════════════════════════════
   E-CONOMIC-KALD (kun udkast)
   ══════════════════════════════════════════════════════════════ */

/**
 * Opret fakturaudkast i e-conomic. Forventer en beriget bon (lines med
 * economic_product_number). Kører forhåndstjek; bygger ikke payload hvis noget mangler.
 * @returns {Promise<{draftInvoiceNumber:number, raw:object}>}
 */
async function createDraftInvoice(bon, { invoiceDate, oneoffForMissing } = {}) {
    const readiness = checkReadiness(bon);
    if (!readiness.ok && !(oneoffForMissing && readiness.missingProducts.length && !readiness.missingCustomer && !readiness.eanWithoutContact)) {
        const err = new Error('Bon ikke klar til fakturering (manglende kobling).');
        err.code = 'not_ready';
        err.readiness = readiness;
        throw err;
    }
    const settings = getEconomicSettings();
    const payload = buildDraftInvoice(bon, settings, { invoiceDate, oneoffForMissing });
    // Idempotency-nøgle = bon-id + content-hash: ægte netværks-retry (samme payload)
    // dedupes; ændret indhold (redigeret bon gen-sendt inden for 1t) får en ny nøgle
    // og undgår e-conomics "PayloadChanged"-fejl. Re-send efter success forhindres
    // separat af economic_draft_number-guarden i routes.
    const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
    const res = await eco.rest('/invoices/drafts', {
        method: 'POST',
        body: payload,
        idempotencyKey: `bon-${bon.id}-${hash}`,
    });
    return { draftInvoiceNumber: res?.draftInvoiceNumber ?? null, raw: res };
}

/** Slet et fakturaudkast (til test/oprydning). */
function deleteDraftInvoice(draftInvoiceNumber) {
    return eco.rest(`/invoices/drafts/${draftInvoiceNumber}`, { method: 'DELETE' });
}

module.exports = {
    getEconomicSettings,
    resolveEconomicCustomer,
    buildReference,
    checkReadiness,
    buildDraftInvoice,
    createDraftInvoice,
    deleteDraftInvoice,
    round2,
};
