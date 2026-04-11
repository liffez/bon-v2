/**
 * routes/goods-receipts.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelse v3 — fødevarekontrol + lager-opdatering.
 *
 * POST /api/goods-receipts/photo    Upload foto (multipart)
 * POST /api/goods-receipts          Opret receipt + Grocy addStock + webhook
 * GET  /api/goods-receipts          Liste med filtre
 * GET  /api/goods-receipts/:id      Detalje inkl. items
 * GET  /api/goods-receipts/users    Aktive brugere (til dropdown)
 *
 * Monteres i server.js:
 *   app.use('/api/goods-receipts', require('./routes/goods-receipts'));
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const Busboy  = require('busboy');

const { getDb }       = require('../db/database');
const { transaction } = require('../db/compat');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const grocy           = require('../services/grocyAdapter');
const webhook         = require('../services/goodsReceiptWebhook');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'receipts');
const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10 MB

/* ── Helpers ──────────────────────────────────────────────── */

function nextReceiptNumber() {
    const db = getDb();
    return transaction(db, () => {
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_prefix'`).get()?.value ?? 'VR';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='goods_receipt_number_next'`).run(String(current + 1));
        const year = new Date().getFullYear();
        return `${prefix}-${year}-${String(current).padStart(3, '0')}`;
    });
}

/* ── GET /users — aktive brugere til dropdown ────────────── */

router.get('/users', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare(
        `SELECT id, name FROM users WHERE is_active = 1 ORDER BY name`
    ).all();
    res.json(rows);
}));

/* ── POST /photo — upload følgeseddel-foto ───────────────── */

router.post('/photo', requireAuth(), (req, res) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_PHOTO_SIZE, files: 1 }
    });

    let fileData = null;

    bb.on('file', (name, stream, info) => {
        const { filename, mimeType } = info;

        if (!mimeType.startsWith('image/')) {
            stream.resume();
            fileData = { error: 'Kun billedfiler er tilladt' };
            return;
        }

        const chunks = [];
        let truncated = false;

        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('limit', () => { truncated = true; });
        stream.on('end', () => {
            const ext = mimeType === 'image/png' ? '.png'
                      : mimeType === 'image/webp' ? '.webp'
                      : '.jpg';
            fileData = {
                buffer: Buffer.concat(chunks),
                ext,
                truncated,
            };
        });
    });

    bb.on('close', () => {
        try {
            if (!fileData) return res.status(400).json({ error: 'Ingen fil modtaget' });
            if (fileData.error) return res.status(400).json({ error: fileData.error });
            if (fileData.truncated) return res.status(413).json({ error: 'Fil overstiger 10 MB' });

            const storedName = `vr-tmp-${Date.now()}${fileData.ext}`;
            const filePath = path.join(UPLOAD_DIR, storedName);
            fs.writeFileSync(filePath, fileData.buffer);

            res.json({ path: `/uploads/receipts/${storedName}` });
        } catch (err) {
            console.error('[goods-receipts] Foto upload fejl:', err.message);
            res.status(500).json({ error: 'Upload fejlede' });
        }
    });

    bb.on('error', (err) => {
        console.error('[goods-receipts] Busboy fejl:', err.message);
        res.status(500).json({ error: 'Upload fejlede' });
    });

    req.pipe(bb);
});

/* ── POST / — opret goods receipt + Grocy + webhook ──────── */

router.post('/', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const {
        supplier_name,
        received_by_user_id,
        received_by_name,
        location_id,

        temperature_cool_enabled,
        temperature_cool_value,
        temperature_cool_ok,

        temperature_frozen_enabled,
        temperature_frozen_value,
        temperature_frozen_ok,

        date_check_ok,
        labeling_check_ok,
        packaging_check_ok,

        has_deviation,
        deviation_type,
        deviation_note,

        photo_path,
        notes,
        items,
    } = req.body;

    // Validering
    if (!supplier_name) return res.status(400).json({ error: 'supplier_name er påkrævet' });
    if (!received_by_name && !received_by_user_id) return res.status(400).json({ error: 'received_by_name er påkrævet' });
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet' });
    }

    // 1. Generér receipt_number
    const receiptNumber = nextReceiptNumber();

    // 2. INSERT goods_receipt
    const receiverName = received_by_name || null;
    const grResult = db.prepare(`
        INSERT INTO goods_receipts (
            receipt_number, supplier_name, location_id, received_by, received_by_name, received_at,
            temperature_cool_enabled, temperature_cool_value, temperature_cool_ok,
            temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok,
            date_check_ok, labeling_check_ok, packaging_check_ok,
            has_deviation, deviation_type, deviation_note,
            photo_path, notes, status
        ) VALUES (?, ?, ?, ?, ?, datetime('now'),
                  ?, ?, ?,
                  ?, ?, ?,
                  ?, ?, ?,
                  ?, ?, ?,
                  ?, ?, 'approved')
    `).run(
        receiptNumber,
        supplier_name,
        location_id || null,
        received_by_user_id || null,
        receiverName,
        temperature_cool_enabled ? 1 : 0,
        temperature_cool_enabled ? temperature_cool_value : null,
        temperature_cool_enabled ? (temperature_cool_ok ? 1 : 0) : null,
        temperature_frozen_enabled ? 1 : 0,
        temperature_frozen_enabled ? temperature_frozen_value : null,
        temperature_frozen_enabled ? (temperature_frozen_ok ? 1 : 0) : null,
        date_check_ok ? 1 : 0,
        labeling_check_ok ? 1 : 0,
        packaging_check_ok ? 1 : 0,
        has_deviation ? 1 : 0,
        deviation_type || null,
        deviation_note || null,
        photo_path || null,
        notes || null
    );

    const receiptId = grResult.lastInsertRowid;

    // 3. INSERT items
    const insertItem = db.prepare(`
        INSERT INTO goods_receipt_items (
            receipt_id, grocy_product_id, product_name,
            expected_quantity, unit, received_quantity,
            status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
        insertItem.run(
            receiptId,
            item.grocy_product_id || null,
            item.product_name,
            item.expected_quantity || null,
            item.unit || null,
            item.received_quantity || null,
            item.status || 'ok',
            item.notes || null
        );
    }

    // 4. Sekventiel Grocy addStock + shopping list cleanup
    const grocyResults = [];
    const updateItem = db.prepare(`
        UPDATE goods_receipt_items SET grocy_added = ?, grocy_error = ?
        WHERE receipt_id = ? AND grocy_product_id = ?
    `);

    for (const item of items) {
        const shouldAddStock = item.status === 'ok' ||
            (item.status === 'wrong' && item.received_quantity > 0) ||
            (item.status === 'damaged' && item.received_quantity > 0);

        if (!shouldAddStock || !item.grocy_product_id || (item.received_quantity || 0) <= 0) {
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: null,
                skipped: true
            });
            continue;
        }

        try {
            await grocy.addToStock(
                item.grocy_product_id,
                item.received_quantity,
                null, // best_before_date — Grocy bruger default_due_days
                location_id || null
            );
            updateItem.run(1, null, receiptId, item.grocy_product_id);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: true,
                error: null
            });
        } catch (err) {
            updateItem.run(0, err.message, receiptId, item.grocy_product_id);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: err.message
            });
        }

        // Shopping list cleanup
        if (item.shopping_list_id) {
            try {
                const received = item.received_quantity || 0;
                const expected = item.expected_quantity || 0;

                if (item.status === 'missing' || received <= 0) {
                    // Nulstil ordered_* men behold på listen
                    await grocy.updateShoppingListItem(item.shopping_list_id, {
                        userfields: {
                            ordered_varenr: '',
                            ordered_at: '',
                            ordered_qty: '',
                            ordered_supplier: ''
                        }
                    });
                } else if (received < expected) {
                    // Delvis: reducer qty til rest, nulstil ordered_*
                    const remaining = expected - received;
                    await grocy.updateShoppingListItem(item.shopping_list_id, {
                        amount: remaining,
                        userfields: {
                            ordered_varenr: '',
                            ordered_at: '',
                            ordered_qty: '',
                            ordered_supplier: ''
                        }
                    });
                } else {
                    // Fuld levering: slet fra listen
                    await grocy.deleteShoppingListItem(item.shopping_list_id);
                }
            } catch (slErr) {
                console.warn(`[goods-receipts] Shopping list cleanup fejl for item ${item.grocy_product_id}:`, slErr.message);
            }
        }
    }

    // 5. Omdøb foto hvis det er en temp-fil
    if (photo_path && photo_path.includes('vr-tmp-')) {
        try {
            const oldName = path.basename(photo_path);
            const ext = path.extname(oldName);
            const newName = `vr-${receiptNumber}-${Date.now()}${ext}`;
            const oldPath = path.join(UPLOAD_DIR, oldName);
            const newPath = path.join(UPLOAD_DIR, newName);

            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
                const newPhotoPath = `/uploads/receipts/${newName}`;
                db.prepare(`UPDATE goods_receipts SET photo_path = ? WHERE id = ?`).run(newPhotoPath, receiptId);
            }
        } catch (err) {
            console.warn('[goods-receipts] Foto omdøbning fejlede:', err.message);
        }
    }

    // 6. Fire-and-forget webhook
    const userName = receiverName || 'Ukendt';
    const receiptRow = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);
    webhook.send(receiptRow, userName).catch(err => {
        console.warn('[goods-receipts] Webhook fejl (non-blocking):', err.message);
    });

    // 7. Response
    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: 'approved',
        grocy_results: grocyResults,
        webhook_sent: true // vi ved det ikke endnu — async
    });
}));

/* ── GET / — liste med filtre ────────────────────────────── */

router.get('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { from, to, supplier, location } = req.query;

    let sql = `SELECT * FROM goods_receipts WHERE 1=1`;
    const params = [];

    if (from) {
        sql += ` AND received_at >= ?`;
        params.push(from);
    }
    if (to) {
        sql += ` AND received_at <= ?`;
        params.push(to + ' 23:59:59');
    }
    if (supplier) {
        sql += ` AND supplier_name LIKE ?`;
        params.push('%' + supplier + '%');
    }
    if (location) {
        sql += ` AND location_id = ?`;
        params.push(parseInt(location));
    }

    sql += ` ORDER BY received_at DESC`;

    res.json(db.prepare(sql).all(...params));
}));

/* ── GET /:id — detalje inkl. items ──────────────────────── */

router.get('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const receipt = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(id);
    if (!receipt) return res.status(404).json({ error: 'Ikke fundet' });

    receipt.items = db.prepare(`SELECT * FROM goods_receipt_items WHERE receipt_id = ?`).all(id);

    res.json(receipt);
}));

module.exports = router;
