// shared/contactPoints.js
// ==========================================
// Cache-sync helper: contact_points → companies/customers retning.
// (Den modsatte retning håndteres af SQLite-triggers — se migration 053.)
//
// Kaldes fra routes/contact-points.js efter INSERT/PATCH/DELETE der ændrer
// is_primary, value, eller fjerner et primary contact_point.
// ==========================================

/**
 * Synkronisér den denormaliserede cache på companies.email/phone (eller
 * customers.email/phone) ud fra det primære contact_point.
 *
 * Henter det aktive primary cp for (entity_type, entity_id, kind) og UPDATE'er
 * den tilsvarende kolonne på companies/customers. Hvis intet primary findes,
 * sættes kolonnen til NULL.
 *
 * BEMÆRK: Denne funktion bypasser ikke triggerne — den UPDATE'er companies/
 * customers direkte, hvilket fyrer trg_*_to_cp. Det er ufarligt fordi triggeren
 * matcher værdien præcis (NEW.email = primary cp.value), men trigger-logikken
 * kører alligevel og kan oprette/opdatere et primary cp. For at undgå støj:
 * vi kalder kun denne funktion når primary cp'et i forvejen er korrekt — så
 * triggeren bliver no-op.
 *
 * @param {object} db    node:sqlite Database instance (fra getDb())
 * @param {string} entityType  'company' | 'customer'
 * @param {number} entityId
 * @param {string} kind        'email' | 'phone'
 */
function syncPrimaryCache(db, entityType, entityId, kind) {
    if (entityType !== 'company' && entityType !== 'customer') {
        throw new Error(`syncPrimaryCache: ukendt entity_type "${entityType}"`);
    }
    if (kind !== 'email' && kind !== 'phone') {
        throw new Error(`syncPrimaryCache: ukendt kind "${kind}"`);
    }

    const primary = db.prepare(`
        SELECT value
          FROM contact_points
         WHERE entity_type = ?
           AND entity_id = ?
           AND kind = ?
           AND is_primary = 1
           AND is_active = 1
         LIMIT 1
    `).get(entityType, entityId, kind);

    const table = entityType === 'company' ? 'companies' : 'customers';
    // kind = 'email' | 'phone' — trygt at interpolere, validated above
    db.prepare(`UPDATE ${table} SET ${kind} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(primary?.value ?? null, entityId);
}

/**
 * Hvis is_primary=1 sættes på et nyt cp, skal alle andre primary'er for samme
 * (entity_type, entity_id, kind) nulstilles først. Kaldes inde i transactions.
 */
function clearOtherPrimaries(db, entityType, entityId, kind, exceptId = null) {
    if (exceptId != null) {
        db.prepare(`
            UPDATE contact_points
               SET is_primary = 0, updated_at = CURRENT_TIMESTAMP
             WHERE entity_type = ?
               AND entity_id = ?
               AND kind = ?
               AND is_primary = 1
               AND id != ?
        `).run(entityType, entityId, kind, exceptId);
    } else {
        db.prepare(`
            UPDATE contact_points
               SET is_primary = 0, updated_at = CURRENT_TIMESTAMP
             WHERE entity_type = ?
               AND entity_id = ?
               AND kind = ?
               AND is_primary = 1
        `).run(entityType, entityId, kind);
    }
}

/**
 * Promovér det "bedst ledige" cp til primary for (entity, kind).
 * Bruges efter sletning af det nuværende primary, så cachen ikke står tom
 * hvis der findes andre kontaktpunkter.
 *
 * Prioritet: ældste oprettede aktive cp af samme kind.
 */
function promoteNextPrimary(db, entityType, entityId, kind) {
    const next = db.prepare(`
        SELECT id FROM contact_points
         WHERE entity_type = ?
           AND entity_id = ?
           AND kind = ?
           AND is_active = 1
           AND is_primary = 0
         ORDER BY created_at ASC
         LIMIT 1
    `).get(entityType, entityId, kind);

    if (next) {
        db.prepare(`
            UPDATE contact_points
               SET is_primary = 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(next.id);
        return next.id;
    }
    return null;
}

/**
 * Validér en email- eller telefonværdi.
 * Returnér { ok: bool, error?: string, normalized?: string }.
 */
function validateContactValue(kind, value) {
    if (typeof value !== 'string') {
        return { ok: false, error: 'value skal være en streng' };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: 'value må ikke være tom' };
    }
    if (kind === 'email') {
        // Pragmatisk regex (matcher de fleste reelle emails)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            return { ok: false, error: 'ikke en gyldig email' };
        }
        return { ok: true, normalized: trimmed.toLowerCase() };
    }
    if (kind === 'phone') {
        // Tillad cifre, mellemrum, +, -, ., parenteser. Min 6 cifre.
        const digits = trimmed.replace(/\D/g, '');
        if (digits.length < 6 || digits.length > 15) {
            return { ok: false, error: 'telefon skal have 6–15 cifre' };
        }
        return { ok: true, normalized: trimmed };
    }
    return { ok: false, error: `ukendt kind "${kind}"` };
}

module.exports = {
    syncPrimaryCache,
    clearOtherPrimaries,
    promoteNextPrimary,
    validateContactValue,
};
