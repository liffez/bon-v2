/**
 * shared/planning.js
 * ════════════════════════════════════════════════════════════
 * Planlægningsbon — aggregerer menu-linjer på tværs af bons.
 *
 * API:
 *   initPlanning(containerEl, options)
 *
 * Options:
 *   zone:      'kitchen' | 'office'
 *   onEdit:    function(bonId)   — åbn drawer
 *
 * Afhængigheder (load order):
 *   BonConfig.js     → BON_CONFIG.statuses
 *   shared/utils.js  → statusToFrontend, formatDanishDate, esc, connectSSE, getClientId
 *   shared/api.js    → fetchBonsPlanning, fetchSettings
 *   shared/bon_kort_builder.js → createPlanningCard (optional)
 * ════════════════════════════════════════════════════════════
 */

/* ── Intern state ──────────────────────────────────────────── */
var _plContainer   = null;
var _plOptions     = {};
var _plFrom        = '';
var _plTo          = '';
var _plStatuses    = {};       // status-key → boolean (aktiv)
var _plShowOffers  = false;
var _plSelectedIds = new Set(); // bon-id'er der er checked
var _plBons        = [];       // rådata fra API
var _plAggregated  = [];       // beregnede linjer
var _plShowPrices  = false;
var _plVatMode     = 'incl';   // 'incl' = m/moms, 'excl' = u/moms (linje-priser)
var _plLoading     = false;
var _plStaffData   = null;
var _plExtraLines  = []; // session-local ad-hoc opskrifter (mistes ved reload)
var _plExtraSeq    = 1;  // lokal ID-generator til fjern-knap
var _plExtraPicker = null; // VarePicker instance

var _PL_WEEKDAYS = ['Søn','Man','Tir','Ons','Tor','Fre','Lør'];
var _PL_MONTHS   = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

/* Festival-salgsbons (event_role='sales') + udgifter er IKKE produktion — maden er
   allerede talt i prep-bonnen. Spejler db/helpers.js countsAsWorkload(). */
function _plCountsAsWorkload(b) {
    return !b || (b.event_role !== 'sales' && b.event_role !== 'expense');
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
function initPlanning(containerEl, options) {
    _plContainer = containerEl;
    _plOptions   = options || {};

    // Periode: options.from/to > URL ?from/?to > default (indeværende uge)
    var urlParams = new URLSearchParams(window.location.search);
    var optFrom = _plOptions.from || urlParams.get('from');
    var optTo   = _plOptions.to   || urlParams.get('to');
    var isoDate = /^\d{4}-\d{2}-\d{2}$/;

    if (optFrom && isoDate.test(optFrom) && optTo && isoDate.test(optTo)) {
        _plFrom = optFrom;
        _plTo   = optTo;
    } else {
        var now = new Date();
        var dow = now.getDay() || 7;
        var mon = new Date(now);
        mon.setDate(mon.getDate() - dow + 1);
        var sun = new Date(mon);
        sun.setDate(sun.getDate() + 6);
        _plFrom = mon.toISOString().slice(0, 10);
        _plTo   = sun.toISOString().slice(0, 10);
    }

    // Status-filter fra localStorage eller defaults
    var saved = localStorage.getItem('planning_status_filter');
    if (saved) {
        try { _plStatuses = JSON.parse(saved); } catch(e) { _plStatuses = {}; }
    }
    if (!Object.keys(_plStatuses).length) {
        _plStatuses = { godkendt: true, igang: true, klar: true, lev: true };
    }

    _plShowOffers = localStorage.getItem('planning_show_offers') === 'true';

    // Hent pris-setting fra server, render shell imens
    _plRenderShell();
    _plLoadData();
    _plInitSSE();

    fetchSettings().then(function(settings) {
        var s = (settings || []).find(function(r) { return r.key === 'show_prices_in_planning'; });
        var val = s ? s.value === '1' : false;
        if (val !== _plShowPrices) {
            _plShowPrices = val;
            _plUpdatePriceToggle();
            _plRenderResult();
        }
    }).catch(function() {});
}

/* ══════════════════════════════════════════════════════════════
   SHELL
   ══════════════════════════════════════════════════════════════ */
function _plRenderShell() {
    _plContainer.innerHTML = '';
    _plContainer.className = 'planning-wrap';

    // ── Vagtplan toggle ──
    var zone = _plOptions.zone || 'kitchen';
    var vpKey = 'planning_vagtplan_open_' + zone;
    var vpOpen = localStorage.getItem(vpKey) === 'true';
    var vpEl = document.createElement('div');
    vpEl.className = 'pl-vagtplan-wrap';
    vpEl.innerHTML =
        '<button class="pl-vagtplan-toggle" id="plVagtToggle">' +
            '<span class="pl-vagtplan-arrow" id="plVagtArrow">' + (vpOpen ? '▼' : '▶') + '</span>' +
            ' Vagtplan for perioden' +
        '</button>' +
        '<div class="pl-vagtplan-content' + (vpOpen ? ' open' : '') + '" id="plVagtContent"></div>';
    _plContainer.appendChild(vpEl);

    // ── Periode-valg ──
    var periodeEl = document.createElement('div');
    periodeEl.className = 'pl-periode';
    periodeEl.innerHTML =
        '<div class="pl-periode-row">' +
            '<label>Fra <input type="date" id="plFrom" value="' + _plFrom + '"></label>' +
            '<label>Til <input type="date" id="plTo" value="' + _plTo + '"></label>' +
            '<button class="pl-week-btn" id="plPrevWeek" title="Forrige uge">◀</button>' +
            '<button class="pl-week-btn" id="plNextWeek" title="Næste uge">▶</button>' +
        '</div>';
    _plContainer.appendChild(periodeEl);

    // ── Status-filter ──
    var filterBar = document.createElement('div');
    filterBar.className = 'pl-status-filters';
    filterBar.id = 'plFilters';
    _plContainer.appendChild(filterBar);
    _plBuildStatusFilters();

    // ── Bon-liste ──
    var bonListWrap = document.createElement('div');
    bonListWrap.className = 'pl-bon-list-wrap';
    bonListWrap.innerHTML =
        '<div class="pl-bon-list-header">' +
            '<span class="pl-bon-list-title">BONS I PERIODEN</span>' +
            '<span class="pl-bon-list-count" id="plBonCount"></span>' +
            '<button class="pl-select-all-btn" id="plSelectAll">Vælg alle</button>' +
        '</div>' +
        '<div class="pl-bon-list" id="plBonList"></div>';
    _plContainer.appendChild(bonListWrap);

    // ── Ekstra opskrifter (session-local) ──
    var extrasWrap = document.createElement('div');
    extrasWrap.className = 'pl-extras-wrap';
    extrasWrap.innerHTML =
        '<div class="pl-bon-list-header">' +
            '<span class="pl-bon-list-title">EKSTRA OPSKRIFTER</span>' +
            '<span class="pl-bon-list-count" id="plExtraCount"></span>' +
            '<button class="pl-select-all-btn" id="plAddExtra">+ Tilføj opskrift</button>' +
        '</div>' +
        '<div class="pl-extras-list" id="plExtrasList"></div>' +
        '<div class="pl-extras-picker" id="plExtrasPicker"></div>';
    _plContainer.appendChild(extrasWrap);

    // ── Aggregeret resultat ──
    var resultEl = document.createElement('div');
    resultEl.className = 'pl-result';
    resultEl.id = 'plResult';
    _plContainer.appendChild(resultEl);

    // ── Wire events ──
    document.getElementById('plFrom').addEventListener('change', function() {
        _plFrom = this.value;
        _plLoadData();
    });
    document.getElementById('plTo').addEventListener('change', function() {
        _plTo = this.value;
        _plLoadData();
    });
    document.getElementById('plPrevWeek').addEventListener('click', function() {
        _plShiftWeek(-7);
    });
    document.getElementById('plNextWeek').addEventListener('click', function() {
        _plShiftWeek(7);
    });
    document.getElementById('plSelectAll').addEventListener('click', _plToggleSelectAll);
    document.getElementById('plAddExtra').addEventListener('click', _plToggleExtraPicker);
    _plRenderExtras();

    // Vagtplan toggle
    document.getElementById('plVagtToggle').addEventListener('click', function() {
        var content = document.getElementById('plVagtContent');
        var arrow = document.getElementById('plVagtArrow');
        var isOpen = content.classList.toggle('open');
        arrow.textContent = isOpen ? '▼' : '▶';
        localStorage.setItem(vpKey, isOpen ? 'true' : 'false');
        if (isOpen && !_plStaffData) _plLoadStaff();
    });

    // Load staff if vagtplan is open
    if (vpOpen) _plLoadStaff();
}

/* ── Periode-navigation ────────────────────────────────────── */
function _plShiftWeek(days) {
    var f = new Date(_plFrom);
    var t = new Date(_plTo);
    f.setDate(f.getDate() + days);
    t.setDate(t.getDate() + days);
    _plFrom = f.toISOString().slice(0, 10);
    _plTo   = t.toISOString().slice(0, 10);
    document.getElementById('plFrom').value = _plFrom;
    document.getElementById('plTo').value   = _plTo;
    _plLoadData();
}

/* ── Status-filtre ─────────────────────────────────────────── */
function _plBuildStatusFilters() {
    var bar = document.getElementById('plFilters');
    if (!bar || typeof BON_CONFIG === 'undefined') return;
    bar.innerHTML = '';

    var statuses = BON_CONFIG.statuses;
    for (var key in statuses) {
        if (!statuses.hasOwnProperty(key)) continue;
        if (key === 'aflyst') continue; // aldrig relevant
        var cfg = statuses[key];
        var active = !!_plStatuses[key];

        var btn = document.createElement('button');
        btn.className = 'pl-filter-btn' + (active ? ' active' : '');
        btn.dataset.status = key;
        btn.textContent = cfg.label;
        if (active) {
            btn.style.background = cfg.color;
            btn.style.color = cfg.text;
        } else {
            btn.style.background = 'transparent';
            btn.style.color = cfg.color;
            btn.style.border = '1px solid ' + cfg.color;
        }
        btn.addEventListener('click', _plToggleStatus);
        bar.appendChild(btn);
    }

    // Tilbuds-toggle (SPEC_007). Persisterer i localStorage som status-filtrene.
    // Tilbud har is_offer=1 og inkluderes/ekskluderes i _plLoadData baseret på _plShowOffers.
    var offerBtn = document.createElement('button');
    offerBtn.className = 'pl-filter-btn pl-toggle-offers' + (_plShowOffers ? ' active' : '');
    offerBtn.dataset.pl = 'toggle-offers';
    offerBtn.setAttribute('aria-pressed', _plShowOffers ? 'true' : 'false');
    offerBtn.setAttribute('aria-label', _plShowOffers ? 'Skjul tilbud i planlægning' : 'Vis tilbud i planlægning');
    offerBtn.textContent = (_plShowOffers ? '✓ ' : '× ') + 'Tilbud';
    offerBtn.addEventListener('click', _plToggleOffers);
    bar.appendChild(offerBtn);
}

function _plToggleOffers() {
    _plShowOffers = !_plShowOffers;
    localStorage.setItem('planning_show_offers', _plShowOffers ? 'true' : 'false');
    _plBuildStatusFilters();  // re-render knap
    _plLoadData();            // re-fetch så listen opdateres
}

function _plToggleStatus(e) {
    var key = e.target.dataset.status;
    _plStatuses[key] = !_plStatuses[key];
    localStorage.setItem('planning_status_filter', JSON.stringify(_plStatuses));
    _plBuildStatusFilters();
    _plLoadData();
}

/* ══════════════════════════════════════════════════════════════
   DATA
   ══════════════════════════════════════════════════════════════ */
function _plLoadData() {
    if (_plLoading) return;
    _plLoading = true;

    // Byg status-param fra aktive filtre.
    // VIGTIGT: oversæt frontend-nøgler til backend-koder (fx 'lev' → 'LEVERET').
    // Alle andre nøgler uppercaser til deres egen DB-kode, men 'lev' afviger —
    // uden mapping filtreres LEVERET-bons væk og forsvinder fra planlægningen.
    var codes = [];
    for (var k in _plStatuses) {
        if (_plStatuses[k]) codes.push(statusToBackend(k));
    }
    var statusParam = codes.join(',');

    // Re-load staff if vagtplan is open
    var vpContent = document.getElementById('plVagtContent');
    if (vpContent && vpContent.classList.contains('open')) {
        _plStaffData = null;
        _plLoadStaff();
    }

    fetchBonsPlanning(_plFrom, _plTo, statusParam).then(function(bons) {
        // Dedup på id — API'et returnerer hver bon én gang, men en defensiv
        // dedup forhindrer dobbelt-rækker (set fx B4069 vist to gange) hvis et
        // svar/SSE-flow nogensinde leverer samme bon to gange.
        var seen = {};
        _plBons = (bons || []).filter(function(b) {
            if (seen[b.id]) return false;
            seen[b.id] = true;
            return true;
        });
        _plLoading = false;

        // Filtrer tilbud hvis ikke vist
        var filtered = _plBons;
        if (!_plShowOffers) {
            filtered = _plBons.filter(function(b) { return !b.is_offer; });
        }

        // Default: alle valgt
        var newSelected = new Set();
        filtered.forEach(function(b) {
            if (_plSelectedIds.has(b.id) || _plSelectedIds.size === 0) {
                newSelected.add(b.id);
            }
        });
        _plSelectedIds = newSelected;

        _plRenderBonList(filtered);
        _plAggregate();
    }).catch(function(err) {
        _plLoading = false;
        console.error('Planning fetch fejlede:', err);
    });
}

/* ── Bon-liste ─────────────────────────────────────────────── */
function _plRenderBonList(bons) {
    var list = document.getElementById('plBonList');
    var countEl = document.getElementById('plBonCount');
    if (!list) return;

    if (countEl) {
        var totalUnits = 0;
        bons.forEach(function(b) {
            if (_plSelectedIds.has(b.id) && _plCountsAsWorkload(b)) totalUnits += (b.total_units > 0 ? b.total_units : (b.pax || 0));
        });
        countEl.textContent = bons.length + ' bons · ' + totalUnits + ' enh';
    }

    if (!bons.length) {
        list.innerHTML = '<div class="pl-empty">Ingen bons i perioden</div>';
        return;
    }

    var html = '';
    bons.forEach(function(b) {
        var checked = _plSelectedIds.has(b.id) ? ' checked' : '';
        var d = new Date(b.delivery_date + 'T00:00:00');
        var dayStr = _PL_WEEKDAYS[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
        var isOffer = b.is_offer ? ' pl-offer' : '';
        var statusCode = (b.status_code || '').toLowerCase();
        var statusCfg = BON_CONFIG.statuses[statusCode] || {};

        html += '<label class="pl-bon-row' + isOffer + '">' +
            '<input type="checkbox" class="pl-bon-check" data-bon-id="' + b.id + '"' + checked + '>' +
            '<span class="pl-bon-nr">#' + (b.bon_number || b.id) + '</span>' +
            '<span class="pl-bon-status" style="background:' + (statusCfg.color || '#999') + ';color:' + (statusCfg.text || '#fff') + '">' + (statusCfg.label || statusCode) + '</span>' +
            '<span class="pl-bon-customer">' + esc(b.company_name || b.contact_name_full || '') + '</span>' +
            '<span class="pl-bon-date">' + dayStr + '</span>' +
            '<span class="pl-bon-units">' + (b.total_units || b.pax || 0) + ' enh</span>' +
        '</label>';
    });
    list.innerHTML = html;

    // Wire checkbox events
    list.querySelectorAll('.pl-bon-check').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var id = parseInt(this.dataset.bonId);
            if (this.checked) _plSelectedIds.add(id);
            else _plSelectedIds.delete(id);
            _plAggregate();
            _plUpdateCount();
        });
    });
}

function _plUpdateCount() {
    var countEl = document.getElementById('plBonCount');
    if (!countEl) return;
    var totalUnits = 0;
    _plBons.forEach(function(b) {
        if (_plSelectedIds.has(b.id) && _plCountsAsWorkload(b)) totalUnits += (b.total_units > 0 ? b.total_units : (b.pax || 0));
    });
    var count = 0;
    _plBons.forEach(function(b) { if (_plSelectedIds.has(b.id)) count++; });
    countEl.textContent = count + ' bons · ' + totalUnits + ' enh';
}

function _plToggleSelectAll() {
    var allChecked = true;
    var checkboxes = document.querySelectorAll('.pl-bon-check');
    checkboxes.forEach(function(cb) { if (!cb.checked) allChecked = false; });

    checkboxes.forEach(function(cb) {
        cb.checked = !allChecked;
        var id = parseInt(cb.dataset.bonId);
        if (!allChecked) _plSelectedIds.add(id);
        else _plSelectedIds.delete(id);
    });

    var btn = document.getElementById('plSelectAll');
    if (btn) btn.textContent = allChecked ? 'Vælg alle' : 'Fravælg alle';

    _plAggregate();
    _plUpdateCount();
}

/* ══════════════════════════════════════════════════════════════
   EKSTRA OPSKRIFTER (session-local)
   ══════════════════════════════════════════════════════════════ */
function _plRenderExtras() {
    var list = document.getElementById('plExtrasList');
    var countEl = document.getElementById('plExtraCount');
    if (!list) return;

    if (countEl) {
        var totalQty = _plExtraLines.reduce(function(s, l) { return s + (l.quantity || 0); }, 0);
        countEl.textContent = _plExtraLines.length
            ? _plExtraLines.length + ' varer · ' + totalQty + ' enh'
            : '';
    }

    if (!_plExtraLines.length) {
        list.innerHTML = '<div class="pl-extras-empty">Ingen ekstra opskrifter — klik "+ Tilføj opskrift"</div>';
        return;
    }

    var html = '';
    _plExtraLines.forEach(function(l) {
        var cat = (l.category || '').replace(/^\d+\s+/, '');
        html += '<div class="pl-extra-row" data-extra-id="' + l._extraId + '">' +
            '<span class="pl-extra-qty"><strong>' + l.quantity + '</strong> ' + esc(l.unit || 'stk') + '</span>' +
            '<span class="pl-extra-name">' + esc(l.product_name) + '</span>' +
            '<span class="pl-extra-cat">' + esc(cat) + '</span>' +
            '<span class="pl-extra-pricecat">' + esc(l.price_category || '') + '</span>' +
            '<button class="pl-extra-remove" title="Fjern">×</button>' +
        '</div>';
    });
    list.innerHTML = html;

    list.querySelectorAll('.pl-extra-remove').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var row = btn.closest('.pl-extra-row');
            if (!row) return;
            var id = parseInt(row.dataset.extraId);
            _plExtraLines = _plExtraLines.filter(function(l) { return l._extraId !== id; });
            _plRenderExtras();
            _plAggregate();
        });
    });
}

function _plToggleExtraPicker() {
    var pickerEl = document.getElementById('plExtrasPicker');
    var btn = document.getElementById('plAddExtra');
    if (!pickerEl) return;

    if (_plExtraPicker && _plExtraPicker._visible) {
        _plExtraPicker.close();
        _plExtraPicker = null;
        if (btn) btn.textContent = '+ Tilføj opskrift';
        return;
    }

    if (typeof VarePicker === 'undefined') {
        console.error('VarePicker ikke loadet');
        return;
    }

    _plExtraPicker = new VarePicker({
        bonId: null, // detached mode
        priceCategory: 'catering',
        container: pickerEl,
        viewName: 'planning',
        showPriceCategorySelector: true,
        onAdded: function(line) {
            line._extraId = _plExtraSeq++;
            _plExtraLines.push(line);
            _plRenderExtras();
            _plAggregate();
        },
    });
    _plExtraPicker.open();
    if (btn) btn.textContent = 'Luk';
}

/* ══════════════════════════════════════════════════════════════
   AGGREGERING
   ══════════════════════════════════════════════════════════════ */
function _plAggregate() {
    var map = {}; // nøgle → aggregeret linje

    function addLine(line) {
        // Nøgle: grocy_recipe_id eller product_name+unit
        var key = line.grocy_recipe_id
            ? 'r:' + line.grocy_recipe_id
            : 'n:' + (line.product_name || '') + '|' + (line.unit || '');

        if (!map[key]) {
            map[key] = {
                grocy_recipe_id: line.grocy_recipe_id,
                product_name:    line.product_name,
                category:        line.category || '',
                unit:            line.unit || 'stk',
                quantity:        0,
                unit_price:      0,
                cost_price:      0,
                co2e:            0,
                is_accessory:    line.is_accessory,
                _price_count:    0
            };
        }
        var agg = map[key];
        agg.quantity += (line.quantity || 0);
        if (line.unit_price) {
            agg.unit_price += (line.unit_price * (line.quantity || 0));
            agg.cost_price += ((line.cost_price || 0) * (line.quantity || 0));
            agg._price_count += (line.quantity || 0);
        }
        if (line.co2e) agg.co2e += (line.co2e * (line.quantity || 0));
    }

    _plBons.forEach(function(bon) {
        if (!_plSelectedIds.has(bon.id)) return;
        if (!bon.lines) return;
        // Festival-salgsbons (event_role='sales') + udgifter er IKKE produktion —
        // maden er allerede talt i prep-bonnen. Spring dem over i produktions-aggregeringen.
        if (bon.event_role === 'sales' || bon.event_role === 'expense') return;
        bon.lines.forEach(addLine);
    });

    // Ekstra opskrifter (session-local) — altid inkluderet
    _plExtraLines.forEach(addLine);

    // Beregn vægtet gennemsnit for priser
    _plAggregated = Object.values(map).map(function(a) {
        if (a._price_count > 0) {
            a.unit_price = a.unit_price / a._price_count;
            a.cost_price = a.cost_price / a._price_count;
            a.co2e       = a.co2e / a._price_count;
        }
        delete a._price_count;
        return a;
    });

    // Sortér efter kategori → navn
    _plAggregated.sort(function(a, b) {
        var ca = a.category || 'ZZZ';
        var cb = b.category || 'ZZZ';
        if (ca !== cb) return ca.localeCompare(cb, 'da');
        return (a.product_name || '').localeCompare(b.product_name || '', 'da');
    });

    _plRenderResult();
}

/* ══════════════════════════════════════════════════════════════
   RESULTAT — aggregeret bon
   ══════════════════════════════════════════════════════════════ */
function _plRenderResult() {
    var el = document.getElementById('plResult');
    if (!el) return;

    if (!_plAggregated.length) {
        el.innerHTML = '<div class="pl-empty">Ingen varer at vise — vælg mindst én bon</div>';
        return;
    }

    var totalQty = 0;
    var totalSales = 0;
    var totalCost = 0;

    // Gruppér efter kategori
    var categories = {};
    _plAggregated.forEach(function(line) {
        var cat = line.category || 'Andet';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(line);
        totalQty += line.quantity;
        totalSales += (line.unit_price || 0) * line.quantity;
        totalCost += (line.cost_price || 0) * line.quantity;
    });

    var html = '<div class="pl-result-header">' +
        '<span class="pl-result-title">AGGREGERET PRODUKTIONSOVERSIGT</span>' +
        '<span class="pl-result-meta">' + _plAggregated.length + ' varer · ' + totalQty + ' enheder</span>' +
        '<div class="pl-result-actions">' +
            '<button class="pl-action-btn' + (_plShowPrices ? ' pl-price-toggle-active' : '') + '" id="plBtnPrices" title="' + (_plShowPrices ? 'Skjul priser' : 'Vis priser') + '">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>' +
                ' Priser' +
            '</button>' +
            '<button class="pl-action-btn" id="plBtnRavarer" title="Råvarer">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>' +
                ' Råvarer' +
            '</button>' +
            '<button class="pl-action-btn" id="plBtnSummary" title="Sammentælling">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="14" y2="18"/></svg>' +
                ' Sammentælling' +
            '</button>' +
        '</div>' +
    '</div>';

    var isExcl = _plVatMode === 'excl';
    // vatDiv er en lokal toggle: når brugeren har valgt "u/moms"-visning, divideres
    // linjepriser med MOMS_FACTOR for at give ex-moms; ellers vises priserne 1:1 (incl moms).
    var vatDiv = isExcl ? Moms.MOMS_FACTOR : 1;
    var vatLabel = isExcl ? 'u/moms' : 'm/moms';

    html += '<table class="pl-result-table"><thead><tr>' +
        '<th class="pl-col-qty">Antal</th>' +
        '<th class="pl-col-name">Vare</th>' +
        '<th class="pl-col-cat">Kategori</th>';
    if (_plShowPrices) {
        html += '<th class="pl-col-price">Stk-pris' +
                    ' <button class="pl-vat-toggle" id="plVatToggle" title="Skift moms-visning">' + vatLabel + '</button>' +
                '</th>' +
                '<th class="pl-col-cost">Kostpris</th>' +
                '<th class="pl-col-total">Total</th>';
    }
    html += '</tr></thead><tbody>';

    var catNames = Object.keys(categories).sort(function(a, b) { return a.localeCompare(b, 'da'); });
    catNames.forEach(function(cat) {
        var items = categories[cat];
        items.forEach(function(line) {
            var isAccessory = line.is_accessory ? ' pl-accessory' : '';
            var catDisplay = (cat || '').replace(/^\d+\s+/, '');
            html += '<tr class="pl-result-row' + isAccessory + '">' +
                '<td class="pl-col-qty"><strong>' + line.quantity + '</strong> ' + esc(line.unit) + '</td>' +
                '<td class="pl-col-name">' + esc(line.product_name) + '</td>' +
                '<td class="pl-col-cat">' + esc(catDisplay) + '</td>';
            if (_plShowPrices) {
                var uPrice = line.unit_price ? (line.unit_price / vatDiv) : 0;
                var lineTotal = line.unit_price ? (line.unit_price * line.quantity / vatDiv) : 0;
                html += '<td class="pl-col-price">' + (uPrice ? uPrice.toFixed(0) + ' kr' : '') + '</td>' +
                        '<td class="pl-col-cost">' + (line.cost_price ? line.cost_price.toFixed(0) + ' kr' : '') + '</td>' +
                        '<td class="pl-col-total">' + (lineTotal ? lineTotal.toFixed(0) + ' kr' : '') + '</td>';
            }
            html += '</tr>';
        });
    });

    // Footer — faktura-format; bold total følger moms-mode så kolonnesum matcher
    html += '</tbody><tfoot>';
    if (_plShowPrices) {
        var salesExVat = window.Moms.inclToExcl(totalSales);
        var vatAmount = totalSales - salesExVat;
        var margin = salesExVat > 0 ? ((1 - totalCost / salesExVat) * 100).toFixed(0) : 0;
        var nettoRowCls   = isExcl ? 'pl-result-total'    : 'pl-result-subtotal';
        var nettoValueHtml = isExcl ? '<strong>' + salesExVat.toFixed(0) + ' kr</strong>'
                                    : salesExVat.toFixed(0) + ' kr';
        var totalRowCls   = isExcl ? 'pl-result-subtotal' : 'pl-result-total';
        var totalValueHtml = isExcl ? totalSales.toFixed(0) + ' kr'
                                    : '<strong>' + totalSales.toFixed(0) + ' kr</strong>';
        html += '<tr class="' + nettoRowCls + '">' +
            '<td class="pl-col-qty"><strong>' + totalQty + '</strong></td>' +
            '<td class="pl-col-name">Total</td>' +
            '<td></td>' +
            '<td class="pl-col-price">Netto</td>' +
            '<td class="pl-col-cost"></td>' +
            '<td class="pl-col-total">' + nettoValueHtml + '</td>' +
        '</tr>' +
        '<tr class="pl-result-subtotal">' +
            '<td></td><td></td><td></td>' +
            '<td class="pl-col-price">Moms 25%</td>' +
            '<td></td>' +
            '<td class="pl-col-total">' + vatAmount.toFixed(0) + ' kr</td>' +
        '</tr>' +
        '<tr class="' + totalRowCls + '">' +
            '<td></td><td></td><td></td>' +
            '<td class="pl-col-price">Total inkl. moms</td>' +
            '<td></td>' +
            '<td class="pl-col-total">' + totalValueHtml + '</td>' +
        '</tr>' +
        '<tr class="pl-result-subtotal">' +
            '<td></td><td></td><td></td>' +
            '<td class="pl-col-price">Kostpris</td>' +
            '<td></td>' +
            '<td class="pl-col-total">' + totalCost.toFixed(0) + ' kr</td>' +
        '</tr>' +
        '<tr class="pl-result-margin">' +
            '<td></td><td></td><td></td>' +
            '<td class="pl-col-price">Margin</td>' +
            '<td></td>' +
            '<td class="pl-col-total"><strong>' + margin + '%</strong></td>' +
        '</tr>';
    } else {
        html += '<tr class="pl-result-total">' +
            '<td class="pl-col-qty"><strong>' + totalQty + '</strong></td>' +
            '<td class="pl-col-name">Total</td>' +
            '<td></td>' +
        '</tr>';
    }
    html += '</tfoot></table>';

    el.innerHTML = html;

    // Wire action buttons
    var btnPrices = document.getElementById('plBtnPrices');
    if (btnPrices) btnPrices.addEventListener('click', _plTogglePrices);
    var btnVat = document.getElementById('plVatToggle');
    if (btnVat) btnVat.addEventListener('click', _plToggleVat);
    var btnRav = document.getElementById('plBtnRavarer');
    if (btnRav) btnRav.addEventListener('click', _plShowRavarer);
    var btnSum = document.getElementById('plBtnSummary');
    if (btnSum) btnSum.addEventListener('click', _plShowSummary);
}

/* ══════════════════════════════════════════════════════════════
   VAGTPLAN
   ══════════════════════════════════════════════════════════════ */
function _plLoadStaff() {
    fetchSmartplanShifts(_plFrom, _plTo).then(function(shifts) {
        _plStaffData = shifts || [];
        _plRenderStaff();
    }).catch(function(err) {
        console.warn('Smartplan ikke tilgængelig:', err);
        var el = document.getElementById('plVagtContent');
        if (el) el.innerHTML = '<div class="pl-vagtplan-empty">Vagtplan ikke tilgængelig</div>';
    });
}

function _plRenderStaff() {
    var el = document.getElementById('plVagtContent');
    if (!el || !_plStaffData) return;

    if (!_plStaffData.length) {
        el.innerHTML = '<div class="pl-vagtplan-empty">Ingen vagter i perioden</div>';
        return;
    }

    // Gruppér vagter per dag
    var byDate = {};
    _plStaffData.forEach(function(s) {
        var date = (s.date || '').slice(0, 10);
        if (!date) return;
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push(s);
    });

    var dates = Object.keys(byDate).sort();
    var html = '<div class="pl-vagtplan-grid">';

    dates.forEach(function(date) {
        var d = new Date(date + 'T00:00:00');
        var dayStr = _PL_WEEKDAYS[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
        var shifts = byDate[date];

        html += '<div class="pl-vagtplan-day">' +
            '<div class="pl-vagtplan-day-label">' + dayStr + '</div>';
        shifts.forEach(function(s) {
            var from = (s.start || '').slice(11, 16);
            var to = (s.end || '').slice(11, 16);
            var name = s.first_name || s.employee_name || '?';
            html += '<div class="pl-vagtplan-shift">' +
                '<span class="pl-shift-time">' + from + '–' + to + '</span> ' +
                '<span class="pl-shift-name">' + esc(name) + '</span>' +
            '</div>';
        });
        html += '</div>';
    });

    html += '</div>';
    el.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════
   ACTION BUTTONS — Råvarer + Sammentælling
   ══════════════════════════════════════════════════════════════ */
function _plShowSummary() {
    if (!_plAggregated.length || typeof openModal !== 'function') return;

    // Byg sammentælling grupperet per kategori
    var categories = {};
    var grandTotal = 0;
    _plAggregated.forEach(function(line) {
        if (line.is_accessory) return; // skip emballage/levering
        var cat = (line.category || 'Andet').replace(/^\d+\s+/, '');
        if (!categories[cat]) categories[cat] = 0;
        categories[cat] += line.quantity;
        grandTotal += line.quantity;
    });

    var html = '<table style="width:100%;border-collapse:collapse;font-size:14px">';
    var catNames = Object.keys(categories).sort(function(a,b) { return a.localeCompare(b,'da'); });
    catNames.forEach(function(cat) {
        html += '<tr><td style="padding:6px 0;font-weight:700;font-size:16px;color:var(--brand-primary,#8e631f)">' +
            categories[cat] + '</td><td style="padding:6px 8px">' + esc(cat) + '</td></tr>';
    });
    html += '<tr style="border-top:2px solid var(--color-border,#d7d1ca)">' +
        '<td style="padding:8px 0;font-weight:700;font-size:18px">' + grandTotal + '</td>' +
        '<td style="padding:8px 8px;font-weight:700">Total</td></tr>';
    html += '</table>';

    openModal({ title: 'Sammentælling — Planlægning', bodyHtml: html });
}

async function _plShowRavarer() {
    if (typeof openModal !== 'function') return;

    var bonIds = [];
    _plBons.forEach(function(b) { if (_plSelectedIds.has(b.id)) bonIds.push(b.id); });

    var extras = _plExtraLines
        .filter(function(l) { return l.grocy_recipe_id; })
        .map(function(l) { return { grocy_recipe_id: l.grocy_recipe_id, quantity: l.quantity }; });

    if (!bonIds.length && !extras.length) return;

    var titleParts = [];
    if (bonIds.length) titleParts.push(bonIds.length + ' bons');
    if (extras.length) titleParts.push(extras.length + ' ekstra');

    openModal({
        title: 'Råvarer — ' + titleParts.join(' + '),
        bodyHtml: '<div class="changelog-empty">Henter ingrediensbehov…</div>'
    });

    try {
        var data = await fetchPlanningIngredients(bonIds, extras);
        // Gem data for toggle og genbrug _buildRavarerHtml fra modal.js
        _ravarerData = data;
        _ravarerLevel = 'production';
        var body = document.querySelector('.modal-body');
        if (body) body.innerHTML = _buildRavarerHtml(data);
    } catch(err) {
        console.error('Råvarer-fejl:', err);
        var body = document.querySelector('.modal-body');
        if (body) body.innerHTML = '<div class="changelog-empty">Kunne ikke hente ingredienser. Prøv igen.</div>';
    }
}

/* ══════════════════════════════════════════════════════════════
   PRIS-TOGGLE
   ══════════════════════════════════════════════════════════════ */
function _plTogglePrices() {
    _plShowPrices = !_plShowPrices;
    // Persistér til server-setting
    if (typeof patchSetting === 'function') {
        patchSetting('show_prices_in_planning', _plShowPrices ? '1' : '0').catch(function() {});
    }
    _plUpdatePriceToggle();
    _plRenderResult();
}

function _plToggleVat(e) {
    e.stopPropagation();
    _plVatMode = _plVatMode === 'incl' ? 'excl' : 'incl';
    _plRenderResult();
}

function _plUpdatePriceToggle() {
    var btn = document.getElementById('plBtnPrices');
    if (!btn) return;
    btn.title = _plShowPrices ? 'Skjul priser' : 'Vis priser';
    if (_plShowPrices) {
        btn.classList.add('pl-price-toggle-active');
    } else {
        btn.classList.remove('pl-price-toggle-active');
    }
}

/* ══════════════════════════════════════════════════════════════
   SSE
   ══════════════════════════════════════════════════════════════ */
function _plInitSSE() {
    connectSSE('/api/sse?client_id=' + getClientId(), {
        connected: function() {},
        bon_created: function() { _plLoadData(); },
        bon_updated: function() { _plLoadData(); },
        bon_status:  function() { _plLoadData(); },
    });
}
