/**
 * Event-bro — bro mellem event-order-3 (forudbestilling) og Bon v2.
 * Se docs/CLAUDE_EVENT_BON_BRIDGE.md.
 *
 * Public endpoints (uden for /api-gaten, monteres på /webhook med webhookCors).
 * Beskyttet af en OPTIONEL delt secret (settings.event_bridge_secret) — samme
 * mønster som web-order-webhooken: håndhæves kun hvis den er sat.
 *
 *   GET  /webhook/event-menu?menu=standard  — Ristet Rugs Grocy-menu (Fase 1)
 *   POST /webhook/event-prep                — aggregeret prep-bon pr. event-dag (Fase 3)
 *
 * Ansvarssnit (jf. broen-doc §2 + §8): Bon v2 ser ALDRIG individuelle
 * event-kunder — kun aggregatet "lav N af hver ret til denne dag".
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const {
    todayISO, getStatusId, nextBonNumber, recalcBonTotalUnits, transaction, logChange
} = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { resolveMenuItemLines } = require('../services/menuItemsToLines');
const grocyAdapter = require('../services/grocyAdapter');

// Statusser hvor prep-bonnen stadig må reconciles (opdateres fra broen).
// Så snart køkkenet starter (IGANG) eller lageret er trukket, fryser bonnen —
// ellers ville en genindsættelse desynke HQ-lageret. Dette (ikke deadline) er
// det der gør "bestillinger på dag 1 til dag 2" sikkert: hver dags prep-bon
// fryser uafhængigt når netop DEN dags produktion går i gang.
const RECONCILE_STATUSES = ['NY', 'GODKENDT'];

// ─── Secret (optionel — som web-orders) ────────────────────────────────────
// Returnerer true hvis kaldet må fortsætte; sender selv 401 og returnerer false ellers.
function checkBridgeSecret(req, res) {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'event_bridge_secret'").get();
    const secret = row?.value;
    if (secret && secret.length > 0) {
        if (req.headers['x-webhook-secret'] !== secret) {
            console.warn('[event-bridge] Forkert secret');
            res.status(401).json({ error: 'Unauthorized' });
            return false;
        }
    }
    return true;
}

// ─── Menu-builder (Grocy → event-order-3 item-format) ──────────────────────
// Genbruger samme kategori/skjul/tags-logik som routes/embed.js, men tilføjer
// festival-pris i ØRE (event-order-3 arbejder i øre internt). Festival-prisen
// er INCL moms (Grocy sales-userfields er incl moms) — det er den pris kunden
// faktisk betaler, så ingen moms-omregning her.
//
// `deps` kan injiceres i test (getRecipes/getRecipesRaw) uden at røre Grocy.
function buildCategoryId(name) {
    return String(name || 'andet')
        .toLowerCase()
        .replace(/[æøå]/g, c => ({ 'æ': 'ae', 'ø': 'oe', 'å': 'aa' }[c]))
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'andet';
}

async function buildBridgeMenu(menuId = 'standard', deps = grocyAdapter) {
    const recipes = await deps.getRecipes();
    const raw = await deps.getRecipesRaw();
    const ufById = {};
    for (const r of raw) ufById[r.id] = r.userfields || {};

    const categoriesMap = new Map(); // name → slug-id
    const items = [];

    for (const r of recipes) {
        const uf = ufById[r.id] || {};
        if (String(uf.bestil_skjul) === '1') continue;

        const catName = r.category || 'Andet';
        if (!categoriesMap.has(catName)) {
            categoriesMap.set(catName, buildCategoryId(catName));
        }
        const categoryId = categoriesMap.get(catName);

        const tags = String(uf.bestil_tags || '')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        const festival = Number(r.prices?.festival) || 0;

        items.push({
            id: 'r' + r.id,                       // stabil Grocy-reference — flyder gennem event-order-3
            name: r.name,
            category: categoryId,
            price: Math.round(festival * 100),    // øre (incl moms)
            tags,
            allergens: String(uf.bestil_allergens || '').trim(),
            active: true
        });
    }

    const categories = Array.from(categoriesMap.entries()).map(([name, id]) => ({ id, name }));

    return {
        menu_id: menuId,
        name: 'Ristet Rug (Grocy)',
        version: todayISO(),
        source: 'grocy-bridge',
        categories,
        items
    };
}

// ─── GET /webhook/event-menu ───────────────────────────────────────────────
router.get('/event-menu', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const menuId = req.query.menu || 'standard';
        const menu = await buildBridgeMenu(menuId);
        res.json(menu);
    } catch (err) {
        console.error('[event-bridge] menu-fejl:', err);
        res.status(500).json({ error: 'menu_failed' });
    }
});

// ─── Prep-bon: aggregat → linjer ───────────────────────────────────────────
// Oversætter broens payload {grocy_recipe_id, antal} → prissatte prep-linjer via
// den delte resolveMenuItemLines (samme som web-order-flowet). priceCategory =
// 'produktion' → produktion-priser (typisk 0); kostpris + CO₂ snapshottes til P&L.
// `deps` kan injiceres i test.
async function resolvePrepLines(lines, deps = grocyAdapter) {
    const recipes = await deps.getRecipes();
    const recipesById = new Map(recipes.map(r => [r.id, r]));
    const menuItems = (lines || []).map(l => ({
        id: 'r' + Number(l.grocy_recipe_id),
        count: Number(l.antal ?? l.count ?? 0)
    }));
    return resolveMenuItemLines({ menuItems, recipesById, priceCategory: 'produktion' });
}

function getBridgeEvent(db, id) {
    return db.prepare(
        `SELECT id, name, location_id, start_date, end_date, event_address_id FROM events WHERE id = ?`
    ).get(id);
}

function findPrepBon(db, eventId, date) {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.inventory_deducted, sd.code AS status_code
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.event_id = ? AND b.delivery_date = ? AND b.event_role = 'prep'
          AND b.status_id != (SELECT id FROM status_definitions WHERE code = 'AFLYST')
        ORDER BY b.created_at
        LIMIT 1
    `).get(eventId, date);
}

// Indsæt prep-linjer + opdatér totaler. Bruges af både opret og reconcile.
function insertPrepLines(db, bonId, resolved) {
    let total = 0;
    resolved.forEach((line, i) => {
        const qty       = Number(line.quantity ?? 0);
        const unitPrice = Number(line.unit_price ?? 0);   // produktion = 0
        const lineTotal = qty * unitPrice;
        total += lineTotal;
        db.prepare(`
            INSERT INTO bon_lines (
                bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                unit_price, line_total, cost_price, co2e, moms_included, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
            bonId, line.grocy_recipe_id ?? null, line.product_name, line.category ?? null,
            qty, line.unit ?? 'stk', unitPrice, lineTotal, line.cost_price ?? null, line.co2e ?? null, i
        );
    });
    db.prepare(`UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(total, total, bonId);
    recalcBonTotalUnits(db, bonId);
}

// Kernen: find-eller-opret prep-bon for (event, dato) og reconcile linjer.
// Ren funktion (db injiceres) så den kan testes uden HTTP/server.
// Returnerer { action: 'created'|'updated'|'frozen', bonId, bonNumber, status? }.
function applyPrepPush(db, { event, date, resolved, userId = null }) {
    const existing = findPrepBon(db, event.id, date);

    // Frys: i gang / leveret må ikke muteres (lager kan være trukket).
    if (existing && (existing.inventory_deducted === 1 || !RECONCILE_STATUSES.includes(existing.status_code))) {
        return { action: 'frozen', bonId: existing.id, bonNumber: existing.bon_number, status: existing.status_code };
    }

    if (existing) {
        transaction(db, () => {
            db.prepare(`DELETE FROM bon_lines WHERE bon_id = ?`).run(existing.id);
            insertPrepLines(db, existing.id, resolved);
        });
        logChange({
            entityType: 'bon', entityId: existing.id, action: 'update', fieldName: 'event_bridge',
            newValue: `prep opdateret fra event-bro (${resolved.length} linjer)`, userId
        });
        broadcast('bon_updated', { id: existing.id, event_id: event.id });
        broadcast('event_updated', { id: event.id });
        return { action: 'updated', bonId: existing.id, bonNumber: existing.bon_number };
    }

    // Opret ny prep-bon — spejler generatoren (role=prep, produktion, GODKENDT).
    const pc = db.prepare(`SELECT id, code FROM price_categories WHERE code = 'produktion' AND is_active = 1`).get();
    if (!pc) throw new Error("Priskategori 'produktion' findes ikke");
    const statusId = getStatusId('GODKENDT');
    const bonNumber = nextBonNumber();

    const bonId = transaction(db, () => {
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
            bonNumber, statusId, event.location_id, pc.id, pc.code, event.id, 'prep',
            todayISO(), date, null, null,
            'event', event.event_address_id ?? null, 0, 0, 'cash',
            null, null, null,
            userId, 0
        );
        const id = r.lastInsertRowid;
        insertPrepLines(db, id, resolved);
        return id;
    });

    logChange({
        entityType: 'bon', entityId: bonId, action: 'create', fieldName: 'event_bridge',
        newValue: `${bonNumber} (event-bro prep, event:${event.name}, ${date})`, userId
    });
    broadcast('bon_created', { id: bonId, bon_number: bonNumber, event_id: event.id });
    broadcast('event_updated', { id: event.id });
    return { action: 'created', bonId, bonNumber };
}

// ─── POST /webhook/event-prep ──────────────────────────────────────────────
router.post('/event-prep', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const db = getDb();
        const eventId = Number(req.body.event_id);
        const date = String(req.body.date || '').trim();
        const lines = req.body.lines;

        if (!eventId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(lines) || lines.length === 0) {
            return res.status(400).json({ error: 'event_id, date (YYYY-MM-DD) og lines (non-empty array) er påkrævet' });
        }

        const event = getBridgeEvent(db, eventId);
        if (!event) return res.status(404).json({ error: 'Event ikke fundet' });

        const { lines: resolved, unmatched } = await resolvePrepLines(lines);
        if (resolved.length === 0) {
            return res.status(422).json({ error: 'ingen linjer kunne mappes til Grocy-opskrifter', unmatched });
        }

        const result = applyPrepPush(db, { event, date, resolved, userId: null });
        const status = result.action === 'created' ? 201 : 200;
        return res.status(status).json({
            ok: true,
            action: result.action,
            bon_id: result.bonId,
            bon_number: result.bonNumber,
            ...(result.status ? { status: result.status } : {}),
            lines: resolved.length,
            unmatched
        });
    } catch (err) {
        console.error('[event-bridge] prep-fejl:', err);
        return res.status(500).json({ error: 'prep_failed' });
    }
});

module.exports = router;
module.exports.buildBridgeMenu = buildBridgeMenu;
module.exports.buildCategoryId = buildCategoryId;
module.exports.checkBridgeSecret = checkBridgeSecret;
module.exports.resolvePrepLines = resolvePrepLines;
module.exports.applyPrepPush = applyPrepPush;
module.exports.findPrepBon = findPrepBon;
