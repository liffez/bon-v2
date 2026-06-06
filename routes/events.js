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
    handle, logChange, getBon, getStatusId, getDefaultLocationId,
    todayISO, nextBonNumber, recalcBonTotalUnits, transaction,
    inclToExcl
} = require('../db/helpers');
const { getDb }    = require('../db/database');
const { broadcast } = require('../shared/sse');
const { requireAuth } = require('../shared/auth');
const grocy = require('../services/grocyAdapter');

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
               b.inventory_deducted,
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
function classifyRole(bon, eventStart) {
    if (bon.price_category_code === 'produktion') {
        // Første produktionsbon (efter oprettelsestid) = prep; resten = top-up
        return bon._is_first_production ? 'prep' : 'topup';
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

// ─── EVENTS — CRUD ─────────────────────────────────────────────────────────

router.get('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { status } = req.query;
    let where = '1=1', params = [];
    if (status) { where += ' AND e.status = ?'; params.push(status); }
    const rows = db.prepare(`
        SELECT e.id, e.name, e.model, e.start_date, e.end_date, e.status,
               e.location_id, l.name AS location_name, l.code AS location_code,
               e.notes, e.created_at,
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
        INSERT INTO events (name, location_id, model, start_date, end_date, status, notes, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        b.name, locationId, model, b.start_date,
        b.end_date ?? null, b.status ?? 'planning',
        b.notes ?? null,
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
    const ALLOWED = ['name','start_date','end_date','status','notes','model','location_id'];
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

// ─── EVENT OVERBLIK ────────────────────────────────────────────────────────

router.get('/:id/overview', requireAuth(), handle(async (req, res) => {
    const event = getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event ikke fundet' });
    const bons = getEventBons(event.id);
    // Marker første produktionsbon som "prep" (oprettelsesrækkefølge).
    let seenProduction = false;
    for (const b of bons) {
        if (b.price_category_code === 'produktion') {
            b._is_first_production = !seenProduction;
            seenProduction = true;
        }
        b.role = classifyRole(b, event.start_date);
        delete b._is_first_production;
    }
    const pnl = computeEventPnL(bons);
    pnl.cost_estimated = computeEventCost(event.id);
    pnl.result = Math.round((pnl.revenue_excl - pnl.cost_estimated - pnl.expenses) * 100) / 100;

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

    res.json({ event, bons, pnl, forecast, days, categories });
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
//   - 'prep' / 'topup'  → price_category='produktion', status=NY (køkkenet ser den)
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

    // Priskategori
    const isProduction = (role === 'prep' || role === 'topup');
    const pcCode  = isProduction ? 'produktion' : (b.price_category_code ?? 'catering');
    const pc      = getPriceCategoryByCode(pcCode);
    if (!pc) return res.status(500).json({ error: `Priskategori '${pcCode}' findes ikke i price_categories` });

    // Status: prep/topup = NY (køkkenet prepper), sales/expense = GODKENDT.
    // Brugeren kan overskrive med b.status_code (fx hvis salgsbonnen registreres
    // efter levering og skal hoppe direkte til LEVERET).
    const startStatus = b.status_code ?? (isProduction ? 'NY' : 'GODKENDT');
    const statusId = getStatusId(startStatus);
    if (!statusId) return res.status(400).json({ error: `Ukendt status: ${startStatus}` });

    const bonNumber = nextBonNumber();
    const deliveryDate = b.delivery_date ?? event.start_date;
    const orderDate    = b.order_date ?? todayISO();

    const result = transaction(db, () => {
        const r = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, price_category_id, price_category, event_id,
                order_date, delivery_date, pickup_time, delivery_time,
                delivery_type, pax, total_units, payment_type,
                kitchen_info, customer_wishes, internal_notes,
                created_by_user_id, is_internal,
                total_price, total_with_delivery,
                prep_ingredients_ready, prep_supplies_ready, kitchen_selects, customer_collects,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                0, 0,
                0, 0, 0, 0,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `).run(
            bonNumber, statusId, event.location_id, pc.id, pc.code, event.id,
            orderDate, deliveryDate, b.pickup_time ?? null, b.delivery_time ?? null,
            b.delivery_type ?? 'event', b.pax ?? 0, 0, b.payment_type ?? (isProduction ? 'cash' : 'cash'),
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

module.exports = router;
