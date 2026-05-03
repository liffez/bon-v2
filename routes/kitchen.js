const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle, getBonLines } = require('../db/helpers');
// grocyAdapter bruges nu via services/ingredientResolver.js
// quConvert bruges nu via services/ingredientResolver.js

// GET /api/bons/today — køkken i dag
router.get('/today', handle((req, res) => {
    const db    = getDb();
    const today = new Date().toISOString().slice(0, 10);

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.kitchen_info, b.delivery_type, b.delivery_method,
            b.prep_ingredients_ready, b.prep_supplies_ready,
            b.kitchen_selects, b.customer_collects, b.price_category,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            sd.icon  AS status_icon,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            c.phone  AS contact_phone,
            co.name  AS company_name,
            co.phone AS company_phone,
            a.street_name || ' ' || COALESCE(a.street_nr,'') AS delivery_street,
            a.city   AS delivery_city,
            a.postal_code AS delivery_postal,
            dv.label AS delivery_vehicle_label,
            (SELECT COUNT(*) FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0) AS unread_mail_count
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
        LEFT JOIN delivery_vehicles dv ON b.delivery_vehicle_id = dv.id
        WHERE b.delivery_date = ?
          AND sd.code IN ('GODKENDT', 'IGANG', 'KLAR', 'LEVERET')
        ORDER BY b.pickup_time, b.id
    `).all(today);

    for (const bon of bons) {
        bon.lines = getBonLines(bon.id);
        bon.notifications = db.prepare(`
            SELECT id, type, message, priority, created_at
            FROM notifications WHERE bon_id = ? ORDER BY created_at DESC LIMIT 5
        `).all(bon.id);
    }

    res.json(bons);
}));

// GET /api/bons/later — køkken senere (fra i morgen + N dage)
router.get('/later', handle((req, res) => {
    const db    = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const days  = parseInt(req.query.days) || 28;

    // Beregn slutdato: today + days
    const end = new Date();
    end.setDate(end.getDate() + days);
    const endDate = end.toISOString().slice(0, 10);

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.kitchen_info, b.delivery_type, b.delivery_method,
            b.prep_ingredients_ready, b.prep_supplies_ready,
            b.kitchen_selects, b.customer_collects, b.is_offer, b.price_category,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            sd.icon  AS status_icon,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            c.phone  AS contact_phone,
            co.name  AS company_name,
            co.phone AS company_phone,
            a.street_name || ' ' || COALESCE(a.street_nr,'') AS delivery_street,
            a.city   AS delivery_city,
            a.postal_code AS delivery_postal,
            dv.label AS delivery_vehicle_label,
            (SELECT COUNT(*) FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0) AS unread_mail_count
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
        LEFT JOIN delivery_vehicles dv ON b.delivery_vehicle_id = dv.id
        WHERE b.delivery_date >= ?
          AND b.delivery_date <= ?
          AND (sd.code IN ('VENTER', 'GODKENDT', 'IGANG', 'KLAR') OR b.is_offer = 1)
        ORDER BY b.is_offer ASC, b.delivery_date ASC, b.pickup_time ASC, b.id ASC
    `).all(today, endDate);

    for (const bon of bons) {
        bon.lines = getBonLines(bon.id);
        bon.notifications = db.prepare(`
            SELECT id, type, message, priority, created_at
            FROM notifications WHERE bon_id = ? ORDER BY created_at DESC LIMIT 5
        `).all(bon.id);
    }

    res.json(bons);
}));

// GET /api/bons/planning — planlægningsview (bons med lines, for client-side aggregering)
router.get('/planning', handle((req, res) => {
    const db = getDb();

    // Default: indeværende uge (mandag–søndag)
    const now   = new Date();
    const dow   = now.getDay() || 7; // søndag = 7
    const mon   = new Date(now);
    mon.setDate(mon.getDate() - dow + 1);
    const sun   = new Date(mon);
    sun.setDate(sun.getDate() + 6);

    const from = req.query.from || mon.toISOString().slice(0, 10);
    const to   = req.query.to   || sun.toISOString().slice(0, 10);

    // Status-filter (kommasepareret, default: produktions-relevante)
    const statusCodes = req.query.status
        ? req.query.status.split(',').map(s => s.trim().toUpperCase())
        : ['GODKENDT', 'IGANG', 'KLAR', 'LEVERET'];

    const placeholders = statusCodes.map(() => '?').join(',');

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.is_offer, b.price_category,
            b.delivery_type, b.delivery_method,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            co.name  AS company_name,
            pc.code  AS price_category_code,
            (SELECT COUNT(*) FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0) AS unread_mail_count
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN price_categories pc ON b.price_category = pc.id
        WHERE b.delivery_date >= ?
          AND b.delivery_date <= ?
          AND (sd.code IN (${placeholders}) OR b.is_offer = 1)
        ORDER BY b.delivery_date ASC, b.pickup_time ASC, b.id ASC
    `).all(from, to, ...statusCodes);

    for (const bon of bons) {
        bon.lines = getBonLines(bon.id);
    }

    res.json(bons);
}));

// GET /api/bons/planning/ingredients?ids=3305,3291,3288
// POST /api/bons/planning/ingredients  body: { bon_ids: [], extra_lines: [{grocy_recipe_id, quantity}] }
// Aggregerer ingrediensbehov for flere bons + valgfri ekstra ad-hoc opskrift-linjer
async function planningIngredientsHandler(bonIds, extraLines) {
    if (!bonIds.length && !extraLines.length) {
        return { ingredients: [], groups: [], lines_without_recipe: [] };
    }

    const allLines = [];
    const linesWithoutRecipe = [];

    for (const id of bonIds) {
        const lines = getBonLines(id);
        lines.forEach(l => {
            if (l.grocy_recipe_id) allLines.push(l);
            else if (!l.is_accessory) linesWithoutRecipe.push(l.product_name);
        });
    }

    extraLines.forEach(l => {
        const rid = parseInt(l.grocy_recipe_id);
        const qty = parseFloat(l.quantity);
        if (rid && qty > 0) allLines.push({ grocy_recipe_id: rid, quantity: qty });
    });

    if (!allLines.length) {
        const empty = { ingredients: [], groups: [], sub_recipes: [] };
        return { bon_ids: bonIds, production: empty, raw: empty, ingredients: [], groups: [], lines_without_recipe: linesWithoutRecipe };
    }

    const { resolveIngredients } = require('../services/ingredientResolver');
    const { production, raw } = await resolveIngredients(allLines);

    return {
        bon_ids: bonIds,
        production,
        raw,
        ingredients: raw.ingredients,
        groups: raw.groups,
        lines_without_recipe: linesWithoutRecipe,
    };
}

router.get('/planning/ingredients', handle(async (req, res) => {
    if (!req.query.ids) return res.status(400).json({ error: 'ids param påkrævet' });
    const bonIds = req.query.ids.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const result = await planningIngredientsHandler(bonIds, []);
    res.json(result);
}));

router.post('/planning/ingredients', handle(async (req, res) => {
    const bonIds = Array.isArray(req.body.bon_ids)
        ? req.body.bon_ids.map(n => parseInt(n)).filter(n => !isNaN(n))
        : [];
    const extraLines = Array.isArray(req.body.extra_lines) ? req.body.extra_lines : [];
    const result = await planningIngredientsHandler(bonIds, extraLines);
    res.json(result);
}));

// GET /api/bons/calendar — kalender-view (bons grupperet per dato med totaler)
router.get('/calendar', handle((req, res) => {
    const db    = getDb();
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    // Valgfri status-filter (kommasepareret)
    const statusFilter = req.query.status ? req.query.status.split(',') : null;

    // Beregn månedens grænser
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;

    // Udvid til fulde ISO-uger (man–søn)
    const startDt  = new Date(startDate + 'T00:00:00');
    const startDow = startDt.getDay(); // 0=søn, 1=man, ...
    const daysBack = startDow === 0 ? 6 : startDow - 1; // dage tilbage til mandag
    startDt.setDate(startDt.getDate() - daysBack);
    const calStart = _localDateStr(startDt);

    const lastDay = new Date(nextYear, nextMonth - 1, 0); // sidste dag i måneden
    const endDow  = lastDay.getDay();
    const daysFwd = endDow === 0 ? 0 : 7 - endDow; // dage frem til søndag
    lastDay.setDate(lastDay.getDate() + daysFwd);
    const calEnd = _localDateStr(lastDay);

    // Byg WHERE
    const where = ['b.delivery_date >= ?', 'b.delivery_date <= ?'];
    const args  = [calStart, calEnd];

    if (statusFilter) {
        where.push(`sd.code IN (${statusFilter.map(() => '?').join(',')})`);
        args.push(...statusFilter);
    }

    const bons = db.prepare(`
        SELECT
            b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time,
            b.pax, b.total_units, b.delivery_type, b.payment_type, b.is_offer,
            sd.code  AS status_code,
            sd.label AS status_label,
            sd.color AS status_color,
            c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
            co.name  AS company_name,
            (SELECT COUNT(*) FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id WHERE mt.bon_id = b.id AND mm.direction = 'in' AND mm.is_read = 0) AS unread_mail_count
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        WHERE ${where.join(' AND ')}
        ORDER BY b.delivery_date ASC, b.pickup_time ASC, b.id ASC
    `).all(...args);

    // Gruppér per dato
    const days = {};
    for (const bon of bons) {
        const d = bon.delivery_date;
        if (!days[d]) {
            days[d] = { bons: [], totals: { pax: 0, units: 0, workload: 0, count: 0, offers: 0 } };
        }
        days[d].bons.push(bon);
        if (bon.is_offer) {
            days[d].totals.offers++;
        } else {
            const pax   = bon.pax || 0;
            const units = bon.total_units || 0;
            days[d].totals.pax      += pax;
            days[d].totals.units    += units;
            // Workload: enheder afspejler reel arbejdsbyrde bedre end pax
            // (fx 3 slidere per kuvert = 3x arbejde vs. 1 sandwich per kuvert)
            days[d].totals.workload += units > 0 ? units : pax;
            days[d].totals.count++;
        }
    }

    // Uge-totaler (ISO-uger, mandag-baseret)
    const weekTotals = {};
    for (const [dateStr, dayData] of Object.entries(days)) {
        const dt      = new Date(dateStr + 'T00:00:00');
        const weekNum = _getISOWeek(dt);
        const weekKey = `${dt.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        if (!weekTotals[weekKey]) {
            weekTotals[weekKey] = { pax: 0, units: 0, workload: 0, count: 0 };
        }
        weekTotals[weekKey].pax      += dayData.totals.pax;
        weekTotals[weekKey].units    += dayData.totals.units;
        weekTotals[weekKey].workload += dayData.totals.workload;
        weekTotals[weekKey].count    += dayData.totals.count;
    }

    res.json({ year, month, calStart, calEnd, days, weekTotals });
}));

/** Lokal dato som YYYY-MM-DD (undgår toISOString() UTC-forskydning) */
function _localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** ISO-ugenummer (mandag = start) */
function _getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

module.exports = router;
