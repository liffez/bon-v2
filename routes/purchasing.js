/**
 * routes/purchasing.js
 * ════════════════════════════════════════════════════════════
 * Leverandør- og Grocy-lokations-management.
 *
 * Monteres i server.js som:
 *   app.use('/api/purchasing', require('./routes/purchasing'));
 *
 * Endpoints:
 *   GET    /api/purchasing/suppliers             Leverandører med grocy-locations
 *   GET    /api/purchasing/suppliers/grocy-locations  Grocy shopping_locations + link-status
 *   POST   /api/purchasing/suppliers/grocy-locations  Link grocy-location til supplier
 *   DELETE /api/purchasing/suppliers/grocy-locations/:id  Unlink
 *
 * Ordrer og varemodtagelse håndteres af routes/orders.js
 * og routes/receiving.js — duplikeres IKKE her.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../db/database');
const { handle } = require('../db/helpers');
const grocy = require('../services/grocyAdapter');

/* ── GET /suppliers ─────────────────────────────────────── */

/**
 * Returnerer leverandører med Grocy-handelssteder.
 * Én række pr. grocy_location_id (Inco giver 2 rækker).
 * Query: ?location_id= (Ristet Rugs siteId, fx HQ=1)
 */
router.get('/suppliers', handle((req, res) => {
    const db = getDb();
    const siteId = req.query.location_id ? parseInt(req.query.location_id) : null;

    let sql = `
        SELECT
            s.id              AS supplier_id,
            s.name            AS supplier_name,
            s.integration_type,
            s.contact_email,
            s.contact_phone,
            s.webshop_url,
            s.notes           AS supplier_notes,
            s.is_active,
            sgl.grocy_location_id,
            sgl.display_name  AS grocy_location_display_name
        FROM suppliers s
    `;

    const params = [];

    if (siteId) {
        sql += `
            INNER JOIN supplier_locations sl ON sl.supplier_id = s.id AND sl.location_id = ?
        `;
        params.push(siteId);
    }

    sql += `
        LEFT JOIN supplier_grocy_locations sgl ON sgl.supplier_id = s.id
        WHERE s.is_active = 1
        ORDER BY s.name, sgl.grocy_location_id
    `;

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
}));

/* ── GET /suppliers/grocy-locations ─────────────────────── */

/**
 * Henter alle Grocy shopping_locations + eksisterende koblings-status.
 * Bruges af bestillings-tabbens inline setup-bar.
 */
router.get('/suppliers/grocy-locations', handle(async (req, res) => {
    const db = getDb();

    // Hent fra Grocy
    const grocyLocs = await grocy.getShoppingLocations();

    // Hent eksisterende koblinger
    const linked = db.prepare(`
        SELECT sgl.*, s.name AS supplier_name
        FROM supplier_grocy_locations sgl
        JOIN suppliers s ON s.id = sgl.supplier_id
    `).all();

    const linkedMap = {};
    for (const l of linked) {
        linkedMap[l.grocy_location_id] = l;
    }

    // Hent alle suppliers til dropdown
    const suppliers = db.prepare(`
        SELECT id, name, integration_type FROM suppliers WHERE is_active = 1 ORDER BY name
    `).all();

    // Merge
    const result = grocyLocs.map(gl => {
        const link = linkedMap[gl.id] || null;
        return {
            grocy_location_id: gl.id,
            grocy_location_name: gl.name || gl.description || `Lokation ${gl.id}`,
            linked_supplier_id: link ? link.supplier_id : null,
            linked_supplier_name: link ? link.supplier_name : null,
            display_name: link ? link.display_name : null,
        };
    });

    res.json({ locations: result, suppliers });
}));

/* ── POST /suppliers/grocy-locations ────────────────────── */

/**
 * Link en Grocy shopping_location til en v2 supplier.
 * Body: { grocy_location_id, supplier_id, display_name? }
 */
router.post('/suppliers/grocy-locations', handle((req, res) => {
    const db = getDb();
    const { grocy_location_id, supplier_id, display_name } = req.body;

    if (!grocy_location_id || !supplier_id) {
        return res.status(400).json({ error: 'grocy_location_id og supplier_id er påkrævet' });
    }

    db.prepare(`
        INSERT OR REPLACE INTO supplier_grocy_locations (supplier_id, grocy_location_id, display_name)
        VALUES (?, ?, ?)
    `).run(supplier_id, grocy_location_id, display_name || null);

    res.json({ ok: true, grocy_location_id, supplier_id });
}));

/* ── DELETE /suppliers/grocy-locations/:id ───────────────── */

/**
 * Fjern kobling mellem Grocy shopping_location og supplier.
 * :id er grocy_location_id (ikke tabel-PK).
 */
router.delete('/suppliers/grocy-locations/:id', handle((req, res) => {
    const db = getDb();
    const grocyLocId = parseInt(req.params.id);

    const result = db.prepare(`
        DELETE FROM supplier_grocy_locations WHERE grocy_location_id = ?
    `).run(grocyLocId);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Kobling ikke fundet' });
    }

    res.json({ ok: true, grocy_location_id: grocyLocId });
}));

module.exports = router;
