// routes/co2.js
// ==========================================
// CO₂ F3 (#108) — materiale-faktortabel + emballage-tildeler.
// Spec: docs/CLAUDE_CO2.md §6 + §8 + §12 trin 3.
//
//   GET   /api/co2/materials            — faktortabel (alle aktive materialer)
//   PATCH /api/co2/materials/:id         — udfyld/ret faktor+version (admin) → auto re-resolve
//   POST  /api/co2/materials/:id/reresolve — gen-skriv faktor til alle koblede varer (admin)
//   GET   /api/co2/packaging            — emballagevarer m. materiale-status
//   POST  /api/co2/assign               — tildel materiale til vare (skriver Grocy-userfields)
//   POST  /api/co2/clear                — ryd materiale-tildeling på en vare
//
// Faktor-edits + re-resolve er admin-only (reference-data). Selve tildelingen
// er operationel kuratering → åben for enhver indlogget bruger (jf. rolle-login).
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, todayISO } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const co2 = require('../services/co2Materials');

const ADMIN = requireAuth('admin');
const AUTH  = requireAuth();

/** Parse tal robust (accepterer dansk decimalkomma). Tom → null. */
function parseFactor(raw) {
    if (raw == null || raw === '') return null;
    let s = String(raw).trim();
    if (s === '') return null;
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : NaN; // NaN → ugyldigt (skelnes fra null=ryd)
}

/* ---------- faktortabel ---------- */

router.get('/materials', AUTH, handle((req, res) => {
    const includeInactive = req.query.include_inactive === '1';
    res.json({ materials: co2.listMaterials(getDb(), includeInactive) });
}));

// Udfyld/ret en faktor (og evt. version / aktiv). Efter gem: re-resolve alle
// koblede varer så tallet straks slår igennem på lageret.
router.patch('/materials/:id', ADMIN, handle(async (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const mat = db.prepare('SELECT * FROM co2_material_factors WHERE id = ?').get(id);
    if (!mat) return res.status(404).json({ error: 'Materiale ikke fundet' });

    const body = req.body || {};
    const sets = [];
    const vals = [];

    if ('factor' in body) {
        const f = parseFactor(body.factor);
        if (Number.isNaN(f)) return res.status(400).json({ error: 'Ugyldig faktor' });
        sets.push('factor_kg_co2e_per_kg = ?'); vals.push(f); // null = ryd, tal = sæt
    }
    if ('version' in body) { sets.push('version = ?'); vals.push(body.version ? String(body.version) : null); }
    if ('is_active' in body) { sets.push('is_active = ?'); vals.push(body.is_active ? 1 : 0); }

    if (!sets.length) return res.status(400).json({ error: 'Intet at opdatere' });

    sets.push('updated_at = ?'); vals.push(todayISO());
    vals.push(id);
    db.prepare(`UPDATE co2_material_factors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Re-resolve koblede varer (best-effort — Grocy kan være nede).
    let reresolve = null;
    try {
        reresolve = await co2.reresolveMaterial(db, mat.key);
    } catch (e) {
        reresolve = { error: e.message };
    }
    res.json({
        material: db.prepare('SELECT * FROM co2_material_factors WHERE id = ?').get(id),
        reresolve,
    });
}));

router.post('/materials/:id/reresolve', ADMIN, handle(async (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const mat = db.prepare('SELECT key FROM co2_material_factors WHERE id = ?').get(id);
    if (!mat) return res.status(404).json({ error: 'Materiale ikke fundet' });
    res.json(await co2.reresolveMaterial(db, mat.key));
}));

/* ---------- emballagevarer ---------- */

router.get('/packaging', AUTH, handle(async (req, res) => {
    res.json({ products: await co2.listPackagingProducts(getDb()) });
}));

router.post('/assign', AUTH, handle(async (req, res) => {
    const { product_id, material } = req.body || {};
    if (!product_id || !material) {
        return res.status(400).json({ error: 'product_id og material kræves' });
    }
    // Valider materialet her (handle() mapper alle kast til 500 — vi vil have 400).
    if (!co2.getMaterialByKey(getDb(), material)) {
        return res.status(400).json({ error: 'Ukendt materiale: ' + material });
    }
    res.json(await co2.assignMaterial(getDb(), product_id, material));
}));

router.post('/clear', AUTH, handle(async (req, res) => {
    const { product_id } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product_id kræves' });
    res.json(await co2.clearMaterial(getDb(), product_id));
}));

module.exports = router;
module.exports._test = { parseFactor };
