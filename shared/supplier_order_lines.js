// shared/supplier_order_lines.js
// ==========================================
// Varelinjen som LEVERANDØREN ser den — én definition for hele Bon v2.
// Dual-export: Node (CommonJS) + browser (window.SupplierOrderLines).
//
// Baggrund:
//   To flader skriver den samme bestilling til den samme leverandør —
//   bestillingsmailen (routes/orders.js) og "Kopiér liste" (shared/indkob.js).
//   De byggede hver sin linje, så kopi-teksten og mailen kunne vise forskellige
//   ting for samme ordre. Samme drift som gjorde _buildMailVars til tre uenige
//   udgaver; derfor bor reglen ét sted.
//
// To regler, og de hænger sammen:
//
//   1. BETEGNELSEN er stregkodens `note`, ikke Grocy-produktnavnet.
//      Grocy-navnet er vores eget korte ord ("Burgerlommer"), og det kan
//      leverandøren ikke bestille efter — Serviwet har dem i både 11×11 og
//      14×14 cm. `note` er leverandørens egen tekst: målt på grocy-hq har
//      142 af 146 stregkoder en note, og kun 10 er lig produktnavnet
//      ("Cornichoner" → "Cornichons, 330 g").
//
//   2. NUMMERET udelades når det er VORES eget. En leverandør uden katalog
//      har intet varenummer, så Bon genererer et internt (INT-0001) for at
//      kunne koble varen. Det tal siger leverandøren intet — det er vores
//      interne bogholderi, og det skal ikke stå i en mail til dem.
//
// Fælden ved at skrive betegnelsen i selve nummer-feltet (fri tekst, som
// feltet tillader): så ryger den ud som "(nr. Burgerlommer, brune, 11 x 11
// cm., pakke af 1.000 stk.)" — "nr." foran en sætning — og varen har intet
// kort nummer at referere til internt.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.SupplierOrderLines = api;
})(typeof self !== 'undefined' ? self : this, function () {

    /* Bons egen generator (_ibNextIntNumber i shared/indkob.js) laver præcis
       denne form. Mønstret er bevidst SMALT: "SW-2210" ligner et internt
       nummer, men er Serviwets eget og skal med i bestillingen. Vi udelader
       kun det vi selv har fundet på. */
    const INTERNAL_NUMBER = /^INT-\d+$/i;

    function _str(v) {
        return v == null ? '' : String(v).trim();
    }

    /** Er nummeret et Bon selv har opfundet? Så kender leverandøren det ikke. */
    function isInternalNumber(nr) {
        return INTERNAL_NUMBER.test(_str(nr));
    }

    /**
     * Sådan hedder varen HOS LEVERANDØREN.
     * `note` vinder over produktnavnet; uden note falder vi tilbage på vores
     * eget navn frem for at sende en linje uden vare.
     */
    function supplierLabel(item) {
        if (!item) return 'Ukendt vare';
        return _str(item.note)
            || _str(item.product_name)
            || _str(item.name)
            || 'Ukendt vare';
    }

    /**
     * Leverandørens eget varenummer — tom streng når der ikke er et at vise.
     * Tomt i tre tilfælde: intet nummer, vores eget interne nummer, eller et
     * nummer der ER betegnelsen (fri tekst skrevet i nummer-feltet — så ville
     * linjen gentage sig selv).
     */
    function supplierNumber(item) {
        const nr = _str(item && (item.barcode != null ? item.barcode : item.varenr));
        if (!nr || isInternalNumber(nr)) return '';
        if (nr === supplierLabel(item)) return '';
        return nr;
    }

    /** "2 stk" — mængde med enhed, enheden defaulter som de to kaldere gjorde. */
    function quantityText(item) {
        const qty = item && (item.quantity_ordered != null ? item.quantity_ordered
                                                           : item.quantity);
        const unit = _str(item && item.unit) || 'stk';
        return (qty == null ? 0 : qty) + ' ' + unit;
    }

    /** Bestillingsmailens linje: "• Cornichons, 330 g — 2 stk (nr. 13889531)" */
    function mailLine(item) {
        const nr = supplierNumber(item);
        return '• ' + supplierLabel(item) + ' — ' + quantityText(item)
             + (nr ? ' (nr. ' + nr + ')' : '');
    }

    function mailList(items) {
        return (items || []).map(mailLine).join('\n');
    }

    /** Kopiér-listens linje — tabulérsepareret, så den kan sættes ind i et ark. */
    function copyLine(item) {
        const nr = supplierNumber(item);
        return supplierLabel(item) + '\t' + quantityText(item)
             + (nr ? '\tNr. ' + nr : '');
    }

    function copyList(items, heading) {
        const lines = (items || []).map(copyLine);
        return (heading ? heading + '\n' : '') + lines.join('\n');
    }

    return {
        isInternalNumber,
        supplierLabel,
        supplierNumber,
        quantityText,
        mailLine,
        mailList,
        copyLine,
        copyList,
    };
});
