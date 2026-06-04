/**
 * services/leadCreate.js
 * ════════════════════════════════════════════════════════════
 * Delt lead-oprettelse: find/opret kunde, kontaktpunkter, lead-stadie.
 * Bruges af bulk lead-import (routes/crm.js) og opret-lead-fra-mail
 * (routes/mail.js). Én kilde til rfm_scores-synk + contact_point-logik.
 * ════════════════════════════════════════════════════════════
 */

const { logChange } = require('../db/helpers');
const { validateContactValue } = require('../shared/contactPoints');

function findCustomerByEmail(db, email) {
    const v = (email || '').trim().toLowerCase();
    if (!v) return null;
    return db.prepare(`
        SELECT * FROM customers
         WHERE is_active = 1 AND LOWER(TRIM(COALESCE(email,''))) = ?
         ORDER BY id LIMIT 1
    `).get(v);
}

// Opret/genaktivér et contact_point. Returnerer true hvis et NYT punkt blev oprettet.
// (053-triggerne fyrer KUN ved UPDATE af companies/customers, ikke ved INSERT —
//  derfor oprettes kontaktpunkter eksplicit her.)
function ensureContactPoint(db, entityType, entityId, kind, value) {
    const val = validateContactValue(kind, value);
    if (!val.ok) return false;
    const existing = db.prepare(`
        SELECT id FROM contact_points
         WHERE entity_type = ? AND entity_id = ? AND kind = ? AND value = ?
    `).get(entityType, entityId, kind, val.normalized);
    if (existing) {
        db.prepare(`
            UPDATE contact_points
               SET is_active = 1, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(existing.id);
        return false;
    }
    const hasPrimary = db.prepare(`
        SELECT 1 FROM contact_points
         WHERE entity_type = ? AND entity_id = ? AND kind = ? AND is_primary = 1 AND is_active = 1
    `).get(entityType, entityId, kind);
    db.prepare(`
        INSERT INTO contact_points
            (entity_type, entity_id, kind, value, source, is_public, is_primary, last_seen_at)
        VALUES (?, ?, ?, ?, 'manual', 0, ?, CURRENT_TIMESTAMP)
    `).run(entityType, entityId, kind, val.normalized, hasPrimary ? 0 : 1);
    return true;
}

// Sæt stage='lead' KUN hvis kunden ikke allerede har et stadie. Returnerer det gældende stadie.
// Nedgraderer aldrig en VIP/aktiv kunde. Synker til rfm_scores med stage_locked.
function setLeadStageIfNew(db, customerId, userId) {
    const existing = db.prepare('SELECT stage FROM crm_customer_meta WHERE customer_id = ?').get(customerId);
    if (existing) return existing.stage;

    db.prepare("INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, 'lead')").run(customerId);

    const cust = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(customerId);
    if (cust?.company_id) {
        const rfmExists = db.prepare('SELECT 1 FROM rfm_scores WHERE company_id = ?').get(cust.company_id);
        if (rfmExists) {
            db.prepare(`
                UPDATE rfm_scores SET stage = 'lead', stage_locked = 1, stage_locked_by = ?, stage_locked_at = datetime('now')
                 WHERE company_id = ?
            `).run(userId, cust.company_id);
        } else {
            db.prepare(`
                INSERT INTO rfm_scores (company_id, stage, stage_locked, stage_locked_by, stage_locked_at)
                VALUES (?, 'lead', 1, ?, datetime('now'))
            `).run(cust.company_id, userId);
        }
    }
    return 'lead';
}

/**
 * Opret (eller genfind på email) en privat lead-kontakt — kunde uden firma.
 * Returnerer { customerId, created }.
 *   created = true  → ny kunde-række blev oprettet
 *   created = false → eksisterende kunde matchede på email (stadie kun sat hvis manglede)
 */
function createPrivateLead(db, { firstName, lastName, email, phone, notes, userId, sourceLabel }) {
    let customer = findCustomerByEmail(db, email);
    let created = false;

    if (!customer) {
        const fn = (firstName || '').trim()
            || (email ? email.split('@')[0] : '')
            || 'Kontakt';
        const ins = db.prepare(`
            INSERT INTO customers (company_id, first_name, last_name, phone, email, notes)
            VALUES (NULL, ?, ?, ?, ?, ?)
        `).run(
            fn,
            (lastName || '').trim() || null,
            (phone || '').trim() || null,
            (email || '').trim() || null,
            (notes || '').trim() || null
        );
        customer = { id: Number(ins.lastInsertRowid) };
        created = true;
        logChange({
            entityType: 'customer', entityId: customer.id, action: 'create',
            fieldName: 'lead', newValue: fn, userId,
            notes: sourceLabel || 'lead',
        });
    }

    if (email) ensureContactPoint(db, 'customer', customer.id, 'email', email);
    if (phone) ensureContactPoint(db, 'customer', customer.id, 'phone', phone);
    setLeadStageIfNew(db, customer.id, userId);

    return { customerId: customer.id, created };
}

module.exports = { findCustomerByEmail, ensureContactPoint, setLeadStageIfNew, createPrivateLead };
