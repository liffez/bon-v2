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

module.exports = { nextBonNumber, nextQuoteNumber, logChange, handle };
