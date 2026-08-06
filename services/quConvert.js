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
 * `factor` er den faktor der blev ganget på (1, 1000 eller 0,001). Den skal med ud,
 * fordi en kalder der lader BRUGEREN redigere det formaterede tal er nødt til at
 * kunne regne tilbage til udgangsenheden. Uden den gætter kalderen — og gætter man
 * på 1, skriver man "150" for 150 gram ind i et felt der betyder kilo.
 *
 * @param {number} amount   — Mængde
 * @param {string} unitName — Enhedsnavn (kg, g, l, ml, stk, …)
 * @returns {{ amount: number, unit: string, factor: number }}
 */
function autoFormatAmount(amount, unitName) {
    const u = (unitName || '').toLowerCase().trim();
    const round = (n) => Math.round(n * 100) / 100;

    if ((u === 'kg' || u === 'kilo') && amount > 0 && amount < 1)
        return { amount: round(amount * 1000), unit: 'g', factor: 1000 };
    if ((u === 'l' || u === 'liter') && amount > 0 && amount < 1)
        return { amount: round(amount * 1000), unit: 'ml', factor: 1000 };
    if ((u === 'g' || u === 'gram') && amount >= 1000)
        return { amount: round(amount / 1000), unit: 'kg', factor: 0.001 };
    if (u === 'ml' && amount >= 1000)
        return { amount: round(amount / 1000), unit: 'l', factor: 0.001 };

    return { amount: round(amount), unit: unitName, factor: 1 };
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

    let displayAmount, displayUnitName, convFactor;
    if (factor !== null) {
        displayAmount = stockAmount * factor;
        convFactor = factor;
        const displayUnit = unitMap.get(toQuId);
        displayUnitName = displayUnit ? (displayUnit.name_short || displayUnit.name || '') : '';
    } else {
        // Ingen konvertering fundet — vis i stock-unit
        displayAmount = stockAmount;
        convFactor = 1;
        const stockUnit = unitMap.get(fromQuId);
        displayUnitName = stockUnit ? (stockUnit.name_short || stockUnit.name || '') : '';
    }

    const out = autoFormatAmount(displayAmount, displayUnitName);
    // Samlet faktor lager → vist tal, altså begge trin ganget sammen. En kalder der
    // lader brugeren redigere `amount` kan komme tilbage til lager-enheden med
    // `redigeret / factor`. (Selve `amount` er afrundet til 2 decimaler; factor er ikke.)
    return { ...out, factor: convFactor * out.factor };
}

/**
 * Omregn en mængde EN BRUGER HAR TASTET til produktets lager-enhed (#358).
 *
 * Varemodtagelsen henter det forventede antal fra indkøbslisten, hvor det står i
 * INDKØBS-enhed ("994 Kasse"), og skrev det derefter til Grocy uden enhed — hvor
 * det blev læst som lager-enhed (kilo). 69 af 215 produkter i grocy-hq har
 * forskellig købs- og lager-enhed, så det ramte hver fjerde vare.
 *
 * Funktionen NÆGTER at gætte. Kan mængden ikke omregnes entydigt, returneres en
 * fejl som kalderen skal gøre synlig — en forkert lagerbeholdning er værre end en
 * modtagelse der beder om hjælp, fordi den forkerte beholdning ser rigtig ud.
 *
 * Bemærk `quId == null`: en klient der ikke sender enheden (fx en cachet browser
 * efter deploy) accepteres KUN når produktet ikke er tvetydigt — altså når køb og
 * lager er samme enhed. Ellers er der intet at afgøre det på.
 *
 * @param {object}  opts
 * @param {object}  opts.product      Grocy-produkt (qu_id_stock, qu_id_purchase, id)
 * @param {number}  opts.amount       Mængden som brugeren tastede den
 * @param {number?} opts.quId         Enheden mængden står i (null = ikke oplyst)
 * @param {Array}   opts.conversions  Grocy quantity_unit_conversions
 * @returns {{ amount: number|null, factor: number|null, error: string|null }}
 */
function resolveToStockAmount({ product, amount, quId, conversions }) {
    const err = (msg) => ({ amount: null, factor: null, error: msg });

    if (!product) return err('Produktet findes ikke i Grocy — kan ikke afgøre lager-enhed');

    const stockQu = product.qu_id_stock != null ? parseInt(product.qu_id_stock) : null;
    if (!stockQu) return err('Produktet har ingen lager-enhed i Grocy');

    const purchaseQu = product.qu_id_purchase != null ? parseInt(product.qu_id_purchase) : null;
    const from = quId != null && quId !== '' ? parseInt(quId) : null;

    if (from === null) {
        // Ingen enhed oplyst. Kun forsvarligt når produktet ikke KAN være tvetydigt.
        if (purchaseQu && purchaseQu !== stockQu) {
            return err('Enheden på det modtagne antal er ikke oplyst, og produktet '
                     + 'har forskellig købs- og lager-enhed — genindlæs siden og prøv igen');
        }
        return { amount, factor: 1, error: null };
    }

    if (from === stockQu) return { amount, factor: 1, error: null };

    const factor = findConversionFactor(conversions || [], parseInt(product.id), from, stockQu);
    if (factor === null) {
        return err(`Ingen enhedsomregning i Grocy fra enhed ${from} til lager-enhed ${stockQu} `
                 + `— opret konverteringen på produktet og modtag varen igen`);
    }

    return { amount: amount * factor, factor, error: null };
}

module.exports = { findConversionFactor, autoFormatAmount, convertAndFormat, resolveToStockAmount };
