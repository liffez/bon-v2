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
            `UPDATE bons SET inventory_deducted = 1, inventory_deducted_at = CURRENT_TIMESTAMP WHERE id = ?`
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
    const { consumeRecipes } = require('../services/grocyAdapter');
    consumeRecipes(lines, packingOverrides).then(results => {
        const failed  = results.filter(r => !r.success);
        const partial = results.filter(r => r.partial);
        if (failed.length) {
            console.warn(`[grocy_consume] bon ${bonId}: ${failed.length} fejl:`, failed);
        } else if (partial.length) {
            console.log(`[grocy_consume] bon ${bonId}: ${results.length} produkter trukket — ${partial.length} partial (rest lagt på shopping-list)`);
        } else {
            console.log(`[grocy_consume] bon ${bonId}: ${results.length} produkter forbrugt fra lager`);
        }
        db.prepare(
            `UPDATE bons SET inventory_deducted = 1, inventory_deducted_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(bonId);
        logChange({ entityType: 'bon', entityId: bonId, action: 'grocy_consume', fieldName: 'stock', oldValue: null, newValue: JSON.stringify(results) });
    }).catch(err => {
        console.error(`[grocy_consume] bon ${bonId}: fejl:`, err.message);
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

function invalidateUnitCountCache() {
    _unitCatCache = null;
    _unitCatCacheUntil = 0;
}

/**
 * Genberegn total_units på en bon. SUM(quantity) på linjer hvis kategori
 * er i settings.unit_count_categories OG ikke er markeret som tilbehør.
 * Returnerer den nye total.
 */
function recalcBonTotalUnits(db, bonId) {
    const cats = getUnitCountCategories();
    let total = 0;
    if (cats.length > 0) {
        const placeholders = cats.map(() => '?').join(',');
        total = db.prepare(`
            SELECT COALESCE(SUM(quantity), 0) AS t
            FROM bon_lines
            WHERE bon_id = ?
              AND (is_accessory = 0 OR is_accessory IS NULL)
              AND category IN (${placeholders})
        `).get(bonId, ...cats).t;
    }
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);
    return total;
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
    return getDb().prepare('SELECT id, name, email, role, pin FROM users WHERE id = ? AND is_active = 1').get(id);
}

module.exports = {
    nextBonNumber, nextQuoteNumber, logChange, handle,
    getBon, getBonLines, getBonMenuGroups, getPrepPackingOverrides, getStatusId, getDefaultLocationId,
    todayISO, offsetISO,
    autoConsumeBonInventory,
    getUnitCountCategories, invalidateUnitCountCache, recalcBonTotalUnits,
    hashPassword, verifyPassword, getUserByEmail, getUserById,
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
