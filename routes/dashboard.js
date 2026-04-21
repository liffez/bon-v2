/**
 * routes/dashboard.js
 * ════════════════════════════════════════════════════════════
 * Dashboard API endpoints.
 *
 * GET /api/dashboard/today   — "Lige nu" data
 * GET /api/dashboard/stats   — Søjlegraf + uge-sammenligning
 * GET /api/dashboard/weather — DMI vejr-proxy (placeholder)
 * ════════════════════════════════════════════════════════════
 */

const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle }    = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { getShifts } = require('../services/smartplanAdapter');

// ─── Auth on all routes ──────────────────────────────────────
router.use(requireAuth());

// ─── Helpers ─────────────────────────────────────────────────

const TERMINAL_CODES = ['LEVERET', 'AFLYST', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function _today() {
    return new Date().toISOString().slice(0, 10);
}

function _dateOffset(base, days) {
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

function _getISOWeek(dateStr) {
    const d = new Date(Date.UTC(
        parseInt(dateStr.slice(0, 4)),
        parseInt(dateStr.slice(5, 7)) - 1,
        parseInt(dateStr.slice(8, 10))
    ));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function _dayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.getDay(); // 0=sun, 1=mon, ...
}

// ─── GET /today ──────────────────────────────────────────────

router.get('/today', handle(async (req, res) => {
    const db    = getDb();
    const today = _today();

    // Bons for today (non-terminal)
    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number,
            sd.code  AS status_code,
            sd.color AS status_color,
            COALESCE(b.delivery_time, b.pickup_time) AS delivery_time,
            b.total_units, b.pax,
            b.prep_ingredients_ready, b.prep_supplies_ready,
            b.total_price,
            COALESCE(co.name, c.first_name || ' ' || COALESCE(c.last_name,'')) AS customer_name
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN (${TERMINAL_CODES.map(() => '?').join(',')})
        ORDER BY COALESCE(b.delivery_time, b.pickup_time, '23:59'), b.id
    `).all(today, ...TERMINAL_CODES);

    // Totals (inkl. leveret — hele dagen)
    const allBons = db.prepare(`
        SELECT b.pax, b.total_units, b.total_price
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).all(today);

    const totals = {
        bon_count:   allBons.length,
        total_units: allBons.reduce((s, b) => s + (b.total_units || 0), 0),
        total_pax:   allBons.reduce((s, b) => s + (b.pax || 0), 0),
        total_price: allBons.reduce((s, b) => s + (b.total_price || 0), 0),
    };

    // Categories from bon_lines for today
    const categories = db.prepare(`
        SELECT bl.category AS name, SUM(bl.quantity) AS units
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST')
          AND bl.category IS NOT NULL AND bl.category != ''
        GROUP BY bl.category
        ORDER BY bl.category
    `).all(today);

    // Alerts
    const alerts = [];

    // prep_missing
    const prepMissing = db.prepare(`
        SELECT b.id AS bon_id, b.bon_number
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN (${TERMINAL_CODES.map(() => '?').join(',')})
          AND (b.prep_ingredients_ready = 0 OR b.prep_supplies_ready = 0)
    `).all(today, ...TERMINAL_CODES);

    for (const b of prepMissing) {
        const parts = [];
        const full = db.prepare(`SELECT prep_ingredients_ready, prep_supplies_ready FROM bons WHERE id = ?`).get(b.bon_id);
        if (!full.prep_ingredients_ready) parts.push('råvarer');
        if (!full.prep_supplies_ready) parts.push('emballage');
        alerts.push({
            type: 'prep_missing',
            bon_id: b.bon_id,
            bon_number: b.bon_number,
            message: `#${b.bon_number} mangler ${parts.join(' + ')}`,
            severity: 'warning',
        });
    }

    // status_waiting
    const waiting = db.prepare(`
        SELECT b.id AS bon_id, b.bon_number, sd.code AS status_code
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code IN ('NY', 'VENTER')
    `).all(today);

    for (const b of waiting) {
        alerts.push({
            type: 'status_waiting',
            bon_id: b.bon_id,
            bon_number: b.bon_number,
            message: `#${b.bon_number} ${b.status_code === 'NY' ? 'er ny' : 'venter godkendelse'}`,
            severity: 'info',
        });
    }

    // unread_mail
    const unreadMail = db.prepare(`SELECT COUNT(*) AS cnt FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mm.direction = 'in' AND mm.is_read = 0`).get();
    if (unreadMail.cnt > 0) {
        alerts.push({
            type: 'unread_mail',
            count: unreadMail.cnt,
            message: `${unreadMail.cnt} ulæst${unreadMail.cnt === 1 ? '' : 'e'} mail${unreadMail.cnt === 1 ? '' : 's'}`,
            severity: 'info',
        });
    }

    // Next pickup
    const nextPickup = db.prepare(`
        SELECT MIN(COALESCE(b.pickup_time, b.delivery_time)) AS next_time
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN (${TERMINAL_CODES.map(() => '?').join(',')})
          AND COALESCE(b.pickup_time, b.delivery_time) >= TIME('now', 'localtime')
    `).get(today, ...TERMINAL_CODES);

    // Tomorrow prep status
    const tomorrow = _dateOffset(today, 1);
    const tomorrowBons = db.prepare(`
        SELECT b.id, b.bon_number, b.prep_ingredients_ready, b.prep_supplies_ready,
               b.total_units, b.pax,
               COALESCE(co.name, c.first_name || ' ' || COALESCE(c.last_name,'')) AS customer_name,
               sd.code AS status_code
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN (${TERMINAL_CODES.map(() => '?').join(',')})
        ORDER BY COALESCE(b.delivery_time, b.pickup_time, '23:59'), b.id
    `).all(tomorrow, ...TERMINAL_CODES);

    const tomorrow_prep = {
        date: tomorrow,
        bon_count: tomorrowBons.length,
        total_units: tomorrowBons.reduce((s, b) => s + (b.total_units || 0), 0),
        total_pax: tomorrowBons.reduce((s, b) => s + (b.pax || 0), 0),
        bons: tomorrowBons.map(b => ({
            id: b.id,
            bon_number: b.bon_number,
            customer_name: b.customer_name,
            prep_ingredients_ready: b.prep_ingredients_ready,
            prep_supplies_ready: b.prep_supplies_ready,
            total_units: b.total_units,
            pax: b.pax,
        })),
        all_ingredients_ready: tomorrowBons.length > 0 && tomorrowBons.every(b => b.prep_ingredients_ready),
        all_supplies_ready: tomorrowBons.length > 0 && tomorrowBons.every(b => b.prep_supplies_ready),
    };

    // ── MTD KPI data (for office dashboard) ──
    const monthStart = today.slice(0, 8) + '01';
    const DELIVERED_CODES = ['LEVERET', 'FAKTURERET', 'AFSLUTTET', 'BETALT'];
    const OPEN_CODES      = ['NY', 'VENTER', 'GODKENDT', 'IGANG', 'KLAR'];

    const mtdDelivered = db.prepare(`
        SELECT COALESCE(SUM(b.total_price), 0) AS revenue,
               COALESCE(SUM(b.total_units), 0) AS units
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code IN (${DELIVERED_CODES.map(() => '?').join(',')})
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).get(monthStart, today, ...DELIVERED_CODES);

    const mtdOpen = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code IN (${OPEN_CODES.map(() => '?').join(',')})
    `).get(...OPEN_CODES);

    const mtdUnfactured = db.prepare(`
        SELECT COALESCE(SUM(b.total_price), 0) AS amount
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code = 'LEVERET'
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).get();

    // Last year same MTD period
    const lyYear = parseInt(today.slice(0, 4)) - 1;
    const lyMonthStart = `${lyYear}${monthStart.slice(4)}`;
    const lyToday      = `${lyYear}${today.slice(4)}`;

    const lyMtd = db.prepare(`
        SELECT COALESCE(SUM(b.total_price), 0) AS revenue,
               COALESCE(SUM(b.total_units), 0) AS units
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code IN (${DELIVERED_CODES.map(() => '?').join(',')})
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).get(lyMonthStart, lyToday, ...DELIVERED_CODES);

    const mtd = {
        revenue:          mtdDelivered.revenue,
        units:            mtdDelivered.units,
        open_bons:        mtdOpen.cnt,
        unfactured:       mtdUnfactured.amount,
        last_year_revenue: lyMtd.revenue,
        last_year_units:   lyMtd.units,
    };

    // ── Settings for kitchen ──
    const countdownEnabled = db.prepare(
        `SELECT value FROM settings WHERE key = 'dashboard_countdown_enabled'`
    ).get()?.value === '1';

    res.json({
        date: today,
        bons,
        totals,
        categories,
        alerts,
        next_pickup: nextPickup?.next_time || null,
        tomorrow_prep,
        mtd,
        countdown_enabled: countdownEnabled,
    });
}));

// ─── GET /stats ──────────────────────────────────────────────

const DAY_SHORT = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

// Map price_category code to display label for chart
const PRICE_CAT_LABELS = {
    store: 'Store', catering: 'Catering', festival: 'Festival',
    produktion: 'Produktion', waiste: 'Waiste',
};

router.get('/stats', handle(async (req, res) => {
    const db         = getDb();
    const today      = _today();
    const daysBack   = Math.min(parseInt(req.query.days_back) || 7, 60);
    const daysFwd    = Math.min(parseInt(req.query.days_forward) || 7, 60);

    const startDate  = _dateOffset(today, -daysBack);
    const endDate    = _dateOffset(today, daysFwd);

    // Individual bons in range (for legoklods chart)
    const bonRows = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date,
            b.total_units, b.total_price, b.pax,
            b.price_category,
            COALESCE(co.name, c.first_name || ' ' || COALESCE(c.last_name,'')) AS customer_name
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers c  ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id  = co.id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code NOT IN ('AFLYST')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
        ORDER BY b.delivery_date, b.total_units ASC
    `).all(startDate, endDate);

    // Last year data (364 days back from each end)
    const lyStartDate = _dateOffset(startDate, -364);
    const lyEndDate   = _dateOffset(endDate, -364);
    const lyRows = db.prepare(`
        SELECT b.delivery_date, SUM(b.total_units) AS total_units, SUM(b.total_price) AS total_price
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code NOT IN ('AFLYST')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
        GROUP BY b.delivery_date
    `).all(lyStartDate, lyEndDate);

    // Index last year by date
    const lyByDate = {};
    for (const r of lyRows) {
        lyByDate[r.delivery_date] = { total_units: r.total_units || 0, total_price: r.total_price || 0 };
    }

    // Group bons by date
    const bonsByDate = {};
    for (const r of bonRows) {
        if (!bonsByDate[r.delivery_date]) bonsByDate[r.delivery_date] = [];
        bonsByDate[r.delivery_date].push(r);
    }

    // Smartplan shifts (async, non-blocking) — with full details for badges
    let shiftsByDate = {};
    try {
        const shifts = await getShifts(startDate, endDate);
        for (const s of shifts) {
            if (!s.date) continue;
            const firstName = s.first_name || (s.employee_name ? s.employee_name.split(' ')[0] : null);
            if (!firstName) continue;
            if (!shiftsByDate[s.date]) shiftsByDate[s.date] = [];
            const lastName = s.last_name || (s.employee_name ? s.employee_name.split(' ').slice(1).join(' ') : '');
            const init = (firstName.charAt(0) + (lastName ? lastName.charAt(0) : '')).toUpperCase();
            const startTime = s.start_time ? s.start_time.slice(0, 5).replace(':00', '') : '';
            const endTime = s.end_time ? s.end_time.slice(0, 5).replace(':00', '') : '';
            const tid = startTime && endTime ? `${startTime}–${endTime}` : '';
            // Deduplicate by name
            if (!shiftsByDate[s.date].find(x => x.name === (s.employee_name || firstName))) {
                shiftsByDate[s.date].push({
                    init,
                    name: s.employee_name || firstName,
                    first_name: firstName,
                    tid,
                });
            }
        }
    } catch (e) {
        // Smartplan unavailable — graceful degradation
    }

    // Build days array
    const days = [];
    let d = startDate;
    while (d <= endDate) {
        const dateBons = bonsByDate[d] || [];
        const lyDate = _dateOffset(d, -364);
        const ly = lyByDate[lyDate] || null;
        const dt = new Date(d + 'T12:00:00');
        const dayLabel = `${DAY_SHORT[dt.getDay()]}\n${dt.getDate()}.`;

        days.push({
            date: d,
            label: dayLabel,
            is_today: d === today,
            is_future: d > today,
            bons: dateBons.map(b => ({
                id: b.id,
                bon_number: b.bon_number,
                category: PRICE_CAT_LABELS[b.price_category] || b.price_category || 'Store',
                customer_name: (b.customer_name || '').trim(),
                units: (b.total_units > 0 ? b.total_units : (b.pax || 0)),
                price: b.total_price || 0,
            })),
            total_units: dateBons.reduce((s, b) => s + (b.total_units > 0 ? b.total_units : (b.pax || 0)), 0),
            total_price: dateBons.reduce((s, b) => s + (b.total_price || 0), 0),
            last_year_units: ly ? ly.total_units : 0,
            last_year_price: ly ? ly.total_price : 0,
            shifts: shiftsByDate[d] || [],
        });

        d = _dateOffset(d, 1);
    }

    res.json({ days });
}));

// ─── GET /top-products ────────────────────────────────────────

router.get('/top-products', handle(async (req, res) => {
    const db = getDb();
    const today = _today();
    const from = req.query.from || today.slice(0, 8) + '01'; // default: month start
    const to   = req.query.to   || today;

    const rows = db.prepare(`
        SELECT
            bl.product_name,
            SUM(bl.quantity)               AS total_enh,
            SUM(bl.quantity * bl.unit_price) AS total_kr
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code != 'AFLYST'
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
          AND bl.product_name IS NOT NULL AND bl.product_name != ''
          AND bl.is_accessory = 0
        GROUP BY bl.product_name
        ORDER BY total_enh DESC
        LIMIT 10
    `).all(from, to);

    res.json(rows);
}));

// ─── GET /weather ────────────────────────────────────────────

router.get('/weather', handle(async (req, res) => {
    const apiKey = process.env.DMI_API_KEY;
    if (!apiKey) {
        return res.json({ available: false, reason: 'DMI_API_KEY ikke sat i .env' });
    }

    // Placeholder for DMI integration
    res.json({ available: false, reason: 'DMI integration ikke implementeret endnu' });
}));

module.exports = router;
