/**
 * routes/drift.js
 * ════════════════════════════════════════════════════════════
 * Driftsregnskab — dagsbaseret resultatanalyse.
 * Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §1/§4/§6/§6a.
 *
 * GET /api/drift/day?date=YYYY-MM-DD&mode=realiseret|forecast
 *   Kombinerer data vi allerede har (omsætning, vareforbrug, levering fra
 *   bonner) med løn fra laborAdapter (Smartplan-timer × wage_rates).
 *
 * MOMS (§3): ALT i driftsregnskabet er EX moms — det er en resultatanalyse.
 *   - bon_lines.line_total er INCL moms → konverteres via Moms.inclToExcl
 *   - bon_lines.cost_price + bons.delivery_cost er allerede ex moms
 *   - løn har ingen moms
 *
 * ROLLER (§6a): bud (delivery) afregnes separat → ekskluderet fra driftens
 *   løn-, rate- og lønandels-tal. Kun production tæller i kapacitetsrate +
 *   lønandel; production+other indgår i driftsresultatets løn.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();

const { getDb }       = require('../db/database');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { inclToExcl }  = require('../shared/moms');
const labor           = require('../services/laborAdapter');

const ALL = requireAuth('admin', 'office');

// Realiseret = leverede bonner; forecast = bookede (alt ikke-aflyst).
const REALISERET_STATUS = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function r2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

/* ── GET /day ────────────────────────────────────────────── */

router.get('/day', ALL, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';

    const db = getDb();

    // Status-filter afhænger af mode
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];

    // Omsætning (incl moms) + vareforbrug (ex moms) fra linjer
    const lineAgg = db.prepare(`
        SELECT COALESCE(SUM(bl.line_total), 0)                AS revenue_incl,
               COALESCE(SUM(bl.quantity * bl.cost_price), 0)  AS cost_ex
          FROM bons b
          JOIN bon_lines bl ON bl.bon_id = b.id
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ?
           AND COALESCE(b.is_offer, 0) = 0
           AND COALESCE(b.is_internal, 0) = 0
           ${statusClause}
    `).get(date, ...statusArgs);

    // Bon-niveau: levering (ex moms) + enheder + antal
    const bonAgg = db.prepare(`
        SELECT COALESCE(SUM(b.delivery_cost), 0) AS delivery_ex,
               COALESCE(SUM(b.total_units), 0)   AS units,
               COUNT(*)                          AS bon_count
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ?
           AND COALESCE(b.is_offer, 0) = 0
           AND COALESCE(b.is_internal, 0) = 0
           ${statusClause}
    `).get(date, ...statusArgs);

    const revenue   = r2(inclToExcl(lineAgg.revenue_incl));   // ex moms
    const cost      = r2(lineAgg.cost_ex);                    // ex moms
    const delivery  = r2(bonAgg.delivery_ex);                 // ex moms
    const units     = Number(bonAgg.units) || 0;

    // Løn fra laborAdapter (ex moms). Bud ekskluderes fra driften (§6a).
    let laborRows = [];
    let laborError = null;
    try {
        laborRows = await labor.getLabor(date, mode);
    } catch (e) {
        laborError = e.message;
    }

    const prod   = laborRows.filter(l => l.role_class === 'production');
    const nonBud = laborRows.filter(l => l.role_class !== 'delivery');

    const laborDrift      = r2(nonBud.reduce((s, l) => s + (l.kostpris || 0), 0)); // production+other
    const laborProduction = r2(prod.reduce((s, l) => s + (l.kostpris || 0), 0));
    const hoursProduction = prod.reduce((s, l) => s + (l.timer || 0), 0);

    const driftsresultat = r2(revenue - cost - delivery - laborDrift);

    // ── Belastnings-tidslinje (§8): enheder/time vs produktions-mandetimer/time ──
    const tlBons = db.prepare(`
        SELECT b.total_units AS units, b.delivery_time AS dtime, b.pickup_time AS ptime
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ?
           AND COALESCE(b.is_offer, 0) = 0
           AND COALESCE(b.is_internal, 0) = 0
           ${statusClause}
    `).all(date, ...statusArgs);

    const hourOf = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1], 10) : null; };
    const minOf  = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

    const unitsByHour = {};
    for (const b of tlBons) {
        const h = hourOf(b.dtime) ?? hourOf(b.ptime);          // leveres/klar — fallback afhentning
        if (h == null) continue;
        unitsByHour[h] = (unitsByHour[h] || 0) + (Number(b.units) || 0);
    }
    // Produktions-mandetimer pr. time (vagt-overlap, kun production-roller §6a)
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
    for (let h = hMin; h <= hMax; h++) {
        timeline.push({ hour: h, units: r2(unitsByHour[h] || 0), manhours: r2(manhoursByHour[h] || 0) });
    }

    res.json({
        timeline,
        date, mode,
        bon_count: bonAgg.bon_count,
        // Alle beløb ex moms
        revenue_ex_moms:   revenue,
        cost_ex_moms:      cost,
        delivery_ex_moms:  delivery,
        labor_ex_moms:     laborDrift,
        driftsresultat_ex_moms: driftsresultat,
        // Nøgletal
        db_pct:            revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units,
        kapacitetsrate:    hoursProduction > 0 ? r2(units / hoursProduction) : null,   // enh/mandetime (production)
        loenandel_pct:     revenue > 0 ? r2(laborProduction / revenue * 100) : null,   // kun production
        vareforbrug_pr_enhed: units > 0 ? r2(cost / units) : null,
        // Bemanding
        labor_production_ex_moms: laborProduction,
        hours_production: r2(hoursProduction),
        labor_rows: laborRows,
        // Advarsler
        rate_missing_count:  laborRows.filter(l => l.rate_missing).length,
        role_unmapped_count: laborRows.filter(l => l.role_unmapped).length,
        labor_error: laborError,
    });
}));

module.exports = router;
