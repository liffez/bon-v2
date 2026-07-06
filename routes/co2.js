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
const grocy = require('../services/grocyAdapter');
const engine = require('../services/co2Engine');

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

/* ---------- F7: overblik/rapport ---------- */

// Live CO₂-overblik: kører motoren mod Grocy → dækning + per-opskrift-CO₂ +
// hyppigst manglende faktor/kg-vej (datakvalitet). Kun opskrifter med ingredienser.
router.get('/overview', AUTH, handle(async (req, res) => {
    const [recipesMap, pos, nestings, products, conversions, units] = await Promise.all([
        grocy.getRecipesRawMap(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
        grocy.getQuantityUnits(),
    ]);
    const recipes = [...recipesMap.values()].map(r => ({ id: r.id, name: r.name, base_servings: r.base_servings }));
    const results = engine.computeAll({ recipes, pos, nestings, products, conversions, units });

    const posIds = new Set(pos.map(p => p.recipe_id));
    const nestIds = new Set(nestings.map(n => n.recipe_id));
    const real = [...results.values()].filter(r => posIds.has(r.recipe_id) || nestIds.has(r.recipe_id));
    const complete = real.filter(r => r.complete);

    const mf = new Map(), mk = new Map();
    real.filter(r => !r.complete).forEach(r => {
        r.missing_factor.forEach(x => mf.set(x, (mf.get(x) || 0) + 1));
        r.missing_kgvej.forEach(x => mk.set(x, (mk.get(x) || 0) + 1));
    });
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => ({ name, count }));

    res.json({
        summary: {
            total: real.length,
            complete: complete.length,
            partial: real.length - complete.length,
            coverage_pct: real.length ? Math.round((complete.length / real.length) * 100) : 0,
        },
        recipes: real
            .map(r => ({
                id: r.recipe_id, name: r.name,
                co2e_per_serving: r.complete ? r.co2e_per_serving : null,
                complete: r.complete,
                missing_factor: r.missing_factor,
                missing_kgvej: r.missing_kgvej,
            }))
            .sort((a, b) => (b.co2e_per_serving || 0) - (a.co2e_per_serving || 0)),
        missing: { factor: top(mf), kgvej: top(mk) },
    });
}));

// CO₂ over tid: månedlig Σ(bons.total_co2e) + pax → CO₂ pr. kuvert. Ekskl.
// tilbud + AFLYST. Bemærk: pre-F5-bons bærer gamle frosne tal (se F6-note).
router.get('/timeseries', AUTH, handle((req, res) => {
    const db = getDb();
    const months = Math.min(36, Math.max(1, parseInt(req.query.months, 10) || 12));
    const rows = db.prepare(`
        SELECT strftime('%Y-%m', b.delivery_date) AS month,
               COALESCE(SUM(b.total_co2e), 0)     AS co2e,
               COALESCE(SUM(b.pax), 0)            AS pax,
               COUNT(*)                           AS bons
          FROM bons b
          JOIN status_definitions sd ON b.status_id = sd.id
         WHERE (b.is_offer = 0 OR b.is_offer IS NULL)
           AND sd.code != 'AFLYST'
           AND b.delivery_date >= date('now', ?)
         GROUP BY month
         ORDER BY month
    `).all(`-${months} months`);
    res.json({ months: rows.map(r => ({ ...r, co2e_per_pax: r.pax ? r.co2e / r.pax : null })) });
}));

module.exports = router;
module.exports._test = { parseFactor };
