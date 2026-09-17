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


/**
 * Lav de Hurtig-mellemprodukter bonen mangler, inden lageret trækkes (#267).
 *
 * Ligger her, ikke i `services/autoBatch.js`, fordi den binder Grocy-data,
 * databasen og changelog sammen — selve BESLUTNINGEN (hvor mange hele batches,
 * hvad rækker råvarerne til, hvad mangler) er ren og testbar derovre.
 */
async function autoBatchForBon(bonId, lines, recipeFactors, packingOverrides = null, packingExtras = null) {
    const grocy = require('../services/grocyAdapter');
    const { resolveConsumeItems } = require('../services/ingredientResolver');
    const { planAutoBatches, runAutoBatches } = require('../services/autoBatch');
    const { unitCostFromStockRow } = require('../services/production');

    const needs = await resolveConsumeItems(lines, recipeFactors);
    // Extras kan tilføje varer der slet ikke står i opskrifterne, så en tom
    // liste først er tom når de også er tomme.
    if (!needs.length && !(packingExtras && packingExtras.length)) return;

    const [rawRecipeMap, allPos, nestings, products, units, quConversions, stock] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
        // FRISKT lager (#589). Planen herunder afgør hvor meget der trækkes af
        // hver råvare, og siden #560 gør den det også når råvarerne kun rækker
        // delvist — altså netop for de varer der ligger tæt på nul, og som er
        // dem der fejler når tallet er gammelt. Opskrifter, produkter og enheder
        // er stamdata og bliver ved med at være cachede.
        grocy.getStockFresh(),
    ]);

    const posByRecipe = {}, nestingsByRecipe = {};
    for (const p of allPos) (posByRecipe[p.recipe_id] ||= []).push(p);
    for (const n of nestings) (nestingsByRecipe[n.recipe_id] ||= []).push(n);

    // Samme pakke-justeringer som selve trækket bruger.
    //
    // Uden dem regnede auto-batchen på det BOM-beregnede behov mens
    // `consumeRecipes` trak det PAKKEDE. Tog køkkenet 2,5 kg med i stedet for
    // de beregnede 0,9, producerede Bon til 0,9 og trak 2,5 — og forskellen
    // forsvandt ned i mellemproduktet, som gik i minus. Latent indtil nu, fordi
    // Remoulade er den eneste konverterede blanding og ingen har lagt en buffer
    // på den; #270 gør det live på Frisk Grønt, der både sidder i 28 retter
    // og HAR buffer-mekanikken i event-prep.
    //
    // De to sider skal regne på det samme tal.
    const productMap = new Map(products.map(p => [p.id, p]));
    grocy.applyPackingAdjustments(needs, packingOverrides, packingExtras, productMap);
    if (!needs.length) return;

    const plan = planAutoBatches({
        needs, rawRecipeMap, posByRecipe, nestingsByRecipe,
        productMap,
        unitMap: new Map(units.map(u => [Number(u.id), u])),
        quConversions,
        // Samme lager-opslag som trækket bruger: børnenes lager ruller op på
        // forælderen, ellers ville "kål" altid se tom ud (#327).
        effectiveStock: grocy.makeEffectiveStock(stock, products),
    });
    if (!plan.batches.length && !plan.skipped.length) return;

    const costMap = {};
    for (const s of stock) {
        const c = unitCostFromStockRow(s);
        if (c != null) costMap[s.product_id] = c;
    }

    const out = await runAutoBatches(bonId, plan, {
        db: getDb(), grocy, locationId: getDefaultLocationId(),
        unitCost: (pid) => costMap[pid] ?? 0,
        logChange,
    });
    if (out.produced.length) {
        console.log(`[auto_batch] bon ${bonId}: ${out.produced.length} produktion(er) lavet — `
                  + out.produced.map(p => `${p.product_name} ${p.amount}`).join(', '));
    }
    if (out.shortages.length) {
        console.warn(`[auto_batch] bon ${bonId}: råvarer manglede til `
                   + out.shortages.map(s => s.product_name).join(', ')
                   + ' — lagt på indkøbslisten');
    }
    if (out.skipped.length) {
        console.warn(`[auto_batch] bon ${bonId}: sprunget over (udbytte ikke oplyst i Grocy): `
                   + out.skipped.map(s => s.recipe_name).join(', '));
    }
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
    // ── Hurtig-produktion FØR trækket (#267) ────────────────────────────────
    // Mangler der mayonnaise, laver Bon den — af råvarer der er på lager —
    // og trækker derefter som normalt. Selvkorrektion: lavede personalet den
    // uden at registrere noget, står råvarerne fysisk væk mens Grocy tæller
    // dem, og produktet står fysisk mens Grocy siger 0. Begge sider flytter
    // mod virkeligheden.
    //
    // Fejler den, fortsætter trækket. Leveringen blokeres aldrig.
    autoBatchForBon(bonId, lines, recipeFactors, packingOverrides, packingExtras)
      .catch(err => { console.error(`[auto_batch] bon ${bonId}: fejl:`, err.message); })
      .then(() => consumeRecipes(lines, packingOverrides, packingExtras, recipeFactors)).then(results => {
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
            -- Kom bonen fra bestillingsformularen? Kundeønske-feltet er da
            -- maskingenereret fra kundens menu-valg og kan holdes op mod
            -- varelinjerne; på en almindelig bon er det en menneskeskrevet note.
            EXISTS (SELECT 1 FROM web_orders wo WHERE wo.bon_id = b.id) AS from_web_order,
            l.name    AS location_name,
            l.code    AS location_code,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            c.phone   AS contact_phone,
            c.email   AS contact_email,
            co.name   AS company_name,
            co.phone  AS company_phone,
            -- Den STÅENDE rabat på firmaet/kunden — ikke bonens egen sats.
            -- Bonens offer_discount_percent er et snapshot fra oprettelsen
            -- (migration 111), så de to kan afvige: aftales en rabat i dag,
            -- bærer bons der allerede ligger i køen stadig 0. Draweren viser
            -- forskellen og tilbyder at hente den igen — uden de to felter
            -- side om side er den forskel usynlig.
            co.discount_percent AS company_discount_percent,
            c.discount_percent  AS customer_discount_percent,
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

    // Tilbuddet bonnen kom af. `source_quote_id` alene er et tal ingen kan
    // slå op i hovedet — nummeret er det man leder efter når man står med en
    // bon og skal finde den aftale kunden godkendte.
    if (bon.source_quote_id) {
        bon.source_quote_number = db.prepare('SELECT bon_number FROM bons WHERE id = ?')
                                    .get(bon.source_quote_id)?.bon_number ?? null;
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
            day_contact_name, day_contact_phone, end_customer_name,
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
            ?, ?, ?,
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
        // Slutkunde (forhandler-ordrer, migration 167). Fri tekst, defaulter til
        // null ⇒ alle eksisterende kaldere er upåvirkede.
        input.end_customer_name ?? null,
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
/**
 * Et rent tal i et søgefelt er også et kunde- eller firma-id.
 *
 * Listerne VISER id'et — firma-listen med tooltip'en "brug til sammenlægning" —
 * men søgefeltet lige ovenover kunne ikke finde det. Man kommer med id'et i
 * hånden fra en changelog-linje, et oprydnings-script eller en fejlbesked, og
 * stod så uden vej ind.
 *
 * EKSAKT match, aldrig delstreng: `4019` må ikke også trække 14019 og 40190 med.
 * Og det ERSTATTER ikke tekstsøgningen — `4019` skal stadig kunne ramme et
 * telefonnummer der indeholder cifrene. Præcis dét skete i drift, hvor en
 * søgning på et kunde-id fandt seks rækker med Ristet Rugs eget mobilnummer.
 *
 * Øvre længde på 9 cifre holder et absurd langt tal ude af en heltals-kolonne;
 * et telefonnummer eller et EAN er ikke et id.
 *
 * Havelågen accepteres, fordi listerne VISER id'et som "#4019" og felterne
 * inviterer til den skrivemåde. Uden den afviste søgningen sin egen notation.
 *
 * Den skærper samtidig: ingen navn, mail eller telefon indeholder en havelåge,
 * så "#4019" rammer kun id'et, mens "4019" også tager de brede tekst-træffere
 * med. To niveauer af præcision uden et ekstra felt.
 *
 * @returns {number|null} id'et, eller null hvis søgeteksten ikke er et rent tal
 */
function searchAsId(q) {
    const t = String(q ?? '').trim().replace(/^#/, '');
    return /^\d{1,9}$/.test(t) ? Number(t) : null;
}

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

// ─── TIDSSTEMPEL TIL DATABASEN ────────────────────────────
// Databasen gemmer tidsstempler i UTC, i SQLites eget format:
// `YYYY-MM-DD HH:MM:SS` — det `datetime('now')` producerer.
//
// Her er UTC altså RIGTIGT, modsat todayISO() ovenfor. Fælden er en anden:
// blandes de to skrivemåder i samme kolonnefamilie, sammenlignes de som TEKST,
// og `'T'` (0x54) sorterer efter `' '` (0x20). Inbound-mails blev gemt med
// `toISOString()` og outbound med `datetime('now')`, så en tråd med indgående
// som seneste aktivitet lagde sig over enhver tråd med udgående fra samme dag,
// uanset klokkeslæt. "Nyeste øverst" holdt kun på tværs af dage (#488).
//
// Brug denne til ethvert tidsstempel der skal kunne sammenlignes med
// `datetime('now')`-skrevne kolonner.
function sqlTime(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    // utc-ok: databasens tidsstempler ER UTC — samme skala som datetime('now')
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ─── DANSK DØGN → UTC-GRÆNSER ─────────────────────────────
// "Sendt i dag" betyder dansk døgn, men databasen gemmer UTC. Mellem
// midnat og kl. 02 (sommertid) ligger en dansk dag derfor på to UTC-datoer,
// og et filter på `date(sent_at) = ?` ville tabe nattens og få gårsdagens
// sene mails med. Vi regner i stedet det UTC-øjeblik ud hvor den danske dag
// begynder, og sammenligner tidsstempler i databasens eget format.
//
// Beregningen afhænger ikke af serverens tidszone: den gættes først som
// UTC-midnat, og forskydningen aflæses med Intl for netop den dato (så
// sommertid/vintertid håndteres pr. dag). To omgange er nok — skiftet sker
// kl. 02/03, aldrig ved midnat.
function copenhagenDayStartSql(isoDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
    if (!m) return null;
    const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (Number.isNaN(target)) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Copenhagen', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    let t = target;
    for (let i = 0; i < 2; i++) {
        const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
        const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
        t -= (wall - target);
    }
    return sqlTime(new Date(t));
}

// Dansk kalenderdato ± N dage (ren datoregning, ingen tidszone).
function addDaysISO(isoDate, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    d.setUTCDate(d.getUTCDate() + days);
    // utc-ok: ren kalenderregning på en UTC-midnat — ingen klokkeslæt involveret
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

// ── KOSTPRIS-VINDUET (#557) ───────────────────────────────
// Hvor mange dages indkøb kostprisen vægtes over. Default og grænser bor i
// `services/recipeCost.js` sammen med reglen selv; her læses kun den aktive
// værdi. Indstillingen redigeres i ⚙-popoveren inde i Opskrifter & priser.
let _costWindowCache = null;
let _costWindowCacheUntil = 0;

function getRecipeCostWindowDays() {
    const now = Date.now();
    if (_costWindowCache != null && now < _costWindowCacheUntil) return _costWindowCache;
    const { clampWindowDays, PRICE_WINDOW_DAYS_DEFAULT } = require('../services/recipeCost');
    let dage = PRICE_WINDOW_DAYS_DEFAULT;
    try {
        const row = getDb().prepare(
            `SELECT value FROM settings WHERE key='recipe_cost_price_window_days'`).get();
        // En tom eller vrøvlet værdi må ikke slå kostprisen ihjel — clampen
        // falder tilbage på defaulten, og tallet står synligt i overskriften
        // på Opskrifter & priser, så en fejl kan ses.
        if (row?.value != null && String(row.value).trim() !== '') dage = clampWindowDays(row.value);
    } catch { /* DB nede → default */ }
    _costWindowCache = dage;
    _costWindowCacheUntil = now + 60_000;
    return dage;
}

function invalidateRecipeCostWindowCache() {
    _costWindowCache = null;
    _costWindowCacheUntil = 0;
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
/**
 * insertBonLines — skriv linjer på en bon og få tallene til at passe bagefter.
 *
 * Samler de fire ting der ALTID hører sammen når linjer lægges maskinelt på en
 * bon: INSERT, recalc af enheder, recalc af totalen og et changelog-spor. Lå de
 * hos hver kalder, ville de drive fra hinanden — og en glemt recalc er usynlig
 * indtil et tal et helt andet sted er forkert.
 *
 * `lines` har formen fra services/menuItemsToLines.js (resolveMenuItemLines).
 * Linjer uden pris får `line_total = null`, ikke 0: prisen er ukendt, ikke gratis.
 *
 * @returns {number} antal indsatte linjer
 */
function insertBonLines(db, bonId, lines, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) return 0;

    const insert = db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
            cost_price, unit_price, line_total, sort_order, is_accessory, special_request, co2e, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let sort = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS mx FROM bon_lines WHERE bon_id = ?`).get(bonId).mx;
    for (const l of lines) {
        const lineTotal = (l.unit_price != null && l.quantity) ? l.quantity * l.unit_price : null;
        insert.run(
            bonId, l.grocy_recipe_id, l.product_name, l.category, l.quantity, l.unit,
            l.cost_price, l.unit_price, lineTotal, ++sort, 0, null, l.co2e, null
        );
    }

    // Server-autoritativ recalc — samme helpers som POST /:id/lines.
    recalcBonTotalUnits(db, bonId);
    recalcBonTotal(db, bonId, { logIfChanged: false });

    logChange({
        entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines',
        newValue: opts.changelogMessage || `${lines.length} linje(r) auto-genereret`,
        notes: opts.notes || null,
        userId: opts.userId ?? null,
    });

    if (opts.broadcast !== false) {
        const { broadcast } = require('../shared/sse');
        broadcast('bon_updated', { id: bonId });
    }
    return lines.length;
}

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
/**
 * Har bonen en linje der REPRÆSENTERER leveringen?
 *
 * Reglen har hidtil været "findes der en x-Levering-linje?" og bor fire steder
 * (her, routes/bons.js, routes/quotes.js, services/economicInvoice.js). Den er
 * samlet her fordi den fik en undtagelse: et STANDARDGEBYR (settings.auto_fee_rules,
 * fx miljøbidraget) er også en x-Levering-opskrift i Grocy, men det er ikke en
 * levering. Uden undtagelsen ville et gebyr på 36 kr få recalcBonTotal til at tro
 * at leveringen allerede lå som linje — og lade `bons.delivery_price` (fx 180 kr)
 * falde ud af totalen OG af e-conomic-fakturaen. Det nye logistik-system gemmer
 * netop levering linjeløst på delivery_price, så det ville ramme fremadrettet.
 *
 * Kræver at linjerne har `grocy_recipe_id` med — ellers kan et gebyr ikke skelnes
 * fra en levering, og vi falder (sikkert) tilbage til den gamle adfærd.
 */
function findDeliveryLine(lines) {
    let feeIds = null;   // slås først op hvis der faktisk ER en x-Levering-linje
    return (lines || []).find(l => {
        if (l.category !== 'x-Levering') return false;
        if (l.grocy_recipe_id == null) return true;
        if (feeIds === null) {
            try { feeIds = require('../services/autoFees').getFeeRecipeIds(); }
            catch { feeIds = new Set(); }
        }
        return !feeIds.has(Number(l.grocy_recipe_id));
    }) || null;
}

/** Som findDeliveryLine, men kun ja/nej. Samme regel — ét sted. */
function hasDeliveryLine(lines) {
    return findDeliveryLine(lines) !== null;
}

function recalcBonTotal(db, bonId, opts = {}) {
    const bon = db.prepare('SELECT total_price, total_with_delivery, delivery_price, offer_discount_percent FROM bons WHERE id = ?').get(bonId);
    if (!bon) return null;
    const lines = db.prepare('SELECT line_total, category, grocy_recipe_id FROM bon_lines WHERE bon_id = ?').all(bonId);
    const hasLeveringLine = hasDeliveryLine(lines);
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
 * Driftsregnskabets lokations-snit (CLAUDE_EVENT.md §18.7).
 *
 * "Hvor foregik arbejdet bag denne bon?"
 *   hq     — HQ-køkkenet. Almindelige bons OG event-prep/top-up: de laves på
 *            HQ, af HQ-folk, på en HQ-vagt. Derfor bliver de i driften.
 *   events — det der sker PÅ PLADSEN: event-salg og event-udgifter.
 *   all    — begge (uændret adfærd, og fortsat default).
 *
 * De to snit er DISJUNKTE, så hq + events = all. Det er med vilje: kan man
 * ikke lægge dem sammen og få totalen, er der noget der falder ned mellem dem.
 *
 * Prædikatet er det samme som `workloadRoleSql` — og det er ikke tilfældigt:
 * "tæller som produktions-workload" og "foregik på HQ" partitionerer ens i dag.
 * De besvarer alligevel hver sit spørgsmål og kan skride fra hinanden (fx hvis
 * en ny rolle er HQ-arbejde uden at være workload), så de holdes adskilt frem
 * for at dele én funktion der så skulle betyde to ting.
 *
 * @param {'hq'|'events'|'all'} location
 * @param {string} bonAlias
 * @returns {string} SQL-prædikat — '1=1' for 'all'
 */
function driftLocationSql(location, bonAlias = 'b') {
    const col = `${bonAlias}.event_role`;
    if (location === 'hq')     return `COALESCE(${col}, '') NOT IN ('sales','expense')`;
    if (location === 'events') return `COALESCE(${col}, '') IN ('sales','expense')`;
    return '1=1';
}

/**
 * "Ejer denne bon sin egen lagerbevægelse — og dermed sit vareforbrug?"
 *
 * For en almindelig bon: ja. Den både trækker lager og har omsætning, så dens
 * cost_price ER dagens vareforbrug.
 *
 * For et LET event: nej for salgsbonnen. Prep-bonnen ejer trækket
 * (autoConsumeBonInventory's event-gate → 'event_prep_owns_stock'), men
 * VarePicker snapshotter alligevel en cost_price på hver eneste linje. Summeres
 * den råt, tælles eventets varer to gange — én gang på prep-bonnen og én gang
 * på salgsbonnen. Målt på drift: 137.251 kr (prep) + 68.742 kr (salg).
 *
 * Festival-modellen gates IKKE — dér trækker salgsbonnen fra sin egen lokation
 * og ejer altså sin omkostning. Derfor står `model` med i prædikatet.
 *
 * Skrevet som ÉT selvstændigt udtryk der kun kræver bon-aliaset, så det kan
 * bruges i en aggregat-query uden at tvinge kalderen til at joine to tabeller.
 *
 * NB: kolonnen `inventory_deduct_status` kan IKKE bruges som genvej. Den er
 * NULL på alle event-salgsbons fra før migration 141, så et opslag ville give
 * det forkerte svar på præcis de historiske dage man kigger på. Reglen skal
 * genberegnes, ikke aflæses.
 *
 * @param {string} bonAlias  alias for bons-tabellen (default 'b')
 * @returns {string} SQL-prædikat til WHERE/CASE
 */
function bonOwnsStockCostSql(bonAlias = 'b') {
    return `NOT (
        ${bonAlias}.event_id IS NOT NULL
        AND COALESCE((SELECT pc2.code FROM price_categories pc2
                       WHERE pc2.id = ${bonAlias}.price_category_id), '') <> 'produktion'
        AND COALESCE((SELECT e2.model FROM events e2
                       WHERE e2.id = ${bonAlias}.event_id), '') = 'light'
    )`;
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
    searchAsId,
    nextBonNumber, nextQuoteNumber, logChange, handle,
    getBon, getBonLines, getBonMenuGroups, getPrepPackingOverrides, getPrepPackingExtras, getPrepPackingRecipeFactors, getStatusId, getDefaultLocationId,
    createBon,
    todayISO, offsetISO, sqlTime, copenhagenDayStartSql, addDaysISO,
    autoConsumeBonInventory,
    getUnitCountCategories, getUnitCountExtraRecipes, invalidateUnitCountCache,
    getRecipeCostWindowDays, invalidateRecipeCostWindowCache,
    getNonRevenuePaymentCodes, revenueFactorSQL, nonRevenueBonExcludeSQL, invalidateNonRevenueCache,
    bonUnitsExpr, unitCountablePredicate,
    recalcBonTotalUnits, recalcBonTotalCo2e, recalcBonTotal, insertBonLines, hasDeliveryLine, findDeliveryLine,
    WORKLOAD_EXCLUDED_EVENT_ROLES, countsAsWorkload, workloadRoleSql, bonOwnsStockCostSql,
    driftLocationSql,
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
