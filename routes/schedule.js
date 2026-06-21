/**
 * routes/schedule.js
 * ════════════════════════════════════════════════════════════
 * Ugeoversigt API.
 *
 * GET /api/schedule/week?from=&to=
 * ════════════════════════════════════════════════════════════
 */

const express       = require('express');
const router        = express.Router();
const { getDb }     = require('../db/database');
const { handle, todayISO, countsAsWorkload }    = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { getShifts } = require('../services/smartplanAdapter');

// ─── Auth ────────────────────────────────────────────────────
router.use(requireAuth('admin', 'office', 'kitchen_personal'));

// ─── Helpers ─────────────────────────────────────────────────

const DAYS_DA = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];

function _today() {
    return todayISO();   // dansk lokal dato — ikke UTC (undgår off-by-one efter midnat)
}

/** Beregn mandag i ugen for en given dato */
function _weekMonday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay(); // 0=søn
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
}

/** Beregn søndag fra mandag */
function _weekSunday(mondayStr) {
    const d = new Date(mondayStr + 'T12:00:00');
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
}

/** ISO ugenummer */
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

/** Generér 7 datoer fra mandag */
function _weekDates(mondayStr) {
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(mondayStr + 'T12:00:00');
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
}

/** Parse "HH:MM" til decimal timer */
function _timeToDecimal(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h + (m || 0) / 60;
}

/** Beregn initialer fra navn */
function _initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Kapacitets-ratio status */
function _ratioStatus(ratio, thresholds) {
    if (ratio === null || ratio === undefined) return 'grey';
    if (ratio < thresholds.low)    return 'blue';
    if (ratio < thresholds.green)  return 'green';
    if (ratio < thresholds.yellow) return 'yellow';
    return 'red';
}

// ─── GET /week ───────────────────────────────────────────────

router.get('/week', handle(async (req, res) => {
    const db = getDb();
    const today = _today();

    // Beregn uge-interval
    let from = req.query.from || _weekMonday(today);
    let to   = req.query.to   || _weekSunday(from);

    // Hent bons — valgfrit status-filter via ?status=NY,GODKENDT,...
    // Uden filter: alle bons (ekskl. AFLYST som default)
    let statusFilter = '';
    const params = [from, to];
    if (req.query.status) {
        const codes = req.query.status.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',');
            statusFilter = `AND sd.code IN (${placeholders})`;
            params.push(...codes);
        }
    } else {
        statusFilter = `AND sd.code != 'AFLYST'`;
    }

    const bons = db.prepare(`
        SELECT b.id, b.bon_number, b.total_units, b.pax, b.event_role,
               b.pickup_time, b.delivery_time,
               sd.code AS status_code, sd.color AS status_color, sd.label AS status_label,
               COALESCE(co.name, cu.first_name || ' ' || cu.last_name) AS customer_name,
               b.delivery_date
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers cu ON b.customer_id = cu.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE b.delivery_date BETWEEN ? AND ?
          ${statusFilter}
          AND b.is_offer = 0
        ORDER BY b.delivery_date, COALESCE(b.pickup_time, b.delivery_time), b.id
    `).all(...params);

    // Hent bon_lines for lager-tjek (har alle linjer grocy_recipe_id?)
    const bonIds = bons.map(b => b.id);
    let linesByBon = {};
    if (bonIds.length > 0) {
        const placeholders = bonIds.map(() => '?').join(',');
        const lines = db.prepare(`
            SELECT bon_id, grocy_recipe_id
            FROM bon_lines
            WHERE bon_id IN (${placeholders})
        `).all(...bonIds);
        for (const l of lines) {
            if (!linesByBon[l.bon_id]) linesByBon[l.bon_id] = [];
            linesByBon[l.bon_id].push(l);
        }
    }

    // Smartplan shifts (graceful degradation)
    let allShifts = [];
    try {
        allShifts = await getShifts(from, to);
    } catch (e) {
        console.warn('[schedule] Smartplan fejl:', e.message);
    }

    // Kapacitets-settings
    const settings = {};
    const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'capacity_%' OR key = 'production_start_time'`).all();
    for (const r of rows) settings[r.key] = r.value;
    const capacityEnabled = settings.capacity_ratio_enabled === 'true';
    const productionStart = _timeToDecimal(settings.production_start_time || '08:00');
    const thresholds = {
        low:    parseFloat(settings.capacity_threshold_low    || '20'),
        green:  parseFloat(settings.capacity_threshold_green  || '35'),
        yellow: parseFloat(settings.capacity_threshold_yellow || '45'),
    };

    // Byg per-dag data
    const dates = _weekDates(from);
    const days = dates.map(date => {
        const dayObj = new Date(date + 'T12:00:00');
        const weekday = DAYS_DA[dayObj.getDay()];

        // Bons for denne dag
        const dayBons = bons
            .filter(b => b.delivery_date === date)
            .map(b => {
                const bonLines = linesByBon[b.id] || [];
                const hasLines = bonLines.length > 0;
                const allLinked = hasLines && bonLines.every(l => l.grocy_recipe_id != null);
                return {
                    id: b.id,
                    bon_number: b.bon_number,
                    status_code: b.status_code,
                    status_color: b.status_color,
                    status_label: b.status_label,
                    customer_name: b.customer_name,
                    total_units: b.total_units || 0,
                    pax: b.pax || 0,
                    event_role: b.event_role || null,
                    // Festival-salgsbons + udgifter tæller IKKE som produktion (allerede
                    // talt i prep-bonnen) — workload=0, men bonnen vises stadig i dagen.
                    workload: countsAsWorkload(b)
                        ? ((b.total_units && b.total_units > 0) ? b.total_units : (b.pax || 0))
                        : 0,
                    pickup_time: b.pickup_time || null,
                    delivery_time: b.delivery_time || null,
                    stock_status: !hasLines ? 'no_lines' : (allLinked ? 'ok' : 'missing'),
                };
            });

        // Shifts for denne dag
        const dayShifts = allShifts
            .filter(s => s.date === date)
            .map(s => ({
                is_open: !s.employee_name && !s.first_name,
                name: (s.employee_name || s.first_name) || 'Ledig vagt',
                initials: (s.employee_name || s.first_name) ? _initials(s.employee_name) : '?',
                start: s.start_time || '',
                end: s.end_time || '',
            }));

        // En vagt uden ejer er LEDIG (udlagt, endnu ikke taget) — tæller ikke som bemanding.
        const assignedShifts = dayShifts.filter(s => !s.is_open);
        const openShifts     = dayShifts.filter(s => s.is_open);

        // Lager-summary
        const stockChecked = dayBons.filter(b => b.stock_status === 'ok').length;
        const stockMissing = dayBons.filter(b => b.stock_status === 'missing').length;
        const stockNoLines = dayBons.filter(b => b.stock_status === 'no_lines').length;
        const stockTotal = dayBons.length;
        let stockStatus = 'grey';
        if (stockTotal > 0) {
            stockStatus = (stockMissing > 0 || stockNoLines > 0) ? 'orange' : 'green';
        }

        // Produktion totaler (workload = total_units > 0 ? units : pax)
        const totalUnits = dayBons.reduce((sum, b) => sum + (b.workload || 0), 0);

        // Personale: total timer
        const totalHours = assignedShifts.reduce((sum, s) => {
            const start = _timeToDecimal(s.start);
            const end = _timeToDecimal(s.end);
            return sum + (start != null && end != null ? end - start : 0);
        }, 0);

        // ── Kapacitetsberegning (dagsniveau — kører ALTID) ──
        // Formel: total_workload / tilgængelige persontimer
        // Produktionsvindue: production_start → seneste production_end
        // Persontimer: vagternes overlap med produktionsvinduet
        let dayRatio = null;
        let capStatus = 'grey';
        let capacity = { enabled: false };

        if (dayBons.length > 0 && assignedShifts.length > 0) {
            // Find seneste production_end (pickup_time || delivery_time - 45min)
            let latestEnd = 0;
            for (const b of dayBons) {
                let endDec;
                if (b.pickup_time) {
                    endDec = _timeToDecimal(b.pickup_time);
                } else if (b.delivery_time) {
                    endDec = _timeToDecimal(b.delivery_time) - 0.75;
                }
                if (endDec != null && endDec > latestEnd) latestEnd = endDec;
            }

            // Produktionsvindue: production_start_time → seneste deadline (min 1 time)
            const windowStart = productionStart;
            const rawEnd = latestEnd > windowStart ? latestEnd : windowStart + 1;
            const windowEnd = Math.max(rawEnd, windowStart + 1); // minimum 1 times vindue

            // Tilgængelige persontimer = overlap af vagter med produktionsvinduet
            let availableHours = 0;
            for (const s of assignedShifts) {
                const sStart = _timeToDecimal(s.start);
                const sEnd = _timeToDecimal(s.end);
                if (sStart != null && sEnd != null) {
                    const overlap = Math.max(0, Math.min(sEnd, windowEnd) - Math.max(sStart, windowStart));
                    availableHours += overlap;
                }
            }

            if (availableHours > 0) {
                dayRatio = Math.round((totalUnits / availableHours) * 10) / 10;
            }
            capStatus = _ratioStatus(dayRatio, thresholds);

            if (capacityEnabled) {
                capacity = {
                    enabled: true,
                    day_ratio: dayRatio,
                    status: capStatus,
                    window_start: windowStart,
                    window_end: windowEnd,
                    available_hours: Math.round(availableHours * 10) / 10,
                };
            }
        }

        // Produktion status
        let prodStatus = 'grey';
        if (dayBons.length > 0) {
            prodStatus = dayRatio != null ? capStatus : 'green';
        }

        // Personale status
        let staffStatus = 'grey';
        if (assignedShifts.length > 0) {
            staffStatus = dayRatio != null ? capStatus : 'green';
        } else if (openShifts.length > 0 && dayBons.length > 0) {
            // Kun ledige vagter dækker dagens bons → reelt ubemandet
            staffStatus = 'red';
        }

        return {
            date,
            weekday,
            bons: dayBons,
            shifts: dayShifts,
            production: {
                count: dayBons.length,
                total_units: totalUnits,
                status: prodStatus,
            },
            staff: {
                count: assignedShifts.length,
                open_count: openShifts.length,
                total_hours: Math.round(totalHours * 10) / 10,
                status: staffStatus,
                ratio: dayRatio,
            },
            stock: {
                checked: stockChecked,
                total: stockTotal,
                missing: stockMissing,
                no_lines: stockNoLines,
                status: stockStatus,
            },
            capacity,
        };
    });

    // ── Uge-total (sum på tværs af de 7 dage) ──
    // Produktions-enheder = workload (festival-salg ekskluderet, jf. ovenfor).
    const weekTotals = days.reduce((acc, d) => {
        acc.production_units += d.production.total_units || 0;
        acc.bon_count        += d.production.count || 0;
        acc.staff_count      += d.staff.count || 0;
        acc.staff_hours      += d.staff.total_hours || 0;
        acc.stock_checked    += d.stock.checked || 0;
        acc.stock_total      += d.stock.total || 0;
        return acc;
    }, { production_units: 0, bon_count: 0, staff_count: 0, staff_hours: 0, stock_checked: 0, stock_total: 0 });
    weekTotals.staff_hours = Math.round(weekTotals.staff_hours * 10) / 10;

    res.json({
        week: {
            from,
            to,
            week_number: _getISOWeek(from),
            days,
            totals: weekTotals,
        },
    });
}));

module.exports = router;
