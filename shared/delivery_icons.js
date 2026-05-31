/* shared/delivery_icons.js — én sandhedskilde for delivery_method-ikoner
 *
 * Frontends loader ved boot (eller første brug) og cacher i `window.DeliveryIcons.cache`.
 * Bruges af bons-list, bon_kort_builder, bon_drawer og logistik så ikoner kan
 * konfigureres i Settings → System uden kode-deploy.
 *
 * Fallback: hvis fetch fejler eller settings mangler, bruges DEFAULTS nedenfor.
 * Synonymer (own-bike → bike) håndteres i getDeliveryIcon().
 */
(function() {
    // Gul Volvo Duett som inline-SVG (stationcar-silhuet i Ristet Rugs gule):
    // rundet front, lang tagline, ruder + fælge, mørk gul kontur for skarphed.
    // Em-baseret + lidt større end emoji-ikonerne så vognen er tydelig.
    // Renderes via innerHTML i alle forbrugere (logistik, bon-kort, drawer, lister).
    var VOLVO_SVG = '<svg viewBox="0 0 24 20" width="1.45em" height="1.45em" style="vertical-align:-0.32em" aria-hidden="true">'
        + '<path d="M2 13 L2 10.8 Q2 9.7 3.2 9.5 L4.6 9.3 L6.8 5.6 Q7.1 5 7.9 5 L20.4 5 Q21.5 5 21.5 6.1 L21.5 12 Q21.5 13 20.5 13 Z" fill="#E2B33D" stroke="#9c6f28" stroke-width="0.7" stroke-linejoin="round"/>'
        + '<path d="M7.7 6.1 L12 6.1 L12 8.9 L6.95 8.9 Z" fill="#d6e6f0"/>'
        + '<path d="M12.8 6.1 L20.3 6.1 L20.5 8.9 L12.8 8.9 Z" fill="#d6e6f0"/>'
        + '<circle cx="6.9" cy="13.2" r="2.4" fill="#2c2c2c"/><circle cx="6.9" cy="13.2" r="0.95" fill="#dcdcdc"/>'
        + '<circle cx="18.3" cy="13.2" r="2.4" fill="#2c2c2c"/><circle cx="18.3" cy="13.2" r="0.95" fill="#dcdcdc"/>'
        + '</svg>';

    var DEFAULTS = {
        bike:   { icon: '🚲', label: 'Cykel' },         // 🚲
        taxi:   { icon: '🚕', label: 'Taxa' },           // 🚕
        volvo:  { icon: VOLVO_SVG, label: 'Volvo' },     // gul stationcar-SVG
        pickup: { icon: '🏠', label: 'Afhentning' },     // 🏠
    };

    var cache = null;
    var loading = null;

    function loadIcons() {
        if (cache) return Promise.resolve(cache);
        if (loading) return loading;
        loading = fetch('/api/settings/delivery-icons')
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
                cache = (data && typeof data === 'object') ? Object.assign({}, DEFAULTS, data) : Object.assign({}, DEFAULTS);
                loading = null;
                return cache;
            })
            .catch(function() {
                cache = Object.assign({}, DEFAULTS);
                loading = null;
                return cache;
            });
        return loading;
    }

    function getDeliveryIcon(method) {
        if (!method) return null;
        // Synonymer
        if (method === 'own-bike') method = 'bike';
        var icons = cache || DEFAULTS;
        return icons[method] || null;
    }

    function clearCache() { cache = null; loading = null; }

    window.DeliveryIcons = {
        load: loadIcons,
        get: getDeliveryIcon,
        defaults: DEFAULTS,
        clearCache: clearCache,
    };

    // Eager-load så ikoner er klar når komponenterne rendrer
    if (typeof window !== 'undefined') loadIcons();
})();
