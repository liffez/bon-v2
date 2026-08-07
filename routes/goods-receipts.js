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
const { handle, getUserById } = require('../db/helpers');
const { requireAuth, userCan } = require('../shared/auth');
const grocy           = require('../services/grocyAdapter');
const webhook         = require('../services/goodsReceiptWebhook');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'receipts');
const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10 MB

/* ── GET /users — aktive brugere til dropdown ────────────── */

router.get('/users', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare(
        `SELECT id, name FROM users WHERE is_active = 1 ORDER BY name`
    ).all();
    res.json(rows);
}));

/* ── GET /webhook-log — er koblingen til Whiteboard i live? ─
 *
 * Diagnose-endpoint til Settings. Uden det var den eneste måde at se om
 * varemodtagelserne nåede frem, at logge ind på serveren og læse sqlite.
 * Skal stå FØR '/:id', ellers fanger den generiske rute den. */

router.get('/webhook-log', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const rows = db.prepare(`
        SELECT id, url, status_code, error, sent_at
        FROM webhook_log
        ORDER BY id DESC
        LIMIT ?
    `).all(limit);

    const counts = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN whiteboard_synced_at IS NULL THEN 1 ELSE 0 END) AS unsynced
        FROM goods_receipts
    `).get();

    res.json({
        configured:      webhook.isConfigured(),
        url:             webhook.getWebhookUrl(),
        receipts_total:  counts?.total || 0,
        receipts_unsynced: counts?.unsynced || 0,
        attempts:        rows,
    });
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
        received_at,

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
    if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items skal være en liste' });
    }
    // Varefri registrering (kun fødevarekontrol) er tilladt — når varer købes
    // uden om indkøbsmodulet er der ingen linjer at lægge på lager. Ad-hoc varer
    // lægges på lager via lageroptælling, ikke via varemodtagelsen.

    // F37: Validér at alle items har product_name (NOT NULL constraint på
    // goods_receipt_items.product_name). Uden denne tjek får UI'en en uforklarlig
    // 500 SQLite-fejl i stedet for en pæn 400-besked.
    //
    // F28 (Patch C): samtidig enum-validation på item.status. Status er valgfri
    // (defaulter til 'ok' i INSERT), men ugyldige værdier afvises eksplicit
    // i stedet for at falde igennem alle conditionals i shouldAddStock.
    const VALID_ITEM_STATUSES = ['ok', 'wrong', 'damaged', 'missing'];
    for (let i = 0; i < items.length; i++) {
        const name = items[i]?.product_name;
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
                error: `items[${i}].product_name er påkrævet`
            });
        }
        const status = items[i]?.status;
        if (status !== undefined && status !== null && !VALID_ITEM_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `items[${i}].status='${status}' er ugyldig. Tilladte: ${VALID_ITEM_STATUSES.join(', ')}`
            });
        }
    }

    // Backdatering af modtagedato er admin-only. received_at repræsenterer den
    // ægte modtage-/kontroldato (fra følgeseddlen); created_at forbliver "nu"
    // som ærligt revisionsspor for hvornår posten blev tastet ind. FVST-sikkert
    // — begge datoer bevares, intet skjules.
    let receivedAtValue = null; // null → COALESCE falder tilbage til datetime('now')
    if (received_at != null && received_at !== '') {
        // Admin må altid; andre kun med den finkornede evne 'modtag_backdate'
        // (gives per-bruger i Settings → Brugere, midlertidigt efter behov).
        const actor = getUserById(req.session.userId);
        const canBackdate = req.session.userRole === 'admin' || userCan(actor, 'modtag_backdate');
        if (!canBackdate) {
            return res.status(403).json({ error: 'Du har ikke rettighed til at sætte modtagedato' });
        }
        const dateStr = String(received_at).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
            return res.status(400).json({ error: `received_at='${received_at}' er ugyldig (forventer YYYY-MM-DD)` });
        }
        // Kl. 12:00 lokal undgår at datoen skrider en dag ved tidszone-visning.
        receivedAtValue = `${dateStr} 12:00:00`;
    }

    // Resolve receiver-navn FØR transaction: foretrukket eksplicit name,
    // ellers slå op fra users-tabel via id. Bruges både i INSERT og webhook.
    let receiverName = received_by_name || null;
    if (!receiverName && received_by_user_id) {
        const user = db.prepare(`SELECT name FROM users WHERE id = ?`).get(received_by_user_id);
        receiverName = user?.name || null;
    }

    // Counter-bump + INSERT receipt + INSERT items kører i ÉN transaction.
    // Hvis noget fejler her, rulles ALT tilbage — inkl. counter — så vi
    // ikke spilder receipt-numre eller ender med halv-populerede rækker.
    // Async Grocy addStock + webhook ligger udenfor (partial-success by design:
    // receiptet er gyldigt selvom Grocy-opdatering fejler).
    let receiptId;
    let receiptNumber;
    const itemIds = [];

    transaction(db, () => {
        // 1. Bump counter + generér receipt_number. Inlined her — nextReceiptNumber()
        //    havde sin egen transaction, og node:sqlite tillader ikke nested BEGIN.
        const prefix  = db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_prefix'`).get()?.value ?? 'VR';
        const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='goods_receipt_number_next'`).get()?.value ?? '1');
        db.prepare(`UPDATE settings SET value=? WHERE key='goods_receipt_number_next'`).run(String(current + 1));
        const year = new Date().getFullYear();
        receiptNumber = `${prefix}-${year}-${String(current).padStart(3, '0')}`;

        // 2. INSERT goods_receipt
        const grResult = db.prepare(`
            INSERT INTO goods_receipts (
                receipt_number, supplier_name, location_id, received_by, received_by_name, received_at,
                temperature_cool_enabled, temperature_cool_value, temperature_cool_ok,
                temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok,
                date_check_ok, labeling_check_ok, packaging_check_ok,
                has_deviation, deviation_type, deviation_note,
                photo_path, notes, status
            ) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')),
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
            receivedAtValue,
            temperature_cool_enabled ? 1 : 0,
            // F40: '?? null' (ikke '|| null') så 0°C ikke clampes til null
            temperature_cool_enabled ? (temperature_cool_value ?? null) : null,
            temperature_cool_enabled ? (temperature_cool_ok ? 1 : 0) : null,
            temperature_frozen_enabled ? 1 : 0,
            temperature_frozen_enabled ? (temperature_frozen_value ?? null) : null,
            temperature_frozen_enabled ? (temperature_frozen_ok ? 1 : 0) : null,
            date_check_ok ? 1 : 0,
            labeling_check_ok ? 1 : 0,
            packaging_check_ok ? 1 : 0,
            has_deviation ? 1 : 0,
            // F41: clamp type/note til null når has_deviation=false (state-konsistens)
            has_deviation ? (deviation_type || null) : null,
            has_deviation ? (deviation_note || null) : null,
            photo_path || null,
            notes || null
        );
        receiptId = grResult.lastInsertRowid;

        // 3. INSERT items — gem item-ID per række så vi senere kan opdatere
        //    den specifikke item (ikke alle items med samme grocy_product_id)
        const insertItem = db.prepare(`
            INSERT INTO goods_receipt_items (
                receipt_id, grocy_product_id, product_name,
                expected_quantity, unit, received_quantity,
                status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of items) {
            const result = insertItem.run(
                receiptId,
                item.grocy_product_id || null,
                item.product_name,
                item.expected_quantity || null,
                item.unit || null,
                item.received_quantity || null,
                item.status || 'ok',
                item.notes || null
            );
            itemIds.push(result.lastInsertRowid);
        }
    });

    // 3b. Hvilken fysisk enhed står varerne i? (#336)
    //
    // Optællingen bruger LastCheckedUnit som "hvor er varen sidst observeret" og
    // lader den styre hvilken enheds-liste varen dukker op i. En vare der lige er
    // modtaget og stillet på plads ER observeret — uden dette stod den stadig som
    // "aldrig tjekket" i optællingen.
    //
    // Varemodtagelsen kender kun en Grocy-lokation, ikke en enhed. Vi slår enheden
    // op ud fra lokationen og vælger deterministisk den første (sort_order, så navn)
    // når der er flere. Brugeren skal ikke gøre noget — flowet er touch-først og må
    // ikke koste et tryk mere.
    //
    // Et forkert gæt er billigt og selvhelbredende: den bløde fallback i optællingen
    // (beslutning E) viser varen under sin lokation uanset hvad, og første gang nogen
    // tæller den det rigtige sted, ruller LastCheckedUnit derhen af sig selv.
    let receivedIntoUnit = null;
    if (location_id) {
        try {
            receivedIntoUnit = db.prepare(`
                SELECT name FROM physical_units
                WHERE grocy_location_id = ? AND archived_at IS NULL
                ORDER BY sort_order, name
                LIMIT 1
            `).get(location_id)?.name || null;
        } catch (err) {
            console.warn('[goods-receipts] Kunne ikke slå fysisk enhed op:', err.message);
        }
    }

    // 4. Sekventiel Grocy addStock + shopping list cleanup.
    // UPDATE matcher på item.id (unik) — ikke grocy_product_id — fordi samme
    // product kan optræde flere gange i samme receipt (forskellige batches).
    const grocyResults = [];
    const updateItem = db.prepare(`
        UPDATE goods_receipt_items SET grocy_added = ?, grocy_error = ?
        WHERE id = ?
    `);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemId = itemIds[i];

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
            updateItem.run(1, null, itemId);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: true,
                error: null
            });

            // #336 — stemple varen som observeret her. Kun når lageret rent
            // faktisk blev opdateret: fejler addStock, står varen ikke der.
            // Fejl må ALDRIG vælte en varemodtagelse — samme partial-success-
            // princip som shopping list-oprydningen nedenfor.
            try {
                await grocy.updateProductUserfields(item.grocy_product_id, {
                    LastCheckedAt: new Date().toISOString(),
                    ...(receivedIntoUnit ? { LastCheckedUnit: receivedIntoUnit } : {})
                });
            } catch (ufErr) {
                console.warn(
                    `[goods-receipts] Kunne ikke stemple produkt ${item.grocy_product_id} som observeret:`,
                    ufErr.message
                );
            }
        } catch (err) {
            updateItem.run(0, err.message, itemId);
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

    // 4b. Patch E (F33): hvis nogen items skulle have addStock men fejlede,
    //     opgradér receipt-status til 'partially_approved' så UI kan rendere
    //     advarsel. Skipped items (status='missing' eller qty=0) tæller IKKE
    //     som failures — kun reelle fejl fra Grocy.
    const grocyFailures = grocyResults.filter(r => r.grocy_added === false && r.skipped !== true);
    if (grocyFailures.length > 0) {
        db.prepare(`UPDATE goods_receipts SET status = 'partially_approved' WHERE id = ?`).run(receiptId);
        console.warn(`[goods-receipts] Receipt ${receiptId} markeret partially_approved — ${grocyFailures.length}/${items.length} items fejlede i Grocy`);
    }

    // 5. Omdøb foto hvis det er en temp-fil.
    // Hvis rename ikke kan gennemføres (temp-fil mangler), null'er vi
    // photo_path i DB så vi ikke ender med dangling reference.
    if (photo_path && photo_path.includes('vr-tmp-')) {
        let renameSucceeded = false;
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
                renameSucceeded = true;
            }
        } catch (err) {
            console.warn('[goods-receipts] Foto omdøbning fejlede:', err.message);
        }

        if (!renameSucceeded) {
            db.prepare(`UPDATE goods_receipts SET photo_path = NULL WHERE id = ?`).run(receiptId);
            console.warn(`[goods-receipts] photo_path nullet for receipt ${receiptId} — temp-fil findes ikke`);
        }
    }

    // 6. Fire-and-forget webhook (receiverName er allerede resolveret ovenfor)
    const userName = receiverName || 'Ukendt';
    const receiptRow = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);
    webhook.send(receiptRow, userName).catch(err => {
        console.warn('[goods-receipts] Webhook fejl (non-blocking):', err.message);
    });

    // 7. Response. Patch E: re-fetch status så vi returnerer 'partially_approved'
    // når det er sat, ikke hardcoded 'approved'. grocy_failure_count eksponerer
    // antallet af fejlede items så UI kan vise badge ("2 fejlede").
    const finalStatus = db.prepare(`SELECT status FROM goods_receipts WHERE id = ?`).get(receiptId)?.status ?? 'approved';
    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: finalStatus,
        grocy_results: grocyResults,
        grocy_failure_count: grocyFailures.length,
        webhook_sent: true,         // @deprecated — bevares for klient-kompatibilitet
        webhook_dispatched: true,   // @deprecated — sagde 'true' også når intet blev sendt
        // Sandheden om Whiteboard-koblingen. De to flag ovenfor har altid stået
        // på true — også i bonv2_only-mode hvor der aldrig blev sendt noget.
        // configured=false betyder: registreringen findes KUN i Bon v2.
        whiteboard: {
            configured: webhook.isConfigured(),
            dispatched: webhook.isConfigured()   // fire-and-forget: afsendt, ikke bekræftet
        }
    });
}));

/* ── GET / — liste med filtre ────────────────────────────── */

router.get('/', requireAuth(), handle((req, res) => {
    const db = getDb();
    const { from, to, supplier, location } = req.query;

    // item_count som korreleret subquery — listen viser "N varer" uden N+1-kald.
    let sql = `
        SELECT gr.*,
               (SELECT COUNT(*) FROM goods_receipt_items gi WHERE gi.receipt_id = gr.id) AS item_count
        FROM goods_receipts gr
        WHERE 1=1`;
    const params = [];

    if (from) {
        sql += ` AND gr.received_at >= ?`;
        params.push(from);
    }
    if (to) {
        sql += ` AND gr.received_at <= ?`;
        params.push(to + ' 23:59:59');
    }
    if (supplier) {
        sql += ` AND gr.supplier_name LIKE ?`;
        params.push('%' + supplier + '%');
    }
    if (location) {
        sql += ` AND gr.location_id = ?`;
        params.push(parseInt(location));
    }

    sql += ` ORDER BY gr.received_at DESC LIMIT ?`;
    params.push(Math.min(parseInt(req.query.limit) || 200, 1000));

    res.json(db.prepare(sql).all(...params));
}));

/* ── POST /:id/resend-webhook — send igen til Whiteboard ───
 *
 * requireAuth() og ikke admin: den der står ved leverancen skal kunne rette op
 * på en fejlet synkronisering med det samme (jf. rolle-baseret login).
 *
 * Nægter når receipten allerede ER synkroniseret — Whiteboard afviser ikke
 * dubletter, så et ekstra kald ville lægge samme leverance i FVST-loggen to
 * gange. Det er værre end at mangle den. */

router.post('/:id/resend-webhook', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const receipt = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(id);
    if (!receipt) return res.status(404).json({ error: 'Ikke fundet' });

    if (receipt.whiteboard_synced_at) {
        return res.status(409).json({
            error: 'Allerede sendt til Whiteboard ' + receipt.whiteboard_synced_at
                 + ' — en gensendelse ville give en dublet i FVST-loggen.'
        });
    }

    if (!webhook.isConfigured()) {
        return res.status(400).json({
            error: 'Whiteboard-koblingen er ikke sat op. Udfyld webhook-URL under Indstillinger → Whiteboard.'
        });
    }

    const userName = receipt.received_by_name
        || getUserById(receipt.received_by)?.name
        || 'Ukendt';

    const result = await webhook.send(receipt, userName);

    if (!result?.ok) {
        return res.status(502).json({
            error: result?.error || 'Whiteboard svarede ikke som forventet',
            status_code: result?.statusCode || null
        });
    }

    res.json({ ok: true, synced_at: db.prepare(
        `SELECT whiteboard_synced_at FROM goods_receipts WHERE id = ?`
    ).get(id)?.whiteboard_synced_at });
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
