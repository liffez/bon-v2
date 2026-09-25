/**
 * shared/planning_drill.js — Planlægning (ny): drill-down
 * ════════════════════════════════════════════════════════════
 * Spec: docs/CLAUDE_PLANLAEGNING_DRILLDOWN.md. Fase 1 = niveau 1–3.
 *
 * Kører SIDE OM SIDE med den gamle shared/planning.js indtil den nye er
 * godkendt i drift. Egne navne (_pd*), egne localStorage-nøgler.
 *
 *   initPlanningDrill(containerEl, { zone: 'kitchen'|'office', onEdit(bonId) })
 *   cleanupPlanningDrill()
 *   _pdHandleSSE(event, data)     — office' globale SSE-dispatch kalder denne
 *
 * Frontenden REGNER IKKE. Træet kommer færdigt fra POST /api/bons/planning/tree;
 * her navigeres og formateres kun. Ingen summering af bonlinjer, ingen moms.
 * Kost og salg er kun i svaret hvis rollen må se dem — findes feltet ikke,
 * findes knappen heller ikke.
 *
 * Afhængigheder: BonConfig.js, shared/utils.js (esc, todayISO, statusToFrontend,
 * statusToBackend, connectSSE, getClientId), shared/api.js, shared/periodPicker.js,
 * shared/vare_picker.js.
 * ════════════════════════════════════════════════════════════
 */

var _pd = null;

var PD_TABS = [
    { key: 'categories', n: 1, label: 'Kategorier' },
    { key: 'items',      n: 2, label: 'Varer' },
    { key: 'requests',   n: 3, label: 'Ønsker' },
    { key: 'prep',       n: 4, label: 'Skal laves', fase2: true },
    { key: 'raw',        n: 5, label: 'Råvarer',    fase2: true },
    { key: 'check',      n: 6, label: 'Tjekliste' },
];
var PD_WEEKDAYS = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
var PD_COUNT_UNITS = { stk: 1, antal: 1, portion: 1, '': 1 };

function initPlanningDrill(containerEl, options) {
    cleanupPlanningDrill();
    _pd = {
        el: containerEl,
        opts: options || {},
        zone: (options && options.zone) || 'kitchen',
        from: null, to: null,
        statuses: {},         // frontend-nøgle → bool
        showOffers: false,
        bons: [],
        selected: new Set(),
        selectionTouched: false,
        extras: [],           // { _id, grocy_recipe_id, quantity, product_name, price_category }
        extraSeq: 1,
        extraPicker: null,
        tree: null,
        treeSeq: 0,
        bonSeq: 0,
        loading: false,
        error: null,
        tab: _pdLoad('planning2_tab', 'categories'),
        path: [],             // valgt knude-id pr. kolonne
        metric: _pdLoad('planning2_metric', 'antal'),
        perDay: _pdLoad('planning2_perday', '0') === '1',
        staff: null,
        reloadTimer: null,
        sse: null,
        resizeObs: null,
    };
    if (!PD_TABS.some(function (t) { return t.key === _pd.tab; })) _pd.tab = 'categories';

    _pdRenderShell();
    _pdInitStatuses().then(function () {
        _pdBuildStatusChips();
        _pdLoadBons();
    });

    if (_pd.zone === 'kitchen' && typeof connectSSE === 'function') {
        _pd.sse = connectSSE('/api/sse?client_id=' + getClientId(), {
            connected: function () {},
            bon_created: function (d) { _pdHandleSSE('bon_created', d); },
            bon_updated: function (d) { _pdHandleSSE('bon_updated', d); },
            bon_status:  function (d) { _pdHandleSSE('bon_status', d); },
        });
    }
}

function cleanupPlanningDrill() {
    if (!_pd) return;
    if (_pd.reloadTimer) clearTimeout(_pd.reloadTimer);
    if (_pd.resizeObs) _pd.resizeObs.disconnect();
    if (_pd.extraPicker) { try { _pd.extraPicker.close(); } catch (e) {} }
    _pd = null;
}

function _pdHandleSSE(event, data) {
    if (!_pd) return;
    // Nye bons og statusskift kan ændre bonlisten; et bon_updated på en valgt
    // bon ændrer træet. Debounced, så en stribe events giver ét kald.
    if (_pd.reloadTimer) clearTimeout(_pd.reloadTimer);
    _pd.reloadTimer = setTimeout(function () { if (_pd) _pdLoadBons(); }, 600);
}

/* ── Små hjælpere ─────────────────────────────────────────── */
function _pdLoad(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function _pdSave(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function _pdEsc(s) { return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s); }
function _pdKr(n) {
    return (Number(n) || 0).toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' kr';
}
function _pdKg(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('da-DK', { maximumFractionDigits: v < 10 ? 2 : 1 }) + ' kg';
}
function _pdIsLight(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    if (!m) return false;
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 200;
}
function _pdDay(iso) {
    var d = new Date(iso + 'T12:00:00Z');
    return PD_WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
}

/* ══════════════════════════════════════════════════════════════
   SHELL
   ══════════════════════════════════════════════════════════════ */
function _pdRenderShell() {
    var vpKey = 'planning2_vagtplan_open_' + _pd.zone;
    var vpOpen = _pdLoad(vpKey, 'false') === 'true';

    _pd.el.innerHTML =
        '<div class="pd-wrap">' +
            '<div class="pd-top">' +
                '<div class="pd-period" id="pdPeriod"></div>' +
                '<button type="button" class="pd-toggle' + (_pd.perDay ? ' active' : '') + '" id="pdPerDay" aria-pressed="' + _pd.perDay + '">' +
                    '<span class="pd-toggle-dot"></span> Pr. dag</button>' +
            '</div>' +
            '<div class="pd-vagtplan">' +
                '<button type="button" class="pd-vagtplan-toggle" id="pdVagtToggle">' +
                    '<span id="pdVagtArrow">' + (vpOpen ? '▼' : '▶') + '</span> Vagtplan for perioden</button>' +
                '<div class="pd-vagtplan-content' + (vpOpen ? ' open' : '') + '" id="pdVagt"></div>' +
            '</div>' +
            '<div class="pd-tabsbar">' +
                '<div class="pd-tabs" id="pdTabs"></div>' +
                '<div class="pd-metric" id="pdMetric"></div>' +
            '</div>' +
            '<div class="pd-body">' +
                '<aside class="pd-bons">' +
                    '<div class="pd-chips" id="pdChips"></div>' +
                    '<div class="pd-bons-head">' +
                        '<span class="pd-h">BONS</span>' +
                        '<span class="pd-bons-count" id="pdBonCount"></span>' +
                        '<button type="button" class="pd-btn" id="pdSelectAll">Vælg alle</button>' +
                    '</div>' +
                    '<div class="pd-bonlist" id="pdBonList"><div class="pd-empty">Henter…</div></div>' +
                    '<div class="pd-bons-head pd-extras-head">' +
                        '<span class="pd-h">EKSTRA — UDEN BON</span>' +
                        '<button type="button" class="pd-btn" id="pdAddExtra">+ Tilføj menu</button>' +
                    '</div>' +
                    '<div id="pdExtras"></div>' +
                    '<div id="pdExtraPicker"></div>' +
                '</aside>' +
                '<section class="pd-drill">' +
                    '<div class="pd-crumbs" id="pdCrumbs"></div>' +
                    '<div class="pd-warn" id="pdWarn"></div>' +
                    '<div class="pd-cols" id="pdCols"></div>' +
                '</section>' +
            '</div>' +
        '</div>';

    var byId = function (id) { return _pd.el.querySelector('#' + id); };

    _pd.picker = PeriodPicker.create(byId('pdPeriod'), {
        // 10 dage fra i morgen som standard: planlægger man mandag, skal hele
        // næste arbejdsuge med — en kalenderuge rækker ikke.
        modes: ['day', '3days', '10days', 'week', 'period'],
        offsets: { day: 1, '3days': 1, '10days': 1, week: 1 },
        initial: '10days',
        // Ny nøgle, så et gemt "Uge" fra afprøvningen ikke skjuler den nye standard.
        storageKey: 'planning2_period_mode_v2',
        onChange: function (p) {
            _pd.from = p.from; _pd.to = p.to;
            // Periode-skift: ekstra-linjerne er engangs og hører til det der blev
            // planlagt — de følger ikke med til en anden periode.
            _pd.extras = [];
            _pd.selectionTouched = false;
            _pdRenderExtras();
            _pd.staff = null;
            _pdLoadBons();
            if (byId('pdVagt').classList.contains('open')) _pdLoadStaff();
        },
    });
    var p = _pd.picker.get();
    _pd.from = p.from; _pd.to = p.to;

    byId('pdPerDay').addEventListener('click', function () {
        _pd.perDay = !_pd.perDay;
        _pdSave('planning2_perday', _pd.perDay ? '1' : '0');
        this.classList.toggle('active', _pd.perDay);
        this.setAttribute('aria-pressed', _pd.perDay);
        _pdRenderDrill();
    });
    byId('pdVagtToggle').addEventListener('click', function () {
        var c = byId('pdVagt');
        var open = c.classList.toggle('open');
        byId('pdVagtArrow').textContent = open ? '▼' : '▶';
        _pdSave(vpKey, open ? 'true' : 'false');
        if (open && !_pd.staff) _pdLoadStaff();
    });
    if (vpOpen) _pdLoadStaff();

    byId('pdSelectAll').addEventListener('click', _pdToggleSelectAll);
    byId('pdAddExtra').addEventListener('click', _pdToggleExtraPicker);

    byId('pdTabs').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-tab]');
        if (!b || b.disabled) return;
        _pd.tab = b.dataset.tab; _pd.path = [];
        _pdSave('planning2_tab', _pd.tab);
        _pdRenderTabs(); _pdRenderDrill();
    });
    byId('pdMetric').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-metric]');
        if (!b) return;
        _pd.metric = b.dataset.metric;
        _pdSave('planning2_metric', _pd.metric);
        _pdRenderMetric(); _pdRenderDrill();
    });
    byId('pdCrumbs').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-depth]');
        if (!b) return;
        _pd.path = _pd.path.slice(0, Number(b.dataset.depth));
        _pdRenderDrill();
    });
    byId('pdCols').addEventListener('click', _pdOnRowClick);
    // Tjekliste: Enter i tal-feltet = Ret lager, Escape = annullér.
    byId('pdCols').addEventListener('keydown', function (e) {
        if (e.target.id !== 'pdCkInput') return;
        var row = e.target.closest('.pd-ck-edit');
        if (e.key === 'Enter') { e.preventDefault(); var b = row && row.querySelector('[data-ck="save"]'); if (b) b.click(); }
        else if (e.key === 'Escape') { var c2 = row && row.querySelector('[data-ck="cancel"]'); if (c2) c2.click(); }
    });

    // Antal kolonner følger bredden (spec §4): samme komponent på iPad og 27".
    if (typeof ResizeObserver === 'function') {
        // Kun når antallet af kolonner skifter — en ny højde (fordi rækkerne
        // blev tegnet) må ikke tegne dem igen.
        _pd.resizeObs = new ResizeObserver(function () {
            if (_pd && _pd.colCount !== _pdColumnCount()) _pdRenderDrill();
        });
        _pd.resizeObs.observe(byId('pdCols'));
    }

    _pdRenderTabs();
    _pdRenderMetric();
    _pdRenderExtras();
}

/* ══════════════════════════════════════════════════════════════
   STATUS-FILTRE
   Standarden er en admin-indstilling (planning_default_statuses). Brugerens
   egne valg huskes, men kun så længe admins standard er den samme — ændres
   standarden, starter alle forfra på den nye.
   ══════════════════════════════════════════════════════════════ */
function _pdInitStatuses() {
    return fetchSettings().then(function (rows) {
        var r = (rows || []).find(function (x) { return x.key === 'planning_default_statuses'; });
        var base = (r && r.value) || '["GODKENDT","IGANG","KLAR"]';
        var codes = [];
        try { codes = JSON.parse(base); } catch (e) { codes = []; }
        var defaults = {};
        (codes || []).forEach(function (c) { defaults[statusToFrontend(c)] = true; });

        var saved = null;
        try { saved = JSON.parse(_pdLoad('planning2_status_filter', 'null')); } catch (e) { saved = null; }
        _pd.statuses = (saved && saved.base === base && saved.statuses) ? saved.statuses : defaults;
        _pd.statusBase = base;
        _pd.showOffers = saved && saved.base === base ? !!saved.offers : false;
    }).catch(function () {
        _pd.statuses = { godkendt: true, igang: true, klar: true };
        _pd.statusBase = null;
    });
}

function _pdSaveStatuses() {
    _pdSave('planning2_status_filter', JSON.stringify({ base: _pd.statusBase, statuses: _pd.statuses, offers: _pd.showOffers }));
}

function _pdBuildStatusChips() {
    var bar = _pd.el.querySelector('#pdChips');
    if (!bar || typeof BON_CONFIG === 'undefined') return;
    var html = '';
    Object.keys(BON_CONFIG.statuses).forEach(function (key) {
        // AFLYST er aldrig relevant; tilbud har sin egen knap nedenfor (de styres
        // af is_offer, ikke af en status).
        if (key === 'aflyst' || key === 'tilbud') return;
        var cfg = BON_CONFIG.statuses[key];
        var on = !!_pd.statuses[key];
        // Samme udtryk som kalenderens filterknapper: udfyldt når valgt, bleg når
        // ikke. LEV er hvid i BonConfig, så dens kant hentes fra designsystemet.
        var light = _pdIsLight(cfg.color);
        html += '<button type="button" class="pd-chip' + (on ? ' active' : '') + '" data-status="' + key + '"' +
            ' aria-pressed="' + on + '" style="--c:' + cfg.color + ';--t:' + cfg.text +
            (light ? ';--b:var(--color-border, #d7d1ca)' : '') + '">' +
            '<span class="pd-chip-face">' + _pdEsc(cfg.label) + '</span></button>';
    });
    var tc = (BON_CONFIG.statuses.tilbud || {});
    html += '<button type="button" class="pd-chip pd-chip-offer' + (_pd.showOffers ? ' active' : '') + '" data-offers="1"' +
        ' aria-pressed="' + _pd.showOffers + '" style="--c:' + (tc.color || '#b0b8c8') + ';--t:' + (tc.text || '#333') + '">' +
        '<span class="pd-chip-face">Tilbud</span></button>';
    bar.innerHTML = html;
    bar.onclick = function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.offers) _pd.showOffers = !_pd.showOffers;
        else _pd.statuses[b.dataset.status] = !_pd.statuses[b.dataset.status];
        _pdSaveStatuses();
        _pdBuildStatusChips();
        _pdLoadBons();
    };
}

/* ══════════════════════════════════════════════════════════════
   BONS (venstre kolonne) — genbruger GET /api/bons/planning
   ══════════════════════════════════════════════════════════════ */
function _pdLoadBons() {
    if (!_pd || !_pd.from) return;
    var codes = [];
    Object.keys(_pd.statuses).forEach(function (k) { if (_pd.statuses[k]) codes.push(statusToBackend(k)); });
    var seq = ++_pd.bonSeq;
    // Uden en eneste status ville ruten falde tilbage til sin egen standard;
    // en tom liste skal betyde tom liste.
    var req = codes.length ? fetchBonsPlanning(_pd.from, _pd.to, codes.join(',')) : Promise.resolve([]);
    req.then(function (bons) {
        if (!_pd || seq !== _pd.bonSeq) return;
        var seen = {};
        // Ruten sender altid åbne tilbud med (uanset statusfilter); de vises kun
        // når Tilbud er slået til. Et vundet tilbud sender ruten aldrig.
        _pd.bons = (bons || []).filter(function (b) {
            if (seen[b.id]) return false; seen[b.id] = true;
            return _pd.showOffers || !b.is_offer;
        });
        var ids = new Set(_pd.bons.map(function (b) { return b.id; }));
        if (!_pd.selectionTouched) _pd.selected = new Set(ids);
        else _pd.selected = new Set(Array.from(_pd.selected).filter(function (id) { return ids.has(id); }));
        _pdRenderBonList();
        _pdLoadTree();
    }).catch(function (err) {
        if (!_pd) return;
        var l = _pd.el.querySelector('#pdBonList');
        if (l) l.innerHTML = '<div class="pd-empty">Bons kunne ikke hentes: ' + _pdEsc(err.message || '') + '</div>';
    });
}

function _pdRenderBonList() {
    var list = _pd.el.querySelector('#pdBonList');
    var cnt = _pd.el.querySelector('#pdBonCount');
    var btn = _pd.el.querySelector('#pdSelectAll');
    if (!list) return;
    var nSel = _pd.bons.filter(function (b) { return _pd.selected.has(b.id); }).length;
    if (cnt) cnt.textContent = nSel + ' af ' + _pd.bons.length + ' valgt';
    if (btn) btn.textContent = nSel === _pd.bons.length && _pd.bons.length ? 'Fravælg alle' : 'Vælg alle';
    if (!_pd.bons.length) { list.innerHTML = '<div class="pd-empty">Ingen bons i perioden med de valgte statusser.</div>'; return; }

    list.innerHTML = _pd.bons.map(function (b) {
        var code = statusToFrontend(b.status_code || '');
        var cfg = (BON_CONFIG.statuses || {})[code] || {};
        var workload = b.event_role !== 'sales' && b.event_role !== 'expense';
        var units = b.total_units > 0 ? b.total_units : (b.pax || 0);
        return '<label class="pd-bon' + (b.is_offer ? ' is-offer' : '') + (workload ? '' : ' no-work') + '">' +
            '<input type="checkbox" data-bon="' + b.id + '"' + (_pd.selected.has(b.id) ? ' checked' : '') + '>' +
            '<span class="pd-bon-main">' +
                '<span class="pd-bon-l1"><strong>#' + _pdEsc(b.bon_number || b.id) + '</strong>' +
                    ' <span class="pd-status" style="background:' + (cfg.color || '#999') + ';color:' + (cfg.text || '#fff') + '">' +
                    _pdEsc(b.is_offer ? 'Tilbud' : (cfg.label || b.status_code)) + '</span>' +
                    ' <span class="pd-bon-day">' + _pdDay(b.delivery_date) + '</span></span>' +
                '<span class="pd-bon-l2">' + _pdEsc(b.company_name || (b.contact_name_full || '').trim() || '—') +
                    (workload ? '' : ' · <em>tæller ikke (event-' + (b.event_role === 'sales' ? 'salg' : 'udgift') + ')</em>') + '</span>' +
            '</span>' +
            '<span class="pd-bon-units">' + units + ' enh</span>' +
        '</label>';
    }).join('');
    list.onchange = function (e) {
        var cb = e.target.closest('input[data-bon]');
        if (!cb) return;
        _pd.selectionTouched = true;
        var id = Number(cb.dataset.bon);
        if (cb.checked) _pd.selected.add(id); else _pd.selected.delete(id);
        _pdRenderBonList();
        _pdLoadTree();
    };
}

function _pdToggleSelectAll() {
    var all = _pd.bons.length && _pd.bons.every(function (b) { return _pd.selected.has(b.id); });
    _pd.selectionTouched = true;
    _pd.selected = all ? new Set() : new Set(_pd.bons.map(function (b) { return b.id; }));
    _pdRenderBonList();
    _pdLoadTree();
}

/* ── Ekstra — uden bon ─────────────────────────────────────── */
function _pdRenderExtras() {
    var el = _pd && _pd.el.querySelector('#pdExtras');
    if (!el) return;
    if (!_pd.extras.length) { el.innerHTML = '<div class="pd-empty pd-empty-sm">Ingen ekstra. Forsvinder når perioden skiftes.</div>'; return; }
    el.innerHTML = _pd.extras.map(function (x) {
        return '<div class="pd-extra"><span><strong>' + x.quantity + '</strong> × ' + _pdEsc(x.product_name) +
            ' <span class="pd-dim">' + _pdEsc(x.price_category) + '</span></span>' +
            '<button type="button" class="pd-x" data-extra="' + x._id + '" aria-label="Fjern">×</button></div>';
    }).join('');
    el.onclick = function (e) {
        var b = e.target.closest('button[data-extra]');
        if (!b) return;
        var id = Number(b.dataset.extra);
        _pd.extras = _pd.extras.filter(function (x) { return x._id !== id; });
        _pdRenderExtras();
        _pdLoadTree();
    };
}

function _pdToggleExtraPicker() {
    var host = _pd.el.querySelector('#pdExtraPicker');
    var btn = _pd.el.querySelector('#pdAddExtra');
    if (_pd.extraPicker && _pd.extraPicker._visible) {
        _pd.extraPicker.close(); _pd.extraPicker = null;
        btn.textContent = '+ Tilføj menu';
        return;
    }
    if (typeof VarePicker === 'undefined') return;
    _pd.extraPicker = new VarePicker({
        bonId: null,                   // detached: ingen POST, linjen kommer tilbage her
        priceCategory: 'catering',
        container: host,
        viewName: 'planning',
        showPriceCategorySelector: true,
        onAdded: function (line) {
            // Kun det serveren skal bruge: opskrift, antal, priskategori. Pris,
            // kost og CO₂ slår serveren selv op — ingen tal fra browseren.
            _pd.extras.push({ _id: _pd.extraSeq++, grocy_recipe_id: line.grocy_recipe_id,
                quantity: line.quantity, product_name: line.product_name,
                price_category: line.price_category || 'catering' });
            _pdRenderExtras();
            _pdLoadTree();
        },
    });
    _pd.extraPicker.open();
    btn.textContent = 'Luk';
}

/* ══════════════════════════════════════════════════════════════
   TRÆET
   ══════════════════════════════════════════════════════════════ */
function _pdLoadTree() {
    if (!_pd) return;
    // Er en beregning i gang, venter vi på den og kører så ÉN gang til. Ellers
    // starter hver SSE-opdatering en ny tung beregning oven i den første — ved
    // kold Grocy-cache blev det til seks samtidige kald ved sidens start.
    if (_pd.treeInflight) { _pd.treePending = true; return; }
    _pd.treeInflight = true;
    var bonIds = Array.from(_pd.selected);
    var extras = _pd.extras.map(function (x) {
        return { grocy_recipe_id: x.grocy_recipe_id, quantity: x.quantity, price_category: x.price_category };
    });
    var seq = ++_pd.treeSeq;
    _pd.loading = true;
    _pdRenderDrill();
    var done = function () {
        if (!_pd) return;
        _pd.treeInflight = false;
        if (_pd.treePending) { _pd.treePending = false; _pdLoadTree(); }
    };
    fetchPlanningTree(bonIds, extras).then(function (tree) {
        done();
        if (!_pd || seq !== _pd.treeSeq || _pd.treeInflight) return;   // et nyere kald er på vej
        _pd.tree = tree; _pd.loading = false; _pd.error = null;
        // Hold stien så længe knuderne findes — en SSE-genindlæsning må ikke
        // smide brugeren tilbage til toppen.
        _pd.path = _pd.path.filter(function (id) { return tree.nodes[id]; });
        _pdRenderMetric();
        _pdRenderDrill();
    }).catch(function (err) {
        done();
        if (!_pd || seq !== _pd.treeSeq || _pd.treeInflight) return;
        _pd.loading = false; _pd.error = err.message || 'Ukendt fejl';
        _pdRenderDrill();
    });
}

function _pdRenderTabs() {
    var el = _pd.el.querySelector('#pdTabs');
    if (!el) return;
    el.innerHTML = PD_TABS.map(function (t) {
        return '<button type="button" class="pd-tab' + (t.key === _pd.tab ? ' active' : '') + '" data-tab="' + t.key + '"' +
'>' + '<span class="pd-tab-n">' + t.n + '</span> ' + t.label + '</button>';
    }).join('');
}

/** Vis-vælgeren tilbyder kun de tal serveren faktisk har sendt. */
function _pdMetricsAvailable() {
    var p = (_pd.tree && _pd.tree.perms) || {};
    var m = [{ key: 'antal', label: 'Antal' }];
    if (p.cost) m.push({ key: 'kost', label: 'Kost' });
    m.push({ key: 'co2', label: 'CO₂' });
    if (p.sale) m.push({ key: 'salg', label: 'Salg' });
    if (p.cost && p.sale) m.push({ key: 'db', label: 'DB' });
    return m;
}

function _pdRenderMetric() {
    var el = _pd.el.querySelector('#pdMetric');
    if (!el) return;
    var ms = _pdMetricsAvailable();
    // Før træet er hentet kender vi ikke rettighederne — et gemt valg (fx Kost)
    // må ikke nulstilles bare fordi svaret ikke er kommet endnu.
    var active = ms.some(function (m) { return m.key === _pd.metric; }) ? _pd.metric : 'antal';
    if (_pd.tree) _pd.metric = active;
    el.innerHTML = '<span class="pd-dim">Vis:</span><div class="pd-seg">' + ms.map(function (m) {
        return '<button type="button" data-metric="' + m.key + '" class="' + (m.key === active ? 'active' : '') + '">' + m.label + '</button>';
    }).join('') + '</div>';
}

/* ── Kolonner ─────────────────────────────────────────────── */
function _pdColumnCount() {
    var el = _pd.el.querySelector('#pdCols');
    var w = el ? el.clientWidth : 0;
    return w >= 1200 ? 3 : w >= 820 ? 2 : 1;
}

/** Niveau 4–5: aktuelle priser, intet pr. dag, egne totaler. */
function _pdIsFase2() { return _pd.tab === 'prep' || _pd.tab === 'raw'; }

function _pdRootIds() {
    return (_pd.tree && _pd.tree.levels[_pd.tab]) || [];
}

function _pdRenderDrill() {
    if (!_pd) return;
    var cols = _pd.el.querySelector('#pdCols');
    var crumbsEl = _pd.el.querySelector('#pdCrumbs');
    var warnEl = _pd.el.querySelector('#pdWarn');
    if (!cols) return;

    if (_pd.error) { cols.innerHTML = '<div class="pd-empty">Planlægningen kunne ikke beregnes: ' + _pdEsc(_pd.error) + '</div>'; return; }
    if (!_pd.tree) { cols.innerHTML = '<div class="pd-empty">' + (_pd.loading ? 'Beregner…' : '') + '</div>'; return; }

    var t = _pd.tree, nodes = t.nodes;
    var tab = PD_TABS.filter(function (x) { return x.key === _pd.tab; })[0];
    if (_pd.tab === 'check') {
        crumbsEl.innerHTML = '<span class="pd-crumb">Tjekliste</span>' + (_pd.loading ? ' <span class="pd-dim pd-loading">opdaterer…</span>' : '');
        warnEl.innerHTML = (t.meta.warnings || []).map(function (x) { return '<div>' + _pdEsc(x) + '</div>'; }).join('');
        cols.style.setProperty('--pd-cols', 1);
        cols.innerHTML = _pdCheckHtml();
        return;
    }

    // Brødkrumme
    var crumbs = '<button type="button" data-depth="0" class="pd-crumb">' + _pdEsc(tab.label) + '</button>';
    _pd.path.forEach(function (id, i) {
        crumbs += ' <span class="pd-dim">›</span> <button type="button" data-depth="' + (i + 1) + '" class="pd-crumb">' +
            _pdEsc(_pdRowTitle(nodes[id])) + '</button>';
    });
    if (_pd.loading) crumbs += ' <span class="pd-dim pd-loading">opdaterer…</span>';
    crumbsEl.innerHTML = crumbs;

    // Advarsler fra serveren — et hul skal kunne ses, ikke ligne et tomt svar.
    var w = (t.meta.warnings || []).slice();
    if (t.meta.excluded_bons && t.meta.excluded_bons.length) {
        w.push('Tæller ikke (event-salg/udgift — maden er talt i prep-bonnen): ' + t.meta.excluded_bons.map(function (n) { return '#' + n; }).join(', '));
    }
    if (_pd.perDay && _pdIsFase2()) {
        w.push('Pr. dag findes ikke for Skal laves og Råvarer — behovet er samlet for hele perioden.');
    }
    warnEl.innerHTML = w.map(function (x) { return '<div>' + _pdEsc(x) + '</div>'; }).join('');

    // Kolonnerne: rod + én pr. valgt knude med børn. Vis de sidste N.
    var all = [{ title: tab.label, ids: _pdRootIds(), parent: null }];
    _pd.path.forEach(function (id) {
        var n = nodes[id];
        if (n && n.children && n.children.length) all.push({ title: _pdRowTitle(n), ids: n.children, parent: n });
    });
    var n = _pdColumnCount();
    _pd.colCount = n;
    if (_pd.perDay && !_pdIsFase2()) {
        // Pr. dag: én bred tabel — den kolonne man står i, med en kolonne pr. dag.
        // Brødkrummen bruges til at gå op.
        cols.style.setProperty('--pd-cols', 1);
        cols.innerHTML = _pdTableHtml(all[all.length - 1], all.length - 1);
        return;
    }
    var start = Math.max(0, all.length - n);
    var html = '';
    for (var c = start; c < all.length; c++) html += _pdColumnHtml(all[c], c);
    cols.style.setProperty('--pd-cols', Math.min(n, all.length - start));
    cols.innerHTML = html;
}

/* ── Pr. dag-tabel ─────────────────────────────────────────
   Dagene kommer færdige fra serveren (tree.days: kun dage med noget på), og
   hver celle er knudens eget dagstal — intet summeres her. Bundlinjen er
   forælderens dagstal, eller enhederne pr. dag på øverste niveau. */
function _pdNum(v) {
    if (v == null || v === 0) return '<span class="pd-dim">–</span>';
    return _pdEsc(String(Math.round(v * 100) / 100).replace('.', ','));
}

function _pdTableHtml(col, depth) {
    var t = _pd.tree, nodes = t.nodes;
    var days = t.days || [];
    var metric = _pd.metric !== 'antal';
    var tpl = 'minmax(150px, 1fr) repeat(' + days.length + ', 52px) 64px' + (metric ? ' 108px' : '') + ' 56px';
    var style = ' style="grid-template-columns:' + tpl + '"';

    var head = '<div class="pd-trow pd-thead"' + style + '><span class="pd-tname">' + _pdEsc(col.title) + '</span>' +
        days.map(function (d) {
            var p = _pdDay(d).split(' ');
            return '<span class="pd-tnum"><strong>' + p[0] + '</strong><br><span class="pd-dim">' + p[1] + '</span></span>';
        }).join('') +
        '<span class="pd-tnum"><strong>I alt</strong></span>' +
        (metric ? '<span class="pd-tnum">' + _pdEsc((_pdMetricsAvailable().filter(function (m) { return m.key === _pd.metric; })[0] || {}).label || '') + '</span>' : '') +
        '<span></span></div>';

    var rows = col.ids.map(function (id) {
        var n = nodes[id];
        if (!n) return '';
        var hasKids = n.children && n.children.length;
        var clickable = hasKids || _pdCanOpenBon(n);
        var dim = n.kind === 'category' && !n.counts_as_unit;
        var tag = clickable ? 'button type="button"' : 'div';
        var badge = n.badge ? ' <span class="pd-badge pd-badge-' + (n.badge.tone || 'amber') + '">' + _pdEsc(n.badge.text) + '</span>' : '';
        return '<' + tag + ' class="pd-row pd-trow' + (clickable ? ' clickable' : '') + (dim ? ' dim' : '') + '"' + style +
            ' data-id="' + _pdEsc(n.id) + '" data-depth="' + depth + '">' +
            '<span class="pd-tname">' + _pdEsc(_pdRowTitle(n)) + badge + '</span>' +
            days.map(function (d) { return '<span class="pd-tnum">' + _pdNum(n.days && n.days[d]) + '</span>'; }).join('') +
            '<span class="pd-tnum pd-ttotal">' + _pdEsc(_pdQtyText(n)) + '</span>' +
            (metric ? '<span class="pd-tnum pd-tval">' + (n.values ? _pdMetricLabel(n.values, false) : '') + '</span>' : '') +
            '<span class="pd-chev">' + (hasKids ? '›' : (_pdCanOpenBon(n) ? '<span class="pd-open">åbn ›</span>' : '')) + '</span>' +
        '</' + (clickable ? 'button' : 'div') + '>';
    }).join('');

    // Bundlinje: forælderens egne dagstal, eller enheder pr. dag øverst.
    var footDays = col.parent ? col.parent.days : (_pd.tab === 'requests' ? null : t.totals.units_days);
    var footTotal = col.parent ? _pdQtyText(col.parent) : (_pd.tab === 'requests' ? '' : t.totals.units + ' enh');
    var foot = footDays ? '<div class="pd-trow pd-tfoot"' + style + '><span class="pd-tname">' +
        (col.parent ? 'I alt' : 'Enheder') + '</span>' +
        days.map(function (d) { return '<span class="pd-tnum">' + _pdNum(footDays[d]) + '</span>'; }).join('') +
        '<span class="pd-tnum pd-ttotal">' + _pdEsc(footTotal) + '</span>' +
        (metric ? '<span class="pd-tnum">' + _pdColumnHead(col) + '</span>' : '') + '<span></span></div>' : '';

    var empty = col.ids.length ? '' : '<div class="pd-empty">Intet at vise.</div>';
    return '<div class="pd-col pd-table"><div class="pd-tscroll">' + head + rows + foot + '</div>' + empty + '</div>';
}

function _pdColumnHtml(col, depth) {
    var nodes = _pd.tree.nodes;
    var selected = _pd.path[depth];
    var head = _pdColumnHead(col);
    var secs = (depth === 0 && _pd.tab === 'prep' && _pd.tree.sections && _pd.tree.sections.prep) || null;
    var rows = secs ? _pdSectionsHtml(secs, depth, selected)
        : col.ids.length ? col.ids.map(function (id) { return _pdRowHtml(nodes[id], depth, id === selected); }).join('')
        : '<div class="pd-empty">' + (_pd.tab === 'requests' && depth === 0 ? 'Ingen særlige ønsker i det valgte.' : 'Intet at vise.') + '</div>';
    return '<div class="pd-col"><div class="pd-col-head"><span class="pd-col-title">' + _pdEsc(col.title) +
        _pdRecipeLink(col.parent) + '</span>' +
        '<span class="pd-col-sum">' + head + '</span></div><div class="pd-col-rows">' + rows + '</div></div>';
}

/* Skal laves: tre afsnit. "Dækket af lager" er foldet sammen — det er ikke
   noget der skal gøres, men det skal kunne findes. */
function _pdSectionsHtml(secs, depth, selected) {
    var nodes = _pd.tree.nodes;
    if (!secs.length) return '<div class="pd-empty">Intet skal laves i det valgte.</div>';
    return secs.map(function (sec) {
        var open = !sec.collapsed || _pd.coveredOpen;
        var head = '<' + (sec.collapsed ? 'button type="button" data-section-toggle="1"' : 'div') + ' class="pd-sec-head' +
            (sec.collapsed ? ' toggle' : '') + '">' +
            (sec.collapsed ? '<span class="pd-sec-arrow">' + (open ? '▾' : '▸') + '</span> ' : '') +
            '<span class="pd-sec-title">' + _pdEsc(sec.title) + '</span> <span class="pd-sec-count">' + sec.ids.length + '</span>' +
            (sec.note ? '<span class="pd-sec-note">' + _pdEsc(sec.note) + '</span>' : '') +
            '</' + (sec.collapsed ? 'button' : 'div') + '>';
        var rows = open ? sec.ids.map(function (id) { return _pdRowHtml(nodes[id], depth, id === selected); }).join('') : '';
        return head + rows;
    }).join('');
}

/* Link til opskriften bag en vare der skal laves. Samme URL-regel som "Lav
   snart" (recipeUrl i shared/utils.js): batch-tallet kun når udbyttet er kendt —
   ellers åbner vieweren på opskriftens eget portionstal frem for et gæt. */
function _pdRecipeLink(n) {
    if (!n || n.kind !== 'prep' || !n.make || !n.make.recipe_id || typeof recipeUrl !== 'function') return '';
    var url = recipeUrl({ recipeId: n.make.recipe_id, batches: n.make.batches,
        trustBatches: !n.make.estimated && n.status !== 'ok' });
    return ' <a class="pd-recipe-link" href="' + _pdEsc(url) + '" target="_blank" rel="noopener" title="Åbn opskriften ' +
        _pdEsc(n.make.recipe_name || '') + (n.make.batches && !n.make.estimated && n.status !== 'ok' ? ' i ' + n.make.batches + ' batch' + (n.make.batches === 1 ? '' : 'es') : '') +
        ' (ny fane)">Åbn opskrift →</a>';
}

/** Kolonnehovedet summerer ikke — det viser forælderens (eller totalens) færdige tal. */
function _pdColumnHead(col) {
    var t = _pd.tree;
    if (_pdIsFase2()) {
        var fv = col.parent ? col.parent.values : (t.level_totals && t.level_totals[_pd.tab]);
        if (_pd.metric === 'antal') {
            if (!col.parent && _pd.tab === 'prep') {
                var ss = (t.sections && t.sections.prep) || [];
                var todo = 0, cov = 0;
                ss.forEach(function (x) { if (x.key === 'covered') cov += x.ids.length; else todo += x.ids.length; });
                return todo + ' skal laves' + (cov ? ' · ' + cov + ' dækket' : '');
            }
            if (!col.parent) return col.ids.length + ' varegrupper';
            return col.parent.kind === 'raw_group' ? col.ids.length + ' råvarer' : '';
        }
        if (_pd.metric === 'salg' || _pd.metric === 'db') return 'findes ikke her';
        var lbl = fv ? _pdMetricLabel(fv, true) : '';
        return lbl ? lbl + ' · aktuelle priser' : '';
    }
    var v = col.parent ? col.parent.values : (_pd.tab === 'requests' ? null : t.totals);
    if (_pd.metric === 'antal') {
        if (!col.parent && _pd.tab !== 'requests') return t.totals.units + ' enh';
        if (col.parent && col.parent.kind === 'category' && col.parent.counts_as_unit) return col.parent.units + ' enh';
        if (col.parent && col.parent.kind !== 'category') return _pdEsc(_pdQtyText(col.parent)) + ' i alt';
        return '';
    }
    if (!v) return '';
    return _pdMetricLabel(v, true);
}

function _pdMetricLabel(v, head) {
    var m = _pd.metric;
    var out = '', unknown = 0, note = '', val = null;
    if (m === 'kost') { if (v.cost_ex == null) return ''; val = v.cost_ex; out = _pdKr(val) + ' ex'; unknown = v.cost_unknown; }
    else if (m === 'co2') { val = v.co2e_kg; out = _pdKg(val) + ' CO₂e'; unknown = v.co2e_unknown; }
    else if (m === 'salg') {
        if (v.sale_ex == null) return '';
        val = v.sale_ex; out = _pdKr(val) + ' ex'; unknown = v.sale_unknown;
        if (head && v.sale_basis === 'blandet') note = 'inkl. listepriser';
        else if (v.sale_basis === 'liste') note = 'listepris';
    } else if (m === 'db') { if (v.db_ex == null) return ''; val = v.db_ex; out = _pdKr(val) + ' ex'; unknown = v.db_unknown; }
    if (!head) {
        // Kun ukendte tal → "?" frem for et nul der ligner en måling.
        if (unknown && !val) return '<span class="pd-q" title="Ingen tal for denne linje">?</span>';
        return out + (unknown ? ' <span class="pd-q" title="' + unknown + ' linje(r) uden tal — ikke med i summen">+?</span>' : '') +
            (note ? ' <span class="pd-dim">' + note + '</span>' : '');
    }
    return out + (unknown ? ' · ' + unknown + ' ukendte' : '') + (note ? ' · ' + note : '');
}

function _pdQtyText(n) {
    if (n.kind === 'category') return n.counts_as_unit ? String(n.units) : n.qty_display;
    var unit = String(n.unit || '').trim();
    var showUnit = unit && !PD_COUNT_UNITS[unit.toLowerCase()];
    return n.qty_display + (showUnit ? ' ' + unit : '');
}

function _pdRowTitle(n) {
    if (!n) return '';
    if (n.kind === 'standard') return 'Standard';
    if (n.kind === 'request') return '"' + n.name + '"';
    return n.name;
}

function _pdRowHtml(n, depth, isSel) {
    if (!n) return '';
    if (n.kind === 'prep') return _pdPrepRowHtml(n, depth, isSel);
    var hasKids = n.children && n.children.length;
    var dim = n.kind === 'category' && !n.counts_as_unit;
    var sub = [];
    if (n.kind === 'item_requests') sub.push('af ' + n.of_qty);
    if (n.kind === 'source' && n.source && n.source.delivery_date) sub.push(_pdDay(n.source.delivery_date));
    if (n.kind === 'category' && !n.counts_as_unit) sub.push('tæller ikke som enheder');
    var st = _pdStatusBadge(n);
    if (n.kind === 'prep') sub = sub.concat(_pdPrepSub(n));
    if (n.kind === 'raw' || n.kind === 'prep_raw') sub.push('på lager ' + n.stock_display);
    var badge = st + (n.badge ? ' <span class="pd-badge pd-badge-' + (n.badge.tone || 'amber') + '">' + _pdEsc(n.badge.text) + '</span>' : '');
    var right = _pd.metric !== 'antal' && n.values ? _pdMetricLabel(n.values, false) : '';
    if (n.cart) {
        // Som i Råvarer-modalen i dag: mængden er oprundet på serveren.
        right += '<button type="button" class="pd-cart" data-cart="' + _pdEsc(n.id) + '" title="Læg ' +
            _pdEsc(String(n.cart.amount).replace('.', ',') + ' ' + (n.cart.unit || '')) + ' på indkøbslisten">🛒</button>';
    }
    var clickable = hasKids || _pdCanOpenBon(n);
    return '<' + (clickable ? 'button type="button"' : 'div') + ' class="pd-row' + (isSel ? ' selected' : '') + (dim ? ' dim' : '') +
        (clickable ? ' clickable' : '') + '" data-id="' + _pdEsc(n.id) + '" data-depth="' + depth + '">' +
        '<span class="pd-row-main"><span class="pd-row-line"><strong class="pd-qty">' + _pdEsc(_pdQtyText(n)) + '</strong> × ' +
            _pdEsc(_pdRowTitle(n)) + badge + '</span>' +
            (sub.length ? '<span class="pd-row-sub">' + _pdEsc(sub.join(' · ')) + '</span>' : '') + '</span>' +
        (right ? '<span class="pd-row-val">' + right + '</span>' : '') +
        (hasKids ? '<span class="pd-chev">›</span>' : '') +
        (!hasKids && _pdCanOpenBon(n) ? '<span class="pd-open">åbn bon ›</span>' : '') +
    '</' + (clickable ? 'button' : 'div') + '>';
}

/* ── Niveau 4–5: status og undertekst ─────────────────────── */
var PD_STATUS = {
    ok:        { cls: 'ok',   text: 'dækket' },
    kan_laves: { cls: 'warn', text: 'kan laves' },
    lav:       { cls: 'warn', text: 'for lidt' },
    mangler:   { cls: 'bad',  text: 'mangler' },
    ukendt:    { cls: 'dim',  text: 'udbytte mangler' },
};
function _pdStatusBadge(n) {
    if (n.kind === 'raw' || n.kind === 'prep_raw') {
        var s = PD_STATUS[n.status] || PD_STATUS.ok;
        return ' <span class="pd-dot pd-dot-' + s.cls + '" title="' + (n.status === 'ok' ? 'på lager' : s.text) + '"></span>';
    }
    if (n.kind !== 'prep') return '';
    var out = '';
    if (n.production_type === 'on_demand') out += ' <span class="pd-badge pd-badge-blue" title="RR produktion Hurtig — Bon laver den selv når bonen leveres">laves ved levering</span>';
    var s2 = PD_STATUS[n.status];
    if (s2) out += ' <span class="pd-badge pd-badge-' + s2.cls + '">' + s2.text + '</span>';
    return out;
}
function _pdBatchText(n) {
    var m = n.make || {};
    if (n.status === 'ok') return 'dækket';
    if (m.estimated || n.status === 'ukendt') return 'antal batches ukendt';
    if (m.batches) return 'lav ' + m.batches + (m.batches === 1 ? ' batch' : ' batches');
    return 'skal laves';
}

function _pdPrepRowHtml(n, depth, isSel) {
    var m = n.make || {};
    var hasKids = n.children && n.children.length;
    var tone = n.status === 'ok' ? 'ok' : (n.status === 'mangler' || n.status === 'lav') ? 'bad'
        : n.status === 'ukendt' ? 'dim' : 'warn';
    var sub = [];
    if (n.status === 'ok') sub.push('behov ' + n.need_display + ' · lager ' + n.stock_display);
    else sub.push('mangler ' + n.short_display + ' (behov ' + n.need_display + ' · lager ' + n.stock_display + ')');
    var rn = m.recipe_name && m.recipe_name.trim().toLowerCase() !== String(n.name).trim().toLowerCase() ? m.recipe_name : '';
    if (rn && n.status !== 'ok') sub.push('opskrift: ' + rn);
    if (n.status === 'ukendt') sub.push('udbyttet er ikke oplyst i Grocy');
    var missing = (n.status === 'mangler' || n.status === 'lav') && m.missing && m.missing.length
        ? '<span class="pd-row-sub pd-missing">mangler råvarer: ' + _pdEsc(m.missing.join(', ')) + '</span>' : '';
    var used = n.used_in || [];
    var usedHtml = !used.length ? '' : used.length <= 2
        ? '<span class="pd-row-sub">bruges i ' + _pdEsc(used.join(', ')) + '</span>'
        : '<span class="pd-row-sub" title="' + _pdEsc(used.join(', ')) + '">bruges i ' + used.length + ' retter</span>';
    var right = _pd.metric !== 'antal' && n.values ? _pdMetricLabel(n.values, false) : '';
    var tag = hasKids ? 'button type="button"' : 'div';
    return '<' + tag + ' class="pd-row pd-prep' + (isSel ? ' selected' : '') + (n.status === 'ok' ? ' dim' : '') +
        (hasKids ? ' clickable' : '') + '" data-id="' + _pdEsc(n.id) + '" data-depth="' + depth + '">' +
        '<span class="pd-row-main"><span class="pd-row-line"><strong>' + _pdEsc(n.name) + '</strong>' +
            ' <span class="pd-action pd-action-' + tone + '">' + _pdEsc(_pdBatchText(n)) + '</span></span>' +
            '<span class="pd-row-sub">' + _pdEsc(sub.join(' · ')) + '</span>' + missing + usedHtml + '</span>' +
        (right ? '<span class="pd-row-val">' + right + '</span>' : '') +
        // Uden børn er der ingen kolonne at sætte linket i — så står det på rækken.
        // (Et link inde i en <button> er ikke tilladt, derfor kun her.)
        (!hasKids ? _pdRecipeLink(n) : '') +
        (hasKids ? '<span class="pd-chev">›</span>' : '') +
    '</' + (hasKids ? 'button' : 'div') + '>';
}

function _pdPrepSub(n) {
    var out = [];
    var m = n.make || {};
    if (n.status === 'ok') out.push('på lager ' + n.stock_display);
    else if (n.status === 'kan_laves' && m.batches) {
        // Opskriftens navn kun når det siger noget nyt (Frisk Grønt laves af "Frisk Grønt").
        var rn = m.recipe_name && m.recipe_name.trim().toLowerCase() !== String(n.name).trim().toLowerCase() ? ' · ' + m.recipe_name : '';
        out.push('lav ' + m.batches + (m.batches === 1 ? ' batch' : ' batches') + rn);
    }
    else if (n.status === 'ukendt') out.push('udbyttet er ikke oplyst i Grocy (' + (m.recipe_name || 'opskriften') + ')');
    if ((n.status === 'mangler' || n.status === 'lav') && m.missing && m.missing.length) out.push('mangler ' + m.missing.join(', '));
    if (n.used_in && n.used_in.length) out.push('bruges i ' + n.used_in.join(', '));
    return out;
}

function _pdOnCartClick(btn) {
    var n = _pd.tree && _pd.tree.nodes[btn.dataset.cart];
    if (!n || !n.cart || typeof postGrocyShoppingList !== 'function') return;
    btn.disabled = true; btn.textContent = '…';
    postGrocyShoppingList([{ product_id: n.cart.product_id, amount: n.cart.amount, note: n.name }]).then(function () {
        btn.textContent = '✓'; btn.classList.add('done');
        btn.title = 'Lagt på indkøbslisten';
    }).catch(function (err) {
        btn.disabled = false; btn.textContent = '🛒';
        btn.title = 'Kunne ikke lægges på listen: ' + ((err && err.message) || '');
    });
}

/* ── Åbn en bon fra en kilde-række ─────────────────────────
   Office: bon-draweren (onEdit). Køkkenet: bon-info-visningen fra
   shared/modal.js med "Gå til bon →" — samme vej som kalenderen bruger. */
function _pdCanOpenBon(n) {
    return !!(n && n.kind === 'source' && n.source && n.source.bon_id
        && (_pd.opts.onEdit || typeof showBonInfo === 'function'));
}
function _pdOpenBon(bonId, bonNr) {
    if (_pd.opts.onEdit) _pd.opts.onEdit(bonId);
    else if (typeof showBonInfo === 'function') showBonInfo(bonId, { showGotoButton: true, bonNumber: bonNr });
}

function _pdOnRowClick(e) {
    var cart = e.target.closest('.pd-cart');
    if (cart) { _pdOnCartClick(cart); return; }
    if (e.target.closest('[data-section-toggle]')) { _pd.coveredOpen = !_pd.coveredOpen; _pdRenderDrill(); return; }
    var ck = e.target.closest('[data-ck]');
    if (ck) { _pdCheckAction(ck); return; }
    var r = e.target.closest('.pd-row.clickable');
    if (!r) return;
    var n = _pd.tree.nodes[r.dataset.id];
    var depth = Number(r.dataset.depth);
    if (n.children && n.children.length) {
        _pd.path = _pd.path.slice(0, depth).concat(n.id);
        _pdRenderDrill();
    } else if (_pdCanOpenBon(n)) {
        _pdOpenBon(n.source.bon_id, n.source.bon_nr);
    }
}

/* ══════════════════════════════════════════════════════════════
   VAGTPLAN — som i den gamle planlægning (kollapset sektion)
   ══════════════════════════════════════════════════════════════ */
function _pdLoadStaff() {
    var el = _pd.el.querySelector('#pdVagt');
    fetchSmartplanShifts(_pd.from, _pd.to).then(function (shifts) {
        if (!_pd) return;
        _pd.staff = shifts || [];
        _pdRenderStaff();
    }).catch(function (err) {
        if (!_pd || !el) return;
        var msg = (err && err.message) || '';
        var throttled = /429|begrænser|dagsgrænse|minut/i.test(msg);
        el.innerHTML = '<div class="pd-empty">' + (throttled ? '⏳ Vagtplanen kan ikke hentes lige nu' : 'Vagtplan ikke tilgængelig') +
            (msg ? '<br><span class="pd-dim">' + _pdEsc(msg) + '</span>' : '') + '</div>';
    });
}

function _pdRenderStaff() {
    var el = _pd.el.querySelector('#pdVagt');
    if (!el || !_pd.staff) return;
    if (!_pd.staff.length) { el.innerHTML = '<div class="pd-empty">Ingen vagter i perioden</div>'; return; }
    var byDate = {};
    _pd.staff.forEach(function (s) {
        var d = (s.date || '').slice(0, 10);
        if (d) (byDate[d] = byDate[d] || []).push(s);
    });
    el.innerHTML = '<div class="pd-vagt-grid">' + Object.keys(byDate).sort().map(function (d) {
        return '<div class="pd-vagt-day"><div class="pd-vagt-label">' + _pdDay(d) + '</div>' +
            byDate[d].map(function (s) {
                return '<div class="pd-vagt-shift"><span class="pd-dim">' + (s.start || '').slice(11, 16) + '–' + (s.end || '').slice(11, 16) +
                    '</span> ' + _pdEsc(s.first_name || s.employee_name || '?') + '</div>';
            }).join('') + '</div>';
    }).join('') + '</div>';
}

/* ══════════════════════════════════════════════════════════════
   TJEKLISTE (fase 3) — gå lageret igennem, rigtigt tal ind hvis det ikke passer
   ══════════════════════════════════════════════════════════════
   Ingen ny lagerlogik: tjeklisten kalder optællingens egne endpoints (#673).
     ✓ er der     → optællingslinje "uændret" + LastCheckedAt
     passer ikke  → postGrocyInventory med count (Grocy rettes, linjen logges
                    først når Grocy tog imod) + LastCheckedAt
   Én optælling pr. Grocy-lokation, oprettet første gang en vare derfra tjekkes,
   lukket når tjeklisten afsluttes. Afkrydsningerne huskes på tabletten for netop
   dette grundlag (periode + bons + ekstra) indtil det skifter. */

function _pdCheckKey() {
    var ids = Array.from(_pd.selected).sort(function (a, b) { return a - b; });
    var ex = _pd.extras.map(function (x) { return x.grocy_recipe_id + 'x' + x.quantity; }).join(',');
    return 'planning2_check:' + _pd.from + ':' + _pd.to + ':' + ids.join(',') + ':' + ex;
}
function _pdCheckState() {
    var key = _pdCheckKey();
    if (!_pd.ck || _pd.ck.key !== key) {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { saved = null; }
        _pd.ck = { key: key, items: (saved && saved.items) || {}, counts: (saved && saved.counts) || {},
                   finished: !!(saved && saved.finished), prepDone: !!(saved && saved.prepDone), editing: null, busy: {} };
    }
    return _pd.ck;
}
function _pdCheckSave() {
    var c = _pd.ck; if (!c) return;
    _pdSave(c.key, JSON.stringify({ items: c.items, counts: c.counts, finished: c.finished, prepDone: c.prepDone }));
}

/** Varerne på listen: forud-producerede først, så råvarerne i deres varegrupper. */
function _pdCheckGroups() {
    var t = _pd.tree, N = t.nodes, groups = [];
    var made = (t.levels.prep || []).filter(function (id) { return N[id] && N[id].check; });
    if (made.length) groups.push({ title: 'Færdige varer (laves i forvejen)', ids: made });
    (t.levels.raw || []).forEach(function (gid) {
        var ids = (N[gid].children || []).filter(function (id) { return N[id] && N[id].check; });
        if (ids.length) groups.push({ title: N[gid].name, ids: ids });
    });
    return groups;
}

function _pdFmtNum(v) { return String(Math.round((Number(v) || 0) * 1000) / 1000).replace('.', ','); }

function _pdCheckHtml() {
    var c = _pdCheckState(), N = _pd.tree.nodes;
    var groups = _pdCheckGroups();
    var all = [].concat.apply([], groups.map(function (g) { return g.ids; }));
    if (!all.length) return '<div class="pd-col"><div class="pd-empty">Ingen varer at tjekke for det valgte.</div></div>';
    var done = all.filter(function (id) { var st = c.items[N[id].check.product_id]; return st && (st.state === 'ok' || st.state === 'fixed'); }).length;

    var html = '<div class="pd-col pd-check"><div class="pd-col-head"><span class="pd-col-title">Tjekliste — er varerne fysisk på lager?</span>' +
        '<span class="pd-col-sum"><strong>' + done + ' af ' + all.length + '</strong> tjekket</span></div>' +
        '<div class="pd-check-bar"><span style="width:' + Math.round(done / all.length * 100) + '%"></span></div>';

    groups.forEach(function (g) {
        html += '<div class="pd-sec-head"><span class="pd-sec-title">' + _pdEsc(g.title) + '</span> <span class="pd-sec-count">' + g.ids.length + '</span></div>';
        g.ids.forEach(function (id) { html += _pdCheckRow(N[id], c); });
    });

    html += '<div class="pd-check-foot">' + _pdCheckFoot(c, done, all) + '</div></div>';
    return html;
}

function _pdCheckRow(n, c) {
    var k = n.check, st = c.items[k.product_id] || {}, pid = k.product_id;
    var unit = k.stock_unit || '';
    var busy = c.busy[pid];
    // Behov og lager i LAGER-enheden — den tallet tastes i. Visningsenheden (fx
    // "5 stk" brød) i parentes, når den er en anden.
    var disp = n.need_display || (n.qty_display + ' ' + (n.unit || ''));
    var needStock = _pdFmtNum(k.need_qty) + ' ' + unit;
    var info = '<span class="pd-row-sub">behov ' + _pdEsc(needStock) +
        (n.unit && unit && String(n.unit).toLowerCase() !== String(unit).toLowerCase() ? ' (' + _pdEsc(disp) + ')' : '') +
        ' · lager ' + _pdEsc(_pdFmtNum(k.stock_qty) + ' ' + unit) + '</span>';
    var right = '';
    if (busy) {
        right = '<span class="pd-dim">' + (c.editing === pid ? 'Retter lageret…' : 'Gemmer…') + '</span>';
    } else if (c.editing === pid) {
        right = '<span class="pd-ck-edit">talt <input type="text" inputmode="decimal" class="pd-ck-input" id="pdCkInput" value="' +
            _pdEsc(_pdFmtNum(k.stock_qty)) + '"> ' + _pdEsc(unit) +
            ' <button type="button" class="pd-btn pd-btn-primary" data-ck="save" data-pid="' + pid + '">Ret lager</button>' +
            ' <button type="button" class="pd-btn" data-ck="cancel" data-pid="' + pid + '">Annullér</button></span>';
    } else if (st.state === 'ok') {
        right = '<span class="pd-ck-done ok">✓ er der</span> <button type="button" class="pd-ck-undo" data-ck="undo" data-pid="' + pid + '">fortryd</button>';
    } else if (st.state === 'fixed') {
        right = '<span class="pd-ck-done fixed">talt ' + _pdEsc(_pdFmtNum(st.counted) + ' ' + unit) + ' · lager rettet</span>';
    } else {
        right = '<button type="button" class="pd-btn pd-ck-ok" data-ck="ok" data-pid="' + pid + '"' + (busy ? ' disabled' : '') + '>✓ er der</button>' +
            ' <button type="button" class="pd-btn" data-ck="bad" data-pid="' + pid + '"' + (busy ? ' disabled' : '') + '>passer ikke</button>';
    }
    var err = st.error ? '<span class="pd-row-sub pd-missing">' + _pdEsc(st.error) + '</span>' : '';
    var cart = n.cart && (st.state === 'fixed' || n.status !== 'ok')
        ? ' <button type="button" class="pd-cart" data-cart="' + _pdEsc(n.id) + '" title="Læg ' +
          _pdEsc(String(n.cart.amount).replace('.', ',') + ' ' + (n.cart.unit || '')) + ' på indkøbslisten">🛒</button>' : '';
    var dot = n.kind === 'raw' ? _pdStatusBadge(n) : '';
    return '<div class="pd-row pd-ck-row' + (st.state ? ' ck-' + st.state : '') + '" data-id="' + _pdEsc(n.id) + '">' +
        '<span class="pd-row-main"><span class="pd-row-line"><strong>' + _pdEsc(n.name) + '</strong>' + dot + '</span>' + info + err + '</span>' +
        '<span class="pd-ck-actions">' + right + cart + '</span></div>';
}

function _pdCheckFoot(c, done, all) {
    var N = _pd.tree.nodes;
    if (!c.finished) {
        var left = all.length - done;
        return '<button type="button" class="pd-btn pd-btn-primary" data-ck="finish"' + (left ? ' disabled' : '') + '>Afslut tjekliste</button>' +
            (left ? ' <span class="pd-dim">' + left + ' mangler at blive tjekket</span>' : '') +
            ' <button type="button" class="pd-btn pd-ck-reset" data-ck="reset">Start forfra</button>';
    }
    // Råvarer ✓ kun når alle råvarer (niveau 5) nu står dækket — efter rettelserne.
    var short = (_pd.tree.levels.raw || []).reduce(function (a, gid) {
        return a.concat((N[gid].children || []).filter(function (id) { return N[id].status !== 'ok'; }));
    }, []);
    var bons = _pdCheckBons();
    var out = '<span class="pd-ck-summary">✓ Tjeklisten er afsluttet.</span> ';
    var bonTxt = bons.length + (bons.length === 1 ? ' bon' : ' bons');
    if (c.prepDone) out += '<span class="pd-ck-done ok">Råvarer ✓ er sat på ' + bonTxt + '</span>';
    else if (short.length) {
        out += '<span class="pd-missing">' + short.length + ' råvare' + (short.length === 1 ? '' : 'r') + ' mangler stadig (' +
            _pdEsc(short.slice(0, 5).map(function (id) { return N[id].name; }).join(', ')) + (short.length > 5 ? ' …' : '') +
            ') — Råvarer ✓ sættes ikke.</span>';
    } else if (bons.length) {
        out += '<button type="button" class="pd-btn pd-btn-primary" data-ck="prep">Sæt Råvarer ✓ på ' + bonTxt + '</button>';
    }
    return out + ' <button type="button" class="pd-btn pd-ck-reset" data-ck="reset">Start forfra</button>';
}

/** De bons Råvarer ✓ sættes på: valgte, produktion (ikke event-salg/udgift), ikke tilbud. */
function _pdCheckBons() {
    return _pd.bons.filter(function (b) {
        return _pd.selected.has(b.id) && !b.is_offer && b.event_role !== 'sales' && b.event_role !== 'expense';
    });
}

async function _pdEnsureCount(locationId, physicalName) {
    var c = _pd.ck;
    if (!locationId) return null;
    if (c.counts[locationId]) return c.counts[locationId];
    var r = await createStockCount(locationId, null, physicalName || null);
    c.counts[locationId] = r.count.id;
    _pdCheckSave();
    return r.count.id;
}

async function _pdCheckAction(btn) {
    var c = _pdCheckState(), N = _pd.tree.nodes;
    var act = btn.dataset.ck, pid = Number(btn.dataset.pid);
    var node = null;
    if (pid) Object.keys(N).some(function (id) { if (N[id].check && N[id].check.product_id === pid) { node = N[id]; return true; } return false; });
    var k = node && node.check;

    if (act === 'bad') { c.editing = pid; _pdRenderDrill(); var inp = document.getElementById('pdCkInput'); if (inp) { inp.focus(); inp.select(); } return; }
    if (act === 'cancel') { c.editing = null; _pdRenderDrill(); return; }
    if (act === 'undo') { delete c.items[pid]; _pdCheckSave(); _pdRenderDrill(); return; }
    if (act === 'reset') {
        if (!confirm('Start tjeklisten forfra? Det der allerede er rettet i lageret, bliver stående.')) return;
        await _pdFinishCounts();
        localStorage.removeItem(c.key); _pd.ck = null; _pdRenderDrill(); return;
    }
    if (act === 'finish') { await _pdFinishCounts(); c.finished = true; _pdCheckSave(); _pdRenderDrill(); return; }
    if (act === 'prep') {
        var bons = _pdCheckBons();
        btn.disabled = true; btn.textContent = 'Sætter…';
        var fejl = 0;
        for (var i = 0; i < bons.length; i++) {
            try { await patchBonPrep(bons[i].id, true, undefined, 'fra planlægningens tjekliste'); } catch (e) { fejl++; }
        }
        if (fejl) { btn.disabled = false; btn.textContent = 'Prøv igen (' + fejl + ' fejlede)'; return; }
        c.prepDone = true; _pdCheckSave(); _pdRenderDrill(); return;
    }
    if (!k) return;

    var physical = k.physical_unit_name || 'Tjekliste (planlægning)';
    // Læs tallet FØR der tegnes om — ellers er feltet væk.
    var raw = act === 'save' ? ((document.getElementById('pdCkInput') || {}).value || '') : '';
    if (c.busy[pid]) return;   // et tryk er allerede på vej
    c.busy[pid] = true; delete (c.items[pid] || {}).error;
    // Grocy kan være et par sekunder om det — vis at der sker noget, og lås knapperne.
    _pdRenderDrill();
    try {
        var countId = await _pdEnsureCount(k.location_id, k.physical_unit_name);
        if (act === 'ok') {
            if (countId) {
                var r1 = await postStockCountLines(countId, [{ product_id: pid, product_name: node.name, expected_qty: k.stock_qty,
                    outcome: 'unchanged', lines: [{ physical_unit_name: physical, stock_qty: k.stock_qty }] }]);
                if (r1 && r1.errors && r1.errors.length) throw new Error('ikke logget: ' + r1.errors[0].error);
            }
            c.items[pid] = { state: 'ok', at: Date.now(), error: countId ? null : 'Varen har ingen lokation i Grocy — tjekket, men ikke logget.' };
        } else if (act === 'save') {
            var amount = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
            if (!Number.isFinite(amount) || amount < 0) throw new Error('Skriv et tal (0 eller mere).');
            var r2 = await postGrocyInventory(pid, amount, undefined, undefined, countId ? {
                id: countId, product_name: node.name, expected_qty: k.stock_qty,
                lines: [{ physical_unit_name: physical, stock_qty: amount }] } : null);
            c.items[pid] = { state: 'fixed', counted: amount, at: Date.now(),
                error: r2 && r2.log_error ? 'Lageret er rettet, men ikke logget: ' + r2.log_error
                     : (countId ? null : 'Varen har ingen lokation i Grocy — lageret er rettet, men ikke logget.') };
            c.editing = null;
            _pdLoadTree();   // nyt lagertal og ny status fra serveren
        }
        // Et tjek uden ændring er også et tjek (#613).
        try { await putGrocyProductUserfields(pid, { LastCheckedAt: new Date().toISOString() }); } catch (e) { /* ikke kritisk */ }
    } catch (err) {
        c.items[pid] = Object.assign({}, c.items[pid] || {}, { error: (err && err.message) || 'Fejl' });
    } finally {
        delete c.busy[pid];
        _pdCheckSave();
        _pdRenderDrill();
    }
}

async function _pdFinishCounts() {
    var c = _pd.ck; if (!c) return;
    var ids = Object.keys(c.counts);
    for (var i = 0; i < ids.length; i++) {
        try { await finishStockCount(c.counts[ids[i]]); } catch (e) { /* allerede lukket */ }
    }
    c.counts = {};
    _pdCheckSave();
}
