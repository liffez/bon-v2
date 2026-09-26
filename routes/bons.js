const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, getBon, getBonLines, getBonMenuGroups, getStatusId, getDefaultLocationId, isNonDriftLocation, todayISO, nextBonNumber, computeMomsFields, recalcBonTotalUnits, transaction, autoConsumeBonInventory, getPrepPackingOverrides, getPrepPackingExtras, getPrepPackingRecipeFactors, hasDeliveryLine, recalcBonTotal } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { requireAuth } = require('../shared/auth');
const grocy   = require('../services/grocyAdapter');
const { syncCashflowInvoice } = require('../services/cashflowSync');
const invoiceGuard = require('../services/invoiceGuard');
const bonTransportCo2 = require('../services/bonTransportCo2');
// quConvert bruges nu via services/ingredientResolver.js

// recalcBonTotal bor i db/helpers.js — én definition, så rabatreglen
// (services/bonDiscount.js) ikke kan drive fra en lokal kopi.

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
    const { status, date, date_from, date_to, q, location, unread_mail, sort, dir, limit, offset, company_id, customer_id, payment_type } = req.query;
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

    // Betalingstype — kommasepareret (bruges bl.a. til at finde modregning/sponsorat)
    if (payment_type) {
        const pts = payment_type.split(',').map(s => s.trim()).filter(Boolean);
        if (pts.length) {
            where.push('b.payment_type IN (' + pts.map(() => '?').join(',') + ')');
            args.push(...pts);
        }
    }

    // Fakturavagt (#319): kun bons markeret faktureret uden at der findes en faktura.
    // Genbruger VAGTENS eget SQL-udtryk, så filter og mærke aldrig kan divergere.
    // Er vagten inaktiv (ingen e-conomic-tokens) returnerer udtrykket '0' → tom liste,
    // hvilket er det ærlige svar: vi kan ikke vide det uden e-conomic.
    if (req.query.missing_invoice === '1') {
        where.push(`(${invoiceGuard.missingInvoiceSQL(db, 'b', 'sd')}) = 1`);
    }

    // Søgning — bonnumre er præcis 4 cifre:
    //   • ≤ 4 cifre  → match på bon_number (1, 33, 338, 3387). bon_number har et
    //                  præfiks ("B4037", "cafe-3485"), så vi matcher BÅDE prefix
    //                  (rene tal-numre) OG suffix (cifrene efter præfikset).
    //   • > 4 cifre  → telefon (kan ikke være bonnummer)
    //   • bogstaver  → kunde- og firma-navn (LIKE %q%)
    if (q) {
        const isDigits = /^\d+$/.test(q);
        if (isDigits && q.length <= 4) {
            where.push('(b.bon_number LIKE ? OR b.bon_number LIKE ?)');
            args.push(`${q}%`, `%${q}`);
        } else if (isDigits) {
            where.push('(c.phone LIKE ?)');
            args.push(`%${q}%`);
        } else {
            const like = `%${q}%`;
            // end_customer_name er med, fordi det er DET navn office leder efter
            // på en forhandler-ordre — bonnen ligger jo på forhandleren (Able),
            // ikke på slutkunden (Systematic), så hverken kunde- eller firmanavn
            // finder den.
            where.push("(b.bon_number LIKE ? OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR co.name LIKE ? OR COALESCE(b.end_customer_name,'') LIKE ?)");
            args.push(like, like, like, like);
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
            b.pax, b.total_units, b.total_co2e, b.total_price, b.event_role,
            b.payment_type, b.delivery_type, b.delivery_method, b.kitchen_selects,
            b.price_category_id, b.end_customer_name,
            pc.code  AS price_category_code,
            pc.label AS price_category_label,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            ${invoiceGuard.missingInvoiceSQL(db, 'b', 'sd')} AS missing_invoice,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name_full,
            c.phone  AS customer_phone,
            c.email  AS customer_email,
            co.name  AS company_name,
            co.ean   AS company_ean,
            co.is_reseller AS company_is_reseller,
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
                 THEN 1 ELSE 0 END AS is_unconfirmed_web,
            -- Kom bonen fra et booket møde (smagsprøve)? Office skal kunne se
            -- det i listen — ellers ligner den en almindelig ordre, og
            -- forklaringen står kun i køkkeninfo som listen ikke viser.
            -- Mødetypens EGET navn, ikke et hårdkodet ord: så er den sand
            -- uanset hvilke typer der senere kan give en bon.
            (SELECT mt.label FROM crm_activities ca
               JOIN meeting_types mt ON mt.id = ca.meeting_type_id
              WHERE ca.bon_id = b.id AND ca.type = 'meeting'
              ORDER BY ca.id LIMIT 1
            ) AS booking_meeting_label,
            (SELECT mt.emoji FROM crm_activities ca
               JOIN meeting_types mt ON mt.id = ca.meeting_type_id
              WHERE ca.bon_id = b.id AND ca.type = 'meeting'
              ORDER BY ca.id LIMIT 1
            ) AS booking_meeting_emoji
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
        // kontakt@-mail: matchede tråde uden bon (kunde/leverandør/indkøbsordre)
        const kontaktThreadCount = db.prepare(`
            SELECT COUNT(*) AS n
            FROM mail_messages mm
            JOIN mail_threads mt ON mm.thread_id = mt.id
            WHERE mm.direction = 'in' AND mm.is_read = 0
              AND mm.mailbox LIKE '%kontakt%'
              AND mt.bon_id IS NULL AND mt.status = 'active'
              AND mm.received_at > ?
        `).get(mailFloor).n;
        // kontakt@-mail: ufordelt post (ingen tag matchede ved IMAP-routing)
        const unmatchedCount = db.prepare(`
            SELECT COUNT(*) AS n
            FROM mail_unmatched
            WHERE status = 'open' AND mailbox LIKE '%kontakt%'
              AND COALESCE(received_at, created_at) > ?
        `).get(mailFloor).n;
        return res.json({
            count: newBonCount + mailCount + kontaktThreadCount + unmatchedCount,
            last_seen_at: null,
        });
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

    // kontakt@-mail på matchede tråde UDEN bon (kunde/leverandør/indkøbsordre).
    // Bon-tilknyttede tråde dækkes allerede af unreadMails ovenfor (uanset
    // mailbox), så her filtreres bevidst på bon_id IS NULL for at undgå dubletter.
    const kontaktThreadMails = db.prepare(`
        SELECT
            mm.id AS mail_id, mm.subject, mm.body_text, mm.from_email, mm.from_name,
            mm.received_at AS event_at,
            mt.customer_id, mt.purchase_order_id, mt.supplier_id,
            cu.first_name AS cust_first, cu.last_name AS cust_last,
            s.name AS supplier_name,
            po.id AS po_id, ps.name AS po_supplier_name
        FROM mail_messages mm
        JOIN mail_threads mt ON mm.thread_id = mt.id
        LEFT JOIN customers cu ON mt.customer_id = cu.id
        LEFT JOIN suppliers s ON mt.supplier_id = s.id
        LEFT JOIN purchase_orders po ON mt.purchase_order_id = po.id
        LEFT JOIN suppliers ps ON po.supplier_id = ps.id
        WHERE mm.direction = 'in' AND mm.is_read = 0
          AND mm.mailbox LIKE '%kontakt%'
          AND mt.bon_id IS NULL AND mt.status = 'active'
          AND mm.received_at > ?
        ORDER BY mm.received_at DESC
        LIMIT ?
    `).all(mailFloor, fetchSize);

    // kontakt@-mail i ufordelt post (intet tag matchede ved IMAP-routing)
    const unmatchedKontakt = db.prepare(`
        SELECT id AS mail_id, subject, body_text, from_email, from_name,
               COALESCE(received_at, created_at) AS event_at
        FROM mail_unmatched
        WHERE status = 'open' AND mailbox LIKE '%kontakt%'
          AND COALESCE(received_at, created_at) > ?
        ORDER BY COALESCE(received_at, created_at) DESC
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

    // kontakt@ tråd-mails (kunde/leverandør/indkøbsordre — ingen bon at åbne)
    for (const m of kontaktThreadMails) {
        let entityType, entityLabel;
        if (m.supplier_id) {
            entityType = 'supplier';
            entityLabel = 'Leverandør: ' + (m.supplier_name || ('#' + m.supplier_id));
        } else if (m.purchase_order_id) {
            entityType = 'purchase_order';
            entityLabel = 'Indkøbsordre #' + m.po_id + (m.po_supplier_name ? ' · ' + m.po_supplier_name : '');
        } else if (m.customer_id) {
            entityType = 'customer';
            const name = [m.cust_first, m.cust_last].filter(Boolean).join(' ').trim();
            entityLabel = 'Kunde: ' + (name || ('#' + m.customer_id));
        } else {
            entityType = 'thread';
            entityLabel = m.from_name || m.from_email || 'Mail';
        }
        events.push({
            event_type:   'kontakt_mail',
            event_at:     m.event_at,
            seen:         false,
            mail_kind:    'thread',
            entity_type:  entityType,
            entity_label: entityLabel,
            mail: {
                id: m.mail_id,
                subject: m.subject,
                preview: _mailPreview(m.body_text),
                from_address: m.from_email,
                from_name: m.from_name || null,
            },
        });
    }

    // kontakt@ ufordelt post
    for (const m of unmatchedKontakt) {
        events.push({
            event_type:   'kontakt_mail',
            event_at:     m.event_at,
            seen:         false,
            mail_kind:    'unmatched',
            entity_type:  'unmatched',
            entity_label: 'Ufordelt post',
            mail: {
                id: m.mail_id,
                subject: m.subject,
                preview: _mailPreview(m.body_text),
                from_address: m.from_email,
                from_name: m.from_name || null,
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

    // Fakturavagt (#319): udledt mærke — selv-helende, forsvinder når en kladde
    // eller bogført faktura dukker op. Vises kun når bonnen ER faktureret.
    bon.missing_invoice = invoiceGuard.GUARDED_STATUSES.includes(bon.status_code)
        && invoiceGuard.bonMissingInvoice(getDb(), bon.id).missing ? 1 : 0;

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
            SELECT f.id, f.entity_type, f.entity_id, f.title, f.body, f.show_in_kitchen, f.created_at,
                   u.name AS created_by_name,
                   EXISTS(SELECT 1 FROM flag_acks
                          WHERE flag_id = f.id AND bon_id = ?) AS acked_on_this_bon
            FROM entity_flags f
            LEFT JOIN users u ON f.created_by_user_id = u.id
            WHERE f.dismissed_at IS NULL AND (${conds.join(' OR ')})
            ORDER BY f.created_at DESC
        `).all(...args);
    }

    // Transport-CO₂ pr. bon (Fase 3) — mad-CO₂ = bon.total_co2e, transport lægges ved.
    const tco2 = bonTransportCo2.computeForBon(getDb(), bon);
    res.json({
        ...bon,
        ...computeMomsFields(bon.total_price),
        transport_co2e_kg: tco2.kg,
        transport_co2_source: tco2.source,
        transport_vehicle_label: tco2.vehicle_label,
    });
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
        // Samme regel som changeloggen nedenfor: hvem der oprettede bonnen er
        // ikke afsenderens at bestemme. Ingen klient sender feltet i dag, så
        // kolonnen går fra altid-tom til at pege på et menneske.
        req.session?.userId ?? null, b.is_internal ? 1 : 0
    );

    // Identitet kommer fra sessionen, ALDRIG fra body: changelog er det eneste
    // spor der peger på et menneske, så afsenderen må ikke kunne skrive en anden
    // ind i det. Ingen klient har nogensinde sendt created_by_user_id, så det her
    // udfylder tomme rækker frem for at ændre eksisterende adfærd.
    //
    // new_value bar før bon-nummeret (som står i entity_id i forvejen). Nu bærer
    // den kilden, så historikken kan skelne en bon tastet i huset fra en der kom
    // ind ad sig selv — samme konvention som createBons changelog_message.
    logChange({ entityType: 'bon', entityId: result.lastInsertRowid, action: 'create',
        fieldName: 'manual', newValue: 'Oprettet manuelt', userId: req.session?.userId ?? null });
    // Server-autoritativ recalc (linjer kan være indsat i samme request via /lines, men typisk ingen endnu)
    // POS-undtagelse: se kommentar over recalcBonTotal-definitionen
    // total_units er ALTID afledt af linjerne (boks-aware) — aldrig payload-værdien,
    // så en ny bon uden linjer får 0 (ikke et tilfældigt pax-tal der senere divergerer).
    recalcBonTotalUnits(getDb(), result.lastInsertRowid);
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
//
// Event-bons: event_id + event_role bevares på kopien. Uden dem ville en
// kopieret prep-bon falde ud af eventets prep-liste/P&L OG miste Vej B-
// undtagelsen i autoConsumeBonInventory — den ville aldrig trække HQ-lager
// ved LEVERET når det globale auto-deduct-flag er slukket. Typisk brugscase:
// flerdags-event med ens dage → kopiér dag 1's prep-bon til dag 2.

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
                bon_number, status_id, location_id, customer_id, company_id, price_category_id, price_category,
                event_id, event_role,
                order_date, delivery_date, pickup_time, delivery_time,
                delivery_type, delivery_method, delivery_address_id,
                delivery_notes, delivery_price,
                pax, total_units, boxes,
                payment_type, kitchen_selects, customer_collects,
                kitchen_info, customer_wishes, internal_notes, invoice_info,
                day_contact_name, day_contact_phone,
                created_by_user_id, is_internal
            ) VALUES (
                ?,?,?,?,?,?,?,
                ?,?,
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
            src.customer_id, src.company_id, src.price_category_id, src.price_category,
            src.event_id, src.event_role,
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
        'end_customer_name',
        'offer_discount_percent',
        'is_internal'
    ];

    const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'Ingen gyldige felter' });

    // Rabatten er den ENE sats hele systemet regner ud fra (recalcBonTotal her,
    // discountPercentage pr. linje i e-conomic-udkastet), så den skal valideres
    // hvor den skrives. 100 % er ikke en rabat, og en negativ sats ville lægge
    // TIL fakturaen i stedet for at trække fra.
    if ('offer_discount_percent' in updates) {
        const pct = Number(updates.offer_discount_percent);
        if (!Number.isFinite(pct) || pct < 0 || pct >= 100)
            return res.status(400).json({ error: 'Rabat skal være mindst 0 og under 100 procent' });
        updates.offer_discount_percent = pct;
    }

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
    if ('delivery_price' in updates || 'offer_discount_percent' in updates) {
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

// ─── POST /api/bons/:id/reapply-discount — hent firmaets/kundens rabat igen ──
//
// `bons_seed_standing_discount` (migration 111) kopierer satsen ved INSERT og kun
// der — bevidst, så en ændret sats ikke rører historiske fakturaer. Men det gør
// også at en rabat aftalt i dag ALDRIG rammer de bons der allerede ligger i
// faktureringskøen, og der fandtes ingen vej til at hente den. Det kostede to
// kreditnotaer i august (faktura 4150 → 4177 → 4178, og 4161 → 4179 → 4180).
//
// Bevidst handling med sin egen changelog-linje, ikke en bivirkning af at gemme.
router.post('/:id/reapply-discount', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const bon = db.prepare(`
        SELECT b.id, b.offer_discount_percent,
               co.discount_percent AS company_pct, co.name AS company_name,
               c.discount_percent  AS customer_pct
        FROM bons b
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN customers c  ON c.id  = b.customer_id
        WHERE b.id = ?`).get(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    // Samme prioritet som triggeren: firmaet vinder over personen.
    const pct = Number(bon.company_pct) > 0 ? Number(bon.company_pct)
              : Number(bon.customer_pct) > 0 ? Number(bon.customer_pct)
              : 0;
    const current = Number(bon.offer_discount_percent) || 0;
    if (pct === current) return res.json({ ok: true, changed: false, discount_percent: pct });

    db.prepare('UPDATE bons SET offer_discount_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pct, id);
    logChange({
        entityType: 'bon', entityId: id, action: 'update',
        fieldName: 'offer_discount_percent',
        oldValue: String(current), newValue: String(pct),
        userId: req.session?.userId ?? null,
        notes: pct > 0
            ? `Hentet fra ${bon.company_name ? 'firmaet ' + bon.company_name : 'kunden'}`
            : 'Nulstillet — der er ingen stående rabat',
    });
    recalcBonTotal(db, id, { logIfChanged: true, userId: req.session?.userId ?? null });
    broadcast('bon_updated', { id });
    res.json({ ok: true, changed: true, discount_percent: pct, previous: current });
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

    // Force-mode: overstyr en status-vej der ikke findes i status_transitions.
    //
    // Kræver en gyldig session — men IKKE admin (Patch D var admin-only indtil
    // aug 2026). Virkeligheden følger ikke altid flow-diagrammet: en kunde
    // aflyser efter levering, en bon skal lukkes fra en terminal status. Den
    // der står med sagen skal kunne rette op, og auth her er rolle-baseret med
    // delte konti — så admin-kravet ramte roller, ikke ansvar. Frontenden
    // advarer og beder om bekræftelse; changelog viser bagefter hvem det var.
    //
    // Login-kravet står ved magt: det gør IKKE force til noget et
    // uautentificeret kald kan lave, og det er dét der sikrer at der er en
    // bruger at skrive i auditsporet.
    //
    // D-2b/D-3 er uændret: både rolle-tjek og audit-user-id kommer fra
    // SESSION, aldrig fra body.user_id — ellers kunne afsenderen skrive en
    // anden brugers navn i historikken.
    const isForce = force === true;
    const sessionUserId = req.session?.userId ?? null;
    // Slå session-brugeren op ALTID (ikke kun ved force) — så can_force kan
    // beregnes korrekt allerede på den første ikke-force-request der afvises, og
    // frontenden ved om override overhovedet er en mulighed.
    const sessionUser = sessionUserId
        ? db.prepare(`SELECT role FROM users WHERE id = ? AND is_active = 1`).get(sessionUserId)
        : null;
    if (isForce) {
        if (!sessionUserId) {
            return res.status(401).json({ error: 'Force-mode kræver login' });
        }
        if (!sessionUser) {
            return res.status(401).json({ error: 'Session-bruger ikke gyldig' });
        }
    }

    // Slå transition op (uanset force-mode — vi bruger triggers_json længere nede).
    // Hvis transition ikke findes OG vi ikke har force+admin, afvises requesten.
    const transition = db.prepare(`
        SELECT st.* FROM status_transitions st
        JOIN status_definitions from_sd ON st.from_status_id = from_sd.id
        JOIN status_definitions to_sd   ON st.to_status_id   = to_sd.id
        WHERE from_sd.code = ? AND to_sd.code = ? AND st.is_active = 1
    `).get(bon.current_code, status_code);

    if (!transition && !isForce) {
        return res.status(400).json({
            error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt`,
            code: 'TRANSITION_NOT_ALLOWED',
            // Maskinlæsbart flag så frontenden kan tilbyde override (force:true)
            // præcist når en normal status-vej afvises — uden at matche på dansk tekst.
            // Uden session er der ingen at skrive i auditsporet, og så tilbydes det ikke.
            can_force: !!sessionUser,
            hint: 'Kan overstyres med {force: true} af en indlogget bruger'
        });
    }

    // ── Fakturavagt (#319) ────────────────────────────────────────────────
    // Markeres bonnen faktureret uden at der findes en kladde eller bogført
    // faktura, spørger vi ÉN gang — i det øjeblik beslutningen tages, hvor
    // konteksten er der. Byttehandel/sponsorat → bevidst, klik videre.
    // Forglemmelse → fanget. Blokerer aldrig: klienten sender igen med
    // confirm_no_invoice. Se services/invoiceGuard.js for regel + filtre.
    if (invoiceGuard.GUARDED_STATUSES.includes(status_code) && req.body.confirm_no_invoice !== true) {
        const guard = invoiceGuard.bonMissingInvoice(db, id);
        if (guard.missing) {
            return res.status(409).json({
                error: 'Der findes hverken en e-conomic-kladde eller en bogført faktura på denne bon',
                code: 'NO_INVOICE_FOUND',
                bon_number: guard.bon_number,
                hint: 'Send igen med {confirm_no_invoice: true} hvis det er med vilje',
            });
        }
    }

    db.prepare(`UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus.id, id);
    // Audit-user-id:
    //   - Force-mode: ALTID session.userId (kan ikke falsificeres via body)
    //   - Ikke-force: behold eksisterende mønster (body.user_id eller null) —
    //     endpointet er stadig uautentificeret for ikke-force-flow, så kitchen-
    //     tablets der sender user_id i body får audit-værdien som hidtil.
    const auditUserId = isForce
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
        wasForced: isForce
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
    //
    // Peger den aktive Grocy et sted der ikke er drift (Test, den udfasede cafe),
    // lander trækket DÉR — og kan ikke gentages, fordi idempotens-vagten netop
    // forhindrer det (#535). Det er ikke en spærring: der kan være en grund til
    // at stå i Test. Men det skal siges, mens man er ved skærmen.
    let grocyWarning = null;
    if (status_code === 'LEVERET') {
        // Spørg trækket selv om der SKETE noget, og hvor. Reglerne (auto-deduct-
        // flaget, event-gaten, idempotensen) bor ét sted; gentog ruten dem, ville
        // advarslen før eller siden påstå et træk der aldrig blev sat i gang.
        const { started, location } = autoConsumeBonInventory(id) || {};
        if (started && isNonDriftLocation(location)) {
            grocyWarning = `Lageret blev trukket i "${location.name}" — ikke i produktions-Grocy.`
                         + ' Skift aktiv Grocy under Settings → Grocy. Trækket kan ikke gentages på denne bon.';
        }
    }

    // Cashflow-sync: opret/opdater/slet cf_invoice afhængigt af status.
    // Helperen er idempotent og no-op for ikke-faktura-bons (POS, tilbud, interne).
    // Fejl må ikke afbryde status-skift — log og fortsæt.
    try {
        syncCashflowInvoice(db, id);
    } catch (err) {
        console.error(`[cashflow] sync failed for bon ${id}:`, err.message);
    }

    // Standardgebyrer (settings.auto_fee_rules, fx miljøbidraget) lægges på når
    // bonen træder ind i faktureringskøen. Her — og ikke i e-conomic-kladden —
    // fordi ikke alle fakturaer går gennem kladden; nogle tastes i hånden, og de
    // skal se samme total. Se services/autoFees.js.
    //
    // Fire-and-forget som auto-consume ovenfor: gebyret kræver et Grocy-opslag,
    // og køkkenets "Leveret"-tryk skal svare med det samme. Lander gebyret, skal
    // cf_invoice have det nye beløb, og skærmene skal opdatere.
    if (status_code === 'LEVERET') {
        require('../services/autoFees')
            .applyAutoFees(db, id, { userId: auditUserId })
            .then(({ added }) => {
                if (!added.length) return;
                try { syncCashflowInvoice(db, id); }
                catch (err) { console.error(`[cashflow] resync efter gebyr, bon ${id}:`, err.message); }
                broadcast('bon_updated', { id });
            })
            .catch(err => console.error(`[autoFees] bon ${id}:`, err.message));
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
        // null når alt er som det skal være — så en klient der ikke kender feltet
        // er upåvirket, og en der gør kun viser noget når der ER noget.
        grocy_warning: grocyWarning,
        triggers
    });
}));

// ─── DELETE /api/bons/:id — permanent sletning ──────────────────────────────
// Sikkerhedsnet: kun bons med status AFLYST kan slettes permanent — alt andet
// skal aflyses først (drawerens "Slet bon" gør netop det i to trin).
// Rydder alle refererende tabeller i én transaction (mønster fra
// scripts/cleanup-test-bons.js + nyere tabeller fra migration 069/073).

router.delete('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const bon = db.prepare(`
        SELECT b.id, b.bon_number, sd.code AS status_code
        FROM bons b JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.id = ?
    `).get(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    if (bon.status_code !== 'AFLYST') {
        return res.status(409).json({
            error: `Kun aflyste bons kan slettes permanent — bonen har status ${bon.status_code}. Aflys den først.`
        });
    }

    transaction(db, () => {
        // Mail-kæden: attachments → messages → threads
        db.prepare(`DELETE FROM mail_attachments WHERE message_id IN
            (SELECT id FROM mail_messages WHERE thread_id IN
                (SELECT id FROM mail_threads WHERE bon_id = ?))`).run(id);
        db.prepare(`DELETE FROM mail_messages WHERE thread_id IN
            (SELECT id FROM mail_threads WHERE bon_id = ?)`).run(id);
        db.prepare(`DELETE FROM mail_threads WHERE bon_id = ?`).run(id);

        // SET NULL hvor koblingen kun er reference/audit
        db.prepare(`UPDATE shopping_list SET source_bon_id = NULL WHERE source_bon_id = ?`).run(id);
        db.prepare(`UPDATE mail_unmatched SET linked_bon_id = NULL WHERE linked_bon_id = ?`).run(id);
        db.prepare(`UPDATE crm_unmatched_emails SET linked_bon_id = NULL WHERE linked_bon_id = ?`).run(id);
        db.prepare(`UPDATE quotes SET converted_to_bon_id = NULL WHERE converted_to_bon_id = ?`).run(id);
        db.prepare(`UPDATE entity_flags SET dismissed_on_bon_id = NULL WHERE dismissed_on_bon_id = ?`).run(id);

        // DELETE for rækker der er bon-ejede
        db.prepare(`DELETE FROM web_orders WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM notifications WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM delivery_events WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM crm_activities WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM geo_calculations WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM flag_acks WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM delivery_incidents WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM delivery_route_stops WHERE bon_id = ?`).run(id);
        db.prepare(`DELETE FROM attachments WHERE entity_type = 'bon' AND entity_id = ?`).run(id);

        // Polymorf changelog
        db.prepare(`DELETE FROM changelog WHERE entity_type = 'bon' AND entity_id = ?`).run(id);

        // Selve bonen — CASCADE rydder bon_lines, bon_menu_groups, prep_packing_overrides.
        // cf_invoices.bon_id er ON DELETE SET NULL (migration 078).
        db.prepare(`DELETE FROM bons WHERE id = ?`).run(id);
    });

    console.log(`[bons] Bon ${id} (${bon.bon_number}) permanent slettet af user ${req.session?.userId ?? '?'}`);
    broadcast('bon_deleted', { id, bon_number: bon.bon_number });
    res.json({ ok: true, deleted: id });
}));

// ─── PATCH /api/bons/:id/prep — opdater prep-checks ────────────────────────

router.patch('/:id/prep', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { ingredients_ready, supplies_ready, note } = req.body;

    const fields = [];
    const vals   = [];
    if (ingredients_ready !== undefined) { fields.push('prep_ingredients_ready = ?'); vals.push(ingredients_ready ? 1 : 0); }
    if (supplies_ready    !== undefined) { fields.push('prep_supplies_ready = ?');    vals.push(supplies_ready    ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Ingen felter at opdatere' });

    const before = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(id);
    if (!before) return res.status(404).json({ error: 'Bon ikke fundet' });

    db.prepare(`UPDATE bons SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, id);
    const bon = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(id);

    // Historik + live-opdatering. Ruten skrev ingen af delene, så et flueben
    // sat fra én skærm hverken kunne ses på de andre eller spores bagefter.
    // Kun felter der faktisk skifter logges. Brugeren kommer fra sessionen.
    const changes = [
        ['prep_ingredients_ready', before.prep_ingredients_ready, bon.prep_ingredients_ready],
        ['prep_supplies_ready',    before.prep_supplies_ready,    bon.prep_supplies_ready],
    ].filter(([, o, n]) => !!o !== !!n);
    for (const [field, o, n] of changes) {
        logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: field,
            oldValue: o ? '1' : '0', newValue: n ? '1' : '0',
            userId: req.session?.userId ?? null,
            notes: typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null });
    }
    if (changes.length) broadcast('bon_updated', { id });

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
    logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'kitchen_info', oldValue: old.kitchen_info, newValue: text, userId: req.session?.userId ?? null });
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

    // Findes varen allerede på bonen? Så lægges antallet oveni i stedet for at
    // lave endnu en række — ellers ender en bon med fx 6 × "1× Kartoflen slider",
    // som kun køkken-kortet skjuler (mail, info-modal og faktura viser rå linjer).
    // Bevidst konservativ: kun linjer der er identiske på alt kunde/køkken kan se
    // slås sammen. Særønsker holdes altid adskilt — de er selvstændige beskeder.
    // Og kun løse linjer (menu_group_id IS NULL), så en tilføjelse aldrig
    // smutter ind i en eksisterende menugruppe.
    const special = (l.special_request ?? null) || null;
    const existing = special ? null : db.prepare(`
        SELECT id, quantity FROM bon_lines
         WHERE bon_id = ?
           AND menu_group_id IS NULL
           AND block_type IS NULL
           AND (special_request IS NULL OR special_request = '')
           AND product_name = ?
           AND is_accessory = ?
           AND unit = ?
           AND grocy_recipe_id IS ?
           AND category IS ?
           AND unit_price IS ?
         ORDER BY id
         LIMIT 1
    `).get(
        bonId, l.product_name, l.is_accessory ? 1 : 0, l.unit ?? 'stk',
        l.grocy_recipe_id ?? null, l.category ?? null, unitPrice
    );

    let lineId;
    let logValue;

    if (existing) {
        const newQty   = existing.quantity + qty;
        const newTotal = (unitPrice != null && newQty) ? newQty * unitPrice : null;
        db.prepare(`UPDATE bon_lines SET quantity = ?, line_total = ? WHERE id = ?`)
          .run(newQty, newTotal, existing.id);
        lineId   = existing.id;
        logValue = `tilføjet: ${qty}x ${l.product_name} (nu ${newQty}x)`;
    } else {
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
            l.is_accessory ? 1 : 0, special,
            l.co2e ?? null, l.notes ?? null
        );
        lineId   = result.lastInsertRowid;
        logValue = `tilføjet: ${qty}x ${l.product_name}`;
    }

    // Genberegn total_units (kun kategorier i settings.unit_count_categories)
    recalcBonTotalUnits(db, bonId);

    // Server-autoritativ recalc af total_price (incl. moms)
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: l.user_id ?? null });

    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', newValue: logValue, userId: req.session?.userId ?? null });
    broadcast('bon_updated', { id: bonId });
    res.status(201).json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
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
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet', userId: req.session?.userId ?? null });
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
        newValue: `${savedGroups.length} gruppe(r)`, userId: req.session?.userId ?? null });
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
    const db = getDb();
    const overrides = db.prepare(`
        SELECT product_id, product_name, packed_amount, unit
        FROM prep_packing_overrides WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    // Ekstra buffer-varer (lægges OVENI opskrifts-forbruget — se migration 102).
    const extras = db.prepare(`
        SELECT product_id, product_name, amount, unit
        FROM prep_packing_extras WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    // Underopskrift-skalering (Frisk Grønt, dressinger — se migration 103).
    const recipe_overrides = db.prepare(`
        SELECT recipe_id, factor
        FROM prep_packing_recipe_overrides WHERE bon_id = ? ORDER BY recipe_id
    `).all(id);
    res.json({ overrides, extras, recipe_overrides });
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
    // Begge arrays er valgfrie, men mindst ét skal være med. Sender klienten kun
    // det ene, reconciler vi kun det — det andet røres ikke (bagudkompatibelt med
    // ældre klienter der kun kender overrides).
    const overrideItems = Array.isArray(req.body?.overrides)        ? req.body.overrides        : null;
    const extraItems    = Array.isArray(req.body?.extras)           ? req.body.extras           : null;
    const recipeItems   = Array.isArray(req.body?.recipe_overrides) ? req.body.recipe_overrides : null;
    if (!overrideItems && !extraItems && !recipeItems) {
        return res.status(400).json({ error: 'overrides, extras eller recipe_overrides (array) er påkrævet' });
    }

    transaction(db, () => {
        if (overrideItems) {
            db.prepare(`DELETE FROM prep_packing_overrides WHERE bon_id = ?`).run(id);
            const ins = db.prepare(`
                INSERT INTO prep_packing_overrides (bon_id, product_id, product_name, packed_amount, unit, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const it of overrideItems) {
                const pid = parseInt(it.product_id);
                const amt = Number(it.packed_amount);
                if (!pid || Number.isNaN(amt) || amt < 0) continue;
                ins.run(id, pid, it.product_name ?? null, amt, it.unit ?? null);
            }
        }
        if (extraItems) {
            db.prepare(`DELETE FROM prep_packing_extras WHERE bon_id = ?`).run(id);
            const insX = db.prepare(`
                INSERT INTO prep_packing_extras (bon_id, product_id, product_name, amount, unit, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const it of extraItems) {
                const pid = parseInt(it.product_id);
                const amt = Number(it.amount);
                if (!pid || Number.isNaN(amt) || amt <= 0) continue;
                insX.run(id, pid, it.product_name ?? null, amt, it.unit ?? null);
            }
        }
        if (recipeItems) {
            db.prepare(`DELETE FROM prep_packing_recipe_overrides WHERE bon_id = ?`).run(id);
            const insR = db.prepare(`
                INSERT INTO prep_packing_recipe_overrides (bon_id, recipe_id, factor, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const it of recipeItems) {
                const rid = parseInt(it.recipe_id);
                const f   = Number(it.factor);
                // factor=1 (eller ~1) er ingen ændring → gem ikke
                if (!rid || Number.isNaN(f) || f <= 0 || Math.abs(f - 1) < 0.0001) continue;
                insR.run(id, rid, f);
            }
        }
    });
    logChange({ entityType: 'bon', entityId: id, action: 'update', fieldName: 'packing', userId: req.session?.userId ?? null });
    broadcast('bon_updated', { id });
    const overrides = db.prepare(`
        SELECT product_id, product_name, packed_amount, unit
        FROM prep_packing_overrides WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    const extras = db.prepare(`
        SELECT product_id, product_name, amount, unit
        FROM prep_packing_extras WHERE bon_id = ? ORDER BY product_id
    `).all(id);
    const recipe_overrides = db.prepare(`
        SELECT recipe_id, factor
        FROM prep_packing_recipe_overrides WHERE bon_id = ? ORDER BY recipe_id
    `).all(id);
    res.json({ overrides, extras, recipe_overrides });
}));

// Read-only forhåndsvisning af lagertrækket: PRÆCIS hvad LEVERET ville trække
// fra HQ (opskrifts-komponenter + overrides + extras) UDEN at røre Grocy-lageret.
// Bruger samme delte resolverings-helpers som det rigtige consume → garanteret match.
router.get('/:id/packing/consume-preview', handle(async (req, res) => {
    const id = parseInt(req.params.id);
    const bon = getBon(id);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });
    const lines         = getBonLines(id);
    const overrides     = getPrepPackingOverrides(id);
    const extras        = getPrepPackingExtras(id);
    const recipeFactors = getPrepPackingRecipeFactors(id);
    const { items } = await grocy.planConsume(lines, overrides, extras, recipeFactors);
    res.json({ bon_id: bon.id, bon_number: bon.bon_number, items });
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
//
// Fritekst-body køres gennem renderTemplate, præcis som POST /api/customers/:id/mail.
// Uden det gik universelle pladsholdere — i dag {{booking_link}} — afsted til kunden
// som rå tekst: bon-draweren og bon-kortet folder skabelonen ud i BROWSEREN og sender
// resultatet som `text`, så serveren så aldrig en skabelon at rendere.
router.post('/:id/mail', handle(async (req, res) => {
    const bonId = parseInt(req.params.id);
    const { to, subject, text, templateKey, inReplyTo, attachments } = req.body;
    if (!to || (!text && !templateKey)) {
        return res.status(400).json({ error: 'to og text/templateKey er påkrævet' });
    }

    // Validate attachments
    const { sendMail, sendFromTemplate, validateAttachments, bonMailContext, renderTemplate } = require('../services/mailService');
    const att = validateAttachments(attachments);
    if (att.error) return res.status(400).json({ error: att.error });
    const validatedAttachments = att.list;

    const db = getDb();
    const bon = db.prepare('SELECT bon_number, customer_id FROM bons WHERE id = ?').get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    // Tilbud sendes gennem denne rute (de ER bons med is_offer = 1), så typen
    // skal udledes af rækken — ikke antages. Hardkodet 'bon' gav T-28 tagget
    // #b-28, og kundens svar kunne dermed ikke finde tilbuddet igen.
    const context = bonMailContext(db, bonId);
    const userId = req.session?.userId || null;

    // Bonens kunde er den eneste kunde en bon-mail kan handle om — et
    // {{booking_link}} herfra skal bindes til hende, ikke til nogen anden.
    // Bons uden kunde (interne, event) har ingen, og så kaster renderTemplate.
    const renderCtx = { customerId: bon.customer_id || null, userId, bookingFlow: 'smagning' };

    let result;
    try {
        if (templateKey) {
            const vars = req.body.vars || {};
            result = await sendFromTemplate({ templateKey, to, vars, bonId, context, userId, attachments: validatedAttachments });
        } else {
            result = await sendMail({
                to,
                subject: renderTemplate(subject || '', {}, renderCtx),
                text: renderTemplate(text, {}, renderCtx),
                bonId, context, inReplyTo, smtpPrefix: 'smtp', userId,
                attachments: validatedAttachments
            });
        }
    } catch (err) {
        // Et uopløseligt booking-link er brugerens at rette, ikke en serverfejl.
        // Beskeden er skrevet til afsenderen og skal helt ud i UI'et.
        if (err.code === 'booking_link_unresolvable') {
            return res.status(400).json({ error: err.message, code: err.code });
        }
        throw err;
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
