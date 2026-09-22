/* ══════════════════════════════════════════════════════════════
   invoice_price.js — prisen som den står på fakturaen
   Eksponeres som window.InvoicePrice i browseren, module.exports i Node.

   Fakturaen skriver en PAKKEPRIS ("115,00 · Transportkasse, 25 stk."), mens
   Grocy skal bruge prisen pr. LAGER-enhed. Divisionen her er det ENESTE en
   browser må regne på en pris.

   Omregningen fra stregkodens enhed til lagerets bor derimod ét sted, på
   serveren (services/supplierPrices.js), og må ikke få en kopi her: to uenige
   enhedsregler er præcis dét der kostede faktor 1000 i #352.

   Bruges af indkøbslistens kobl-panel (shared/indkob.js) og af arbejdslisten
   "N uden pris" i Indkøb → ⚙ → Produkter (shared/indkob_settings.js). To
   kopier ville skride fra hinanden.
   ══════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    /** Dansk komma tålt — fakturaen skriver 115,00 og tastaturet giver komma. */
    function numFromInput(v) {
        if (v === null || v === undefined) return null;
        var t = String(v).trim().replace(/\s/g, '').replace(',', '.');
        if (!t) return null;
        var n = parseFloat(t);
        return isFinite(n) ? n : null;
    }

    /**
     * "115" kr for "25" lager-enheder → 4,6 kr pr. lager-enhed.
     * Tomt indhold = prisen ER pr. enhed. Står der NOGET i indholdet som ikke
     * kan læses, giver vi null frem for at regne som om feltet var tomt — så
     * ville "115 kr for tolv" blive gemt som 115 kr pr. stk.
     * @returns {number|null}
     */
    function priceFromInvoice(prisTekst, indholdTekst) {
        var pris = numFromInput(prisTekst);
        if (pris === null || pris <= 0) return null;
        var raa = indholdTekst === null || indholdTekst === undefined ? '' : String(indholdTekst).trim();
        var indhold = numFromInput(indholdTekst);
        if (indhold === null) {
            if (raa) return null;
            indhold = 1;
        }
        if (indhold <= 0) return null;
        return Math.round((pris / indhold) * 10000) / 10000;
    }

    var api = { numFromInput: numFromInput, priceFromInvoice: priceFromInvoice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.InvoicePrice = api;
})(typeof window !== 'undefined' ? window : null);
