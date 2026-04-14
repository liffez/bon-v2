/**
 * routes/crm.js
 * ════════════════════════════════════════════════════════════
 * CRM API — portet fra Python-prototype (crm_server.py)
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');

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

// ─── GET /briefing ──────────────────────────────────────────
router.get('/briefing', handle((req, res) => {
    const db = getDb();
    const items = [];

    const sc = db.prepare("SELECT COUNT(*) as c FROM v_service_calls_pending").get().c;
    if (sc > 0) items.push({ icon: '📞', text: sc + ' service-kald venter', type: 'action', link: 'svc' });

    const cb = db.prepare("SELECT COUNT(*) as c FROM v_callbacks_pending").get().c;
    if (cb > 0) items.push({ icon: '🔔', text: cb + ' callback' + (cb > 1 ? 's' : '') + ' at følge op', type: 'action', link: 'callbacks' });

    const overdue = db.prepare(`
        SELECT
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
            type: 'insight', link: 'suggestions'
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
    if (season > 0) items.push({ icon: '📅', text: season + ' kunder bestilte på denne tid sidste år', type: 'insight', link: 'suggestions' });

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
            CAST(julianday('now') - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery
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
    const { stage, q, category, order_after, order_before } = req.query;
    const limit = parseInt(req.query.limit) || 50;

    const where = ["c.is_active = 1"];
    let bonFilter = "b.is_internal = 0";
    const having = [];
    const args = [];

    if (stage && stage !== 'all') {
        where.push("cm.stage = ?");
        args.push(stage);
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
        SELECT a.*, u.name as user_name, b.bon_number
        FROM crm_activities a
        LEFT JOIN users u ON a.owner_user_id = u.id
        LEFT JOIN bons b ON a.bon_id = b.id
        WHERE a.customer_id = ?
        ORDER BY a.created_at DESC LIMIT 20
    `).all(id);

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

    res.json({ customer, stats, orders, activities, products, rfm });
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
    const { customer_id, bon_id, type, result, sentiment, text, due_at, purpose_id } = req.body;
    const userId = req.session.user?.id || null;

    if (!customer_id || !type || !text) {
        return res.status(400).json({ error: 'Mangler customer_id, type eller text' });
    }

    const ins = db.prepare(`
        INSERT INTO crm_activities (customer_id, bon_id, type, result, sentiment, text, due_at, owner_user_id, purpose_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(customer_id, bon_id || null, type, result || null, sentiment || null, text, due_at || null, userId, purpose_id || null);

    const activityId = ins.lastInsertRowid;

    // Opdater last_contact_at
    db.prepare(`
        UPDATE crm_customer_meta SET last_contact_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE customer_id = ?
    `).run(customer_id);

    // Hvis opkald med reached → markér som done
    if (['call', 'service_call'].includes(type) && result === 'reached') {
        db.prepare("UPDATE crm_activities SET done_at = CURRENT_TIMESTAMP WHERE id = ?").run(activityId);
    }

    broadcast('crm_activity_created', { id: activityId, customer_id, bon_id, type });
    res.json({ id: activityId, ok: true });
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

module.exports = router;
