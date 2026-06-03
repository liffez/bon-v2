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
function _drMonday(iso) {
    var d = new Date(iso + 'T12:00:00');
    var day = d.getDay();                       // 0=søn
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
}
function _drISOWeek(iso) {
    var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
    var dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function _drFmtRange(from, to) {
    var f = from.slice(8, 10) + '.' + from.slice(5, 7);
    var t = to.slice(8, 10) + '.' + to.slice(5, 7) + '.' + to.slice(0, 4);
    return f + '–' + t;
}

function initDrift(container) {
    _driftState.el = container;
    if (!_driftState.date) _driftState.date = _drTodayISO();
    if (!_driftState.view) _driftState.view = 'day';
    if (!_driftState.to)   { _driftState.to = _drShiftDate(_drTodayISO(), -1); _driftState.from = _drShiftDate(_driftState.to, -6); }
    if (!_driftState.weekFrom) _driftState.weekFrom = _drMonday(_drTodayISO());
    container.innerHTML = '<div class="dr-wrap"><div class="dr-loading">Henter driftsregnskab…</div></div>';
    _drRenderShell();
}

function cleanupDrift() { _driftState.el = null; }

function _drRenderShell() {
    var s = _driftState;
    var viewToggle =
        '<div class="dr-view-toggle">' +
            '<button class="dr-view-btn' + (s.view === 'day' ? ' active' : '') + '" data-view="day">📅 Dag</button>' +
            '<button class="dr-view-btn' + (s.view === 'week' ? ' active' : '') + '" data-view="week">📆 Uge</button>' +
            '<button class="dr-view-btn' + (s.view === 'period' ? ' active' : '') + '" data-view="period">📈 Periode</button>' +
        '</div>';
    var modeBtns =
        '<div class="dr-mode">' +
            '<button class="dr-mode-btn' + (s.mode === 'realiseret' ? ' active' : '') + '" data-mode="realiseret">Realiseret</button>' +
            '<button class="dr-mode-btn' + (s.mode === 'forecast' ? ' active' : '') + '" data-mode="forecast">Forecast</button>' +
        '</div>';

    var weekTo = _drShiftDate(s.weekFrom, 6);
    var weekLabel = 'Uge ' + _drISOWeek(s.weekFrom) + ' · ' + _drFmtRange(s.weekFrom, weekTo);

    var toolbar;
    if (s.view === 'period') {
        toolbar = '<div class="dr-toolbar">' + viewToggle +
            '<label class="dr-pl">Fra <input type="date" id="drFrom" value="' + _drEsc(s.from) + '"></label>' +
            '<label class="dr-pl">Til <input type="date" id="drTo" value="' + _drEsc(s.to) + '"></label>' +
            modeBtns +
          '</div>';
    } else if (s.view === 'week') {
        toolbar = '<div class="dr-toolbar">' + viewToggle +
            '<button class="dr-nav" id="drWeekPrev">◀</button>' +
            '<span class="dr-week-label" id="drWeekLabel">' + _drEsc(weekLabel) + '</span>' +
            '<button class="dr-nav" id="drWeekNext">▶</button>' +
            '<button class="dr-today" id="drWeekToday">Denne uge</button>' +
            modeBtns +
          '</div>';
    } else {
        toolbar = '<div class="dr-toolbar">' + viewToggle +
            '<button class="dr-nav" id="drPrev">◀</button>' +
            '<input type="date" id="drDate" value="' + _drEsc(s.date) + '">' +
            '<button class="dr-nav" id="drNext">▶</button>' +
            '<button class="dr-today" id="drToday">I dag</button>' +
            modeBtns +
            '<span class="dr-mode-note" id="drModeNote"></span>' +
          '</div>';
    }

    s.el.innerHTML = '<div class="dr-wrap">' + toolbar + '<div id="drBody"><div class="dr-loading">Henter…</div></div></div>';

    var byId = function (id) { return s.el.querySelector('#' + id); };
    s.el.querySelectorAll('.dr-view-btn').forEach(function (b) {
        b.addEventListener('click', function (e) { s.view = e.currentTarget.getAttribute('data-view'); _drRenderShell(); });
    });
    s.el.querySelectorAll('.dr-mode-btn').forEach(function (b) {
        b.addEventListener('click', function (e) { s.mode = e.currentTarget.getAttribute('data-mode'); _drRenderShell(); });
    });

    if (s.view === 'period') {
        byId('drFrom').addEventListener('change', function (e) { s.from = e.target.value; _drLoadPeriod(); });
        byId('drTo').addEventListener('change', function (e) { s.to = e.target.value; _drLoadPeriod(); });
        _drLoadPeriod();
    } else if (s.view === 'week') {
        byId('drWeekPrev').addEventListener('click', function () { s.weekFrom = _drShiftDate(s.weekFrom, -7); _drLoadWeek(); });
        byId('drWeekNext').addEventListener('click', function () { s.weekFrom = _drShiftDate(s.weekFrom, 7); _drLoadWeek(); });
        byId('drWeekToday').addEventListener('click', function () { s.weekFrom = _drMonday(_drTodayISO()); _drLoadWeek(); });
        _drLoadWeek();
    } else {
        byId('drDate').addEventListener('change', function (e) { s.date = e.target.value; _drLoad(); });
        byId('drPrev').addEventListener('click', function () { s.date = _drShiftDate(s.date, -1); _drSync(); _drLoad(); });
        byId('drNext').addEventListener('click', function () { s.date = _drShiftDate(s.date, 1); _drSync(); _drLoad(); });
        byId('drToday').addEventListener('click', function () { s.date = _drTodayISO(); _drSync(); _drLoad(); });
        byId('drModeNote').textContent = s.mode === 'realiseret' ? 'Leverede bonner + faktisk fremmøde' : 'Bookede bonner + planlagt vagt';
        _drLoad();
    }
}

function _drSync() {
    var d = _driftState.el && _driftState.el.querySelector('#drDate');
    if (d) d.value = _driftState.date;
}

// ── Uge-visning: snap til man–søn, genbrug periode-renderingen ──
function _drLoadWeek() {
    var s = _driftState;
    s.from = s.weekFrom;
    s.to = _drShiftDate(s.weekFrom, 6);
    var lbl = s.el && s.el.querySelector('#drWeekLabel');
    if (lbl) lbl.textContent = 'Uge ' + _drISOWeek(s.weekFrom) + ' · ' + _drFmtRange(s.from, s.to);
    _drLoadPeriod();
}

// ── Periode-trend ──────────────────────────────────────────
// Blød grænse: over dette antal dage er driftsresultatet tungt at beregne
// (dag-for-dag). Vi henter ikke automatisk — brugeren skal bekræfte, og får
// samtidig en genvej til den lette Økonomi-rapport.
var DR_PERIOD_SOFT = 62;

function _drDaySpan(from, to) {
    // UTC-midnat → DST-immun (jan→maj krydser sommertid og ville ellers tælle 1 for lidt)
    var a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
}

function _drPeriodHeavyNotice(span) {
    return '<div class="dr-heavy">' +
        '<div class="dr-heavy-title">Lang periode — ' + span + ' dage</div>' +
        '<p class="dr-heavy-text">Driftsresultatet beregnes <strong>dag-for-dag</strong> ' +
            '(omsætning, vareforbrug, levering og løn pr. dag). For lange perioder kan det tage et øjeblik. ' +
            'Skal du bare bruge den overordnede omsætnings-trend, er Økonomi-rapporten hurtigere.</p>' +
        '<div class="dr-heavy-actions">' +
            '<a class="dr-heavy-pill" id="drPeriodRapporter" href="#">📊 Se omsætnings-trend i Økonomi →</a>' +
            '<button class="dr-heavy-go" id="drPeriodGo">Beregn alligevel</button>' +
        '</div>' +
    '</div>';
}

function _drLoadPeriod() {
    var s = _driftState;
    var body = s.el && s.el.querySelector('#drBody');
    if (!body) return;
    if (!s.from || !s.to || s.from > s.to) { body.innerHTML = '<div class="dr-error">Vælg en gyldig periode (fra ≤ til).</div>'; return; }

    var span = _drDaySpan(s.from, s.to);
    var key = s.from + '|' + s.to;
    // Over blød grænse + ikke bekræftet for præcis dette interval → vis notice
    // i stedet for at hente. Skifter brugeren dato, matcher nøglen ikke → re-prompt.
    if (span > DR_PERIOD_SOFT && s.periodConfirmed !== key) {
        body.innerHTML = _drPeriodHeavyNotice(span);
        var go = body.querySelector('#drPeriodGo');
        if (go) go.addEventListener('click', function () { s.periodConfirmed = key; _drLoadPeriod(); });
        var rap = body.querySelector('#drPeriodRapporter');
        if (rap) rap.addEventListener('click', function (e) {
            e.preventDefault();
            if (window.switchSection) window.switchSection('okonomi', 'rap');
        });
        return;
    }

    body.innerHTML = '<div class="dr-loading">Beregner ' + span + ' dage… et øjeblik.</div>';
    var rf = s.from, rt = s.to, rm = s.mode;
    fetchDriftPeriod(rf, rt, rm).then(function (p) {
        if (s.from !== rf || s.to !== rt || s.mode !== rm) return;   // forældet svar
        _drRenderPeriod(p);
    }).catch(function (err) {
        body.innerHTML = '<div class="dr-error">Kunne ikke hente: ' + _drEsc(err.message) + '</div>';
    });
}

function _drRenderPeriod(p) {
    var body = _driftState.el.querySelector('#drBody');
    if (!body) return;
    var t = p.totals || {};
    var days = p.days || [];
    var resultCls = (t.driftsresultat_ex_moms >= 0) ? 'dr-pos' : 'dr-neg';

    var kpi = function (label, val, cls) {
        return '<div class="dr-kpi ' + (cls || '') + '"><div class="dr-kpi-val">' + val + '</div><div class="dr-kpi-label">' + label + '</div></div>';
    };

    // Trend: driftsresultat pr. dag (søjler, grøn/rød), skaleret til største |beløb|
    var maxAbs = Math.max.apply(null, [1].concat(days.map(function (d) { return Math.abs(d.driftsresultat_ex_moms || 0); })));
    var bars = days.map(function (d) {
        var v = d.driftsresultat_ex_moms || 0;
        var h = Math.round(Math.abs(v) / maxAbs * 100);
        var dd = d.date.slice(8, 10) + '/' + d.date.slice(5, 7);
        return '<div class="dr-tr-col" title="' + d.date + ': ' + _drMoney(v) + ' ex moms' + (d.frozen ? ' (frosset)' : '') + '">' +
            '<div class="dr-tr-bar ' + (v >= 0 ? 'dr-tr-pos' : 'dr-tr-neg') + '" style="height:' + h + '%"></div>' +
            '<div class="dr-tr-day">' + dd + (d.frozen ? ' 🔒' : '') + '</div>' +
        '</div>';
    }).join('');

    var rows = days.map(function (d) {
        return '<tr>' +
            '<td>' + d.date + (d.frozen ? ' <span class="dr-flag">🔒</span>' : '') + '</td>' +
            '<td class="dr-r">' + _drMoney(d.revenue_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drMoney(d.cost_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drMoney(d.delivery_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drMoney(d.labor_ex_moms) + '</td>' +
            '<td class="dr-r ' + ((d.driftsresultat_ex_moms >= 0) ? 'dr-pos' : 'dr-neg') + '">' + _drMoney(d.driftsresultat_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drPct(d.db_pct) + '</td>' +
            '<td class="dr-r">' + _drNum(d.units, 0) + '</td>' +
        '</tr>';
    }).join('');

    body.innerHTML = '' +
        '<div class="dr-kpis">' +
            kpi('Omsætning (ex moms)', _drMoney(t.revenue_ex_moms)) +
            kpi('Vareforbrug (ex moms)', '−' + _drMoney(t.cost_ex_moms)) +
            kpi('Levering (ex moms)', '−' + _drMoney(t.delivery_ex_moms)) +
            kpi('Løn (ex moms)', '−' + _drMoney(t.labor_ex_moms)) +
            kpi('Driftsresultat (ex moms)', _drMoney(t.driftsresultat_ex_moms), resultCls) +
            kpi('DB%', _drPct(t.db_pct), resultCls) +
            kpi('Enheder', _drNum(t.units, 0)) +
        '</div>' +
        '<div class="dr-section-title">Driftsresultat pr. dag <span class="dr-sub">(' + (t.day_count || 0) + ' dage · ex moms)</span></div>' +
        '<div class="dr-trend">' + (days.length ? bars : '<div class="dr-empty">Ingen dage.</div>') + '</div>' +
        '<div class="dr-section-title">Dag-for-dag</div>' +
        '<table class="dr-labor"><thead><tr><th>Dato</th><th class="dr-r">Omsætning</th><th class="dr-r">Vareforbrug</th>' +
            '<th class="dr-r">Levering</th><th class="dr-r">Løn</th><th class="dr-r">Driftsresultat</th><th class="dr-r">DB%</th><th class="dr-r">Enh.</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>';
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

    var frozenHtml = '';
    if (d.frozen) {
        frozenHtml = '<div class="dr-frozen">' +
            '<span>🔒 Frosset ' + (d.frozen_at ? _drEsc(String(d.frozen_at).slice(0, 16).replace('T', ' ')) : '') +
            ' — tallene skrider ikke ved senere Smartplan-ændringer.</span>' +
            (d.can_refreeze ? '<button class="dr-refreeze" id="drRefreeze">🔓 Genberegn fra live</button>'
                            : '<span class="dr-frozen-note">Kun admin kan genberegne.</span>') +
            '</div>';
    }

    body.innerHTML = '' +
        frozenHtml +
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
        _drTimelineHtml(d.timeline) +
        '<div class="dr-section-title">Bemanding <span class="dr-sub">(bud ekskluderet fra driftens løn + rate)</span></div>' +
        laborTable;

    var rf = body.querySelector('#drRefreeze');
    if (rf) rf.addEventListener('click', _drRefreeze);
}

function _drRefreeze() {
    var s = _driftState;
    var btn = s.el && s.el.querySelector('#drRefreeze');
    if (btn) { btn.disabled = true; btn.textContent = 'Genberegner…'; }
    refreezeDriftDay(s.date).then(function (d) {
        if (s.date === d.date) _drRender(d);
    }).catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '🔓 Genberegn fra live'; }
        alert('Kunne ikke genberegne: ' + err.message);
    });
}

// Belastnings-tidslinje (§8): enheder/time (søjle) vs produktions-mandetimer/time (søjle).
// Røde timer = belastning uden bemanding (underbemandet).
function _drTimelineHtml(tl) {
    if (!tl || !tl.length) return '';
    var maxU = Math.max.apply(null, [1].concat(tl.map(function (t) { return t.units; })));
    var maxM = Math.max.apply(null, [0.5].concat(tl.map(function (t) { return t.manhours; })));
    var cols = tl.map(function (t) {
        var uh = Math.round(t.units / maxU * 100);
        var mh = Math.round(t.manhours / maxM * 100);
        var under = t.units > 0 && t.manhours <= 0;
        return '<div class="dr-tl-col' + (under ? ' dr-tl-under' : '') + '">' +
            '<div class="dr-tl-bars">' +
                '<div class="dr-tl-bar dr-tl-units" style="height:' + uh + '%" title="' + _drNum(t.units, 0) + ' enheder"></div>' +
                '<div class="dr-tl-bar dr-tl-man" style="height:' + mh + '%" title="' + _drNum(t.manhours, 1) + ' mandetimer"></div>' +
            '</div>' +
            '<div class="dr-tl-hour">' + t.hour + '</div>' +
        '</div>';
    }).join('');
    return '<div class="dr-section-title">Belastnings-tidslinje ' +
        '<span class="dr-sub">(<i class="dr-lg dr-lg-u"></i> enheder · <i class="dr-lg dr-lg-m"></i> produktions-mandetimer, pr. time)</span></div>' +
        '<div class="dr-timeline">' + cols + '</div>';
}
