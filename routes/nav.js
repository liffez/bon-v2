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

    // ── CRM indbakke: ufordelte mails ───────────────────────────────────
    // Bruger mail_unmatched-tabellen (samme som GET /api/mail/unmatched)
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM mail_unmatched WHERE status = 'open'
        `).get();
        result.crm_indbakke = row?.c || 0;
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

module.exports = router;
