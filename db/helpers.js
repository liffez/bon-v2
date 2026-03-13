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

/**
 * Næste bon-nummer (atomisk, transaction-sikret).
 * Returnerer fx "3261" eller "B-3261" med præfiks.
 */
function nextBonNumber() {
    const db = getDb();
    return db.transaction(() => {
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='bon_number_prefix'`).get()?.value ?? '';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='bon_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='bon_number_next'`).run(String(current + 1));
        return `${prefix}${current}`;
    })();
}

/**
 * Næste tilbudsnummer.
 */
function nextQuoteNumber() {
    const db = getDb();
    return db.transaction(() => {
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='quote_number_prefix'`).get()?.value ?? 'T-';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='quote_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='quote_number_next'`).run(String(current + 1));
        return `${prefix}${current}`;
    })();
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
function logChange({ entityType, entityId, action, fieldName, oldValue, newValue, userId, notes }) {
    getDb().prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        entityType, entityId, action,
        fieldName ?? null,
        oldValue != null ? String(oldValue) : null,
        newValue != null ? String(newValue) : null,
        userId   ?? null,
        notes    ?? null
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
               is_accessory, special_request, co2e, pos_product_id, notes
        FROM bon_lines
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
            co.phone  AS company_phone
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        JOIN   locations l           ON b.location_id = l.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
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
    return bon;
}

function getStatusId(code) {
    return getDb().prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;
}

function getDefaultLocationId() {
    return getDb().prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 1`).get()?.id;
}

module.exports = { nextBonNumber, nextQuoteNumber, logChange, handle, getBon, getBonLines, getStatusId, getDefaultLocationId };
