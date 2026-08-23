// routes/role_map.js
// ==========================================
// Jobtype → rolle-kategori for driftsregnskabet. ADMIN-ONLY.
//
// Smartplan har intet rolle-felt, så jobtype er rollesignalet. Denne mapping
// afgør om en medarbejders timer/løn tæller i driften:
//   production → tæller i kapacitetsrate + lønandel (kok/salg/assistent)
//   delivery   → ekskluderet fra driften (bud — isoleres i leveringsmodulet)
//   other      → vises, men tæller hverken i rate eller lønandel
//
// Nye/ukendte jobtyper defaulter til 'other' i laborAdapter og flagges, så de
// ikke tavst forsvinder ud af rate-beregningen. GET her synkroniserer først
// jobtyper set i Smartplan ind i smartplan_role_map, så Settings har rækker at
// kategorisere.
//
// Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §6a
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { handle, offsetISO } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const labor   = require('../services/laborAdapter');

const ADMIN = requireAuth('admin');

const ROLE_CLASSES = ['production', 'delivery', 'other', 'volunteer'];

// Sync-vindue: ét år tilbage fanger arkiverede worklogs, 60 dage frem fanger
// planlagte shifts med nye jobtyper. Sync er additiv (INSERT OR IGNORE) og
// idempotent — rører ikke eksisterende manuel mapping.
const SYNC_FROM = '2025-01-01';

/* ---------- GET — alle jobtyper + deres kategori ---------- */
router.get('/', ADMIN, handle(async (req, res) => {
    const db = getDb();
    let synced = false;
    try {
        await labor.syncRoleMap(SYNC_FROM, offsetISO(60));
        synced = true;
    } catch {
        // Smartplan nede → vis blot eksisterende rækker (graceful degradation).
    }
    const rows = db.prepare(`
        SELECT jobtype_uuid, jobtype_title, role_class, updated_at
          FROM smartplan_role_map
         ORDER BY jobtype_title COLLATE NOCASE, jobtype_uuid
    `).all();
    res.json({ jobtypes: rows, synced });
}));

/* ---------- PATCH /:uuid — sæt kategori ---------- */
router.patch('/:uuid', ADMIN, handle(async (req, res) => {
    const roleClass = req.body && req.body.role_class;
    if (!ROLE_CLASSES.includes(roleClass)) {
        return res.status(400).json({ error: 'role_class skal være en af: ' + ROLE_CLASSES.join(', ') });
    }
    const db = getDb();
    const r = db.prepare(`
        UPDATE smartplan_role_map
           SET role_class = ?, updated_at = datetime('now')
         WHERE jobtype_uuid = ?
    `).run(roleClass, req.params.uuid);
    if (!r.changes) return res.status(404).json({ error: 'Ukendt jobtype.' });
    res.json({ ok: true, jobtype_uuid: req.params.uuid, role_class: roleClass });
}));

module.exports = router;
