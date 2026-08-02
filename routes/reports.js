/**
 * routes/reports.js
 * ════════════════════════════════════════════════════════════
 * Rapport-endpoints til Office rapportmodul.
 *
 * GET /api/reports/summary        — KPI strip YTD
 * GET /api/reports/monthly        — 12 months bar data
 * GET /api/reports/top-customers  — Top 10 kunder
 * GET /api/reports/categories     — Priskategori-fordeling YTD
 * GET /api/reports/monthly-table  — Månedlig KPI-tabel
 * GET /api/reports/lego           — Lego-sammenligning per kategori
 * GET /api/reports/cumulative     — Ugentlig kumulativ kurve
 * GET /api/reports/top-categories — Top 10 produktkategorier YTD
 * ════════════════════════════════════════════════════════════
 */

const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle, inclToExcl, momsOfIncl, getUnitCountCategories, salesPriceCategorySql, revenueFactorSQL, getNonRevenuePaymentCodes } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

// ─── Auth on all routes ──────────────────────────────────────
router.use(requireAuth());

// ─── Shared constants ────────────────────────────────────────

const REVENUE_CODES = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];
// Booket pipeline: bekræftede/aktive bons der endnu ikke er leveret (≠ realiseret omsætning).
// Bruges til at vise forventet omsætning på kommende måneder i månedstabellen.
// AFLYST udelades helt; TILBUD fanges allerede af OFFER_INTERNAL_FILTER.
const PIPELINE_CODES = ['NY', 'VENTER', 'GODKENDT', 'IGANG', 'KLAR'];
const OFFER_INTERNAL_FILTER = 'AND COALESCE(b.is_offer, 0) = 0 AND COALESCE(b.is_internal, 0) = 0';

const MONTH_LABELS = [
    'Januar', 'Februar', 'Marts', 'April', 'Maj', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'December'
];

// ─── Helpers ─────────────────────────────────────────────────

function _thisYear() {
    return new Date().getFullYear().toString();
}

/**
 * YTD-dato-grænser: returnerer { thisStart, thisEnd, prevStart, prevEnd }
 * som ISO YYYY-MM-DD strings hvor *End er eksklusiv (delivery_date < end).
 *
 * thisStart = 1. januar i år
 * thisEnd   = i morgen (så hele dagen i dag tæller med)
 * prevStart = 1. januar sidste år
 * prevEnd   = samme dato sidste år, eksklusiv
 *
 * Bruges af /summary og /categories til æbler-mod-æbler YoY-sammenligning —
 * uden klampen sammenlignes YTD i år mod HELE sidste år, hvilket giver
 * misvisende fald (-76 % omsætning når man kun er 5 måneder inde i året).
 */
function _ytdBounds() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);             // Date håndterer måneds-overflow
    const prevTomorrow = new Date(tomorrow);
    prevTomorrow.setFullYear(tomorrow.getFullYear() - 1);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const yr = now.getFullYear();
    return {
        thisStart: `${yr}-01-01`,
        thisEnd:   fmt(tomorrow),
        prevStart: `${yr - 1}-01-01`,
        prevEnd:   fmt(prevTomorrow),
    };
}

function _statusPlaceholders(codes) {
    return codes.map(() => '?').join(',');
}

/**
 * Fælles rapport-filtre fra query-string.
 *
 *   ?from=YYYY-MM-DD   inklusiv nedre grænse for delivery_date
 *   ?to=YYYY-MM-DD     EKSKLUSIV øvre grænse (delivery_date < to) — matcher YTD-konventionen
 *   ?exclude_cats=a,b  price_category-koder der SKAL udelades (fx "festival,produktion")
 *
 * Periode-default = YTD (1. jan i år → i morgen), så en rapport UDEN filtre opfører
 * sig præcis som før. prev* = samme periode skubbet ét år tilbage ("samme længde
 * året før") — for YTD-defaulten giver det nøjagtig de gamle _ytdBounds()-værdier.
 *
 * Fragmenterne appendes SIDST i WHERE (efter status + OFFER_INTERNAL_FILTER), og
 * args appendes i SAMME rækkefølge, så placeholder-rækkefølgen holder:
 *   .all(...statusArgs, ...f.periodArgs, ...f.catArgs)
 *   .all(...statusArgs, ...f.prevPeriodArgs, ...f.catArgs)   // YoY
 *
 * catClause er uafhængig af periode og bruges også af de kort der beholder deres
 * egen tidsakse (månedssøjler, akkumuleret, legoklods) — så "fjern festival"
 * rammer hvert eneste tal.
 */
function parseReportFilters(req) {
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const q = req.query || {};

    // ── Periode ──────────────────────────────────────────────
    let from = ISO.test(q.from || '') ? q.from : null;
    let to   = ISO.test(q.to   || '') ? q.to   : null;
    const customPeriod = !!(from && to && from < to);
    if (!customPeriod) {
        const b = _ytdBounds();
        from = b.thisStart;
        to   = b.thisEnd;
    }
    // Skub begge datoer ét år tilbage (Date håndterer måneds-/skudårs-overflow
    // som setFullYear, jf. _ytdBounds).
    const shiftYear = (iso) => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
    };
    const prevFrom = shiftYear(from);
    const prevTo   = shiftYear(to);

    // ── Kategori-udeladelse ──────────────────────────────────
    let excl = [];
    if (typeof q.exclude_cats === 'string' && q.exclude_cats.trim()) {
        excl = q.exclude_cats.split(',').map(s => s.trim()).filter(Boolean);
    }
    const catClause = excl.length
        ? `AND b.price_category NOT IN (${excl.map(() => '?').join(',')})`
        : '';

    return {
        customPeriod,
        from, to, prevFrom, prevTo,
        periodClause:   'AND b.delivery_date >= ? AND b.delivery_date < ?',
        periodArgs:     [from, to],
        prevPeriodArgs: [prevFrom, prevTo],
        catClause,
        catArgs:        excl,
    };
}

/** Round to 2 decimals */
function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

/**
 * Bygger SQL CASE-udtryk der returnerer quantity hvis category er en
 * enheds-kategori (jf. settings.unit_count_categories), ellers 0.
 * Bruges i SUM() til at få "antal enheder"-metrics korrekt — sandwich,
 * slider og salat tæller, kager/drikke/emballage/levering gør ikke.
 * Returnerer { sql, args } så placeholder-rækkefølgen passer i .all().
 */
function _unitCaseExpr() {
    const cats = getUnitCountCategories();
    if (cats.length === 0) return { sql: '0', args: [] };
    const placeholders = cats.map(() => '?').join(',');
    return { sql: `CASE WHEN bl.category IN (${placeholders}) THEN bl.quantity ELSE 0 END`, args: cats };
}

/**
 * Som _unitCaseExpr, men SALGS-linsen: produktions-bonner (priskategori
 * 'produktion' = prep/top-up) tæller IKKE som solgte enheder. Kræver at
 * price_categories er joinet som `pc` (via price_category_id). Bruges i økonomi-
 * /omsætningsrapporter så festival-maden ikke dobbelttælles (prep + salg).
 */
function _salesUnitCaseExpr() {
    const cats = getUnitCountCategories();
    if (cats.length === 0) return { sql: '0', args: [] };
    const placeholders = cats.map(() => '?').join(',');
    return {
        sql: `CASE WHEN ${salesPriceCategorySql('pc.code')} AND bl.category IN (${placeholders}) THEN bl.quantity ELSE 0 END`,
        args: cats,
    };
}

/**
 * Konstruer 3-felt moms-mønster fra incl-moms-total.
 * Rapporter-konvention: revenue_excl_moms er primær. Se BON_V2_PRINCIPPER.md sektion 6c.
 */
function revenueFields(inclMoms) {
    const incl = r2(inclMoms);
    const excl = r2(inclToExcl(incl));
    const vat  = r2(momsOfIncl(incl));
    return {
        revenue_excl_moms: excl,
        revenue_incl_moms: incl,
        vat_collected:     vat,
    };
}

// ─── GET /summary — KPI strip YTD ───────────────────────────

router.get('/summary', handle(async (req, res) => {
    const db = getDb();
    const f = parseReportFilters(req);

    // Revenue + orders for perioden
    const ytd = db.prepare(`
        SELECT
            COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
            COUNT(DISTINCT b.id) AS orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
    `).get(...REVENUE_CODES, ...f.periodArgs, ...f.catArgs);

    // Revenue + orders samme periode året før (æbler-mod-æbler)
    const ytdPrev = db.prepare(`
        SELECT
            COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
            COUNT(DISTINCT b.id) AS orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
    `).get(...REVENUE_CODES, ...f.prevPeriodArgs, ...f.catArgs);

    // Pending invoice (LEVERET i perioden)
    const pending = db.prepare(`
        SELECT
            COUNT(DISTINCT b.id) AS cnt,
            COALESCE(SUM(b.total_price${revenueFactorSQL('b')}), 0) AS amount
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code = 'LEVERET'
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
    `).get(...f.periodArgs, ...f.catArgs);

    const avgThis = ytd.orders > 0 ? Math.round(ytd.revenue / ytd.orders) : 0;
    const avgPrev = ytdPrev.orders > 0 ? Math.round(ytdPrev.revenue / ytdPrev.orders) : 0;

    // 3-felt mønster (ex/incl/vat) for revenue — primær er ex moms (regnskab).
    // Se BON_V2_PRINCIPPER.md sektion 6c. Bagudkompatibel: gamle felter bevares som incl-moms.
    const ytdMoms      = revenueFields(ytd.revenue);
    const ytdPrevMoms  = revenueFields(ytdPrev.revenue);
    const pendingMoms  = revenueFields(pending.amount);

    res.json({
        // Bagudkompatibilitet — incl moms (gamle felter)
        revenue_ytd:       ytd.revenue,
        revenue_ytd_prev:  ytdPrev.revenue,
        avg_order_value:   avgThis,
        avg_order_prev:    avgPrev,
        pending_invoice:   pending.amount,
        // Nye eksplicitte felter
        revenue_ytd_excl_moms:      ytdMoms.revenue_excl_moms,
        revenue_ytd_incl_moms:      ytdMoms.revenue_incl_moms,
        vat_collected_ytd:          ytdMoms.vat_collected,
        revenue_ytd_prev_excl_moms: ytdPrevMoms.revenue_excl_moms,
        revenue_ytd_prev_incl_moms: ytdPrevMoms.revenue_incl_moms,
        avg_order_value_excl_moms:  r2(inclToExcl(avgThis)),
        avg_order_prev_excl_moms:   r2(inclToExcl(avgPrev)),
        pending_invoice_excl_moms:  pendingMoms.revenue_excl_moms,
        pending_invoice_incl_moms:  pendingMoms.revenue_incl_moms,
        orders_ytd:        ytd.orders,
        orders_ytd_prev:   ytdPrev.orders,
        pending_count:     pending.cnt,
    });
}));

// ─── GET /monthly — 12 month bars ───────────────────────────

router.get('/monthly', handle(async (req, res) => {
    const db = getDb();
    const now = new Date();
    const thisYear = now.getFullYear();

    // Last 12 months range
    const endMonth = `${thisYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startDate = new Date(thisYear, now.getMonth() - 11, 1);
    const startMonth = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;

    // Prev year range (offset by 12 months)
    const prevStartDate = new Date(startDate.getFullYear() - 1, startDate.getMonth(), 1);
    const prevEndDate = new Date(thisYear - 1, now.getMonth(), 1);
    const prevStartMonth = `${prevStartDate.getFullYear()}-${String(prevStartDate.getMonth() + 1).padStart(2, '0')}`;
    const prevEndMonth = `${prevEndDate.getFullYear()}-${String(prevEndDate.getMonth() + 1).padStart(2, '0')}`;

    const unit = _salesUnitCaseExpr();   // salgs-enheder: ekskl. produktion
    // Månedssøjlerne beholder deres rullende 12-mdrs akse (egen tidsakse per aftalen);
    // kun kategori-filteret gælder her, så "fjern festival" også rammer trend-kortet.
    const f = parseReportFilters(req);

    const thisYearRows = db.prepare(`
        SELECT
            strftime('%Y-%m', b.delivery_date) AS month,
            COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
            COALESCE(SUM(${unit.sql}), 0) AS units,
            COUNT(DISTINCT b.id) AS orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.catClause}
          AND strftime('%Y-%m', b.delivery_date) >= ?
          AND strftime('%Y-%m', b.delivery_date) <= ?
        GROUP BY strftime('%Y-%m', b.delivery_date)
        ORDER BY month
    `).all(...unit.args, ...REVENUE_CODES, ...f.catArgs, startMonth, endMonth);

    const prevYearRows = db.prepare(`
        SELECT
            strftime('%Y-%m', b.delivery_date) AS month,
            COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
            COALESCE(SUM(${unit.sql}), 0) AS units,
            COUNT(DISTINCT b.id) AS orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.catClause}
          AND strftime('%Y-%m', b.delivery_date) >= ?
          AND strftime('%Y-%m', b.delivery_date) <= ?
        GROUP BY strftime('%Y-%m', b.delivery_date)
        ORDER BY month
    `).all(...unit.args, ...REVENUE_CODES, ...f.catArgs, prevStartMonth, prevEndMonth);

    // Tilføj 3-felt mønster pr måned (regnskabskonvention: revenue_excl_moms primær)
    const decorate = rows => rows.map(r => ({
        ...r,
        revenue_excl_moms: r2(inclToExcl(r.revenue)),
        revenue_incl_moms: r2(r.revenue),
        vat_collected:     r2(momsOfIncl(r.revenue)),
    }));

    res.json({
        this_year: decorate(thisYearRows),
        prev_year: decorate(prevYearRows),
    });
}));

// ─── GET /top-customers — Top 10 kunder ─────────────────────

router.get('/top-customers', handle(async (req, res) => {
    const db = getDb();
    const by = req.query.by === 'orders' ? 'orders' : 'revenue';
    const f = parseReportFilters(req);

    // Aggregér per firma når company_id findes, ellers per kunde.
    // Det undgår at samme firma ("Ristet Rug", "Cisco" osv.) optræder flere gange
    // når flere kontaktpersoner på samme CVR har lagt ordrer.
    // entity_key er en virtuel id: "co:NN" for firma, "cu:NN" for privatkunde.
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN b.company_id IS NOT NULL THEN 'co:' || b.company_id
                ELSE 'cu:' || b.customer_id
            END AS entity_key,
            CASE WHEN b.company_id IS NOT NULL THEN b.company_id ELSE NULL END AS company_id,
            CASE WHEN b.company_id IS NULL THEN b.customer_id ELSE NULL END AS customer_id,
            COALESCE(
                MAX(CASE WHEN b.company_id IS NOT NULL THEN co.name END),
                MAX(c.first_name || ' ' || COALESCE(c.last_name, ''))
            ) AS display_name,
            COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
            COUNT(DISTINCT b.id) AS orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN customers c ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
          AND (b.company_id IS NOT NULL OR b.customer_id IS NOT NULL)
        GROUP BY entity_key
        ORDER BY ${by === 'orders' ? 'orders' : 'revenue'} DESC
        LIMIT 10
    `).all(...REVENUE_CODES, ...f.periodArgs, ...f.catArgs);

    // Compute total for pct
    const total = db.prepare(`
        SELECT COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS total_revenue,
               COUNT(DISTINCT b.id) AS total_orders
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
    `).get(...REVENUE_CODES, ...f.periodArgs, ...f.catArgs);

    const totalVal = by === 'orders' ? (total.total_orders || 1) : (total.total_revenue || 1);

    const customers = rows.map(r => ({
        // Bagudkomp: 'id' var customer_id før. Nu sætter vi den til company_id når firma findes
        // (matcher hvad clicks skal navigere til — firmaer aggregeres jo nu),
        // ellers customer_id.
        id:            r.company_id || r.customer_id,
        entity_type:   r.company_id ? 'company' : 'customer',
        entity_key:    r.entity_key,
        display_name:  (r.display_name || '').trim(),
        // Regnskabskonvention: revenue_excl_moms er primær (jf. BON_V2_PRINCIPPER.md sektion 6c)
        revenue:           r.revenue,                            // bagudkomp. (incl moms)
        revenue_excl_moms: r2(inclToExcl(r.revenue)),
        revenue_incl_moms: r2(r.revenue),
        vat_collected:     r2(momsOfIncl(r.revenue)),
        orders:        r.orders,
        pct_of_total:  Math.round(((by === 'orders' ? r.orders : r.revenue) / totalVal) * 1000) / 10,
    }));

    res.json({ by, customers });
}));

// ─── GET /categories — Priskategori-fordeling YTD ────────────

router.get('/categories', handle(async (req, res) => {
    const db = getDb();
    const f = parseReportFilters(req);

    function fetchCategories(periodArgs) {
        const unit = _unitCaseExpr();
        const rows = db.prepare(`
            SELECT
                pc.code,
                pc.label,
                COALESCE(SUM(${unit.sql}), 0) AS units,
                COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            JOIN bon_lines bl ON bl.bon_id = b.id
            LEFT JOIN price_categories pc ON pc.code = b.price_category
            WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
              ${OFFER_INTERNAL_FILTER}
              ${f.periodClause}
              ${f.catClause}
            GROUP BY pc.code
            ORDER BY pc.sort_order, pc.code
        `).all(...unit.args, ...REVENUE_CODES, ...periodArgs, ...f.catArgs);

        const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0) || 1;
        return rows.map(r => ({
            code:    r.code,
            label:   r.label || r.code,
            // Produktion (prep/top-up) er intern produktion — 0 kr, IKKE salg. Enheds-tallet
            // vises stadig (køkkenets produktionsvolumen), men frontenden mærker rækken så
            // tallet ikke læses som solgte enheder. Salgs-andelen er allerede 0 % (0 kr).
            is_production: r.code === 'produktion',
            units:   r.units,
            revenue: r.revenue,                                  // bagudkomp. (incl moms)
            revenue_excl_moms: r2(inclToExcl(r.revenue)),
            revenue_incl_moms: r2(r.revenue),
            vat_collected:     r2(momsOfIncl(r.revenue)),
            pct:     Math.round((r.revenue / totalRevenue) * 1000) / 10,
        }));
    }

    res.json({
        this_year: fetchCategories(f.periodArgs),
        prev_year: fetchCategories(f.prevPeriodArgs),
    });
}));

// ─── GET /monthly-table — Månedlig KPI-tabel ─────────────────

router.get('/monthly-table', handle(async (req, res) => {
    const db = getDb();
    const f = parseReportFilters(req);
    const now = new Date();
    const actualYear = now.getFullYear();
    // Månedstabellen er en kalenderårs-tabel (12 rækker). Periode-filteret bestemmer
    // HVILKET år der vises = året for periodens fra-dato. Kategori-filteret gælder.
    const thisYear = parseInt(f.from.slice(0, 4)) || actualYear;
    const isCurrentYear = thisYear === actualYear;
    // For et forgangent år er alle måneder realiseret — intet er "current"/"future".
    const currentMonth = isCurrentYear ? (now.getMonth() + 1) : 13;
    const prevYear = thisYear - 1;

    // Fetch monthly data for a given year, filtered by a set of status codes.
    // Index'eres efter month_nr af kalderen.
    function fetchMonthly(year, codes) {
        const unit = _salesUnitCaseExpr();   // salgs-enheder: ekskl. produktion
        return db.prepare(`
            SELECT
                CAST(strftime('%m', b.delivery_date) AS INTEGER) AS month_nr,
                COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue,
                COUNT(DISTINCT b.id) AS orders,
                COALESCE(SUM(${unit.sql}), 0) AS units
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            JOIN bon_lines bl ON bl.bon_id = b.id
            LEFT JOIN price_categories pc ON pc.id = b.price_category_id
            WHERE sd.code IN (${_statusPlaceholders(codes)})
              ${OFFER_INTERNAL_FILTER}
              ${f.catClause}
              AND strftime('%Y', b.delivery_date) = ?
            GROUP BY CAST(strftime('%m', b.delivery_date) AS INTEGER)
        `).all(...unit.args, ...codes, ...f.catArgs, year.toString());
    }

    function indexByMonth(rows) {
        const map = {};
        for (const r of rows) map[r.month_nr] = r;
        return map;
    }

    const ACTIVE_CODES = [...REVENUE_CODES, ...PIPELINE_CODES];

    // Realiseret omsætning (leveret+) i år + sidste år
    const realizedThis = indexByMonth(fetchMonthly(thisYear, REVENUE_CODES));
    const realizedPrev = indexByMonth(fetchMonthly(prevYear, REVENUE_CODES));
    // Booket pipeline (bekræftet men ikke leveret) i år — forventet omsætning
    const bookedThis   = indexByMonth(fetchMonthly(thisYear, PIPELINE_CODES));
    // Ordrer + enheder tæller ALLE aktive bons (realiseret + booket), så kommende
    // måneder ikke står 0/0 ved siden af en booket-værdi.
    const activeThis   = indexByMonth(fetchMonthly(thisYear, ACTIVE_CODES));

    // Pending invoice for current month
    const monthStart = `${thisYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const monthEnd = currentMonth === 12
        ? `${thisYear}-12-31`
        : `${thisYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

    // Ufaktureret giver kun mening for den nuværende måned i indeværende år.
    const pendingRow = isCurrentYear ? db.prepare(`
        SELECT COALESCE(SUM(b.total_price${revenueFactorSQL('b')}), 0) AS amount
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE sd.code = 'LEVERET'
          ${OFFER_INTERNAL_FILTER}
          ${f.catClause}
          AND b.delivery_date >= ? AND b.delivery_date < ?
    `).get(monthStart, monthEnd, ...f.catArgs) : { amount: 0 };

    // YoY æbler-mod-æbler: den nuværende måned er kun delvist gået, så den må
    // sammenlignes mod SAMME datospan sidste år — ikke hele måneden. Ellers ser
    // en halv måned altid ud som et fald. (Samme princip som _ytdBounds for KPI-stripen.)
    const todayDay = now.getDate();
    const cmStr = String(currentMonth).padStart(2, '0');
    const prevClampStart = `${prevYear}-${cmStr}-01`;
    const clampEndDate = new Date(prevYear, currentMonth - 1, todayDay + 1); // Date håndterer overflow
    const prevClampEnd = `${clampEndDate.getFullYear()}-${String(clampEndDate.getMonth() + 1).padStart(2, '0')}-${String(clampEndDate.getDate()).padStart(2, '0')}`;
    const prevClampRow = db.prepare(`
        SELECT COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.catClause}
          AND b.delivery_date >= ? AND b.delivery_date < ?
    `).get(...REVENUE_CODES, ...f.catArgs, prevClampStart, prevClampEnd);

    const rows = [];
    for (let m = 1; m <= 12; m++) {
        const t      = realizedThis[m] || { revenue: 0, orders: 0, units: 0 };
        const booked = bookedThis[m]   || { revenue: 0, orders: 0, units: 0 };
        const active = activeThis[m]   || { revenue: 0, orders: 0, units: 0 };
        const isCurrent = m === currentMonth;
        const isFuture  = m > currentMonth;

        // Prev-år til YoY: fuld måned for forgangne måneder, datospan-klampet for
        // den nuværende (MTD) måned. Fremtidige måneder sammenlignes ikke (is_future).
        const pRev = isCurrent
            ? prevClampRow.revenue
            : (realizedPrev[m]?.revenue || 0);

        const deltaPct = pRev > 0
            ? Math.round(((t.revenue - pRev) / pRev) * 1000) / 10
            : (t.revenue > 0 ? 100 : 0);

        // Gns. ordreværdi over alle aktive bons (realiseret + booket) så fremtidige
        // måneder med booket pipeline også får et meningsfuldt tal.
        const activeRevenue = t.revenue + booked.revenue;

        rows.push({
            month_label:      MONTH_LABELS[m - 1],
            is_current:       isCurrent,
            is_future:        isFuture,
            // Realiseret omsætning — bagudkomp. (incl moms)
            revenue_this:     t.revenue,
            revenue_prev:     pRev,
            // Eksplicit ex/incl/vat (regnskabskonvention: ex moms primær)
            revenue_this_excl_moms: r2(inclToExcl(t.revenue)),
            revenue_this_incl_moms: r2(t.revenue),
            vat_this_collected:     r2(momsOfIncl(t.revenue)),
            revenue_prev_excl_moms: r2(inclToExcl(pRev)),
            revenue_prev_incl_moms: r2(pRev),
            // Booket pipeline (forventet, ikke leveret endnu)
            revenue_booked:           booked.revenue,
            revenue_booked_excl_moms: r2(inclToExcl(booked.revenue)),
            revenue_booked_incl_moms: r2(booked.revenue),
            delta_pct:        deltaPct,
            orders:           active.orders,
            units:            active.units,
            avg_order_value:           active.orders > 0 ? Math.round(activeRevenue / active.orders) : 0,
            avg_order_value_excl_moms: active.orders > 0 ? r2(inclToExcl(activeRevenue) / active.orders) : 0,
            pending_invoice:           isCurrent ? pendingRow.amount : null,
            pending_invoice_excl_moms: isCurrent ? r2(inclToExcl(pendingRow.amount)) : null,
        });
    }

    res.json({ rows });
}));

// ─── GET /lego — Pax-baseret legoklods-rapport ────────────────
//
// Query params (vælg ÉN form):
//   ?periods=2026-05,2025-05         — eksplicit liste af (år, måned)-perioder.
//                                       Hver periode = 1 søjle-stak side om side.
//                                       Max 3 perioder. Bruges til år-mod-år-sammenligning.
//   ?months=6,7&year=2025            — backwards compat: 1 måned = 1 periode,
//                                       2 måneder = 2 perioder, 3+ = aggregeret i 1.
//
// Hvert bon tildeles en pax-kategori fra settings ('lego_pax_categories').
// Festival-bons (price_category='festival') → 'festival' uanset pax.

router.get('/lego', handle(async (req, res) => {
    const db = getDb();
    const now = new Date();
    const defaultYear = now.getFullYear();
    // Legoklods beholder sine egne måneds-vælgere (egen tidsakse) — kun kategori-filteret gælder.
    const f = parseReportFilters(req);

    // Parse perioder. Ny form (periods=) vinder over gammel (months+year).
    // Periode-format: "YYYY-MM" → { year, months: [m] }.
    // Backwards compat: months=6,7 + year=2025 → 1-2 perioder afhængigt af antal måneder.
    let periodSpecs;       // array af { year, months: [m1,m2,...] }
    if (req.query.periods) {
        periodSpecs = req.query.periods.split(',')
            .map(p => p.trim())
            .map(p => {
                const m = p.match(/^(\d{4})-(\d{1,2})$/);
                if (!m) return null;
                const yr = parseInt(m[1]);
                const mo = parseInt(m[2]);
                if (yr < 2000 || yr > 2100 || mo < 1 || mo > 12) return null;
                return { year: yr, months: [mo] };
            })
            .filter(Boolean)
            .slice(0, 3);   // max 3 perioder side om side
        if (periodSpecs.length === 0) periodSpecs = null;
    }
    if (!periodSpecs) {
        const year = parseInt(req.query.year) || defaultYear;
        let months;
        if (req.query.months) {
            months = req.query.months.split(',').map(m => parseInt(m.trim())).filter(m => m >= 1 && m <= 12);
        } else {
            months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        }
        // Backwards compat: <=2 måneder = 1 periode hver, ellers aggregér til 1
        periodSpecs = months.length <= 2
            ? months.map(m => ({ year, months: [m] }))
            : [{ year, months }];
    }

    // Load pax categories from settings
    const catRow = db.prepare(`SELECT value FROM settings WHERE key = 'lego_pax_categories'`).get();
    let paxCats;
    try { paxCats = JSON.parse(catRow?.value); } catch (_) { paxCats = []; }
    if (!Array.isArray(paxCats) || !paxCats.length) {
        paxCats = [
            { key: 'smaa', label: 'Små', max_pax: 20, color: '#4a90d9', sort_order: 1 },
            { key: 'mellem', label: 'Mellem', max_pax: 80, color: '#c49a45', sort_order: 2 },
            { key: 'store', label: 'Store', max_pax: 120, color: '#6d4c16', sort_order: 3 },
            { key: 'events', label: 'Events', max_pax: 180, color: '#7a9c54', sort_order: 4 },
            { key: 'festival', label: 'Festival', max_pax: null, color: '#d4652a', sort_order: 5 },
        ];
    }
    paxCats.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    // Classify a bon into a pax category key
    function classify(pax, priceCategory) {
        if (priceCategory === 'festival') return 'festival';
        for (const cat of paxCats) {
            if (cat.key === 'festival') continue;
            if (cat.max_pax != null && (pax || 0) <= cat.max_pax) return cat.key;
        }
        // Fallback: last non-festival category
        const nonFest = paxCats.filter(c => c.key !== 'festival');
        return nonFest.length ? nonFest[nonFest.length - 1].key : 'other';
    }

    // Fetch individual bons with revenue for a given year + months
    function fetchBons(yr, filterMonths) {
        const monthPlaceholders = filterMonths.map(() => '?').join(',');
        return db.prepare(`
            SELECT
                b.id, b.pax, b.price_category,
                COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            LEFT JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
              ${OFFER_INTERNAL_FILTER}
              ${f.catClause}
              AND strftime('%Y', b.delivery_date) = ?
              AND CAST(strftime('%m', b.delivery_date) AS INTEGER) IN (${monthPlaceholders})
            GROUP BY b.id
        `).all(...REVENUE_CODES, ...f.catArgs, yr.toString(), ...filterMonths);
    }

    // Aggregate bons into stacks by pax category
    function aggregate(bons) {
        const buckets = {};
        for (const cat of paxCats) {
            buckets[cat.key] = { key: cat.key, label: cat.label, color: cat.color, orders: 0, revenue: 0 };
        }
        for (const bon of bons) {
            const catKey = classify(bon.pax, bon.price_category);
            if (!buckets[catKey]) buckets[catKey] = { key: catKey, label: catKey, color: '#999', orders: 0, revenue: 0 };
            buckets[catKey].orders++;
            buckets[catKey].revenue += bon.revenue || 0;
        }
        // Tilføj 3-felt mønster pr stack (regnskabskonvention: ex moms primær)
        return paxCats.map(c => buckets[c.key]).filter(b => b).map(b => ({
            ...b,
            revenue_excl_moms: r2(inclToExcl(b.revenue)),
            revenue_incl_moms: r2(b.revenue),
            vat_collected:     r2(momsOfIncl(b.revenue)),
        }));
    }

    const periods = periodSpecs.map(spec => {
        const bons = fetchBons(spec.year, spec.months);
        const pMonths = spec.months;
        const label = pMonths.length === 1
            ? MONTH_LABELS[pMonths[0] - 1] + ' ' + spec.year
            : (pMonths.length === 12 ? 'Hele ' + spec.year : pMonths.map(m => MONTH_LABELS[m - 1]).join(' + ') + ' ' + spec.year);
        return { label, months: pMonths, year: spec.year, stacks: aggregate(bons) };
    });

    res.json({ periods, categories: paxCats });
}));

// ─── GET /cumulative — Ugentlig kumulativ kurve ──────────────

router.get('/cumulative', handle(async (req, res) => {
    const db = getDb();
    const thisYear = parseInt(_thisYear());
    // Akkumuleret beholder sine år-kurver (egen tidsakse) — kun kategori-filteret gælder.
    const f = parseReportFilters(req);

    // Parse years param or default to current + 2 previous
    let years;
    if (req.query.years) {
        years = req.query.years.split(',').map(y => parseInt(y.trim())).filter(y => y > 2000 && y <= thisYear + 1);
    } else {
        years = [thisYear - 2, thisYear - 1, thisYear];
    }

    const result = {};

    for (const year of years) {
        const rows = db.prepare(`
            SELECT
                week_nr,
                revenue,
                SUM(revenue) OVER (ORDER BY week_nr) AS cumulative
            FROM (
                SELECT
                    CAST(strftime('%W', b.delivery_date) AS INTEGER) AS week_nr,
                    COALESCE(SUM(bl.quantity * bl.unit_price${revenueFactorSQL('b')}), 0) AS revenue
                FROM bons b
                JOIN status_definitions sd ON b.status_id = sd.id
                JOIN bon_lines bl ON bl.bon_id = b.id
                WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
                  ${OFFER_INTERNAL_FILTER}
                  ${f.catClause}
                  AND strftime('%Y', b.delivery_date) = ?
                GROUP BY CAST(strftime('%W', b.delivery_date) AS INTEGER)
            )
            ORDER BY week_nr
        `).all(...REVENUE_CODES, ...f.catArgs, year.toString());

        // Tilføj 3-felt mønster pr uge (regnskabskonvention: ex moms primær)
        result[year.toString()] = rows.map(r => ({
            week:       r.week_nr,
            cumulative:           r.cumulative,                            // bagudkomp.
            cumulative_excl_moms: r2(inclToExcl(r.cumulative)),
            cumulative_incl_moms: r2(r.cumulative),
        }));
    }

    res.json({ years: result });
}));

// ─── GET /top-categories — Top 10 produktkategorier YTD ──────

router.get('/top-categories', handle(async (req, res) => {
    const db = getDb();
    const f = parseReportFilters(req);

    const rows = db.prepare(`
        SELECT
            COALESCE(bl.category, 'Uden kategori') AS category,
            COALESCE(SUM(bl.quantity), 0) AS units
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          AND ${salesPriceCategorySql('pc.code')}
          ${f.catClause}
          AND bl.is_accessory = 0
          ${f.periodClause}
        GROUP BY COALESCE(bl.category, 'Uden kategori')
        ORDER BY units DESC
        LIMIT 10
    `).all(...REVENUE_CODES, ...f.catArgs, ...f.periodArgs);

    // Compute total units for pct
    const totalRow = db.prepare(`
        SELECT COALESCE(SUM(bl.quantity), 0) AS total
        FROM bon_lines bl
        JOIN bons b ON bl.bon_id = b.id
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          AND ${salesPriceCategorySql('pc.code')}
          ${f.catClause}
          AND bl.is_accessory = 0
          ${f.periodClause}
    `).get(...REVENUE_CODES, ...f.catArgs, ...f.periodArgs);

    const totalUnits = totalRow.total || 1;

    const categories = rows.map(r => ({
        category: r.category,
        units:    r.units,
        pct:      Math.round((r.units / totalUnits) * 1000) / 10,
    }));

    res.json({ categories });
}));

// ─── GET /giveaways — Modregning/Sponsorat (ikke omsætning, men findbar) ──────
// Summerer de ÆGTE priser på bons med ikke-omsætnings-betalingstyper, så man kan
// se hvor meget mad der blev givet væk eller byttet. Bevidst uden revenueFactorSQL
// (her VIL vi have beløbet). Default YTD; ?from=&to= (YYYY-MM-DD) overstyrer.
router.get('/giveaways', handle(async (req, res) => {
    const db = getDb();
    const codes = getNonRevenuePaymentCodes();
    if (!codes.length) {
        return res.json({ from: null, to: null, types: [], total_incl_moms: 0, total_excl_moms: 0, orders: 0 });
    }

    // Følger den globale periode + kategori-filter (samme parser som resten).
    const f = parseReportFilters(req);
    const from = f.from, to = f.to;

    const rows = db.prepare(`
        SELECT b.payment_type AS code,
               COALESCE(pt.label, b.payment_type) AS label,
               COUNT(DISTINCT b.id) AS orders,
               COALESCE(SUM(bl.quantity * bl.unit_price), 0) AS total_incl
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        JOIN bon_lines bl ON bl.bon_id = b.id
        LEFT JOIN payment_types pt ON pt.code = b.payment_type
        WHERE b.payment_type IN (${codes.map(() => '?').join(',')})
          AND sd.code IN (${_statusPlaceholders(REVENUE_CODES)})
          ${OFFER_INTERNAL_FILTER}
          ${f.periodClause}
          ${f.catClause}
        GROUP BY b.payment_type, pt.label
        ORDER BY total_incl DESC
    `).all(...codes, ...REVENUE_CODES, ...f.periodArgs, ...f.catArgs);

    let totalIncl = 0, orders = 0;
    const types = rows.map(r => {
        totalIncl += r.total_incl;
        orders    += r.orders;
        return {
            code:  r.code,
            label: r.label,
            orders: r.orders,
            total_incl_moms: r.total_incl,
            total_excl_moms: Math.round(inclToExcl(r.total_incl) * 100) / 100,
        };
    });

    res.json({
        from, to,
        types,
        orders,
        total_incl_moms: totalIncl,
        total_excl_moms: Math.round(inclToExcl(totalIncl) * 100) / 100,
    });
}));

module.exports = router;
