/**
 * office/views/bons-calendar.js
 * ════════════════════════════════════════════════════════════
 * Office kalender-view — wrapper around shared/calendar.js.
 *
 * API:
 *   initOfficeCalendar(containerEl, { openDrawer, openNewBon })
 *   cleanupOfficeCalendar()
 *
 * Afhængigheder (load order):
 *   shared/calendar.js  → initCalendar
 *   shared/modal.js     → showBonInfo
 *   shared/api.js
 *   BonConfig.js        → BON_CONFIG
 * ════════════════════════════════════════════════════════════
 */

var _ocContainer = null;
var _ocOptions   = {};

function initOfficeCalendar(containerEl, options) {
    _ocContainer = containerEl;
    _ocOptions   = options || {};

    // Wrap in a div so calendar.js can own it
    var wrap = document.createElement('div');
    wrap.className = 'office-calendar-wrap';
    containerEl.appendChild(wrap);

    initCalendar(wrap, {
        zone: 'office',
        showStaff: true,
        onEdit: function(bonId) {
            if (_ocOptions.openDrawer) _ocOptions.openDrawer(bonId);
        }
    });

    // Wire "Ny bon" button (rendered inside calendar header by calendar.js)
    var nyBonBtn = document.getElementById('calNyBon');
    if (nyBonBtn && _ocOptions.openNewBon) {
        nyBonBtn.addEventListener('click', function() {
            _ocOptions.openNewBon();
        });
    }
}

function cleanupOfficeCalendar() {
    _ocContainer = null;
}
