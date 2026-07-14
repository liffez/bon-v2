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

/** 'YYYY-MM-DD' → 'Ons 20/5' (kompakt til bon-kort) */
function formatShortDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${_DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

/**
 * 'YYYY-MM-DD' → 'I dag' | 'I morgen' | 'Ons 20/5'
 * Returnerer relativ form for i dag og i morgen, ellers kompakt dato.
 */
function formatRelativeDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'I dag';
    if (diffDays === 1) return 'I morgen';
    return formatShortDate(dateStr);
}

/** 'HH:MM' → 'HH:MM' (pass-through, men null-safe) */
function formatTime(t) {
    return t || '';
}

/* ══════════════════════════════════════════════════════════════
   SERVER-TIMESTAMP PARSING
   ──────────────────────────────────────────────────────────────
   Server bruger SQLite CURRENT_TIMESTAMP / datetime('now') som
   producerer "YYYY-MM-DD HH:MM:SS" i UTC UDEN timezone-marker.
   JavaScript parser dette inkonsistent (Chrome: lokal, Safari: lokal,
   Firefox: lokal) — så UTC-tider vises som om de var lokale.
   Helperen normaliserer ved at tilføje 'Z', så strings altid tolkes
   som UTC. ISO-strings med Z eller offset bevares uændret.
   ══════════════════════════════════════════════════════════════ */
function parseServerDate(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    var str = String(s);
    // Allerede med timezone-marker?
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(str)) return new Date(str);
    // SQLite-format "YYYY-MM-DD HH:MM:SS" eller "YYYY-MM-DDTHH:MM:SS" — antag UTC
    return new Date(str.replace(' ', 'T') + 'Z');
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
function connectSSE(url, handlers, opts) {
    const es = new EventSource(url || '/api/sse');
    opts = opts || {};

    for (const [eventName, handler] of Object.entries(handlers)) {
        es.addEventListener(eventName, (e) => {
            try {
                handler(JSON.parse(e.data));
            } catch (err) {
                console.error(`SSE parse error (${eventName}):`, err);
            }
        });
    }

    // Office bruger sin egen samlede "Nyt"-toast + topbar-indikator, så den
    // undertrykker de generiske mail-toasts her (undgår dobbelt-toast).
    // Kitchen-zonen sender ikke flaget og beholder de generiske toasts.
    if (!opts.suppressMailToast) {
        // ── Global mail-received handler ──
        es.addEventListener('mail_received', (e) => {
            try {
                const data = JSON.parse(e.data);
                // Opdater mail-badge på bon-kort
                const card = document.getElementById('bon' + data.bon_id);
                if (card) {
                    const idEl = card.querySelector('.bon-id');
                    if (idEl && !idEl.querySelector('.bon-mail-badge')) {
                        idEl.insertAdjacentHTML('beforeend', ' <span class="bon-mail-badge" title="Ulæst mail">' + mailIcon(14) + '</span>');
                    }
                }
                // Toast notification
                _showMailToast(data);
            } catch (err) { console.error('SSE mail_received error:', err); }
        });

        es.addEventListener('mail_unmatched', (e) => {
            try {
                const data = JSON.parse(e.data);
                _showMailToast({ unmatched: true, count: data.count });
            } catch (err) { /* stille */ }
        });
    }

    es.onerror = () => {
        console.warn('SSE forbindelse tabt — genopkobler automatisk…');
    };
    return es;
}

function _showMailToast(data) {
    if (typeof document === 'undefined') return;
    var existing = document.querySelector('.mail-toast');
    if (existing) existing.remove();
    var msg = data.unmatched
        ? data.count + ' ufordelt' + (data.count > 1 ? 'e' : '') + ' mail'
        : 'Ny mail på bon #' + (data.bon_number || data.bon_id || '?');
    var toast = document.createElement('div');
    toast.className = 'mail-toast';
    toast.innerHTML = mailIcon(15) + ' ' + esc(msg);
    toast.onclick = function() { toast.remove(); };
    document.body.appendChild(toast);
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 10000);
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
            g.base = Object.assign({}, item, { line_ids: [...(item.line_ids || [])] });
        } else {
            g.base.qty = `${parseInt(g.base.qty) + parseInt(item.qty)}`;
            g.base.line_ids = [...(g.base.line_ids || []), ...(item.line_ids || [])];
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

    // Menu-linjer — med kategori + special_request, sorteret og sammenlagt.
    // Linjer med menu_group_id samles i deres persisterede gruppe (titel + note);
    // grupper rendres øverst i sort_order, løse linjer kategori-sorteret nedenunder.
    const allLines = apiBon.lines || [];
    const lineToRaw = (line) => ({
        type:            'item',
        qty:             `${line.quantity}`,
        name:            line.product_name,
        style:           line.is_accessory ? 'emballage' : undefined,
        category:        line.category || null,
        special_request: line.special_request || null,
        line_ids:        [line.id],
    });

    const menu = [];
    const groupsMeta = (apiBon.menu_groups || [])
        .slice()
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
    for (const g of groupsMeta) {
        const groupLines = allLines.filter(l => l.menu_group_id === g.id);
        if (!groupLines.length) continue;   // forældreløs gruppe — spring over
        menu.push({
            type:  'group',
            title: g.title || 'Gruppe',
            note:  g.note || '',
            items: _sortAndMergeMenu(groupLines.map(lineToRaw)),
        });
    }
    const looseLines = allLines.filter(l => l.menu_group_id == null);
    menu.push(..._sortAndMergeMenu(looseLines.map(lineToRaw)));

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

    const unitLabel = 'ENH';

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
        date_short:     apiBon.delivery_date ? formatRelativeDate(apiBon.delivery_date) : '',
        delivery_date_raw: apiBon.delivery_date || '',
        units:          apiBon.total_units || apiBon.pax || 0,
        unit_label:     unitLabel,
        pax:            apiBon.pax || 0,
        units_from_pax: !apiBon.total_units && !!apiBon.pax,
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
        delivery_vehicle_label: apiBon.delivery_vehicle_label || '',
        price_category:  apiBon.price_category || 'catering',
        unread_mail_count: apiBon.unread_mail_count || 0,
        event_id:        apiBon.event_id || null,
        event_name:      apiBon.event_name || '',
        event_model:     apiBon.event_model || '',
        // CO₂ (Fase 3): 3-delt strip når transport-tal findes; ellers dormant.
        co2: (apiBon.total_co2e != null || apiBon.transport_co2e_kg != null) ? {
            food_kg:          apiBon.total_co2e != null ? apiBon.total_co2e : 0,
            transport_kg:     apiBon.transport_co2e_kg != null ? apiBon.transport_co2e_kg : null,
            transport_source: apiBon.transport_co2_source || null,
            method:           apiBon.transport_vehicle_label || '',
        } : undefined,
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

/* ══════════════════════════════════════════════════════════════
   AUTH CHECK
   Tjekker /api/auth/me — redirecter til login hvis 401.
   Returnerer user-objekt { id, name, role } ved success.
   ══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   ICONS — Inline SVG-ikoner som strings.
   Bruges hvor unicode-symboler renderer for små eller inkonsistent.
   Arver currentColor så de farves som omgivende tekst.
   ══════════════════════════════════════════════════════════════ */

function mailIcon(size, extraStyle) {
    var s = size || 14;
    var style = 'vertical-align:-2px;flex-shrink:0' + (extraStyle ? ';' + extraStyle : '');
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="currentColor" aria-hidden="true" style="' + style + '">' +
        '<path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/>' +
        '</svg>';
}

/* Telefon-ikon — companion til mailIcon() (☏-glyffen er lige så tynd/usynlig). */
function phoneIcon(size, extraStyle) {
    var s = size || 14;
    var style = 'vertical-align:-2px;flex-shrink:0' + (extraStyle ? ';' + extraStyle : '');
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="currentColor" aria-hidden="true" style="' + style + '">' +
        '<path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.5.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.6a1 1 0 0 1 1 1c0 1.2.2 2.4.57 3.5a1 1 0 0 1-.25 1l-2.2 2.3z"/>' +
        '</svg>';
}

/* ══════════════════════════════════════════════════════════════
   PARSE EMAILS FROM NOTES
   Returnerer array af { email, label } fra fri-tekst notes.
   Genkender mønstre som "Navn — email@example.dk" eller bare "email@x.dk".
   Bruges til quick-pick chips i mail-compose.
   ══════════════════════════════════════════════════════════════ */

function parseEmailsFromNotes(notes) {
    if (!notes) return [];
    var emails = [];
    var seen = {};
    var lines = String(notes).split(/\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var m = line.match(/[\w.+-]+@[\w.-]+\.\w+/g);
        if (!m) continue;
        for (var j = 0; j < m.length; j++) {
            var email = m[j].toLowerCase();
            if (seen[email]) continue;
            seen[email] = 1;
            // Find label = teksten før email på samme linje, trimmet for fyld
            var idx = line.indexOf(m[j]);
            var beforeRaw = line.substring(0, idx);
            var label = beforeRaw.replace(/[—\-:|·,]+\s*$/, '').trim();
            if (!label) {
                // Fallback: brug delen før @ (fx 'kontakt@firma.dk' → 'firma')
                label = email.split('@')[1].split('.')[0];
                label = label.charAt(0).toUpperCase() + label.slice(1);
            }
            emails.push({ email: email, label: label });
        }
    }
    return emails;
}

async function checkAuth(redirectTo) {
    if (redirectTo === undefined) redirectTo = '/login.html';
    try {
        var res = await fetch('/api/auth/me');
        if (!res.ok) {
            window.location.href = redirectTo;
            return null;
        }
        return await res.json();
    } catch (e) {
        window.location.href = redirectTo;
        return null;
    }
}

// ─── withFocusPreserved ─────────────────────────────────────
// Bevarer fokus + markør i et input/textarea hen over en re-render
// der erstatter DOM'en (typisk container.innerHTML = ...).
//
// Den klassiske bug: et søgefelt er inde i den container der re-rendres
// på hvert tastetryk → input destrueres → fokus tabes → man kan kun
// skrive ét tegn ad gangen. Pak re-renderen i:
//
//     withFocusPreserved(container, function() {
//         container.innerHTML = newHtml;
//     });
//
// Identifikation: foretrækker `id`, fallback til første `data-*`-attribut.
// Begge er stabile på tværs af re-render hvis HTML'en genskaber dem.
function withFocusPreserved(containerEl, fn) {
    var fa = document.activeElement;
    var sel = null, selStart = 0, selEnd = 0;
    if (fa && containerEl && containerEl.contains(fa)
        && (fa.tagName === 'INPUT' || fa.tagName === 'TEXTAREA')) {
        if (fa.id) {
            sel = '#' + (window.CSS && CSS.escape ? CSS.escape(fa.id) : fa.id);
        } else {
            for (var i = 0; i < fa.attributes.length; i++) {
                var a = fa.attributes[i];
                if (a.name.indexOf('data-') === 0) {
                    sel = '[' + a.name + '="' + a.value.replace(/"/g, '\\"') + '"]';
                    break;
                }
            }
        }
        try { selStart = fa.selectionStart; selEnd = fa.selectionEnd; } catch (e) { /* number/date inputs */ }
    }
    fn();
    if (sel) {
        var el = containerEl.querySelector(sel);
        if (el && typeof el.focus === 'function') {
            el.focus();
            try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
        }
    }
}
