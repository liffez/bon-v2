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
var _currentView  = 'calendar'; // 'calendar' | 'list' | 'web-orders'
var _webOrdersData = null;
var _webOrdersBadgeCount = 0;
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
    // URL-param ?view=web-orders har forrang over localStorage (deep-link
    // fra fx kitchen-dashboard-card)
    var urlView = null;
    try { urlView = new URLSearchParams(window.location.search).get('view'); } catch(e) {}
    if (urlView === 'web-orders' || urlView === 'list' || urlView === 'calendar') {
        _currentView = urlView;
    } else {
        _currentView = localStorage.getItem('bon_cal_view') || _options.view || 'calendar';
    }

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
    _syncSidekickVisibility();
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
        + '<button class="cal-view-btn" data-view="list" title="Liste">\u2261</button>'
        + '<button class="cal-view-btn cal-view-btn-wo" data-view="web-orders" title="Nye bestillinger">\uD83C\uDD95<span class="cal-wo-badge" id="calWoBadge" style="display:none">0</span></button>';
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

    // Hent web-order badge i baggrunden (skal være synlig uanset view)
    _loadWebOrdersBadge();

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
    else if (_currentView === 'web-orders') _renderWebOrders();
    else _renderList();
}

/* ══════════════════════════════════════════════════════════════
   WEB-ORDERS VIEW (#042 — kitchen-styled)
   ══════════════════════════════════════════════════════════════ */

function _loadWebOrdersBadge() {
    if (typeof fetchPendingWebOrders !== 'function') return;
    fetchPendingWebOrders().then(function(rows) {
        _webOrdersBadgeCount = rows.length;
        var badge = document.getElementById('calWoBadge');
        if (badge) {
            badge.textContent = rows.length;
            badge.style.display = rows.length > 0 ? '' : 'none';
        }
    }).catch(function() { /* lydløs */ });
}

function _renderWebOrders() {
    var content = document.getElementById('calContent');
    if (!content) return;
    content.innerHTML = '<div class="cal-empty">Henter...</div>';

    if (typeof fetchPendingWebOrders !== 'function') {
        content.innerHTML = '<div class="cal-empty">API ikke tilgængelig.</div>';
        return;
    }

    fetchPendingWebOrders().then(function(rows) {
        _webOrdersData = rows;
        _webOrdersBadgeCount = rows.length;
        var badge = document.getElementById('calWoBadge');
        if (badge) {
            badge.textContent = rows.length;
            badge.style.display = rows.length > 0 ? '' : 'none';
        }

        if (rows.length === 0) {
            content.innerHTML = '<div class="cal-wo-wrap">'
                + '<div class="cal-wo-empty">'
                + '<div class="cal-wo-empty-emoji">🎉</div>'
                + '<div>Ingen ubekræftede bestillinger fra hjemmesiden</div>'
                + '</div></div>';
            return;
        }

        var html = '<div class="cal-wo-wrap">';
        html += '<div class="cal-wo-header">';
        html += '<div class="cal-wo-count">' + rows.length + '</div>';
        html += '<div class="cal-wo-header-sub">ubekræftede web-bestillinger — klik <strong>Bekræft modtaget</strong> når du har set bonen</div>';
        html += '</div>';
        html += '<div class="cal-wo-list">';
        for (var i = 0; i < rows.length; i++) {
            html += _renderWebOrderCard(rows[i]);
        }
        html += '</div></div>';
        content.innerHTML = html;

        // Wire knapper
        var btns = content.querySelectorAll('[data-wo-ack]');
        for (var j = 0; j < btns.length; j++) {
            btns[j].addEventListener('click', _onWebOrderAck);
        }
        var openBtns = content.querySelectorAll('[data-wo-open]');
        for (var k = 0; k < openBtns.length; k++) {
            openBtns[k].addEventListener('click', _onWebOrderOpen);
        }
    }).catch(function(err) {
        console.error('[cal/web-orders] fejl:', err);
        content.innerHTML = '<div class="cal-empty">Kunne ikke hente web-bestillinger.</div>';
    });
}

function _renderWebOrderCard(b) {
    var daysUntil = _calDaysUntil(b.delivery_date);
    var daysClass = 'cal-wo-days-soon';
    var daysText = '';
    if (daysUntil !== null) {
        if (daysUntil < 0)        { daysClass = 'cal-wo-days-past'; daysText = 'for ' + (-daysUntil) + ' dag' + (daysUntil === -1 ? '' : 'e') + ' siden'; }
        else if (daysUntil === 0) { daysText = 'i dag'; }
        else if (daysUntil === 1) { daysText = 'i morgen'; }
        else if (daysUntil < 14)  { daysText = 'om ' + daysUntil + ' dage'; }
        else                      { daysClass = 'cal-wo-days-far'; daysText = 'om ' + daysUntil + ' dage'; }
    }
    var time = b.delivery_time ? b.delivery_time.slice(0, 5) : '—';
    var typeLbl = b.order_type === 'pickup' ? '🏠 Afhentning' : '🚚 Levering';
    var feStatusWo = (typeof statusToFrontend === 'function') ? statusToFrontend(b.status_code) : '';
    var statusCfgWo = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses) ? BON_CONFIG.statuses[feStatusWo] : null;
    var statusPillStyle = statusCfgWo
        ? 'background:' + statusCfgWo.color + ';color:' + (statusCfgWo.text || '#fff')
        : (b.status_color ? 'background:' + _calEsc(b.status_color) + ';color:#fff' : '');
    var statusLabelWo = statusCfgWo ? statusCfgWo.label : (b.status_label || b.status_code || '');

    var h = '<div class="cal-wo-card" data-bon-id="' + b.bon_id + '">';
    h += '<div class="cal-wo-card-head">';
    h += '<span class="cal-wo-bon-num">#' + _calEsc(b.bon_number) + '</span>';
    h += '<span class="cal-wo-customer">' + _calEsc(b.customer_name) + '</span>';
    h += '<span class="cal-wo-status-pill" style="' + statusPillStyle + '">' + _calEsc(statusLabelWo) + '</span>';
    h += '</div>';

    h += '<div class="cal-wo-meta">';
    h += '<span>📅 ' + _calFmtDate(b.delivery_date) + ' kl. ' + time + ' <span class="' + daysClass + '">(' + _calEsc(daysText) + ')</span></span>';
    h += '<span>' + typeLbl + '</span>';
    if (b.pax) h += '<span>👥 ' + b.pax + ' pax</span>';
    if (b.customer_email) h += '<span>' + mailIcon(13) + ' <a href="mailto:' + _calEsc(b.customer_email) + '">' + _calEsc(b.customer_email) + '</a></span>';
    if (b.customer_phone) h += '<span>📞 <a href="tel:' + _calEsc(b.customer_phone) + '">' + _calEsc(b.customer_phone) + '</a></span>';
    if (b.company_name) h += '<span>🏢 ' + _calEsc(b.company_name) + '</span>';
    h += '</div>';

    if (b.address_text && b.delivery_type !== 'pickup') {
        h += '<div class="cal-wo-meta"><span>📍 ' + _calEsc(b.address_text);
        if (b.postal_code) h += ', ' + _calEsc(b.postal_code) + ' ' + _calEsc(b.city || '');
        h += '</span></div>';
    }
    if (b.customer_wishes) {
        h += '<div class="cal-wo-wishes">' + _calEsc(b.customer_wishes) + '</div>';
    }

    h += '<div class="cal-wo-foot">';
    h += '<span class="cal-wo-age">Modtaget ' + _calFmtAge(b.created_at) + '</span>';
    h += '<div class="cal-wo-foot-right">';
    h += '<button class="cal-wo-btn" data-wo-open="' + b.bon_id + '">Åbn</button>';
    h += '<button class="cal-wo-btn cal-wo-btn-primary" data-wo-ack="' + b.bon_id + '">✓ Bekræft modtaget</button>';
    h += '</div></div>';
    h += '</div>';
    return h;
}

function _onWebOrderAck(e) {
    var btn = e.currentTarget;
    var bonId = parseInt(btn.getAttribute('data-wo-ack'));
    btn.disabled = true;
    btn.textContent = '…';

    if (typeof acknowledgeBon !== 'function') {
        btn.disabled = false;
        btn.textContent = '✓ Bekræft modtaget';
        alert('API ikke tilgængelig.');
        return;
    }

    acknowledgeBon(bonId).then(function() {
        var card = _container.querySelector('.cal-wo-card[data-bon-id="' + bonId + '"]');
        if (card) {
            card.classList.add('cal-wo-removing');
            setTimeout(function() {
                _webOrdersData = (_webOrdersData || []).filter(function(b) { return b.bon_id !== bonId; });
                _webOrdersBadgeCount = _webOrdersData.length;
                var badge = document.getElementById('calWoBadge');
                if (badge) {
                    badge.textContent = _webOrdersBadgeCount;
                    badge.style.display = _webOrdersBadgeCount > 0 ? '' : 'none';
                }
                _renderWebOrders();
            }, 350);
        }
    }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = '✓ Bekræft modtaget';
        alert('Kunne ikke bekræfte: ' + err.message);
    });
}

function _onWebOrderOpen(e) {
    var bonId = parseInt(e.currentTarget.getAttribute('data-wo-open'));
    if (_options.onBonClick) {
        _options.onBonClick(bonId);
    } else if (typeof window.openBonInfo === 'function') {
        window.openBonInfo(bonId);
    }
}

/* ── Web-order helpers ─────────────────────────────────────── */

function _calDaysUntil(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + 'T12:00:00');
    var today = new Date(); today.setHours(12, 0, 0, 0);
    return Math.round((d - today) / 86400000);
}
function _calFmtDate(dateStr) {
    if (!dateStr) return '—';
    var d = new Date(dateStr + 'T12:00:00');
    var days = ['Søn','Man','Tir','Ons','Tor','Fre','Lør'];
    var months = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
    return days[d.getDay()] + ' ' + d.getDate() + '. ' + months[d.getMonth()];
}
function _calFmtAge(createdAt) {
    if (!createdAt) return '';
    var created = new Date(createdAt.replace(' ', 'T') + 'Z');
    var mins = Math.round((Date.now() - created.getTime()) / 60000);
    if (mins < 1) return 'lige nu';
    if (mins < 60) return mins + ' min siden';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' time' + (hrs === 1 ? '' : 'r') + ' siden';
    var days = Math.round(hrs / 24);
    return days + ' dag' + (days === 1 ? '' : 'e') + ' siden';
}
function _calEsc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]; });
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
    // Web-orders huskes ikke i localStorage — den åbnes via badge-klik
    // eller URL-param og bør ikke "låse sig fast" som default næste gang.
    if (view !== 'web-orders') {
        localStorage.setItem('bon_cal_view', view);
    }
    _updateViewButtons();
    _render();
    _syncSidekickVisibility();
}

// Whiteboard-sidekick: kun synlig på selve kalender-viewet (ikke list/web-orders)
function _syncSidekickVisibility() {
    if (window.Sidekick) window.Sidekick.setVisible(_currentView === 'calendar');
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
                // Vis workload (= enh. hvis sat, ellers pax — per bon, summeret)
                // Matcher v1's "Total"-tal og undgår dobbelttælling af bons med både pax og enh.
                var wtLine = wt.workload > 0 ? (wt.workload + ' enh.') : (wt.count + ' bons');
                wtCell.innerHTML = '<div class="cal-week-total-line">' + wtLine + '</div>'
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

    // Bemanding (Smartplan) — adskilte badges for HQ og Festival & Events
    if (_staffData && Array.isArray(_staffData)) {
        var shifts = _staffData.filter(function(s) { return s.date === dateStr; });
        if (shifts.length > 0) {
            var hqShifts = [], evShifts = [];
            for (var i = 0; i < shifts.length; i++) {
                (shifts[i].location_class === 'events' ? evShifts : hqShifts).push(shifts[i]);
            }
            var appendStaffBadge = function(list, icon, cls) {
                if (list.length === 0) return;
                var badge = document.createElement('span');
                badge.className = 'cal-staff-badge' + (cls ? ' ' + cls : '');
                badge.textContent = icon + ' ' + list.length;
                var lines = [];
                for (var j2 = 0; j2 < list.length; j2++) {
                    var firstName = (list[j2].employee_name || '').split(' ')[0];
                    lines.push(list[j2].start_time + '\u2013' + list[j2].end_time + '  ' + firstName);
                }
                badge.title = lines.join('\n');
                dateRow.appendChild(badge);
            };
            appendStaffBadge(hqShifts, '\uD83D\uDC64', '');
            appendStaffBadge(evShifts, '\uD83C\uDFAA', 'is-events');
        }
    }

    cell.appendChild(dateRow);

    // Dag-totaler ØVERST — workload (enh. hvis sat, ellers pax — per bon)
    if (dayData && dayData.totals.count > 0) {
        var totalsTop = document.createElement('div');
        totalsTop.className = 'cal-day-totals';
        var dayLineTop = dayData.totals.workload > 0
            ? (dayData.totals.workload + ' enh.')
            : (dayData.totals.count + ' bons');
        totalsTop.innerHTML = '<span>' + dayLineTop + '</span>'
            + '<span>' + dayData.totals.count + ' bons</span>';
        cell.appendChild(totalsTop);
    }

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
            var textColor = statusCfg && statusCfg.text ? statusCfg.text : '#ffffff';

            var isProduction = bon.price_category === 'produktion' || bon.price_category_code === 'produktion';
            var entry = document.createElement('div');
            entry.className = 'cal-bon-entry';
            entry.dataset.bonId  = bon.id;
            entry.dataset.status = feStatus;
            entry.dataset.offer  = bon.is_offer ? 'true' : 'false';
            if (isProduction) {
                entry.dataset.production = 'true';
                // Inline value beats [data-production] CSS selector (specificity),
                // so set production blue + white text directly når bonen er en produktions-bon.
                entry.style.setProperty('--bon-color', '#4a7ab0');
                entry.style.setProperty('--bon-text', '#ffffff');
            } else {
                entry.style.setProperty('--bon-color', color);
                entry.style.setProperty('--bon-text', textColor);
            }

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

            var prodIcon = (bon.price_category === 'produktion' || bon.price_category_code === 'produktion') ? ' <span class="bon-prod-badge" title="Produktionsbon">🔧</span>' : '';
            var mailBadge = bon.unread_mail_count ? ' <span class="bon-mail-badge" title="' + bon.unread_mail_count + ' ulæst mail">' + mailIcon(13) + '</span>' : '';
            entry.innerHTML = '<span class="cal-bon-time">' + esc(timeStr) + '</span>'
                + '<span class="cal-bon-id">#' + esc(bon.bon_number) + prodIcon + mailBadge + '</span>'
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
    withFocusPreserved(content, function () { _renderListInner(content); });
}

function _renderListInner(content) {
    content.innerHTML = '';

    // Søgefelt
    var searchWrap = document.createElement('div');
    searchWrap.className = 'cal-list-search';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'calListSearch';
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
            } else if (col2.key === 'bon_number') {
                var isProd2 = bon.price_category === 'produktion' || bon.price_category_code === 'produktion';
                td.innerHTML = '#' + esc(String(bon.bon_number || ''))
                    + (isProd2 ? ' <span class="bon-prod-badge" title="Produktionsbon">🔧</span>' : '')
                    + (bon.unread_mail_count ? ' <span class="bon-mail-badge">' + mailIcon(13) + '</span>' : '');
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
        bon_deleted: function() {
            _loadData();
        },
        bon_updated: function() {
            _loadData();
            if (_currentView === 'web-orders') _renderWebOrders();
            else _loadWebOrdersBadge();
        },
        bon_created: function() {
            _loadData();
            if (_currentView === 'web-orders') _renderWebOrders();
            else _loadWebOrdersBadge();
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
