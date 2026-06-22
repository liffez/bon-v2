/**
 * routes/physical-units.js
 * ════════════════════════════════════════════════════════════
 * Fysiske enheder til lageroptælling per Grocy-lokation.
 * Erstatter localStorage-lagring så alle devices ser samme liste.
 *
 * GET    /api/physical-units?location_id=   Aktive enheder (all=1 for arkiverede)
 * POST   /api/physical-units                Opret (reaktiverer hvis samme navn er arkiveret)
 * PATCH  /api/physical-units/:id            Omdøb / arkivér / genaktivér
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast }   = require('../shared/sse');

/* ── GET / — liste ───────────────────────────────────────── */

router.get('/', requireAuth(), handle((req, res) => {
    const locId = parseInt(req.query.location_id);
    if (!locId) return res.status(400).json({ error: 'location_id p\u00e5kr\u00e6vet' });

    const includeArchived = req.query.all === '1';
    const sql = includeArchived
        ? 'SELECT * FROM physical_units WHERE grocy_location_id = ? ORDER BY archived_at IS NULL DESC, sort_order, name'
        : 'SELECT * FROM physical_units WHERE grocy_location_id = ? AND archived_at IS NULL ORDER BY sort_order, name';

    res.json(getDb().prepare(sql).all(locId));
}));

/* ── POST / — opret eller reaktivér ─────────────────────── */

router.post('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { grocy_location_id, name, sort_order } = req.body;

    if (!grocy_location_id) return res.status(400).json({ error: 'grocy_location_id p\u00e5kr\u00e6vet' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name p\u00e5kr\u00e6vet' });

    const cleanName = name.trim();

    // Aktiv med samme navn? Konflikt.
    const active = db.prepare(
        'SELECT * FROM physical_units WHERE grocy_location_id = ? AND name = ? AND archived_at IS NULL'
    ).get(grocy_location_id, cleanName);
    if (active) return res.status(409).json({ error: 'Enhed findes allerede', unit: active });

    // Arkiveret med samme navn? Reaktivér.
    const archived = db.prepare(
        'SELECT * FROM physical_units WHERE grocy_location_id = ? AND name = ? AND archived_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(grocy_location_id, cleanName);
    if (archived) {
        db.prepare('UPDATE physical_units SET archived_at = NULL WHERE id = ?').run(archived.id);
        broadcast('physical_unit_changed', { grocy_location_id: Number(grocy_location_id), action: 'created' });
        return res.json(db.prepare('SELECT * FROM physical_units WHERE id = ?').get(archived.id));
    }

    const result = db.prepare(
        'INSERT INTO physical_units (grocy_location_id, name, sort_order) VALUES (?, ?, ?)'
    ).run(grocy_location_id, cleanName, sort_order || 0);

    broadcast('physical_unit_changed', { grocy_location_id: Number(grocy_location_id), action: 'created' });
    res.status(201).json(
        db.prepare('SELECT * FROM physical_units WHERE id = ?').get(result.lastInsertRowid)
    );
}));

/* ── PATCH /:id — omdøb / arkivér / genaktivér ──────────── */

router.patch('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const unit = db.prepare('SELECT * FROM physical_units WHERE id = ?').get(id);
    if (!unit) return res.status(404).json({ error: 'Ikke fundet' });

    const { name, archived, sort_order } = req.body;

    if (name !== undefined) {
        const cleanName = (name || '').trim();
        if (!cleanName) return res.status(400).json({ error: 'name kan ikke v\u00e6re tom' });
        // Konflikt hvis et andet aktivt objekt har samme navn
        const conflict = db.prepare(
            'SELECT id FROM physical_units WHERE grocy_location_id = ? AND name = ? AND archived_at IS NULL AND id <> ?'
        ).get(unit.grocy_location_id, cleanName, id);
        if (conflict) return res.status(409).json({ error: 'Navnet bruges allerede af en aktiv enhed' });
        db.prepare('UPDATE physical_units SET name = ? WHERE id = ?').run(cleanName, id);
    }

    if (archived !== undefined) {
        if (archived) {
            db.prepare('UPDATE physical_units SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        } else {
            db.prepare('UPDATE physical_units SET archived_at = NULL WHERE id = ?').run(id);
        }
    }

    if (sort_order !== undefined) {
        db.prepare('UPDATE physical_units SET sort_order = ? WHERE id = ?').run(parseInt(sort_order) || 0, id);
    }

    broadcast('physical_unit_changed', { grocy_location_id: Number(unit.grocy_location_id), action: 'updated' });
    res.json(db.prepare('SELECT * FROM physical_units WHERE id = ?').get(id));
}));

module.exports = router;
