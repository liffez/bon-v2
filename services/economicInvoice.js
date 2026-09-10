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
        noninvoiceRecipes:           parseIdList(get('economic_noninvoice_recipes')),
        noDiscountCategories:        parseCategoryList(get('economic_no_discount_categories')),
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

/**
 * Kategorinavne fra Grocys `grupper` → Set af NORMALISEREDE navne.
 * Normalisering (trim, ét mellemrum, små bogstaver) er ikke pynt: kategorien
 * hedder `x- Service` med mellemrum efter bindestregen, og `x-Service` ville
 * ellers ryge lydløst forbi reglen — præcis den slags tastefejl der først opdages
 * på en faktura hos kunden.
 */
function parseCategoryList(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        return new Set((Array.isArray(arr) ? arr : [])
            .filter(v => typeof v === 'string')
            .map(normalizeCategory)
            .filter(Boolean));
    } catch {
        return new Set();
    }
}

function normalizeCategory(s) {
    return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Rabatsats for ÉN fakturalinje. Den stående kunderabat gælder varerne — ikke
 * levering og ikke gebyrer. Et gebyr er et gebyr; det rabatteres ikke.
 *
 * ÉN kilde, som alle tre linje-veje (vare, bundt, leverings-synteselinje) kalder,
 * så de ikke kan blive uenige. Netop håndkraft-synkronisering mellem parallelle
 * grene producerede #444.
 *
 * `category` er Grocys `grupper` som den står på bonlinjen. Er den tom, gælder
 * rabatten — vi udelader kun det vi positivt kan genkende, så en linje uden
 * kategori mister ikke stille en rabat kunden har krav på.
 */
function discountForLine(category, basePercent, settings = {}) {
    if (!basePercent) return 0;
    const excluded = settings.noDiscountCategories;
    if (!excluded) return basePercent;
    return excluded.has(normalizeCategory(category)) ? 0 : basePercent;
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

/**
 * Firmaets EAN, klar til e-conomic (`recipient.ean`, max 13 tegn i deres skema).
 *
 * Et EAN-nummer er 13 cifre. Skrives det med mellemrum eller bindestreger i CRM,
 * skal cifrene stadig frem. Er der noget andet end 13 cifre tilbage, er nummeret
 * ubrugeligt: e-conomic kan ikke sende fakturaen via Nemhandel, og fejlen ville
 * først vise sig ved bogføring — langt fra den der kan rette den. Derfor larmer vi
 * her frem for at sende et halvt nummer med.
 *
 * @returns {string|null} 13 cifre, eller null hvis firmaet slet ikke har et EAN.
 * @throws {Error} code 'invalid_ean' hvis der ER et EAN, men det ikke er 13 cifre.
 */
function economicEan(bon) {
    const raw = bon.company?.ean;
    if (raw == null || String(raw).trim() === '') return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length !== 13) {
        const err = new Error(
            `EAN-nummeret på ${bon.company?.name || 'firmaet'} er "${raw}" — det skal være 13 cifre. ` +
            `Ret det i firmaets stamdata; ellers kan e-conomic ikke sende fakturaen via Nemhandel.`);
        err.code = 'invalid_ean';
        throw err;
    }
    return digits;
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

const EMPTY_SET = new Set();

/** Grocy-kategorien leverings-opskrifterne bærer. Synteselinjen låner den. */
const DELIVERY_CATEGORY = 'x-Levering';

/** Linjens værdi INCL moms. `line_total` er sandheden; ellers antal × stk-pris. */
function lineAmount(line) {
    if (line.line_total != null && line.line_total !== '') return round2(Number(line.line_total));
    return round2(Number(line.quantity || 0) * Number(line.unit_price || 0));
}

/**
 * Hvad skal der ske med én bonlinje? ÉN kilde, som BÅDE checkReadiness og
 * buildDraftInvoice kører over — de to kan ikke blive uenige ved konstruktion.
 * Det var netop håndkraft-synkroniseringen mellem dem der producerede #444.
 *
 * Rækkefølgen er betydningsbærende:
 *   varenr → bundt → beløb 0 (udelad) → engangsvare → blokér
 * Udeladelsen ligger FØR engangsvaren; ellers ville en prep-linje til 0 kr blive
 * sendt til kunden som en engangsvare-linje.
 *
 * "Faktureres ikke"-listen (settings, #454) er pr. OPSKRIFT — ikke pr. kategori.
 * To kategorier er blandede: 'Tilbehør & Bokse' rummer ægte varer med omsætning, og
 * '06 Emballage' rummer både emballage og transportkasser der faktureres. 'lunch' er
 * slet ikke en kategori, men block_type lækket fra tilbudsmodulet.
 *
 * Listen kan kun ophæve en blokering — den kan ALDRIG fjerne omsætning: en linje
 * der bærer penge blokerer også når opskriften står på listen. Så er det en
 * selvmodsigelse i stamdata, og den skal ses frem for at blive skjult.
 *
 * @returns {{kind:'product'|'bundle'|'excluded'|'oneoff'|'blocked', listed:boolean,
 *            amount:number, reason?:string}}
 */
function classifyLine(line, settings = {}, opts = {}) {
    const noninvoice = settings.noninvoiceRecipes || EMPTY_SET;
    const listed = line.grocy_recipe_id != null && noninvoice.has(Number(line.grocy_recipe_id));
    const amount = lineAmount(line);

    if (hasProductNumber(line)) return { kind: 'product', listed, amount };
    if (hasBundle(line))        return { kind: 'bundle',  listed, amount };

    // Ingen varenr. En linje uden beløb kan ikke gøre fakturaen for lille — den
    // udelades, men rapporteres, så den ikke forsvinder i stilhed.
    if (amount === 0) {
        return { kind: 'excluded', listed, amount, reason: listed ? 'noninvoice' : 'zero_amount' };
    }
    // Penge uden varenr må aldrig forsvinde — heller ikke fra listen.
    if (opts.oneoffForMissing && settings.oneoffProductNumber != null) {
        return { kind: 'oneoff', listed, amount };
    }
    return { kind: 'blocked', listed, amount, reason: listed ? 'noninvoice_but_priced' : 'no_product' };
}

/** Varenr til leverings-synteselinjen — køretøjets eget, ellers fallback fra Settings. */
function deliveryProductNumber(bon, settings) {
    const no = bon.delivery_vehicle_economic_product_number ?? settings.deliveryFallbackProductNumber;
    return (no == null || String(no).trim() === '') ? null : String(no);
}

/** Har bonen en leverings-synteselinje der skal bygges? (beløb på bon, ingen x-Levering-linje) */
function needsDeliveryLine(bon) {
    const { hasDeliveryLine } = require('../db/helpers');
    return Number(bon.delivery_price) > 0 && !hasDeliveryLine(bon.lines);
}

/**
 * Tjek om en (beriget) bon kan faktureres. Linjer skal være beriget med
 * economic_product_number (fra grocyAdapter.getEconomicProductMap) før dette kald.
 *
 * Kører over de SAMMENLAGTE linjer — præcis som buildDraftInvoice — så `line_ids`
 * peger på de rækker builderen faktisk arbejder med.
 *
 * `settings` er valgfri og funktionen er bevidst ren (den åbner ALDRIG en DB —
 * unit-testene kalder den uden). Uden settings er "faktureres ikke"-listen tom,
 * så alt uden varenr blokerer: et glemt kaldested fejler synligt frem for at
 * slippe noget igennem.
 *
 * @param {object} bon       beriget bon
 * @param {object} [settings] fra getEconomicSettings()
 * @returns {{ok:boolean, missingCustomer:boolean, eanWithoutContact:boolean,
 *            missingDelivery:boolean,
 *            missingProducts:Array<{line_id,line_ids,product_name,grocy_recipe_id,amount,reason}>,
 *            excluded:Array<{line_id,line_ids,product_name,grocy_recipe_id,amount,reason}>,
 *            excluded_total:number, oneoffAvailable:boolean}}
 */
function checkReadiness(bon, settings = {}) {
    const missingProducts = [];
    const excluded = [];
    for (const l of mergeLines(bon.lines || [])) {
        const cls = classifyLine(l, settings);
        if (cls.kind !== 'blocked' && cls.kind !== 'excluded') continue;
        const entry = {
            line_id:         l.id,
            line_ids:        l.merged_line_ids || [l.id],
            product_name:    l.product_name,
            grocy_recipe_id: l.grocy_recipe_id,
            amount:          cls.amount,          // INCL moms (jf. §6b)
            reason:          cls.reason,
        };
        (cls.kind === 'blocked' ? missingProducts : excluded).push(entry);
    }
    // Beløbene er INCL moms — `line_total` er det pr. §6b. Mærkes som sådan i UI'et.
    const excludedTotal = round2(excluded.reduce((sum, e) => sum + e.amount, 0));

    const missingCustomer = resolveEconomicCustomer(bon) == null;

    // Leverings-synteselinjen bygges uden om linjerne og var derfor usynlig for
    // forhåndstjekket: uden varenr blev String(null) = "null" POST'et til e-conomic.
    const missingDelivery = needsDeliveryLine(bon) && deliveryProductNumber(bon, settings) == null;

    // EAN-kunde (offentlig) kræver en kontaktperson på e-conomic-kunden, ellers fejler bogføring.
    const isEan = Boolean(bon.company?.ean);
    const hasContact = bon.customer?.economic_contact_id != null
        && String(bon.customer.economic_contact_id).trim() !== '';
    const eanWithoutContact = isEan && !hasContact;

    return {
        // `excluded` gør IKKE bonen ikke-klar — det er en oplysning, ikke en mangel.
        ok: missingProducts.length === 0 && !missingCustomer && !eanWithoutContact && !missingDelivery,
        missingCustomer,
        eanWithoutContact,
        missingDelivery,
        missingProducts,
        excluded,
        excluded_total: excludedTotal,
        // Findes engangsvaren? Uden den kan UI'et ikke tilbyde nødudgangen — og
        // en knap der altid fejler er værre end ingen knap.
        oneoffAvailable: settings.oneoffProductNumber != null,
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

    // At bede om en redning der ikke findes må ikke være en stille no-op (#444):
    // uden engangsnummer faldt koden tilbage til at droppe linjen uden en lyd.
    if (opts.oneoffForMissing && oneoff == null) {
        const err = new Error('Engangsvare-redning er valgt, men engangsvarens varenr (economic_oneoff_product_number) er ikke sat.');
        err.code = 'oneoff_unavailable';
        throw err;
    }

    const lines = [];
    let ln = 0;
    // Ens bon-linjer slås sammen, så kunden ser "3 × Kartoflen slider" og ikke
    // tre fakturalinjer à 1 stk — se shared/bon_lines.js.
    for (const line of mergeLines(bon.lines || [])) {
        const cls = classifyLine(line, settings, opts);

        // Bevidst udeladt (på "faktureres ikke"-listen, eller uden beløb). Ikke stille:
        // checkReadiness rapporterer den i `excluded`, og fakturerings-skærmen viser den.
        if (cls.kind === 'excluded') continue;

        // Værn BAG checkReadiness (#444). Nås kun hvis nogen bygger uden om
        // forhåndstjekket — så skal det larme, ikke give en for lille faktura.
        if (cls.kind === 'blocked') {
            const err = new Error(
                `Linjen "${line.product_name}" (recipe ${line.grocy_recipe_id ?? '—'}, ${cls.amount} kr incl moms) `
                + 'har intet e-conomic varenr og kan ikke faktureres.'
                + (cls.reason === 'noninvoice_but_priced'
                    ? ' Opskriften står på "faktureres ikke"-listen, men linjen har en pris — ret det ene af de to.'
                    : ''));
            err.code = 'line_without_product';
            err.line = {
                line_id: line.id, line_ids: line.merged_line_ids || [line.id],
                product_name: line.product_name, grocy_recipe_id: line.grocy_recipe_id,
                amount: cls.amount, reason: cls.reason,
            };
            throw err;
        }

        // Bundt (slider-boks) → én fakturalinje pr. vare i boksen.
        // Prisen fordeles fra BONENS linjepris, ikke fra delenes listepriser: boksen
        // er solgt til en aftalt pris (boks 78 koster 160 kr, delene står til 176),
        // og fakturasummen skal være præcis den samme som uden udfoldning.
        if (cls.kind === 'bundle') {
            const parts   = line.economic_bundle;
            const partDiscount = discountForLine(line.category, lineDiscount, settings);
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
                if (partDiscount) partObj.discountPercentage = partDiscount;
                lines.push(partObj);
            });
            continue;
        }

        // productNumber SKAL være String pr. e-conomics skema (varenr kan være alfanumerisk).
        // 'oneoff' = engangsvaren redder en prissat linje uden varenr; tekst og beløb
        // ligger allerede på linjen.
        const productNumber = cls.kind === 'oneoff'
            ? String(oneoff)
            : String(line.economic_product_number);
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
        const pct = discountForLine(line.category, lineDiscount, settings);
        if (pct) lineObj.discountPercentage = pct;
        lines.push(lineObj);
    }

    // Leveringslinje KUN når levering ligger på bon.delivery_price uden en x-Levering-linje
    // (det nye logistik-systems linjeløse levering). x-Levering-recipes er allerede normale linjer.
    // Delt regel — et standardgebyr i x-Levering (fx miljøbidraget) er ikke en
    // levering og må ikke undertrykke synteselinjen (se db/helpers.js).
    if (needsDeliveryLine(bon)) {
        // Uden varenr blev String(null) til strengen "null" og POST'et til e-conomic.
        // Samme fejlklasse som #444: en linje der ikke kan bygges, skal larme.
        const deliveryNo = deliveryProductNumber(bon, settings);
        if (deliveryNo == null) {
            const err = new Error('Leveringen har hverken et e-conomic varenr på køretøjet eller en fallback i Settings (economic_delivery_fallback_product_number).');
            err.code = 'delivery_without_product';
            throw err;
        }
        const dl = {
            lineNumber:   ++ln,
            product:      { productNumber: deliveryNo },
            description:  bon.delivery_vehicle_label ? `Levering (${bon.delivery_vehicle_label})` : 'Levering',
            quantity:     1,
            unitNetPrice: round2(inclToExcl(bon.delivery_price)),
        };
        // Synteselinjen har ingen bonlinje at hente kategori fra, men den ER en
        // levering — så den følger x-Levering-reglen. Fjernes kategorien fra
        // listen, får leveringen rabat igen, og de to veje bliver ikke uenige.
        const delPct = discountForLine(DELIVERY_CATEGORY, lineDiscount, settings);
        if (delPct) dl.discountPercentage = delPct;
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
    // Fakturaadresse + EAN på modtageren. e-conomic kopierer IKKE fra kundekortet:
    // sender vi kun recipient.name, står fakturaen uden adresse og uden EAN, og en
    // offentlig kunde kan slet ikke modtage den. `delivery` nedenfor er noget andet
    // — dét er hvor maden kørte hen.
    const billTo = bon.company?.address;
    if (billTo && (billTo.street_name || billTo.city)) {
        payload.recipient.address = `${billTo.street_name || ''} ${billTo.street_nr || ''}`.trim();
        payload.recipient.zip     = billTo.postal_code || '';
        payload.recipient.city    = billTo.city || '';
        payload.recipient.country = 'Danmark';
    }
    const ean = economicEan(bon);
    if (ean) payload.recipient.ean = ean;

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
 * Hører kontakten til den kunde fakturaen udstedes til?
 *
 * e-conomic afviser HELE kladden med E04800 ("Mismatching customer number for
 * invoice and customer contact") hvis ikke. Intet i forhåndstjekket kunne fange
 * det, fordi `customers.economic_contact_id` er et bart kontaktnummer uden nogen
 * registrering af hvilken kunde det ligger under — mens fakturakunden kan være
 * firmaet (se resolveEconomicCustomer). En person der har fået sin kontakt
 * oprettet under ét kundenummer og siden optræder på en bon der faktureres til et
 * andet (firma-kobling tilføjet bagefter, ny arbejdsplads, samme person brugt på
 * flere firmaers bons) rammer den hver eneste gang.
 *
 * FAIL-OPEN: kun et definitivt 404 er et nej. Netværksfejl, 500, rate limit → vi
 * ved det ikke, og vores egen vagt må ikke blokere en faktura på et gæt; det
 * rigtige kald bagefter afgør sagen alligevel.
 *
 * @returns {Promise<boolean>} false KUN når kontakten beviseligt ikke findes der.
 */
async function contactBelongsToCustomer(customerNumber, contactNumber) {
    try {
        await eco.rest(`/customers/${customerNumber}/contacts/${contactNumber}`);
        return true;
    } catch (err) {
        return err.status !== 404;
    }
}

/**
 * Opret fakturaudkast i e-conomic. Forventer en beriget bon (lines med
 * economic_product_number). Kører forhåndstjek; bygger ikke payload hvis noget mangler.
 * @param {object} opts  { invoiceDate?, oneoffForMissing?, dryRun? }
 *   dryRun: byg payloaden og kør alle vagter, men ring ikke til e-conomic og opret intet.
 * @returns {Promise<{draftInvoiceNumber:number|null, raw?:object, payload:object,
 *                    idempotencyKey:string, dryRun?:true}>}
 */
async function createDraftInvoice(bon, { invoiceDate, oneoffForMissing, dryRun } = {}) {
    // Settings hentes FØR forhåndstjekket, så route og service klassificerer på
    // nøjagtig samme grundlag — ellers kan de to blive uenige om hvad der udelades.
    const settings = getEconomicSettings();
    const readiness = checkReadiness(bon, settings);
    if (!readiness.ok && !(oneoffForMissing && readiness.missingProducts.length && !readiness.missingCustomer && !readiness.eanWithoutContact && !readiness.missingDelivery)) {
        const err = new Error('Bon ikke klar til fakturering (manglende kobling).');
        err.code = 'not_ready';
        err.readiness = readiness;
        throw err;
    }
    const payload = buildDraftInvoice(bon, settings, { invoiceDate, oneoffForMissing });

    // Kontakt-vagt: e-conomic afviser hele kladden hvis kontakten ligger under en
    // anden kunde end fakturaens. Tjekket kører også i prøvekørslen — en generalprøve
    // der ikke fanger den fejl beviser intet. Det er ét opslag; der skrives intet.
    const draftContactNo = payload.references?.customerContact?.customerContactNumber;
    if (draftContactNo != null) {
        const draftCustomerNo = payload.customer.customerNumber;
        if (!(await contactBelongsToCustomer(draftCustomerNo, draftContactNo))) {
            const err = new Error(
                `Kontaktpersonen (e-conomic kontakt ${draftContactNo}) hører ikke til kunde ` +
                `${draftCustomerNo}, som fakturaen udstedes til. e-conomic afviser hele ` +
                `fakturaen. Ryd eller ret kontakt-nummeret på kunden — "Foreslå kunde/kontakt" ` +
                `viser de kontakter der faktisk ligger under kunde ${draftCustomerNo}.`);
            err.code = 'contact_customer_mismatch';
            err.contactNumber = draftContactNo;
            err.customerNumber = draftCustomerNo;
            throw err;
        }
    }
    // Idempotency-nøgle = bon-id + content-hash: ægte netværks-retry (samme payload)
    // dedupes; ændret indhold (redigeret bon gen-sendt inden for 1t) får en ny nøgle
    // og undgår e-conomics "PayloadChanged"-fejl. Re-send efter success forhindres
    // separat af economic_draft_number-guarden i routes.
    const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
    const idempotencyKey = `bon-${bon.id}-${hash}`;

    // Prøvekørsel: stopper på SIDSTE trin, efter at alle vagter og hele payloaden er
    // bygget af samme kode som en rigtig afsendelse. En generalprøve der følger sin
    // egen sti beviser ingenting — derfor er dette ét `return`, ikke en parallel gren.
    if (dryRun) return { dryRun: true, draftInvoiceNumber: null, payload, idempotencyKey, readiness };

    const res = await eco.rest('/invoices/drafts', {
        method: 'POST',
        body: payload,
        idempotencyKey,
    });
    return { draftInvoiceNumber: res?.draftInvoiceNumber ?? null, raw: res, payload, idempotencyKey };
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
    classifyLine,
    lineAmount,
    hasBundle,
    isAmountLine,
    parseIdList,
    parseCategoryList,
    normalizeCategory,
    discountForLine,
    splitOre,
    buildDraftInvoice,
    contactBelongsToCustomer,
    economicEan,
    createDraftInvoice,
    deleteDraftInvoice,
    round2,
};
