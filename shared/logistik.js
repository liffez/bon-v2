/**
 * office/views/logistik.js
 * ════════════════════════════════════════════════════════════
 * Logistik — Workflow B: daglig leveringsoversigt (Delivery Spor 2).
 *
 * Office ser dagens leveringer, får et vogn-forslag pr. bon, og
 * bygger ture (oftest 1 stop) som beregnes og bekræftes.
 *
 * API:
 *   initLogistik(containerEl, { openDrawer })
 *   cleanupLogistik()
 *   _logHandleSSE(eventType, data)
 *
 * Afhængigheder (shared/api.js):
 *   fetchDeliveryOverview, fetchDeliveryVehicles, calculateDelivery,
 *   deliveryHealth, createDeliveryRoute, deleteDeliveryRoute,
 *   addDeliveryRouteStop, removeDeliveryRouteStop, reorderDeliveryRouteStops,
 *   applyDeliveryRoute, setRoutePickupTime, setDeliveryRouteActualCost,
 *   bookDeliveryRoute
 * ════════════════════════════════════════════════════════════
 */

/* ── State ──────────────────────────────────────────────── */
var _logContainer = null;
var _logOptions   = {};
var _logActive    = false;
var _logDate      = '';
var _logHighlightBon = null;   // bon der scrolles til + pulses efter load (one-shot)
var _logData      = { bons: [], routes: [] };
var _logVehicles  = [];
var _logCouriers  = [];        // aktive brugere til chauffør-tildeling
var _logSelected  = {};        // bon_id → true
var _logCalc      = {};        // bon_id → /calculate-resultat (cache)
var _logComputed  = {};        // route_id → forslag (beregnet, ikke anvendt)
var _logDebounce  = null;
var _logMap         = null;    // Leaflet-kort
var _logMarkerLayer = null;
var _logRouteLayer  = null;
var _logLegendCtl   = null;    // Leaflet-legende-kontrol
var _logMarkers     = {};      // bon_id → markør (kort↔liste-link)
var _logDrag        = null;    // bon_id der trækkes (drag → rute)

var _LOG_MONTHS = ['januar','februar','marts','april','maj','juni','juli',
                   'august','september','oktober','november','december'];
var _LOG_DAYS   = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
var _LOG_ROUTE_STATUS = {
    draft:     { label: 'Kladde',     cls: 'draft' },
    computed:  { label: 'Beregnet',   cls: 'computed' },
    confirmed: { label: 'Bekræftet',  cls: 'confirmed' },
    active:    { label: 'I gang',     cls: 'active' },
    completed: { label: 'Fuldført',   cls: 'completed' },
    cancelled: { label: 'Annulleret', cls: 'cancelled' }
};

/* ── Helpers ───────────────────────────────────────────── */
function _logEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
}
function _logToday() { return todayISO(); }
function _logShiftDate(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}
function _logDateLabel(dateStr) {
    var d = new Date(dateStr + 'T12:00:00');
    var today = _logToday();
    var prefix = dateStr === today ? 'I dag · '
        : dateStr === _logShiftDate(today, 1) ? 'I morgen · '
        : dateStr === _logShiftDate(today, -1) ? 'I går · ' : '';
    return prefix + _LOG_DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + _LOG_MONTHS[d.getMonth()];
}
function _logAddr(o) {
    var street = [o.street_name, o.street_nr].filter(Boolean).join(' ');
    var city = [o.postal_code, o.city].filter(Boolean).join(' ');
    return [street, city].filter(Boolean).join(', ');
}
function _logVehicleIcon(type) {
    if (type === 'own-bike') type = 'bike';
    var di = window.DeliveryIcons && (window.DeliveryIcons.get(type) || window.DeliveryIcons.defaults[type]);
    return di ? di.icon : '📦';
}

// Oversæt det gamle bons.delivery_method ('volvo'/'taxi'/'bike') til en
// konkret vogn. Entydigt: Egen cykel har type 'own-bike', så method 'bike'
// matcher kun By-expressen (type 'bike'). Bruges til at vise vogne der er
// tildelt på den gamle måde (uden delivery_vehicle_id) som "tildelt".
function _logVehicleByMethod(method) {
    if (!method) return null;
    return (_logVehicles || []).find(function(v) { return v.type === method; }) || null;
}
function _logMethodLabel(method) {
    var mv = _logVehicleByMethod(method);
    if (mv) return mv.label;
    return method === 'volvo' ? 'Volvo'
        : method === 'taxi' ? 'Taxa'
        : method === 'bike' ? 'By-expressen' : (method || '');
}

// Samlet markør-farve for en bon: rute-farve > booket vogn > gammel method.
function _logBonMarkerColor(b) {
    if (b.on_route_id) return _logRouteColorById(b.on_route_id);
    if (b.delivery_vehicle_id) {
        var v = (_logVehicles || []).find(function(x) { return x.id === b.delivery_vehicle_id; });
        if (v) return v.color || _logRouteColor(v.type);
        if (b.delivery_vehicle_type) return _logRouteColor(b.delivery_vehicle_type);
    }
    if (b.delivery_method) {
        var mv = _logVehicleByMethod(b.delivery_method);
        return mv ? (mv.color || _logRouteColor(mv.type)) : _logRouteColor(b.delivery_method);
    }
    return null;
}

/* ── Init / Cleanup ────────────────────────────────────── */
function initLogistik(containerEl, opts) {
    _logContainer = containerEl;
    _logOptions = opts || {};
    _logActive = true;
    _logDate = (opts && opts.date) || _logToday();
    _logHighlightBon = (opts && opts.highlightBon) || null;
    _logSelected = {};
    _logCalc = {};
    _logComputed = {};

    _logRenderShell();
    _logCheckHealth();

    fetchDeliveryVehicles().then(function(vs) {
        _logVehicles = (vs || []).filter(function(v) { return v.is_active; });
        _logBuildLegend();
    }).catch(function() { _logVehicles = []; });

    fetchDeliveryCouriers().then(function(us) {
        _logCouriers = us || [];
        if (_logActive) _logRenderRoutes();
    }).catch(function() { _logCouriers = []; });

    _logLoad();
}

function cleanupLogistik() {
    _logActive = false;
    _logData = { bons: [], routes: [] };
    _logSelected = {};
    _logCalc = {};
    _logComputed = {};
    if (_logDebounce) { clearTimeout(_logDebounce); _logDebounce = null; }
    if (_logMap) { try { _logMap.remove(); } catch (e) {} _logMap = null; }
    _logMarkerLayer = null;
    _logRouteLayer = null;
}

function _logHandleSSE(eventType, data) {
    if (!_logActive) return;
    if (_logDebounce) clearTimeout(_logDebounce);
    _logDebounce = setTimeout(function() { _logLoad(); }, 600);
}

/* ── Data ──────────────────────────────────────────────── */
function _logLoad() {
    fetchDeliveryOverview(_logDate)
        .then(function(resp) {
            if (!_logActive) return;
            _logData = resp || { bons: [], routes: [] };
            // Ryd valg af bons der ikke længere er ledige.
            var onRoute = {};
            (_logData.bons || []).forEach(function(b) { if (b.on_route_id) onRoute[b.id] = true; });
            Object.keys(_logSelected).forEach(function(id) {
                if (onRoute[id]) delete _logSelected[id];
            });
            _logRenderStatBar();
            _logRenderBons();
            _logRenderRoutes();
            _logRenderMap();
            _logRenderSelBar();
            _logLoadForslag();

            // "Se i logistik"-link: fremhæv den bon man kom fra (one-shot).
            if (_logHighlightBon) {
                var hb = _logHighlightBon;
                _logHighlightBon = null;
                var row = _logContainer.querySelector('.log-bon[data-bon-id="' + hb + '"]');
                if (row) {
                    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    row.classList.add('log-bon-flash');
                    setTimeout(function() { row.classList.remove('log-bon-flash'); }, 2500);
                }
            }
        })
        .catch(function(err) {
            console.error('[logistik] load error:', err);
            var el = document.getElementById('logBonList');
            if (el) el.innerHTML = '<div class="log-empty">Kunne ikke hente leveringer</div>';
        });
}

function _logCheckHealth() {
    deliveryHealth().then(function(h) {
        var el = document.getElementById('logHealth');
        if (!el) return;
        if (h && h.up) {
            el.innerHTML = '<span class="log-health-ok">● Routing klar</span>';
        } else {
            el.innerHTML = '<span class="log-health-down">● Routing utilgængelig</span>';
        }
    }).catch(function() {});
}

// Per-bon afstand/forslag — async, fylder linjerne ud når svaret kommer.
function _logLoadForslag() {
    (_logData.bons || []).forEach(function(b) {
        if (b.on_route_id) return;                 // på rute → ingen forslag
        if (b.delivery_vehicle_id) return;         // bud allerede bestilt → ingen forslag
        if (b.delivery_method) return;             // vogn tildelt (gammelt felt) → ingen forslag
        if (_logCalc[b.id]) { _logFillRow(b.id); return; }
        calculateDelivery({ bon_id: b.id })
            .then(function(r) {
                _logCalc[b.id] = r;
                if (_logActive) _logFillRow(b.id);
            })
            .catch(function() {});
    });
}

// Én bons afledte felter: afstand/forslag-linjen + prisen i By-ex-pillen.
function _logFillRow(bonId) {
    _logFillForslag(bonId);
    _logFillByExPill(bonId);
}

// By-ex-pillen viser standard-KUNDEPRISEN med det samme — tallet ligger
// allerede i /calculate-svaret, så det koster ingen ekstra kald. Klik
// henter stadig By-expressens egen pris (vores KOSTpris) + margin.
// Ligger turen uden for standardprisens rækkevidde, viser vi intet tal:
// et forkert tal er værre end ingen.
function _logFillByExPill(bonId) {
    var row = document.querySelector('.log-bon[data-bon-id="' + bonId + '"]');
    var btn = row && row.querySelector('.log-byex-btn');
    if (!btn) return;
    var r = _logCalc[bonId];
    if (!r || !r.ok) return;
    var alt = (r.alternatives || []).find(function(a) { return a.code === 'byekspressen'; });
    if (!alt) return;

    if (alt.cost_dkk == null) return;

    btn.innerHTML = '💰 By-ex ' + alt.cost_dkk + ' kr';
    var kasser = r.boxes != null ? r.boxes + ' kasser' : 'std';
    if (alt.suitable) {
        btn.title = 'Kundepris ex moms (' + kasser + '). Klik for By-expressens egen pris + margin.';
    } else {
        // Trappen har et trin for lange ture, så PRISEN gælder. Det der ikke
        // gælder er Food-produktet — derfor stiplet + forklaring.
        btn.classList.add('log-byex-btn-nostd');
        btn.title = 'Kundepris ex moms efter langt-væk-takst (' + kasser + ').'
            + (alt.reason ? ' NB: ' + alt.reason + ' — Food dækker ikke turen,' +
               ' så kostprisen skal hentes under By-ex booking.' : '');
    }
}

function _logFillForslag(bonId) {
    var el = document.querySelector('.log-bon[data-bon-id="' + bonId + '"] .log-bon-forslag');
    if (!el) return;
    var r = _logCalc[bonId];
    if (!r) return;
    if (!r.ok) {
        var msg = r.reason === 'missing_coords' ? '📍 Adresse mangler koordinater'
            : r.reason === 'no_route' ? '📍 Rute kunne ikke beregnes'
            : (r.reason === 'no_api_key' || r.reason === 'hq_not_configured') ? ''
            : 'Afstand kunne ikke beregnes';
        el.innerHTML = msg ? '<span class="log-forslag-note">' + msg + '</span>' : '';
        return;
    }
    var sug = (r.alternatives || []).find(function(a) { return a.vehicle_id === r.suggested_vehicle_id; });
    var sugTxt = sug
        ? _logVehicleIcon(sug.type) + ' ' + _logEsc(sug.label)
          + (sug.cost_dkk != null ? ' ~' + sug.cost_dkk + ' kr' : '')
        : '';
    el.innerHTML = '<span class="log-forslag">📍 '
        + String(r.distance_km).replace('.', ',') + ' km · ' + r.duration_min + ' min'
        + (sugTxt ? ' · ' + sugTxt : '') + '</span>';
}

/* ── Shell ─────────────────────────────────────────────── */
function _logRenderShell() {
    _logContainer.innerHTML =
        '<div class="log-wrap">' +
          '<div class="log-header">' +
            '<div class="log-nav">' +
              '<button class="log-nav-btn" data-nav="-1">◀</button>' +
              '<span class="log-date" id="logDateLabel"></span>' +
              '<button class="log-nav-btn" data-nav="1">▶</button>' +
              '<button class="log-today-btn" data-nav="today">I dag</button>' +
            '</div>' +
            '<button class="log-pc-open" id="logPcOpen" type="button"' +
              ' title="Slå leveringsprisen op for en adresse — uden at oprette en bon">' +
              '🧮 Beregn pris</button>' +
            '<div class="log-health" id="logHealth"></div>' +
          '</div>' +
          _logPriceCalcHtml() +
          '<div class="log-statbar" id="logStatBar" hidden></div>' +
          '<div class="log-map" id="logMap"></div>' +
          '<div class="log-cols">' +
            '<div class="log-col log-col-bons">' +
              '<div class="log-col-head">Leveringer <span id="logBonCount" class="log-count"></span></div>' +
              '<div id="logBonList"></div>' +
              '<div class="log-selbar" id="logSelBar" hidden></div>' +
            '</div>' +
            '<div class="log-col log-col-routes">' +
              '<div class="log-col-head">Ture</div>' +
              '<div id="logRouteList"></div>' +
            '</div>' +
          '</div>' +
        '</div>';

    document.getElementById('logDateLabel').textContent = _logDateLabel(_logDate);

    _logContainer.querySelector('.log-nav').addEventListener('click', function(e) {
        var nav = e.target.getAttribute('data-nav');
        if (!nav) return;
        _logDate = nav === 'today' ? _logToday() : _logShiftDate(_logDate, parseInt(nav, 10));
        _logCalc = {};
        _logComputed = {};
        _logSelected = {};
        document.getElementById('logDateLabel').textContent = _logDateLabel(_logDate);
        _logLoad();
    });

    _logBindPriceCalc();

    document.getElementById('logBonList').addEventListener('click', _logOnBonClick);
    document.getElementById('logRouteList').addEventListener('click', _logOnRouteClick);
    document.getElementById('logRouteList').addEventListener('change', _logOnRouteChange);
    document.getElementById('logSelBar').addEventListener('click', _logOnSelBarClick);

    _logInitMap();
}

/* ── Prisberegner for en løs adresse ────────────────────
   Til telefonopkaldet: "hvad koster det at få leveret til X?"
   Bruger SAMME /calculate som bon-forslagene, så prisen kunden
   får i røret er den samme office senere ser på bonen. Der
   oprettes ingen bon, og der ringes ikke ud til By-expressen. */

var _logPc = null;        // { lat, lon, text } — bekræftet adresse
var _logPcHits = [];      // seneste DAWA-resultater
var _logPcSeq = 0;        // race-vagt: kun det nyeste svar må rendres
var _logPcDocBound = false;

function _logPriceCalcHtml() {
    return '<div class="log-pc" id="logPriceCalc" hidden>' +
        '<div class="log-pc-head">' +
          '<strong>Beregn leveringspris</strong>' +
          '<span class="log-pc-sub">Slå prisen op uden at oprette en bon</span>' +
          '<button type="button" class="log-pc-x" data-pc="close" title="Luk">✕</button>' +
        '</div>' +
        '<div class="log-pc-form">' +
          '<label class="log-pc-field log-pc-field-addr">' +
            '<span>Leveringsadresse</span>' +
            '<input type="text" id="logPcAddr" placeholder="Søg adresse…" autocomplete="off">' +
            '<div class="log-pc-dawa" id="logPcDawa" hidden></div>' +
          '</label>' +
          '<label class="log-pc-field log-pc-field-n">' +
            '<span>Kuverter</span>' +
            '<input type="number" id="logPcPax" min="0" step="1" placeholder="fx 30">' +
          '</label>' +
          '<label class="log-pc-field log-pc-field-n">' +
            '<span>Kasser</span>' +
            '<input type="number" id="logPcBoxes" min="0" step="1" placeholder="auto">' +
          '</label>' +
        '</div>' +
        '<div class="log-pc-result" id="logPcResult"></div>' +
        '<div class="log-pc-hist" id="logPcHist" hidden></div>' +
      '</div>';
}

function _logBindPriceCalc() {
    var openBtn = document.getElementById('logPcOpen');
    var panel = document.getElementById('logPriceCalc');
    if (!openBtn || !panel) return;

    openBtn.addEventListener('click', function() {
        panel.hidden = !panel.hidden;
        openBtn.classList.toggle('log-pc-open-active', !panel.hidden);
        if (!panel.hidden) document.getElementById('logPcAddr').focus();
    });
    panel.addEventListener('click', function(e) {
        if (!e.target.closest('[data-pc="close"]')) return;
        panel.hidden = true;
        openBtn.classList.remove('log-pc-open-active');
    });

    var addr = document.getElementById('logPcAddr');
    var dawa = document.getElementById('logPcDawa');
    var searchTimer = null;

    addr.addEventListener('input', function() {
        _logPc = null;                       // adressen er ikke bekræftet længere
        clearTimeout(searchTimer);
        var q = addr.value.trim();
        if (q.length < 3) { dawa.hidden = true; dawa.innerHTML = ''; return; }
        searchTimer = setTimeout(function() { _logPcSearch(q); }, 300);
    });
    addr.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { dawa.hidden = true; }
    });
    // mousedown (ikke click): fyrer FØR feltet mister fokus, så valget
    // ikke går tabt hvis noget senere skulle skjule listen på blur.
    dawa.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.log-pc-dawa-item');
        if (!item) return;
        e.preventDefault();
        _logPcSelect(_logPcHits[parseInt(item.getAttribute('data-i'), 10)]);
    });

    // Kun ÉN gang for hele siden — shell'en gen-renderes ved view-skift.
    if (!_logPcDocBound) {
        _logPcDocBound = true;
        document.addEventListener('click', function(e) {
            var p = document.getElementById('logPriceCalc');
            var d = document.getElementById('logPcDawa');
            if (p && d && !p.contains(e.target)) d.hidden = true;
        });
    }

    var recalcTimer = null;
    var bump = function() { clearTimeout(recalcTimer); recalcTimer = setTimeout(_logPcCalc, 350); };
    document.getElementById('logPcPax').addEventListener('input', bump);
    document.getElementById('logPcBoxes').addEventListener('input', bump);
}

function _logPcSearch(q) {
    var dawa = document.getElementById('logPcDawa');
    if (!dawa) return;
    fetch('https://api.dataforsyningen.dk/adresser/autocomplete?q=' + encodeURIComponent(q) + '&per_side=6')
        .then(function(r) { return r.json(); })
        .then(function(list) {
            if (!document.getElementById('logPcDawa')) return;
            if (!Array.isArray(list) || !list.length) { dawa.hidden = true; dawa.innerHTML = ''; return; }
            _logPcHits = list;
            dawa.innerHTML = list.map(function(it, i) {
                return '<div class="log-pc-dawa-item" data-i="' + i + '">' + _logEsc(it.tekst || '') + '</div>';
            }).join('');
            dawa.hidden = false;
        })
        .catch(function() { dawa.hidden = true; });
}

function _logPcSelect(item) {
    if (!item) return;
    var a = item.adresse || {};
    var lat = Number(a.y), lon = Number(a.x);      // DAWA: x = lon, y = lat (WGS84)
    document.getElementById('logPcAddr').value = item.tekst || '';
    document.getElementById('logPcDawa').hidden = true;
    if (!isFinite(lat) || !isFinite(lon)) {
        _logPc = null;
        _logPcMsg('Adressen har ingen koordinater — prøv en anden skrivemåde.', 'err');
        return;
    }
    _logPc = { lat: lat, lon: lon, text: item.tekst || '', postnr: a.postnr || '' };
    _logPcCalc();
    _logPcLoadHistory(a.postnr);
}

// "Hvad plejer vi at tage hertil?" — uafhængigt af formlen, hentet fra
// hvad kunderne faktisk er blevet opkrævet. Non-blocking: fejler den,
// mangler linjen bare.
function _logPcLoadHistory(postnr) {
    var el = document.getElementById('logPcHist');
    if (!el) return;
    if (!postnr) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'log-pc-hist loading';
    el.textContent = 'Slår tidligere priser op…';
    fetchDeliveryPriceHistory(postnr, 8).then(function(h) {
        if (!_logPc || _logPc.postnr !== postnr) return;   // adressen er skiftet
        el.className = 'log-pc-hist';
        if (!h || !h.count) {
            el.innerHTML = '<span class="log-pc-hist-none">Ingen tidligere leveringer til '
                + _logEsc(postnr) + '</span>';
            return;
        }
        var kr = function(n) { return Number(n).toLocaleString('da-DK', { maximumFractionDigits: 2 }) + ' kr'; };
        var top = (h.common || [])[0];
        el.innerHTML = '<strong>Sidst taget til ' + _logEsc(h.postal_code) + ':</strong> '
            + kr(h.last.price_incl) + ' <span class="log-pc-dim">inkl. ('
            + kr(h.last.price_ex) + ' ex) · ' + _logEsc(h.last.label || '')
            + (h.last.delivery_date ? ' · ' + _logEsc(h.last.delivery_date) : '') + '</span>'
            + (top && top.n > 1
                ? '<br><span class="log-pc-dim">Oftest ' + kr(top.price_incl) + ' inkl. ('
                  + top.n + ' af ' + h.count + ' seneste)</span>'
                : '');
    }).catch(function() {
        el.hidden = true;
    });
}

function _logPcMsg(text, cls) {
    var out = document.getElementById('logPcResult');
    if (!out) return;
    out.className = 'log-pc-result log-pc-' + (cls || 'note');
    out.textContent = text;
}

function _logPcCalc() {
    if (!_logPc) return;
    var pax = parseInt(document.getElementById('logPcPax').value, 10);
    var boxes = parseInt(document.getElementById('logPcBoxes').value, 10);
    var payload = { lat: _logPc.lat, lng: _logPc.lon };
    if (boxes > 0) payload.boxes = boxes;
    if (pax > 0) payload.pax = pax;

    _logPcMsg('Beregner…', 'loading');
    var token = ++_logPcSeq;
    calculateDelivery(payload)
        .then(function(r) { if (token === _logPcSeq) _logPcRender(r); })
        .catch(function(e) {
            if (token !== _logPcSeq) return;
            _logPcMsg('Kunne ikke beregne: ' + ((e && e.message) || 'fejl'), 'err');
        });
}

function _logPcRender(r) {
    var out = document.getElementById('logPcResult');
    if (!out) return;
    if (!r || !r.ok) {
        _logPcMsg(
            r && r.reason === 'no_api_key'        ? 'Rute-opslag er ikke sat op (ORS-nøgle mangler).'
          : r && r.reason === 'hq_not_configured' ? 'HQ-koordinater mangler i indstillingerne.'
          : r && r.reason === 'no_route'          ? 'Der kunne ikke findes en rute til adressen.'
          : 'Afstanden kunne ikke beregnes.', 'err');
        return;
    }

    // Vis hvilket kasse-antal prisen er regnet på, uden at overskrive et tal
    // brugeren selv har tastet.
    var boxEl = document.getElementById('logPcBoxes');
    if (boxEl && !boxEl.value) boxEl.placeholder = r.boxes > 0 ? r.boxes + ' (auto)' : 'auto';

    var kr = function(n) {
        return n == null ? '–' : Number(n).toLocaleString('da-DK', { maximumFractionDigits: 2 }) + ' kr';
    };
    var toIncl = function(ex) {
        return (ex != null && window.Moms) ? window.Moms.exclToIncl(ex) : null;
    };

    var rows = (r.alternatives || []).slice().sort(function(a, b) {
        if (a.suitable !== b.suitable) return a.suitable ? -1 : 1;
        return (a.cost_dkk == null ? Infinity : a.cost_dkk) - (b.cost_dkk == null ? Infinity : b.cost_dkk);
    }).map(function(a) {
        // Constraint-brud er en anbefaling, ikke en spærring — og siden By-expressen
        // fik en afstandstrappe, GÆLDER prisen også herude. Så sig ikke andet.
        var caveat = (!a.suitable && a.reason)
            ? '<span class="log-pc-caveat">⚠ ' + _logEsc(a.reason) + ' — kan vælges alligevel</span>'
            : '';
        return '<div class="log-pc-row' + (a.suitable ? '' : ' log-pc-row-off') + '">' +
            '<span class="log-pc-veh">' + _logVehicleIcon(a.type) + ' ' + _logEsc(a.label) +
              (a.is_internal ? ' <span class="log-pc-tag">egen vogn</span>' : '') + '</span>' +
            '<span class="log-pc-ex">' + kr(a.cost_dkk) + '</span>' +
            '<span class="log-pc-incl">' + kr(toIncl(a.cost_dkk)) + '</span>' +
            caveat +
        '</div>';
    }).join('');

    out.className = 'log-pc-result log-pc-ok';
    out.innerHTML =
        '<div class="log-pc-sum">📍 ' + String(r.distance_km).replace('.', ',') + ' km · '
          + r.duration_min + ' min fra HQ · '
          + (r.boxes > 0
              ? 'pris regnet på <strong>' + r.boxes + ' kasser</strong>'
              : 'pris uden kasse-tillæg — skriv antal kuverter for et præcist tal')
          + '</div>' +
        '<div class="log-pc-rows">' +
          '<div class="log-pc-row log-pc-row-head">' +
            '<span class="log-pc-veh">Vogn</span>' +
            '<span class="log-pc-ex">ex moms</span>' +
            '<span class="log-pc-incl">inkl. moms</span>' +
          '</div>' + rows +
        '</div>' +
        '<div class="log-pc-foot">Sig <strong>inkl. moms</strong> til en privatkunde og '
          + '<strong>ex moms</strong> til et firma.<br>'
          + '“Egen vogn” er vores egen omkostning ved selv at køre — ikke et tal at give kunden. '
          + 'Standardpriser, ikke et bindende tilbud.</div>';
}

/* ── Live-mode statbar (vises kun når datoen er i dag) ─── */
function _logRenderStatBar() {
    var bar = document.getElementById('logStatBar');
    if (!bar) return;
    if (_logDate !== _logToday()) { bar.hidden = true; bar.innerHTML = ''; return; }

    var leveret = 0, problem = 0, undervejs = 0;
    (_logData.routes || []).forEach(function(r) {
        (r.stops || []).forEach(function(s) {
            if (s.status === 'leveret')      leveret++;
            else if (s.status === 'problem') problem++;
            else                             undervejs++;
        });
    });
    if (leveret + problem + undervejs === 0) { bar.hidden = true; bar.innerHTML = ''; return; }

    bar.hidden = false;
    bar.innerHTML =
        '<span class="log-stat log-stat-live">● Live · i dag</span>' +
        '<span class="log-stat log-stat-done">' + leveret + ' leveret</span>' +
        '<span class="log-stat log-stat-way">' + undervejs + ' undervejs</span>' +
        '<span class="log-stat log-stat-prob' + (problem ? '' : ' is-zero') + '">' +
            problem + ' problem</span>';
}

// Stop-etiket: courierens stop-status (leveret/problem) vinder over
// bon-statussen — så et problem-stop ikke bare viser bonens "klar".
function _logStopLabel(s) {
    if (s.status === 'problem') return { label: 'problem', cls: 'problem' };
    if (s.status === 'leveret') return { label: 'leveret', cls: 'leveret' };
    return _logBonState(s.status_code);
}

/* ── Bon-liste ─────────────────────────────────────────── */
function _logRenderBons() {
    var el = document.getElementById('logBonList');
    var bons = _logData.bons || [];
    document.getElementById('logBonCount').textContent = bons.length ? '(' + bons.length + ')' : '';

    if (!bons.length) {
        el.innerHTML = '<div class="log-empty">Ingen leveringer denne dag</div>';
        return;
    }

    el.innerHTML = bons.map(function(b) {
        var onRoute = !!b.on_route_id;
        var statusCls = (b.status_code || '').toLowerCase();
        var name = b.company_name || b.customer_name || 'Ukendt';
        var check = onRoute ? ''
            : '<input type="checkbox" class="log-bon-check" data-bon-id="' + b.id + '"'
              + (_logSelected[b.id] ? ' checked' : '') + '>';
        // Allerede bestilt bud (Spor 1 — popout-booking uden rute).
        var booked = !onRoute && b.delivery_vehicle_id;
        // Vogn tildelt via det gamle delivery_method-felt (ingen vehicle_id).
        var assigned = !onRoute && !b.delivery_vehicle_id && b.delivery_method;
        var routeLine;
        if (onRoute) {
            routeLine = '<span class="log-bon-onroute">'
                + '<span class="log-dot" style="background:' + (_logRouteColorById(b.on_route_id) || '#9a948c') + '"></span>'
                + 'På rute #' + b.on_route_id
                + (b.route_sequence ? ' · stop ' + b.route_sequence : '') + '</span>';
        } else if (booked) {
            routeLine = '<span class="log-bon-booked">'
                + _logVehicleIcon(b.delivery_vehicle_type || b.delivery_method) + ' '
                + _logEsc(b.delivery_vehicle_label || 'Bud bestilt') + ' · booket</span>';
        } else if (assigned) {
            var aColor = _logBonMarkerColor(b) || '#9a948c';
            routeLine = '<span class="log-bon-assigned-method">'
                + '<span class="log-dot" style="background:' + aColor + '"></span>'
                + _logVehicleIcon(b.delivery_method) + ' '
                + _logEsc(_logMethodLabel(b.delivery_method)) + ' · tildelt</span>';
        } else {
            routeLine = '<span class="log-bon-forslag"><span class="log-forslag-note">Beregner…</span></span>';
        }

        var addrText = _logAddr(b);
        var addrHtml = addrText
            ? '<a class="log-bon-addr log-bon-addr-link" draggable="false"'
              + ' href="https://www.google.com/maps/search/?api=1&query='
              + encodeURIComponent(addrText) + '" target="_blank" rel="noopener"'
              + ' title="Åbn i Google Maps">'
              + '<svg class="log-addr-pin" viewBox="0 0 24 24" fill="none"'
              + ' stroke="currentColor" stroke-width="2.2">'
              + '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>'
              + '<circle cx="12" cy="10" r="3"/></svg>'
              + _logEsc(addrText) + '</a>'
            : '<div class="log-bon-addr"></div>';

        return '<div class="log-bon' + (onRoute ? ' log-bon-assigned' : '') + '" data-bon-id="' + b.id + '">' +
            '<div class="log-bon-check-cell">' + check + '</div>' +
            '<div class="log-bon-main">' +
              '<div class="log-bon-row1">' +
                '<span class="log-bon-time">' + _logEsc(b.delivery_time || '–') + '</span>' +
                '<span class="log-bon-name">' + _logEsc(name) + '</span>' +
                '<span class="log-bon-status status-' + statusCls + '">' + _logEsc(b.status_code || '') + '</span>' +
              '</div>' +
              addrHtml +
              '<div class="log-bon-meta">' + routeLine +
                (onRoute ? '' : '<button class="log-byex-btn" data-byex="' + b.id + '" title="Hent live By-ex pris">💰 By-ex pris</button>') +
              '</div>' +
              '<div class="log-byex-result" data-byex-result="' + b.id + '" hidden></div>' +
            '</div>' +
        '</div>';
    }).join('');

    // Kort↔liste-link + drag-til-rute.
    el.querySelectorAll('.log-bon').forEach(function(row) {
        var id = parseInt(row.getAttribute('data-bon-id'), 10);
        row.addEventListener('mouseenter', function() { _logHighlightMarker(id, true); });
        row.addEventListener('mouseleave', function() { _logHighlightMarker(id, false); });
        // Kun uplanlagte bons kan trækkes til en rute.
        if (!row.classList.contains('log-bon-assigned')) {
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', function(e) {
                _logDrag = id;
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', function() {
                _logDrag = null;
                _logContainer.querySelectorAll('.log-route-drop')
                    .forEach(function(c) { c.classList.remove('log-route-drop'); });
            });
        }
    });
}

// Fremhæv en bon-RÆKKE (kaldes når markøren hoveres).
function _logHighlightBonRow(bonId, on) {
    var row = _logContainer && _logContainer.querySelector('.log-bon[data-bon-id="' + bonId + '"]');
    if (row) row.classList.toggle('log-bon-hi', on);
}

// Fremhæv en MARKØR (kaldes når rækken hoveres).
function _logHighlightMarker(bonId, on) {
    var m = _logMarkers[bonId];
    if (!m) return;
    var el = m.getElement();
    if (el) el.classList.toggle('log-mk-hi', on);
}

// Klik i checkbox-cellen til venstre vælger/fravælger bonen til en tur
// (man kan vælge flere bons der køres sammen). Klik andetsteds på rækken
// åbner bon-draweren. Cellen er bred + fuld højde, så den er nem at ramme
// uden at ramme drawer-zonen.
function _logOnBonClick(e) {
    var row = e.target.closest('.log-bon');
    if (!row) return;
    var id = parseInt(row.getAttribute('data-bon-id'), 10);
    if (!id) return;
    var chk = row.querySelector('.log-bon-check');

    if (e.target.closest('.log-bon-check-cell') && chk) {
        var sel = (e.target === chk) ? chk.checked : !_logSelected[id];
        if (e.target !== chk) chk.checked = sel;
        if (sel) _logSelected[id] = true;
        else delete _logSelected[id];
        _logRenderSelBar();
        return;
    }
    // Adresse-link → lad browseren åbne Google Maps; åbn ikke draweren.
    if (e.target.closest('.log-bon-addr-link')) return;
    // Kasse-stepper i By-ex resultatet → gen-hent med justeret antal.
    var boxBtn = e.target.closest('.log-box-btn');
    if (boxBtn) {
        var resEl = row.querySelector('.log-byex-result');
        if (resEl && resEl.classList.contains('busy')) return;  // undgå dobbeltklik mens den henter
        var cur = resEl ? (parseInt(resEl.getAttribute('data-boxes'), 10) || 0) : 0;
        _logFetchByExPrice(id, row, Math.max(0, cur + parseInt(boxBtn.getAttribute('data-box'), 10)));
        return;
    }
    // "By-ex pris"-knap → hent live kostpris inline (åbn ikke draweren).
    if (e.target.closest('.log-byex-btn')) { _logFetchByExPrice(id, row); return; }
    // Alt andet på rækken → åbn bon-draweren.
    if (_logOptions.openDrawer) _logOptions.openDrawer(id);
}

// On-demand By-ex (Lobo) kostpris for én bon. Opretter + sletter en orderdraft
// hos Lobo (INGEN ordre, intet bud) og viser kostpris + margin inline.
function _logFetchByExPrice(id, row, boxes) {
    var btn = row.querySelector('.log-byex-btn');
    var out = row.querySelector('.log-byex-result[data-byex-result="' + id + '"]');
    if (!out) return;
    if (btn) btn.disabled = true;
    out.hidden = false;
    // Ved kasse-justering: behold linjen + dæmp kun (intet blink). Første gang: vis "Henter".
    var isUpdate = out.classList.contains('ok');
    if (isUpdate) {
        out.classList.add('busy');
        var nEl = out.querySelector('.log-box-n');
        if (nEl && boxes != null) nEl.textContent = boxes;
    } else {
        out.className = 'log-byex-result loading';
        out.textContent = 'Henter By-ex pris…';
    }
    fetchLoboQuote(id, boxes).then(function(q) {
        var kr = function(n) { return n == null ? '–' : Number(n).toLocaleString('da-DK', { maximumFractionDigits: 2 }) + ' kr'; };
        // By-expressens EGEN målte afstand — mærkes, så den ikke forveksles med
        // vores ORS-afstand fra HQ på linjen ovenover (de måler ikke det samme).
        var dist = q.routedistance != null
            ? ' · ' + (q.routedistance / 1000).toLocaleString('da-DK', { maximumFractionDigits: 1 })
              + ' km <span class="byex-dim">(By-ex)</span>'
            : '';
        var marginHtml = '';
        if (q.margin != null) {
            marginHtml = ' · <span class="byex-margin ' + (q.margin < 0 ? 'neg' : 'pos') + '">margin '
                + (q.margin >= 0 ? '+' : '') + kr(q.margin) + '</span>';
        } else if (q.supply_warning) {
            // By-expressen kører gerne derud, men ikke på Food — og det er Food vi
            // har spurgt om. Prisen ovenfor er derfor et Food-tal for noget vi ikke
            // kan købe. Send office videre til booking-panelet frem for at gætte.
            marginHtml = ' · <span class="byex-suggest">uden for Food-området — hent'
                + ' rigtig pris under <strong>By-ex booking</strong></span>';
        }
        out.setAttribute('data-boxes', q.boxes);
        out.className = 'log-byex-result ok';
        out.innerHTML = '🚴 <strong>' + kr(q.cost_ex) + '</strong> <span class="byex-dim">ex moms</span>' + marginHtml + dist
            + ' · <span class="log-box-stepper">Kasser <button type="button" class="log-box-btn" data-box="-1">−</button>'
            + '<span class="log-box-n">' + q.boxes + '</span>'
            + '<button type="button" class="log-box-btn" data-box="1">+</button></span>';
    }).catch(function(err) {
        out.className = 'log-byex-result err';
        out.textContent = (err && err.code === 'config')
            ? 'By-ex ikke konfigureret endnu'
            : 'Kunne ikke hente pris: ' + ((err && err.message) || 'fejl');
    }).finally(function() {
        if (btn) btn.disabled = false;
    });
}

/* ── Vælg-bar (opret tur) ──────────────────────────────── */
function _logRenderSelBar() {
    var el = document.getElementById('logSelBar');
    var ids = Object.keys(_logSelected);
    if (!ids.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    var opts = _logVehicles.map(function(v) {
        return '<option value="' + v.id + '">' + _logVehicleIcon(v.type) + ' ' + _logEsc(v.label) + '</option>';
    }).join('');

    el.innerHTML =
        '<span class="log-selbar-count">' + ids.length + ' valgt</span>' +
        '<select class="log-selbar-vehicle" id="logSelVehicle">' + opts + '</select>' +
        '<button class="log-btn log-btn-primary" data-action="create-route">Opret tur</button>' +
        '<button class="log-btn log-btn-ghost" data-action="clear-sel">Ryd</button>';
}

function _logOnSelBarClick(e) {
    var action = e.target.getAttribute('data-action');
    if (action === 'clear-sel') {
        _logSelected = {};
        _logRenderBons();
        _logRenderSelBar();
        _logLoadForslag();
    } else if (action === 'create-route') {
        _logCreateRoute();
    }
}

function _logCreateRoute() {
    var sel = document.getElementById('logSelVehicle');
    var vehicleId = sel ? parseInt(sel.value, 10) : null;
    if (!vehicleId) { alert('Vælg en vogn'); return; }
    var bonIds = Object.keys(_logSelected).map(function(s) { return parseInt(s, 10); });
    if (!bonIds.length) return;

    createDeliveryRoute({ route_date: _logDate, vehicle_id: vehicleId })
        .then(function(route) {
            // Tilføj de valgte bons sekventielt.
            return bonIds.reduce(function(chain, bonId) {
                return chain.then(function() { return addDeliveryRouteStop(route.id, bonId); });
            }, Promise.resolve());
        })
        .then(function() {
            _logSelected = {};
            _logLoad();
        })
        .catch(function(err) {
            alert('Kunne ikke oprette tur: ' + (err.message || 'fejl'));
        });
}

/* ── Rute-liste ────────────────────────────────────────── */
function _logRenderRoutes() {
    var el = document.getElementById('logRouteList');
    var routes = _logData.routes || [];
    if (!routes.length) {
        el.innerHTML = '<div class="log-empty">Ingen ture endnu — vælg leveringer og opret en tur</div>';
        return;
    }
    el.innerHTML = routes.map(_logRouteCard).join('');

    // Drop-mål: træk en uplanlagt bon ind på et rute-kort → tilføj stop.
    el.querySelectorAll('.log-route').forEach(function(card) {
        var routeId = parseInt(card.getAttribute('data-route-id'), 10);
        card.addEventListener('dragover', function(e) {
            if (_logDrag == null || card.getAttribute('data-editable') !== '1') return;
            e.preventDefault();
            card.classList.add('log-route-drop');
        });
        card.addEventListener('dragleave', function(e) {
            if (!card.contains(e.relatedTarget)) card.classList.remove('log-route-drop');
        });
        card.addEventListener('drop', function(e) {
            e.preventDefault();
            card.classList.remove('log-route-drop');
            if (_logDrag == null || card.getAttribute('data-editable') !== '1') return;
            var bonId = _logDrag;
            _logDrag = null;
            addDeliveryRouteStop(routeId, bonId)
                .then(function() { delete _logComputed[routeId]; _logLoad(); })
                .catch(function(err) { alert('Kunne ikke tilføje til ruten: ' + (err.message || 'fejl')); });
        });
    });
}

// Bon-status pr. stop → kort etiket. Senere (S2.3/S2.4) udvides med
// "hos bud" + "afleveret" fra courier-app / By-expressens API.
function _logBonState(code) {
    switch (code) {
        case 'KLAR':    return { label: 'klar',      cls: 'klar' };
        case 'LEVERET': return { label: 'afleveret', cls: 'leveret' };
        case 'IGANG':   return { label: 'i køkken',  cls: 'igang' };
        case 'AFLYST':  return { label: 'aflyst',    cls: 'aflyst' };
        default:        return { label: 'afventer',  cls: 'afventer' };
    }
}

// Rute-health: hvad kræver opmærksomhed? Chips til hurtigt overblik.
function _logRouteHealthChips(r) {
    var chips = [];
    var stops = r.stops || [];
    var cancelled = stops.filter(function(s) { return s.status_code === 'AFLYST'; });
    if (cancelled.length) {
        chips.push({ text: '🔴 ' + cancelled.length + ' aflyst stop', cls: 'bad' });
    }
    if (r.status === 'draft' && stops.length) {
        chips.push({ text: '⚠ Skal beregnes', cls: 'warn' });
    }
    var ext = r.vehicle_booking_method === 'manual_clipboard' || r.vehicle_booking_method === 'api';
    if (ext && r.booking_status === 'pending' && stops.length) {
        chips.push({ text: '⚠ Skal bookes', cls: 'warn' });
    }
    if (stops.length) {
        var klar = stops.filter(function(s) {
            return s.status_code === 'KLAR' || s.status_code === 'LEVERET';
        }).length;
        chips.push({
            text: klar + '/' + stops.length + ' klar',
            cls: (klar === stops.length && chips.length === 0) ? 'ok' : 'neutral'
        });
    }
    return chips;
}

function _logRouteCard(r) {
    var st = _LOG_ROUTE_STATUS[r.status] || { label: r.status, cls: 'draft' };
    var stops = r.stops || [];
    var proposal = _logComputed[r.id];
    var isDraft = r.status === 'draft' || r.status === 'computed';
    // Stop kan redigeres så længe ruten ikke er afsluttet — også på en
    // bekræftet rute (verden ændrer sig efter bekræftelse).
    var isEditable = r.status !== 'completed' && r.status !== 'cancelled';

    var summaryBits = [];
    summaryBits.push(stops.length + ' stop');
    var km = (proposal && proposal.total_km != null) ? proposal.total_km : r.total_km;
    if (km != null) summaryBits.push(String(km).replace('.', ',') + ' km');
    var cost = (proposal && proposal.estimated_cost_dkk != null)
        ? proposal.estimated_cost_dkk : r.estimated_cost_dkk;
    if (cost != null) summaryBits.push('~' + cost + ' kr');

    // Stop-rækker (ETA fra forslag hvis netop beregnet, ellers fra DB).
    var etaByStop = {};
    if (proposal) (proposal.ordered_stops || []).forEach(function(s) { etaByStop[s.bon_id] = s.eta; });
    var stopRows = stops.map(function(s, idx) {
        var eta = etaByStop[s.bon_id] != null ? etaByStop[s.bon_id] : s.eta;
        var reorder = '';
        if (isEditable && stops.length > 1) {
            reorder =
                '<button class="log-stop-mv" data-action="move-up" data-route-id="' + r.id +
                  '" data-bon-id="' + s.bon_id + '"' + (idx === 0 ? ' disabled' : '') +
                  ' title="Flyt op">▲</button>' +
                '<button class="log-stop-mv" data-action="move-down" data-route-id="' + r.id +
                  '" data-bon-id="' + s.bon_id + '"' + (idx === stops.length - 1 ? ' disabled' : '') +
                  ' title="Flyt ned">▼</button>';
        }
        var rm = isEditable
            ? '<button class="log-stop-rm" data-action="rm-stop" data-route-id="' + r.id
              + '" data-bon-id="' + s.bon_id + '" title="Fjern stop">×</button>'
            : '';
        var bonState = _logStopLabel(s);
        var cancelled = s.status_code === 'AFLYST';
        return '<div class="log-stop' + (cancelled ? ' log-stop-cancelled' : '') + '">' +
            '<span class="log-stop-seq">' + s.sequence + '</span>' +
            '<span class="log-stop-bon" data-open-bon="' + s.bon_id + '">#' + _logEsc(s.bon_number) + '</span>' +
            '<span class="log-stop-cust">' + _logEsc(s.company_name || s.customer_name || '') + '</span>' +
            '<span class="log-stop-state log-bst-' + bonState.cls + '">' + bonState.label + '</span>' +
            '<span class="log-stop-eta">' + (eta ? 'ETA ' + _logEsc(eta) : '') + '</span>' +
            reorder + rm + '</div>';
    }).join('');

    // Forslag-advarsler/fejl efter Beregn.
    var alertHtml = '';
    if (proposal) {
        (proposal.errors || []).forEach(function(e) {
            alertHtml += '<div class="log-route-alert log-alert-error">⚠ ' + _logEsc(e.message) + '</div>';
        });
        (proposal.warnings || []).forEach(function(w) {
            alertHtml += '<div class="log-route-alert log-alert-warn">⚠ ' + _logEsc(w.message) + '</div>';
        });
        if (!proposal.errors.length && !proposal.warnings.length) {
            alertHtml += '<div class="log-route-alert log-alert-ok">✓ Ruten kan gennemføres — klik Anvend</div>';
        }
    }

    // Action-knapper. "Beregn rute" beregner + skriver planen i ét — intet
    // låses, så der er ingen grund til separat anvend/bekræft.
    var actions = [];
    if (isDraft && stops.length) {
        actions.push('<button class="log-btn log-btn-primary" data-action="apply" data-route-id="' + r.id + '">Beregn rute</button>');
    }
    if (isDraft) {
        actions.push('<button class="log-btn log-btn-danger" data-action="delete-route" data-route-id="' + r.id + '">Slet</button>');
    }

    // Booking — kun eksterne vogne (By-expressen/taxa) bookes eksternt.
    // Interne vogne (Volvo/egen cykel) kører selv — ingen booking-sektion.
    var isExternal = r.vehicle_booking_method === 'manual_clipboard'
                  || r.vehicle_booking_method === 'api';
    var bookingHtml = '';
    if (isExternal) {
        var bsMap = {
            pending:      { label: 'Afventer booking', cls: 'pending' },
            in_progress:  { label: 'Afventer ref',     cls: 'pending' },
            booked:       { label: '✓ Booket',         cls: 'booked' },
            failed:       { label: 'Booking fejlede',  cls: 'failed' },
            not_required: { label: '—',                cls: 'pending' }
        };
        var bs = bsMap[r.booking_status] || { label: r.booking_status || '—', cls: 'pending' };
        bookingHtml =
            '<div class="log-route-booking">' +
              '<div class="log-booking-line">' +
                '<span class="log-booking-badge log-bs-' + bs.cls + '">' + bs.label + '</span>' +
                (r.external_reference
                    ? '<span class="log-booking-ref">ref ' + _logEsc(r.external_reference) + '</span>' : '') +
                '<button class="log-btn log-btn-primary" data-action="open-booking" ' +
                  'data-route-id="' + r.id + '">📦 Book hos ' +
                  _logEsc(r.vehicle_label || 'leverandør') + '</button>' +
              '</div>' +
              '<div class="log-booking-line">' +
                '<input type="text" class="log-booking-ref-input" data-route-id="' + r.id + '" ' +
                  'placeholder="Booking-ref (valgfri)">' +
                '<button class="log-btn log-btn-ok" data-action="mark-booked" ' +
                  'data-route-id="' + r.id + '">Marker booket</button>' +
              '</div>' +
            '</div>';
    }

    // Health-linje — hurtigt overblik over hvad ruten kræver.
    var healthHtml = '<div class="log-route-health">' +
        _logRouteHealthChips(r).map(function(c) {
            return '<span class="log-hc log-hc-' + c.cls + '">' + c.text + '</span>';
        }).join('') + '</div>';

    // Afhentningstid — redigerbar. Vi regner baglæns fra leveringstid;
    // office kan altid taste en manuel tid (vinder over genberegning).
    var pickupHtml = '';
    if (stops.length) {
        var pickupVal = r.pickup_time || '';
        var suggestion = (proposal && proposal.suggested_pickup_time) || '';
        var pickupHint = '';
        if (r.pickup_time_source === 'manual') {
            pickupHint = '<span class="log-pickup-tag">manuelt</span>' +
                '<button class="log-pickup-auto" data-action="pickup-auto" ' +
                  'data-route-id="' + r.id + '">↺ auto</button>';
            if (suggestion && suggestion !== pickupVal) {
                pickupHint += '<span class="log-pickup-sugg">forslag ' + _logEsc(suggestion) + '</span>';
            }
        }
        pickupHtml =
            '<div class="log-pickup-row">' +
              '<label>Afhentning</label>' +
              '<input type="text" class="log-pickup-input" data-route-id="' + r.id + '" ' +
                'value="' + _logEsc(pickupVal) + '" placeholder="––:––" maxlength="5">' +
              '<button class="log-btn log-btn-ghost" data-action="save-pickup" ' +
                'data-route-id="' + r.id + '">Gem</button>' +
              pickupHint +
            '</div>';
    }

    // Chauffør — kun interne vogne (Volvo/egen cykel) kører selv og dukker
    // op i courier-mobilen. Uden en tildelt chauffør ser ingen ruten på
    // mobilen, så feltet er afgørende for internt-kørte ture.
    var courierHtml = '';
    if (!isExternal) {
        var courierOpts = '<option value="">— vælg chauffør —</option>' +
            _logCouriers.map(function(u) {
                var selected = String(u.id) === String(r.courier_user_id) ? ' selected' : '';
                return '<option value="' + u.id + '"' + selected + '>' + _logEsc(u.name) + '</option>';
            }).join('');
        var courierWarn = r.courier_user_id ? '' :
            '<span class="log-courier-warn">⚠ Ingen chauffør — vises ikke på mobil</span>';
        courierHtml =
            '<div class="log-route-courier">' +
              '<label>Chauffør</label>' +
              '<select class="log-courier-select" data-route-id="' + r.id + '">' + courierOpts + '</select>' +
              courierWarn +
            '</div>';
    }

    // Faktisk pris.
    var costRow =
        '<div class="log-route-cost">' +
          '<label>Faktisk pris</label>' +
          '<input type="number" min="0" step="1" class="log-cost-input" data-route-id="' + r.id + '"'
            + ' value="' + (r.actual_cost_dkk != null ? r.actual_cost_dkk : '') + '"'
            + ' placeholder="kr">' +
          '<button class="log-btn log-btn-ghost" data-action="save-cost" data-route-id="' + r.id + '">Gem</button>' +
        '</div>';

    return '<div class="log-route" data-route-id="' + r.id + '" data-editable="' + (isEditable ? '1' : '0') + '">' +
        '<div class="log-route-head">' +
          '<span class="log-route-title">' +
            '<span class="log-dot" style="background:' + (r.vehicle_color || _logRouteColor(r.vehicle_type)) + '"></span>' +
            _logVehicleIcon(r.vehicle_type) + ' Rute #' + r.id + ' · ' + _logEsc(r.vehicle_label || '') +
          '</span>' +
          '<span class="log-route-status log-rs-' + st.cls + '">' + st.label + '</span>' +
        '</div>' +
        '<div class="log-route-summary">' + summaryBits.join(' · ') + '</div>' +
        healthHtml +
        pickupHtml +
        courierHtml +
        (stopRows ? '<div class="log-route-stops">' + stopRows + '</div>' : '') +
        alertHtml +
        (actions.length ? '<div class="log-route-actions">' + actions.join('') + '</div>' : '') +
        bookingHtml +
        costRow +
    '</div>';
}

function _logOnRouteClick(e) {
    var openId = e.target.getAttribute('data-open-bon');
    if (openId && _logOptions.openDrawer) {
        _logOptions.openDrawer(parseInt(openId, 10));
        return;
    }
    var action = e.target.getAttribute('data-action');
    if (!action) return;
    var routeId = parseInt(e.target.getAttribute('data-route-id'), 10);

    if (action === 'rm-stop') {
        var bonId = parseInt(e.target.getAttribute('data-bon-id'), 10);
        removeDeliveryRouteStop(routeId, bonId)
            .then(function() { delete _logComputed[routeId]; _logLoad(); })
            .catch(function(err) { alert('Kunne ikke fjerne stop: ' + (err.message || 'fejl')); });
    } else if (action === 'apply') {
        // "Beregn rute" — beregner + skriver planen i ét.
        _logSetBusy(routeId, 'Beregner…');
        applyDeliveryRoute(routeId)
            .then(function(resp) { _logComputed[routeId] = resp && resp.proposal; _logLoad(); })
            .catch(function(err) { alert('Beregning fejlede: ' + (err.message || 'fejl')); _logRenderRoutes(); });
    } else if (action === 'delete-route') {
        if (!confirm('Slet tur #' + routeId + '? Leveringerne bliver ledige igen.')) return;
        deleteDeliveryRoute(routeId)
            .then(function() { delete _logComputed[routeId]; _logLoad(); })
            .catch(function(err) { alert('Kunne ikke slette: ' + (err.message || 'fejl')); });
    } else if (action === 'save-cost') {
        var input = _logContainer.querySelector('.log-cost-input[data-route-id="' + routeId + '"]');
        var amount = input ? Number(input.value) : NaN;
        if (isNaN(amount) || amount < 0) { alert('Indtast et gyldigt beløb'); return; }
        setDeliveryRouteActualCost(routeId, { amount_dkk: amount, source: 'manual' })
            .then(function() { _logLoad(); })
            .catch(function(err) { alert('Kunne ikke gemme pris: ' + (err.message || 'fejl')); });
    } else if (action === 'open-booking') {
        // Åbner Spor 1's enkelt-bon-popout pr. stop. By-expressen-bookinger
        // er per levering — typisk 1 stop, sjældent flere.
        var route = _logRouteById(routeId);
        if (!route || !route.stops || !route.stops.length) {
            alert('Ruten har ingen stop'); return;
        }
        if (typeof window.openDeliveryNote !== 'function') {
            alert('Popout-vinduet er ikke tilgængeligt'); return;
        }
        route.stops.forEach(function(s) {
            window.openDeliveryNote(s.bon_id, route.vehicle_id);
        });
    } else if (action === 'mark-booked') {
        var refInput = _logContainer.querySelector(
            '.log-booking-ref-input[data-route-id="' + routeId + '"]');
        var ref = refInput ? refInput.value.trim() : '';
        bookDeliveryRoute(routeId, { external_reference: ref || null, status: 'booked' })
            .then(function() { _logLoad(); })
            .catch(function(err) { alert('Kunne ikke markere booket: ' + (err.message || 'fejl')); });
    } else if (action === 'move-up' || action === 'move-down') {
        var mvBon = parseInt(e.target.getAttribute('data-bon-id'), 10);
        var mvRoute = _logRouteById(routeId);
        if (!mvRoute || !mvRoute.stops) return;
        var order = mvRoute.stops.slice()
            .sort(function(a, b) { return a.sequence - b.sequence; })
            .map(function(s) { return s.bon_id; });
        var i = order.indexOf(mvBon);
        var j = action === 'move-up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= order.length) return;
        order[i] = order[j];
        order[j] = mvBon;
        reorderDeliveryRouteStops(routeId, order)
            .then(function() { delete _logComputed[routeId]; _logLoad(); })
            .catch(function(err) { alert('Kunne ikke omarrangere: ' + (err.message || 'fejl')); });
    } else if (action === 'save-pickup') {
        var pInput = _logContainer.querySelector('.log-pickup-input[data-route-id="' + routeId + '"]');
        var pVal = pInput ? pInput.value.trim() : '';
        setRoutePickupTime(routeId, { pickup_time: pVal })
            .then(function() { _logLoad(); })
            .catch(function(err) { alert('Kunne ikke gemme afhentningstid: ' + (err.message || 'fejl')); });
    } else if (action === 'pickup-auto') {
        // Nulstil til auto og genberegn straks, så feltet viser den
        // baglæns-beregnede tid igen.
        setRoutePickupTime(routeId, { pickup_time: null })
            .then(function() { return applyDeliveryRoute(routeId); })
            .then(function(resp) { _logComputed[routeId] = resp && resp.proposal; _logLoad(); })
            .catch(function(err) { alert('Kunne ikke nulstille: ' + (err.message || 'fejl')); });
    }
}

// Tildel/ryd chauffør på en rute. Uden en chauffør dukker ruten ikke op
// i courier-mobilen (GET /courier/today filtrerer på courier_user_id).
function _logOnRouteChange(e) {
    var sel = e.target;
    if (!sel.classList || !sel.classList.contains('log-courier-select')) return;
    var routeId = parseInt(sel.getAttribute('data-route-id'), 10);
    var val = sel.value ? parseInt(sel.value, 10) : null;
    updateDeliveryRoute(routeId, { courier_user_id: val })
        .then(function() { _logLoad(); })
        .catch(function(err) { alert('Kunne ikke tildele chauffør: ' + (err.message || 'fejl')); });
}

function _logSetBusy(routeId, text) {
    var card = _logContainer.querySelector('.log-route[data-route-id="' + routeId + '"] .log-route-actions');
    if (card) card.innerHTML = '<span class="log-busy">' + text + '</span>';
}

/* ── Leaflet-kort ──────────────────────────────────────── */
function _logInitMap() {
    if (typeof L === 'undefined') return;          // Leaflet ikke loadet
    var el = document.getElementById('logMap');
    if (!el) return;
    _logMap = L.map(el, { zoomControl: true }).setView([55.69, 12.56], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(_logMap);
    _logMarkerLayer = L.layerGroup().addTo(_logMap);
    _logRouteLayer = L.layerGroup().addTo(_logMap);
    // Kortet rendres i et nyligt indsat element — invalidér størrelsen.
    setTimeout(function() { if (_logMap) _logMap.invalidateSize(); }, 150);
}

function _logHqIcon() {
    return L.divIcon({
        className: 'log-mk',
        html: '<div class="log-mk-hq">🏠</div>',
        iconSize: [26, 26], iconAnchor: [13, 13]
    });
}
function _logBonIcon(color, label) {
    var bg = color || '#9a948c';   // neutral grå når bonen ikke er på en rute
    return L.divIcon({
        className: 'log-mk',
        html: '<div class="log-mk-pin" style="background:' + bg + '">' + (label || '') + '</div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
    });
}
// Fallback-farve hvis en vogn mangler color i DB.
function _logRouteColor(type) {
    return type === 'volvo' ? '#8e631f'
        : type === 'taxi' ? '#4a8a3a'
        : '#2d6da3';
}
function _logRouteById(routeId) {
    return (_logData.routes || []).find(function(x) { return x.id === routeId; });
}
function _logRouteColorById(routeId) {
    var r = _logRouteById(routeId);
    return r ? (r.vehicle_color || _logRouteColor(r.vehicle_type)) : null;
}

// Legende — viser aktive vogne med farve + ikon (som Bon v1).
function _logBuildLegend() {
    if (!_logMap || typeof L === 'undefined' || !L.control) return;
    if (_logLegendCtl) { try { _logMap.removeControl(_logLegendCtl); } catch (e) {} _logLegendCtl = null; }
    if (!_logVehicles.length) return;
    var ctl = L.control({ position: 'topright' });
    ctl.onAdd = function() {
        var div = L.DomUtil.create('div', 'log-legend');
        div.innerHTML = '<div class="log-legend-title">Vogne</div>' +
            _logVehicles.map(function(v) {
                return '<div class="log-legend-row">' +
                    '<span class="log-legend-swatch" style="background:' +
                        (v.color || '#9a948c') + '"></span>' +
                    '<span>' + _logVehicleIcon(v.type) + ' ' + _logEsc(v.label) + '</span>' +
                '</div>';
            }).join('');
        return div;
    };
    ctl.addTo(_logMap);
    _logLegendCtl = ctl;
}

function _logRenderMap() {
    if (!_logMap || !_logMarkerLayer) return;
    _logMarkerLayer.clearLayers();
    _logRouteLayer.clearLayers();

    var bounds = [];

    var hq = _logData.hq;
    if (hq && hq.lat != null && hq.lon != null) {
        L.marker([hq.lat, hq.lon], { icon: _logHqIcon() })
            .bindTooltip('HQ — Ristet Rug')
            .addTo(_logMarkerLayer);
        bounds.push([hq.lat, hq.lon]);
    }

    _logMarkers = {};
    (_logData.bons || []).forEach(function(b) {
        if (b.lat == null || b.lon == null) return;
        var onRoute = !!b.on_route_id;
        var seq = (onRoute && b.route_sequence) ? String(b.route_sequence) : '';
        var color = _logBonMarkerColor(b);
        var m = L.marker([b.lat, b.lon], { icon: _logBonIcon(color, seq) });
        var name = b.company_name || b.customer_name || ('Bon #' + b.id);
        m.bindTooltip((b.delivery_time ? b.delivery_time + ' · ' : '') + name);
        m.on('click', function() {
            if (_logOptions.openDrawer) _logOptions.openDrawer(b.id);
        });
        m.on('mouseover', function() { _logHighlightBonRow(b.id, true); });
        m.on('mouseout',  function() { _logHighlightBonRow(b.id, false); });
        m.addTo(_logMarkerLayer);
        _logMarkers[b.id] = m;
        bounds.push([b.lat, b.lon]);
    });

    // Rute-polylinjer (anvendt geometri fra DB eller netop beregnet forslag).
    (_logData.routes || []).forEach(function(r) {
        if (r.status === 'cancelled') return;
        var geo = (_logComputed[r.id] && _logComputed[r.id].geometry_geojson) || r.route_geojson;
        if (!geo) return;
        L.geoJSON(geo, {
            style: { color: r.vehicle_color || _logRouteColor(r.vehicle_type), weight: 4, opacity: 0.7 }
        }).addTo(_logRouteLayer);
    });

    if (bounds.length) {
        _logMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
    }
}
