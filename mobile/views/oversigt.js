/**
 * mobile/views/oversigt.js
 * ════════════════════════════════════════════════════════════
 * Travlhedsoverblik (3 dage) + Smartplan vagter per dag.
 * ════════════════════════════════════════════════════════════
 */

var _moContainer = null;

function _moIsoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
}

async function initMobileOversigt(container) {
    _moContainer = container;
    container.innerHTML = '<div class="m-loading">Henter overblik...</div>';

    var today = new Date();
    var dates = [];
    for (var i = 0; i < 3; i++) {
        var d = new Date(today);
        d.setDate(d.getDate() + i);
        dates.push(d);
    }

    var fromIso = _moIsoDate(dates[0]);
    var toIso = _moIsoDate(dates[2]);

    try {
        var fetchPromises = [];
        for (var j = 0; j < dates.length; j++) {
            var iso = _moIsoDate(dates[j]);
            fetchPromises.push(
                j === 0
                    ? apiFetch('/bons?date=today')
                    : apiFetch('/bons?date=' + iso)
            );
        }
        fetchPromises.push(
            apiFetch('/smartplan/shifts?from=' + fromIso + '&to=' + toIso)
                .catch(function() { return []; })
        );

        var results = await Promise.all(fetchPromises);
        var allShifts = results[dates.length] || [];
        if (!Array.isArray(allShifts)) allShifts = allShifts.shifts || [];

        // Gruppér vagter per dato
        var shiftsByDate = {};
        allShifts.forEach(function(s) {
            var d = s.date;
            if (!d) return;
            if (!shiftsByDate[d]) shiftsByDate[d] = [];
            shiftsByDate[d].push(s);
        });

        var html = '';
        var dayLabels = ['I dag', 'I morgen', 'Overmorgen'];

        for (var k = 0; k < dates.length; k++) {
            var bons = results[k].bons || results[k] || [];
            var totalUnits = 0;
            var statusCounts = {};

            bons.forEach(function(b) {
                // Fallback til pax hvis enheder ikke er sat (samme regel som kalender + ugeoversigt)
                var units = (b.total_units && b.total_units > 0) ? b.total_units : (b.pax || 0);
                totalUnits += units;
                var code = (b.status_code || b.status || 'ny').toLowerCase();
                statusCounts[code] = (statusCounts[code] || 0) + 1;
            });

            var iso = _moIsoDate(dates[k]);
            var dayShifts = (shiftsByDate[iso] || []).slice().sort(function(a, b) {
                return (a.start_time || '').localeCompare(b.start_time || '');
            });

            var dateStr = dates[k].getDate() + '/' + (dates[k].getMonth() + 1);

            html += '<div class="m-overview-card">';
            html += '<div class="m-overview-date">' + dayLabels[k] + ' · ' + dateStr + '</div>';
            html += '<div class="m-overview-stats">';
            html += '<div><div class="m-overview-stat-num">' + bons.length + '</div><div style="font-size:12px;color:var(--color-text-dim)">bons</div></div>';
            html += '<div><div class="m-overview-stat-num">' + totalUnits + '</div><div style="font-size:12px;color:var(--color-text-dim)">enheder</div></div>';
            html += '<div><div class="m-overview-stat-num">' + dayShifts.length + '</div><div style="font-size:12px;color:var(--color-text-dim)">vagter</div></div>';
            html += '</div>';

            // Status badges
            if (Object.keys(statusCounts).length) {
                html += '<div class="m-overview-badges">';
                Object.keys(statusCounts).forEach(function(code) {
                    var s = BON_CONFIG.statuses[code] || { color: '#ccc', text: '#333', label: code };
                    html += '<span class="m-bon-badge" style="background:' + s.color + ';color:' + s.text + ';font-size:10px">' +
                        statusCounts[code] + ' ' + s.label + '</span>';
                });
                html += '</div>';
            }

            // Vagter for dagen
            html += '<div class="m-overview-shifts">';
            html += '<div class="m-overview-shifts-label">P\u00e5 arbejde</div>';
            if (dayShifts.length) {
                dayShifts.forEach(function(shift) {
                    var name = shift.first_name || shift.employee_name || '?';
                    var startT = shift.start_time || '';
                    var endT = shift.end_time || '';
                    html += '<div class="m-shift-item">' +
                        '<span class="m-shift-name">' + _moEsc(name) + '</span>' +
                        '<span class="m-shift-time">' + startT + (endT ? ' – ' + endT : '') + '</span>' +
                        '</div>';
                });
            } else {
                html += '<div class="m-overview-shifts-empty">Ingen vagter</div>';
            }
            html += '</div>';

            html += '</div>';
        }

        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = '<div class="m-bon-empty">Kunne ikke hente overblik</div>';
    }
}

function _moEsc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
