/**
 * services/packSizeGuard.js — F13-guard
 * ════════════════════════════════════════════════════════════
 * Forhindrer at pakke-vægt divergerer STILLE mellem to kilder i Grocy:
 *
 *   A) product_barcodes userfield `pack_size_stock_unit` (kg)
 *      — bruges af indkøbsmodulet til kr/kg-beregning
 *   B) quantity_unit_conversions `factor` (purchase → stock)
 *      — bruges af Grocy's egne kostpris-beregninger + sync-v1
 *
 * Når de divergerer beregner Grocy og Bon v2 forskellige kr/kg.
 * F12-fund (14. maj 2026): Brød Rug (pid 1) havde conversion
 * 1 Kasse = 10.8 Kilo, mens barcode + Hørkram sagde 7.68 kg — 29 % fejl
 * der forplanter sig til kostpriser, faktura-grundlag og dækningsbidrag.
 *
 * Guarden BLOKERER ikke writes — den nye værdi kan netop være rettelsen.
 * Den logger divergens til data/pack-size-divergence-log.json og
 * returnerer et warning-objekt som route-handleren sender med i svaret,
 * så brugeren der lige koblede varen får besked.
 *
 * Spec: docs/Grocy audit/CLAUDE_GROCY_AUDIT_4B.md — "Næste skridt" #2.
 * ════════════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');

const TOLERANCE = 0.02; // ±2 % — samme tolerance som 4B-audit
const LOG_FILE  = path.join(__dirname, '..', 'data', 'pack-size-divergence-log.json');
const LOG_CAP   = 1000; // behold de seneste N entries

/** parse dansk-eller-engelsk decimal til tal */
function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    return parseFloat(String(v).replace(',', '.'));
}

function round(n, dp) {
    const f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(n * f) / f;
}

/** relativ afvigelse mellem to positive tal */
function spread(a, b) {
    const lo = Math.min(a, b);
    if (lo <= 0) return Infinity;
    return Math.abs(a - b) / lo;
}

/**
 * Find konverteringsfaktor fromQu → toQu for et produkt.
 * Prøver produkt-specifik først, så global, og inverterer hvis kun
 * den modsatte retning findes.
 * @returns {number|null} faktor, eller null hvis ingen conversion findes
 */
function resolveFactor(conversions, productId, fromQu, toQu) {
    if (Number(fromQu) === Number(toQu)) return 1;
    const pid = Number(productId);
    const forProduct = c => Number(c.product_id) === pid;
    const isGlobal   = c => !c.product_id || Number(c.product_id) === 0;
    const dir = (c, f, t) => Number(c.from_qu_id) === Number(f) && Number(c.to_qu_id) === Number(t);

    let c = conversions.find(x => forProduct(x) && dir(x, fromQu, toQu));
    if (c) return num(c.factor);

    c = conversions.find(x => forProduct(x) && dir(x, toQu, fromQu));
    if (c && num(c.factor) > 0) return 1 / num(c.factor);

    c = conversions.find(x => isGlobal(x) && dir(x, fromQu, toQu));
    if (c) return num(c.factor);

    c = conversions.find(x => isGlobal(x) && dir(x, toQu, fromQu));
    if (c && num(c.factor) > 0) return 1 / num(c.factor);

    return null;
}

/** Append en divergens-entry til log-filen (bounded). Fejler aldrig hårdt. */
function logDivergence(entry) {
    try {
        let log = [];
        if (fs.existsSync(LOG_FILE)) {
            try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) || []; }
            catch { log = []; }
        }
        if (!Array.isArray(log)) log = [];
        log.push(Object.assign({ timestamp: new Date().toISOString() }, entry));
        if (log.length > LOG_CAP) log = log.slice(-LOG_CAP);
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    } catch (err) {
        console.warn('[packSizeGuard] kunne ikke skrive log:', err.message);
    }
}

/**
 * Tjek om en `pack_size_stock_unit`-værdi der skrives til en barcode
 * divergerer fra produktets quantity_unit_conversion.
 *
 * @param {Object} grocy        grocyAdapter
 * @param {number} barcodeId    product_barcodes.id
 * @param {*}      packSizeRaw  værdien der skrives (string|number)
 * @returns {Promise<Object|null>} warning-objekt, eller null hvis alt stemmer
 */
async function checkBarcodePackSize(grocy, barcodeId, packSizeRaw) {
    const packSize = num(packSizeRaw);
    if (!isFinite(packSize) || packSize <= 0) return null;

    const [barcodes, products, conversions] = await Promise.all([
        grocy.getProductBarcodes(),
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
    ]);

    const bc = barcodes.find(b => Number(b.id) === Number(barcodeId));
    if (!bc) return null;
    const prod = products.find(p => Number(p.id) === Number(bc.product_id));
    if (!prod) return null;

    const stockQu   = Number(prod.qu_id_stock);
    const barcodeQu = Number(bc.qu_id || prod.qu_id_purchase);
    const amount    = num(bc.amount) > 0 ? num(bc.amount) : 1;

    let expected;
    if (barcodeQu === stockQu) {
        expected = amount;
    } else {
        const factor = resolveFactor(conversions, prod.id, barcodeQu, stockQu);
        if (factor === null) {
            // Ingen conversion at validere mod — Grocy's kostpris-beregning
            // har intet at gå efter. Informativt fund, ikke en divergens.
            const w = {
                type: 'no_conversion',
                product_id: prod.id,
                product_name: prod.name,
                barcode_id: bc.id,
                barcode: bc.barcode,
                pack_size_kg: round(packSize),
                message: 'Ingen enhedskonvertering for "' + prod.name + '" — '
                    + 'Grocy kan ikke beregne kostpris konsistent med pakkestørrelsen. '
                    + 'Opret en konvertering (indkøbsenhed → lagerenhed) i Grocy.',
            };
            logDivergence(Object.assign({ source: 'barcode_userfield_write' }, w));
            return w;
        }
        expected = amount * factor;
    }

    const dev = spread(packSize, expected);
    if (dev <= TOLERANCE) return null;

    const w = {
        type: 'divergence',
        product_id: prod.id,
        product_name: prod.name,
        barcode_id: bc.id,
        barcode: bc.barcode,
        pack_size_kg: round(packSize),
        conversion_kg: round(expected),
        spread_pct: round(dev * 100, 1),
        message: 'Pakkestørrelse ' + round(packSize) + ' kg afviger '
            + round(dev * 100, 1) + ' % fra enhedskonverteringen ('
            + round(expected) + ' kg) for "' + prod.name + '". '
            + 'Ret den ene i Grocy så de stemmer — ellers bliver kostprisen forkert.',
    };
    logDivergence(Object.assign({ source: 'barcode_userfield_write' }, w));
    return w;
}

/**
 * Tjek om en ny quantity_unit_conversion divergerer fra
 * `pack_size_stock_unit` på produktets eksisterende barcodes.
 *
 * @param {Object} grocy  grocyAdapter
 * @param {Object} conv   { product_id, from_qu_id, to_qu_id, factor }
 * @returns {Promise<Object|null>} warning-objekt, eller null
 */
async function checkConversionFactor(grocy, conv) {
    const factor = num(conv && conv.factor);
    if (!isFinite(factor) || factor <= 0) return null;
    const productId = Number(conv.product_id);
    if (!productId) return null;

    const [barcodes, products] = await Promise.all([
        grocy.getProductBarcodes(),
        grocy.getProducts(),
    ]);
    const prod = products.find(p => Number(p.id) === productId);
    if (!prod) return null;
    const stockQu = Number(prod.qu_id_stock);

    // Kun purchase→stock-konverteringer er relevante for pakkestørrelse.
    // Normalisér til en faktor udtrykt som from→stock.
    let fromQu, normFactor;
    if (Number(conv.to_qu_id) === stockQu) {
        fromQu = Number(conv.from_qu_id); normFactor = factor;
    } else if (Number(conv.from_qu_id) === stockQu) {
        fromQu = Number(conv.to_qu_id);   normFactor = 1 / factor;
    } else {
        return null; // ikke en lagerenheds-konvertering
    }

    const divergent = [];
    for (const bc of barcodes) {
        if (Number(bc.product_id) !== productId) continue;
        const pk = num(bc.userfields && bc.userfields.pack_size_stock_unit);
        if (!isFinite(pk) || pk <= 0) continue;
        const barcodeQu = Number(bc.qu_id || prod.qu_id_purchase);
        if (barcodeQu !== fromQu) continue;
        const amount = num(bc.amount) > 0 ? num(bc.amount) : 1;
        const expected = amount * normFactor;
        const dev = spread(pk, expected);
        if (dev > TOLERANCE) {
            divergent.push({
                barcode_id: bc.id,
                barcode: bc.barcode,
                pack_size_kg: round(pk),
                conversion_kg: round(expected),
                spread_pct: round(dev * 100, 1),
            });
        }
    }
    if (!divergent.length) return null;

    const w = {
        type: 'divergence',
        product_id: prod.id,
        product_name: prod.name,
        barcodes: divergent,
        message: 'Ny enhedskonvertering for "' + prod.name + '" afviger fra '
            + 'pakkestørrelsen på ' + divergent.length + ' stregkode(r). '
            + 'Ret så de stemmer — ellers bliver kostprisen forkert.',
    };
    logDivergence(Object.assign({ source: 'conversion_write' }, w));
    return w;
}

module.exports = {
    checkBarcodePackSize,
    checkConversionFactor,
    resolveFactor,   // eksporteret til tests
    LOG_FILE,
    TOLERANCE,
};
