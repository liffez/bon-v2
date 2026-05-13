/**
 * routes/invoices.js
 * GET /api/invoices/queue — fakturerings-arbejdsliste
 *
 * MOMS-HÅNDTERING (når faktura-generering bygges):
 * - bon_lines.unit_price er INCL. moms (jf. BON_V2_PRINCIPPER.md sektion 6b)
 * - bon_lines.cost_price er EX moms
 * - bons.total_price er INCL. moms
 *
 * Faktura skal udstille linje-priser EX MOMS + separat moms-beløb (e-conomic-konvention):
 *   const { inclToExcl } = require('../db/helpers');
 *   const unit_price_excl = inclToExcl(line.unit_price);
 *   const line_total_excl = inclToExcl(line.line_total);
 *   const moms_amount     = line.line_total - line_total_excl;
 *
 * Visnings-disciplin (sektion 6c):
 * - Faktura-PDF/print: hver pris-linje har eksplicit basis-label
 * - Eksempel: "Subtotal (ex moms): X kr" + "Moms (25%): Y kr" + "Total (incl moms): Z kr"
 *
 * Se også: docs/CLAUDE_TILBUD_PRIS.md (samme moms-mønster bruges i tilbud)
 *          tests/moms_audit_e2e.test.js (verifikations-suite, T-5 case)
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');

// ─── GET /api/invoices/queue ────────────────────────────────────────────────
router.get('/queue', handle((req, res) => {
    const db = getDb();
    const includeDone = req.query.include_done === '1';
    const doneLimit   = Math.min(parseInt(req.query.limit) || 20, 100);
    const today = new Date().toISOString().slice(0, 10);

    // Pending: LEVERET + payment_type = 'invoice'
    const pending = db.prepare(`
        SELECT
            b.id,
            b.bon_number,
            b.delivery_date,
            b.pickup_time,
            b.delivery_time,
            b.pax,
            b.total_units,
            b.customer_wishes  AS customer_note,
            b.invoice_info     AS invoice_note,
            b.internal_notes   AS internal_note,
            b.kitchen_info     AS kitchen_note,
            b.delivery_method,
            b.courier_arrival_time,
            b.day_contact_name,
            b.day_contact_phone,
            b.payment_type,
            sd.code AS status_code,
            CAST(julianday(?) - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery,
            -- Customer
            c.id            AS customer_id,
            c.first_name    AS customer_first_name,
            c.last_name     AS customer_last_name,
            c.phone         AS customer_phone,
            c.email         AS customer_email,
            c.economic_contact_id,
            c.economic_customer_id AS customer_economic_customer_id,
            -- Company
            co.id           AS company_id,
            co.name         AS company_name,
            co.legal_name   AS company_legal_name,
            co.cvr          AS company_cvr,
            co.ean          AS company_ean,
            co.invoice_method AS company_invoice_method,
            co.economic_customer_id AS company_economic_customer_id,
            -- Price category
            pc.code         AS price_category_code,
            pc.label        AS price_category_label,
            -- Address
            a.street_name   AS addr_street_name,
            a.street_nr     AS addr_street_nr,
            a.postal_code   AS addr_postal_code,
            a.city          AS addr_city
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN customers c ON c.id = b.customer_id
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        LEFT JOIN addresses a ON a.id = b.delivery_address_id
        WHERE sd.code = 'LEVERET'
          AND b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY b.delivery_date ASC
    `).all(today);

    // Lines for each pending bon
    const lineStmt = db.prepare(`
        SELECT id, product_name, quantity, unit, unit_price, line_total,
               special_request, co2e, notes, is_accessory
        FROM bon_lines WHERE bon_id = ? ORDER BY sort_order, id
    `);

    for (const bon of pending) {
        bon.lines = lineStmt.all(bon.id);
        // line_total ekskluderer accessory-lines (bestik, servietter) — matcher
        // konventionen i reports.js + dashboard.js + total_units-aggregeringer.
        // bon.lines[] beholdes komplet så frontend kan vise tilbehør separat.
        bon.line_total = bon.lines
            .filter(l => !l.is_accessory)
            .reduce((sum, l) => sum + (l.line_total || 0), 0);
    }

    // Done: FAKTURERET/AFSLUTTET (optional)
    let done = [];
    if (includeDone) {
        done = db.prepare(`
            SELECT
                b.id,
                b.bon_number,
                b.delivery_date,
                b.pax,
                sd.code AS status_code,
                c.first_name || ' ' || COALESCE(c.last_name,'') AS customer_name,
                co.name AS company_name,
                co.ean  AS company_ean,
                b.payment_type,
                (SELECT SUM(bl3.line_total) FROM bon_lines bl3
                 WHERE bl3.bon_id = b.id
                   AND (bl3.is_accessory = 0 OR bl3.is_accessory IS NULL)
                ) AS line_total,
                (SELECT MAX(ch.created_at) FROM changelog ch
                 WHERE ch.entity_type = 'bon' AND ch.entity_id = b.id
                   AND ch.action = 'status_change' AND ch.new_value = (SELECT CAST(sd2.id AS TEXT) FROM status_definitions sd2 WHERE sd2.code = 'FAKTURERET')
                ) AS faktureret_date
            FROM bons b
            JOIN status_definitions sd ON sd.id = b.status_id
            LEFT JOIN customers c ON c.id = b.customer_id
            LEFT JOIN companies co ON co.id = b.company_id
            WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
              AND b.payment_type = 'invoice'
              AND (b.is_offer = 0 OR b.is_offer IS NULL)
              AND b.delivery_date >= date(?, '-60 days')
            ORDER BY b.delivery_date DESC
            LIMIT ?
        `).all(today, doneLimit);
    }

    // Summary
    const pendingAmount = pending.reduce((sum, b) => sum + (b.line_total || 0), 0);
    const eanCount = pending.filter(b => b.company_ean).length;

    // Done this month
    const monthStart = today.slice(0, 7) + '-01';
    const doneMonth = db.prepare(`
        SELECT COUNT(DISTINCT b.id) AS count,
               COALESCE(SUM(bl.line_total), 0) AS amount
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
          AND b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
          AND b.delivery_date >= ?
    `).get(monthStart);

    res.json({
        pending: pending.map(formatBon),
        done,
        summary: {
            pending_count:    pending.length,
            pending_amount:   pendingAmount,
            ean_count:        eanCount,
            done_count_month: doneMonth.count,
            done_amount_month: doneMonth.amount,
        }
    });
}));

function formatBon(row) {
    return {
        id:               row.id,
        bon_number:       row.bon_number,
        delivery_date:    row.delivery_date,
        pickup_time:      row.pickup_time,
        delivery_time:    row.delivery_time,
        pax:              row.pax,
        total_units:      row.total_units,
        payment_type:     row.payment_type,
        customer_note:    row.customer_note,
        invoice_note:     row.invoice_note,
        internal_note:    row.internal_note,
        kitchen_note:     row.kitchen_note,
        status_code:      row.status_code,
        days_since_delivery: row.days_since_delivery,
        delivery_method:  row.delivery_method,
        day_contact_name: row.day_contact_name,
        day_contact_phone: row.day_contact_phone,
        price_category_code:  row.price_category_code,
        price_category_label: row.price_category_label,
        customer: {
            id:         row.customer_id,
            first_name: row.customer_first_name,
            last_name:  row.customer_last_name,
            phone:      row.customer_phone,
            email:      row.customer_email,
            economic_contact_id:  row.economic_contact_id,
            economic_customer_id: row.customer_economic_customer_id,
        },
        company: row.company_id ? {
            id:                   row.company_id,
            name:                 row.company_name,
            legal_name:           row.company_legal_name,
            cvr:                  row.company_cvr,
            ean:                  row.company_ean,
            invoice_method:       row.company_invoice_method,
            economic_customer_id: row.company_economic_customer_id,
        } : null,
        delivery_address: row.addr_street_name ? {
            street_name: row.addr_street_name,
            street_nr:   row.addr_street_nr,
            postal_code: row.addr_postal_code,
            city:        row.addr_city,
        } : null,
        lines:      row.lines,
        line_total: row.line_total,
    };
}

module.exports = router;
