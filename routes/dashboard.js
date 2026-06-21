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
const { handle, inclToExcl, momsOfIncl, todayISO, countsAsWorkload, workloadRoleSql, salesPriceCategorySql } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { getShifts } = require('../services/smartplanAdapter');

/** Round to 2 decimals */
function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// ─── Auth on all routes ──────────────────────────────────────
router.use(requireAuth());

// ─── Helpers ─────────────────────────────────────────────────

const TERMINAL_CODES = ['LEVERET', 'AFLYST', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function _today() {
    return todayISO();   // dansk lokal dato — ikke UTC (undgår off-by-one efter midnat)
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

    // Totals (inkl. leveret — hele dagen). Produktionsbons (is_internal=1) tælles separat
    // så de ikke inflaterer omsætning/KPI'er, men stadig er synlige i køkkenets dagsoverblik.
    const allBons = db.prepare(`
        SELECT b.pax, b.total_units, b.total_price, b.event_role
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).all(today);

    // total_units = produktions-workload → festival-salg ekskluderes (allerede talt i
    // prep-bonnen), så "I dag"-tallet matcher kalenderen. total_price (omsætning) tæller
    // ALT — dér er festival-salget pengene, og prep er produktion (≈0 kr).
    const totals = {
        bon_count:   allBons.length,
        total_units: allBons.reduce((s, b) => s + (countsAsWorkload(b) ? (b.total_units > 0 ? b.total_units : (b.pax || 0)) : 0), 0),
        total_pax:   allBons.reduce((s, b) => s + (countsAsWorkload(b) ? (b.pax || 0) : 0), 0),
        total_price: allBons.reduce((s, b) => s + (b.total_price || 0), 0),
    };

    const productionBons = db.prepare(`
        SELECT b.pax, b.total_units
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST')
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 1
    `).all(today);

    const production_totals = {
        bon_count:   productionBons.length,
        total_units: productionBons.reduce((s, b) => s + (b.total_units > 0 ? b.total_units : (b.pax || 0)), 0),
        total_pax:   productionBons.reduce((s, b) => s + (b.pax || 0), 0),
    };

    // Categories from bon_lines for today
    const categories = db.prepare(`
        SELECT bl.category AS name, SUM(bl.quantity) AS units
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code NOT IN ('AFLYST')
          AND ${workloadRoleSql('b.event_role')}
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

    // new_web_orders — bons fra webhook der endnu ikke er bekræftet af et
    // menneske. acknowledged_at IS NULL er proxy for "ubehandlet"; den
    // adskiller "set af operatør" fra status_id, så en august-bestilling
    // i NY kan ryddes fra listen uden at den flyttes ud af status-flowet.
    const newWebOrders = db.prepare(`
        SELECT COUNT(DISTINCT b.id) AS cnt
        FROM bons b
        JOIN web_orders wo ON wo.bon_id = b.id
        WHERE b.acknowledged_at IS NULL
    `).get();
    if (newWebOrders.cnt > 0) {
        alerts.push({
            type: 'new_web_orders',
            count: newWebOrders.cnt,
            message: `${newWebOrders.cnt} ny${newWebOrders.cnt === 1 ? '' : 'e'} bestilling${newWebOrders.cnt === 1 ? '' : 'er'} fra hjemmesiden afventer godkendelse`,
            severity: 'warning',
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

    // Status-fordeling for hele dagen (inkl. leveret) — driver "Dagens status"-tile
    // på dashboardet. AFLYST + offers + interne udelades (samme regel som totals).
    const statusBreakdownRows = db.prepare(`
        SELECT sd.code AS status_code, sd.label AS status_label, sd.color AS status_color,
               COUNT(*) AS count
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND sd.code != 'AFLYST'
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
        GROUP BY sd.code, sd.label, sd.color
    `).all(today);

    // Tidspunkt for sidst leverede bon i dag — vises i tile-footer ("sidst leveret HH:MM").
    // Bruger seneste status_change-changelog hvor new_value=LEVERET (datostempel = dansk lokal tid).
    const lastDelivered = db.prepare(`
        SELECT MAX(cl.created_at) AS last_time
        FROM changelog cl
        JOIN bons b ON cl.entity_id = b.id
        WHERE cl.entity_type = 'bon'
          AND cl.action = 'status_change'
          AND cl.new_value = 'LEVERET'
          AND b.delivery_date = ?
    `).get(today);

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
        // Workload: enh. hvis sat, ellers pax (per bon) — samme regel som kalender/kitchen
        total_units: tomorrowBons.reduce((s, b) => s + (b.total_units > 0 ? b.total_units : (b.pax || 0)), 0),
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
    // Driftsoverblik: kun faktisk leveret t.o.m. i dag.
    // Sammenligning vs. samme MTD-periode sidste år (apples-to-apples).
    const monthStart = today.slice(0, 8) + '01';
    const DELIVERED_CODES = ['LEVERET', 'FAKTURERET', 'AFSLUTTET', 'BETALT'];
    const OPEN_CODES      = ['NY', 'VENTER', 'GODKENDT', 'IGANG', 'KLAR'];

    // Enheder = SOLGTE enheder → produktion (prep/top-up, 0 kr) tæller IKKE med.
    // Omsætning (total_price) tæller ALT (produktion er alligevel 0 kr).
    const mtdDelivered = db.prepare(`
        SELECT COALESCE(SUM(b.total_price), 0) AS revenue,
               COALESCE(SUM(CASE WHEN ${salesPriceCategorySql('pc.code')}
                                 THEN (CASE WHEN b.total_units > 0 THEN b.total_units ELSE COALESCE(b.pax, 0) END)
                                 ELSE 0 END), 0) AS units
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
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
               COALESCE(SUM(CASE WHEN ${salesPriceCategorySql('pc.code')}
                                 THEN (CASE WHEN b.total_units > 0 THEN b.total_units ELSE COALESCE(b.pax, 0) END)
                                 ELSE 0 END), 0) AS units
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code IN (${DELIVERED_CODES.map(() => '?').join(',')})
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
    `).get(lyMonthStart, lyToday, ...DELIVERED_CODES);

    // Regnskabskonvention: revenue (omsætning) er primær EX MOMS.
    // Bagudkomp.: feltnavnet "revenue" bevares som incl moms (kunne ses i gamle UI'er).
    // Se BON_V2_PRINCIPPER.md sektion 6c.
    const mtd = {
        // Bagudkompatibilitet (incl moms — det er hvad feltet altid har været)
        revenue:          mtdDelivered.revenue,
        units:            mtdDelivered.units,
        open_bons:        mtdOpen.cnt,
        unfactured:       mtdUnfactured.amount,
        last_year_revenue: lyMtd.revenue,
        last_year_units:   lyMtd.units,
        // Eksplicitte 3-felt værdier (regnskabs-primær er ex moms)
        revenue_excl_moms: r2(inclToExcl(mtdDelivered.revenue)),
        revenue_incl_moms: r2(mtdDelivered.revenue),
        vat_collected:     r2(momsOfIncl(mtdDelivered.revenue)),
        unfactured_excl_moms: r2(inclToExcl(mtdUnfactured.amount)),
        unfactured_incl_moms: r2(mtdUnfactured.amount),
        last_year_revenue_excl_moms: r2(inclToExcl(lyMtd.revenue)),
        last_year_revenue_incl_moms: r2(lyMtd.revenue),
    };

    // ── Settings for kitchen ──
    const countdownEnabled = db.prepare(
        `SELECT value FROM settings WHERE key = 'dashboard_countdown_enabled'`
    ).get()?.value === '1';

    res.json({
        date: today,
        bons,
        totals,
        production_totals,
        categories,
        alerts,
        next_pickup: nextPickup?.next_time || null,
        last_delivered_time: lastDelivered?.last_time || null,
        status_breakdown: statusBreakdownRows,
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
            b.price_category, b.event_role,
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
    // Enh-mode = produktions-volumen → festival-salg ekskluderes så festival-maden
    // ikke dobbelttælles (prep + salg). Kr (total_price) tæller alt.
    const lyRows = db.prepare(`
        SELECT b.delivery_date,
               SUM(CASE WHEN ${workloadRoleSql('b.event_role')}
                        THEN (CASE WHEN b.total_units > 0 THEN b.total_units ELSE COALESCE(b.pax, 0) END)
                        ELSE 0 END) AS total_units,
               SUM(b.total_price) AS total_price
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

        const totalPriceIncl = dateBons.reduce((s, b) => s + (b.total_price || 0), 0);
        const lyPriceIncl    = ly ? ly.total_price : 0;
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
                // Enh-mode: festival-salg giver 0 enheder (produktionen er talt i prep-klodsen),
                // men klodsen vises stadig i Kr-mode via price. Produktion (prep) tæller med.
                units: countsAsWorkload(b) ? (b.total_units > 0 ? b.total_units : (b.pax || 0)) : 0,
                // Bagudkomp.: price = total_price (incl moms)
                price: b.total_price || 0,
                price_excl_moms: r2(inclToExcl(b.total_price || 0)),
                price_incl_moms: r2(b.total_price || 0),
            })),
            total_units: dateBons.reduce((s, b) => s + (countsAsWorkload(b) ? (b.total_units > 0 ? b.total_units : (b.pax || 0)) : 0), 0),
            // Bagudkomp.: total_price = incl moms
            total_price:           totalPriceIncl,
            total_price_excl_moms: r2(inclToExcl(totalPriceIncl)),
            total_price_incl_moms: r2(totalPriceIncl),
            vat_collected:         r2(momsOfIncl(totalPriceIncl)),
            last_year_units:       ly ? ly.total_units : 0,
            last_year_price:           lyPriceIncl,
            last_year_price_excl_moms: r2(inclToExcl(lyPriceIncl)),
            last_year_price_incl_moms: r2(lyPriceIncl),
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
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE b.delivery_date >= ? AND b.delivery_date <= ?
          AND sd.code != 'AFLYST'
          AND COALESCE(b.is_offer, 0) = 0
          AND COALESCE(b.is_internal, 0) = 0
          AND ${salesPriceCategorySql('pc.code')}
          AND bl.product_name IS NOT NULL AND bl.product_name != ''
          AND bl.is_accessory = 0
        GROUP BY bl.product_name
        ORDER BY total_enh DESC
        LIMIT 10
    `).all(from, to);

    // Tilføj 3-felt mønster pr produkt (regnskabskonvention: ex moms primær)
    const decorated = rows.map(r => ({
        ...r,
        total_kr_excl_moms: r2(inclToExcl(r.total_kr)),
        total_kr_incl_moms: r2(r.total_kr),
        vat_collected:      r2(momsOfIncl(r.total_kr)),
    }));
    res.json(decorated);
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
