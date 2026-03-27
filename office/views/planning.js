/**
 * office/views/planning.js
 * ════════════════════════════════════════════════════════════
 * Office planlægnings-view — wrapper around shared/planning.js.
 *
 * API:
 *   initOfficePlanning(containerEl, { openDrawer })
 *   cleanupOfficePlanning()
 *
 * Afhængigheder (load order):
 *   shared/planning.js  → initPlanning
 *   BonConfig.js        → BON_CONFIG
 * ════════════════════════════════════════════════════════════
 */

var _opContainer = null;

function initOfficePlanning(containerEl, options) {
    _opContainer = containerEl;
    var _opOptions = options || {};

    var wrap = document.createElement('div');
    wrap.className = 'office-planning-wrap';
    containerEl.appendChild(wrap);

    initPlanning(wrap, {
        zone: 'office',
        onEdit: function(bonId) {
            if (_opOptions.openDrawer) _opOptions.openDrawer(bonId);
        }
    });
}

function cleanupOfficePlanning() {
    _opContainer = null;
}
