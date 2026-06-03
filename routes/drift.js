/**
 * routes/drift.js
 * ════════════════════════════════════════════════════════════
 * Driftsregnskab — dagsbaseret resultatanalyse.
 * Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §1/§4/§6/§6a/§7/§8.
 *
 * GET  /api/drift/day?date=&mode=  Dagsresultat (live el. frosset snapshot)
 * POST /api/drift/refreeze {date}  Admin: genberegn frosset dag fra live data
 *
 * MOMS (§3): ALT ex moms. line_total er INCL → Moms.inclToExcl; cost_price +
 *   delivery_cost er allerede ex moms; løn ingen moms.
 * ROLLER (§6a): bud (delivery) ekskluderet fra driftens løn-/rate-tal.
 * FRYS (§7): afsluttede dage (dato < i dag, realiseret) snapshottes ved første
 *   visning → immune over for senere Smartplan-ændringer. Kun admin kan
 *   genberegne (overskrive snapshot fra aktuelle tal).
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();

const { getDb }       = require('../db/database');
const { handle, logChange, getDefaultLocationId, todayISO } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { inclToExcl }  = require('../shared/moms');
const labor           = require('../services/laborAdapter');

const ALL   = requireAuth('admin', 'office');
const ADMIN = requireAuth('admin');

const REALISERET_STATUS = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function r2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

/* ── Kerne-beregning (genbruges af /day + /refreeze) ─────── */

async function computeDay(db, date, mode) {
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];

    const lineAgg = db.prepare(`
        SELECT COALESCE(SUM(bl.line_total), 0)               AS revenue_incl,
               COALESCE(SUM(bl.quantity * bl.cost_price), 0) AS cost_ex
          FROM bons b
          JOIN bon_lines bl ON bl.bon_id = b.id
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
    `).get(date, ...statusArgs);

    const bonAgg = db.prepare(`
        SELECT COALESCE(SUM(b.delivery_cost),0) AS delivery_ex,
               COALESCE(SUM(b.total_units),0)   AS units,
               COUNT(*)                         AS bon_count
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
    `).get(date, ...statusArgs);

    const revenue  = r2(inclToExcl(lineAgg.revenue_incl));
    const cost     = r2(lineAgg.cost_ex);
    const delivery = r2(bonAgg.delivery_ex);
    const units    = Number(bonAgg.units) || 0;

    let laborRows = [], laborError = null;
    try { laborRows = await labor.getLabor(date, mode); }
    catch (e) { laborError = e.message; }

    const prod   = laborRows.filter(l => l.role_class === 'production');
    const nonBud = laborRows.filter(l => l.role_class !== 'delivery');
    const laborDrift      = r2(nonBud.reduce((s, l) => s + (l.kostpris || 0), 0));
    const laborProduction = r2(prod.reduce((s, l) => s + (l.kostpris || 0), 0));
    const hoursProduction = prod.reduce((s, l) => s + (l.timer || 0), 0);
    const driftsresultat  = r2(revenue - cost - delivery - laborDrift);

    // Belastnings-tidslinje (§8)
    const tlBons = db.prepare(`
        SELECT b.total_units AS units, b.delivery_time AS dtime, b.pickup_time AS ptime
          FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
    `).all(date, ...statusArgs);
    const hourOf = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1], 10) : null; };
    const minOf  = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const unitsByHour = {};
    for (const b of tlBons) {
        const h = hourOf(b.dtime) ?? hourOf(b.ptime);
        if (h == null) continue;
        unitsByHour[h] = (unitsByHour[h] || 0) + (Number(b.units) || 0);
    }
    const manhoursByHour = {};
    for (const l of prod) {
        const s = minOf(l.start), e = minOf(l.slut);
        if (s == null || e == null || e <= s) continue;
        for (let h = Math.floor(s / 60); h < Math.ceil(e / 60); h++) {
            const overlap = (Math.min(e, (h + 1) * 60) - Math.max(s, h * 60)) / 60;
            if (overlap > 0) manhoursByHour[h] = (manhoursByHour[h] || 0) + overlap;
        }
    }
    const allHours = [...Object.keys(unitsByHour), ...Object.keys(manhoursByHour)].map(Number);
    const hMin = allHours.length ? Math.min(...allHours) : 8;
    const hMax = allHours.length ? Math.max(...allHours) : 16;
    const timeline = [];
    for (let h = hMin; h <= hMax; h++) timeline.push({ hour: h, units: r2(unitsByHour[h] || 0), manhours: r2(manhoursByHour[h] || 0) });

    return {
        date, mode,
        bon_count: bonAgg.bon_count,
        revenue_ex_moms: revenue, cost_ex_moms: cost, delivery_ex_moms: delivery,
        labor_ex_moms: laborDrift, driftsresultat_ex_moms: driftsresultat,
        db_pct: revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units,
        kapacitetsrate: hoursProduction > 0 ? r2(units / hoursProduction) : null,
        loenandel_pct: revenue > 0 ? r2(laborProduction / revenue * 100) : null,
        vareforbrug_pr_enhed: units > 0 ? r2(cost / units) : null,
        labor_production_ex_moms: laborProduction,
        hours_production: r2(hoursProduction),
        labor_rows: laborRows,
        timeline,
        rate_missing_count:  laborRows.filter(l => l.rate_missing).length,
        role_unmapped_count: laborRows.filter(l => l.role_unmapped).length,
        labor_error: laborError,
    };
}

function saveSnapshot(db, date, mode, data, userId) {
    db.prepare(`
        INSERT INTO labor_day_snapshot (location_id, snapshot_date, mode, data_json, frozen_by_user_id)
        VALUES (?,?,?,?,?)
        ON CONFLICT(location_id, snapshot_date, mode)
        DO UPDATE SET data_json = excluded.data_json, frozen_at = datetime('now'), frozen_by_user_id = excluded.frozen_by_user_id
    `).run(getDefaultLocationId() || null, date, mode, JSON.stringify(data), userId || null);
}

/* ── GET /day ────────────────────────────────────────────── */

router.get('/day', ALL, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    const db = getDb();
    const isAdmin = req.session.userRole === 'admin';

    // Frys kun afsluttede dage i realiseret-mode (i dag/fremtid + forecast = altid live).
    const isPast = date < todayISO();
    if (isPast && mode === 'realiseret') {
        let snap = db.prepare('SELECT data_json, frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        if (!snap) {
            const data = await computeDay(db, date, mode);
            saveSnapshot(db, date, mode, data, req.session.userId);
            snap = db.prepare('SELECT frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
            return res.json({ ...data, frozen: true, frozen_at: snap.frozen_at, can_refreeze: isAdmin });
        }
        return res.json({ ...JSON.parse(snap.data_json), frozen: true, frozen_at: snap.frozen_at, can_refreeze: isAdmin });
    }

    const data = await computeDay(db, date, mode);
    res.json({ ...data, frozen: false, can_refreeze: false });
}));

/* ── POST /refreeze — admin: genberegn frosset dag fra live ─ */

router.post('/refreeze', ADMIN, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body && req.body.date) ? req.body.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const db = getDb();
    const data = await computeDay(db, date, 'realiseret');
    saveSnapshot(db, date, 'realiseret', data, req.session.userId);
    const snap = db.prepare('SELECT frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, 'realiseret');
    logChange({ entityType: 'labor_day_snapshot', entityId: 0, action: 'refreeze',
        fieldName: date, newValue: String(data.driftsresultat_ex_moms), userId: req.session.userId });
    res.json({ ...data, frozen: true, frozen_at: snap.frozen_at, can_refreeze: true, refrozen: true });
}));

/* ── GET /period — trend over flere dage ─────────────────── */

// Læs én dag til periode-visning: frosset snapshot hvis det findes (afsluttet
// dag), ellers live beregning. Opretter IKKE snapshot (kun /day fryser).
async function readDay(db, date, mode) {
    if (date < todayISO() && mode === 'realiseret') {
        const snap = db.prepare('SELECT data_json FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        if (snap) return { ...JSON.parse(snap.data_json), frozen: true };
    }
    return { ...(await computeDay(db, date, mode)), frozen: false };
}

router.get('/period', ALL, handle(async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;
    if (!from || !to) return res.status(400).json({ error: 'from + to (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';

    // Byg dagsliste (cap 62 dage)
    const dates = [];
    for (let d = new Date(from + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
        const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
        if (iso > to || dates.length >= 62) break;
        dates.push(iso);
    }

    const db = getDb();
    const days = [];
    for (const date of dates) {
        const d = await readDay(db, date, mode);
        days.push({
            date, frozen: d.frozen,
            revenue_ex_moms: d.revenue_ex_moms, cost_ex_moms: d.cost_ex_moms,
            delivery_ex_moms: d.delivery_ex_moms, labor_ex_moms: d.labor_ex_moms,
            driftsresultat_ex_moms: d.driftsresultat_ex_moms, db_pct: d.db_pct,
            units: d.units, bon_count: d.bon_count, kapacitetsrate: d.kapacitetsrate,
        });
    }

    const sum = (k) => r2(days.reduce((s, x) => s + (x[k] || 0), 0));
    const revenue = sum('revenue_ex_moms');
    const driftsresultat = sum('driftsresultat_ex_moms');
    const totals = {
        from, to, mode, day_count: days.length,
        revenue_ex_moms: revenue, cost_ex_moms: sum('cost_ex_moms'),
        delivery_ex_moms: sum('delivery_ex_moms'), labor_ex_moms: sum('labor_ex_moms'),
        driftsresultat_ex_moms: driftsresultat,
        db_pct: revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units: days.reduce((s, x) => s + (x.units || 0), 0),
        bon_count: days.reduce((s, x) => s + (x.bon_count || 0), 0),
    };
    res.json({ days, totals });
}));

module.exports = router;
