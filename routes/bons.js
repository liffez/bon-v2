const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getBonMenuGroups, getStatusId, getDefaultLocationId, todayISO, nextBonNumber, computeMomsFields, recalcBonTotalUnits, transaction, autoConsumeBonInventory } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const grocy   = require('../services/grocyAdapter');
const { syncCashflowInvoice } = require('../services/cashflowSync');
// quConvert bruges nu via services/ingredientResolver.js

/**
 * recalcBonTotal — server-autoritativ recalc af bon-total fra bon_lines.
 *
 * Skriver til både total_price og total_with_delivery (delivery_price
 * tilføjes hvis sat). Frontenden sender ALDRIG total_price i POST/PATCH
 * — alt går gennem denne funktion.
 *
 * UNDTAGELSE — POS/Zettle (planlagt, ikke bygget pr. maj 2026):
 * Når POS-stien bygges (routes/pos.js eller webhook fra Zettle), skal
 * dén sandsynligvis SKIPPE recalc og diktere total_price direkte fra
 * Zettle-kvitteringen — Zettle er den eksterne sandhedskilde, ikke os.
 *
 * Mønster:
 *   if (payment_type !== 'pos') recalcBonTotal(db, bonId);
 *
 * Ref: docs/Grocy audit/KENDTE_DATABUGS.md — moms-refaktorering, Commit 3 (1. maj 2026)
 *      verificerede at ingen eksisterende sti sender total_price.
 *
 * Quick-fix (Del 5.5 i CLAUDE_TILBUD_PRIS.md): hvis bonnen har en x-Levering-linje
 * (migreret fra Bon v1), bruges DEN som leverings-bidrag og bons.delivery_price
 * ignoreres så vi ikke dobbelttæller. Logger til changelog hvis totalen ændrer sig.
 */
function recalcBonTotal(db, bonId, opts = {}) {
    const bon = db.prepare('SELECT total_price, total_with_delivery, delivery_price, offer_discount_percent FROM bons WHERE id = ?').get(bonId);
    if (!bon) return null;
    const lines = db.prepare('SELECT line_total, category FROM bon_lines WHERE bon_id = ?').all(bonId);
    const hasLeveringLine = lines.some(l => l.category === 'x-Levering');
    const linesSum = lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const deliveryAdd = hasLeveringLine ? 0 : (bon.delivery_price ?? 0);
    const subtotal = linesSum + deliveryAdd;
    const discount = bon.offer_discount_percent ? subtotal * (bon.offer_discount_percent / 100) : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;

    db.prepare('UPDATE bons SET total_price = ?, total_with_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(total, total, bonId);

    // Log spor hvis totalen rykker mere end 1 kr — synligt for brugeren der åbner bonnen senere
    if (opts.logIfChanged && bon.total_price != null && Math.abs((bon.total_price ?? 0) - total) > 1) {
        logChange({
            entityType: 'bon', entityId: bonId,
            action: 'update', fieldName: 'total_price',
            oldValue: bon.total_price, newValue: total,
            notes: 'Auto-recalc',
            userId: opts.userId ?? null,
        });
    }
    return total;
}

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
    const { status, date, date_from, date_to, q, location, unread_mail, sort, dir, limit, offset, company_id, customer_id } = req.query;
    const where = ['(b.is_offer = 0 OR b.is_offer IS NULL)'];
    const args  = [];

    // Firma- og kunde-filter (bruges af Firma 360°/Kunde 360° aggregerede views)
    if (company_id) {
        where.push('b.company_id = ?');
        args.push(parseInt(company_id, 10));
    }
    if (customer_id) {
        where.push('b.customer_id = ?');
        args.push(parseInt(customer_id, 10));
    }

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
        const d = date === 'today' ? todayISO() : date;
        where.push('b.delivery_date = ?');
        args.push(d);
    }
    if (date_from) { where.push('b.delivery_date >= ?'); args.push(date_from); }
    if (date_to)   { where.push('b.delivery_date <= ?'); args.push(date_to); }

    if (location) { where.push('l.code = ?'); args.push(location); }

    // Søgning — bonnumre er præcis 4 cifre:
    //   • ≤ 4 cifre  → prefix-match på bon_number (1, 33, 338, 3387)
    //   • > 4 cifre  → telefon (kan ikke være bonnummer)
    //   • bogstaver  → kunde- og firma-navn (LIKE %q%)
    if (q) {
        const isDigits = /^\d+$/.test(q);
        if (isDigits && q.length <= 4) {
            where.push('(b.bon_number LIKE ?)');
            args.push(`${q}%`);
        } else if (isDigits) {
            where.push('(c.phone LIKE ?)');
            args.push(`%${q}%`);
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
            ) AS latest_delivery_event_time,
            (SELECT cl.created_at FROM changelog cl
             WHERE cl.entity_type = 'bon' AND cl.entity_id = b.id
               AND cl.action = 'status_change'
             ORDER BY cl.created_at DESC LIMIT 1
            ) AS latest_status_change_time,
            (SELECT COUNT(*) FROM entity_flags ef
             WHERE ef.dismissed_at IS NULL
               AND (
                   (ef.entity_type = 'customer' AND ef.entity_id = b.customer_id) OR
                   (ef.entity_type = 'company'  AND ef.entity_id = b.company_id)
               )
            ) AS flag_count,
            CASE WHEN b.acknowledged_at IS NULL
                   AND EXISTS (SELECT 1 FROM web_orders wo WHERE wo.bon_id = b.id)
                 THEN 1 ELSE 0 END AS is_unconfirmed_web
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

    // Tilføj pre-beregnede moms-felter på hver række (frontends må aldrig regne selv)
    const decorated = rows.map(r => ({ ...r, ...computeMomsFields(r.total_price) }));
    res.json(decorated);
}));

// ─── GET /api/bons/new — Nye-listen (mobile) ───────────────────────────────
//
// "Nye" er en pending-inbox, ikke et tidsbaseret feed (beslutning 12,
// 14. maj 2026). Den viser kun arbejde der endnu ikke er håndteret:
//   • new_bon     → bons.status_code = 'NY' (ikke yet handled)
//   • unread_mail → mail_messages.is_read=0 AND direction='in'
//
// Når en bons status ændres (NY → GODKENDT, VENTER_INFO osv.), forsvinder
// den fra Nye-listen automatisk. Mails forsvinder når nogen markerer dem
// som læst i office (eller andetsteds).
//
// Mail-filteret beholder en 7-dages tærskel på received_at for at undgå
// at v1-migrerede gamle ulæste mails fylder feedet.
//
// Source ('web' / 'manual') bestemmes ved JOIN mod web_orders.bon_id.
//
// ?count_only=1   → return { count: N } — hurtigt badge-load
// ?limit=30&offset=0
//
// MÅ stå før /:id-routen — ellers fanger Express 'new' som id.

function _mailPreview(text) {
    if (!text) return '';
    // Klip ved første quoted-line eller signatur-separator
    let cut = text;
    const quotedIdx = cut.search(/\n>/);
    if (quotedIdx > 0) cut = cut.slice(0, quotedIdx);
    const sigIdx = cut.search(/\n--\s*\n/);
    if (sigIdx > 0) cut = cut.slice(0, sigIdx);
    cut = cut.replace(/\s+/g, ' ').trim();
    if (cut.length > 140) cut = cut.slice(0, 137) + '…';
    return cut;
}

router.get('/new', handle((req, res) => {
    const db = getDb();
    const userId = req.session?.userId ?? null;
    if (!userId) return res.status(401).json({ error: 'Ikke logget ind' });

    // 7-dages cap på mails — beskytter mod v1-migrerede gamle mails der
    // aldrig blev markeret som læst.
    const mailFloor = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    // count_only — hurtig badge-load
    if (req.query.count_only === '1') {
        const newBonCount = db.prepare(`
            SELECT COUNT(*) AS n
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            WHERE sd.code = 'NY' AND (b.is_offer = 0 OR b.is_offer IS NULL)
        `).get().n;
        const mailCount = db.prepare(`
            SELECT COUNT(*) AS n
            FROM mail_messages mm
            JOIN mail_threads mt ON mm.thread_id = mt.id
            WHERE mm.direction = 'in' AND mm.is_read = 0
              AND mt.bon_id IS NOT NULL
              AND mm.received_at > ?
        `).get(mailFloor).n;
        return res.json({ count: newBonCount + mailCount, last_seen_at: null });
    }

    const limit  = Math.min(parseInt(req.query.limit)  || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    // Hent flere end limit fra hver side, merge i JS, slice til limit+offset.
    const fetchSize = limit + offset + 30;  // buffer til offset

    // Pending bons: status NY (ikke handlet endnu)
    const newBons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.created_at AS event_at,
            b.delivery_date, b.delivery_time,
            b.pax, b.status_id,
            sd.code AS status_code, sd.label AS status_label, sd.color AS status_color,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            co.name AS company_name,
            (SELECT 1 FROM web_orders wo WHERE wo.bon_id = b.id LIMIT 1) AS is_web
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE sd.code = 'NY'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY b.created_at DESC
        LIMIT ?
    `).all(fetchSize);

    // Ulæste indkommende mails knyttet til bons (alle bon-statusser — også
    // mails på handlede bons skal kunne ses, så ingen status-filter her)
    const unreadMails = db.prepare(`
        SELECT
            mm.id AS mail_id, mt.bon_id, mm.subject, mm.body_text, mm.from_email,
            mm.received_at AS event_at,
            b.bon_number, b.delivery_date, b.delivery_time, b.pax,
            sd.code AS status_code, sd.label AS status_label, sd.color AS status_color,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            co.name AS company_name
        FROM mail_messages mm
        JOIN mail_threads mt ON mm.thread_id = mt.id
        JOIN bons b ON mt.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE mm.direction = 'in' AND mm.is_read = 0
          AND mm.received_at > ?
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY mm.received_at DESC
        LIMIT ?
    `).all(mailFloor, fetchSize);

    const events = [];
    for (const b of newBons) {
        events.push({
            event_type: 'new_bon',
            event_at:   b.event_at,
            seen:       false,  // alle status=NY bons er per definition pending
            bon: {
                id: b.id, bon_number: b.bon_number,
                contact_name_full: b.contact_name_full || null,
                company_name: b.company_name,
                delivery_date: b.delivery_date,
                delivery_time: b.delivery_time,
                pax: b.pax,
                status_code: b.status_code,
                status_label: b.status_label,
                status_color: b.status_color,
                source: b.is_web ? 'web' : 'manual',
            },
        });
    }
    for (const m of unreadMails) {
        events.push({
            event_type: 'unread_mail',
            event_at:   m.event_at,
            seen:       false,  // is_read=0 betyder altid uset
            bon: {
                id: m.bon_id, bon_number: m.bon_number,
                contact_name_full: m.contact_name_full || null,
                company_name: m.company_name,
                delivery_date: m.delivery_date,
                delivery_time: m.delivery_time,
                pax: m.pax,
                status_code: m.status_code,
                status_label: m.status_label,
                status_color: m.status_color,
            },
            mail: {
                id: m.mail_id,
                subject: m.subject,
                preview: _mailPreview(m.body_text),
                from_address: m.from_email,
            },
        });
    }

    // Sortér samlet ned ad event_at, slice til paginering
    events.sort((a, b) => (b.event_at || '').localeCompare(a.event_at || ''));
    const total = events.length;
    const page  = events.slice(offset, offset + limit);

    res.json({
        last_seen_at: null,  // ikke længere brugt i status-NY modellen
        count: total,
        has_more: total > offset + limit,
        events: page,
    });
}));

// ─── POST /api/bons/mark-all-seen ───────────────────────────────────────────
// No-op i status-NY-modellen (beslutning 12, 14. maj 2026). Items forsvinder
// kun fra Nye-listen ved reel handling — bons skal have deres status ændret,
// mails skal markeres læst. Endpointet er bevaret for bagudkompatibilitet
// med cachede klient-builds.

router.post('/mark-all-seen', handle((req, res) => {
    const userId = req.session?.userId ?? null;
    if (!userId) return res.status(401).json({ error: 'Ikke logget ind' });
    res.json({ ok: true });
}));

// ─── POST /api/bons/:id/mark-seen ──────────────────────────────────────────
// No-op endpoint bevaret for bagudkompatibilitet med klient-builds før 14. maj.
//
// Tidligere advancede dette endpoint last_seen_at (for new_bon) og satte
// is_read=1 (for unread_mail) baseret på IntersectionObserver-feedback fra
// mobilen. Det viste sig at have to problemer:
//   1) MAX-update på last_seen_at gjorde at scrolling forbi ÉN ny bon
//      filtrerede ALLE ældre uset bons væk på næste fetch.
//   2) Auto-is_read påvirkede office's "Ulæst mail"-filtre (cross-user).
//
// Ny model (beslutning 11, 14. maj 2026): Auto-mark er rent visuel feedback
// på klient-siden (CSS-fade på den røde kant). Persistent dismissal sker
// KUN via /mark-all-seen — det er den eksplicitte "jeg er færdig"-handling.

router.post('/:id/mark-seen', handle((req, res) => {
    const userId = req.session?.userId ?? null;
    if (!userId) return res.status(401).json({ error: 'Ikke logget ind' });
    res.json({ ok: true });
}));

// ─── GET /api/bons/:id ──────────────────────────────────────────────────────

router.get('/:id', handle((req, res) => {
    const bon = getBon(parseInt(req.params.id));
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    // Aktive flag på kunden og/eller firmaet (jf. docs/CLAUDE_KUNDE_FLAGS.md).
    // acked_on_this_bon afgør om "Set"/"Gjort"-knapper stadig skal vises i drawer.
    bon.flags = [];
    if (bon.customer_id || bon.company_id) {
        const conds = [];
        const args  = [bon.id];   // første ? er til EXISTS-subquery
        if (bon.customer_id) {
            conds.push("(f.entity_type = 'customer' AND f.entity_id = ?)");
            args.push(bon.customer_id);
        }
        if (bon.company_id) {
            conds.push("(f.entity_type = 'company' AND f.entity_id = ?)");
            args.push(bon.company_id);
        }
        bon.flags = getDb().prepare(`
            SELECT f.id, f.entity_type, f.entity_id, f.title, f.body, f.created_at,
                   u.name AS created_by_name,
                   EXISTS(SELECT 1 FROM flag_acks
                          WHERE flag_id = f.id AND bon_id = ?) AS acked_on_this_bon
            FROM entity_flags f
            LEFT JOIN users u ON f.created_by_user_id = u.id
            WHERE f.dismissed_at IS NULL AND (${conds.join(' OR ')})
            ORDER BY f.created_at DESC
        `).all(...args);
    }

    res.json({ ...bon, ...computeMomsFields(bon.total_price) });
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
            created_by_user_id, is_internal
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
            ?,?
        )
    `).run(
        bonNumber, statusId, locationId,
        b.customer_id ?? null, b.company_id ?? null, b.price_category_id ?? null,
        b.order_date ?? todayISO(),
        b.delivery_date, b.pickup_time ?? null, b.delivery_time ?? null,
        b.delivery_type ?? 'delivery', b.delivery_method ?? null, b.delivery_address_id ?? null,
        b.delivery_notes ?? null, b.delivery_cost ?? null, b.delivery_price ?? null,
        b.courier_arrival_time ?? null, b.courier_provider ?? null,
        b.pax ?? 0, b.total_units ?? 0, b.boxes ?? null,
        // total_price + total_with_delivery sættes altid af serveren via recalcBonTotal nedenfor —
        // klienten må ikke diktere totalen.
        0, 0,
        b.payment_type ?? null, b.kitchen_selects ? 1 : 0, b.customer_collects ? 1 : 0,
        b.kitchen_info ?? null, b.customer_wishes ?? null,
        b.internal_notes ?? null, b.invoice_info ?? null,
        0, 0,
        b.created_by_user_id ?? null, b.is_internal ? 1 : 0
    );

    logChange({ entityType: 'bon', entityId: result.lastInsertRowid, action: 'create', newValue: bonNumber, userId: b.created_by_user_id });
    // Server-autoritativ recalc (linjer kan være indsat i samme request via /lines, men typisk ingen endnu)
    // POS-undtagelse: se kommentar over recalcBonTotal-definitionen
    recalcBonTotal(getDb(), result.lastInsertRowid);
    const newBon = getBon(result.lastInsertRowid);
    broadcast('bon_created', { id: newBon.id, bon_number: newBon.bon_number });
    res.status(201).json(newBon);
}));

// ─── POST /api/bons/:id/copy — kopiér bon til ny bon med status NY ──────────
//
// Kopierer alle relevante felter (kunde, levering, mængder, noter), bon_lines
// og menu-grupper. Nulstiller workflow-felter (status, prep, lager-træk,
// kvitteret, courier-booking, tilbuds-flag, v1-sync). Body kan optionelt
// overskrive delivery_date/pickup_time/delivery_time (typisk brugscase).

router.post('/:id/copy', handle((req, res) => {
    const db = getDb();
    const sourceId = parseInt(req.params.id);
    const body = req.body || {};

    const src = db.prepare(`SELECT * FROM bons WHERE id = ?`).get(sourceId);
    if (!src) return res.status(404).json({ error: 'Bon ikke fundet' });

    const srcLines = db.prepare(`SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order`).all(sourceId);
    const srcGroups = db.prepare(`SELECT * FROM bon_menu_groups WHERE bon_id = ? ORDER BY sort_order`).all(sourceId);

    const userId = req.session?.userId ?? body.user_id ?? null;
    const today = todayISO();

    // Allokeres uden for transaction-blokken — nextBonNumber() har sin egen
    // transaction og kan ikke nestes (SQLite tillader ikke nested transactions).
    const bonNumber = nextBonNumber();
    const statusId  = getStatusId('NY');

    const newBonId = transaction(db, () => {

        const ins = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, customer_id, company_id, price_category_id,
                order_date, delivery_date, pickup_time, delivery_time,
                delivery_type, delivery_method, delivery_address_id,
                delivery_notes, delivery_price,
                pax, total_units, boxes,
                payment_type, kitchen_selects, customer_collects,
                kitchen_info, customer_wishes, internal_notes, invoice_info,
                day_contact_name, day_contact_phone,
                created_by_user_id, is_internal
            ) VALUES (
                ?,?,?,?,?,?,
                ?,?,?,?,
                ?,?,?,
                ?,?,
                ?,?,?,
                ?,?,?,
                ?,?,?,?,
                ?,?,
                ?,?
            )
        `).run(
            bonNumber, statusId, src.location_id,
            src.customer_id, src.company_id, src.price_category_id,
            today,
            body.delivery_date ?? src.delivery_date,
            body.pickup_time ?? src.pickup_time,
            body.delivery_time ?? src.delivery_time,
            src.delivery_type, src.delivery_method, src.delivery_address_id,
            src.delivery_notes, src.delivery_price,
            src.pax, src.total_units, src.boxes,
            src.payment_type, src.kitchen_selects, src.customer_collects,
            src.kitchen_info, src.customer_wishes, src.internal_notes, src.invoice_info,
            src.day_contact_name, src.day_contact_phone,
            userId, src.is_internal
        );
        const newId = ins.lastInsertRowid;

        // Mapping fra gamle gruppe-IDs til nye, så linje-FK bevares
        const groupMap = new Map();
        for (const g of srcGroups) {
            const gr = db.prepare(`
                INSERT INTO bon_menu_groups (bon_id, title, note, sort_order)
                VALUES (?,?,?,?)
            `).run(newId, g.title, g.note, g.sort_order);
            groupMap.set(g.id, gr.lastInsertRowid);
        }

        for (const l of srcLines) {
            const newGroupId = l.menu_group_id ? (groupMap.get(l.menu_group_id) ?? null) : null;
            db.prepare(`
                INSERT INTO bon_lines (
                    bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                    cost_price, unit_price, line_total, sort_order, is_accessory,
                    special_request, co2e, pos_product_id, notes, block_type, menu_group_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
                newId, l.grocy_recipe_id, l.product_name, l.category, l.quantity, l.unit,
                l.cost_price, l.unit_price, l.line_total, l.sort_order, l.is_accessory,
                l.special_request, l.co2e, l.pos_product_id, l.notes, l.block_type, newGroupId
            );
        }

        recalcBonTotalUnits(db, newId);
        recalcBonTotal(db, newId);

        return newId;
    });

    const newBon = getBon(newBonId);
    logChange({
        entityType: 'bon',
        entityId: newBonId,
        action: 'create',
        newValue: newBon.bon_number,
        notes: `kopieret fra bon ${src.bon_number}`,
        userId
    });
    broadcast('bon_created', { id: newBon.id, bon_number: newBon.bon_number, copied_from: src.bon_number });
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
        'day_contact_name', 'day_contact_phone',
        'is_internal'
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
    if ('is_internal' in updates) updates.is_internal = updates.is_internal ? 1 : 0;

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

    // Hvis felter der påvirker totalen er ændret → recalc server-autoritativt
    if ('delivery_price' in updates) {
        recalcBonTotal(db, id, { logIfChanged: true, userId: req.session?.userId ?? null });
    }

    // Cashflow-sync hvis felter der påvirker auto-genereret cf_invoice er ændret.
    // invoice_info kan indeholde "Fakturanr: ..." der bliver til cf_invoice.id.
    // payment_type-skift fra invoice → andet sletter cf_invoice (hvis ikke betalt).
    // delivery_date/_price ændrer forfald og beløb.
    const CF_RELEVANT = ['invoice_info', 'payment_type', 'delivery_date', 'delivery_price'];
    if (CF_RELEVANT.some(f => f in updates)) {
        try {
            syncCashflowInvoice(db, id);
        } catch (err) {
            console.error(`[cashflow] sync failed for bon ${id}:`, err.message);
        }
    }

    broadcast('bon_updated', { id });
    res.json({ ok: true });
}));

// ─── PATCH /api/bons/:id/status — skift status ─────────────────────────────

router.patch('/:id/status', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { status_code, user_id, force } = req.body;
    if (!status_code) return res.status(400).json({ error: 'status_code er påkrævet' });

    const bon = db.prepare(`SELECT b.id, sd.code as current_code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?`).get(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const newStatus = db.prepare(`SELECT id, code FROM status_definitions WHERE code = ?`).get(status_code);
    if (!newStatus) return res.status(400).json({ error: `Ukendt status: ${status_code}` });

    // Patch D: force-mode. Rolle-tjek mod SESSION (ikke body) for at undgå
    // privilege escalation. Også audit-user-id kommer fra session — body.user_id
    // accepteres ikke til auth eller audit (D-2b fix).
    const isForce = force === true;
    let isAdmin = false;
    const sessionUserId = req.session?.userId ?? null;
    if (isForce) {
        if (!sessionUserId) {
            return res.status(401).json({ error: 'Force-mode kræver login' });
        }
        const sessionUser = db.prepare(
            `SELECT role FROM users WHERE id = ? AND is_active = 1`
        ).get(sessionUserId);
        if (!sessionUser) {
            return res.status(401).json({ error: 'Session-bruger ikke gyldig' });
        }
        if (sessionUser.role !== 'admin') {
            return res.status(403).json({ error: 'Force-mode kræver admin-rolle' });
        }
        isAdmin = true;
    }

    // Slå transition op (uanset force-mode — vi bruger triggers_json længere nede).
    // Hvis transition ikke findes OG vi ikke har force+admin, afvises requesten.
    const transition = db.prepare(`
        SELECT st.* FROM status_transitions st
        JOIN status_definitions from_sd ON st.from_status_id = from_sd.id
        JOIN status_definitions to_sd   ON st.to_status_id   = to_sd.id
        WHERE from_sd.code = ? AND to_sd.code = ? AND st.is_active = 1
    `).get(bon.current_code, status_code);

    if (!transition && !(isForce && isAdmin)) {
        return res.status(400).json({
            error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt`,
            hint: 'Admins kan overstyre med {force: true}'
        });
    }

    db.prepare(`UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus.id, id);
    // Audit-user-id:
    //   - Force-mode: ALTID session.userId (kan ikke falsificeres via body)
    //   - Ikke-force: behold eksisterende mønster (body.user_id eller null) —
    //     endpointet er stadig uautentificeret for ikke-force-flow, så kitchen-
    //     tablets der sender user_id i body får audit-værdien som hidtil.
    const auditUserId = (isForce && isAdmin)
        ? sessionUserId
        : (user_id ?? sessionUserId ?? null);
    logChange({
        entityType: 'bon',
        entityId: id,
        action: 'status_change',
        fieldName: 'status_id',
        oldValue: bon.current_code,
        newValue: status_code,
        userId: auditUserId,
        wasForced: isForce && isAdmin
    });

    broadcast('bon_status', { id, old: bon.current_code, new: status_code });

    // Triggers stub — kobles til Grocy/mail senere.
    // transition kan være null hvis force-mode overstyrede en ikke-eksisterende
    // transition; i så fald har vi ingen triggers at køre.
    const triggers = transition?.triggers_json
        ? JSON.parse(transition.triggers_json)
        : [];

    // Grocy auto-consume ved LEVERET (uafhængigt af triggers_json).
    // Idempotent via bons.inventory_deducted — T_INV_IDEM_01 verificerer adfærden.
    if (status_code === 'LEVERET') {
        autoConsumeBonInventory(id);
    }

    // Cashflow-sync: opret/opdater/slet cf_invoice afhængigt af status.
    // Helperen er idempotent og no-op for ikke-faktura-bons (POS, tilbud, interne).
    // Fejl må ikke afbryde status-skift — log og fortsæt.
    try {
        syncCashflowInvoice(db, id);
    } catch (err) {
        console.error(`[cashflow] sync failed for bon ${id}:`, err.message);
    }

    for (const trigger of triggers) {
        if (trigger.action === 'send_mail') {
            console.log(`[trigger] send_mail for bon ${id} — ikke implementeret endnu`);
        }
    }

    res.json({
        id,
        status_code,
        // transition kan være null hvis force-mode overstyrede en ikke-eksisterende
        // transition (Patch D). Fallback til false/null for kompatibilitet.
        requires_confirmation: transition?.requires_confirmation === 1,
        confirmation_message:  transition?.confirmation_message ?? null,
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

// PATCH /api/bons/:id/acknowledge — marker en bon (typisk web-bestilling)
// som "set af menneske" uden at ændre status_id. Bruges af #042's
// "Nye bestillinger"-side så listen kan ryddes uden at flytte status.
router.patch('/:id/acknowledge', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const undo = req.body?.undo === true || req.body?.undo === 'true';

    const old = db.prepare('SELECT acknowledged_at FROM bons WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ error: 'Bon ikke fundet' });

    if (undo) {
        db.prepare('UPDATE bons SET acknowledged_at = NULL, acknowledged_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'acknowledged_at', oldValue: old.acknowledged_at, newValue: null, userId });
    } else {
        if (old.acknowledged_at) return res.json({ id, acknowledged_at: old.acknowledged_at, already: true });
        db.prepare(`UPDATE bons SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId, id);
        const fresh = db.prepare('SELECT acknowledged_at FROM bons WHERE id = ?').get(id);
        logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'acknowledged_at', oldValue: null, newValue: fresh.acknowledged_at, userId });
    }

    const fresh = db.prepare('SELECT acknowledged_at, acknowledged_by_user_id FROM bons WHERE id = ?').get(id);
    broadcast('bon_updated', { id });
    res.json({ id, ...fresh });
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
    // line_total beregnes altid af serveren — klientens værdi ignoreres
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

    // Genberegn total_units (kun kategorier i settings.unit_count_categories)
    recalcBonTotalUnits(db, bonId);

    // Server-autoritativ recalc af total_price (incl. moms)
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: l.user_id ?? null });

    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', newValue: `tilføjet: ${qty}x ${l.product_name}`, userId: l.user_id ?? null });
    broadcast('bon_updated', { id: bonId });
    res.status(201).json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(result.lastInsertRowid));
}));

// PUT /api/bons/:id/lines/:lid
router.put('/:id/lines/:lid', handle((req, res) => {
    const db     = getDb();
    const bonId  = parseInt(req.params.id);
    const lineId = parseInt(req.params.lid);
    const l = req.body;

    // line_total fjernet fra allowed — beregnes altid af serveren ud fra quantity × unit_price
    const allowed = ['product_name', 'category', 'quantity', 'unit', 'cost_price', 'unit_price', 'sort_order', 'is_accessory', 'special_request', 'co2e', 'notes'];
    const updates = Object.entries(l).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'Ingen gyldige felter' });

    const sets = updates.map(([k]) => `${k} = ?`).join(', ');
    const vals = updates.map(([, v]) => v);
    db.prepare(`UPDATE bon_lines SET ${sets} WHERE id = ? AND bon_id = ?`).run(...vals, lineId, bonId);

    // Genberegn line_total ud fra de aktuelle værdier (server-autoritativ)
    const cur = db.prepare(`SELECT quantity, unit_price FROM bon_lines WHERE id = ? AND bon_id = ?`).get(lineId, bonId);
    if (cur) {
        const newLineTotal = (cur.unit_price != null && cur.quantity != null) ? cur.quantity * cur.unit_price : null;
        db.prepare(`UPDATE bon_lines SET line_total = ? WHERE id = ?`).run(newLineTotal, lineId);
    }

    recalcBonTotalUnits(db, bonId);

    // Server-autoritativ recalc af bons.total_price
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });

    // Patch F (F57): tilføj manglende broadcast på PUT lines
    broadcast('bon_updated', { id: bonId });
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
    recalcBonTotalUnits(db, bonId);
    // Server-autoritativ recalc af bons.total_price
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet' });
    // Patch F (F58): tilføj manglende broadcast på DELETE lines
    broadcast('bon_updated', { id: bonId });
    res.json({ deleted: lineId });
}));

// PUT /api/bons/:id/menu-groups — reconcilér menu-gruppering på køkken-bonen.
// Body: { groups: [{ title, note, line_ids: [] }, ...] }
// Frontenden sender den fulde struktur; serveren sletter alle grupper for
// bonen og genskaber dem fra payloadet. Idempotent. Tomme grupper droppes.
router.put('/:id/menu-groups', handle((req, res) => {
    const db    = getDb();
    const bonId = parseInt(req.params.id);
    const bon   = db.prepare(`SELECT id FROM bons WHERE id = ?`).get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const groups = Array.isArray(req.body.groups) ? req.body.groups : [];

    transaction(db, () => {
        db.prepare(`UPDATE bon_lines SET menu_group_id = NULL WHERE bon_id = ?`).run(bonId);
        db.prepare(`DELETE FROM bon_menu_groups WHERE bon_id = ?`).run(bonId);

        const insGroup = db.prepare(`INSERT INTO bon_menu_groups (bon_id, title, note, sort_order) VALUES (?,?,?,?)`);
        const setGroup = db.prepare(`UPDATE bon_lines SET menu_group_id = ? WHERE id = ? AND bon_id = ?`);

        groups.forEach((g, idx) => {
            const lineIds = (Array.isArray(g.line_ids) ? g.line_ids : [])
                .map(n => parseInt(n)).filter(Number.isInteger);
            if (!lineIds.length) return;   // tomme grupper persisteres ikke
            const title = (g.title || '').toString().trim().slice(0, 80) || 'Gruppe';
            const note  = (g.note  || '').toString().trim().slice(0, 500) || null;
            const gid = insGroup.run(bonId, title, note, idx).lastInsertRowid;
            lineIds.forEach(lid => setGroup.run(gid, lid, bonId));
        });
    });

    const savedGroups = getBonMenuGroups(bonId);
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'menu_groups',
        newValue: `${savedGroups.length} gruppe(r)`, userId: req.body.user_id ?? req.session?.userId ?? null });
    broadcast('bon_updated', { id: bonId });

    res.json({ menu_groups: savedGroups, lines: getBonLines(bonId) });
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

// ─── PAKKE-OVERRIDES (event-prep §6) ────────────────────────────────────────
// Manuelle justeringer af de råvare-mængder der pakkes/tages med fra HQ.
// Overrider den BOM-beregnede mængde → trækkes fra HQ ved LEVERET.

router.get('/:id/packing', handle((req, res) => {
    const id = parseInt(req.params.id);
    const rows = getDb().prepare(`
        SELECT product_id, product_name, packed_amount, unit
        FROM prep_packing_overrides WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    res.json({ overrides: rows });
}));

router.put('/:id/packing', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const bon = getBon(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });
    // Lås efter lager-træk: en ændring efter LEVERET ville skabe inkonsistens mod
    // Grocy. Vi tjekker BÅDE status (deterministisk + øjeblikkelig ved LEVERET) og
    // inventory_deducted-flaget (async sat efter consume) — status fanger race-vinduet
    // hvor flaget endnu ikke er sat, men consume allerede er i gang.
    const TERMINAL = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];
    if (bon.inventory_deducted === 1 || TERMINAL.includes(bon.status_code)) {
        return res.status(409).json({ error: 'Bonen er allerede leveret — pakke-mængder kan ikke ændres', code: 'ALREADY_DEDUCTED' });
    }
    const items = Array.isArray(req.body?.overrides) ? req.body.overrides : null;
    if (!items) return res.status(400).json({ error: 'overrides (array) er påkrævet' });

    transaction(db, () => {
        db.prepare(`DELETE FROM prep_packing_overrides WHERE bon_id = ?`).run(id);
        const ins = db.prepare(`
            INSERT INTO prep_packing_overrides (bon_id, product_id, product_name, packed_amount, unit, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        for (const it of items) {
            const pid = parseInt(it.product_id);
            const amt = Number(it.packed_amount);
            if (!pid || Number.isNaN(amt) || amt < 0) continue;
            ins.run(id, pid, it.product_name ?? null, amt, it.unit ?? null);
        }
    });
    logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'packing', userId: req.body?.user_id ?? req.session?.userId });
    broadcast('bon_updated', { id });
    const rows = db.prepare(`
        SELECT product_id, product_name, packed_amount, unit
        FROM prep_packing_overrides WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    res.json({ overrides: rows });
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

    broadcast('notification', { id: bonId, notification: notif, sender_client_id: client_id ?? null });
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
                   (SELECT json_group_array(json_object('id', ma.id, 'filename', ma.filename, 'mime_type', ma.mime_type, 'size_bytes', ma.size_bytes, 'content_id', ma.content_id, 'is_inline', ma.is_inline))
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

// POST /api/bons/:id/mail — send udgående mail (med valgfri vedhæftninger)
router.post('/:id/mail', handle(async (req, res) => {
    const bonId = parseInt(req.params.id);
    const { to, subject, text, templateKey, inReplyTo, attachments } = req.body;
    if (!to || (!text && !templateKey)) {
        return res.status(400).json({ error: 'to og text/templateKey er påkrævet' });
    }

    // Validate attachments
    const validatedAttachments = [];
    if (attachments) {
        if (!Array.isArray(attachments)) return res.status(400).json({ error: 'attachments skal være et array' });
        if (attachments.length > 5) return res.status(400).json({ error: 'Max 5 vedhæftninger per mail' });
        for (const att of attachments) {
            const id = parseInt(att.attachment_id);
            if (!id || id <= 0) return res.status(400).json({ error: 'Ugyldigt attachment_id' });
            validatedAttachments.push({ attachment_id: id });
        }
    }

    const db = getDb();
    const bon = db.prepare('SELECT bon_number FROM bons WHERE id = ?').get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const { sendMail, sendFromTemplate } = require('../services/mailService');
    const context = { type: 'bon', number: parseInt(bon.bon_number.replace(/\D/g, '')) };
    const userId = req.session?.user?.id || null;

    let result;
    if (templateKey) {
        const vars = req.body.vars || {};
        result = await sendFromTemplate({ templateKey, to, vars, bonId, context, userId, attachments: validatedAttachments });
    } else {
        result = await sendMail({ to, subject: subject || '', text, bonId, context, inReplyTo, smtpPrefix: 'smtp', userId, attachments: validatedAttachments });
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
