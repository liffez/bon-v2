/**
 * routes/nav.js
 *
 * GET /api/nav/badges
 *   Samler badge-tællere til office-sidebar v2 i ét kald.
 *   Erstatter de tidligere separate updateInvoiceBadge / updateWebOrdersBadge /
 *   updateSiBadge-funktioner i office/index.html.
 *
 *   Response:
 *     {
 *       bons_nye: <count>,                // web-orders der ikke er acknowledged
 *       bons_ulaest_mail: <count>,        // bons med ulæst indgående mail
 *       crm_indbakke: <count>,            // mail_unmatched med status='open'
 *       tilbud_aktive: <count>,           // bons med is_offer=1 og åben offer_status
 *       indkob_leverandorpost: <count>,   // ulæste indgående mails på PO+supplier-tråde
 *       okonomi_fakturering: <count>      // LEVERET-bons med invoice payment_type
 *     }
 *
 *   Frontend skal kalde det her endpoint ved init + på SSE-event
 *   'nav:badges-changed' (debounced 300ms).
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../shared/auth');
const { handle } = require('../db/helpers');

router.get('/badges', requireAuth(), handle((req, res) => {
    const db = getDb();
    const result = {
        bons_nye: 0,
        bons_ulaest_mail: 0,
        crm_indbakke: 0,
        tilbud_aktive: 0,
        indkob_leverandorpost: 0,
        okonomi_fakturering: 0,
    };

    // ── Nye bons: web-orders endnu ikke acknowledged ────────────────────
    // Matcher samme query som GET /api/web-orders/pending
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c
            FROM bons b
            JOIN web_orders wo ON wo.bon_id = b.id
            WHERE b.acknowledged_at IS NULL
        `).get();
        result.bons_nye = row?.c || 0;
    } catch (e) { console.warn('[nav/badges] bons_nye:', e.message); }

    // ── Ulæst mail på bons: indgående, ulæste mails knyttet til en bon ──
    // Matcher samme mønster som unread_mail-filteret i GET /api/bons.
    // Tæller distinkte bons (ikke beskeder) så badgen matcher rækkerne i listen.
    try {
        const row = db.prepare(`
            SELECT COUNT(DISTINCT mt.bon_id) AS c
            FROM mail_messages mm
            JOIN mail_threads mt ON mt.id = mm.thread_id
            WHERE mm.direction = 'in'
              AND mm.is_read = 0
              AND mt.bon_id IS NOT NULL
        `).get();
        result.bons_ulaest_mail = row?.c || 0;
    } catch (e) { console.warn('[nav/badges] bons_ulaest_mail:', e.message); }

    // ── CRM indbakke: tråde der KRÆVER HANDLING (matcher indbakkens "Åbne"-chip) ──
    // Efter indbakke-redesignet (migration 104) styres handling af `handling_status`,
    // ikke læst-status: en åben tråd forbliver "Åben" selv efter man har læst den.
    // Badgen = Åbne (handling_status='aaben', ikke snoozet) + Ufordelt (mail_unmatched
    // status='open'). Tidligere talte den ulæste beskeder → badgen forsvandt så snart
    // man åbnede mailen, selvom tråden stadig krævede svar.
    try {
        const um = db.prepare(`SELECT COUNT(*) AS c FROM mail_unmatched WHERE status = 'open'`).get();
        const open = db.prepare(`
            SELECT COUNT(*) AS c FROM mail_threads mt
            WHERE mt.handling_status = 'aaben'
              AND NOT (mt.snooze_until IS NOT NULL AND mt.snooze_until > datetime('now'))
        `).get();
        result.crm_indbakke = (um?.c || 0) + (open?.c || 0);
    } catch (e) { console.warn('[nav/badges] crm_indbakke:', e.message); }

    // ── Aktive tilbud: is_offer=1 og ikke afsluttede ────────────────────
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM bons
            WHERE is_offer = 1
              AND (offer_status IS NULL
                   OR offer_status NOT IN ('won', 'lost', 'expired', 'cancelled'))
        `).get();
        result.tilbud_aktive = row?.c || 0;
    } catch (e) { console.warn('[nav/badges] tilbud_aktive:', e.message); }

    // ── Leverandørpost: ulæste indgående mails på PO- + supplier-tråde ──
    // Matcher samme mønster som GET /api/orders/mail-threads + supplier mail
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c
            FROM mail_messages mm
            JOIN mail_threads mt ON mt.id = mm.thread_id
            WHERE mm.direction = 'in'
              AND mm.is_read = 0
              AND mt.status = 'active'
              AND (mt.purchase_order_id IS NOT NULL OR mt.supplier_id IS NOT NULL)
        `).get();
        result.indkob_leverandorpost = row?.c || 0;
    } catch (e) { console.warn('[nav/badges] indkob_leverandorpost:', e.message); }

    // ── Fakturering: LEVERET + payment_type='invoice' ───────────────────
    // Matcher samme WHERE som GET /api/invoices/queue (pending-sektion)
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c
            FROM bons b
            JOIN status_definitions sd ON sd.id = b.status_id
            WHERE sd.code = 'LEVERET'
              AND b.payment_type = 'invoice'
              AND (b.is_offer = 0 OR b.is_offer IS NULL)
        `).get();
        result.okonomi_fakturering = row?.c || 0;
    } catch (e) { console.warn('[nav/badges] okonomi_fakturering:', e.message); }

    res.set('Cache-Control', 'no-cache');
    res.json(result);
}));

// ── GET /api/nav/attention ──────────────────────────────────────────
// Fælles "Nyt der kræver handling"-feed til topbar-indikatoren.
// Samler de to ting man ikke må overse i office:
//   1. Nye web-bestillinger (bons med web_order + acknowledged_at IS NULL)
//   2. Mail der kan blive en ordre (ufordelt + åbne kunde/bon-tråde)
// Tællerne matcher bons_nye + crm_indbakke i /badges, så topbar og sidebar
// aldrig modsiger hinanden.
router.get('/attention', requireAuth(), handle((req, res) => {
    const db = getDb();
    const out = { web_orders: [], failed_orders: [], mail: [], counts: { web: 0, failed: 0, mail: 0, total: 0 } };

    // ── Nye web-bestillinger ────────────────────────────────────────
    try {
        out.web_orders = db.prepare(`
            SELECT b.id            AS bon_id,
                   b.bon_number    AS bon_number,
                   b.delivery_date AS delivery_date,
                   b.total_units   AS total_units,
                   b.pax           AS pax,
                   TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS customer_name,
                   co.name         AS company_name,
                   b.created_at    AS created_at
            FROM bons b
            JOIN web_orders wo ON wo.bon_id = b.id
            LEFT JOIN customers c ON c.id = b.customer_id
            LEFT JOIN companies co ON co.id = b.company_id
            WHERE b.acknowledged_at IS NULL
            ORDER BY b.created_at DESC
            LIMIT 50
        `).all();
    } catch (e) { console.warn('[nav/attention] web_orders:', e.message); }

    // ── Mail: ufordelt (ukendt afsender) ────────────────────────────
    let unmatched = [];
    try {
        unmatched = db.prepare(`
            SELECT id, from_email, from_name, subject, received_at, parsed_name, parsed_company
            FROM mail_unmatched
            WHERE status = 'open'
            ORDER BY received_at DESC
            LIMIT 50
        `).all().map(m => ({
            kind: 'unmatched',
            id: m.id,
            from: m.from_name || m.parsed_name || m.from_email || 'Ukendt afsender',
            from_email: m.from_email,
            subject: m.subject || '(uden emne)',
            customer_name: m.parsed_company || null,
            received_at: m.received_at,
        }));
    } catch (e) { console.warn('[nav/attention] unmatched:', e.message); }

    // ── Mail: åbne kunde/bon-tråde (kræver handling, ikke PO/leverandør) ──
    let threads = [];
    try {
        threads = db.prepare(`
            SELECT mt.id            AS thread_id,
                   mt.bon_id        AS bon_id,
                   mt.subject       AS subject,
                   mt.updated_at    AS received_at,
                   TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS customer_name,
                   b.bon_number     AS bon_number,
                   (SELECT mm.from_email FROM mail_messages mm
                     WHERE mm.thread_id = mt.id AND mm.direction = 'in'
                     ORDER BY mm.received_at DESC LIMIT 1) AS from_email
            FROM mail_threads mt
            LEFT JOIN customers c ON c.id = mt.customer_id
            LEFT JOIN bons b ON b.id = mt.bon_id
            WHERE mt.handling_status = 'aaben'
              AND mt.purchase_order_id IS NULL
              AND mt.supplier_id IS NULL
              AND NOT (mt.snooze_until IS NOT NULL AND mt.snooze_until > datetime('now'))
            ORDER BY mt.updated_at DESC
            LIMIT 50
        `).all().map(t => ({
            kind: 'thread',
            id: t.thread_id,
            thread_id: t.thread_id,
            bon_id: t.bon_id || null,
            bon_number: t.bon_number || null,
            from: t.customer_name || t.from_email || 'Kunde',
            from_email: t.from_email,
            subject: t.subject || '(uden emne)',
            customer_name: t.customer_name || null,
            received_at: t.received_at,
        }));
    } catch (e) { console.warn('[nav/attention] threads:', e.message); }

    out.mail = unmatched.concat(threads)
        .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));

    // ── Web-bestillinger der ALDRIG blev til en bon (#638) ──────────
    //
    // Panelets hovedliste ovenfor går `FROM bons JOIN web_orders` — en ordre
    // uden bon falder derfor helt ud af den. Det var præcis hullet: rækken
    // blev gemt, og ingen kunne se den. Her er den modsatte vej ind.
    //
    // `status='afvist'` holdes UDE med vilje: kunden fik en forklaring og en
    // vej videre (deadline, ferielukket), så der er ingen handling at tage.
    // De ligger i web_orders til rapportering — GET /api/web-orders?status=afvist.
    try {
        out.failed_orders = db.prepare(`
            SELECT wo.id             AS web_order_id,
                   wo.customer_name  AS customer_name,
                   wo.customer_email AS customer_email,
                   wo.customer_phone AS customer_phone,
                   wo.company        AS company_name,
                   wo.delivery_date  AS delivery_date,
                   wo.delivery_time  AS delivery_time,
                   wo.pax            AS pax,
                   wo.failure_reason AS failure_reason,
                   wo.created_at     AS created_at
            FROM web_orders wo
            WHERE wo.bon_id IS NULL
              AND wo.acknowledged_at IS NULL
              AND wo.status <> 'afvist'
            ORDER BY wo.created_at DESC
            LIMIT 50
        `).all();
    } catch (e) { console.warn('[nav/attention] failed_orders:', e.message); }

    out.counts.web = out.web_orders.length;
    out.counts.failed = out.failed_orders.length;
    out.counts.mail = out.mail.length;
    out.counts.total = out.counts.web + out.counts.failed + out.counts.mail;

    res.set('Cache-Control', 'no-cache');
    res.json(out);
}));

module.exports = router;
