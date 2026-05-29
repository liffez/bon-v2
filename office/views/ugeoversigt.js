/**
 * office/views/ugeoversigt.js
 * ════════════════════════════════════════════════════════════
 * Ugeoversigt — ugebillede med Produktion/Personale/Lager.
 *
 * API:
 *   initUgeoversigt(containerEl, { openDrawer })
 *   cleanupUgeoversigt()
 *   _uoHandleSSE(eventType, data)
 *
 * Afhængigheder:
 *   shared/api.js    → fetchScheduleWeek
 * ════════════════════════════════════════════════════════════
 */

/* ── State ──────────────────────────────────────────────── */

var _uoContainer = null;
var _uoOptions   = {};
var _uoData      = null;      // API response
var _uoFrom      = '';        // YYYY-MM-DD (mandag)
var _uoTo        = '';        // YYYY-MM-DD (søndag)
var _uoDetailDay = null;      // valgt dag-index (0–6) eller null
var _uoActive    = false;
var _uoDebounce  = null;
var _uoHiddenStatuses = JSON.parse(localStorage.getItem('uo_status_filter') || '{}'); // status_code → true = hidden

/* ── Constants ─────────────────────────────────────────── */

var _UO_DAYS_SHORT = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
var _UO_DAYS_LONG  = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
var _UO_MONTHS     = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];

/* ── Init / Cleanup ────────────────────────────────────── */

function initUgeoversigt(containerEl, opts) {
    _uoContainer = containerEl;
    _uoOptions = opts || {};
    _uoActive = true;

    // Start på indeværende uge
    var today = new Date();
    _uoFrom = _uoWeekMonday(today);
    _uoTo   = _uoAddDays(_uoFrom, 6);

    _uoRenderShell();
    _uoLoadData();
}

function cleanupUgeoversigt() {
    _uoActive = false;
    _uoData = null;
    _uoDetailDay = null;
    if (_uoDebounce) { clearTimeout(_uoDebounce); _uoDebounce = null; }
}

function _uoHandleSSE(eventType, data) {
    if (!_uoActive) return;
    // Debounce re-fetch
    if (_uoDebounce) clearTimeout(_uoDebounce);
    _uoDebounce = setTimeout(function() { _uoLoadData(); }, 500);
}

/* ── Data ──────────────────────────────────────────────── */

function _uoActiveStatusCodes() {
    if (typeof BON_CONFIG === 'undefined' || !BON_CONFIG.statuses) return null;
    var codes = [];
    for (var key in BON_CONFIG.statuses) {
        if (!BON_CONFIG.statuses.hasOwnProperty(key)) continue;
        if (!_uoHiddenStatuses[key]) codes.push(key.toUpperCase());
    }
    // If nothing is hidden, return null (use server default)
    var totalStatuses = Object.keys(BON_CONFIG.statuses).length;
    if (codes.length === totalStatuses) return null;
    return codes;
}

function _uoLoadData() {
    var codes = _uoActiveStatusCodes();
    var statusParam = codes ? codes.join(',') : '';
    fetchScheduleWeek(_uoFrom, _uoTo, statusParam)
        .then(function(resp) {
            if (!_uoActive) return;
            _uoData = resp.week;
            _uoRenderGrid();
            if (_uoDetailDay !== null) _uoRenderDetail(_uoDetailDay);
        })
        .catch(function(err) {
            console.error('[ugeoversigt] load error:', err);
        });
}

/* ── Date helpers ──────────────────────────────────────── */

function _uoWeekMonday(date) {
    var d = new Date(date);
    d.setHours(12, 0, 0, 0);
    var day = d.getDay(); // 0=søn
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
}

function _uoAddDays(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

function _uoToday() {
    return new Date().toISOString().slice(0, 10);
}

function _uoFormatDateRange(from, to) {
    var f = new Date(from + 'T12:00:00');
    var t = new Date(to + 'T12:00:00');
    var fDay = f.getDate();
    var tDay = t.getDate();
    var fMonth = _UO_MONTHS[f.getMonth()];
    var tMonth = _UO_MONTHS[t.getMonth()];
    var year = f.getFullYear();
    if (fMonth === tMonth) {
        return fDay + '.–' + tDay + '. ' + fMonth + ' ' + year;
    }
    return fDay + '. ' + fMonth + ' – ' + tDay + '. ' + tMonth + ' ' + year;
}

function _uoGetISOWeek(dateStr) {
    var d = new Date(Date.UTC(
        parseInt(dateStr.slice(0, 4)),
        parseInt(dateStr.slice(5, 7)) - 1,
        parseInt(dateStr.slice(8, 10))
    ));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/* ── Shell ─────────────────────────────────────────────── */

function _uoRenderShell() {
    _uoContainer.innerHTML = '<div class="uge-wrap" id="uoWrap">' +
        '<div class="uge-nav" id="uoNav"></div>' +
        '<div class="uge-filters" id="uoFilters"></div>' +
        '<div class="uge-legend" id="uoLegend"></div>' +
        '<div id="uoGridWrap"></div>' +
        '<div id="uoDetailWrap"></div>' +
    '</div>';

    _uoRenderNav();
    _uoRenderFilters();
    _uoRenderLegend();
}

function _uoRenderNav() {
    var el = document.getElementById('uoNav');
    if (!el) return;

    var weekNum = _uoGetISOWeek(_uoFrom);
    var rangeStr = _uoFormatDateRange(_uoFrom, _uoTo);

    el.innerHTML =
        '<button class="uge-nav-btn" id="uoPrev">◀</button>' +
        '<button class="uge-nav-btn" id="uoNext">▶</button>' +
        '<div>' +
            '<div class="uge-heading">Uge ' + weekNum + ' &nbsp;·&nbsp; ' + rangeStr + '</div>' +
        '</div>' +
        '<button class="uge-today-btn" id="uoTodayBtn">I dag</button>';

    document.getElementById('uoPrev').onclick = function() { _uoShiftWeek(-7); };
    document.getElementById('uoNext').onclick = function() { _uoShiftWeek(7); };
    document.getElementById('uoTodayBtn').onclick = function() {
        _uoFrom = _uoWeekMonday(new Date());
        _uoTo = _uoAddDays(_uoFrom, 6);
        _uoDetailDay = null;
        _uoRenderNav();
        _uoLoadData();
    };
}

function _uoRenderLegend() {
    var el = document.getElementById('uoLegend');
    if (!el) return;
    el.innerHTML =
        '<div class="uge-legend-item"><div class="legend-dot" style="background:var(--color-green-dark)"></div> OK</div>' +
        '<div class="uge-legend-item"><div class="legend-dot" style="background:var(--color-orange)"></div> Kræver opmærksomhed</div>' +
        '<div class="uge-legend-item"><div class="legend-dot" style="background:var(--color-red)"></div> Problem</div>' +
        '<div class="uge-legend-item"><div class="legend-dot" style="background:var(--color-text-dim)"></div> Tom dag</div>';
}

function _uoRenderFilters() {
    var el = document.getElementById('uoFilters');
    if (!el) return;
    if (typeof BON_CONFIG === 'undefined' || !BON_CONFIG.statuses) { el.innerHTML = ''; return; }

    var html = '';
    var statuses = BON_CONFIG.statuses;
    for (var key in statuses) {
        if (!statuses.hasOwnProperty(key)) continue;
        var cfg = statuses[key];
        var hidden = !!_uoHiddenStatuses[key];
        var cls = 'uge-filter-btn' + (hidden ? ' hidden' : '');
        html += '<button class="' + cls + '" data-status="' + key + '" ' +
            'style="--filter-color:' + cfg.color + ';--filter-text:' + (cfg.text || '#fff') + '">' +
            cfg.label + '</button>';
    }
    el.innerHTML = html;

    // Klik-handlers
    var btns = el.querySelectorAll('.uge-filter-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function() {
            var st = this.dataset.status;
            if (_uoHiddenStatuses[st]) {
                delete _uoHiddenStatuses[st];
                this.classList.remove('hidden');
            } else {
                _uoHiddenStatuses[st] = true;
                this.classList.add('hidden');
            }
            localStorage.setItem('uo_status_filter', JSON.stringify(_uoHiddenStatuses));
            _uoDetailDay = null;
            _uoLoadData();
        });
    }
}

function _uoShiftWeek(days) {
    _uoFrom = _uoAddDays(_uoFrom, days);
    _uoTo = _uoAddDays(_uoFrom, 6);
    _uoDetailDay = null;
    _uoRenderNav();
    _uoLoadData();
}

/* ── Grid ──────────────────────────────────────────────── */

function _uoRenderGrid() {
    var wrap = document.getElementById('uoGridWrap');
    if (!wrap || !_uoData) return;

    var today = _uoToday();
    var days = _uoData.days || [];
    var html = '<div class="uge-grid">';

    // ── Kolonne-headere ──
    html += '<div class="uge-col-header" style="border-left:none;background:transparent;"></div>';
    for (var i = 0; i < 7; i++) {
        var d = days[i] || {};
        var dateNum = d.date ? parseInt(d.date.slice(8, 10)) : '';
        var isToday = d.date === today;
        var isWeekend = i >= 5;
        var cls = 'uge-col-header';
        if (isToday) cls += ' today';
        else if (isWeekend) cls += ' weekend';
        html += '<div class="' + cls + '">' +
            '<div class="uge-day-name">' + _UO_DAYS_SHORT[i] + '</div>' +
            '<div class="uge-day-date">' + dateNum + '</div>' +
        '</div>';
    }

    // ── Række 1: Produktion ──
    html += '<div class="uge-row-label"><div class="uge-row-label-text"><span class="uge-row-icon">📋</span> Prod.</div></div>';
    for (var i = 0; i < 7; i++) {
        var d = days[i] || {};
        var prod = d.production || {};
        var isToday = (d.date === today);
        var isWeekend = i >= 5;
        var cellCls = 'uge-cell';
        if (isToday) cellCls += ' today-col';
        else if (isWeekend) cellCls += ' weekend-col';

        if (prod.count === 0 || !prod.count) {
            cellCls += ' empty';
            html += '<div class="' + cellCls + '"><div class="uge-cell-empty-txt">Ingen bonner</div></div>';
        } else {
            html += '<div class="' + cellCls + '" data-day="' + i + '">' +
                _uoStatusBadge(prod.status, _uoProdLabel(prod.status)) +
                '<div class="uge-cell-main">' + prod.count + '</div>' +
                '<div class="uge-cell-sub">bonner · ' + (prod.total_units || 0) + ' enh</div>' +
            '</div>';
        }
    }

    // ── Række 2: Personale ──
    html += '<div class="uge-row-label"><div class="uge-row-label-text"><span class="uge-row-icon">👥</span> Pers.</div></div>';
    for (var i = 0; i < 7; i++) {
        var d = days[i] || {};
        var staff = d.staff || {};
        var openN = staff.open_count || 0;
        var isToday = (d.date === today);
        var isWeekend = i >= 5;
        var cellCls = 'uge-cell';
        if (isToday) cellCls += ' today-col';
        else if (isWeekend) cellCls += ' weekend-col';

        if (!staff.count && !openN) {
            cellCls += ' empty';
            html += '<div class="' + cellCls + '"><div class="uge-cell-empty-txt">Ingen vagter</div></div>';
        } else {
            var ratioHtml = '';
            if (staff.ratio != null) {
                ratioHtml = '<div class="uge-ratio">' + Math.round(staff.ratio) + ' enh/p</div>';
            }
            var openHtml = openN > 0
                ? '<div class="uge-open-shift" title="Udlagt, men endnu ikke taget af nogen">⚠ ' + openN + ' ledig vagt' + (openN === 1 ? '' : 'er') + '</div>'
                : '';
            html += '<div class="' + cellCls + '" data-day="' + i + '">' +
                _uoStatusBadge(staff.status, _uoStaffLabel(staff.status)) +
                '<div class="uge-cell-main">' + staff.count + '</div>' +
                '<div class="uge-cell-sub">vagt' + (staff.count === 1 ? '' : 'er') + ' · ' + staff.total_hours + ' t</div>' +
                ratioHtml +
                openHtml +
            '</div>';
        }
    }

    // ── Række 3: Lager ──
    html += '<div class="uge-row-label" style="border-bottom:none"><div class="uge-row-label-text"><span class="uge-row-icon">📦</span> Lager</div></div>';
    for (var i = 0; i < 7; i++) {
        var d = days[i] || {};
        var stock = d.stock || {};
        var isToday = (d.date === today);
        var isWeekend = i >= 5;
        var cellCls = 'uge-cell';
        if (isToday) cellCls += ' today-col';
        else if (isWeekend) cellCls += ' weekend-col';

        var lastRow = ' style="border-bottom:none"';

        if (!stock.total) {
            cellCls += ' empty';
            html += '<div class="' + cellCls + '"' + lastRow + '><div class="uge-cell-empty-txt">—</div></div>';
        } else {
            var stockLabel = '';
            if (stock.missing > 0 || stock.no_lines > 0) {
                var n = (stock.missing || 0) + (stock.no_lines || 0);
                stockLabel = n + ' uden opskrift';
            } else {
                stockLabel = 'Klar';
            }
            html += '<div class="' + cellCls + '" data-day="' + i + '"' + lastRow + '>' +
                _uoStatusBadge(stock.status, stockLabel) +
                '<div class="uge-cell-sub">' + stock.checked + '/' + stock.total + ' bonner tjekket</div>' +
            '</div>';
        }
    }

    html += '</div>';
    wrap.innerHTML = html;

    // Klik-handlers
    var cells = wrap.querySelectorAll('.uge-cell[data-day]');
    for (var c = 0; c < cells.length; c++) {
        cells[c].addEventListener('click', function() {
            var dayIdx = parseInt(this.getAttribute('data-day'));
            _uoDetailDay = dayIdx;
            _uoRenderDetail(dayIdx);
        });
    }
}

/* ── Status helpers ────────────────────────────────────── */

function _uoStatusBadge(status, label) {
    var cls = 'none';
    if (status === 'green') cls = 'green';
    else if (status === 'orange') cls = 'orange';
    else if (status === 'red') cls = 'red';
    else if (status === 'yellow') cls = 'orange';
    else if (status === 'blue') cls = 'green';
    return '<div class="uge-status ' + cls + '"><div class="uge-status-dot"></div>' + (label || '') + '</div>';
}

function _uoProdLabel(status) {
    if (status === 'green' || status === 'blue') return 'OK';
    if (status === 'orange' || status === 'yellow') return 'Se';
    if (status === 'red') return 'Problem';
    return 'Tom';
}

function _uoStaffLabel(status) {
    if (status === 'green' || status === 'blue') return 'OK';
    if (status === 'orange' || status === 'yellow') return 'Højt';
    if (status === 'red') return 'Understaffed';
    return 'Tom';
}

/* ── Dag-detalje ───────────────────────────────────────── */

function _uoRenderDetail(dayIdx) {
    var wrap = document.getElementById('uoDetailWrap');
    if (!wrap || !_uoData) return;

    var day = _uoData.days[dayIdx];
    if (!day) { wrap.innerHTML = ''; return; }

    // Titel
    var dateObj = new Date(day.date + 'T12:00:00');
    var today = _uoToday();
    var titleDate = _UO_DAYS_LONG[dayIdx] + ' ' + dateObj.getDate() + '. ' + _UO_MONTHS[dateObj.getMonth()] + ' ' + dateObj.getFullYear();
    if (day.date === today) titleDate += ' — I dag';

    // Overall status (worst of prod/staff/stock)
    var overallStatus = _uoWorstStatus([day.production.status, day.staff.status, day.stock.status]);
    var overallLabel = _uoOverallLabel(overallStatus);

    var html = '<div class="uge-detail">';

    // Header
    html += '<div class="uge-detail-header">' +
        '<div class="uge-detail-title">' + titleDate + '</div>';
    if (overallStatus !== 'grey') {
        var badgeCls = overallStatus === 'red' ? 'red' : (overallStatus === 'orange' || overallStatus === 'yellow' ? 'orange' : 'green');
        html += '<div class="uge-status ' + badgeCls + '" style="font-size:11px;margin-left:8px"><div class="uge-status-dot"></div>' + overallLabel + '</div>';
    }
    html += '<div class="uge-detail-close" id="uoDetailClose">✕</div></div>';

    // Body: 3 kolonner
    html += '<div class="uge-detail-body">';

    // ── Produktion ──
    html += '<div class="uge-detail-section">';
    html += '<div class="uge-detail-sec-title">📋 Produktion</div>';
    if (day.bons.length === 0) {
        html += '<div style="font-size:12px;color:var(--color-text-dim);font-style:italic">Ingen bonner</div>';
    } else {
        for (var b = 0; b < day.bons.length; b++) {
            var bon = day.bons[b];
            var feStatus = (typeof statusToFrontend === 'function') ? statusToFrontend(bon.status_code) : '';
            var statusCfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses) ? BON_CONFIG.statuses[feStatus] : null;
            var statusBg = statusCfg ? statusCfg.color : '#999';
            var statusFg = statusCfg ? (statusCfg.text || '#fff') : '#fff';
            var statusLabel = statusCfg ? statusCfg.label : (bon.status_label || bon.status_code);
            html += '<div class="uge-bon-item" data-bon-id="' + bon.id + '" data-bon-number="' + _uoEsc(bon.bon_number || '') + '" title="Klik for info">' +
                '<span class="uge-bon-nr">#' + (bon.bon_number || bon.id) + '</span>' +
                '<span class="uge-bon-customer">' + _uoEsc(bon.customer_name || '—') + '</span>' +
                '<span class="uge-bon-units">' + (bon.workload ? bon.workload + (bon.total_units ? ' enh' : ' pax') : '—') + '</span>' +
                '<span class="uge-bon-status" style="background:' + statusBg + ';color:' + statusFg + '">' + _uoEsc(statusLabel) + '</span>' +
            '</div>';
        }
    }
    html += '</div>';

    // ── Personale ──
    html += '<div class="uge-detail-section">';
    html += '<div class="uge-detail-sec-title">👥 Personale';
    if (day.staff.ratio != null) {
        var ratioColor = day.staff.status === 'red' ? 'var(--color-red)' : (day.staff.status === 'orange' || day.staff.status === 'yellow' ? 'var(--color-orange)' : 'var(--color-text-dim)');
        html += ' &nbsp;<span style="font-weight:400;color:' + ratioColor + ';font-size:10px">' + Math.round(day.staff.ratio) + ' enh/person';
        if (day.staff.status === 'red' || day.staff.status === 'orange' || day.staff.status === 'yellow') html += ' ⚠';
        html += '</span>';
    }
    html += '</div>';

    if (day.shifts.length === 0) {
        html += '<div style="font-size:12px;color:var(--color-text-dim);font-style:italic">Ingen vagter</div>';
    } else {
        for (var s = 0; s < day.shifts.length; s++) {
            var shift = day.shifts[s];
            var shiftCls = 'uge-shift-item' + (shift.is_open ? ' uge-shift-open' : '');
            html += '<div class="' + shiftCls + '">' +
                '<div class="uge-shift-avatar">' + _uoEsc(shift.initials || '?') + '</div>' +
                '<div class="uge-shift-name">' + _uoEsc(shift.name) + '</div>' +
                '<div class="uge-shift-time">' + (shift.start || '') + '–' + (shift.end || '') + '</div>' +
            '</div>';
        }
    }

    // Kapacitets-advarsel
    if (day.staff.status === 'red' || day.staff.status === 'orange' || day.staff.status === 'yellow') {
        var totalUnits = day.production.total_units || 0;
        var staffCount = day.staff.count || 0;
        html += '<div style="margin-top:10px;padding:8px;background:var(--color-orange-bg);border-radius:6px;font-size:11px;color:#a06010;border:1px solid var(--color-orange)">' +
            '⚠ ' + totalUnits + ' enheder med ' + staffCount + ' folk — overvej ekstra vagt</div>';
    }
    html += '</div>';

    // ── Lager ──
    html += '<div class="uge-detail-section">';
    html += '<div class="uge-detail-sec-title">📦 Lager</div>';
    if (day.bons.length === 0) {
        html += '<div style="font-size:12px;color:var(--color-text-dim);font-style:italic">Ingen bonner</div>';
    } else {
        for (var b = 0; b < day.bons.length; b++) {
            var bon = day.bons[b];
            var stockHtml = '';
            if (bon.stock_status === 'ok') {
                stockHtml = '<span class="uge-lager-ok">✓ Opskrifter koblet</span>';
            } else if (bon.stock_status === 'missing') {
                stockHtml = '<span class="uge-lager-warn">⚠ Varer uden opskrift</span>';
            } else {
                stockHtml = '<span class="uge-lager-warn">⚠ Ingen varer tilføjet</span>';
            }
            var shortName = (bon.customer_name || '—');
            if (shortName.length > 15) shortName = shortName.slice(0, 15) + '…';
            html += '<div class="uge-lager-item" data-bon-id="' + bon.id + '" data-bon-number="' + _uoEsc(bon.bon_number || '') + '" title="Klik for info">' +
                '<span>#' + (bon.bon_number || bon.id) + ' ' + _uoEsc(shortName) + '</span>' +
                stockHtml +
            '</div>';
        }
    }
    html += '</div>';

    html += '</div>'; // /detail-body

    // Footer
    html += '<div class="uge-detail-action">' +
        '<button class="btn-sm primary" id="uoOpenPlanning">Åbn planlægning →</button>' +
        '<button class="btn-sm" id="uoSeeBons">Se alle bonner</button>' +
    '</div>';

    html += '</div>'; // /detail
    wrap.innerHTML = html;

    // Event handlers
    document.getElementById('uoDetailClose').onclick = function() {
        _uoDetailDay = null;
        wrap.innerHTML = '';
    };

    // Bon-klik → info-modal (både produktion og lager)
    var bonRows = wrap.querySelectorAll('[data-bon-id]');
    for (var br = 0; br < bonRows.length; br++) {
        bonRows[br].addEventListener('click', function() {
            var bonId = parseInt(this.getAttribute('data-bon-id'));
            var bonNumber = this.getAttribute('data-bon-number') || '';
            if (!bonId || typeof showBonInfo !== 'function') return;
            var infoOpts = { showGotoButton: true, bonNumber: bonNumber };
            if (_uoOptions.openDrawer) {
                infoOpts.showEditButton = true;
                infoOpts.onEdit = _uoOptions.openDrawer;
            }
            showBonInfo(bonId, infoOpts);
        });
    }
    document.getElementById('uoOpenPlanning').onclick = function() {
        // Åbn planlægning med den valgte dag som periode
        if (typeof window.switchView === 'function') {
            var url = new URL(window.location);
            url.searchParams.set('from', day.date);
            url.searchParams.set('to', day.date);
            history.replaceState({}, '', url);
            window.switchView('planning');
        } else {
            window.open('/kitchen/planning.html?from=' + day.date + '&to=' + day.date, '_blank');
        }
    };
    document.getElementById('uoSeeBons').onclick = function() {
        // Skift til bons-listen med dato-filter
        if (typeof window.switchView === 'function') {
            window.switchView('bons');
            // Sæt dato-filter efter switch
            setTimeout(function() {
                if (typeof _blSetDateFilter === 'function') _blSetDateFilter(day.date);
            }, 100);
        }
    };

    // Scroll til detalje
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Detail helpers ────────────────────────────────────── */

function _uoWorstStatus(statuses) {
    var order = { red: 4, orange: 3, yellow: 3, blue: 1, green: 1, grey: 0 };
    var worst = 'grey';
    var worstVal = 0;
    for (var i = 0; i < statuses.length; i++) {
        var v = order[statuses[i]] || 0;
        if (v > worstVal) { worstVal = v; worst = statuses[i]; }
    }
    return worst;
}

function _uoOverallLabel(status) {
    if (status === 'green' || status === 'blue') return 'OK';
    if (status === 'orange' || status === 'yellow') return 'Kræver opmærksomhed';
    if (status === 'red') return 'Problem';
    return '';
}

function _uoEsc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
