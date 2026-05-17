/**
 * mobile/views/oversigt.js
 * ════════════════════════════════════════════════════════════
 * Travlhedsoverblik over en valgt periode (14 dage eller måned)
 * med Smartplan-vagter pr. dag. Hver dag-kort er klikbart og
 * åbner bons-viewet filtreret til den dato.
 *
 * Periode + offset huskes i localStorage.
 * ════════════════════════════════════════════════════════════
 */

var _moContainer = null;
var _moPeriod    = '14';   // '14' eller 'month'
var _moOffset    = 0;      // 0 = nuværende periode, 1 = næste, -1 = forrige

var _MO_LS_PERIOD = 'mobileOversigtPeriod';

function _moIsoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
}

function _moAddDays(d, n) {
    var x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

/* Beregn periodens [from, to] datoer ud fra periode + offset. */
function _moPeriodRange() {
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    if (_moPeriod === 'month') {
        // Kalendermåned: offset 0 = denne måned, 1 = næste, -1 = forrige
        var first = new Date(today.getFullYear(), today.getMonth() + _moOffset, 1);
        var last  = new Date(today.getFullYear(), today.getMonth() + _moOffset + 1, 0);
        return { from: first, to: last };
    }

    // 14-dages rullende vindue: offset 0 = i dag → 13 dage frem
    var from = _moAddDays(today, _moOffset * 14);
    var to   = _moAddDays(from, 13);
    return { from: from, to: to };
}

function _moRangeLabel(from, to) {
    if (_moPeriod === 'month') {
        var months = ['januar', 'februar', 'marts', 'april', 'maj', 'juni',
                      'juli', 'august', 'september', 'oktober', 'november', 'december'];
        return months[from.getMonth()] + ' ' + from.getFullYear();
    }
    var sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
    if (sameMonth) {
        return from.getDate() + '.–' + to.getDate() + '/' + (to.getMonth() + 1);
    }
    return from.getDate() + '/' + (from.getMonth() + 1) +
           ' – ' + to.getDate() + '/' + (to.getMonth() + 1);
}

function _moDayList(from, to) {
    var dates = [];
    var d = new Date(from);
    while (d <= to) {
        dates.push(new Date(d));
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

async function initMobileOversigt(container) {
    _moContainer = container;

    // Hent periode-præference fra localStorage
    try {
        var stored = localStorage.getItem(_MO_LS_PERIOD);
        if (stored === '14' || stored === 'month') _moPeriod = stored;
    } catch (e) { /* ignorer */ }
    // Reset offset hver gang viewet åbnes
    _moOffset = 0;

    await _moRender();
}

async function _moRender() {
    if (!_moContainer) return;

    var range = _moPeriodRange();
    var fromIso = _moIsoDate(range.from);
    var toIso   = _moIsoDate(range.to);

    _moContainer.innerHTML = _moRenderToolbar(range) +
        '<div id="moBody"><div class="m-loading">Henter overblik...</div></div>';

    _moAttachToolbarHandlers();

    var body = document.getElementById('moBody');
    if (!body) return;

    var statuses = 'NY,VENTER,GODKENDT,IGANG,KLAR,LEVERET,FAKTURERET,AFSLUTTET,BETALT';

    try {
        var results = await Promise.all([
            apiFetch('/bons?date_from=' + fromIso + '&date_to=' + toIso +
                     '&status=' + statuses + '&limit=500'),
            apiFetch('/smartplan/shifts?from=' + fromIso + '&to=' + toIso)
                .catch(function() { return []; })
        ]);

        var allBons = Array.isArray(results[0]) ? results[0] : (results[0].bons || []);
        var allShifts = results[1] || [];
        if (!Array.isArray(allShifts)) allShifts = allShifts.shifts || [];

        // Gruppér bons + shifts pr. dato
        var bonsByDate = {};
        allBons.forEach(function(b) {
            var d = b.delivery_date;
            if (!d) return;
            if (!bonsByDate[d]) bonsByDate[d] = [];
            bonsByDate[d].push(b);
        });
        var shiftsByDate = {};
        allShifts.forEach(function(s) {
            var d = s.date;
            if (!d) return;
            if (!shiftsByDate[d]) shiftsByDate[d] = [];
            shiftsByDate[d].push(s);
        });

        body.innerHTML = _moRenderDays(_moDayList(range.from, range.to), bonsByDate, shiftsByDate);
        _moAttachDayClickHandlers();
    } catch (e) {
        body.innerHTML = '<div class="m-bon-empty">Kunne ikke hente overblik</div>';
    }
}

function _moRenderToolbar(range) {
    var label = _moRangeLabel(range.from, range.to);
    return (
        '<div class="m-overview-toolbar">' +
            '<div class="m-overview-period-tabs">' +
                '<button class="m-overview-period-tab' + (_moPeriod === '14'    ? ' active' : '') + '" data-period="14">14 dage</button>' +
                '<button class="m-overview-period-tab' + (_moPeriod === 'month' ? ' active' : '') + '" data-period="month">Måned</button>' +
            '</div>' +
            '<div class="m-overview-nav">' +
                '<button class="m-overview-nav-btn" data-step="-1" aria-label="Forrige">&#9664;</button>' +
                '<div class="m-overview-nav-label">' + label + '</div>' +
                '<button class="m-overview-nav-btn" data-step="1" aria-label="Næste">&#9654;</button>' +
            '</div>' +
        '</div>'
    );
}

function _moAttachToolbarHandlers() {
    _moContainer.querySelectorAll('.m-overview-period-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var p = btn.dataset.period;
            if (p === _moPeriod) return;
            _moPeriod = p;
            _moOffset = 0;
            try { localStorage.setItem(_MO_LS_PERIOD, p); } catch (e) { /* ignorer */ }
            _moRender();
        });
    });
    _moContainer.querySelectorAll('.m-overview-nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            _moOffset += parseInt(btn.dataset.step) || 0;
            _moRender();
        });
    });
}

function _moRenderDays(dates, bonsByDate, shiftsByDate) {
    var dayNames = ['Søn','Man','Tir','Ons','Tor','Fre','Lør'];
    var todayIso = _moIsoDate(new Date());

    var html = '';
    var currentWeek = null;

    dates.forEach(function(d) {
        var iso = _moIsoDate(d);
        var bons = bonsByDate[iso] || [];
        var shifts = (shiftsByDate[iso] || []).slice().sort(function(a, b) {
            return (a.start_time || '').localeCompare(b.start_time || '');
        });

        // Ugedivider når perioden skifter uge
        var weekNum = _moIsoWeek(d);
        if (weekNum !== currentWeek) {
            html += '<div class="m-overview-week-divider">Uge ' + weekNum + '</div>';
            currentWeek = weekNum;
        }

        var totalUnits = 0;
        var statusCounts = {};
        bons.forEach(function(b) {
            var units = (b.total_units && b.total_units > 0) ? b.total_units : (b.pax || 0);
            totalUnits += units;
            var code = (b.status_code || b.status || 'ny').toLowerCase();
            statusCounts[code] = (statusCounts[code] || 0) + 1;
        });

        var isToday = iso === todayIso;
        var isPast  = iso < todayIso;
        var isWeekend = d.getDay() === 0 || d.getDay() === 6;

        var classes = 'm-overview-day';
        if (isToday) classes += ' is-today';
        if (isPast)  classes += ' is-past';
        if (isWeekend) classes += ' is-weekend';
        if (!bons.length && !shifts.length) classes += ' is-empty';

        var dayLabel = dayNames[d.getDay()];
        var dateLabel = d.getDate() + '/' + (d.getMonth() + 1);

        html += '<div class="' + classes + '" data-date="' + iso + '" role="button" tabindex="0">' +
            '<div class="m-overview-day-head">' +
                '<div class="m-overview-day-when">' +
                    '<span class="m-overview-day-dow">' + dayLabel + '</span> ' +
                    '<span class="m-overview-day-date">' + dateLabel + '</span>' +
                    (isToday ? ' <span class="m-overview-day-today">I dag</span>' : '') +
                '</div>' +
                '<div class="m-overview-day-stats">' +
                    '<span><strong>' + bons.length + '</strong> bons</span>' +
                    '<span><strong>' + totalUnits + '</strong> enh.</span>' +
                    '<span><strong>' + shifts.length + '</strong> vagter</span>' +
                '</div>' +
            '</div>';

        if (Object.keys(statusCounts).length) {
            html += '<div class="m-overview-day-badges">';
            Object.keys(statusCounts).forEach(function(code) {
                var s = BON_CONFIG.statuses[code] || { color: '#ccc', text: '#333', label: code };
                html += '<span class="m-bon-badge m-bon-badge-mini" style="background:' + s.color + ';color:' + s.text + '">' +
                    statusCounts[code] + ' ' + s.label + '</span>';
            });
            html += '</div>';
        }

        if (shifts.length) {
            html += '<div class="m-overview-day-shifts">';
            shifts.forEach(function(shift) {
                var name = shift.first_name || shift.employee_name || '?';
                var startT = (shift.start_time || '').slice(0, 5);
                var endT = (shift.end_time || '').slice(0, 5);
                html += '<span class="m-overview-shift-pill">' +
                    _moEsc(name) +
                    (startT ? ' <span class="m-overview-shift-time">' + startT + (endT ? '–' + endT : '') + '</span>' : '') +
                    '</span>';
            });
            html += '</div>';
        }

        html += '</div>';
    });

    return html;
}

function _moAttachDayClickHandlers() {
    _moContainer.querySelectorAll('.m-overview-day').forEach(function(el) {
        function open() {
            var iso = el.dataset.date;
            if (!iso) return;
            // Sæt URL-param og skift view — bons.js læser bon_date ved init
            var params = new URLSearchParams(window.location.search);
            params.set('view', 'bons');
            params.set('bon_date', iso);
            params.delete('bon');
            history.pushState(null, '', '?' + params.toString());
            if (window._mSwitchView) window._mSwitchView('bons');
        }
        el.addEventListener('click', open);
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
    });
}

/* ISO ugenummer */
function _moIsoWeek(d) {
    var dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var dayNum = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function _moEsc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
