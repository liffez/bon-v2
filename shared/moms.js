// shared/moms.js
// ==========================================
// Moms — én definition for hele Bon v2.
// Dual-export: Node (CommonJS) + browser (window.Moms).
//
// Konvention (se BON_V2_PRINCIPPER.md):
//   - Grocy salgspriser, bon_lines.unit_price, bons.total_price = INCL. moms
//   - Grocy råvarepriser, bon_lines.cost_price = EX moms
// Frontends må ALDRIG selv regne moms ud fra magic 1.25 — brug helpers herfra.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.Moms = api;
})(typeof self !== 'undefined' ? self : this, function () {

    const MOMS_RATE   = 0.25;
    const MOMS_FACTOR = 1 + MOMS_RATE;   // 1.25

    function inclToExcl(incl) {
        return (incl ?? 0) / MOMS_FACTOR;
    }

    function exclToIncl(excl) {
        return (excl ?? 0) * MOMS_FACTOR;
    }

    function momsOfIncl(incl) {
        const v = incl ?? 0;
        return v - v / MOMS_FACTOR;
    }

    function round2(n) {
        return Math.round((n ?? 0) * 100) / 100;
    }

    function computeMomsFields(totalInclMoms) {
        const incl = round2(totalInclMoms);
        const excl = round2(incl / MOMS_FACTOR);
        const moms = round2(incl - excl);
        return {
            total_incl_moms: incl,
            total_excl_moms: excl,
            moms_amount:     moms,
        };
    }

    /**
     * Bruges af tilbud-wizardens prisvisning.
     * subInclMoms: subtotal incl. moms (sum af linjer + levering, før rabat)
     * pctOfIncl:   rabat-procent (fx 10 = 10 %)
     * Returnerer både incl- og ex-moms-rabat så visning kan placeres
     * konsistent mellem "Subtotal (u/moms)" og "Moms (25 %)".
     */
    function applyDiscount(subInclMoms, pctOfIncl) {
        const sub = subInclMoms ?? 0;
        const pct = pctOfIncl ?? 0;
        const discountIncl = sub * pct / 100;
        const discountExcl = discountIncl / MOMS_FACTOR;
        const totalIncl    = sub - discountIncl;
        return { discountIncl, discountExcl, totalIncl };
    }

    return {
        MOMS_RATE,
        MOMS_FACTOR,
        inclToExcl,
        exclToIncl,
        momsOfIncl,
        computeMomsFields,
        applyDiscount,
    };
});
