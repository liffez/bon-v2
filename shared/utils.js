/**
 * shared/utils.js
 * ════════════════════════════════════════════════════════════
 * Fælles hjælpefunktioner for Bon v2 frontend.
 * Loades FØR bon_kort.js og view-specifikke scripts.
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════════
   STATUS MAPPING
   Backend bruger UPPERCASE (NY, IGANG, LEVERET …)
   BonConfig.js bruger lowercase (ny, igang, lev …)
   BonConfig er sandhed — denne mapping oversætter.
   ══════════════════════════════════════════════════════════════ */

const STATUS_MAP_TO_FRONTEND = {
    'NY':         'ny',
    'VENTER':     'venter',
    'GODKENDT':   'godkendt',
    'IGANG':      'igang',
    'KLAR':       'klar',
    'LEVERET':    'lev',
    'FAKTURERET': 'faktureret',
    'BETALT':     'betalt',
    'AFSLUTTET':  'afsluttet',
    'AFLYST':     'aflyst',
};

const STATUS_MAP_TO_BACKEND = {};
for (const [backend, frontend] of Object.entries(STATUS_MAP_TO_FRONTEND)) {
    STATUS_MAP_TO_BACKEND[frontend] = backend;
}

function statusToFrontend(backendCode) {
    return STATUS_MAP_TO_FRONTEND[backendCode] || backendCode.toLowerCase();
}

function statusToBackend(frontendKey) {
    return STATUS_MAP_TO_BACKEND[frontendKey] || frontendKey.toUpperCase();
}

/* ══════════════════════════════════════════════════════════════
   DATO-FORMATERING
   ══════════════════════════════════════════════════════════════ */

const _DAYS   = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
const _MONTHS = ['januar','februar','marts','april','maj','juni',
                 'juli','august','september','oktober','november','december'];

/** 'YYYY-MM-DD' → 'Man 9. marts' */
function formatDanishDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${_DAYS[d.getDay()]} ${d.getDate()}. ${_MONTHS[d.getMonth()]}`;
}

/** 'HH:MM' → 'HH:MM' (pass-through, men null-safe) */
function formatTime(t) {
    return t || '';
}

/* ══════════════════════════════════════════════════════════════
   HTML ESCAPE
   ══════════════════════════════════════════════════════════════ */

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ══════════════════════════════════════════════════════════════
   CLIENT ID (midlertidig identitet uden auth)
   ══════════════════════════════════════════════════════════════ */

function getClientId() {
    let id = localStorage.getItem('bon_client_id');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('bon_client_id', id);
    }
    return id;
}

/* ══════════════════════════════════════════════════════════════
   SSE KLIENT-HELPER
   ══════════════════════════════════════════════════════════════ */

/**
 * Opret SSE-forbindelse med named event handlers.
 *
 * @param {string} url       SSE endpoint (default: '/api/sse')
 * @param {Object} handlers  { eventName: fn(parsedData) }
 * @returns {EventSource}
 *
 * Eksempel:
 *   connectSSE('/api/sse', {
 *       connected:    (data) => console.log('SSE ok', data),
 *       bon_status:   (data) => handleStatus(data),
 *       notification: (data) => handleNotification(data),
 *   });
 */
function connectSSE(url, handlers) {
    const es = new EventSource(url || '/api/sse');

    for (const [eventName, handler] of Object.entries(handlers)) {
        es.addEventListener(eventName, (e) => {
            try {
                handler(JSON.parse(e.data));
            } catch (err) {
                console.error(`SSE parse error (${eventName}):`, err);
            }
        });
    }

    es.onerror = () => {
        console.warn('SSE forbindelse tabt — genopkobler automatisk…');
    };
    return es;
}

/* ══════════════════════════════════════════════════════════════
   MENU SORT + MERGE
   ══════════════════════════════════════════════════════════════
   Sorterer menu-items efter kategori-prioritet og samler ens varer.
   Items med special_request beholdes separate men placeres
   umiddelbart efter det samlede item.
   ══════════════════════════════════════════════════════════════ */

function _sortAndMergeMenu(items) {
    if (!items || items.length === 0) return items;

    // Fast bundrækkefølge: 06 Emballage → x-service → x-levering
    const BOTTOM_ORDER = { '06 emballage': 10, 'x-service': 11, 'x-levering': 12 };

    function catPriority(item) {
        // Normalisér: lowercase, trim, og fjern mellemrum efter "x-" (Grocy sender "x- Service")
        const cat = (item.category || '').toLowerCase().trim().replace(/^x-\s+/, 'x-');
        const isAccessory = item.style === 'emballage';
        if (cat.startsWith('03') || cat.startsWith('05')) return 0;  // top
        if (BOTTOM_ORDER[cat] !== undefined) return BOTTOM_ORDER[cat]; // fast bund
        if (isAccessory) return 10;  // emballage-flag → sammen med 06
        return 1;  // midt
    }

    // 1. Sortér: prioritet → kategori → navn
    const sorted = [...items].sort((a, b) => {
        const pa = catPriority(a), pb = catPriority(b);
        if (pa !== pb) return pa - pb;
        const ca = (a.category || ''), cb = (b.category || '');
        if (ca !== cb) return ca.localeCompare(cb, 'da');
        return (a.name || '').localeCompare(b.name || '', 'da');
    });

    // 2. Giv bund-items emballage-styling (dim farve, normal font)
    for (const item of sorted) {
        if (catPriority(item) >= 10) item.style = 'emballage';
    }

    // 3. Gruppér efter navn: saml qty for items UDEN special_request
    const grouped = new Map();
    for (const item of sorted) {
        const key = item.name;
        if (!grouped.has(key)) grouped.set(key, { base: null, specials: [] });
        const g = grouped.get(key);

        if (item.special_request) {
            g.specials.push(item);
        } else if (!g.base) {
            g.base = Object.assign({}, item);
        } else {
            g.base.qty = `${parseInt(g.base.qty) + parseInt(item.qty)}`;
        }
    }

    // 4. Emit i sorteret rækkefølge: base først, derefter specials
    const result = [];
    const emitted = new Set();
    for (const item of sorted) {
        if (emitted.has(item.name)) continue;
        emitted.add(item.name);
        const g = grouped.get(item.name);
        if (g.base) result.push(g.base);
        for (const s of g.specials) result.push(s);
    }
    return result;
}

/* ══════════════════════════════════════════════════════════════
   API-RESPONSE → createCard() MAPPER
   ══════════════════════════════════════════════════════════════
   Oversætter et bon-objekt fra GET /api/bons/today
   til det bonData-schema som createCard() forventer
   (dokumenteret i bon_kort.js linje 376-416).
   ══════════════════════════════════════════════════════════════ */

function mapApiBonToCardData(apiBon) {
    // Adresse-string
    const addr = apiBon.delivery_street
        ? `${apiBon.delivery_street}, ${apiBon.delivery_postal || ''} ${apiBon.delivery_city || ''}`.trim()
        : (apiBon.customer_collects ? 'Afhentes' : '');

    // Kunde
    const customer = {
        name:          (apiBon.contact_name_full || '').trim() || 'Ukendt',
        company:       apiBon.company_name || '',
        address:       addr,
        phone:         apiBon.contact_phone || '',
        company_phone: apiBon.company_phone || '',
        email:         apiBon.contact_email || '',
    };

    // Menu-linjer — med kategori + special_request, sorteret og sammenlagt
    const menuRaw = (apiBon.lines || []).map(line => ({
        type:            'item',
        qty:             `${line.quantity}`,
        name:            line.product_name,
        style:           line.is_accessory ? 'emballage' : undefined,
        category:        line.category || null,
        special_request: line.special_request || null,
    }));
    const menu = _sortAndMergeMenu(menuRaw);

    // Prep
    const prep = [
        { id: 'ingredients', label: 'Råvarer',   checked: !!apiBon.prep_ingredients_ready },
        { id: 'supplies',    label: 'Emballage',  checked: !!apiBon.prep_supplies_ready },
    ];

    // Alerts fra notifikationer
    const alerts = (apiBon.notifications || []).map(n => ({
        type: n.priority === 'urgent' ? 'kitchen-info' : 'delivery-info',
        text: n.message,
    }));

    // Gæt primær enhedslabel fra første ikke-tilbehørslinje
    const mainLine = (apiBon.lines || []).find(l => !l.is_accessory);
    const unitLabel = mainLine ? (mainLine.unit || 'stk').toUpperCase() : 'STK';

    // Leveringstype
    const orderType = apiBon.customer_collects ? 'pickup'
                    : apiBon.delivery_type || 'delivery';

    return {
        id:             apiBon.id,
        bon_number:     apiBon.bon_number,
        status:         statusToFrontend(apiBon.status_code),
        payment:        apiBon.payment_type === 'kontant' ? 'kontant' : 'faktura',
        pickup_time:    formatTime(apiBon.pickup_time),
        delivery_time:  formatTime(apiBon.delivery_time),
        date:           apiBon.delivery_date ? formatDanishDate(apiBon.delivery_date) : '',
        units:          apiBon.total_units || 0,
        unit_label:     unitLabel,
        pax:            apiBon.pax || 0,
        customer:       customer,
        delivery_address: addr,
        order_type:     orderType,
        alerts:         alerts,
        prep:           prep,
        menu:           menu,
        // Ekstra felter for kitchen-today moduler
        kitchen_info:    apiBon.kitchen_info || '',
        delivery_notes:  apiBon.delivery_notes || '',
        delivery_method: apiBon.delivery_method || '',
        price_category:  apiBon.price_category || 'catering',
    };
}

/* ══════════════════════════════════════════════════════════════
   SCROLL TO BON VIA URL HASH
   Bruges af today.js og later.js til at scrolle til og
   highlighte en bon når man navigerer fra kalender-modal.
   Kald efter bons er renderet.
   ══════════════════════════════════════════════════════════════ */

function scrollToBonHash() {
    var hash = window.location.hash;
    if (!hash || !hash.startsWith('#bon')) return;

    var el = document.getElementById(hash.slice(1));
    if (!el) return;

    // Scroll med offset for sticky headers
    setTimeout(function() {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('bon-highlight');
        setTimeout(function() { el.classList.remove('bon-highlight'); }, 4500);
        // Ryd hash så refresh ikke gentager
        history.replaceState(null, '', window.location.pathname);
    }, 300);
}
