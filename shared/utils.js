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
    closeOnOutsideClick(ov, stop);

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

    // ── Ny version i drift ────────────────────────────────────────────────
    // Registreres HER og ikke i den enkelte shell: en fane der har stået åben
    // hele dagen kører gammel JS uanset hvilken zone den er i, så beskeden skal
    // gælde office, kitchen, mobile og planlægning på én gang.
    es.addEventListener('connected', (e) => {
        try {
            _sseCheckBuild(JSON.parse(e.data).build);
        } catch (err) { /* stille — en manglende version-besked må ikke vælte SSE */ }
    });

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

/* ══════════════════════════════════════════════════════════════
   NY VERSION I DRIFT

   Statiske filer serveres med `Cache-Control: max-age=0` + ETag, så en
   genindlæsning henter altid ny kode. Problemet er fanen der ALDRIG bliver
   genindlæst: den kører videre på den JS den fik i går, uden at brugeren
   kan se det. Et versions-stempel på script-tagget løser ikke det — URL'en
   læses jo først når siden hentes igen.

   Derfor: serveren sender sit build-id med hvert 'connected', og vi siger
   til når det ændrer sig. Der genindlæses ALDRIG af sig selv — man kan stå
   midt i en bon, og en genindlæsning ville koste det der er tastet.
   ══════════════════════════════════════════════════════════════ */

var _sseBuild        = null;   // det id vi startede på
var _sseBuildIgnored = null;   // id brugeren har afvist beskeden for

function _sseCheckBuild(build) {
    if (!build) return;                        // ældre server uden build-id
    if (_sseBuild === null) { _sseBuild = build; return; }   // første forbindelse
    if (build === _sseBuild) return;
    if (build === _sseBuildIgnored) return;    // allerede afvist for netop denne version
    _sseShowReloadBar(build);
}

function _sseShowReloadBar(build) {
    if (typeof document === 'undefined') return;
    if (document.getElementById('sse-version-bar')) return;

    // Stilen ligger inline med vilje: bjælken skal se ens ud i office, kitchen,
    // mobile og settings, og de har hver sit stylesheet. Fire kopier af den
    // samme CSS ville skride fra hinanden.
    var bar = document.createElement('div');
    bar.id = 'sse-version-bar';
    bar.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        'bottom:20px', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'gap:14px',
        'padding:12px 14px 12px 18px', 'border-radius:10px',
        'background:#2f2a24', 'color:#fff',
        'font:500 14px/1.3 system-ui,-apple-system,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.28)',
        'max-width:calc(100vw - 32px)'
    ].join(';');

    var text = document.createElement('span');
    text.textContent = 'Ny version af Bon v2 er klar.';

    var reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Genindlæs';
    reload.style.cssText = [
        'cursor:pointer', 'border:0', 'border-radius:7px',
        'padding:7px 14px', 'background:#c8a24a', 'color:#241f19',
        'font:600 14px/1 system-ui,-apple-system,sans-serif'
    ].join(';');
    reload.onclick = function () { window.location.reload(); };

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.title = 'Skjul — beskeden kommer igen ved næste version';
    dismiss.style.cssText = [
        'cursor:pointer', 'border:0', 'background:transparent',
        'color:#cfc6b8', 'font:400 20px/1 system-ui,sans-serif', 'padding:0 4px'
    ].join(';');
    dismiss.onclick = function () {
        _sseBuildIgnored = build;
        bar.remove();
    };

    bar.appendChild(text);
    bar.appendChild(reload);
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
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
   MENU-RÆKKEFØLGE — én regel, tre flader
   ══════════════════════════════════════════════════════════════
   Bon-kortet, bon-draweren og info-modalen skal vise linjerne i
   SAMME rækkefølge: kager/drikke øverst, mad i midten, emballage
   → service → levering nederst.

   Reglen lå tidligere kun i _sortAndMergeMenu (bon-kortet), så
   draweren og info-modalen viste rå DB-rækkefølge — emballage og
   levering landede midt i maden.

   Info-modalen forsøgte at skille tilbehør fra på `is_accessory`,
   men det flag er i praksis aldrig sat (0 af ~8.200 emballage-
   linjer i drift), så opdelingen var reelt død. Kategorien er den
   kilde der faktisk bærer data — flaget beholdes kun som ekstra
   signal, aldrig som eneste.
   ══════════════════════════════════════════════════════════════ */

// Fast bundrækkefølge: 06 Emballage → x-Service → x-Levering
const MENU_BOTTOM_ORDER = { '06 emballage': 10, 'x-service': 11, 'x-levering': 12 };

/** Normalisér kategori: lowercase, trim, "x- Service" → "x-service" (Grocy sender med mellemrum) */
function normalizeMenuCategory(category) {
    return String(category || '').toLowerCase().trim().replace(/^x-\s+/, 'x-');
}

/**
 * Sorteringsprioritet for én linje. Lavere tal = højere oppe.
 * Tager både bon_line-form (category/is_accessory) og kort-item-form (category/style).
 */
function menuLinePriority(line) {
    const cat = normalizeMenuCategory(line && line.category);
    const isAccessory = !!(line && (line.is_accessory || line.style === 'emballage'));
    if (cat.startsWith('03') || cat.startsWith('05')) return 0;      // kager/drikke → top
    if (MENU_BOTTOM_ORDER[cat] !== undefined) return MENU_BOTTOM_ORDER[cat];
    if (isAccessory) return 10;                                      // flag → sammen med emballage
    return 1;                                                        // mad → midt
}

/** True når linjen hører til bundgruppen (emballage/service/levering). */
function isBottomMenuLine(line) {
    return menuLinePriority(line) >= 10;
}

/**
 * Sortér linjer efter prioritet → kategori → navn. Stabil, så to
 * ens rå rækker beholder deres indbyrdes rækkefølge (draweren viser
 * dem bevidst hver for sig, så man kan slette den enkelte).
 * Muterer ikke input.
 */
function sortMenuLines(lines) {
    if (!lines || lines.length === 0) return lines || [];
    const nameOf = (l) => String((l && (l.product_name || l.name)) || '');
    return [...lines].sort((a, b) => {
        const pa = menuLinePriority(a), pb = menuLinePriority(b);
        if (pa !== pb) return pa - pb;
        const ca = (a.category || ''), cb = (b.category || '');
        if (ca !== cb) return ca.localeCompare(cb, 'da');
        return nameOf(a).localeCompare(nameOf(b), 'da');
    });
}

/* ══════════════════════════════════════════════════════════════
   MENU SORT + MERGE (bon-kortet)
   ══════════════════════════════════════════════════════════════
   Sorterer menu-items efter kategori-prioritet og samler ens varer.
   Items med special_request beholdes separate men placeres
   umiddelbart efter det samlede item.
   ══════════════════════════════════════════════════════════════ */

function _sortAndMergeMenu(items) {
    if (!items || items.length === 0) return items;

    // 1. Sortér: prioritet → kategori → navn (delt regel, se ovenfor)
    const sorted = sortMenuLines(items);

    // 2. Giv bund-items emballage-styling (dim farve, normal font)
    for (const item of sorted) {
        if (isBottomMenuLine(item)) item.style = 'emballage';
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
        // Slutkunde på forhandler-ordrer (migration 167) — hvem maden er til,
        // når firmaet på bonnen er den der betaler.
        end_customer:  apiBon.end_customer_name || '',
        address:       addr,
        phone:         apiBon.contact_phone || '',
        company_phone: apiBon.company_phone || '',
        email:         apiBon.contact_email || '',
    };

    // Menu-linjer — med kategori + special_request, sorteret og sammenlagt.
    // Linjer med menu_group_id samles i deres persisterede gruppe (titel + note);
    // grupper rendres øverst i sort_order, løse linjer kategori-sorteret nedenunder.
    // 0-mængde-linjer vises ikke: de er ikke arbejde. De opstår kun på en
    // rest-prep-bon hvor forudbestillingerne har dækket hele dagens mål
    // (migration 166) — bonnen bliver stående med sin køkkentekst, men "0 ×
    // Tunen" tre gange er støj. Der findes ingen 0-linjer i historikken, så
    // filteret kan ikke skjule noget der plejede at være synligt.
    const allLines = (apiBon.lines || []).filter(l => Number(l.quantity) !== 0);
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
    if (!el) {
        // Bonen står ikke på siden — uden for Senere-vinduet, eller filtreret
        // helt bort (Senere renderer slet ikke terminale statusser). Draweren
        // er bedre end at der ikke sker noget.
        if (typeof window._bonInfoEditHandler === 'function') {
            history.replaceState(null, '', window.location.pathname);
            window._bonInfoEditHandler(hash.slice(4));
        }
        return;
    }

    // Scroll med offset for sticky headers
    setTimeout(function() {
        // Kortet kan ligge i DOM'en men være skjult af et filter (leveret,
        // IGANG/KLAR). Så ville scroll ramme noget usynligt.
        if (typeof window.revealBonCard === 'function') window.revealBonCard(el);
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
   STATUS-BADGE
   ══════════════════════════════════════════════════════════════ */

/**
 * Status-mærkat med BON_CONFIG's egne farver.
 *
 * En status skal se ens ud uanset hvilken skærm man står på. Skærme der
 * hardkoder deres egen kulør (grå, blegblå …) ligner ikke resten af huset og
 * gør det umuligt at scanne en liste på farven — det var netop fejlen der blev
 * rettet i ugeoversigten, web-ordrer og kalenderen 19. maj 2026, og som stadig
 * sad i Firma 360° og Kunde 360°.
 *
 * Falder tilbage på grå + koden hvis BonConfig ikke er loadet, så en skærm uden
 * den viser noget forkert frem for ingenting.
 *
 * @param {string} statusCode  backend-koden ('LEVERET', 'FAKTURERET', …)
 * @param {object} [opts]      { label, className, title }
 */
function statusBadgeHtml(statusCode, opts = {}) {
    const _e = (typeof esc === 'function') ? esc : (s) => String(s ?? '');
    const code = String(statusCode || '').trim();
    let cfg = {};
    if (typeof statusToFrontend === 'function' && typeof BON_CONFIG !== 'undefined') {
        cfg = (BON_CONFIG.statuses || {})[statusToFrontend(code)] || {};
    }
    const label = opts.label || cfg.label || code || '—';
    const cls   = opts.className ? ' ' + opts.className : '';
    const title = opts.title ? ` title="${_e(opts.title)}"` : '';
    return `<span class="status-badge${cls}" style="background:${cfg.color || '#999'};`
         + `color:${cfg.text || '#fff'}"${title}>${_e(label)}</span>`;
}

/* ══════════════════════════════════════════════════════════════
   ICONS — Inline SVG-ikoner som strings.
   Bruges hvor unicode-symboler renderer for små eller inkonsistent.
   Arver currentColor så de farves som omgivende tekst.
   ══════════════════════════════════════════════════════════════ */

/**
 * Advarsel om at et lagertræk landede et sted der ikke er drift (#535).
 *
 * Bliver STÅENDE til den lukkes. En toast der forsvinder af sig selv er
 * forkert her: trækket kan ikke gentages på bonen, så beskeden er det eneste
 * varsel man får — og den skal kunne læses færdig, også af en der kiggede væk.
 */
function showGrocyWarning(msg) {
    if (!msg) return;
    document.querySelectorAll('.grocy-warn').forEach(el => el.remove());
    const box = document.createElement('div');
    box.className = 'grocy-warn';
    const tekst = document.createElement('div');
    tekst.textContent = '⚠ ' + msg;
    const luk = document.createElement('button');
    luk.type = 'button';
    luk.className = 'grocy-warn-close';
    luk.textContent = 'OK';
    luk.addEventListener('click', () => box.remove());
    box.appendChild(tekst);
    box.appendChild(luk);
    document.body.appendChild(box);
}

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

// ─── Kiosk-enhed ────────────────────────────────────────────
// Den fastmonterede køkkenskærm åbner Bon med ?kiosk=<device-id>. Så snart man
// navigerer videre (fx fra dashboardet til "I dag" via topbaren), er parameteren
// væk — derfor husker browseren det. Udløber sessionen på en side uden ?kiosk,
// får login-siden stadig PIN-padden; ellers står skærmen uden tastatur.
// localStorage er pr. origin, hvilket er nok her: login-siden ligger på samme.
// Nulstilles med /login.html?kiosk=off.
var KIOSK_DEVICE_KEY = 'bon_kiosk_device';
(function rememberKioskDevice() {
    try {
        var v = new URLSearchParams(location.search).get('kiosk');
        if (v !== null && v !== 'off') localStorage.setItem(KIOSK_DEVICE_KEY, v || '1');
    } catch (e) { /* localStorage kan være spærret — så virker ?kiosk stadig */ }
})();

function isKioskDevice() {
    try {
        if (new URLSearchParams(location.search).has('kiosk')) return true;
        return !!localStorage.getItem(KIOSK_DEVICE_KEY);
    } catch (e) { return false; }
}

async function checkAuth(redirectTo) {
    if (redirectTo === undefined) {
        redirectTo = '/login.html';
        // Kiosken skal tilbage til SIN side efter login. Uden `next` sender login-siden
        // køkken-rollen til sin standardzone, og siden man stod på er tabt.
        // `kiosk` får også login-siden til at vise PIN-padden.
        if (isKioskDevice()) {
            redirectTo += '?kiosk=1&next=' + encodeURIComponent(location.pathname + location.search);
        }
    }
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

/* ══════════════════════════════════════════════════════════════
   KLIK UDEN FOR EN MODAL
   ══════════════════════════════════════════════════════════════

   Modaler lå historisk med `if (e.target === overlay) luk()`. Det ser rigtigt
   ud, men `click` fyrer på den nærmeste FÆLLES forfader til dér hvor knappen
   blev trykket ned og dér hvor den blev sluppet. Markerer man tekst i et felt
   inde i modalen og trækker musen ud over overlayet, bliver den fælles
   forfader netop overlayet — og modalen lukkede midt i en markering, med det
   man havde skrevet.

   Her kræver vi at BÅDE nedtrykket og slippet skete på selve overlayet.
   Så lukker modalen på et ægte klik udenfor, og bliver stående når musen
   bare passerer forbi undervejs. Samme princip som fold-ud-vagten i
   shared/mail_thread.js.

   Trykkets ophav spores ét sted på document (capture), så også delegerede
   klik-handlere kan spørge — de har ikke et overlay-element at hænge en
   lytter på. */

var _POINTER_DOWN_EVT = window.PointerEvent ? 'pointerdown' : 'mousedown';
var _POINTER_UP_EVT   = window.PointerEvent ? 'pointerup'   : 'mouseup';

var _pressStartTarget = null;
var _pressEndTarget = null;
var _pressSelectionNodes = null;

document.addEventListener(_POINTER_DOWN_EVT, function (e) {
    _pressStartTarget = e.target;
    _pressEndTarget = null;
    _pressSelectionNodes = _selectionNodes();
}, true);

document.addEventListener(_POINTER_UP_EVT, function (e) {
    _pressEndTarget = e.target;
}, true);

// Er dette klik et ægte klik på `el` — trykket ned OG sluppet dér?
// `e` er klik-eventet; dets target skal også være `el` (ellers blev der
// klikket på noget inde i modalen).
function isOutsideClick(e, el) {
    if (!el || !e || e.target !== el) return false;
    return _pressStartTarget === el && _pressEndTarget === el;
}

// Hvor lå markeringen da trykket faldt? Skal aflæses i capture-fasen —
// browseren rydder markeringen som standardhandling på nedtrykket.
//
// En markering inde i et <input>/<textarea> er usynlig for getSelection(),
// så det felt der har fokus tjekkes særskilt. Netop dét felt er det
// almindelige tilfælde i en bon-drawer.
function _selectionNodes() {
    try {
        var sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).length) {
            return [sel.anchorNode, sel.focusNode];
        }
    } catch (err) { /* getSelection kan kaste i sjældne tilfælde */ }
    var fa = document.activeElement;
    if (fa && (fa.tagName === 'INPUT' || fa.tagName === 'TEXTAREA')) {
        try {
            if (fa.selectionStart !== fa.selectionEnd) return [fa];
        } catch (err) { /* tal- og datofelter har ingen markering */ }
    }
    return null;
}

// Ryddede dette klik en markering inde i `el`? Så var det dét klikket handlede
// om — og så må det ikke oveni lukke panelet.
function pressClearedSelectionIn(el) {
    if (!el || !_pressSelectionNodes) return false;
    for (var i = 0; i < _pressSelectionNodes.length; i++) {
        var n = _pressSelectionNodes[i];
        if (n && el.contains(n)) return true;
    }
    return false;
}

// Luk-på-klik-udenfor. closeFn kaldes kun ved et ægte klik på overlayet selv.
//
// `panelEl` er det indhold der skal beskyttes. Udelades det, beskyttes alt
// inde i overlayet — rigtigt for en modal, hvor panelet ligger indeni. En
// drawer lægger derimod sin baggrund som SØSKENDE til panelet og skal sende
// panelet med, ellers ved vagten ikke hvor markeringen lå.
//
// Uden dette led lukker draweren stadig: trækket lukker den ikke længere, men
// det klik man laver bagefter for at fjerne markeringen gør. Første klik
// rydder markeringen, næste klik lukker — som man ville forvente.
function closeOnOutsideClick(overlayEl, closeFn, panelEl) {
    if (!overlayEl || typeof closeFn !== 'function') return;
    var guardEl = panelEl || overlayEl;
    overlayEl.addEventListener('click', function (e) {
        if (!isOutsideClick(e, overlayEl)) return;
        if (pressClearedSelectionIn(guardEl)) return;
        closeFn(e);
    });
}

// Ramte klikket UDEN FOR alle de angivne elementer? Bruges af dropdowns,
// menuer og autocomplete-lister der lukker når man klikker ved siden af —
// de har ingen overlay at hænge closeOnOutsideClick på, men rammes af samme
// fejl: trækker man en markering ud af listen, lander `click` på en fælles
// forfader udenfor, og listen lukkede midt i markeringen.
//
//     if (clickedOutside(e, input, resultsEl)) resultsEl.style.display = 'none';
function clickedOutside(e) {
    var els = Array.prototype.slice.call(arguments, 1);
    function inside(node) {
        if (!node) return false;
        for (var i = 0; i < els.length; i++) {
            if (els[i] && els[i].contains(node)) return true;
        }
        return false;
    }
    if (inside(e && e.target)) return false;
    if (inside(_pressStartTarget)) return false;   // trykket startede indeni
    if (inside(_pressEndTarget)) return false;     // musen blev sluppet indeni
    return true;
}

// Samme regel, men matchet med en CSS-selector — til delegerede handlere der
// bruger closest() og altså ikke har et konkret element at pege på.
function clickedOutsideSelector(e, selector) {
    function inside(node) {
        return !!(node && node.closest && node.closest(selector));
    }
    if (inside(e && e.target)) return false;
    if (inside(_pressStartTarget)) return false;
    if (inside(_pressEndTarget)) return false;
    return true;
}

// ── Link til en opskrift i opskrift-vieweren ────────────────────────────────
//
// Tre steder peger på den samme opskrift-viewer: køkken-dashboardets "Lav
// snart", råvarer-modalens underopskrifter, og dens kan-laves-råvarer. De ved
// hver sit om mængden, men de deler ÉN regel om hvornår et tal må sendes med.
// Skrevet tre gange ville de skride fra hinanden — nøjagtig sådan #428 opstod.
//
// Mængden angives på den form kalderen faktisk har:
//   portions — direkte antal portioner. `sub_recipes[].servings` er præcis
//              dette: resolveren regner `mult = servings / base_servings`,
//              samme formel som vieweren. Intet at omregne.
//   batches  — hele batches (`make_batches`). Vieweren omregner, for den
//              kender `base_servings`; kalderen gør ikke.
//
// `trustBatches: false` betyder at batch-tallet er en FALLBACK og ikke en
// måling — så sendes det ikke. Sker når Grocy ikke har oplyst opskriftens
// udbytte (`make_status === 'ukendt'`), hvor resolveren sætter 1. Sendte vi
// det videre, ville vieweren vise en mængde ingen har regnet.
function recipeUrl(opts) {
    var o   = opts || {};
    var rid = Number(o.recipeId) || 0;
    if (!rid) return '';

    var url = '/kitchen/recipes.html?recipe=' + rid;

    // Afrundet, så flydende-tal-støj (1.5599999999) ikke ender i URL'en.
    var p = Math.round((Number(o.portions) || 0) * 1000) / 1000;
    if (p > 0) return url + '&portions=' + p;

    var trust = o.trustBatches !== false;
    var b = Math.round((Number(o.batches) || 0) * 1000) / 1000;
    if (trust && b > 0) return url + '&batches=' + b;

    // Ingen brugbar mængde: vieweren viser opskriftens eget portionstal frem
    // for at vi hælder et nul eller et gæt i den.
    return url;
}

/* ══════════════════════════════════════════════════════════════
   KUNDENS RET-LINJER  (web-bestilling)
   ══════════════════════════════════════════════════════════════
   Bestillingsformularen skriver kundens menu-valg som linjer i
   kundeønske-feltet ("3× Kyllingen") OG sender dem struktureret
   som `menu_items[]`, hvorfra bon-linjerne genereres (#382).

   To repræsentationer af det samme, og de kan skride fra hinanden:
   kunden redigerer teksten frit, og formularen genkender ikke
   altid en ret bag en note ("3× Kyllingen (1 without mayonaise)").
   Så falder retten ud af `menu_items[]` — uden en lyd, og med et
   bon-kort der ser komplet ud.

   Reglen her er den samme begge steder: en ret genkendes når dens
   navn står FORREST i linjen og slutter på en ordgrænse. Derfor
   vinder "Kyllingen BBQ- Salat" over "Kyllingen" på sin egen linje
   (længste match), og "Fisken" rammer ikke "Fiskens".

   Formularen har sin egen kopi (single-file, ingen imports) —
   `tests/wish_lines.test.js` asserterer at de to svarer ens.
   ══════════════════════════════════════════════════════════════ */

/** Ret-linjer ("N× tekst") skilt fra fri tekst. Bevarer rækkefølgen. */
function parseWishDishes(text) {
    const free = [];
    const dishes = [];
    for (const line of String(text == null ? '' : text).split('\n')) {
        const m = line.trim().match(/^(\d+)\s*[×x]\s*(.+?)\s*$/i);
        if (m) dishes.push({ count: parseInt(m[1], 10), rest: m[2] });
        else free.push(line);
    }
    return { free, dishes };
}

/* Skilletegn folk skriver forskelligt fra menuen. Menuen har "Trøflen - slider"
   og «"Tunen"»; kunden skriver "Trøflen slider" og "Tunen". Uden tolerance falder
   retten ud af bestillingen — målt på driftsdata rammer det 61 ret-linjer. */
var DISH_DASHES = /[-\u2010-\u2015]/;
var DISH_QUOTES = /["'\u00ab\u00bb\u201a\u201c\u201d\u201e]/;
var DISH_WORDCHAR = /[0-9a-z\u00e0-\u00f6\u00f8-\u00ff]/;

/**
 * Normalisér et retnavn til sammenligning, og hold styr på hvor hvert tegn kom
 * fra i originalen.
 *
 * Kortet er ikke pynt: kalderen skal kunne skære kundens note af den ORIGINALE
 * tekst ("Kyllingen (1 uden mayo)"), og normaliseringen ændrer længden. Uden
 * det ville noten blive klippet forkert.
 *
 * Anførselstegn forsvinder helt; bindestreger og gentagne mellemrum bliver til
 * ét mellemrum. `toLowerCase()` kan give flere tegn for ét (tyrkisk İ), så hvert
 * resultat-tegn får originalens index — kortet er altid lige så langt som teksten.
 */
function _normDish(s) {
    const out = [], map = [];
    let prevSpace = true;                 // true fra start = spis ledende mellemrum
    for (let i = 0; i < s.length; i++) {
        const raw = s.charAt(i);
        if (DISH_QUOTES.test(raw)) continue;
        if (DISH_DASHES.test(raw) || raw === ' ' || raw === '\t') {
            if (prevSpace) continue;
            prevSpace = true; out.push(' '); map.push(i);
            continue;
        }
        prevSpace = false;
        const lc = raw.toLowerCase();
        for (let k = 0; k < lc.length; k++) { out.push(lc.charAt(k)); map.push(i); }
    }
    while (out.length && out[out.length - 1] === ' ') { out.pop(); map.pop(); }
    return { norm: out.join(''), map };
}

/**
 * Find den ret i `names` der står forrest i `rest`. Længste match vinder,
 * og navnet skal slutte på en ordgrænse.
 *
 * Sammenligningen er tolerant over for bindestreger, dobbelte mellemrum og
 * anførselstegn (se _normDish). Målt mod driftsdata gav det 61 nye match og
 * **nul** linjer der skiftede fra én ret til en anden — og ingen af de 3119
 * bons har to egne linjer der smelter sammen, så matchet forbliver entydigt.
 *
 * @returns {{name: string, note: string}|null} name = kandidatens eget navn
 *          (uændret casing), note = det kunden skrev bagefter.
 */
function matchDishName(rest, names) {
    const hay = String(rest == null ? '' : rest).trim();
    const H = _normDish(hay);
    if (!H.norm) return null;

    let best = null;
    for (const raw of (names || [])) {
        const name = String(raw == null ? '' : raw).trim();
        const n = _normDish(name).norm;
        if (!n || n.length > H.norm.length) continue;
        if (H.norm.slice(0, n.length) !== n) continue;
        // Ordgrænse — ellers ville "Fisken" sluge "Fiskens ..."
        const next = H.norm.charAt(n.length);
        if (next && DISH_WORDCHAR.test(next)) continue;
        if (!best || n.length > best.len) {
            // Skær noten af den originale tekst, ikke af den normaliserede.
            // Et anførselstegn der KLISTRER til navnet lukker navnet («"Tunen"» før
            // « (uden løg)»); står der et mellemrum imellem, er det kundens eget
            // og bliver i noten.
            let cut = H.map[n.length - 1] + 1;
            while (cut < hay.length && DISH_QUOTES.test(hay.charAt(cut))) cut++;
            best = { name, note: hay.slice(cut).trim(), len: n.length };
        }
    }
    return best ? { name: best.name, note: best.note } : null;
}

/**
 * Hvad står i kundens tekst som ikke står på bonen?
 *
 * Går KUN fra tekst → bon. At bonen har mere end teksten er normalt
 * (office tilføjer emballage, retter efter aftale) og siges ikke.
 *
 * Emballage/levering/service tælles ikke med: dem lægger vi selv på.
 *
 * @returns {{missing: Array, differs: Array}|null} null når alt stemmer,
 *          eller når teksten slet ikke har ret-linjer (så er der intet at holde op imod).
 */
function wishLineDiff(customerWishes, lines) {
    const { dishes } = parseWishDishes(customerWishes);
    if (!dishes.length) return null;

    // Alle linjer tæller med — også emballage. At bonen har MERE end teksten
    // siges der intet om (vi går kun tekst → bon), så vores egne tilføjelser
    // larmer ikke. Og nævner kunden faktisk en transportkasse, skal antallet
    // kunne sammenlignes frem for at blive meldt som "står ikke på bonen".
    const bonLines = (lines || []);
    const names = bonLines.map(l => String((l && (l.product_name || l.name)) || ''));

    // Bonens antal pr. vare — rå dubletrækker lægges sammen
    const have = new Map();
    for (const l of bonLines) {
        const k = String((l && (l.product_name || l.name)) || '').trim().toLowerCase();
        if (k) have.set(k, (have.get(k) || 0) + (Number(l.quantity) || 0));
    }

    const missing = [];
    const wanted = new Map();
    for (const d of dishes) {
        const hit = matchDishName(d.rest, names);
        if (!hit) { missing.push({ count: d.count, text: d.rest }); continue; }
        const k = hit.name.toLowerCase();
        const prev = wanted.get(k);
        wanted.set(k, { name: hit.name, count: (prev ? prev.count : 0) + d.count });
    }

    const differs = [];
    for (const [k, w] of wanted) {
        const got = have.get(k) || 0;
        if (got !== w.count) differs.push({ name: w.name, want: w.count, have: got });
    }

    return (missing.length || differs.length) ? { missing, differs } : null;
}

/**
 * Er bonen lukket for rettelser?
 *
 * Grænsen går ved **fakturering**, ikke ved levering. En LEVERET bon skal
 * stadig faktureres, så en manglende varelinje betyder en for lille faktura —
 * det er netop dér et mærke betyder penge. Er fakturaen sendt, kan der ikke
 * gøres noget, og et mærke man ikke kan handle på lærer folk at ignorere
 * mærket. Samme svigt som vagthunden i #305.
 *
 * De fire koder er præcis dem med `status_definitions.is_terminal = 1`.
 * Listen skrives ud frem for at hente feltet, fordi draweren skal kunne
 * slukke mærket i samme øjeblik status skifter — den kender kun `status_code`
 * indtil bonen hentes igen.
 */
var CLOSED_BON_STATUSES = ['FAKTURERET', 'BETALT', 'AFSLUTTET', 'AFLYST'];
function bonIsClosed(statusCode) {
    return CLOSED_BON_STATUSES.indexOf(String(statusCode || '').toUpperCase()) !== -1;
}

/**
 * Færre enheder end gæster — er det værd at nævne?
 *
 * Reglen går KUN én vej. Flere enheder end pax er helt normalt: en
 * slider-bon har 2-3 pr. gæst, en buffet endnu flere. Målt på 2026 ville
 * 137 af 139 slider-bons i drift være tavse, og de sidste 2 har 0 enheder
 * med varer på bonen — altså en ægte fejl, ikke en slider-norm.
 *
 * Og kun når bonen HAR varer: en netop oprettet, tom bon er ufærdig,
 * ikke forkert.
 *
 * Rammer ~3 % af bons i drift, hvilket er sjældent nok til at blive læst.
 *
 * @returns {{kind: 'zero'|'few', pax: number, units: number}|null}
 */
function unitPaxHint(pax, units, hasFoodLines) {
    const p = Number(pax) || 0;
    const u = Number(units) || 0;
    if (!(p > 0 && u < p && hasFoodLines)) return null;
    return { kind: u === 0 ? 'zero' : 'few', pax: p, units: u };
}

/* ══════════════════════════════════════════════════════════════
   DAWA-ADRESSESØGNING — København først
   ══════════════════════════════════════════════════════════════

   DAWA's autocomplete rangerer ikke efter nærhed: "Vesterbrogade 10"
   giver Viborg, Kolding, Gilleleje og otte etager i Hedensted — og
   København V dukker ikke op i de første 30. At hente flere og sortere
   klient-side hjælper derfor ikke; adressen er der slet ikke.

   I stedet spørges DAWA to gange parallelt: én gang afgrænset til
   hovedstadsområdet (kommunekode-filter) og én gang uden filter. De
   lokale hits vises først, resten bagefter, hver blok sorteret efter
   postnummer (laveste = København). Dubletter (samme adresse-id) fjernes.

   Fælde: DAWA returnerer 0 hits når `fuzzy=true` kombineres med et
   filter, så den lokale forespørgsel kører altid UDEN fuzzy — kun den
   globale får det, hvis kalderen beder om det.

   `public/embed/bestilling.html` er single-file uden imports og bærer en
   KOPI af samme regel (dawaSearch). Ændres reglen her, ændres den dér. */

var DAWA_BASE = 'https://api.dataforsyningen.dk';

/** Hovedstadsområdet som DAWA-kommunekoder — det "nære" i søgningen. */
var DAWA_LOCAL_KOMMUNER = [
    '0101', // København
    '0147', // Frederiksberg
    '0151', // Ballerup
    '0153', // Brøndby
    '0155', // Dragør
    '0157', // Gentofte
    '0159', // Gladsaxe
    '0161', // Glostrup
    '0163', // Herlev
    '0165', // Albertslund
    '0167', // Hvidovre
    '0169', // Høje-Taastrup
    '0173', // Lyngby-Taarbæk
    '0175', // Rødovre
    '0183', // Ishøj
    '0185', // Tårnby
    '0187', // Vallensbæk
    '0190', // Furesø
    '0230', // Rudersdal
    '0240', // Egedal
];

/** Stabil sortering efter postnummer; ukendt postnr sidst. */
function dawaSortByPostnr(items) {
    return (items || [])
        .map(function(it, i) { return { it: it, i: i }; })
        .sort(function(a, b) {
            var pa = parseInt((a.it.adresse || {}).postnr, 10), pb = parseInt((b.it.adresse || {}).postnr, 10);
            if (isNaN(pa)) pa = 99999;
            if (isNaN(pb)) pb = 99999;
            return (pa - pb) || (a.i - b.i);
        })
        .map(function(x) { return x.it; });
}

/**
 * Ren flette-regel: lokale hits først, så resten — begge efter postnr,
 * uden dubletter, højst `limit`. Adskilt fra fetch så den kan testes.
 */
function dawaMergeSuggestions(local, global, limit) {
    var seen = {};
    var out = [];
    var take = function(list) {
        dawaSortByPostnr(list).forEach(function(it) {
            var key = (it.adresse && it.adresse.id) || it.tekst;
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(it);
        });
    };
    take(local);
    take(global);
    return out.slice(0, limit);
}

/**
 * Søg adresser i DAWA med København først.
 *
 * Returnerer samme item-form som `/adresser/autocomplete`
 * (`{ tekst, adresse: { id, vejnavn, husnr, postnr, postnrnavn, x, y, … } }`),
 * så eksisterende kaldere kan bytte deres `fetch` ud én-til-én.
 *
 * Fejler den lokale forespørgsel, vises den globale alene — søgningen må
 * ikke dø fordi ranking-laget gjorde det. Fejler den globale, kastes som før.
 *
 * @param {string} q
 * @param {{limit?: number, fuzzy?: boolean, fetch?: Function}} [opts]
 */
async function dawaAutocomplete(q, opts) {
    opts = opts || {};
    var limit = opts.limit || 10;
    var fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch mangler');
    var enc = encodeURIComponent(q);
    var localUrl  = DAWA_BASE + '/adresser/autocomplete?q=' + enc + '&per_side=' + limit
                  + '&kommunekode=' + DAWA_LOCAL_KOMMUNER.join('|');
    var globalUrl = DAWA_BASE + '/adresser/autocomplete?q=' + enc + '&per_side=' + limit
                  + (opts.fuzzy ? '&fuzzy=true' : '');
    var get = function(url) {
        return fetchImpl(url).then(function(r) {
            if (!r.ok) throw new Error('DAWA ' + r.status);
            return r.json();
        }).then(function(d) { return Array.isArray(d) ? d : []; });
    };
    var results = await Promise.all([
        get(localUrl).catch(function() { return []; }),
        get(globalUrl),
    ]);
    return dawaMergeSuggestions(results[0], results[1], limit);
}

// ════════════════════════════════════════════════════════════
// GROCY PRODUKT-FLAG
// ════════════════════════════════════════════════════════════
//
// To flag på et Grocy-produkt som Bon indtil nu ikke læste. De kommer med i
// `/objects/products` (men IKKE i `/stock`'s indlejrede `product` — se #613),
// og Grocy sender dem som tal, mens userfields kommer som strenge. Derfor den
// tolerante sammenligning, magen til `active`.
//
//   hide_on_stock_overview  "Vis aldrig på lageroversigten"
//   no_own_stock            "Deaktiver egen lagerbeholdning" — en FORÆLDER hvis
//                           beholdning ligger på børnene (kål → Spidskål, Hvidkål).
//
// `no_own_stock` er den vigtige i optællingen: forælderens egen lagerrække står
// per konstruktion på 0, så varen ligner en tom vare i tællelisten. Det var
// præcis dét der fik nogen til at trykke "Varen findes ikke mere" på kål —
// varen blev sat inaktiv, og 13 bons fik `partial` 14.–16. september 2026.
// Consume er upåvirket: `makeEffectiveStock` summerer forælder + børn, og
// trækket sender `allow_subproduct_substitution: true`.

function grocyFlagOn(v) {
    return v === 1 || v === '1' || v === true;
}

/** Skal varen aldrig vises i lageroversigten? */
function grocyHiddenOnStockOverview(p) {
    return !!p && grocyFlagOn(p.hide_on_stock_overview);
}

/** Er varen en forælder uden egen beholdning (børnene bærer lageret)? */
function grocyHasNoOwnStock(p) {
    return !!p && grocyFlagOn(p.no_own_stock);
}

// ─── Formidler-mærke ─────────────────────────────────────────
// Et firma markeret som formidler (companies.is_reseller) bestiller for andre.
// Ligger bonen på et sådant firma UDEN at vi ved hvem maden er til, kan mærket
// fortælle det — men det er bevidst en OPLYSNING, ikke en opgave: nogle
// formidlere oplyser aldrig slutkunden, så feltet må gerne stå tomt for evigt.
// Derfor ét dæmpet ord uden farve eller ikon; rød og amber er reserveret til
// noget der skal handles på.
//
// Reglen bor her, fordi bon-listen og bon-draweren begge viser mærket. Skrevet
// to steder ville de kunne skride fra hinanden, og så ville de to flader være
// uenige om hvornår en bon mangler en slutkunde.
//
// Er slutkunden kendt, er mærket overflødigt: listen viser "Able → Systematic",
// og i draweren står navnet i feltet.
function formidlerMark(bon) {
    if (!bon || !bon.company_is_reseller) return false;
    return !String(bon.end_customer_name || '').trim();
}
