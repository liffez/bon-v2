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
          fetchGrocyLocations, fetchGrocyProductGroups, fetchShoppingLocations,
          fetchGrocyQuantityUnitConversions,
          postGrocyInventory, postGrocyShoppingList,
          putGrocyProduct, putGrocyProductUserfields, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

var _soStockData      = [];   // processed stock items (aktive varer)
var _soInactiveItems  = [];   // inaktive varer (#615) — vises kun bag pillen "inaktive"
var _soHiddenCount    = 0;    // varer Grocy siger aldrig skal vises her (#616)
var _soAllProducts    = [];   // all active products (for add-product)
var _soProductsMap    = {};   // product_id -> product
var _soQUnitsMap      = {};   // qu_id -> unit name
var _soLocationsMap   = {};   // location_id -> name
var _soLocationsArr   = [];   // raw locations array
var _soGroupsMap      = {};   // product_group_id -> name
var _soGroupsArr      = [];   // raw groups array
var _soShopLocsMap    = {};   // shopping_location_id -> name
var _soShopLocsArr    = [];   // raw shopping locations array
var _soConversions    = [];   // raw quantity_unit_conversions (til salgs-/forbrugsenhed-visning)
var _soEditIds        = [];   // product_ids under redigering (1 = enkelt, >1 = bulk)

var _soFilteredData   = [];   // after filters applied
var _soSelectMode     = false;
var _soSelectedIds    = {};   // product_id -> true  (plain object, no Set for compat)
var _soCurrentExpand  = null; // product_id of expanded card
var _soSearchTimer    = null; // debounce timer
var _soAddSearchTimer = null; // debounce timer (tilføj vare-modal)
var _soSaving         = {};   // product_id -> true mens en lager-skrivning er undervejs
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
            fetchGrocyProductGroups(),
            fetchShoppingLocations().catch(function() { return []; }),
            fetchGrocyQuantityUnitConversions().catch(function() { return []; })
        ]);

        var rawStock    = results[0];
        var rawProducts = results[1];
        var rawQus      = results[2];
        var rawLocs     = results[3];
        var rawGroups   = results[4];
        var rawShopLocs = results[5] || [];
        _soConversions  = results[6] || [];

        // Build lookup maps
        _soQUnitsMap = {};
        rawQus.forEach(function(q) { _soQUnitsMap[q.id] = q.name; });

        _soLocationsMap = {};
        _soLocationsArr = rawLocs.slice().sort(function(a, b) { return String(a.name).localeCompare(String(b.name), 'da'); });
        rawLocs.forEach(function(l) { _soLocationsMap[l.id] = l.name; });

        _soGroupsMap = {};
        // Grocy leverer grupperne i oprettelses-rækkefølge, så en ny gruppe
        // ("05 Dressinger") landede nederst i filteret. Samme sortering som
        // gruppe-overskrifterne i listen.
        _soGroupsArr = rawGroups.slice().sort(function(a, b) { return String(a.name).localeCompare(String(b.name), 'da'); });
        rawGroups.forEach(function(g) { _soGroupsMap[g.id] = g.name; });

        _soShopLocsMap = {};
        _soShopLocsArr = rawShopLocs;
        rawShopLocs.forEach(function(s) { _soShopLocsMap[s.id] = s.name; });

        // Kortet rummer ALLE produkter, så ✎-modalen også kan åbne en inaktiv vare
        // (#615). _soAllProducts (til "Tilføj vare") er fortsat kun de aktive.
        _soProductsMap = {};
        rawProducts.forEach(function(p) { _soProductsMap[p.id] = p; });

        // Grocys "Vis aldrig på lageroversigten" respekteres nu (#616). Kortet
        // rummer dem stadig, så ✎-modalen kan åbne en skjult vare hvis nogen
        // deep-linker; de er bare ude af listerne. Tælles i _soHiddenCount, så
        // "intet at se" kan skelnes fra "vi skjuler noget".
        _soHiddenCount = rawProducts.filter(grocyHiddenOnStockOverview).length;
        var visible = rawProducts.filter(function(p) { return !grocyHiddenOnStockOverview(p); });
        _soAllProducts = visible.filter(_soIsActiveProduct);

        // Process stock
        var now = new Date();
        // Inaktive varer hører ikke til i den aktive liste, heller ikke hvis de
        // stadig har en lagerpost — de samles i _soInactiveItems nedenfor.
        _soStockData = rawStock.filter(function(item) {
            var fp = _soProductsMap[item.product_id];
            if (grocyHiddenOnStockOverview(fp)) return false;
            return !fp || _soIsActiveProduct(fp);
        }).map(function(item) {
            var status = 'ok';
            var daysUntilExpiry = Infinity;
            var amount = parseFloat(item.amount) || 0;
            var product = item.product || _soProductsMap[item.product_id] || {};
            var fullProduct = _soProductsMap[item.product_id] || product;
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
                min_stock_amount:   minStock,
                alt_conv:           _soAltConv(product),
                // "Sidst tjekket" — Grocy-userfields skrevet af optællingen,
                // varemodtagelsen og (fra #613) lageroversigtens eget Gem.
                // Læses fra /objects/products (_soProductsMap): det `product`,
                // /stock indlejrer, bærer INGEN userfields, så alt ville stå
                // som "aldrig tjekket" (fundet ved browser-verifikation).
                last_checked:       _soLastChecked(fullProduct),
                last_checked_unit:  (fullProduct.userfields || {}).LastCheckedUnit || null,
                check_interval:     _soCheckInterval(fullProduct),
                check:              null
            };
        });
        _soStockData.forEach(_soRecalcCheck);
        _soSortMode = _soLoadSortMode();

        // Inaktive varer (#615): egen liste, beholdning fra /stock hvis der er en.
        var stockByPid = {};
        rawStock.forEach(function(item) { stockByPid[item.product_id] = item; });
        _soInactiveItems = visible.filter(function(p) { return !_soIsActiveProduct(p); })
            .map(function(p) { return _soItemFromProduct(p, stockByPid[p.id] || null, true); });
        _soInactiveItems.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });

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
        '  <input type="text" class="so-search" id="soSearch" placeholder="Søg produkt...">',
        '  <button class="so-filter-btn so-add-btn" id="soAddBtn" title="Tilføj en vare der ikke står på listen">+ Tilføj vare</button>',
        '  <select class="so-select" id="soLocationFilter"><option value="">Alle lokationer</option></select>',
        '  <select class="so-select" id="soGroupFilter"><option value="">Alle grupper</option></select>',
        '  <select class="so-select" id="soSortSel" title="Rækkefølge inden for hver gruppe">',
        '    <option value="name">Sortér: navn</option>',
        '    <option value="checked">Sortér: ældst tjekket først</option>',
        '  </select>',
        '  <button class="so-filter-btn" id="soSelectModeBtn" title="Vælg flere">&#x2610;</button>',
        '</div>',
        '<div class="so-selection-bar" id="soSelectionBar">',
        '  <span class="so-sel-count" id="soSelCount">0 valgt</span>',
        '  <button class="so-sel-btn so-sel-edit" data-action="bulk-edit">&#x270E; Rediger valgte</button>',
        '  <button class="so-sel-btn so-sel-shopping" data-action="bulk-shopping">+ Indkøbsliste</button>',
        '  <button class="so-sel-btn" data-action="bulk-clear">Annuller</button>',
        '</div>',
        '<div class="so-toast-area" id="soToastArea"></div>',
        '<div class="so-content" id="soContent"></div>',
        '<div class="so-edit-overlay" id="soEditOverlay">',
        '  <div class="so-edit-modal" role="dialog" aria-modal="true">',
        '    <div class="so-edit-header">',
        '      <h3 id="soEditTitle">Rediger vare</h3>',
        '      <button class="so-edit-x so-edit-close" title="Luk">&times;</button>',
        '    </div>',
        '    <div class="so-edit-body" id="soEditBody"></div>',
        '    <div class="so-edit-footer">',
        '      <span class="so-edit-status" id="soEditStatus"></span>',
        '      <button class="so-sel-btn so-edit-close">Annuller</button>',
        '      <button class="so-save-btn so-edit-save">Gem</button>',
        '    </div>',
        '  </div>',
        '</div>',
        // Tilføj vare: varer uden lagerpost i Grocy findes slet ikke i /stock,
        // og er derfor usynlige i oversigten indtil de får en beholdning.
        '<div class="so-edit-overlay" id="soAddOverlay">',
        '  <div class="so-edit-modal" role="dialog" aria-modal="true">',
        '    <div class="so-edit-header">',
        '      <h3>Tilføj vare</h3>',
        '      <button class="so-edit-x so-add-close" title="Luk">&times;</button>',
        '    </div>',
        '    <div class="so-edit-body">',
        '      <p class="so-add-hint">Varer der endnu ikke har en beholdning. Vælg en for at give den et tal.</p>',
        '      <div class="so-add-filters">',
        '        <input type="text" class="so-search" id="soAddSearch" placeholder="Søg vare...">',
        '        <select class="so-select" id="soAddLocFilter"><option value="">Alle lokationer</option></select>',
        '      </div>',
        '      <div class="so-add-list" id="soAddList"></div>',
        '    </div>',
        '    <div class="so-edit-footer">',
        '      <span class="so-edit-status" id="soAddCount"></span>',
        '      <button class="so-sel-btn so-add-close">Luk</button>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('\n');

    // Event delegation on container
    _soContainer.addEventListener('click', _soHandleClick);
    _soContainer.addEventListener('input', _soHandleInput);
    _soContainer.addEventListener('change', _soHandleChange);

    // Escape to close edit modal (first), then expand
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        var addOv = document.getElementById('soAddOverlay');
        if (addOv && addOv.classList.contains('so-visible')) { _soCloseAdd(); return; }
        var ov = document.getElementById('soEditOverlay');
        if (ov && ov.classList.contains('so-visible')) { _soCloseEdit(); return; }
        if (_soCurrentExpand !== null) _soCloseExpand(_soCurrentExpand);
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

    var sortSel = document.getElementById('soSortSel');
    if (sortSel) sortSel.value = _soSortMode;

    var addLocSel = document.getElementById('soAddLocFilter');
    if (addLocSel) {
        addLocSel.innerHTML = '<option value="">Alle lokationer</option>' +
            _soLocationsArr.map(function(l) {
                return '<option value="' + l.id + '">' + esc(l.name) + '</option>';
            }).join('');
    }
}

// ════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ════════════════════════════════════════════════════════════

function _soHandleClick(e) {
    var target = e.target;

    // Tilføj vare: åbn, luk, vælg. Først — modalen ligger inde i containeren,
    // så dens klik skal fanges inden kort-/handlings-tjekkene nedenfor.
    if (target.closest('#soAddBtn')) {
        _soOpenAdd();
        return;
    }
    if (target.closest('.so-add-close') ||
        (target.id === 'soAddOverlay' && isOutsideClick(e, target))) {
        _soCloseAdd();
        return;
    }
    var addItem = target.closest('.so-add-item');
    if (addItem) {
        _soAddProductToList(parseInt(addItem.getAttribute('data-id')));
        return;
    }

    // Genaktivér (#615)
    var reBtn = target.closest('.so-reactivate-btn');
    if (reBtn) {
        e.stopPropagation();
        var rcard = reBtn.closest('.so-card');
        if (rcard) _soReactivate(parseInt(rcard.getAttribute('data-id')));
        return;
    }

    // Edit pencil on a card
    var editBtn = target.closest('.so-edit-btn');
    if (editBtn) {
        e.stopPropagation();
        var ecard = editBtn.closest('.so-card');
        if (ecard) _soOpenEdit([parseInt(ecard.getAttribute('data-id'))]);
        return;
    }

    // Edit modal: close (× / Annuller / backdrop) or save
    if (target.closest('.so-edit-close') ||
        (target.id === 'soEditOverlay' && isOutsideClick(e, target))) {
        _soCloseEdit();
        return;
    }
    if (target.closest('.so-edit-save')) {
        _soSaveEdit();
        return;
    }

    // Status pill click -> filter ("N varer" rydder alt)
    var pill = target.closest('.so-status-pill[data-filter]');
    if (pill) {
        var pf = pill.getAttribute('data-filter');
        if (pf === '__all__') _soClearAllFilters();
        else _soToggleStatusFilter(pf);
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
        if (action === 'bulk-edit')     { _soOpenBulkEdit(); return; }
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
        } else if (!card.classList.contains('so-inactive')) {
            _soToggleExpand(pid);       // en inaktiv vare har intet lager at justere
        }
        return;
    }
}

function _soHandleInput(e) {
    if (e.target.id === 'soSearch') {
        clearTimeout(_soSearchTimer);
        _soSearchTimer = setTimeout(_soApplyFilters, 200);
    }
    if (e.target.id === 'soAddSearch') {
        clearTimeout(_soAddSearchTimer);
        _soAddSearchTimer = setTimeout(_soRenderAddList, 150);
    }
}

function _soHandleChange(e) {
    if (e.target.id === 'soLocationFilter' || e.target.id === 'soGroupFilter') {
        _soApplyFilters();
    }
    if (e.target.id === 'soSortSel') {
        _soSetSortMode(e.target.value);
    }
    if (e.target.id === 'soAddLocFilter') {
        _soRenderAddList();
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

function _soHasAnyFilter() {
    var searchEl = document.getElementById('soSearch');
    var locEl    = document.getElementById('soLocationFilter');
    var grpEl    = document.getElementById('soGroupFilter');
    return !!(_soActiveStatusFilter ||
        (searchEl && searchEl.value.trim()) ||
        (locEl && locEl.value) ||
        (grpEl && grpEl.value));
}

function _soClearAllFilters() {
    var searchEl = document.getElementById('soSearch');
    var locEl    = document.getElementById('soLocationFilter');
    var grpEl    = document.getElementById('soGroupFilter');
    if (searchEl) searchEl.value = '';
    if (locEl)    locEl.value = '';
    if (grpEl)    grpEl.value = '';
    _soActiveStatusFilter = '';
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

    // Søg/lokation/gruppe gælder begge lister; status-pillen vælger hvilken.
    function base(item) {
        if (search && item.name.toLowerCase().indexOf(search) === -1) return false;
        if (locationId && String(item.location_id) !== locationId) return false;
        if (groupId && String(item.product_group_id) !== groupId) return false;
        return true;
    }
    var activeMatches   = _soStockData.filter(base);
    var inactiveMatches = _soInactiveItems.filter(base);

    if (status === 'inactive') {
        _soFilteredData = inactiveMatches;
    } else {
        _soFilteredData = activeMatches.filter(function(item) {
            if (status === 'unchecked') return _soIsUnchecked(item);
            return !status || item.status === status;
        });
    }

    _soUpdateStatusBar(activeMatches, inactiveMatches.length);
    _soRenderGrid();
}

// ════════════════════════════════════════════════════════════
// STATUS BAR
// ════════════════════════════════════════════════════════════

function _soUpdateStatusBar(activeMatches, inactiveCount) {
    var bar = document.getElementById('soStatusBar');
    if (!bar) return;
    activeMatches = activeMatches || _soFilteredData;
    inactiveCount = inactiveCount || 0;

    var total   = activeMatches.length;
    var expired = 0, duesoon = 0, low = 0, unchecked = 0;
    activeMatches.forEach(function(i) {
        if (i.status === 'expired') expired++;
        if (i.status === 'duesoon') duesoon++;
        if (i.status === 'low')     low++;
        if (_soIsUnchecked(i))      unchecked++;
    });

    // "N varer" er også vejen tilbage: ét klik rydder status-pille, søgning,
    // lokation og gruppe. Uden filtre er den blot en tæller.
    var filtered = _soHasAnyFilter();
    var html = '<span class="so-status-pill so-pill-total' + (filtered ? ' so-pill-clear' : '') +
        '" data-filter="__all__" title="' + (filtered ? 'Vis alle aktive varer — ryd alle filtre' : 'Alle aktive varer') + '">' +
        (filtered ? 'Alle ' : '') + total + ' varer</span>';

    if (expired > 0) {
        html += '<span class="so-status-pill so-pill-expired' +
            (_soActiveStatusFilter === 'expired' ? ' active' : '') +
            '" data-filter="expired">' + expired + ' udløbet</span>';
    }
    if (duesoon > 0) {
        html += '<span class="so-status-pill so-pill-duesoon' +
            (_soActiveStatusFilter === 'duesoon' ? ' active' : '') +
            '" data-filter="duesoon">' + duesoon + ' snart udløb</span>';
    }
    if (low > 0) {
        html += '<span class="so-status-pill so-pill-low' +
            (_soActiveStatusFilter === 'low' ? ' active' : '') +
            '" data-filter="low">' + low + ' lav beholdning</span>';
    }
    if (unchecked > 0) {
        html += '<span class="so-status-pill so-pill-unchecked' +
            (_soActiveStatusFilter === 'unchecked' ? ' active' : '') +
            '" data-filter="unchecked" title="Aldrig tjekket, eller tjek-intervallet er overskredet">' +
            unchecked + ' ikke tjekket</span>';
    }
    if (inactiveCount > 0) {
        html += '<span class="so-status-pill so-pill-inactive' +
            (_soActiveStatusFilter === 'inactive' ? ' active' : '') +
            '" data-filter="inactive" title="Varer der er sat inaktive (fx \'Varen findes ikke mere\' i optællingen). Kan genaktiveres herfra.">' +
            inactiveCount + ' inaktive</span>';
    }

    // Skjulte varer nævnes, men er ikke en pille man kan klikke: de er skjult
    // efter et bevidst valg i Grocy, og en liste her ville modsige det. Uden
    // tallet kan man ikke se forskel på "der er ikke mere" og "vi viser ikke alt".
    if (_soHiddenCount > 0) {
        html += '<span class="so-status-note" title="Sat til &quot;Vis aldrig p&aring; lageroversigten&quot; i Grocy — typisk en forælder hvis beholdning ligger på dens undervarer. Ændres i Grocy.">'
             +  _soHiddenCount + ' skjult</span>';
    }

    bar.innerHTML = html;
}

// ════════════════════════════════════════════════════════════
// RENDER GRID
// ════════════════════════════════════════════════════════════

/**
 * Hele gridet bygges med innerHTML, så et udfoldet kort bliver skiftet ud med et
 * NYT element hver gang der søges eller filtreres. Uden det her mister brugeren
 * det tal han lige har tastet — og et klik der rammer midt i udskiftningen bliver
 * aldrig til et click-event, fordi knappen forsvandt mellem tryk og slip.
 * Samme mønster som fokus-redningen i shared/indkob.js.
 */
function _soCaptureEdit(container) {
    if (_soCurrentExpand === null) return null;
    var el = container.querySelector('.so-card[data-id="' + _soCurrentExpand + '"] .so-adj-input');
    if (!el) return null;
    var sel = null;
    // selectionStart findes ikke på type="number" i alle browsere.
    try { sel = [el.selectionStart, el.selectionEnd]; } catch (e) { sel = null; }
    return { id: _soCurrentExpand, value: el.value, focused: document.activeElement === el, sel: sel };
}

function _soRestoreEdit(container, keep) {
    if (!keep) return;
    var el = container.querySelector('.so-card[data-id="' + keep.id + '"] .so-adj-input');
    if (!el) return;                       // kortet blev filtreret væk — det kan brugeren se
    el.value = keep.value;
    if (keep.focused) {
        el.focus();
        if (keep.sel) { try { el.setSelectionRange(keep.sel[0], keep.sel[1]); } catch (e) { /* number-input */ } }
    }
}

function _soRenderGrid() {
    var container = document.getElementById('soContent');
    if (!container) return;

    var keep = _soCaptureEdit(container);

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
        group.items = _soSortItems(group.items);
        html += '<div class="so-group-header">' + esc(group.label) + ' (' + group.items.length + ')</div>';
        html += '<div class="so-grid' + selectClass + '">';
        group.items.forEach(function(item) {
            html += _soRenderCard(item);
        });
        html += '</div>';
    });

    container.innerHTML = html;
    _soRestoreEdit(container, keep);
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
        amountText += ' (' + _soRound(item.amount_opened) + ' åbnet)';
    }

    // Sekundær enhed(er) — fx "≈ 6 kasser" (salgs-/forbrugsenhed, kun hvor konvertering findes)
    var altHtml = '';
    if (item.alt_conv && item.alt_conv.length && item.amount > 0) {
        altHtml = '<span class="so-card-alt">' + item.alt_conv.map(function(a) {
            return '&#8776; ' + _soRound(item.amount * a.factor, 1) + ' ' + esc(a.unit);
        }).join(' &middot; ') + '</span>';
    }

    var checkHtml = item.inactive ? '' : _soRenderCheck(item);

    // Min stock warning
    var minHtml = '';
    if (item.min_stock_amount > 0 && item.amount < item.min_stock_amount) {
        minHtml = '<span class="so-min-warn">min ' + _soRound(item.min_stock_amount) + '</span>';
    }

    // Netop hentet frem: har endnu ingen lagerpost i Grocy
    var newHtml = item.isNew && !item.inactive ? '<span class="so-new-badge">ingen beholdning endnu</span>' : '';
    // #615 — inaktiv: ingen justering (varen er taget af listerne), men en vej tilbage.
    var inactiveHtml = item.inactive ? '<span class="so-inactive-badge">inaktiv</span>' : '';

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
        '  <button class="so-shop-btn" title="Tilføj til indkøbsliste">+ Indkøbsliste</button>' +
        '</div>' +
        '</div>';

    if (item.inactive) {
        return '<div class="so-card so-inactive' + selectedClass + '" data-id="' + item.product_id + '">' +
            '<div class="so-card-main">' +
            selectBoxHtml +
            '<div class="so-card-info">' +
            '  <div class="so-card-name">' + esc(item.name) + '</div>' +
            '  <div class="so-card-meta">' +
            '    <span class="so-card-amount">' + amountText + '</span>' +
            inactiveHtml +
            '  </div>' +
            '</div>' +
            '<div class="so-card-side so-card-side-row">' +
            '  <button class="so-reactivate-btn" title="Gør varen aktiv igen — den kommer tilbage på listerne">&#x21BA; Aktivér</button>' +
            '  <button class="so-edit-btn" title="Rediger vare">&#x270E;</button>' +
            '</div>' +
            '</div>' +
            '</div>';
    }

    return '<div class="so-card ' + statusClass + selectedClass + expandedClass + '" data-id="' + item.product_id + '">' +
        '<div class="so-card-main">' +
        selectBoxHtml +
        '<div class="so-card-info">' +
        '  <div class="so-card-name">' + esc(item.name) + '</div>' +
        '  <div class="so-card-meta">' +
        '    <span class="so-card-amount">' + amountText + '</span>' +
        altHtml + expiryHtml + minHtml + newHtml +
        '  </div>' +
        '</div>' +
        // Højre-søjle: blyant øverst, "sidst tjekket" under. Søjlen er præcis
        // så høj som kortets indholds-minimum (44px), så mærket aldrig gør
        // kortet højere — og det stjæler ikke plads fra enheds-omregningerne.
        '<div class="so-card-side">' +
        '  <button class="so-edit-btn" title="Rediger vare">&#x270E;</button>' +
        checkHtml +
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

/** Nuværende beholdning i Grocy for ét produkt. null hvis den ikke kunne hentes. */
async function _soFreshAmount(productId) {
    try {
        var stock = await fetchGrocyStock();
        var row = stock.find(function(s) { return String(s.product_id) === String(productId); });
        return row ? (parseFloat(row.amount) || 0) : 0;
    } catch (e) {
        return null;
    }
}

async function _soAdjustInventory(productId) {
    var input = document.getElementById('soAdj-' + productId);
    if (!input) return;
    var newAmount = parseFloat(input.value);

    if (isNaN(newAmount) || newAmount < 0) {
        _soShowToast('Ugyldig mængde', 'warn');
        return;
    }

    var item = _soStockData.find(function(i) { return i.product_id === productId; });
    if (!item) return;

    // Dobbeltklik må ikke sende to skrivninger afsted mod hinanden.
    if (_soSaving[productId]) return;
    _soSaving[productId] = true;

    try {
        // Kortet kan have stået åbent i timevis. Lageret flytter sig af sig selv —
        // en bon der sættes til LEVERET trækker råvarerne automatisk. Vi sender et
        // ABSOLUT tal, så uden det her tjek ville et Gem tavst skrive oven i det
        // der er sket imens. Samme vagt som optællingen har (§6).
        var fresh = await _soFreshAmount(productId);
        if (fresh !== null && Math.abs(fresh - item.amount) > 0.01) {
            var behold = !confirm(
                'Lageret har ændret sig, mens kortet stod åbent.\n\n' +
                'Nu på lageret: ' + _soRound(fresh) + ' ' + item.qu_name + '\n' +
                'Dit tal: ' + _soRound(newAmount) + ' ' + item.qu_name + '\n\n' +
                'OK — mit tal er rigtigt, skriv det.\n' +
                'Annuller — lagerets tal er rigtigt, lad det stå.'
            );
            if (behold) {
                item.amount = fresh;
                item.isNew  = false;
                _soRecalcStatus(item);
                var stampedKeep = await _soStampChecked(item);
                _soCloseExpand(productId);
                _soApplyFilters();
                _soShowToast(esc(item.name) + ': beholdt lagerets tal (' + _soRound(fresh) + ' ' + esc(item.qu_name) + ')' +
                    (stampedKeep ? ' · tjek registreret' : ''), 'info');
                return;
            }
            item.amount = fresh;   // så "diff" i kvitteringen nedenfor er sand
        }

        if (Math.abs(newAmount - item.amount) < 0.01) {
            // #613 — et tjek uden ændring er også et tjek. Varen ER set, og
            // tallet passede; det skal stå på varen, ellers ser den "aldrig
            // tjekket" ud, selvom nogen lige har stået med den i hånden.
            var stampedSame = await _soStampChecked(item);
            _soCloseExpand(productId);
            _soApplyFilters();
            _soShowToast('Ingen ændring' + (stampedSame ? ' · tjek registreret' : ''), 'info');
            return;
        }

        await postGrocyInventory(productId, newAmount, item.best_before_date || null);
        // Stemplet skrives EFTER lager-skrivningen og må aldrig vælte den:
        // fejler stemplingen, er tallet stadig gemt, og det siges højt.
        await _soStampChecked(item);

        var diff = _soRound(newAmount - item.amount);
        var sign = diff > 0 ? '+' : '';
        _soShowToast(esc(item.name) + ': ' + sign + diff + ' ' + esc(item.qu_name) + ' (nu ' + _soRound(newAmount) + ')', 'success');
        _soCloseExpand(productId);

        // Update local data + re-render
        item.amount = newAmount;
        item.isNew  = false;   // varen har en lagerpost nu
        _soRecalcStatus(item);
        _soApplyFilters();

    } catch (err) {
        _soShowToast('Fejl: ' + esc(err.message), 'error');
    } finally {
        delete _soSaving[productId];
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
        _soShowToast((item ? esc(item.name) : 'Produkt') + ' tilføjet til indkøbslisten', 'success');
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
        _soShowToast(ids.length + ' varer tilføjet til indkøbslisten', 'success');
        _soClearSelection();
    } catch (err) {
        _soShowToast('Fejl: ' + esc(err.message), 'error');
    }
}

// ════════════════════════════════════════════════════════════
// TILFØJ VARE (uden lagerpost)
// ════════════════════════════════════════════════════════════

// Grocys /stock returnerer kun varer der HAR en lagerpost. En vare der aldrig
// har haft lager findes derfor slet ikke i oversigten — hverken med 0 eller med
// en soegning. Modalen her henter den frem, saa den kan faa et tal.

function _soOpenAdd() {
    var searchEl = document.getElementById('soAddSearch');
    if (searchEl) searchEl.value = '';
    var locEl = document.getElementById('soAddLocFilter');
    if (locEl) locEl.value = '';

    _soRenderAddList();
    var ov = document.getElementById('soAddOverlay');
    if (ov) ov.classList.add('so-visible');
    if (searchEl) searchEl.focus();
}

function _soCloseAdd() {
    var ov = document.getElementById('soAddOverlay');
    if (ov) ov.classList.remove('so-visible');
}

/** Aktive varer der ikke allerede står i oversigten. */
function _soProductsWithoutStock() {
    var onList = {};
    _soStockData.forEach(function(i) { onList[i.product_id] = true; });

    return _soAllProducts.filter(function(p) {
        return !onList[p.id];
    }).sort(function(a, b) {
        return String(a.name).localeCompare(String(b.name), 'da');
    });
}

function _soRenderAddList() {
    var listEl = document.getElementById('soAddList');
    if (!listEl) return;

    var searchEl = document.getElementById('soAddSearch');
    var locEl    = document.getElementById('soAddLocFilter');
    var search   = searchEl ? searchEl.value.toLowerCase().trim() : '';
    var locId    = locEl ? locEl.value : '';

    var all = _soProductsWithoutStock();
    var shown = all.filter(function(p) {
        if (search && String(p.name).toLowerCase().indexOf(search) === -1) return false;
        if (locId && String(p.location_id) !== locId) return false;
        return true;
    });

    var countEl = document.getElementById('soAddCount');
    if (countEl) {
        countEl.textContent = all.length === 0 ? '' :
            (shown.length === all.length
                ? shown.length + ' varer'
                : 'Viser ' + shown.length + ' af ' + all.length);
    }

    if (all.length === 0) {
        listEl.innerHTML = '<p class="so-add-empty">Alle varer står allerede på listen.</p>';
        return;
    }
    if (shown.length === 0) {
        listEl.innerHTML = '<p class="so-add-empty">Ingen varer matcher.</p>';
        return;
    }

    listEl.innerHTML = shown.map(function(p) {
        var loc = _soLocationsMap[p.location_id] || '-';
        var grp = _soGroupsMap[p.product_group_id] || '';
        return '<button type="button" class="so-add-item" data-id="' + p.id + '">' +
            '<span class="so-add-item-name">' + esc(p.name) + '</span>' +
            '<span class="so-add-item-meta">' + esc(loc) +
            (grp ? ' &middot; ' + esc(grp) : '') + '</span>' +
            '</button>';
    }).join('');
}

/**
 * Ryd kun de filtre der ville skjule den netop tilføjede vare.
 * Alternativet — at rydde alt — ville smide brugerens opsætning væk
 * uden grund. Returnerer true hvis noget blev ryddet.
 */
function _soClearFiltersHiding(item) {
    var cleared  = false;
    var searchEl = document.getElementById('soSearch');
    var locEl    = document.getElementById('soLocationFilter');
    var grpEl    = document.getElementById('soGroupFilter');

    if (searchEl && searchEl.value.trim() &&
        item.name.toLowerCase().indexOf(searchEl.value.toLowerCase().trim()) === -1) {
        searchEl.value = '';
        cleared = true;
    }
    if (locEl && locEl.value && String(item.location_id) !== locEl.value) {
        locEl.value = '';
        cleared = true;
    }
    if (grpEl && grpEl.value && String(item.product_group_id) !== grpEl.value) {
        grpEl.value = '';
        cleared = true;
    }
    if (_soActiveStatusFilter && item.status !== _soActiveStatusFilter) {
        _soActiveStatusFilter = '';
        cleared = true;
    }
    return cleared;
}

function _soAddProductToList(productId) {
    var p = _soProductsMap[productId];
    if (!p) return;

    if (_soStockData.some(function(i) { return i.product_id === productId; })) {
        _soCloseAdd();
        _soShowToast(esc(p.name) + ' står allerede på listen', 'info');
        return;
    }

    var item = _soItemFromProduct(p, null, false);   // isNew: ingen lagerpost i Grocy endnu

    _soStockData.push(item);
    _soStockData.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });

    var cleared = _soClearFiltersHiding(item);
    _soCloseAdd();
    _soApplyFilters();

    // Fold kortet ud med det samme — det er hele grunden til at hente varen frem.
    _soCurrentExpand = null;
    _soToggleExpand(productId);
    var card = _soContainer.querySelector('.so-card[data-id="' + productId + '"]');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center' });

    _soShowToast(esc(item.name) + ': indtast beholdning og tryk Gem' +
        (cleared ? ' (filtre ryddet)' : ''), 'success');
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

// ── Inaktive varer (#615) ──────────────────────────────────

function _soIsActiveProduct(p) {
    if (!p || p.active === undefined || p.active === null) return true;
    return p.active === '1' || p.active === 1 || p.active === true;
}

// Ét sted at bygge et kort-item ud fra et Grocy-produkt (+ evt. lagerpost).
// Bruges af "Tilføj vare", inaktiv-listen og genaktivering, så de tre ikke
// kan drive fra hinanden.
function _soItemFromProduct(p, stockRow, inactive) {
    var amount = stockRow ? (parseFloat(stockRow.amount) || 0) : 0;
    var item = {
        product_id:         parseInt(p.id),
        name:               p.name || 'Ukendt',
        amount:             amount,
        amount_opened:      stockRow ? (parseFloat(stockRow.amount_opened) || 0) : 0,
        qu_id:              p.qu_id_stock,
        qu_name:            _soQUnitsMap[p.qu_id_stock] || '',
        best_before_date:   stockRow ? stockRow.best_before_date : null,
        daysUntilExpiry:    Infinity,
        status:             'low',
        location_id:        p.location_id,
        location_name:      _soLocationsMap[p.location_id] || '',
        product_group_id:   p.product_group_id,
        product_group_name: _soGroupsMap[p.product_group_id] || '',
        min_stock_amount:   parseFloat(p.min_stock_amount) || 0,
        alt_conv:           _soAltConv(p),
        last_checked:       _soLastChecked(p),
        last_checked_unit:  (p.userfields || {}).LastCheckedUnit || null,
        check_interval:     _soCheckInterval(p),
        check:              null,
        isNew:              !stockRow,
        inactive:           !!inactive
    };
    _soRecalcStatus(item);
    _soRecalcCheck(item);
    return item;
}

function _soMoveToActive(id) {
    var idx = _soInactiveItems.findIndex(function(it) { return it.product_id === id; });
    if (idx === -1) return null;
    var item = _soInactiveItems.splice(idx, 1)[0];
    item.inactive = false;
    item.isNew = item.amount <= 0;
    _soRecalcStatus(item);
    if (!_soStockData.some(function(it) { return it.product_id === id; })) {
        _soStockData.push(item);
        _soStockData.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });
    }
    var prod = _soProductsMap[id];
    if (prod) prod.active = '1';
    return item;
}

function _soMoveToInactive(id) {
    var idx = _soStockData.findIndex(function(it) { return it.product_id === id; });
    if (idx === -1) return null;
    var item = _soStockData.splice(idx, 1)[0];
    item.inactive = true;
    if (!_soInactiveItems.some(function(it) { return it.product_id === id; })) {
        _soInactiveItems.push(item);
        _soInactiveItems.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });
    }
    var prod = _soProductsMap[id];
    if (prod) prod.active = '0';
    return item;
}

// "↺ Aktivér": sætter KUN active=1. Lageret røres ikke — det står på 0 efter
// "Varen findes ikke mere", og det er brugerens næste skridt at give det et tal.
async function _soReactivate(id) {
    var item = _soInactiveItems.find(function(it) { return it.product_id === id; });
    if (!item) return;
    if (!confirm('Gør "' + item.name + '" aktiv igen?\n\nVaren kommer tilbage på lageroversigten og i optællingen.')) return;
    try {
        await putGrocyProduct(id, { active: 1 });
    } catch (err) {
        _soShowToast('Kunne ikke aktivere ' + esc(item.name) + ': ' + esc(err.message), 'error');
        return;
    }
    _soMoveToActive(id);
    _soApplyFilters();
    _soShowToast(esc(item.name) + ' er aktiv igen' + (item.amount <= 0 ? ' — står på listen med 0 på lager, klik den for at give den et tal' : ''), 'success');
}

// ── "Sidst tjekket" (#613) ─────────────────────────────────
// Samme regler som optællingen (_icComputeCheckStatus i inventory_check.js):
// forfaldent når dage siden > HverDag, snart ved > 80 %, aldrig tjekket
// tæller som forfaldent hvis varen har et interval. Kopieret frem for delt,
// fordi lageroversigten også skal virke på sider uden inventory_check.js.

var _soSortMode = 'name';

function _soLastChecked(product) {
    var raw = (product && product.userfields || {}).LastCheckedAt;
    if (!raw) return null;
    // Skrives som UTC (toISOString); Grocy kan strippe 'Z' ved returnering.
    var d = (typeof parseServerDate === 'function') ? parseServerDate(raw) : new Date(raw);
    return (d && !isNaN(d.getTime())) ? d : null;
}

function _soCheckInterval(product) {
    var v = (product && product.userfields || {}).HverDag;
    if (v === undefined || v === null || v === '') return null;
    var n = parseInt(v, 10);
    return (isNaN(n) || n <= 0) ? null : n;
}

function _soCheckStatus(intervalDays, lastChecked, now) {
    now = now || new Date();
    if (!lastChecked) {
        return { status: intervalDays ? 'overdue' : 'never', daysSince: null };
    }
    var ds = Math.floor((now - lastChecked) / (1000 * 60 * 60 * 24));
    if (!intervalDays) return { status: 'neutral', daysSince: ds };
    if (ds > intervalDays)          return { status: 'overdue', daysSince: ds };
    if (ds / intervalDays > 0.8)    return { status: 'soon',    daysSince: ds };
    return { status: 'ok', daysSince: ds };
}

function _soRecalcCheck(item) {
    item.check = _soCheckStatus(item.check_interval, item.last_checked);
}

// Pillen "ikke tjekket": aldrig set, eller intervallet er overskredet.
function _soIsUnchecked(item) {
    var c = item.check || _soCheckStatus(item.check_interval, item.last_checked);
    return c.status === 'overdue' || c.status === 'never';
}

function _soFormatSince(date, now) {
    now = now || new Date();
    var ds = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (ds <= 0) return 'i dag';
    if (ds === 1) return 'i går';
    if (ds < 7)   return ds + 'd siden';
    return date.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

function _soRenderCheck(item) {
    var c = item.check || _soCheckStatus(item.check_interval, item.last_checked);
    var cls = 'so-check-' + c.status;
    var text, title;
    if (!item.last_checked) {
        text  = 'aldrig tjekket';
        title = 'Ingen har registreret et tjek på varen endnu';
        if (item.check_interval) title += ' · tjek-interval ' + item.check_interval + ' dage';
    } else {
        var icon = c.status === 'overdue' ? '\u23F0 ' : c.status === 'soon' ? '\u23F3 ' : '\u2713 ';
        text  = icon + _soFormatSince(item.last_checked);
        title = 'Sidst tjekket ' + item.last_checked.toLocaleString('da-DK', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
        if (item.last_checked_unit) title += ' i ' + item.last_checked_unit;
        if (item.check_interval) {
            title += ' · interval ' + item.check_interval + ' dage';
            if (c.status === 'overdue') title += ' · forfaldent (' + c.daysSince + ' dage siden)';
            else if (c.status === 'soon') title += ' · snart forfaldent';
        }
    }
    return '<span class="so-check ' + cls + '" title="' + esc(title) + '">' + esc(text) + '</span>';
}

// Skriver KUN datoen. LastCheckedUnit er optællingens felt: den bruger enheden
// til at afgøre hvilken køl/frys-liste varen hører til, og lageroversigten
// kender ikke den fysiske enhed — kun Grocy-lokationen. Beslutning 14/9-2026.
// Returnerer true hvis stemplet landede; fejl siges højt men kastes ikke.
async function _soStampChecked(item) {
    var stamp = new Date();
    try {
        await putGrocyProductUserfields(item.product_id, { LastCheckedAt: stamp.toISOString() });
    } catch (err) {
        _soShowToast(esc(item.name) + ': gemt, men tjek-stemplet kunne ikke skrives (' + esc(err.message) + ')', 'warn');
        return false;
    }
    item.last_checked = stamp;
    _soRecalcCheck(item);
    var prod = _soProductsMap[item.product_id];
    if (prod) {
        prod.userfields = prod.userfields || {};
        prod.userfields.LastCheckedAt = stamp.toISOString();
    }
    return true;
}

// ── Sortering inden for gruppe ─────────────────────────────
function _soLoadSortMode() {
    try { var v = localStorage.getItem('so_sort_mode'); if (v === 'checked') return v; } catch (e) { /* privat vindue */ }
    return 'name';
}
function _soSetSortMode(mode) {
    _soSortMode = (mode === 'checked') ? 'checked' : 'name';
    try { localStorage.setItem('so_sort_mode', _soSortMode); } catch (e) { /* ignorer */ }
    _soRenderGrid();
}
// Ældst tjekket først: aldrig tjekket øverst, derefter stigende dato; navn som tiebreak.
function _soSortItems(items) {
    var arr = items.slice();
    if (_soSortMode !== 'checked') {
        arr.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });
        return arr;
    }
    arr.sort(function(a, b) {
        var ta = a.last_checked ? a.last_checked.getTime() : -Infinity;
        var tb = b.last_checked ? b.last_checked.getTime() : -Infinity;
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.name.localeCompare(b.name, 'da');
    });
    return arr;
}

function _soRound(num, decimals) {
    if (decimals === undefined) decimals = 2;
    var factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
}

// ── Enhedskonvertering (stock -> salgs-/forbrugsenhed) ──────────
// Samme opslags-mønster som recipe_viewer/recipe_designer: produkt-
// specifik forward/reverse, derefter global forward/reverse.
function _soFindFactor(productId, fromQuId, toQuId) {
    if (String(fromQuId) === String(toQuId)) return 1;
    var convs = _soConversions || [];
    var pf = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (pf) return parseFloat(pf.factor) || null;
    var pr = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (pr) { var f1 = parseFloat(pr.factor); return f1 ? 1 / f1 : null; }
    var gf = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (gf) return parseFloat(gf.factor) || null;
    var gr = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (gr) { var f2 = parseFloat(gr.factor); return f2 ? 1 / f2 : null; }
    return null;
}

// Resolvér salgs-/forbrugsenhed for et produkt -> [{ factor, unit }].
// Faktorer er statiske (afhænger ikke af mængden), så de kan caches på item'et
// og ganges på den friske amount ved hver render.
function _soAltConv(product) {
    if (!product) return [];
    var stockQu = product.qu_id_stock;
    if (!stockQu) return [];

    var targets = [];
    if (product.qu_id_purchase && String(product.qu_id_purchase) !== String(stockQu)) {
        targets.push(product.qu_id_purchase);
    }
    if (product.qu_id_consume &&
        String(product.qu_id_consume) !== String(stockQu) &&
        String(product.qu_id_consume) !== String(product.qu_id_purchase)) {
        targets.push(product.qu_id_consume);
    }

    var out = [];
    targets.forEach(function(tq) {
        var f = _soFindFactor(product.id, stockQu, tq);
        if (f && isFinite(f)) {
            out.push({ factor: f, unit: _soQUnitsMap[tq] || '' });
        }
    });
    return out;
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

// ════════════════════════════════════════════════════════════
// EDIT PRODUCT (stamdata) — enkelt vare + bulk
// ════════════════════════════════════════════════════════════

function _soOpenBulkEdit() {
    var ids = Object.keys(_soSelectedIds).map(function(k) { return parseInt(k); });
    if (ids.length === 0) return;
    _soOpenEdit(ids);
}

function _soOpenEdit(ids) {
    _soEditIds = ids;
    var bulk = ids.length > 1;

    var titleEl = document.getElementById('soEditTitle');
    if (titleEl) {
        titleEl.textContent = bulk
            ? ('Rediger ' + ids.length + ' varer')
            : ('Rediger: ' + ((_soProductsMap[ids[0]] || {}).name || 'vare'));
    }

    var statusEl = document.getElementById('soEditStatus');
    if (statusEl) {
        statusEl.textContent = bulk
            ? 'Kun felter du ændrer skrives til alle valgte varer.'
            : '';
    }

    var body = document.getElementById('soEditBody');
    if (body) body.innerHTML = _soBuildEditForm(ids);

    var saveBtn = _soContainer.querySelector('.so-edit-save');
    if (saveBtn) saveBtn.disabled = false;

    var ov = document.getElementById('soEditOverlay');
    if (ov) ov.classList.add('so-visible');
}

function _soFieldRow(label, controlHtml, hint) {
    return '<div class="so-edit-row">' +
        '<label class="so-edit-label">' + esc(label) + '</label>' +
        '<div class="so-edit-control">' + controlHtml +
        (hint ? '<div class="so-edit-hint">' + esc(hint) + '</div>' : '') +
        '</div>' +
        '</div>';
}

function _soBuildEditForm(ids) {
    var bulk = ids.length > 1;
    var p  = bulk ? {} : (_soProductsMap[ids[0]] || {});
    var uf = (p && p.userfields) || {};

    function selectField(id, label, arr, current, allowNone, noneLabel) {
        var html = bulk ? '<option value="__keep__" selected>— behold —</option>' : '';
        if (allowNone) {
            var noneSel = (!bulk && (current === null || current === undefined || current === '')) ? ' selected' : '';
            html += '<option value=""' + noneSel + '>' + esc(noneLabel || '(ingen)') + '</option>';
        }
        html += (arr || []).map(function(o) {
            var sel = (!bulk && String(current) === String(o.id)) ? ' selected' : '';
            return '<option value="' + o.id + '"' + sel + '>' + esc(o.name) + '</option>';
        }).join('');
        return _soFieldRow(label, '<select class="so-edit-input" id="' + id + '">' + html + '</select>');
    }

    function numField(id, label, val, hint) {
        var v = (val === null || val === undefined || val === '') ? '' : val;
        var ph = bulk ? '— behold —' : '';
        var input = '<input type="number" class="so-edit-input" id="' + id + '" value="' +
            (bulk ? '' : esc(String(v))) + '" placeholder="' + esc(ph) + '" step="1">';
        return _soFieldRow(label, input, hint);
    }

    // Aktiv
    var activeCtrl;
    if (bulk) {
        activeCtrl = '<select class="so-edit-input" id="soEdit_active">' +
            '<option value="__keep__" selected>— behold —</option>' +
            '<option value="1">Aktiv</option>' +
            '<option value="0">Inaktiv</option>' +
            '</select>';
    } else {
        var isActive = (p.active === '1' || p.active === 1 || p.active === true);
        activeCtrl = '<label class="so-edit-check"><input type="checkbox" id="soEdit_active"' +
            (isActive ? ' checked' : '') + '> Aktiv</label>';
    }

    var rows = '';
    rows += _soFieldRow('Aktiv', activeCtrl);
    rows += selectField('soEdit_location_id', 'Standardplacering', _soLocationsArr, p.location_id, false);
    rows += selectField('soEdit_shopping_location_id', 'Standard-butik', _soShopLocsArr, p.shopping_location_id, true, '(ingen)');
    rows += numField('soEdit_dbb', 'Bedst før (dage)', p.default_best_before_days, '-1 = udløber aldrig');
    rows += selectField('soEdit_group', 'Varegruppe', _soGroupsArr, p.product_group_id, true, '(ingen)');
    rows += numField('soEdit_hverdag', 'Tjek-interval (dage)', uf.HverDag, 'Hvor ofte varen skal tælles i optælling. Tom = uændret.');

    return rows;
}

async function _soSaveEdit() {
    var ids = _soEditIds;
    if (!ids || ids.length === 0) return;
    var bulk = ids.length > 1;
    var p  = bulk ? null : (_soProductsMap[ids[0]] || {});
    var uf = (p && p.userfields) || {};

    var master = {};
    var user   = {};

    // Aktiv
    var actEl = document.getElementById('soEdit_active');
    if (actEl) {
        if (bulk) {
            if (actEl.value !== '__keep__') master.active = (actEl.value === '1') ? 1 : 0;
        } else {
            var curActive = (p.active === '1' || p.active === 1 || p.active === true) ? 1 : 0;
            var newActive = actEl.checked ? 1 : 0;
            if (newActive !== curActive) master.active = newActive;
        }
    }

    function readSelect(id, key, current) {
        var el = document.getElementById(id);
        if (!el) return;
        var v = el.value;
        if (bulk) {
            if (v === '__keep__') return;
            master[key] = (v === '') ? null : v;
            return;
        }
        var cur = (current === null || current === undefined || current === '') ? '' : String(current);
        if (v === cur) return;               // uaendret
        master[key] = (v === '') ? null : v;
    }
    readSelect('soEdit_location_id', 'location_id', p ? p.location_id : null);
    readSelect('soEdit_shopping_location_id', 'shopping_location_id', p ? p.shopping_location_id : null);
    readSelect('soEdit_group', 'product_group_id', p ? p.product_group_id : null);

    function readNum(id, bag, key, current) {
        var el = document.getElementById(id);
        if (!el) return;
        var raw = (el.value || '').trim();
        if (raw === '') return;              // tom = ingen aendring
        var n = Number(raw);
        if (!isFinite(n)) return;
        if (!bulk && current !== null && current !== undefined && current !== '' && Number(current) === n) return;
        bag[key] = n;
    }
    readNum('soEdit_dbb', master, 'default_best_before_days', p ? p.default_best_before_days : null);
    readNum('soEdit_hverdag', user, 'HverDag', uf.HverDag);

    var mKeys = Object.keys(master);
    var uKeys = Object.keys(user);
    if (mKeys.length === 0 && uKeys.length === 0) {
        _soShowToast('Ingen ændringer', 'info');
        return;
    }

    var saveBtn  = _soContainer.querySelector('.so-edit-save');
    var statusEl = document.getElementById('soEditStatus');
    if (saveBtn) saveBtn.disabled = true;

    var success = 0, failed = 0;
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (statusEl) statusEl.textContent = 'Gemmer ' + (i + 1) + '/' + ids.length + '...';
        try {
            if (mKeys.length) await putGrocyProduct(id, master);
            if (uKeys.length) await putGrocyProductUserfields(id, user);
            _soApplyEditToLocal(id, master, user);
            success++;
        } catch (err) {
            console.error('[stock_overview] redigering fejlede for ' + id + ':', err);
            failed++;
        }
    }

    _soCloseEdit();

    if (failed === 0) {
        _soShowToast(bulk ? (success + ' varer opdateret') : 'Vare opdateret', 'success');
    } else {
        _soShowToast(success + ' opdateret, ' + failed + ' fejlede', failed === ids.length ? 'error' : 'warn');
    }

    if (bulk) _soClearSelection();
    _soApplyFilters();
}

function _soApplyEditToLocal(id, master, user) {
    var prod = _soProductsMap[id];
    if (prod) {
        for (var k in master) {
            if (master.hasOwnProperty(k)) prod[k] = master[k];
        }
        if (user && Object.keys(user).length) {
            prod.userfields = prod.userfields || {};
            for (var u in user) {
                if (user.hasOwnProperty(u)) prod.userfields[u] = user[u];
            }
        }
    }

    // Aktiv-flaget flytter varen mellem de to lister (#615) — begge veje.
    if (master.hasOwnProperty('active')) {
        if (master.active === 0 || master.active === '0') { _soMoveToInactive(id); return; }
        _soMoveToActive(id);
    }

    var item = _soStockData.find(function(it) { return it.product_id === id; });
    if (!item) return;
    if (master.hasOwnProperty('location_id')) {
        item.location_id   = master.location_id;
        item.location_name = _soLocationsMap[master.location_id] || '';
    }
    if (master.hasOwnProperty('product_group_id')) {
        item.product_group_id   = master.product_group_id;
        item.product_group_name = _soGroupsMap[master.product_group_id] || '';
    }
}

function _soCloseEdit() {
    var ov = document.getElementById('soEditOverlay');
    if (ov) ov.classList.remove('so-visible');
    _soEditIds = [];
    var statusEl = document.getElementById('soEditStatus');
    if (statusEl) statusEl.textContent = '';
}

// CommonJS export guard — exposes pure functions to Node-based tests (T_STOCK).
// Browser ignores this block since `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _soRecalcStatus: _soRecalcStatus,
        _soCheckStatus:  _soCheckStatus,
        _soFormatSince:  _soFormatSince,
        _soIsUnchecked:  _soIsUnchecked,
        _soSortItems:    _soSortItems,
        _soClearAllFilters: _soClearAllFilters,
        _soHasAnyFilter:    _soHasAnyFilter,
        _soItemFromProduct: _soItemFromProduct,
        _soMoveToActive:    _soMoveToActive,
        _soMoveToInactive:  _soMoveToInactive
    };
}
