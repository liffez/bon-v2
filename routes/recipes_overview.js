/**
 * routes/recipes_overview.js
 * ════════════════════════════════════════════════════════════
 * Opskrifter & priser — margin-analyse-view i office.
 *
 * GET    /api/recipes/overview            — hovedtabel-data + KPI-summary
 * POST   /api/recipes/refresh-costs       — refresh recipe_cost_cache fra Grocy
 * POST   /api/recipes/backfill            — force-rerun af auto-backfill (admin)
 * PUT    /api/item-prices                 — opdater én salgspris
 * GET    /api/recipes/targets             — alle DB%-mål + kategorier fra Grocy
 * PUT    /api/recipes/targets             — bulk-upsert mål
 * PATCH  /api/recipes/targets/:category   — opdater ét mål (inline-edit)
 * DELETE /api/recipes/targets/:category   — fjern mål for kategori
 * GET    /api/grocy/recipe-link/:id       — 302-redirect til Grocy
 *
 * Moms-doktrin: revenue summeres som incl moms i SQL og konverteres via
 * Moms.inclToExcl i Node — ALDRIG ved direkte division. Se BON_V2_PRINCIPPER.md §6b.
 *
 * Spec: docs/CLAUDE_OPSKRIFTER.md
 * Test: tests/specs/T_OPSKRIFTER.md
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();             // monteres på /api/recipes
const itemPricesRouter = express.Router();   // monteres på /api/item-prices
const { getDb } = require('../db/database');
const { handle, logChange, inclToExcl, exclToIncl, nonRevenueBonExcludeSQL } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const grocyAdapter = require('../services/grocyAdapter');
const { convertAndFormat } = require('../services/quConvert');
const itemPriceBackfill = require('../services/itemPriceBackfill');
const { broadcast } = require('../shared/sse');

// Alle endpoints kræver auth
router.use(requireAuth());
itemPricesRouter.use(requireAuth());

// ─── Konstanter ───────────────────────────────────────────────

const REVENUE_CODES = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];
const OFFER_INTERNAL_FILTER = 'AND COALESCE(b.is_offer, 0) = 0 AND COALESCE(b.is_internal, 0) = 0';
const VALID_PRICE_CATEGORIES = ['store', 'catering', 'festival', 'produktion', 'waiste'];
const STALE_WARN_HOURS = 48;
const STALE_CRIT_HOURS = 24 * 7;

// ─── Helpers ──────────────────────────────────────────────────

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function _statusPlaceholders(codes) { return codes.map(() => '?').join(','); }

/**
 * Beregn 12 periode-buckets fra `period_days`.
 * buckets[0] = ældste, buckets[11] = nyeste.
 * Returnerer { bucketDays, bucketBoundaries: [{startDays, endDays}, ...] }
 * hvor startDays/endDays er "dage før nu" (0 = i dag).
 */
function _calcBuckets(periodDays) {
    const bucketDays = periodDays / 12;
    const boundaries = [];
    for (let i = 0; i < 12; i++) {
        // bucket 0 = ældste = (periodDays - bucketDays) til periodDays dage før nu
        boundaries.push({
            startDays: periodDays - (i + 1) * bucketDays,  // færre dage før nu (nyere)
            endDays: periodDays - i * bucketDays,
        });
    }
    return { bucketDays, boundaries };
}

/**
 * SQLite CURRENT_TIMESTAMP returnerer "YYYY-MM-DD HH:MM:SS" i UTC men uden
 * tz-suffix. JS' `new Date(s)` ville parse det som LOKAL tid — derfor
 * tilføjer vi 'T' + 'Z' så det parses som UTC.
 */
function _sqliteUtcToIso(ts) {
    if (!ts) return null;
    if (typeof ts !== 'string') return ts;
    if (ts.includes('T') || ts.endsWith('Z')) return ts;
    return ts.replace(' ', 'T') + 'Z';
}

function _staleLevel(refreshedAt) {
    if (!refreshedAt) return 'critical';
    const iso = _sqliteUtcToIso(refreshedAt);
    const ms = Date.now() - new Date(iso).getTime();
    const hours = ms / (1000 * 60 * 60);
    if (hours >= STALE_CRIT_HOURS) return 'critical';
    if (hours >= STALE_WARN_HOURS) return 'warn';
    return 'fresh';
}

function _getPriceCategoryId(code) {
    const db = getDb();
    const row = db.prepare('SELECT id FROM price_categories WHERE code = ?').get(code);
    return row ? row.id : null;
}

// ─── GET /api/recipes/overview ────────────────────────────────

router.get('/overview', handle(async (req, res) => {
    const priceCategory = String(req.query.price_category || 'catering');
    const periodDays = parseInt(req.query.period_days, 10) || 365;
    const categoryFilter = req.query.category ? String(req.query.category) : null;
    const includeInactive = req.query.include_inactive === '1';

    if (!VALID_PRICE_CATEGORIES.includes(priceCategory)) {
        return res.status(400).json({ error: `Ukendt price_category: ${priceCategory}` });
    }
    if (![30, 90, 180, 365, 730].includes(periodDays) && (periodDays < 7 || periodDays > 1825)) {
        return res.status(400).json({ error: 'period_days skal være 30/90/180/365/730 eller 7-1825' });
    }

    // 1) Auto-backfill hvis flag er '0'
    const backfillResult = await itemPriceBackfill.backfillIfNeeded({ userId: req.session?.userId });

    const db = getDb();
    const priceCategoryId = _getPriceCategoryId(priceCategory);
    if (!priceCategoryId) {
        return res.status(500).json({ error: `price_category '${priceCategory}' findes ikke i DB` });
    }

    // 2) Hent recipes fra Grocy (raw så vi har alle userfields, inkl. sellable, Oeko, grupper)
    let rawRecipes;
    try {
        rawRecipes = await grocyAdapter.getRecipesRaw();
    } catch (err) {
        return res.status(503).json({ error: 'Grocy ikke tilgængelig', detail: err.message });
    }

    // 3) Hent costs fra cache (+ refreshed_at timestamp)
    const costRows = db.prepare('SELECT * FROM recipe_cost_cache').all();
    const costMap = {};
    let oldestRefreshed = null;
    for (const r of costRows) {
        costMap[r.grocy_recipe_id] = r;
        if (!oldestRefreshed || r.refreshed_at < oldestRefreshed) {
            oldestRefreshed = r.refreshed_at;
        }
    }

    // 4) Hent salgspriser fra item_prices
    const priceRows = db.prepare(`
        SELECT item_id, price FROM item_prices
        WHERE item_type = 'recipe' AND price_category_id = ?
    `).all(priceCategoryId);
    const priceMap = {};
    for (const p of priceRows) priceMap[p.item_id] = p.price;

    // 5) Hent DB%-mål
    const targetRows = db.prepare('SELECT category, target_pct FROM recipe_db_targets').all();
    const targetMap = {};
    for (const t of targetRows) targetMap[t.category] = t.target_pct;

    // 6) Sold-aggregat for perioden (revenue INCL moms — konverteres til excl bagefter)
    const placeholders = _statusPlaceholders(REVENUE_CODES);
    const soldRaw = db.prepare(`
        SELECT bl.grocy_recipe_id,
               SUM(bl.quantity) AS units,
               SUM(bl.quantity * bl.unit_price) AS revenue_incl_moms
        FROM bon_lines bl
        JOIN bons b ON b.id = bl.bon_id
        JOIN status_definitions s ON s.id = b.status_id
        WHERE b.delivery_date >= date('now', ?)
          AND s.code IN (${placeholders})
          ${OFFER_INTERNAL_FILTER}${nonRevenueBonExcludeSQL('b')}
          AND bl.grocy_recipe_id IS NOT NULL
        GROUP BY bl.grocy_recipe_id
    `).all(`-${periodDays} days`, ...REVENUE_CODES);

    const soldMap = {};
    for (const s of soldRaw) {
        soldMap[s.grocy_recipe_id] = {
            units: s.units || 0,
            revenue_excl_moms: r2(inclToExcl(s.revenue_incl_moms || 0)),  // KRITISK: konverter via helper
        };
    }

    // 7) Period-buckets (12 buckets, ældste først)
    const { boundaries } = _calcBuckets(periodDays);
    // SQL: brug (julianday('now') - julianday(b.delivery_date)) som "dage før nu"
    const bucketsRaw = db.prepare(`
        SELECT bl.grocy_recipe_id,
               CAST(julianday('now') - julianday(b.delivery_date) AS INTEGER) AS days_ago,
               SUM(bl.quantity) AS units
        FROM bon_lines bl
        JOIN bons b ON b.id = bl.bon_id
        JOIN status_definitions s ON s.id = b.status_id
        WHERE b.delivery_date >= date('now', ?)
          AND s.code IN (${placeholders})
          ${OFFER_INTERNAL_FILTER}${nonRevenueBonExcludeSQL('b')}
          AND bl.grocy_recipe_id IS NOT NULL
        GROUP BY bl.grocy_recipe_id, days_ago
    `).all(`-${periodDays} days`, ...REVENUE_CODES);

    const bucketMap = {};   // recipe_id → [12 tal]
    for (const row of bucketsRaw) {
        const daysAgo = row.days_ago;
        // Find bucket-index: bucket[i] dækker (periodDays - (i+1)*bucketDays, periodDays - i*bucketDays]
        // I.e. bucket 0 (ældste) = (periodDays - bucketDays, periodDays]
        //      bucket 11 (nyeste) = (0, bucketDays]
        let bucketIdx = -1;
        for (let i = 0; i < 12; i++) {
            const b = boundaries[i];
            if (daysAgo >= b.startDays && daysAgo < b.endDays) {
                bucketIdx = i;
                break;
            }
        }
        // Edge case: daysAgo = 0 (i dag) falder i sidste bucket (nyeste)
        if (bucketIdx === -1 && daysAgo >= 0 && daysAgo < boundaries[11].endDays) {
            bucketIdx = 11;
        }
        if (bucketIdx === -1) continue;

        if (!bucketMap[row.grocy_recipe_id]) bucketMap[row.grocy_recipe_id] = new Array(12).fill(0);
        bucketMap[row.grocy_recipe_id][bucketIdx] += row.units || 0;
    }

    // 8) Byg recipe-array
    const recipes = [];
    for (const r of rawRecipes) {
        const uf = r.userfields || {};
        const isActive = String(uf.sellable) === '1';
        if (!includeInactive && !isActive) continue;

        const rawCategory = uf.grupper || null;
        // Preset-checklist kan have flere værdier (kommasepareret) — tag første
        const category = rawCategory
            ? String(rawCategory).split(',')[0].trim()
            : null;
        if (categoryFilter && category !== categoryFilter) continue;

        const isOrganic = String(uf.Oeko) === '1';
        const cost = costMap[r.id];
        const costPriceExcl = cost ? r2(cost.cost_price_excl_moms) : null;
        const co2ePerUnit = cost?.co2e ?? (parseFloat(uf.Co2e) || 0);

        const salesPriceExcl = priceMap[r.id] != null ? r2(priceMap[r.id]) : null;

        const dbKr = (salesPriceExcl != null && costPriceExcl != null)
            ? r2(salesPriceExcl - costPriceExcl)
            : null;
        const dbPct = (salesPriceExcl != null && costPriceExcl != null && salesPriceExcl > 0)
            ? r2((salesPriceExcl - costPriceExcl) / salesPriceExcl * 100)
            : null;

        const targetPct = category != null ? (targetMap[category] ?? null) : null;
        const underTarget = (dbPct != null && targetPct != null && dbPct < targetPct);
        const lossMaking = (dbPct != null && dbPct < 0);

        const soldUnits = soldMap[r.id]?.units || 0;
        const revenueExcl = soldMap[r.id]?.revenue_excl_moms || 0;
        const periodBuckets = bucketMap[r.id] || new Array(12).fill(0);
        const co2Total = r2(co2ePerUnit * soldUnits);

        recipes.push({
            grocy_recipe_id: r.id,
            name: r.name,
            category,
            is_active: isActive,
            is_organic: isOrganic,
            cost_price_excl_moms: costPriceExcl,
            sales_price_excl_moms: salesPriceExcl,
            db_kr_excl_moms: dbKr,
            db_pct: dbPct,
            db_target_pct: targetPct,
            under_target: underTarget,
            loss_making: lossMaking,
            sold_units: soldUnits,
            revenue_excl_moms: revenueExcl,
            co2e_per_unit: r2(co2ePerUnit),
            co2_total_period: co2Total,
            period_buckets: periodBuckets,
        });
    }

    // 9) Summary KPI'er
    const activeCount = recipes.filter(r => r.is_active).length;
    const underTargetCount = recipes.filter(r => r.under_target).length;
    const lossMakingCount = recipes.filter(r => r.loss_making).length;
    const missingPriceCount = recipes.filter(r => r.sales_price_excl_moms == null).length;
    const notSoldCount = recipes.filter(r => r.sold_units === 0).length;
    const okoCount = recipes.filter(r => r.is_organic).length;

    const totalRevenue = recipes.reduce((s, r) => s + r.revenue_excl_moms, 0);

    // Vægtet DB% skal være et ægte vægtet gennemsnit af rækkernes db_pct, dvs.
    // tæller og nævner SKAL bruge samme pris-grundlag (den valgte priskategoris
    // teoretiske pris). Tidligere delte vi teoretisk DB med FAKTISK omsætning →
    // inkommensurabelt, og resultatet kunne overstige den højeste enkelt-række
    // (matematisk umuligt for et vægtet gennemsnit). Summér begge over de SAMME
    // rækker (hvor DB kan beregnes).
    let totalDbKr = 0;
    let totalWeightRevenue = 0;   // Σ(kategori-salgspris_excl × sold_units)
    for (const r of recipes) {
        if (r.db_kr_excl_moms == null || r.sales_price_excl_moms == null) continue;
        totalDbKr += r.db_kr_excl_moms * r.sold_units;
        totalWeightRevenue += r.sales_price_excl_moms * r.sold_units;
    }
    const totalCo2 = recipes.reduce((s, r) => s + r.co2_total_period, 0);

    const shareUnderTargetPct = activeCount > 0
        ? r2(underTargetCount / activeCount * 100)
        : 0;
    const avgDbPctWeighted = totalWeightRevenue > 0
        ? r2(totalDbKr / totalWeightRevenue * 100)
        : 0;

    res.json({
        price_category: priceCategory,
        period_days: periodDays,
        cost_refreshed_at: _sqliteUtcToIso(oldestRefreshed),
        cost_stale: _staleLevel(oldestRefreshed),
        backfill_ran: !backfillResult.skipped,
        summary: {
            active_count: activeCount,
            total_count: recipes.length,
            under_target_count: underTargetCount,
            loss_making_count: lossMakingCount,
            missing_price_count: missingPriceCount,
            not_sold_count: notSoldCount,
            oko_count: okoCount,
            share_under_target_pct: shareUnderTargetPct,
            avg_db_pct_weighted: avgDbPctWeighted,
            total_revenue_excl_moms: r2(totalRevenue),
            total_db_kr_excl_moms: r2(totalDbKr),
            total_co2_kg: r2(totalCo2),
        },
        recipes,
    });
}));

// ─── POST /api/recipes/refresh-costs ──────────────────────────

router.post('/refresh-costs', handle(async (req, res) => {
    const t0 = Date.now();
    const db = getDb();

    let rawRecipes, fulfillment;
    try {
        [rawRecipes, fulfillment] = await Promise.all([
            grocyAdapter.getRecipesRaw(),
            grocyAdapter.getRecipeFulfillment(),
        ]);
    } catch (err) {
        return res.status(503).json({ error: 'Grocy ikke tilgængelig', detail: err.message });
    }

    // Build cost-lookup fra fulfillment
    const costMap = {};
    for (const f of fulfillment) {
        costMap[f.recipe_id] = f.costs ?? 0;
    }

    const upsert = db.prepare(`
        INSERT INTO recipe_cost_cache (grocy_recipe_id, cost_price_excl_moms, ingredients_json, co2e, refreshed_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(grocy_recipe_id) DO UPDATE SET
            cost_price_excl_moms = excluded.cost_price_excl_moms,
            ingredients_json = excluded.ingredients_json,
            co2e = excluded.co2e,
            refreshed_at = CURRENT_TIMESTAMP
    `);

    let refreshed = 0;
    const errors = [];
    for (const recipe of rawRecipes) {
        try {
            const uf = recipe.userfields || {};
            const cost = costMap[recipe.id] ?? (parseFloat(uf.costprice) || 0);
            const co2e = parseFloat(uf.Co2e) || null;
            // Simpel ingredients_json — kun navnet på opskriften er kendt på denne fase.
            // Detaljeret breakdown bygges via getRecipeIngredients() ved drill-down,
            // men vi gemmer en stub her for fremtidig udvidelse.
            upsert.run(recipe.id, r2(cost), '[]', co2e);
            refreshed++;
        } catch (err) {
            errors.push({ recipe_id: recipe.id, error: err.message });
        }
    }

    // Synk også salgspriser Grocy → item_prices (Grocy er master; redigeringer i
    // viewet er allerede skrevet tilbage til Grocy, så overwrite er sikkert).
    let priceSync = null;
    try {
        priceSync = itemPriceBackfill.syncPricesFromGrocy(rawRecipes);
    } catch (err) {
        errors.push({ price_sync: true, error: err.message });
    }

    const result = {
        refreshed,
        price_sync: priceSync,
        errors: errors.length ? errors : undefined,
        duration_ms: Date.now() - t0,
        refreshed_at: new Date().toISOString(),
    };
    broadcast('recipe_costs_refreshed', { refreshed, refreshed_at: result.refreshed_at });
    res.json(result);
}));

// ─── POST /api/recipes/backfill (admin force re-run) ──────────

router.post('/backfill', requireAuth('admin'), handle(async (req, res) => {
    const force = parseInt(req.query.force, 10) || 0;
    if (force < 0 || force > 2) {
        return res.status(400).json({ error: 'force skal være 0, 1 eller 2' });
    }

    const db = getDb();
    // Nulstil flag før kørsel (force=1+ implicit) så backfillIfNeeded ikke springer over
    db.prepare(`UPDATE settings SET value = '0' WHERE key = 'recipe_prices_backfilled'`).run();

    const result = await itemPriceBackfill.runBackfill({
        force,
        userId: req.session?.userId,
    });
    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'recipe_prices_backfilled'`).run();

    if (force === 2) {
        result._warning = 'force=2: manuel ændrede priser blev overskrevet';
    }
    res.json(result);
}));

// ─── PUT /api/item-prices ─────────────────────────────────────
// Bemærk: monteret på sin egen router så public path bliver /api/item-prices
// (matcher spec). Selve handleren ligger her for at holde modul-sammenhæng.

itemPricesRouter.put('/', handle(async (req, res) => {
    const { item_type, item_id, price_category_code, price_excl_moms } = req.body || {};

    if (!['recipe', 'product', 'local'].includes(item_type)) {
        return res.status(400).json({ error: 'item_type skal være recipe, product eller local' });
    }
    if (!Number.isFinite(Number(item_id))) {
        return res.status(400).json({ error: 'item_id påkrævet' });
    }
    if (!price_category_code) {
        return res.status(400).json({ error: 'price_category_code påkrævet' });
    }
    const priceNum = Number(price_excl_moms);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'price_excl_moms skal være ≥ 0' });
    }

    const db = getDb();
    const pcId = _getPriceCategoryId(price_category_code);
    if (!pcId) {
        return res.status(400).json({ error: `Ukendt price_category_code: ${price_category_code}` });
    }

    // Write-back til Grocy FØRST (Grocy er master for recipe-salgspriser — §6b:
    // Salesprice*-userfields er INCL moms). Fejler Grocy gemmes der INTET lokalt,
    // så item_prices og Grocy aldrig divergerer.
    if (item_type === 'recipe') {
        const userfield = itemPriceBackfill.CATEGORY_TO_USERFIELD[price_category_code];
        if (userfield) {
            const priceInclMoms = r2(exclToIncl(priceNum));
            try {
                await grocyAdapter.updateRecipeUserfields(Number(item_id), {
                    [userfield]: String(priceInclMoms),
                });
            } catch (err) {
                return res.status(503).json({
                    error: 'Grocy ikke tilgængelig — prisen blev IKKE gemt',
                    detail: err.message,
                });
            }
        }
    }

    const userId = req.session?.userId || null;
    const result = db.prepare(`
        INSERT INTO item_prices (item_type, item_id, price_category_id, price, updated_at, updated_by_user_id)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(item_type, item_id, price_category_id) DO UPDATE SET
            price = excluded.price,
            updated_at = CURRENT_TIMESTAMP,
            updated_by_user_id = excluded.updated_by_user_id
    `).run(item_type, Number(item_id), pcId, r2(priceNum), userId);

    // Find row-id til changelog
    const row = db.prepare(`
        SELECT id, updated_at FROM item_prices
        WHERE item_type = ? AND item_id = ? AND price_category_id = ?
    `).get(item_type, Number(item_id), pcId);

    try {
        logChange({
            entity_type: 'item_prices',
            entity_id: row.id,
            action: 'update',
            user_id: userId,
            details: { item_type, item_id, price_category_code, price_excl_moms: r2(priceNum) },
        });
    } catch (err) { /* changelog non-critical */ }

    broadcast('item_price_updated', {
        item_type,
        item_id: Number(item_id),
        price_category_code,
        price_excl_moms: r2(priceNum),
    });

    res.json({ ok: true, updated_at: row.updated_at, id: row.id });
}));

// ─── GET /api/recipes/targets ─────────────────────────────────

router.get('/targets', handle(async (req, res) => {
    const db = getDb();
    const targets = db.prepare(`
        SELECT category, target_pct, updated_at FROM recipe_db_targets ORDER BY category
    `).all();

    // Saml unikke kategorier fra Grocy (inkl. dem uden mål)
    let categories = [];
    try {
        const rawRecipes = await grocyAdapter.getRecipesRaw();
        const set = new Set();
        for (const r of rawRecipes) {
            const uf = r.userfields || {};
            const raw = uf.grupper;
            if (!raw) continue;
            const first = String(raw).split(',')[0].trim();
            if (first) set.add(first);
        }
        categories = Array.from(set).sort();
    } catch (err) {
        // Grocy nede — returnér kun targets uden categories-liste
    }

    res.json({ categories, targets });
}));

// ─── PUT /api/recipes/targets (bulk-upsert) ───────────────────

router.put('/targets', handle((req, res) => {
    const { targets } = req.body || {};
    if (!Array.isArray(targets)) {
        return res.status(400).json({ error: 'targets skal være array' });
    }

    const db = getDb();
    const userId = req.session?.userId || null;
    const upsert = db.prepare(`
        INSERT INTO recipe_db_targets (category, target_pct, updated_at, updated_by_user_id)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(category) DO UPDATE SET
            target_pct = excluded.target_pct,
            updated_at = CURRENT_TIMESTAMP,
            updated_by_user_id = excluded.updated_by_user_id
    `);

    let count = 0;
    for (const t of targets) {
        if (!t.category || !Number.isFinite(Number(t.target_pct))) continue;
        upsert.run(String(t.category), Number(t.target_pct), userId);
        count++;
    }

    broadcast('recipe_targets_updated', { targets });
    res.json({ ok: true, count });
}));

// ─── PATCH /api/recipes/targets/:category ─────────────────────

router.patch('/targets/:category', handle((req, res) => {
    const category = String(req.params.category);
    const { target_pct } = req.body || {};
    const pctNum = Number(target_pct);
    if (!Number.isFinite(pctNum)) {
        return res.status(400).json({ error: 'target_pct påkrævet' });
    }

    const db = getDb();
    const userId = req.session?.userId || null;
    db.prepare(`
        INSERT INTO recipe_db_targets (category, target_pct, updated_at, updated_by_user_id)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(category) DO UPDATE SET
            target_pct = excluded.target_pct,
            updated_at = CURRENT_TIMESTAMP,
            updated_by_user_id = excluded.updated_by_user_id
    `).run(category, pctNum, userId);

    broadcast('recipe_targets_updated', { targets: [{ category, target_pct: pctNum }] });
    res.json({ ok: true, category, target_pct: pctNum });
}));

// ─── DELETE /api/recipes/targets/:category ────────────────────

router.delete('/targets/:category', handle((req, res) => {
    const category = String(req.params.category);
    const db = getDb();
    const info = db.prepare('DELETE FROM recipe_db_targets WHERE category = ?').run(category);
    broadcast('recipe_targets_updated', { removed: [category] });
    res.json({ ok: true, deleted: info.changes });
}));

// ─── GET /api/grocy/recipe-link/:id → 302 ─────────────────────

router.get('/grocy-recipe-link/:id', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).send('Invalid id');

    try {
        const { url } = await grocyAdapter.getGrocyConfig();
        // Grocy URL er typisk .../api → fjern /api for at få base
        const baseUrl = url.replace(/\/api\/?$/, '');
        return res.redirect(302, `${baseUrl}/recipe/${id}`);
    } catch (err) {
        return res.status(503).send('Grocy config ikke tilgængelig');
    }
}));

// ─── Composition: råvarer + underopskrifter til drill-down i panelet ──────────
//
// GET /api/recipes/:id/composition
//
// Ét niveau ad gangen: den valgte opskrifts direkte ingredienser + dens
// underopskrifter. Drill-down sker klient-side ved at kalde endpointet igen for
// den klikkede id. To slags klikbare børn — samme mekanik som køkkenets
// recipe_viewer (shared/recipe_viewer.js):
//   • sub_recipes           — ægte recipes_nestings (Frisk Grønt, Løvstikke Mayo)
//   • ingredienser med producing_recipe_id — et PRODUKT hvis egen opskrift
//     producerer det (Langtids Stegt Gris → svinekam). Åbnes via den opskrift.
//
// recipes_pos.amount er i STOCK-enhed → konverteres til display via quConvert
// (samme som ingredientResolver). Bruger getRecipesRawMap (IKKE getRecipes, der
// filtrerer sellable=1) — produktions-opskrifter er sjældent sellable.
router.get('/:id/composition', handle(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ugyldigt id' });

    const [recipesMap, allPos, nestings, products, units, conversions, stock] = await Promise.all([
        grocyAdapter.getRecipesRawMap(),
        grocyAdapter.getAllRecipesPos(),
        grocyAdapter.getRecipeNestings(),
        grocyAdapter.getProducts(),
        grocyAdapter.getQuantityUnits(),
        grocyAdapter.getQuantityUnitConversions(),
        grocyAdapter.getStock().catch(() => []),
    ]);

    const recipe = recipesMap.get(id);
    if (!recipe) return res.status(404).json({ error: 'Opskrift ikke fundet' });

    const unitMap = new Map(units.map(u => [u.id, u]));
    const productMap = new Map(products.map(p => [String(p.id), p]));
    const stockMap = new Map(stock.map(s => [String(s.product_id), parseFloat(s.amount) || 0]));

    // Produkt → opskrift der producerer det (recipe.product_id peger på output-produktet).
    const producingByProduct = new Map();
    for (const r of recipesMap.values()) {
        if (r.product_id && String(r.product_id) !== '0') {
            producingByProduct.set(String(r.product_id), r.id);
        }
    }

    const unitName = (quId) => {
        const u = unitMap.get(quId);
        return u ? (u.name_short || u.name || '') : '';
    };

    // Direkte ingredienser (recipes_pos)
    const ingredients = allPos
        .filter(p => String(p.recipe_id) === String(id))
        .map(pos => {
            const prod = productMap.get(String(pos.product_id)) || {};
            const stockQuId = prod.qu_id_stock || pos.qu_id;
            const fmt = convertAndFormat(parseFloat(pos.amount) || 0, {
                productId: pos.product_id,
                fromQuId: stockQuId,
                toQuId: pos.qu_id,
                conversions,
                unitMap,
            });
            const producingId = producingByProduct.get(String(pos.product_id));
            return {
                product_id: pos.product_id,
                name: pos.product_name || prod.name || ('Produkt #' + pos.product_id),
                amount: fmt.amount,
                unit: fmt.unit,
                ingredient_group: pos.ingredient_group || '',
                stock: stockMap.has(String(pos.product_id)) ? stockMap.get(String(pos.product_id)) : null,
                stock_unit: unitName(stockQuId),
                // Klikbar kun hvis produktet har sin EGEN opskrift (og ikke er den vi står på).
                producing_recipe_id: (producingId && producingId !== id) ? producingId : null,
            };
        });

    // Underopskrifter (recipes_nestings)
    const sub_recipes = nestings
        .filter(n => String(n.recipe_id) === String(id))
        .map(n => {
            const sub = recipesMap.get(n.includes_recipe_id);
            if (!sub) return null;
            const uf = sub.userfields || {};
            return {
                recipe_id: sub.id,
                name: sub.name,
                servings: parseFloat(n.servings) || 1,
                unit: uf.recipeunit || 'stk',
                category: uf.grupper || null,
            };
        })
        .filter(Boolean);

    const uf = recipe.userfields || {};
    res.json({
        recipe_id: recipe.id,
        name: recipe.name,
        category: uf.grupper || null,
        unit: uf.recipeunit || 'stk',
        base_servings: parseInt(recipe.base_servings) || 1,
        ingredients,
        sub_recipes,
    });
}));

module.exports = router;
module.exports.itemPricesRouter = itemPricesRouter;
