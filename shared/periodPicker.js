/**
 * shared/periodPicker.js — delt periodevælger
 * ════════════════════════════════════════════════════════════
 * [Dag | 3 dage | Uge | Periode]  ◀  {interval}  ▶  [I dag]
 *
 * Spec: docs/CLAUDE_PLANLAEGNING_DRILLDOWN.md §10. Bygger på driftsregnskabets
 * vælger; driftsregnskabet migreres til den når der alligevel arbejdes i det.
 *
 *   var pp = PeriodPicker.create(el, {
 *       modes:   ['day', '3days', 'week', 'period'],   // hvilke knapper
 *       offsets: { day: 1, '3days': 1, week: 1 },      // start: i morgen / næste uge
 *       initial: 'week',
 *       storageKey: 'planning2_period',                // valgfri — husker mode
 *       onChange: function(p) { p.from, p.to, p.mode }
 *   });
 *   pp.get() → { from, to, mode }
 *
 * Forbrugeren får kun {from, to} (ISO-datoer) og regner ikke selv på datoer.
 * Al datoregning sker her på rene kalenderdatoer (UTC-midnat, ingen klokkeslæt),
 * forankret i dansk "i dag" via todayISO() fra shared/utils.js — samme metode
 * som offsetISO(), så et skift over midnat eller sommertid ikke flytter en dag.
 * ════════════════════════════════════════════════════════════
 */
(function (root) {
    var LABELS = { day: 'Dag', '3days': '3 dage', week: 'Uge', period: 'Periode' };
    var WEEKDAYS = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

    function parse(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }
    function fmt(d) { return d.toISOString().slice(0, 10); } // utc-ok: ren kalenderdato på UTC-midnat
    function addDays(iso, n) {
        var d = parse(iso); if (!d) return iso;
        d.setUTCDate(d.getUTCDate() + n);
        return fmt(d);
    }
    function monday(iso) {
        var d = parse(iso); var dow = d.getUTCDay() || 7;
        return addDays(iso, -(dow - 1));
    }
    function isoWeek(iso) {
        var d = parse(iso); var day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - day);
        var y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - y0) / 86400000) + 1) / 7);
    }
    function today() {
        return (typeof todayISO === 'function') ? todayISO()
            : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
    }
    function dm(iso) { return iso.slice(8, 10) + '.' + iso.slice(5, 7); }

    /** Intervallet for et mode, med `anchor` som første dag. Ren funktion. */
    function rangeFor(mode, anchor) {
        if (mode === 'week') { var f = monday(anchor); return { from: f, to: addDays(f, 6) }; }
        if (mode === '3days') return { from: anchor, to: addDays(anchor, 2) };
        return { from: anchor, to: anchor };                    // day
    }

    /** Startanker for et mode: i dag + offset (uge: offset i uger). */
    function startAnchor(mode, offsets, base) {
        var off = (offsets && offsets[mode]) || 0;
        var t = base || today();
        return mode === 'week' ? addDays(monday(t), 7 * off) : addDays(t, off);
    }

    /** Ét interval frem/tilbage. */
    function step(mode, anchor, dir) {
        var n = mode === 'week' ? 7 : mode === '3days' ? 3 : 1;
        return addDays(anchor, n * dir);
    }

    function label(mode, r) {
        if (mode === 'week') return 'Uge ' + isoWeek(r.from) + ' · ' + dm(r.from) + '–' + dm(r.to);
        if (mode === '3days') return dm(r.from) + '–' + dm(r.to) + '.' + r.to.slice(0, 4);
        var d = parse(r.from);
        return WEEKDAYS[d.getUTCDay()] + ' ' + dm(r.from) + '.' + r.from.slice(0, 4);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function create(el, opts) {
        opts = opts || {};
        var modes = opts.modes || ['day', 'week', 'period'];
        var offsets = opts.offsets || {};
        var mode = opts.initial && modes.indexOf(opts.initial) !== -1 ? opts.initial : modes[0];
        if (opts.storageKey) {
            try {
                var saved = localStorage.getItem(opts.storageKey);
                if (saved && modes.indexOf(saved) !== -1) mode = saved;
            } catch (e) { /* privat vindue */ }
        }
        var state = { mode: mode, anchor: null, from: null, to: null };

        function setMode(m, anchor) {
            state.mode = m;
            if (m === 'period') {
                if (!state.from) { var r0 = rangeFor('week', startAnchor('week', offsets)); state.from = r0.from; state.to = r0.to; }
            } else {
                state.anchor = anchor || startAnchor(m, offsets);
                var r = rangeFor(m, state.anchor);
                state.from = r.from; state.to = r.to;
            }
            if (opts.storageKey) { try { localStorage.setItem(opts.storageKey, m); } catch (e) {} }
        }

        function emit() {
            render();
            if (typeof opts.onChange === 'function') opts.onChange({ from: state.from, to: state.to, mode: state.mode });
        }

        function render() {
            var html = '<div class="pp-wrap"><div class="pp-modes" role="group">' +
                modes.map(function (m) {
                    return '<button type="button" class="pp-mode' + (m === state.mode ? ' active' : '') +
                        '" data-mode="' + m + '">' + esc(LABELS[m] || m) + '</button>';
                }).join('') + '</div>';
            if (state.mode === 'period') {
                html += '<label class="pp-field">Fra <input type="date" class="pp-from" value="' + esc(state.from) + '"></label>' +
                        '<label class="pp-field">Til <input type="date" class="pp-to" value="' + esc(state.to) + '"></label>';
            } else {
                html += '<button type="button" class="pp-nav pp-prev" aria-label="Forrige">◀</button>' +
                        '<span class="pp-label">' + esc(label(state.mode, state)) + '</span>' +
                        '<button type="button" class="pp-nav pp-next" aria-label="Næste">▶</button>';
            }
            html += '<button type="button" class="pp-today">I dag</button></div>';
            el.innerHTML = html;
        }

        el.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b || !el.contains(b)) return;
            if (b.classList.contains('pp-mode')) { setMode(b.dataset.mode); emit(); }
            else if (b.classList.contains('pp-prev') || b.classList.contains('pp-next')) {
                setMode(state.mode, step(state.mode, state.anchor, b.classList.contains('pp-next') ? 1 : -1));
                emit();
            } else if (b.classList.contains('pp-today')) {
                // "I dag" → Dag, offset 0 — uanset hvad Dag-mode ellers starter på.
                var m = modes.indexOf('day') !== -1 ? 'day' : state.mode;
                setMode(m, m === 'week' ? monday(today()) : today());
                emit();
            }
        });
        el.addEventListener('change', function (e) {
            var t = e.target;
            if (!t.classList || (!t.classList.contains('pp-from') && !t.classList.contains('pp-to'))) return;
            var f = el.querySelector('.pp-from').value, to = el.querySelector('.pp-to').value;
            if (!parse(f) || !parse(to)) return;
            if (f > to) { var x = f; f = to; to = x; }
            state.from = f; state.to = to;
            emit();
        });

        setMode(state.mode);
        render();

        return {
            get: function () { return { from: state.from, to: state.to, mode: state.mode }; },
            setRange: function (from, to) {
                if (!parse(from) || !parse(to)) return;
                state.mode = modes.indexOf('period') !== -1 ? 'period' : state.mode;
                state.from = from; state.to = to; render();
            },
        };
    }

    var api = { create: create, _rangeFor: rangeFor, _startAnchor: startAnchor, _step: step, _isoWeek: isoWeek, _label: label };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PeriodPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
