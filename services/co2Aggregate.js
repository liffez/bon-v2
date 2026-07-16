// services/co2Aggregate.js
// ==========================================
// Rene aggregerings-/parse-helpers til CO₂-routene. Ligger her (ikke inline i
// routes/co2.js) så den subtile skalerings-matematik kan unit-testes uden DB,
// Grocy eller server — samme princip som co2Engine/co2Transport.
//
// Fælles fælde disse dækker: covered_kg/missing_kg er pr. base_servings, så de
// SKAL divideres med base_servings før de vægtes med solgte enheder/antal.
// ==========================================

'use strict';

/**
 * Parse periode-parametre. Brugerdefineret from/to (YYYY-MM-DD, from <= to)
 * vinder; ellers relativt months-vindue (1-60, default 12).
 * Ren: selve dato-udregningen for months laves af kalderen (SQL date('now')).
 * @returns {{from:string|null, to:string|null, months:number|null}}
 *          from/to sat + months=null  ELLER  from/to=null + months=N
 */
function parseCo2Window(q) {
    const rx = /^\d{4}-\d{2}-\d{2}$/;
    const qq = q || {};
    const from = rx.test(qq.from || '') ? qq.from : null;
    const to   = rx.test(qq.to   || '') ? qq.to   : null;
    if (from && to && from <= to) return { from, to, months: null };
    let months = parseInt(qq.months, 10);
    if (!Number.isInteger(months) || months < 1 || months > 60) months = 12;
    return { from: null, to: null, months };
}

/**
 * Samlet masse-dækning vægtet efter faktisk salg:
 *   Σ(dækket kg pr. enhed × solgte enheder) / Σ(kendt kg pr. enhed × solgte enheder)
 * @param usage   [{ rid, units }]  — solgte enheder pr. opskrift
 * @param metaById Map(recipe_id → { covered_kg, missing_kg, base_servings })
 * @returns {number|null} procent (0-100), eller null hvis ingen kendt masse
 */
function weightedMassCoverage(usage, metaById) {
    let totCov = 0, totKnown = 0;
    for (const u of (usage || [])) {
        const m = metaById && metaById.get(Number(u.rid));
        if (!m || m.covered_kg == null) continue;
        const base = m.base_servings || 1;
        const units = Number(u.units) || 0;
        totCov += (m.covered_kg / base) * units;
        totKnown += ((m.covered_kg + m.missing_kg) / base) * units;
    }
    return totKnown > 0 ? Math.round((totCov / totKnown) * 100) : null;
}

/**
 * Bonens mad-CO₂ nøjagtighed: linjernes dækkede/manglende masse, vægtet efter antal.
 * @param lines   [{ rid, quantity }]
 * @param results Map(recipe_id → { covered_kg, missing_kg, base_servings })
 * @returns {{accuracy_pct:number|null, covered_kg:number, missing_kg:number}}
 */
function aggregateBonAccuracy(lines, results) {
    let covered = 0, missing = 0;
    for (const l of (lines || [])) {
        const r = results && results.get(Number(l.rid));
        if (!r) continue;
        const base = r.base_servings || 1;
        const q = Number(l.quantity) || 0;
        covered += (r.covered_kg / base) * q;
        missing += (r.missing_kg / base) * q;
    }
    const known = covered + missing;
    return {
        accuracy_pct: known > 0 ? Math.round((covered / known) * 100) : null,
        covered_kg: covered,
        missing_kg: missing,
    };
}

/**
 * Transport-CO₂ summeret pr. måned (til "CO₂ over tid"-banen).
 * @param tbons [{ id, month }]
 * @param tmap  Map(bon_id → { kg })
 * @returns Map(month → kg)
 */
function sumTransportByMonth(tbons, tmap) {
    const byMonth = new Map();
    for (const b of (tbons || [])) {
        const t = tmap && tmap.get(b.id);
        if (t && t.kg) byMonth.set(b.month, (byMonth.get(b.month) || 0) + t.kg);
    }
    return byMonth;
}

module.exports = { parseCo2Window, weightedMassCoverage, aggregateBonAccuracy, sumTransportByMonth };
