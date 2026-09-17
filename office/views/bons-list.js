/**
 * office/views/bons-list.js
 * ════════════════════════════════════════════════════════════
 * Office listview — primær indgang til alle bonner.
 *
 * API:
 *   initBonsList(containerEl, { openDrawer, openNewBon })
 *
 * Afhængigheder (load order):
 *   shared/utils.js  → statusToFrontend, formatDanishDate, esc, connectSSE
 *   shared/api.js    → fetchBons
 *   BonConfig.js     → BON_CONFIG.statuses
 * ════════════════════════════════════════════════════════════
 */

/* ── State ──────────────────────────────────────────────── */

var _blContainer = null;
var _blOptions   = {};
var _blBons      = [];
var _blFilter    = 'today';   // 'today' | 'ny' | 'mail' | 'date' | 'all'
var _blDateValue = '';        // YYYY-MM-DD for date filter
var _blSearch    = '';
var _blDebounceTimer = null;
var _blLastFilter = null;     // sidste loadede filter — bruges til standardsortering ved filterskift

var _blSort = JSON.parse(localStorage.getItem('office_listview_sort') || '{}');
if (!_blSort.col) { _blSort = { col: 'delivery_time', dir: 'asc' }; }

var _blColumns = JSON.parse(localStorage.getItem('office_listview_columns') || 'null') || {
    customer: true,
    company: true,
    // Slutkunde er default FRA: den er kun udfyldt på forhandler-ordrer, og en
    // altid-synlig kolonne ville give alle andre en tom spalte. Gemte
    // kolonne-valg mangler nøglen og læses som false — ingen ændring for dem
    // der allerede har en indstilling liggende.
    end_customer: false,
    pax: true,
    phone: false,
    email: false,
    courier: true,
    handover: false,
    mail: true,
    price_cat: false,
    payment: false,
    delivery_type: false,
    total_price: false,
};

var _blStaffData = null; // Smartplan shifts for single-day views

/* ── Column definitions ─────────────────────────────────── */

var BL_COLUMN_DEFS = {
    // Fixed columns are rendered separately
    customer:        { label: 'Kunde',          sortKey: 'customer_name' },
    company:         { label: 'Firma',          sortKey: 'company_name' },
    end_customer:    { label: 'Slutkunde',      sortKey: null },
    pax:             { label: 'Pax / Enh.',     sortKey: 'pax',                  align: 'right' },
    phone:           { label: 'Telefon',        sortKey: null },
    email:           { label: 'Email',          sortKey: null },
    courier:         { label: 'Bud',            sortKey: 'courier_arrival_time' },
    handover:        { label: 'Afleveret',      sortKey: null },
    mail:            { label: '\u2709 Mail',    sortKey: null },
    price_cat:       { label: 'Priskategori',   sortKey: null },
    payment:         { label: 'Betaling',       sortKey: null },
    delivery_type:   { label: 'Leveringstype',  sortKey: null },
    total_price:     { label: 'Total pris',     sortKey: 'total_price' },
};

/* Leveringsmetode-ikoner — hardcoded foreløbig, flyttes til settings senere */
var BL_DELIVERY_ICONS = new Proxy({}, {
    get: function(_t, method) {
        if (!window.DeliveryIcons) return undefined;
        return window.DeliveryIcons.get(method) || window.DeliveryIcons.defaults[method];
    },
});

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */

function initBonsList(containerEl, options) {
    _blContainer = containerEl;
    _blOptions   = options || {};
    _renderBonsListShell();

    // Honor ?filter=&date=&q= so other views (fx dashboard) kan dybe-linke ind
    var params = new URLSearchParams(window.location.search);
    var filter = params.get('filter');
    var date   = params.get('date');
    var q      = params.get('q');
    if (q) {
        _blSearch = q;
        _blFilter = 'search';
        var si = document.getElementById('blSearch');
        if (si) si.value = q;
    } else if (filter === 'date' && date) {
        _blFilter = 'date';
        _blDateValue = date;
        var di = document.getElementById('blDateInput');
        if (di) di.value = date;
    } else if (filter && ['today','ny','mail','open','all','giveaway','nofaktura'].indexOf(filter) >= 0) {
        _blFilter = filter;
    }

    _blLoadData();
}

// Eksternt entry-point — andre views kan navigere ind med fx
//   setBonsListFilter('date', { date: '2026-04-30' })
function setBonsListFilter(filterKey, opts) {
    if (!_blContainer) return;
    opts = opts || {};
    _blSearch = '';
    var si = document.getElementById('blSearch');
    if (si) si.value = '';

    if (filterKey === 'date' && opts.date) {
        _blFilter = 'date';
        _blDateValue = opts.date;
        var di = document.getElementById('blDateInput');
        if (di) di.value = opts.date;
    } else {
        _blFilter = filterKey;
        _blDateValue = '';
        var di2 = document.getElementById('blDateInput');
        if (di2) di2.value = '';
    }
    _blUpdateFilterButtons();
    _blLoadData();
}
window.setBonsListFilter = setBonsListFilter;

/* ══════════════════════════════════════════════════════════════
   SHELL
   ══════════════════════════════════════════════════════════════ */

function _renderBonsListShell() {
    _blContainer.innerHTML = '';

    // ── Toolbar ──
    var toolbar = document.createElement('div');
    toolbar.className = 'bl-toolbar';

    // Search
    var searchWrap = document.createElement('div');
    searchWrap.className = 'bl-search-wrap';
    searchWrap.innerHTML = '<input type="text" class="bl-search" placeholder="S\u00F8g bon#, navn, firma..." id="blSearch">';
    toolbar.appendChild(searchWrap);

    // Right side: columns + new bon
    var right = document.createElement('div');
    right.className = 'bl-toolbar-right';

    // Column chooser
    var colBtn = document.createElement('div');
    colBtn.className = 'bl-col-chooser';
    colBtn.innerHTML = '<button class="bl-col-btn" id="blColBtn">Kolonner \u25BE</button>'
        + '<div class="bl-col-dropdown" id="blColDropdown"></div>';
    right.appendChild(colBtn);

    // New bon button
    if (_blOptions.openNewBon) {
        var nyBtn = document.createElement('button');
        nyBtn.className = 'bl-ny-btn';
        nyBtn.textContent = '+ Ny bon';
        nyBtn.addEventListener('click', function() { _blOptions.openNewBon(); });
        right.appendChild(nyBtn);
    }

    toolbar.appendChild(right);
    _blContainer.appendChild(toolbar);

    // ── Filter bar ──
    var filterBar = document.createElement('div');
    filterBar.className = 'bl-filters';
    filterBar.id = 'blFilters';

    var filters = [
        { key: 'today',    label: 'I DAG' },
        { key: 'ny',       label: 'NY' },
        { key: 'mail',     label: 'UL\u00C6ST MAIL' },
        { key: 'giveaway', label: 'SPONSORAT/MODREGN.' },
        { key: 'nofaktura', label: '⚠ MANGLER I E-CONOMIC' },
    ];
    for (var i = 0; i < filters.length; i++) {
        var btn = document.createElement('button');
        btn.className = 'bl-filter-btn';
        btn.dataset.filter = filters[i].key;
        btn.textContent = filters[i].label;
        // Tæller-badge på ULÆST MAIL — fyldes af det globale nav-badge-system
        // (data-badge="bons_ulaest_mail"). Gør indkommende mail synlig uden at
        // man først skal klikke filteret.
        if (filters[i].key === 'mail') {
            var mailBadge = document.createElement('span');
            mailBadge.className = 'bl-filter-badge';
            mailBadge.dataset.badge = 'bons_ulaest_mail';
            mailBadge.style.display = 'none';
            btn.appendChild(document.createTextNode(' '));
            btn.appendChild(mailBadge);
        }
        btn.addEventListener('click', _blOnFilterClick);
        filterBar.appendChild(btn);
    }

    // Date picker
    var dateWrap = document.createElement('span');
    dateWrap.className = 'bl-date-wrap';
    dateWrap.innerHTML = '<label>Dato:</label><input type="date" class="bl-date-input" id="blDateInput">';
    filterBar.appendChild(dateWrap);

    // All
    var allBtn = document.createElement('button');
    allBtn.className = 'bl-filter-btn';
    allBtn.dataset.filter = 'all';
    allBtn.textContent = 'Alle';
    allBtn.addEventListener('click', _blOnFilterClick);
    filterBar.appendChild(allBtn);

    _blContainer.appendChild(filterBar);

    // ── Summary line ──
    var summary = document.createElement('div');
    summary.className = 'bl-summary';
    summary.id = 'blSummary';
    _blContainer.appendChild(summary);

    // ── Table ──
    var tableWrap = document.createElement('div');
    tableWrap.className = 'bl-table-wrap';
    tableWrap.innerHTML = '<table class="bl-table" id="blTable"><thead></thead><tbody></tbody></table>';
    _blContainer.appendChild(tableWrap);

    // ── Wire events ──
    var searchInput = document.getElementById('blSearch');
    searchInput.addEventListener('input', function() {
        clearTimeout(_blDebounceTimer);
        var val = this.value;
        _blDebounceTimer = setTimeout(function() {
            _blSearch = val;
            if (_blSearch.length >= 1) {
                _blFilter = 'search';
                _blLoadData();
            } else if (_blSearch.length === 0) {
                _blFilter = 'today';
                _blLoadData();
            }
        }, 300);
    });
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            this.value = '';
            _blSearch = '';
            _blFilter = 'today';
            _blLoadData();
        }
    });

    document.getElementById('blDateInput').addEventListener('change', function() {
        if (this.value) {
            _blDateValue = this.value;
            _blFilter = 'date';
            _blSearch = '';
            document.getElementById('blSearch').value = '';
            _blLoadData();
        }
    });

    // Column chooser
    _blBuildColumnDropdown();
    document.getElementById('blColBtn').addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById('blColDropdown').classList.toggle('open');
    });
    document.addEventListener('click', function(e) {
        var dd = document.getElementById('blColDropdown');
        if (dd && clickedOutside(e, dd) && e.target.id !== 'blColBtn') {
            dd.classList.remove('open');
        }
    });

    _blUpdateFilterButtons();

    // Få det globale nav-badge-system til at fylde mail-tælleren på ULÆST MAIL-
    // knappen (viewet mountes efter den initiale badge-load, så DOM'en var tom da).
    if (typeof window.loadNavBadges === 'function') window.loadNavBadges();
}

// Status-sub-tekst: "leveret 09:42" / "i gang 10:15 · 22 min" / "klar 10:31 · 6 min"
// Vises under status-badgen i status-kolonnen. NY har intet skift endnu → returnerer "".
function _blFormatStatusTime(bon) {
    if (!bon || !bon.latest_status_change_time) return '';
    var dt = parseServerDate(bon.latest_status_change_time);
    if (!dt || isNaN(dt.getTime())) return '';
    var hh = String(dt.getHours()).padStart(2, '0');
    var mm = String(dt.getMinutes()).padStart(2, '0');
    var timeStr = hh + ':' + mm;

    // Vis kun datodel hvis ikke i dag (sjælden — listen viser typisk dagens bons,
    // men bons under andre filtre kan have ældre status-skift).
    var today = new Date();
    var sameDay = dt.getFullYear() === today.getFullYear()
        && dt.getMonth() === today.getMonth()
        && dt.getDate() === today.getDate();
    if (!sameDay) {
        var dd = String(dt.getDate()).padStart(2, '0');
        var mo = String(dt.getMonth() + 1).padStart(2, '0');
        timeStr = dd + '/' + mo + ' ' + hh + ':' + mm;
    }

    // Prefix-ord pr. status. Terminal-statusser (FAKTURERET/BETALT/AFSLUTTET) er alle
    // post-levering → vis "leveret HH:MM" (det er det kunden spørger om).
    var code = bon.status_code;
    var prefix;
    switch (code) {
        case 'LEVERET':
        case 'FAKTURERET':
        case 'BETALT':
        case 'AFSLUTTET':
            prefix = 'leveret'; break;
        case 'KLAR':     prefix = 'klar';     break;
        case 'IGANG':    prefix = 'i gang';   break;
        case 'GODKENDT': prefix = 'godkendt'; break;
        case 'VENTER':   prefix = 'venter siden'; break;
        case 'AFLYST':   prefix = 'aflyst';   break;
        case 'NY':       return ''; // intet "skift" sket — pillen taler for sig selv
        default:         prefix = (bon.status_label || code || '').toLowerCase();
    }

    // For aktivt arbejde (IGANG/KLAR): tilføj "· N min" så office kan se varigheden af spurten.
    var result = prefix + ' ' + timeStr;
    if (sameDay && (code === 'IGANG' || code === 'KLAR')) {
        var elapsedMin = Math.floor((today.getTime() - dt.getTime()) / 60000);
        if (elapsedMin >= 1 && elapsedMin < 24 * 60) {
            result += ' · ' + elapsedMin + ' min';
        }
    }
    return result;
}

// Format delivery_events timestamp som HH:MM hvis i dag, ellers "dd/MM HH:MM"
function _blFormatHandover(iso) {
    if (!iso) return '';
    // delivery_events.event_time er UTC (CURRENT_TIMESTAMP) — parseServerDate
    // tilføjer 'Z' så klokkeslættet ikke vises 1-2 timer forskudt.
    var dt = (typeof parseServerDate === 'function') ? parseServerDate(iso) : new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(dt.getTime())) return iso;
    var today = new Date();
    var sameDay = dt.getFullYear() === today.getFullYear() && dt.getMonth() === today.getMonth() && dt.getDate() === today.getDate();
    var hh = String(dt.getHours()).padStart(2, '0');
    var mm = String(dt.getMinutes()).padStart(2, '0');
    if (sameDay) return hh + ':' + mm;
    var dd = String(dt.getDate()).padStart(2, '0');
    var mo = String(dt.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mo + ' ' + hh + ':' + mm;
}

function _blBuildColumnDropdown() {
    var dd = document.getElementById('blColDropdown');
    if (!dd) return;
    dd.innerHTML = '';
    for (var key in BL_COLUMN_DEFS) {
        if (!BL_COLUMN_DEFS.hasOwnProperty(key)) continue;
        var label = BL_COLUMN_DEFS[key].label;
        var item = document.createElement('label');
        item.className = 'bl-col-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!_blColumns[key];
        cb.dataset.col = key;
        cb.addEventListener('change', function() {
            _blColumns[this.dataset.col] = this.checked;
            localStorage.setItem('office_listview_columns', JSON.stringify(_blColumns));
            _blRenderTable();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(' ' + label));
        dd.appendChild(item);
    }
}

/* ══════════════════════════════════════════════════════════════
   FILTER HANDLING
   ══════════════════════════════════════════════════════════════ */

function _blOnFilterClick(e) {
    var key = e.currentTarget.dataset.filter;
    _blFilter = key;
    _blSearch = '';
    document.getElementById('blSearch').value = '';
    if (key !== 'date') {
        document.getElementById('blDateInput').value = '';
        _blDateValue = '';
    }
    _blUpdateFilterButtons();
    _blLoadData();
}

function _blUpdateFilterButtons() {
    if (!_blContainer) return;
    var btns = _blContainer.querySelectorAll('.bl-filter-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.filter === _blFilter);
    }
}

/* ══════════════════════════════════════════════════════════════
   DATA LOADING
   ══════════════════════════════════════════════════════════════ */

function _blLoadData() {
    var params = {};

    // NY-filteret åbnes sorteret efter leveringsdato (hvornår bonnen skal
    // leveres). Sættes kun ved selve filterskiftet, så kolonne-klik bagefter
    // stadig kan ændre sorteringen frit.
    if (_blFilter === 'ny' && _blLastFilter !== 'ny') {
        _blSort = { col: 'delivery_date', dir: 'asc' };
        localStorage.setItem('office_listview_sort', JSON.stringify(_blSort));
    }
    // Manglende faktura: ældste først — de gamle haster mest, og listen ryddes bagfra.
    if (_blFilter === 'nofaktura' && _blLastFilter !== 'nofaktura') {
        _blSort = { col: 'delivery_date', dir: 'asc' };
        localStorage.setItem('office_listview_sort', JSON.stringify(_blSort));
    }
    _blLastFilter = _blFilter;

    switch (_blFilter) {
        case 'today':
            params.date = 'today';
            break;
        case 'ny':
            params.status = 'NY';
            break;
        case 'open':
            params.status = 'NY,VENTER,GODKENDT,IGANG,KLAR';
            break;
        case 'mail':
            params.unread_mail = '1';
            break;
        case 'giveaway':
            // Modregning + sponsorat — ikke omsætning, men findbare (alle datoer)
            params.payment_type = 'barter,sponsorship';
            break;
        case 'nofaktura':
            // Fakturavagt (#319): markeret faktureret uden at der findes en faktura.
            // Alle datoer — arbejdslisten skal kunne ryddes bagfra. Ældste først,
            // for de gamle er dem der haster (og som forsvinder når de rettes).
            params.missing_invoice = '1';
            break;
        case 'date':
            params.date = _blDateValue;
            break;
        case 'all':
            // Seneste 90 dage
            params.date_from = offsetISO(-90);
            break;
        case 'search':
            params.q = _blSearch;
            break;
    }

    params.sort = _blSort.col;
    params.dir = _blSort.dir;
    params.limit = '200';

    _blUpdateFilterButtons();

    // Determine if single-day view for Smartplan
    var isSingleDay = (_blFilter === 'today' || _blFilter === 'date');
    var dateForStaff = null;
    if (isSingleDay) {
        dateForStaff = (_blFilter === 'today') ? todayISO() : _blDateValue;
    }

    fetchBons(params).then(function(rows) {
        _blBons = rows;
        _blRenderTable();
        _blRenderSummary();

        // Fetch Smartplan for single-day views (async, non-blocking)
        if (isSingleDay && dateForStaff && typeof fetchSmartplanShifts === 'function') {
            _blStaffData = null;
            fetchSmartplanShifts(dateForStaff, dateForStaff)
                .then(function(shifts) {
                    _blStaffData = shifts;
                    _blRenderSummary();
                })
                .catch(function() { /* Smartplan ikke tilgængelig */ });
        } else {
            _blStaffData = null;
        }
    }).catch(function(err) {
        console.error('Listview fejl:', err);
    });
}

/* ══════════════════════════════════════════════════════════════
   SUMMARY
   ══════════════════════════════════════════════════════════════ */

// Mærket der siger at bonen kom fra et booket møde (smagsprøve).
//
// Uden det ligner den en helt almindelig ordre i listen: forklaringen
// ("standard smagsprøve") står i Køkken info, som listen ikke viser.
// Mødetypens EGET navn, ikke et hårdkodet ord — så er mærket sandt den dag
// en anden type også begynder at give en bon.
//
// Egen funktion frem for inline i rækkebygningen, så den kan efterprøves:
// en grep på filen kan ikke se forskel på levende og død kode.
function _blBookingChip(bon) {
    if (!bon || !bon.booking_meeting_label) return '';
    var navn = esc(bon.booking_meeting_label);
    return '<br><span class="bl-booking-chip" title="Oprettet automatisk fra en booket '
        + navn.toLowerCase() + ' \u2014 indholdet st\u00E5r i K\u00F8kken info p\u00E5 bonen">'
        + (bon.booking_meeting_emoji ? esc(bon.booking_meeting_emoji) + ' ' : '')
        + navn + '</span>';
}

function _blRenderSummary() {
    var el = document.getElementById('blSummary');
    if (!el) return;

    // Vis for dato-baserede views + NY-filteret
    if (_blFilter !== 'today' && _blFilter !== 'date' && _blFilter !== 'ny') {
        el.style.display = 'none';
        return;
    }

    // ── NY-filteret: tæl bonner + udskil ubekræftede web-bestillinger ──
    // "NY" er et statusfilter (alle status-NY bonner uanset kilde). Badgen
    // "Ubekræftede" tæller derimod kun web-bestillinger ingen har bekræftet.
    // Linjen her viser relationen så de to tal ikke ser modstridende ud.
    if (_blFilter === 'ny') {
        var nyCount = _blBons.length;
        var webCount = 0;
        for (var k = 0; k < _blBons.length; k++) {
            if (_blBons[k].is_unconfirmed_web) webCount++;
        }
        var nyHtml = '<span>' + nyCount + ' NY-bon' + (nyCount !== 1 ? 'ner' : '') + '</span>';
        if (webCount > 0) {
            nyHtml += ' <span class="bl-summary-web" title="Web-bestillinger som ingen endnu har trykket'
                + ' &quot;Bekræft modtaget&quot; på. Resten er manuelt oprettede eller allerede bekræftede.">'
                + '· heraf 🌐 ' + webCount + ' ubekræftede web-bestillinger</span>';
        }
        el.innerHTML = nyHtml;
        el.style.display = '';
        return;
    }

    // Workload (= enh. hvis sat, ellers pax — per bon). Ekskl. AFLYST + tilbud.
    // Matcher v1's "Total" og undgår dobbelttælling af bons med både pax og enh.
    var workload = 0, count = 0;
    for (var i = 0; i < _blBons.length; i++) {
        var b = _blBons[i];
        if (b.is_offer || b.status_code === 'AFLYST') continue;
        // Festival-salgsbons (event_role='sales') + udgifter tæller ikke som produktion
        // (allerede talt i prep-bonnen) — undgår dobbelttælling i belastningsoverblikket.
        if (b.event_role === 'sales' || b.event_role === 'expense') continue;
        var pax = b.pax || 0;
        var units = b.total_units || 0;
        workload += units > 0 ? units : pax;
        count++;
    }

    // Date label
    var dateLabel = '';
    if (_blFilter === 'today') {
        dateLabel = 'I dag';
    } else if (_blDateValue) {
        dateLabel = formatDanishDate(_blDateValue);
    }

    var parts = [dateLabel];
    parts.push(count + ' bon' + (count !== 1 ? 'ner' : ''));
    if (workload > 0) parts.push(workload + ' enheder');

    var html = '<span>' + esc(parts.join(' \u00B7 ')) + '</span>';

    // Smartplan bemanding
    if (_blStaffData && _blStaffData.length > 0) {
        var lines = [];
        for (var s = 0; s < _blStaffData.length; s++) {
            var shift = _blStaffData[s];
            var firstName = (shift.employee_name || '').split(' ')[0];
            lines.push(shift.start_time + '\u2013' + shift.end_time + '  ' + firstName);
        }
        html += ' <span class="bl-staff-badge" title="' + esc(lines.join('\n')) + '">'
            + '\uD83D\uDC64 ' + _blStaffData.length + ' bemanding</span>';
    }

    el.innerHTML = html;
    el.style.display = '';
}

/* ══════════════════════════════════════════════════════════════
   TABLE RENDERING
   ══════════════════════════════════════════════════════════════ */

function _blRenderTable() {
    var table = document.getElementById('blTable');
    if (!table) return;

    var thead = table.querySelector('thead');
    var tbody = table.querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    // Visible optional columns (filter out unknown keys from old localStorage)
    var visCols = [];
    for (var key in _blColumns) {
        if (_blColumns[key] && BL_COLUMN_DEFS[key]) visCols.push(key);
    }

    // ── Header ──
    var hRow = document.createElement('tr');

    // Fixed: Bon#
    _blAddTh(hRow, 'Bon#', 'bon_number');
    // Fixed: Dato + Tid
    _blAddTh(hRow, 'Dato', 'delivery_date');
    _blAddTh(hRow, 'Tid', 'delivery_time');
    // Fixed: Status
    _blAddTh(hRow, 'Status', 'status');

    // Optional columns
    for (var c = 0; c < visCols.length; c++) {
        var def = BL_COLUMN_DEFS[visCols[c]];
        _blAddTh(hRow, def.label, def.sortKey, def.align);
    }

    thead.appendChild(hRow);

    // ── Body ──
    var todayStr = todayISO();

    for (var r = 0; r < _blBons.length; r++) {
        var bon = _blBons[r];
        var feStatus = statusToFrontend(bon.status_code);
        var statusCfg = BON_CONFIG.statuses[feStatus] || {};
        var isProduction = bon.price_category_code === 'produktion';

        // ── Row 1 ──
        var tr1 = document.createElement('tr');
        tr1.className = 'bl-row bl-row-main';
        tr1.dataset.bonId = bon.id;
        if (isProduction) tr1.classList.add('bl-production');

        // Bon#
        var tdBon = document.createElement('td');
        tdBon.className = 'bl-td-bon';
        tdBon.setAttribute('rowspan', '2');
        tdBon.innerHTML = '<span class="bl-bon-number">' + esc(bon.bon_number) + '</span>'
            + (isProduction ? ' <span class="bl-prod-icon">\uD83D\uDD27</span>' : '')
            + (bon.is_unconfirmed_web
                ? '<br><span class="bl-web-chip" title="Ubekr\u00E6ftet web-bestilling \u2014 \u00E5bn bonnen og tryk \u00ABBekr\u00E6ft modtaget\u00BB">\uD83C\uDF10 ubekr\u00E6ftet</span>'
                : '')
            + _blBookingChip(bon);
        tr1.appendChild(tdBon);

        // Dato
        var tdDate = document.createElement('td');
        tdDate.className = 'bl-td-date';
        if (bon.delivery_date === todayStr) {
            tdDate.textContent = 'i dag';
            tdDate.classList.add('bl-today');
        } else {
            tdDate.textContent = formatDanishDate(bon.delivery_date);
        }
        tr1.appendChild(tdDate);

        // Tid
        var tdTime = document.createElement('td');
        tdTime.className = 'bl-td-time';
        tdTime.textContent = bon.pickup_time || bon.delivery_time || '';
        tr1.appendChild(tdTime);

        // Status — badge + tidspunkt for seneste status-skift + historik-knap
        var tdStatus = document.createElement('td');
        tdStatus.className = 'bl-td-status';
        tdStatus.setAttribute('rowspan', '2');

        var statusInner = '<div class="bl-status-cell">'
            + '<span class="bl-status-badge" style="background:'
            + (statusCfg.color || '#999') + ';color:' + (statusCfg.text || '#fff') + '">'
            + esc(statusCfg.label || bon.status_code) + '</span>';

        var statusTime = _blFormatStatusTime(bon);
        if (statusTime) {
            statusInner += '<span class="bl-status-time">' + esc(statusTime) + '</span>';
        }

        // Fakturavagt (#319): markeret faktureret, men ingen faktura findes.
        // Udledt af serveren — forsvinder af sig selv når kladden dukker op.
        //
        // Teksten siger bevidst HVOR fakturaen mangler. "ingen faktura" lige ved
        // siden af statusbadgen FAKTURERET læses som en selvmodsigelse ved første
        // øjekast — og så bruger man et halvt minut på at regne ud hvad der menes,
        // hver gang. Statussen er hvad nogen har trykket; mærket er hvad der rent
        // faktisk ligger i regnskabet.
        if (bon.missing_invoice) {
            statusInner += '<span class="bl-missing-invoice"'
                + ' title="Markeret faktureret, men der findes hverken e-conomic-kladde'
                + ' eller bogført faktura — kunden har ikke fået en regning">'
                + '⚠ mangler i e-conomic</span>';
        }

        statusInner += '<button type="button" class="bl-history-btn"'
            + ' data-bon-id="' + bon.id + '"'
            + ' data-bon-number="' + esc(bon.bon_number) + '"'
            + ' title="Vis historik">⏱</button>';
        statusInner += '</div>';

        tdStatus.innerHTML = statusInner;
        tr1.appendChild(tdStatus);

        // Historik-knap: stopPropagation så row-klikket ikke åbner drawer samtidig
        var historyBtn = tdStatus.querySelector('.bl-history-btn');
        if (historyBtn) {
            historyBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (typeof showHistorik === 'function') {
                    showHistorik({ bonId: this.dataset.bonId, bonNumber: this.dataset.bonNumber });
                }
            });
        }

        // Optional columns — row 1
        for (var c1 = 0; c1 < visCols.length; c1++) {
            var td1 = document.createElement('td');
            td1.className = 'bl-td-opt';
            switch (visCols[c1]) {
                case 'customer':
                    var name = (bon.contact_name_full || '').trim();
                    td1.innerHTML = esc(name);
                    if (bon.unread_mail_count > 0) {
                        td1.innerHTML += ' <span class="bl-mail-icon">\u2709'
                            + (bon.unread_mail_count > 1 ? bon.unread_mail_count : '') + '</span>';
                    }
                    if (bon.flag_count > 0) {
                        var pluralFlag = bon.flag_count === 1 ? 'p\u00e5mindelse' : 'p\u00e5mindelser';
                        td1.innerHTML += ' <span class="bl-flag-badge" data-bon-id="'
                            + bon.id + '" title="' + bon.flag_count + ' '
                            + pluralFlag + ' p\u00e5 kunden">\ud83d\udea9'
                            + (bon.flag_count > 1 ? bon.flag_count : '') + '</span>';
                    }
                    break;
                case 'company':
                    // Forhandler-ordre: vis begge dele, så det er tydeligt at
                    // firmaet er den der betaler og ikke den maden er til.
                    // Kun når slutkunden findes — alle andre rækker er uændrede.
                    td1.textContent = bon.company_name || '';
                    if (bon.end_customer_name) {
                        td1.textContent += ' → ' + bon.end_customer_name;
                        td1.title = (bon.company_name || '') + ' bestiller for ' + bon.end_customer_name;
                    }
                    td1.classList.add('bl-td-dim');
                    break;
                case 'end_customer':
                    td1.textContent = bon.end_customer_name || '';
                    td1.classList.add('bl-td-dim');
                    break;
                case 'pax':
                    var paxParts = [];
                    if (bon.pax) paxParts.push(bon.pax);
                    if (bon.total_units) paxParts.push(bon.total_units + ' enh.');
                    td1.textContent = paxParts.join(' / ');
                    td1.classList.add('bl-td-num');
                    break;
                case 'phone':
                    td1.textContent = bon.customer_phone || '';
                    td1.classList.add('bl-td-dim');
                    break;
                case 'email':
                    td1.textContent = bon.customer_email || '';
                    td1.classList.add('bl-td-dim');
                    break;
                case 'courier':
                    var cmParts = [];
                    var cmDm = BL_DELIVERY_ICONS[bon.delivery_method];
                    if (cmDm) {
                        cmParts.push('<span title="' + esc(cmDm.label) + '">' + cmDm.icon + '</span>');
                    }
                    if (bon.courier_arrival_time) {
                        cmParts.push('<span class="bl-td-dim">' + esc(bon.courier_arrival_time) + '</span>');
                    }
                    td1.innerHTML = cmParts.join(' ');
                    break;
                case 'handover':
                    if (bon.latest_delivery_event_time) {
                        var hoTime = _blFormatHandover(bon.latest_delivery_event_time);
                        td1.innerHTML = '<span title="' + esc(bon.latest_delivery_event || 'event') + ': ' + esc(bon.latest_delivery_event_time) + '">' + esc(hoTime) + '</span>';
                        td1.classList.add('bl-td-dim');
                    }
                    break;
                case 'mail':
                    if (bon.unread_mail_count > 0) {
                        td1.innerHTML = '<span class="bl-mail-badge">\u2709 ' + bon.unread_mail_count + '</span>';
                    }
                    break;
                case 'price_cat':
                    td1.textContent = bon.price_category_label || '';
                    break;
                case 'payment':
                    td1.textContent = bon.payment_type || '';
                    break;
                case 'delivery_type':
                    td1.textContent = bon.delivery_type || '';
                    break;
                case 'total_price':
                    td1.textContent = bon.total_price ? bon.total_price.toLocaleString('da-DK') + ' kr' : '';
                    td1.classList.add('bl-td-num');
                    break;
            }
            tr1.appendChild(td1);
        }

        // Click handler
        (function(bonId) {
            tr1.addEventListener('click', function() {
                if (_blOptions.openDrawer) _blOptions.openDrawer(bonId);
            });
        })(bon.id);

        // Flag-badge: åbner drawer med expandFlags=true (stopPropagation så row-klikket ikke fires)
        var flagBadge = tr1.querySelector('.bl-flag-badge');
        if (flagBadge) {
            (function(bonId) {
                flagBadge.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (_blOptions.openDrawer) _blOptions.openDrawer(bonId, { expandFlags: true });
                });
            })(bon.id);
        }

        tbody.appendChild(tr1);

        // ── Row 2 (sub-row) ──
        var tr2 = document.createElement('tr');
        tr2.className = 'bl-row bl-row-sub';
        tr2.dataset.bonId = bon.id;

        // Dato + Tid cells empty (bon# and status have rowspan)
        var tdEmpty1 = document.createElement('td');
        tr2.appendChild(tdEmpty1);
        var tdEmpty2 = document.createElement('td');
        tr2.appendChild(tdEmpty2);

        // Optional columns — row 2 (show company under customer, courier under others)
        for (var c2 = 0; c2 < visCols.length; c2++) {
            var td2 = document.createElement('td');
            td2.className = 'bl-td-opt bl-td-dim';
            switch (visCols[c2]) {
                case 'customer':
                    td2.textContent = bon.company_name || '';
                    break;
                case 'courier':
                    // Show courier in sub-row if not already visible
                    break;
                default:
                    // Empty
                    break;
            }
            tr2.appendChild(td2);
        }

        (function(bonId) {
            tr2.addEventListener('click', function() {
                if (_blOptions.openDrawer) _blOptions.openDrawer(bonId);
            });
        })(bon.id);

        tbody.appendChild(tr2);
    }

    // Empty state
    if (_blBons.length === 0) {
        var emptyTr = document.createElement('tr');
        var emptyTd = document.createElement('td');
        emptyTd.colSpan = 4 + visCols.length;
        emptyTd.className = 'bl-empty';
        emptyTd.textContent = 'Ingen bonner fundet.';
        emptyTr.appendChild(emptyTd);
        tbody.appendChild(emptyTr);
    }
}

function _blAddTh(row, label, sortKey, align) {
    var th = document.createElement('th');
    th.className = 'bl-th';
    th.textContent = label;
    if (align) th.style.textAlign = align;
    if (sortKey) {
        th.classList.add('bl-sortable');
        if (_blSort.col === sortKey) {
            th.classList.add('bl-sorted');
            th.classList.add(_blSort.dir);
        }
        th.addEventListener('click', function() {
            if (_blSort.col === sortKey) {
                _blSort.dir = _blSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                _blSort.col = sortKey;
                _blSort.dir = 'asc';
            }
            localStorage.setItem('office_listview_sort', JSON.stringify(_blSort));
            _blLoadData();
        });
    }
    row.appendChild(th);
}

/* ══════════════════════════════════════════════════════════════
   SSE HANDLERS
   ══════════════════════════════════════════════════════════════ */

function _blHandleBonCreated(data) {
    // Re-fetch to ensure correct filter/sort
    _blLoadData();
}

function _blHandleBonUpdated(data) {
    _blLoadData();
}

function _blHandleBonStatus(data) {
    _blLoadData();
}

// Ny indgående mail på en bon → re-fetch så ✉-badgen på rækken (og ULÆST MAIL-
// tælleren) opdateres live uden reload.
function _blHandleMailReceived(data) {
    _blLoadData();
}
