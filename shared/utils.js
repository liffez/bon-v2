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
   SSE KLIENT-HELPER
   ══════════════════════════════════════════════════════════════ */

function connectSSE(url, onMessage) {
    const es = new EventSource(url || '/api/sse');
    es.onmessage = (e) => {
        try {
            onMessage(JSON.parse(e.data));
        } catch (err) {
            console.error('SSE parse error:', err);
        }
    };
    es.onerror = () => {
        console.warn('SSE forbindelse tabt — genopkobler automatisk…');
    };
    return es;
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
        name:    (apiBon.contact_name_full || '').trim() || 'Ukendt',
        company: apiBon.company_name || '',
        address: addr,
        phone:   apiBon.contact_phone || '',
        email:   apiBon.contact_email || '',
    };

    // Menu-linjer
    const menu = (apiBon.lines || []).map(line => ({
        type:  'item',
        qty:   `${line.quantity}`,
        name:  line.product_name,
        style: line.is_accessory ? 'emballage' : undefined,
    }));

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
    };
}
