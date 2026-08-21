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

   To varianter — de er IKKE ens, vælg bevidst:

   esc()        — escaper kun & < >. Bemærk: esc(0) → '' (falsy-tjek), og
                  anførselstegn slipper igennem. Brug KUN i tekst-kontekst
                  (mellem tags), aldrig i et attribut: title="${esc(x)}"
                  kan brydes ud af.
   escapeHtml() — escaper også " og ', og bevarer 0/false. Sikker i både
                  tekst- og attribut-kontekst. Foretræk denne i ny kode.
   ══════════════════════════════════════════════════════════════ */

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/* ══════════════════════════════════════════════════════════════
   BELØB

   formatKr()  — kompakt beløb MED valuta til visning: 1.500 → "2k kr",
                 1.500.000 → "1,5 mio kr". Til KPI-tal og kort.
   (fmtKr() i shared/dashboard_chart.js er en ANDEN funktion: kompakt
    UDEN valuta, til chart-akser. Slå dem ikke sammen.)
   ══════════════════════════════════════════════════════════════ */

function formatKr(n) {
    const v = Math.round(Number(n) || 0);
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.', ',') + ' mio kr';
    if (v >= 1000)    return (v / 1000).toFixed(0) + 'k kr';
    return v + ' kr';
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
   SIKKER NAVIGATION (zone-skift)
   ══════════════════════════════════════════════════════════════ */

/**
 * Hele domænet kører HTTP/2, så alle sider deler ÉN TCP-forbindelse til
 * serveren. Bliver den forbindelse ubrugelig i baggrunden (dvale, Wi-Fi-skift,
 * netværk der flapper), opdager browseren det først ved NÆSTE navigation — som
 * så fejler øjeblikkeligt med `-1009` "Der er ingen internetforbindelse".
 * Brugeren står tilbage på browserens egen fejlside, og siden man kom fra er
 * væk. Genindlæs virker med det samme, fordi det tvinger en ny forbindelse.
 *
 * `safeNavigate()` prøver forbindelsen af FØR den forlader siden:
 *
 *   1. Et HEAD-kald til selve destinationen. Ethvert svar — også 401 eller en
 *      redirect til login — beviser at forbindelsen lever.
 *   2. Fejler det, har browseren netop revet den døde forbindelse ned. Andet
 *      forsøg får derfor typisk en frisk forbindelse og går igennem.
 *   3. Fejler også det, viser vi vores egen besked med automatisk genforsøg —
 *      og den side brugeren står på går IKKE tabt.
 *
 * Et timeout tæller som "i live": et langsomt netværk skal ikke blokere
 * navigationen. Kun en hård netværksfejl udløser genforsøget.
 *
 * @see https://github.com/liffez/bon-v2/issues/423
 */
var NAV_PROBE_TIMEOUT_MS = 2500;
var NAV_RETRY_INTERVAL_MS = 3000;

function _navProbe(url) {
    if (typeof fetch !== 'function') return Promise.resolve(true);

    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
        timedOut = true;
        if (ctrl) ctrl.abort();
    }, NAV_PROBE_TIMEOUT_MS);

    return fetch(url, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'manual',
        signal: ctrl ? ctrl.signal : undefined
    }).then(function () {
        clearTimeout(timer);
        return true;
    }).catch(function () {
        clearTimeout(timer);
        // Timeout = langsomt, ikke dødt. Lad browseren om resten.
        return timedOut;
    });
}

function safeNavigate(url) {
    if (!url) return;
    if (typeof fetch !== 'function') { location.href = url; return; }

    var go = function () { location.href = url; };

    _navProbe(url).then(function (alive) {
        if (alive) return go();
        return _navProbe(url).then(function (aliveAgain) {
            if (aliveAgain) return go();
            _navShowRetry(url);
        });
    }).catch(go);   // uventet fejl i selve prøven må aldrig spærre for navigation
}

function _navShowRetry(url) {
    if (typeof document === 'undefined') { location.href = url; return; }
    if (document.getElementById('nav-retry-overlay')) return;

    var ov = document.createElement('div');
    ov.id = 'nav-retry-overlay';
    ov.setAttribute('role', 'alert');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
        'display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);' +
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#2b2b2b;max-width:400px;width:calc(100% - 40px);' +
        'padding:26px 28px;border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.35);text-align:center;';
    box.innerHTML =
        '<div style="font-size:34px;line-height:1;margin-bottom:12px">📡</div>' +
        '<div style="font-weight:600;font-size:17px;margin-bottom:6px">Forbindelsen kom væk</div>' +
        '<div id="nav-retry-msg" style="font-size:14px;color:#666;line-height:1.45;margin-bottom:20px">' +
        'Prøver igen… Du står stadig på den side du kom fra — intet er tabt.</div>';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;';

    var retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = 'Prøv nu';
    retryBtn.style.cssText = 'flex:1;padding:10px 16px;border:0;border-radius:8px;cursor:pointer;' +
        'background:#8e631f;color:#fff;font-size:15px;font-weight:600;';

    var stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.textContent = 'Bliv her';
    stayBtn.style.cssText = 'flex:1;padding:10px 16px;border:1px solid #d7d1ca;border-radius:8px;' +
        'cursor:pointer;background:#fff;color:#555;font-size:15px;';

    row.appendChild(retryBtn);
    row.appendChild(stayBtn);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);

    var timer = null;
    var busy = false;
    var attempts = 0;

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (ov.parentNode) ov.parentNode.removeChild(ov);
    }

    function attempt() {
        if (busy) return;
        busy = true;
        attempts++;
        var msg = document.getElementById('nav-retry-msg');
        if (msg) msg.textContent = 'Prøver igen… (forsøg ' + attempts + ')';
        _navProbe(url).then(function (alive) {
            busy = false;
            if (alive) { stop(); location.href = url; return; }
            if (msg) {
                msg.textContent = 'Ingen forbindelse endnu (forsøg ' + attempts +
                    '). Du står stadig på den side du kom fra — intet er tabt.';
            }
        }).catch(function () { busy = false; });
    }

    retryBtn.addEventListener('click', attempt);
    stayBtn.addEventListener('click', stop);
    ov.addEventListener('click', function (e) { if (e.target === ov) stop(); });

    // Ingen prøve med det samme — vi har lige fejlet to gange i træk. Første
    // automatiske genforsøg kommer med intervallet.
    timer = setInterval(attempt, NAV_RETRY_INTERVAL_MS);
}

/**
 * Lad et <a> gå gennem safeNavigate() i stedet for browserens egen navigation.
 * Modifier-klik, midterklik og target="_blank" røres ikke — de skal stadig
 * åbne i ny fane.
 */
function guardLink(el) {
    if (!el || el.getAttribute('data-nav-guarded')) return el;
    el.setAttribute('data-nav-guarded', '1');
    el.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var target = el.getAttribute('target');
        if (target && target !== '_self') return;
        var href = el.getAttribute('href');
        if (!href || href.charAt(0) === '#') return;
        e.preventDefault();
        safeNavigate(href);
    });
    return el;
}

/* ══════════════════════════════════════════════════════════════
   SSE KLIENT-HELPER
   ══════════════════════════════════════════════════════════════ */

/**
 * Livscyklus-styring for én SSE-forbindelse. ALT der åbner en EventSource skal
 * gå gennem denne — ellers bliver streamen hængende når man forlader siden.
 *
 * Hvorfor det betyder noget: serveren opdager først et forsvundet klient-socket
 * ved næste heartbeat (25 s), så en side man har navigeret væk fra kan holde sin
 * stream åben i op mod et minut bagefter. Hele domænet kører HTTP/2, så alle
 * sider deler ÉN TCP-forbindelse til serveren — de efterladte streams holder
 * netop den forbindelse i live, også når den er blevet ubrugelig (dvale,
 * Wi-Fi-skift). Næste navigation genbruger så en død forbindelse og fejler med
 * "Der er ingen internetforbindelse", indtil man reloader.
 *
 * @param {Function} factory  () => EventSource med lyttere allerede påsat.
 *                            Kaldes igen ved bfcache-gendannelse, så ALLE
 *                            lyttere skal sættes på herinde — ikke bagefter.
 * @returns {{es: EventSource|null, close: Function}}
 */
function manageSSE(factory) {
    var es = factory();
    var closed = false;

    function shutdown() {
        try { if (es) es.close(); } catch (e) { /* stille */ }
        es = null;
    }

    // 'pagehide' dækker både rigtig navigation og "siden lægges i bfcache".
    // Brug IKKE 'unload'/'beforeunload' — de forhindrer bfcache i Safari.
    function onPageHide() { if (!closed) shutdown(); }

    // Kun ved bfcache-gendannelse (persisted): siden køres ikke forfra, så
    // JS'en genopretter ikke sig selv — vi skal koble på igen manuelt.
    function onPageShow(e) {
        if (closed || !e.persisted || es) return;
        try { es = factory(); } catch (err) { /* stille — siden virker uden live-opdatering */ }
    }

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    return {
        get es() { return es; },
        close: function () {
            closed = true;
            shutdown();
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('pageshow', onPageShow);
        }
    };
}

/**
 * Opret SSE-forbindelse med named event handlers.
 *
 * @param {string} url       SSE endpoint (default: '/api/sse')
 * @param {Object} handlers  { eventName: fn(parsedData) }
 * @returns {{es: EventSource|null, close: Function}}  handle fra manageSSE().
 *          Bemærk: returværdien er IKKE længere selve EventSource'n — den
 *          udskiftes ved bfcache-gendannelse, så den skal tilgås via `.es`.
 *
 * Eksempel:
 *   connectSSE('/api/sse', {
 *       connected:    (data) => console.log('SSE ok', data),
 *       bon_status:   (data) => handleStatus(data),
 *       notification: (data) => handleNotification(data),
 *   });
 */
function connectSSE(url, handlers, opts) {
    opts = opts || {};
    return manageSSE(function () { return _buildSSE(url, handlers, opts); });
}

function _buildSSE(url, handlers, opts) {
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

    // ── Window-bro ────────────────────────────────────────────────────────
    // Komponenter der ikke ejer SSE-forbindelsen (fx bon-draweren, der lever i
    // alle zoner) lytter på 'sse:<event>' på window. Broen registreres HER —
    // uafhængigt af `handlers` — så den virker uanset hvilke events den enkelte
    // shell selv har tilmeldt. Uden den var drawerens SSE-lytter død overalt
    // undtagen fra levering-popoutet, som dispatchede eventet selv.
    for (const eventName of ['bon_updated', 'bon_status', 'bon_created']) {
        es.addEventListener(eventName, (e) => {
            try {
                window.dispatchEvent(new CustomEvent('sse:' + eventName, { detail: JSON.parse(e.data) }));
            } catch (err) { /* stille — handler-løkken ovenfor logger parse-fejl */ }
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
        // Køkken-synlige kunde-/firma-påmindelser (read-only på kortet)
        kitchen_flags:   apiBon.kitchen_flags || [],
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
   DATO (dansk kalenderdato)

   `new Date().toISOString().slice(0,10)` giver UTC-datoen. Mellem midnat
   og kl. 02 dansk sommertid peger den stadig på I GÅR — så "I dag"-filtre,
   dato-overskrifter og default-datoer rammer den forkerte dag. Fejlen viser
   sig kun om natten, så den opdages typisk kun ved et tilfælde.

   Spejler db/helpers.js' todayISO()/offsetISO() så frontend og backend altid
   er enige om hvad "i dag" er. Forankret i Europe/Copenhagen frem for
   maskinens lokaltid: en tablet med forkert tidszone giver så stadig den
   rigtige danske dato.
   ══════════════════════════════════════════════════════════════ */

function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
}

/* Dansk kalenderdato N dage fra i dag (negativ = bagud). */
function offsetISO(days) {
    var parts = todayISO().split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/* YYYY-MM-DD for et vilkårligt Date-objekt, læst som dansk kalenderdato.
   Brug denne frem for .toISOString().slice(0,10) på datoer der stammer fra
   et klokkeslæt — ellers hopper sen-aftens-timestamps en dag tilbage. */
function dateToISO(d) {
    if (!d) return '';
    var dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(dt);
}

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
