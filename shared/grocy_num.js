// shared/grocy_num.js
// ==========================================
// Tal fra Grocy-userfields — tåler dansk decimal-komma.
// Dual-export: Node (CommonJS) + browser (window.GrocyNum).
//
// HVORFOR
// Userfields (recipes/products/product_barcodes) er tekst. Rå
// `parseFloat("1,1")` giver 1 — et dansk komma bliver TAVST til et
// forkert tal: en salgspris, en kostpris eller et udbytte der ser
// plausibelt ud og er forkert. Grocy gemmer i dag med punktum (målt
// mod grocy-hq 19/9 2026: 0 komma-tal), så dette er et værn, ikke en
// rettelse af en aktiv fejl.
//
// SEMANTIK
// num() opfører sig præcis som parseFloat — bortset fra kommaet. Tomt,
// null, undefined og vrøvl giver NaN, så kaldstedernes `|| 0` / `|| 1` /
// Number.isFinite-fallbacks virker uændret. Kun FØRSTE komma læses som
// decimaltegn, som parseFloat læser første punktum.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.GrocyNum = api;
})(typeof self !== 'undefined' ? self : this, function () {

    function num(v) {
        if (typeof v === 'number') return v;
        return parseFloat(String(v == null ? '' : v).trim().replace(',', '.'));
    }

    return { num };
});
