/**
 * shared/calendar.js
 * ════════════════════════════════════════════════════════════
 * Kalender + Liste — shared komponent.
 *
 * API:
 *   initCalendar(containerEl, options)
 *
 * Options:
 *   zone:      'kitchen' | 'office'  (UI-densitet)
 *   view:      'calendar' | 'list'   (initial, default: localStorage)
 *   year:      number                (default: i år)
 *   month:     number                (default: denne måned)
 *   showStaff: boolean               (default: true)
 *
 * Afhængigheder (load order):
 *   BonConfig.js     → BON_CONFIG.statuses
 *   shared/utils.js  → statusToFrontend, formatDanishDate, esc,
 *                       connectSSE, getClientId
 *   shared/api.js    → fetchBonsCalendar, fetchSmartplanShifts, fetchBon
 *   shared/modal.js  → showBonInfo, openModal
 * ════════════════════════════════════════════════════════════
 */

/* ── Intern state ──────────────────────────────────────────── */

var _container    = null;
var _currentYear  = 0;
var _currentMonth = 0;
var _currentView  = 'calendar'; // 'calendar' | 'list'
var _activeFilters = {};        // status-key → true
var _filterCount   = 0;
var _calendarData  = null;
var _staffData     = null;
var _sortColumn    = 'delivery_date';
var _sortDir       = 'asc';
var _options       = {};

var _CAL_WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
var _CAL_MONTHS = ['Januar','Februar','Marts','April','Maj','Juni',
                   'Juli','August','September','Oktober','November','December'];

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */

function initCalendar(containerEl, options) {
    _container    = containerEl;
    _options      = options || {};
    _currentYear  = _options.year  || new Date().getFullYear();
    _currentMonth = _options.month || (new Date().getMonth() + 1);
    _currentView  = localStorage.getItem('bon_cal_view') || _options.view || 'calendar';

    // Restore filter state from localStorage
    var savedFilters = localStorage.getItem('cal_status_filter');
    if (savedFilters) {
        try {
            _activeFilters = JSON.parse(savedFilters);
            _filterCount = Object.keys(_activeFilters).length;
        } catch(e) { _activeFilters = {}; _filterCount = 0; }
    }

    _renderShell();
    _loadData();
    _initSSE();
}

/* ══════════════════════════════════════════════════════════════
   SHELL — header + content area
   ══════════════════════════════════════════════════════════════ */

function _renderShell() {
    _container.innerHTML = '';

    // Header
    var header = document.createElement('div');
    header.className = 'cal-header';

    // Month navigation
    var monthNav = document.createElement('div');
    monthNav.className = 'cal-month-nav';
    monthNav.innerHTML = '<button id="calPrev">\u25C0</button>'
        + '<span class="cal-month-label" id="calMonthLabel"></span>'
        + '<button id="calNext">\u25B6</button>';
    header.appendChild(monthNav);

    // Right side: ny bon + view toggle
    var right = document.createElement('div');
    right.className = 'cal-header-right';
    right.innerHTML = '<button class="cal-ny-bon-btn" id="calNyBon">+ Ny bon</button>'
        + '<button class="cal-view-btn" data-view="calendar" title="Kalender">\uD83D\uDCC5</button>'
        + '<button class="cal-view-btn" data-view="list" title="Liste">\u2261</button>';
    header.appendChild(right);

    _container.appendChild(header);

    // Status filters
    var filterBar = _buildStatusFilters();
    _container.appendChild(filterBar);

    // Content area
    var content = document.createElement('div');
    content.className = 'cal-content';
    content.id = 'calContent';
    _container.appendChild(content);

    // Wire events
    document.getElementById('calPrev').addEventListener('click', _prevMonth);
    document.getElementById('calNext').addEventListener('click', _nextMonth);

    var viewBtns = _container.querySelectorAll('.cal-view-btn');
    for (var i = 0; i < viewBtns.length; i++) {
        viewBtns[i].addEventListener('click', function() {
            _toggleView(this.dataset.view);
        });
    }

    _updateMonthDisplay();
    _updateViewButtons();
}

function _updateMonthDisplay() {
    var label = document.getElementById('calMonthLabel');
    if (label) label.textContent = _CAL_MONTHS[_currentMonth - 1] + ' ' + _currentYear;
}

function _updateViewButtons() {
    var btns = _container.querySelectorAll('.cal-view-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.view === _currentView);
    }
}

/* ══════════════════════════════════════════════════════════════
   STATUS FILTERS
   ══════════════════════════════════════════════════════════════ */

function _buildStatusFilters() {
    var bar = document.createElement('div');
    bar.className = 'cal-status-filters';

    if (typeof BON_CONFIG === 'undefined' || !BON_CONFIG.statuses) return bar;

    var statuses = BON_CONFIG.statuses;
    for (var key in statuses) {
        if (!statuses.hasOwnProperty(key)) continue;
        var cfg = statuses[key];

        var btn = document.createElement('button');
        btn.className = 'cal-filter-btn' + (_activeFilters[key] ? ' hidden' : '');
        btn.dataset.status = key;
        btn.textContent = cfg.label;
        btn.style.setProperty('--filter-color', cfg.color);
        btn.style.setProperty('--filter-text', cfg.text || '#fff');

        btn.addEventListener('click', function() {
            var st = this.dataset.status;
            if (_activeFilters[st]) {
                // Re-enable: remove from hidden set
                delete _activeFilters[st];
                _filterCount--;
                this.classList.remove('hidden');
            } else {
                // Disable: add to hidden set
                _activeFilters[st] = true;
                _filterCount++;
                this.classList.add('hidden');
            }
            bar.classList.toggle('has-filter', _filterCount > 0);
            localStorage.setItem('cal_status_filter', JSON.stringify(_activeFilters));
            _applyFilters();
        });

        bar.appendChild(btn);
    }

    if (_filterCount > 0) bar.classList.add('has-filter');
    return bar;
}

function _applyFilters() {
    // _activeFilters now contains statuses to HIDE (subtractive)
    var entries = _container.querySelectorAll('.cal-bon-entry, .cal-list-row');
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var status = entry.dataset.status;
        var isOffer = entry.dataset.offer === 'true';

        if (_filterCount === 0) {
            // No filters = show everything
            entry.dataset.hidden = 'false';
        } else if (_activeFilters[status]) {
            // This status is in the hidden set
            entry.dataset.hidden = 'true';
        } else if (_activeFilters['tilbud'] && isOffer) {
            // Tilbud is hidden
            entry.dataset.hidden = 'true';
        } else {
            entry.dataset.hidden = 'false';
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   DATA LOADING
   ══════════════════════════════════════════════════════════════ */

function _loadData() {
    _updateMonthDisplay();

    // Render kalender med det samme — Smartplan hentes asynkront bagefter
    fetchBonsCalendar(_currentYear, _currentMonth).then(function(data) {
        _calendarData = data;
        _render();

        // Hent Smartplan i baggrunden (blokerer ikke kalender-render)
        if (_options.showStaff !== false) {
            var lastDay = new Date(_currentYear, _currentMonth, 0).getDate();
            var from = _currentYear + '-' + String(_currentMonth).padStart(2, '0') + '-01';
            var to   = _currentYear + '-' + String(_currentMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
            fetchSmartplanShifts(from, to)
                .then(function(staff) { _staffData = staff; _render(); })
                .catch(function() { /* Smartplan ikke tilgængelig */ });
        }
    }).catch(function(err) {
        console.error('Kalenderfejl:', err);
        var content = document.getElementById('calContent');
        if (content) content.innerHTML = '<div class="cal-empty">Kunne ikke hente kalenderdata.</div>';
    });
}

function _render() {
    if (_currentView === 'calendar') _renderCalendar();
    else _renderList();
}

/* ══════════════════════════════════════════════════════════════
   MONTH NAVIGATION
   ══════════════════════════════════════════════════════════════ */

function _prevMonth() {
    _currentMonth--;
    if (_currentMonth < 1) { _currentMonth = 12; _currentYear--; }
    _loadData();
}

function _nextMonth() {
    _currentMonth++;
    if (_currentMonth > 12) { _currentMonth = 1; _currentYear++; }
    _loadData();
}

/* ══════════════════════════════════════════════════════════════
   VIEW TOGGLE
   ══════════════════════════════════════════════════════════════ */

function _toggleView(view) {
    _currentView = view;
    localStorage.setItem('bon_cal_view', view);
    _updateViewButtons();
    _render();
}

/* ══════════════════════════════════════════════════════════════
   KALENDER RENDERING
   ══════════════════════════════════════════════════════════════ */

function _renderCalendar() {
    var content = document.getElementById('calContent');
    if (!content || !_calendarData) return;
    content.innerHTML = '';

    var grid = document.createElement('div');
    grid.className = 'cal-grid';

    // Header row: week-label + 7 weekdays + week-total
    var wlHeader = document.createElement('div');
    wlHeader.className = 'cal-week-label-header';
    wlHeader.textContent = 'Uge';
    grid.appendChild(wlHeader);

    for (var d = 0; d < 7; d++) {
        var hdr = document.createElement('div');
        hdr.className = 'cal-weekday-header';
        hdr.textContent = _CAL_WEEKDAYS[d];
        grid.appendChild(hdr);
    }

    var wtHeader = document.createElement('div');
    wtHeader.className = 'cal-weekday-header cal-week-total-header';
    wtHeader.textContent = 'Total';
    grid.appendChild(wtHeader);

    // Generate day cells
    var startDate   = new Date(_calendarData.calStart + 'T00:00:00');
    var endDate     = new Date(_calendarData.calEnd + 'T00:00:00');
    var currentDate = new Date(startDate);
    var todayStr    = _localDateStr(new Date());
    var weekPax     = 0;
    var weekUnits   = 0;
    var weekCount   = 0;

    while (currentDate <= endDate) {
        var dateStr = _localDateStr(currentDate);
        var dow     = currentDate.getDay(); // 0=søn, 1=man
        var isoDow  = dow === 0 ? 7 : dow;  // 1=man, 7=søn

        // Start of week (Monday): insert week-label
        if (isoDow === 1) {
            weekPax = 0; weekUnits = 0; weekCount = 0;
            var weekNum  = _getISOWeek(currentDate);
            var wLabel   = document.createElement('div');
            wLabel.className = 'cal-week-label';
            wLabel.textContent = 'v. ' + weekNum;
            grid.appendChild(wLabel);
        }

        // Day cell
        var dayData        = _calendarData.days[dateStr] || null;
        var isCurrentMonth = (currentDate.getMonth() + 1) === _currentMonth;
        var isToday        = dateStr === todayStr;

        if (dayData) {
            weekPax   += dayData.totals.pax;
            weekUnits += dayData.totals.units;
            weekCount += dayData.totals.count;
        }

        var cell = _buildDayCell(dateStr, dayData, isCurrentMonth, isToday);
        grid.appendChild(cell);

        // End of week (Sunday): insert week-total
        if (isoDow === 7) {
            var weekNum2 = _getISOWeek(currentDate);
            var weekKey  = currentDate.getFullYear() + '-W' + String(weekNum2).padStart(2, '0');
            var wt       = _calendarData.weekTotals[weekKey];
            var wtCell   = document.createElement('div');
            wtCell.className = 'cal-week-total';
            if (wt && wt.count > 0) {
                var wtParts = [];
                if (wt.pax > 0) wtParts.push(wt.pax + ' pax');
                if (wt.units > 0) wtParts.push('(' + wt.units + ' enh.)');
                wtCell.innerHTML = '<div class="cal-week-total-line">' + (wtParts.join(' ') || wt.count + ' bons') + '</div>'
                    + '<div class="cal-week-total-line count">' + wt.count + ' bons</div>';
            }
            grid.appendChild(wtCell);
        }

        currentDate.setDate(currentDate.getDate() + 1);
    }

    content.appendChild(grid);
    _applyFilters();
}

function _buildDayCell(dateStr, dayData, isCurrentMonth, isToday) {
    var cell = document.createElement('div');
    cell.className = 'cal-day-cell';
    if (!isCurrentMonth) cell.classList.add('cal-outside-month');
    if (isToday) cell.classList.add('cal-today');

    // Dato-header: nummer + bemanding
    var dateRow = document.createElement('div');
    dateRow.className = 'cal-date-row';

    var dateNum = document.createElement('span');
    dateNum.className = 'cal-date-num';
    dateNum.textContent = new Date(dateStr + 'T00:00:00').getDate();
    dateRow.appendChild(dateNum);

    // Bemanding (Smartplan) — kompakt badge
    if (_staffData && Array.isArray(_staffData)) {
        var shifts = _staffData.filter(function(s) { return s.date === dateStr; });
        if (shifts.length > 0) {
            var badge = document.createElement('span');
            badge.className = 'cal-staff-badge';
            badge.textContent = '\uD83D\uDC64 ' + shifts.length;

            // Tooltip: tid først, kun fornavn
            var lines = [];
            for (var i = 0; i < shifts.length; i++) {
                var firstName = (shifts[i].employee_name || '').split(' ')[0];
                lines.push(shifts[i].start_time + '\u2013' + shifts[i].end_time + '  ' + firstName);
            }
            badge.title = lines.join('\n');
            dateRow.appendChild(badge);
        }
    }

    cell.appendChild(dateRow);

    // Bon-entries
    if (dayData && dayData.bons.length > 0) {
        var bonsDiv = document.createElement('div');
        bonsDiv.className = 'cal-bons';

        for (var j = 0; j < dayData.bons.length; j++) {
            var bon      = dayData.bons[j];
            var feStatus = statusToFrontend(bon.status_code);
            var statusCfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses)
                ? BON_CONFIG.statuses[feStatus] : null;
            var color = statusCfg ? statusCfg.color : (bon.status_color || '#999');

            var entry = document.createElement('div');
            entry.className = 'cal-bon-entry';
            entry.dataset.bonId  = bon.id;
            entry.dataset.status = feStatus;
            entry.dataset.offer  = bon.is_offer ? 'true' : 'false';
            entry.style.setProperty('--bon-color', color);

            var timeStr = bon.pickup_time || bon.delivery_time || '';

            // Pax/enheder — vis det største, enheder i parentes
            var bonPax = bon.pax || 0;
            var bonUnits = bon.total_units || 0;
            var bonLoad = '';
            if (bonUnits > 0 && bonUnits >= bonPax) {
                bonLoad = '(' + bonUnits + ')';
            } else if (bonPax > 0) {
                bonLoad = String(bonPax);
            }

            entry.innerHTML = '<span class="cal-bon-time">' + esc(timeStr) + '</span>'
                + '<span class="cal-bon-id">#' + esc(bon.bon_number) + '</span>'
                + (bonLoad ? '<span class="cal-bon-pax">' + bonLoad + '</span>' : '');

            // Klik → bon-info modal
            (function(b) {
                entry.addEventListener('click', function() {
                    var infoOpts = { showGotoButton: true, bonNumber: b.bon_number };
                    if (_options.onEdit) { infoOpts.showEditButton = true; infoOpts.onEdit = _options.onEdit; }
                    showBonInfo(b.id, infoOpts);
                });
            })(bon);

            bonsDiv.appendChild(entry);
        }
        cell.appendChild(bonsDiv);
    }

    // Dag-totaler — pax + (enheder)
    if (dayData && dayData.totals.count > 0) {
        var totals = document.createElement('div');
        totals.className = 'cal-day-totals';
        var totalParts = [];
        if (dayData.totals.pax > 0) totalParts.push(dayData.totals.pax + ' pax');
        if (dayData.totals.units > 0) totalParts.push('(' + dayData.totals.units + ' enh.)');
        totals.innerHTML = '<span>' + (totalParts.join(' ') || dayData.totals.count + ' bons') + '</span>'
            + '<span>' + dayData.totals.count + ' bons</span>';
        cell.appendChild(totals);
    }

    return cell;
}

/* ══════════════════════════════════════════════════════════════
   LISTE RENDERING
   ══════════════════════════════════════════════════════════════ */

var _LIST_COLUMNS = [
    { key: 'bon_number',        label: 'Bon#' },
    { key: 'delivery_date',     label: 'Dato' },
    { key: 'status_code',       label: 'Status' },
    { key: 'pax',               label: 'PAX' },
    { key: 'total_units',       label: 'ENHEDER' },
    { key: 'contact_name_full', label: 'Kunde' },
    { key: 'company_name',      label: 'Firma' },
    { key: 'payment_type',      label: 'Betaling' },
    { key: 'pickup_time',       label: 'Tid' },
    { key: 'delivery_type',     label: 'Type' },
];

var _searchTerm = '';

function _renderList() {
    var content = document.getElementById('calContent');
    if (!content || !_calendarData) return;
    content.innerHTML = '';

    // Søgefelt
    var searchWrap = document.createElement('div');
    searchWrap.className = 'cal-list-search';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Søg bon#, kunde, firma...';
    searchInput.className = 'cal-list-search-input';
    searchInput.value = _searchTerm;
    searchInput.addEventListener('input', function() {
        _searchTerm = this.value;
        _renderList();
    });
    searchWrap.appendChild(searchInput);
    content.appendChild(searchWrap);

    // Samle alle bons
    var allBons = [];
    for (var dateStr in _calendarData.days) {
        if (!_calendarData.days.hasOwnProperty(dateStr)) continue;
        var dayBons = _calendarData.days[dateStr].bons;
        for (var i = 0; i < dayBons.length; i++) {
            allBons.push(dayBons[i]);
        }
    }

    // Filtrer med søgeterm
    if (_searchTerm.trim()) {
        var q = _searchTerm.trim().toLowerCase();
        allBons = allBons.filter(function(bon) {
            return (bon.bon_number && String(bon.bon_number).toLowerCase().indexOf(q) !== -1)
                || (bon.contact_name_full && bon.contact_name_full.toLowerCase().indexOf(q) !== -1)
                || (bon.company_name && bon.company_name.toLowerCase().indexOf(q) !== -1)
                || (bon.delivery_date && bon.delivery_date.indexOf(q) !== -1)
                || (bon.status_code && bon.status_code.toLowerCase().indexOf(q) !== -1);
        });
    }

    // Sortér
    allBons.sort(function(a, b) {
        var va = a[_sortColumn], vb = b[_sortColumn];
        if (va == null) va = '';
        if (vb == null) vb = '';
        var cmp = String(va).localeCompare(String(vb), 'da', { numeric: true });
        return _sortDir === 'asc' ? cmp : -cmp;
    });

    // Byg tabel
    var table = document.createElement('table');
    table.className = 'cal-list-table';

    // Header
    var thead = document.createElement('thead');
    var hRow  = document.createElement('tr');
    for (var c = 0; c < _LIST_COLUMNS.length; c++) {
        var col = _LIST_COLUMNS[c];
        var th  = document.createElement('th');
        th.className = 'cal-list-th';
        th.textContent = col.label;
        th.dataset.column = col.key;
        if (_sortColumn === col.key) {
            th.classList.add('sorted');
            th.classList.add(_sortDir);
        }
        (function(colKey) {
            th.addEventListener('click', function() {
                if (_sortColumn === colKey) {
                    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    _sortColumn = colKey;
                    _sortDir = 'asc';
                }
                _renderList();
            });
        })(col.key);
        hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    table.appendChild(thead);

    // Body
    var tbody = document.createElement('tbody');
    for (var r = 0; r < allBons.length; r++) {
        var bon = allBons[r];
        var feStatus = statusToFrontend(bon.status_code);
        var rowStatusCfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses)
            ? BON_CONFIG.statuses[feStatus] : null;
        var tr = document.createElement('tr');
        tr.className = 'cal-list-row';
        tr.dataset.bonId  = bon.id;
        tr.dataset.status = feStatus;
        tr.dataset.offer  = bon.is_offer ? 'true' : 'false';
        if (rowStatusCfg) tr.style.setProperty('--row-color', rowStatusCfg.color);

        (function(b) {
            tr.addEventListener('click', function() {
                var infoOpts = { showGotoButton: true, bonNumber: b.bon_number };
                if (_options.onEdit) { infoOpts.showEditButton = true; infoOpts.onEdit = _options.onEdit; }
                showBonInfo(b.id, infoOpts);
            });
        })(bon);

        for (var c2 = 0; c2 < _LIST_COLUMNS.length; c2++) {
            var col2 = _LIST_COLUMNS[c2];
            var td   = document.createElement('td');

            if (col2.key === 'status_code') {
                var statusCfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses)
                    ? BON_CONFIG.statuses[feStatus] : null;
                var bgColor = statusCfg ? statusCfg.color : '#999';
                var txtColor = statusCfg ? (statusCfg.text || '#fff') : '#fff';
                var label = statusCfg ? statusCfg.label : bon.status_code;
                td.innerHTML = '<span class="cal-status-badge" style="background:'
                    + bgColor + ';color:' + txtColor + '">' + esc(label) + '</span>';
            } else if (col2.key === 'delivery_date') {
                td.textContent = formatDanishDate(bon.delivery_date);
            } else if (col2.key === 'pickup_time') {
                td.textContent = bon.pickup_time || bon.delivery_time || '';
            } else {
                td.textContent = bon[col2.key] != null ? bon[col2.key] : '';
            }

            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    content.appendChild(table);
    _applyFilters();
}

/* ══════════════════════════════════════════════════════════════
   SSE
   ══════════════════════════════════════════════════════════════ */

function _initSSE() {
    connectSSE('/api/sse?client_id=' + getClientId(), {
        connected: function() {
            console.log('SSE tilsluttet (calendar)');
        },
        bon_status: function() {
            _loadData();
        },
        bon_updated: function() {
            _loadData();
        },
    });
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

/** Lokal dato-streng YYYY-MM-DD (undgår UTC-forskydning fra toISOString) */
function _localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _getISOWeek(date) {
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
