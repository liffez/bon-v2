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
const { mergeLines } = require('../shared/bon_lines');
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
        amountLineRecipes:           parseIdList(get('economic_amount_line_recipes')),
    };
}

/** JSON-array af recipe-id → Set. Ugyldig/tom værdi må ikke vælte en fakturering. */
function parseIdList(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        // Kun positive heltal — ellers bliver null til recipe-id 0 (Number(null) === 0).
        return new Set((Array.isArray(arr) ? arr : []).map(Number).filter(n => Number.isInteger(n) && n > 0));
    } catch {
        return new Set();
    }
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

// Kategorier der IKKE faktureres: en linje uden varenr i disse udelades stille
// (ikke på fakturaen, ikke blokerende). Pt. faktureres KUN transportkasser blandt
// emballage (de HAR varenr 56/58); andre bokse + prep skal ikke med.
// En mad-/levering-/service-linje uden varenr blokerer stadig (ægte gap).
const NONINVOICE_CATEGORIES = new Set([
    '06 Emballage', 'Tilbehør & Bokse', 'RR Produktion', 'RR produktion Hurtig', 'lunch',
]);
function isNoninvoice(line) { return NONINVOICE_CATEGORIES.has(line.category); }

/**
 * Tjek om en (beriget) bon kan faktureres. Linjer skal være beriget med
 * economic_product_number (fra grocyAdapter.getEconomicProductMap) før dette kald.
 * @returns {{ok:boolean, missingCustomer:boolean, eanWithoutContact:boolean,
 *            missingProducts:Array<{line_id,product_name,grocy_recipe_id}>}}
 */
function checkReadiness(bon) {
    const lines = bon.lines || [];
    // Kun fakturérbare linjer uden varenr blokerer. Bokse/prep uden varenr udelades stille.
    // En bundt-linje (slider-boks) er dækket af sit indhold og blokerer ikke.
    const missingProducts = lines
        .filter(l => !hasProductNumber(l) && !hasBundle(l) && !isNoninvoice(l))
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

/**
 * Beløbslinje: kronerne står i quantity, prisen er ±1 (Rabat, Engangsbeløb).
 * Hvilke opskrifter det gælder står i settings — vi gætter ikke ud fra pris eller
 * kategori, for en ægte vare til 1 kr ville også ramme sådan et gæt.
 */
function isAmountLine(line, amountRecipes) {
    return line.grocy_recipe_id != null && amountRecipes.has(Number(line.grocy_recipe_id));
}

/** Bundt-linje: én bonlinje (slider-boks) der skal blive til flere fakturalinjer. */
function hasBundle(line) {
    return Array.isArray(line.economic_bundle) && line.economic_bundle.length > 0;
}

/**
 * Fordel et ørebeløb på flere dele efter vægt. Største rest får de overskydende
 * ører, så summen er PRÆCIS det man startede med — en faktura må ikke ændre sig
 * en øre af at en boks blev foldet ud. Negative beløb fordeles med samme regel.
 */
function splitOre(totalOre, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return weights.map(() => 0);
    const sign = totalOre < 0 ? -1 : 1;
    const abs = Math.abs(Math.round(totalOre));
    const exact = weights.map(w => (abs * w) / sum);
    const parts = exact.map(Math.floor);
    let rest = abs - parts.reduce((a, b) => a + b, 0);
    const order = exact
        .map((v, i) => ({ i, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; rest > 0; k++, rest--) parts[order[k % order.length].i] += 1;
    return parts.map(v => v * sign);
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
    const amountRecipes = settings.amountLineRecipes || new Set();

    const lines = [];
    let ln = 0;
    // Ens bon-linjer slås sammen, så kunden ser "3 × Kartoflen slider" og ikke
    // tre fakturalinjer à 1 stk — se shared/bon_lines.js.
    for (const line of mergeLines(bon.lines || [])) {
        // Bundt (slider-boks) → én fakturalinje pr. vare i boksen.
        // Prisen fordeles fra BONENS linjepris, ikke fra delenes listepriser: boksen
        // er solgt til en aftalt pris (boks 78 koster 160 kr, delene står til 176),
        // og fakturasummen skal være præcis den samme som uden udfoldning.
        if (!hasProductNumber(line) && hasBundle(line)) {
            const parts   = line.economic_bundle;
            const boxOre  = Math.round(round2(inclToExcl(line.unit_price)) * 100);
            const shares  = splitOre(boxOre, parts.map(p => p.servings));
            // e-conomic vil have prisen PR. ENHED, så andelen deles med servings og
            // rundes til øre. Med servings > 1 kan den runding flytte totalen et par
            // ører — de lægges tilbage på den linje hvor det går præcist op (færrest
            // enheder pr. boks). I dag har alle bokse servings = 1, så det er en vagt.
            const unitOre = parts.map((p, i) => Math.round(shares[i] / p.servings));
            const drift   = boxOre - unitOre.reduce((s, v, i) => s + v * parts[i].servings, 0);
            if (drift !== 0) {
                let fix = -1;
                for (let i = 0; i < parts.length; i++) {
                    if (drift % parts[i].servings !== 0) continue;
                    if (fix < 0 || parts[i].servings < parts[fix].servings) fix = i;
                }
                if (fix >= 0) unitOre[fix] += drift / parts[fix].servings;
            }
            parts.forEach((p, i) => {
                const partObj = {
                    lineNumber:   ++ln,
                    product:      { productNumber: String(p.product_number) },
                    // Kun varens eget navn — boksens navn ("Alm slider Boks - fisken,
                    // Frikadellen, kartoflen") ville støje på hver eneste linje.
                    description:  line.special_request ? `${p.name} (${line.special_request})` : p.name,
                    quantity:     line.quantity * p.servings,
                    unitNetPrice: unitOre[i] / 100,
                };
                if (lineDiscount) partObj.discountPercentage = lineDiscount;
                lines.push(partObj);
            });
            continue;
        }

        // productNumber SKAL være String pr. e-conomics skema (varenr kan være alfanumerisk).
        let productNumber = hasProductNumber(line) ? String(line.economic_product_number) : null;
        if (productNumber == null) {
            if (opts.oneoffForMissing && oneoff != null) {
                productNumber = String(oneoff);   // engangsvare: overskriv tekst+beløb (de er allerede på linjen)
            } else {
                // Ingen varenr → faktureres ikke (fx anden boks). checkReadiness har
                // allerede blokeret, hvis det var en fakturérbar linje. Udelad stille.
                continue;
            }
        }
        // Beløbslinje (Rabat / Engangsbeløb): kronerne står i quantity og prisen er
        // ±1, så "11.600 stk à -0,80" ville stå på kundens faktura. Foldes sammen
        // til antal 1 med linjesummen som pris — samme beløb, læsbar linje.
        // Ingen discountPercentage: en rabat skal ikke rabatteres igen.
        if (isAmountLine(line, amountRecipes)) {
            const totalIncl = line.line_total != null
                ? Number(line.line_total)
                : Number(line.quantity || 0) * Number(line.unit_price || 0);
            lines.push({
                lineNumber:   ++ln,
                product:      { productNumber },
                // special_request bærer forklaringen ("bil", "løn", "Prisjustering")
                // og er mere sigende end opskriftsnavnet.
                description:  String(line.special_request || '').trim() || line.product_name,
                quantity:     1,
                unitNetPrice: round2(inclToExcl(totalIncl)),
            });
            continue;
        }

        const lineObj = {
            lineNumber:   ++ln,
            product:      { productNumber },
            description:  line.special_request
                            ? `${line.product_name} (${line.special_request})`
                            : line.product_name,
            quantity:     line.quantity,
            unitNetPrice: round2(inclToExcl(line.unit_price)),   // EX moms, 2 decimaler
        };
        if (lineDiscount) lineObj.discountPercentage = lineDiscount;
        lines.push(lineObj);
    }

    // Leveringslinje KUN når levering ligger på bon.delivery_price uden en x-Levering-linje
    // (det nye logistik-systems linjeløse levering). x-Levering-recipes er allerede normale linjer.
    // Delt regel — et standardgebyr i x-Levering (fx miljøbidraget) er ikke en
    // levering og må ikke undertrykke synteselinjen (se db/helpers.js).
    const deliveryOnBon = require('../db/helpers').hasDeliveryLine(bon.lines);
    if (Number(bon.delivery_price) > 0 && !deliveryOnBon) {
        const deliveryNo = bon.delivery_vehicle_economic_product_number
            || settings.deliveryFallbackProductNumber;
        const dl = {
            lineNumber:   ++ln,
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
        // Bon-nummeret i overskriften ("#B4111") — RR's konvention, og match-nøglen
        // for cashflow-afstemningen (services/cashflowReconcile.js parser den).
        ...(bon.bon_number ? { notes: { heading: `#${bon.bon_number}` } } : {}),
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
    hasBundle,
    isAmountLine,
    parseIdList,
    splitOre,
    buildDraftInvoice,
    createDraftInvoice,
    deleteDraftInvoice,
    round2,
};
