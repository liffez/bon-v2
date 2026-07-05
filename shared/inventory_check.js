/**
 * shared/inventory_check.js
 * ════════════════════════════════════════════════════════════
 * Inventory Check (Lagercheck) component for Bon v2.
 * Physical counting tool with multi-unit tracking,
 * smart sorting, progress persistence and summary modal.
 *
 * Ported from bontools/tools/grocy/inventory-check.html.
 * Adapted to bon-v2 architecture: MPA, vanilla JS,
 * API via shared/api.js, design tokens from tokens.css.
 *
 * Export: initInventoryCheck(containerEl)
 * ════════════════════════════════════════════════════════════
 */

/* global fetchGrocyStock, fetchGrocyProducts, fetchGrocyQuantityUnits,
          fetchGrocyLocations, fetchGrocyQuantityUnitConversions,
          postGrocyInventory, putGrocyProductUserfields,
          postGrocyShoppingList, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

var _ic = {
    locationId:    null,
    locationName:  '',
    physicalUnit:  '',

    locations:     [],          // Grocy locations
    quantityUnits: {},          // qu_id -> name
    conversions:   [],          // quantity_unit_conversions (salgs-/forbrugsenhed-visning)
    allProducts:   [],          // ALL products (for "add unexpected")
    productsById:  {},          // id -> fuldt produkt (kort får kun et udsnit)
    products:      [],          // Products for current location
    grocyStock:    {},          // productId -> { amount, unit, bestBefore }
    counts:        {},          // productId -> { units: { unitName: amount }, total }
    skipped:       [],          // productIds skipped in current unit (array)
    priorities:    {},          // productId -> "high"|"low"
    physicalUnits: {},          // locationId -> [{ id, name, sort_order, archived_at }] fra server
    searchQuery:   '',          // fritekst-filter på varenavn i optællings-listen

    isChecking:    false,
    _sse:          null         // dedikeret EventSource til live-sync af enheder
};

var _icContainer = null;       // root DOM element

// ════════════════════════════════════════════════════════════
// PUBLIC: initInventoryCheck
// ════════════════════════════════════════════════════════════

function initInventoryCheck(containerEl) {
    _icContainer = containerEl;
    _icContainer.innerHTML = '<div class="ic-loading"><div class="ic-spinner"></div><p>Henter lokationer...</p></div>';
    _icLoadInitial();
}

// ════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════

async function _icLoadInitial() {
    try {
        var results = await Promise.all([
            fetchGrocyLocations(),
            fetchGrocyQuantityUnits()
        ]);

        _ic.locations = results[0];

        // Build quantity units map
        _ic.quantityUnits = {};
        results[1].forEach(function(qu) {
            _ic.quantityUnits[qu.id] = qu.name;
        });

        // Load priorities (stadig localStorage — per-device valgte prioriteter)
        _icLoadPriorities();

        // Render setup view
        _icRenderSetup();

        // Live-sync: lyt efter enheder tilføjet/ændret på andre devices
        _icInitSSE();

    } catch (err) {
        _icContainer.innerHTML = '<div class="ic-empty"><h3>Fejl ved indlæsning</h3><p>' + esc(err.message) + '</p></div>';
    }
}

// ════════════════════════════════════════════════════════════
// PHYSICAL UNITS PERSISTENCE (server via /api/physical-units)
// ════════════════════════════════════════════════════════════

async function _icLoadPhysicalUnitsForLocation(locationId) {
    try {
        var units = await fetchPhysicalUnits(locationId, false);
        _ic.physicalUnits[locationId] = units || [];

        // One-time migration: hvis serveren er tom OG localStorage har enheder for
        // denne lokation, upload dem. Flag per device+lokation.
        if (_ic.physicalUnits[locationId].length === 0) {
            await _icMigrateLocalStorageUnits(locationId);
        }
    } catch (e) {
        _ic.physicalUnits[locationId] = [];
    }
}

async function _icMigrateLocalStorageUnits(locationId) {
    var migratedKey = 'ic_migrated_loc_' + locationId;
    if (localStorage.getItem(migratedKey)) return;

    try {
        var stored = localStorage.getItem('ic_physical_units');
        if (!stored) { localStorage.setItem(migratedKey, '1'); return; }

        var map = JSON.parse(stored);
        var names = map[locationId] || [];
        if (!names.length) { localStorage.setItem(migratedKey, '1'); return; }

        for (var i = 0; i < names.length; i++) {
            try {
                await createPhysicalUnit(locationId, names[i], i);
            } catch (err) { /* konflikt/duplikat — ignorér */ }
        }

        var refreshed = await fetchPhysicalUnits(locationId, false);
        _ic.physicalUnits[locationId] = refreshed || [];
        localStorage.setItem(migratedKey, '1');
        if (refreshed && refreshed.length) {
            _icAlert('Importerede ' + refreshed.length + ' enheder fra lokal cache', 'success');
        }
    } catch (e) {
        // Migrationsfejl skal ikke blokere — bare log og gå videre
        console.error('[inventory_check] Migration af enheder fejlede:', e);
    }
}

function _icGetUnitsForLocation(locationId) {
    var arr = _ic.physicalUnits[locationId] || [];
    return arr.map(function(u) { return u.name; });
}

function _icGetUnitIdByName(locationId, name) {
    var arr = _ic.physicalUnits[locationId] || [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) return arr[i].id;
    }
    return null;
}

async function _icAddUnit(locationId, unitName) {
    var unit = await createPhysicalUnit(locationId, unitName);
    if (!_ic.physicalUnits[locationId]) _ic.physicalUnits[locationId] = [];
    // Undgå duplikat hvis reaktivering returnerede eksisterende
    var exists = _ic.physicalUnits[locationId].some(function(u) { return u.id === unit.id; });
    if (!exists) _ic.physicalUnits[locationId].push(unit);
}

async function _icRemoveUnit(locationId, unitName) {
    var id = _icGetUnitIdByName(locationId, unitName);
    if (!id) return;
    await updatePhysicalUnit(id, { archived: true });
    if (_ic.physicalUnits[locationId]) {
        _ic.physicalUnits[locationId] = _ic.physicalUnits[locationId].filter(function(u) { return u.id !== id; });
    }
}

// ════════════════════════════════════════════════════════════
// LIVE-SYNC (SSE) — enheder tilføjet/ændret på andre devices
// ════════════════════════════════════════════════════════════

function _icInitSSE() {
    // Kun én forbindelse pr. side — _ic er modul-global, så den overlever re-mount
    if (_ic._sse || typeof EventSource === 'undefined') return;
    try {
        var es = new EventSource('/api/sse');
        es.addEventListener('physical_unit_changed', function(e) {
            try { _icOnPhysicalUnitChanged(JSON.parse(e.data)); }
            catch (err) { /* stille */ }
        });
        _ic._sse = es;
    } catch (e) {
        // SSE ikke tilgængelig — degradér stille (listen virker stadig ved genvalg/reload)
    }
}

function _icOnPhysicalUnitChanged(data) {
    // Ignorér hvis ingen lokation er valgt, eller eventet gælder en anden lokation
    if (!_ic.locationId) return;
    if (Number(data.grocy_location_id) !== Number(_ic.locationId)) return;
    _icRefreshUnitsLive();
}

async function _icRefreshUnitsLive() {
    var prevSelection = _ic.physicalUnit;
    try {
        var units = await fetchPhysicalUnits(_ic.locationId, false);
        _ic.physicalUnits[_ic.locationId] = units || [];
    } catch (e) {
        return;  // netværksfejl — behold den nuværende liste
    }

    _icUpdateUnitsDropdown();   // genbygger dropdown (nulstiller valg)
    _icUpdateUnitsConfig();     // genbygger enheds-tags

    // Gendan brugerens valg hvis enheden stadig findes
    var names    = _icGetUnitsForLocation(_ic.locationId);
    var sel      = _icContainer.querySelector('#icUnitSelect');
    var startBtn = _icContainer.querySelector('#icStartBtn');
    if (prevSelection && names.indexOf(prevSelection) !== -1) {
        _ic.physicalUnit = prevSelection;
        if (sel) sel.value = prevSelection;
        if (startBtn) startBtn.disabled = false;
    } else if (prevSelection) {
        // Den valgte enhed blev fjernet et andet sted
        _ic.physicalUnit = '';
        if (sel) sel.value = '';
        if (startBtn) startBtn.disabled = true;
    }
}

// ════════════════════════════════════════════════════════════
// COUNTING STATE PERSISTENCE (localStorage)
// ════════════════════════════════════════════════════════════

function _icSessionKey() {
    var today = new Date().toISOString().split('T')[0];
    return 'ic_counts_' + _ic.locationId + '_' + today;
}

function _icLoadCounts() {
    try {
        var stored = localStorage.getItem(_icSessionKey());
        if (stored) {
            var data = JSON.parse(stored);
            _ic.counts = data.counts || {};
        } else {
            _ic.counts = {};
        }
    } catch (e) {
        _ic.counts = {};
    }
}

function _icSaveCounts() {
    localStorage.setItem(_icSessionKey(), JSON.stringify({ counts: _ic.counts }));
}

function _icClearCounts() {
    localStorage.removeItem(_icSessionKey());
    _ic.counts = {};
}

// ════════════════════════════════════════════════════════════
// SKIP STATE PERSISTENCE (sessionStorage per unit)
// ════════════════════════════════════════════════════════════

function _icSkipKey() {
    return 'ic_skip_' + _ic.locationId + '_' + _ic.physicalUnit;
}

function _icLoadSkipped() {
    try {
        _ic.skipped = JSON.parse(sessionStorage.getItem(_icSkipKey()) || '[]');
    } catch (e) {
        _ic.skipped = [];
    }
}

function _icSaveSkipped() {
    sessionStorage.setItem(_icSkipKey(), JSON.stringify(_ic.skipped));
}

// ════════════════════════════════════════════════════════════
// PRIORITIES PERSISTENCE (localStorage)
// ════════════════════════════════════════════════════════════

function _icLoadPriorities() {
    try {
        var stored = localStorage.getItem('ic_priorities');
        _ic.priorities = stored ? JSON.parse(stored) : {};
    } catch (e) {
        _ic.priorities = {};
    }
}

function _icSavePriorities() {
    localStorage.setItem('ic_priorities', JSON.stringify(_ic.priorities));
}

// ════════════════════════════════════════════════════════════
// ALERT TOAST
// ════════════════════════════════════════════════════════════

function _icAlert(message, type) {
    type = type || 'info';
    var box = _icContainer.querySelector('.ic-alert-box');
    if (!box) return;

    var el = document.createElement('div');
    el.className = 'ic-alert ic-alert-' + type;
    el.textContent = message;
    box.appendChild(el);

    setTimeout(function() {
        el.style.opacity = '0';
        setTimeout(function() { el.remove(); }, 500);
    }, 4000);
}

// ════════════════════════════════════════════════════════════
// RENDER: SETUP VIEW
// ════════════════════════════════════════════════════════════

function _icRenderSetup() {
    var locOptions = '<option value="">-- Vaelg lokation --</option>';
    _ic.locations.forEach(function(loc) {
        locOptions += '<option value="' + loc.id + '">' + esc(loc.name) + '</option>';
    });

    _icContainer.innerHTML =
        '<div class="ic-alert-box"></div>' +

        '<div class="ic-location-bar">' +
            '<div class="ic-form-group">' +
                '<label>Lokation</label>' +
                '<select id="icLocSelect">' + locOptions + '</select>' +
            '</div>' +
            '<div class="ic-form-group">' +
                '<label>Fysisk enhed</label>' +
                '<select id="icUnitSelect"><option value="">-- Vaelg lokation foerst --</option></select>' +
            '</div>' +
            '<div class="ic-bar-actions">' +
                '<button class="ic-btn ic-btn-primary" id="icStartBtn" disabled>Start</button>' +
                '<button class="ic-btn ic-btn-config" id="icConfigBtn">Enheder</button>' +
            '</div>' +
        '</div>' +

        '<div class="ic-units-config" id="icUnitsConfig">' +
            '<h4>Fysiske enheder for <span id="icConfigLocName">-</span></h4>' +
            '<div class="ic-unit-tags" id="icUnitTags"></div>' +
            '<div class="ic-add-unit-row">' +
                '<input type="text" id="icNewUnitInput" placeholder="Ny enhed (fx KOL-2, FRYS-1)">' +
                '<button class="ic-btn-primary" id="icAddUnitBtn">+ Tilfoej</button>' +
            '</div>' +
        '</div>' +

        '<div id="icProgressSection" style="display:none;"></div>' +

        '<div class="ic-product-list" id="icProductArea">' +
            '<div class="ic-empty" id="icEmptyState">' +
                '<h3>Vaelg lokation og fysisk enhed for at starte</h3>' +
                '<p>Tael maengder i hver fysisk enhed - systemet tracker paa tvaers.</p>' +
            '</div>' +
            '<div class="ic-loading" id="icLoadingState" style="display:none;">' +
                '<div class="ic-spinner"></div><p>Henter produkter...</p>' +
            '</div>' +
            '<div id="icProductList" style="display:none;">' +
                '<div id="icUncheckedList"></div>' +
                '<div class="ic-checked-section" id="icCheckedSection" style="display:none;">' +
                    '<button class="ic-checked-toggle" id="icCheckedToggle">' +
                        '<span id="icCheckedIcon">&#9654;</span> ' +
                        'Tjekket i <span id="icCurrentUnit">denne enhed</span>: <strong id="icCheckedCount">0</strong>' +
                    '</button>' +
                    '<div class="ic-checked-list" id="icCheckedList"></div>' +
                '</div>' +
            '</div>' +
        '</div>' +

        // Summary overlay
        '<div class="ic-overlay" id="icSummaryOverlay">' +
            '<div class="ic-modal">' +
                '<div class="ic-modal-header">' +
                    '<h2>Optaelling afsluttet</h2>' +
                    '<p id="icSummaryLoc"></p>' +
                '</div>' +
                '<div class="ic-modal-body" id="icSummaryBody"></div>' +
                '<div class="ic-modal-footer">' +
                    '<button class="ic-btn-close" id="icSummaryClose">Luk</button>' +
                    '<button class="ic-btn-shopping" id="icSummaryShop">Tilfoej manglende til indkoeb</button>' +
                    '<button class="ic-btn-save-all" id="icSummarySave">Gem alle aendringer</button>' +
                '</div>' +
            '</div>' +
        '</div>' +

        // Add product overlay
        '<div class="ic-overlay" id="icAddOverlay">' +
            '<div class="ic-modal" style="max-width:500px;">' +
                '<div class="ic-modal-header">' +
                    '<h2>Tilfoej vare</h2>' +
                    '<p>Fandt en vare der ikke var paa listen?</p>' +
                '</div>' +
                '<div class="ic-modal-body">' +
                    '<input type="text" class="ic-add-search" id="icAddSearch" placeholder="Skriv for at soege...">' +
                    '<div id="icAddList" style="max-height:300px;overflow-y:auto;"></div>' +
                '</div>' +
                '<div class="ic-modal-footer">' +
                    '<button class="ic-btn-close" id="icAddClose">Annuller</button>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Wire up events
    _icContainer.querySelector('#icLocSelect').addEventListener('change', _icOnLocationChange);
    _icContainer.querySelector('#icUnitSelect').addEventListener('change', _icOnUnitChange);
    _icContainer.querySelector('#icStartBtn').addEventListener('click', _icStartCheck);
    _icContainer.querySelector('#icConfigBtn').addEventListener('click', _icToggleConfig);
    _icContainer.querySelector('#icAddUnitBtn').addEventListener('click', _icDoAddUnit);
    _icContainer.querySelector('#icNewUnitInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') _icDoAddUnit();
    });
    _icContainer.querySelector('#icCheckedToggle').addEventListener('click', _icToggleCheckedList);
    _icContainer.querySelector('#icSummaryClose').addEventListener('click', _icCloseSummary);
    _icContainer.querySelector('#icSummarySave').addEventListener('click', _icSaveAllToGrocy);
    _icContainer.querySelector('#icSummaryShop').addEventListener('click', _icAddAllToShopping);
    _icContainer.querySelector('#icAddClose').addEventListener('click', _icCloseAddProduct);
    _icContainer.querySelector('#icAddSearch').addEventListener('input', _icFilterAddProducts);
}

// ════════════════════════════════════════════════════════════
// EVENT HANDLERS: LOCATION & UNIT SELECT
// ════════════════════════════════════════════════════════════

async function _icOnLocationChange() {
    var sel = _icContainer.querySelector('#icLocSelect');
    var locId = sel.value;

    if (!locId) {
        _icContainer.querySelector('#icUnitSelect').innerHTML = '<option value="">-- Vaelg lokation foerst --</option>';
        _icContainer.querySelector('#icStartBtn').disabled = true;
        return;
    }

    _ic.locationId = parseInt(locId);
    _ic.locationName = sel.options[sel.selectedIndex].text;

    // Vis "henter"-state mens enheder loades fra server
    _icContainer.querySelector('#icUnitSelect').innerHTML = '<option value="">-- Henter enheder... --</option>';
    _icContainer.querySelector('#icStartBtn').disabled = true;

    await _icLoadPhysicalUnitsForLocation(_ic.locationId);

    _icUpdateUnitsDropdown();
    _icUpdateUnitsConfig();
    _icResetUI();
    _icLoadCounts();
}

function _icOnUnitChange() {
    _ic.physicalUnit = _icContainer.querySelector('#icUnitSelect').value;
    _icContainer.querySelector('#icStartBtn').disabled = !_ic.physicalUnit;

    // Load skipped state for this unit
    _icLoadSkipped();
}

function _icResetUI() {
    _ic.isChecking = false;
    var prog = _icContainer.querySelector('#icProgressSection');
    if (prog) prog.style.display = 'none';
    var list = _icContainer.querySelector('#icProductList');
    if (list) list.style.display = 'none';
    var empty = _icContainer.querySelector('#icEmptyState');
    if (empty) empty.style.display = 'block';
}

// ════════════════════════════════════════════════════════════
// UNITS CONFIG
// ════════════════════════════════════════════════════════════

function _icToggleConfig() {
    _icContainer.querySelector('#icUnitsConfig').classList.toggle('ic-visible');
}

function _icUpdateUnitsConfig() {
    var nameEl = _icContainer.querySelector('#icConfigLocName');
    if (nameEl) nameEl.textContent = _ic.locationName || '-';

    var tagsEl = _icContainer.querySelector('#icUnitTags');
    var units = _icGetUnitsForLocation(_ic.locationId);

    if (units.length === 0) {
        tagsEl.innerHTML = '<span style="color:var(--color-text-dim);font-size:13px;">Ingen enheder. Tilfoej fx "KOL-1", "FRYS-1"</span>';
    } else {
        tagsEl.innerHTML = '';
        units.forEach(function(unit) {
            var tag = document.createElement('span');
            tag.className = 'ic-unit-tag';
            tag.innerHTML = esc(unit) + ' <button class="ic-remove">&times;</button>';
            tag.querySelector('.ic-remove').addEventListener('click', function() {
                _icDoRemoveUnit(unit);
            });
            tagsEl.appendChild(tag);
        });
    }
}

function _icUpdateUnitsDropdown() {
    var unitSel = _icContainer.querySelector('#icUnitSelect');
    var units = _icGetUnitsForLocation(_ic.locationId);

    if (units.length === 0) {
        unitSel.innerHTML = '<option value="">-- Tilfoej enheder foerst --</option>';
        _icContainer.querySelector('#icStartBtn').disabled = true;
    } else {
        var html = '<option value="">-- Vaelg enhed --</option>';
        units.forEach(function(u) {
            html += '<option value="' + esc(u) + '">' + esc(u) + '</option>';
        });
        unitSel.innerHTML = html;
    }
}

async function _icDoAddUnit() {
    var input = _icContainer.querySelector('#icNewUnitInput');
    var name = input.value.trim();
    if (!name || !_ic.locationId) return;

    try {
        await _icAddUnit(_ic.locationId, name);
        input.value = '';
        _icUpdateUnitsConfig();
        _icUpdateUnitsDropdown();
        _icAlert('Tilfojet: ' + name, 'success');
    } catch (e) {
        _icAlert('Kunne ikke tilfoeje: ' + (e.message || 'ukendt fejl'), 'error');
    }
}

async function _icDoRemoveUnit(unitName) {
    if (!_ic.locationId) return;
    try {
        await _icRemoveUnit(_ic.locationId, unitName);
        _icUpdateUnitsConfig();
        _icUpdateUnitsDropdown();

        if (_ic.physicalUnit === unitName) {
            _ic.physicalUnit = '';
            _icContainer.querySelector('#icUnitSelect').value = '';
            _icContainer.querySelector('#icStartBtn').disabled = true;
        }
    } catch (e) {
        _icAlert('Kunne ikke fjerne: ' + (e.message || 'ukendt fejl'), 'error');
    }
}

// ════════════════════════════════════════════════════════════
// START CHECK — load products + stock
// ════════════════════════════════════════════════════════════

async function _icStartCheck() {
    if (!_ic.locationId || !_ic.physicalUnit) {
        _icAlert('Vaelg baade lokation og fysisk enhed', 'warning');
        return;
    }

    _ic.isChecking = true;
    _ic.searchQuery = '';

    var emptyEl = _icContainer.querySelector('#icEmptyState');
    if (emptyEl) emptyEl.style.display = 'none';

    // Show progress
    _icRenderProgress();

    var loadEl = _icContainer.querySelector('#icLoadingState');
    if (loadEl) loadEl.style.display = 'block';

    try {
        var results = await Promise.all([
            fetchGrocyProducts(),
            fetchGrocyStock(),
            fetchGrocyQuantityUnitConversions().catch(function() { return []; })
        ]);

        var allProducts = results[0];
        var stockData   = results[1];
        _ic.conversions = results[2] || [];

        // Store all active products for "add unexpected"
        _ic.allProducts = allProducts.filter(function(p) {
            return p.active === '1' || p.active === 1 || p.active === true;
        });

        // Id -> fuldt produkt. _icCreateCard får kun et kategoriseret udsnit
        // (uden qu_id_*-felter), så enhed + salgs-/forbrugsenhed slås op her.
        _ic.productsById = {};
        _ic.allProducts.forEach(function(p) { _ic.productsById[p.id] = p; });

        // Filter products belonging to this location
        _ic.products = _ic.allProducts.filter(function(p) {
            var locId = parseInt(p.location_id) || 0;
            var consumeLocId = parseInt(p.default_consume_location_id) || 0;
            return locId === _ic.locationId || consumeLocId === _ic.locationId;
        });

        // Build stock map
        _ic.grocyStock = {};
        stockData.forEach(function(item) {
            var quId = null;
            if (item.quantity_unit_stock && item.quantity_unit_stock.id) {
                quId = item.quantity_unit_stock.id;
            } else if (item.product && item.product.qu_id_stock) {
                quId = item.product.qu_id_stock;
            } else if (item.qu_id) {
                quId = item.qu_id;
            }

            // Find unit name from product data if not on stock
            var unitName = '';
            if (item.quantity_unit_stock && item.quantity_unit_stock.name) {
                unitName = item.quantity_unit_stock.name;
            } else if (quId && _ic.quantityUnits[quId]) {
                unitName = _ic.quantityUnits[quId];
            }

            // Try to get unit from product qu_id_stock
            if (!unitName) {
                var prod = _ic.allProducts.find(function(p) { return p.id == item.product_id; });
                if (prod && prod.qu_id_stock && _ic.quantityUnits[prod.qu_id_stock]) {
                    unitName = _ic.quantityUnits[prod.qu_id_stock];
                }
            }

            _ic.grocyStock[item.product_id] = {
                amount:     parseFloat(item.amount) || 0,
                unit:       unitName,
                bestBefore: item.best_before_date || null
            };
        });

        // Load counting state
        _icLoadCounts();
        _icLoadSkipped();

        if (loadEl) loadEl.style.display = 'none';
        var listEl = _icContainer.querySelector('#icProductList');
        if (listEl) listEl.style.display = 'block';

        _icRenderProducts();
        _icUpdateProgress();

    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
        if (loadEl) loadEl.style.display = 'none';
        _icResetUI();
    }
}

// ════════════════════════════════════════════════════════════
// SWITCH TO NEXT UNIT
// ════════════════════════════════════════════════════════════

function _icSwitchUnit() {
    // Save current skip state
    _icSaveSkipped();

    var units = _icGetUnitsForLocation(_ic.locationId);
    var idx = units.indexOf(_ic.physicalUnit);
    var nextIdx = (idx + 1) % units.length;

    _ic.physicalUnit = units[nextIdx];
    _icContainer.querySelector('#icUnitSelect').value = _ic.physicalUnit;

    _icLoadSkipped();
    _icRenderProducts();
    _icUpdateProgress();
    _icUpdateProgressLabels();
    _icAlert('Skiftet til: ' + _ic.physicalUnit, 'info');
}

// ════════════════════════════════════════════════════════════
// CATEGORIZE PRODUCTS (sort logic)
// ════════════════════════════════════════════════════════════

/**
 * Parse HverDag userfield — interval in days between checks.
 * Returns positive number or null if not set / invalid.
 */
function _icParseIntervalDays(uf) {
    if (!uf) return null;
    var v = uf.HverDag;
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * Compute check-status based on HverDag interval and LastCheckedAt.
 * Returns { status: 'overdue'|'soon'|'ok'|'neutral', ratio, daysSince }
 */
function _icComputeCheckStatus(intervalDays, lastChecked, now) {
    if (!intervalDays) {
        return { status: 'neutral', ratio: 0, daysSince: null };
    }
    if (!lastChecked) {
        return { status: 'overdue', ratio: Infinity, daysSince: Infinity };
    }
    var ds = Math.floor((now - lastChecked) / (1000 * 60 * 60 * 24));
    var ratio = ds / intervalDays;
    if (ds > intervalDays) return { status: 'overdue', ratio: ratio, daysSince: ds };
    if (ratio > 0.8)       return { status: 'soon',    ratio: ratio, daysSince: ds };
    return { status: 'ok', ratio: ratio, daysSince: ds };
}

function _icCategorize() {
    var now = new Date();
    var unchecked = [];
    var checkedInUnit = [];

    _ic.products.forEach(function(product) {
        var uf = product.userfields || {};
        // LastCheckedAt skrives som UTC (toISOString); Grocy kan strippe 'Z' ved
    // returnering — parseServerDate genskaber UTC-tolkningen begge veje.
    var lastChecked = uf.LastCheckedAt ? ((typeof parseServerDate === 'function') ? parseServerDate(uf.LastCheckedAt) : new Date(uf.LastCheckedAt)) : null;
        var lastCheckedUnit = uf.LastCheckedUnit || null;
        var intervalDays = _icParseIntervalDays(uf);
        var checkStatus = _icComputeCheckStatus(intervalDays, lastChecked, now);

        var countData = _ic.counts[product.id];
        var countedInThisUnit = countData && countData.units && countData.units[_ic.physicalUnit] !== undefined;
        var skippedInThisUnit = _ic.skipped.indexOf(product.id) !== -1;

        if (countedInThisUnit) {
            checkedInUnit.push({
                id:            product.id,
                name:          product.name,
                userfields:    product.userfields,
                status:        'checked',
                countedAmount: _icRound(countData.units[_ic.physicalUnit]),
                totalCounted:  _icRound(countData.total)
            });
            return;
        }

        if (skippedInThisUnit) return;

        var stockInfo    = _ic.grocyStock[product.id];
        var grocyAmount  = _icRound(stockInfo ? stockInfo.amount : 0);
        var countedTotal = _icRound(countData ? (countData.total || 0) : 0);
        var remaining    = _icRound(grocyAmount - countedTotal);

        var daysUntilExpiry = Infinity;
        if (stockInfo && stockInfo.bestBefore && stockInfo.bestBefore !== '2999-12-31') {
            var expiry = new Date(stockInfo.bestBefore);
            daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        }

        // checkedTodayHere: true if checked today in this specific physical unit
        var todayStr = now.toISOString().slice(0, 10);
        var lastStr = lastChecked ? lastChecked.toISOString().slice(0, 10) : null;
        var checkedTodayHere = lastStr === todayStr && lastCheckedUnit === _ic.physicalUnit;

        unchecked.push({
            id:               product.id,
            name:             product.name,
            userfields:       product.userfields,
            location_id:      product.location_id,
            lastChecked:      lastChecked,
            lastCheckedUnit:  lastCheckedUnit,
            intervalDays:     intervalDays,
            checkStatus:      checkStatus,
            checkedTodayHere: checkedTodayHere,
            daysUntilExpiry:  daysUntilExpiry,
            grocyAmount:      grocyAmount,
            countedTotal:     countedTotal,
            remaining:        remaining
        });
    });

    // Sort: priority -> check-status (overdue/soon) -> expiry urgency -> never-checked -> oldest-checked -> alpha
    var prioOrder = { high: 0, normal: 1, low: 2 };
    var statusOrder = { overdue: 0, soon: 1, ok: 2, neutral: 3 };

    unchecked.sort(function(a, b) {
        // 1. Manual priority
        var aPrio = prioOrder[_ic.priorities[a.id] || 'normal'];
        var bPrio = prioOrder[_ic.priorities[b.id] || 'normal'];
        if (aPrio !== bPrio) return aPrio - bPrio;

        // 2. Check-status from HverDag (overdue first, then soon)
        var aCS = statusOrder[a.checkStatus.status];
        var bCS = statusOrder[b.checkStatus.status];
        if (aCS !== bCS) return aCS - bCS;

        // 3. Within same check-status: higher ratio = more urgent
        var aRatio = a.checkStatus.ratio === Infinity ? 9999 : (a.checkStatus.ratio || 0);
        var bRatio = b.checkStatus.ratio === Infinity ? 9999 : (b.checkStatus.ratio || 0);
        if (aRatio !== bRatio) return bRatio - aRatio;

        // 4. Expiry urgency
        var aUrgent = a.daysUntilExpiry <= 3;
        var bUrgent = b.daysUntilExpiry <= 3;
        if (aUrgent && !bUrgent) return -1;
        if (!aUrgent && bUrgent) return 1;
        if (aUrgent && bUrgent) return a.daysUntilExpiry - b.daysUntilExpiry;

        // 5. Never checked first
        if (!a.lastChecked && !b.lastChecked) return a.name.localeCompare(b.name, 'da');
        if (!a.lastChecked) return -1;
        if (!b.lastChecked) return 1;

        // 6. Oldest checked first
        return a.lastChecked - b.lastChecked;
    });

    return { unchecked: unchecked, checkedInUnit: checkedInUnit };
}

// ════════════════════════════════════════════════════════════
// RENDER: PROGRESS BAR
// ════════════════════════════════════════════════════════════

function _icRenderProgress() {
    var sec = _icContainer.querySelector('#icProgressSection');
    sec.style.display = 'block';
    sec.innerHTML =
        '<div class="ic-progress">' +
            '<div class="ic-progress-header">' +
                '<span class="ic-progress-location" id="icProgLoc">' + esc(_ic.locationName) + '</span>' +
                '<span class="ic-progress-unit" id="icProgUnit">' + esc(_ic.physicalUnit) + '</span>' +
            '</div>' +
            '<div class="ic-progress-track"><div class="ic-progress-bar" id="icProgBar"></div></div>' +
            '<div class="ic-progress-text" id="icProgText">0 / 0 tjekket</div>' +
            '<div class="ic-progress-actions">' +
                '<button class="ic-btn-secondary" id="icBtnNextUnit">Naeste enhed</button>' +
                '<button class="ic-btn-secondary" id="icBtnAddProduct">Tilfoej vare</button>' +
                '<button class="ic-btn-finish" id="icBtnFinish">Afslut optaelling</button>' +
            '</div>' +
            '<div class="ic-search-row">' +
                '<input type="text" class="ic-search" id="icSearch" placeholder="Soeg vare i listen...">' +
                '<button class="ic-search-clear" id="icSearchClear" title="Ryd" style="display:none;">&times;</button>' +
            '</div>' +
        '</div>';

    sec.querySelector('#icBtnNextUnit').addEventListener('click', _icSwitchUnit);
    sec.querySelector('#icBtnAddProduct').addEventListener('click', _icShowAddProduct);
    sec.querySelector('#icBtnFinish').addEventListener('click', _icShowSummary);

    var searchEl = sec.querySelector('#icSearch');
    var clearEl  = sec.querySelector('#icSearchClear');
    if (searchEl) {
        searchEl.value = _ic.searchQuery || '';
        if (clearEl) clearEl.style.display = _ic.searchQuery ? 'flex' : 'none';
        searchEl.addEventListener('input', function() {
            _ic.searchQuery = this.value;
            if (clearEl) clearEl.style.display = this.value ? 'flex' : 'none';
            _icRenderProducts();
        });
    }
    if (clearEl) {
        clearEl.addEventListener('click', function() {
            _ic.searchQuery = '';
            if (searchEl) { searchEl.value = ''; searchEl.focus(); }
            clearEl.style.display = 'none';
            _icRenderProducts();
        });
    }
}

function _icUpdateProgressLabels() {
    var locEl = _icContainer.querySelector('#icProgLoc');
    var unitEl = _icContainer.querySelector('#icProgUnit');
    var curEl = _icContainer.querySelector('#icCurrentUnit');
    if (locEl) locEl.textContent = _ic.locationName;
    if (unitEl) unitEl.textContent = _ic.physicalUnit;
    if (curEl) curEl.textContent = _ic.physicalUnit;
}

function _icUpdateProgress() {
    var cat = _icCategorize();
    var total = cat.unchecked.length + cat.checkedInUnit.length;
    var checked = cat.checkedInUnit.length;
    var pct = total > 0 ? (checked / total) * 100 : 0;

    var bar = _icContainer.querySelector('#icProgBar');
    var text = _icContainer.querySelector('#icProgText');
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = checked + ' / ' + total + ' tjekket i ' + _ic.physicalUnit;
}

// ════════════════════════════════════════════════════════════
// RENDER: PRODUCT CARDS
// ════════════════════════════════════════════════════════════

function _icRenderProducts() {
    var cat = _icCategorize();
    var q = (_ic.searchQuery || '').toLowerCase().trim();

    var unchecked     = cat.unchecked;
    var checkedInUnit = cat.checkedInUnit;
    if (q) {
        var match = function(p) { return (p.name || '').toLowerCase().indexOf(q) !== -1; };
        unchecked     = unchecked.filter(match);
        checkedInUnit = checkedInUnit.filter(match);
    }

    var uncheckedEl = _icContainer.querySelector('#icUncheckedList');
    uncheckedEl.innerHTML = '';

    unchecked.forEach(function(p) {
        uncheckedEl.appendChild(_icCreateCard(p, false));
    });

    // Tom-tilstand ved søgning uden match
    if (q && unchecked.length === 0 && checkedInUnit.length === 0) {
        uncheckedEl.innerHTML = '<div class="ic-search-empty">Ingen varer matcher &laquo;' +
            esc(_ic.searchQuery.trim()) + '&raquo;</div>';
    }

    var checkedListEl = _icContainer.querySelector('#icCheckedList');
    checkedListEl.innerHTML = '';

    if (checkedInUnit.length > 0) {
        _icContainer.querySelector('#icCheckedSection').style.display = 'block';
        _icContainer.querySelector('#icCheckedCount').textContent = checkedInUnit.length;
        _icContainer.querySelector('#icCurrentUnit').textContent = _ic.physicalUnit;
        checkedInUnit.forEach(function(p) {
            checkedListEl.appendChild(_icCreateCard(p, true));
        });
    } else {
        _icContainer.querySelector('#icCheckedSection').style.display = 'none';
    }
}

function _icCreateCard(product, isChecked) {
    var card = document.createElement('div');
    card.className = 'ic-card';
    card.dataset.productId = product.id;

    // product er det kategoriserede udsnit (mangler qu_id_*-felter) — slå det
    // fulde produkt op så enhed + salgs-/forbrugsenhed kan resolves.
    var fullProduct = (_ic.productsById && _ic.productsById[product.id]) || product;
    var stockInfo = _ic.grocyStock[product.id];
    // Enhed altid vist (som lageroversigten): fald tilbage til produktets
    // lager-enhed når varen ikke har en lagerpost (fx 0 på lager).
    var unitName = (stockInfo && stockInfo.unit) ? stockInfo.unit : (_ic.quantityUnits[fullProduct.qu_id_stock] || '');
    var grocyAmount = _icRound(stockInfo ? stockInfo.amount : 0);

    var countData = _ic.counts[product.id];
    var totalCounted = _icRound(countData ? (countData.total || 0) : 0);
    var remaining = _icRound(grocyAmount - totalCounted);

    // Sekundær enhed(er) — fx "(≈ 6 kasser)" (salgs-/forbrugsenhed, kun hvor konvertering findes)
    var altSuffix = '';
    var alts = _icAltConv(fullProduct);
    if (alts.length && grocyAmount > 0) {
        altSuffix = ' <span class="ic-card-alt">(' + alts.map(function(a) {
            return '&#8776; ' + _icRound(grocyAmount * a.factor, 1) + ' ' + esc(a.unit);
        }).join(' &middot; ') + ')</span>';
    }

    var stockText = 'Grocy: ' + grocyAmount + ' ' + unitName + altSuffix;
    if (totalCounted > 0) {
        stockText += ' &middot; Talt: ' + totalCounted;
        if (remaining > 0) {
            stockText += ' &middot; Mangler: ' + remaining;
        }
    }

    // Last checked text + unit
    var uf = product.userfields || {};
    // LastCheckedAt skrives som UTC (toISOString); Grocy kan strippe 'Z' ved
    // returnering — parseServerDate genskaber UTC-tolkningen begge veje.
    var lastChecked = uf.LastCheckedAt ? ((typeof parseServerDate === 'function') ? parseServerDate(uf.LastCheckedAt) : new Date(uf.LastCheckedAt)) : null;
    var lastUnit = uf.LastCheckedUnit || null;
    var lastText = lastChecked ? 'Sidst: ' + _icFormatDate(lastChecked) : 'Aldrig tjekket';
    if (lastChecked && lastUnit) {
        lastText += ' (' + esc(lastUnit) + ')';
    }

    // HverDag check-status badge
    var intervalDays = _icParseIntervalDays(uf);
    var checkStatus = product.checkStatus || _icComputeCheckStatus(intervalDays, lastChecked, new Date());
    var checkBadgeHtml = '';
    if (checkStatus.status === 'overdue') {
        var overdueText = checkStatus.daysSince === Infinity ? 'Aldrig' : checkStatus.daysSince + 'd';
        checkBadgeHtml = ' <span class="ic-check-badge ic-check-overdue" title="Overdue — sidst ' + overdueText + ' siden (interval: ' + (intervalDays || '?') + 'd)">&#x23F0;</span>';
    } else if (checkStatus.status === 'soon') {
        checkBadgeHtml = ' <span class="ic-check-badge ic-check-soon" title="Snart — ' + (checkStatus.daysSince || 0) + 'd siden (interval: ' + intervalDays + 'd)">&#x23F3;</span>';
    }

    // Expiry info
    var expiryHtml = '';
    var days = product.daysUntilExpiry;
    if (days !== undefined && days !== Infinity) {
        if (days < 0)       expiryHtml = ' <span class="ic-expiry-warn">Udloebet</span>';
        else if (days === 0) expiryHtml = ' <span class="ic-expiry-warn">Udloeber i dag</span>';
        else if (days <= 3)  expiryHtml = ' <span class="ic-expiry-soon">' + days + ' dag' + (days > 1 ? 'e' : '') + '</span>';
    }

    // Counted text for checked items
    var countedHtml = '';
    if (isChecked && product.countedAmount !== undefined) {
        countedHtml = '<div class="ic-card-counted">Talt ' + _icRound(product.countedAmount) + ' ' + esc(unitName) + ' i ' + esc(_ic.physicalUnit) + '</div>';
    }

    // Priority
    var prio = _ic.priorities[product.id] || 'normal';
    var prioIcon = prio === 'high' ? '\u2B50' : prio === 'low' ? '\uD83D\uDCA4' : '\u00B7';
    var prioClass = prio !== 'normal' ? ' ic-prio-' + prio : '';

    // Status class on card — use check-status (HverDag) when available, fall back to expiry
    if (!isChecked) {
        if (checkStatus.status === 'overdue')          card.className += ' ic-status-overdue';
        else if (checkStatus.status === 'soon')        card.className += ' ic-status-soon';
        else if (days !== undefined && days < 0)       card.className += ' ic-status-overdue';
        else if (days !== undefined && days <= 3)      card.className += ' ic-status-soon';
        else if (grocyAmount > 0)                      card.className += ' ic-status-ok';
        else                                            card.className += ' ic-status-neutral';
    } else {
        card.className += ' ic-status-checked';
    }

    // Default value for expanded input
    var defaultVal = remaining > 0 ? remaining : grocyAmount;

    var actionsHtml = '';
    if (!isChecked) {
        actionsHtml =
            '<div class="ic-card-actions">' +
                '<button class="ic-action-btn ic-btn-accept" data-action="accept" title="Accepter maengde">\u2714</button>' +
                '<button class="ic-action-btn ic-btn-skip" data-action="skip" title="Ikke her">\u23ED</button>' +
            '</div>';
    }

    card.innerHTML =
        '<div class="ic-card-main">' +
            '<div class="ic-card-info" data-action="expand">' +
                '<div class="ic-card-name">' +
                    '<button class="ic-priority-btn' + prioClass + '" data-action="priority" title="Skift prioritet">' + prioIcon + '</button> ' +
                    esc(product.name) + checkBadgeHtml + expiryHtml +
                '</div>' +
                '<div class="ic-card-meta">' + lastText + '</div>' +
                '<div class="ic-card-stock">' + stockText + '</div>' +
                countedHtml +
            '</div>' +
            actionsHtml +
        '</div>' +
        '<div class="ic-expanded">' +
            '<div class="ic-qty-row">' +
                '<div class="ic-qty-main">' +
                    '<button class="ic-qty-btn" data-action="minus">\u2212</button>' +
                    '<input type="number" class="ic-qty-input" value="' + defaultVal + '" min="0" step="0.5" data-grocy="' + _icRound(grocyAmount) + '">' +
                    '<button class="ic-qty-btn" data-action="plus">+</button>' +
                    '<span class="ic-qty-unit">' + esc(unitName) + '</span>' +
                '</div>' +
                '<div class="ic-qty-fractions">' +
                    '<button class="ic-fraction-btn" data-action="frac" data-frac="0.25">&frac14;</button>' +
                    '<button class="ic-fraction-btn" data-action="frac" data-frac="0.5">&frac12;</button>' +
                    '<button class="ic-fraction-btn" data-action="frac" data-frac="0.75">&frac34;</button>' +
                    '<button class="ic-fraction-btn ic-undo" data-action="cancel" title="Fortryd">\u21A9</button>' +
                '</div>' +
                '<button class="ic-qty-confirm" data-action="confirm">Gem</button>' +
            '</div>' +
        '</div>';

    // Delegate events from card
    card.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.dataset.action;
        var pid = parseInt(card.dataset.productId);

        if (action === 'accept')   _icMarkSeen(pid);
        else if (action === 'skip')     _icMarkSkipped(pid);
        else if (action === 'expand')   _icToggleExpand(pid);
        else if (action === 'priority') { e.stopPropagation(); _icTogglePriority(pid); }
        else if (action === 'minus')    _icAdjustQty(pid, -1);
        else if (action === 'plus')     _icAdjustQty(pid, 1);
        else if (action === 'frac')     _icSetFraction(pid, parseFloat(btn.dataset.frac));
        else if (action === 'cancel')   _icCancelExpand(pid);
        else if (action === 'confirm')  _icConfirmCount(pid);
    });

    return card;
}

// ════════════════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════════════════

function _icMarkSeen(productId) {
    var grocyAmount  = _icRound(_ic.grocyStock[productId] ? _ic.grocyStock[productId].amount : 0);
    var countData    = _ic.counts[productId];
    var totalCounted = _icRound(countData ? (countData.total || 0) : 0);
    var remaining    = _icRound(grocyAmount - totalCounted);

    var amount = remaining > 0 ? remaining : grocyAmount;
    _icSaveCount(productId, amount);
}

function _icMarkSkipped(productId) {
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (card) card.classList.add('ic-hiding');

    _ic.skipped.push(productId);
    _icSaveSkipped();

    setTimeout(function() {
        _icRenderProducts();
        _icUpdateProgress();
    }, 300);
}

function _icToggleExpand(productId) {
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (!card) return;

    // Close other expanded
    var all = _icContainer.querySelectorAll('.ic-card.ic-open');
    for (var i = 0; i < all.length; i++) {
        if (all[i] !== card) all[i].classList.remove('ic-open');
    }
    card.classList.toggle('ic-open');
}

function _icTogglePriority(productId) {
    var current = _ic.priorities[productId] || 'normal';
    var next = current === 'normal' ? 'high' : current === 'high' ? 'low' : 'normal';

    if (next === 'normal') {
        delete _ic.priorities[productId];
    } else {
        _ic.priorities[productId] = next;
    }
    _icSavePriorities();
    _icRenderProducts();
}

function _icAdjustQty(productId, delta) {
    var input = _icContainer.querySelector('[data-product-id="' + productId + '"] .ic-qty-input');
    if (!input) return;
    var val = parseFloat(input.value) || 0;
    val = _icRound(Math.max(0, val + delta));
    input.value = val;
}

function _icSetFraction(productId, fraction) {
    var input = _icContainer.querySelector('[data-product-id="' + productId + '"] .ic-qty-input');
    if (!input) return;
    var grocy = parseFloat(input.dataset.grocy) || 0;
    input.value = Math.round(grocy * fraction * 100) / 100;
}

function _icCancelExpand(productId) {
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (card) {
        card.classList.remove('ic-open');
        var input = card.querySelector('.ic-qty-input');
        if (input) input.value = parseFloat(input.dataset.grocy) || 0;
    }
}

function _icConfirmCount(productId) {
    var input = _icContainer.querySelector('[data-product-id="' + productId + '"] .ic-qty-input');
    var amount = parseFloat(input.value) || 0;
    _icSaveCount(productId, amount);
}

function _icSaveCount(productId, amount) {
    amount = _icRound(amount);

    if (!_ic.counts[productId]) {
        _ic.counts[productId] = { units: {}, total: 0 };
    }

    _ic.counts[productId].units[_ic.physicalUnit] = amount;

    // Recalculate total
    var sum = 0;
    var units = _ic.counts[productId].units;
    for (var u in units) {
        if (units.hasOwnProperty(u)) sum += units[u];
    }
    _ic.counts[productId].total = _icRound(sum);

    _icSaveCounts();

    // Update LastCheckedAt in Grocy (fire and forget)
    _icUpdateLastChecked(productId);

    // Animate card out then re-render
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (card) card.classList.add('ic-hiding');

    setTimeout(function() {
        _icRenderProducts();
        _icUpdateProgress();
    }, 300);
}

async function _icUpdateLastChecked(productId) {
    try {
        await putGrocyProductUserfields(productId, {
            LastCheckedAt: new Date().toISOString(),
            LastCheckedUnit: _ic.physicalUnit
        });
    } catch (err) {
        // Not critical -- userfields may not exist
        console.warn('Could not update LastCheckedAt:', err.message);
    }
}

function _icToggleCheckedList() {
    var list = _icContainer.querySelector('#icCheckedList');
    var icon = _icContainer.querySelector('#icCheckedIcon');
    list.classList.toggle('ic-visible');
    icon.innerHTML = list.classList.contains('ic-visible') ? '&#9660;' : '&#9654;';
}

// ════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════

function _icShowSummary() {
    var overlay = _icContainer.querySelector('#icSummaryOverlay');
    var body    = _icContainer.querySelector('#icSummaryBody');
    var locEl   = _icContainer.querySelector('#icSummaryLoc');
    locEl.textContent = _ic.locationName;

    var discrepancies = [];
    var notFound = [];
    var okItems = [];

    _ic.products.forEach(function(product) {
        var grocyAmount = _icRound(_ic.grocyStock[product.id] ? _ic.grocyStock[product.id].amount : 0);
        var countData = _ic.counts[product.id];
        var totalCounted = _icRound(countData ? (countData.total || 0) : 0);
        var _si = _ic.grocyStock[product.id];
        var unitName = (_si && _si.unit) ? _si.unit : (_ic.quantityUnits[product.qu_id_stock] || '');

        if (!countData || !countData.units || Object.keys(countData.units).length === 0) {
            if (grocyAmount > 0) {
                notFound.push({ id: product.id, name: product.name, grocyAmount: grocyAmount, unitName: unitName });
            }
        } else if (Math.abs(totalCounted - grocyAmount) > 0.01) {
            discrepancies.push({
                id: product.id,
                name: product.name,
                grocyAmount: grocyAmount,
                countedAmount: totalCounted,
                difference: _icRound(totalCounted - grocyAmount),
                unitName: unitName,
                countsByUnit: countData.units
            });
        } else {
            okItems.push({ id: product.id, name: product.name, grocyAmount: grocyAmount, unitName: unitName });
        }
    });

    var html =
        '<div class="ic-stats-row">' +
            '<div class="ic-stat-card"><div class="ic-stat-number">' + Object.keys(_ic.counts).length + '</div><div class="ic-stat-label">Varer talt</div></div>' +
            '<div class="ic-stat-card"><div class="ic-stat-number" style="color:' + (discrepancies.length > 0 ? 'var(--color-orange)' : 'var(--color-green)') + '">' + discrepancies.length + '</div><div class="ic-stat-label">Afvigelser</div></div>' +
            '<div class="ic-stat-card"><div class="ic-stat-number" style="color:' + (notFound.length > 0 ? 'var(--color-red)' : 'var(--color-green)') + '">' + notFound.length + '</div><div class="ic-stat-label">Ikke fundet</div></div>' +
        '</div>';

    if (discrepancies.length > 0) {
        html += '<div class="ic-summary-section"><h3>Afvigelser (' + discrepancies.length + ')</h3>';
        discrepancies.forEach(function(item) {
            var sign = item.difference > 0 ? '+' : '';
            var unitsDetail = Object.keys(item.countsByUnit).map(function(u) {
                return u + ': ' + _icRound(item.countsByUnit[u]);
            }).join(', ');

            html +=
                '<div class="ic-summary-item ic-disc" data-product-id="' + item.id + '">' +
                    '<div class="ic-summary-item-name">' + esc(item.name) + '</div>' +
                    '<div class="ic-summary-item-detail">' +
                        'Grocy: ' + item.grocyAmount + ' &rarr; Talt: ' + item.countedAmount + ' (' + sign + item.difference + ') ' + esc(item.unitName) + '<br>' +
                        '<small>' + esc(unitsDetail) + '</small>' +
                    '</div>' +
                    '<div class="ic-summary-item-actions">' +
                        '<button class="ic-btn-correct" data-correct="' + item.id + '" data-amount="' + item.countedAmount + '">Ret</button>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    if (notFound.length > 0) {
        html += '<div class="ic-summary-section"><h3>Ikke fundet (' + notFound.length + ')</h3>';
        notFound.forEach(function(item) {
            html +=
                '<div class="ic-summary-item ic-miss" data-product-id="' + item.id + '">' +
                    '<div class="ic-summary-item-name">' + esc(item.name) + '</div>' +
                    '<div class="ic-summary-item-detail">Grocy: ' + item.grocyAmount + ' ' + esc(item.unitName) + '</div>' +
                    '<div class="ic-summary-item-actions">' +
                        '<button class="ic-btn-correct" data-correct="' + item.id + '" data-amount="0">Saet til 0</button>' +
                        '<button class="ic-btn-add-shop" data-shop="' + item.id + '">Indkoeb</button>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    if (okItems.length > 0) {
        html += '<div class="ic-summary-section"><h3>OK (' + okItems.length + ')</h3>' +
            '<p style="color:var(--color-text-dim);font-size:13px;">' + okItems.length + ' varer stemmer med Grocy</p></div>';
    }

    body.innerHTML = html;

    // Delegate clicks in summary
    body.addEventListener('click', function(e) {
        var correctBtn = e.target.closest('[data-correct]');
        if (correctBtn) {
            _icCorrectInventory(parseInt(correctBtn.dataset.correct), parseFloat(correctBtn.dataset.amount));
            return;
        }
        var shopBtn = e.target.closest('[data-shop]');
        if (shopBtn) {
            _icAddToShopping(parseInt(shopBtn.dataset.shop));
        }
    });

    overlay.classList.add('ic-visible');
}

function _icCloseSummary() {
    _icContainer.querySelector('#icSummaryOverlay').classList.remove('ic-visible');
}

// ════════════════════════════════════════════════════════════
// GROCY ACTIONS
// ════════════════════════════════════════════════════════════

async function _icCorrectInventory(productId, newAmount) {
    try {
        await postGrocyInventory(productId, newAmount, '2999-12-31');
        _icAlert('Lager rettet', 'success');

        var item = _icContainer.querySelector('.ic-summary-item[data-product-id="' + productId + '"]');
        if (item) {
            item.className = 'ic-summary-item ic-ok';
            var acts = item.querySelector('.ic-summary-item-actions');
            if (acts) acts.innerHTML = '<span style="color:var(--color-green);font-weight:600;">Rettet</span>';
        }
    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
    }
}

async function _icAddToShopping(productId) {
    try {
        var product = _ic.products.find(function(p) { return p.id === productId; });
        var grocyAmount = _ic.grocyStock[productId] ? _ic.grocyStock[productId].amount : 1;

        await postGrocyShoppingList([{
            product_id: productId,
            amount:     grocyAmount,
            note:       'Manglede ved optaelling ' + new Date().toLocaleDateString('da-DK')
        }]);

        _icAlert((product ? product.name : 'Produkt') + ' tilfojet til indkoebsliste', 'success');

        var item = _icContainer.querySelector('.ic-summary-item[data-product-id="' + productId + '"]');
        if (item) {
            var btn = item.querySelector('[data-shop]');
            if (btn) { btn.textContent = 'Tilfojet'; btn.disabled = true; }
        }
    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
    }
}

async function _icSaveAllToGrocy() {
    var discs = [];

    _ic.products.forEach(function(product) {
        var grocyAmount = _ic.grocyStock[product.id] ? _ic.grocyStock[product.id].amount : 0;
        var countData = _ic.counts[product.id];
        var totalCounted = countData ? countData.total : undefined;

        if (totalCounted !== undefined && Math.abs(totalCounted - grocyAmount) > 0.01) {
            discs.push({ id: product.id, newAmount: totalCounted });
        }
    });

    if (discs.length === 0) {
        _icAlert('Ingen aendringer at gemme', 'info');
        return;
    }

    _icAlert('Gemmer ' + discs.length + ' aendringer...', 'info');

    var success = 0;
    var failed  = 0;

    for (var i = 0; i < discs.length; i++) {
        try {
            await postGrocyInventory(discs[i].id, discs[i].newAmount, '2999-12-31');
            success++;
        } catch (err) {
            console.error('Failed to update ' + discs[i].id + ':', err);
            failed++;
        }
    }

    if (failed === 0) {
        _icAlert('Alle ' + success + ' aendringer gemt!', 'success');
        _icClearCounts();
        _icCloseSummary();
        _icResetUI();
    } else {
        _icAlert(success + ' gemt, ' + failed + ' fejlede', 'warning');
    }
}

async function _icAddAllToShopping() {
    var missing = [];

    _ic.products.forEach(function(product) {
        var grocyAmount = _ic.grocyStock[product.id] ? _ic.grocyStock[product.id].amount : 0;
        var countData = _ic.counts[product.id];

        if (grocyAmount > 0 && (!countData || !countData.units || Object.keys(countData.units).length === 0)) {
            missing.push({ product_id: product.id, amount: grocyAmount, note: 'Manglede ved optaelling ' + new Date().toLocaleDateString('da-DK') });
        }
    });

    if (missing.length === 0) {
        _icAlert('Ingen manglende varer', 'info');
        return;
    }

    _icAlert('Tilfojer ' + missing.length + ' varer til indkoebsliste...', 'info');

    try {
        await postGrocyShoppingList(missing);
        _icAlert(missing.length + ' varer tilfojet til indkoebsliste', 'success');
    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// ADD UNEXPECTED PRODUCT
// ════════════════════════════════════════════════════════════

function _icShowAddProduct() {
    _icContainer.querySelector('#icAddSearch').value = '';
    _icFilterAddProducts();
    _icContainer.querySelector('#icAddOverlay').classList.add('ic-visible');
    _icContainer.querySelector('#icAddSearch').focus();
}

function _icCloseAddProduct() {
    _icContainer.querySelector('#icAddOverlay').classList.remove('ic-visible');
}

function _icFilterAddProducts() {
    var search = (_icContainer.querySelector('#icAddSearch').value || '').toLowerCase().trim();
    var listEl = _icContainer.querySelector('#icAddList');

    var existingIds = {};
    _ic.products.forEach(function(p) { existingIds[p.id] = true; });

    var available = _ic.allProducts.filter(function(p) { return !existingIds[p.id]; });

    if (search) {
        available = available.filter(function(p) {
            return p.name.toLowerCase().indexOf(search) !== -1;
        });
    }

    available = available.slice(0, 20);

    if (available.length === 0) {
        listEl.innerHTML = '<p style="color:var(--color-text-dim);text-align:center;padding:20px;">Ingen produkter fundet</p>';
        return;
    }

    listEl.innerHTML = '';
    available.forEach(function(p) {
        var loc = _ic.locations.find(function(l) { return l.id == p.location_id; });
        var locName = loc ? loc.name : '-';

        var item = document.createElement('div');
        item.className = 'ic-add-product-item';
        item.innerHTML = '<span class="ic-add-product-name">' + esc(p.name) + '</span>' +
                          '<span class="ic-add-product-loc">' + esc(locName) + '</span>';

        item.addEventListener('click', function() {
            _icAddUnexpectedProduct(p.id);
        });
        listEl.appendChild(item);
    });
}

function _icAddUnexpectedProduct(productId) {
    var product = _ic.allProducts.find(function(p) { return p.id === productId; });
    if (!product) return;

    _ic.products.push(product);
    _icCloseAddProduct();
    _icRenderProducts();
    _icAlert(product.name + ' tilfojet til optaelling', 'success');
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function _icRound(num, decimals) {
    decimals = decimals || 2;
    return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// ── Enhedskonvertering (stock -> salgs-/forbrugsenhed) ──────────
// Samme opslags-mønster som recipe_viewer/recipe_designer.
function _icFindFactor(productId, fromQuId, toQuId) {
    if (String(fromQuId) === String(toQuId)) return 1;
    var convs = _ic.conversions || [];
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

function _icAltConv(product) {
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
        var f = _icFindFactor(product.id, stockQu, tq);
        if (f && isFinite(f)) {
            out.push({ factor: f, unit: _ic.quantityUnits[tq] || '' });
        }
    });
    return out;
}

function _icFormatDate(date) {
    if (!date) return '-';
    var d = new Date(date);
    var diffDays = Math.floor((new Date() - d) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'I dag';
    if (diffDays === 1) return 'I gaar';
    if (diffDays < 7) return diffDays + ' dage siden';
    return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

// CommonJS export guard — exposes pure functions to Node-based tests (T_STOCK).
// Browser ignores this block since `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _icParseIntervalDays: _icParseIntervalDays,
        _icComputeCheckStatus: _icComputeCheckStatus
    };
}
