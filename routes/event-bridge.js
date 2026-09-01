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
const { eventContactFields, resolveActiveOrderEvent, reconcileRestBonsForEvent } = require('./events');
const grocyAdapter = require('../services/grocyAdapter');

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
            // Kundevendt salgstekst — IKKE Grocys egen `description`, som er
            // produktions-noter ("skæres med blad nr 2 på Robocut").
            description: String(uf.bestil_beskrivelse || '').trim(),
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

// Event-specifik menu: den KURATEREDE prisliste fra event_menu_items (office's
// "Menu & priser"-panel på eventet — udvalgte retter, event-priser, rækkefølge).
// Returnerer null hvis eventet ingen menu har → kalderen falder tilbage til hele
// Grocy-menuen. unit_price er INCL moms (§6b) → øre uden moms-omregning.
function buildEventMenu(db, eventId, menuId = 'standard') {
    const rows = db.prepare(`
        SELECT id, grocy_recipe_id, product_name, category, unit_price, sort_order, note, item_type, applies_to
        FROM event_menu_items WHERE event_id = ? ORDER BY sort_order, id
    `).all(eventId);
    if (!rows.length) return null;

    // Stabil nøgle — SKAL matche menuKey() i routes/events.js (applies_to peger på den).
    const keyOf = r => r.grocy_recipe_id
        ? `r:${r.grocy_recipe_id}`
        : `n:${String(r.product_name || '').trim().toLowerCase()}`;
    // Id uden '_' — variant-id'et er `${base}__${optId}_${choiceId}`, så et
    // underscore i optId ville gøre choiceId'et umuligt at læse tilbage.
    const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x';
    const refOf = r => r.grocy_recipe_id ? ('r' + r.grocy_recipe_id) : ('n' + slug(r.product_name));

    // Allergener/tags/beskrivelse genbruges fra bestillingsformens menu, hvor de
    // allerede vedligeholdes pr. ret (Settings → Bestilling — Menu). Nøglen er
    // recipe-id'et, så de to menuer altid siger det samme.
    // MIDLERTIDIGT: når Grocy får bestil_allergens/bestil_beskrivelse på alle
    // opskrifter, skiftes kilden her — resten af koden er upåvirket.
    const extraByRef = new Map();
    try {
        const raw = db.prepare(`SELECT value FROM settings WHERE key = 'bestilling.menu_standard'`).get()?.value;
        for (const it of (JSON.parse(raw || '{}').items || [])) {
            if (!it?.id) continue;
            extraByRef.set(String(it.id), {
                allergens: String(it.allergens || '').trim(),
                tags: Array.isArray(it.tags) ? it.tags : [],
                description: String(it.description || '').trim(),
            });
        }
    } catch { /* ingen bestillingsmenu → event-menuen kører bare uden */ }

    // Allergen-tag udledes af navnet (samme værdier som event-order-3's MY_TAGS).
    // Grov, men gratis: den markerer bestillingen korrekt i køkken/udlevering.
    const tagOf = name => {
        const n = String(name || '').toLowerCase();
        if (n.includes('gluten')) return 'gluten-free';
        if (n.includes('vegan'))  return 'vegan';
        if (n.includes('laktose') || n.includes('lactose')) return 'lactose-free';
        return '';
    };

    const optionRows = rows.filter(r => r.item_type === 'option' && r.applies_to);
    // Tilvalg uden applies_to vises som almindelig ret — så en halvt opsat
    // linje ikke forsvinder i stilhed fra bestillingssiden.
    const dishRows = rows.filter(r => !(r.item_type === 'option' && r.applies_to));

    // menuKey → tilvalg der gælder for den ret
    const optionsByDish = new Map();
    for (const o of optionRows) {
        let keys = [];
        try { keys = JSON.parse(o.applies_to) || []; } catch { keys = []; }
        for (const k of keys) {
            if (!optionsByDish.has(k)) optionsByDish.set(k, []);
            optionsByDish.get(k).push(o);
        }
    }

    const categoriesMap = new Map();
    const items = dishRows.map(r => {
        const catName = r.category || 'Menu';
        if (!categoriesMap.has(catName)) categoriesMap.set(catName, buildCategoryId(catName));

        // Hvert tilvalg bliver sin egen valggruppe med "Almindelig" som
        // standardvalg — kunden kan altså bestille både "Tunen" og
        // "Tunen – Glutenfri Bolle". Første valg er forvalgt i event-order-3.
        const opts = (optionsByDish.get(keyOf(r)) || []).map(o => ({
            id: 'o' + refOf(o),
            label: o.note ? String(o.note).trim() : 'Tilvalg',
            required: true,
            choices: [
                { id: 'std', name: 'Almindelig', price: 0 },
                {
                    id: refOf(o),                                        // fx 'r161' → prep kan finde Grocy-varen
                    name: o.product_name,
                    price: Math.round((Number(o.unit_price) || 0) * 100),
                    tag: tagOf(o.product_name)
                }
            ]
        }));

        const extra = extraByRef.get(refOf(r)) || {};
        return {
            id: refOf(r),
            name: r.product_name,
            category: categoriesMap.get(catName),
            price: Math.round((Number(r.unit_price) || 0) * 100),  // øre, incl moms
            tags: extra.tags || [],
            allergens: extra.allergens || '',
            description: extra.description || '',
            active: true,
            options: opts
        };
    });
    const categories = Array.from(categoriesMap.entries()).map(([name, id]) => ({ id, name }));
    return { menu_id: menuId, name: 'Event-menu', version: todayISO(), source: 'event-menu', categories, items };
}

// ─── GET /webhook/event-menu ───────────────────────────────────────────────
router.get('/event-menu', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const menuId = req.query.menu || 'standard';
        const eventId = req.query.event ? Number(req.query.event) : null;
        // Eventets kuraterede menu vinder; ellers hele Grocy-menuen (fallback).
        if (eventId) {
            const em = buildEventMenu(getDb(), eventId, menuId);
            if (em) return res.json(em);
        }
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

    // Én ad gangen, så `variant` kan følge med den linje den hører til.
    // Broen sender fx to linjer på samme ret: "Tunen" 113 og "Tunen" 1 med
    // varianten "Glutenfri Bolle". Uden teksten kunne køkkenet kun se at der
    // et sted skulle bruges ti glutenfri boller — ikke til hvilke retter.
    // Teksten lander i special_request, og linjer med den slås aldrig sammen
    // (shared/bon_lines.js) — samme mekanik som "uden nødder" på en almindelig bon.
    const out = [], unmatched = [];
    for (const l of (lines || [])) {
        const variant = String(l.variant ?? '').trim().slice(0, 120);
        const r = resolveMenuItemLines({
            menuItems: [{ id: 'r' + Number(l.grocy_recipe_id), count: Number(l.antal ?? l.count ?? 0) }],
            recipesById, priceCategory: 'produktion',
        });
        for (const line of r.lines) out.push(variant ? { ...line, special_request: variant } : line);
        unmatched.push(...r.unmatched);
    }
    return { lines: out, unmatched };
}

// Kontaktfelterne joines med, så broens bons arver eventets kontaktperson
// på præcis samme måde som event-modulets egen generator (migration 139).
// eventContactFields() ejes af routes/events.js — én regel for fallbacken
// fra kunde til dagskontakt, ikke to der kan drive fra hinanden.
function getBridgeEvent(db, id) {
    return db.prepare(`
        SELECT e.id, e.name, e.location_id, e.start_date, e.end_date, e.event_address_id,
               e.customer_id, e.company_id, e.day_contact_name, e.day_contact_phone,
               NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
               c.phone AS contact_phone
        FROM events e
        LEFT JOIN customers c ON e.customer_id = c.id
        WHERE e.id = ?
    `).get(id);
}

// De tre bons broen laver pr. event-dag (migration 137). Samme format som
// event-modulets egne roller (§3), så P&L'en regner rigtigt:
//   prep  → vareforbrug + lagertræk      sales → omsætning      fee → udgift
const BRIDGE_ROLES = {
    // reconcile: statusser hvor broen stadig må opdatere bonnen.
    // Prep fryser når køkkenet går i gang (så en ny ordre ikke ændrer det de
    // allerede laver). Salg/gebyr lever derimod i BETALT hele dagen — det er
    // deres normale tilstand — og skal blive ved med at samle dagens ordrer,
    // indtil nogen manuelt fører dem videre (FAKTURERET/AFSLUTTET).
    prep:  { eventRole: 'prep',    pc: 'produktion', status: 'GODKENDT', sign:  1, internal: 0,
             reconcile: ['NY', 'GODKENDT'], stockGuard: true,
             kitchenInfo: 'FORUDBESTILT af kunder — allerede solgt. Er der også en prep-bon med dagens forecast, indgår disse i den (lav dem ikke oveni). Opdateres automatisk ved hver ny ordre.' },
    sales: { eventRole: 'sales',   pc: 'festival',   status: 'BETALT',   sign:  1, internal: 0,
             reconcile: ['NY', 'GODKENDT', 'BETALT'], stockGuard: false,
             kitchenInfo: null },
    fee:   { eventRole: 'expense', pc: 'festival',   status: 'BETALT',   sign: -1, internal: 1,
             reconcile: ['NY', 'GODKENDT', 'BETALT'], stockGuard: false,
             kitchenInfo: null },
};

// Broens EGEN bon for (event, dag, rolle) — aldrig en office har lavet.
// En aflyst bon tæller ikke: så laver vi en frisk i stedet.
function findPrepBon(db, eventId, date, role = 'prep') {
    return db.prepare(`
        SELECT b.id, b.bon_number, b.inventory_deducted, sd.code AS status_code
        FROM event_bridge_bons ebb
        JOIN bons b ON b.id = ebb.bon_id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE ebb.event_id = ? AND ebb.delivery_date = ? AND ebb.role = ?
          AND b.status_id != (SELECT id FROM status_definitions WHERE code = 'AFLYST')
    `).get(eventId, date, role);
}

// Salgspriser: hvad kunden FAKTISK betalte = eventets menupris (incl moms).
// Falder tilbage til Grocys festivalpris hvis en vare ikke står i menuen.
function eventMenuPriceMap(db, eventId) {
    const m = new Map();
    for (const r of db.prepare(
        `SELECT grocy_recipe_id, unit_price FROM event_menu_items WHERE event_id = ? AND grocy_recipe_id IS NOT NULL`
    ).all(eventId)) m.set(r.grocy_recipe_id, Number(r.unit_price) || 0);
    return m;
}

// Indsæt prep-linjer + opdatér totaler. Bruges af både opret og reconcile.
function insertPrepLines(db, bonId, resolved, sign = 1) {
    let total = 0;
    resolved.forEach((line, i) => {
        const qty       = Number(line.quantity ?? 0);
        const unitPrice = Number(line.unit_price ?? 0);   // produktion = 0, salg = menupris
        const lineTotal = sign * qty * unitPrice;
        total += lineTotal;
        // Udgiftslinjer (gebyr) ligger ex moms — jf. bon_lines.moms_included
        // (migration 104). Alt andet holder doktrin-default'en incl moms.
        const momsIncluded = sign < 0 ? 0 : 1;
        db.prepare(`
            INSERT INTO bon_lines (
                bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                unit_price, line_total, cost_price, co2e, moms_included, special_request, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            bonId, line.grocy_recipe_id ?? null, line.product_name, line.category ?? null,
            qty, line.unit ?? 'stk', sign * unitPrice, lineTotal,
            line.cost_price ?? null, line.co2e ?? null, momsIncluded,
            line.special_request || null, i
        );
    });
    db.prepare(`UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(total, total, bonId);
    recalcBonTotalUnits(db, bonId);
}

// Kernen: find-eller-opret prep-bon for (event, dato) og reconcile linjer.
// Ren funktion (db injiceres) så den kan testes uden HTTP/server.
// Returnerer { action: 'created'|'updated'|'frozen', bonId, bonNumber, status? }.
function applyPrepPush(db, { event, date, resolved, userId = null, role = 'prep' }) {
    const cfg = BRIDGE_ROLES[role];
    if (!cfg) throw new Error(`Ukendt bro-rolle: ${role}`);
    const existing = findPrepBon(db, event.id, date, role);

    // Frys: bonnen er nået videre i sit forløb og må ikke muteres.
    // Lager-vagten gælder kun prep — det er den eneste rolle der trækker.
    if (existing && ((cfg.stockGuard && existing.inventory_deducted === 1)
                     || !cfg.reconcile.includes(existing.status_code))) {
        return { action: 'frozen', bonId: existing.id, bonNumber: existing.bon_number, status: existing.status_code };
    }

    if (existing) {
        transaction(db, () => {
            db.prepare(`DELETE FROM bon_lines WHERE bon_id = ?`).run(existing.id);
            insertPrepLines(db, existing.id, resolved, cfg.sign);
        });
        logChange({
            entityType: 'bon', entityId: existing.id, action: 'update', fieldName: 'event_bridge',
            newValue: `${role} opdateret fra event-bro (${resolved.length} linjer)`, userId
        });
        broadcast('bon_updated', { id: existing.id, event_id: event.id });
        broadcast('event_updated', { id: event.id });
        return { action: 'updated', bonId: existing.id, bonNumber: existing.bon_number };
    }

    // Opret ny bon — spejler event-generatoren for den valgte rolle.
    const pc = db.prepare(`SELECT id, code FROM price_categories WHERE code = ? AND is_active = 1`).get(cfg.pc);
    if (!pc) throw new Error(`Priskategori '${cfg.pc}' findes ikke`);
    const statusId = getStatusId(cfg.status);
    const bonNumber = nextBonNumber();

    const contact = eventContactFields(event);

    const bonId = transaction(db, () => {
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
            bonNumber, statusId, event.location_id, pc.id, pc.code, event.id, cfg.eventRole,
            todayISO(), date, null, null,
            'event', event.event_address_id ?? null, 0, 0, 'cash',
            contact.customer_id, contact.company_id, contact.day_contact_name, contact.day_contact_phone,
            cfg.kitchenInfo, null,
            `Oprettet af event-broen (${role}). Bygget af kundernes forudbestillinger for dagen og opdateres ved hver ny ordre.`,
            userId, cfg.internal
        );
        const id = r.lastInsertRowid;
        // Registrér ejerskab (migration 137), så broen aldrig rører andres bons.
        db.prepare(`
            INSERT INTO event_bridge_bons (event_id, delivery_date, role, bon_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(event_id, delivery_date, role)
            DO UPDATE SET bon_id = excluded.bon_id, updated_at = CURRENT_TIMESTAMP
        `).run(event.id, date, role, id);
        insertPrepLines(db, id, resolved, cfg.sign);
        return id;
    });

    logChange({
        entityType: 'bon', entityId: bonId, action: 'create', fieldName: 'event_bridge',
        newValue: `${bonNumber} (event-bro ${role}, event:${event.name}, ${date})`, userId
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

        // 1) PREP — hvad køkkenet skal lave (produktion, 0 kr, trækker lager)
        const prep = applyPrepPush(db, { event, date, resolved, userId: null, role: 'prep' });

        // 2) SALG — hvad kunderne betalte. Priserne kommer fra eventets menu
        //    (incl moms), så bankudbetalingen fra Stripe kan afstemmes mod bonnen.
        const priceMap = eventMenuPriceMap(db, event.id);
        const salesLines = resolved.map(l => ({
            ...l,
            unit_price: priceMap.has(l.grocy_recipe_id)
                ? priceMap.get(l.grocy_recipe_id)
                : (Number(l.unit_price) || 0),   // fallback: Grocy-pris fra resolveren
        }));
        const salesTotal = salesLines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
        const sales = applyPrepPush(db, { event, date, resolved: salesLines, userId: null, role: 'sales' });

        // 3) GEBYR — estimat af Stripes andel. Bogføres automatisk, fordi en
        //    udgift man skal huske at taste, systematisk bliver glemt.
        const feePct = Number(db.prepare(`SELECT value FROM settings WHERE key='event_bridge_fee_pct'`).get()?.value ?? 0);
        let fee = null;
        if (feePct > 0 && salesTotal > 0) {
            const feeAmount = Math.round(salesTotal * feePct) / 100;
            fee = applyPrepPush(db, {
                event, date, userId: null, role: 'fee',
                resolved: [{
                    product_name: `Betalingsgebyr (estimat ${feePct} %)`,
                    category: null, quantity: 1, unit: 'stk', unit_price: feeAmount,
                }],
            });
        }

        // 4) REST-PREP — de forudbestilte er steget, så office' rest-bon skal
        //    ned tilsvarende (migration 166). Uden det tælles begge bons fuldt
        //    med i ugeoversigt, kapacitet, top-up, retur OG lagertrækket.
        //
        //    Må ALDRIG vælte forudbestillingen: kundens ordre er landet, og en
        //    fejl her er en efterfølgende justering — ikke en grund til at
        //    svare 500 og få event-order-3 til at prøve igen. Samme princip som
        //    goodsReceiptWebhook: bivirkningen rapporteres, den blokerer ikke.
        let restPrep = null;
        try {
            restPrep = reconcileRestBonsForEvent(db, event.id, null);
        } catch (err) {
            console.error('[event-bridge] rest-prep genberegning fejlede:', err);
            restPrep = { error: String(err.message || err) };
        }

        const status = prep.action === 'created' ? 201 : 200;
        return res.status(status).json({
            ok: true,
            action: prep.action,
            bon_id: prep.bonId,
            bon_number: prep.bonNumber,
            ...(prep.status ? { status: prep.status } : {}),
            sales: { action: sales.action, bon_id: sales.bonId, bon_number: sales.bonNumber, total: salesTotal },
            ...(fee ? { fee: { action: fee.action, bon_id: fee.bonId, bon_number: fee.bonNumber, pct: feePct } } : {}),
            lines: resolved.length,
            rest_prep: restPrep,
            unmatched
        });
    } catch (err) {
        console.error('[event-bridge] prep-fejl:', err);
        return res.status(500).json({ error: 'prep_failed' });
    }
});

// ─── GET /webhook/event-active ─────────────────────────────────────────────
// "Hvilket event tages der imod forudbestillinger til lige nu?"
//
// Findes fordi koblingen før lå i event-order-3's egen konfigurationsfil
// (`bonV2.eventId`). Et nyt event krævede: opret i Bon → kopiér id → redigér
// fil på en anden server → deploy. Nu erklærer eventet det selv med et flueben,
// og broen kan spørge.
//
// Vi gætter aldrig: er der ikke præcis ét, siger vi hvad vi fandt i stedet for
// at vælge. Et forkert valg ville lægge kundernes forudbestillinger på det
// forkerte event — og det ville se helt rigtigt ud.
router.get('/event-active', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    // Reglen ejes af routes/events.js og deles med Settings-panelet, så de to
    // ikke kan sige forskellige ting om hvilket event der er aktivt.
    const r = resolveActiveOrderEvent(getDb(), todayISO());
    if (r.event) {
        return res.json({
            event_id: r.event.id, name: r.event.name,
            start_date: r.event.start_date, end_date: r.event.end_date,
        });
    }
    return res.json({
        event_id: null,
        reason: r.reason,
        candidates: r.candidates.map(e => ({ id: e.id, name: e.name, start_date: e.start_date, end_date: e.end_date })),
        hint: r.hint,
    });
});

// ─── POST /webhook/event-refresh-menu ──────────────────────────────────────
// Office trykker "Opdater menu i event-ordre" → vi beder event-order-3 hente
// menuen NU (ellers venter den på sin 10-min-cache). Kræver login (kaldes fra
// office-UI, ikke fra event-appen) — derfor auth via session, ikke bro-secret.
router.post('/event-refresh-menu', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const db = getDb();
        const base = (db.prepare(`SELECT value FROM settings WHERE key = 'event_order_base_url'`).get()?.value || '').trim();
        if (!/^https?:\/\//i.test(base)) return res.status(400).json({ error: 'event_order_base_url ikke sat' });
        const secret = db.prepare(`SELECT value FROM settings WHERE key = 'event_bridge_secret'`).get()?.value || '';

        const r = await fetch(base.replace(/\/+$/, '') + '/api/bonv2/refresh-menu', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}) },
            signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) return res.status(502).json({ error: 'event-ordre svarede ' + r.status });
        res.json({ ok: true });
    } catch (err) {
        console.error('[event-bridge] refresh-menu fejl:', err.message);
        res.status(502).json({ error: 'kunne ikke nå event-ordre' });
    }
});

module.exports = router;
module.exports.buildBridgeMenu = buildBridgeMenu;
module.exports.buildEventMenu = buildEventMenu;
module.exports.buildCategoryId = buildCategoryId;
module.exports.checkBridgeSecret = checkBridgeSecret;
module.exports.resolvePrepLines = resolvePrepLines;
module.exports.applyPrepPush = applyPrepPush;
module.exports.findPrepBon = findPrepBon;
