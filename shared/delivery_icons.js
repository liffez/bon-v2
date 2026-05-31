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
        + '<path d="M2 13.2 C1.5 13.2 1.2 12.8 1.2 12.3 L1.2 11 C1.2 10.3 1.7 9.8 2.5 9.7 L4.3 9.5 L6.2 6 C6.6 5.3 7.3 4.9 8.1 4.9 L17.6 4.9 C18.4 4.9 19.1 5.3 19.5 6 L20.8 9.3 L21.8 9.6 C22.6 9.9 23 10.6 23 11.4 L23 12.4 C23 12.8 22.7 13.2 22.2 13.2 Z" fill="#E2B33D" stroke="#9c6f28" stroke-width="0.7" stroke-linejoin="round"/>'
        + '<path d="M7.8 6.4 L12 6.4 L12 9 L6.3 9 Z" fill="#d6e6f0"/>'
        + '<path d="M13 6.4 L17.2 6.4 C17.7 6.4 18 6.6 18.3 7.1 L19.4 9 L13 9 Z" fill="#d6e6f0"/>'
        + '<circle cx="7.2" cy="13.4" r="2.4" fill="#2c2c2c"/><circle cx="7.2" cy="13.4" r="0.95" fill="#dcdcdc"/>'
        + '<circle cx="18.2" cy="13.4" r="2.4" fill="#2c2c2c"/><circle cx="18.2" cy="13.4" r="0.95" fill="#dcdcdc"/>'
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
