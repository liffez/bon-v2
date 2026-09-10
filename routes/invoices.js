/**
 * routes/invoices.js
 * GET /api/invoices/queue — fakturerings-arbejdsliste
 *
 * MOMS-HÅNDTERING (når faktura-generering bygges):
 * - bon_lines.unit_price er INCL. moms (jf. BON_V2_PRINCIPPER.md sektion 6b)
 * - bon_lines.cost_price er EX moms
 * - bons.total_price er INCL. moms
 *
 * Faktura skal udstille linje-priser EX MOMS + separat moms-beløb (e-conomic-konvention):
 *   const { inclToExcl } = require('../db/helpers');
 *   const unit_price_excl = inclToExcl(line.unit_price);
 *   const line_total_excl = inclToExcl(line.line_total);
 *   const moms_amount     = line.line_total - line_total_excl;
 *
 * Visnings-disciplin (sektion 6c):
 * - Faktura-PDF/print: hver pris-linje har eksplicit basis-label
 * - Eksempel: "Subtotal (ex moms): X kr" + "Moms (25%): Y kr" + "Total (incl moms): Z kr"
 *
 * Se også: docs/CLAUDE_TILBUD_PRIS.md (samme moms-mønster bruges i tilbud)
 *          tests/moms_audit_e2e.test.js (verifikations-suite, T-5 case)
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, todayISO, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { requireAuth } = require('../shared/auth');
const grocyAdapter = require('../services/grocyAdapter');
const eco = require('../services/economicAdapter');
const economicInvoice = require('../services/economicInvoice');
const autoFees = require('../services/autoFees');

// ─── GET /api/invoices/queue ────────────────────────────────────────────────
router.get('/queue', handle((req, res) => {
    const db = getDb();
    const includeDone = req.query.include_done === '1';
    const doneLimit   = Math.min(parseInt(req.query.limit) || 20, 100);
    const today = todayISO();

    // Pending: LEVERET + payment_type = 'invoice'
    const pending = db.prepare(`
        SELECT
            b.id,
            b.bon_number,
            b.delivery_date,
            b.pickup_time,
            b.delivery_time,
            b.pax,
            b.total_units,
            b.customer_wishes  AS customer_note,
            b.invoice_info     AS invoice_note,
            b.internal_notes   AS internal_note,
            b.kitchen_info     AS kitchen_note,
            b.delivery_method,
            b.courier_arrival_time,
            b.day_contact_name,
            b.day_contact_phone,
            b.payment_type,
            b.delivery_price,
            b.delivery_cost,
            b.economic_draft_number,
            b.economic_draft_at,
            -- Stående/tilbuds-rabat (migration 111) og slutkunde på
            -- forhandler-ordrer (migration 167). Begge er ting fakturøren skal
            -- kunne se: rabatten forklarer hvorfor totalen er lavere end
            -- linjesummen, slutkunden hvem fakturaen dækker.
            b.offer_discount_percent,
            b.end_customer_name,
            sd.code AS status_code,
            CAST(julianday(?) - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery,
            -- Customer
            c.id            AS customer_id,
            c.first_name    AS customer_first_name,
            c.last_name     AS customer_last_name,
            c.phone         AS customer_phone,
            c.email         AS customer_email,
            c.economic_contact_id,
            c.economic_customer_id AS customer_economic_customer_id,
            -- Company
            co.id           AS company_id,
            co.name         AS company_name,
            co.legal_name   AS company_legal_name,
            co.cvr          AS company_cvr,
            co.ean          AS company_ean,
            co.invoice_method AS company_invoice_method,
            co.economic_customer_id AS company_economic_customer_id,
            -- Price category
            pc.code         AS price_category_code,
            pc.label        AS price_category_label,
            -- Address
            a.street_name   AS addr_street_name,
            a.street_nr     AS addr_street_nr,
            a.postal_code   AS addr_postal_code,
            a.city          AS addr_city
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN customers c ON c.id = b.customer_id
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        LEFT JOIN addresses a ON a.id = b.delivery_address_id
        WHERE sd.code = 'LEVERET'
          AND b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY b.delivery_date ASC
    `).all(today);

    // Lines for each pending bon
    const lineStmt = db.prepare(`
        SELECT id, product_name, quantity, unit, unit_price, line_total,
               special_request, co2e, notes, is_accessory
        FROM bon_lines WHERE bon_id = ? ORDER BY sort_order, id
    `);

    for (const bon of pending) {
        bon.lines = lineStmt.all(bon.id);
        // line_total ekskluderer accessory-lines (bestik, servietter) — matcher
        // konventionen i reports.js + dashboard.js + total_units-aggregeringer.
        // bon.lines[] beholdes komplet så frontend kan vise tilbehør separat.
        bon.line_total = bon.lines
            .filter(l => !l.is_accessory)
            .reduce((sum, l) => sum + (l.line_total || 0), 0);
    }

    // Done: FAKTURERET/AFSLUTTET (optional)
    let done = [];
    if (includeDone) {
        done = db.prepare(`
            SELECT
                b.id,
                b.bon_number,
                b.delivery_date,
                b.pax,
                sd.code AS status_code,
                c.first_name || ' ' || COALESCE(c.last_name,'') AS customer_name,
                co.name AS company_name,
                co.ean  AS company_ean,
                b.payment_type,
                (SELECT SUM(bl3.line_total) FROM bon_lines bl3
                 WHERE bl3.bon_id = b.id
                   AND (bl3.is_accessory = 0 OR bl3.is_accessory IS NULL)
                ) AS line_total,
                (SELECT MAX(ch.created_at) FROM changelog ch
                 WHERE ch.entity_type = 'bon' AND ch.entity_id = b.id
                   AND ch.action = 'status_change' AND ch.new_value = (SELECT CAST(sd2.id AS TEXT) FROM status_definitions sd2 WHERE sd2.code = 'FAKTURERET')
                ) AS faktureret_date
            FROM bons b
            JOIN status_definitions sd ON sd.id = b.status_id
            LEFT JOIN customers c ON c.id = b.customer_id
            LEFT JOIN companies co ON co.id = b.company_id
            WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
              AND b.payment_type = 'invoice'
              AND (b.is_offer = 0 OR b.is_offer IS NULL)
              AND b.delivery_date >= date(?, '-60 days')
            ORDER BY b.delivery_date DESC
            LIMIT ?
        `).all(today, doneLimit);
    }

    // Summary
    //
    // Rabatten trækkes fra her. `line_total` er varelinjernes sum FØR rabat, og
    // et KPI-tal der siger 520 kr lige ved siden af en bon der faktureres til
    // 455 kr, er ikke et afrundingsspørgsmål — det er to forskellige påstande om
    // det samme beløb.
    const invoiceableTotal = (b) =>
        (b.line_total || 0) * (1 - (Number(b.offer_discount_percent) || 0) / 100);
    const pendingAmount = pending.reduce((sum, b) => sum + invoiceableTotal(b), 0);
    const eanCount = pending.filter(b => b.company_ean).length;
    // Kladder sendt til e-conomic men endnu ikke faktureret (vises overstreget i køen).
    const draftsWaiting = pending.filter(b => b.economic_draft_number != null).length;

    // Done this month
    const monthStart = today.slice(0, 7) + '-01';
    const doneMonth = db.prepare(`
        SELECT COUNT(DISTINCT b.id) AS count,
               COALESCE(SUM(bl.line_total), 0) AS amount
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
          AND b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
          AND b.delivery_date >= ?
    `).get(monthStart);

    res.json({
        pending: pending.map(formatBon),
        done,
        summary: {
            pending_count:    pending.length,
            pending_amount:   pendingAmount,
            ean_count:        eanCount,
            drafts_waiting:   draftsWaiting,
            done_count_month: doneMonth.count,
            done_amount_month: doneMonth.amount,
        }
    });
}));

function formatBon(row) {
    return {
        id:               row.id,
        bon_number:       row.bon_number,
        delivery_date:    row.delivery_date,
        pickup_time:      row.pickup_time,
        delivery_time:    row.delivery_time,
        pax:              row.pax,
        total_units:      row.total_units,
        payment_type:     row.payment_type,
        customer_note:    row.customer_note,
        invoice_note:     row.invoice_note,
        internal_note:    row.internal_note,
        kitchen_note:     row.kitchen_note,
        status_code:      row.status_code,
        days_since_delivery: row.days_since_delivery,
        delivery_method:  row.delivery_method,
        day_contact_name: row.day_contact_name,
        day_contact_phone: row.day_contact_phone,
        price_category_code:  row.price_category_code,
        price_category_label: row.price_category_label,
        delivery_price:       row.delivery_price,
        delivery_cost:        row.delivery_cost,
        economic_draft_number: row.economic_draft_number,
        economic_draft_at:     row.economic_draft_at,
        offer_discount_percent: row.offer_discount_percent,
        end_customer_name:      row.end_customer_name,
        customer: {
            id:         row.customer_id,
            first_name: row.customer_first_name,
            last_name:  row.customer_last_name,
            phone:      row.customer_phone,
            email:      row.customer_email,
            economic_contact_id:  row.economic_contact_id,
            economic_customer_id: row.customer_economic_customer_id,
        },
        company: row.company_id ? {
            id:                   row.company_id,
            name:                 row.company_name,
            legal_name:           row.company_legal_name,
            cvr:                  row.company_cvr,
            ean:                  row.company_ean,
            invoice_method:       row.company_invoice_method,
            economic_customer_id: row.company_economic_customer_id,
        } : null,
        delivery_address: row.addr_street_name ? {
            street_name: row.addr_street_name,
            street_nr:   row.addr_street_nr,
            postal_code: row.addr_postal_code,
            city:        row.addr_city,
        } : null,
        lines:      row.lines,
        line_total: row.line_total,
    };
}

/* ══════════════════════════════════════════════════════════════════════════
   E-CONOMIC FAKTURAUDKAST (Spor 2)
   Spec: docs/economics/CLAUDE_ECONOMIC_ADAPTER.md + CLAUDE_ECONOMIC_PLAN.md
   ══════════════════════════════════════════════════════════════════════════ */

// Hent én bon i den form economicInvoice.js forventer (nested customer/company/
// delivery_address; lines med grocy_recipe_id + category). Beriger derefter hver
// linje med economic_product_number fra Grocy-recipe-mappen, og bonen med
// køretøjets varenr/label (til det nye logistik-systems linjeløse delivery_price).
const ECO_BON_SQL = `
    SELECT
        b.id, b.bon_number, b.delivery_date, b.delivery_price,
        b.offer_discount_percent, b.delivery_vehicle_id,
        b.economic_draft_number, b.economic_draft_at,
        -- Til standardgebyrer (services/autoFees.js): betingelsen + faktura-filtrene.
        b.pax, b.payment_type, b.is_offer, b.is_internal,
        pc.code AS price_category_code,
        c.id AS customer_id, c.first_name AS customer_first_name,
        c.last_name AS customer_last_name,
        c.economic_contact_id, c.economic_customer_id AS customer_economic_customer_id,
        co.id AS company_id, co.name AS company_name, co.ean AS company_ean,
        co.economic_customer_id AS company_economic_customer_id,
        -- Firmaets EGEN adresse (companies.address_id) = fakturaadressen. Den er en
        -- anden end bonens leveringsadresse: vi leverer på et sted og fakturerer til
        -- hovedkontoret. Begge skal med på fakturaen, hver sit sted.
        ca.street_name AS co_street_name, ca.street_nr AS co_street_nr,
        ca.postal_code AS co_postal_code, ca.city AS co_city,
        a.street_name AS addr_street_name, a.street_nr AS addr_street_nr,
        a.postal_code AS addr_postal_code, a.city AS addr_city,
        dv.label AS delivery_vehicle_label,
        dv.economic_product_number AS delivery_vehicle_economic_product_number
    FROM bons b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN companies co ON co.id = b.company_id
    LEFT JOIN addresses ca ON ca.id = co.address_id
    LEFT JOIN addresses a ON a.id = b.delivery_address_id
    LEFT JOIN delivery_vehicles dv ON dv.id = b.delivery_vehicle_id
    LEFT JOIN price_categories pc ON pc.id = b.price_category_id
    WHERE b.id = ?
`;

/**
 * @param {object} opts
 *   lookupBillingAddress: slå firmaets adresse op i e-conomic hvis den mangler i CRM.
 *     Koster ét API-kald, så den er OPT-IN: kø-tjekket (/economic-readiness) kører
 *     denne funktion for HVER bon ved hver sideindlæsning, og må ikke lave N kald.
 *     Forhåndsvisning og afsendelse slår op; kø-tjekket gør ikke.
 */
async function enrichBonForEconomic(db, bonId, opts = {}) {
    const row = db.prepare(ECO_BON_SQL).get(bonId);
    if (!row) return null;

    const lines = db.prepare(`
        SELECT id, product_name, quantity, unit, unit_price, line_total,
               special_request, category, grocy_recipe_id, is_accessory, sort_order
        FROM bon_lines WHERE bon_id = ? ORDER BY sort_order, id
    `).all(bonId);

    // Berig linjer med economic_product_number fra Grocy (recipe_id → varenr).
    // Linjer uden eget varenr kan være et "bundt" (slider-boks) — så bærer de i
    // stedet indholdet, som buildDraftInvoice folder ud til én linje pr. vare.
    const [productMap, bundleMap] = await Promise.all([
        grocyAdapter.getEconomicProductMap(),
        grocyAdapter.getEconomicBundleMap(),
    ]);
    for (const l of lines) {
        const rid = l.grocy_recipe_id != null ? Number(l.grocy_recipe_id) : null;
        l.economic_product_number = rid != null ? (productMap.get(rid) ?? null) : null;
        l.economic_bundle = (l.economic_product_number == null && rid != null)
            ? (bundleMap.get(rid) ?? null)
            : null;
    }

    const bon = {
        id:                     row.id,
        bon_number:             row.bon_number,
        delivery_date:          row.delivery_date,
        delivery_price:         row.delivery_price,
        offer_discount_percent: row.offer_discount_percent,
        delivery_vehicle_label: row.delivery_vehicle_label,
        delivery_vehicle_economic_product_number: row.delivery_vehicle_economic_product_number,
        economic_draft_number:  row.economic_draft_number,
        economic_draft_at:      row.economic_draft_at,
        // Standardgebyrer (services/autoFees.js) skal kunne se betingelsen + at
        // bonen overhovedet er en faktura. Uden dem er computeFees blind og
        // returnerer stille en tom liste.
        pax:                    row.pax,
        payment_type:           row.payment_type,
        is_offer:               row.is_offer,
        is_internal:            row.is_internal,
        price_category_code:    row.price_category_code,
        customer: {
            id:                   row.customer_id,
            first_name:           row.customer_first_name,
            last_name:            row.customer_last_name,
            economic_contact_id:  row.economic_contact_id,
            economic_customer_id: row.customer_economic_customer_id,
        },
        company: row.company_id ? {
            id:                   row.company_id,
            name:                 row.company_name,
            ean:                  row.company_ean,
            economic_customer_id: row.company_economic_customer_id,
            // Fakturaadressen — adskilt fra delivery_address nedenfor. Én form
            // (`line/zip/city/country`), så builderen ikke skal vide hvor den kom fra.
            billing_address: row.co_street_name || row.co_city ? {
                line:    `${row.co_street_name || ''} ${row.co_street_nr || ''}`.trim(),
                zip:     row.co_postal_code || '',
                city:    row.co_city || '',
                country: 'Danmark',
                source:  'crm',
            } : null,
        } : null,
        delivery_address: row.addr_street_name ? {
            street_name: row.addr_street_name,
            street_nr:   row.addr_street_nr,
            postal_code: row.addr_postal_code,
            city:        row.addr_city,
        } : null,
        lines,
    };

    // Adressen står allerede på kundekortet i e-conomic — de her kunder har fået
    // fakturaer i årevis. Det er kun CRM der ikke kender den. Hellere hente den
    // end sende en faktura uden afsenderadresse, og hellere det end at kræve at
    // nogen taster den ind et sted den allerede findes.
    // FAIL-OPEN: kan vi ikke hente den, sendes fakturaen som hidtil.
    if (opts.lookupBillingAddress && bon.company && !bon.company.billing_address
        && bon.company.economic_customer_id && eco.isConfigured()) {
        try {
            const kunde = await eco.rest(`/customers/${bon.company.economic_customer_id}`);
            if (kunde && (kunde.address || kunde.city)) {
                bon.company.billing_address = {
                    line:    kunde.address || '',
                    zip:     kunde.zip     || '',
                    city:    kunde.city    || '',
                    country: kunde.country || 'Danmark',
                    source:  'economic',
                };
            }
        } catch (e) { /* fail-open — adressen er en forbedring, ikke et krav */ }
    }

    return bon;
}

// ─── GET /api/invoices/economic-readiness ───────────────────────────────────
// Pre-flight: hvilke kø-bons (LEVERET + invoice, ikke allerede sendt) ville blive
// blokeret + hvorfor. + tæller på kladder der venter på bogføring i e-conomic.
// Statisk path — registreret FØR /:bonId/* så der ikke er rute-sammenstød.
router.get('/economic-readiness', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const queue = db.prepare(`
        SELECT b.id
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        WHERE sd.code = 'LEVERET'
          AND b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND b.economic_draft_number IS NULL
        ORDER BY b.delivery_date ASC
    `).all();

    // Settings hentes én gang — ikke pr. bon; ellers er det N SELECT'er pr. sideindlæsning.
    const settings = economicInvoice.getEconomicSettings(db);
    const blocked = [];
    let excludedBons = 0, excludedTotal = 0;
    for (const { id } of queue) {
        const bon = await enrichBonForEconomic(db, id);
        if (!bon) continue;
        const r = economicInvoice.checkReadiness(bon, settings);
        // Udeladte linjer gør ikke bonen blokeret, men de skal kunne tælles op:
        // "hvad kommer der IKKE med på fakturaerne i køen".
        if (r.excluded.length) { excludedBons++; excludedTotal += r.excluded_total; }
        if (!r.ok) {
            blocked.push({
                bon_id:            bon.id,
                bon_number:        bon.bon_number,
                recipient_name:    bon.company?.name
                                     || `${bon.customer?.first_name || ''} ${bon.customer?.last_name || ''}`.trim(),
                missing_customer:  r.missingCustomer,
                ean_without_contact: r.eanWithoutContact,
                missing_delivery:  r.missingDelivery,
                missing_products:  r.missingProducts,
                excluded:          r.excluded,
                excluded_total:    r.excluded_total,
            });
        }
    }

    // Kladder der venter på menneske-bogføring i e-conomic.
    const draftsWaiting = db.prepare(`
        SELECT COUNT(*) AS n FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        WHERE b.economic_draft_number IS NOT NULL
          AND sd.code = 'LEVERET'
    `).get().n;

    res.json({
        queue_count:    queue.length,
        blocked_count:  blocked.length,
        ready_count:    queue.length - blocked.length,
        drafts_waiting: draftsWaiting,
        excluded_bons:  excludedBons,
        excluded_total: Math.round(excludedTotal * 100) / 100,   // INCL moms (§6b)
        blocked,
    });
}));

// ─── GET /api/invoices/:bonId/economic-preview ──────────────────────────────
// Dry-run: byg payloaden uden at sende til e-conomic. Ingen side-effekter, ingen
// tokens nødvendige — viser præcis hvad der ville blive POST'et + hvad der mangler.
router.get('/:bonId/economic-preview', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const bon = await enrichBonForEconomic(db, parseInt(req.params.bonId, 10), { lookupBillingAddress: true });
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const settings = economicInvoice.getEconomicSettings(db);
    const readiness = economicInvoice.checkReadiness(bon, settings);

    // Hvilke standardgebyrer mangler bonen? Preview'et skriver ikke (det er en
    // GET) — det viser bare hvad kladde-trykket vil lægge på, så gebyret ikke
    // dukker op som en overraskelse på kundens faktura.
    const pendingFees = await previewPendingFees(db, bon);

    let payload = null;
    let buildError = null;
    if (readiness.ok) {
        try {
            payload = economicInvoice.buildDraftInvoice(bon, settings);
        } catch (e) {
            buildError = e.message;
        }
    }

    res.json({
        bon_id:                bon.id,
        bon_number:            bon.bon_number,
        already_sent:          bon.economic_draft_number != null,
        economic_draft_number: bon.economic_draft_number,
        readiness,
        settings_ok:           settings.paymentTermsNumber != null && settings.layoutNumber != null,
        payload,
        build_error:           buildError,
        pending_fees:          pendingFees.fees,
        skipped_fees:          pendingFees.skipped,
    });
}));

/**
 * Gebyrer bonen mangler — ren læsning til preview'et. Grocy nede ⇒ tom liste,
 * ikke en fejl: previewet skal stadig kunne vises.
 */
async function previewPendingFees(db, bon) {
    try {
        const rules = autoFees.getFeeRules(db);
        if (!rules.some(r => r.active)) return { fees: [], skipped: [] };
        const recipes = new Map(
            (await grocyAdapter.getRecipes()).map(r => [Number(r.id), r])
        );
        const present = new Set(
            (bon.lines || []).filter(l => l.grocy_recipe_id != null).map(l => Number(l.grocy_recipe_id))
        );
        return autoFees.computeFees(bon, rules, recipes, present);
    } catch (err) {
        console.error('[autoFees] preview:', err.message);
        return { fees: [], skipped: [] };
    }
}

// ─── GET /api/invoices/:bonId/economic-customer-suggest ─────────────────────
// Når en bon blokerer på manglende kunde: slå firmaet op i e-conomic (CVR→EAN→navn)
// + hent dets kontakter og match bonens person mod dem. Kobling sker via de
// eksisterende PATCH /companies|customers/:id/economic. KUN læsning her.
const _digits = (s) => String(s || '').replace(/\D/g, '');
function _nameScore(a, b) {
    a = String(a || '').toLowerCase().replace(/[^a-zæøå0-9 ]/gi, '').trim();
    b = String(b || '').toLowerCase().replace(/[^a-zæøå0-9 ]/gi, '').trim();
    if (!a || !b) return 0; if (a === b) return 1;
    const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1); return m; };
    const A = bg(a), B = bg(b); let i = 0, sa = 0, sb = 0;
    for (const v of A.values()) sa += v;
    for (const [g, v] of B) { sb += v; if (A.has(g)) i += Math.min(v, A.get(g)); }
    return sa + sb ? 2 * i / (sa + sb) : 0;
}
// Kontakt-navne er ofte kun fornavn ("Sigurd") mod bonens fulde navn ("Sigurd Testesen").
// Prefix/fornavns-match vægtes derfor højere end ren bigram.
function _contactScore(personName, contactName) {
    const np = String(personName || '').toLowerCase().trim();
    const nc = String(contactName || '').toLowerCase().trim();
    if (!np || !nc) return 0;
    if (np === nc) return 1;
    if (np.startsWith(nc) || nc.startsWith(np)) return 0.9;       // Sigurd ⊂ Sigurd Testesen
    const pt = np.split(/\s+/)[0], ct = nc.split(/\s+/)[0];
    if (pt && pt === ct && pt.length >= 3) return 0.8;            // samme fornavn
    return _nameScore(personName, contactName);
}

async function _searchEconomicCustomers({ cvr, ean, name }) {
    const enc = encodeURIComponent;
    const out = [], seen = new Set();
    const add = (arr, match) => { for (const k of (arr || [])) { const n = String(k.customerNumber); if (!seen.has(n)) { seen.add(n); out.push({ number: n, name: k.name || '', cvr: k.corporateIdentificationNumber || '', ean: k.ean || '', match }); } } };
    const d = _digits(cvr);
    if (d) { const r = await eco.rest('/customers?filter=' + enc('corporateIdentificationNumber$eq:' + d)).catch(() => null); add(r?.collection, 'cvr'); }
    const e = _digits(ean);
    if (e) { const r = await eco.rest('/customers?filter=' + enc('ean$eq:' + e)).catch(() => null); add(r?.collection, 'ean'); }
    if (out.length === 0 && name) {
        const word = (String(name).split(/\s+/).find(w => w.length >= 3) || name).replace(/[^\wæøåÆØÅ]/gi, '');
        if (word) { const r = await eco.rest('/customers?filter=' + enc('name$like:' + word) + '&pagesize=10').catch(() => null); add(r?.collection, 'name'); }
    }
    return out;
}

router.get('/:bonId/economic-customer-suggest', requireAuth(), handle(async (req, res) => {
    if (!eco.isConfigured()) return res.status(503).json({ error: 'e-conomic er ikke konfigureret' });
    const db = getDb();
    const row = db.prepare(`
        SELECT b.id, co.id AS company_id, co.name AS company_name, co.cvr, co.ean, co.economic_customer_id AS company_eco,
               c.id AS customer_id, c.first_name, c.last_name, c.email,
               c.economic_customer_id AS customer_eco, c.economic_contact_id
        FROM bons b LEFT JOIN companies co ON co.id = b.company_id LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.id = ?`).get(parseInt(req.params.bonId, 10));
    if (!row) return res.status(404).json({ error: 'Bon ikke fundet' });

    const isCompany = !!row.company_id;
    const personName = `${row.first_name || ''} ${row.last_name || ''}`.trim();

    // Find kunde-kandidater (firma → CVR/EAN/navn; privat → navn)
    const candidates = isCompany
        ? await _searchEconomicCustomers({ cvr: row.cvr, ean: row.ean, name: row.company_name })
        : await _searchEconomicCustomers({ name: personName });

    // Effektivt kundenummer til kontakt-opslag: allerede koblet ELLER bedste kandidat
    const effectiveNumber = (isCompany ? row.company_eco : row.customer_eco) || candidates[0]?.number || null;

    let contacts = null;
    if (effectiveNumber) {
        const r = await eco.rest('/customers/' + effectiveNumber + '/contacts?pagesize=100').catch(() => null);
        const list = (r?.collection || []).map(c => ({
            number: String(c.customerContactNumber), name: c.name || '', email: c.email || '',
            score: row.email && c.email && row.email.toLowerCase() === c.email.toLowerCase() ? 1 : _contactScore(personName, c.name),
        })).sort((a, b) => b.score - a.score);
        const best = list[0] && list[0].score >= 0.6 ? list[0] : null;
        contacts = {
            for_customer_number: effectiveNumber,
            list,
            suggested: best,
            person_is_new: !best,                 // bonens person matcher ingen eksisterende kontakt
        };
    }

    res.json({
        bon_id: row.id,
        target_type: isCompany ? 'company' : 'customer',
        target_id: isCompany ? row.company_id : row.customer_id,
        company: isCompany ? { id: row.company_id, name: row.company_name, cvr: row.cvr, ean: row.ean, already: row.company_eco } : null,
        person: row.customer_id ? { id: row.customer_id, name: personName, email: row.email, already: row.economic_contact_id } : null,
        customer_candidates: candidates,
        contacts,
    });
}));

// ─── POST /api/invoices/:bonId/economic-create-customer ─────────────────────
// Opret bonens firma (eller privatperson) som NY kunde i e-conomic + valgfri
// kontakt, og skriv numrene tilbage på Bon. Til kunder der ikke findes i forvejen.
async function _nextEconomicCustomerNumber() {
    const r = await eco.rest('/customers?pagesize=1&sort=-customerNumber').catch(() => null);
    const max = Number(r?.collection?.[0]?.customerNumber || 0);
    return max + 1;
}

router.post('/:bonId/economic-create-customer', requireAuth(), handle(async (req, res) => {
    if (!eco.isConfigured()) return res.status(503).json({ error: 'e-conomic er ikke konfigureret' });
    const db = getDb();
    const row = db.prepare(`
        SELECT b.id, co.id AS company_id, co.name AS company_name, co.cvr, co.ean, co.economic_customer_id AS company_eco,
               c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone,
               c.economic_customer_id AS customer_eco, c.economic_contact_id,
               -- Firmaets egen adresse først; bonens leveringsadresse kun som
               -- nødløsning (og for privatkunder, der ikke har nogen anden).
               -- Et kundekort med leveringsadressen sender rykkere til et
               -- festivalområde.
               COALESCE(ca.street_name, a.street_name) AS street_name,
               COALESCE(ca.street_nr,   a.street_nr)   AS street_nr,
               COALESCE(ca.postal_code, a.postal_code) AS postal_code,
               COALESCE(ca.city,        a.city)        AS city
        FROM bons b
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN addresses ca ON ca.id = co.address_id
        LEFT JOIN customers c ON c.id = b.customer_id
        LEFT JOIN addresses a ON a.id = b.delivery_address_id
        WHERE b.id = ?`).get(parseInt(req.params.bonId, 10));
    if (!row) return res.status(404).json({ error: 'Bon ikke fundet' });

    const isCompany = !!row.company_id;
    const personName = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    const createContact = req.body?.create_contact !== false;     // default: ja, hvis person findes

    const existingNo = isCompany ? row.company_eco : row.customer_eco;
    const hasContact = row.economic_contact_id != null && String(row.economic_contact_id).trim() !== '';
    const canMakeContact = createContact && !!personName && !!row.customer_id && !hasContact;
    // Allerede koblet OG intet nyt at lave → 409.
    if (existingNo && !canMakeContact) return res.status(409).json({ error: 'Kunden er allerede koblet i e-conomic', economic_customer_id: existingNo });

    let newNumber = existingNo;

    // Opret kunden hvis den ikke findes endnu
    if (!existingNo) {
        const setNum = (k) => { const v = db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value; return v == null || v === '' ? null : Number(v); };
        const groupNo = setNum('economic_default_customer_group_number') || 1;        // 1 = Diverse
        const termsNo = setNum('economic_default_payment_terms_number') || 1;          // 1 = Netto 8 dage
        const number = await _nextEconomicCustomerNumber();
        const payload = {
            customerNumber: number,
            name: isCompany ? row.company_name : (personName || 'Kunde'),
            currency: 'DKK',
            customerGroup: { customerGroupNumber: groupNo },
            paymentTerms: { paymentTermsNumber: termsNo },
            vatZone: { vatZoneNumber: 1 },                                            // indenlandsk DK
        };
        if (isCompany && row.cvr) payload.corporateIdentificationNumber = String(row.cvr).replace(/\D/g, '');
        if (row.ean) payload.ean = String(row.ean).replace(/\D/g, '');
        if (row.email) payload.email = row.email;
        if (row.phone) payload.telephoneAndFaxNumber = row.phone;
        if (row.street_name) { payload.address = `${row.street_name} ${row.street_nr || ''}`.trim(); payload.zip = row.postal_code || ''; payload.city = row.city || ''; payload.country = 'Danmark'; }

        let created;
        try { created = await eco.rest('/customers', { method: 'POST', body: payload }); }
        catch (e) { return res.status(502).json({ error: 'e-conomic afviste oprettelsen', detail: e.message }); }
        newNumber = created?.customerNumber ?? number;

        if (isCompany) db.prepare('UPDATE companies SET economic_customer_id = ? WHERE id = ?').run(String(newNumber), row.company_id);
        else db.prepare('UPDATE customers SET economic_customer_id = ? WHERE id = ?').run(String(newNumber), row.customer_id);
        logChange({ entityType: isCompany ? 'company' : 'customer', entityId: isCompany ? row.company_id : row.customer_id,
            action: 'economic_customer_created', fieldName: 'economic_customer_id', oldValue: null, newValue: String(newNumber), userId: req.session?.userId ?? null });
    }

    // Opret kontakt fra bonens person (hvis kunden findes/blev oprettet + ingen kontakt endnu)
    let contactNumber = null;
    if (canMakeContact && newNumber) {
        try {
            const ct = await eco.rest(`/customers/${newNumber}/contacts`, { method: 'POST', body: { name: personName, ...(row.email ? { email: row.email } : {}) } });
            contactNumber = ct?.customerContactNumber ?? null;
            if (contactNumber != null) db.prepare('UPDATE customers SET economic_contact_id = ? WHERE id = ?').run(String(contactNumber), row.customer_id);
        } catch (e) { /* kontakt er valgfri — kunden er oprettet uanset */ }
    }

    res.json({ ok: true, economic_customer_id: newNumber, economic_contact_id: contactNumber, created_customer: !existingNo });
}));

// ─── POST /api/invoices/:bonId/economic-draft ───────────────────────────────
// Opret fakturaudkast i e-conomic. Forhåndstjek → 422 ved mangler. Re-send-guard
// på economic_draft_number. Gemmer draft-nr + timestamp, logger, broadcaster.
// body: { oneoff_for_missing?: bool } — brug engangs-varenr for linjer uden recipe-nr.
router.post('/:bonId/economic-draft', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const bonId = parseInt(req.params.bonId, 10);

    const existing = db.prepare('SELECT economic_draft_number FROM bons WHERE id = ?').get(bonId);
    if (!existing) return res.status(404).json({ error: 'Bon ikke fundet' });
    // Re-send-guard: udkast findes allerede → byg ikke et nyt (undgår dublet-udkast).
    if (existing.economic_draft_number != null) {
        return res.status(409).json({
            error: 'Udkast findes allerede i e-conomic',
            economic_draft_number: existing.economic_draft_number,
        });
    }
    if (!eco.isConfigured()) {
        return res.status(503).json({ error: 'e-conomic er ikke konfigureret (tokens mangler i .env)' });
    }

    // Prøvekørsel: byg kladden og kør alle vagter, men rør hverken e-conomic eller bonen.
    const dryRun = req.body?.dry_run === true;

    // Sikkerhedsnet for bons der allerede var LEVERET da gebyr-reglen blev tændt
    // (hovedvejen er status-skiftet i routes/bons.js). Idempotent — en opskrift
    // der allerede ligger på bonen tilføjes ikke igen.
    // Springes over ved prøvekørsel: den SKRIVER gebyrlinjer på bonen, og en
    // generalprøve må ikke ændre noget. Til gengæld rapporteres hvad den ville have
    // lagt på, så payloaden ikke ser mindre ud end den rigtige afsendelses.
    if (!dryRun) await autoFees.applyAutoFees(db, bonId, { userId: req.session?.userId ?? null });

    const bon = await enrichBonForEconomic(db, bonId, { lookupBillingAddress: true });
    const oneoffForMissing = req.body?.oneoff_for_missing === true;

    const readiness = economicInvoice.checkReadiness(bon, economicInvoice.getEconomicSettings(db));
    // Blokér hvis ikke klar — medmindre eneste mangel er recipe-numre OG oneoff-redning er valgt.
    const oneoffRescues = oneoffForMissing
        && readiness.missingProducts.length > 0
        && !readiness.missingCustomer
        && !readiness.eanWithoutContact
        && !readiness.missingDelivery;
    if (!readiness.ok && !oneoffRescues) {
        return res.status(422).json({ error: 'Bon ikke klar til fakturering', readiness });
    }

    let result;
    try {
        result = await economicInvoice.createDraftInvoice(bon, { oneoffForMissing, dryRun });
    } catch (e) {
        if (e.code === 'not_ready') {
            return res.status(422).json({ error: 'Bon ikke klar til fakturering', readiness: e.readiness });
        }
        // Værn bag forhåndstjekket (#444/#454): en linje der ikke kan bygges må aldrig
        // ende som en for lille faktura. Nås kun hvis de to er blevet uenige.
        if (e.code === 'line_without_product' || e.code === 'delivery_without_product'
            || e.code === 'oneoff_unavailable' || e.code === 'contact_customer_mismatch') {
            return res.status(422).json({ error: e.message, code: e.code, line: e.line ?? null, readiness });
        }
        // e-conomics egen begrundelse må ikke kun findes i HTTP-svaret. Da en kladde
        // blev afvist i drift, stod der intet i journalctl (handle() når aldrig herned,
        // fordi vi selv fanger fejlen) og toasten viste kun den generiske overskrift —
        // så årsagen fandtes ét sted: i et svar ingen kiggede i.
        console.error(`[e-conomic] kladde for bon ${bonId} afvist:`, e.message);
        if (e instanceof eco.EconomicAuthError) {
            return res.status(502).json({ error: 'e-conomic-adgang skal genetableres', detail: e.message });
        }
        if (e instanceof eco.EconomicRateError) {
            return res.status(503).json({ error: 'e-conomic rate limit ramt — prøv igen senere', detail: e.message });
        }
        return res.status(502).json({ error: 'e-conomic afviste udkastet', detail: e.message });
    }

    // Prøvekørsel stopper her: intet gemmes, intet logges, intet broadcastes.
    if (dryRun) {
        return res.json({
            ok: true, dry_run: true,
            payload: result.payload,
            idempotency_key: result.idempotencyKey,
            readiness: result.readiness ?? readiness,
            // Gebyrer den RIGTIGE afsendelse ville lægge på først — de er ikke i payloaden her.
            pending_fees: (await previewPendingFees(db, bon)).fees,
        });
    }

    const draftNo = result.draftInvoiceNumber;
    db.prepare(`UPDATE bons SET economic_draft_number = ?, economic_draft_at = datetime('now','localtime') WHERE id = ?`)
      .run(draftNo, bonId);

    logChange({
        entityType: 'bon',
        entityId:   bonId,
        action:     'economic_draft_created',
        fieldName:  'economic_draft_number',
        oldValue:   null,
        newValue:   String(draftNo),
        userId:     req.session?.userId ?? null,
    });
    broadcast('bon_updated', { id: bonId, economic_draft_number: draftNo });

    res.json({ ok: true, economic_draft_number: draftNo });
}));

module.exports = router;
