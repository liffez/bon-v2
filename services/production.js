/**
 * services/production.js
 * ════════════════════════════════════════════════════════════
 * Rene, server-side helpers til produktionsbatch (MVP).
 * Spec: docs/CLAUDE_PRODUKTION_MVP.md §5 (pris) + §6 (QU + idempotens).
 *
 * Disse funktioner er bevidst FRI for I/O (ingen DB, ingen Grocy-kald) så de
 * kan unit-testes isoleret. Orkestreringen (sekventielle consumes +
 * self-production add) ligger i grocyAdapter.produceBatch.
 *
 * MOMS: ALT her er ex moms. Råvarekost (Grocy fulfillment `costs`) er ex moms,
 * og produktion momses ikke (BON_V2_PRINCIPPER §6b). Derfor INGEN
 * moms-multiplikation — kost føres uændret igennem.
 * ════════════════════════════════════════════════════════════
 */

const { findConversionFactor } = require('./quConvert');

const FLOAT_TOL = 1e-9;

/** Fejl med .code så routes/tests kan skelne kontrolleret. */
class ProductionError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'ProductionError';
        this.code = code;
    }
}

function round2(n) {
    return Math.round(((n ?? 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Konvertér en mængde fra display-enhed til stock-enhed (R6).
 *
 * `recipes_pos.amount` er allerede i stock-enhed, men manuelt indtastede
 * actuals + tilføjede varer kommer i display-enhed og SKAL konverteres før
 * consume/add. Stol ALDRIG på display-enheden.
 *
 * @param {object} p
 * @param {number} p.productId      Grocy product ID
 * @param {number} p.displayAmount  Mængde i display-enhed
 * @param {number} p.fromQuId       Display-enhed (kilde)
 * @param {number} p.toQuId         Stock-enhed (mål)
 * @param {Array}  p.conversions    Grocy quantity_unit_conversions
 * @returns {{ stockAmount:number, factor:number, log:string }}
 * @throws  {ProductionError} code='qu_missing' når display≠stock og ingen konvertering findes
 */
function toStockAmount({ productId, displayAmount, fromQuId, toQuId, conversions }) {
    const amt = Number(displayAmount) || 0;

    if (fromQuId === toQuId) {
        return { stockAmount: amt, factor: 1, log: `${amt} (samme enhed)` };
    }

    const factor = findConversionFactor(conversions || [], productId, fromQuId, toQuId);
    if (factor === null) {
        throw new ProductionError(
            'qu_missing',
            `Ingen QU-konvertering for produkt ${productId}: ${fromQuId} → ${toQuId}`,
        );
    }

    const stockAmount = amt * factor;
    return {
        stockAmount,
        factor,
        log: `prod ${productId}: ${amt} (qu ${fromQuId}) → ${round4(stockAmount)} (qu ${toQuId}, faktor ${factor})`,
    };
}

function round4(n) {
    return Math.round(((n ?? 0) + Number.EPSILON) * 10000) / 10000;
}

/**
 * Skalér en master-mængde (pr. 1 portion) til faktisk antal portioner.
 * Bruger override-per-modellen: actual = (override_per ?? per) × portioner —
 * IKKE inkrementel `actual *= factor` (giver rundingsdrift). Spec §4.
 *
 * @param {number} perPortion  Mængde ved 1-portions-basis
 * @param {number} portions    Antal portioner (decimaler tilladt)
 */
function scaleToPortions(perPortion, portions) {
    return (Number(perPortion) || 0) * (Number(portions) || 0);
}

/**
 * Beregn batch-kost og pris pr. produceret enhed (R3). Alt ex moms.
 *
 *   faktisk_batch_kost = Σ (stockAmount × unitCost)        // inkl. byttede + tilføjede
 *   pris_pr_enhed      = faktisk_batch_kost / faktisk_udbytte
 *
 * Prisen koncentreres bevidst ved svind (mindre udbytte → højere kr/enhed).
 *
 * @param {Array<{stockAmount:number, unitCost:number}>} lines  Forbrugte linjer (stock-enhed + ex-moms-enhedskost)
 * @param {number} actualYield  Faktisk udbytte i stock-enhed
 * @returns {{ batchCost:number, pricePerUnit:number }}  begge ex moms
 * @throws  {ProductionError} code='invalid_yield' hvis udbytte ≤ 0
 */
function computeBatchPrice(lines, actualYield) {
    const y = Number(actualYield) || 0;
    if (y <= FLOAT_TOL) {
        throw new ProductionError('invalid_yield', `Faktisk udbytte skal være > 0 (fik ${actualYield})`);
    }

    let batchCost = 0;
    for (const l of lines || []) {
        const amt  = Number(l.stockAmount) || 0;
        const cost = Number(l.unitCost) || 0;
        batchCost += amt * cost;
    }

    return {
        batchCost:    round2(batchCost),
        pricePerUnit: round4(batchCost / y),  // kr/stock-enhed, ex moms — 4 decimaler (sendes til Grocy)
    };
}

/**
 * Enhedskost (ex moms, pr. stock-enhed) for ét produkt ud fra en Grocy
 * `/stock`-række. R3 — "samme kilde som resten af systemet".
 *
 * ⚠️ GO-LIVE-BLOKKER (spec §13): det præcise Grocy-felt skal verificeres mod
 * prod-Grocy. Grocy gemmer indkøbspriser ex moms (CLAUDE.md), så her momses
 * IKKE. Rækkefølge: `last_price` (pris pr. stock-enhed ved seneste køb) →
 * `value / amount` (gns. lagerværdi) → null (ukendt, route bør flagge).
 *
 * @param {object} row  Grocy stock-række
 * @returns {number|null}  kr/stock-enhed ex moms, eller null hvis ukendt
 */
function unitCostFromStockRow(row) {
    if (!row) return null;
    const last = Number(row.last_price);
    if (Number.isFinite(last) && last > 0) return last;

    const value  = Number(row.value);
    const amount = Number(row.amount);
    if (Number.isFinite(value) && Number.isFinite(amount) && amount > FLOAT_TOL) {
        return value / amount;
    }
    return null;
}

/**
 * Byg en produktions-plan ud fra rå input + Grocy-data. REN funktion (ingen
 * I/O) så den kan unit-testes. Konverterer hver linje display→stock (R6),
 * udregner consume-liste + batch-pris (R3) og samler blokerende fejl.
 *
 * Linje-input (display-enhed):
 *   { productId, productName, plannedQty, actualQty, fromQuId, toQuId,
 *     stockUnitName?, deviationReason?, substituteForProductId?, unitCost? }
 *
 * @returns {{
 *   errors: Array<{code,message,productId?}>,
 *   consume: Array<{productId, amount, unitCost}>,     // stock-enhed, actual>0
 *   consumptionRows: Array<object>,                    // klar til INSERT (stock-enhed)
 *   masterCost:number, actualCost:number, pricePerUnit:number,
 *   conversionLog: string[]
 * }}
 */
function buildBatchPlan({ portions, actualYield, lines = [], conversions = [], costMap = {} }) {
    const errors = [];
    if (!(Number(portions) > 0))     errors.push({ code: 'invalid_portions', message: 'Portioner skal være > 0' });
    if (!(Number(actualYield) > 0))  errors.push({ code: 'invalid_yield', message: 'Faktisk udbytte skal være > 0' });

    const consume = [];
    const consumptionRows = [];
    const costLines = [];
    const conversionLog = [];

    for (const ln of lines) {
        const unitCost = Number(costMap[ln.productId] ?? ln.unitCost ?? 0);
        let actualStock = 0, plannedStock = 0;

        try {
            const a = toStockAmount({ productId: ln.productId, displayAmount: ln.actualQty ?? 0, fromQuId: ln.fromQuId, toQuId: ln.toQuId, conversions });
            actualStock = a.stockAmount;
            if (actualStock > FLOAT_TOL) conversionLog.push(a.log);
            const p = toStockAmount({ productId: ln.productId, displayAmount: ln.plannedQty ?? 0, fromQuId: ln.fromQuId, toQuId: ln.toQuId, conversions });
            plannedStock = p.stockAmount;
        } catch (e) {
            if (e instanceof ProductionError && e.code === 'qu_missing') {
                errors.push({ code: 'qu_missing', productId: ln.productId, message: e.message });
                continue;
            }
            throw e;
        }

        if (actualStock > FLOAT_TOL) {
            consume.push({ productId: ln.productId, amount: actualStock, unitCost });
            costLines.push({ stockAmount: actualStock, unitCost });
        }
        consumptionRows.push({
            grocy_product_id:          ln.productId,
            product_name:              ln.productName || '',
            planned_qty:               round4(plannedStock),
            actual_qty:                round4(actualStock),
            unit:                      ln.stockUnitName || '',
            deviation_reason:          ln.deviationReason || null,
            substitute_for_product_id: ln.substituteForProductId || null,
            unit_cost:                 round2(unitCost),
        });
    }

    let actualCost = 0, pricePerUnit = 0;
    if (!errors.some(e => e.code === 'invalid_yield')) {
        try {
            const r = computeBatchPrice(costLines, actualYield);
            actualCost = r.batchCost;
            pricePerUnit = r.pricePerUnit;
        } catch (e) {
            errors.push({ code: e.code, message: e.message });
        }
    }

    const masterCost = round2(
        consumptionRows.reduce((s, r) => s + r.planned_qty * (Number(costMap[r.grocy_product_id]) || 0), 0),
    );

    return { errors, consume, consumptionRows, masterCost, actualCost, pricePerUnit, conversionLog };
}

module.exports = {
    ProductionError,
    toStockAmount,
    scaleToPortions,
    computeBatchPrice,
    unitCostFromStockRow,
    buildBatchPlan,
    round2,
    round4,
};
