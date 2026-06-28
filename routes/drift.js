/**
 * routes/drift.js
 * ════════════════════════════════════════════════════════════
 * Driftsregnskab — dagsbaseret resultatanalyse.
 * Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §1/§4/§6/§6a/§7/§8.
 *
 * GET  /api/drift/day?date=&mode=  Dagsresultat (live el. frosset snapshot)
 * GET  /api/drift/day/bons?date=&mode=  Per-bon nedbrydning, altid live
 *                                  (fallback for snapshots fra før bons-feltet)
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
const { handle, logChange, getDefaultLocationId, todayISO, bonUnitsExpr } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { inclToExcl }  = require('../shared/moms');
const labor           = require('../services/laborAdapter');

const ALL   = requireAuth('admin', 'office');
const ADMIN = requireAuth('admin');

const REALISERET_STATUS = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function r2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

/* ── Per-bon nedbrydning (drill-down fra KPI-pills) ──────── */
// Samme filtre som computeDay's aggregater, så summen af rækkerne stemmer
// krone for krone med pills'ene. Subqueries (ikke JOIN bon_lines) så bons
// uden linjer stadig tæller med i levering/enheder — som i bonAgg.

function computeDayBons(db, date, mode) {
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];
    const unitsExpr = bonUnitsExpr();

    const rows = db.prepare(`
        SELECT b.id, b.bon_number,
               sd.code AS status_code,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
               co.name AS company_name,
               COALESCE(b.delivery_cost, 0) AS delivery_ex,
               COALESCE((SELECT SUM(${unitsExpr.contrib}) FROM bon_lines bl ${unitsExpr.join}
                          WHERE bl.bon_id = b.id AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)), 0) AS units,
               COALESCE((SELECT SUM(bl.line_total)              FROM bon_lines bl WHERE bl.bon_id = b.id), 0) AS revenue_incl,
               COALESCE((SELECT SUM(bl.quantity * bl.cost_price) FROM bon_lines bl WHERE bl.bon_id = b.id), 0) AS cost_ex
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
          LEFT JOIN customers c  ON c.id  = b.customer_id
          LEFT JOIN companies co ON co.id = b.company_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
         ORDER BY revenue_incl DESC, b.bon_number
    `).all(...unitsExpr.args, date, ...statusArgs);

    return rows.map(r => ({
        id: r.id,
        bon_number: r.bon_number,
        status_code: r.status_code,
        customer: (r.company_name || (r.contact_name_full || '').trim() || null),
        contact: (r.contact_name_full || '').trim() || null,
        revenue_ex_moms: r2(inclToExcl(r.revenue_incl)),
        cost_ex_moms: r2(r.cost_ex),
        delivery_ex_moms: r2(r.delivery_ex),
        units: Number(r.units) || 0,
    }));
}

/* ── Kerne-beregning (genbruges af /day + /refreeze) ─────── */

// skipBons: periode-visningen smider per-bon data væk — spring beregningen over
// dér (op til 366 dage). /day + /refreeze beregner den altid (ryger i snapshot).
async function computeDay(db, date, mode, prefetchedLabor, skipBons) {
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
               COUNT(*)                         AS bon_count
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
    `).get(date, ...statusArgs);

    // Enheder beregnes LIVE fra bon_lines (boks-aware) — aldrig fra det cachede
    // bons.total_units, så et forældet felt ikke kan smitte driftsregnskabet.
    const unitsExpr = bonUnitsExpr();
    const unitsAgg = db.prepare(`
        SELECT COALESCE(SUM(${unitsExpr.contrib}), 0) AS units
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
          JOIN bon_lines bl ON bl.bon_id = b.id
          ${unitsExpr.join}
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0 ${statusClause}
           AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
    `).get(...unitsExpr.args, date, ...statusArgs);

    const revenue  = r2(inclToExcl(lineAgg.revenue_incl));
    const cost     = r2(lineAgg.cost_ex);
    const delivery = r2(bonAgg.delivery_ex);
    const units    = Number(unitsAgg.units) || 0;

    // prefetchedLabor: forud-hentet løn for denne dato (periode-batch). Et array
    // (også tomt) betyder "allerede hentet" → spring per-dag Smartplan-kaldet over.
    let laborRows = [], laborError = null;
    if (Array.isArray(prefetchedLabor)) {
        laborRows = prefetchedLabor;
    } else {
        try { laborRows = await labor.getLabor(date, mode); }
        catch (e) { laborError = e.message; }
    }

    // Løntillæg (§3): satserne i wage_rates er medarbejderens BRUTTOLØN. Den
    // reelle arbejdsgiveromkostning er højere (feriepenge, ATP, evt. pension).
    // labor_overhead_pct ganges på den rå brutto-løn. Default 0 = ingen ændring.
    const overheadPct = Math.max(0,
        parseFloat(db.prepare(`SELECT value FROM settings WHERE key='labor_overhead_pct'`).get()?.value ?? '0') || 0);
    const overheadFactor = 1 + overheadPct / 100;

    const prod   = laborRows.filter(l => l.role_class === 'production');
    const nonBud = laborRows.filter(l => l.role_class !== 'delivery');
    const laborDriftRaw   = r2(nonBud.reduce((s, l) => s + (l.kostpris || 0), 0));
    const laborProdRaw    = r2(prod.reduce((s, l) => s + (l.kostpris || 0), 0));
    const laborDrift      = r2(laborDriftRaw * overheadFactor);   // reel omkostning (vist)
    const laborProduction = r2(laborProdRaw * overheadFactor);
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
        labor_ex_moms: laborDrift, labor_raw_ex_moms: laborDriftRaw, labor_overhead_pct: overheadPct,
        driftsresultat_ex_moms: driftsresultat,
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
        // Per-bon nedbrydning til drill-down — med i frosne snapshots fremover,
        // så drill-down på en frosset dag viser præcis de tal der blev frosset.
        ...(skipBons ? {} : { bons: computeDayBons(db, date, mode) }),
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

/* ── GET /day/bons — per-bon nedbrydning, altid live ─────── */
// Fallback for frosne snapshots fra før `bons` kom med i computeDay-outputtet.
// Beregner live og kan derfor afvige fra et frosset aggregat — frontenden
// flager det. (Registreres FØR /day så Express ikke matcher den som /day.)

router.get('/day/bons', ALL, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    res.json({ date, mode, live: true, bons: computeDayBons(getDb(), date, mode) });
}));

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
async function readDay(db, date, mode, prefetchedLabor) {
    if (date < todayISO() && mode === 'realiseret') {
        const snap = db.prepare('SELECT data_json FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        if (snap) return { ...JSON.parse(snap.data_json), frozen: true };
    }
    return { ...(await computeDay(db, date, mode, prefetchedLabor, true)), frozen: false };
}

router.get('/period', ALL, handle(async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;
    if (!from || !to) return res.status(400).json({ error: 'from + to (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';

    // Byg dagsliste. Hårdt loft = 1 år: AFVIS (fejl) frem for tavs afkortning,
    // så et urealistisk stort interval ikke ser ud som om hele perioden er med.
    const MAX_DAYS = 366;
    const dates = [];
    for (let d = new Date(from + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
        const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
        if (iso > to) break;
        if (dates.length >= MAX_DAYS) {
            return res.status(400).json({ error: `Vælg højst ${MAX_DAYS} dage (1 år) ad gangen.`, code: 'PERIOD_TOO_LONG', max_days: MAX_DAYS });
        }
        dates.push(iso);
    }

    const db = getDb();

    // Batch-hent løn for hele intervallet i ÉT Smartplan-kald (i stedet for ét
    // pr. dag). Frosne fortidsdage læses fra snapshot og rører ikke dette map.
    let laborMap = {};
    try { laborMap = await labor.getLaborMap(from, to, mode); }
    catch (_) { laborMap = {}; }   // Smartplan nede → løn=0 (samme som per-dag-fejl)

    const days = [];
    for (const date of dates) {
        const d = await readDay(db, date, mode, laborMap[date] || []);
        days.push({
            date, frozen: d.frozen,
            revenue_ex_moms: d.revenue_ex_moms, cost_ex_moms: d.cost_ex_moms,
            delivery_ex_moms: d.delivery_ex_moms, labor_ex_moms: d.labor_ex_moms,
            labor_raw_ex_moms: d.labor_raw_ex_moms,
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
        labor_raw_ex_moms: sum('labor_raw_ex_moms'),
        driftsresultat_ex_moms: driftsresultat,
        db_pct: revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units: days.reduce((s, x) => s + (x.units || 0), 0),
        bon_count: days.reduce((s, x) => s + (x.bon_count || 0), 0),
    };
    res.json({ days, totals });
}));

module.exports = router;
