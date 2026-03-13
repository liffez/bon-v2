/**
 * services/quConvert.js
 * ════════════════════════════════════════════════════════════
 * Quantity-unit konvertering og formatering.
 *
 * Bruges af routes/bons.js (ingredienser) og fremtidige
 * moduler (indkøb, bestilling, varemodtagelse).
 *
 * Data kommer fra Grocy's quantity_units og
 * quantity_unit_conversions endpoints.
 * ════════════════════════════════════════════════════════════
 */

/**
 * Find konverteringsfaktor mellem to enheder for et produkt.
 * Søger i rækkefølge:
 *   1. Produkt-specifik forward
 *   2. Produkt-specifik reverse (1/faktor)
 *   3. Global forward (product_id = null)
 *   4. Global reverse
 *
 * @param {Array} conversions  — Grocy quantity_unit_conversions
 * @param {number} productId   — Produkt-ID (for produkt-specifikke konverteringer)
 * @param {number} fromQuId    — Fra-enhed ID
 * @param {number} toQuId      — Til-enhed ID
 * @returns {number|null}      — Faktor, eller null hvis ikke fundet
 */
function findConversionFactor(conversions, productId, fromQuId, toQuId) {
    if (fromQuId === toQuId) return 1;

    // Produkt-specifik forward
    const pf = conversions.find(c => c.product_id === productId && c.from_qu_id === fromQuId && c.to_qu_id === toQuId);
    if (pf) return parseFloat(pf.factor) || 1;

    // Produkt-specifik reverse
    const pr = conversions.find(c => c.product_id === productId && c.from_qu_id === toQuId && c.to_qu_id === fromQuId);
    if (pr) return 1 / (parseFloat(pr.factor) || 1);

    // Global forward (product_id er null eller ikke sat)
    const gf = conversions.find(c => !c.product_id && c.from_qu_id === fromQuId && c.to_qu_id === toQuId);
    if (gf) return parseFloat(gf.factor) || 1;

    // Global reverse
    const gr = conversions.find(c => !c.product_id && c.from_qu_id === toQuId && c.to_qu_id === fromQuId);
    if (gr) return 1 / (parseFloat(gr.factor) || 1);

    return null;
}

/**
 * Smart formatering af mængde + enhed.
 *   0.03 kg → 30 g
 *   1200 g  → 1.2 kg
 *   0.5 l   → 500 ml
 *   1500 ml → 1.5 l
 *
 * @param {number} amount   — Mængde
 * @param {string} unitName — Enhedsnavn (kg, g, l, ml, stk, …)
 * @returns {{ amount: number, unit: string }}
 */
function autoFormatAmount(amount, unitName) {
    const u = (unitName || '').toLowerCase().trim();
    const round = (n) => Math.round(n * 100) / 100;

    if ((u === 'kg' || u === 'kilo') && amount > 0 && amount < 1)
        return { amount: round(amount * 1000), unit: 'g' };
    if ((u === 'l' || u === 'liter') && amount > 0 && amount < 1)
        return { amount: round(amount * 1000), unit: 'ml' };
    if ((u === 'g' || u === 'gram') && amount >= 1000)
        return { amount: round(amount / 1000), unit: 'kg' };
    if (u === 'ml' && amount >= 1000)
        return { amount: round(amount / 1000), unit: 'l' };

    return { amount: round(amount), unit: unitName };
}

/**
 * Konvertér mængde fra stock-unit til display-unit med auto-format.
 * Convenience-wrapper der kombinerer findConversionFactor + autoFormatAmount.
 *
 * @param {number} stockAmount  — Mængde i stock-units
 * @param {object} opts
 * @param {number} opts.productId     — Produkt-ID
 * @param {number} opts.fromQuId      — Stock-enhed ID
 * @param {number} opts.toQuId        — Display-enhed ID
 * @param {Array}  opts.conversions   — Grocy quantity_unit_conversions
 * @param {Map}    opts.unitMap       — Map(qu_id → { name, name_short, … })
 * @returns {{ amount: number, unit: string }}
 */
function convertAndFormat(stockAmount, { productId, fromQuId, toQuId, conversions, unitMap }) {
    const factor = findConversionFactor(conversions, productId, fromQuId, toQuId);

    let displayAmount, displayUnitName;
    if (factor !== null) {
        displayAmount = stockAmount * factor;
        const displayUnit = unitMap.get(toQuId);
        displayUnitName = displayUnit ? (displayUnit.name_short || displayUnit.name || '') : '';
    } else {
        // Ingen konvertering fundet — vis i stock-unit
        displayAmount = stockAmount;
        const stockUnit = unitMap.get(fromQuId);
        displayUnitName = stockUnit ? (stockUnit.name_short || stockUnit.name || '') : '';
    }

    return autoFormatAmount(displayAmount, displayUnitName);
}

module.exports = { findConversionFactor, autoFormatAmount, convertAndFormat };
