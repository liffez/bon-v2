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
        SELECT e.*, l.name AS location_name, l.code AS location_code
        FROM events e
        JOIN locations l ON e.location_id = l.id
        WHERE e.id = ?
    `).get(id);
}

// Hent alle bons for et event, joinet med priskategori + status, sorteret efter rolle.
function getEventBons(eventId) {
    return getDb().prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
               b.pax, b.total_units, b.total_price, b.payment_type,
               b.created_at, b.kitchen_info, b.customer_wishes, b.internal_notes,
               b.inventory_deducted, b.event_role,
               sd.code  AS status_code,
               sd.label AS status_label,
               sd.color AS status_color,
               pc.code  AS price_category_code,
               pc.label AS price_category_label
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE b.event_id = ?
        ORDER BY b.delivery_date, b.created_at
    `).all(eventId);
}

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
    for (const b of bons) {
        const price = b.total_price ?? 0;
        if (b.price_category_code === 'produktion') continue;     // prep/top-up = 0 kr, irrelevant for P&L
        if (price < 0) expenses += -price;                         // udgiftsbon (negativ linje)
        else           revenue_incl += price;
    }
    // Vareforbrug = sum af cost_price * quantity på prep-bonner (ex moms).
    // For MVP: hentes via separat query for at undgå at slæbe linjer rundt.
    const revenue_excl = inclToExcl(revenue_incl);
    return {
        revenue_incl, revenue_excl,
        expenses, cost_estimated: cost,
        // P&L = omsætning ex moms − vareforbrug ex moms − udgifter
        result: Math.round((revenue_excl - cost - expenses) * 100) / 100
    };
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
    const bons = getEventBons(event.id);
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
               (SELECT COUNT(*) FROM bons WHERE event_id = e.id) AS bon_count
        FROM events e
        JOIN locations l ON e.location_id = l.id
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
        INSERT INTO events (name, location_id, model, start_date, end_date, status, notes, event_address, event_address_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        b.name, locationId, model, b.start_date,
        b.end_date ?? null, b.status ?? 'planning',
        b.notes ?? null, b.event_address ?? null,
        b.event_address_id ?? null,
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
    const ALLOWED = ['name','start_date','end_date','status','notes','model','location_id','event_address','event_address_id','open_hours_json'];
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
    pnl.result = Math.round((pnl.revenue_excl - pnl.cost_estimated - pnl.expenses) * 100) / 100;
    pnl.co2e_total = computeEventCO2(event.id);

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
        GROUP BY b.delivery_date, bl.category
    `).all(event.id);
    const prepped = {};   // "date|category" → qty
    for (const r of preppedRows) prepped[`${r.date}|${r.category}`] = r.qty;

    res.json({ event, bons, pnl, forecast, days, categories, prepped });
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
    // Find prep-bonnerne via samme rolle-klassifikation som overview viser.
    const bons = getEventBons(event.id);
    const seenProductionDates = new Set();
    for (const b of bons) {
        if (b.price_category_code === 'produktion') {
            b._is_first_production_on_date = !seenProductionDates.has(b.delivery_date);
            seenProductionDates.add(b.delivery_date);
        }
        b.role = classifyRole(b, event.start_date);
    }
    const prepIds = bons.filter(b => b.role === 'prep').map(b => b.id);
    if (prepIds.length === 0) return { lines: [], price_category_code: 'festival' };

    // Aggregér prep-linjer pr. produkt (grocy_recipe_id når sat, ellers navn).
    const ph = prepIds.map(() => '?').join(',');
    const rows = getDb().prepare(`
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

    // Festival-salgspris (+ kostpris/CO₂-snapshot) fra Grocy pr. opskrift.
    let recById = {};
    try {
        const recipes = await grocy.getRecipes();
        for (const r of recipes) recById[r.id] = r;
    } catch (err) {
        console.warn('[events] sales-prefill: kunne ikke hente Grocy-priser:', err.message);
    }

    const lines = rows.map(r => {
        const rec = r.grocy_recipe_id ? recById[r.grocy_recipe_id] : null;
        return {
            grocy_recipe_id: r.grocy_recipe_id ?? null,
            product_name:    r.product_name,
            category:        r.category ?? null,
            unit:            r.unit ?? 'stk',
            quantity:        r.qty,
            unit_price:      rec ? (rec.prices?.festival ?? 0) : 0,
            cost_price:      rec ? (rec.cost_price ?? null) : null,
            co2e:            rec ? (rec.co2e ?? null) : null,
        };
    });
    return { lines, price_category_code: 'festival' };
}

router.get('/:id/sales-prefill', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    res.json(await computeSalesPrefill(event));
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
//   - 'sales'           → price_category=catering (default), status=GODKENDT
//   - 'expense'         → price_category=catering, status=GODKENDT, negativ total
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

    // Status: alle roller starter på GODKENDT. Prep/top-up er bevidst genereret
    // arbejde (ikke en ubehandlet indkommende bestilling), og køkkenets I dag-
    // tavle viser kun GODKENDT/IGANG/KLAR/LEVERET — en NY-bon ville aldrig
    // dukke op der. Brugeren kan overskrive med b.status_code (fx hvis
    // salgsbonnen registreres efter levering og skal direkte til LEVERET).
    const startStatus = b.status_code ?? 'GODKENDT';
    const statusId = getStatusId(startStatus);
    if (!statusId) return res.status(400).json({ error: `Ukendt status: ${startStatus}` });

    const bonNumber = nextBonNumber();
    const deliveryDate = b.delivery_date ?? event.start_date;
    const orderDate    = b.order_date ?? todayISO();
    const addressId    = resolveEventAddressId(event);

    const result = transaction(db, () => {
        const r = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, price_category_id, price_category, event_id, event_role,
                order_date, delivery_date, pickup_time, delivery_time,
                delivery_type, delivery_address_id, pax, total_units, payment_type,
                kitchen_info, customer_wishes, internal_notes,
                created_by_user_id, is_internal,
                total_price, total_with_delivery,
                prep_ingredients_ready, prep_supplies_ready, kitchen_selects, customer_collects,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
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
            db.prepare(`
                INSERT INTO bon_lines (
                    bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                    special_request, unit_price, line_total, cost_price, co2e,
                    sort_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
// Eksponér ren helper til test (rammer den ægte aggregering + festival-opslag).
module.exports.computeSalesPrefill = computeSalesPrefill;
