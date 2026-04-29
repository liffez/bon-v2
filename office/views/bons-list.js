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

var _blSort = JSON.parse(localStorage.getItem('office_listview_sort') || '{}');
if (!_blSort.col) { _blSort = { col: 'delivery_time', dir: 'asc' }; }

var _blColumns = JSON.parse(localStorage.getItem('office_listview_columns') || 'null') || {
    customer: true,
    company: true,
    pax: true,
    phone: false,
    email: false,
    courier: true,
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
    pax:             { label: 'Pax / Enh.',     sortKey: 'pax',                  align: 'right' },
    phone:           { label: 'Telefon',        sortKey: null },
    email:           { label: 'Email',          sortKey: null },
    courier:         { label: 'Bud',            sortKey: 'courier_arrival_time' },
    mail:            { label: '\u2709 Mail',    sortKey: null },
    price_cat:       { label: 'Priskategori',   sortKey: null },
    payment:         { label: 'Betaling',       sortKey: null },
    delivery_type:   { label: 'Leveringstype',  sortKey: null },
    total_price:     { label: 'Total pris',     sortKey: 'total_price' },
};

/* Leveringsmetode-ikoner — hardcoded foreløbig, flyttes til settings senere */
var BL_DELIVERY_ICONS = {
    bike:   { icon: '\uD83D\uDEB2', label: 'Cykel' },
    taxi:   { icon: '\uD83D\uDE95', label: 'Taxa' },
    volvo:  { icon: '\uD83D\uDE9B', label: 'Volvo' },
    pickup: { icon: '\uD83C\uDFE0', label: 'Afhentning' },
};

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
    } else if (filter && ['today','ny','mail','open','all'].indexOf(filter) >= 0) {
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
        { key: 'today', label: 'I DAG' },
        { key: 'ny',    label: 'NY' },
        { key: 'mail',  label: 'UL\u00C6ST MAIL' },
    ];
    for (var i = 0; i < filters.length; i++) {
        var btn = document.createElement('button');
        btn.className = 'bl-filter-btn';
        btn.dataset.filter = filters[i].key;
        btn.textContent = filters[i].label;
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
        if (dd && !dd.contains(e.target) && e.target.id !== 'blColBtn') {
            dd.classList.remove('open');
        }
    });

    _blUpdateFilterButtons();
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
        case 'date':
            params.date = _blDateValue;
            break;
        case 'all':
            // Seneste 90 dage
            var d = new Date();
            d.setDate(d.getDate() - 90);
            params.date_from = d.toISOString().slice(0, 10);
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
        dateForStaff = (_blFilter === 'today') ? new Date().toISOString().slice(0, 10) : _blDateValue;
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

function _blRenderSummary() {
    var el = document.getElementById('blSummary');
    if (!el) return;

    // Only show for date-filtered views
    if (_blFilter !== 'today' && _blFilter !== 'date') {
        el.style.display = 'none';
        return;
    }

    var totalPax = 0, totalUnits = 0, count = _blBons.length;
    for (var i = 0; i < _blBons.length; i++) {
        totalPax += _blBons[i].pax || 0;
        totalUnits += _blBons[i].total_units || 0;
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
    if (totalPax > 0) parts.push(totalPax + ' pax');
    if (totalUnits > 0) parts.push(totalUnits + ' enheder');

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
    var todayStr = new Date().toISOString().slice(0, 10);

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
            + (isProduction ? ' <span class="bl-prod-icon">\uD83D\uDD27</span>' : '');
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

        // Status
        var tdStatus = document.createElement('td');
        tdStatus.className = 'bl-td-status';
        tdStatus.setAttribute('rowspan', '2');
        tdStatus.innerHTML = '<span class="bl-status-badge" style="background:'
            + (statusCfg.color || '#999') + ';color:' + (statusCfg.text || '#fff') + '">'
            + esc(statusCfg.label || bon.status_code) + '</span>';
        tr1.appendChild(tdStatus);

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
                    break;
                case 'company':
                    td1.textContent = bon.company_name || '';
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
