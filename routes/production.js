/**
 * routes/production.js
 * ════════════════════════════════════════════════════════════
 * Produktionsbatch (MVP) — log-opskrift / batch record.
 * Spec: docs/CLAUDE_PRODUKTION_MVP.md §11.
 *
 * POST /api/production/batches    Opret batch (QU-konvertering + manuelt
 *                                 lagertræk + self-production add)
 * GET  /api/production/batches    Historik (filtre: recipe_id, from, to)
 * GET  /api/production/batches/:id Detalje inkl. consumption-linjer
 *
 * Monteres i server.js:
 *   app.use('/api/production', require('./routes/production'));
 *
 * Principper:
 *  - QU-konvertering sker HER (server-side) før Grocy-kald (R6).
 *  - Pris ex moms fra Grocy (R3) — al beregning i services/production.js,
 *    ingen moms-multiplikation.
 *  - Idempotens via batch_nonce UNIQUE (R7): dobbelt-submit → returnér den
 *    allerede-oprettede batch i stedet for at trække igen.
 *  - Changelog skrives af serveren. SSE: production_batch_created.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();

const { getDb }       = require('../db/database');
const { transaction } = require('../db/compat');
const { handle, logChange, getDefaultLocationId } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast }   = require('../shared/sse');
const grocy           = require('../services/grocyAdapter');
const { buildBatchPlan, unitCostFromStockRow, resolveYieldToStock } = require('../services/production');

/* ── POST /batches — producér en batch ───────────────────── */

router.post('/batches', requireAuth(), handle(async (req, res) => {
    const b = req.body || {};
    const {
        recipe_id,
        output_product_id,
        portions,
        actual_yield,
        planned_yield,
        yield_qu_id,
        output_unit,
        lines,
        batch_nonce,
        notes,
        add_missing_to_shopping_list,
    } = b;

    // ── Grund-validering (server-side, jf. §11) ──────────────
    // output_product_id er VALGFRI: RR Produktion-opskrifter uden produceret
    // produkt ("Hurtig") laver en consume-only batch (råvarer trækkes, intet
    // lægges på lager).
    const hasOutput = output_product_id != null && output_product_id !== '' && Number(output_product_id) > 0;
    if (!recipe_id)
        return res.status(400).json({ error: 'recipe_id kræves' });
    if (!batch_nonce)
        return res.status(400).json({ error: 'batch_nonce kræves (idempotens)' });
    if (!Array.isArray(lines) || lines.length === 0)
        return res.status(400).json({ error: 'lines kræves' });

    const db = getDb();

    // ── Idempotens-vagt (R7): kendt nonce → returnér eksisterende ─
    const existing = db.prepare('SELECT * FROM production_batches WHERE batch_nonce = ?').get(batch_nonce);
    if (existing) {
        const consumption = db.prepare(
            'SELECT * FROM production_batch_consumption WHERE production_batch_id = ?'
        ).all(existing.id);
        return res.json({ batch: existing, consumption, idempotent: true });
    }

    const locationId = getDefaultLocationId();
    if (!locationId) return res.status(400).json({ error: 'Ingen aktiv lokation' });

    // ── Hent Grocy-data til QU-konvertering + enhedskost ─────
    const [conversions, stock, products, units, rawRecipes] = await Promise.all([
        grocy.getQuantityUnitConversions(),
        grocy.getStock(),
        hasOutput ? grocy.getProducts() : Promise.resolve([]),
        hasOutput ? grocy.getQuantityUnits() : Promise.resolve([]),
        hasOutput ? grocy.getRecipesRaw() : Promise.resolve([]),
    ]);
    const costMap = {};
    for (const s of stock) {
        const c = unitCostFromStockRow(s);
        if (c != null) costMap[s.product_id] = c;
    }

    // ── Udbyttet skal i LAGER-enhed før noget som helst andet (#360) ──
    // Grocy lægger tallet på lageret som lager-enhed uanset hvad UI'et kaldte
    // det. Kan enheden ikke afgøres, afvises batchen — et forkert lagertal er
    // værre end en afvist registrering, fordi det ikke kan ses bagefter.
    let yieldStock = Number(actual_yield) || 0;
    let plannedStock = Number(planned_yield) || 0;
    let stockUnitName = output_unit || '';
    if (hasOutput) {
        const outProduct = products.find(p => String(p.id) === String(output_product_id));
        const outRecipe  = rawRecipes.find(r => String(r.id) === String(recipe_id));
        const r = resolveYieldToStock({
            product: outProduct, recipe: outRecipe,
            amount: Number(actual_yield) || 0, quId: yield_qu_id, units, conversions,
        });
        if (r.error) {
            return res.status(400).json({ error: r.error, code: 'yield_unit_unresolved' });
        }
        yieldStock = r.amount;
        // Forventet udbytte er tastet i SAMME enhed og skal skaleres ens —
        // ellers sammenlignes svind på tværs af to enheder.
        plannedStock = (Number(planned_yield) || 0) * (r.factor ?? 1);
        const qu = units.find(u => Number(u.id) === Number(outProduct.qu_id_stock));
        stockUnitName = qu ? (qu.name_short || qu.name || '') : (output_unit || '');
    }

    // ── Byg plan (REN: QU-konvertering + pris) ───────────────
    // Udbytte kræves kun når der ER et output-produkt at prissætte (consume-only
    // batches behøver ikke et udbytte).
    const plan = buildBatchPlan({ portions, actualYield: yieldStock, lines, conversions, costMap, requireYield: hasOutput });
    if (plan.errors.length) {
        return res.status(400).json({ error: 'Validering fejlede', details: plan.errors });
    }

    // ── Persistér draft + consumption-linjer ─────────────────
    let batchId;
    transaction(db, () => {
        const r = db.prepare(`
            INSERT INTO production_batches
              (location_id, grocy_recipe_id, grocy_output_product_id, portions,
               planned_output_qty, actual_output_qty, output_unit, batch_nonce,
               state, master_cost, actual_cost, notes, produced_by_user_id)
            VALUES (?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)
        `).run(
            locationId, recipe_id, hasOutput ? Number(output_product_id) : null, Number(portions) || 1,
            // planned_output_qty = forventet udbytte (svind-reference); falder tilbage til
            // faktisk hvis frontend ikke sender planned_yield. actual = faktisk udbytte.
            (plannedStock || yieldStock || 0), (yieldStock || 0) || null,
            stockUnitName, batch_nonce,
            plan.masterCost, plan.actualCost, notes || null, req.session.userId || null,
        );
        batchId = r.lastInsertRowid;

        const ins = db.prepare(`
            INSERT INTO production_batch_consumption
              (production_batch_id, grocy_product_id, product_name, planned_qty,
               actual_qty, unit, deviation_reason, substitute_for_product_id, unit_cost)
            VALUES (?,?,?,?,?,?,?,?,?)
        `);
        for (const c of plan.consumptionRows) {
            ins.run(batchId, c.grocy_product_id, c.product_name, c.planned_qty,
                c.actual_qty, c.unit, c.deviation_reason, c.substitute_for_product_id, c.unit_cost);
        }
    });

    // ── Producér i Grocy (uden for transaction — ekstern I/O) ─
    // Consume-only (intet output): spring self-production add over.
    const result = await grocy.produceBatch({
        consume: plan.consume.map(c => ({ productId: c.productId, amount: c.amount })),
        produce: hasOutput
            ? { productId: Number(output_product_id), amount: yieldStock, price: plan.pricePerUnit }
            : undefined,
    });

    // ── Opdatér batch-state + transaction-id'er ──────────────
    transaction(db, () => {
        db.prepare(`
            UPDATE production_batches
               SET state = ?, produce_transaction_id = ?, produced_at = datetime('now')
             WHERE id = ?
        `).run(result.state, result.produceTx, batchId);

        const upd = db.prepare(`
            UPDATE production_batch_consumption
               SET grocy_transaction_id = ?
             WHERE production_batch_id = ? AND grocy_product_id = ?
        `);
        for (const t of result.consumeTx) upd.run(t.transactionId, batchId, t.productId);
    });

    // ── Valgfri indkøbsliste-kobling for udeladte råvarer (§8) ─
    let shoppingAdded = [];
    if (add_missing_to_shopping_list) {
        const missing = plan.consumptionRows.filter(c => c.deviation_reason === 'udeladt' && c.planned_qty > 0);
        if (missing.length) {
            try {
                await grocy.addToShoppingList(missing.map(c => ({
                    product_id: c.grocy_product_id,
                    amount:     c.planned_qty,
                    note:       'Manglede ved produktion',
                })));
                shoppingAdded = missing.map(c => c.grocy_product_id);
            } catch (_) { /* ikke-blokerende — springes over ved fejl */ }
        }
    }

    logChange({
        entityType: 'production_batch',
        entityId:   batchId,
        action:     'create',
        newValue:   JSON.stringify({ recipe_id, state: result.state, price_per_unit: plan.pricePerUnit }),
        userId:     req.session.userId,
    });
    broadcast('production_batch_created', { id: batchId, recipe_id, state: result.state });

    const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(batchId);
    const consumption = db.prepare(
        'SELECT * FROM production_batch_consumption WHERE production_batch_id = ?'
    ).all(batchId);

    res.status(201).json({
        batch,
        consumption,
        grocy: result,
        conversion_log: plan.conversionLog,
        shopping_added: shoppingAdded,
    });
}));

/* ── GET /batches — historik ─────────────────────────────── */

router.get('/batches', requireAuth(), handle((req, res) => {
    const { recipe_id, from, to } = req.query;
    const where = [];
    const args = [];
    if (recipe_id) { where.push('grocy_recipe_id = ?'); args.push(Number(recipe_id)); }
    if (from)      { where.push("date(produced_at) >= ?"); args.push(from); }
    if (to)        { where.push("date(produced_at) <= ?"); args.push(to); }
    const sql = `SELECT * FROM production_batches
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 200`;
    res.json(getDb().prepare(sql).all(...args));
}));

/* ── GET /batches/:id — detalje inkl. linjer ─────────────── */

router.get('/batches/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Batch ikke fundet' });
    const consumption = db.prepare(
        'SELECT * FROM production_batch_consumption WHERE production_batch_id = ? ORDER BY id'
    ).all(batch.id);
    res.json({ batch, consumption });
}));

module.exports = router;
