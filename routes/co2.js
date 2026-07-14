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
const synonyms = require('../services/co2Synonyms');
const transport = require('../services/co2Transport');
const bonTransportCo2 = require('../services/bonTransportCo2');

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

// Vindue for periode-baserede CO₂-tal: brugerdefineret from/to (YYYY-MM-DD)
// vinder; ellers relativt months-vindue (default 12). SQLite date-math (localtime).
function _resolveCo2Window(db, q) {
    const rx = /^\d{4}-\d{2}-\d{2}$/;
    const from = rx.test(q.from || '') ? q.from : null;
    const to   = rx.test(q.to   || '') ? q.to   : null;
    if (from && to && from <= to) return { from, to, months: null };
    let months = parseInt(q.months, 10);
    if (!Number.isInteger(months) || months < 1 || months > 60) months = 12;
    const w = db.prepare(
        `SELECT date('now','localtime','-' || ? || ' months') AS f, date('now','localtime') AS t`
    ).get(months);
    return { from: w.f, to: w.t, months };
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
    const [recipesMap, pos, nestings, products, conversions, units, groups] = await Promise.all([
        grocy.getRecipesRawMap(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
        grocy.getQuantityUnits(),
        grocy.getProductGroups(),
    ]);
    // Klassificér mangler: emballage (fixes i Emballage-tildeler) vs råvare (manuel/ark).
    const groupName = new Map(groups.map(g => [String(g.id), g.name]));
    const prodByName = new Map();
    products.forEach(p => { if (!prodByName.has(p.name)) prodByName.set(p.name, p); });
    const enrichMissing = (arr) => arr.map(x => {
        const p = prodByName.get(x.name);
        const kind = p ? (/emballage/i.test(groupName.get(String(p.product_group_id)) || '') ? 'emballage' : 'raavare') : null;
        return { ...x, product_id: p ? p.id : null, kind };
    });
    const recipes = [...recipesMap.values()].map(r => ({ id: r.id, name: r.name, base_servings: r.base_servings }));
    // Enhed + kategori pr. opskrift (fra userfields) — så rapporten kan vise at
    // "6,5 kg/kg produktion" og "0,3 kg/stk sandwich" IKKE er sammenlignelige.
    const meta = new Map([...recipesMap.values()].map(r => {
        const uf = r.userfields || {};
        return [r.id, { unit: uf.recipeunit || null, category: uf.grupper || null, sellable: uf.sellable === '1' || uf.sellable === 1 }];
    }));
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
            .map(r => {
                const m = meta.get(r.recipe_id) || {};
                return {
                    id: r.recipe_id, name: r.name,
                    co2e_per_serving: r.complete ? r.co2e_per_serving : null,
                    unit: m.unit, category: m.category, sellable: !!m.sellable,
                    complete: r.complete,
                    missing_factor: r.missing_factor,
                    missing_kgvej: r.missing_kgvej,
                };
            })
            .sort((a, b) => (b.co2e_per_serving || 0) - (a.co2e_per_serving || 0)),
        categories: [...new Set(real.map(r => (meta.get(r.recipe_id) || {}).category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'da')),
        missing: { factor: enrichMissing(top(mf)), kgvej: enrichMissing(top(mk)) },
    });
}));

// Drill-down: per-råvare-nedbrydning for ÉN opskrift (kg × faktor pr. råvare +
// andel + underopskrifter). Eksponerer det motoren allerede regner internt.
router.get('/recipe/:id', AUTH, handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ugyldigt id' });
    const [recipesMap, pos, nestings, products, conversions, units, groups] = await Promise.all([
        grocy.getRecipesRawMap(),
        grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(),
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
        grocy.getQuantityUnits(),
        grocy.getProductGroups(),
    ]);
    const recipe = recipesMap.get(id);
    if (!recipe) return res.status(404).json({ error: 'Opskrift ikke fundet' });
    const recipes = [...recipesMap.values()].map(r => ({ id: r.id, name: r.name, base_servings: r.base_servings }));
    const bd = engine.breakdownRecipe(id, { recipes, pos, nestings, products, conversions, units, groups });
    const uf = recipe.userfields || {};
    res.json({ ...bd, name: recipe.name, unit: uf.recipeunit || null, category: uf.grupper || null });
}));

// Manuel råvare-faktor (§1 source='manual') — fallback for råvarer der ikke er i
// Katrines CONCITO-ark. Overskrives af en fremtidig import hvis arket får varen.
router.post('/manual-factor', AUTH, handle(async (req, res) => {
    const { product_id, factor } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product_id kræves' });
    const f = parseFactor(factor);
    if (f == null || Number.isNaN(f)) return res.status(400).json({ error: 'Ugyldig faktor' });
    await grocy.updateProductUserfields(product_id, {
        co2e_per_kg: String(f), co2e_source: 'manual', co2e_version: 'Manuel',
    });
    grocy.clearCache();
    res.json({ product_id: Number(product_id), factor: f });
}));

/* ---------- synonymer (dublet-vare-regler — synlige + redigerbare) ---------- */

router.get('/synonyms', AUTH, handle(async (req, res) => {
    res.json({ synonyms: await synonyms.listResolved(getDb()) });
}));

router.post('/synonyms', AUTH, handle(async (req, res) => {
    const { canonical_name, synonym_name } = req.body || {};
    res.json(await synonyms.addSynonym(getDb(), canonical_name, synonym_name));
}));

router.delete('/synonyms/:id', AUTH, handle((req, res) => {
    res.json(synonyms.removeSynonym(getDb(), parseInt(req.params.id, 10)));
}));

// CO₂ over tid: månedlig Σ(bons.total_co2e) + pax → CO₂ pr. kuvert. Ekskl.
// tilbud + AFLYST. Bemærk: pre-F5-bons bærer gamle frosne tal (se F6-note).
// Hver måned får desuden by_category: {kategori: kg} summeret fra bon_lines
// (samme frosne kilde, bare ét niveau dybere) → stacked kategori-graf.
router.get('/timeseries', AUTH, handle((req, res) => {
    const db = getDb();
    const win = _resolveCo2Window(db, req.query);
    const rows = db.prepare(`
        SELECT strftime('%Y-%m', b.delivery_date) AS month,
               COALESCE(SUM(b.total_co2e), 0)     AS co2e,
               COALESCE(SUM(b.pax), 0)            AS pax,
               COUNT(*)                           AS bons
          FROM bons b
          JOIN status_definitions sd ON b.status_id = sd.id
         WHERE (b.is_offer = 0 OR b.is_offer IS NULL)
           AND sd.code != 'AFLYST'
           AND b.delivery_date BETWEEN ? AND ?
         GROUP BY month
         ORDER BY month
    `).all(win.from, win.to);

    // Kategori-nedbrydning pr. måned (kun linjer med CO₂-tal — dækning vokser
    // over tid, hvilket er ærligt). Kilde: bon_lines.co2e × quantity (som F6).
    const catRows = db.prepare(`
        SELECT strftime('%Y-%m', b.delivery_date)                     AS month,
               COALESCE(NULLIF(TRIM(bl.category), ''), 'Uden kategori') AS category,
               SUM(bl.co2e * bl.quantity)                             AS co2e
          FROM bons b
          JOIN bon_lines bl        ON bl.bon_id = b.id
          JOIN status_definitions sd ON b.status_id = sd.id
         WHERE (b.is_offer = 0 OR b.is_offer IS NULL)
           AND sd.code != 'AFLYST'
           AND b.delivery_date BETWEEN ? AND ?
           AND bl.co2e IS NOT NULL AND bl.co2e > 0
         GROUP BY month, COALESCE(NULLIF(TRIM(bl.category), ''), 'Uden kategori')
    `).all(win.from, win.to);
    const byMonth = new Map();
    for (const r of catRows) {
        if (!byMonth.has(r.month)) byMonth.set(r.month, {});
        byMonth.get(r.month)[r.category] = r.co2e;
    }

    // Transport-CO₂ pr. måned (§2.5) — beregnet pr. bon, summeret pr. måned.
    // Holdes ADSKILT fra co2e (mad-total) så kuvert-KPI'en forbliver ekskl. transport.
    const tbons = db.prepare(`
        SELECT b.id, strftime('%Y-%m', b.delivery_date) AS month,
               b.delivery_type, b.delivery_method, b.delivery_vehicle_id, b.delivery_address_id
          FROM bons b
          JOIN status_definitions sd ON b.status_id = sd.id
         WHERE (b.is_offer = 0 OR b.is_offer IS NULL)
           AND sd.code != 'AFLYST'
           AND b.delivery_date BETWEEN ? AND ?
    `).all(win.from, win.to);
    const tmap = bonTransportCo2.computeForBons(db, tbons);
    const transportByMonth = new Map();
    for (const b of tbons) {
        const t = tmap.get(b.id);
        if (t && t.kg) transportByMonth.set(b.month, (transportByMonth.get(b.month) || 0) + t.kg);
    }

    res.json({
        window: { from: win.from, to: win.to, months: win.months },
        months: rows.map(r => ({
            ...r,
            co2e_per_pax: r.pax ? r.co2e / r.pax : null,
            by_category: byMonth.get(r.month) || {},
            transport_co2e: Math.round((transportByMonth.get(r.month) || 0) * 10) / 10,
        })),
    });
}));

/* ---------- transport-CO₂ (docs/CLAUDE_CO2_TRANSPORT.md §4 Fase 1.4) ---------- */
// GET /api/co2/transport?months=12
// On-the-fly aggregat pr. leveringsmetode: leveringer, km, CO₂, gns, km-dækning.
// Ingen snapshot — beregnes fra delivery_vehicles-faktorer + geo/rute-km.
router.get('/transport', AUTH, handle((req, res) => {
    const db = getDb();
    const win = _resolveCo2Window(db, req.query);
    const fromD = win.from, toD = win.to, months = win.months;

    // 1) Vogne → byId + byType (default pr. type = aktiv, laveste sort_order).
    const vehicles = db.prepare(`
        SELECT id, code, label, type, color, sort_order, is_active,
               co2_g_per_km, co2_g_fixed, co2_distance_multiplier, co2_positioning_km
        FROM delivery_vehicles ORDER BY is_active DESC, sort_order, id
    `).all();
    const byId = new Map(vehicles.map(v => [v.id, v]));
    const byType = new Map();
    for (const v of vehicles) if (!byType.has(v.type)) byType.set(v.type, v);

    // 2) Bons i vinduet (leverede/planlagte — ekskl. tilbud, interne, aflyste).
    const bons = db.prepare(`
        SELECT b.id, b.delivery_type, b.delivery_method, b.delivery_vehicle_id, b.delivery_address_id
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date BETWEEN ? AND ?
          AND b.is_offer = 0 AND b.is_internal = 0
          AND sd.code != 'AFLYST'
    `).all(fromD, toD);

    // 3) Rute-stop i vinduet → route-objekt pr. bon (til §3-fordeling).
    const stopRows = db.prepare(`
        SELECT rs.bon_id, rs.route_id, rs.distance_from_prev_m, r.total_km
        FROM delivery_route_stops rs
        JOIN delivery_routes r ON r.id = rs.route_id
        WHERE r.route_date BETWEEN ? AND ?
    `).all(fromD, toD);
    const routeById = new Map();   // route_id → { total_km, stops:[...] }
    const bonToRoute = new Map();  // bon_id → route_id
    for (const s of stopRows) {
        if (!routeById.has(s.route_id)) routeById.set(s.route_id, { total_km: s.total_km, stops: [] });
        routeById.get(s.route_id).stops.push({ bon_id: s.bon_id, distance_from_prev_m: s.distance_from_prev_m });
        bonToRoute.set(s.bon_id, s.route_id);
    }

    // 4) Geo-afstand pr. adresse (seneste).
    const geoRows = db.prepare(`
        SELECT address_id, distance_meters
        FROM geo_calculations
        WHERE distance_meters IS NOT NULL
        ORDER BY calculated_at DESC, id DESC
    `).all();
    const addrDist = new Map();
    for (const g of geoRows) if (!addrDist.has(g.address_id)) addrDist.set(g.address_id, g.distance_meters);

    // 4b) Adresse-koordinater (haversine-fallback for bons uden ORS-vejcache) + HQ.
    const addrCoords = new Map();
    for (const a of db.prepare(
        `SELECT id, lat, lon FROM addresses WHERE lat IS NOT NULL AND lon IS NOT NULL`
    ).all()) {
        addrCoords.set(a.id, { lat: Number(a.lat), lon: Number(a.lon) });
    }
    const hqRows = db.prepare(
        `SELECT key, value FROM settings WHERE key IN ('delivery_hq_lat','delivery_hq_lon')`
    ).all();
    const hqMap = {};
    for (const r of hqRows) hqMap[r.key] = Number(r.value);
    const hq = (Number.isFinite(hqMap.delivery_hq_lat) && Number.isFinite(hqMap.delivery_hq_lon))
        ? { lat: hqMap.delivery_hq_lat, lon: hqMap.delivery_hq_lon } : null;

    // 5) Aggregér pr. metode (ren logik i servicen).
    const agg = transport.aggregateMethods({ bons, byId, byType, routeById, bonToRoute, addrDist, addrCoords, hq });

    res.json({ window: { from: fromD, to: toD, months }, ...agg });
}));

module.exports = router;
module.exports._test = { parseFactor };
