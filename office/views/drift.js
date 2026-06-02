/* ════════════════════════════════════════════════════════════
 * office/views/drift.js — Driftsregnskab (MVP-v1)
 * Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §1/§6/§6a. Alle tal EX moms (§3).
 *
 * Dagsvisning: omsætning − vareforbrug − levering − løn = driftsresultat.
 * Realiseret (leverede bonner + faktisk fremmøde) vs forecast (bookede +
 * planlagt vagt). Bud (delivery) ekskluderet fra driftens løn-/rate-tal.
 *
 * Plain script — global initDrift(container) / cleanupDrift().
 * ════════════════════════════════════════════════════════════ */

let _driftState = { date: null, mode: 'realiseret', el: null };

function _drMoney(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
}
function _drNum(n, dec) {
    if (n == null) return '—';
    return Number(n).toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: dec == null ? 1 : dec });
}
function _drPct(n) { return n == null ? '—' : _drNum(n, 1) + ' %'; }
function _drEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function _drTodayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
}
function _drShiftDate(iso, days) {
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
}

function initDrift(container) {
    _driftState.el = container;
    if (!_driftState.date) _driftState.date = _drTodayISO();
    container.innerHTML = '<div class="dr-wrap"><div class="dr-loading">Henter driftsregnskab…</div></div>';
    _drRenderShell();
    _drLoad();
}

function cleanupDrift() { _driftState.el = null; }

function _drRenderShell() {
    var s = _driftState;
    s.el.innerHTML = '' +
        '<div class="dr-wrap">' +
            '<div class="dr-toolbar">' +
                '<button class="dr-nav" id="drPrev">◀</button>' +
                '<input type="date" id="drDate" value="' + _drEsc(s.date) + '">' +
                '<button class="dr-nav" id="drNext">▶</button>' +
                '<button class="dr-today" id="drToday">I dag</button>' +
                '<div class="dr-mode">' +
                    '<button class="dr-mode-btn' + (s.mode === 'realiseret' ? ' active' : '') + '" data-mode="realiseret">Realiseret</button>' +
                    '<button class="dr-mode-btn' + (s.mode === 'forecast' ? ' active' : '') + '" data-mode="forecast">Forecast</button>' +
                '</div>' +
                '<span class="dr-mode-note" id="drModeNote"></span>' +
            '</div>' +
            '<div id="drBody"><div class="dr-loading">Henter…</div></div>' +
        '</div>';

    var byId = function (id) { return s.el.querySelector('#' + id); };
    byId('drDate').addEventListener('change', function (e) { s.date = e.target.value; _drLoad(); });
    byId('drPrev').addEventListener('click', function () { s.date = _drShiftDate(s.date, -1); _drSync(); _drLoad(); });
    byId('drNext').addEventListener('click', function () { s.date = _drShiftDate(s.date, 1); _drSync(); _drLoad(); });
    byId('drToday').addEventListener('click', function () { s.date = _drTodayISO(); _drSync(); _drLoad(); });
    s.el.querySelectorAll('.dr-mode-btn').forEach(function (b) {
        b.addEventListener('click', function (e) { s.mode = e.currentTarget.getAttribute('data-mode'); _drRenderShell(); _drLoad(); });
    });
    byId('drModeNote').textContent = s.mode === 'realiseret'
        ? 'Leverede bonner + faktisk fremmøde'
        : 'Bookede bonner + planlagt vagt';
}

function _drSync() {
    var d = _driftState.el && _driftState.el.querySelector('#drDate');
    if (d) d.value = _driftState.date;
}

function _drLoad() {
    var s = _driftState;
    var body = s.el && s.el.querySelector('#drBody');
    if (!body) return;
    body.innerHTML = '<div class="dr-loading">Henter…</div>';
    var reqDate = s.date, reqMode = s.mode;
    fetchDriftDay(reqDate, reqMode).then(function (d) {
        if (s.date !== reqDate || s.mode !== reqMode) return;   // forældet svar
        _drRender(d);
    }).catch(function (err) {
        body.innerHTML = '<div class="dr-error">Kunne ikke hente: ' + _drEsc(err.message) + '</div>';
    });
}

function _drRender(d) {
    var body = _driftState.el.querySelector('#drBody');
    if (!body) return;

    var resultClass = d.driftsresultat_ex_moms >= 0 ? 'dr-pos' : 'dr-neg';

    var warnings = [];
    if (d.labor_error) warnings.push('Løn kunne ikke hentes (' + _drEsc(d.labor_error) + ') — løn vises som 0.');
    if (d.rate_missing_count) warnings.push('⚠ ' + d.rate_missing_count + ' medarbejder(e) mangler timeløn → driftsresultatet er for højt. Udfyld satser i Settings → Løn.');
    if (d.role_unmapped_count) warnings.push('⚠ ' + d.role_unmapped_count + ' jobtype(r) er ikke kategoriseret (tæller som "other"). Kategorisér i Settings.');
    var warnHtml = warnings.length
        ? '<div class="dr-warn">' + warnings.map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>'
        : '';

    var kpi = function (label, val, cls) {
        return '<div class="dr-kpi ' + (cls || '') + '"><div class="dr-kpi-val">' + val + '</div>' +
               '<div class="dr-kpi-label">' + label + '</div></div>';
    };

    var laborRows = (d.labor_rows || []).map(function (l) {
        var flags = [];
        if (l.rate_missing) flags.push('<span class="dr-flag dr-flag-warn">mangler sats</span>');
        if (l.role_unmapped) flags.push('<span class="dr-flag dr-flag-warn">ukategoriseret</span>');
        if (l.used_fallback_hours) flags.push('<span class="dr-flag">planlagt (ej fremmødt endnu)</span>');
        var roleLabel = { production: 'Produktion', delivery: 'Bud', other: 'Andet' }[l.role_class] || l.role_class;
        return '<tr' + (l.role_class === 'delivery' ? ' class="dr-row-bud"' : '') + '>' +
            '<td>' + _drEsc(l.employee_name) + '</td>' +
            '<td>' + _drEsc(l.jobtype_title || '') + '</td>' +
            '<td><span class="dr-role dr-role-' + l.role_class + '">' + roleLabel + '</span></td>' +
            '<td class="dr-r">' + _drNum(l.timer, 2) + '</td>' +
            '<td class="dr-r">' + (l.sats == null ? '—' : _drMoney(l.sats)) + '</td>' +
            '<td class="dr-r">' + (l.kostpris == null ? '—' : _drMoney(l.kostpris)) + '</td>' +
            '<td>' + flags.join(' ') + '</td>' +
        '</tr>';
    }).join('');
    var laborTable = (d.labor_rows && d.labor_rows.length)
        ? '<table class="dr-labor"><thead><tr><th>Medarbejder</th><th>Jobtype</th><th>Rolle</th>' +
          '<th class="dr-r">Timer</th><th class="dr-r">Sats</th><th class="dr-r">Kostpris</th><th></th></tr></thead>' +
          '<tbody>' + laborRows + '</tbody></table>'
        : '<div class="dr-empty">Ingen vagter registreret for dagen.</div>';

    body.innerHTML = '' +
        warnHtml +
        '<div class="dr-kpis">' +
            kpi('Omsætning (ex moms)', _drMoney(d.revenue_ex_moms)) +
            kpi('Vareforbrug (ex moms)', '−' + _drMoney(d.cost_ex_moms)) +
            kpi('Levering (ex moms)', '−' + _drMoney(d.delivery_ex_moms)) +
            kpi('Løn (ex moms)', '−' + _drMoney(d.labor_ex_moms)) +
            kpi('Driftsresultat (ex moms)', _drMoney(d.driftsresultat_ex_moms), resultClass) +
            kpi('DB%', _drPct(d.db_pct), resultClass) +
        '</div>' +
        '<div class="dr-section-title">Nøgletal</div>' +
        '<div class="dr-metrics">' +
            '<div class="dr-metric"><span>Kapacitetsrate</span><strong>' + _drNum(d.kapacitetsrate, 1) + ' enh/mandetime</strong></div>' +
            '<div class="dr-metric"><span>Lønandel (produktion)</span><strong>' + _drPct(d.loenandel_pct) + '</strong></div>' +
            '<div class="dr-metric"><span>Vareforbrug pr. enhed</span><strong>' + (d.vareforbrug_pr_enhed == null ? '—' : _drMoney(d.vareforbrug_pr_enhed)) + '</strong></div>' +
            '<div class="dr-metric"><span>Enheder</span><strong>' + _drNum(d.units, 0) + '</strong></div>' +
            '<div class="dr-metric"><span>Bonner</span><strong>' + _drNum(d.bon_count, 0) + '</strong></div>' +
            '<div class="dr-metric"><span>Produktionstimer</span><strong>' + _drNum(d.hours_production, 1) + '</strong></div>' +
        '</div>' +
        '<div class="dr-section-title">Bemanding <span class="dr-sub">(bud ekskluderet fra driftens løn + rate)</span></div>' +
        laborTable;
}
