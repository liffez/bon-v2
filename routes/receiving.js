/**
 * routes/receiving.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelse — fusion endpoint.
 *
 * POST /api/receiving/complete gør fire ting:
 *   1. Grocy lager → tilføj modtagne varer
 *   2. Whiteboard FVST → log fødevaredokumentation
 *   3. Purchase order → marker som modtaget
 *   4. Lokal log → gem i receiving_log
 *
 * Monteres i server.js som:
 *   app.use('/api/receiving', require('./routes/receiving'));
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../db/database');
const { handle, getUserId, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const grocy = require('../services/grocyAdapter');
const { resolveToStockAmount } = require('../services/quConvert');

/* ── POST /api/receiving/complete ────────────────────────── */

router.post('/complete', handle(async (req, res) => {
    const db = getDb();
    const {
        purchase_order_id,
        supplier,
        receiver,
        temperature,
        date_ok,
        label_ok,
        packaging_ok,
        deviation,
        deviation_note,
        photo_path,
        items,
    } = req.body;

    if (!supplier) return res.status(400).json({ error: 'supplier er påkrævet' });
    if (!receiver) return res.status(400).json({ error: 'receiver er påkrævet' });
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet' });
    }

    const tempOk = temperature != null ? temperature <= 5 : true;

    // ── 1. GROCY LAGER ──────────────────────────────────────
    //
    // #358: samme enheds-forveksling som i goods-receipts.js. Endpointet er legacy
    // (den nuværende varemodtagelse bruger /api/goods-receipts), men det er stadig
    // monteret, og et forkert lagertal koster det samme uanset hvilken dør det kom
    // ind ad. Kan mængden ikke omregnes entydigt, springes lager-opdateringen over.
    let productMap = new Map();
    let conversions = [];
    let quMetaError = null;
    try {
        const [grocyProducts, grocyConversions] = await Promise.all([
            grocy.getProducts(),
            grocy.getQuantityUnitConversions(),
        ]);
        productMap  = new Map(grocyProducts.map(p => [parseInt(p.id), p]));
        conversions = grocyConversions;
    } catch (err) {
        quMetaError = err.message;
        console.warn('[receiving] Kunne ikke hente Grocy enheds-data:', err.message);
    }

    const grocyResults = [];
    for (const item of items) {
        if (item.status === 'missing') {
            grocyResults.push({ product_id: item.product_id, status: 'missing', success: true, skipped: true });
            continue;
        }
        const qty = item.quantity_received || 0;
        if (qty <= 0) {
            grocyResults.push({ product_id: item.product_id, status: item.status, success: true, skipped: true });
            continue;
        }
        const conv = quMetaError
            ? { amount: null, error: `Kunne ikke hente enheds-data fra Grocy (${quMetaError})` }
            : resolveToStockAmount({
                  product: productMap.get(parseInt(item.product_id)),
                  amount: qty,
                  quId: item.qu_id,
                  conversions,
              });
        if (conv.error) {
            grocyResults.push({ product_id: item.product_id, amount: qty, status: item.status, success: false, error: conv.error });
            console.warn(`[receiving] produkt ${item.product_id}: ${conv.error}`);
            continue;
        }

        try {
            await grocy.addToStock(
                item.product_id,
                conv.amount,   // #358: lager-enhed
                item.best_before_date || null,
                null // location_id
            );
            grocyResults.push({ product_id: item.product_id, amount: conv.amount, status: item.status, success: true });
        } catch (err) {
            grocyResults.push({ product_id: item.product_id, amount: qty, status: item.status, success: false, error: err.message });
        }
    }

    const grocyAdded = grocyResults.filter(r => r.success && !r.skipped).length;
    const grocyFailed = grocyResults.filter(r => !r.success).length;

    // ── 2. WHITEBOARD FVST ──────────────────────────────────
    let whiteboardEventId = null;
    let whiteboardError = null;

    const autoFvst = db.prepare(`SELECT value FROM settings WHERE key = 'receiving_auto_fvst'`).get();
    const wbUrl = db.prepare(`SELECT value FROM settings WHERE key = 'whiteboard_url'`).get();

    if (autoFvst && autoFvst.value === '1' && wbUrl && wbUrl.value) {
        try {
            const fvstResponse = await fetch(wbUrl.value + '/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    schema_name: 'varemodtagelse',
                    user: receiver,
                    supplier: supplier,
                    data: {
                        temperature: temperature || null,
                        date_ok: !!date_ok,
                        label_ok: !!label_ok,
                        packaging_ok: !!packaging_ok,
                        deviation: deviation || 'none',
                        deviation_note: deviation_note || '',
                        photo_path: photo_path || null,
                    },
                }),
            });
            if (fvstResponse.ok) {
                const fvstData = await fvstResponse.json();
                whiteboardEventId = fvstData.id || null;
                console.log(`[receiving] FVST event oprettet: ${whiteboardEventId}`);
            } else {
                const errText = await fvstResponse.text();
                whiteboardError = `HTTP ${fvstResponse.status}: ${errText.slice(0, 200)}`;
                console.warn(`[receiving] Whiteboard fejl:`, whiteboardError);
            }
        } catch (err) {
            whiteboardError = err.message;
            console.warn(`[receiving] Whiteboard utilgængelig:`, err.message);
        }
    }

    // ── 3. PURCHASE ORDER ───────────────────────────────────
    if (purchase_order_id) {
        try {
            const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(purchase_order_id);
            if (po) {
                const missingCount = items.filter(i => i.status === 'missing').length;
                const newStatus = missingCount > 0 ? 'partially_received' : 'received';

                db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(newStatus, purchase_order_id);

                // Opret goods_receipt
                const grResult = db.prepare(`
                    INSERT INTO goods_receipts (
                        location_id, purchase_order_id, receipt_date, status,
                        has_discrepancies, notes, received_by_user_id, created_at
                    ) VALUES (?, ?, date('now'), 'approved', ?, ?, ?, CURRENT_TIMESTAMP)
                `).run(
                    po.location_id,
                    purchase_order_id,
                    missingCount > 0 ? 1 : 0,
                    deviation_note || null,
                    getUserId(req)
                );

                const grId = grResult.lastInsertRowid;

                // Goods receipt lines
                const insertGrl = db.prepare(`
                    INSERT INTO goods_receipt_lines (
                        goods_receipt_id, item_id, quantity_expected, quantity_received,
                        quantity_damaged, discrepancy_type, discrepancy_note, added_to_inventory
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                `);

                for (const item of items) {
                    const discType = item.status === 'ok' ? 'none'
                        : item.status === 'missing' ? 'missing'
                        : item.status === 'damaged' ? 'damaged'
                        : item.status === 'wrong' ? 'wrong_item'
                        : 'none';

                    insertGrl.run(
                        grId,
                        item.product_id,
                        item.quantity_expected || item.quantity_received || 0,
                        item.status === 'missing' ? 0 : (item.quantity_received || 0),
                        item.status === 'damaged' ? (item.quantity_damaged || 0) : 0,
                        discType,
                        item.note || null
                    );
                }

                logChange({
                    entityType: 'purchase_order',
                    entityId: purchase_order_id,
                    action: 'update',
                    fieldName: 'status',
                    oldValue: po.status,
                    newValue: newStatus,
                });

                broadcast('order_received', { id: purchase_order_id, status: newStatus });
            }
        } catch (err) {
            console.warn(`[receiving] PO update fejl:`, err.message);
        }
    }

    // ── 4. LOKAL LOG ────────────────────────────────────────
    let logId = null;
    try {
        const logResult = db.prepare(`
            INSERT INTO receiving_log (
                purchase_order_id, supplier, receiver_name,
                temperature, temp_ok,
                fvst_checks_json, items_json, grocy_results_json,
                whiteboard_event_id, photo_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            purchase_order_id || null,
            supplier,
            receiver,
            temperature || null,
            tempOk ? 1 : 0,
            JSON.stringify({ date_ok, label_ok, packaging_ok, deviation, deviation_note }),
            JSON.stringify(items),
            JSON.stringify(grocyResults),
            whiteboardEventId,
            photo_path || null
        );
        logId = logResult.lastInsertRowid;
    } catch (err) {
        console.warn(`[receiving] Log fejl:`, err.message);
    }

    // ── RESPONSE ────────────────────────────────────────────
    res.json({
        ok: grocyFailed === 0,
        receiving_log_id: logId,
        grocy: {
            added: grocyAdded,
            failed: grocyFailed,
            results: grocyResults,
        },
        whiteboard: {
            sent: !!whiteboardEventId,
            event_id: whiteboardEventId,
            error: whiteboardError,
        },
        purchase_order: purchase_order_id ? { updated: true } : null,
    });
}));

/* ── GET /api/receiving/log ──────────────────────────────── */

router.get('/log', handle((req, res) => {
    const db = getDb();
    const days = parseInt(req.query.days) || 90;
    const supplier = req.query.supplier || null;

    let sql = `SELECT * FROM receiving_log WHERE received_at >= datetime('now', '-' || ? || ' days')`;
    const params = [days];

    if (supplier) {
        sql += ` AND supplier LIKE ?`;
        params.push('%' + supplier + '%');
    }

    sql += ` ORDER BY received_at DESC`;

    res.json(db.prepare(sql).all(...params));
}));

module.exports = router;
