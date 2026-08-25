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
const { paymentUuidIndex, attributeLedger, suggestBankMatch, round2 } = require('./posFinance');

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

    // Bonnen må ALDRIG trække lager: prep-bonnen ejer trækket (CLAUDE_EVENT.md
    // §5), og køkkeninfoen siger det til mennesket. Gaten i
    // autoConsumeBonInventory ville have sat præcis dette — men den kaldes kun
    // ved LEVERET, og en POS-bon oprettes direkte som BETALT og passerer aldrig
    // dér. Uden markeringen stod bonen med flag 0 og tom status, og vagthunden
    // meldte den som et manglende træk hver eneste nat (#B4202, #B4207 24.08).
    //
    // Sat HER frem for som en undtagelse i vagthunden, så bonen selv bærer sin
    // begrundelse. En kontrol der skal udlede den, kan tage fejl.
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
                inventory_deducted, inventory_deducted_at, inventory_deduct_status,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'event', ?, 0, 0, 'pos',
                ?, ?, ?, ?,
                ?, ?, ?, 0,
                0, 0, 0, 0, 0, 0,
                1, CURRENT_TIMESTAMP, 'event_prep_owns_stock',
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

    // Hovedbogen hentes bagefter, fordi gebyret kobles til dagen gennem
    // betalings-uuid'et i de køb vi lige har gemt. Fejler den, står salget
    // stadig rigtigt — gebyret mangler bare og samles op ved næste synk.
    let finance = null;
    try {
        finance = await syncFinance(db, { adapter: zettle, from: windowFrom, to: windowTo, userId, deps });
    } catch (err) {
        console.error('[pos-sync] hovedbogen kunne ikke hentes:', err.message);
        finance = { ok: false, error: err.message };
    }

    return {
        ok: true,
        from: windowFrom, to: windowTo,
        purchases: purchases.length, inserted, updated,
        recipes_available: Boolean(recipes),
        days,
        finance,
    };
}

/* ══════════════════════════════════════════════════════════════
   GEBYR + UDBETALING (Fase 3)
   ══════════════════════════════════════════════════════════════ */

const FEE_LINE_NAME = 'Kortgebyr (Zettle)';

/** Broens egen gebyr-bon for dagen — aldrig en andens. */
function ownFeeBon(db, date) {
    return db.prepare(`
        SELECT b.id, b.bon_number, sd.code AS status_code
        FROM pos_sales_days d
        JOIN bons b ON b.id = d.fee_bon_id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE d.source = ? AND d.business_date = ?
          AND b.status_id != (SELECT id FROM status_definitions WHERE code = 'AFLYST')
    `).get(SOURCE, date);
}

/**
 * Dagens kortgebyr som udgiftsbon. Spejler event-broens gebyr-rolle
 * (migration 137): event_role='expense', is_internal=1, negativt beløb.
 *
 * Bogføres automatisk med vilje: en udgift man skal huske at taste, bliver
 * systematisk glemt. Forskellen fra broen er at dette er et MÅLT tal fra
 * Zettles hovedbog, ikke et procent-skøn.
 *
 * Momsen: gebyret er en finansiel ydelse og bærer ingen moms. `moms_included=0`
 * er den nærmeste sandhed skemaet kan udtrykke (jf. #317 — flaget kan ikke
 * skelne "ex moms" fra "momsfri"), og det er samme valg broen traf.
 */
function applyFeeBon(db, { event, date, feeIncl, priceCategory, userId = null }) {
    const existing = ownFeeBon(db, date);
    const amount = round2(feeIncl);

    if (existing && !RECONCILE_STATUSES.includes(existing.status_code)) {
        return { action: 'frozen', bon_id: existing.id, bon_number: existing.bon_number, status: existing.status_code };
    }
    if (!amount && !existing) return { action: 'skipped', reason: 'no_fee' };

    const writeFeeLine = (bonId) => {
        db.prepare('DELETE FROM bon_lines WHERE bon_id = ?').run(bonId);
        db.prepare(`
            INSERT INTO bon_lines (bon_id, product_name, quantity, unit, unit_price, line_total, moms_included, sort_order)
            VALUES (?, ?, 1, 'stk', ?, ?, 0, 0)
        `).run(bonId, FEE_LINE_NAME, amount, amount);
        db.prepare('UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(amount, amount, bonId);
    };

    if (existing) {
        transaction(db, () => writeFeeLine(existing.id));
        broadcast('bon_updated', { id: existing.id, event_id: event.id });
        return { action: 'updated', bon_id: existing.id, bon_number: existing.bon_number, amount };
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
                delivery_type, pax, total_units, payment_type,
                customer_id, company_id, day_contact_name, day_contact_phone,
                internal_notes, created_by_user_id, is_internal,
                total_price, total_with_delivery,
                prep_ingredients_ready, prep_supplies_ready, kitchen_selects, customer_collects,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'expense', ?, ?, 'event', 0, 0, 'pos', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0,
                      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
            bonNumber, statusId, event.location_id, pc.id, pc.code, event.id, date, date,
            contact.customer_id, contact.company_id, contact.day_contact_name, contact.day_contact_phone,
            `Zettles kortgebyr for ${date}. Målt fra Zettles hovedbog, ikke et skøn. Opdateres ved hver synk.`,
            userId,
        );
        const id = r.lastInsertRowid;
        db.prepare('UPDATE pos_sales_days SET fee_bon_id = ? WHERE source = ? AND business_date = ?')
            .run(id, SOURCE, date);
        writeFeeLine(id);
        return id;
    });

    logChange({
        entityType: 'bon', entityId: bonId, action: 'create', fieldName: 'pos_fee',
        newValue: `${bonNumber} (Zettle-kortgebyr, ${date}, ${amount} kr)`, userId,
    });
    broadcast('bon_created', { id: bonId, bon_number: bonNumber, event_id: event.id });
    return { action: 'created', bon_id: bonId, bon_number: bonNumber, amount };
}

/**
 * Hent Zettles hovedbog, fordel den på dage og udbetalinger, og bogfør
 * dagens gebyr.
 *
 * Kræver at købene er hentet først — gebyret kobles til dagen gennem
 * betalings-uuid'et i den rå payload. Er et køb ikke gemt endnu, står gebyret
 * uden dag og tælles ikke med; næste synk samler det op.
 */
async function syncFinance(db, { adapter = null, from = null, to = null, userId = null, deps = {} } = {}) {
    const cfg = getPosSettings(db);
    if (!cfg.enabled) return { ok: false, skipped: true, reason: 'disabled' };
    const zettle = adapter || getZettleAdapter();
    if (!zettle.isConfigured()) return { ok: false, skipped: true, reason: 'not_configured' };

    const today = deps.todayISO ? deps.todayISO() : require('../db/helpers').todayISO();
    const offset = deps.offsetISO ? deps.offsetISO : require('../db/helpers').offsetISO;
    const windowFrom = from || offset(-cfg.resyncDays);
    const windowTo = to || today;

    const ledger = await zettle.getFinanceTransactions({ from: windowFrom, to: windowTo });
    const purchases = db.prepare(
        'SELECT purchase_uuid, business_date, raw_json FROM pos_purchases WHERE source = ?'
    ).all(SOURCE);
    const index = paymentUuidIndex(purchases);
    const { rows, payouts, days } = attributeLedger(ledger, index);

    transaction(db, () => {
        const ins = db.prepare(`
            INSERT INTO pos_finance_tx (source, tx_type, originating_uuid, occurred_at, amount_incl, payout_uuid, business_date, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(source, tx_type, originating_uuid) DO UPDATE SET
                occurred_at   = excluded.occurred_at,
                amount_incl   = excluded.amount_incl,
                payout_uuid   = COALESCE(excluded.payout_uuid, pos_finance_tx.payout_uuid),
                business_date = COALESCE(excluded.business_date, pos_finance_tx.business_date),
                synced_at     = datetime('now')
        `);
        for (const r of rows) {
            if (!r.originating_uuid || !r.tx_type) continue;
            ins.run(SOURCE, r.tx_type, r.originating_uuid, r.occurred_at, r.amount_incl, r.payout_uuid, r.business_date);
        }
        // Udbetalingen: sammensætningen genberegnes, men et godkendt bank-match
        // røres ALDRIG — det er et menneskes beslutning.
        const insP = db.prepare(`
            INSERT INTO pos_payouts (source, payout_uuid, occurred_at, amount_incl, gross_incl, fee_incl, covered_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, payout_uuid) DO UPDATE SET
                occurred_at  = excluded.occurred_at,
                amount_incl  = excluded.amount_incl,
                gross_incl   = excluded.gross_incl,
                fee_incl     = excluded.fee_incl,
                covered_json = excluded.covered_json
        `);
        for (const p of payouts) {
            insP.run(SOURCE, p.payout_uuid, p.occurred_at, p.amount_incl, p.gross_incl, p.fee_incl,
                JSON.stringify({ covered: p.covered, partial: p.partial, explained_incl: p.explained_incl }));
        }
        for (const d of days) {
            db.prepare(`UPDATE pos_sales_days SET fee_incl = ?, card_gross_incl = ?
                        WHERE source = ? AND business_date = ?`)
                .run(d.fee_incl, d.card_gross_incl, SOURCE, d.business_date);
        }
    });

    // Gebyr-bons — kun på dage der er koblet til et event.
    const feeBons = [];
    if (db.prepare("SELECT value FROM settings WHERE key='zettle_fee_bon_enabled'").get()?.value === '1') {
        for (const d of days) {
            if (!d.fee_incl) continue;
            const day = db.prepare('SELECT * FROM pos_sales_days WHERE source = ? AND business_date = ?')
                .get(SOURCE, d.business_date);
            if (!day?.event_id) continue;
            const event = db.prepare(`
                SELECT e.id, e.name, e.location_id, e.event_address_id, e.customer_id, e.company_id,
                       e.day_contact_name, e.day_contact_phone,
                       NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS contact_name,
                       c.phone AS contact_phone
                FROM events e LEFT JOIN customers c ON e.customer_id = c.id WHERE e.id = ?
            `).get(day.event_id);
            if (!event) continue;
            try {
                feeBons.push({ date: d.business_date,
                    ...applyFeeBon(db, { event, date: d.business_date, feeIncl: d.fee_incl, priceCategory: cfg.priceCategory, userId }) });
            } catch (err) {
                console.error(`[pos-finance] gebyr-bon for ${d.business_date} fejlede:`, err.message);
            }
        }
    }

    return { ok: true, from: windowFrom, to: windowTo, ledger: rows.length, payouts: payouts.length, days: days.length, fee_bons: feeBons };
}

/**
 * Kobl en udbetaling til bankposteringen og fordel beløbet.
 *
 * Fordelingen er præcis: hver dækket dags KORTsalg allokeres til dagens
 * salgsbon, og gebyret som én negativ linje. Summen rammer udbetalingen —
 * det er brutto+gebyr-modellen fra CLAUDE_PENGESTROEM §2.F.4.
 *
 * ⚠️ Kun kortdelen. MobilePay og kontant i dagens bon hører til andre penge og
 *    må ikke allokeres mod denne indbetaling.
 */
function matchPayout(db, { payoutUuid, transactionId, userId = null }) {
    const payout = db.prepare('SELECT * FROM pos_payouts WHERE source = ? AND payout_uuid = ?').get(SOURCE, payoutUuid);
    if (!payout) throw Object.assign(new Error('Udbetalingen findes ikke'), { code: 'unknown_payout' });
    if (payout.cf_transaction_id) {
        throw Object.assign(new Error(`Udbetalingen er allerede koblet til postering ${payout.cf_transaction_id}`), { code: 'already_matched' });
    }
    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(transactionId);
    if (!tx) throw Object.assign(new Error('Bankposteringen findes ikke'), { code: 'unknown_transaction' });
    if (Math.abs(tx.beloeb - payout.amount_incl) > 0.01) {
        throw Object.assign(
            new Error(`Beløbene er ikke ens: udbetaling ${payout.amount_incl} kr, postering ${tx.beloeb} kr`),
            { code: 'amount_mismatch' });
    }
    const alreadyAllocated = db.prepare('SELECT COUNT(*) c FROM cf_allocations WHERE transaction_id = ?').get(transactionId).c;
    if (alreadyAllocated) {
        throw Object.assign(new Error('Posteringen er allerede fordelt — ryd fordelingen først'), { code: 'already_allocated' });
    }

    const meta = JSON.parse(payout.covered_json || '{}');
    const covered = meta.covered || [];
    const alloc = [];
    let looseFee = 0;
    for (const c of covered) {
        const day = db.prepare('SELECT bon_id, fee_bon_id FROM pos_sales_days WHERE source = ? AND business_date = ?')
            .get(SOURCE, c.business_date);
        if (day?.bon_id && c.gross_incl) {
            alloc.push({ target_type: 'bon', target_id: String(day.bon_id), amount: round2(c.gross_incl),
                         note: `Zettle kortsalg ${c.business_date}` });
        }
        // Gebyret allokeres til dagens UDGIFTSBON når den findes. Beslutningen
        // fra 29. juni (CLAUDE_PENGESTROEM §2.F): på et event bogføres afgiften
        // som en udgiftsbon, og afstemningen vælger salgsbonnen (+) sammen med
        // udgiftsbonnerne (−) så Σ rammer netto-indbetalingen. En løs
        // fee-allokering ville lade udgiftsbonnen stå som uafstemt for evigt.
        if (!c.fee_incl) continue;
        if (day?.fee_bon_id) {
            alloc.push({ target_type: 'bon', target_id: String(day.fee_bon_id), amount: round2(c.fee_incl),
                         note: `Zettle kortgebyr ${c.business_date}` });
        } else {
            looseFee = round2(looseFee + c.fee_incl);   // dag uden event ⇒ ingen udgiftsbon at pege på
        }
    }
    if (looseFee) alloc.push({ target_type: 'fee', target_id: 'zettle', amount: looseFee, note: 'Zettle kortgebyr' });

    const sum = round2(alloc.reduce((s, a) => s + a.amount, 0));
    if (Math.abs(sum - payout.amount_incl) > 0.01) {
        throw Object.assign(
            new Error(`Fordelingen går ikke op: ${sum} kr mod udbetalingens ${payout.amount_incl} kr. `
                    + 'Sandsynligvis er en af de dækkede dage ikke koblet til et event endnu.'),
            { code: 'allocation_mismatch', sum, expected: payout.amount_incl });
    }

    transaction(db, () => {
        const ins = db.prepare(`INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount, note, created_by)
                                VALUES (?, ?, ?, ?, ?, ?)`);
        for (const a of alloc) ins.run(transactionId, a.target_type, a.target_id, a.amount, a.note, userId);
        db.prepare(`UPDATE pos_payouts SET cf_transaction_id = ?, matched_at = datetime('now'), matched_by_user_id = ?
                    WHERE source = ? AND payout_uuid = ?`).run(transactionId, userId, SOURCE, payoutUuid);
    });

    logChange({
        entityType: 'cf_transaction', entityId: transactionId, action: 'update', fieldName: 'pos_payout',
        newValue: payoutUuid, notes: `Zettle-udbetaling ${payout.amount_incl} kr fordelt på ${alloc.length} mål`, userId,
    });
    return { ok: true, allocations: alloc, payout_uuid: payoutUuid, transaction_id: transactionId };
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
    SOURCE, RECONCILE_STATUSES, assignDay, ownBon, ownFeeBon, startPolling, stopPolling,
    applyFeeBon, syncFinance, matchPayout, suggestBankMatch,
    getPosSettings, upsertPurchases, loadDayPurchases,
    candidateEvents, applyDayBon, rebuildDay, syncPos,
};
