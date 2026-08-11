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
// Lille tekst under Løn-kortet: erstatter "ex moms" (der aldrig er moms på løn)
// med den rå brutto-løn FØR arbejdsgiver-tillæg, så man ser hvad der ligger bag.
function _drLoenSub(d) {
    if (d.labor_raw_ex_moms == null) return '';                          // ældre opgørelse uden rå-tal
    if (!(d.labor_overhead_pct > 0)) return 'rå løn · intet løntillæg sat';
    return 'rå −' + _drMoney(d.labor_raw_ex_moms) + ' + ' + _drNum(d.labor_overhead_pct, 1) + ' % tillæg';
}
// Branche-nøgletal: løn% og råvare% (vareforbrugsprocent) = andel af omsætningen.
// Udledes HER i frontenden af tal der allerede ligger i svaret — ikke som nye
// felter på API'et. Grunden: afsluttede dage fryses som `data_json`
// (labor_day_snapshot), og et nyt server-felt ville mangle i alle eksisterende
// snapshots. Udledningen virker på både live-svar, frosne snapshots og
// periode-totaler. Det er et rent forhold mellem to tal der ALLEREDE er ex moms
// — ingen moms-regning i frontenden (jf. §6b).
function _drShareOf(part, revenue) {
    if (part == null || !(revenue > 0)) return null;
    return part / revenue * 100;
}
// Sub-linje til en KPI-pille: "28,4 % af omsætning" (tom hvis omsætning = 0).
function _drShareSub(part, revenue) {
    var p = _drShareOf(part, revenue);
    if (p == null) return '';
    return '<span class="dr-share">' + _drPct(p) + '</span> af omsætning';
}
// Procent-celle til dag-for-dag-tabellen. Dæmpet, fordi den er afledt af
// kronekolonnen ved siden af — beløbet er stadig det primære.
function _drShareCell(part, revenue) {
    var p = _drShareOf(part, revenue);
    return '<td class="dr-r dr-pct-cell">' + (p == null ? '—' : _drPct(p)) + '</td>';
}
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

function initDrift(container, opts) {
    _driftState.el = container;
    _driftState.openDrawer = (opts && opts.openDrawer) || null;
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

    var kpi = function (label, val, cls, sub) {
        return '<div class="dr-kpi ' + (cls || '') + '"><div class="dr-kpi-val">' + val + '</div><div class="dr-kpi-label">' + label + '</div>' +
               (sub ? '<div class="dr-kpi-sub">' + sub + '</div>' : '') + '</div>';
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
            _drShareCell(d.cost_ex_moms, d.revenue_ex_moms) +
            '<td class="dr-r">' + _drMoney(d.delivery_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drMoney(d.labor_ex_moms) + '</td>' +
            _drShareCell(d.labor_ex_moms, d.revenue_ex_moms) +
            '<td class="dr-r ' + ((d.driftsresultat_ex_moms >= 0) ? 'dr-pos' : 'dr-neg') + '">' + _drMoney(d.driftsresultat_ex_moms) + '</td>' +
            '<td class="dr-r">' + _drPct(d.db_pct) + '</td>' +
            '<td class="dr-r">' + _drNum(d.units, 0) + '</td>' +
        '</tr>';
    }).join('');

    var pRaw = (t.labor_raw_ex_moms != null && t.labor_raw_ex_moms !== t.labor_ex_moms)
        ? 'rå −' + _drMoney(t.labor_raw_ex_moms) + ' + tillæg' : '';
    var pLoenSub = [_drShareSub(t.labor_ex_moms, t.revenue_ex_moms), pRaw].filter(Boolean).join('<br>');

    body.innerHTML = '' +
        '<div class="dr-kpis">' +
            kpi('Omsætning (ex moms)', _drMoney(t.revenue_ex_moms)) +
            kpi('Vareforbrug (ex moms)', '−' + _drMoney(t.cost_ex_moms), '',
                _drShareSub(t.cost_ex_moms, t.revenue_ex_moms)) +
            kpi('Levering (ex moms)', '−' + _drMoney(t.delivery_ex_moms)) +
            kpi('Løn', '−' + _drMoney(t.labor_ex_moms), '', pLoenSub) +
            kpi('Driftsresultat (ex moms)', _drMoney(t.driftsresultat_ex_moms), resultCls) +
            kpi('DB%', _drPct(t.db_pct), resultCls) +
            kpi('Enheder', _drNum(t.units, 0)) +
        '</div>' +
        '<div class="dr-section-title">Driftsresultat pr. dag <span class="dr-sub">(' + (t.day_count || 0) + ' dage · ex moms)</span></div>' +
        '<div class="dr-trend">' + (days.length ? bars : '<div class="dr-empty">Ingen dage.</div>') + '</div>' +
        '<div class="dr-section-title">Dag-for-dag</div>' +
        '<table class="dr-labor"><thead><tr><th>Dato</th><th class="dr-r">Omsætning</th><th class="dr-r">Vareforbrug</th>' +
            '<th class="dr-r dr-pct-cell">Vare%</th>' +
            '<th class="dr-r">Levering</th><th class="dr-r">Løn</th>' +
            '<th class="dr-r dr-pct-cell">Løn%</th>' +
            '<th class="dr-r">Driftsresultat</th><th class="dr-r">DB%</th><th class="dr-r">Enh.</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' +
        // Ingen total-række: pillerne øverst ER periodens totaler, og en samlet
        // procent er IKKE gennemsnittet af dagenes procenter (den skal regnes på
        // periodens samlede omsætning). To tal der ligner hinanden men afviger,
        // ville invitere til fejllæsning.
        '<div class="dr-sub" style="margin-top:8px">Vare% og Løn% er dagens andel af dagens omsætning · periodens samlede procenter står i pillerne øverst.</div>';
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
    _driftState.day = d;   // drill-down (bon-modal) læser herfra

    var resultClass = d.driftsresultat_ex_moms >= 0 ? 'dr-pos' : 'dr-neg';

    var warnings = [];
    if (d.labor_error) warnings.push('Løn kunne ikke hentes (' + _drEsc(d.labor_error) + ') — løn vises som 0.');
    if (d.rate_missing_count) warnings.push('⚠ ' + d.rate_missing_count + ' medarbejder(e) mangler timeløn → driftsresultatet er for højt. Udfyld satser i Settings → Løn.');
    if (d.role_unmapped_count) warnings.push('⚠ ' + d.role_unmapped_count + ' jobtype(r) er ikke kategoriseret (tæller som "other"). Kategorisér i Settings.');
    var warnHtml = warnings.length
        ? '<div class="dr-warn">' + warnings.map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>'
        : '';

    // drill: 'bons' = åbn per-bon nedbrydning · 'logistik' = hop til Logistik for dagen
    var kpi = function (label, val, cls, sub, drill) {
        return '<div class="dr-kpi ' + (cls || '') + (drill ? ' dr-kpi-drill' : '') + '"' +
               (drill ? ' data-drill="' + drill + '" title="' + (drill === 'logistik' ? 'Åbn Logistik for dagen' : 'Se bonnerne bag tallet') + '" role="button" tabindex="0"' : '') + '>' +
               '<div class="dr-kpi-val">' + val + '</div>' +
               '<div class="dr-kpi-label">' + label + (drill ? ' <span class="dr-drill-arrow">›</span>' : '') + '</div>' +
               (sub ? '<div class="dr-kpi-sub">' + sub + '</div>' : '') + '</div>';
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
    // Footer: afstem den rå brutto-løn (sum af sats×timer, ekskl. bud) med det
    // tillagte tal der vises på Løn-kortet og indgår i driftsresultatet.
    var laborFoot = '';
    if (d.labor_raw_ex_moms != null) {
        laborFoot = '<tr class="dr-foot"><td colspan="5" class="dr-r">Rå løn i alt (ekskl. bud)</td>' +
            '<td class="dr-r">−' + _drMoney(d.labor_raw_ex_moms) + '</td><td></td></tr>';
        if (d.labor_overhead_pct > 0) {
            var tillaeg = (d.labor_ex_moms || 0) - (d.labor_raw_ex_moms || 0);
            laborFoot += '<tr class="dr-foot"><td colspan="5" class="dr-r">+ ' + _drNum(d.labor_overhead_pct, 1) +
                ' % løntillæg <span class="dr-sub">(feriepenge, ATP, pension)</span></td>' +
                '<td class="dr-r">−' + _drMoney(tillaeg) + '</td><td></td></tr>';
            laborFoot += '<tr class="dr-foot dr-foot-total"><td colspan="5" class="dr-r"><strong>Løn i alt</strong></td>' +
                '<td class="dr-r"><strong>−' + _drMoney(d.labor_ex_moms) + '</strong></td><td></td></tr>';
        }
    }
    var laborTable = (d.labor_rows && d.labor_rows.length)
        ? '<table class="dr-labor"><thead><tr><th>Medarbejder</th><th>Jobtype</th><th>Rolle</th>' +
          '<th class="dr-r">Timer</th><th class="dr-r">Sats</th><th class="dr-r">Kostpris</th><th></th></tr></thead>' +
          '<tbody>' + laborRows + '</tbody>' +
          (laborFoot ? '<tfoot>' + laborFoot + '</tfoot>' : '') + '</table>'
        : '<div class="dr-empty">Ingen vagter registreret for dagen.</div>';

    // Løn-pillen: lønprocenten øverst (branche-nøgletallet), rå-løn/tillæg under.
    // Procenten måler dét tal pillen selv viser — drifts-løn ekskl. bud, altså
    // inkl. "other"-roller. Nøgletallet "Lønandel (kun produktionsroller)"
    // nedenfor er snævrere (§6 pkt. 4); de to må derfor gerne afvige.
    var loenSub = [_drShareSub(d.labor_ex_moms, d.revenue_ex_moms), _drLoenSub(d)].filter(Boolean).join('<br>');

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
            kpi('Omsætning (ex moms)', _drMoney(d.revenue_ex_moms), '', '', 'bons') +
            kpi('Vareforbrug (ex moms)', '−' + _drMoney(d.cost_ex_moms), '',
                _drShareSub(d.cost_ex_moms, d.revenue_ex_moms), 'bons') +
            kpi('Levering (ex moms)', '−' + _drMoney(d.delivery_ex_moms), '', '', 'logistik') +
            kpi('Løn', '−' + _drMoney(d.labor_ex_moms), '', loenSub) +
            kpi('Driftsresultat (ex moms)', _drMoney(d.driftsresultat_ex_moms), resultClass) +
            kpi('DB%', _drPct(d.db_pct), resultClass) +
        '</div>' +
        '<div class="dr-section-title">Nøgletal</div>' +
        '<div class="dr-metrics">' +
            '<div class="dr-metric"><span>Kapacitetsrate</span><strong>' + _drNum(d.kapacitetsrate, 1) + ' enh/mandetime</strong></div>' +
            '<div class="dr-metric"><span>Lønandel (kun produktionsroller)</span><strong>' + _drPct(d.loenandel_pct) + '</strong></div>' +
            '<div class="dr-metric"><span>Vareforbrug pr. enhed</span><strong>' + (d.vareforbrug_pr_enhed == null ? '—' : _drMoney(d.vareforbrug_pr_enhed)) + '</strong></div>' +
            '<div class="dr-metric"><span>Enheder</span><strong>' + _drNum(d.units, 0) + '</strong></div>' +
            '<div class="dr-metric dr-kpi-drill" data-drill="bons" title="Se bonnerne bag tallet" role="button" tabindex="0"><span>Bonner <span class="dr-drill-arrow">›</span></span><strong>' + _drNum(d.bon_count, 0) + '</strong></div>' +
            '<div class="dr-metric"><span>Produktionstimer</span><strong>' + _drNum(d.hours_production, 1) + '</strong></div>' +
        '</div>' +
        _drTimelineHtml(d.timeline) +
        '<div class="dr-section-title">Bemanding <span class="dr-sub">(bud ekskluderet fra driftens løn + rate)</span></div>' +
        laborTable;

    var rf = body.querySelector('#drRefreeze');
    if (rf) rf.addEventListener('click', _drRefreeze);

    body.querySelectorAll('[data-drill]').forEach(function (el) {
        var go = function () {
            var drill = el.getAttribute('data-drill');
            if (drill === 'logistik') {
                if (window.openLogistikForBon) window.openLogistikForBon(null, _driftState.date);
            } else {
                _drOpenBonModal();
            }
        };
        el.addEventListener('click', go);
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
}

// ── Per-bon nedbrydning (drill-down modal) ─────────────────
// Bruger `day.bons` fra API'et (live eller frosset snapshot — tallene stemmer
// med pills'ene). Ældre frosne snapshots mangler feltet → hent live med ⚠-flag.
function _drOpenBonModal() {
    var s = _driftState, d = s.day;
    if (!d || typeof openModal !== 'function') return;
    if (Array.isArray(d.bons)) {
        _drShowBonModal(d, d.bons, false);
    } else {
        fetchDriftDayBons(d.date, d.mode).then(function (r) {
            if (_driftState.day === d) _drShowBonModal(d, r.bons || [], true);
        }).catch(function (err) {
            openModal({ title: 'Bonner — ' + _drEsc(d.date), bodyHtml: '<div class="dr-error">Kunne ikke hente: ' + _drEsc(err.message) + '</div>' });
        });
    }
}

function _drShowBonModal(d, bons, liveFallback) {
    var sum = function (k) { return bons.reduce(function (a, b) { return a + (b[k] || 0); }, 0); };

    var warnHtml = liveFallback && d.frozen
        ? '<div class="dr-warn"><div>⚠ Dagen er frosset, men snapshottet er fra før per-bon nedbrydningen — listen er beregnet live og kan afvige fra de frosne tal. Admin kan genberegne dagen for at synkronisere.</div></div>'
        : '';

    var rows = bons.map(function (b) {
        var name = b.customer || '—';
        var sub = (b.contact && b.contact !== b.customer) ? ' <span class="dr-sub">' + _drEsc(b.contact) + '</span>' : '';
        return '<tr class="dr-bon-row" data-bon-id="' + b.id + '" title="Åbn bon">' +
            '<td>' + _drEsc(b.bon_number) + '</td>' +
            '<td>' + _drEsc(name) + sub + '</td>' +
            '<td><span class="dr-flag">' + _drEsc(b.status_code) + '</span></td>' +
            '<td class="dr-r">' + _drMoney(b.revenue_ex_moms) + '</td>' +
            '<td class="dr-r">' + (b.cost_ex_moms ? '−' + _drMoney(b.cost_ex_moms) : '0 kr') + '</td>' +
            '<td class="dr-r">' + (b.delivery_ex_moms ? '−' + _drMoney(b.delivery_ex_moms) : '<span class="dr-sub">0 kr</span>') + '</td>' +
            '<td class="dr-r">' + _drNum(b.units, 0) + '</td>' +
        '</tr>';
    }).join('');

    var foot = '<tr class="dr-foot dr-foot-total">' +
        '<td colspan="3"><strong>I alt (' + bons.length + ' bonner)</strong></td>' +
        '<td class="dr-r"><strong>' + _drMoney(sum('revenue_ex_moms')) + '</strong></td>' +
        '<td class="dr-r"><strong>−' + _drMoney(sum('cost_ex_moms')) + '</strong></td>' +
        '<td class="dr-r"><strong>−' + _drMoney(sum('delivery_ex_moms')) + '</strong></td>' +
        '<td class="dr-r"><strong>' + _drNum(sum('units'), 0) + '</strong></td></tr>';

    var modeLabel = d.mode === 'forecast' ? 'forecast' : 'realiseret';
    var bodyHtml = warnHtml +
        (bons.length
            ? '<table class="dr-labor dr-bon-table"><thead><tr><th>Bon</th><th>Kunde</th><th>Status</th>' +
              '<th class="dr-r">Omsætning</th><th class="dr-r">Vareforbrug</th><th class="dr-r">Levering</th><th class="dr-r">Enh.</th></tr></thead>' +
              '<tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table>' +
              '<div class="dr-sub" style="margin-top:8px">Alle beløb ex moms · ' + modeLabel + (d.frozen && !liveFallback ? ' · 🔒 fra frosset snapshot' : '') + '</div>'
            : '<div class="dr-empty">Ingen bonner indgår i dagens tal.</div>');

    openModal({ title: 'Bonner bag tallene — ' + _drEsc(d.date), bodyHtml: bodyHtml });

    var overlay = document.querySelector('.modal-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('.dr-bon-row').forEach(function (tr) {
        tr.addEventListener('click', function () {
            var id = parseInt(tr.getAttribute('data-bon-id'), 10);
            if (!id) return;
            closeModal();
            if (_driftState.openDrawer) _driftState.openDrawer(id);
            else if (window.openDrawer) window.openDrawer(id);
        });
    });
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
