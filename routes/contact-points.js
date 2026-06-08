// routes/contact-points.js
// ==========================================
// CRUD + toggle-public for contact_points.
// Kontaktpunkter (emails + telefoner) med kilde, offentlig/privat-flag,
// purpose, primary-flag. Polymorf: tilhører enten company eller customer.
//
// Cachen på companies.email/phone (og customers.email/phone) holdes i sync
// af syncPrimaryCache() i shared/contactPoints.js. Den modsatte retning
// håndteres af SQLite-triggers fra migration 053.
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, getUserId, logChange, transaction } = require('../db/helpers');
const {
    syncPrimaryCache,
    clearOtherPrimaries,
    promoteNextPrimary,
    validateContactValue,
} = require('../shared/contactPoints');

// ----------- Helpers -----------

const ALLOWED_SOURCES = ['cvr', 'nemhandel', 'website', 'form', 'mail', 'manual'];

function entityExists(db, entityType, entityId) {
    const table = entityType === 'company' ? 'companies' : 'customers';
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId);
    return !!row;
}

function getCp(db, id) {
    return db.prepare(`SELECT * FROM contact_points WHERE id = ?`).get(id);
}

// ----------- GET /api/contact-points?entity_type=&entity_id= -----------

router.get('/', handle((req, res) => {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type og entity_id er påkrævet' });
    }
    if (!['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være "company" eller "customer"' });
    }
    const id = parseInt(entity_id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'entity_id skal være et heltal' });
    }

    const db = getDb();
    const rows = db.prepare(`
        SELECT id, entity_type, entity_id, kind, value, source,
               is_public, is_primary, purpose,
               verified_at, last_seen_at, is_active, notes,
               created_at, updated_at
          FROM contact_points
         WHERE entity_type = ? AND entity_id = ? AND is_active = 1
         ORDER BY is_primary DESC, kind ASC, created_at ASC
    `).all(entity_type, id);

    res.json(rows);
}));

// ----------- POST /api/contact-points -----------

router.post('/', handle((req, res) => {
    const {
        entity_type, entity_id, kind, value,
        source, is_public, is_primary, purpose, notes, verified_at,
    } = req.body || {};

    // Validér krav
    if (!entity_type || !['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være "company" eller "customer"' });
    }
    const eId = parseInt(entity_id, 10);
    if (!Number.isFinite(eId)) {
        return res.status(400).json({ error: 'entity_id skal være et heltal' });
    }
    if (!kind || !['email', 'phone'].includes(kind)) {
        return res.status(400).json({ error: 'kind skal være "email" eller "phone"' });
    }
    const validation = validateContactValue(kind, value);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const src = source || 'manual';
    if (!ALLOWED_SOURCES.includes(src)) {
        return res.status(400).json({ error: `source skal være én af: ${ALLOWED_SOURCES.join(', ')}` });
    }

    const db = getDb();
    if (!entityExists(db, entity_type, eId)) {
        return res.status(404).json({ error: `${entity_type} #${eId} findes ikke` });
    }

    const isPub = is_public ? 1 : 0;
    const isPrim = is_primary ? 1 : 0;

    // Tjek for eksisterende
    const existing = db.prepare(`
        SELECT id, is_active FROM contact_points
         WHERE entity_type = ? AND entity_id = ? AND kind = ? AND value = ?
    `).get(entity_type, eId, kind, validation.normalized);

    if (existing && existing.is_active === 1) {
        const full = getCp(db, existing.id);
        return res.status(409).json({ error: 'Kontaktpunkt findes allerede', existing: full });
    }

    let newId;
    transaction(db, () => {
        // Hvis is_primary=1: nulstil alle andre primary'er for samme entity+kind
        if (isPrim) {
            clearOtherPrimaries(db, entity_type, eId, kind);
        }

        if (existing && existing.is_active === 0) {
            // Genaktivér tidligere blødt-slettet række
            db.prepare(`
                UPDATE contact_points
                   SET is_active = 1, source = ?, is_public = ?, is_primary = ?,
                       purpose = ?, notes = ?, verified_at = ?,
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?
            `).run(src, isPub, isPrim, purpose || null, notes || null, verified_at || null, existing.id);
            newId = existing.id;
        } else {
            const result = db.prepare(`
                INSERT INTO contact_points
                    (entity_type, entity_id, kind, value, source,
                     is_public, is_primary, purpose, notes, verified_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                entity_type, eId, kind, validation.normalized, src,
                isPub, isPrim, purpose || null, notes || null, verified_at || null
            );
            newId = Number(result.lastInsertRowid);
        }

        if (isPrim) {
            syncPrimaryCache(db, entity_type, eId, kind);
        }

        logChange({
            entityType: entity_type,
            entityId: eId,
            action: 'contact_point_create',
            fieldName: kind,
            newValue: validation.normalized,
            userId: getUserId(req),
            notes: `source=${src} public=${isPub} primary=${isPrim}` + (purpose ? ` purpose=${purpose}` : ''),
        });
    });

    res.status(201).json(getCp(db, newId));
}));

// ----------- PATCH /api/contact-points/:id -----------

router.patch('/:id', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt id' });

    const db = getDb();
    const cp = getCp(db, id);
    if (!cp || cp.is_active === 0) {
        return res.status(404).json({ error: 'kontaktpunkt ikke fundet' });
    }

    const {
        is_public, is_primary, purpose, notes, value, source, verified_at,
    } = req.body || {};

    const updates = [];
    const args = [];

    // value-ændring kræver validering + unique-tjek
    let newValue = cp.value;
    if (value !== undefined) {
        const validation = validateContactValue(cp.kind, value);
        if (!validation.ok) return res.status(400).json({ error: validation.error });
        newValue = validation.normalized;
        if (newValue !== cp.value) {
            const dup = db.prepare(`
                SELECT id FROM contact_points
                 WHERE entity_type = ? AND entity_id = ? AND kind = ? AND value = ? AND id != ?
            `).get(cp.entity_type, cp.entity_id, cp.kind, newValue, id);
            if (dup) return res.status(409).json({ error: 'Værdi findes allerede som andet kontaktpunkt', existing_id: dup.id });
            updates.push('value = ?');
            args.push(newValue);
        }
    }

    if (source !== undefined) {
        if (!ALLOWED_SOURCES.includes(source)) {
            return res.status(400).json({ error: `source skal være én af: ${ALLOWED_SOURCES.join(', ')}` });
        }
        updates.push('source = ?');
        args.push(source);
    }
    if (is_public !== undefined) {
        updates.push('is_public = ?');
        args.push(is_public ? 1 : 0);
    }
    if (purpose !== undefined) {
        updates.push('purpose = ?');
        args.push(purpose || null);
    }
    if (notes !== undefined) {
        updates.push('notes = ?');
        args.push(notes || null);
    }
    if (verified_at !== undefined) {
        updates.push('verified_at = ?');
        args.push(verified_at || null);
    }

    const willBePrimary = is_primary !== undefined ? (is_primary ? 1 : 0) : cp.is_primary;

    if (updates.length === 0 && is_primary === undefined) {
        return res.json(cp);
    }

    transaction(db, () => {
        if (is_primary !== undefined) {
            if (willBePrimary === 1) {
                clearOtherPrimaries(db, cp.entity_type, cp.entity_id, cp.kind, id);
            }
            updates.push('is_primary = ?');
            args.push(willBePrimary);
        }

        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            args.push(id);
            db.prepare(`UPDATE contact_points SET ${updates.join(', ')} WHERE id = ?`).run(...args);
        }

        // Sync cache hvis dette er (eller var) primary
        if (willBePrimary === 1 || cp.is_primary === 1) {
            syncPrimaryCache(db, cp.entity_type, cp.entity_id, cp.kind);
        }

        logChange({
            entityType: cp.entity_type,
            entityId: cp.entity_id,
            action: 'contact_point_update',
            fieldName: cp.kind,
            oldValue: cp.value,
            newValue,
            userId: getUserId(req),
        });
    });

    res.json(getCp(db, id));
}));

// ----------- PATCH /api/contact-points/:id/toggle-public -----------

router.patch('/:id/toggle-public', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt id' });

    const db = getDb();
    const cp = getCp(db, id);
    if (!cp || cp.is_active === 0) {
        return res.status(404).json({ error: 'kontaktpunkt ikke fundet' });
    }

    const newPublic = cp.is_public === 1 ? 0 : 1;
    db.prepare(`
        UPDATE contact_points
           SET is_public = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
    `).run(newPublic, id);

    logChange({
        entityType: cp.entity_type,
        entityId: cp.entity_id,
        action: newPublic === 1 ? 'contact_point_make_public' : 'contact_point_make_private',
        fieldName: cp.kind,
        newValue: cp.value,
        userId: getUserId(req),
    });

    res.json(getCp(db, id));
}));

// ----------- DELETE /api/contact-points/:id (soft-delete) -----------

router.delete('/:id', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt id' });

    const db = getDb();
    const cp = getCp(db, id);
    if (!cp || cp.is_active === 0) {
        return res.status(404).json({ error: 'kontaktpunkt ikke fundet' });
    }

    transaction(db, () => {
        db.prepare(`
            UPDATE contact_points
               SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(id);

        // Hvis dette var primary, find næste tilgængelige
        if (cp.is_primary === 1) {
            promoteNextPrimary(db, cp.entity_type, cp.entity_id, cp.kind);
            syncPrimaryCache(db, cp.entity_type, cp.entity_id, cp.kind);
        }

        logChange({
            entityType: cp.entity_type,
            entityId: cp.entity_id,
            action: 'contact_point_delete',
            fieldName: cp.kind,
            oldValue: cp.value,
            userId: getUserId(req),
        });
    });

    res.json({ ok: true });
}));

module.exports = router;
