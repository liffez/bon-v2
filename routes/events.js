// routes/events.js — Event-modul (let event: alt fra HQ)
// ============================================================
// Spec: docs/CLAUDE_EVENT.md
// Mountes på /api/events i server.js.
//
// MVP-omfang:
//   - CRUD: events (GET/POST/PATCH)
//   - GET /:id/overview — event-detalje med bons grupperet i fire roller + P&L
//   - POST /:id/bons — generér prep/top-up/salgs/udgifts-bon med linjer
//
// No-deduct-gaten (§5) + Vej B-overstyringen ligger i db/helpers.js
// autoConsumeBonInventory og affyres når en bon når LEVERET — vi rører
// ikke lageret her i routes/events.js. Denne fil binder bare bons til
// events via bons.event_id og orkestrerer oprettelsen.
// ============================================================

const express = require('express');
const router  = express.Router();
const {
    handle, logChange, getBon, getBonLines, getStatusId, getDefaultLocationId,
    getPrepPackingOverrides, todayISO, nextBonNumber, recalcBonTotalUnits, transaction,
    inclToExcl
} = require('../db/helpers');
const { getDb }    = require('../db/database');
const { broadcast } = require('../shared/sse');
const { requireAuth } = require('../shared/auth');
const grocy = require('../services/grocyAdapter');
const { geocodeAddress } = require('../services/geocode');

// ─── helpers ───────────────────────────────────────────────────────────────

function getPriceCategoryByCode(code) {
    return getDb().prepare(`SELECT id, code, label FROM price_categories WHERE code = ? AND is_active = 1`).get(code);
}

function getEvent(id) {
    return getDb().prepare(`
        SELECT e.*, l.name AS location_name, l.code AS location_code,
               NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
               c.phone AS contact_phone, c.email AS contact_email,
               co.name AS contact_company_name
        FROM events e
        JOIN locations l ON e.location_id = l.id
        LEFT JOIN customers c ON e.customer_id = c.id
        LEFT JOIN companies co ON e.company_id = co.id
        WHERE e.id = ?
    `).get(id);
}

// Kontaktfelterne der arves ned på event-genererede bons. Kunden kopieres
// direkte (customer_id/company_id spejler bons' egne felter). Kontakt på
// dagen falder tilbage til kundens navn/telefon når den ikke er sat separat
// — det er langt det almindelige tilfælde, og en tom dagskontakt på en
// event-bon hjælper ingen i køkkenet.
function eventContactFields(event) {
    return {
        customer_id: event.customer_id ?? null,
        company_id:  event.company_id ?? null,
        day_contact_name:  event.day_contact_name  ?? event.contact_name  ?? null,
        day_contact_phone: event.day_contact_phone ?? event.contact_phone ?? null,
    };
}

// Hent alle bons for et event, joinet med priskategori + status, sorteret efter rolle.
function getEventBons(eventId) {
    return getDb().prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
               b.pax, b.total_units, b.total_price, b.payment_type,
               b.created_at, b.kitchen_info, b.customer_wishes, b.internal_notes,
               b.inventory_deducted, b.inventory_deduct_status, b.event_role,
               sd.code  AS status_code,
               sd.label AS status_label,
               sd.color AS status_color,
               pc.code  AS price_category_code,
               pc.label AS price_category_label,
               -- Lavet af event-broen (forudbestillinger) frem for i hånden.
               -- Skal kunne ses: en prep-bon fra broen er ALLEREDE SOLGT og
               -- indgår typisk i forecast-prep-bonnen — ikke ekstra produktion.
               (SELECT 1 FROM event_bridge_bons ebb WHERE ebb.bon_id = b.id) AS is_bridge
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ?
        ORDER BY b.delivery_date, b.created_at
    `).all(eventId);
}

// ─── AFLYSTE BONS: synlige i listen, aldrig i tallene ──────────────────────
// En aflyst prep-bon er historik ("der VAR en plan") og skal blive stående i
// overblikkets bon-liste. Men den forlod aldrig huset og blev aldrig solgt, så
// den må ikke tælle i vareforbrug, CO₂, P&L, salgs-prefill eller de beregnede
// rest-/top-up-/retur-tal. Hver beregning filtrerer selv (frem for at stole på
// at kalderen har gjort det), fordi flere af dem er eksporteret til test.
// SQL-fragmentet kræver at forespørgslen har `bons` aliaset `b`.
const EXCLUDE_CANCELLED_SQL =
    `AND b.status_id != (SELECT id FROM status_definitions WHERE code = 'AFLYST')`;

const isCancelled = bon => bon.status_code === 'AFLYST';
const activeBons  = bons => bons.filter(b => !isCancelled(b));

// Klassificer en event-bon i en af de fire roller.
// Match spec'en (§3): prep + top-up + dagssalg + udgift. Hjemkomst er en
// varemodtagelse, ikke en bon — ignoreres i bon-listen.
// Rollen persisteres på bons.event_role ved generering (migration 101) så et
// flerdags-event kan have flere prep-bons. Fallback-heuristik for ældre bons:
// første produktionsbon pr. delivery_date = prep, resten samme dag = top-up.
function classifyRole(bon, eventStart) {
    if (bon.event_role) return bon.event_role;
    if (bon.price_category_code === 'produktion') {
        return bon._is_first_production_on_date ? 'prep' : 'topup';
    }
    if ((bon.total_price ?? 0) < 0) return 'expense';
    return 'sales';
}

// Beregn P&L baseret på event-bons. Alt i kroner, incl moms på salget
// (matcher hvordan totals gemmes i v2 — moms-doktrinen §6b).
function computeEventPnL(bons) {
    let revenue_incl = 0, expenses = 0, cost = 0;
    for (const b of activeBons(bons)) {
        const price = b.total_price ?? 0;
        if (b.price_category_code === 'produktion') continue;     // prep/top-up = 0 kr, irrelevant for P&L
        if (price < 0) expenses += -price;                         // udgiftsbon (negativ linje)
        else           revenue_incl += price;
    }
    // Vareforbrug = sum af cost_price * quantity på prep-bonner (ex moms).
    // For MVP: hentes via separat query for at undgå at slæbe linjer rundt.
    const revenue_excl = inclToExcl(revenue_incl);
    // Udgiftsbonner gemmes incl moms (moms-doktrin §6b: bons.total_price er incl
    // moms). P&L'en er ex moms (§7/spec linje 161 "Alt ex moms"), så udgiften
    // konverteres til ex moms før den trækkes fra — ellers blandes momsgrundlag.
    const expenses_excl = inclToExcl(expenses);
    return {
        revenue_incl, revenue_excl,
        expenses, expenses_excl, cost_estimated: cost,
        // P&L = omsætning ex moms − vareforbrug ex moms − udgifter ex moms
        result: Math.round((revenue_excl - cost - expenses_excl) * 100) / 100
    };
}

// Udgifter til event-P&L'en, ex moms, beregnet PR. LINJE. Udgiftslinjer kan
// være incl moms (kvittering: benzin/bro/stadeleje) eller ex moms (Grocy-produkt-
// kostpris, service-fee) — moms_included-flaget på bon_lines afgør det. Vi
// identificerer udgiftsbonner præcis som computeEventPnL (ikke-produktion +
// negativ total) så HVILKE bonner der tæller ikke ændrer sig — kun HVORDAN moms
// håndteres. line_total er negativt på udgiftslinjer → abs() giver beløbet.
function computeEventExpenses(eventId) {
    const rows = getDb().prepare(`
        SELECT bl.line_total, bl.moms_included
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND COALESCE(pc.code,'') != 'produktion' AND b.total_price < 0
          ${EXCLUDE_CANCELLED_SQL}
    `).all(eventId);
    let incl = 0, excl = 0;
    for (const r of rows) {
        const amt = Math.abs(r.line_total ?? 0);
        incl += amt;
        excl += r.moms_included ? inclToExcl(amt) : amt;   // ex moms: behold som-er
    }
    return { incl: Math.round(incl * 100) / 100, excl: Math.round(excl * 100) / 100 };
}

function computeEventCost(eventId) {
    // Vareforbrug ex moms = Σ over prep/top-up-bons (price_category='produktion')
    // af bon_lines.cost_price * quantity. cost_price er allerede ex moms.
    const row = getDb().prepare(`
        SELECT COALESCE(SUM(bl.cost_price * bl.quantity), 0) AS c
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND pc.code = 'produktion'
          ${EXCLUDE_CANCELLED_SQL}
    `).get(eventId);
    return row?.c ?? 0;
}

// Event-CO₂ (§7). co2e ligger på BÅDE prep- og salgsbons (samme opskrifter), så
// en usfiltreret sum tæller footprintet dobbelt. CO₂ er ikke pris-gated som
// P&L'en (hvor produktion selv-udelukkes via 0-pris), så vi ekskluderer
// produktion EKSPLICIT og tæller kun salgs-/udgiftsbons (= faktisk omsætning).
function computeEventCO2(eventId) {
    const row = getDb().prepare(`
        SELECT COALESCE(SUM(bl.co2e * bl.quantity), 0) AS co2
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND (pc.code IS NULL OR pc.code != 'produktion')
          ${EXCLUDE_CANCELLED_SQL}
    `).get(eventId);
    return Math.round((row?.co2 ?? 0) * 100) / 100;
}

// Find adresse-id til genererede bons (delivery_address_id — vises i drawer,
// logistik, kort-links). To veje:
//   1) event_address_id sat (DAWA-valgt i event-modalen) → brug den direkte.
//      Struktureret + geokodet allerede ved event-oprettelsen.
//   2) Fritekst-fallback: gem teksten som street_name og lad DAWA geokode
//      fire-and-forget (må aldrig blokere bon-oprettelsen). Genbrug pr.
//      (event-navn, adressetekst) så hver bon ikke spawner en ny række.
function resolveEventAddressId(event) {
    if (event.event_address_id) return event.event_address_id;
    if (!event.event_address) return null;
    const db = getDb();
    const existing = db.prepare(`
        SELECT id FROM addresses WHERE label = ? AND street_name = ?
    `).get(event.name, event.event_address);
    if (existing) return existing.id;
    const r = db.prepare(`
        INSERT INTO addresses (label, street_name) VALUES (?, ?)
    `).run(event.name, event.event_address);
    const id = Number(r.lastInsertRowid);
    geocodeAddress(id).catch(err => {
        console.warn(`[events] geokodning af event-adresse #${id} fejlede:`, err.message);
    });
    return id;
}

// Opløs en bons FAKTISK pakkede råvarer (consume-items + pakke-overrides).
// Samme grundlag som det Grocy trækker ved LEVERET. Returnerer
// [{ product_id, product_name, amount_stock, qu_id_stock }].
async function resolvePackedRaw(bonId, applyOverrides) {
    const { resolveConsumeItems } = require('../services/ingredientResolver');
    const lines = getBonLines(bonId);
    if (!lines.some(l => l.grocy_recipe_id)) return [];
    const items = await resolveConsumeItems(lines);
    if (applyOverrides) {
        const ov = getPrepPackingOverrides(bonId);
        for (const it of items) {
            if (ov.has(it.product_id)) it.amount_stock = ov.get(it.product_id);
        }
    }
    return items;
}

// Beregn event-beholdning (rest_på_eventet) pr. råvare:
//   rest = (prep + top-ups, m/overrides)  −  solgt (BOM-eksploderet)
// Alt i stock-units. Returnerer { items: [{product_id, name, unit, prepped, sold, suggested_rest}] }.
async function computeReturnSuggestion(event) {
    const bons = activeBons(getEventBons(event.id));
    const [products, qus] = await Promise.all([grocy.getProducts(), grocy.getQuantityUnits()]);
    const prodMap = new Map(products.map(p => [parseInt(p.id), p]));
    const quMap   = new Map(qus.map(u => [parseInt(u.id), u]));

    const prepped = new Map();   // pid → amount
    const sold    = new Map();
    const names   = new Map();

    for (const b of bons) {
        const isProd = b.price_category_code === 'produktion';
        const isExpense = (b.total_price ?? 0) < 0 && !isProd;
        if (isExpense) continue;
        const items = await resolvePackedRaw(b.id, isProd);   // overrides kun relevante på prep
        const target = isProd ? prepped : sold;
        for (const it of items) {
            target.set(it.product_id, (target.get(it.product_id) || 0) + it.amount_stock);
            if (!names.has(it.product_id)) names.set(it.product_id, it.product_name);
        }
    }

    const allPids = new Set([...prepped.keys(), ...sold.keys()]);
    const items = [];
    for (const pid of allPids) {
        const p = prepped.get(pid) || 0;
        const s = sold.get(pid) || 0;
        const rest = Math.max(0, p - s);
        const prod = prodMap.get(pid) || {};
        const unit = quMap.get(parseInt(prod.qu_id_stock))?.name || '';
        items.push({
            product_id: pid,
            product_name: names.get(pid) || prod.name || `#${pid}`,
            unit,
            prepped: Math.round(p * 100) / 100,
            sold: Math.round(s * 100) / 100,
            suggested_rest: Math.round(rest * 100) / 100,
        });
    }
    items.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '', 'da'));
    return { items };
}

// ─── TOP-UP-FORSLAG (§6) ───────────────────────────────────────────────────
// Morgen dag N: hvad mangler der at blive hentet fra HQ, og hvad står der
// allerede rigeligt af på pladsen?
//
//   rest_på_eventet  = (prep + top-ups, delivery_date ≤ dato)
//                    − solgt (salgs-bons, delivery_date < dato — dagens salg er ikke sket endnu)
//   forslag          = forecast_dag_N − rest          (clamp ≥ 0)
//
// Beregnes på TO niveauer:
//   • Kategori/produkt (færdige menuer) — det topup-bonnen består af.
//     Forecasten er pr. KATEGORI, så kategori-forslaget fordeles pro-rata på
//     de produkter der faktisk er preppet i kategorien (prep-mixet er den
//     eneste bro fra kategori-tal til konkrete opskrifter → BOM).
//   • Råvarer — behov (BOM af de allokerede produkter) mod beregnet råvare-rest
//     (BOM af produktion m/pakke-overrides − BOM af salg). Giver "hent mere"
//     og "rigeligt på pladsen" — pakkevejledning, ikke bon-linjer.
//
// VIGTIGT: resten er et GÆT baseret på loggede bevægelser ("vi er trætte om
// aftenen" — salget er ikke altid tastet). sales_bon_count sendes med så
// frontenden kan vise antagelsen tydeligt, og alt er frit justerbart.

// Largest-remainder-afrunding: fordel `total` (heltal) på vægte så summen
// rammer præcist. Returnerer array af heltal i samme rækkefølge som weights.
function allocateInteger(total, weights) {
    const sumW = weights.reduce((a, b) => a + b, 0);
    if (sumW <= 0 || total <= 0) return weights.map(() => 0);
    const exact = weights.map(w => total * w / sumW);
    const floors = exact.map(Math.floor);
    let remainder = total - floors.reduce((a, b) => a + b, 0);
    // Fordel resten til de største decimaler
    const order = exact.map((v, i) => ({ i, frac: v - floors[i] }))
        .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
        floors[order[k].i]++;
    }
    return floors;
}

async function computeTopupSuggestion(event, date) {
    const db = getDb();

    // ── 1) Kategori-niveau: prepped/solgt/rest i færdig-produkt-enheder ──
    // Produktion på pladsen (alle prep/topup-bons t.o.m. dato).
    const preppedRows = db.prepare(`
        SELECT bl.category AS category, bl.grocy_recipe_id AS rid,
               bl.product_name AS name, bl.unit AS unit,
               COALESCE(SUM(bl.quantity), 0) AS qty
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND pc.code = 'produktion' AND b.delivery_date <= ?
          ${EXCLUDE_CANCELLED_SQL}
        GROUP BY bl.category, bl.grocy_recipe_id, bl.product_name, bl.unit
    `).all(event.id, date);

    // Solgt indtil i morges (salgs-bons FØR dato; udgifter ekskluderet).
    const soldRows = db.prepare(`
        SELECT bl.category AS category, COALESCE(SUM(bl.quantity), 0) AS qty
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND b.delivery_date < ?
          AND (pc.code IS NULL OR pc.code != 'produktion')
          AND COALESCE(b.event_role, 'sales') != 'expense'
          AND b.total_price >= 0
          ${EXCLUDE_CANCELLED_SQL}
        GROUP BY bl.category
    `).all(event.id, date);

    const salesBonCount = db.prepare(`
        SELECT COUNT(*) AS c FROM bons b
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND b.delivery_date < ?
          AND (pc.code IS NULL OR pc.code != 'produktion')
          AND COALESCE(b.event_role, 'sales') != 'expense'
          AND b.total_price >= 0
          ${EXCLUDE_CANCELLED_SQL}
    `).get(event.id, date)?.c ?? 0;

    const forecastRows = db.prepare(`
        SELECT category, expected_qty FROM event_forecast
        WHERE event_id = ? AND forecast_date = ?
    `).all(event.id, date);

    const preppedByCat = new Map();   // cat → qty
    const mixByCat     = new Map();   // cat → [{rid, name, unit, qty}]
    for (const r of preppedRows) {
        const cat = r.category || '(uden kategori)';
        preppedByCat.set(cat, (preppedByCat.get(cat) || 0) + r.qty);
        if (!mixByCat.has(cat)) mixByCat.set(cat, []);
        mixByCat.get(cat).push(r);
    }
    const soldByCat = new Map();
    for (const r of soldRows) soldByCat.set(r.category || '(uden kategori)', r.qty);
    const forecastByCat = new Map();
    for (const r of forecastRows) forecastByCat.set(r.category, r.expected_qty);

    // Kategori-tabellen: union af forecast- og prepped-kategorier.
    const allCats = new Set([...forecastByCat.keys(), ...preppedByCat.keys()]);
    const categories = [];
    const warnings = [];
    const allocatedProducts = [];   // [{grocy_recipe_id, product_name, category, unit, quantity}]
    for (const cat of allCats) {
        const fc      = forecastByCat.get(cat) || 0;
        const prepped = preppedByCat.get(cat) || 0;
        const sold    = soldByCat.get(cat) || 0;
        const rest    = Math.max(0, prepped - sold);
        const suggestion = Math.max(0, fc - rest);
        categories.push({ category: cat, forecast: fc, prepped, sold, rest, suggestion });

        if (suggestion <= 0) continue;
        const mix = mixByCat.get(cat) || [];
        if (mix.length === 0) {
            warnings.push(`${cat}: forecast ${fc} men intet prep-mix at fordele på — vælg selv produkter.`);
            continue;
        }
        const alloc = allocateInteger(suggestion, mix.map(m => m.qty));
        for (let i = 0; i < mix.length; i++) {
            if (alloc[i] <= 0) continue;
            allocatedProducts.push({
                grocy_recipe_id: mix[i].rid ?? null,
                product_name:    mix[i].name,
                category:        cat,
                unit:            mix[i].unit || 'stk',
                quantity:        alloc[i],
            });
        }
    }
    categories.sort((a, b) => a.category.localeCompare(b.category, 'da'));

    // ── 2) Råvare-niveau: behov (BOM af forslag) mod beregnet rest ──────
    // Genbruger resolvePackedRaw (consume-items + pakke-overrides) så tallene
    // matcher hvad LEVERET faktisk ville trække. Kræver Grocy — degraderer
    // gracefully til kun kategori-niveau hvis Grocy er utilgængelig
    // (kategori-forslaget er ren SQL og stadig brugbart).
    const raw = [];
    try {
        const bons = activeBons(getEventBons(event.id));
        const preppedRaw = new Map(), soldRaw = new Map(), rawNames = new Map();
        for (const b of bons) {
            const isProd = b.price_category_code === 'produktion';
            const isExpense = (b.event_role === 'expense') || ((b.total_price ?? 0) < 0 && !isProd);
            if (isExpense) continue;
            if (isProd  && b.delivery_date >  date) continue;   // fremtidig prep er ikke på pladsen
            if (!isProd && b.delivery_date >= date) continue;   // dagens salg er ikke sket endnu
            const items = await resolvePackedRaw(b.id, isProd);
            const target = isProd ? preppedRaw : soldRaw;
            for (const it of items) {
                target.set(it.product_id, (target.get(it.product_id) || 0) + it.amount_stock);
                if (!rawNames.has(it.product_id)) rawNames.set(it.product_id, it.product_name);
            }
        }

        // Behov: BOM-eksplodér de allokerede produkter (kun dem med recipe-id).
        const { resolveConsumeItems } = require('../services/ingredientResolver');
        const bomLines = allocatedProducts.filter(p => p.grocy_recipe_id);
        const needRaw = new Map();
        if (bomLines.length > 0) {
            const items = await resolveConsumeItems(bomLines);
            for (const it of items) {
                needRaw.set(it.product_id, (needRaw.get(it.product_id) || 0) + it.amount_stock);
                if (!rawNames.has(it.product_id)) rawNames.set(it.product_id, it.product_name);
            }
        }

        // Enheder fra Grocy (best effort — tomme strenge ved fejl).
        let prodMap = new Map(), quMap = new Map();
        try {
            const [products, qus] = await Promise.all([grocy.getProducts(), grocy.getQuantityUnits()]);
            prodMap = new Map(products.map(p => [parseInt(p.id), p]));
            quMap   = new Map(qus.map(u => [parseInt(u.id), u]));
        } catch (err) {
            console.warn('[events] topup: kunne ikke hente produkter/enheder:', err.message);
        }

        const allPids = new Set([...needRaw.keys(), ...preppedRaw.keys(), ...soldRaw.keys()]);
        for (const pid of allPids) {
            const need = needRaw.get(pid) || 0;
            const rest = Math.max(0, (preppedRaw.get(pid) || 0) - (soldRaw.get(pid) || 0));
            const fetch   = Math.max(0, need - rest);
            const surplus = Math.max(0, rest - need);
            if (need === 0 && rest === 0) continue;
            const prod = prodMap.get(pid) || {};
            raw.push({
                product_id:   pid,
                product_name: rawNames.get(pid) || prod.name || `#${pid}`,
                unit:         quMap.get(parseInt(prod.qu_id_stock))?.name || '',
                needed:  Math.round(need * 100) / 100,
                rest:    Math.round(rest * 100) / 100,
                fetch:   Math.round(fetch * 100) / 100,
                surplus: Math.round(surplus * 100) / 100,
            });
        }
        raw.sort((a, b) => (b.fetch - a.fetch) || (a.product_name || '').localeCompare(b.product_name || '', 'da'));
    } catch (err) {
        console.warn('[events] topup: råvare-niveau utilgængeligt (Grocy):', err.message);
        warnings.push('Råvare-tjek utilgængeligt — kunne ikke nå Grocy. Kategori-forslaget gælder stadig.');
    }

    return {
        date,
        sales_bon_count: salesBonCount,
        categories,
        products: allocatedProducts,
        raw,
        warnings,
    };
}

// ─── EVENTS — CRUD ─────────────────────────────────────────────────────────

router.get('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { status } = req.query;
    let where = '1=1', params = [];
    if (status) { where += ' AND e.status = ?'; params.push(status); }
    const rows = db.prepare(`
        SELECT e.id, e.name, e.model, e.start_date, e.end_date, e.status,
               e.location_id, l.name AS location_name, l.code AS location_code,
               e.notes, e.event_address, e.created_at,
               e.customer_id, e.company_id,
               NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
               co.name AS contact_company_name,
               (SELECT COUNT(*) FROM bons WHERE event_id = e.id) AS bon_count
        FROM events e
        JOIN locations l ON e.location_id = l.id
        LEFT JOIN customers c ON e.customer_id = c.id
        LEFT JOIN companies co ON e.company_id = co.id
        WHERE ${where}
        ORDER BY
          CASE e.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
          e.start_date DESC
    `).all(...params);
    res.json({ events: rows });
}));

router.get('/:id', requireAuth(), handle((req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    res.json(event);
}));

router.post('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const b  = req.body;
    if (!b.name)        return res.status(400).json({ error: 'name er påkrævet' });
    if (!b.start_date)  return res.status(400).json({ error: 'start_date er påkrævet' });
    const model = b.model ?? 'light';
    if (!['light','festival'].includes(model)) {
        return res.status(400).json({ error: "model skal være 'light' eller 'festival'" });
    }
    const locationId = b.location_id ?? getDefaultLocationId();
    const result = db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status, notes, event_address, event_address_id,
                            customer_id, company_id, day_contact_name, day_contact_phone, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        b.name, locationId, model, b.start_date,
        b.end_date ?? null, b.status ?? 'planning',
        b.notes ?? null, b.event_address ?? null,
        b.event_address_id ?? null,
        b.customer_id ?? null, b.company_id ?? null,
        b.day_contact_name ?? null, b.day_contact_phone ?? null,
        req.session?.userId ?? null
    );
    const ev = getEvent(result.lastInsertRowid);
    logChange({ entityType: 'event', entityId: ev.id, action: 'create', newValue: ev.name, userId: req.session?.userId });
    broadcast('event_created', { id: ev.id, name: ev.name });
    res.status(201).json(ev);
}));

router.patch('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = req.params.id;
    const ev = getEvent(id);
    if (!ev) return res.status(404).json({ error: 'Event ikke fundet' });
    const ALLOWED = ['name','start_date','end_date','status','notes','model','location_id','event_address','event_address_id','open_hours_json',
                     'customer_id','company_id','day_contact_name','day_contact_phone'];
    const updates = [], params = [];
    for (const key of ALLOWED) {
        if (key in req.body) { updates.push(`${key} = ?`); params.push(req.body[key]); }
    }
    if (updates.length === 0) return res.json(ev);
    params.push(id);
    db.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const updated = getEvent(id);
    logChange({ entityType: 'event', entityId: id, action: 'update', userId: req.session?.userId });
    broadcast('event_updated', { id: updated.id });
    res.json(updated);
}));

// Slet event. Afkobler tilknyttede bons (sætter event_id=NULL — de bevares som
// almindelige bons med deres data/lager-træk intakt) og sletter derefter
// eventet. event_forecast cascader; prep_packing_overrides hænger på bons og
// bevares. Returnerer hvor mange bons der blev afkoblet.
router.delete('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const ev = getEvent(id);
    if (!ev) return res.status(404).json({ error: 'Event ikke fundet' });
    let unlinked = 0;
    transaction(db, () => {
        unlinked = db.prepare(`UPDATE bons SET event_id = NULL WHERE event_id = ?`).run(id).changes;
        db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
    });
    logChange({
        entityType: 'event', entityId: id, action: 'delete',
        oldValue: ev.name, newValue: `slettet (${unlinked} bons afkoblet)`,
        userId: req.session?.userId,
    });
    broadcast('event_deleted', { id });
    res.json({ deleted: true, unlinked_bons: unlinked });
}));

// ─── EVENT OVERBLIK ────────────────────────────────────────────────────────

router.get('/:id/overview', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const bons = getEventBons(event.id);
    // Fallback for bons uden persisteret event_role: marker første
    // produktionsbon pr. delivery_date som "prep" (oprettelsesrækkefølge).
    const seenProductionDates = new Set();
    for (const b of bons) {
        if (b.price_category_code === 'produktion') {
            b._is_first_production_on_date = !seenProductionDates.has(b.delivery_date);
            seenProductionDates.add(b.delivery_date);
        }
        b.role = classifyRole(b, event.start_date);
        delete b._is_first_production_on_date;
    }
    const pnl = computeEventPnL(bons);
    pnl.cost_estimated = computeEventCost(event.id);
    // Præcis udgifts-beregning pr. linje (incl/ex moms) — overskriver grov-summen
    // fra computeEventPnL, på samme måde som cost overskrives ovenfor.
    const exp = computeEventExpenses(event.id);
    pnl.expenses = exp.incl;
    pnl.expenses_excl = exp.excl;
    pnl.result = Math.round((pnl.revenue_excl - pnl.cost_estimated - pnl.expenses_excl) * 100) / 100;
    pnl.co2e_total = computeEventCO2(event.id);

    // Bank-afstemt: Σ pengestrøms-allokeringer på eventets bons (salg + · udgift −,
    // incl moms). Giver overblik over hvor meget af eventets økonomi der faktisk er
    // afstemt mod banken (jf. CLAUDE_PENGESTROEM.md §2.E).
    const bankRecon = getDb().prepare(`
        SELECT COALESCE(SUM(a.amount), 0) AS s, COUNT(DISTINCT a.transaction_id) AS tx
        FROM cf_allocations a
        JOIN bons b ON a.target_type = 'bon' AND a.target_id = CAST(b.id AS TEXT)
        WHERE b.event_id = ?
    `).get(event.id);
    pnl.bank_reconciled = Math.round((bankRecon.s || 0) * 100) / 100;
    pnl.bank_reconciled_tx = bankRecon.tx || 0;

    // Forecast pr. dag pr. kategori. Vi sender også de dage events spænder over
    // (start_date → end_date eller bare start_date hvis ingen end_date).
    const forecast = getDb().prepare(`
        SELECT id, forecast_date, category, expected_qty, notes
        FROM event_forecast WHERE event_id = ? ORDER BY forecast_date, category
    `).all(event.id);
    const days = [];
    if (event.start_date) {
        const start = new Date(event.start_date + 'T12:00:00');
        const end   = event.end_date ? new Date(event.end_date + 'T12:00:00') : start;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            days.push(d.toISOString().slice(0, 10));
        }
    }
    // Kategori-liste fra Grocy `grupper`-userfield. Vi udlæser distinct fra
    // sellable recipes — det matcher hvad køkkenet faktisk arbejder med
    // (sandwich, salat, slider, drikke, kager). Emballage-kategorien filtreres
    // bort: det er pakke-materiale, ikke noget kunden køber.
    let categories = [];
    try {
        const recipes = await grocy.getRecipes();
        const set = new Set();
        for (const r of recipes) {
            const cat = (r.category || '').trim();
            if (!cat) continue;
            // Filtrér kategorier der ikke er "noget kunden køber":
            //   - Emballage / underopskrifter (Grocy interne)
            //   - RR Produktion / RR produktion Hurtig (interne produktionsbatches)
            //   - "x-" prefiks (Service, Levering — administrative)
            //   - Tilbehør & Bokse (emballage-variant)
            if (/emballage|underopskrift|tilbeh.r/i.test(cat)) continue;
            if (/^rr\s*produktion/i.test(cat)) continue;
            if (/^x-?\s*/i.test(cat)) continue;
            set.add(cat);
        }
        categories = Array.from(set).sort((a, b) => a.localeCompare(b, 'da'));
    } catch (err) {
        console.warn('[events] kunne ikke hente Grocy-kategorier:', err.message);
    }

    // Allerede prepped pr. (dato, kategori) i færdig-produkt-enheder. Driver
    // top-up: forecast_dag_N − prepped = mangler at preppe. Summerer linjer fra
    // prep/top-up-bons (price_category='produktion') grupperet på bon.delivery_date.
    const preppedRows = getDb().prepare(`
        SELECT b.delivery_date AS date, bl.category AS category, COALESCE(SUM(bl.quantity), 0) AS qty
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ? AND pc.code = 'produktion' AND bl.category IS NOT NULL
          ${EXCLUDE_CANCELLED_SQL}
        GROUP BY b.delivery_date, bl.category
    `).all(event.id);
    const prepped = {};   // "date|category" → qty
    for (const r of preppedRows) prepped[`${r.date}|${r.category}`] = r.qty;

    // Global link til event-order-3's admin (event-broen). Tom = knap skjules.
    const eventOrderAdminUrl = getDb().prepare(
        `SELECT value FROM settings WHERE key = 'event_order_admin_url'`
    ).get()?.value || '';

    // Bons oprettet FØR eventet fik en kontaktperson står stadig uden kunde.
    // Tælleren driver "udfyld"-knappen i UI'et (POST /:id/apply-contact) —
    // uden den ville kontakten kun virke fremadrettet, og netop de bons man
    // allerede har genereret er dem man kigger på.
    const missingContact = event.customer_id
        ? getDb().prepare(`SELECT COUNT(*) AS n FROM bons WHERE event_id = ? AND customer_id IS NULL`).get(event.id).n
        : 0;

    res.json({ event, bons, pnl, forecast, days, categories, prepped,
               bons_missing_contact: missingContact,
               event_order_admin_url: eventOrderAdminUrl });
}));

// Udfyld eventets kontaktperson på de bons der mangler den. Rører KUN tomme
// felter — en bon hvor kontoret selv har sat en anden kunde eller en anden
// kontakt på dagen står urørt. Eksplicit handling frem for en bivirkning af
// at gemme eventet: at skrive på tværs af eksisterende bons skal være noget
// man beder om.
router.post('/:id/apply-contact', requireAuth(), handle((req, res) => {
    const db = getDb();
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    if (!event.customer_id) return res.status(400).json({ error: 'Eventet har ingen kontaktperson' });
    const c = eventContactFields(event);

    const targets = db.prepare(`SELECT id FROM bons WHERE event_id = ? AND customer_id IS NULL`).all(event.id);
    transaction(db, () => {
        const upd = db.prepare(`
            UPDATE bons
               SET customer_id       = ?,
                   company_id        = COALESCE(company_id, ?),
                   day_contact_name  = COALESCE(day_contact_name, ?),
                   day_contact_phone = COALESCE(day_contact_phone, ?),
                   updated_at        = CURRENT_TIMESTAMP
             WHERE id = ?
        `);
        for (const t of targets) {
            upd.run(c.customer_id, c.company_id, c.day_contact_name, c.day_contact_phone, t.id);
        }
    });
    for (const t of targets) {
        logChange({
            entityType: 'bon', entityId: t.id, action: 'update', fieldName: 'customer_id',
            newValue: `Kontaktperson arvet fra event "${event.name}"`, userId: req.session?.userId
        });
        broadcast('bon_updated', { id: t.id, event_id: event.id });
    }
    if (targets.length) broadcast('event_updated', { id: event.id });
    res.json({ updated: targets.length });
}));

// ─── EVENT-MENU (prisliste) §16 ────────────────────────────────────────────
// Menuen er eventets prisliste: hvad vi sælger, og til hvilken pris. Den
// genereres fra prep-bonnerne + Grocys festivalpriser, redigeres frit, og
// bliver derefter KILDEN til salgs-prefillens priser i stedet for Grocy.
//
// unit_price er INCL moms (§6b) — se migration 131 for hvorfor, og for
// hvorfor den IKKE må rettes til at matche item_prices (som er ex moms).

// Nøgle til at matche en menulinje mod en prep-linje. Opskrift-id når det
// findes (stabilt over tid), ellers normaliseret navn (fritekst-linjer kan
// kun matches på navn — accepteret begrænsning, jf. §16).
const menuKey = (recipeId, name) =>
    recipeId ? `r:${recipeId}` : `n:${String(name || '').trim().toLowerCase()}`;

// Aggregér eventets prep-linjer pr. produkt. Delt af menu-generering og
// salgs-prefill, så de to ALTID er enige om hvad "menuen" består af.
// Kun prep-rollen tæller (ikke top-up) og aldrig aflyste bons.
function getPrepAggregate(event) {
    const bons = activeBons(getEventBons(event.id));
    const seenProductionDates = new Set();
    for (const b of bons) {
        if (b.price_category_code === 'produktion') {
            b._is_first_production_on_date = !seenProductionDates.has(b.delivery_date);
            seenProductionDates.add(b.delivery_date);
        }
        b.role = classifyRole(b, event.start_date);
    }
    const prepIds = bons.filter(b => b.role === 'prep').map(b => b.id);
    if (prepIds.length === 0) return [];

    const ph = prepIds.map(() => '?').join(',');
    return getDb().prepare(`
        SELECT bl.grocy_recipe_id AS grocy_recipe_id,
               bl.product_name    AS product_name,
               bl.category        AS category,
               bl.unit            AS unit,
               COALESCE(SUM(bl.quantity), 0) AS qty
        FROM bon_lines bl
        WHERE bl.bon_id IN (${ph})
        GROUP BY bl.grocy_recipe_id, bl.product_name, bl.category, bl.unit
        ORDER BY bl.category, bl.product_name
    `).all(...prepIds);
}

function getMenuItems(eventId) {
    return getDb().prepare(`
        SELECT id, grocy_recipe_id, product_name, category, unit, unit_price, sort_order, note,
               item_type, applies_to
        FROM event_menu_items WHERE event_id = ?
        ORDER BY sort_order, category, product_name
    `).all(eventId);
}

// Diskret sikkerhedsnet i stedet for prisversionering (§16): har en salgsbon
// solgt et menupunkt til en anden pris end menuens, markeres rækken. Fanger de
// sjældne midt-i-event-prisændringer uden at bygge et versioneringslag.
function getMenuPriceDeviations(event) {
    const rows = getDb().prepare(`
        SELECT bl.grocy_recipe_id AS grocy_recipe_id,
               bl.product_name    AS product_name,
               bl.unit_price      AS unit_price
        FROM bons b
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ?
          AND COALESCE(pc.code, '') != 'produktion'
          AND COALESCE(b.total_price, 0) >= 0
          ${EXCLUDE_CANCELLED_SQL}
        GROUP BY bl.grocy_recipe_id, bl.product_name, bl.unit_price
    `).all(event.id);

    const byKey = new Map();
    for (const r of rows) {
        const k = menuKey(r.grocy_recipe_id, r.product_name);
        if (!byKey.has(k)) byKey.set(k, new Set());
        byKey.get(k).add(Math.round((r.unit_price ?? 0) * 100) / 100);
    }
    return byKey;
}

// Byg menu-svaret: rækker + afvigelses-markering pr. række.
function buildMenuResponse(event) {
    const items = getMenuItems(event.id);
    const sold  = getMenuPriceDeviations(event);
    for (const it of items) {
        const prices = sold.get(menuKey(it.grocy_recipe_id, it.product_name));
        const menuPrice = Math.round((it.unit_price ?? 0) * 100) / 100;
        const differing = prices ? [...prices].filter(p => p !== menuPrice) : [];
        it.sold_prices     = prices ? [...prices].sort((a, b) => a - b) : [];
        it.price_deviation = differing.length > 0;
    }
    return { items };
}

router.get('/:id/menu', requireAuth(), handle((req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    res.json(buildMenuResponse(event));
}));

// PUT erstatter hele menuen for eventet (idempotent reconcile — samme mønster
// som /forecast). Klienten sender altid den fulde liste.
router.put('/:id/menu', requireAuth(), handle((req, res) => {
    const db = getDb();
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items (array) er påkrævet' });

    // Valider FØR vi rører databasen, så et halvt gyldigt payload ikke kan
    // efterlade menuen delvist skrevet.
    const clean = [];
    const seen  = new Set();
    for (const [i, it] of items.entries()) {
        const name = String(it.product_name ?? '').trim();
        if (!name) return res.status(400).json({ error: 'product_name er påkrævet på alle linjer' });
        const price = Number(it.unit_price);
        if (!Number.isFinite(price) || price < 0) {
            return res.status(400).json({ error: `Ugyldig pris på "${name}"` });
        }
        const rid = it.grocy_recipe_id != null ? parseInt(it.grocy_recipe_id, 10) : null;
        if (rid != null && !Number.isInteger(rid)) {
            return res.status(400).json({ error: `Ugyldigt grocy_recipe_id på "${name}"` });
        }
        const k = menuKey(rid, name);
        if (seen.has(k)) return res.status(400).json({ error: `"${name}" optræder to gange i menuen` });
        seen.add(k);
        // Tilvalg (§ migration 135): item_type='option' + applies_to = menuKeys.
        const itemType = it.item_type === 'option' ? 'option' : 'dish';
        let appliesTo = null;
        if (itemType === 'option') {
            const raw = Array.isArray(it.applies_to) ? it.applies_to : [];
            const keys = raw.map(s => String(s).trim()).filter(Boolean);
            appliesTo = keys.length ? JSON.stringify(keys) : null;
        }
        clean.push({
            grocy_recipe_id: rid,
            product_name:    name,
            category:        it.category ? String(it.category).trim() : null,
            unit:            it.unit ? String(it.unit).trim() : 'stk',
            unit_price:      Math.round(price * 100) / 100,
            sort_order:      Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : i,
            note:            it.note ? String(it.note).trim() : null,
            item_type:       itemType,
            applies_to:      appliesTo,
        });
    }

    transaction(db, () => {
        db.prepare(`DELETE FROM event_menu_items WHERE event_id = ?`).run(event.id);
        const ins = db.prepare(`
            INSERT INTO event_menu_items
                (event_id, grocy_recipe_id, product_name, category, unit, unit_price, sort_order, note,
                 item_type, applies_to, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        for (const c of clean) {
            ins.run(event.id, c.grocy_recipe_id, c.product_name, c.category,
                    c.unit, c.unit_price, c.sort_order, c.note,
                    c.item_type, c.applies_to);
        }
    });
    logChange({ entityType: 'event', entityId: event.id, action: 'update', fieldName: 'menu', userId: req.session?.userId });
    broadcast('event_updated', { id: event.id });
    res.json(buildMenuResponse(event));
}));

// Generér = RESYNC, ikke additiv (§16):
//   • genskaber manglende prep-afledte linjer — også dem der er slettet
//     (det er reset-knappen)
//   • rører ALDRIG prisen på linjer der allerede findes. Ellers ville et tryk
//     her — fordi nogen lige tilføjede en vare til prep-bonnen — nulstille alle
//     on-site-justerede priser tilbage til Grocys festivalpris
//   • manuelle linjer (dem prep ikke kender) overlever urørt
router.post('/:id/menu/generate', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });

    const prepRows = getPrepAggregate(event);
    const existing = getMenuItems(event.id);
    const existingKeys = new Set(existing.map(it => menuKey(it.grocy_recipe_id, it.product_name)));

    let recById = {};
    let grocyFailed = false;
    try {
        for (const r of await grocy.getRecipes()) recById[r.id] = r;
    } catch (err) {
        console.warn('[events] menu/generate: kunne ikke hente Grocy-priser:', err.message);
        grocyFailed = true;
    }

    // Nye linjer lægges efter de eksisterende, så en manuelt sat rækkefølge
    // ikke rykker rundt hver gang der resyncs.
    let nextSort = existing.reduce((m, it) => Math.max(m, it.sort_order ?? 0), -1) + 1;
    const toAdd = [];
    const seenNew = new Set();
    for (const r of prepRows) {
        const k = menuKey(r.grocy_recipe_id, r.product_name);
        if (existingKeys.has(k) || seenNew.has(k)) continue;   // findes ⇒ prisen bevares
        seenNew.add(k);
        const rec = r.grocy_recipe_id ? recById[r.grocy_recipe_id] : null;
        toAdd.push({
            grocy_recipe_id: r.grocy_recipe_id ?? null,
            product_name:    r.product_name,
            category:        r.category ?? null,
            unit:            r.unit ?? 'stk',
            unit_price:      rec ? (rec.prices?.festival ?? 0) : 0,
            sort_order:      nextSort++,
        });
    }

    if (toAdd.length > 0) {
        transaction(db, () => {
            const ins = db.prepare(`
                INSERT INTO event_menu_items
                    (event_id, grocy_recipe_id, product_name, category, unit, unit_price, sort_order, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const a of toAdd) {
                ins.run(event.id, a.grocy_recipe_id, a.product_name, a.category,
                        a.unit, a.unit_price, a.sort_order);
            }
        });
        logChange({ entityType: 'event', entityId: event.id, action: 'update', fieldName: 'menu', userId: req.session?.userId });
        broadcast('event_updated', { id: event.id });
    }

    // Grocy-fejlen advares der kun om når den faktisk fik en konsekvens — dvs.
    // når der blev oprettet linjer der så mangler deres pris. Var menuen i
    // forvejen i sync, ændrede fejlen intet, og advarslen ville være støj.
    const warnings = (grocyFailed && toAdd.length > 0)
        ? ['Grocy-priser kunne ikke hentes — de nye linjer fik pris 0 og skal udfyldes i hånden.']
        : [];

    res.json({
        ...buildMenuResponse(event),
        added: toAdd.length,
        kept:  existing.length,
        warnings,
    });
}));

// ─── SALGS-BON PRE-FILL (menu-punkter fra prep-bonnerne) ───────────────────
// Salgsbonnen pre-udfyldes med de FÆRDIGE menuer fra eventets prep-bonner —
// det vi tog med fra HQ. Vi sælger hele menuer, ikke pakkelistens råvarer, så
// kilden er prep-bonnernes bon_lines (færdig-produkt-niveau), ikke pakkelisten.
//
// Beslutninger (Leif, jun 2026):
//   • KUN prep-rollen tæller (ikke top-up).
//   • Antal = summen af preppet pr. produkt på tværs af eventets prep-bonner
//     (union). Det er et START-gæt — justeres NED for spild, smagsprøver, ting
//     der ryger på gulvet osv. (differencen = svind, jf. §6's retur/spild).
//   • Pris = FESTIVAL-salgspris fra Grocy. Events/festivaler sælger til
//     festivalpris (afviger fra spec §3's 'catering' — forretningsbeslutning).
// Aggregér salgs-bon pre-fill for et event. Testbar helper (jf.
// computeEventPnL/Cost/CO2) — ruten kalder bare denne + res.json.
async function computeSalesPrefill(event) {
    // Antallet kommer fra prep-bonnerne (hvad vi fysisk tog med). Prisen
    // kommer fra eventets menu når den findes — ellers falder vi tilbage til
    // Grocys festivalpris som før (bagudkompatibelt for events oprettet inden
    // menuen fandtes).
    const rows = getPrepAggregate(event);
    const menu = getMenuItems(event.id);
    if (rows.length === 0 && menu.length === 0) {
        return { lines: [], price_category_code: 'festival', price_source: 'grocy' };
    }

    // Kostpris/CO₂ er stadig Grocy-snapshots — menuen holder kun salgsprisen.
    let recById = {};
    try {
        const recipes = await grocy.getRecipes();
        for (const r of recipes) recById[r.id] = r;
    } catch (err) {
        console.warn('[events] sales-prefill: kunne ikke hente Grocy-priser:', err.message);
    }

    const menuByKey = new Map(menu.map(m => [menuKey(m.grocy_recipe_id, m.product_name), m]));
    const usingMenu = menu.length > 0;

    const buildLine = (r, qty, menuItem) => {
        const rec = r.grocy_recipe_id ? recById[r.grocy_recipe_id] : null;
        return {
            grocy_recipe_id: r.grocy_recipe_id ?? null,
            product_name:    r.product_name,
            category:        r.category ?? null,
            unit:            r.unit ?? 'stk',
            quantity:        qty,
            // Menuprisen er INCL moms og matcher bon_lines.unit_price direkte
            // (§6b) — ingen konvertering her.
            unit_price:      menuItem ? menuItem.unit_price : (rec ? (rec.prices?.festival ?? 0) : 0),
            cost_price:      rec ? (rec.cost_price ?? null) : null,
            co2e:            rec ? (rec.co2e ?? null) : null,
        };
    };

    const lines = [];
    const usedMenuKeys = new Set();
    for (const r of rows) {
        const k = menuKey(r.grocy_recipe_id, r.product_name);
        const m = menuByKey.get(k);
        if (m) usedMenuKeys.add(k);
        lines.push(buildLine(r, r.qty, m));
    }

    // Menupunkter uden prep — typisk en ret fundet på pladsen. De skal med i
    // prefillen med antal 0, ellers skal de tastes som fritekst hver eneste dag
    // (præcis det problem menuen findes for at løse).
    for (const m of menu) {
        const k = menuKey(m.grocy_recipe_id, m.product_name);
        if (usedMenuKeys.has(k)) continue;
        lines.push(buildLine(m, 0, m));
    }

    return { lines, price_category_code: 'festival', price_source: usingMenu ? 'menu' : 'grocy' };
}

router.get('/:id/sales-prefill', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    res.json(await computeSalesPrefill(event));
}));

// ─── TOP-UP-FORSLAG (§6) ───────────────────────────────────────────────────
// Morgen-beregning: forecast_dag_N − beregnet rest på pladsen. Se helper-
// kommentaren ved computeTopupSuggestion for formler og antagelser.

router.get('/:id/topup-suggestion', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const date = req.query.date || event.start_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date skal være YYYY-MM-DD' });
    }
    res.json(await computeTopupSuggestion(event, date));
}));

// ─── FORECAST CRUD (pr-kategori, pr-dag) ───────────────────────────────────
// PUT erstatter hele forecast-tabellen for eventet (idempotent reconcile).
// Tomme/0-værdier slettes så vi ikke akkumulerer støj.

router.put('/:id/forecast', requireAuth(), handle((req, res) => {
    const db = getDb();
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items (array) er påkrævet' });

    transaction(db, () => {
        db.prepare(`DELETE FROM event_forecast WHERE event_id = ?`).run(event.id);
        const ins = db.prepare(`
            INSERT INTO event_forecast (event_id, forecast_date, category, expected_qty, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        for (const it of items) {
            const qty = Math.max(0, parseInt(it.expected_qty, 10) || 0);
            if (qty === 0) continue;
            if (!it.forecast_date || !it.category) continue;
            ins.run(event.id, it.forecast_date, String(it.category).trim(), qty, it.notes ?? null);
        }
    });
    logChange({ entityType: 'event', entityId: event.id, action: 'update', fieldName: 'forecast', userId: req.session?.userId });
    broadcast('event_updated', { id: event.id });
    const forecast = db.prepare(`
        SELECT id, forecast_date, category, expected_qty, notes
        FROM event_forecast WHERE event_id = ? ORDER BY forecast_date, category
    `).all(event.id);
    res.json({ forecast });
}));

// ─── EVENT-BON GENERATOR ───────────────────────────────────────────────────
// Ét generelt endpoint der opretter en bon bundet til eventet, med linjer.
// `role` styrer:
//   - 'prep' / 'topup'  → price_category='produktion', status=GODKENDT (på køkkenets tavle)
//   - 'sales'           → price_category='festival' (default), status=BETALT (solgt + betalt på stedet)
//   - 'expense'         → price_category='festival' (default), status=GODKENDT, negativ total
// Bonen behandles efterfølgende via normale status-skift (KLAR/LEVERET/BETALT)
// — gaten i autoConsumeBonInventory tager sig af lager-konsekvenserne.

router.post('/:id/bons', requireAuth(), handle((req, res) => {
    const db = getDb();
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const b = req.body;
    const role = b.role;
    if (!['prep','topup','sales','expense'].includes(role)) {
        return res.status(400).json({ error: "role skal være prep/topup/sales/expense" });
    }
    if (!Array.isArray(b.lines) || b.lines.length === 0) {
        return res.status(400).json({ error: 'lines (array) er påkrævet' });
    }

    // Priskategori. Prep/top-up = produktion (0 kr). Salg/udgift defaulter til
    // FESTIVAL — events/festivaler sælges til festivalpris (Leif, jun 2026;
    // afviger fra spec §3's 'catering'). Frontenden kan overskrive via
    // b.price_category_code.
    const isProduction = (role === 'prep' || role === 'topup');
    const pcCode  = isProduction ? 'produktion' : (b.price_category_code ?? 'festival');
    const pc      = getPriceCategoryByCode(pcCode);
    if (!pc) return res.status(500).json({ error: `Priskategori '${pcCode}' findes ikke i price_categories` });

    // Status-default afhænger af rolle:
    //   sales → BETALT. En event-salgsbon registreres FRA en salgsrapport — varerne
    //     er solgt og pengene indkasseret på stedet (POS-konvention, jf. status-flow).
    //     BETALT er en REVENUE_CODE, så omsætningen tæller med i økonomirapporten med
    //     det samme uden et manuelt status-flip. Springer LEVERET over med vilje:
    //     auto-consume fyrer kun på LEVERET, og prep-bonnerne ejer allerede HQ-lager-
    //     trækket (§5-gaten) — en salgsbon må ikke dobbelt-trække.
    //   prep/topup/expense → GODKENDT. Prep/top-up er bevidst genereret arbejde der skal
    //     på køkkenets I dag-tavle (viser kun GODKENDT/IGANG/KLAR/LEVERET). Udgift netter
    //     ikke mod omsætning (is_internal=1).
    // Brugeren kan altid overskrive med b.status_code.
    const defaultStatus = role === 'sales' ? 'BETALT' : 'GODKENDT';
    const startStatus = b.status_code ?? defaultStatus;
    const statusId = getStatusId(startStatus);
    if (!statusId) return res.status(400).json({ error: `Ukendt status: ${startStatus}` });

    const bonNumber = nextBonNumber();
    const deliveryDate = b.delivery_date ?? event.start_date;
    const orderDate    = b.order_date ?? todayISO();
    const addressId    = resolveEventAddressId(event);

    // Kontaktperson arves fra eventet (migration 139) med mindre kaldet
    // sætter noget selv. Uden den stod event-bons uden kunde — køkkenets
    // kort viste "Ukendt", og kontoret tastede samme person ind på hver bon.
    const contact = eventContactFields(event);

    const result = transaction(db, () => {
        const r = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, price_category_id, price_category, event_id, event_role,
                order_date, delivery_date, pickup_time, delivery_time,
                delivery_type, delivery_address_id, pax, total_units, payment_type,
                customer_id, company_id, day_contact_name, day_contact_phone,
                kitchen_info, customer_wishes, internal_notes,
                created_by_user_id, is_internal,
                total_price, total_with_delivery,
                prep_ingredients_ready, prep_supplies_ready, kitchen_selects, customer_collects,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                0, 0,
                0, 0, 0, 0,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `).run(
            bonNumber, statusId, event.location_id, pc.id, pc.code, event.id, role,
            orderDate, deliveryDate, b.pickup_time ?? null, b.delivery_time ?? null,
            b.delivery_type ?? 'event', addressId, b.pax ?? 0, 0, b.payment_type ?? (isProduction ? 'cash' : 'cash'),
            b.customer_id ?? contact.customer_id, b.company_id ?? contact.company_id,
            b.day_contact_name ?? contact.day_contact_name, b.day_contact_phone ?? contact.day_contact_phone,
            b.kitchen_info ?? null, b.customer_wishes ?? null, b.internal_notes ?? null,
            req.session?.userId ?? null, role === 'expense' ? 1 : 0
        );
        const bonId = r.lastInsertRowid;

        // Indsæt linjer.
        let total = 0;
        const sign = role === 'expense' ? -1 : 1;
        for (const [i, line] of b.lines.entries()) {
            const qty       = Number(line.quantity ?? 1);
            const unitPrice = Number(line.unit_price ?? 0);
            const lineTotal = sign * qty * unitPrice;
            total += lineTotal;
            // Moms-markering: kun udgiftslinjer må være ex moms (0). Alle andre
            // linjetyper holder doktrin-default'en incl moms (1) uanset payload.
            const momsIncluded = (role === 'expense' && Number(line.moms_included) === 0) ? 0 : 1;
            db.prepare(`
                INSERT INTO bon_lines (
                    bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                    special_request, unit_price, line_total, cost_price, co2e,
                    moms_included, sort_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                bonId,
                line.grocy_recipe_id ?? null,
                line.product_name,
                line.category ?? null,
                qty,
                line.unit ?? 'stk',
                line.special_request ?? null,
                sign * unitPrice,
                lineTotal,
                line.cost_price ?? null,
                line.co2e ?? null,
                momsIncluded,
                i
            );
        }
        db.prepare(`UPDATE bons SET total_price = ?, total_with_delivery = ? WHERE id = ?`).run(total, total, bonId);
        recalcBonTotalUnits(db, bonId);
        return bonId;
    });

    logChange({
        entityType: 'bon', entityId: result, action: 'create',
        newValue: `${bonNumber} (event:${event.name}, role:${role})`,
        userId: req.session?.userId
    });
    broadcast('bon_created', { id: result, bon_number: bonNumber, event_id: event.id });
    broadcast('event_updated', { id: event.id });
    res.status(201).json(getBon(result));
}));

// ─── RETUR / HJEMKOMST (§6) ────────────────────────────────────────────────
// Beregner event-beholdning pr. råvare (prep+topup − solgt) som forslag.
// Køkkenet tæller fysisk og justerer, og bogfører returen som lager-add til HQ.

router.get('/:id/return-suggestion', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const suggestion = await computeReturnSuggestion(event);
    res.json(suggestion);
}));

router.post('/:id/return', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items (array) er påkrævet' });

    // Parent-produkter med no_own_stock=1 (fx "kål" → Hvidkål/Spidskål) kan ikke
    // modtage lager direkte i Grocy. Vi omdirigerer returen til det barn der
    // FAKTISK HAR VARER PÅ LAGER (det der er i brug) — fald tilbage til første
    // aktive barn hvis ingen har lager. Samme tankegang som consume's
    // børn-substitution. Byg parent→børn-map + stock-map.
    let prodMap = new Map(), childrenByParent = new Map(), stockByPid = new Map();
    try {
        const [products, stock] = await Promise.all([grocy.getProducts(), grocy.getStock()]);
        prodMap = new Map(products.map(p => [parseInt(p.id), p]));
        for (const s of stock) stockByPid.set(parseInt(s.product_id), parseFloat(s.amount) || 0);
        for (const p of products) {
            if (p.parent_product_id) {
                const par = parseInt(p.parent_product_id);
                if (!childrenByParent.has(par)) childrenByParent.set(par, []);
                childrenByParent.get(par).push(p);
            }
        }
    } catch (err) {
        console.warn('[events] kunne ikke hente produkter/stock til parent-resolve:', err.message);
    }
    function resolveAddTarget(pid) {
        const prod = prodMap.get(pid);
        if (prod && String(prod.no_own_stock) === '1') {
            const kids = (childrenByParent.get(pid) || []).filter(k => String(k.active) !== '0');
            if (kids.length) {
                // Vælg barnet med mest lager (det der er i brug); ellers første
                const sorted = kids.slice().sort((a, b) =>
                    (stockByPid.get(parseInt(b.id)) || 0) - (stockByPid.get(parseInt(a.id)) || 0));
                return parseInt(sorted[0].id);
            }
        }
        return pid;
    }

    // Læg hver talt rest tilbage på HQ-lageret via Grocy stock-add. Sekventielt
    // så fejlede produkter er kendte; partial success tilladt (fortsæt ved fejl).
    const results = [];
    for (const it of items) {
        const pid = parseInt(it.product_id);
        const amt = Number(it.amount);
        if (!pid || Number.isNaN(amt) || amt <= 0) continue;
        const target = resolveAddTarget(pid);
        try {
            await grocy.addToStock(target, amt);
            const r = { product_id: pid, amount: amt, success: true };
            if (target !== pid) r.added_to_child = target;
            results.push(r);
        } catch (err) {
            results.push({ product_id: pid, amount: amt, success: false, error: err.message });
        }
    }
    const ok = results.filter(r => r.success).length;
    logChange({
        entityType: 'event', entityId: event.id, action: 'update', fieldName: 'return',
        newValue: `retur bogført: ${ok}/${results.length} produkter lagt på HQ-lager`,
        userId: req.session?.userId,
    });
    broadcast('event_updated', { id: event.id });
    res.json({ results, returned_count: ok });
}));

module.exports = router;
// Eksponér rene helpers til test (rammer den ægte aggregering + festival-opslag).
module.exports.computeSalesPrefill = computeSalesPrefill;
module.exports.computeTopupSuggestion = computeTopupSuggestion;
module.exports.allocateInteger = allocateInteger;
module.exports.getEventBons = getEventBons;
module.exports.computeEventPnL = computeEventPnL;
module.exports.computeEventCost = computeEventCost;
module.exports.computeEventCO2 = computeEventCO2;
module.exports.computeEventExpenses = computeEventExpenses;
module.exports.computeReturnSuggestion = computeReturnSuggestion;
module.exports.getPrepAggregate = getPrepAggregate;
module.exports.getMenuItems = getMenuItems;
module.exports.buildMenuResponse = buildMenuResponse;
module.exports.menuKey = menuKey;
module.exports.eventContactFields = eventContactFields;
