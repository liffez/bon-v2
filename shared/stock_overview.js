/**
 * shared/stock_overview.js
 * ════════════════════════════════════════════════════════════
 * Stock Overview component for Bon v2.
 * Ported from bontools stock-overview.html, adapted to bon-v2
 * architecture: MPA, vanilla JS, API via shared/api.js.
 *
 * Export: initStockOverview(containerEl)
 * ════════════════════════════════════════════════════════════
 */

/* global fetchGrocyStock, fetchGrocyProducts, fetchGrocyQuantityUnits,
          fetchGrocyLocations, fetchGrocyProductGroups, postGrocyInventory,
          postGrocyShoppingList, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

var _soStockData      = [];   // processed stock items
var _soAllProducts    = [];   // all active products (for add-product)
var _soProductsMap    = {};   // product_id -> product
var _soQUnitsMap      = {};   // qu_id -> unit name
var _soLocationsMap   = {};   // location_id -> name
var _soLocationsArr   = [];   // raw locations array
var _soGroupsMap      = {};   // product_group_id -> name
var _soGroupsArr      = [];   // raw groups array

var _soFilteredData   = [];   // after filters applied
var _soSelectMode     = false;
var _soSelectedIds    = {};   // product_id -> true  (plain object, no Set for compat)
var _soCurrentExpand  = null; // product_id of expanded card
var _soSearchTimer    = null; // debounce timer
var _soContainer      = null; // root DOM element

// ════════════════════════════════════════════════════════════
// PUBLIC: initStockOverview
// ════════════════════════════════════════════════════════════

function initStockOverview(containerEl) {
    _soContainer = containerEl;
    _soContainer.innerHTML =
        '<div class="so-loading"><div class="so-spinner"></div><p>Henter lagerbeholdning...</p></div>';
    _soLoadData();
}

// ════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════

async function _soLoadData() {
    try {
        var results = await Promise.all([
            fetchGrocyStock(),
            fetchGrocyProducts(),
            fetchGrocyQuantityUnits(),
            fetchGrocyLocations(),
            fetchGrocyProductGroups()
        ]);

        var rawStock    = results[0];
        var rawProducts = results[1];
        var rawQus      = results[2];
        var rawLocs     = results[3];
        var rawGroups   = results[4];

        // Build lookup maps
        _soQUnitsMap = {};
        rawQus.forEach(function(q) { _soQUnitsMap[q.id] = q.name; });

        _soLocationsMap = {};
        _soLocationsArr = rawLocs;
        rawLocs.forEach(function(l) { _soLocationsMap[l.id] = l.name; });

        _soGroupsMap = {};
        _soGroupsArr = rawGroups;
        rawGroups.forEach(function(g) { _soGroupsMap[g.id] = g.name; });

        _soProductsMap = {};
        _soAllProducts = rawProducts.filter(function(p) {
            if (p.active === undefined || p.active === null) return true;
            return p.active === '1' || p.active === 1 || p.active === true;
        });
        _soAllProducts.forEach(function(p) { _soProductsMap[p.id] = p; });

        // Process stock
        var now = new Date();
        _soStockData = rawStock.map(function(item) {
            var status = 'ok';
            var daysUntilExpiry = Infinity;
            var amount = parseFloat(item.amount) || 0;
            var product = item.product || _soProductsMap[item.product_id] || {};
            var minStock = parseFloat(item.min_stock_amount) || 0;

            if (amount > 0 && item.best_before_date && item.best_before_date !== '2999-12-31') {
                var expiry = new Date(item.best_before_date + 'T23:59:59');
                daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

                if (daysUntilExpiry < 0) {
                    status = 'expired';
                } else if (daysUntilExpiry <= 5) {
                    status = 'duesoon';
                }
            }

            if (amount < minStock && amount > 0) {
                if (status === 'ok') status = 'low';
            }

            if (amount <= 0) {
                status = 'low';
            }

            return {
                product_id:         item.product_id,
                name:               (product.name) || 'Ukendt',
                amount:             amount,
                amount_opened:      parseFloat(item.amount_opened) || 0,
                qu_id:              product.qu_id_stock,
                qu_name:            _soQUnitsMap[product.qu_id_stock] || '',
                best_before_date:   item.best_before_date,
                daysUntilExpiry:    daysUntilExpiry,
                status:             status,
                location_id:        product.location_id,
                location_name:      _soLocationsMap[product.location_id] || '',
                product_group_id:   product.product_group_id,
                product_group_name: _soGroupsMap[product.product_group_id] || '',
                min_stock_amount:   minStock
            };
        });

        // Sort by name
        _soStockData.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });

        // Build UI shell + render
        _soBuildShell();
        _soPopulateFilters();
        _soApplyFilters();

    } catch (err) {
        _soContainer.innerHTML =
            '<div class="so-empty"><p>Fejl ved hentning: ' + esc(err.message) + '</p></div>';
    }
}

// ════════════════════════════════════════════════════════════
// UI SHELL
// ════════════════════════════════════════════════════════════

function _soBuildShell() {
    _soContainer.innerHTML = [
        '<div class="so-status-bar" id="soStatusBar"></div>',
        '<div class="so-filter-bar" id="soFilterBar">',
        '  <input type="text" class="so-search" id="soSearch" placeholder="Soeg produkt...">',
        '  <select class="so-select" id="soLocationFilter"><option value="">Alle lokationer</option></select>',
        '  <select class="so-select" id="soGroupFilter"><option value="">Alle grupper</option></select>',
        '  <button class="so-filter-btn" id="soSelectModeBtn" title="Vaelg flere">&#x2610;</button>',
        '</div>',
        '<div class="so-selection-bar" id="soSelectionBar">',
        '  <span class="so-sel-count" id="soSelCount">0 valgt</span>',
        '  <button class="so-sel-btn so-sel-shopping" data-action="bulk-shopping">+ Indkoebsliste</button>',
        '  <button class="so-sel-btn" data-action="bulk-clear">Annuller</button>',
        '</div>',
        '<div class="so-toast-area" id="soToastArea"></div>',
        '<div class="so-content" id="soContent"></div>'
    ].join('\n');

    // Event delegation on container
    _soContainer.addEventListener('click', _soHandleClick);
    _soContainer.addEventListener('input', _soHandleInput);
    _soContainer.addEventListener('change', _soHandleChange);

    // Escape to close expand
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && _soCurrentExpand !== null) {
            _soCloseExpand(_soCurrentExpand);
        }
    });
}

function _soPopulateFilters() {
    var locSel = document.getElementById('soLocationFilter');
    if (locSel) {
        locSel.innerHTML = '<option value="">Alle lokationer</option>' +
            _soLocationsArr.map(function(l) {
                return '<option value="' + l.id + '">' + esc(l.name) + '</option>';
            }).join('');
    }

    var grpSel = document.getElementById('soGroupFilter');
    if (grpSel) {
        grpSel.innerHTML = '<option value="">Alle grupper</option>' +
            _soGroupsArr.map(function(g) {
                return '<option value="' + g.id + '">' + esc(g.name) + '</option>';
            }).join('');
    }
}

// ════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ════════════════════════════════════════════════════════════

function _soHandleClick(e) {
    var target = e.target;

    // Status pill click -> filter
    var pill = target.closest('.so-status-pill[data-filter]');
    if (pill) {
        _soToggleStatusFilter(pill.getAttribute('data-filter'));
        return;
    }

    // Select mode toggle
    if (target.closest('#soSelectModeBtn')) {
        _soToggleSelectMode();
        return;
    }

    // Selection bar actions
    var selAction = target.closest('[data-action]');
    if (selAction) {
        var action = selAction.getAttribute('data-action');
        if (action === 'bulk-shopping') { _soBulkAddToShopping(); return; }
        if (action === 'bulk-clear')    { _soClearSelection(); return; }
    }

    // Select box click
    var selectBox = target.closest('.so-select-box');
    if (selectBox) {
        e.stopPropagation();
        var cardEl = selectBox.closest('.so-card');
        if (cardEl) _soToggleSelect(parseInt(cardEl.getAttribute('data-id')));
        return;
    }

    // Adjust +/- buttons
    var adjBtn = target.closest('.so-adj-btn');
    if (adjBtn) {
        e.stopPropagation();
        var delta = parseInt(adjBtn.getAttribute('data-delta'));
        var cardId = parseInt(adjBtn.closest('.so-card').getAttribute('data-id'));
        _soAdjStep(cardId, delta);
        return;
    }

    // Save button in expand
    var saveBtn = target.closest('.so-save-btn');
    if (saveBtn) {
        e.stopPropagation();
        var sid = parseInt(saveBtn.closest('.so-card').getAttribute('data-id'));
        _soAdjustInventory(sid);
        return;
    }

    // Shopping list button in expand
    var shopBtn = target.closest('.so-shop-btn');
    if (shopBtn) {
        e.stopPropagation();
        var shopId = parseInt(shopBtn.closest('.so-card').getAttribute('data-id'));
        _soAddToShoppingList(shopId);
        return;
    }

    // Card click (expand or select)
    var card = target.closest('.so-card');
    if (card && !target.closest('.so-expand-panel') && !target.closest('.so-adj-btn') && !target.closest('button') && !target.closest('input')) {
        var pid = parseInt(card.getAttribute('data-id'));
        if (_soSelectMode) {
            _soToggleSelect(pid);
        } else {
            _soToggleExpand(pid);
        }
        return;
    }
}

function _soHandleInput(e) {
    if (e.target.id === 'soSearch') {
        clearTimeout(_soSearchTimer);
        _soSearchTimer = setTimeout(_soApplyFilters, 200);
    }
}

function _soHandleChange(e) {
    if (e.target.id === 'soLocationFilter' || e.target.id === 'soGroupFilter') {
        _soApplyFilters();
    }
}

// ════════════════════════════════════════════════════════════
// FILTERS
// ════════════════════════════════════════════════════════════

var _soActiveStatusFilter = '';

function _soToggleStatusFilter(status) {
    _soActiveStatusFilter = (_soActiveStatusFilter === status) ? '' : status;
    _soApplyFilters();
}

function _soApplyFilters() {
    var searchEl = document.getElementById('soSearch');
    var locEl    = document.getElementById('soLocationFilter');
    var grpEl    = document.getElementById('soGroupFilter');
    if (!searchEl) return;

    var search     = searchEl.value.toLowerCase().trim();
    var locationId = locEl.value;
    var groupId    = grpEl.value;
    var status     = _soActiveStatusFilter;

    _soFilteredData = _soStockData.filter(function(item) {
        if (search && item.name.toLowerCase().indexOf(search) === -1) return false;
        if (locationId && String(item.location_id) !== locationId) return false;
        if (groupId && String(item.product_group_id) !== groupId) return false;
        if (status && item.status !== status) return false;
        return true;
    });

    _soUpdateStatusBar();
    _soRenderGrid();
}

// ════════════════════════════════════════════════════════════
// STATUS BAR
// ════════════════════════════════════════════════════════════

function _soUpdateStatusBar() {
    var bar = document.getElementById('soStatusBar');
    if (!bar) return;

    var total   = _soFilteredData.length;
    var expired = 0, duesoon = 0, low = 0;
    _soFilteredData.forEach(function(i) {
        if (i.status === 'expired') expired++;
        if (i.status === 'duesoon') duesoon++;
        if (i.status === 'low')     low++;
    });

    var html = '<span class="so-status-pill so-pill-total">' + total + ' varer</span>';

    if (expired > 0) {
        html += '<span class="so-status-pill so-pill-expired' +
            (_soActiveStatusFilter === 'expired' ? ' active' : '') +
            '" data-filter="expired">' + expired + ' udloebet</span>';
    }
    if (duesoon > 0) {
        html += '<span class="so-status-pill so-pill-duesoon' +
            (_soActiveStatusFilter === 'duesoon' ? ' active' : '') +
            '" data-filter="duesoon">' + duesoon + ' snart udloeb</span>';
    }
    if (low > 0) {
        html += '<span class="so-status-pill so-pill-low' +
            (_soActiveStatusFilter === 'low' ? ' active' : '') +
            '" data-filter="low">' + low + ' lav beholdning</span>';
    }

    bar.innerHTML = html;
}

// ════════════════════════════════════════════════════════════
// RENDER GRID
// ════════════════════════════════════════════════════════════

function _soRenderGrid() {
    var container = document.getElementById('soContent');
    if (!container) return;

    if (_soFilteredData.length === 0) {
        container.innerHTML = '<div class="so-empty"><p>Ingen varer fundet</p></div>';
        return;
    }

    // Group by product_group
    var groups = {};
    _soFilteredData.forEach(function(item) {
        var key   = item.product_group_id || 'none';
        var label = item.product_group_name || 'Ingen gruppe';
        if (!groups[key]) groups[key] = { label: label, items: [] };
        groups[key].items.push(item);
    });

    var sortedGroups = Object.keys(groups).map(function(k) { return groups[k]; });
    sortedGroups.sort(function(a, b) { return a.label.localeCompare(b.label, 'da'); });

    var selectClass = _soSelectMode ? ' so-select-mode' : '';
    var html = '';

    sortedGroups.forEach(function(group) {
        html += '<div class="so-group-header">' + esc(group.label) + ' (' + group.items.length + ')</div>';
        html += '<div class="so-grid' + selectClass + '">';
        group.items.forEach(function(item) {
            html += _soRenderCard(item);
        });
        html += '</div>';
    });

    container.innerHTML = html;
}

function _soRenderCard(item) {
    var isSelected    = _soSelectedIds[item.product_id] === true;
    var isExpanded    = _soCurrentExpand === item.product_id;
    var statusClass   = 'so-status-' + item.status;
    var selectedClass = isSelected ? ' so-selected' : '';
    var expandedClass = isExpanded ? ' so-expanded' : '';

    // Expiry display
    var expiryHtml = '';
    if (item.amount > 0 && item.best_before_date && item.best_before_date !== '2999-12-31') {
        var d = item.daysUntilExpiry;
        var expiryClass = 'so-expiry-ok';
        var expiryText  = '';

        if (d < 0) {
            expiryClass = 'so-expiry-danger';
            expiryText  = 'Udl. ' + Math.abs(d) + 'd siden';
        } else if (d === 0) {
            expiryClass = 'so-expiry-danger';
            expiryText  = 'Udl. i dag';
        } else if (d <= 5) {
            expiryClass = 'so-expiry-warn';
            expiryText  = d + 'd til udl.';
        } else {
            expiryText = _soFormatExpiryDate(item.best_before_date);
        }

        expiryHtml = '<span class="so-expiry ' + expiryClass + '">' + expiryText + '</span>';
    }

    // Amount
    var amountText = _soRound(item.amount) + ' ' + esc(item.qu_name);
    if (item.amount_opened > 0) {
        amountText += ' (' + _soRound(item.amount_opened) + ' aabnet)';
    }

    // Min stock warning
    var minHtml = '';
    if (item.min_stock_amount > 0 && item.amount < item.min_stock_amount) {
        minHtml = '<span class="so-min-warn">min ' + _soRound(item.min_stock_amount) + '</span>';
    }

    // Select box
    var selectBoxHtml = '<div class="so-select-box' + (isSelected ? ' so-selected' : '') + '">' +
        (isSelected ? '&#x2713;' : '') + '</div>';

    // Expand panel
    var expandHtml = '<div class="so-expand-panel">' +
        '<div class="so-expand-row">' +
        '  <label>Antal:</label>' +
        '  <button class="so-adj-btn" data-delta="-1" title="Minus 1">&#x25BC;</button>' +
        '  <input type="number" class="so-adj-input" id="soAdj-' + item.product_id + '"' +
        '    value="' + _soRound(item.amount) + '" min="0" step="0.5">' +
        '  <button class="so-adj-btn" data-delta="1" title="Plus 1">&#x25B2;</button>' +
        '  <span class="so-adj-unit">' + esc(item.qu_name) + '</span>' +
        '</div>' +
        '<div class="so-expand-actions">' +
        '  <button class="so-save-btn">Gem</button>' +
        '  <button class="so-shop-btn" title="Tilfoej til indkoebsliste">+ Indkoebsliste</button>' +
        '</div>' +
        '</div>';

    return '<div class="so-card ' + statusClass + selectedClass + expandedClass + '" data-id="' + item.product_id + '">' +
        '<div class="so-card-main">' +
        selectBoxHtml +
        '<div class="so-card-info">' +
        '  <div class="so-card-name">' + esc(item.name) + '</div>' +
        '  <div class="so-card-meta">' +
        '    <span class="so-card-amount">' + amountText + '</span>' +
        expiryHtml + minHtml +
        '  </div>' +
        '</div>' +
        '</div>' +
        expandHtml +
        '</div>';
}

// ════════════════════════════════════════════════════════════
// EXPAND / COLLAPSE
// ════════════════════════════════════════════════════════════

function _soToggleExpand(productId) {
    if (_soCurrentExpand !== null && _soCurrentExpand !== productId) {
        _soCloseExpand(_soCurrentExpand);
    }

    var card = _soContainer.querySelector('.so-card[data-id="' + productId + '"]');
    if (!card) return;

    if (card.classList.contains('so-expanded')) {
        card.classList.remove('so-expanded');
        _soCurrentExpand = null;
    } else {
        card.classList.add('so-expanded');
        _soCurrentExpand = productId;
        // Focus input
        var input = card.querySelector('.so-adj-input');
        if (input) input.focus();
    }
}

function _soCloseExpand(productId) {
    var card = _soContainer.querySelector('.so-card[data-id="' + productId + '"]');
    if (card) card.classList.remove('so-expanded');
    if (_soCurrentExpand === productId) _soCurrentExpand = null;
}

// ════════════════════════════════════════════════════════════
// SELECT MODE
// ════════════════════════════════════════════════════════════

function _soToggleSelectMode() {
    _soSelectMode = !_soSelectMode;
    var btn = document.getElementById('soSelectModeBtn');
    if (btn) btn.classList.toggle('active', _soSelectMode);

    if (!_soSelectMode) {
        _soSelectedIds = {};
    }

    _soRenderGrid();
    _soUpdateSelectionBar();
}

function _soToggleSelect(productId) {
    if (_soSelectedIds[productId]) {
        delete _soSelectedIds[productId];
    } else {
        _soSelectedIds[productId] = true;
    }

    // Update card visually without full re-render
    var card = _soContainer.querySelector('.so-card[data-id="' + productId + '"]');
    var box  = card ? card.querySelector('.so-select-box') : null;
    if (card && box) {
        var isSel = _soSelectedIds[productId] === true;
        card.classList.toggle('so-selected', isSel);
        box.classList.toggle('so-selected', isSel);
        box.innerHTML = isSel ? '&#x2713;' : '';
    }

    _soUpdateSelectionBar();
}

function _soClearSelection() {
    _soSelectedIds = {};
    _soSelectMode = false;
    var btn = document.getElementById('soSelectModeBtn');
    if (btn) btn.classList.remove('active');
    _soRenderGrid();
    _soUpdateSelectionBar();
}

function _soUpdateSelectionBar() {
    var bar   = document.getElementById('soSelectionBar');
    var count = Object.keys(_soSelectedIds).length;

    if (_soSelectMode && count > 0) {
        bar.classList.add('so-visible');
        document.getElementById('soSelCount').textContent = count + ' valgt';
    } else {
        bar.classList.remove('so-visible');
    }
}

// ════════════════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════════════════

async function _soAdjustInventory(productId) {
    var input = document.getElementById('soAdj-' + productId);
    if (!input) return;
    var newAmount = parseFloat(input.value);

    if (isNaN(newAmount) || newAmount < 0) {
        _soShowToast('Ugyldig maengde', 'warn');
        return;
    }

    var item = _soStockData.find(function(i) { return i.product_id === productId; });
    if (!item) return;

    if (Math.abs(newAmount - item.amount) < 0.01) {
        _soCloseExpand(productId);
        _soShowToast('Ingen aendring', 'info');
        return;
    }

    try {
        await postGrocyInventory(productId, newAmount, item.best_before_date || null);

        var diff = _soRound(newAmount - item.amount);
        var sign = diff > 0 ? '+' : '';
        _soShowToast(esc(item.name) + ': ' + sign + diff + ' ' + esc(item.qu_name) + ' (nu ' + _soRound(newAmount) + ')', 'success');
        _soCloseExpand(productId);

        // Update local data + re-render
        item.amount = newAmount;
        _soRecalcStatus(item);
        _soApplyFilters();

    } catch (err) {
        _soShowToast('Fejl: ' + esc(err.message), 'error');
    }
}

function _soAdjStep(productId, delta) {
    var input = document.getElementById('soAdj-' + productId);
    if (!input) return;
    var val = parseFloat(input.value) || 0;
    val = Math.max(0, _soRound(val + delta));
    input.value = val;
}

async function _soAddToShoppingList(productId) {
    var item = _soStockData.find(function(i) { return i.product_id === productId; });
    try {
        await postGrocyShoppingList([{
            product_id: productId,
            amount: 1,
            note: ''
        }]);
        _soShowToast((item ? esc(item.name) : 'Produkt') + ' tilfojet til indkoebsliste', 'success');
    } catch (err) {
        _soShowToast('Fejl: ' + esc(err.message), 'error');
    }
}

async function _soBulkAddToShopping() {
    var ids = Object.keys(_soSelectedIds);
    if (ids.length === 0) return;

    var items = ids.map(function(pid) {
        return { product_id: parseInt(pid), amount: 1, note: '' };
    });

    try {
        await postGrocyShoppingList(items);
        _soShowToast(ids.length + ' varer tilfojet til indkoebsliste', 'success');
        _soClearSelection();
    } catch (err) {
        _soShowToast('Fejl: ' + esc(err.message), 'error');
    }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function _soRecalcStatus(item) {
    var now = new Date();
    item.status = 'ok';
    item.daysUntilExpiry = Infinity;

    if (item.amount > 0 && item.best_before_date && item.best_before_date !== '2999-12-31') {
        var expiry = new Date(item.best_before_date + 'T23:59:59');
        item.daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

        if (item.daysUntilExpiry < 0) {
            item.status = 'expired';
        } else if (item.daysUntilExpiry <= 5) {
            item.status = 'duesoon';
        }
    }

    if (item.min_stock_amount > 0 && item.amount < item.min_stock_amount && item.amount > 0) {
        if (item.status === 'ok') item.status = 'low';
    }

    if (item.amount <= 0) {
        item.status = 'low';
    }
}

function _soRound(num, decimals) {
    if (decimals === undefined) decimals = 2;
    var factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
}

function _soFormatExpiryDate(dateStr) {
    if (!dateStr || dateStr === '2999-12-31') return '';
    var d = new Date(dateStr);
    return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

function _soShowToast(message, type) {
    var area = document.getElementById('soToastArea');
    if (!area) return;

    var toast = document.createElement('div');
    toast.className = 'so-toast so-toast-' + (type || 'info');
    toast.textContent = message;
    area.appendChild(toast);

    setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s';
        setTimeout(function() { toast.remove(); }, 400);
    }, 3500);
}
