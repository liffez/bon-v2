/**
 * routes/crm.js
 * ════════════════════════════════════════════════════════════
 * CRM API — portet fra Python-prototype (crm_server.py)
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, getUserId, logChange, transaction } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const {
    findCustomerByEmail: _liFindCustomerByEmail,
    ensureContactPoint:  _liEnsureContactPoint,
    setLeadStageIfNew:   _liSetLeadStageIfNew,
} = require('../services/leadCreate');

router.use(requireAuth());

// ─── GET /stats ─────────────────────────────────────────────
router.get('/stats', handle((req, res) => {
    const db = getDb();
    const stats = {};

    stats.service_calls_pending = db.prepare(
        "SELECT COUNT(*) as c FROM v_service_calls_pending"
    ).get().c;

    stats.callbacks_pending = db.prepare(
        "SELECT COUNT(*) as c FROM v_callbacks_pending"
    ).get().c;

    stats.hard_to_reach = db.prepare(
        "SELECT COUNT(*) as c FROM v_hard_to_reach"
    ).get().c;

    const rr = db.prepare(`
        SELECT COALESCE(
            ROUND(100.0 * SUM(CASE WHEN result='reached' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 0),
            0
        ) as rate
        FROM crm_activities
        WHERE type IN ('call','service_call')
        AND created_at >= date('now','-7 days')
    `).get();
    stats.reach_rate = rr.rate;

    const stages = db.prepare("SELECT stage, COUNT(*) as c FROM crm_customer_meta GROUP BY stage").all();
    for (const row of stages) {
        stats['stage_' + row.stage] = row.c;
    }

    stats.total_customers = db.prepare("SELECT COUNT(*) as c FROM customers").get().c;
    stats.total_companies = db.prepare("SELECT COUNT(*) as c FROM companies WHERE is_internal=0").get().c;
    stats.bons_today = db.prepare("SELECT COUNT(*) as c FROM bons WHERE delivery_date = date('now')").get().c;

    const week = db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN type IN ('call','service_call') AND result='reached' THEN 1 ELSE 0 END) as calls_reached,
            SUM(CASE WHEN type IN ('call','service_call') THEN 1 ELSE 0 END) as calls_total,
            SUM(CASE WHEN type = 'note' THEN 1 ELSE 0 END) as notes
        FROM crm_activities
        WHERE created_at >= date('now','-7 days')
    `).get();
    stats.week_total = week.total || 0;
    stats.week_calls_reached = week.calls_reached || 0;
    stats.week_calls_total = week.calls_total || 0;
    stats.week_notes = week.notes || 0;

    res.json(stats);
}));

// ─── GET /meetings/upcoming ─────────────────────────────────
// Kommende bookede møder (planlagte, ikke afsluttede).
router.get('/meetings/upcoming', handle((req, res) => {
    const db = getDb();
    const days = parseInt(req.query.days) || 30;
    const limit = parseInt(req.query.limit) || 20;

    const rows = db.prepare(`
        SELECT a.id, a.due_at, a.duration_min, a.guest_count, a.event_type,
               a.text, a.booked_via, a.created_at,
               a.customer_id, a.owner_user_id,
               c.first_name, c.last_name, c.email, c.phone,
               co.id AS company_id, co.name AS company_name,
               mt.label AS meeting_type_label, mt.emoji AS meeting_type_emoji,
               u.name AS owner_name
        FROM crm_activities a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN companies co ON co.id = c.company_id
        LEFT JOIN meeting_types mt ON mt.id = a.meeting_type_id
        LEFT JOIN users u ON u.id = a.owner_user_id
        WHERE a.type = 'meeting'
          AND a.done_at IS NULL
          AND DATE(a.due_at) >= date('now')
          AND DATE(a.due_at) <= date('now', '+' || ? || ' days')
        ORDER BY a.due_at ASC
        LIMIT ?
    `).all(days, limit);

    res.json(rows);
}));

// ─── GET /briefing ──────────────────────────────────────────
router.get('/briefing', handle((req, res) => {
    const db = getDb();
    const items = [];

    const sc = db.prepare("SELECT COUNT(*) as c FROM v_service_calls_pending").get().c;
    if (sc > 0) items.push({ icon: '📞', text: sc + ' service-kald venter', type: 'action', link: 'svc' });

    const cb = db.prepare("SELECT COUNT(*) as c FROM v_callbacks_pending").get().c;
    if (cb > 0) items.push({ icon: '🔔', text: cb + ' callback' + (cb > 1 ? 's' : '') + ' at følge op', type: 'action', link: 'callbacks' });

    const upcomingMeetings = db.prepare(`
        SELECT COUNT(*) as c FROM crm_activities
        WHERE type = 'meeting' AND done_at IS NULL
          AND DATE(due_at) BETWEEN date('now') AND date('now', '+7 days')
    `).get().c;
    if (upcomingMeetings > 0) items.push({
        icon: '🤝',
        text: upcomingMeetings + ' bookede møder' + (upcomingMeetings === 1 ? '' : '') + ' denne uge',
        type: 'action', link: 'meetings'
    });

    const overdue = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            co.name AS company_name,
            ostats.days_since,
            ostats.avg_gap
        FROM customers c
        JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON c.id = cm.customer_id
        JOIN (
            SELECT customer_id,
                CAST(julianday('now') - julianday(MAX(delivery_date)) AS INTEGER) AS days_since,
                ROUND(CAST(julianday(MAX(delivery_date)) - julianday(MIN(delivery_date)) AS REAL) / NULLIF(COUNT(*)-1, 0), 0) AS avg_gap,
                SUM(total_price) AS revenue
            FROM bons WHERE is_internal = 0
            GROUP BY customer_id HAVING COUNT(*) >= 5
        ) ostats ON ostats.customer_id = c.id
        WHERE cm.stage IN ('active', 'vip') AND co.is_internal = 0
            AND ostats.avg_gap > 0
            AND ostats.days_since > ostats.avg_gap * 1.3
        ORDER BY ostats.revenue DESC
        LIMIT 1
    `).get();
    if (overdue) {
        const overdueDays = Math.round(overdue.days_since - overdue.avg_gap);
        items.push({
            icon: '📊',
            text: overdue.name + ' (' + overdue.company_name + ') er ' + overdueDays + 'd forsinket med bestilling',
            type: 'insight',
            customer_id: overdue.customer_id,
        });
    }

    const offers = db.prepare(`
        SELECT COUNT(*) as c FROM bons
        WHERE is_offer = 1 AND offer_status = 'sent'
        AND offer_valid_until BETWEEN date('now') AND date('now', '+3 days')
    `).get().c;
    if (offers > 0) items.push({ icon: '⏰', text: offers + ' tilbud udløber inden 3 dage', type: 'urgent', link: 'suggestions' });

    const wk = db.prepare(`
        SELECT COUNT(*) as total,
            SUM(CASE WHEN type IN ('call','service_call') THEN 1 ELSE 0 END) as calls
        FROM crm_activities WHERE created_at >= date('now', '-7 days')
    `).get();
    if (wk.total > 0) {
        items.push({ icon: '✅', text: 'Denne uge: ' + (wk.calls || 0) + ' opkald, ' + wk.total + ' aktiviteter total', type: 'progress', link: null });
    } else {
        items.push({ icon: '💪', text: 'Ingen aktiviteter logget denne uge — tid til at komme i gang!', type: 'motivation', link: null });
    }

    const season = db.prepare(`
        SELECT COUNT(DISTINCT b.customer_id) as c
        FROM bons b
        WHERE b.is_internal = 0
            AND b.delivery_date BETWEEN date('now', '-14 months') AND date('now', '-10 months')
            AND NOT EXISTS (
                SELECT 1 FROM bons b2
                WHERE b2.customer_id = b.customer_id
                AND b2.delivery_date > date('now', '-60 days')
                AND b2.is_internal = 0
            )
    `).get().c;
    if (season > 0) items.push({ icon: '📅', text: season + ' kunder bestilte på denne tid sidste år', type: 'insight' });

    res.json(items.slice(0, 6));
}));

// ─── GET /suggestions ───────────────────────────────────────
router.get('/suggestions', handle((req, res) => {
    const db = getDb();
    const category = req.query.category;
    const suggestions = [];

    // Build category filter
    let catFilter = '';
    const catArgs = [];
    if (category && category !== 'all') {
        catFilter = "AND b1.price_category_id = (SELECT id FROM price_categories WHERE code = ?)";
        catArgs.push(category);
    }

    // 1. OVERDUE CUSTOMERS
    const overdueRows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone,
            co.name AS company_name,
            cm.stage,
            ostats.order_count,
            ostats.avg_interval_days,
            ostats.last_order,
            ostats.days_since,
            ostats.total_revenue
        FROM customers c
        JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON c.id = cm.customer_id
        JOIN (
            SELECT
                b1.customer_id,
                COUNT(*) AS order_count,
                MAX(b1.delivery_date) AS last_order,
                CAST(julianday('now') - julianday(MAX(b1.delivery_date)) AS INTEGER) AS days_since,
                SUM(b1.total_price) AS total_revenue,
                ROUND(
                    CAST(julianday(MAX(b1.delivery_date)) - julianday(MIN(b1.delivery_date)) AS REAL)
                    / NULLIF(COUNT(*) - 1, 0)
                , 0) AS avg_interval_days
            FROM bons b1
            WHERE b1.is_internal = 0
                ${catFilter.replace(/b_inner/g, 'b1')}
            GROUP BY b1.customer_id
            HAVING COUNT(*) >= 5
        ) ostats ON ostats.customer_id = c.id
        WHERE co.is_internal = 0
            AND cm.stage IN ('active', 'vip')
            AND ostats.avg_interval_days > 0
            AND ostats.days_since > ostats.avg_interval_days * 1.3
        ORDER BY ostats.total_revenue DESC
        LIMIT 10
    `).all(...catArgs);

    for (const r of overdueRows) {
        const overdueDays = r.days_since - Math.round(r.avg_interval_days);
        suggestions.push({
            type: 'overdue_customer',
            priority: Math.min(3, 1 + Math.floor(overdueDays / 14)),
            icon: '📞',
            title: r.name + ' er ' + overdueDays + 'd forsinket',
            detail: r.company_name + ' · ' + Math.round(r.total_revenue).toLocaleString('da-DK') + ' kr total · ' + r.order_count + ' ordrer',
            reason: 'Bestiller normalt hver ~' + Math.round(r.avg_interval_days) + ' dage. Sidst: ' + r.last_order + '. Det er nu ' + r.days_since + 'd siden — ' + overdueDays + 'd over normalen.',
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            action: 'call',
        });
    }

    // 2. SEASON CUSTOMERS
    const seasonRows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone,
            co.name AS company_name,
            b1.delivery_date AS last_year_date,
            b1.pax,
            b1.total_price,
            pc.code AS price_category
        FROM bons b1
        JOIN customers c ON b1.customer_id = c.id
        JOIN companies co ON b1.company_id = co.id
        LEFT JOIN price_categories pc ON b1.price_category_id = pc.id
        WHERE b1.is_internal = 0
            AND b1.delivery_date BETWEEN date('now', '-14 months') AND date('now', '-10 months')
            AND NOT EXISTS (
                SELECT 1 FROM bons b2
                WHERE b2.customer_id = c.id
                AND b2.delivery_date > date('now', '-60 days')
                AND b2.is_internal = 0
            )
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a
                WHERE a.customer_id = c.id
                AND a.created_at > date('now', '-30 days')
            )
            ${catFilter.replace(/b_inner/g, 'b1')}
        GROUP BY c.id
        ORDER BY b1.total_price DESC
        LIMIT 8
    `).all(...catArgs);

    for (const r of seasonRows) {
        suggestions.push({
            type: 'season_reminder',
            priority: 2,
            icon: '📅',
            title: r.name + ' bestilte på denne tid sidste år',
            detail: r.company_name + ' · ' + r.pax + ' pax · ' + Math.round(r.total_price).toLocaleString('da-DK') + ' kr',
            reason: 'Bestilte ' + r.pax + ' pax d. ' + r.last_year_date + ' for ' + Math.round(r.total_price).toLocaleString('da-DK') + ' kr.',
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            action: 'call',
        });
    }

    // 3. UNCONTACTED LEADS
    const leadRows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone, c.email,
            co.name AS company_name,
            cm.created_at,
            CAST(julianday('now') - julianday(cm.created_at) AS INTEGER) AS days_as_lead
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON c.id = cm.customer_id
        WHERE cm.stage = 'lead'
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a WHERE a.customer_id = c.id
            )
        ORDER BY cm.created_at ASC
        LIMIT 5
    `).all();

    for (const r of leadRows) {
        suggestions.push({
            type: 'uncontacted_lead',
            priority: r.days_as_lead > 3 ? 3 : 2,
            icon: '🆕',
            title: 'Nyt lead: ' + r.name + ' — ikke kontaktet',
            detail: (r.company_name || 'Ukendt firma') + ' · ' + r.days_as_lead + 'd siden oprettelse',
            reason: 'Oprettet som lead for ' + r.days_as_lead + ' dage siden. Ingen aktiviteter logget endnu.',
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            action: 'call',
        });
    }

    // 4. EXPIRING OFFERS
    const offerRows = db.prepare(`
        SELECT
            b.id AS bon_id, b.bon_number, b.total_price,
            b.offer_valid_until,
            CAST(julianday(b.offer_valid_until) - julianday('now') AS INTEGER) AS days_left,
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone,
            co.name AS company_name
        FROM bons b
        JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE b.is_offer = 1
            AND b.offer_status = 'sent'
            AND b.offer_valid_until BETWEEN date('now') AND date('now', '+5 days')
        ORDER BY b.offer_valid_until ASC
    `).all();

    for (const r of offerRows) {
        const urgency = r.days_left <= 1 ? 'UDLØBER I MORGEN!' : 'udløber om ' + r.days_left + ' dage.';
        suggestions.push({
            type: 'expiring_offer',
            priority: r.days_left <= 1 ? 1 : 2,
            icon: '⏰',
            title: 'Tilbud ' + r.bon_number + ' udløber om ' + r.days_left + 'd',
            detail: r.name + ' · ' + r.company_name + ' · ' + Math.round(r.total_price).toLocaleString('da-DK') + ' kr',
            reason: 'Tilbud sendt til ' + r.name + ' (' + r.company_name + ') på ' + Math.round(r.total_price).toLocaleString('da-DK') + ' kr. ' + urgency,
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            bon_id: r.bon_id,
            action: 'call',
        });
    }

    // 5. HIGH-VALUE DORMANT
    const dormantRows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone,
            co.name AS company_name,
            SUM(b1.total_price) AS total_revenue,
            COUNT(b1.id) AS order_count,
            MAX(b1.delivery_date) AS last_order,
            CAST(julianday('now') - julianday(MAX(b1.delivery_date)) AS INTEGER) AS days_since
        FROM customers c
        JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON c.id = cm.customer_id
        JOIN bons b1 ON b1.customer_id = c.id AND b1.is_internal = 0
        WHERE cm.stage = 'dormant'
            AND co.is_internal = 0
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a
                WHERE a.customer_id = c.id AND a.created_at > date('now', '-30 days')
            )
            ${catFilter.replace(/b_inner/g, 'b1')}
        GROUP BY c.id
        HAVING total_revenue > 30000
        ORDER BY total_revenue DESC
        LIMIT 5
    `).all(...catArgs);

    for (const r of dormantRows) {
        suggestions.push({
            type: 'dormant_highvalue',
            priority: 2,
            icon: '💤',
            title: r.name + ' — ' + Math.round(r.total_revenue).toLocaleString('da-DK') + ' kr kunde sover',
            detail: r.company_name + ' · ' + r.order_count + ' ordrer · sidst ' + r.last_order,
            reason: 'Har købt for ' + Math.round(r.total_revenue).toLocaleString('da-DK') + ' kr over ' + r.order_count + ' ordrer. Sidst bestilt ' + r.last_order + ' (' + r.days_since + 'd siden).',
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            action: 'call',
        });
    }

    // 6. GLAD KUNDE → BED OM ANBEFALING
    //    Kunder med en positiv stemning registreret for nylig, som vi endnu ikke har
    //    bedt om en anbefaling/anmeldelse. Rider 100% på sentiment der allerede fanges
    //    af servicekaldet. Dedupe på purpose 'anbefaling'.
    //    Tærskler navngivet (jf. CLAUDE_CRM_TRIKS.md revision pkt. 8 — ingen magiske
    //    tal i WHERE). Spejles af scripts/test-crm-review.js — hold queries i sync.
    const REVIEW_POSITIVE_WINDOW_DAYS = 21;   // hvor frisk skal den positive stemning være
    const REVIEW_DEDUPE_DAYS          = 180;  // bed ikke om anbefaling oftere end hvert halve år
    const reviewRows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.phone,
            co.name AS company_name,
            a.sentiment,
            a.created_at AS sentiment_at,
            a.text AS last_note
        FROM crm_activities a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON cm.customer_id = c.id
        WHERE a.sentiment = 'positive'
            AND a.created_at > date('now', ?)
            AND cm.stage IN ('active', 'vip')
            -- ekskludér interne firmaer; privatkunder (uden firma) er valide
            AND (co.is_internal = 0 OR co.id IS NULL)
            -- kun den seneste stemning pr. kunde — en nyere neutral/negativ aflyser
            AND a.id = (
                SELECT a2.id FROM crm_activities a2
                WHERE a2.customer_id = c.id AND a2.sentiment IS NOT NULL
                ORDER BY a2.created_at DESC LIMIT 1
            )
            -- dedupe: ikke allerede bedt om anbefaling inden for vinduet
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a3
                JOIN activity_purposes ap ON ap.id = a3.purpose_id
                WHERE a3.customer_id = c.id
                    AND ap.key = 'anbefaling'
                    AND a3.created_at > date('now', ?)
            )
            -- service-opfølgning, ikke markedsføring → kun do_not_contact gælder
            -- (jf. consent-doktrin i routes/campaigns.js; INTET marketing_consent-krav)
            AND COALESCE(cm.do_not_contact, 0) != 1
        ORDER BY a.created_at DESC
        LIMIT 6
    `).all('-' + REVIEW_POSITIVE_WINDOW_DAYS + ' days', '-' + REVIEW_DEDUPE_DAYS + ' days');

    for (const r of reviewRows) {
        suggestions.push({
            type: 'review_ask',
            priority: 2,
            icon: '⭐',
            title: r.name + ' var glad — bed om en anbefaling',
            detail: (r.company_name || 'Privat') + ' · positiv ' + (r.sentiment_at || '').substring(0, 10),
            reason: 'Sidste kontakt var positiv' +
                (r.last_note ? ' ("' + r.last_note.substring(0, 60) + '")' : '') +
                '. Godt øjeblik at bede om en Google-anmeldelse eller en henvisning.',
            customer_id: r.customer_id,
            customer_name: r.name,
            company_name: r.company_name,
            phone: r.phone,
            action: 'review',
        });
    }

    suggestions.sort((a, b) => a.priority - b.priority);
    res.json(suggestions);
}));

// ─── GET /service-calls ─────────────────────────────────────
router.get('/service-calls', handle((req, res) => {
    const db = getDb();
    const days = parseInt(req.query.days) || 7;
    const rows = db.prepare(`
        SELECT
            b.id AS bon_id, b.bon_number, b.delivery_date, b.delivery_time,
            b.pax, b.total_units, b.total_price,
            c.id AS customer_id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email,
            co.name AS company_name,
            CAST(julianday('now') - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery,
            (SELECT a.sentiment FROM crm_activities a
                WHERE a.customer_id = c.id AND a.sentiment IS NOT NULL
                ORDER BY a.created_at DESC LIMIT 1) AS last_sentiment,
            (SELECT a.created_at FROM crm_activities a
                WHERE a.customer_id = c.id AND a.sentiment IS NOT NULL
                ORDER BY a.created_at DESC LIMIT 1) AS last_sentiment_at,
            (SELECT a.text FROM crm_activities a
                WHERE a.customer_id = c.id AND a.text IS NOT NULL AND a.text != ''
                ORDER BY a.created_at DESC LIMIT 1) AS last_note,
            (SELECT a.created_at FROM crm_activities a
                WHERE a.customer_id = c.id AND a.text IS NOT NULL AND a.text != ''
                ORDER BY a.created_at DESC LIMIT 1) AS last_note_at
        FROM bons b
        JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN ('LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET')
            AND b.is_internal = 0
            AND julianday('now') - julianday(b.delivery_date) BETWEEN 0 AND ?
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a
                WHERE a.bon_id = b.id AND a.type = 'service_call'
            )
        ORDER BY b.delivery_date DESC
    `).all(days);
    res.json(rows);
}));

// ─── GET /customers ─────────────────────────────────────────
router.get('/customers', handle((req, res) => {
    const db = getDb();
    const { stage, q, category, order_after, order_before, company_id } = req.query;
    const limit = parseInt(req.query.limit) || 50;

    const where = ["c.is_active = 1"];
    let bonFilter = "b.is_internal = 0";
    const having = [];
    const args = [];

    if (stage && stage !== 'all') {
        where.push("cm.stage = ?");
        args.push(stage);
    }
    if (company_id) {
        where.push("c.company_id = ?");
        args.push(parseInt(company_id, 10));
    }
    if (q) {
        where.push("(c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR co.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)");
        const s = '%' + q + '%';
        args.push(s, s, s, s);
    }
    if (category && category !== 'all') {
        bonFilter += " AND b.price_category_id = (SELECT id FROM price_categories WHERE code = ?)";
        args.push(category);
    }
    if (order_after) {
        having.push("MAX(b.delivery_date) >= ?");
        args.push(order_after);
    }
    if (order_before) {
        having.push("MAX(b.delivery_date) <= ?");
        args.push(order_before);
    }

    const havingClause = having.length > 0 ? 'HAVING ' + having.join(' AND ') : '';
    args.push(limit);

    const rows = db.prepare(`
        SELECT c.id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.email, c.phone,
            co.id AS company_id, co.name AS company_name,
            cm.stage, cm.tags, cm.owner_user_id, cm.last_contact_at,
            COUNT(DISTINCT b.id) AS total_orders,
            COALESCE(SUM(b.total_price), 0) AS total_revenue,
            ROUND(AVG(b.total_price), 0) AS avg_order_value,
            MIN(b.delivery_date) AS first_order_date,
            MAX(b.delivery_date) AS last_order_date,
            CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since_last
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN crm_customer_meta cm ON c.id = cm.customer_id
        LEFT JOIN bons b ON b.customer_id = c.id AND ${bonFilter}
        WHERE ${where.join(' AND ')}
        GROUP BY c.id
        ${havingClause}
        ORDER BY total_revenue DESC
        LIMIT ?
    `).all(...args);

    res.json(rows);
}));

// ─── GET /companies ─────────────────────────────────────────
// Aggregeret listview af firmaer med kunde- og bon-statistik.
// Bruges af crm-firmaer-listview (Kontakter → Firmaer-fane).
router.get('/companies', handle((req, res) => {
    const db = getDb();
    const { stage, q, order_after, order_before } = req.query;
    const limit = parseInt(req.query.limit, 10) || 100;

    const where = ['co.is_active = 1', 'co.is_internal = 0'];
    const having = [];
    const args = [];

    if (q) {
        where.push("(co.name LIKE ? OR co.cvr LIKE ? OR COALESCE(co.legal_name,'') LIKE ? OR COALESCE(co.alternate_names,'') LIKE ?)");
        const s = '%' + q + '%';
        args.push(s, s, s, s);
    }
    // order_after/order_before filtrerer på sidste ordre — referer nu det subquery-aliasede felt
    // i WHERE-clause på det yderste SELECT (HAVING virker ikke uden b-join længere).
    // Bygges som ekstra outer-where (se nedenfor).
    const orderFilters = [];
    if (order_after)  { orderFilters.push('last_order_date >= ?'); args.push(order_after); }
    if (order_before) { orderFilters.push('last_order_date <= ?'); args.push(order_before); }

    const stageFilter = stage && stage !== 'all'
        ? `AND aggregated_stage = ?` : '';
    if (stageFilter) args.push(stage);

    const havingClause = having.length > 0 ? 'HAVING ' + having.join(' AND ') : '';
    const orderFilterClause = orderFilters.length > 0 ? 'AND ' + orderFilters.join(' AND ') : '';
    args.push(limit);

    // VIGTIGT: bons-stats beregnes via subqueries, IKKE via LEFT JOIN bons.
    // Hvis vi joiner bons direkte mens vi også joiner customers, multiplicerer SUM/MAX
    // sig med antallet af kontakter under firmaet (84 bons × 39 kontakter = 12,5 mio kr
    // i stedet for de reelle 321k). Subqueries holder hver aggregering isoleret.
    const sql = `
        WITH agg AS (
            SELECT co.id,
                   co.name,
                   co.legal_name,
                   co.cvr,
                   co.ean,
                   co.last_enriched_at,
                   COUNT(DISTINCT c.id) AS contact_count,
                   (SELECT COUNT(*)              FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)) AS total_orders,
                   (SELECT COALESCE(SUM(total_price), 0) FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)) AS total_revenue,
                   (SELECT MAX(delivery_date)    FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)) AS last_order_date,
                   (SELECT CAST(julianday('now') - julianday(MAX(delivery_date)) AS INTEGER)
                      FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)) AS days_since_last,
                   CASE
                       WHEN MAX(CASE WHEN cm.stage = 'vip' THEN 1 ELSE 0 END) = 1 THEN 'vip'
                       WHEN (SELECT MAX(delivery_date) FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)) IS NULL
                            OR julianday('now') - julianday(
                                (SELECT MAX(delivery_date) FROM bons WHERE company_id = co.id AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL))
                            ) > 180 THEN 'dormant'
                       ELSE 'active'
                   END AS aggregated_stage,
                   (SELECT COUNT(*) FROM entity_flags ef
                    WHERE ef.entity_type = 'company' AND ef.entity_id = co.id
                      AND ef.dismissed_at IS NULL
                   ) AS flag_count
              FROM companies co
         LEFT JOIN customers c ON c.company_id = co.id AND c.is_active = 1
         LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
             WHERE ${where.join(' AND ')}
          GROUP BY co.id
            ${havingClause}
        )
        SELECT * FROM agg
         WHERE 1=1 ${stageFilter} ${orderFilterClause}
      ORDER BY total_revenue DESC, contact_count DESC, name ASC
         LIMIT ?
    `;
    res.json(db.prepare(sql).all(...args));
}));

// ─── GET /customer/:id ──────────────────────────────────────
router.get('/customer/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const customer = db.prepare(`
        SELECT c.*, co.name as company_name, co.ean, co.invoice_method,
               cm.stage, cm.tags, cm.owner_user_id, cm.marketing_consent,
               cm.do_not_contact, cm.last_contact_at, cm.next_followup_at
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN crm_customer_meta cm ON c.id = cm.customer_id
        WHERE c.id = ?
    `).get(id);

    if (!customer) return res.status(404).json({ error: 'Kunde ikke fundet' });

    const stats = db.prepare(`
        SELECT
            COUNT(b.id) as total_orders,
            COALESCE(SUM(b.total_price),0) as total_revenue,
            ROUND(AVG(b.total_price),0) as avg_order,
            MAX(b.delivery_date) as last_order,
            MIN(b.delivery_date) as first_order
        FROM bons b WHERE b.customer_id = ? AND b.is_internal = 0 AND (b.is_offer = 0 OR b.is_offer IS NULL)
    `).get(id);

    const orders = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.pax, b.total_price,
               sd.code as status, sd.label as status_label
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.customer_id = ? AND b.is_internal = 0 AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY b.delivery_date DESC LIMIT 10
    `).all(id);

    const activities = db.prepare(`
        SELECT a.*, u.name as user_name, u.name as owner_name, b.bon_number,
               mt.label AS meeting_type_label, mt.emoji AS meeting_type_emoji,
               cr.label AS contact_reason_label, cr.emoji AS contact_reason_emoji,
               p.label AS purpose_label, p.emoji AS purpose_emoji
        FROM crm_activities a
        LEFT JOIN users u ON a.owner_user_id = u.id
        LEFT JOIN bons b ON a.bon_id = b.id
        LEFT JOIN meeting_types mt ON mt.id = a.meeting_type_id
        LEFT JOIN contact_reasons cr ON cr.id = a.contact_reason_id
        LEFT JOIN activity_purposes p ON a.purpose_id = p.id
        WHERE a.customer_id = ?
        ORDER BY a.created_at DESC LIMIT 20
    `).all(id);

    // Dismissed flag som syntetiske aktivitets-rows (CLAUDE_KUNDE_FLAGS.md fase 7).
    // Vises som læse-only entries i timeline ved siden af crm_activities.
    // Inkluderer både kunde-flag og firma-flag (sidstnævnte hvis kunden har company_id).
    const dismissedConds = ["(f.entity_type = 'customer' AND f.entity_id = ?)"];
    const dismissedArgs  = [id];
    if (customer.company_id) {
        dismissedConds.push("(f.entity_type = 'company' AND f.entity_id = ?)");
        dismissedArgs.push(customer.company_id);
    }
    const dismissedFlags = db.prepare(`
        SELECT f.id, f.title, f.body, f.dismiss_note, f.entity_type,
               f.dismissed_at, f.dismissed_on_bon_id, f.dismissed_by_user_id,
               u.name AS user_name, u.name AS owner_name,
               b.bon_number
        FROM entity_flags f
        LEFT JOIN users u ON f.dismissed_by_user_id = u.id
        LEFT JOIN bons  b ON f.dismissed_on_bon_id  = b.id
        WHERE f.dismissed_at IS NOT NULL AND (${dismissedConds.join(' OR ')})
        ORDER BY f.dismissed_at DESC LIMIT 20
    `).all(...dismissedArgs);

    // Form de dismissed-rows så de matcher crm_activities-shape som timelinen forventer
    const synthetic = dismissedFlags.map(f => ({
        id: 'flag_' + f.id,
        type: 'dismissed_flag',
        text: f.title + (f.body ? '\n' + f.body : ''),
        note: f.dismiss_note,
        created_at: f.dismissed_at,
        bon_id: f.dismissed_on_bon_id,
        bon_number: f.bon_number,
        owner_user_id: f.dismissed_by_user_id,
        user_name: f.user_name,
        owner_name: f.owner_name,
        flag_entity_type: f.entity_type,
    }));

    // Merge + sortér på created_at DESC. crm_activities har normalt LIMIT 20 — vi
    // beholder den begrænsning samlet (max 20 entries i timelinen).
    const mergedActivities = [...activities, ...synthetic]
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 20);

    const products = db.prepare(`
        SELECT bl.product_name, SUM(bl.quantity) as total_qty, COUNT(DISTINCT b.id) as order_count
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        WHERE b.customer_id = ? AND COALESCE(bl.category,'') NOT IN ('06 Emballage','x-Levering','Emballage','x- Service')
        GROUP BY bl.product_name
        ORDER BY total_qty DESC LIMIT 8
    `).all(id);

    // RFM-data for firmaet
    let rfm = null;
    if (customer.company_id) {
        rfm = db.prepare(`
            SELECT r_score, f_score, m_score, rfm_total, stage AS rfm_stage,
                   stage_locked, order_count AS rfm_orders, total_guests AS rfm_guests,
                   total_revenue AS rfm_revenue, computed_at AS rfm_computed_at
            FROM rfm_scores WHERE company_id = ?
        `).get(customer.company_id);
    }

    // Aktive flag på kunden (jf. docs/CLAUDE_KUNDE_FLAGS.md).
    // Ack-historik begrænset til seneste 10 til display — fuld liste kan
    // hentes via /api/flags?include_dismissed=1.
    const flags = db.prepare(`
        SELECT f.*,
               u.name AS created_by_name,
               (SELECT COUNT(*) FROM flag_acks WHERE flag_id = f.id) AS ack_count
        FROM entity_flags f
        LEFT JOIN users u ON f.created_by_user_id = u.id
        WHERE f.entity_type = 'customer' AND f.entity_id = ? AND f.dismissed_at IS NULL
        ORDER BY f.created_at DESC
    `).all(id);
    const ackBonsStmt = db.prepare(`
        SELECT b.id, b.bon_number, fa.acked_at
        FROM flag_acks fa JOIN bons b ON fa.bon_id = b.id
        WHERE fa.flag_id = ? ORDER BY fa.acked_at DESC LIMIT 10
    `);
    for (const f of flags) f.ack_bons = ackBonsStmt.all(f.id);

    const contact_points = db.prepare(`
        SELECT id, kind, value, source, is_public, is_primary, purpose,
               verified_at, last_seen_at, notes, created_at, updated_at
          FROM contact_points
         WHERE entity_type = 'customer' AND entity_id = ? AND is_active = 1
         ORDER BY is_primary DESC, kind ASC, created_at ASC
    `).all(id);

    res.json({
        customer, stats, orders,
        activities: mergedActivities,
        products, rfm, flags, contact_points,
    });
}));

// ─── GET /company/:id ───────────────────────────────────────
// Detaljeret firma-data med aggregerede tal, contact_points,
// kunder under firmaet, RFM-data, og adresse-info.
// Bruges af Firma 360°-viewet (office/views/crm-firma360.js).
router.get('/company/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ugyldigt id' });

    const company = db.prepare(`
        SELECT c.*,
               a.street_name, a.street_nr, a.postal_code, a.city
          FROM companies c
     LEFT JOIN addresses a ON c.address_id = a.id
         WHERE c.id = ?
    `).get(id);
    if (!company) return res.status(404).json({ error: 'Firma ikke fundet' });

    // Aggregeret stats fra bons
    const stats = db.prepare(`
        SELECT
            COUNT(b.id)                       AS total_orders,
            COALESCE(SUM(b.total_price), 0)   AS total_revenue,
            ROUND(AVG(b.total_price), 0)      AS avg_order_value,
            MIN(b.delivery_date)              AS first_order_date,
            MAX(b.delivery_date)              AS last_order_date
          FROM bons b
         WHERE b.company_id = ?
           AND b.is_internal = 0
           AND (b.is_offer = 0 OR b.is_offer IS NULL)
    `).get(id);

    const customerCounts = db.prepare(`
        SELECT
            COUNT(*) AS contact_count,
            SUM(CASE WHEN cm.stage = 'vip' THEN 1 ELSE 0 END) AS vip_count,
            SUM(CASE WHEN cm.stage = 'dormant' THEN 1 ELSE 0 END) AS dormant_count
          FROM customers c
     LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
         WHERE c.company_id = ? AND c.is_active = 1
    `).get(id);

    // Kontaktpunkter på firma-niveau
    const contact_points = db.prepare(`
        SELECT id, kind, value, source, is_public, is_primary, purpose,
               verified_at, last_seen_at, notes, created_at
          FROM contact_points
         WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
         ORDER BY is_primary DESC, kind ASC, created_at ASC
    `).all(id);

    // Kunder under firmaet
    const customers = db.prepare(`
        SELECT c.id,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
               c.email, c.phone,
               cm.stage, cm.last_contact_at,
               COUNT(DISTINCT b.id) AS order_count,
               MAX(b.delivery_date) AS last_order_date
          FROM customers c
     LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
     LEFT JOIN bons b ON b.customer_id = c.id AND b.is_internal = 0 AND (b.is_offer = 0 OR b.is_offer IS NULL)
         WHERE c.company_id = ? AND c.is_active = 1
      GROUP BY c.id
      ORDER BY last_order_date DESC NULLS LAST, order_count DESC, name ASC
    `).all(id);

    // RFM-data for firmaet
    const rfm = db.prepare(`
        SELECT r_score, f_score, m_score, rfm_total, stage AS rfm_stage,
               stage_locked, order_count AS rfm_orders, total_guests AS rfm_guests,
               total_revenue AS rfm_revenue, computed_at AS rfm_computed_at
          FROM rfm_scores WHERE company_id = ?
    `).get(id);

    // Aggregeret stage (samme logik som /companies-listview)
    let aggregated_stage = 'active';
    if ((customerCounts?.vip_count || 0) > 0) aggregated_stage = 'vip';
    else if (!stats.last_order_date) aggregated_stage = 'dormant';
    else {
        const days = Math.floor((Date.now() - new Date(stats.last_order_date).getTime()) / 86400000);
        if (days > 180) aggregated_stage = 'dormant';
    }

    // Aktive flag på firmaet (CLAUDE_KUNDE_FLAGS.md)
    const flags = db.prepare(`
        SELECT f.*,
               u.name AS created_by_name,
               (SELECT COUNT(*) FROM flag_acks WHERE flag_id = f.id) AS ack_count
        FROM entity_flags f
        LEFT JOIN users u ON f.created_by_user_id = u.id
        WHERE f.entity_type = 'company' AND f.entity_id = ? AND f.dismissed_at IS NULL
        ORDER BY f.created_at DESC
    `).all(id);
    const ackBonsStmt = db.prepare(`
        SELECT b.id, b.bon_number, fa.acked_at
        FROM flag_acks fa JOIN bons b ON fa.bon_id = b.id
        WHERE fa.flag_id = ? ORDER BY fa.acked_at DESC LIMIT 10
    `);
    for (const f of flags) f.ack_bons = ackBonsStmt.all(f.id);

    res.json({
        company,
        aggregations: {
            ...stats,
            ...customerCounts,
            aggregated_stage,
        },
        contact_points,
        customers,
        rfm,
        flags,
    });
}));

// ─── GET /customer-orders/:id ───────────────────────────────
router.get('/customer-orders/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 5;

    const orders = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.delivery_time,
               b.pax, b.total_units, b.total_price,
               sd.code as status, sd.label as status_label
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.customer_id = ? AND b.is_internal = 0 AND (b.is_offer = 0 OR b.is_offer IS NULL)
        ORDER BY b.delivery_date DESC LIMIT ?
    `).all(id, limit);

    const result = orders.map(o => {
        const lines = db.prepare(`
            SELECT product_name, category, quantity, unit_price, special_request
            FROM bon_lines
            WHERE bon_id = ?
              AND COALESCE(category,'') NOT IN ('06 Emballage','x-Levering','Emballage','x- Service')
            ORDER BY sort_order
        `).all(o.id);
        return { ...o, lines };
    });

    res.json(result);
}));

// ─── POST /activity ─────────────────────────────────────────
router.post('/activity', handle((req, res) => {
    const db = getDb();
    const { customer_id, bon_id, type, result, sentiment, text, due_at, purpose_id, campaign_id } = req.body;
    const userId = req.session.user?.id || null;

    if (!customer_id || !type || !text) {
        return res.status(400).json({ error: 'Mangler customer_id, type eller text' });
    }

    const ins = db.prepare(`
        INSERT INTO crm_activities
            (customer_id, bon_id, type, result, sentiment, text, due_at, owner_user_id, purpose_id, campaign_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        customer_id, bon_id || null, type, result || null, sentiment || null,
        text, due_at || null, userId, purpose_id || null, campaign_id || null,
    );

    const activityId = ins.lastInsertRowid;

    // Opdater last_contact_at
    db.prepare(`
        UPDATE crm_customer_meta SET last_contact_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE customer_id = ?
    `).run(customer_id);

    // Outreach (spec sektion 1.2.5): opdater campaign_members.last_activity_at.
    // - campaign_id sat: kun det ene medlemskab i den kampagne
    // - ellers: alle medlemskaber for kunden (samme adfærd som den fjernede trigger,
    //   men nu eksplicit og forudsigelig). UPDATE påvirker 0 rows hvis kunden ikke
    //   er medlem af nogen kampagne — harmløst.
    if (campaign_id) {
        db.prepare(`
            UPDATE campaign_members
            SET last_activity_at = CURRENT_TIMESTAMP
            WHERE campaign_id = ? AND customer_id = ?
        `).run(campaign_id, customer_id);
    } else {
        db.prepare(`
            UPDATE campaign_members
            SET last_activity_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
        `).run(customer_id);
    }

    // Hvis opkald med reached → markér som done
    if (['call', 'service_call'].includes(type) && result === 'reached') {
        db.prepare("UPDATE crm_activities SET done_at = CURRENT_TIMESTAMP WHERE id = ?").run(activityId);
    }

    broadcast('crm_activity_created', { id: activityId, customer_id, bon_id, type, campaign_id: campaign_id || null });
    res.json({ id: activityId, ok: true });
}));

// ─── PATCH /activity/:id/done ───────────────────────────────
// Markér aktivitet som afholdt/afsluttet (sætter done_at).
router.patch('/activity/:id/done', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const a = db.prepare('SELECT id, customer_id FROM crm_activities WHERE id = ?').get(id);
    if (!a) return res.status(404).json({ error: 'Aktivitet ikke fundet' });

    db.prepare("UPDATE crm_activities SET done_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    broadcast('crm_activity_updated', { id, customer_id: a.customer_id });
    res.json({ ok: true });
}));

// ─── PATCH /customer/:id/stage ──────────────────────────────
router.patch('/customer/:id/stage', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { stage } = req.body;

    if (!['lead', 'active', 'dormant', 'vip'].includes(stage)) {
        return res.status(400).json({ error: 'Ugyldigt stadie' });
    }

    // Upsert crm_customer_meta
    const existing = db.prepare("SELECT 1 FROM crm_customer_meta WHERE customer_id = ?").get(id);
    if (existing) {
        db.prepare("UPDATE crm_customer_meta SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?").run(stage, id);
    } else {
        db.prepare("INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, ?)").run(id, stage);
    }

    // Sync til rfm_scores (sæt stage_locked så RFM batch-job respekterer manuelt valg)
    const customer = db.prepare("SELECT company_id FROM customers WHERE id = ?").get(id);
    if (customer?.company_id) {
        const userId = req.session.user?.id || null;
        const rfmExists = db.prepare("SELECT 1 FROM rfm_scores WHERE company_id = ?").get(customer.company_id);
        if (rfmExists) {
            db.prepare(`
                UPDATE rfm_scores SET stage = ?, stage_locked = 1, stage_locked_by = ?, stage_locked_at = datetime('now')
                WHERE company_id = ?
            `).run(stage, userId, customer.company_id);
        } else {
            db.prepare(`
                INSERT INTO rfm_scores (company_id, stage, stage_locked, stage_locked_by, stage_locked_at)
                VALUES (?, ?, 1, ?, datetime('now'))
            `).run(customer.company_id, stage, userId);
        }
    }

    broadcast('crm_stage_changed', { customer_id: id, stage });
    res.json({ ok: true });
}));

// ─── PATCH /customer/:id/consent ────────────────────────────
// Sætter marketing_consent og/eller do_not_contact på crm_customer_meta.
// Begge er INTEGER (0|1). Hver ændring logges i changelog så vi kan dokumentere
// hvornår og af hvem consent blev givet/tilbagekaldt — vigtigt for §10-compliance.
// Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md sektion 1.3
router.patch('/customer/:id/consent', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    // req.session.userId er den faktiske session-nøgle (sat af routes/auth.js login).
    // Den udbredte req.session.user?.id i eksisterende handlers er en lurking bug
    // der returnerer altid undefined — vi bruger den korrekte her.
    const userId = req.session?.userId || null;
    const { marketing_consent, do_not_contact } = req.body || {};

    if (marketing_consent === undefined && do_not_contact === undefined) {
        return res.status(400).json({ error: 'no_fields' });
    }
    const toBit = (v) => (v === true || v === 1 || v === '1') ? 1 : 0;

    // Upsert crm_customer_meta så consent kan sættes selv hvis raden ikke findes endnu
    const existing = db.prepare(
        'SELECT marketing_consent, do_not_contact FROM crm_customer_meta WHERE customer_id = ?'
    ).get(id);
    if (!existing) {
        // Verificér at kunden findes inden vi opretter meta-row
        const cust = db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id);
        if (!cust) return res.status(404).json({ error: 'customer_not_found' });
        db.prepare(`
            INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact)
            VALUES (?, ?, ?)
        `).run(
            id,
            marketing_consent !== undefined ? toBit(marketing_consent) : 0,
            do_not_contact !== undefined ? toBit(do_not_contact) : 0,
        );
    } else {
        const fields = [];
        const args = [];
        if (marketing_consent !== undefined) {
            fields.push('marketing_consent = ?');
            args.push(toBit(marketing_consent));
        }
        if (do_not_contact !== undefined) {
            fields.push('do_not_contact = ?');
            args.push(toBit(do_not_contact));
        }
        fields.push("updated_at = CURRENT_TIMESTAMP");
        args.push(id);
        db.prepare(`UPDATE crm_customer_meta SET ${fields.join(', ')} WHERE customer_id = ?`).run(...args);
    }

    // Log hver ændring separat (audit-trail per consent-felt)
    const before = existing || { marketing_consent: 0, do_not_contact: 0 };
    if (marketing_consent !== undefined && before.marketing_consent !== toBit(marketing_consent)) {
        logChange({
            entityType: 'crm_customer_meta', entityId: id,
            action: 'update', fieldName: 'marketing_consent',
            oldValue: String(before.marketing_consent),
            newValue: String(toBit(marketing_consent)),
            userId,
        });
    }
    if (do_not_contact !== undefined && before.do_not_contact !== toBit(do_not_contact)) {
        logChange({
            entityType: 'crm_customer_meta', entityId: id,
            action: 'update', fieldName: 'do_not_contact',
            oldValue: String(before.do_not_contact),
            newValue: String(toBit(do_not_contact)),
            userId,
        });
    }

    broadcast('crm_consent_updated', { customer_id: id });
    res.json({ ok: true });
}));

// ─── GET /callbacks ─────────────────────────────────────────
router.get('/callbacks', handle((req, res) => {
    const db = getDb();
    const callbacks = db.prepare("SELECT * FROM v_callbacks_pending").all();
    const hard = db.prepare("SELECT * FROM v_hard_to_reach").all();
    res.json({ callbacks, hard_to_reach: hard });
}));

// ─── GET /dormant ───────────────────────────────────────────
router.get('/dormant', handle((req, res) => {
    const db = getDb();
    const minDays = parseInt(req.query.min_days) || 60;
    const maxDays = req.query.max_days ? parseInt(req.query.max_days) : null;

    let query = `
        SELECT c.id,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
            c.email, c.phone,
            co.name AS company_name,
            cm.stage, cm.last_contact_at,
            MAX(b.delivery_date) AS last_order_date,
            CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since,
            COUNT(b.id) AS total_orders,
            SUM(b.total_price) AS total_revenue
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN crm_customer_meta cm ON c.id = cm.customer_id
        LEFT JOIN bons b ON b.customer_id = c.id AND b.is_internal = 0
        WHERE c.is_active = 1
        GROUP BY c.id
        HAVING (days_since > ? OR last_order_date IS NULL)
    `;
    const args = [minDays];

    if (maxDays) {
        query += " AND days_since <= ?";
        args.push(maxDays);
    }
    query += " ORDER BY days_since DESC LIMIT 50";

    res.json(db.prepare(query).all(...args));
}));

// ─── GET /call-log ──────────────────────────────────────────
router.get('/call-log', handle((req, res) => {
    const db = getDb();
    const limit = parseInt(req.query.limit) || 30;
    const sentiment = req.query.sentiment;

    let query = `
        SELECT a.id, a.type, a.result, a.sentiment, a.text, a.created_at,
               u.name AS called_by,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
               co.name AS company_name,
               b.bon_number, b.delivery_date
        FROM crm_activities a
        LEFT JOIN users u ON a.owner_user_id = u.id
        LEFT JOIN customers c ON a.customer_id = c.id
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN bons b ON a.bon_id = b.id
        WHERE a.type IN ('call', 'service_call')
    `;
    const args = [];
    if (sentiment && sentiment !== 'all') {
        query += " AND a.sentiment = ?";
        args.push(sentiment);
    }
    query += " ORDER BY a.created_at DESC LIMIT ?";
    args.push(limit);

    res.json(db.prepare(query).all(...args));
}));

// ─── GET /call-stats ────────────────────────────────────────
router.get('/call-stats', handle((req, res) => {
    const db = getDb();

    const weekly = db.prepare("SELECT * FROM v_call_stats_weekly LIMIT 8").all();

    const perUser = db.prepare(`
        SELECT u.name, COUNT(*) as total,
               SUM(CASE WHEN a.result='reached' THEN 1 ELSE 0 END) as reached,
               ROUND(100.0*SUM(CASE WHEN a.result='reached' THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) as rate
        FROM crm_activities a
        JOIN users u ON a.owner_user_id = u.id
        WHERE a.type IN ('call','service_call')
        GROUP BY u.id ORDER BY total DESC
    `).all();

    const results = db.prepare(`
        SELECT result, COUNT(*) as c
        FROM crm_activities
        WHERE type IN ('call','service_call') AND result IS NOT NULL
        GROUP BY result ORDER BY c DESC
    `).all();

    const sentiments = db.prepare(`
        SELECT
            COALESCE(sentiment, 'unset') as sentiment,
            COUNT(*) as c
        FROM crm_activities
        WHERE type IN ('call','service_call') AND result = 'reached'
        GROUP BY sentiment ORDER BY c DESC
    `).all();

    res.json({ weekly, per_user: perUser, results, sentiments });
}));

// ─── GET /pipeline ──────────────────────────────────────────
router.get('/pipeline', handle((req, res) => {
    const db = getDb();
    const category = req.query.category;

    let where = 'WHERE (b.is_offer = 1 OR sd.code IN (\'NY\',\'VENTER\'))';
    const args = [];
    if (category) {
        where += ' AND b.price_category = ?';
        args.push(category);
    }

    const rows = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.pax, b.total_price,
               b.price_category, b.is_offer, b.offer_status, b.offer_sent_at,
               b.customer_id,
               sd.code as status, sd.label as status_label,
               c.first_name, c.last_name, co.name as company_name
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON c.company_id = co.id
        ${where}
        ORDER BY b.delivery_date ASC
    `).all(...args);

    // Group into pipeline columns
    const columns = {
        ny: { label: 'Lead', items: [] },
        tilbud_sendt: { label: 'Tilbud sendt', items: [] },
        forhandling: { label: 'Forhandling', items: [] },
        vundet: { label: 'Vundet', items: [] },
    };

    for (const r of rows) {
        const item = {
            id: r.id,
            bon_number: r.bon_number,
            customer_id: r.customer_id,
            customer_name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
            company_name: r.company_name,
            delivery_date: r.delivery_date,
            pax: r.pax,
            total_price: r.total_price,
            price_category: r.price_category,
            status: r.status,
            offer_status: r.offer_status,
        };

        // Status-baseret sortering har højere prioritet end offer_status
        if (r.status === 'GODKENDT' || (r.is_offer && r.offer_status === 'won')) columns.vundet.items.push(item);
        else if (r.status === 'VENTER') columns.forhandling.items.push(item);
        else if (r.is_offer && r.offer_status === 'sent') columns.tilbud_sendt.items.push(item);
        else columns.ny.items.push(item);
    }

    res.json(columns);
}));

// ─── PATCH /pipeline/:id/move ────────────────────────────────
router.patch('/pipeline/:id/move', handle((req, res) => {
    const db = getDb();
    const bonId = parseInt(req.params.id);
    const { column } = req.body;
    if (!column) return res.status(400).json({ error: 'column er påkrævet' });

    const bon = db.prepare('SELECT b.*, sd.code as status FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?').get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    // Map column → status/offer_status changes
    const columnMap = {
        ny:            { status_code: 'NY', offer_status: bon.is_offer ? 'draft' : null },
        tilbud_sendt:  { status_code: null, offer_status: 'sent' },
        forhandling:   { status_code: 'VENTER', offer_status: null },
        vundet:        { status_code: 'GODKENDT', offer_status: bon.is_offer ? 'won' : null },
    };

    const mapping = columnMap[column];
    if (!mapping) return res.status(400).json({ error: 'Ugyldig kolonne: ' + column });

    // Update status if needed
    if (mapping.status_code && bon.status !== mapping.status_code) {
        const newStatus = db.prepare('SELECT id FROM status_definitions WHERE code = ?').get(mapping.status_code);
        if (newStatus) {
            db.prepare('UPDATE bons SET status_id = ? WHERE id = ?').run(newStatus.id, bonId);
            logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'status', oldValue: bon.status, newValue: mapping.status_code, userId: req.session?.userId });
        }
    }

    // Update offer_status if needed
    if (mapping.offer_status && bon.offer_status !== mapping.offer_status) {
        db.prepare('UPDATE bons SET offer_status = ? WHERE id = ?').run(mapping.offer_status, bonId);
        logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'offer_status', oldValue: bon.offer_status, newValue: mapping.offer_status, userId: req.session?.userId });
        if (mapping.offer_status === 'sent' && !bon.offer_sent_at) {
            db.prepare("UPDATE bons SET offer_sent_at = datetime('now') WHERE id = ?").run(bonId);
        }
    }

    // Ensure is_offer is set for tilbud columns
    if ((column === 'tilbud_sendt') && !bon.is_offer) {
        db.prepare('UPDATE bons SET is_offer = 1 WHERE id = ?').run(bonId);
    }

    const { broadcast } = require('../shared/sse');
    broadcast('bon_updated', { id: bonId });

    res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
// LEAD-IMPORT — POST /leads/import
// ════════════════════════════════════════════════════════════
// Bulk-indlæsning af leads fra CSV/regneark. Pr. række:
//   1. Match firma på CVR (ellers eksakt navn) — berig manglende felter, opret ikke dublet.
//   2. Match kontakt på email — berig, ellers opret.
//   3. Opret contact_points eksplicit (053-triggerne fyrer KUN ved UPDATE, ikke INSERT).
//   4. Sæt stage='lead' i crm_customer_meta — kun for nye/meta-løse kunder (nedgrader aldrig VIP/aktiv).
//   5. Valgfrit batch-tag i crm_customer_meta.tags + valgfri CVR/Virk-berigelse.
// dry_run=true → kun matching + rapport, ingen writes (driver et præcist preview).

function _liNormCvr(c) {
    return (c == null ? '' : String(c)).replace(/\D/g, '');
}

function _liFindCompany(db, { cvr, name }) {
    const dc = _liNormCvr(cvr);
    if (dc.length === 8) {
        const row = db.prepare(`
            SELECT * FROM companies
             WHERE is_active = 1
               AND REPLACE(REPLACE(COALESCE(cvr,''),' ',''),'-','') = ?
             ORDER BY id LIMIT 1
        `).get(dc);
        if (row) return row;
    }
    if (name && name.trim()) {
        const row = db.prepare(`
            SELECT * FROM companies
             WHERE is_active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))
             ORDER BY id LIMIT 1
        `).get(name);
        if (row) return row;
    }
    return null;
}

function _liAddTag(db, customerId, tag) {
    if (!tag) return;
    const row = db.prepare('SELECT tags FROM crm_customer_meta WHERE customer_id = ?').get(customerId);
    let arr = [];
    if (row && row.tags) { try { arr = JSON.parse(row.tags) || []; } catch { arr = []; } }
    if (!Array.isArray(arr)) arr = [];
    if (!arr.includes(tag)) arr.push(tag);
    db.prepare('UPDATE crm_customer_meta SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?')
      .run(JSON.stringify(arr), customerId);
}

router.post('/leads/import', handle(async (req, res) => {
    const db = getDb();
    const userId = getUserId(req);
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    const dryRun = body.dry_run === true;
    const doEnrich = body.enrich === true;
    const tag = (typeof body.tag === 'string' && body.tag.trim()) ? body.tag.trim().slice(0, 80) : null;

    if (!rows) return res.status(400).json({ error: 'rows skal være et array' });
    if (rows.length === 0) return res.status(400).json({ error: 'Ingen rækker at importere' });
    if (rows.length > 2000) return res.status(413).json({ error: 'Maks 2000 rækker pr. import' });

    let enrichFn = null;
    if (doEnrich) {
        try { enrichFn = require('../services/cvrEnrichment').enrich; } catch { enrichFn = null; }
    }

    const summary = {
        total: rows.length, companies_created: 0, companies_enriched: 0,
        customers_created: 0, customers_matched: 0, leads_set: 0, errors: 0,
    };
    const results = [];
    let anyWritten = false;

    for (let i = 0; i < rows.length; i++) {
        const raw = rows[i] || {};
        const r = {
            company_name: (raw.company_name || '').toString().trim(),
            cvr:          (raw.cvr || '').toString().trim(),
            ean:          (raw.ean || '').toString().trim(),
            first_name:   (raw.first_name || '').toString().trim(),
            last_name:    (raw.last_name || '').toString().trim(),
            email:        (raw.email || '').toString().trim(),
            phone:        (raw.phone || '').toString().trim(),
            notes:        (raw.notes || '').toString().trim(),
            is_private:   raw.is_private === true || raw.is_private === 'true' || raw.is_private === 1,
        };
        const out = { index: i, status: 'ok' };

        try {
            // Validering: en række skal kunne identificeres
            if (r.is_private) {
                if (!r.email && !r.first_name) throw new Error('Privatkunde mangler navn eller email');
            } else if (!r.company_name && !_liNormCvr(r.cvr)) {
                throw new Error('Mangler firmanavn eller CVR');
            }

            // ── Match (read-only) ──
            let company = r.is_private ? null : _liFindCompany(db, { cvr: r.cvr, name: r.company_name });
            const companyAction = r.is_private ? 'none' : (company ? 'matched' : 'create');
            let customer = _liFindCustomerByEmail(db, r.email);
            const customerAction = customer ? 'matched' : 'create';

            // ── Valgfri CVR-berigelse (async, uden for transaction) ──
            let enriched = null;
            if (enrichFn && !r.is_private && (!company || !company.cvr || !company.legal_name)) {
                try {
                    const e = await enrichFn({ cvr: r.cvr || null, ean: r.ean || null, navn: r.company_name || null });
                    if (e && e.found && e.data) enriched = e.data;
                } catch { /* berigelse er best-effort */ }
            }

            out.company_action = companyAction;
            out.company_id = company?.id || null;
            out.company_name = r.company_name || enriched?.legal_name || null;
            out.customer_action = customerAction;
            out.customer_id = customer?.id || null;
            out.enriched = !!enriched;

            if (dryRun) { results.push(out); continue; }

            // ── Writes (én transaction pr. række — én dårlig række ruller ikke hele batchen) ──
            transaction(db, () => {
                // Firma
                if (!r.is_private) {
                    if (!company) {
                        const cvrToUse = _liNormCvr(r.cvr) || _liNormCvr(enriched?.cvr);
                        const name = r.company_name || enriched?.legal_name
                            || (cvrToUse ? `CVR ${cvrToUse}` : 'Ukendt firma');
                        const ins = db.prepare(`
                            INSERT INTO companies (name, cvr, ean, phone, email, notes)
                            VALUES (?, ?, ?, ?, ?, ?)
                        `).run(name, cvrToUse || null, r.ean || null, r.phone || null, r.email || null, r.notes || null);
                        company = { id: Number(ins.lastInsertRowid), cvr: cvrToUse || null, legal_name: null };
                        summary.companies_created++;
                        logChange({
                            entityType: 'company', entityId: company.id, action: 'create',
                            fieldName: 'import', newValue: name, userId,
                            notes: `lead-import${tag ? ' tag=' + tag : ''}`,
                        });
                        if (enriched?.legal_name) {
                            db.prepare(`
                                UPDATE companies
                                   SET legal_name = ?, last_enriched_at = CURRENT_TIMESTAMP,
                                       last_enriched_source = ?, updated_at = CURRENT_TIMESTAMP
                                 WHERE id = ?
                            `).run(enriched.legal_name, 'import-enrich', company.id);
                        }
                    } else {
                        // Berig matchet firma — fyld kun TOMME felter
                        const sets = [], args = [];
                        if (!company.cvr && (_liNormCvr(r.cvr) || _liNormCvr(enriched?.cvr))) {
                            sets.push('cvr = ?'); args.push(_liNormCvr(r.cvr) || _liNormCvr(enriched.cvr));
                        }
                        if (!company.ean && r.ean) { sets.push('ean = ?'); args.push(r.ean); }
                        if (!company.phone && r.phone) { sets.push('phone = ?'); args.push(r.phone); }
                        if (!company.email && r.email) { sets.push('email = ?'); args.push(r.email); }
                        if (!company.legal_name && enriched?.legal_name) { sets.push('legal_name = ?'); args.push(enriched.legal_name); }
                        if (sets.length) {
                            args.push(company.id);
                            db.prepare(`UPDATE companies SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
                            summary.companies_enriched++;
                        }
                    }
                    if (r.email) _liEnsureContactPoint(db, 'company', company.id, 'email', r.email);
                    if (r.phone) _liEnsureContactPoint(db, 'company', company.id, 'phone', r.phone);
                }

                // Kontakt
                if (!customer) {
                    const fn = r.first_name
                        || (r.email ? r.email.split('@')[0] : '')
                        || r.company_name || 'Kontakt';
                    const ins = db.prepare(`
                        INSERT INTO customers (company_id, first_name, last_name, phone, email, notes)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(company?.id || null, fn, r.last_name || null, r.phone || null, r.email || null, r.notes || null);
                    customer = { id: Number(ins.lastInsertRowid) };
                    summary.customers_created++;
                    logChange({
                        entityType: 'customer', entityId: customer.id, action: 'create',
                        fieldName: 'import', newValue: fn, userId,
                        notes: `lead-import${tag ? ' tag=' + tag : ''}`,
                    });
                } else {
                    summary.customers_matched++;
                    const sets = [], args = [];
                    if (!customer.company_id && company?.id) { sets.push('company_id = ?'); args.push(company.id); }
                    if (!customer.phone && r.phone) { sets.push('phone = ?'); args.push(r.phone); }
                    if (sets.length) {
                        args.push(customer.id);
                        db.prepare(`UPDATE customers SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
                    }
                }
                if (r.email) _liEnsureContactPoint(db, 'customer', customer.id, 'email', r.email);
                if (r.phone) _liEnsureContactPoint(db, 'customer', customer.id, 'phone', r.phone);

                // Stadie + tag
                const stage = _liSetLeadStageIfNew(db, customer.id, userId);
                if (stage === 'lead') summary.leads_set++;
                if (tag) _liAddTag(db, customer.id, tag);
            });

            anyWritten = true;
            out.company_id = company?.id || null;
            out.customer_id = customer.id;
            results.push(out);
        } catch (err) {
            out.status = 'error';
            out.message = err.message;
            summary.errors++;
            results.push(out);
        }
    }

    if (anyWritten) {
        broadcast('crm_stage_changed', { source: 'lead_import' });
    }

    res.json({ ok: true, dry_run: dryRun, summary, rows: results });
}));

module.exports = router;
