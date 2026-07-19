/**
 * services/receivingUnits.js
 * ════════════════════════════════════════════════════════════
 * Oversætter en MODTAGET mængde til produktets LAGER-enhed.
 *
 * Hvorfor modulet findes (#358):
 * Varemodtagelsen arbejder i den enhed varen blev BESTILT i — indkøbslisten
 * gemmer i indkøbs-enhed, så Brød Rug står som "994 Kasse". Grocys
 * /stock/products/{id}/add tolker derimod `amount` i produktets LAGER-enhed
 * (Kilo) når der ikke sendes en enhed med. Uden konvertering blev 994 kasser
 * til 994 kilo.
 *
 * Det skete to gange i drift før rettelsen (Spidskål 3. juni 2026: 10 stk lagt
 * på som 10 kg i stedet for 5; Rødkål 18. maj). Ingen opdagede det, fordi en
 * fysisk optælling senere rettede tallet uden at nogen fandt årsagen.
 *
 * Princippet her: vi GÆTTER ALDRIG. Kan enheden ikke afgøres, returneres en
 * fejl, så modtagelsen bliver `partially_approved` og beder om hjælp. En
 * forkert lagerbeholdning er værre end en modtagelse der siger fra.
 * ════════════════════════════════════════════════════════════
 */

const { findConversionFactor } = require('./quConvert');

/**
 * Byg en oversætter ud fra et Grocy-øjebliksbillede.
 *
 * @param {object} snapshot
 * @param {Array} snapshot.products      Grocy products
 * @param {Array} snapshot.units         Grocy quantity_units
 * @param {Array} snapshot.conversions   Grocy quantity_unit_conversions
 * @param {Array} snapshot.shoppingList  Grocy shopping_list (autoritativ for
 *                                       hvilken enhed den bestilte mængde står i)
 * @returns {(item: object) => ({amount, unit, factor?, assumed?}|{error})}
 */
function buildStockQuantityResolver({ products = [], units = [], conversions = [], shoppingList = [] } = {}) {
    const productMap = new Map(products.map(p => [Number(p.id), p]));
    const unitMap    = new Map(units.map(u => [Number(u.id), u]));

    // Indkøbslisten er autoritativ — ikke klienten. Så virker rettelsen også
    // for en browser der kører cachet JavaScript.
    const slUnit  = new Map();
    const slMixed = new Set();
    for (const row of shoppingList) {
        const pid = Number(row.product_id);
        if (!pid || row.qu_id == null) continue;
        const qu = Number(row.qu_id);
        if (slUnit.has(pid)) { if (slUnit.get(pid) !== qu) slMixed.add(pid); }
        else slUnit.set(pid, qu);
    }

    return function toStockQuantity(item) {
        const pid = Number(item.grocy_product_id);
        const received = Number(item.received_quantity);
        if (!Number.isFinite(received)) return { error: 'Ugyldig modtaget mængde' };

        const product = productMap.get(pid);
        if (!product || product.qu_id_stock == null) {
            return { error: 'Kunne ikke slå produktets lager-enhed op i Grocy' };
        }
        const stockQu   = Number(product.qu_id_stock);
        const stockName = unitMap.get(stockQu)?.name || String(stockQu);

        if (slMixed.has(pid)) {
            return { error: 'Varen står på indkøbslisten i flere forskellige enheder — kan ikke lægges på lager automatisk' };
        }

        const fromQu = slUnit.has(pid) ? slUnit.get(pid)
                     : (item.qu_id != null ? Number(item.qu_id) : null);

        // Ingen enhed at gå ud fra (fx en manuelt tilføjet linje uden
        // indkøbsliste-række): antag lager-enhed — det er den gamle adfærd —
        // men marker det, så det ikke ser ud som en verificeret konvertering.
        if (fromQu == null)   return { amount: received, unit: stockName, assumed: true };
        if (fromQu === stockQu) return { amount: received, unit: stockName };

        const factor = findConversionFactor(conversions, pid, fromQu, stockQu);
        if (factor === null) {
            const fromName = unitMap.get(fromQu)?.name || String(fromQu);
            return { error: `Mangler enheds-konvertering i Grocy: ${fromName} → ${stockName}` };
        }
        return { amount: received * factor, unit: stockName, factor, fromQu };
    };
}

module.exports = { buildStockQuantityResolver };
