// db/helpers.js
// ==========================================
// Server-side DB-hjælpere.
// Bruges af alle API-route-filer.
//
// NB: shared/utils.js er klient-side (dato-
// formatering, tal osv.) — denne fil er kun
// til server/backend-brug.
// ==========================================

const { getDb } = require('./database');
const { transaction } = require('./compat');
const bcrypt = require('bcryptjs');
const moms = require('../shared/moms');

/**
 * Næste bon-nummer (atomisk, transaction-sikret).
 * Returnerer fx "3261" eller "B-3261" med præfiks.
 */
function nextBonNumber() {
    const db = getDb();
    return transaction(db, () => {
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='bon_number_prefix'`).get()?.value ?? '';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='bon_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='bon_number_next'`).run(String(current + 1));
        return `${prefix}${current}`;
    });
}

/**
 * Næste tilbudsnummer.
 */
function nextQuoteNumber() {
    const db = getDb();
    return transaction(db, () => {
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='quote_number_prefix'`).get()?.value ?? 'T-';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='quote_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='quote_number_next'`).run(String(current + 1));
        return `${prefix}${current}`;
    });
}

/**
 * Log ændring til changelog.
 *
 * @param {object} o
 * @param {string}  o.entityType  'bon' | 'customer' | 'company' | 'quote'
 * @param {number}  o.entityId
 * @param {string}  o.action      'create' | 'update' | 'delete' | 'status_change'
 * @param {string}  [o.fieldName]
 * @param {*}       [o.oldValue]
 * @param {*}       [o.newValue]
 * @param {number}  [o.userId]
 * @param {string}  [o.notes]
 */
function logChange({ entityType, entityId, action, fieldName, oldValue, newValue, userId, notes, wasForced }) {
    // Patch D: wasForced=true sætter payload={was_forced, by_user_id} så audit-trailen
    // viser hvilke status-skift gik uden om normalt flow. Bagudkompatibelt — opkald
    // uden wasForced får payload=NULL og opfører sig som før.
    const payload = wasForced
        ? JSON.stringify({ was_forced: true, by_user_id: userId ?? null })
        : null;

    getDb().prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        entityType, entityId, action,
        fieldName ?? null,
        oldValue != null ? String(oldValue) : null,
        newValue != null ? String(newValue) : null,
        userId   ?? null,
        notes    ?? null,
        payload
    );
}

/**
 * Express route-wrapper der fanger fejl og returnerer 500.
 *
 * Brug:
 *   router.get('/sti', handle(async (req, res) => { ... }));
 */
function handle(fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            console.error('[API fejl]', err.message);
            res.status(500).json({ error: err.message });
        }
    };
}

// ─── QUERY HELPERS ──────────────────────────────────────────

function getBonLines(bonId) {
    return getDb().prepare(`
        SELECT id, bon_id, grocy_recipe_id, product_name, category, quantity, unit,
               cost_price, unit_price, line_total, sort_order,
               is_accessory, special_request, co2e, pos_product_id, notes,
               -- block_type: tidsblokken på event-tilbud. Manglede her, så
               -- "kopiér ordre" ikke kunne lægge varerne tilbage i deres
               -- oprindelige blokke og smed alt i én (#427).
               block_type,
               -- offer_day_id: hvilken dag på et fler-dags-tilbud linjen hører
               -- til. NULL = alle dage (#425, migration 145).
               offer_day_id,
               -- moms_included: 0 = linjen ligger EX moms (migration 104,
               -- event-udgifter). Manglede her, så enhver kalder der kopierede
               -- linjer videre tavst gjorde dem til INCL-moms-linjer.
               moms_included,
               menu_group_id
        FROM bon_lines
        WHERE bon_id = ?
        ORDER BY sort_order, id
    `).all(bonId);
}

// Grocy auto-consume når en bon leveres. Idempotent via bons.inventory_deducted —
// kaldes både fra office-status-skift (routes/bons.js) og courier-levering
// (routes/delivery.js), men trækker kun lageret én gang. Fire-and-forget:
// Grocy-kaldet afventes ikke, så et langsomt/nede Grocy ikke blokerer svaret.
function autoConsumeBonInventory(bonId) {
    const db = getDb();
    // Slå bon op FØR flag-tjek — vi har brug for event-kontekst både til Vej B-
    // overstyringen og §5-gaten. Priskategori læses via FK→code
    // (price_categories.code) — IKKE den denormaliserede bons.price_category-TEXT-
    // kolonne, der ikke skrives ved nye bons og er stale.
    const bon = db.prepare(`
        SELECT b.inventory_deducted, b.event_id, e.model AS event_model, pc.code AS price_category_code
        FROM bons b
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        LEFT JOIN events e            ON b.event_id          = e.id
        WHERE b.id = ?
    `).get(bonId);
    if (!bon) return;
    if (bon.inventory_deducted === 1) {
        console.log(`[grocy_consume] bon ${bonId}: lager allerede trukket — skipper (idempotens)`);
        return;
    }
    // Event-scoped no-deduct (CLAUDE_EVENT.md §5) FØRST — en let-event salgsbon
    // må ALDRIG trække HQ-lager, uanset om det globale auto-deduct-flag er
    // tændt eller ej. Vi logger og markerer eksplicit 'event_prep_owns_stock'
    // så sporbarheden er entydig (uden denne tidlige gate ville en let-event
    // salgsbon med flag='0' bare returnere tidligt og efterlade INGEN log —
    // skippet ville se ud som "ren tilfældighed" fremfor en bevidst beslutning).
    // Festival-events gates ikke (de skal trække fra deres egen lokation).
    if (bon.event_id != null && bon.event_model === 'light' && bon.price_category_code !== 'produktion') {
        db.prepare(
            `UPDATE bons SET inventory_deducted = 1, inventory_deducted_at = CURRENT_TIMESTAMP,
                             inventory_deduct_status = 'event_prep_owns_stock' WHERE id = ?`
        ).run(bonId);
        logChange({ entityType: 'bon', entityId: bonId, action: 'grocy_consume', fieldName: 'stock', oldValue: null, newValue: 'event_prep_owns_stock' });
        console.log(`[grocy_consume] bon ${bonId}: event-salgsbon — træk sprunget over (prep ejer HQ-lageret)`);
        return;
    }
    // Vej B (CLAUDE_EVENT.md §11): det globale auto-deduct-flag styrer resten af
    // forretningen. En let-event prep/top-up-bon undtages — den trækker uanset
    // flag-state fordi event-modulet ejer sit eget træk. Idempotens-vagten ovenfor
    // sikrer at en evt. senere Vej A-flip ikke laver dobbelttræk på samme prep-bon.
    const isEventProduction =
        bon.event_id != null
        && bon.event_model === 'light'
        && bon.price_category_code === 'produktion';
    if (!isEventProduction) {
        const autoDeduct = db.prepare(`SELECT value FROM settings WHERE key = 'inventory_auto_deduct'`).get();
        if (!autoDeduct || autoDeduct.value !== '1') return;
    }
    const lines = getBonLines(bonId);
    // Manuelle pakke-overrides (kun event-prep-bons har dem) — trækker den
    // faktisk pakkede mængde i stedet for den BOM-beregnede, så HQ-lageret
    // afspejler hvad der fysisk forlod huset (inkl. buffer).
    const packingOverrides = getPrepPackingOverrides(bonId);
    // Ekstra buffer-varer (event-prep): produkter køkkenet tager MED OVENI
    // opskrifterne (fx 1 kg ekstra mayonnaise). Trækkes oven i BOM-forbruget.
    const packingExtras = getPrepPackingExtras(bonId);
    // Underopskrift-skalering (event-prep): tager køkkenet fx mere Frisk Grønt med,
    // skaleres underopskriftens råvarer proportionalt (factor pr. recipe_id).
    const recipeFactors = getPrepPackingRecipeFactors(bonId);
    const { consumeRecipes } = require('../services/grocyAdapter');
    consumeRecipes(lines, packingOverrides, packingExtras, recipeFactors).then(results => {
        const failed  = results.filter(r => !r.success);
        const partial = results.filter(r => r.partial);

        // ── #359: flaget må kun påstå noget der faktisk skete ────────────────
        //
        // consumeRecipes afviser ALDRIG — fejl pr. produkt fanges internt og
        // returneres som success:false, og selv en total resolver-fejl kommer
        // tilbage som et resolvet array. Sattes flaget ubetinget (som før), stod
        // en bon hvor hvert eneste Grocy-kald fik 500 som "lager trukket" — med
        // tidsstempel og changelog-post.
        //
        // Værre endnu: vagthunden (scripts/check-inventory-deduct.js) leder efter
        // leverede bons UDEN flaget. Fejlen SATTE flaget og gjorde dermed
        // kontrollen blind for præcis den tilstand den blev bygget til at fange.
        //
        // Reglen: flaget er en idempotens-vagt, ikke en kvittering. Det sættes når
        // en gentagelse ville gøre skade — altså når noget rent faktisk blev
        // trukket — og kun da.
        let state;
        if (results.length === 0) {
            // Intet at trække (ingen opskriftskoblede linjer). Legitim slutstilstand:
            // flaget sættes, ellers ville vagthunden råbe hver dag om en bon der
            // aldrig kan trække noget.
            state = 'empty';
        } else if (failed.length === results.length) {
            // Intet blev trukket. Flaget bliver stående på 0: sikkert at gentage,
            // og vagthunden fanger bonen i morgen tidlig.
            state = 'failed';
        } else if (failed.length) {
            // Nogle trukket, nogle fejlet. Flaget SKAL sættes — ellers dobbelt-trækker
            // en gentagelse dem der lykkedes. Til gengæld skal tilstanden være synlig,
            // så den kommer med i vagthundens rapport (samme princip som
            // goods_receipts' 'partially_approved').
            state = 'partial';
        } else {
            state = 'ok';
        }

        if (state === 'failed') {
            console.error(`[grocy_consume] bon ${bonId}: INTET trukket — alle ${failed.length} produkter fejlede. `
                        + `Flaget forbliver 0 så trækket kan gentages.`, failed);
        } else if (state === 'partial') {
            console.warn(`[grocy_consume] bon ${bonId}: DELVIST trukket — ${failed.length} af ${results.length} produkter fejlede:`, failed);
        } else if (state === 'empty') {
            console.log(`[grocy_consume] bon ${bonId}: intet at trække (ingen opskriftskoblede linjer)`);
        } else if (partial.length) {
            console.log(`[grocy_consume] bon ${bonId}: ${results.length} produkter trukket — ${partial.length} partial (rest lagt på shopping-list)`);
        } else {
            console.log(`[grocy_consume] bon ${bonId}: ${results.length} produkter forbrugt fra lager`);
        }

        if (state === 'failed') {
            // Status gemmes ALLIGEVEL — uden den ville en fejlet bon se ud præcis
            // som en bon der endnu ikke var forsøgt.
            db.prepare(`UPDATE bons SET inventory_deduct_status = 'failed' WHERE id = ?`).run(bonId);
        } else {
            db.prepare(
                `UPDATE bons SET inventory_deducted = 1, inventory_deducted_at = CURRENT_TIMESTAMP,
                                 inventory_deduct_status = ? WHERE id = ?`
            ).run(state, bonId);
        }
        logChange({ entityType: 'bon', entityId: bonId, action: 'grocy_consume', fieldName: 'stock', oldValue: null, newValue: JSON.stringify({ state, results }) });
    }).catch(err => {
        // Crash i selve .then() (ikke i Grocy-kaldene). Flaget røres ikke, så
        // trækket kan gentages — og status gør fejlen synlig.
        console.error(`[grocy_consume] bon ${bonId}: fejl:`, err.message);
        try {
            db.prepare(`UPDATE bons SET inventory_deduct_status = 'failed' WHERE id = ?`).run(bonId);
        } catch (_) { /* DB nede — loggen er alt vi har */ }
    });
}

// Manuelle pakke-overrides på en (event-prep) bon. Returnerer et Map
// product_id → packed_amount (stock-units). Bruges af autoConsumeBonInventory
// til at trække den faktisk pakkede mængde i stedet for den BOM-beregnede.
function getPrepPackingOverrides(bonId) {
    const rows = getDb().prepare(
        `SELECT product_id, packed_amount FROM prep_packing_overrides WHERE bon_id = ?`
    ).all(bonId);
    const map = new Map();
    for (const r of rows) map.set(parseInt(r.product_id), parseFloat(r.packed_amount));
    return map;
}

// Ekstra buffer-varer på en (event-prep) bon. Returnerer et array
// [{ product_id, amount }] i stock-units. Bruges af autoConsumeBonInventory →
// consumeRecipes til at trække ekstra-varer OVENI opskrifts-forbruget.
function getPrepPackingExtras(bonId) {
    return getDb().prepare(
        `SELECT product_id, amount FROM prep_packing_extras WHERE bon_id = ?`
    ).all(bonId).map(r => ({ product_id: parseInt(r.product_id), amount: parseFloat(r.amount) }));
}

// Underopskrift-skaleringsfaktorer på en (event-prep) bon. Returnerer et Map
// recipe_id → factor. Bruges af resolveConsumeItems til at skalere en
// underopskrifts råvarer proportionalt (fx 1,17 = 17 % mere Frisk Grønt).
function getPrepPackingRecipeFactors(bonId) {
    const rows = getDb().prepare(
        `SELECT recipe_id, factor FROM prep_packing_recipe_overrides WHERE bon_id = ?`
    ).all(bonId);
    const map = new Map();
    for (const r of rows) {
        const f = parseFloat(r.factor);
        if (f > 0) map.set(parseInt(r.recipe_id), f);
    }
    return map;
}

// Visuelle grupper på køkken-bonens menu-liste (titel + note + rækkefølge).
function getBonMenuGroups(bonId) {
    return getDb().prepare(`
        SELECT id, bon_id, title, note, sort_order
        FROM bon_menu_groups
        WHERE bon_id = ?
        ORDER BY sort_order, id
    `).all(bonId);
}

function getBon(id) {
    const db = getDb();
    const bon = db.prepare(`
        SELECT
            b.*,
            sd.code   AS status_code,
            sd.label  AS status_label,
            sd.color  AS status_color,
            sd.icon   AS status_icon,
            l.name    AS location_name,
            l.code    AS location_code,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            c.phone   AS contact_phone,
            c.email   AS contact_email,
            co.name   AS company_name,
            co.phone  AS company_phone,
            pc.code   AS price_category_code,
            ev.name   AS event_name,
            ev.model  AS event_model
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        JOIN   locations l           ON b.location_id = l.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        LEFT JOIN events ev          ON b.event_id = ev.id
        WHERE b.id = ?
    `).get(id);
    if (!bon) return null;

    if (bon.delivery_address_id) {
        bon.delivery_address = db.prepare(`
            SELECT street_name, street_name2, street_nr, postal_code, city, lat, lon
            FROM addresses WHERE id = ?
        `).get(bon.delivery_address_id);
    }

    bon.lines = getBonLines(id);
    bon.menu_groups = getBonMenuGroups(id);
    return bon;
}

function getStatusId(code) {
    return getDb().prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}

function getDefaultLocationId() {
    return getDb().prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id;
}

// ─── BON-OPRETTELSE (fælles) ──────────────────────────────
// Ét oprettelsespunkt der ejer de tværgående bekymringer: bon-nummer,
// status-default, location/priskategori-defaults, INSERT (superset-kolonnesæt),
// changelog og SSE-broadcast. Call-sites leverer normaliseret input og styrer
// changelog-tekst + broadcast-metadata gennem opts.
// Migreret indtil videre: web-orders + webhooks (#237). De øvrige 5 paths
// (quotes, bons manuel/event, events produktion, seed) adopterer den gradvist.
function createBon(input = {}) {
    const db = getDb();

    const statusId  = input.status_id ?? getStatusId(input.status_code || 'NY');
    const bonNumber = nextBonNumber();

    // Location: default HQ (bevarer web-orders/webhooks-adfærd), overstyrbar.
    let locationId = input.location_id;
    if (locationId == null) {
        const loc = db.prepare("SELECT id FROM locations WHERE code = 'hq' LIMIT 1").get();
        locationId = loc?.id || 1;
    }

    // Priskategori: default 'catering' (kode) hvis intet id leveret.
    let priceCategoryId = input.price_category_id;
    if (priceCategoryId === undefined) {
        const cat = db.prepare("SELECT id FROM price_categories WHERE code = ? LIMIT 1")
                      .get(input.price_category_code || 'catering');
        priceCategoryId = cat?.id || null;
    }

    // Felterne nedenfor er tilføjet additivt for tilbuds-konvertering (#425):
    // pickup_time, delivery_method, delivery_price, price_category (kode-teksten),
    // kitchen_info, internal_notes, total_price, created_by_user_id og
    // source_quote_id. Alle defaulter til det de var før, så web-orders og
    // webhooks opfører sig præcis som hidtil.
    const res = db.prepare(`
        INSERT INTO bons (
            bon_number, status_id, location_id,
            customer_id, company_id, price_category_id, price_category,
            order_date, delivery_date, delivery_time, pickup_time,
            delivery_type, delivery_method, delivery_address_id,
            pax, customer_wishes, invoice_info,
            day_contact_name, day_contact_phone,
            delivery_notes, delivery_price,
            kitchen_info, internal_notes,
            total_price, source_quote_id, created_by_user_id,
            payment_type, created_at, updated_at
        ) VALUES (
            ?, ?, ?,
            ?, ?, ?, ?,
            date('now'), ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
    `).run(
        bonNumber, statusId, locationId,
        input.customer_id ?? null, input.company_id ?? null, priceCategoryId,
        // Også NOT NULL. Kolonnen var ikke i INSERT'en før, så skemaets default
        // ('store') gjaldt — og den default beholdes bevidst her, så web-orders
        // og webhooks opfører sig præcis som før.
        //
        // ⚠️ Det efterlader en kendt uoverensstemmelse: `price_category_id`
        // defaulter til CATERING få linjer længere oppe, mens tekstfeltet bliver
        // 'store'. Tre bons i drift står sådan. At rette den her ville ændre
        // priskategorien på web-ordrer som en stille bivirkning af en helt anden
        // opgave — den fortjener sit eget issue.
        input.price_category ?? input.price_category_code ?? 'store',
        input.delivery_date ?? null, input.delivery_time ?? null, input.pickup_time ?? null,
        // `bons.delivery_type` er NOT NULL med DEFAULT 'delivery' i skemaet, men
        // et eksplicit null fra koden overskriver defaulten og giver en rå
        // constraint-fejl. Begge nuværende kaldere sender altid feltet, så det
        // har aldrig ramt drift — men en ny kalder der udelader det, skal ikke
        // møde "NOT NULL constraint failed".
        input.delivery_type ?? 'delivery', input.delivery_method ?? null, input.delivery_address_id ?? null,
        input.pax ?? null, input.customer_wishes ?? null, input.invoice_info ?? null,
        input.day_contact_name ?? null, input.day_contact_phone ?? null,
        input.delivery_notes ?? null, input.delivery_price ?? 0,
        input.kitchen_info ?? null, input.internal_notes ?? null,
        input.total_price ?? 0, input.source_quote_id ?? null, input.user_id ?? null,
        input.payment_type ?? 'invoice'
    );

    const bonId = Number(res.lastInsertRowid);

    logChange({
        entityType: 'bon',
        entityId: bonId,
        action: 'create',
        fieldName: input.changelog_field || 'create',
        oldValue: null,
        newValue: input.changelog_message || 'Oprettet',
        userId: input.user_id ?? null,
    });

    // `broadcast: false` for kaldere der opretter FLERE bons i én transaktion
    // (fler-dags-tilbud, #425). SSE kan ikke rulles tilbage: fejler bon nr. 3,
    // er nr. 1 og 2 allerede annonceret ud i huset selvom de aldrig kom til at
    // findes. De kaldere annoncerer selv, efter commit.
    if (input.broadcast !== false) {
        // Lazy-require for at undgå cirkulær afhængighed (samme mønster som
        // autoConsumeBonInventory's grocyAdapter-require ovenfor).
        const { broadcast } = require('../shared/sse');
        broadcast('bon_created', { id: bonId, bon_number: bonNumber, ...(input.broadcast_extra || {}) });
    }

    return { bonId, bonNumber };
}

// ─── DATO (lokal tid) ─────────────────────────────────────
// `new Date().toISOString().slice(0,10)` giver UTC-dato. Efter midnat dansk
// tid (UTC+1/+2) peger den stadig på i går, så "I dag"-filtre rammer
// gårsdagens bons. todayISO() returnerer altid den danske kalenderdato.
// en-CA-locale formaterer som YYYY-MM-DD.
function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
}

// Lokal dato N dage fra i dag (negativ = bagud). Bevarer YYYY-MM-DD.
function offsetISO(days) {
    const parts = todayISO().split('-').map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// ─── ENHEDER-TÆLLING ──────────────────────────────────────
// Kun kategorier i settings.unit_count_categories tæller med i bons.total_units.
// Grocy `grupper`-userfield er master for hvilke kategorier der findes;
// settings udvælger hvilke der skal tælles. Listen redigeres i Settings.

let _unitCatCache = null;
let _unitCatCacheUntil = 0;
let _unitExtraCache = null;
let _unitExtraCacheUntil = 0;

function getUnitCountCategories() {
    const now = Date.now();
    if (_unitCatCache && now < _unitCatCacheUntil) return _unitCatCache;
    const row = getDb().prepare(`SELECT value FROM settings WHERE key='unit_count_categories'`).get();
    let list = [];
    if (row?.value) {
        try { list = JSON.parse(row.value); } catch { list = []; }
        if (!Array.isArray(list)) list = [];
    }
    _unitCatCache = list;
    _unitCatCacheUntil = now + 60_000;
    return list;
}

// Grocy recipe-id der tæller som 1 enhed selvom kategorien ikke er whitelisted
// (fx Børne Bokse i den blandede "Tilbehør & Bokse"-kategori). Bruges som
// fallback når en linje ikke har en recipe_unit_counts-række endnu.
function getUnitCountExtraRecipes() {
    const now = Date.now();
    if (_unitExtraCache && now < _unitExtraCacheUntil) return _unitExtraCache;
    const row = getDb().prepare(`SELECT value FROM settings WHERE key='unit_count_extra_recipes'`).get();
    let list = [];
    if (row?.value) {
        try { list = JSON.parse(row.value); } catch { list = []; }
        if (!Array.isArray(list)) list = [];
    }
    list = list.map(Number).filter(n => Number.isFinite(n));
    _unitExtraCache = list;
    _unitExtraCacheUntil = now + 60_000;
    return list;
}

function invalidateUnitCountCache() {
    _unitCatCache = null;
    _unitCatCacheUntil = 0;
    _unitExtraCache = null;
    _unitExtraCacheUntil = 0;
}

// ── Betalingstyper der ikke er omsætning (Modregning/Sponsorat, migration 129) ──
// Kilde er payment_types.counts_as_revenue-flaget, ikke hardkodede koder — så
// den næste "gratis"-type koster én række + et flueben i Settings.
let _nonRevCache = null;
let _nonRevCacheUntil = 0;

function getNonRevenuePaymentCodes() {
    const now = Date.now();
    if (_nonRevCache && now < _nonRevCacheUntil) return _nonRevCache;
    let codes = [];
    try {
        codes = getDb()
            .prepare(`SELECT code FROM payment_types WHERE COALESCE(counts_as_revenue, 1) = 0`)
            .all()
            .map(r => r.code);
    } catch { codes = []; }  // kolonnen findes ikke før migration 129 er kørt
    _nonRevCache = codes;
    _nonRevCacheUntil = now + 60_000;
    return codes;
}

function invalidateNonRevenueCache() {
    _nonRevCache = null;
    _nonRevCacheUntil = 0;
}

function _nonRevCodeList() {
    const codes = getNonRevenuePaymentCodes();
    if (!codes.length) return null;
    return codes.map(c => `'${String(c).replace(/'/g, "''")}'`).join(', ');
}

// SQL-multiplikator til krone-summer: 0 for ikke-omsætnings-betalingstyper, 1 ellers.
// Brug: `SUM(b.total_price ${revenueFactorSQL('b')})`. Rører ALDRIG enheder/pax.
// Bruges hvor bonnen stadig skal tælle med i aktivitet (produktion/enheder/P&L-omkostning)
// men ikke bidrage kroner. Returnerer '' når ingen typer er markeret.
function revenueFactorSQL(bonAlias = 'b') {
    const list = _nonRevCodeList();
    return list ? ` * CASE WHEN ${bonAlias}.payment_type IN (${list}) THEN 0 ELSE 1 END` : '';
}

// WHERE-fragment der udelukker ikke-omsætnings-bons HELT. Brug hvor en giveaway
// ville forvrænge tallet ved at bidrage enheder/omkostning uden omsætning (fx
// opskrift-margin). Brug: `... WHERE 1=1 ${nonRevenueBonExcludeSQL('b')}`.
function nonRevenueBonExcludeSQL(bonAlias = 'b') {
    const list = _nonRevCodeList();
    return list ? ` AND COALESCE(${bonAlias}.payment_type, '') NOT IN (${list})` : '';
}

/**
 * Delt enheds-udtryk — ÉN definition af "hvor mange enheder bidrager en
 * bon_lines-række med", genbrugt af recalcBonTotalUnits, drift og backfill.
 *
 * Forudsætter at bon_lines har alias `bl`. Returnerer:
 *   contrib  SQL-udtryk for enheds-bidrag pr. linje (skal SUM'es)
 *   join     LEFT JOIN mod recipe_unit_counts (boks-ekspansion)
 *   args     bind-parametre der hører til `contrib` (skal komme FØRST i .get/.all)
 *
 * ARKIV-ROBUST tællbarhed (vigtig): en linje TÆLLER hvis ÉN af disse holder:
 *   1) linjens SNAPSHOT-kategori (bon_lines.category) er tællende, ELLER
 *   2) recipen er på extra-listen (fx Børne Bokse), ELLER
 *   3) recipens NUVÆRENDE Grocy-kategori er tællende (ruc.unit_count >= 1) —
 *      fanger fejl-kategoriserede snapshots (fx 'lunch' → grocy '01 Sandwich').
 * Snapshot-kriteriet (1) er afgørende: når en opskrift ARKIVERES (flyttes til
 * "gamle opskrifter" i Grocy) skifter dens grupper, og ruc.unit_count bliver 0 —
 * men historiske bons skal stadig tælle den slider de FAKTISK solgte. Derfor må
 * arkivering aldrig ændre fortidens tal.
 *
 * Boks-MULTIPLIKATOR (×3 for slider-bokse) kommer fortsat fra recipe_unit_counts:
 * når ruc.unit_count >= 2 er det en kombo-boks → gang med antallet; ellers ×1.
 * En arkiveret boks der beholder sine underopskrifter tæller stadig korrekt
 * (børnene er tællende → ruc forbliver 3). Tilbehør (is_accessory) filtreres i
 * WHERE af kald-stedet.
 */
function bonUnitsExpr() {
    const p = unitCountablePredicate();
    const contrib = `bl.quantity * CASE
        WHEN ${p.sql}
        THEN CASE WHEN COALESCE(ruc.unit_count, 0) >= 2 THEN ruc.unit_count ELSE 1 END
        ELSE 0 END`;
    return { contrib, join: p.join, args: p.args };
}

/**
 * BOOLEAN-delen af bonUnitsExpr: "tæller denne linje som en solgt enhed?"
 * (uden boks-multiplikatoren). Samme tre kriterier, samme arkiv-robusthed.
 *
 * Udskilt fordi produktlister skal kunne SKILLE mad fra emballage/drikke/kager
 * uden at ændre selve tællingen — fx dashboardets "Top produkter", hvor
 * RR Boks ellers lægger sig øverst fordi den ligger på næsten hver bon.
 * Ét sted at ændre reglen, så listen og `bons.total_units` ikke driver fra
 * hinanden.
 *
 * COALESCE på begge kolonner er bevidst: uden den giver `NULL IN (...)` et
 * NULL-prædikat, og så ville en linje uden kategori falde ud af BÅDE `sql`
 * og `NOT sql` — altså forsvinde helt fra en opdelt visning. I bonUnitsExpr
 * er semantikken uændret (NULL ramte allerede ELSE-grenen).
 *
 * Returnerer { sql, join, args } — forudsætter alias `bl` på bon_lines.
 */
function unitCountablePredicate() {
    const cats = getUnitCountCategories();
    const extra = getUnitCountExtraRecipes();
    const catClause = cats.length
        ? `COALESCE(bl.category, '') IN (${cats.map(() => '?').join(',')})` : '0';
    const extraClause = extra.length
        ? `COALESCE(bl.grocy_recipe_id, 0) IN (${extra.map(() => '?').join(',')})` : '0';
    return {
        sql: `(${catClause} OR ${extraClause} OR COALESCE(ruc.unit_count, 0) >= 1)`,
        join: `LEFT JOIN recipe_unit_counts ruc ON ruc.grocy_recipe_id = bl.grocy_recipe_id`,
        args: [...cats, ...extra],
    };
}

/**
 * Genberegn total_units på en bon — boks-aware (se bonUnitsExpr).
 * Returnerer den nye total.
 */
function recalcBonTotalUnits(db, bonId) {
    const { contrib, join, args } = bonUnitsExpr();
    const total = db.prepare(`
        SELECT COALESCE(SUM(${contrib}), 0) AS t
        FROM bon_lines bl
        ${join}
        WHERE bl.bon_id = ?
          AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
    `).get(...args, bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);
    // F6: total_co2e vedligeholdes samme sted som total_units (kaldes ved alle
    // linje-ændringer) — så de to bon-aggregater altid er i sync.
    recalcBonTotalCo2e(db, bonId);
    return total;
}

/**
 * CO₂ F6 — genberegn bons.total_co2e = Σ(bon_lines.co2e × quantity).
 * bon_lines.co2e er frosset pr. enhed ved linje-oprettelse, så summen er også
 * frosset (ændres ikke bagud når faktorer opdateres). Kaldes samme steder som
 * recalcBonTotalUnits. Returnerer den nye total.
 */
function recalcBonTotalCo2e(db, bonId) {
    const total = db.prepare(`
        SELECT COALESCE(SUM(co2e * quantity), 0) AS t
          FROM bon_lines
         WHERE bon_id = ?
    `).get(bonId).t;
    db.prepare(`UPDATE bons SET total_co2e = ? WHERE id = ?`).run(total, bonId);
    return total;
}

/**
 * recalcBonTotal — server-autoritativ recalc af bons.total_price (INCL moms) fra
 * bon_lines. Håndterer levering (undgår dobbelt-tælling hvis der findes en
 * 'x-Levering'-linje) + stående/tilbuds-rabat (offer_discount_percent).
 * Flyttet hertil fra routes/bons.js så både bon-routen OG web-order-webhooken
 * bruger nøjagtig samme beregning (#382). Returnerer den nye total.
 */
function recalcBonTotal(db, bonId, opts = {}) {
    const bon = db.prepare('SELECT total_price, total_with_delivery, delivery_price, offer_discount_percent FROM bons WHERE id = ?').get(bonId);
    if (!bon) return null;
    const lines = db.prepare('SELECT line_total, category FROM bon_lines WHERE bon_id = ?').all(bonId);
    const hasLeveringLine = lines.some(l => l.category === 'x-Levering');
    const linesSum = lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const deliveryAdd = hasLeveringLine ? 0 : (bon.delivery_price ?? 0);
    const subtotal = linesSum + deliveryAdd;
    const discount = bon.offer_discount_percent ? subtotal * (bon.offer_discount_percent / 100) : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;

    db.prepare('UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(total, total, bonId);

    // Log spor hvis totalen rykker mere end 1 kr — synligt for brugeren der åbner bonnen senere
    if (opts.logIfChanged && bon.total_price != null && Math.abs((bon.total_price ?? 0) - total) > 1) {
        logChange({
            entityType: 'bon', entityId: bonId,
            action: 'update', fieldName: 'total_price',
            oldValue: bon.total_price, newValue: total,
            notes: 'Auto-recalc',
            userId: opts.userId ?? null,
        });
    }
    return total;
}

/**
 * ── Event-roller og produktions-workload ───────────────────────────
 * Et festival-/event-salg er splittet i to slags bonner (event_role):
 *   - prep / topup  → det køkkenet PRODUCERER (priskategori 'produktion')
 *   - sales         → det der SÆLGES på pladsen (samme mad, allerede talt i prep)
 *   - expense       → en udgiftslinje (negativ pris)
 *
 * Køkken-planlægningsvisninger (kalender, ugeoversigt, planlægning, dashboard
 * "I dag") tæller PRODUKTIONS-enheder/workload. Dér må 'sales' og 'expense'
 * IKKE tælle med — ellers dobbelttælles festival-maden (prep + salg). Salget
 * hører hjemme i økonomi-/omsætnings-tallene (rapporter, MTD), hvor det tælles
 * som sædvanligt. Dette er ÉN sandhed for reglen — brug den alle steder.
 */
const WORKLOAD_EXCLUDED_EVENT_ROLES = ['sales', 'expense'];

/** True hvis bonen tæller som produktions-workload (ikke festival-salg/udgift). */
function countsAsWorkload(bon) {
    return !WORKLOAD_EXCLUDED_EVENT_ROLES.includes(bon && bon.event_role);
}

/**
 * SQL-fragment til WHERE/CASE der ekskluderer festival-salg + udgift fra
 * produktions-enheder. `col` er kolonne-udtrykket for event_role (fx 'b.event_role').
 * NULL = normal bon → tæller med.
 */
function workloadRoleSql(col = 'event_role') {
    return `COALESCE(${col}, '') NOT IN ('sales','expense')`;
}

/**
 * ── Salgs-enheder (økonomi-linsen) ──────────────────────────────────
 * Spejlbilledet af produktions-workload: økonomi-/omsætningsvisninger
 * (rapporter, dashboard MTD, top-produkter) tæller SOLGTE enheder. Dér må
 * produktions-bonnerne (priskategori 'produktion' = prep/top-up, 0 kr) IKKE
 * tælle med — de er intern produktion, ikke salg. Festival-salget (priskategori
 * 'festival') tæller derimod fuldt med. Dermed tælles festival-maden aldrig
 * dobbelt: produktions-linsen ekskluderer salg, salgs-linsen ekskluderer produktion.
 *
 * Omsætning/kr røres ALDRIG — produktion er alligevel 0 kr, så den påvirker ikke
 * revenue. Kun enheds-/antalstal gates med dette.
 *
 * NB: brug FK'en price_categories.code (join på price_category_id) — IKKE den
 * denormaliserede bons.price_category-TEXT, der er stale på nye bons.
 */
/** True hvis bonen tæller som salg (ikke intern produktion). */
function countsAsSale(bon) {
    return (bon && bon.price_category_code) !== 'produktion';
}

/**
 * SQL-fragment til WHERE/CASE der ekskluderer produktion fra salgs-enheder.
 * `col` er kolonne-udtrykket for priskategori-koden (fx 'pc.code'). Kræver at
 * price_categories er joinet via price_category_id.
 */
function salesPriceCategorySql(col = 'pc.code') {
    return `COALESCE(${col}, '') != 'produktion'`;
}

// ─── AUTH HELPERS ──────────────────────────────────────────

async function hashPassword(plain) {
    return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

function getUserByEmail(email) {
    return getDb().prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
}

function getUserById(id) {
    // modules_json SKAL med — userCan() læser per-bruger-overrides herfra. Uden
    // den falder alle overrides lydløst tilbage til rolle-default (var en latent bug).
    return getDb().prepare('SELECT id, name, email, role, pin, modules_json FROM users WHERE id = ? AND is_active = 1').get(id);
}

/**
 * Den indloggede brugers id fra sessionen, eller null.
 * Login sætter ET fladt felt: req.session.userId (jf. routes/auth.js).
 * `req.session.user` populeres ALDRIG — læs derfor ALDRIG req.session.user.id.
 * Brug denne helper i stedet for at gentage mønstret (og fejle igen).
 */
function getUserId(req) {
    return req?.session?.userId ?? null;
}

module.exports = {
    nextBonNumber, nextQuoteNumber, logChange, handle,
    getBon, getBonLines, getBonMenuGroups, getPrepPackingOverrides, getPrepPackingExtras, getPrepPackingRecipeFactors, getStatusId, getDefaultLocationId,
    createBon,
    todayISO, offsetISO,
    autoConsumeBonInventory,
    getUnitCountCategories, getUnitCountExtraRecipes, invalidateUnitCountCache,
    getNonRevenuePaymentCodes, revenueFactorSQL, nonRevenueBonExcludeSQL, invalidateNonRevenueCache,
    bonUnitsExpr, unitCountablePredicate,
    recalcBonTotalUnits, recalcBonTotalCo2e, recalcBonTotal,
    WORKLOAD_EXCLUDED_EVENT_ROLES, countsAsWorkload, workloadRoleSql,
    countsAsSale, salesPriceCategorySql,
    hashPassword, verifyPassword, getUserByEmail, getUserById, getUserId,
    transaction,
    // Moms-helpers (re-eksporteret fra shared/moms.js — én definition for hele Bon v2)
    MOMS_RATE: moms.MOMS_RATE,
    MOMS_FACTOR: moms.MOMS_FACTOR,
    inclToExcl: moms.inclToExcl,
    exclToIncl: moms.exclToIncl,
    momsOfIncl: moms.momsOfIncl,
    computeMomsFields: moms.computeMomsFields,
    applyDiscount: moms.applyDiscount,
};
