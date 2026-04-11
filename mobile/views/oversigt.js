/**
 * mobile/views/oversigt.js
 * ════════════════════════════════════════════════════════════
 * Travlhedsoverblik (3 dage) + Smartplan vagter.
 * ════════════════════════════════════════════════════════════
 */

var _moContainer = null;

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

    // Fetch bons for 3 days + Smartplan shifts in parallel
    try {
        var fetches = dates.map(function(d) {
            var iso = d.toISOString().slice(0, 10);
            if (i === 0) return apiFetch('/bons?date=today');
            return apiFetch('/bons?date=' + iso);
        });
        fetches.push(
            apiFetch('/smartplan/shifts?from=' + dates[0].toISOString().slice(0,10) + '&to=' + dates[0].toISOString().slice(0,10))
                .catch(function() { return []; })
        );

        // Fix: construct fetches properly
        var fetchPromises = [];
        for (var j = 0; j < dates.length; j++) {
            var iso = dates[j].toISOString().slice(0, 10);
            fetchPromises.push(
                j === 0
                    ? apiFetch('/bons?date=today')
                    : apiFetch('/bons?date=' + iso)
            );
        }
        fetchPromises.push(
            apiFetch('/smartplan/shifts?from=' + dates[0].toISOString().slice(0,10) + '&to=' + dates[0].toISOString().slice(0,10))
                .catch(function() { return []; })
        );

        var results = await Promise.all(fetchPromises);
        var shifts = results[dates.length] || [];

        var html = '';

        // Day cards
        var dayLabels = ['I dag', 'I morgen', 'Overmorgen'];
        for (var k = 0; k < dates.length; k++) {
            var bons = results[k].bons || results[k] || [];
            var totalUnits = 0;
            var statusCounts = {};

            bons.forEach(function(b) {
                totalUnits += (b.total_units || 0);
                var code = (b.status_code || b.status || 'ny').toLowerCase();
                statusCounts[code] = (statusCounts[code] || 0) + 1;
            });

            var dateStr = dates[k].getDate() + '/' + (dates[k].getMonth() + 1);

            html += '<div class="m-overview-card">';
            html += '<div class="m-overview-date">' + dayLabels[k] + ' · ' + dateStr + '</div>';
            html += '<div class="m-overview-stats">';
            html += '<div><div class="m-overview-stat-num">' + bons.length + '</div><div style="font-size:12px;color:var(--color-text-dim)">bons</div></div>';
            html += '<div><div class="m-overview-stat-num">' + totalUnits + '</div><div style="font-size:12px;color:var(--color-text-dim)">enheder</div></div>';
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
            html += '</div>';
        }

        // Smartplan section
        html += '<div class="m-card" style="margin-top:16px">';
        html += '<div class="m-detail-label">I dag på arbejde</div>';

        var shiftList = shifts.shifts || shifts || [];
        if (Array.isArray(shiftList) && shiftList.length) {
            // Sort by start time
            shiftList.sort(function(a, b) {
                return (a.start_time || a.start || '').localeCompare(b.start_time || b.start || '');
            });

            shiftList.forEach(function(shift) {
                var name = shift.first_name || (shift.owner && shift.owner.first_name) || shift.employee_name || '?';
                var startT = (shift.start_time || shift.start || '').slice(11, 16);
                var endT = (shift.end_time || shift.end || '').slice(11, 16);

                html += '<div class="m-shift-item">' +
                    '<span class="m-shift-name">' + _moEsc(name) + '</span>' +
                    '<span class="m-shift-time">' + startT + ' – ' + endT + '</span>' +
                '</div>';
            });
        } else {
            html += '<div style="padding:12px 0;color:var(--color-text-dim);font-size:14px">Ingen vagter fundet</div>';
        }

        html += '</div>';

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
