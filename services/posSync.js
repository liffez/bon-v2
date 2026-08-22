/**
 * services/posSync.js
 * ════════════════════════════════════════════════════════════
 * Henter POS-køb, gemmer dem rå, og bygger én salgsbon pr. forretningsdag.
 *
 * Spec: docs/CLAUDE_ZETTLE_POS.md §4, §6, §8, §12 · Fase 2 (#509).
 *
 * Ansvarssnit: broen ejer **kun sine egne bons** (pos_sales_days.bon_id) —
 * aldrig en office eller event-broen har lavet. Prep, forecast og lager røres
 * ikke; salgsbonnen bærer `event_id`, så no-deduct-gaten (CLAUDE_EVENT.md §5)
 * springer lagertrækket over. Prep-bonnen ejer trækket.
 * ════════════════════════════════════════════════════════════
 */

const {
    getStatusId, nextBonNumber, recalcBonTotalUnits, transaction, logChange,
} = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { eventContactFields } = require('../routes/events');
const grocyAdapter = require('../services/grocyAdapter');
const { getZettleAdapter } = require('./zettleAdapter');
const {
    businessDate, buildRecipeIndex, aggregateDay, resolveEventForDay,
} = require('./posSales');

const SOURCE = 'zettle';

// Statusser hvor broen stadig må skrive i sin egen bon. Bonnen fødes BETALT —
// det er dens normale tilstand — og skal blive ved med at samle dagens salg
// op, indtil nogen fører den videre (FAKTURERET/AFSLUTTET). Derfra er den
// et menneskes ansvar, og vi rører den ikke igen.
const RECONCILE_STATUSES = ['NY', 'GODKENDT', 'BETALT'];

/* ══════════════════════════════════════════════════════════════
   INDSTILLINGER
   ══════════════════════════════════════════════════════════════ */

function setting(db, key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
}

function getPosSettings(db) {
    return {
        enabled: setting(db, 'zettle_enabled', '0') === '1',
        cutoff: setting(db, 'zettle_business_day_cutoff', '04:00'),
        pollMinutes: Number(setting(db, 'zettle_poll_minutes', '10')) || 0,
        resyncDays: Math.max(0, Number(setting(db, 'zettle_resync_days', '3')) || 0),
        priceCategory: setting(db, 'zettle_default_price_category', 'festival'),
    };
}

/* ══════════════════════════════════════════════════════════════
   RÅ KØB
   ══════════════════════════════════════════════════════════════ */

/**
 * Gem købene. `UNIQUE(source, purchase_uuid)` gør gentagne synk harmløse:
 * et køb der allerede findes får blot sin forretningsdag og rå payload
 * genopfrisket (døgnskiftet kan være ændret i Settings siden sidst).
 * Returnerer de berørte forretningsdage.
 */
function upsertPurchases(db, purchases, cutoff) {
    const dates = new Set();
    let inserted = 0, updated = 0;

    transaction(db, () => {
        const ins = db.prepare(`
            INSERT INTO pos_purchases (
                source, purchase_uuid, purchase_no, occurred_at, business_date,
                amount_incl, vat_amount, payment_type, site_uuid, is_refund, raw_json, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(source, purchase_uuid) DO UPDATE SET
                business_date = excluded.business_date,
                amount_incl   = excluded.amount_incl,
                vat_amount    = excluded.vat_amount,
                payment_type  = excluded.payment_type,
                site_uuid     = excluded.site_uuid,
                is_refund     = excluded.is_refund,
                raw_json      = excluded.raw_json,
                synced_at     = datetime('now')
        `);
        const prevOf = db.prepare('SELECT business_date FROM pos_purchases WHERE source = ? AND purchase_uuid = ?');

        for (const p of purchases) {
            if (!p.purchase_uuid || !p.occurred_at) continue;   // uden nøgle er der intet at være idempotent om
            const bd = businessDate(p.occurred_at, cutoff);
            // Er døgnskiftet ændret i Settings, kan et køb flytte dag. Så skal
            // BEGGE dage bygges om — ellers står beløbet to steder.
            const prev = prevOf.get(SOURCE, p.purchase_uuid);
            if (prev) { updated++; if (prev.business_date) dates.add(prev.business_date); } else { inserted++; }
            ins.run(
                SOURCE, p.purchase_uuid, p.purchase_no ?? null, p.occurred_at, bd,
                p.amount_incl, p.vat_amount, p.payment_type ?? null, p.site_uuid ?? null,
                p.is_refund ? 1 : 0, JSON.stringify(p.raw ?? p),
            );
            dates.add(bd);
        }
    });

    return { inserted, updated, dates: [...dates].sort() };
}

/** Købene for én forretningsdag, tilbage i den form aggregeringen forventer. */
function loadDayPurchases(db, date) {
    const { normalizePurchase } = require('./zettleAdapter');
    return db.prepare(
        'SELECT raw_json FROM pos_purchases WHERE source = ? AND business_date = ? ORDER BY occurred_at'
    ).all(SOURCE, date).map(r => normalizePurchase(JSON.parse(r.raw_json)));
}

/* ══════════════════════════════════════════════════════════════
   EVENT-KOBLING
   ══════════════════════════════════════════════════════════════ */

function candidateEvents(db, date) {
    return db.prepare(`
        SELECT e.id, e.name, e.pos_store_ref, e.location_id, e.start_date, e.end_date,
               e.customer_id, e.company_id, e.day_contact_name, e.day_contact_phone, e.event_address_id,
               NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
               c.phone AS contact_phone
        FROM events e
        LEFT JOIN customers c ON e.customer_id = c.id
        WHERE e.pos_enabled = 1
          AND e.status != 'cancelled'
          AND ? BETWEEN e.start_date AND COALESCE(e.end_date, e.start_date)
        ORDER BY e.id
    `).all(date);
}

/* ══════════════════════════════════════════════════════════════
   SALGSBONNEN (§8)
   ══════════════════════════════════════════════════════════════ */

function ownBon(db, date) {
    return db.prepare(`
        SELECT b.id, b.bon_number, sd.code AS status_code
        FROM pos_sales_days d
        JOIN bons b ON b.id = d.bon_id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE d.source = ? AND d.business_date = ?
          AND b.status_id != (SELECT id FROM status_definitions WHERE code = 'AFLYST')
    `).get(SOURCE, date);
}

function writeLines(db, bonId, lines) {
    let total = 0;
    lines.forEach((l, i) => {
        total += l.line_total_incl;
        db.prepare(`
            INSERT INTO bon_lines (
                bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                unit_price, line_total, cost_price, co2e, moms_included, pos_product_id, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
        `).run(
            bonId, l.grocy_recipe_id ?? null,
            l.variant_name ? `${l.product_name} (${l.variant_name})` : l.product_name,
            l.category ?? null, l.quantity, l.unit || 'stk',
            l.unit_price_incl, l.line_total_incl,
            l.cost_price ?? null, l.co2e ?? null, i,
        );
    });
    total = Math.round(total * 100) / 100;
    db.prepare(`UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(total, total, bonId);
    recalcBonTotalUnits(db, bonId);
    return total;
}

const KITCHEN_INFO =
    'Solgt over kassen (POS). Bonnen bygges automatisk af dagens salg og opdateres ved hver synk. '
    + 'Den trækker IKKE lager — prep-bonnen ejer trækket.';

/**
 * Find-eller-opret dagens salgsbon og reconcile linjerne (fuld erstatning).
 * Ren i den forstand at db injiceres; ingen netværk.
 * → { action: 'created'|'updated'|'frozen'|'skipped', bon_id, bon_number, status? }
 */
function applyDayBon(db, { event, date, agg, priceCategory, userId = null }) {
    const existing = ownBon(db, date);

    if (existing && !RECONCILE_STATUSES.includes(existing.status_code)) {
        // Nogen har ført bonnen videre. Den er ikke vores længere.
        return { action: 'frozen', bon_id: existing.id, bon_number: existing.bon_number, status: existing.status_code };
    }
    if (!agg.lines.length && !existing) {
        return { action: 'skipped', reason: 'no_lines' };
    }

    if (existing) {
        transaction(db, () => {
            db.prepare('DELETE FROM bon_lines WHERE bon_id = ?').run(existing.id);
            writeLines(db, existing.id, agg.lines);
        });
        logChange({
            entityType: 'bon', entityId: existing.id, action: 'update', fieldName: 'pos_sync',
            newValue: `POS-salg opdateret (${agg.lines.length} linjer, ${agg.purchase_count} køb)`, userId,
        });
        broadcast('bon_updated', { id: existing.id, event_id: event.id });
        broadcast('event_updated', { id: event.id });
        return { action: 'updated', bon_id: existing.id, bon_number: existing.bon_number };
    }

    const pc = db.prepare('SELECT id, code FROM price_categories WHERE code = ? AND is_active = 1').get(priceCategory);
    if (!pc) throw new Error(`Priskategori '${priceCategory}' findes ikke`);
    const statusId = getStatusId('BETALT');
    const bonNumber = nextBonNumber();
    const contact = eventContactFields(event);

    const bonId = transaction(db, () => {
        const r = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, price_category_id, price_category,
                event_id, event_role, order_date, delivery_date,
                delivery_type, delivery_address_id, pax, total_units, payment_type,
                customer_id, company_id, day_contact_name, day_contact_phone,
                kitchen_info, internal_notes, created_by_user_id, is_internal,
                total_price, total_with_delivery,
                prep_ingredients_ready, prep_supplies_ready, kitchen_selects, customer_collects,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'event', ?, 0, 0, 'pos',
                ?, ?, ?, ?,
                ?, ?, ?, 0,
                0, 0, 0, 0, 0, 0,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        `).run(
            bonNumber, statusId, event.location_id, pc.id, pc.code,
            event.id, 'sales', date, date,
            event.event_address_id ?? null,
            contact.customer_id, contact.company_id, contact.day_contact_name, contact.day_contact_phone,
            KITCHEN_INFO,
            `Oprettet af POS-synk (Zettle) for ${date}. Bygget af dagens kassesalg og opdateres ved hver synk.`,
            userId,
        );
        const id = r.lastInsertRowid;
        db.prepare('UPDATE pos_sales_days SET bon_id = ? WHERE source = ? AND business_date = ?')
            .run(id, SOURCE, date);
        writeLines(db, id, agg.lines);
        return id;
    });

    logChange({
        entityType: 'bon', entityId: bonId, action: 'create', fieldName: 'pos_sync',
        newValue: `${bonNumber} (POS-salg, event:${event.name}, ${date})`, userId,
    });
    broadcast('bon_created', { id: bonId, bon_number: bonNumber, event_id: event.id });
    broadcast('event_updated', { id: event.id });
    return { action: 'created', bon_id: bonId, bon_number: bonNumber };
}

/* ══════════════════════════════════════════════════════════════
   BYG ÉN DAG
   ══════════════════════════════════════════════════════════════ */

/**
 * Genopbyg alt om én forretningsdag ud fra de rå køb vi allerede har gemt.
 * Kaldes af synken, af "synk nu", og når en dag kobles til et event i hånden.
 *
 * @param {object} deps.recipes  Grocy-opskrifter. Mangler de, bygges bonnen
 *   IKKE — vi skriver hellere ingenting end en bon vi ved er mangelfuld.
 *   Dagen får `last_error` og kan bygges igen når Grocy er tilbage.
 */
function rebuildDay(db, date, { recipes = null, userId = null, forceEventId = undefined } = {}) {
    const cfg = getPosSettings(db);
    const purchases = loadDayPurchases(db, date);

    const productMap = new Map();
    for (const r of db.prepare('SELECT pos_product_uuid, grocy_recipe_id FROM pos_product_map WHERE source = ?').all(SOURCE)) {
        productMap.set(r.pos_product_uuid, { grocy_recipe_id: r.grocy_recipe_id });
    }
    const recipesById = new Map((recipes || []).map(r => [r.id, r]));
    const agg = aggregateDay(purchases, {
        recipeIndex: recipes ? buildRecipeIndex(recipes) : null,
        productMap,
        recipesById,
    });

    // Kobling: manuel tildeling vinder og bliver stående.
    const existingDay = db.prepare('SELECT * FROM pos_sales_days WHERE source = ? AND business_date = ?').get(SOURCE, date);
    let resolved;
    if (forceEventId !== undefined) {
        resolved = forceEventId === null
            ? { event_id: null, status: 'unassigned', reason: 'manual_clear', candidates: [] }
            : { event_id: forceEventId, status: 'manual', reason: 'manual', candidates: [] };
    } else if (existingDay?.assign_status === 'manual' && existingDay.event_id) {
        resolved = { event_id: existingDay.event_id, status: 'manual', reason: 'manual', candidates: [] };
    } else {
        resolved = resolveEventForDay(candidateEvents(db, date), purchases.map(p => p.site_uuid));
    }

    const flags = [...agg.flags];

    // Fjernes fluebenet på eventet EFTER at bonnen er lavet, ville dagen ellers
    // flippe til "uden event" mens bonnen levede videre — og næste kobling ville
    // lave en til. Koblingen bliver stående så længe vi har en levende bon;
    // vil man af med den, skal bonnen håndteres først (samme regel som assignDay).
    if (!resolved.event_id && existingDay?.event_id && ownBon(db, date)) {
        flags.push({ code: 'kept_assignment_bon_exists', event_id: existingDay.event_id, reason: resolved.reason });
        resolved = { event_id: existingDay.event_id, status: existingDay.assign_status, reason: 'bon_exists', candidates: [] };
    }

    if (resolved.status === 'ambiguous') {
        flags.push({ code: 'ambiguous_event', events: resolved.candidates.map(e => ({ id: e.id, name: e.name })) });
    }

    db.prepare(`
        INSERT INTO pos_sales_days (
            source, business_date, event_id, assign_status, gross_incl, by_payment_json,
            purchase_count, refund_count, unmatched_json, flags_json, last_synced_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(source, business_date) DO UPDATE SET
            event_id        = excluded.event_id,
            assign_status   = excluded.assign_status,
            gross_incl      = excluded.gross_incl,
            by_payment_json = excluded.by_payment_json,
            purchase_count  = excluded.purchase_count,
            refund_count    = excluded.refund_count,
            unmatched_json  = excluded.unmatched_json,
            flags_json      = excluded.flags_json,
            last_synced_at  = datetime('now'),
            last_error      = excluded.last_error
    `).run(
        SOURCE, date, resolved.event_id, resolved.status,
        agg.gross_incl, JSON.stringify(agg.by_payment),
        agg.purchase_count, agg.refund_count,
        JSON.stringify(agg.unmatched), JSON.stringify(flags),
        recipes ? null : 'Grocy kunne ikke hentes — bonnen er ikke bygget for denne dag',
    );

    let bon = { action: 'skipped', reason: resolved.event_id ? 'no_recipes' : 'unassigned' };
    if (resolved.event_id && recipes) {
        const event = db.prepare(`
            SELECT e.id, e.name, e.location_id, e.event_address_id, e.customer_id, e.company_id,
                   e.day_contact_name, e.day_contact_phone,
                   NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
                   c.phone AS contact_phone
            FROM events e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.id = ?
        `).get(resolved.event_id);
        if (event) {
            bon = applyDayBon(db, { event, date, agg, priceCategory: cfg.priceCategory, userId });
            if (bon.action === 'frozen') {
                flags.push({ code: 'bon_frozen', status: bon.status, bon_number: bon.bon_number });
                db.prepare('UPDATE pos_sales_days SET flags_json = ? WHERE source = ? AND business_date = ?')
                    .run(JSON.stringify(flags), SOURCE, date);
            }
        }
    }

    return { date, ...agg, flags, assign: resolved, bon };
}

/* ══════════════════════════════════════════════════════════════
   SYNK
   ══════════════════════════════════════════════════════════════ */

/**
 * Hent vinduet, gem købene, byg de berørte dage.
 * Kaster aldrig på en enkelt dags fejl — den skrives på dagen og resten kører.
 */
async function syncPos(db, { adapter = null, from = null, to = null, userId = null, deps = {} } = {}) {
    const cfg = getPosSettings(db);
    if (!cfg.enabled) return { ok: false, skipped: true, reason: 'disabled' };

    const zettle = adapter || getZettleAdapter();
    if (!zettle.isConfigured()) return { ok: false, skipped: true, reason: 'not_configured' };

    const today = deps.todayISO ? deps.todayISO() : require('../db/helpers').todayISO();
    const offset = deps.offsetISO ? deps.offsetISO : require('../db/helpers').offsetISO;
    const windowFrom = from || offset(-cfg.resyncDays);
    const windowTo = to || today;

    // Randen er sikker uden at hente ekstra: rebuildDay læser ALLE gemte køb
    // for dagen, ikke kun dem dette vindue hentede. Et køb der pga. døgnskiftet
    // falder på dagen før vinduet, bygger altså den dag om på fuldt grundlag.
    const purchases = await zettle.getPurchases({ from: windowFrom, to: windowTo });
    const { inserted, updated, dates } = upsertPurchases(db, purchases, cfg.cutoff);

    let recipes = null;
    try {
        recipes = await (deps.getRecipes ? deps.getRecipes() : grocyAdapter.getRecipes());
    } catch (err) {
        console.warn('[pos-sync] Grocy utilgængelig — dagene bygges uden bon:', err.message);
    }

    const days = [];
    for (const d of dates) {
        try {
            days.push(rebuildDay(db, d, { recipes, userId }));
        } catch (err) {
            console.error(`[pos-sync] dag ${d} fejlede:`, err.message);
            db.prepare(`
                INSERT INTO pos_sales_days (source, business_date, last_error, last_synced_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(source, business_date) DO UPDATE SET
                    last_error = excluded.last_error, last_synced_at = datetime('now')
            `).run(SOURCE, d, String(err.message).slice(0, 500));
            days.push({ date: d, error: err.message });
        }
    }

    return {
        ok: true,
        from: windowFrom, to: windowTo,
        purchases: purchases.length, inserted, updated,
        recipes_available: Boolean(recipes),
        days,
    };
}

/* ══════════════════════════════════════════════════════════════
   MANUEL KOBLING
   ══════════════════════════════════════════════════════════════ */

/**
 * Kobl en dag til et event i hånden — typisk fordi fluebenet på eventet blev
 * glemt, eller fordi to events dækkede datoen.
 *
 * Værn mod dubletter: findes der allerede en bon for dagen, FLYTTES den til
 * det nye event i stedet for at der laves en ny. At fjerne koblingen helt
 * afvises mens bonnen findes — ellers ville næste synk lave en frisk bon, og
 * omsætningen ville stå to gange. Bonnen skal håndteres først (aflyses eller
 * føres videre), og dét er en menneskebeslutning.
 */
function assignDay(db, date, eventId, { userId = null, recipes = null } = {}) {
    const day = db.prepare('SELECT * FROM pos_sales_days WHERE source = ? AND business_date = ?').get(SOURCE, date);
    if (!day) throw Object.assign(new Error(`Ingen POS-dag for ${date}`), { code: 'unknown_day' });

    const bon = ownBon(db, date);
    if (eventId === null && bon) {
        throw Object.assign(
            new Error(`Dagen har allerede salgsbon ${bon.bon_number}. Håndtér den først — ellers ville næste synk lave en ny.`),
            { code: 'bon_exists' });
    }
    if (eventId !== null) {
        const ev = db.prepare("SELECT id, name FROM events WHERE id = ? AND status != 'cancelled'").get(eventId);
        if (!ev) throw Object.assign(new Error('Event findes ikke (eller er aflyst)'), { code: 'unknown_event' });
        if (bon && !RECONCILE_STATUSES.includes(bon.status_code)) {
            throw Object.assign(
                new Error(`Salgsbon ${bon.bon_number} er ${bon.status_code} og må ikke flyttes automatisk.`),
                { code: 'bon_frozen' });
        }
        if (bon) {
            db.prepare('UPDATE bons SET event_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventId, bon.id);
            logChange({
                entityType: 'bon', entityId: bon.id, action: 'update', fieldName: 'event_id',
                oldValue: String(day.event_id ?? ''), newValue: String(eventId),
                notes: `POS-dag ${date} koblet til ${ev.name}`, userId,
            });
            broadcast('bon_updated', { id: bon.id, event_id: eventId });
        }
    }
    return rebuildDay(db, date, { recipes, userId, forceEventId: eventId });
}

/* ══════════════════════════════════════════════════════════════
   POLLING
   ══════════════════════════════════════════════════════════════ */

let _timer = null;

/**
 * Baggrunds-synk. Slår sig selv fra når `zettle_enabled` er '0', når
 * credentials mangler, eller når `zettle_poll_minutes` er 0 — og siger det
 * ÉN gang, så en slukket integration ikke ligner en død.
 *
 * En fejl vælter aldrig noget andet: den logges og skrives på dagen
 * (pos_sales_days.last_error), hvor Settings-panelet kan vise den.
 */
function startPolling(db = null) {
    stopPolling();
    const database = db || require('../db/database').getDb();
    const cfg = getPosSettings(database);

    if (!cfg.enabled) { console.log('[pos-sync] slukket (zettle_enabled = 0)'); return null; }
    if (!getZettleAdapter().isConfigured()) {
        console.warn('[pos-sync] tændt, men ZETTLE_CLIENT_ID/ZETTLE_API_KEY mangler i .env — henter intet');
        return null;
    }
    if (cfg.pollMinutes <= 0) { console.log('[pos-sync] automatisk polling slået fra (zettle_poll_minutes = 0)'); return null; }

    const run = () => syncPos(database)
        .then(r => {
            if (r.ok) console.log(`[pos-sync] ${r.purchases} køb · ${r.days.length} dag(e) bygget`);
        })
        .catch(err => console.error('[pos-sync] synk fejlede:', err.message));

    run();
    _timer = setInterval(run, cfg.pollMinutes * 60000);
    if (_timer.unref) _timer.unref();
    console.log(`[pos-sync] poller hvert ${cfg.pollMinutes}. minut`);
    return _timer;
}

function stopPolling() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
    SOURCE, RECONCILE_STATUSES, assignDay, ownBon, startPolling, stopPolling,
    getPosSettings, upsertPurchases, loadDayPurchases,
    candidateEvents, applyDayBon, rebuildDay, syncPos,
};
