/**
 * office/views/planning-ny.js — Planlægning (ny), wrapper om shared/planning_drill.js
 *
 * Står ved siden af den gamle planlægning (pillen "Planlægning") indtil den nye
 * er godkendt i drift. SSE kommer fra office' globale dispatch (_pdHandleSSE).
 */
function initOfficePlanningNy(containerEl, options) {
    var wrap = document.createElement('div');
    wrap.className = 'office-planning-ny-wrap';
    containerEl.appendChild(wrap);
    initPlanningDrill(wrap, {
        zone: 'office',
        onEdit: function (bonId) { if (options && options.openDrawer) options.openDrawer(bonId); },
    });
}

function cleanupOfficePlanningNy() {
    if (typeof cleanupPlanningDrill === 'function') cleanupPlanningDrill();
}
