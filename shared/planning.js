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
var _plLoading     = false;
var _plStaffData   = null;

var _PL_WEEKDAYS = ['Søn','Man','Tir','Ons','Tor','Fre','Lør'];
var _PL_MONTHS   = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
function initPlanning(containerEl, options) {
    _plContainer = containerEl;
    _plOptions   = options || {};

    // Default periode: indeværende uge (man–søn)
    var now = new Date();
    var dow = now.getDay() || 7;
    var mon = new Date(now);
    mon.setDate(mon.getDate() - dow + 1);
    var sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);

    _plFrom = mon.toISOString().slice(0, 10);
    _plTo   = sun.toISOString().slice(0, 10);

    // Status-filter fra localStorage eller defaults
    var saved = localStorage.getItem('planning_status_filter');
    if (saved) {
        try { _plStatuses = JSON.parse(saved); } catch(e) { _plStatuses = {}; }
    }
    if (!Object.keys(_plStatuses).length) {
        _plStatuses = { godkendt: true, igang: true, klar: true, lev: true };
    }

    _plShowOffers = localStorage.getItem('planning_show_offers') === 'true';

    _plRenderShell();
    _plLoadData();
    _plInitSSE();
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

    // Byg status-param fra aktive filtre
    var codes = [];
    for (var k in _plStatuses) {
        if (_plStatuses[k]) codes.push(k);
    }
    var statusParam = codes.join(',');

    // Re-load staff if vagtplan is open
    var vpContent = document.getElementById('plVagtContent');
    if (vpContent && vpContent.classList.contains('open')) {
        _plStaffData = null;
        _plLoadStaff();
    }

    fetchBonsPlanning(_plFrom, _plTo, statusParam).then(function(bons) {
        _plBons = bons || [];
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
        bons.forEach(function(b) { if (_plSelectedIds.has(b.id)) totalUnits += (b.total_units || 0); });
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
        if (_plSelectedIds.has(b.id)) totalUnits += (b.total_units || 0);
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
   AGGREGERING
   ══════════════════════════════════════════════════════════════ */
function _plAggregate() {
    var map = {}; // nøgle → aggregeret linje

    _plBons.forEach(function(bon) {
        if (!_plSelectedIds.has(bon.id)) return;
        if (!bon.lines) return;

        bon.lines.forEach(function(line) {
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
        });
    });

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

    html += '<table class="pl-result-table"><thead><tr>' +
        '<th class="pl-col-qty">Antal</th>' +
        '<th class="pl-col-name">Vare</th>' +
        '<th class="pl-col-cat">Kategori</th>';
    if (_plShowPrices) {
        html += '<th class="pl-col-price">Stk-pris</th>' +
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
                html += '<td class="pl-col-price">' + (line.unit_price ? line.unit_price.toFixed(0) + ' kr' : '') + '</td>' +
                        '<td class="pl-col-total">' + (line.unit_price ? (line.unit_price * line.quantity).toFixed(0) + ' kr' : '') + '</td>';
            }
            html += '</tr>';
        });
    });

    // Totaler
    html += '</tbody><tfoot><tr class="pl-result-total">' +
        '<td class="pl-col-qty"><strong>' + totalQty + '</strong></td>' +
        '<td class="pl-col-name">Total</td>' +
        '<td></td>';
    if (_plShowPrices) {
        var margin = totalSales > 0 ? ((1 - totalCost / totalSales) * 100).toFixed(0) : 0;
        html += '<td class="pl-col-price">Kostpris: ' + totalCost.toFixed(0) + ' kr</td>' +
                '<td class="pl-col-total">' + totalSales.toFixed(0) + ' kr (' + margin + '% margin)</td>';
    }
    html += '</tr></tfoot></table>';

    el.innerHTML = html;

    // Wire action buttons
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
    if (!_plSelectedIds.size || typeof openModal !== 'function') return;

    var bonIds = [];
    _plBons.forEach(function(b) { if (_plSelectedIds.has(b.id)) bonIds.push(b.id); });

    openModal({
        title: 'Råvarer — ' + bonIds.length + ' bons',
        bodyHtml: '<div style="text-align:center;padding:20px;color:#888">Henter ingrediensbehov…</div>'
    });

    try {
        // Ét API-kald for alle valgte bons
        var data = await fetchPlanningIngredients(bonIds);

        var statusDot = { mangler: '🔴', lav: '🟡', ok: '🟢' };
        var html = '';

        if (!data.groups || !data.groups.length) {
            html = '<div style="text-align:center;padding:20px;color:#888;font-style:italic">Ingen opskrifter med ingredienser fundet</div>';
        } else {
            html = '<div style="max-height:60vh;overflow-y:auto">';

            // Vis per gruppe
            data.groups.forEach(function(group) {
                var groupLabel = group.name || 'Ingredienser';
                html += '<div style="margin-bottom:12px">' +
                    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--color-text-dim,#888);padding:6px 0;border-bottom:1px solid var(--color-border,#d7d1ca)">' + esc(groupLabel) + '</div>';

                group.ingredients.forEach(function(ing) {
                    html += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.04);font-size:13px">' +
                        '<span style="width:20px;text-align:center">' + (statusDot[ing.status] || '⚪') + '</span>' +
                        '<span style="flex:1">' + esc(ing.product_name) + '</span>' +
                        '<span style="text-align:right;min-width:80px;font-weight:600">' + ing.amount_needed + ' ' + esc(ing.unit || '') + '</span>' +
                        '<span style="text-align:right;min-width:80px;color:var(--color-text-dim,#888)">' + ing.amount_stock + ' ' + esc(ing.stock_unit || '') + '</span>' +
                    '</div>';
                });

                html += '</div>';
            });

            // Linjer uden opskrift
            if (data.lines_without_recipe && data.lines_without_recipe.length) {
                html += '<div style="margin-top:12px;padding:8px 0;border-top:1px solid var(--color-border,#d7d1ca);font-size:12px;color:var(--color-text-dim,#888)">' +
                    '<strong>Uden opskrift:</strong> ' + data.lines_without_recipe.map(function(n) { return esc(n); }).join(', ') +
                '</div>';
            }

            html += '</div>';
        }

        var body = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
    } catch(err) {
        console.error('Råvarer-fejl:', err);
        var body = document.querySelector('.modal-body');
        if (body) body.innerHTML = '<div style="text-align:center;padding:20px;color:#c00">Kunne ikke hente ingredienser. Prøv igen.</div>';
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
