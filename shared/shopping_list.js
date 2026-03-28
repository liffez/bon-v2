/**
 * shared/shopping_list.js
 * ════════════════════════════════════════════════════════════
 * Shopping List component for Bon v2.
 * Ported from bontools indkobsliste.html, adapted to bon-v2
 * architecture: MPA, vanilla JS, API via shared/api.js.
 *
 * Export: initShoppingList(containerEl)
 * ════════════════════════════════════════════════════════════
 */

/* global fetchShoppingList, fetchGrocyProducts, fetchGrocyProductGroups,
          fetchShoppingLocations, fetchGrocyQuantityUnits,
          deleteShoppingListItem,
          addShoppingListProduct, removeShoppingListProduct,
          addMissingProducts, addExpiredProducts, addOverdueProducts,
          clearShoppingList, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

var _slItems         = [];   // raw shopping list entries
var _slProducts      = [];   // all active products
var _slProductsMap   = {};   // product_id -> product
var _slGroupsMap     = {};   // product_group_id -> name
var _slLocationsMap  = {};   // shopping_location_id -> name
var _slLocationsArr  = [];   // raw shopping locations array
var _slQUnitsMap     = {};   // qu_id -> unit name

var _slFilteredItems = [];   // after search filter
var _slExpandedId    = null; // id of expanded item
var _slSearchTimer   = null; // debounce timer
var _slContainer     = null; // root DOM element
var _slAddPanelOpen  = false;
var _slStruckItems   = {};   // item_id -> true (persisted in localStorage)
var _slBusy          = false; // prevent double-clicks on actions

// ════════════════════════════════════════════════════════════
// PUBLIC: initShoppingList
// ════════════════════════════════════════════════════════════

function initShoppingList(containerEl) {
    _slContainer = containerEl;
    _slContainer.innerHTML =
        '<div class="sl-loading"><div class="sl-spinner"></div><p>Henter indkobsliste...</p></div>';

    // Restore struck items from localStorage
    try {
        var stored = JSON.parse(localStorage.getItem('sl_struck_items') || '{}');
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            _slStruckItems = stored;
        } else if (Array.isArray(stored)) {
            // migrate from array format
            _slStruckItems = {};
            stored.forEach(function(id) { _slStruckItems[String(id)] = true; });
        }
    } catch (e) {
        _slStruckItems = {};
    }

    _slLoadData();
}

// ════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════

async function _slLoadData() {
    try {
        var results = await Promise.all([
            fetchShoppingList(),
            fetchGrocyProducts(),
            fetchGrocyProductGroups(),
            fetchShoppingLocations(),
            fetchGrocyQuantityUnits()
        ]);

        var rawItems    = results[0];
        var rawProducts = results[1];
        var rawGroups   = results[2];
        var rawLocs     = results[3];
        var rawQUs      = results[4];

        // Build lookup maps
        _slProductsMap = {};
        _slProducts = (rawProducts || []).filter(function(p) {
            if (p.active === undefined || p.active === null) return true;
            return p.active === '1' || p.active === 1 || p.active === true;
        });
        _slProducts.forEach(function(p) { _slProductsMap[p.id] = p; });

        _slGroupsMap = {};
        (rawGroups || []).forEach(function(g) { _slGroupsMap[g.id] = g.name; });

        _slLocationsMap = { '': 'Uden leverandor' };
        _slLocationsArr = rawLocs || [];
        _slLocationsArr.forEach(function(l) { _slLocationsMap[l.id] = l.name; });

        _slQUnitsMap = {};
        (rawQUs || []).forEach(function(q) { _slQUnitsMap[q.id] = q.name; });

        _slItems = rawItems || [];

        // Clean up struck items that no longer exist
        var itemIds = {};
        _slItems.forEach(function(i) { itemIds[String(i.id)] = true; });
        Object.keys(_slStruckItems).forEach(function(k) {
            if (!itemIds[k]) delete _slStruckItems[k];
        });
        _slPersistStruck();

        // Build UI shell + render
        _slBuildShell();
        _slApplyFilters();

    } catch (err) {
        _slContainer.innerHTML =
            '<div class="sl-empty"><p>Fejl ved hentning: ' + esc(err.message) + '</p></div>';
    }
}

async function _slReload() {
    try {
        var items = await fetchShoppingList();
        _slItems = items || [];
        _slApplyFilters();
    } catch (err) {
        _slShowToast('Fejl ved genindlasning: ' + esc(err.message), 'error');
    }
}

// ════════════════════════════════════════════════════════════
// UI SHELL
// ════════════════════════════════════════════════════════════

function _slBuildShell() {
    _slContainer.innerHTML = [
        '<div class="sl-toolbar" id="slToolbar">',
        '  <div class="sl-search-wrap">',
        '    <input type="text" class="sl-search" id="slSearch" placeholder="Soeg vare...">',
        '  </div>',
        '  <select class="sl-select" id="slGroupBy">',
        '    <option value="supplier" selected>Leverandor</option>',
        '    <option value="product_group">Produktgruppe</option>',
        '    <option value="none">Ingen gruppering</option>',
        '  </select>',
        '  <button class="sl-add-btn" id="slAddBtn" title="Tilføj vare">+ Tilføj vare</button>',
        '  <div class="sl-stats-pill" id="slStats">—</div>',
        '</div>',

        '<div class="sl-quick-actions" id="slQuickActions">',
        '  <button class="sl-quick-btn" data-action="add-missing">',
        '    <span class="sl-quick-icon">📉</span>',
        '    <div>',
        '      <div class="sl-quick-label">Tilfoej manglende</div>',
        '      <div class="sl-quick-sub">Under min.beholdning</div>',
        '    </div>',
        '  </button>',
        '  <button class="sl-quick-btn" data-action="add-expiring">',
        '    <span class="sl-quick-icon">⏰</span>',
        '    <div>',
        '      <div class="sl-quick-label">Tilfoej udloebende</div>',
        '      <div class="sl-quick-sub">Snart udloebet (5 dage)</div>',
        '    </div>',
        '  </button>',
        '  <button class="sl-quick-btn" data-action="add-overdue">',
        '    <span class="sl-quick-icon">📅</span>',
        '    <div>',
        '      <div class="sl-quick-label">Tilfoej overskredet</div>',
        '      <div class="sl-quick-sub">Allerede udloebet</div>',
        '    </div>',
        '  </button>',
        '</div>',

        '<div class="sl-add-panel" id="slAddPanel">',
        '  <div class="sl-add-title">Tilfoej vare til listen</div>',
        '  <div class="sl-add-fields">',
        '    <input type="text" class="sl-add-search" id="slAddSearch" placeholder="Soeg produkt..." autocomplete="off">',
        '    <div class="sl-add-results" id="slAddResults"></div>',
        '    <div class="sl-add-row">',
        '      <input type="number" class="sl-add-qty" id="slAddQty" placeholder="Antal" min="0.1" step="0.1" value="1">',
        '      <span class="sl-add-unit" id="slAddUnit"></span>',
        '    </div>',
        '  </div>',
        '  <div class="sl-add-actions">',
        '    <button class="sl-btn-primary" id="slAddSubmit">Tilfoej</button>',
        '    <button class="sl-btn-secondary" id="slAddCancel">Annuller</button>',
        '  </div>',
        '</div>',

        '<div class="sl-content" id="slContent"></div>',

        '<div class="sl-bottom-bar" id="slBottomBar">',
        '  <button class="sl-bottom-btn sl-bottom-clear-struck" data-action="clear-struck">Ryd afkrydsede</button>',
        '  <button class="sl-bottom-btn sl-bottom-clear-all" data-action="clear-all">Ryd hele listen</button>',
        '</div>',

        '<div class="sl-toast-area" id="slToastArea"></div>'
    ].join('\n');

    // Event delegation
    _slContainer.addEventListener('click', _slHandleClick);
    _slContainer.addEventListener('input', _slHandleInput);
    _slContainer.addEventListener('change', _slHandleChange);

    // Escape to close expand
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (_slAddPanelOpen) {
                _slToggleAddPanel();
            } else if (_slExpandedId !== null) {
                _slExpandedId = null;
                _slRenderList();
            }
        }
    });
}

// ════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ════════════════════════════════════════════════════════════

function _slHandleClick(e) {
    var target = e.target;

    // Add button (toolbar)
    if (target.closest('#slAddBtn')) {
        _slToggleAddPanel();
        return;
    }

    // Add panel submit
    if (target.closest('#slAddSubmit')) {
        _slAddItemManual();
        return;
    }

    // Add panel cancel
    if (target.closest('#slAddCancel')) {
        _slToggleAddPanel();
        return;
    }

    // Add panel product result click
    var addResult = target.closest('.sl-add-result');
    if (addResult) {
        _slSelectAddProduct(parseInt(addResult.getAttribute('data-id')));
        return;
    }

    // Quick action buttons
    var quickBtn = target.closest('.sl-quick-btn');
    if (quickBtn) {
        var action = quickBtn.getAttribute('data-action');
        if (action === 'add-missing')  { _slQuickAction('missing', quickBtn); return; }
        if (action === 'add-expiring') { _slQuickAction('expiring', quickBtn); return; }
        if (action === 'add-overdue')  { _slQuickAction('overdue', quickBtn); return; }
    }

    // Bottom bar actions
    var bottomBtn = target.closest('.sl-bottom-btn');
    if (bottomBtn) {
        var bAction = bottomBtn.getAttribute('data-action');
        if (bAction === 'clear-struck') { _slClearStruck(); return; }
        if (bAction === 'clear-all')    { _slClearAll(); return; }
    }

    // Item check (strikethrough)
    var check = target.closest('.sl-item-check');
    if (check) {
        e.stopPropagation();
        var checkCard = check.closest('.sl-item-card');
        if (checkCard) _slToggleStrike(checkCard.getAttribute('data-id'));
        return;
    }

    // Detail actions
    var detailBtn = target.closest('.sl-detail-btn');
    if (detailBtn) {
        e.stopPropagation();
        var card = detailBtn.closest('.sl-item-card');
        if (!card) return;
        var itemId = card.getAttribute('data-id');
        var dAction = detailBtn.getAttribute('data-action');
        if (dAction === 'edit-qty')   { _slEditQty(itemId); return; }
        if (dAction === 'remove')     { _slRemoveItem(itemId); return; }
    }

    // Item card click (expand/collapse)
    var itemCard = target.closest('.sl-item-card');
    if (itemCard && !target.closest('.sl-item-detail') && !target.closest('.sl-item-check')) {
        var id = itemCard.getAttribute('data-id');
        _slExpandedId = (_slExpandedId === id) ? null : id;
        _slRenderList();
        return;
    }
}

function _slHandleInput(e) {
    if (e.target.id === 'slSearch') {
        clearTimeout(_slSearchTimer);
        _slSearchTimer = setTimeout(_slApplyFilters, 200);
    }
    if (e.target.id === 'slAddSearch') {
        clearTimeout(_slSearchTimer);
        _slSearchTimer = setTimeout(function() { _slFilterAddProducts(); }, 150);
    }
}

function _slHandleChange(e) {
    if (e.target.id === 'slGroupBy') {
        _slApplyFilters();
    }
}

// ════════════════════════════════════════════════════════════
// FILTERS
// ════════════════════════════════════════════════════════════

function _slApplyFilters() {
    var searchEl = document.getElementById('slSearch');
    if (!searchEl) return;

    var query = searchEl.value.toLowerCase().trim();

    _slFilteredItems = _slItems.filter(function(item) {
        if (!query) return true;
        var p = _slProductsMap[item.product_id];
        var name = p ? p.name.toLowerCase() : '';
        return name.indexOf(query) !== -1;
    });

    _slUpdateStats();
    _slRenderList();
    _slUpdateBottomBar();
}

// ════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════

function _slUpdateStats() {
    var el = document.getElementById('slStats');
    if (!el) return;

    var total = _slFilteredItems.length;
    var done = 0;
    _slFilteredItems.forEach(function(i) {
        if (_slStruckItems[String(i.id)]) done++;
    });

    el.textContent = done > 0
        ? total + ' varer · ' + done + ' afkrydset'
        : total + ' varer';
}

// ════════════════════════════════════════════════════════════
// RENDER LIST
// ════════════════════════════════════════════════════════════

function _slRenderList() {
    var container = document.getElementById('slContent');
    if (!container) return;

    if (_slItems.length === 0) {
        container.innerHTML =
            '<div class="sl-empty">' +
            '<div class="sl-empty-icon">🛒</div>' +
            '<div class="sl-empty-title">Listen er tom</div>' +
            '<div class="sl-empty-sub">Brug knapperne herover til at tilfoeje varer</div>' +
            '</div>';
        return;
    }

    if (_slFilteredItems.length === 0) {
        container.innerHTML =
            '<div class="sl-empty">' +
            '<div class="sl-empty-icon">🔍</div>' +
            '<div class="sl-empty-title">Ingen resultater</div>' +
            '<div class="sl-empty-sub">Ingen varer matcher soegningen</div>' +
            '</div>';
        return;
    }

    var groupByEl = document.getElementById('slGroupBy');
    var groupBy = groupByEl ? groupByEl.value : 'supplier';

    // Sort items: non-struck first, then alphabetically
    var sorted = _slFilteredItems.slice().sort(function(a, b) {
        var aDone = _slStruckItems[String(a.id)] ? 1 : 0;
        var bDone = _slStruckItems[String(b.id)] ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        var aName = (_slProductsMap[a.product_id] || {}).name || '';
        var bName = (_slProductsMap[b.product_id] || {}).name || '';
        return aName.localeCompare(bName, 'da');
    });

    // Build groups
    var groups = _slBuildGroups(sorted, groupBy);
    var html = '';

    var groupKeys = Object.keys(groups);
    // Sort groups alphabetically, "Uden"/"Ingen" last
    groupKeys.sort(function(a, b) {
        var aLast = a.indexOf('Uden') === 0 || a.indexOf('Ingen') === 0;
        var bLast = b.indexOf('Uden') === 0 || b.indexOf('Ingen') === 0;
        if (aLast && !bLast) return 1;
        if (!aLast && bLast) return -1;
        return a.localeCompare(b, 'da');
    });

    for (var gi = 0; gi < groupKeys.length; gi++) {
        var groupName = groupKeys[gi];
        var groupItems = groups[groupName];

        if (groupBy !== 'none') {
            html += '<div class="sl-group-header">' +
                '<span class="sl-group-name">' + esc(groupName) + '</span>' +
                '<span class="sl-group-line"></span>' +
                '<span class="sl-group-count">' + groupItems.length + '</span>' +
                '</div>';
        }

        for (var ii = 0; ii < groupItems.length; ii++) {
            html += _slRenderItem(groupItems[ii], groupBy);
        }
    }

    container.innerHTML = html;
}

function _slBuildGroups(items, groupBy) {
    if (groupBy === 'none') return { '': items };

    var map = {};
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var key = 'Ukendt';
        var p = _slProductsMap[item.product_id];

        if (groupBy === 'supplier') {
            var locId = p ? (p.shopping_location_id || '') : '';
            key = _slLocationsMap[locId] || 'Uden leverandor';
        } else if (groupBy === 'product_group') {
            key = (p && p.product_group_id) ? (_slGroupsMap[p.product_group_id] || 'Ingen kategori') : 'Ingen kategori';
        }

        if (!map[key]) map[key] = [];
        map[key].push(item);
    }
    return map;
}

function _slRenderItem(item, groupBy) {
    var p = _slProductsMap[item.product_id];
    var name = p ? p.name : ('Produkt #' + item.product_id);
    var qty = parseFloat(item.amount) || 1;
    var isDone = _slStruckItems[String(item.id)] === true;
    var isExpanded = _slExpandedId === String(item.id);

    // Unit: use item's qu_id if present, else product's qu_id_stock
    var quId = item.qu_id || (p ? p.qu_id_stock : null);
    var unitName = quId ? (_slQUnitsMap[quId] || '') : '';

    // Source class based on note
    var src = _slGetSourceClass(item);
    var srcTag = '';
    if (src === 'missing') {
        srcTag = '<span class="sl-source-tag sl-tag-missing">Manglende</span>';
    } else if (src === 'expiring') {
        srcTag = '<span class="sl-source-tag sl-tag-expiring">Udloeber</span>';
    }

    // Supplier name (show if not grouping by supplier)
    var supplierHtml = '';
    if (groupBy !== 'supplier' && p && p.shopping_location_id) {
        var sName = _slLocationsMap[p.shopping_location_id];
        if (sName) {
            supplierHtml = '<span class="sl-item-supplier">' + esc(sName) + '</span>';
        }
    }

    // Note
    var noteHtml = '';
    if (item.note && src === 'manual') {
        noteHtml = '<span class="sl-item-note">' + esc(item.note) + '</span>';
    }

    // Expand detail panel
    var detailHtml =
        '<div class="sl-item-detail">' +
        '  <div class="sl-detail-grid">' +
        '    <div class="sl-detail-field">' +
        '      <div class="sl-detail-label">Maengde</div>' +
        '      <div class="sl-detail-value">' + _slFormatQty(qty) + ' ' + esc(unitName) + '</div>' +
        '    </div>' +
        '    <div class="sl-detail-field">' +
        '      <div class="sl-detail-label">Leverandor</div>' +
        '      <div class="sl-detail-value' + (p && p.shopping_location_id ? '' : ' sl-empty-val') + '">' +
                   (p && p.shopping_location_id ? esc(_slLocationsMap[p.shopping_location_id] || '—') : '—') +
        '      </div>' +
        '    </div>' +
        '    <div class="sl-detail-field">' +
        '      <div class="sl-detail-label">Produktgruppe</div>' +
        '      <div class="sl-detail-value' + (p && p.product_group_id ? '' : ' sl-empty-val') + '">' +
                   (p && p.product_group_id ? esc(_slGroupsMap[p.product_group_id] || '—') : '—') +
        '      </div>' +
        '    </div>' +
        '    <div class="sl-detail-field">' +
        '      <div class="sl-detail-label">Note</div>' +
        '      <div class="sl-detail-value' + (item.note ? '' : ' sl-empty-val') + '">' +
                   (item.note ? esc(item.note) : '—') +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="sl-detail-actions">' +
        '    <button class="sl-detail-btn" data-action="edit-qty">Ret antal</button>' +
        '    <button class="sl-detail-btn sl-detail-danger" data-action="remove">Fjern</button>' +
        '  </div>' +
        '</div>';

    return '<div class="sl-item-card' +
        (isDone ? ' sl-done' : '') +
        ' sl-source-' + src +
        (isExpanded ? ' sl-expanded' : '') +
        '" data-id="' + item.id + '">' +
        '<div class="sl-item-main">' +
        '  <div class="sl-item-check"></div>' +
        '  <div class="sl-item-info">' +
        '    <div class="sl-item-name">' + esc(name) + '</div>' +
        '    <div class="sl-item-meta">' + srcTag + supplierHtml + noteHtml + '</div>' +
        '  </div>' +
        '  <div class="sl-item-qty">' + _slFormatQty(qty) + ' <span class="sl-unit">' + esc(unitName) + '</span></div>' +
        '  <div class="sl-item-chevron">›</div>' +
        '</div>' +
        detailHtml +
        '</div>';
}

function _slGetSourceClass(item) {
    var note = (item.note || '').toLowerCase();
    if (note.indexOf('missing') !== -1 || note.indexOf('mangl') !== -1) return 'missing';
    if (note.indexOf('expir') !== -1 || note.indexOf('udl') !== -1) return 'expiring';
    return 'manual';
}

// ════════════════════════════════════════════════════════════
// BOTTOM BAR
// ════════════════════════════════════════════════════════════

function _slUpdateBottomBar() {
    var bar = document.getElementById('slBottomBar');
    if (!bar) return;

    var struckCount = 0;
    _slItems.forEach(function(i) {
        if (_slStruckItems[String(i.id)]) struckCount++;
    });

    bar.style.display = (_slItems.length > 0) ? 'flex' : 'none';

    var clearStruckBtn = bar.querySelector('[data-action="clear-struck"]');
    if (clearStruckBtn) {
        clearStruckBtn.textContent = 'Ryd afkrydsede (' + struckCount + ')';
        clearStruckBtn.disabled = struckCount === 0;
        clearStruckBtn.style.opacity = struckCount === 0 ? '0.4' : '1';
    }
}

// ════════════════════════════════════════════════════════════
// STRIKE / CHECK
// ════════════════════════════════════════════════════════════

function _slToggleStrike(id) {
    var key = String(id);
    if (_slStruckItems[key]) {
        delete _slStruckItems[key];
    } else {
        _slStruckItems[key] = true;
    }
    _slPersistStruck();
    _slApplyFilters();
}

function _slPersistStruck() {
    localStorage.setItem('sl_struck_items', JSON.stringify(_slStruckItems));
}

// ════════════════════════════════════════════════════════════
// ADD PANEL
// ════════════════════════════════════════════════════════════

var _slSelectedProductId = null;

function _slToggleAddPanel() {
    _slAddPanelOpen = !_slAddPanelOpen;
    var panel = document.getElementById('slAddPanel');
    var btn = document.getElementById('slAddBtn');

    if (panel) panel.classList.toggle('sl-show', _slAddPanelOpen);
    if (btn) btn.classList.toggle('sl-add-btn-active', _slAddPanelOpen);

    if (_slAddPanelOpen) {
        _slSelectedProductId = null;
        var search = document.getElementById('slAddSearch');
        if (search) {
            search.value = '';
            search.focus();
        }
        var results = document.getElementById('slAddResults');
        if (results) results.innerHTML = '';
        var qtyInput = document.getElementById('slAddQty');
        if (qtyInput) qtyInput.value = '1';
        var unitSpan = document.getElementById('slAddUnit');
        if (unitSpan) unitSpan.textContent = '';
    }
}

function _slFilterAddProducts() {
    var searchEl = document.getElementById('slAddSearch');
    var resultsEl = document.getElementById('slAddResults');
    if (!searchEl || !resultsEl) return;

    var query = searchEl.value.toLowerCase().trim();
    if (query.length < 2) {
        resultsEl.innerHTML = '';
        return;
    }

    var matches = _slProducts.filter(function(p) {
        return p.name.toLowerCase().indexOf(query) !== -1;
    }).slice(0, 20);

    if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="sl-add-no-results">Ingen produkter fundet</div>';
        return;
    }

    var html = '';
    for (var i = 0; i < matches.length; i++) {
        var p = matches[i];
        var quName = _slQUnitsMap[p.qu_id_stock] || '';
        var selected = _slSelectedProductId === p.id ? ' sl-add-result-selected' : '';
        html += '<div class="sl-add-result' + selected + '" data-id="' + p.id + '">' +
            '<span class="sl-add-result-name">' + esc(p.name) + '</span>' +
            '<span class="sl-add-result-unit">' + esc(quName) + '</span>' +
            '</div>';
    }
    resultsEl.innerHTML = html;
}

function _slSelectAddProduct(productId) {
    _slSelectedProductId = productId;
    var p = _slProductsMap[productId];

    // Highlight selected in results
    var results = document.getElementById('slAddResults');
    if (results) {
        var items = results.querySelectorAll('.sl-add-result');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('sl-add-result-selected',
                parseInt(items[i].getAttribute('data-id')) === productId);
        }
    }

    // Update search field with product name
    var searchEl = document.getElementById('slAddSearch');
    if (searchEl && p) searchEl.value = p.name;

    // Show unit
    var unitSpan = document.getElementById('slAddUnit');
    if (unitSpan && p) {
        unitSpan.textContent = _slQUnitsMap[p.qu_id_stock] || '';
    }

    // Focus qty input
    var qtyInput = document.getElementById('slAddQty');
    if (qtyInput) qtyInput.focus();

    // Hide results
    if (results) results.innerHTML = '';
}

async function _slAddItemManual() {
    if (!_slSelectedProductId) {
        _slShowToast('Vaelg et produkt foerst', 'warn');
        return;
    }
    if (_slBusy) return;
    _slBusy = true;

    var qty = parseFloat(document.getElementById('slAddQty').value) || 1;

    try {
        await addShoppingListProduct(_slSelectedProductId, qty);
        _slShowToast('Vare tilfojet', 'success');
        _slToggleAddPanel();
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        _slBusy = false;
    }
}

// ════════════════════════════════════════════════════════════
// QUICK ACTIONS
// ════════════════════════════════════════════════════════════

async function _slQuickAction(type, btnEl) {
    if (_slBusy) return;
    _slBusy = true;

    var origHtml = btnEl.innerHTML;
    btnEl.style.opacity = '0.5';
    btnEl.style.pointerEvents = 'none';

    try {
        if (type === 'missing')  await addMissingProducts();
        if (type === 'expiring') await addExpiredProducts();
        if (type === 'overdue')  await addOverdueProducts();

        var label = type === 'missing' ? 'Manglende' : (type === 'expiring' ? 'Udloebende' : 'Overskredet');
        _slShowToast(label + ' produkter tilfojet', 'success');
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        btnEl.style.opacity = '';
        btnEl.style.pointerEvents = '';
        _slBusy = false;
    }
}

// ════════════════════════════════════════════════════════════
// ITEM ACTIONS
// ════════════════════════════════════════════════════════════

async function _slEditQty(itemId) {
    var item = _slItems.find(function(i) { return String(i.id) === String(itemId); });
    if (!item) return;

    var currentQty = parseFloat(item.amount) || 1;
    var newQty = prompt('Ny maengde:', currentQty);
    if (newQty === null) return;

    var qty = parseFloat(newQty);
    if (isNaN(qty) || qty <= 0) {
        _slShowToast('Ugyldig maengde', 'warn');
        return;
    }

    if (_slBusy) return;
    _slBusy = true;

    try {
        // Delete old item and re-add with new amount
        await deleteShoppingListItem(item.id);
        await addShoppingListProduct(item.product_id, qty, item.shopping_list_id || 1);
        _slShowToast('Maengde opdateret', 'success');
        _slExpandedId = null;
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        _slBusy = false;
    }
}

async function _slRemoveItem(itemId) {
    if (!confirm('Fjern vare fra listen?')) return;
    if (_slBusy) return;
    _slBusy = true;

    try {
        await deleteShoppingListItem(parseInt(itemId));
        delete _slStruckItems[String(itemId)];
        _slPersistStruck();
        if (_slExpandedId === String(itemId)) _slExpandedId = null;
        _slShowToast('Vare fjernet', 'success');
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        _slBusy = false;
    }
}

// ════════════════════════════════════════════════════════════
// CLEAR ACTIONS
// ════════════════════════════════════════════════════════════

async function _slClearStruck() {
    var struckIds = [];
    _slItems.forEach(function(i) {
        if (_slStruckItems[String(i.id)]) struckIds.push(i.id);
    });

    if (struckIds.length === 0) return;
    if (!confirm('Fjern ' + struckIds.length + ' afkrydsede varer fra listen?')) return;
    if (_slBusy) return;
    _slBusy = true;

    try {
        // Delete each struck item
        var promises = struckIds.map(function(id) {
            return deleteShoppingListItem(id);
        });
        await Promise.all(promises);

        // Clear struck state
        struckIds.forEach(function(id) { delete _slStruckItems[String(id)]; });
        _slPersistStruck();

        _slShowToast(struckIds.length + ' varer fjernet', 'success');
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        _slBusy = false;
    }
}

async function _slClearAll() {
    if (_slItems.length === 0) return;
    if (!confirm('Ryd HELE indkoebslisten? (' + _slItems.length + ' varer)')) return;
    if (_slBusy) return;
    _slBusy = true;

    try {
        await clearShoppingList();
        _slStruckItems = {};
        _slPersistStruck();
        _slShowToast('Listen ryddet', 'success');
        await _slReload();
    } catch (err) {
        _slShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        _slBusy = false;
    }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function _slFormatQty(n) {
    if (n === Math.round(n)) return String(n);
    return n.toFixed(1);
}

function _slShowToast(message, type) {
    var area = document.getElementById('slToastArea');
    if (!area) return;

    var toast = document.createElement('div');
    toast.className = 'sl-toast sl-toast-' + (type || 'info');
    toast.textContent = message;
    area.appendChild(toast);

    setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s';
        setTimeout(function() { toast.remove(); }, 400);
    }, 3000);
}
