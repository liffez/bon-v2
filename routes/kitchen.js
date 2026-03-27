const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle, getBonLines } = require('../db/helpers');
const grocy         = require('../services/grocyAdapter');
const { findConversionFactor, convertAndFormat } = require('../services/quConvert');

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
            a.postal_code AS delivery_postal
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
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
            a.postal_code AS delivery_postal
        FROM bons b
        JOIN   status_definitions sd ON b.status_id  = sd.id
        LEFT JOIN customers c        ON b.customer_id = c.id
        LEFT JOIN companies co       ON b.company_id  = co.id
        LEFT JOIN addresses a        ON b.delivery_address_id = a.id
        WHERE b.delivery_date >= ?
          AND b.delivery_date <= ?
          AND sd.code IN ('VENTER', 'GODKENDT', 'IGANG', 'KLAR')
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
            pc.code  AS price_category_code
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
// Aggregerer ingrediensbehov for flere bons i ét kald
router.get('/planning/ingredients', handle(async (req, res) => {
    if (!req.query.ids) return res.status(400).json({ error: 'ids param påkrævet' });

    const db = getDb();
    const bonIds = req.query.ids.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (!bonIds.length) return res.json({ ingredients: [], groups: [], lines_without_recipe: [] });

    // Hent alle bon_lines for de valgte bons
    const allLines = [];
    const linesWithoutRecipe = [];
    for (const id of bonIds) {
        const lines = getBonLines(id);
        lines.forEach(l => {
            if (l.grocy_recipe_id) allLines.push(l);
            else if (!l.is_accessory) linesWithoutRecipe.push(l.product_name);
        });
    }

    if (!allLines.length) {
        return res.json({ bon_ids: bonIds, ingredients: [], groups: [], lines_without_recipe: linesWithoutRecipe });
    }

    // Hent Grocy-data parallelt
    const uniqueRecipeIds = [...new Set(allLines.map(l => l.grocy_recipe_id))];
    const [recipes, ingredientsByRecipe, stockArr, products, quantityUnits, quConversions] = await Promise.all([
        grocy.getRecipes(),
        Promise.all(uniqueRecipeIds.map(async id => ({ id, items: await grocy.getRecipeIngredients(id) }))),
        grocy.getStock(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]);

    // Lookup-maps
    const recipeMap = new Map(recipes.map(r => [r.id, r]));
    const ingMap = new Map(ingredientsByRecipe.map(r => [r.id, r.items]));
    const stockMap = {};
    stockArr.forEach(s => { stockMap[s.product_id] = parseFloat(s.amount) || 0; });
    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(quantityUnits.map(u => [u.id, u]));

    // Aggregér ingredienser fra ALLE linjer
    const aggregated = new Map();
    for (const line of allLines) {
        const recipe = recipeMap.get(line.grocy_recipe_id);
        const unitNumber = recipe ? recipe.unit_number : 1;
        const scaleFactor = line.quantity / unitNumber;
        const ings = ingMap.get(line.grocy_recipe_id) || [];

        for (const ing of ings) {
            const pid = ing.product_id;
            const baseAmount = parseFloat(ing.amount) || 0;
            const scaledStock = baseAmount * scaleFactor;

            if (aggregated.has(pid)) {
                aggregated.get(pid).needed_stock += scaledStock;
            } else {
                const product = productMap.get(pid) || {};
                aggregated.set(pid, {
                    product_id:       pid,
                    product_name:     product.name || `Produkt #${pid}`,
                    needed_stock:     scaledStock,
                    qu_id_stock:      product.qu_id_stock,
                    qu_id_purchase:   product.qu_id_purchase,
                    qu_id_display:    ing.qu_id,
                    ingredient_group: ing.ingredient_group || '',
                });
            }
        }
    }

    // Konvertér og klassificér
    const ingredients = [...aggregated.values()].map(ing => {
        const stockAmount = stockMap[ing.product_id] || 0;
        let status;
        if (stockAmount >= ing.needed_stock)       status = 'ok';
        else if (stockAmount > 0)                  status = 'lav';
        else                                       status = 'mangler';

        const convOpts = { productId: ing.product_id, fromQuId: ing.qu_id_stock, toQuId: ing.qu_id_display, conversions: quConversions, unitMap };
        const fmtNeeded = convertAndFormat(ing.needed_stock, convOpts);
        const fmtStock  = convertAndFormat(stockAmount, convOpts);

        const shortfallStock = Math.max(0, ing.needed_stock - stockAmount);
        let shortfallPurchase = shortfallStock;
        let purchaseUnitName = '';
        if (ing.qu_id_purchase && ing.qu_id_purchase !== ing.qu_id_stock) {
            const toPurchaseFactor = findConversionFactor(quConversions, ing.product_id, ing.qu_id_stock, ing.qu_id_purchase);
            if (toPurchaseFactor !== null) shortfallPurchase = shortfallStock * toPurchaseFactor;
            const puUnit = unitMap.get(ing.qu_id_purchase);
            purchaseUnitName = puUnit ? (puUnit.name_short || puUnit.name || '') : '';
        } else {
            const stUnit = unitMap.get(ing.qu_id_stock);
            purchaseUnitName = stUnit ? (stUnit.name_short || stUnit.name || '') : '';
        }

        return {
            product_id: ing.product_id, product_name: ing.product_name,
            amount_needed: fmtNeeded.amount, amount_stock: fmtStock.amount,
            unit: fmtNeeded.unit, stock_unit: fmtStock.unit,
            status, ingredient_group: ing.ingredient_group,
            shortfall_purchase: Math.ceil(shortfallPurchase * 100) / 100,
            purchase_unit: purchaseUnitName,
        };
    });

    // Gruppér
    const groupsMap = {};
    for (const ing of ingredients) {
        const g = ing.ingredient_group || '';
        if (!groupsMap[g]) groupsMap[g] = [];
        groupsMap[g].push(ing);
    }
    const groupNames = Object.keys(groupsMap).sort((a, b) => {
        const aL = a.toLowerCase(), bL = b.toLowerCase();
        if (aL === 'emballage') return 1;  if (bL === 'emballage') return -1;
        if (a === '') return -1;  if (b === '') return 1;
        return a.localeCompare(b, 'da');
    });
    const statusOrder = { mangler: 0, lav: 1, ok: 2 };
    const groups = groupNames.map(name => ({
        name,
        ingredients: groupsMap[name].sort((a, b) =>
            (statusOrder[a.status] - statusOrder[b.status]) || a.product_name.localeCompare(b.product_name, 'da')
        ),
    }));

    res.json({ bon_ids: bonIds, ingredients, groups, lines_without_recipe: linesWithoutRecipe });
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
            co.name  AS company_name
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
