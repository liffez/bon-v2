// routes/flags.js
// ==========================================
// CRUD + ack/dismiss for entity_flags.
//
// Stående/engangs-påmindelser på kunder og firmaer ("flags") der hejses
// ved bon-oprettelse og bon-åbning. Polymorf: tilhører enten et company
// eller en customer (XOR).
//
// To handlinger:
//   • POST /:id/ack       — "Set" (per-bon-ack, flag lever videre)
//   • POST /:id/dismiss   — "Gjort" (permanent dismiss)
//
// Spec: docs/CLAUDE_KUNDE_FLAGS.md
// ==========================================

const express   = require('express');
const router    = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

// ----------- Helpers -----------

function entityExists(db, entityType, entityId) {
    const table = entityType === 'company' ? 'companies' : 'customers';
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId);
    return !!row;
}

function getFlag(db, id) {
    return db.prepare('SELECT * FROM entity_flags WHERE id = ?').get(id);
}

// ----------- GET /api/flags?entity_type=&entity_id=&include_dismissed= -----------

router.get('/', handle((req, res) => {
    const { entity_type, entity_id, include_dismissed } = req.query;

    if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type og entity_id er påkrævet' });
    }
    if (!['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være "company" eller "customer"' });
    }
    const eId = parseInt(entity_id, 10);
    if (!Number.isFinite(eId)) {
        return res.status(400).json({ error: 'entity_id skal være et heltal' });
    }

    const db = getDb();
    const where = ['f.entity_type = ?', 'f.entity_id = ?'];
    const args  = [entity_type, eId];
    if (include_dismissed !== '1') where.push('f.dismissed_at IS NULL');

    const flags = db.prepare(`
        SELECT f.*,
               u_c.name AS created_by_name,
               u_d.name AS dismissed_by_name,
               b.bon_number AS dismissed_on_bon_number
        FROM entity_flags f
        LEFT JOIN users u_c ON f.created_by_user_id    = u_c.id
        LEFT JOIN users u_d ON f.dismissed_by_user_id  = u_d.id
        LEFT JOIN bons  b   ON f.dismissed_on_bon_id   = b.id
        WHERE ${where.join(' AND ')}
        ORDER BY f.dismissed_at IS NULL DESC, f.created_at DESC
    `).all(...args);

    // Ack-historik per flag (bon_numbers + timestamps)
    const ackStmt = db.prepare(`
        SELECT b.id, b.bon_number, fa.acked_at, fa.note
        FROM flag_acks fa
        JOIN bons b ON fa.bon_id = b.id
        WHERE fa.flag_id = ?
        ORDER BY fa.acked_at DESC
    `);
    for (const f of flags) {
        f.ack_bons = ackStmt.all(f.id);
    }

    res.json(flags);
}));

// ----------- POST /api/flags -----------

router.post('/', handle((req, res) => {
    const { entity_type, entity_id, title, body } = req.body || {};

    if (!['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være "company" eller "customer"' });
    }
    const eId = parseInt(entity_id, 10);
    if (!Number.isFinite(eId)) {
        return res.status(400).json({ error: 'entity_id skal være et heltal' });
    }
    if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'title er påkrævet' });
    }

    const db = getDb();
    if (!entityExists(db, entity_type, eId)) {
        return res.status(404).json({ error: `${entity_type} ikke fundet` });
    }

    const userId = req.session?.user?.id ?? null;
    const cleanTitle = String(title).trim();
    const cleanBody  = body ? String(body).trim() || null : null;

    const result = db.prepare(`
        INSERT INTO entity_flags (entity_type, entity_id, title, body, created_by_user_id)
        VALUES (?, ?, ?, ?, ?)
    `).run(entity_type, eId, cleanTitle, cleanBody, userId);

    const id = result.lastInsertRowid;
    logChange({
        entityType: entity_type,
        entityId:   eId,
        action:     'flag_created',
        fieldName:  'flag',
        oldValue:   null,
        newValue:   cleanTitle,
        userId,
    });
    broadcast('flag_created', { id, entity_type, entity_id: eId });
    res.json({ id });
}));

// ----------- PATCH /api/flags/:id -----------

router.patch('/:id', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id skal være et heltal' });

    const db = getDb();
    const existing = getFlag(db, id);
    if (!existing) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (existing.dismissed_at) {
        return res.status(400).json({ error: 'Flag er dismissed — kan ikke redigeres' });
    }

    const { title, body } = req.body || {};
    const sets = [];
    const args = [];

    if (title !== undefined) {
        const t = String(title).trim();
        if (!t) return res.status(400).json({ error: 'title må ikke være tom' });
        sets.push('title = ?');
        args.push(t);
    }
    if (body !== undefined) {
        const b = body ? String(body).trim() || null : null;
        sets.push('body = ?');
        args.push(b);
    }
    if (!sets.length) return res.json({ ok: true });

    args.push(id);
    db.prepare(`UPDATE entity_flags SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    const userId = req.session?.user?.id ?? null;
    logChange({
        entityType: existing.entity_type,
        entityId:   existing.entity_id,
        action:     'flag_updated',
        fieldName:  'flag',
        oldValue:   existing.title,
        newValue:   title !== undefined ? String(title).trim() : existing.title,
        userId,
    });
    broadcast('flag_updated', {
        id, entity_type: existing.entity_type, entity_id: existing.entity_id,
    });
    res.json({ ok: true });
}));

// ----------- POST /api/flags/:id/dismiss   ("Gjort"-action) -----------

router.post('/:id/dismiss', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id skal være et heltal' });

    const db = getDb();
    const flag = getFlag(db, id);
    if (!flag) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (flag.dismissed_at) return res.status(400).json({ error: 'Allerede dismissed' });

    const { bon_id, note } = req.body || {};
    const userId = req.session?.user?.id ?? null;

    db.prepare(`
        UPDATE entity_flags
        SET dismissed_at         = CURRENT_TIMESTAMP,
            dismissed_by_user_id = ?,
            dismissed_on_bon_id  = ?,
            dismiss_note         = ?
        WHERE id = ?
    `).run(userId, bon_id || null, note || null, id);

    logChange({
        entityType: flag.entity_type,
        entityId:   flag.entity_id,
        action:     'flag_dismissed',
        fieldName:  'flag',
        oldValue:   flag.title,
        newValue:   note || 'dismissed',
        userId,
    });
    broadcast('flag_dismissed', {
        id, entity_type: flag.entity_type, entity_id: flag.entity_id, bon_id: bon_id || null,
    });
    res.json({ ok: true });
}));

// ----------- POST /api/flags/:id/ack   ("Set"-action — flag lever videre) -----------

router.post('/:id/ack', handle((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id skal være et heltal' });

    const { bon_id, note } = req.body || {};
    if (!bon_id) return res.status(400).json({ error: 'bon_id er påkrævet' });

    const db = getDb();
    const flag = getFlag(db, id);
    if (!flag) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (flag.dismissed_at) return res.status(400).json({ error: 'Flag er dismissed' });

    const userId = req.session?.user?.id ?? null;

    // UPSERT — idempotent. Ny ack eller refresh af eksisterende.
    db.prepare(`
        INSERT INTO flag_acks (flag_id, bon_id, acked_by_user_id, note)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(flag_id, bon_id) DO UPDATE SET
            acked_at         = CURRENT_TIMESTAMP,
            acked_by_user_id = excluded.acked_by_user_id,
            note             = excluded.note
    `).run(id, bon_id, userId, note || null);

    broadcast('flag_acked', {
        id, bon_id, entity_type: flag.entity_type, entity_id: flag.entity_id,
    });
    res.json({ ok: true });
}));

module.exports = router;
