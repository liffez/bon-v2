const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getStatusId, getDefaultLocationId, nextBonNumber } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const grocy   = require('../services/grocyAdapter');
// quConvert bruges nu via services/ingredientResolver.js

// ─── GET /api/bons — liste med filter ────────────────────────────────────────

const SORT_WHITELIST = {
    delivery_date: 'b.delivery_date',
    delivery_time: 'b.delivery_time',
    bon_number: 'b.bon_number',
    customer_name: 'contact_name_full',
    company_name: 'co.name',
    pax: 'b.pax',
    status: 'sd.code',
    courier_arrival_time: 'b.courier_arrival_time',
    total_price: 'b.total_price',
};

router.get('/', handle((req, res) => {
    const db = getDb();
    const { status, date, date_from, date_to, q, location, unread_mail, sort, dir, limit, offset } = req.query;
    const where = ['1=1'];
    const args  = [];

    // Status — kommasepareret
    if (status) {
        const codes = status.split(',').map(s => s.trim()).filter(Boolean);
        if (codes.length === 1) {
            where.push('sd.code = ?');
            args.push(codes[0]);
        } else if (codes.length > 1) {
            where.push('sd.code IN (' + codes.map(() => '?').join(',') + ')');
            args.push(...codes);
        }
    }

    // Dato — 'today' oversættes
    if (date) {
        const d = date === 'today' ? new Date().toISOString().slice(0, 10) : date;
        where.push('b.delivery_date = ?');
        args.push(d);
    }
    if (date_from) { where.push('b.delivery_date >= ?'); args.push(date_from); }
    if (date_to)   { where.push('b.delivery_date <= ?'); args.push(date_to); }

    if (location) { where.push('l.code = ?'); args.push(location); }

    // Søgning
    if (q) {
        const isDigits = /^\d+$/.test(q);
        if (isDigits) {
            where.push('(b.bon_number LIKE ?)');
            args.push(`${q}%`);
        } else {
            const like = `%${q}%`;
            where.push("(b.bon_number LIKE ? OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR co.name LIKE ?)");
            args.push(like, like, like);
        }
    }

    // Ulæst mail
    if (unread_mail === '1') {
        where.push(`(SELECT COUNT(*) FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0) > 0`);
    }

    // Sortering
    const sortCol = SORT_WHITELIST[sort] || 'b.delivery_date';
    const sortDir = dir === 'desc' ? 'DESC' : 'ASC';
    const secondarySort = sort === 'delivery_date' ? `, b.delivery_time ${sortDir}` : '';

    // Pagination
    const lim = Math.min(parseInt(limit) || 100, 500);
    const off = parseInt(offset) || 0;

    const rows = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.delivery_time, b.pickup_time,
            b.courier_arrival_time,
            b.pax, b.total_units, b.total_price,
            b.payment_type, b.delivery_type, b.delivery_method, b.kitchen_selects,
            b.price_category_id,
            pc.code  AS price_category_code,
            pc.label AS price_category_label,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            c.phone  AS customer_phone,
            c.email  AS customer_email,
            co.name  AS company_name,
            co.ean   AS company_ean,
            l.name   AS location_name,
            (SELECT COUNT(*) FROM mail_messages mm
             JOIN mail_threads mt ON mm.thread_id = mt.id
             WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0
            ) AS unread_mail_count,
            (SELECT de.event_type FROM delivery_events de
             WHERE de.bon_id = b.id ORDER BY de.event_time DESC LIMIT 1
            ) AS latest_delivery_event,
            (SELECT de.event_time FROM delivery_events de
             WHERE de.bon_id = b.id ORDER BY de.event_time DESC LIMIT 1
            ) AS latest_delivery_event_time
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        JOIN   locations l           ON b.location_id = l.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN price_categories pc ON b.price_category_id = pc.id
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${sortDir}${secondarySort}
        LIMIT ? OFFSET ?
    `).all(...args, lim, off);

    res.json(rows);
}));

// ─── GET /api/bons/:id ──────────────────────────────────────────────────────

router.get('/:id', handle((req, res) => {
    const bon = getBon(parseInt(req.params.id));
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });
    res.json(bon);
}));

// ─── POST /api/bons — opret ny bon ─────────────────────────────────────────

router.post('/', handle((req, res) => {
    const db = getDb();
    const b  = req.body;
    if (!b.delivery_date) return res.status(400).json({ error: 'delivery_date er påkrævet' });

    const bonNumber  = nextBonNumber();
    const statusId   = b.status_id   ?? getStatusId('NY');
    const locationId = b.location_id ?? getDefaultLocationId();

    const result = db.prepare(`
        INSERT INTO bons (
            bon_number, status_id, location_id, customer_id, company_id, price_category_id,
            order_date, delivery_date, pickup_time, delivery_time,
            delivery_type, delivery_method, delivery_address_id,
            delivery_notes, delivery_cost, delivery_price,
            courier_arrival_time, courier_provider,
            pax, total_units, boxes, total_price, total_with_delivery,
            payment_type, kitchen_selects, customer_collects,
            kitchen_info, customer_wishes, internal_notes, invoice_info,
            prep_ingredients_ready, prep_supplies_ready,
            created_by_user_id
        ) VALUES (
            ?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,
            ?,?,?,
            ?,?,
            ?,?,?,?,?,
            ?,?,?,
            ?,?,?,?,
            ?,?,
            ?
        )
    `).run(
        bonNumber, statusId, locationId,
        b.customer_id ?? null, b.company_id ?? null, b.price_category_id ?? null,
        b.order_date ?? new Date().toISOString().slice(0, 10),
        b.delivery_date, b.pickup_time ?? null, b.delivery_time ?? null,
        b.delivery_type ?? 'delivery', b.delivery_method ?? null, b.delivery_address_id ?? null,
        b.delivery_notes ?? null, b.delivery_cost ?? null, b.delivery_price ?? null,
        b.courier_arrival_time ?? null, b.courier_provider ?? null,
        b.pax ?? 0, b.total_units ?? 0, b.boxes ?? null,
        b.total_price ?? null, b.total_with_delivery ?? null,
        b.payment_type ?? null, b.kitchen_selects ? 1 : 0, b.customer_collects ? 1 : 0,
        b.kitchen_info ?? null, b.customer_wishes ?? null,
        b.internal_notes ?? null, b.invoice_info ?? null,
        0, 0,
        b.created_by_user_id ?? null
    );

    logChange({ entityType: 'bon', entityId: result.lastInsertRowid, action: 'create', newValue: bonNumber, userId: b.created_by_user_id });
    const newBon = getBon(result.lastInsertRowid);
    broadcast('bon_created', { id: newBon.id, bon_number: newBon.bon_number });
    res.status(201).json(newBon);
}));

// ─── PATCH /api/bons/:id — opdater felter ───────────────────────────────────

router.patch('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const allowed = [
        'delivery_date', 'delivery_time', 'pickup_time',
        'delivery_type', 'delivery_method', 'delivery_address_id',
        'delivery_notes', 'delivery_cost', 'delivery_price',
        'courier_provider', 'courier_arrival_time',
        'customer_id', 'company_id', 'price_category_id',
        'pax', 'total_units', 'boxes',
        'payment_type', 'kitchen_selects', 'customer_collects',
        'kitchen_info', 'customer_wishes', 'internal_notes', 'invoice_info',
        'day_contact_name', 'day_contact_phone'
    ];

    const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'Ingen gyldige felter' });

    const bon = db.prepare('SELECT * FROM bons WHERE id = ?').get(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    // Konvertér booleans til integers for SQLite
    if ('kitchen_selects' in updates) updates.kitchen_selects = updates.kitchen_selects ? 1 : 0;
    if ('customer_collects' in updates) updates.customer_collects = updates.customer_collects ? 1 : 0;

    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), id];
    db.prepare(`UPDATE bons SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);

    // Log hvert ændret felt
    for (const [field, newVal] of Object.entries(updates)) {
        const oldVal = bon[field];
        if (String(oldVal ?? '') !== String(newVal ?? '')) {
            logChange({
                entityType: 'bon', entityId: id,
                action: 'update', fieldName: field,
                oldValue: String(oldVal ?? ''),
                newValue: String(newVal ?? ''),
                userId: req.session?.userId ?? null
            });
        }
    }

    broadcast('bon_updated', { id });
    res.json({ ok: true });
}));

// ─── PATCH /api/bons/:id/status — skift status ─────────────────────────────

router.patch('/:id/status', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { status_code, user_id } = req.body;
    if (!status_code) return res.status(400).json({ error: 'status_code er påkrævet' });

    const bon = db.prepare(`SELECT b.id, sd.code as current_code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`).get(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const newStatus = db.prepare(`SELECT id, code FROM status_definitions WHERE code = ?`).get(status_code);
    if (!newStatus) return res.status(400).json({ error: `Ukendt status: ${status_code}` });

    // Tjek at transition er tilladt
    const transition = db.prepare(`
        SELECT st.* FROM status_transitions st
        JOIN status_definitions from_sd ON st.from_status_id = from_sd.id
        JOIN status_definitions to_sd   ON st.to_status_id   = to_sd.id
        WHERE from_sd.code = ? AND to_sd.code = ? AND st.is_active = 1
    `).get(bon.current_code, status_code);

    if (!transition) {
        return res.status(400).json({ error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt` });
    }

    db.prepare(`UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus.id, id);
    logChange({ entityType: 'bon', entityId: id, action: 'status_change', fieldName: 'status_id', oldValue: bon.current_code, newValue: status_code, userId: user_id ?? null });

    broadcast('bon_status', { bon_id: id, old: bon.current_code, new: status_code });

    // Triggers stub — kobles til Grocy/mail senere
    const triggers = transition.triggers_json
        ? JSON.parse(transition.triggers_json)
        : [];

    // Grocy auto-consume ved LEVERET (uafhængigt af triggers_json)
    if (status_code === 'LEVERET') {
        const autoDeduct = db.prepare(`SELECT value FROM settings WHERE key = 'inventory_auto_deduct'`).get();
        if (autoDeduct && autoDeduct.value === '1') {
            const lines = getBonLines(id);
            const { consumeRecipes } = require('../services/grocyAdapter');
            consumeRecipes(lines).then(results => {
                const failed = results.filter(r => !r.success);
                if (failed.length) {
                    console.warn(`[grocy_consume] bon ${id}: ${failed.length} fejl:`, failed);
                } else {
                    console.log(`[grocy_consume] bon ${id}: ${results.length} opskrifter forbrugt fra lager`);
                }
                logChange({ entityType: 'bon', entityId: id, action: 'grocy_consume', fieldName: 'stock', oldValue: null, newValue: JSON.stringify(results) });
            }).catch(err => {
                console.error(`[grocy_consume] bon ${id}: fejl:`, err.message);
            });
        }
    }

    for (const trigger of triggers) {
        if (trigger.action === 'send_mail') {
            console.log(`[trigger] send_mail for bon ${id} — ikke implementeret endnu`);
        }
    }

    res.json({
        id,
        status_code,
        requires_confirmation: transition.requires_confirmation === 1,
        confirmation_message:  transition.confirmation_message,
        triggers
    });
}));

// ─── PATCH /api/bons/:id/prep — opdater prep-checks ────────────────────────

router.patch('/:id/prep', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { ingredients_ready, supplies_ready } = req.body;

    const fields = [];
    const vals   = [];
    if (ingredients_ready !== undefined) { fields.push('prep_ingredients_ready = ?'); vals.push(ingredients_ready ? 1 : 0); }
    if (supplies_ready    !== undefined) { fields.push('prep_supplies_ready = ?');    vals.push(supplies_ready    ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Ingen felter at opdatere' });

    db.prepare(`UPDATE bons SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, id);
    const bon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(id);
    res.json({ id, prep_ingredients_ready: !!bon.prep_ingredients_ready, prep_supplies_ready: !!bon.prep_supplies_ready });
}));

// ─── PATCH /api/bons/:id/kitchen-info ───────────────────────────────────────

router.patch('/:id/kitchen-info', handle((req, res) => {
    const db   = getDb();
    const id   = parseInt(req.params.id);
    const text = req.body.text ?? null;
    const old  = db.prepare(`SELECT kitchen_info FROM bons WHERE id = ?`).get(id);
    if (!old) return res.status(404).json({ error: 'Bon ikke fundet' });
    db.prepare(`UPDATE bons SET kitchen_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(text, id);
    logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'kitchen_info', oldValue: old.kitchen_info, newValue: text, userId: req.body.user_id ?? null });
    res.json({ id, kitchen_info: text });
}));

// ─── BON LINES ──────────────────────────────────────────────────────────────

// POST /api/bons/:id/lines
router.post('/:id/lines', handle((req, res) => {
    const db    = getDb();
    const bonId = parseInt(req.params.id);
    const l     = req.body;
    if (!l.product_name) return res.status(400).json({ error: 'product_name er påkrævet' });

    const bon = db.prepare(`SELECT id FROM bons WHERE id = ?`).get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const qty       = l.quantity ?? 1;
    const unitPrice = l.unit_price ?? null;
    const lineTotal = (unitPrice != null && qty) ? qty * unitPrice : null;

    const maxSort = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) as mx FROM bon_lines WHERE bon_id = ?`).get(bonId).mx;

    const result = db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
            cost_price, unit_price, line_total, sort_order, is_accessory, special_request, co2e, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
        bonId, l.grocy_recipe_id ?? null, l.product_name,
        l.category ?? null, qty, l.unit ?? 'stk',
        l.cost_price ?? null, unitPrice,
        lineTotal, maxSort + 1,
        l.is_accessory ? 1 : 0, l.special_request ?? null,
        l.co2e ?? null, l.notes ?? null
    );

    // Genberegn total_units
    const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);

    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', newValue: `tilføjet: ${qty}x ${l.product_name}`, userId: l.user_id ?? null });
    broadcast('bon_updated', { bon_id: bonId });
    res.status(201).json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(result.lastInsertRowid));
}));

// PUT /api/bons/:id/lines/:lid
router.put('/:id/lines/:lid', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const lineId = parseInt(req.params.lid);
    const l = req.body;

    const allowed = ['product_name', 'category', 'quantity', 'unit', 'cost_price', 'unit_price', 'line_total', 'sort_order', 'is_accessory', 'special_request', 'co2e', 'notes'];
    const updates = Object.entries(l).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'Ingen gyldige felter' });

    const sets = updates.map(([k]) => `${k} = ?`).join(', ');
    const vals = updates.map(([, v]) => v);
    db.prepare(`UPDATE bon_lines SET ${sets} WHERE id = ? AND bon_id = ?`).run(...vals, lineId, bonId);

    const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);

    res.json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
}));

// DELETE /api/bons/:id/lines/:lid
router.delete('/:id/lines/:lid', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const lineId = parseInt(req.params.lid);
    const line = db.prepare(`SELECT product_name, quantity FROM bon_lines WHERE id = ? AND bon_id = ?`).get(lineId, bonId);
    if (!line) return res.status(404).json({ error: 'Linje ikke fundet' });
    db.prepare(`DELETE FROM bon_lines WHERE id = ?`).run(lineId);
    const total = db.prepare(`SELECT COALESCE(SUM(quantity),0) as t FROM bon_lines WHERE bon_id = ? AND (is_accessory = 0 OR is_accessory IS NULL)`).get(bonId).t;
    db.prepare(`UPDATE bons SET total_units = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(total, bonId);
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet' });
    res.json({ deleted: lineId });
}));

// ─── INGREDIENSER (aggregeret fra Grocy) ────────────────────────────────────

router.get('/:id/ingredients', handle(async (req, res) => {
    const bon = getBon(parseInt(req.params.id));
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const recipeLines = (bon.lines || []).filter(l => l.grocy_recipe_id);
    const linesWithoutRecipe = (bon.lines || [])
        .filter(l => !l.grocy_recipe_id && !l.is_accessory)
        .map(l => l.product_name);

    if (recipeLines.length === 0) {
        const empty = { ingredients: [], groups: [], sub_recipes: [] };
        return res.json({
            bon_id: bon.id,
            bon_number: bon.bon_number,
            production: empty,
            raw: empty,
            lines_without_recipe: linesWithoutRecipe,
        });
    }

    const { resolveIngredients } = require('../services/ingredientResolver');
    const { production, raw } = await resolveIngredients(recipeLines);

    res.json({
        bon_id:               bon.id,
        bon_number:           bon.bon_number,
        production,
        raw,
        // Bagudkompatibilitet: ingredients/groups = raw-niveau
        ingredients:          raw.ingredients,
        groups:               raw.groups,
        lines_without_recipe: linesWithoutRecipe,
    });
}));

// ─── CHANGELOG ──────────────────────────────────────────────────────────────

router.get('/:id/changelog', handle((req, res) => {
    const id = parseInt(req.params.id);
    const rows = getDb().prepare(`
        SELECT c.*, u.name as user_name
        FROM changelog c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.entity_type = 'bon' AND c.entity_id = ?
        ORDER BY c.created_at DESC
    `).all(id);
    res.json(rows);
}));

// ─── NOTIFIKATIONER ─────────────────────────────────────────────────────────

router.post('/:id/notifications', handle((req, res) => {
    const db    = getDb();
    const bonId = parseInt(req.params.id);
    const { type, message, priority, sent_by_user_id, client_id } = req.body;
    if (!message) return res.status(400).json({ error: 'message er påkrævet' });

    const result = db.prepare(`
        INSERT INTO notifications (bon_id, type, message, priority, sent_by_user_id)
        VALUES (?,?,?,?,?)
    `).run(bonId, type ?? 'flyver', message, priority ?? 'normal', sent_by_user_id ?? null);

    const notif = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(result.lastInsertRowid);

    logChange({
        entityType: 'bon',
        entityId:   bonId,
        action:     'create',
        fieldName:  'notification',
        newValue:   `flyver: ${message}`,
        userId:     sent_by_user_id ?? null,
        notes:      message,
    });

    // Auto-kvittér for afsender så de ikke ser egen flyver ved reload
    if (client_id) {
        db.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, client_id) VALUES (?, ?)`)
            .run(notif.id, client_id);
    }

    broadcast('notification', { bon_id: bonId, notification: notif, sender_client_id: client_id ?? null });
    res.status(201).json(notif);
}));

router.get('/:id/notifications', handle((req, res) => {
    res.json(getDb().prepare(`SELECT * FROM notifications WHERE bon_id = ? ORDER BY created_at DESC`).all(parseInt(req.params.id)));
}));

// ─── KVITTERING (flyver læst) ──────────────────────────────────────────────

router.post('/:id/notifications/:nid/read', handle((req, res) => {
    const db      = getDb();
    const bonId   = parseInt(req.params.id);
    const notifId = parseInt(req.params.nid);
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id er påkrævet' });

    const notif = db.prepare(`SELECT id FROM notifications WHERE id = ? AND bon_id = ?`).get(notifId, bonId);
    if (!notif) return res.status(404).json({ error: 'Notifikation ikke fundet' });

    db.prepare(`
        INSERT OR IGNORE INTO notification_reads (notification_id, client_id)
        VALUES (?, ?)
    `).run(notifId, client_id);

    res.json({ ok: true });
}));

/* ── BON MAIL ─────────────────────────────────────────────── */

// GET /api/bons/:id/mail — tråde med beskeder
router.get('/:id/mail', handle(async (req, res) => {
    const bonId = parseInt(req.params.id);
    const db = getDb();
    const threads = db.prepare(`
        SELECT * FROM mail_threads WHERE bon_id = ? ORDER BY updated_at DESC
    `).all(bonId);

    for (const t of threads) {
        t.messages = db.prepare(`
            SELECT mm.*,
                   (SELECT json_group_array(json_object('id', ma.id, 'filename', ma.filename, 'mime_type', ma.mime_type, 'size_bytes', ma.size_bytes))
                    FROM mail_attachments ma WHERE ma.message_id = mm.id) as attachments_json
            FROM mail_messages mm WHERE mm.thread_id = ? ORDER BY mm.created_at ASC
        `).all(t.id);
        t.messages.forEach(m => {
            m.attachments = m.attachments_json ? JSON.parse(m.attachments_json) : [];
            delete m.attachments_json;
        });
    }
    res.json({ threads });
}));

// POST /api/bons/:id/mail — send udgående mail
router.post('/:id/mail', handle(async (req, res) => {
    const bonId = parseInt(req.params.id);
    const { to, subject, text, templateKey, inReplyTo } = req.body;
    if (!to || (!text && !templateKey)) {
        return res.status(400).json({ error: 'to og text/templateKey er påkrævet' });
    }

    const db = getDb();
    const bon = db.prepare('SELECT bon_number FROM bons WHERE id = ?').get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const { sendMail, sendFromTemplate } = require('../services/mailService');
    const context = { type: 'bon', number: parseInt(bon.bon_number) };
    const userId = req.session?.user?.id || null;

    let result;
    if (templateKey) {
        const vars = req.body.vars || {};
        result = await sendFromTemplate({ templateKey, to, vars, bonId, context, userId });
    } else {
        result = await sendMail({ to, subject: subject || '', text, bonId, context, inReplyTo, smtpPrefix: 'smtp', userId });
    }

    res.json({ ok: true, messageId: result.messageId, threadId: result.threadId });
}));

// PATCH /api/bons/:id/mail/:msgId/read — marker som læst
router.patch('/:id/mail/:msgId/read', handle(async (req, res) => {
    const bonId = parseInt(req.params.id);
    const msgId = parseInt(req.params.msgId);
    const db = getDb();

    db.prepare('UPDATE mail_messages SET is_read = 1 WHERE id = ?').run(msgId);

    // Count remaining unread
    const unread = db.prepare(`
        SELECT COUNT(*) as n FROM mail_messages mm
        JOIN mail_threads mt ON mm.thread_id = mt.id
        WHERE mt.bon_id = ? AND mm.direction = 'in' AND mm.is_read = 0
    `).get(bonId).n;

    broadcast('bon_updated', { id: bonId, unread_mail_count: unread });

    res.json({ ok: true, unread_mail_count: unread });
}));

module.exports = router;
