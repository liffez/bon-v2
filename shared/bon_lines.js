// shared/bon_lines.js
// ==========================================
// Sammenlægning af ens bon-linjer — én definition for hele Bon v2.
// Dual-export: Node (CommonJS) + browser (window.BonLines).
//
// Baggrund:
//   bon_lines har historisk fået én række pr. "Tilføj"-klik i vare-pickeren,
//   så den samme vare kunne ligge som fx 6 × "1× Kartoflen slider".
//   Køkken-kortet skjulte det med sin egen visnings-merge (_sortAndMergeMenu
//   i shared/utils.js), mens info-modal, mail og faktura viste de rå rækker.
//
//   POST /api/bons/:id/lines slår nu sammen ved indsættelse, men gamle bons
//   har stadig dublet-rækker. Alle flader der viser linjer for et menneske
//   (info-modal, mail, flyver, e-conomic-udkast) kører derfor gennem
//   mergeLines() her, så visningen er ens uanset hvornår bonen blev lavet.
//
// Regel (samme som kortets merge): linjer med special_request slås ALDRIG
// sammen — et særønske er en selvstændig besked til køkkenet.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.BonLines = api;
})(typeof self !== 'undefined' ? self : this, function () {

    /**
     * Alt der gør en linje distinkt for kunde og køkken.
     * Pris og gruppe er med: to linjer med forskellig stykpris eller i hver
     * sin menugruppe er ikke "den samme vare" og må ikke lægges sammen.
     */
    function _mergeKey(line) {
        return JSON.stringify([
            line.menu_group_id ?? null,
            line.is_accessory ? 1 : 0,
            String(line.product_name || '').trim().toLowerCase(),
            line.grocy_recipe_id ?? null,
            line.unit ?? null,
            line.unit_price ?? null,
            line.category ?? null,
            line.block_type ?? null,
        ]);
    }

    /**
     * Slå ens linjer sammen. Returnerer nye objekter — input muteres ikke.
     * Rækkefølgen bevares (en sammenlagt linje bliver hvor den første lå).
     *
     * Den samlede linje får `merged_line_ids` med id'erne bag sig, så en
     * kaldende flade kan slå tilbage til de underliggende rækker.
     *
     * @param {Array<object>} lines  rå bon_lines
     * @returns {Array<object>}      sammenlagte kopier
     */
    function mergeLines(lines) {
        if (!Array.isArray(lines)) return [];
        if (lines.length < 2) return lines.slice();

        const out   = [];
        const byKey = new Map();

        for (const line of lines) {
            // Særønske → altid sin egen linje.
            if (String(line.special_request || '').trim()) {
                out.push(Object.assign({}, line, { merged_line_ids: [line.id] }));
                continue;
            }

            const key      = _mergeKey(line);
            const existing = byKey.get(key);

            if (!existing) {
                const copy = Object.assign({}, line, { merged_line_ids: [line.id] });
                byKey.set(key, copy);
                out.push(copy);
                continue;
            }

            existing.quantity = (existing.quantity || 0) + (line.quantity || 0);
            // line_total forbliver null hvis ingen af linjerne har en pris.
            if (existing.line_total != null || line.line_total != null) {
                existing.line_total = (existing.line_total || 0) + (line.line_total || 0);
            }
            existing.merged_line_ids.push(line.id);
        }

        return out;
    }

    return { mergeLines, _mergeKey };
});
