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
    skipped:       [],          // productIds skipped in current unit (array — spejl af skippedByUnit)
    skippedByUnit: {},          // unitName -> [productId]  (hele sessionen, ikke kun aktiv enhed)
    decisions:     {},          // productId -> 'notrack' | 'discontinued'  (⋯-menu, skrives ved commit)
    countUnitPref: {},          // "<pid>|<enhed>" -> qu_id — sidst brugte tælleenhed i den kontekst
    startedAt:     null,        // ISO — hvornår sessionen begyndte (drives genoptag-banneret)
    priorities:    {},          // productId -> "high"|"low"
    manualAdded:   {},          // productId -> enhed hvor varen blev hentet frem manuelt
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

        // Kvittering fra sidste optælling — står til den lukkes, ikke 3 sekunder.
        var receipt = _icLoadReceipt();
        if (receipt && receipt.text) {
            _icContainer.querySelector('#icReceiptText').textContent = receipt.text;
            _icContainer.querySelector('#icReceipt').classList.add('ic-visible');
        }

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
        // manageSSE lukker forbindelsen ved navigation — ellers blev den
        // hængende og holdt sidens HTTP/2-forbindelse i live efter man var gået.
        _ic._sse = manageSSE(function() {
            var es = new EventSource('/api/sse');
            es.addEventListener('physical_unit_changed', function(e) {
                try { _icOnPhysicalUnitChanged(JSON.parse(e.data)); }
                catch (err) { /* stille */ }
            });
            return es;
        });
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

// Lokal dato (ikke UTC). new Date().toISOString() giver UTC-datoen — i dansk
// sommertid er kl. 22:00 allerede "i morgen" i UTC. Se memory project_utc_today_bug.
function _icLocalDate(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Sessionen er IKKE dags-scoped. Spec §6 bygger på at en optælling kan genoptages
// over flere dage (derfor gemmes grocyAtCount pr. vare, ikke ét session-snapshot).
// En dato i nøglen ville tavst smide counts væk ved midnat.
function _icSessionKey() {
    return 'ic_counts_' + _ic.locationId;
}

// Engangsoprydning: de gamle dags-scopede nøgler (ic_counts_<loc>_<YYYY-MM-DD>).
// Nyeste for DENNE lokation overtages hvis den nye nøgle er tom; resten slettes,
// så de ikke bliver liggende for evigt.
function _icMigrateLegacySessions() {
    var legacyRe = /^ic_counts_(\d+)_(\d{4}-\d{2}-\d{2})$/;
    var mine = [], all = [];
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            var m = k && k.match(legacyRe);
            if (!m) continue;
            all.push(k);
            if (parseInt(m[1]) === _ic.locationId) mine.push({ key: k, date: m[2] });
        }
    } catch (e) { return null; }

    var adopted = null;
    if (mine.length) {
        mine.sort(function(a, b) { return a.date < b.date ? 1 : -1; });   // nyeste først
        try { adopted = JSON.parse(localStorage.getItem(mine[0].key)); } catch (e) { adopted = null; }
    }
    all.forEach(function(k) { try { localStorage.removeItem(k); } catch (e) {} });
    return adopted;
}

function _icLoadCounts() {
    var data = null;
    try {
        var stored = localStorage.getItem(_icSessionKey());
        if (stored) data = JSON.parse(stored);
    } catch (e) { data = null; }

    if (!data) data = _icMigrateLegacySessions();
    else _icMigrateLegacySessions();     // ryd op uanset

    data = data || {};
    _ic.counts        = data.counts || {};
    _ic.skippedByUnit = data.skippedByUnit || {};
    _ic.decisions     = data.decisions || {};
    _ic.startedAt     = data.startedAt || null;

    if (!_ic.startedAt && Object.keys(_ic.counts).length) _ic.startedAt = new Date().toISOString();
}

function _icSaveCounts() {
    if (!_ic.startedAt) _ic.startedAt = new Date().toISOString();
    // try/catch: localStorage findes ikke i Node (tests), og Safari i privat
    // tilstand kaster på setItem. En optælling må ikke dø af det.
    try {
        localStorage.setItem(_icSessionKey(), JSON.stringify({
            counts:        _ic.counts,
            skippedByUnit: _ic.skippedByUnit,
            decisions:     _ic.decisions,
            startedAt:     _ic.startedAt
        }));
    } catch (e) {}
}

function _icClearCounts() {
    try { localStorage.removeItem(_icSessionKey()); } catch (e) {}
    _ic.counts = {};
    _ic.skippedByUnit = {};
    _ic.decisions = {};
    _ic.skipped = [];
    _ic.startedAt = null;
}

// Er sessionen startet på en tidligere dag? (driver genoptag-banneret)
function _icSessionIsOld() {
    if (!_ic.startedAt) return false;
    if (!Object.keys(_ic.counts).length && !Object.keys(_ic.decisions).length) return false;
    return _icLocalDate(new Date(_ic.startedAt)) !== _icLocalDate();
}

// ════════════════════════════════════════════════════════════
// SKIP STATE — del af sessionen (samme levetid som counts)
// ════════════════════════════════════════════════════════════
// Lå før i sessionStorage og døde ved fane-luk, mens counts overlevede. To
// levetider i samme session gjorde "Fortryd" utroværdig.

function _icLoadSkipped() {
    _ic.skipped = (_ic.skippedByUnit && _ic.skippedByUnit[_ic.physicalUnit]) || [];
}

function _icSaveSkipped() {
    if (!_ic.skippedByUnit) _ic.skippedByUnit = {};
    if (_ic.skipped && _ic.skipped.length) _ic.skippedByUnit[_ic.physicalUnit] = _ic.skipped;
    else delete _ic.skippedByUnit[_ic.physicalUnit];
    _icSaveCounts();
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
    try { localStorage.setItem('ic_priorities', JSON.stringify(_ic.priorities)); } catch (e) {}
}

// ════════════════════════════════════════════════════════════
// TÆLLEENHED — huskes pr. vare OG fysisk enhed
// ════════════════════════════════════════════════════════════
// Samme vare tælles ofte i forskellige enheder alt efter hvor den står (bøtter i
// kølerummet, kasser på tørlageret). Konteksten er derfor vare+enhed, ikke vare.
// Den styrer kun hvilket felt der står først og er forudfyldt (§14.3) — alle
// varens enheder står åbne på kortet, så intet er låst.

function _icPrefKey(productId, physicalUnit) {
    return productId + '|' + (physicalUnit || _ic.physicalUnit);
}

function _icLoadCountUnitPrefs() {
    try {
        _ic.countUnitPref = JSON.parse(localStorage.getItem('ic_countunit') || '{}');
    } catch (e) {
        _ic.countUnitPref = {};
    }
}

function _icRememberCountUnit(productId, quId) {
    _ic.countUnitPref[_icPrefKey(productId)] = quId;
    try { localStorage.setItem('ic_countunit', JSON.stringify(_ic.countUnitPref)); } catch (e) {}
}

function _icPreferredCountUnit(productId) {
    var v = _ic.countUnitPref[_icPrefKey(productId)];
    return (v === undefined || v === null) ? null : v;
}

// ════════════════════════════════════════════════════════════
// KVITTERING — bliver stående til den lukkes eller en ny session starter
// ════════════════════════════════════════════════════════════

function _icSaveReceipt(text) {
    try { localStorage.setItem('ic_receipt', JSON.stringify({ text: text, at: new Date().toISOString() })); } catch (e) {}
}

function _icLoadReceipt() {
    try { return JSON.parse(localStorage.getItem('ic_receipt') || 'null'); } catch (e) { return null; }
}

function _icClearReceipt() {
    try { localStorage.removeItem('ic_receipt'); } catch (e) {}
    var el = _icContainer && _icContainer.querySelector('#icReceipt');
    if (el) el.classList.remove('ic-visible');
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
    var locOptions = '<option value="">-- Vælg lokation --</option>';
    _ic.locations.forEach(function(loc) {
        locOptions += '<option value="' + loc.id + '">' + esc(loc.name) + '</option>';
    });

    _icContainer.innerHTML =
        '<div class="ic-alert-box"></div>' +

        // Kvittering fra sidste optælling — bliver stående til den lukkes.
        '<div class="ic-receipt" id="icReceipt">' +
            '<span id="icReceiptText"></span>' +
            '<button class="ic-receipt-close" id="icReceiptClose" title="Luk">&times;</button>' +
        '</div>' +

        // Genoptag-banner: sessionen blev startet en tidligere dag.
        '<div class="ic-resume" id="icResume">' +
            '<span id="icResumeText"></span>' +
            '<span class="ic-resume-actions">' +
                '<button class="ic-btn-secondary" id="icResumeKeep">Fortsæt</button>' +
                '<button class="ic-btn-secondary" id="icResumeReset">Start forfra</button>' +
            '</span>' +
        '</div>' +

        '<div class="ic-location-bar">' +
            '<div class="ic-form-group">' +
                '<label>Lokation</label>' +
                '<select id="icLocSelect">' + locOptions + '</select>' +
            '</div>' +
            '<div class="ic-form-group">' +
                '<label>Fysisk enhed</label>' +
                '<select id="icUnitSelect"><option value="">-- Vælg lokation først --</option></select>' +
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
                '<button class="ic-btn-primary" id="icAddUnitBtn">+ Tilføj</button>' +
            '</div>' +
        '</div>' +

        '<div id="icProgressSection" style="display:none;"></div>' +

        '<div class="ic-product-list" id="icProductArea">' +
            '<div class="ic-empty" id="icEmptyState">' +
                '<h3>Vælg lokation og fysisk enhed for at starte</h3>' +
                '<p>Du kan tælle den samme vare flere steder — vi lægger tallene sammen for dig.</p>' +
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
                    '<h2>Gem og luk</h2>' +
                    '<p id="icSummaryLoc"></p>' +
                '</div>' +
                '<div class="ic-modal-body" id="icSummaryBody"></div>' +
                '<div class="ic-modal-footer">' +
                    '<button class="ic-btn-close" id="icSummaryClose">Tilbage</button>' +
                    '<button class="ic-btn-shopping" id="icSummaryShop">Sæt manglende på indkøbslisten</button>' +
                    '<button class="ic-btn-save-all" id="icSummarySave">Gem og luk</button>' +
                '</div>' +
            '</div>' +
        '</div>' +

        // Add product overlay
        '<div class="ic-overlay" id="icAddOverlay">' +
            '<div class="ic-modal" style="max-width:500px;">' +
                '<div class="ic-modal-header">' +
                    '<h2>Tilføj vare</h2>' +
                    '<p>Fandt en vare der ikke var på listen?</p>' +
                '</div>' +
                '<div class="ic-modal-body">' +
                    '<input type="text" class="ic-add-search" id="icAddSearch" placeholder="Skriv for at søge...">' +
                    '<select class="ic-add-filter" id="icAddLocFilter"><option value="">Alle lokationer</option></select>' +
                    '<div id="icAddList" class="ic-add-list"></div>' +
                '</div>' +
                '<div class="ic-modal-footer">' +
                    '<span class="ic-add-count" id="icAddCount"></span>' +
                    '<button class="ic-btn-close" id="icAddClose">Annuller</button>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Klik udenfor lukker et åbent kort-menu.
    if (!document.body.dataset.icMenuBound) {
        document.body.dataset.icMenuBound = '1';
        document.body.addEventListener('click', function(e) {
            // Trykkets ophav tæller med: trækker man en markering ud af
            // menuen, er det ikke et klik ved siden af.
            if (!clickedOutsideSelector(e, '[data-menu], [data-action="more"]')) return;
            _icCloseAllCardMenus();
        });
    }

    // Wire up events
    _icContainer.querySelector('#icReceiptClose').addEventListener('click', _icClearReceipt);
    _icContainer.querySelector('#icResumeKeep').addEventListener('click', function() {
        _icContainer.querySelector('#icResume').classList.remove('ic-visible');
    });
    _icContainer.querySelector('#icResumeReset').addEventListener('click', function() {
        if (!confirm('Vil du slette det du allerede har talt og starte forfra?')) return;
        _icClearCounts();
        _icContainer.querySelector('#icResume').classList.remove('ic-visible');
        _icRenderProducts();
        _icUpdateProgress();
    });
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
    _icContainer.querySelector('#icAddLocFilter').addEventListener('change', _icFilterAddProducts);
    // Delegeret: listen kan være lang, så vi binder ikke pr. række.
    _icContainer.querySelector('#icAddList').addEventListener('click', function(e) {
        var row = e.target.closest('.ic-add-product-item');
        if (row) _icAddUnexpectedProduct(row.getAttribute('data-pid'));
    });
}

// ════════════════════════════════════════════════════════════
// EVENT HANDLERS: LOCATION & UNIT SELECT
// ════════════════════════════════════════════════════════════

async function _icOnLocationChange() {
    var sel = _icContainer.querySelector('#icLocSelect');
    var locId = sel.value;

    if (!locId) {
        _icContainer.querySelector('#icUnitSelect').innerHTML = '<option value="">-- Vælg lokation først --</option>';
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
    _ic._commitFresh = null;
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
        tagsEl.innerHTML = '<span style="color:var(--color-text-dim);font-size:13px;">Ingen enheder. Tilføj fx "KØL-1", "FRYS-1"</span>';
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
        unitSel.innerHTML = '<option value="">-- Tilføj enheder først --</option>';
        _icContainer.querySelector('#icStartBtn').disabled = true;
    } else {
        var html = '<option value="">-- Vælg enhed --</option>';
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
        _icAlert('Tilføjet: ' + name, 'success');
    } catch (e) {
        _icAlert('Kunne ikke tilføje: ' + (e.message || 'ukendt fejl'), 'error');
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
        _icAlert('Vælg både lokation og fysisk enhed', 'warning');
        return;
    }

    _ic.isChecking = true;
    _ic.searchQuery = '';
    // _ic.products bygges forfra nedenfor, så manuelt fremhentede varer falder ud
    // alligevel — markeringen skal følge med, ellers peger den på en tom liste.
    _ic.manualAdded = {};

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
        //
        // En FORÆLDER uden egen beholdning kan ikke tælles (#616): dens egen
        // lagerrække står per konstruktion på 0, fordi børnene bærer lageret
        // (kål → Spidskål, Hvidkål). I tællelisten ligner den derfor en tom
        // vare — og dét var præcis hvad der fik nogen til at trykke "Varen
        // findes ikke mere" på kål og sætte den inaktiv. Man tæller børnene.
        // `hide_on_stock_overview` tages med af samme grund: siger Grocy at
        // varen aldrig skal ses på lageret, skal den heller ikke tælles.
        _ic.allProducts = allProducts.filter(function(p) {
            if (grocyHasNoOwnStock(p) || grocyHiddenOnStockOverview(p)) return false;
            return p.active === '1' || p.active === 1 || p.active === true;
        });

        // Id -> fuldt produkt. _icCreateCard får kun et kategoriseret udsnit
        // (uden qu_id_*-felter), så enhed + salgs-/forbrugsenhed slås op her.
        _ic.productsById = {};
        _ic.allProducts.forEach(function(p) { _ic.productsById[p.id] = p; });

        // Bug 4 — rullende membership: hvilke varer er "i spil" for denne lokation.
        // IKKE default_consume_location_id (den trak frostvarer ind i køle-listen).
        //   - talt i en enhed under DENNE lokation (LastCheckedUnit ∈ units(L)) → med
        //   - ellers hører varen til her via Grocy location_id → med (blød fallback, beslutning E:
        //     en vare rullet til en anden lokations enhed forsvinder ikke tavst fra sit hjem)
        var _locUnits = _icGetUnitsForLocation(_ic.locationId);
        _ic.products = _ic.allProducts.filter(function(p) {
            var uf = p.userfields || {};
            var lcu = uf.LastCheckedUnit || null;
            if (lcu && _locUnits.indexOf(lcu) !== -1) return true;
            var locId = parseInt(p.location_id) || 0;
            return locId === _ic.locationId;
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
        _icLoadCountUnitPrefs();
        _icShowResumeBanner();
        // Kvitteringen hører til den FORRIGE optælling. Står den endnu når en ny
        // begynder, ligner den en kvittering for det man er i gang med.
        _icClearReceipt();

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
// SKIFT FYSISK ENHED
// ════════════════════════════════════════════════════════════

// Skift til en navngiven enhed (enheds-chips). Tællinger er gemt pr. enhed i
// counts[id].units, så de står urørte når man skifter frem og tilbage.
function _icSwitchToUnit(unitName) {
    if (!unitName || unitName === _ic.physicalUnit) return;
    var units = _icGetUnitsForLocation(_ic.locationId);
    if (units.indexOf(unitName) === -1) return;

    _icSaveSkipped();                 // gem skip for den enhed vi forlader

    _ic.physicalUnit = unitName;
    var sel = _icContainer.querySelector('#icUnitSelect');
    if (sel) sel.value = _ic.physicalUnit;

    _icLoadSkipped();
    _icRenderProducts();
    _icUpdateProgress();          // renderer også chips (aktiv-markering + tællere)
    _icUpdateProgressLabels();
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

// Bug 4 — hører varen til DENNE fysiske enheds liste? (blød fallback, beslutning E)
//   LastCheckedUnit == enhed                     → vis  (rullet hertil)
//   LastCheckedUnit ∈ andre enheder under lok.   → skjul (rullet til anden enhed her)
//   location_id == lok.                          → vis  (fallback: hører til her)
//   ellers                                       → skjul
function _icVisibleInUnit(product, locUnits) {
    // Hentet frem i hånden ("Tilføj vare"): brugeren står med varen i hånden i
    // DENNE enhed. Det slår altid Grocys formodning om hvor den hører hjemme —
    // ellers ville varen blive filtreret væk igen i samme sekund den blev valgt.
    if (_ic.manualAdded[product.id] === _ic.physicalUnit) return true;

    var uf = product.userfields || {};
    var lcu = uf.LastCheckedUnit || null;
    if (lcu === _ic.physicalUnit) return true;
    if (lcu && locUnits.indexOf(lcu) !== -1) return false;
    return (parseInt(product.location_id) || 0) === _ic.locationId;
}

// Bug 3 — 4 grupper (lavere index = højere i listen):
//   0 Forfaldne · 1 Aldrig tjekket · 2 Snart · 3 Ikke-forfaldne (inkl. passiv, beslutning C)
function _icGroupOf(intervalDays, lastChecked, checkStatus) {
    if (!intervalDays) return 3;                          // passiv (HverDag tom) → altid nederst
    if (!lastChecked) return 1;                           // ønsket tracket, aldrig talt
    if (checkStatus.status === 'overdue') return 0;       // forfaldne
    if (checkStatus.status === 'soon')    return 2;       // snart forfaldne
    return 3;                                             // ok → ikke-forfaldne
}

function _icCategorize() {
    var now = new Date();
    var unchecked = [];
    var checkedInUnit = [];
    var locUnits = _icGetUnitsForLocation(_ic.locationId);

    var skippedList = [];

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

        // Bug 4 — vis kun varen i den enhed den (rullende) hører til.
        if (!_icVisibleInUnit(product, locUnits)) return;

        // Sprunget over: forsvinder ikke længere, men samles nederst så
        // "Fortryd" er lige ved hånden (spec 7).
        if (skippedInThisUnit) {
            skippedList.push({
                id: product.id, name: product.name, userfields: product.userfields,
                status: 'skipped'
            });
            return;
        }

        var stockInfo    = _ic.grocyStock[product.id];
        var grocyAmount  = _icRound(stockInfo ? stockInfo.amount : 0);
        var countedTotal = _icRound(countData ? (countData.total || 0) : 0);
        var remaining    = _icRound(grocyAmount - countedTotal);

        var daysUntilExpiry = Infinity;
        if (stockInfo && stockInfo.bestBefore && stockInfo.bestBefore !== '2999-12-31') {
            var expiry = new Date(stockInfo.bestBefore);
            daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        }

        unchecked.push({
            id:               product.id,
            name:             product.name,
            userfields:       product.userfields,
            location_id:      product.location_id,
            lastChecked:      lastChecked,
            lastCheckedUnit:  lastCheckedUnit,
            intervalDays:     intervalDays,
            checkStatus:      checkStatus,
            group:            _icGroupOf(intervalDays, lastChecked, checkStatus),
            daysUntilExpiry:  daysUntilExpiry,
            grocyAmount:      grocyAmount,
            countedTotal:     countedTotal,
            remaining:        remaining
        });
    });

    // Bug 3 — sortér: gruppe → manuel prioritet → check-ratio (mest presserende først)
    //          → best-before KUN som tie-breaker → navn.
    var prioOrder = { high: 0, normal: 1, low: 2 };

    unchecked.sort(function(a, b) {
        // 1. Manuel prioritet (stjernen) — en bevidst menneskelig besked slår automatikken.
        //    Står FØR gruppen: har nogen stjernemarkeret en vare, skal den øverst, også selvom
        //    den ikke er forfalden. Ellers holder markeringen ikke hvad den lover.
        //    (Uændret adfærd fra før 4-gruppe-omskrivningen — for varer uden markering,
        //    dvs. langt de fleste, er sorteringen identisk med gruppe-først.)
        var aPrio = prioOrder[_ic.priorities[a.id] || 'normal'];
        var bPrio = prioOrder[_ic.priorities[b.id] || 'normal'];
        if (aPrio !== bPrio) return aPrio - bPrio;

        // 2. Gruppe (Forfaldne < Aldrig tjekket < Snart < Ikke-forfaldne)
        if (a.group !== b.group) return a.group - b.group;

        // 3. Check-ratio (højere = mere presserende)
        var aRatio = a.checkStatus.ratio === Infinity ? 9999 : (a.checkStatus.ratio || 0);
        var bRatio = b.checkStatus.ratio === Infinity ? 9999 : (b.checkStatus.ratio || 0);
        if (aRatio !== bRatio) return bRatio - aRatio;

        // 4. Best-before som tie-breaker (tidligst udløb først; Infinity sidst)
        if (a.daysUntilExpiry !== b.daysUntilExpiry) return a.daysUntilExpiry - b.daysUntilExpiry;

        // 5. Navn
        return a.name.localeCompare(b.name, 'da');
    });

    skippedList.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });

    return { unchecked: unchecked, checkedInUnit: checkedInUnit, skipped: skippedList };
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
            '<div class="ic-unit-chips" id="icUnitChips"></div>' +
            '<div class="ic-progress-track"><div class="ic-progress-bar" id="icProgBar"></div></div>' +
            '<div class="ic-progress-text" id="icProgText">0 / 0 tjekket</div>' +
            '<div class="ic-progress-actions">' +
                '<button class="ic-btn-secondary" id="icBtnAddProduct">Tilføj vare</button>' +
                '<button class="ic-btn-finish" id="icBtnFinish">Afslut optælling</button>' +
            '</div>' +
            '<div class="ic-search-row">' +
                '<input type="text" class="ic-search" id="icSearch" placeholder="Søg vare i listen...">' +
                '<button class="ic-search-clear" id="icSearchClear" title="Ryd" style="display:none;">&times;</button>' +
            '</div>' +
        '</div>';

    _icRenderUnitChips();
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

// Genoptag-banner: sessionen blev startet en tidligere dag. Vi kaster den ikke væk
// af sig selv (spec §6: en optælling kan strække sig over flere dage) — vi spørger.
function _icShowResumeBanner() {
    var el = _icContainer.querySelector('#icResume');
    if (!el) return;
    if (!_icSessionIsOld()) { el.classList.remove('ic-visible'); return; }

    var d = new Date(_ic.startedAt);
    var dage = Math.round((new Date(_icLocalDate()) - new Date(_icLocalDate(d))) / 86400000);
    var hvornår = dage === 1 ? 'i går' : 'for ' + dage + ' dage siden';
    var tid = d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
    var antal = Object.keys(_ic.counts).length;

    _icContainer.querySelector('#icResumeText').textContent =
        'Du har en optælling i gang, startet ' + hvornår + ' kl. ' + tid +
        ' med ' + antal + ' vare' + (antal === 1 ? '' : 'r') + ' talt.';
    el.classList.add('ic-visible');
}

// Enheds-chips: én pr. fysisk enhed på lokationen, med antal talte varer.
// Erstatter den gamle "Næste enhed"-knap, der kun kunne cykle én vej og skjulte
// at man kan tælle den samme vare flere steder.
function _icRenderUnitChips() {
    var host = _icContainer.querySelector('#icUnitChips');
    if (!host) return;

    var units = _icGetUnitsForLocation(_ic.locationId);
    host.innerHTML = '';

    units.forEach(function(u) {
        var n = 0;
        Object.keys(_ic.counts).forEach(function(pid) {
            var c = _ic.counts[pid];
            if (c && c.units && c.units[u] !== undefined) n++;
        });

        var btn = document.createElement('button');
        btn.className = 'ic-unit-chip' + (u === _ic.physicalUnit ? ' ic-active' : '');
        btn.type = 'button';
        btn.dataset.unit = u;
        btn.innerHTML = esc(u) + (n ? '<span class="ic-unit-chip-count">' + n + '</span>' : '');
        btn.addEventListener('click', function() { _icSwitchToUnit(u); });
        host.appendChild(btn);
    });
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
    // Chip-tællerne følger tællingen — ellers stod "KØL-1 2" i stedet for 3
    // indtil man skiftede enhed.
    _icRenderUnitChips();

    if (bar) bar.style.width = pct + '%';
    if (text) {
        // Sprungne tæller ikke med som tjekket - de får deres egen note, så
        // tallet ikke lyver om hvor langt man er.
        var nSkip = (cat.skipped || []).length;
        text.textContent = checked + ' / ' + total + ' tjekket i ' + _ic.physicalUnit +
            (nSkip ? ' \u00B7 ' + nSkip + ' sprunget over' : '');
    }
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

    var skippedNow = cat.skipped || [];
    if (q) skippedNow = skippedNow.filter(function(p) { return (p.name || '').toLowerCase().indexOf(q) !== -1; });

    // Tom-tilstand ved søgning uden match — SKAL afgøres før de sprungne kort
    // tilføjes, ellers overskriver innerHTML dem. En søgning der kun rammer en
    // sprunget vare påstod tidligere at varen ikke fandtes.
    if (q && unchecked.length === 0 && checkedInUnit.length === 0 && skippedNow.length === 0) {
        uncheckedEl.innerHTML = '<div class="ic-search-empty">Ingen varer matcher &laquo;' +
            esc(_ic.searchQuery.trim()) + '&raquo;</div>';
    }

    skippedNow.forEach(function(p) {
        uncheckedEl.appendChild(_icCreateCard(p, false));
    });

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
            return '&#8776; ' + _icFmt(grocyAmount * a.factor, 1) + ' ' + esc(a.unit);
        }).join(' &middot; ') + ')</span>';
    }

    var stockText = 'På lageret: ' + _icFmt(grocyAmount) + ' ' + unitName + altSuffix;
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
        if (days < 0)       expiryHtml = ' <span class="ic-expiry-warn">Udløbet</span>';
        else if (days === 0) expiryHtml = ' <span class="ic-expiry-warn">Udløber i dag</span>';
        else if (days <= 3)  expiryHtml = ' <span class="ic-expiry-soon">' + days + ' dag' + (days > 1 ? 'e' : '') + '</span>';
    }

    // Counted text for checked items
    var countedHtml = '';
    if (isChecked && product.countedAmount !== undefined) {
        countedHtml = '<div class="ic-card-counted">Talt ' + _icFmt(product.countedAmount) + ' ' + esc(unitName) + ' i ' + esc(_ic.physicalUnit) + '</div>';
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

    // Er varen sprunget over i denne enhed? Den skjules ikke længere — den dæmpes,
    // så "Fortryd" er lige så billig som selve springet (spec §7).
    var isSkipped = _ic.skipped.indexOf(product.id) !== -1;
    if (isSkipped) card.className += ' ic-skipped';

    // Beslutning fra kortets menu, endnu ikke skrevet (sker ved commit).
    var decision = _ic.decisions[product.id] || null;
    if (decision) card.className += ' ic-decided';

    // 1 tryk direkte på kortet til de hyppige arbejdsskridt; menuen til de
    // sjældne beslutninger der ændrer varens opsætning (spec §7:
    // omkostning følger hyppighed, ikke konsekvens-frygt).
    var actionsHtml = '<div class="ic-card-actions">';
    if (!isChecked && !isSkipped && !decision) {
        actionsHtml +=
            '<button class="ic-action-btn ic-btn-accept" data-action="accept" title="Tallet passer — godkend">\u2714</button>' +
            '<button class="ic-action-btn ic-btn-skip" data-action="skip" title="Spring over — tæl den ikke nu">\u23ED</button>';
    }
    actionsHtml +=
        '<button class="ic-action-btn ic-btn-more" data-action="more" title="Flere valg">&#x22EF;</button>' +
        '</div>';

    var menuHtml =
        '<div class="ic-card-menu" data-menu>' +
            '<button data-action="notrack">' +
                (decision === 'notrack' ? 'Fortryd &ndash; skal tælles fast igen' : 'Skal ikke tælles fast') +
            '</button>' +
            '<button class="ic-menu-danger" data-action="discontinued">' +
                (decision === 'discontinued' ? 'Fortryd &ndash; varen bruges stadig' : 'Varen findes ikke mere') +
            '</button>' +
        '</div>';

    var noteHtml = '';
    if (isSkipped) {
        noteHtml = '<div class="ic-card-note">Sprunget over i ' + esc(_ic.physicalUnit) +
            '<button data-action="unskip">Fortryd</button></div>';
    } else if (decision === 'notrack') {
        noteHtml = '<div class="ic-card-note">Bliver ikke husket til fast optælling, når du gemmer.' +
            '<button data-action="undecide">Fortryd</button></div>';
    } else if (decision === 'discontinued') {
        noteHtml = '<div class="ic-card-note ic-note-danger">Sættes til 0 og tages af listerne, når du gemmer.' +
            '<button data-action="undecide">Fortryd</button></div>';
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
        menuHtml +
        noteHtml +
        // Mængdefelterne (§14.6) monteres af _icMountCount lige nedenfor —
        // ét felt pr. enhed varen kan tælles i. ± flyttes ind i felt-rækken
        // og rammer det MARKEREDE felt. Brøkknapperne (¼ ½ ¾) er væk: man
        // tæller det åbnede i den fine enhed i stedet for at gætte på en brøk.
        '<div class="ic-expanded">' +
            '<div class="ic-qty-row">' +
                '<button class="ic-qty-btn" data-action="minus" type="button">\u2212</button>' +
                '<button class="ic-qty-btn" data-action="plus" type="button">+</button>' +
                '<div class="ic-mf-host"></div>' +
                '<div class="ic-qty-actions">' +
                    '<button class="ic-qty-undo" data-action="cancel" type="button" title="Fortryd">\u21A9</button>' +
                    '<button class="ic-qty-confirm" data-action="confirm" type="button">Gem</button>' +
                '</div>' +
            '</div>' +
            '<div class="ic-mf-facit"><span class="ic-mf-sum"></span><span class="ic-mf-delta"></span></div>' +
        '</div>';

    // Delegate events from card
    card.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.dataset.action;
        var pid = parseInt(card.dataset.productId);

        if (action === 'accept')   _icMarkSeen(pid);
        else if (action === 'skip')     _icMarkSkipped(pid);
        else if (action === 'unskip')   { e.stopPropagation(); _icUnskip(pid); }
        else if (action === 'expand')   _icToggleExpand(pid);
        else if (action === 'priority') { e.stopPropagation(); _icTogglePriority(pid); }
        else if (action === 'minus')    _icAdjustQty(pid, -1);
        else if (action === 'plus')     _icAdjustQty(pid, 1);
        else if (action === 'cancel')   _icCancelExpand(pid);
        else if (action === 'confirm')  _icConfirmCount(pid);
        else if (action === 'more')     { e.stopPropagation(); _icToggleCardMenu(card); }
        else if (action === 'notrack')  { e.stopPropagation(); _icDecide(pid, 'notrack'); }
        else if (action === 'discontinued') { e.stopPropagation(); _icDecide(pid, 'discontinued'); }
        else if (action === 'undecide') { e.stopPropagation(); _icDecide(pid, null); }
    });

    _icMountCount(card, fullProduct, defaultVal);

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

// Spring over: varen forsvinder ikke længere fra listen - den dæmpes med en
// Fortryd ved siden af. Gjorde vi springet 1-tryks-let, skal fortrydelsen være
// det også (spec 7).
function _icMarkSkipped(productId) {
    if (_ic.skipped.indexOf(productId) === -1) _ic.skipped.push(productId);
    _icSaveSkipped();
    _icRenderProducts();
    _icUpdateProgress();
}

function _icUnskip(productId) {
    var i = _ic.skipped.indexOf(productId);
    if (i !== -1) _ic.skipped.splice(i, 1);
    _icSaveSkipped();
    _icRenderProducts();
    _icUpdateProgress();
}

// Kortets menu (de sjældne beslutninger). Kun én åben ad gangen.
// ic-menu-open sættes på KORTET, ikke menuen: kortet har overflow:hidden, som
// ellers klipper menuen af ved sin egen kant (se .ic-menu-open i css'en).
function _icCloseAllCardMenus(root) {
    root = root || document;
    var open = root.querySelectorAll('[data-menu].ic-visible');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('ic-visible');
    var cards = root.querySelectorAll('.ic-card.ic-menu-open');
    for (var j = 0; j < cards.length; j++) cards[j].classList.remove('ic-menu-open');
}

function _icToggleCardMenu(card) {
    var menu = card.querySelector('[data-menu]');
    if (!menu) return;
    var willOpen = !menu.classList.contains('ic-visible');
    _icCloseAllCardMenus(_icContainer);
    if (willOpen) {
        menu.classList.add('ic-visible');
        card.classList.add('ic-menu-open');
    }
}

// Beslutning fra menuen. Skrives IKKE nu - først ved commit, som alt andet
// (spec 3: intet går til lageret før "Gem og luk").
function _icDecide(productId, kind) {
    if (kind === 'discontinued') {
        // String-sammenligning som i slutskærmen: Grocy kan returnere id som
        // streng, og netop her skal navnet frem — det er den ene destruktive
        // handling i modulet.
        var p = _ic.products.find(function(x) { return String(x.id) === String(productId); });
        var navn = p ? p.name : 'Varen';
        if (!confirm('Bruger I slet ikke "' + navn + '" mere?\n\n' +
                     'Lageret sættes til 0, og varen tages af listerne, når du gemmer.')) return;
    }
    if (kind === null) delete _ic.decisions[productId];
    else _ic.decisions[productId] = kind;
    _icSaveCounts();
    _icRenderProducts();
    _icUpdateProgress();
}

// ════════════════════════════════════════════════════════════
// MÆNGDEFELTER (§14.6) — tæl i flere enheder på én gang
//
// "3 kasser, en åbnet kasse og nogle løse stykker" tastes som tre tal, ikke
// som 3,06 kasser. Komponenten er den samme som varemodtagelsen og
// lageroversigten bruger (shared/mangde_felter.js), så de tre skærme ikke
// kan blive uenige om hvilke enheder en vare kan tælles i.
//
// Brøkknapperne (¼ ½ ¾) er væk. Deres betydning skiftede med enheden
// (en kvart kasse eller en kvart af hele lageret?), og det spørgsmål
// forsvinder når det åbnede bare tælles i den fine enhed.
// ════════════════════════════════════════════════════════════

// Byg felterne ind i et kort. Kaldes ved oprettelse og ved "Fortryd" — kortet
// bygges forfra ved hver render, så der er ingen tilstand at bære over.
function _icMountCount(card, product, defaultVal) {
    var host = card && card.querySelector('.ic-mf-host');
    if (!host || typeof window === 'undefined' || !window.MangdeFelter) return;

    var opts = _icCountUnitOptions(product);
    var pick = _icPickCountUnit(product, opts);
    var stockNm = (_ic.grocyStock[product.id] && _ic.grocyStock[product.id].unit) ||
                  _ic.quantityUnits[product.qu_id_stock] || '';

    // Forudfyldt med det forventede tal i den enhed man plejer at tælle i —
    // som det ene felt altid har været. "Gem" uden at røre noget er derfor
    // stadig "tallet passer".
    var start = [];
    if (pick && defaultVal > 0) {
        start.push({ qu_id: pick.quId, qty: _icRound(defaultVal / (pick.toStock || 1)) });
    }

    var sumEl   = card.querySelector('.ic-mf-sum');
    var deltaEl = card.querySelector('.ic-mf-delta');
    var expected = _icRound(defaultVal || 0);

    var felter = window.MangdeFelter.create({
        product: {
            id: product.id,
            qu_id_stock: product.qu_id_stock,
            qu_id_purchase: product.qu_id_purchase,
            qu_id_consume: product.qu_id_consume
        },
        conversions: _ic.conversions || [],
        unitNames: _ic.quantityUnits || {},
        focusQuId: pick ? pick.quId : product.qu_id_stock,
        stockUnitName: stockNm,
        entries: start,
        compact: true,
        onChange: function(poster, total) {
            // Summen i lager-enhed: det er dét der skrives. Ved ét felt er
            // tallet og summen det samme, og så gentages det ikke.
            if (sumEl) {
                sumEl.textContent = (poster.length > 1 || (poster[0] && poster[0].factor_used !== 1))
                    ? '= ' + _icFmt(total, 3) + ' ' + stockNm : '';
            }
            // Forskellen til det forventede kan SES før man trykker Gem. Ren
            // oplysning, ikke en advarsel: et stort minus kan lige så godt
            // betyde at der er brugt meget.
            if (deltaEl) {
                var d = Math.round((total - expected) * 1e6) / 1e6;
                deltaEl.textContent = !poster.length
                    ? 'tomt · forventet ' + _icFmt(expected) + ' ' + stockNm
                    : (d === 0 ? 'som forventet'
                       : (d > 0 ? '+' : '−') + _icFmt(Math.abs(d), 3) + ' ' + stockNm +
                         ' i forhold til forventet ' + _icFmt(expected));
            }
        }
    });
    host.innerHTML = '';
    host.appendChild(felter.el);
    card._icMf = felter;

    // ± ind i felt-rækken, og de rammer det MARKEREDE felt. Fokus alene duer
    // ikke: den forsvinder i samme øjeblik man trykker på en pil. Samme
    // greb som lageroversigten.
    var raekke = felter.el.querySelector('.mf-row');
    var ned = card.querySelector('.ic-qty-btn[data-action="minus"]');
    var op  = card.querySelector('.ic-qty-btn[data-action="plus"]');
    if (!raekke) return;
    if (ned) raekke.insertBefore(ned, raekke.firstChild);
    if (op) raekke.appendChild(op);

    var feltEls = [].slice.call(raekke.querySelectorAll('.mf-field'));
    function markér(felt) {
        for (var i = 0; i < feltEls.length; i++) {
            feltEls[i].classList.toggle('ic-mf-aktiv', feltEls[i] === felt);
        }
        var enhed = felt && felt.querySelector('.mf-unit');
        var navn = enhed ? enhed.textContent : '';
        if (ned) ned.title = 'Minus 1 ' + navn;
        if (op) op.title = 'Plus 1 ' + navn;
    }
    raekke.addEventListener('focusin', function(ev) {
        var felt = ev.target && ev.target.closest && ev.target.closest('.mf-field');
        if (felt) markér(felt);
    });
    // Enter i et felt = Gem, som det ene felt altid har gjort.
    raekke.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            _icConfirmCount(parseInt(card.dataset.productId));
        }
    });
    markér(feltEls[0]);
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

// ± rammer det markerede felt — ikke altid det første.
function _icAdjustQty(productId, delta) {
    var card = _icContainer && _icContainer.querySelector('[data-product-id="' + productId + '"]');
    var input = card && (card.querySelector('.ic-mf-aktiv .mf-input') ||
                         card.querySelector('.mf-input'));
    if (!input) return;
    window.MangdeFelter.step(input, delta);
}

function _icCancelExpand(productId) {
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (!card) return;
    card.classList.remove('ic-open');
    // Tilbage til det forventede tal — kortet er bygget til at kunne
    // monteres forfra.
    var full = (_ic.productsById && _ic.productsById[productId]) ||
               _ic.products.find(function(p) { return String(p.id) === String(productId); }) || { id: productId };
    _icMountCount(card, full, _icDefaultCount(productId));
}

// Det tal kortet forventer i DENNE fysiske enhed: resten hvis varen er talt
// andre steder, ellers hele lageret.
function _icDefaultCount(productId) {
    var grocyAmount  = _icRound(_ic.grocyStock[productId] ? _ic.grocyStock[productId].amount : 0);
    var countData    = _ic.counts[productId];
    var totalCounted = _icRound(countData ? (countData.total || 0) : 0);
    var remaining    = _icRound(grocyAmount - totalCounted);
    return remaining > 0 ? remaining : grocyAmount;
}

function _icConfirmCount(productId) {
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    var mf = card && card._icMf;
    if (!mf) {
        // Tidligere kastede dette en tavs TypeError → optællingen "gemte ikke".
        _icAlert('Kunne ikke gemme — prøv at klikke varen op igen', 'error');
        return;
    }
    // Grocy får ALTID lagerenheden (§14.4): hvert felt bærer sin faktor, og
    // summen af qty × factor_used er det eneste tal der skrives.
    var entries = mf.entries();
    var amount  = window.MangdeFelter.stockSum(entries);

    // Den enhed der bar mest af tællingen huskes til næste gang, i netop
    // denne fysiske enhed (§14.3) — det uåbnede i kasser, ikke de løse stk.
    if (entries.length) {
        var bedst = entries.slice().sort(function(a, b) {
            return (b.qty * b.factor_used) - (a.qty * a.factor_used);
        })[0];
        _icRememberCountUnit(productId, bedst.qu_id);
    }
    _icSaveCount(productId, amount, entries);
}

// entries: [{qu_id, qty, factor_used}] — HVAD der blev tastet (§14.4).
// Udelades de (✔ "tallet passer"), gemmes tallet som én post i lager-enheden
// med faktor 1 — det er sandt, og §15.11 kræver faktoren også dér.
function _icSaveCount(productId, amount, entries) {
    amount = _icRound(amount);

    if (!_ic.counts[productId]) {
        _ic.counts[productId] = { units: {}, total: 0 };
    }

    var c = _ic.counts[productId];
    c.units[_ic.physicalUnit] = amount;
    if (!c.entries) c.entries = {};
    c.entries[_ic.physicalUnit] = Array.isArray(entries) ? entries : _icStockEntries(productId, amount);
    // Hvilken fysisk enhed varen sidst blev talt i → bliver LastCheckedUnit ved commit (Bug 1).
    c.lastUnit = _ic.physicalUnit;
    // Concurrency-baseline (§6): Grocy-mængden brugeren SÅ da hun talte. Fanges én gang
    // (første tælling i sessionen) så den overlever recount + enhedsskift. Ved commit
    // sammenlignes den mod frisk lager for at opdage at Grocy har flyttet sig under sessionen.
    if (c.grocyAtCount === undefined) {
        c.grocyAtCount = _ic.grocyStock[productId] ? _icRound(_ic.grocyStock[productId].amount) : 0;
    }

    // Recalculate total
    var sum = 0;
    var units = c.units;
    for (var u in units) {
        if (units.hasOwnProperty(u)) sum += units[u];
    }
    c.total = _icRound(sum);

    _icSaveCounts();

    // Bug 1: LastCheckedAt/LastCheckedUnit skrives IKKE her længere — kun ved commit
    // (_icSaveAllToGrocy), og kun for varer der faktisk blev talt. En afbrudt session
    // efterlader dermed ingen spor i Grocy.

    // Alt ovenfor er ren state. DOM-delen springes over uden container (Node-tests),
    // så tælle-logikken kan verificeres uden en browser.
    if (!_icContainer) return;

    // Animate card out then re-render
    var card = _icContainer.querySelector('[data-product-id="' + productId + '"]');
    if (card) card.classList.add('ic-hiding');

    setTimeout(function() {
        _icRenderProducts();
        _icUpdateProgress();
    }, 300);
}

function _icStockEntries(productId, amount) {
    if (!(amount > 0)) return [];
    var p = (_ic.productsById && _ic.productsById[productId]) ||
            (_ic.products || []).find(function(x) { return String(x.id) === String(productId); });
    var qu = p && p.qu_id_stock;
    if (qu === undefined || qu === null) return null;   // ukendt lager-enhed → ingen poster
    return [{ qu_id: parseInt(qu), qty: amount, factor_used: 1 }];
}

// Alle poster for en vare på tværs af de fysiske enheder den er talt i.
// Serveren summerer dem med SINE egne omregninger (#658), så et tal regnet
// med en forældet faktor i browseren ikke kan skrives.
//
// Mangler én enhed sine poster — en session fra før felterne kom — sendes
// ingen: en delvis liste ville give serveren et for lille tal, uden en fejl.
function _icCommitEntries(productId) {
    var c = _ic.counts[productId];
    if (!c || !c.units) return null;
    var out = [];
    for (var u in c.units) {
        if (!c.units.hasOwnProperty(u)) continue;
        var e = c.entries && c.entries[u];
        if (!Array.isArray(e)) return null;
        for (var i = 0; i < e.length; i++) out.push(e[i]);
    }
    return out;
}

// Skrives KUN ved commit (Bug 1), pr. talt vare, med den enhed varen blev talt i.
async function _icUpdateLastChecked(productId, unitName) {
    try {
        await putGrocyProductUserfields(productId, {
            LastCheckedAt: new Date().toISOString(),
            LastCheckedUnit: unitName || _ic.physicalUnit
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

// ── Commit-hjælpere (delt af summary-visning + gem-alle) ─────────────
// Frisk lager: fresh-fetch, fald tilbage til session-snapshot ved netværksfejl.
async function _icFetchFreshStock() {
    try {
        var stockData = await fetchGrocyStock();
        var m = {};
        stockData.forEach(function(item) { m[String(item.product_id)] = parseFloat(item.amount) || 0; });
        return m;
    } catch (e) {
        return null;
    }
}
function _icFreshAmountFor(freshStock, pid) {
    if (freshStock && Object.prototype.hasOwnProperty.call(freshStock, String(pid))) {
        return freshStock[String(pid)];
    }
    return _ic.grocyStock[pid] ? _ic.grocyStock[pid].amount : 0;
}
// Klassificér en talt vare mod frisk lager. Delt sandhed for summary og commit,
// så de aldrig divergerer.
function _icClassifyCounted(product, freshStock) {
    var countData = _ic.counts[product.id];
    if (!countData || !countData.units || Object.keys(countData.units).length === 0) return null;
    var total    = _icRound(countData.total || 0);
    var grocyNow = _icRound(_icFreshAmountFor(freshStock, product.id));
    var baseline = (countData.grocyAtCount === undefined) ? null : _icRound(countData.grocyAtCount);
    // §6: Grocy har flyttet sig siden brugeren talte → konflikt (medmindre afklaret).
    var conflict = baseline !== null && Math.abs(grocyNow - baseline) > 0.01 && !countData.conflictResolved;
    return {
        total: total, grocyNow: grocyNow, baseline: baseline,
        conflict: conflict, resolved: countData.conflictResolved || null,
        needsWrite: Math.abs(total - grocyNow) > 0.01,
        lastUnit: countData.lastUnit || _ic.physicalUnit,
        countsByUnit: countData.units
    };
}

async function _icShowSummary() {
    var overlay = _icContainer.querySelector('#icSummaryOverlay');
    var body    = _icContainer.querySelector('#icSummaryBody');
    var locEl   = _icContainer.querySelector('#icSummaryLoc');
    locEl.textContent = _ic.locationName;
    overlay.classList.add('ic-visible');
    body.innerHTML = '<p style="padding:20px;color:var(--color-text-dim);">Henter frisk lager fra Grocy…</p>';

    // §6 — sammenlign altid mod Grocys NUVÆRENDE beholdning (auto-forbrug kan have drevet
    // lageret under sessionen). Gemmes så commit bruger nøjagtig samme snapshot.
    var freshStock = await _icFetchFreshStock();
    _ic._commitFresh = freshStock;

    var conflicts = [];
    var discrepancies = [];
    var notFound = [];
    var okItems = [];

    _ic.products.forEach(function(product) {
        var _si = _ic.grocyStock[product.id];
        var unitName = (_si && _si.unit) ? _si.unit : (_ic.quantityUnits[product.qu_id_stock] || '');
        var cls = _icClassifyCounted(product, freshStock);

        if (!cls) {
            var grocyAmount = _icRound(_icFreshAmountFor(freshStock, product.id));
            if (grocyAmount > 0) {
                notFound.push({ id: product.id, name: product.name, grocyAmount: grocyAmount, unitName: unitName });
            }
            return;
        }

        if (cls.conflict) {
            conflicts.push({ id: product.id, name: product.name, unitName: unitName, cls: cls });
        } else if (cls.resolved) {
            // afklaret konflikt — vis i konflikt-sektionen med sin resolution
            conflicts.push({ id: product.id, name: product.name, unitName: unitName, cls: cls });
        } else if (cls.needsWrite) {
            discrepancies.push({
                id: product.id, name: product.name,
                grocyAmount: cls.grocyNow, countedAmount: cls.total,
                difference: _icRound(cls.total - cls.grocyNow),
                unitName: unitName, countsByUnit: cls.countsByUnit
            });
        } else {
            okItems.push({ id: product.id, name: product.name, grocyAmount: cls.grocyNow, unitName: unitName });
        }
    });

    var pendingConflicts = conflicts.filter(function(c) { return c.cls.conflict; }).length;

    var html =
        '<div class="ic-stats-row">' +
            '<div class="ic-stat-card"><div class="ic-stat-number">' + Object.keys(_ic.counts).length + '</div><div class="ic-stat-label">Varer talt</div></div>' +
            (conflicts.length > 0 ? '<div class="ic-stat-card"><div class="ic-stat-number" style="color:' + (pendingConflicts > 0 ? 'var(--color-red)' : 'var(--color-green)') + '">' + pendingConflicts + '</div><div class="ic-stat-label">Tallet ændret</div></div>' : '') +
            '<div class="ic-stat-card"><div class="ic-stat-number" style="color:' + (discrepancies.length > 0 ? 'var(--color-orange)' : 'var(--color-green)') + '">' + discrepancies.length + '</div><div class="ic-stat-label">Afvigelser</div></div>' +
            '<div class="ic-stat-card"><div class="ic-stat-number" style="color:' + (notFound.length > 0 ? 'var(--color-red)' : 'var(--color-green)') + '">' + notFound.length + '</div><div class="ic-stat-label">Ikke talt</div></div>' +
        '</div>';

    if (conflicts.length > 0) {
        html += '<div class="ic-summary-section"><h3>&#9888; Tallet har ændret sig, mens du talte (' + conflicts.length + ')</h3>' +
            '<p style="color:var(--color-text-dim);font-size:13px;">Lagertallet er blevet ændret, efter du talte disse varer — måske har en anden rettet det, eller en bon er blevet leveret imens. Vælg for hver vare, hvilket tal der er rigtigt.</p>';
        conflicts.forEach(function(item) {
            var c = item.cls;
            var actions;
            if (c.resolved === 'override') {
                actions = '<span style="color:var(--color-orange);font-weight:600;">Bruger dit tal</span>';
            } else if (c.resolved === 'keep') {
                actions = '<span style="color:var(--color-text-dim);font-weight:600;">Beholder lagerets tal</span>';
            } else {
                actions =
                    '<button class="ic-btn-correct" data-override="' + item.id + '">Mit tal er rigtigt (' + _icFmt(c.total) + ')</button>' +
                    '<button class="ic-btn-add-shop" data-keep="' + item.id + '">Lagerets tal er rigtigt (' + _icFmt(c.grocyNow) + ')</button>';
            }
            html +=
                '<div class="ic-summary-item ic-disc" data-product-id="' + item.id + '">' +
                    '<div class="ic-summary-item-name">' + esc(item.name) + '</div>' +
                    '<div class="ic-summary-item-detail">' +
                        'Da du talte stod der: ' + _icFmt(c.baseline) + ' &rarr; nu står der: ' + _icFmt(c.grocyNow) + ' ' + esc(item.unitName) + '<br>' +
                        '<small>Du talte: ' + _icFmt(c.total) + '</small>' +
                    '</div>' +
                    '<div class="ic-summary-item-actions">' + actions + '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    if (discrepancies.length > 0) {
        html += '<div class="ic-summary-section"><h3>Afvigelser (' + discrepancies.length + ')</h3>';
        discrepancies.forEach(function(item) {
            var sign = item.difference > 0 ? '+' : '';
            var unitsDetail = Object.keys(item.countsByUnit).map(function(u) {
                return u + ': ' + _icFmt(item.countsByUnit[u]);
            }).join(', ');

            html +=
                '<div class="ic-summary-item ic-disc" data-product-id="' + item.id + '">' +
                    '<div class="ic-summary-item-name">' + esc(item.name) + '</div>' +
                    '<div class="ic-summary-item-detail">' +
                        'På lageret: ' + _icFmt(item.grocyAmount) + ' &rarr; Du talte: ' + _icFmt(item.countedAmount) + ' (' + sign + _icFmt(item.difference) + ') ' + esc(item.unitName) + '<br>' +
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
        html += '<div class="ic-summary-section"><h3>Ikke talt (' + notFound.length + ')</h3>' +
            '<p style="color:var(--color-text-dim);font-size:12px;margin:0 0 8px;">Disse varer står på lageret, men du har ikke talt dem. Fandt du dem alligevel? Skriv hvor meget der er, og tryk Ret. Er de v&aelig;k, tryk »S&aelig;t til 0«.</p>';
        notFound.forEach(function(item) {
            html +=
                '<div class="ic-summary-item ic-miss" data-product-id="' + item.id + '">' +
                    '<div class="ic-summary-item-name">' + esc(item.name) + '</div>' +
                    '<div class="ic-summary-item-detail">På lageret: ' + _icFmt(item.grocyAmount) + ' ' + esc(item.unitName) + '</div>' +
                    '<div class="ic-summary-item-actions">' +
                        '<input class="ic-nf-amount" data-nf-input="' + item.id + '" inputmode="decimal" placeholder="antal" ' +
                            'style="width:70px;height:32px;border:1px solid var(--color-border);border-radius:8px;text-align:center;font-size:14px;">' +
                        '<button class="ic-btn-correct" data-correct-input="' + item.id + '">Ret</button>' +
                        '<button class="ic-btn-correct" data-correct="' + item.id + '" data-amount="0">Sæt til 0</button>' +
                        '<button class="ic-btn-add-shop" data-shop="' + item.id + '">Indkøb</button>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    // Beslutninger fra kortets menu - vises samlet, så man ser hvad man har
    // besluttet undervejs før det bliver skrevet.
    var decided = Object.keys(_ic.decisions || {});
    if (decided.length > 0) {
        html += '<div class="ic-summary-section"><h3>Ændringer til varerne (' + decided.length + ')</h3>';
        decided.forEach(function(pid) {
            var p = _ic.products.find(function(x) { return String(x.id) === String(pid); });
            var kind = _ic.decisions[pid];
            var tekst = kind === 'discontinued'
                ? 'Sættes til 0 og tages af listerne'
                : 'Bliver ikke husket til fast optælling';
            html +=
                '<div class="ic-summary-item ' + (kind === 'discontinued' ? 'ic-miss' : 'ic-disc') + '">' +
                    '<div class="ic-summary-item-name">' + esc(p ? p.name : ('Vare ' + pid)) + '</div>' +
                    '<div class="ic-summary-item-detail">' + tekst + '</div>' +
                    '<div class="ic-summary-item-actions">' +
                        '<button class="ic-btn-add-shop" data-undecide="' + pid + '">Fortryd</button>' +
                    '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    if (okItems.length > 0) {
        html += '<div class="ic-summary-section"><h3>OK (' + okItems.length + ')</h3>' +
            '<p style="color:var(--color-text-dim);font-size:13px;">' + okItems.length + ' varer stemmer med lageret</p></div>';
    }

    body.innerHTML = html;

    // Delegate clicks — bind KUN én gang (summary re-renderes ved konflikt-afklaring).
    if (!body.dataset.icBound) {
        body.dataset.icBound = '1';
        body.addEventListener('click', function(e) {
            var overrideBtn = e.target.closest('[data-override]');
            if (overrideBtn) { _icResolveConflict(parseInt(overrideBtn.dataset.override), 'override'); return; }
            var keepBtn = e.target.closest('[data-keep]');
            if (keepBtn) { _icResolveConflict(parseInt(keepBtn.dataset.keep), 'keep'); return; }
            var undecideBtn = e.target.closest('[data-undecide]');
            if (undecideBtn) {
                delete _ic.decisions[undecideBtn.dataset.undecide];
                _icSaveCounts();
                _icShowSummary();
                return;
            }
            // "Ret" på en ikke-fundet vare: skriv den faktiske optalte mængde fra input-feltet.
            var correctInputBtn = e.target.closest('[data-correct-input]');
            if (correctInputBtn) {
                var pid = parseInt(correctInputBtn.dataset.correctInput);
                var inp = body.querySelector('[data-nf-input="' + pid + '"]');
                var raw = inp ? String(inp.value).trim() : '';
                if (raw === '' || isNaN(parseFloat(raw.replace(',', '.')))) {
                    _icAlert('Skriv en mængde først', 'warning');
                    if (inp) inp.focus();
                    return;
                }
                _icCorrectInventory(pid, _icParseNum(raw));   // komma → punktum før Grocy
                return;
            }
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
    }
}

// §6 — brugeren afklarer en konflikt: 'override' (skriv min optælling ved commit) eller
// 'keep' (behold Grocys tal, glem min optælling for denne vare).
function _icResolveConflict(productId, mode) {
    var c = _ic.counts[productId];
    if (!c) return;
    c.conflictResolved = mode;
    _icSaveCounts();
    _icShowSummary();   // re-render med opdateret status
}

function _icCloseSummary() {
    _icContainer.querySelector('#icSummaryOverlay').classList.remove('ic-visible');
}

// ════════════════════════════════════════════════════════════
// GROCY ACTIONS
// ════════════════════════════════════════════════════════════

async function _icCorrectInventory(productId, newAmount) {
    try {
        // Bug 2 — ingen best-before: Grocy bevarer eksisterende batches og daterer et evt.
        // surplus via produktets default_best_before_days (verificeret mod grocytest).
        await postGrocyInventory(productId, newAmount);
        // Stempl som tjekket (observeret) — samme userfield-skrivning som commit (Bug 1).
        var _cc = _ic.counts[productId];
        await _icUpdateLastChecked(productId, (_cc && _cc.lastUnit) ? _cc.lastUnit : _ic.physicalUnit);
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
            note:       'Manglede ved optælling ' + new Date().toLocaleDateString('da-DK')
        }]);

        _icAlert((product ? product.name : 'Produkt') + ' tilføjet til indkøbsliste', 'success');

        var item = _icContainer.querySelector('.ic-summary-item[data-product-id="' + productId + '"]');
        if (item) {
            var btn = item.querySelector('[data-shop]');
            if (btn) { btn.textContent = 'Tilføjet'; btn.disabled = true; }
        }
    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
    }
}

// ── Commit: plan → udfør → besked → UI ──────────────────────────
// Delt op så den mest sikkerhedskritiske kode i modulet kan køres uden en
// browser. Før lå skrivninger og DOM-opdateringer i samme funktion, og så
// kunne commit-stien kun nås gennem brugerfladen — dvs. reelt kun testes i
// hånden. T_OPTAELLING injicerer nu attrap-Grocy og asserterer hvilke kald
// der faktisk fyrer.

// Ren: hvad SKAL der skrives? Rører hverken Grocy eller DOM.
function _icPlanCommit(freshStock) {
    var toWrite = [];
    var pendingConflicts = 0;
    var keepCount = 0;

    _ic.products.forEach(function(product) {
        var cls = _icClassifyCounted(product, freshStock);
        if (!cls) return;                                     // ikke talt
        // §6 — konflikt-gate: en vare hvor Grocy har flyttet sig siden brugeren
        // talte, og som ikke er afklaret, må IKKE overskrives tavst.
        if (cls.conflict) { pendingConflicts++; return; }
        if (cls.resolved === 'keep') { keepCount++; return; } // behold lagerets tal
        toWrite.push({ id: product.id, cls: cls });
    });

    return {
        toWrite: toWrite,
        pendingConflicts: pendingConflicts,
        keepCount: keepCount,
        decisionIds: Object.keys(_ic.decisions || {})
    };
}

// Udfører planen mod Grocy. Ingen DOM — returnerer hvad der lykkedes.
async function _icExecuteCommit(plan) {
    var invWritten = 0, invFailed = 0;

    for (var i = 0; i < plan.toWrite.length; i++) {
        var it = plan.toWrite[i];
        // Bug 2 — ingen best-before (Grocy bevarer eksisterende batches og
        // daterer surplus via default_best_before_days).
        if (it.cls.needsWrite) {
            try {
                var poster = _icCommitEntries(it.id);
                if (poster && poster.length) await postGrocyInventory(it.id, it.cls.total, undefined, poster);
                else await postGrocyInventory(it.id, it.cls.total);
                invWritten++;
            } catch (err) {
                console.error('Failed to update ' + it.id + ':', err);
                invFailed++;
                continue;   // spring stemplingen over hvis lager-skrivningen fejlede
            }
        }
        // Bug 1 — LastCheckedAt/LastCheckedUnit skrives KUN her, kun for varer
        // der faktisk blev talt. _icUpdateLastChecked sluger egne fejl.
        await _icUpdateLastChecked(it.id, it.cls.lastUnit);
    }

    // Beslutninger fra kortets menu — først her, som alt andet (spec §3).
    var notrackDone = 0, discDone = 0, decFailed = 0, sporFejl = 0;
    for (var d = 0; d < plan.decisionIds.length; d++) {
        var dpid = parseInt(plan.decisionIds[d]);
        var kind = _ic.decisions[plan.decisionIds[d]];
        try {
            if (kind === 'notrack') {
                // Tom HverDag = passiv vare: stiger aldrig til tops i sorteringen.
                var svarN = await putGrocyProductUserfields(dpid, { HverDag: '' }, 'optaelling');
                if (svarN && svarN.log_error) sporFejl++;   // #666: gemt, men ikke i historikken
                notrackDone++;
            } else if (kind === 'discontinued') {
                await postGrocyInventory(dpid, 0);
                var svarD = await putGrocyProduct(dpid, { active: 0 }, 'optaelling');
                if (svarD && svarD.log_error) sporFejl++;
                discDone++;
            }
        } catch (err) {
            console.error('Beslutning fejlede for ' + dpid + ':', err);
            decFailed++;
        }
    }

    return {
        invWritten: invWritten, invFailed: invFailed,
        notrackDone: notrackDone, discDone: discDone, decFailed: decFailed,
        sporFejl: sporFejl
    };
}

// Ren: kvitteringsteksten. Sproget følger §7 — sig hvad der skete for
// brugeren, ikke hvad systemet gjorde.
function _icCommitMessage(plan, res) {
    var dele = [];
    if (res.invWritten > 0)  dele.push(res.invWritten + ' vare' + (res.invWritten === 1 ? '' : 'r') + ' rettet på lageret');
    if (plan.toWrite.length) dele.push(plan.toWrite.length + ' sat som talt');
    if (plan.keepCount > 0)  dele.push(plan.keepCount + ' beholdt lagerets tal');
    if (res.notrackDone > 0) dele.push(res.notrackDone + ' tælles ikke fast mere');
    if (res.discDone > 0)    dele.push(res.discDone + ' taget af listerne');
    var tekst = 'Gemt. ' + (dele.length ? dele.join(', ') : 'Ingen ændringer') + '.';
    // #666: beslutningen ER gemt, men står ikke i varens historik. Det skal
    // man vide — det var netop et spor der manglede, der gjorde kål-sagen svær.
    if (res.sporFejl > 0) tekst += ' ' + res.sporFejl + ' ændring' + (res.sporFejl === 1 ? '' : 'er') +
        ' blev ikke skrevet i varens historik.';
    return tekst;
}

// Ren: fejlteksten. Skeln de to slags — en lager-skrivning der fejlede er
// noget andet end en vare der ikke kunne tages af listerne.
function _icCommitErrorMessage(res) {
    var fejl = [];
    if (res.invFailed > 0) fejl.push(res.invFailed + ' lager-rettelse' + (res.invFailed === 1 ? '' : 'r'));
    if (res.decFailed > 0) fejl.push(res.decFailed + ' ændring til varerne');
    return res.invWritten + ' gemt, men ' + fejl.join(' og ') + ' fejlede';
}

async function _icSaveAllToGrocy() {
    // Genbrug det friske lager fra summary-visningen (fanget for sekunder siden);
    // fald tilbage til en frisk fetch hvis det mangler. Samme snapshot → summary
    // og commit divergerer aldrig.
    var freshStock = _ic._commitFresh || await _icFetchFreshStock();
    var plan = _icPlanCommit(freshStock);

    if (plan.pendingConflicts > 0) {
        _icAlert(plan.pendingConflicts + ' vare(r) har fået et nyt lagertal, mens du talte. Vælg øverst hvilket tal der er rigtigt, før du gemmer.', 'warning');
        return;
    }

    if (plan.toWrite.length === 0 && plan.decisionIds.length === 0) {
        _icAlert('Der er ikke noget at gemme', 'info');
        _ic._commitFresh = null;
        _icClearCounts();
        _icCloseSummary();
        _icResetUI();
        return;
    }

    _icAlert('Gemmer...', 'info');
    var res = await _icExecuteCommit(plan);

    if (res.invFailed > 0 || res.decFailed > 0) {
        _icAlert(_icCommitErrorMessage(res), 'warning');
        return;
    }

    var msg = _icCommitMessage(plan, res);
    _icAlert(msg, 'success');

    // Kvitteringen bliver stående til den lukkes — en 3-sekunders toast er væk
    // før man har nået at læse den (spec §7).
    _icSaveReceipt(msg);
    var rEl = _icContainer && _icContainer.querySelector('#icReceipt');
    if (rEl) {
        _icContainer.querySelector('#icReceiptText').textContent = msg;
        rEl.classList.add('ic-visible');
    }

    _ic._commitFresh = null;
    _icClearCounts();
    _icCloseSummary();
    _icResetUI();
}

async function _icAddAllToShopping() {
    var missing = [];

    _ic.products.forEach(function(product) {
        var grocyAmount = _ic.grocyStock[product.id] ? _ic.grocyStock[product.id].amount : 0;
        var countData = _ic.counts[product.id];

        if (grocyAmount > 0 && (!countData || !countData.units || Object.keys(countData.units).length === 0)) {
            missing.push({ product_id: product.id, amount: grocyAmount, note: 'Manglede ved optælling ' + new Date().toLocaleDateString('da-DK') });
        }
    });

    if (missing.length === 0) {
        _icAlert('Ingen manglende varer', 'info');
        return;
    }

    _icAlert('Tilføjer ' + missing.length + ' varer til indkøbsliste...', 'info');

    try {
        await postGrocyShoppingList(missing);
        _icAlert(missing.length + ' varer tilføjet til indkøbsliste', 'success');
    } catch (err) {
        _icAlert('Fejl: ' + err.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// ADD UNEXPECTED PRODUCT
// ════════════════════════════════════════════════════════════

function _icShowAddProduct() {
    _icContainer.querySelector('#icAddSearch').value = '';

    // Lokations-filter fyldes fra Grocys lokationer (varen kan ligge hvor som helst
    // — det er netop derfor den ikke stod på listen).
    var locSel = _icContainer.querySelector('#icAddLocFilter');
    locSel.innerHTML = '<option value="">Alle lokationer</option>' +
        (_ic.locations || []).map(function(l) {
            return '<option value="' + l.id + '">' + esc(l.name) + '</option>';
        }).join('');
    locSel.value = '';

    _icFilterAddProducts();
    _icContainer.querySelector('#icAddOverlay').classList.add('ic-visible');
    _icContainer.querySelector('#icAddSearch').focus();
}

function _icCloseAddProduct() {
    _icContainer.querySelector('#icAddOverlay').classList.remove('ic-visible');
}

function _icFilterAddProducts() {
    var search  = (_icContainer.querySelector('#icAddSearch').value || '').toLowerCase().trim();
    var locId   = _icContainer.querySelector('#icAddLocFilter').value;
    var listEl  = _icContainer.querySelector('#icAddList');
    var countEl = _icContainer.querySelector('#icAddCount');

    // Skjul kun det brugeren allerede KAN se i denne enhed. En vare der hører til
    // lokationen, men som listen tror står i en anden fysisk enhed, skal kunne
    // hentes frem — det er netop tilfældet "jeg fandt den her".
    var locUnits  = _icGetUnitsForLocation(_ic.locationId);
    var onScreen  = {};
    _ic.products.forEach(function(p) {
        var c = _ic.counts[p.id];
        var countedHere = c && c.units && c.units[_ic.physicalUnit] !== undefined;
        if (countedHere || _icVisibleInUnit(p, locUnits)) onScreen[p.id] = true;
    });

    // Alfabetisk — ellers kommer varerne i Grocys egen rækkefølge, og så er
    // det tilfældigt hvad man ser først.
    var all = _ic.allProducts.filter(function(p) {
        return !onScreen[p.id];
    }).sort(function(a, b) {
        return String(a.name).localeCompare(String(b.name), 'da');
    });

    // Ingen afkortning: hele listen er tilgængelig, ellers kan en vare uden for
    // de første par stykker kun findes hvis man gætter navnet.
    var available = all.filter(function(p) {
        if (search && p.name.toLowerCase().indexOf(search) === -1) return false;
        if (locId && String(p.location_id) !== locId) return false;
        return true;
    });

    if (countEl) {
        countEl.textContent = all.length === 0 ? '' :
            (available.length === all.length
                ? all.length + ' varer'
                : 'Viser ' + available.length + ' af ' + all.length);
    }

    if (available.length === 0) {
        listEl.innerHTML = '<p class="ic-add-empty">' +
            (all.length === 0 ? 'Alle varer er allerede på listen' : 'Ingen varer matcher') +
            '</p>';
        return;
    }

    listEl.innerHTML = available.map(function(p) {
        var loc = (_ic.locations || []).find(function(l) { return l.id == p.location_id; });
        return '<div class="ic-add-product-item" data-pid="' + p.id + '">' +
            '<span class="ic-add-product-name">' + esc(p.name) + '</span>' +
            '<span class="ic-add-product-loc">' + esc(loc ? loc.name : '-') + '</span>' +
            '</div>';
    }).join('');
}

function _icAddUnexpectedProduct(productId) {
    // Løst ==: id kommer som streng fra data-attributten, men kan være tal i _ic.
    var product = _ic.allProducts.find(function(p) { return String(p.id) === String(productId); });
    if (!product) return;

    // Varen kan allerede være i _ic.products (hører til lokationen, men ligger
    // efter listens mening i en anden fysisk enhed) — så må den ikke dubleres.
    var known = _ic.products.some(function(p) { return String(p.id) === String(product.id); });
    if (!known) _ic.products.push(product);

    // Gør den synlig i netop denne enhed (se _icVisibleInUnit).
    _ic.manualAdded[product.id] = _ic.physicalUnit;

    _icCloseAddProduct();
    _icRenderProducts();
    _icUpdateProgress();
    _icAlert(product.name + ' tilføjet til ' + _ic.physicalUnit, 'success');
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

// ── Tal: komma til mennesker, punktum til Grocy ──────────────────
// Verificeret mod grocytest: /stock/products/:id/inventory kræver et JSON-tal
// (float). En streng med komma afvises hårdt ("must be of type float, string
// given"). Derfor: ALDRIG _icFmt på noget der sendes til API'et eller gemmes i
// et data-attribut — kun på tekst mennesker læser.
function _icFmt(num, decimals) {
    if (num === null || num === undefined || num === '') return '';
    var n = (typeof num === 'number') ? num : parseFloat(String(num).replace(',', '.'));
    if (!isFinite(n)) return String(num);
    return String(_icRound(n, decimals)).replace('.', ',');
}

// Læser brugerindtastning: accepterer både "2,5" og "2.5" → 2.5 (JS-tal).
// parseFloat('2,5') giver 2 — derfor må rå parseFloat aldrig bruges på input.
function _icParseNum(v) {
    if (v === null || v === undefined) return 0;
    var n = parseFloat(String(v).trim().replace(',', '.'));
    return isFinite(n) ? n : 0;
}

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
            out.push({ factor: f, unit: _ic.quantityUnits[tq] || '', quId: tq });
        }
    });
    return out;
}

// ── Tælleenheder ────────────────────────────────────────────────
// Hvilke enheder må man tælle denne vare i? Lagerenheden altid først (så den er
// default hvis intet andet er husket), derefter købs-/forbrugsenhed hvor der
// findes en konvertering. `toStock` ganges på det indtastede tal før skrivning —
// Grocy modtager ALTID lagerenheden (spec §5).
function _icCountUnitOptions(product) {
    if (!product || !product.qu_id_stock) return [];
    // Samme regel som varemodtagelsen og lageroversigten — én kilde, så de
    // tre skærme ikke kan blive uenige om hvad en vare kan tælles i.
    // unitsFor tilbyder KUN enheder med en faktor til lager-enheden (#358).
    var MF = (typeof window !== 'undefined' && window.MangdeFelter) || null;
    if (!MF) {
        return [{ quId: product.qu_id_stock, name: _ic.quantityUnits[product.qu_id_stock] || '',
                  toStock: 1, isStock: true }];
    }
    var units = MF.unitsFor({
        product: product,
        conversions: _ic.conversions || [],
        unitNames: _ic.quantityUnits || {},
        focusQuId: product.qu_id_stock   // lager-enheden først, når intet er husket
    });
    return units.map(function(u) {
        return { quId: u.qu_id, name: u.name, toStock: u.factor, isStock: u.role === 'stock' };
    });
}

// Hvilken tælleenhed skal kortet åbne i? Sidst brugte i netop denne
// vare+enheds-kontekst, ellers lagerenheden.
function _icPickCountUnit(product, opts) {
    opts = opts || _icCountUnitOptions(product);
    if (!opts.length) return null;
    var pref = _icPreferredCountUnit(product.id);
    if (pref !== null) {
        var hit = opts.find(function(o) { return String(o.quId) === String(pref); });
        if (hit) return hit;
    }
    return opts[0];
}

function _icFormatDate(date) {
    if (!date) return '-';
    var d = new Date(date);
    var diffDays = Math.floor((new Date() - d) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'I dag';
    if (diffDays === 1) return 'I går';
    if (diffDays < 7) return diffDays + ' dage siden';
    return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

// CommonJS export guard — exposes pure functions to Node-based tests (T_STOCK).
// Browser ignores this block since `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _icParseIntervalDays: _icParseIntervalDays,
        _icComputeCheckStatus: _icComputeCheckStatus,
        _icGroupOf: _icGroupOf,
        _icVisibleInUnit: _icVisibleInUnit,
        _icClassifyCounted: _icClassifyCounted,
        _icCategorize: _icCategorize,
        _icFmt: _icFmt,
        _icParseNum: _icParseNum,
        _icFindFactor: _icFindFactor,
        _icAltConv: _icAltConv,
        _icGetUnitsForLocation: _icGetUnitsForLocation,
        // PR 2 — tælleenheder, session-nøgle og beslutninger
        _icCountUnitOptions: _icCountUnitOptions,
        _icPickCountUnit: _icPickCountUnit,
        _icCommitEntries: _icCommitEntries,
        _icDefaultCount: _icDefaultCount,
        _icMountCount: _icMountCount,
        _icConfirmCount: _icConfirmCount,
        _icCancelExpand: _icCancelExpand,
        _icAdjustQty: _icAdjustQty,
        _icSetContainer: function(el) { _icContainer = el; },
        _icLocalDate: _icLocalDate,
        _icSessionKey: _icSessionKey,
        _icSessionIsOld: _icSessionIsOld,
        _icSaveCount: _icSaveCount,
        // Commit-stien, splittet så den kan køres uden browser
        _icPlanCommit: _icPlanCommit,
        _icExecuteCommit: _icExecuteCommit,
        _icCommitMessage: _icCommitMessage,
        _icCommitErrorMessage: _icCommitErrorMessage,
        // Delt state-reference så tests kan opsætte syntetiske scenarier (T_OPTAELLING).
        _ic: _ic
    };
}
