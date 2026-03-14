const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getStatusId, getDefaultLocationId, nextBonNumber } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const grocy   = require('../services/grocyAdapter');
const { findConversionFactor, convertAndFormat } = require('../services/quConvert');

// ─── GET /api/bons — liste med filter ────────────────────────────────────────

router.get('/', handle((req, res) => {
    const db = getDb();
    const { status, date, from, to, q, location } = req.query;
    const where = ['1=1'];
    const args  = [];

    if (status)   { where.push('sd.code = ?');          args.push(status); }
    if (date)     { where.push('b.delivery_date = ?');   args.push(date); }
    if (from)     { where.push('b.delivery_date >= ?');  args.push(from); }
    if (to)       { where.push('b.delivery_date <= ?');  args.push(to); }
    if (location) { where.push('l.code = ?');            args.push(location); }
    if (q) {
        where.push('(b.bon_number LIKE ? OR co.name LIKE ? OR c.first_name LIKE ?)');
        args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const rows = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time,
            b.pax, b.total_units, b.delivery_type,
            sd.code AS status_code, sd.label AS status_label, sd.color AS status_color,
            co.name AS company_name,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            l.name AS location_name
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        JOIN   locations l           ON b.location_id = l.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        WHERE ${where.join(' AND ')}
        ORDER BY b.delivery_date DESC, b.pickup_time
        LIMIT 200
    `).all(...args);

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

    for (const trigger of triggers) {
        if (trigger.action === 'grocy_consume') {
            console.log(`[trigger] grocy_consume for bon ${id} — ikke implementeret endnu`);
        }
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
        return res.json({
            bon_id: bon.id,
            bon_number: bon.bon_number,
            ingredients: [],
            groups: [],
            lines_without_recipe: linesWithoutRecipe,
        });
    }

    // Hent recipes for unit_number
    const recipes = await grocy.getRecipes();
    const recipeMap = new Map(recipes.map(r => [r.id, r]));

    // Hent ALT parallelt (som recipe-viewer gør)
    const uniqueRecipeIds = [...new Set(recipeLines.map(l => l.grocy_recipe_id))];
    const [ingredientsByRecipe, stockArr, products, quantityUnits, quConversions] = await Promise.all([
        Promise.all(uniqueRecipeIds.map(async id => ({ id, items: await grocy.getRecipeIngredients(id) }))),
        grocy.getStock(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]);

    // Lookup-maps
    const ingMap = new Map(ingredientsByRecipe.map(r => [r.id, r.items]));
    const stockMap = {};            // product_id → stock amount (i stock-unit)
    stockArr.forEach(s => { stockMap[s.product_id] = parseFloat(s.amount) || 0; });
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(quantityUnits.map(u => [u.id, u]));

    // Aggregér ingredienser: key = product_id
    // recipes_pos.amount er i STOCK-unit (qu_id_stock)
    // recipes_pos.qu_id er DISPLAY-unit (den enhed opskriften viser, fx Gram)
    // Lagersammenligning sker i stock-units; visning konverteres stock → display
    const aggregated = new Map();

    for (const line of recipeLines) {
        const recipe = recipeMap.get(line.grocy_recipe_id);
        const unitNumber = recipe ? recipe.unit_number : 1;
        const scaleFactor = line.quantity / unitNumber;
        const ings = ingMap.get(line.grocy_recipe_id) || [];

        for (const ing of ings) {
            const pid = ing.product_id;
            const baseAmount = parseFloat(ing.amount) || 0;    // i stock-unit
            const scaledStock = baseAmount * scaleFactor;       // behov i stock-unit

            if (aggregated.has(pid)) {
                aggregated.get(pid).needed_stock += scaledStock;
            } else {
                const product = productMap.get(pid) || {};
                aggregated.set(pid, {
                    product_id:       pid,
                    product_name:     product.name || `Produkt #${pid}`,
                    needed_stock:     scaledStock,              // i stock-unit
                    qu_id_stock:      product.qu_id_stock,      // produktets lager-unit
                    qu_id_purchase:   product.qu_id_purchase,    // indkøbs-enhed
                    qu_id_display:    ing.qu_id,                // opskriftens display-unit
                    ingredient_group: ing.ingredient_group || '',
                });
            }
        }
    }

    // Konvertér til display-units og klassificér
    const ingredients = [...aggregated.values()].map(ing => {
        const stockAmount = stockMap[ing.product_id] || 0;  // i stock-unit

        // Status baseret på stock-units (begge i samme enhed)
        let status;
        if (stockAmount >= ing.needed_stock)       status = 'ok';
        else if (stockAmount > 0)                  status = 'lav';
        else                                       status = 'mangler';

        // Konvertér behov + lager til display-unit med auto-format
        const convOpts = { productId: ing.product_id, fromQuId: ing.qu_id_stock, toQuId: ing.qu_id_display, conversions: quConversions, unitMap };
        const fmtNeeded = convertAndFormat(ing.needed_stock, convOpts);
        const fmtStock  = convertAndFormat(stockAmount, convOpts);

        // Shortfall → purchase-unit for indkøbsliste
        const shortfallStock = Math.max(0, ing.needed_stock - stockAmount);
        let shortfallPurchase = shortfallStock;
        let purchaseUnitName = '';

        if (ing.qu_id_purchase && ing.qu_id_purchase !== ing.qu_id_stock) {
            const toPurchaseFactor = findConversionFactor(
                quConversions, ing.product_id, ing.qu_id_stock, ing.qu_id_purchase
            );
            if (toPurchaseFactor !== null) shortfallPurchase = shortfallStock * toPurchaseFactor;
            const puUnit = unitMap.get(ing.qu_id_purchase);
            purchaseUnitName = puUnit ? (puUnit.name_short || puUnit.name || '') : '';
        } else {
            const stUnit = unitMap.get(ing.qu_id_stock);
            purchaseUnitName = stUnit ? (stUnit.name_short || stUnit.name || '') : '';
        }

        return {
            product_id:       ing.product_id,
            product_name:     ing.product_name,
            amount_needed:    fmtNeeded.amount,
            amount_stock:     fmtStock.amount,
            unit:             fmtNeeded.unit,
            stock_unit:       fmtStock.unit,
            status,
            ingredient_group: ing.ingredient_group,
            // Til shopping-list: shortfall i purchase-units (afrundet op)
            shortfall_purchase: Math.ceil(shortfallPurchase * 100) / 100,
            purchase_unit:      purchaseUnitName,
        };
    });

    // Byg grupperet struktur
    const groupsMap = {};
    for (const ing of ingredients) {
        const g = ing.ingredient_group || '';
        if (!groupsMap[g]) groupsMap[g] = [];
        groupsMap[g].push(ing);
    }

    // Sortér grupper: tom først, derefter alfabetisk, 'emballage' sidst
    const groupNames = Object.keys(groupsMap).sort((a, b) => {
        const aLow = a.toLowerCase(), bLow = b.toLowerCase();
        if (aLow === 'emballage') return 1;
        if (bLow === 'emballage') return -1;
        if (a === '') return -1;
        if (b === '') return 1;
        return a.localeCompare(b, 'da');
    });

    // Sortér ingredienser inden for gruppe: mangler → lav → ok, derefter navn
    const statusOrder = { mangler: 0, lav: 1, ok: 2 };
    const groups = groupNames.map(name => ({
        name,
        ingredients: groupsMap[name].sort((a, b) =>
            (statusOrder[a.status] - statusOrder[b.status]) ||
            a.product_name.localeCompare(b.product_name, 'da')
        ),
    }));

    res.json({
        bon_id:               bon.id,
        bon_number:           bon.bon_number,
        ingredients,
        groups,
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

module.exports = router;
