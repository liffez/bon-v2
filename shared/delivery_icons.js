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
    var DEFAULTS = {
        bike:   { icon: '🚲', label: 'Cykel' },         // 🚲
        taxi:   { icon: '🚕', label: 'Taxa' },           // 🚕
        volvo:  { icon: '🚛', label: 'Volvo' },          // 🚛
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
