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
    // Gul Volvo Duett som inline-SVG (stationcar-silhuet i Ristet Rugs gule).
    // Em-baseret størrelse så den skalerer med teksten den står ved siden af.
    // Renderes via innerHTML i alle forbrugere (logistik, bon-kort, drawer, lister).
    var VOLVO_SVG = '<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" style="vertical-align:-0.22em" aria-hidden="true">'
        + '<rect x="1.5" y="10" width="21" height="5" rx="1.3" fill="#E2B33D"/>'
        + '<path d="M6 10 L8.5 6.4 Q8.9 6 9.6 6 L17.5 6 Q18.4 6 18.9 6.8 L20.8 10 Z" fill="#E2B33D"/>'
        + '<path d="M9.4 7.3 L16.7 7.3 Q17.2 7.3 17.5 7.8 L18.5 9.3 L9.4 9.3 Z" fill="#fff" opacity="0.9"/>'
        + '<line x1="13" y1="7.3" x2="13" y2="9.3" stroke="#E2B33D" stroke-width="0.8"/>'
        + '<circle cx="7" cy="15.3" r="2.1" fill="#333"/><circle cx="7" cy="15.3" r="0.85" fill="#cfcfcf"/>'
        + '<circle cx="17.6" cy="15.3" r="2.1" fill="#333"/><circle cx="17.6" cy="15.3" r="0.85" fill="#cfcfcf"/>'
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
