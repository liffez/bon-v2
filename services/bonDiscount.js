'use strict';

/**
 * Stående rabat — ÉN regel for hele systemet.
 *
 * En bons rabat (`bons.offer_discount_percent`, snapshot fra firmaets/kundens
 * stående rabat ved oprettelsen) gælder VARERNE — ikke levering, gebyrer og
 * emballage. Hvilke kategorier der er undtaget styres af
 * `settings.economic_no_discount_categories` (migration 168).
 *
 * Reglen blev først skrevet til e-conomic-udkastet (economicInvoice.js), mens
 * bonens egen total trak rabatten af ALT og driftsregnskab/rapporter slet ikke
 * trak den fra. Tre svar på samme spørgsmål. Nu bor svaret her, og alle
 * forbrugere spørger:
 *
 *   discountForLine()      — JS: satsen for én linje (e-conomic, recalcBonTotal)
 *   bonDiscountAmount()    — JS: rabatbeløbet for en hel bon
 *   lineNetSQL()           — SQL: en linjes beløb efter rabat (rapporter, drift)
 */

function normalizeCategory(s) {
    return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Kategorinavne → Set af NORMALISEREDE navne. Normaliseringen er ikke pynt:
 * kategorien hedder `x- Service` med mellemrum efter bindestregen, og
 * `x-Service` ville ellers ryge lydløst forbi reglen.
 */
function parseCategoryList(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        return new Set((Array.isArray(arr) ? arr : [])
            .filter(v => typeof v === 'string')
            .map(normalizeCategory)
            .filter(Boolean));
    } catch {
        return new Set();
    }
}

function getNoDiscountCategories(db) {
    const raw = db.prepare(`SELECT value FROM settings WHERE key = 'economic_no_discount_categories'`).get()?.value;
    return parseCategoryList(raw);
}

/**
 * Rabatsats for ÉN linje. Tom kategori → rabatten gælder: vi udelader kun det
 * vi positivt kan genkende, så en linje uden kategori ikke stille mister en
 * rabat kunden har krav på.
 */
function discountForLine(category, basePercent, settings = {}) {
    if (!basePercent) return 0;
    const excluded = settings.noDiscountCategories;
    if (!excluded) return basePercent;
    return excluded.has(normalizeCategory(category)) ? 0 : basePercent;
}

// Kategorien en leverings-synteselinje (bons.delivery_price uden x-Levering-linje)
// låner. Samme værdi som e-conomic-udkastet bruger.
const DELIVERY_CATEGORY = 'x-Levering';

/**
 * Rabatbeløbet (INCL moms) for en bon.
 *   lines        [{ line_total, category }]
 *   deliveryAdd  leveringsbeløb der ikke står som linje (0 hvis der er en x-Levering-linje)
 */
function bonDiscountAmount({ lines, deliveryAdd = 0, percent, noDiscountCategories }) {
    const pct = Number(percent) || 0;
    if (!pct) return 0;
    const settings = { noDiscountCategories };
    let amount = 0;
    for (const l of lines || []) {
        amount += (Number(l.line_total) || 0) * discountForLine(l.category, pct, settings) / 100;
    }
    amount += (Number(deliveryAdd) || 0) * discountForLine(DELIVERY_CATEGORY, pct, settings) / 100;
    return amount;
}

/**
 * SQL-udtryk: en linjes beløb EFTER bonens rabat.
 *
 *   amountExpr  fx 'bl.line_total' eller 'bl.quantity * bl.unit_price'
 *   blAlias     bon_lines-alias (kategorien)
 *   bAlias      bons-alias (satsen) — skal være joinet i forespørgslen
 *
 * Kategorilisten indlejres som literaler (samme mønster som revenueFactorSQL):
 * den er stamdata, ikke brugerinput, og quote-escapes.
 * Normaliseringen i SQL er lower(trim()) — dobbelte mellemrum inde i et navn
 * fanges ikke, men findes ikke i Grocy-kategorierne.
 */
function lineNetSQL(db, amountExpr, blAlias = 'bl', bAlias = 'b') {
    const cats = [...getNoDiscountCategories(db)];
    const pct = `COALESCE(${bAlias}.offer_discount_percent, 0)`;
    const rate = cats.length
        ? `CASE WHEN lower(trim(COALESCE(${blAlias}.category, ''))) IN (${cats.map(c => `'${c.replace(/'/g, "''")}'`).join(', ')}) THEN 0 ELSE ${pct} END`
        : pct;
    return `((${amountExpr}) * (1 - ${rate} / 100.0))`;
}

module.exports = {
    normalizeCategory,
    parseCategoryList,
    getNoDiscountCategories,
    discountForLine,
    bonDiscountAmount,
    lineNetSQL,
    DELIVERY_CATEGORY,
};
