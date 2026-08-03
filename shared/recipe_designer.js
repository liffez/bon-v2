/**
 * shared/recipe_designer.js
 * ════════════════════════════════════════════════════════════
 * Recipe Designer component for Bon v2.
 * Ported from bontools recipe-designer.html, adapted to bon-v2
 * architecture: MPA, vanilla JS, API via shared/api.js.
 *
 * Export: initRecipeDesigner(containerEl)
 * ═══════════════════════════════════════════���════════════════
 */

/* global fetchGrocyRecipesRaw, fetchGrocyProducts, fetchGrocyQuantityUnits,
          fetchGrocyStock, fetchGrocyRecipesPos, fetchGrocyRecipesNestings,
          fetchGrocyQuantityUnitConversions,
          postGrocyRecipe, putGrocyRecipe, putGrocyRecipeUserfields,
          postGrocyRecipePos, putGrocyRecipePos, deleteGrocyRecipePos,
          postGrocyRecipeNesting, putGrocyRecipeNesting, deleteGrocyRecipeNesting,
          esc */

// ════════════════════════════════════════════════════════════
// STATE
// ══════════��════════════════════���════════════════════════════

var _rdRecipes       = [];       // all recipes (with userfields)
var _rdRecipeMap     = {};       // recipe_id -> recipe
var _rdProducts      = [];       // raw products array
var _rdProductMap    = {};       // product_id -> product
var _rdQuantityUnits = {};       // qu_id -> unit name
var _rdStock         = {};       // product_id -> eget lager (stock-units)
var _rdChildrenByParent = {};    // parent_product_id -> [child product_id] (parent/child-lager)
var _rdQuConversions = [];       // unit conversions (raw)
var _rdAllPositions  = [];       // all recipe positions (raw)
var _rdAllNestings   = [];       // all nestings (raw)

var _rdContainer     = null;     // root DOM element
var _rdDataLoaded    = false;

// Designer state
var _rdDs = {
    mode: 'new',           // 'new' or 'modify'
    originalRecipeId: null,
    name: '',
    description: '',
    group: '',
    recipeUnit: 'stk',
    baseServings: 1,
    currentPortions: 1,
    ingredients: [],       // { id?, product_id, amount, qu_id, ingredient_group, note }
    nestings: [],          // { id?, includes_recipe_id, servings }
    removedIngIds: [],     // IDs to DELETE on save
    removedNestIds: [],
    dirty: false,
    workMin: null          // aktiv arbejdstid (min) pr. batch — userfield arbejdstid_min
};

var _rdVisibleCards       = new Set(['weight', 'stock']);

// ── Kalkulation (kostpris/avance) ──────────────────────────────
// ÉN kostpris: composition.total_cost = Grocy fulfillment (samme tal som office
// "Opskrifter & priser"). Per-ingrediens/underopskrift-kostpris + andel kommer fra
// samme kald. Designeren regner ALDRIG kostpris selv. Se CLAUDE_OPSKRIFT_KALKULATION.md.
var _rdComp        = null;    // { total_cost, ingredients:[{product_id,cost,ingredient_group}], sub_recipes:[{recipe_id,cost}] }
var _rdCompLoading = false;
var _rdLaborRate   = { rate: null, overhead_pct: 0, count: 0 };
var _rdTargets     = {};      // kategori -> DB%-mål (recipe_db_targets)
var _rdCalcLoaded  = false;   // labor-rate + targets hentet
var _rdPrice = {
    showLabor: true,
    dbTarget:  70,
    basis:     'full',        // 'full' (inkl. løn) | 'materials' (kun vareomkostning)
    priceCat:  'catering'
};

var _rdAddPanelOpen       = false;
var _rdAddNestingPanelOpen = false;
var _rdSelectedProduct    = null;
var _rdPickerSelectedGroup = 'Alle';

// Weight unit IDs cache
var _rdGramQuId  = null;
var _rdKiloQuId  = null;
var _rdWeightUnitsCached = false;

// ════════��══════════════════��════════════════════════════════
// PUBLIC: initRecipeDesigner
// ═════════════════���══════════════════════════════════════════

function initRecipeDesigner(containerEl) {
    _rdContainer = containerEl;
    if (_rdDataLoaded) {
        _rdShowStart();
        return;
    }
    _rdContainer.innerHTML = '<div class="rd-loading"><div class="rd-spinner"></div><p>Henter data...</p></div>';
    _rdLoadData();
}

// ═══════════════════════════════════════════════��════════════
// DATA LOADING
// ════════���═══════════════════════════════════════════════════

async function _rdLoadData(background) {
    try {
        var results = await Promise.all([
            fetchGrocyRecipesRaw(),
            fetchGrocyProducts(),
            fetchGrocyQuantityUnits(),
            fetchGrocyStock(),
            fetchGrocyRecipesPos(),
            fetchGrocyRecipesNestings(),
            fetchGrocyQuantityUnitConversions()
        ]);

        var rawRecipes   = results[0];
        var rawProducts  = results[1];
        var rawQus       = results[2];
        var rawStock     = results[3];
        var rawPos       = results[4];
        var rawNestings  = results[5];
        var rawConvs     = results[6];

        _rdRecipes = rawRecipes.map(function(r) {
            r._group   = (r.userfields && r.userfields.grupper) || 'Ingen kategori';
            r._unit    = (r.userfields && r.userfields.recipeunit) || 'stk';
            r._unitNum = (r.userfields && r.userfields.recipeunitnumber) || '1';
            return r;
        });

        _rdRecipeMap = {};
        _rdRecipes.forEach(function(r) { _rdRecipeMap[r.id] = r; });

        _rdProducts = rawProducts;
        _rdProductMap = {};
        rawProducts.forEach(function(p) { _rdProductMap[p.id] = p; });

        _rdQuantityUnits = {};
        rawQus.forEach(function(qu) { _rdQuantityUnits[qu.id] = qu.name; });

        _rdStock = {};
        rawStock.forEach(function(s) { _rdStock[s.product_id] = parseFloat(s.amount) || 0; });

        // Parent/child-lager: parent-produkter ("kål", no_own_stock=1) har eget lager
        // = 0, men børnene holder lageret. Ruller børnene op så visningen ikke viser
        // rødt "0" for et parent-produkt der reelt har rigeligt via børnene (#327).
        _rdChildrenByParent = {};
        rawProducts.forEach(function(p) {
            if (p.parent_product_id) {
                var par = parseInt(p.parent_product_id);
                if (!_rdChildrenByParent[par]) _rdChildrenByParent[par] = [];
                _rdChildrenByParent[par].push(parseInt(p.id));
            }
        });

        _rdAllPositions = rawPos;
        _rdAllNestings  = rawNestings;
        _rdQuConversions = rawConvs;

        _rdWeightUnitsCached = false;
        _rdGramQuId = null;
        _rdKiloQuId = null;

        _rdDataLoaded = true;
        _rdLoadCalcMeta();   // labor-rate + DB-mål (non-blocking)

        if (!background) {
            _rdShowStart();
        }

    } catch (err) {
        _rdContainer.innerHTML = '<div class="rd-alert rd-alert-error">Fejl ved hentning af data: ' + esc(err.message) + '</div>';
    }
}

// ═══════��═════════════════════════════════��══════════════════
// VIEWS — START SCREEN
// ════════════════════════════════════════════════════════════

function _rdShowStart() {
    _rdContainer.innerHTML = '' +
        '<div id="rdAlertBox"></div>' +
        '<div class="rd-view rd-visible" id="rdStartView">' +
            '<div class="rd-start-screen">' +
                '<div class="rd-start-title">Opskrift Designer</div>' +
                '<div class="rd-start-subtitle">Opret nye opskrifter eller tilpas eksisterende</div>' +
                '<div class="rd-mode-cards">' +
                    '<div class="rd-mode-card" id="rdCardModify">' +
                        '<div class="rd-mode-icon">&#x1F4DD;</div>' +
                        '<h2>Tilpas opskrift</h2>' +
                        '<p>Start fra en eksisterende opskrift. Juster ingredienser og m&#230;ngder.</p>' +
                    '</div>' +
                    '<div class="rd-mode-card" id="rdCardNew">' +
                        '<div class="rd-mode-icon">&#x2728;</div>' +
                        '<h2>Ny opskrift</h2>' +
                        '<p>Byg en opskrift fra bunden med live-beregninger af v&#230;gt og lager.</p>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="rd-view" id="rdPickerView"></div>' +
        '<div class="rd-view" id="rdDesignerView"></div>';

    document.getElementById('rdCardModify').addEventListener('click', _rdShowPicker);
    document.getElementById('rdCardNew').addEventListener('click', _rdStartNew);
}

// ═════���════════════════════════════════════════════════��═════
// VIEWS — RECIPE PICKER
// ════════��═══════════════════════��═══════════════════════════

function _rdShowPicker() {
    _rdSwitchView('rdPickerView');
    _rdPickerSelectedGroup = 'Alle';

    var view = document.getElementById('rdPickerView');
    view.innerHTML = '' +
        '<div style="padding:20px 24px;">' +
            '<div class="rd-section-header">' +
                '<h2>V&#230;lg opskrift</h2>' +
                '<button class="rd-back-link" id="rdPickerBack">&larr; Tilbage</button>' +
            '</div>' +
            '<input type="text" class="rd-search-input" placeholder="S&#248;g opskrifter..." id="rdPickerSearch">' +
            '<div class="rd-group-chips" id="rdPickerGroupChips"></div>' +
            '<ul class="rd-picker-list" id="rdPickerList"></ul>' +
        '</div>';

    document.getElementById('rdPickerBack').addEventListener('click', function() { _rdSwitchView('rdStartView'); });

    var searchInput = document.getElementById('rdPickerSearch');
    var debounce = null;
    searchInput.addEventListener('input', function() {
        clearTimeout(debounce);
        debounce = setTimeout(_rdRenderPickerList, 200);
    });

    _rdRenderPickerGroupChips();
    _rdRenderPickerList();
}

function _rdRenderPickerGroupChips() {
    var groupSet = {};
    _rdRecipes.forEach(function(r) {
        if (_rdIsActive(r)) groupSet[r._group] = true;
    });
    var groups = ['Alle'].concat(Object.keys(groupSet).sort(function(a, b) { return a.localeCompare(b, 'da'); }));

    var container = document.getElementById('rdPickerGroupChips');
    container.innerHTML = groups.map(function(g) {
        return '<span class="rd-group-chip' + (g === _rdPickerSelectedGroup ? ' rd-active' : '') +
               '" data-group="' + esc(g) + '">' + esc(g) + '</span>';
    }).join('');

    container.addEventListener('click', function(e) {
        var chip = e.target.closest('.rd-group-chip');
        if (!chip) return;
        _rdPickerSelectedGroup = chip.getAttribute('data-group');
        _rdRenderPickerGroupChips();
        _rdRenderPickerList();
    });
}

function _rdRenderPickerList() {
    var q = (document.getElementById('rdPickerSearch').value || '').toLowerCase();
    var recipes = _rdRecipes.filter(function(r) { return _rdIsActive(r); });

    if (_rdPickerSelectedGroup !== 'Alle') {
        recipes = recipes.filter(function(r) { return r._group === _rdPickerSelectedGroup; });
    }
    if (q) {
        recipes = recipes.filter(function(r) {
            return r.name.toLowerCase().indexOf(q) !== -1 || r._group.toLowerCase().indexOf(q) !== -1;
        });
    }
    recipes.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });

    var list = document.getElementById('rdPickerList');
    if (!recipes.length) {
        list.innerHTML = '<li style="padding:20px;color:var(--color-text-dim);">Ingen opskrifter</li>';
        return;
    }

    list.innerHTML = recipes.map(function(r) {
        return '<li class="rd-picker-item" data-id="' + r.id + '">' +
            '<div>' +
                '<div class="rd-picker-name">' + esc(r.name) + '</div>' +
                '<div class="rd-picker-meta">' + esc(r._group) + ' &middot; ' + r.base_servings + ' ' + esc(r._unit) + '</div>' +
            '</div>' +
            '<span class="rd-picker-arrow">&rarr;</span>' +
        '</li>';
    }).join('');

    list.addEventListener('click', function handler(e) {
        var item = e.target.closest('.rd-picker-item');
        if (!item) return;
        list.removeEventListener('click', handler);
        _rdOpenForEdit(parseInt(item.getAttribute('data-id')));
    });
}

// ══════════════════════════════════════════���═════════════════
// OPEN FOR EDIT
// ═══��═════════════════��══════════════════════════════════════

function _rdOpenForEdit(recipeId) {
    var recipe = _rdRecipeMap[recipeId];
    if (!recipe) return;

    _rdDs.mode = 'modify';
    _rdDs.originalRecipeId = recipeId;
    _rdDs.name = recipe.name;
    _rdDs.description = recipe.description || '';
    _rdDs.group = recipe._group;
    _rdDs.recipeUnit = recipe._unit;
    _rdDs.baseServings = parseInt(recipe.base_servings) || 1;
    _rdDs.currentPortions = _rdDs.baseServings;
    _rdDs.removedIngIds = [];
    _rdDs.removedNestIds = [];
    _rdDs.dirty = false;
    // Aktiv arbejdstid pr. batch fra userfield (tom → null → løn-linje viser —)
    var wm = recipe.userfields && recipe.userfields.arbejdstid_min;
    _rdDs.workMin = (wm != null && wm !== '' && isFinite(parseFloat(wm))) ? parseFloat(wm) : null;

    // Load ingredients for this recipe
    _rdDs.ingredients = _rdAllPositions
        .filter(function(p) { return p.recipe_id == recipeId; })
        .map(function(p) { return _rdShallowCopy(p); });

    // Load nestings
    _rdDs.nestings = _rdAllNestings
        .filter(function(n) { return n.recipe_id == recipeId; })
        .map(function(n) { return _rdShallowCopy(n); });

    _rdComp = null;                    // ny opskrift åbnet → nulstil kostpris-cache
    _rdShowDesigner();
    _rdLoadComposition(recipeId);      // hent kostpris/breakdown (async)
}

// ═════════════════════════���══════════════════════════════════
// START NEW
// ════════════════════════════════════════════════════════════

function _rdStartNew() {
    _rdDs.mode = 'new';
    _rdDs.originalRecipeId = null;
    _rdDs.name = '';
    _rdDs.description = '';
    _rdDs.group = '';
    _rdDs.recipeUnit = 'stk';
    _rdDs.baseServings = 1;
    _rdDs.currentPortions = 1;
    _rdDs.ingredients = [];
    _rdDs.nestings = [];
    _rdDs.removedIngIds = [];
    _rdDs.removedNestIds = [];
    _rdDs.dirty = false;
    _rdDs.workMin = null;

    _rdComp = null;   // ny opskrift har ingen kostpris før den er gemt ("beregnes efter gem")
    _rdShowDesigner();
}

// ════════════════════════════════════════════════════════════
// DESIGNER VIEW — RENDER SHELL
// ════════════════════════════════════════════════════════════

function _rdShowDesigner() {
    _rdSwitchView('rdDesignerView');
    _rdAddPanelOpen = false;
    _rdAddNestingPanelOpen = false;
    _rdSelectedProduct = null;

    var isNew = _rdDs.mode === 'new';
    var badgeClass = isNew ? 'rd-new' : 'rd-modify';
    var badgeText = isNew ? 'NY OPSKRIFT' : 'TILPASNING';
    var subtitleText = isNew
        ? 'Ny opskrift — tilf&#248;j ingredienser herunder'
        : 'Baseret p&#229;: <strong>' + esc(_rdDs.name) + '</strong>';

    var view = document.getElementById('rdDesignerView');
    view.innerHTML = '' +
        '<div style="padding:20px 24px;">' +
            '<button class="rd-back-link" id="rdDesignerBack">&larr; Tilbage</button>' +
            '<div class="rd-designer-top">' +
                '<input type="text" class="rd-name-input" id="rdDName" placeholder="Opskrift navn..." value="' + esc(_rdDs.name) + '">' +
                '<span class="rd-mode-badge ' + badgeClass + '" id="rdDBadge">' + badgeText + '</span>' +
                '<div class="rd-change-marker" id="rdDChanged"><div class="rd-change-dot"></div> &#198;ndringer</div>' +
            '</div>' +
            '<div class="rd-subtitle" id="rdDSubtitle">' + subtitleText + '</div>' +

            // Meta row
            '<div class="rd-meta-row">' +
                '<div class="rd-meta-field">' +
                    '<div class="rd-meta-label">Gruppe</div>' +
                    '<select class="rd-meta-select" id="rdDGroup"></select>' +
                '</div>' +
                '<div class="rd-meta-field rd-narrow">' +
                    '<div class="rd-meta-label">Enhed</div>' +
                    '<select class="rd-meta-select" id="rdDUnit">' +
                        '<option value="stk">stk</option>' +
                        '<option value="kg">kg</option>' +
                        '<option value="liter">liter</option>' +
                        '<option value="antal">antal</option>' +
                        '<option value="portion">portion</option>' +
                    '</select>' +
                '</div>' +
                '<div class="rd-meta-field rd-short">' +
                    '<div class="rd-meta-label">Base antal</div>' +
                    '<input type="number" class="rd-meta-input" id="rdDBaseServings" value="' + _rdDs.baseServings + '" min="1" step="1">' +
                '</div>' +
            '</div>' +

            // Summary toggle (chips genereres fra _rdCardDefs — ét sted)
            '<div class="rd-summary-toggle-row">' +
                '<span class="rd-summary-toggle-label">Vis:</span>' +
                _rdCardDefs.map(function(c) {
                    return '<span class="rd-summary-chip' + (_rdVisibleCards.has(c.id) ? ' rd-active' : '') +
                        '" data-card="' + c.id + '">' + esc(c.short || c.label) + '</span>';
                }).join('') +
            '</div>' +
            '<div class="rd-summary-bar" id="rdSummaryBar"></div>' +
            '<div class="rd-price-panel" id="rdPricePanel" style="display:none"></div>' +

            // Portions
            '<div class="rd-portions-row">' +
                '<span class="rd-portions-label">M&#230;ngde:</span>' +
                '<div class="rd-portions-ctrl">' +
                    '<button class="rd-portions-btn" id="rdPortMinus">&minus;</button>' +
                    '<span class="rd-portions-num" id="rdPortNum">' + _rdDs.currentPortions + '</span>' +
                    '<button class="rd-portions-btn" id="rdPortPlus">+</button>' +
                '</div>' +
                '<span class="rd-portions-unit" id="rdPortUnit">' + esc(_rdDs.recipeUnit) + '</span>' +
                '<span class="rd-base-info" id="rdBaseInfo">Base: ' + _rdDs.baseServings + ' ' + esc(_rdDs.recipeUnit) + '</span>' +
            '</div>' +

            // Ingredients
            '<div class="rd-section rd-section--ingredients">' +
                '<div class="rd-section-title-row">' +
                    '<span class="rd-section-label">Ingredienser</span>' +
                    '<button class="rd-add-btn" id="rdToggleAddPanel">+ Tilf&#248;j ingrediens</button>' +
                '</div>' +
                '<div class="rd-ing-table" id="rdIngTable">' +
                    '<div class="rd-ing-row rd-header"><div></div><div>Produkt</div><div>M&#230;ngde</div><div></div></div>' +
                    '<div id="rdIngRows"></div>' +
                    '<div class="rd-add-panel" id="rdAddPanel">' +
                        '<div class="rd-add-row">' +
                            '<div class="rd-ac-wrapper">' +
                                '<input type="text" class="rd-ac-input" id="rdAcInput" placeholder="S&#248;g produkt...">' +
                                '<div class="rd-ac-dropdown" id="rdAcDropdown"></div>' +
                            '</div>' +
                            '<input type="number" class="rd-add-amt-input" id="rdAddAmt" placeholder="M&#230;ngde" step="0.1">' +
                            '<span class="rd-add-unit-label" id="rdAddUnitLabel"></span>' +
                            '<select class="rd-add-group-select" id="rdAddGroupSelect"><option value="">Ingen gruppe</option></select>' +
                            '<button class="rd-ok-btn" id="rdConfirmAdd">Tilf&#248;j</button>' +
                            '<button class="rd-cancel-btn" id="rdCancelAdd">&#10005;</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // Nestings
            '<div class="rd-section">' +
                '<div class="rd-section-title-row">' +
                    '<span class="rd-section-label">Underopskrifter</span>' +
                    '<button class="rd-add-btn" id="rdToggleAddNesting">+ Tilf&#248;j underopskrift</button>' +
                '</div>' +
                '<div id="rdNestingCards"></div>' +
                '<div class="rd-add-nesting-panel" id="rdAddNestingPanel">' +
                    '<div class="rd-add-row">' +
                        '<div class="rd-ac-wrapper">' +
                            '<input type="text" class="rd-ac-input" id="rdNestAcInput" placeholder="S&#248;g opskrift...">' +
                            '<div class="rd-ac-dropdown" id="rdNestAcDropdown"></div>' +
                        '</div>' +
                        '<input type="number" class="rd-add-amt-input" id="rdNestAmt" placeholder="Antal" step="0.01" value="1">' +
                        '<span class="rd-add-unit-label" id="rdNestUnitLabel">portion</span>' +
                        '<button class="rd-ok-btn" id="rdConfirmAddNesting">Tilf&#248;j</button>' +
                        '<button class="rd-cancel-btn" id="rdCancelAddNesting">&#10005;</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // Notes
            '<div class="rd-section">' +
                '<div class="rd-section-title-row">' +
                    '<span class="rd-section-label">Fremgangsm&#229;de</span>' +
                '</div>' +
                '<textarea class="rd-notes-textarea" id="rdDNotes" placeholder="Beskriv fremgangsm&#229;den...">' + esc(_rdDs.description) + '</textarea>' +
            '</div>' +
        '</div>' +

        // Action bar
        '<div class="rd-action-bar">' +
            '<button class="rd-action-btn rd-btn-save" id="rdBtnSave" style="' + (isNew ? 'display:none;' : '') + '">Gem</button>' +
            '<button class="rd-action-btn rd-btn-save-as" id="rdBtnSaveAs">Gem som ny</button>' +
            '<button class="rd-action-btn rd-btn-discard" id="rdBtnDiscard">Kass&#233;r</button>' +
        '</div>';

    // Bind events
    _rdBindDesignerEvents();

    // Initial render
    _rdPopulateGroupDropdown();
    document.getElementById('rdDUnit').value = _rdDs.recipeUnit;
    _rdRenderIngredients();
    _rdRenderNestings();
    _rdRenderSummaryCards();
    _rdRecalcSummary();
}

// ═════���══════════════════════════════════��═══════════════════
// EVENT BINDING
// ══════════════════════════════��═════════════════════════════

function _rdBindDesignerEvents() {
    // Back
    document.getElementById('rdDesignerBack').addEventListener('click', function() {
        if (_rdDs.dirty && !confirm('Du har ugemte aendringer. Vil du kassere dem?')) return;
        _rdSwitchView('rdStartView');
    });

    // Name input marks dirty
    document.getElementById('rdDName').addEventListener('input', _rdMarkChanged);

    // Meta changes
    document.getElementById('rdDGroup').addEventListener('change', _rdMarkChanged);
    document.getElementById('rdDUnit').addEventListener('change', function() {
        _rdDs.recipeUnit = this.value;
        _rdUpdatePortionsDisplay();
        _rdMarkChanged();
    });
    document.getElementById('rdDBaseServings').addEventListener('change', function() {
        _rdDs.baseServings = Math.max(1, parseInt(this.value) || 1);
        _rdDs.currentPortions = _rdDs.baseServings;
        _rdUpdatePortionsDisplay();
        _rdRenderIngredients();
        _rdRecalcSummary();
        _rdMarkChanged();
    });

    // Notes
    document.getElementById('rdDNotes').addEventListener('input', _rdMarkChanged);

    // Portions
    document.getElementById('rdPortMinus').addEventListener('click', function() { _rdAdjustPortions(-1); });
    document.getElementById('rdPortPlus').addEventListener('click', function() { _rdAdjustPortions(1); });

    // Summary toggle chips
    var toggleRow = document.querySelector('.rd-summary-toggle-row');
    if (toggleRow) {
        toggleRow.addEventListener('click', function(e) {
            var chip = e.target.closest('.rd-summary-chip');
            if (!chip) return;
            var id = chip.getAttribute('data-card');
            if (_rdVisibleCards.has(id)) { _rdVisibleCards.delete(id); } else { _rdVisibleCards.add(id); }
            chip.classList.toggle('rd-active');
            _rdRenderSummaryCards();
            if (id === 'cost') { _rdRenderIngredients(); _rdRenderNestings(); }  // andel-kolonne til/fra
            _rdRecalcSummary();
        });
    }

    // Pris-panel kontroller (delegeret — panelet gen-renderes)
    var pricePanel = document.getElementById('rdPricePanel');
    if (pricePanel) {
        pricePanel.addEventListener('input', function(e) {
            var pp = e.target.getAttribute('data-pp');
            if (pp === 'dbSlider') {
                _rdPrice.dbTarget = parseInt(e.target.value, 10) || 0;
                _rdUpdatePriceLive();
            } else if (pp === 'workMin') {
                var v = parseFloat(String(e.target.value).replace(',', '.'));
                _rdDs.workMin = (e.target.value === '' || !isFinite(v)) ? null : v;
                _rdMarkChanged();
                _rdUpdatePriceLive();
            }
        });
        pricePanel.addEventListener('change', function(e) {
            var pp = e.target.getAttribute('data-pp');
            if (pp === 'lonToggle') { _rdPrice.showLabor = e.target.checked; _rdRenderPrice(); }
            else if (pp === 'priceCat') { _rdPrice.priceCat = e.target.value; _rdRenderPrice(); }
        });
        pricePanel.addEventListener('click', function(e) {
            var btn = e.target.closest('[data-pp="basis"]');
            if (btn) { _rdPrice.basis = btn.getAttribute('data-val'); _rdRenderPrice(); }
        });
    }

    // Add ingredient panel
    document.getElementById('rdToggleAddPanel').addEventListener('click', _rdToggleAddPanel);
    document.getElementById('rdConfirmAdd').addEventListener('click', _rdConfirmAdd);
    document.getElementById('rdCancelAdd').addEventListener('click', _rdToggleAddPanel);

    // Autocomplete for products
    var acInput = document.getElementById('rdAcInput');
    var acDebounce = null;
    acInput.addEventListener('input', function() {
        clearTimeout(acDebounce);
        acDebounce = setTimeout(function() { _rdOnAcInput(acInput.value); }, 150);
    });

    // Add nesting panel
    document.getElementById('rdToggleAddNesting').addEventListener('click', _rdToggleAddNestingPanel);
    document.getElementById('rdConfirmAddNesting').addEventListener('click', _rdConfirmAddNesting);
    document.getElementById('rdCancelAddNesting').addEventListener('click', _rdToggleAddNestingPanel);

    // Nesting autocomplete
    var nestAcInput = document.getElementById('rdNestAcInput');
    var nestAcDebounce = null;
    nestAcInput.addEventListener('input', function() {
        clearTimeout(nestAcDebounce);
        nestAcDebounce = setTimeout(function() { _rdOnNestAcInput(nestAcInput.value); }, 150);
    });

    // Close autocomplete dropdowns on outside click
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#rdAddPanel .rd-ac-wrapper')) {
            var dd = document.getElementById('rdAcDropdown');
            if (dd) dd.classList.remove('rd-open');
        }
        if (!e.target.closest('#rdAddNestingPanel .rd-ac-wrapper')) {
            var dd2 = document.getElementById('rdNestAcDropdown');
            if (dd2) dd2.classList.remove('rd-open');
        }
    });

    // Action buttons
    document.getElementById('rdBtnSave').addEventListener('click', _rdSaveRecipe);
    document.getElementById('rdBtnSaveAs').addEventListener('click', _rdSaveAsNew);
    document.getElementById('rdBtnDiscard').addEventListener('click', function() {
        if (_rdDs.dirty && !confirm('Du har ugemte aendringer. Vil du kassere dem?')) return;
        _rdSwitchView('rdStartView');
    });
}

// ══════════════════════��═════════════════════════════════════
// PORTIONS
// ════════════════════════════════════��═══════════════════════

function _rdAdjustPortions(delta) {
    _rdDs.currentPortions = Math.max(1, _rdDs.currentPortions + delta);
    _rdUpdatePortionsDisplay();
    _rdRenderIngredients();
    _rdRenderNestings();
    _rdRecalcSummary();
}

function _rdUpdatePortionsDisplay() {
    var unit = _rdDs.recipeUnit;
    var el = document.getElementById('rdPortNum');
    if (el) el.textContent = _rdDs.currentPortions;
    var unitEl = document.getElementById('rdPortUnit');
    if (unitEl) unitEl.textContent = unit;
    var baseEl = document.getElementById('rdBaseInfo');
    if (baseEl) baseEl.textContent = 'Base: ' + _rdDs.baseServings + ' ' + unit;
}

// ═════════════���══════════════════════════���═══════════════════
// GROUP DROPDOWN
// ═��════════════════���══════════════════════════════════���══════

function _rdPopulateGroupDropdown() {
    var groupSet = {};
    _rdRecipes.forEach(function(r) { groupSet[r._group] = true; });
    var groups = Object.keys(groupSet).sort(function(a, b) { return a.localeCompare(b, 'da'); });

    var sel = document.getElementById('rdDGroup');
    sel.innerHTML = groups.map(function(g) {
        return '<option value="' + esc(g) + '"' + (g === _rdDs.group ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('') + '<option value="">— Ny gruppe —</option>';

    // Also populate add-ingredient group dropdown
    var ingGroupSet = {};
    _rdDs.ingredients.forEach(function(i) { if (i.ingredient_group) ingGroupSet[i.ingredient_group] = true; });
    var addGroupSel = document.getElementById('rdAddGroupSelect');
    if (addGroupSel) {
        addGroupSel.innerHTML = '<option value="">Ingen gruppe</option>' +
            Object.keys(ingGroupSet).map(function(g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join('');
    }
}

// ═══════��════════════════════════════════════════════════════
// SUMMARY CARDS
// ═══���════════════════════��═══════════════════════════════════

var _rdCardDefs = [
    { id: 'weight', label: 'Samlet vaegt',    short: 'Vaegt' },
    { id: 'stock',  label: 'Lager / mangler', short: 'Lager' },
    { id: 'cost',   label: 'Kostpris',        short: 'Kostpris', calc: true },
    { id: 'price',  label: 'Foreslaaet pris', short: 'Pris',     calc: true },
    { id: 'db',     label: 'DB mod faktisk',  short: 'DB',       calc: true },
    { id: 'co2',    label: 'CO2e',            short: 'CO2e',     calc: true }
];

function _rdRenderSummaryCards() {
    var bar = document.getElementById('rdSummaryBar');
    if (!bar) return;
    bar.innerHTML = _rdCardDefs
        .filter(function(c) { return _rdVisibleCards.has(c.id); })
        .map(function(c) {
            return '<div class="rd-summary-card"><div class="rd-summary-value" id="rdSum_' + c.id + '">&mdash;</div><div class="rd-summary-label">' + c.label + '</div></div>';
        }).join('');
}

function _rdRecalcSummary() {
    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    var totalWeight = 0;
    var inStock = 0;
    var missing = 0;

    _rdDs.ingredients.forEach(function(ing) {
        var product = _rdProductMap[ing.product_id];
        if (!product) return;
        var rawScaled = (parseFloat(ing.amount) || 0) * mult;
        var stockQuId = product.qu_id_stock || ing.qu_id;
        var stockUnitName = _rdQuantityUnits[stockQuId] || '';

        if ((ing.ingredient_group || '').toLowerCase() !== 'emballage') {
            totalWeight += _rdCalcWeightGrams(rawScaled, stockUnitName, ing.product_id, stockQuId);
        }

        var stockAmt = _rdEffectiveStock(ing.product_id);
        if (stockAmt >= rawScaled) inStock++; else missing++;
    });

    // Add nested sub-recipe weights
    _rdDs.nestings.forEach(function(n) {
        var subRecipe = _rdRecipeMap[n.includes_recipe_id];
        if (!subRecipe) return;
        var scaledServings = (parseFloat(n.servings) || 1) * mult;
        totalWeight += _rdCalcSubRecipeWeightGrams(n.includes_recipe_id, scaledServings);
    });

    var setVal = function(id, v) { var el = document.getElementById('rdSum_' + id); if (el) el.innerHTML = v; };
    setVal('weight', totalWeight >= 1000 ? _rdRound(totalWeight / 1000, 2) + ' kg' : _rdRound(totalWeight, 0) + ' g');
    setVal('stock', '<span style="color:var(--color-green-dark)">' + inStock + '</span> / <span style="color:var(--color-red)">' + missing + '</span>');

    // Kalkulations-kort + pris-panel (Fase 1-2)
    _rdRenderPrice();
}

// ════════════════════════════════════════════════════════════
// KALKULATION — kostpris / avance (Fase 1-3)
// ÉN kostpris: composition.total_cost (Grocy fulfillment). Designeren regner
// aldrig kostpris selv. Løn er en separat linje ovenpå. Se spec.
// ════════════════════════════════════════════════════════════

// Hent labor-rate + DB-mål én gang (non-blocking). Fejl er ikke-fatale.
async function _rdLoadCalcMeta() {
    if (_rdCalcLoaded) return;
    _rdCalcLoaded = true;
    try {
        var lr = await fetchLaborRate();
        _rdLaborRate = {
            rate: (lr && lr.standard_hourly_rate != null) ? Number(lr.standard_hourly_rate) : null,
            overhead_pct: (lr && lr.labor_overhead_pct != null) ? Number(lr.labor_overhead_pct) : 0,
            count: (lr && lr.employee_count) || 0
        };
    } catch (e) { /* løn-linje viser — */ }
    try {
        var t = await fetchRecipeTargets();
        _rdTargets = {};
        (t && t.targets || []).forEach(function(row) { _rdTargets[row.category] = Number(row.target_pct); });
    } catch (e) { /* fallback 70 */ }
    if (document.getElementById('rdPricePanel')) _rdRenderPrice();
}

// Hent kostpris/breakdown for én opskrift (composition = fulfillment-total + linjer).
async function _rdLoadComposition(recipeId) {
    _rdCompLoading = true;
    if (document.getElementById('rdPricePanel')) _rdRenderPrice();   // vis "henter…"
    try {
        var comp = await fetchRecipeComposition(recipeId);
        // Kun relevant hvis brugeren stadig er på samme opskrift
        if (_rdDs.originalRecipeId !== recipeId) return;
        _rdComp = comp;
        // DB-slider starter på opskriftens kategori-mål (recipe_db_targets), fallback 70
        var cat = comp && comp.category;
        _rdPrice.dbTarget = (cat && _rdTargets[cat] != null) ? _rdTargets[cat] : 70;
    } catch (e) {
        _rdComp = null;   // Grocy nede → kostpris viser — (aldrig 0)
    } finally {
        _rdCompLoading = false;
        _rdRenderIngredients();   // andel-kolonne på ingrediens-rækker
        _rdRenderNestings();      // + underopskrift-rækker
        _rdRecalcSummary();       // kort + pris-panel
    }
}

// Salgspris inkl. moms fra opskriftens Grocy-userfield for valgt priskategori.
function _rdActualPriceIncl() {
    var r = _rdRecipeMap[_rdDs.originalRecipeId];
    if (!r || !r.userfields) return null;
    var key = 'Salesprice' + _rdPrice.priceCat.charAt(0).toUpperCase() + _rdPrice.priceCat.slice(1);
    var v = parseFloat(r.userfields[key]);
    return (isFinite(v) && v > 0) ? v : null;
}

function _rdCo2PerUnit() {
    var r = _rdRecipeMap[_rdDs.originalRecipeId];
    var v = r && r.userfields ? parseFloat(r.userfields.Co2e) : NaN;
    return isFinite(v) ? v : null;
}

// Alle afledte pris-tal. Alt ex moms; kun visning konverteres til inkl. via window.Moms.
function _rdComputePrice() {
    var out = { hasCost: false, loading: _rdCompLoading, isNew: (_rdDs.mode === 'new') };
    if (!_rdComp || _rdComp.total_cost == null) return out;

    var base = _rdDs.baseServings || 1;
    var materials = Number(_rdComp.total_cost) / base;        // ex moms pr. portion

    // Løn pr. portion — standard-medarbejder × overhead × aktiv-min/portion
    var lr = _rdLaborRate, laborPer = null;
    if (_rdPrice.showLabor && lr.rate != null && _rdDs.workMin != null) {
        var minPer = _rdDs.workMin / base;
        laborPer = lr.rate * (1 + (lr.overhead_pct || 0) / 100) * minPer / 60;
    }
    var full = materials + (laborPer || 0);
    var basis = (_rdPrice.basis === 'materials') ? materials : full;

    out.hasCost = true;
    out.materials = materials;
    out.laborPer = laborPer;
    out.full = full;
    out.basis = basis;

    var db = _rdPrice.dbTarget;
    out.db = db;
    out.suggestEx = (db < 100) ? basis / (1 - db / 100) : null;
    out.suggestIncl = (out.suggestEx != null && window.Moms)
        ? Math.round(window.Moms.exclToIncl(out.suggestEx)) : null;

    var actualIncl = _rdActualPriceIncl();
    out.actualIncl = actualIncl;
    out.actualEx = (actualIncl != null && window.Moms) ? window.Moms.inclToExcl(actualIncl) : null;
    out.dbActual = (out.actualEx != null && out.actualEx > 0)
        ? (out.actualEx - basis) / out.actualEx * 100 : null;

    out.co2 = _rdCo2PerUnit();
    return out;
}

function _rdKr(v) { return _rdRound(v, 2); }

function _rdSetCard(id, v, cls) {
    var el = document.getElementById('rdSum_' + id);
    if (!el) return;
    el.innerHTML = v;
    var card = el.closest('.rd-summary-card');
    if (card) { card.classList.remove('rd-card-ok', 'rd-card-bad'); if (cls) card.classList.add(cls); }
}

// Skriv kalkulations-kortenes værdier (cost/price/db/co2).
function _rdWriteCards(p) {
    if (p.isNew && !p.hasCost) {
        _rdSetCard('cost', '<span class="rd-dim">beregnes efter gem</span>');
        _rdSetCard('price', '&mdash;'); _rdSetCard('db', '&mdash;');
    } else if (!p.hasCost) {
        _rdSetCard('cost', p.loading ? '<span class="rd-dim">henter&hellip;</span>' : '<span class="rd-dim">&mdash;</span>');
        _rdSetCard('price', '&mdash;'); _rdSetCard('db', '&mdash;');
    } else {
        _rdSetCard('cost', _rdKr(_rdPrice.basis === 'materials' ? p.materials : p.full) + ' kr');
        _rdSetCard('price', p.suggestIncl != null ? p.suggestIncl + ' kr' : '&mdash;');
        if (p.dbActual != null) {
            _rdSetCard('db', _rdRound(p.dbActual, 1) + ' %', p.dbActual >= p.db ? 'rd-card-ok' : 'rd-card-bad');
        } else {
            _rdSetCard('db', '&mdash;');
        }
    }
    _rdSetCard('co2', p.co2 != null ? _rdRound(p.co2, 2) + ' kg' : '<span class="rd-dim">&mdash;</span>');
}

// Fuld render: kort + panel-struktur. Kaldes ved strukturelle ændringer.
function _rdRenderPrice() {
    var p = _rdComputePrice();
    _rdWriteCards(p);

    var panel = document.getElementById('rdPricePanel');
    if (!panel) return;
    var anyCalcVisible = _rdVisibleCards.has('cost') || _rdVisibleCards.has('price') || _rdVisibleCards.has('db');
    if (!anyCalcVisible) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
    panel.style.display = '';
    panel.innerHTML = _rdBuildPricePanel(p);
}

// Let opdatering: kun tal-spans + kort (bevarer slider/input-fokus). Kaldes ved
// slider- og arbejdstid-input, hvor et fuldt rebuild ville afbryde brugeren.
function _rdUpdatePriceLive() {
    var p = _rdComputePrice();
    _rdWriteCards(p);
    if (!p.hasCost) return;
    var set = function(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };
    set('rdPPdb', p.db + ' %');
    set('rdPPsug', p.suggestIncl != null ? p.suggestIncl + ' kr' : '&mdash;');
    set('rdPPmat', _rdKr(p.materials) + ' kr');
    set('rdPPlabor', p.laborPer != null ? _rdKr(p.laborPer) + ' kr' : '&mdash;');
    set('rdPPfull', _rdKr(p.materials + (p.laborPer || 0)) + ' kr');
    set('rdPPverdict', _rdVerdictHtml(p));
}

function _rdVerdictHtml(p) {
    if (p.dbActual == null) {
        return '<div class="rd-pp-verdict">Ingen salgspris sat for <b>' + esc(_rdPrice.priceCat) + '</b> &mdash; kan ikke sammenlignes.</div>';
    }
    if (p.dbActual >= p.db) {
        return '<div class="rd-pp-verdict rd-ok">Nuv&#230;rende pris giver <b>' + _rdRound(p.dbActual, 1) + ' % DB</b> &mdash; over m&#229;let (' + p.db + ' %).</div>';
    }
    return '<div class="rd-pp-verdict rd-warn">Nuv&#230;rende pris giver kun <b>' + _rdRound(p.dbActual, 1) + ' % DB</b>. Pris skal op p&#229; <b>' + (p.suggestIncl != null ? p.suggestIncl + ' kr' : '&mdash;') + '</b> for m&#229;let (' + p.db + ' %).</div>';
}

function _rdBuildPricePanel(p) {
    var money = function(v) { return (v == null) ? '&mdash;' : _rdKr(v) + ' kr'; };
    var lr = _rdLaborRate;

    // Breakdown (linjerne summerer ~til fulfillment-total; kilde: composition)
    var groups = _rdCompGroupCosts();   // { materials, packaging, sub } pr. portion, ex moms
    var base = _rdDs.baseServings || 1;

    var left = '';
    if (!p.hasCost) {
        left = '<div class="rd-pp-note">' +
            (p.isNew ? 'Kostprisen beregnes n&#229;r opskriften er gemt.' :
             p.loading ? 'Henter kostpris fra Grocy&hellip;' :
             'Kostpris ikke tilg&#230;ngelig (Grocy svarer ikke).') + '</div>';
    } else {
        // Rest = det autoritative total (fulfillment) minus de prissatte linjer.
        // Positivt når nogle ingredienser mangler pris i Grocys prishistorik — vises
        // eksplicit, så breakdown summerer til totalen i stedet for at se for billig ud.
        var lineSum = groups.materials + groups.packaging + groups.sub;
        var residual = Math.max(0, p.materials - lineSum);
        var matActive = (_rdPrice.basis === 'materials');
        var fullPer = p.materials + (p.laborPer || 0);
        left =
            '<div class="rd-pp-kv"><span>R&#229;varer</span><span>' + money(groups.materials) + '</span></div>' +
            (groups.sub > 0 ? '<div class="rd-pp-kv"><span>Underopskrifter</span><span>' + money(groups.sub) + '</span></div>' : '') +
            (groups.packaging > 0 ? '<div class="rd-pp-kv"><span>Emballage</span><span>' + money(groups.packaging) + '</span></div>' : '') +
            (residual > 0.005 ? '<div class="rd-pp-kv rd-dim"><span>Uprissat rest</span><span>' + money(residual) + '</span></div>' : '') +
            // Subtotal 1: vareomkostning (summerer linjerne ovenfor)
            '<div class="rd-pp-kv rd-pp-sub' + (matActive ? ' rd-pp-active' : '') + '"><span>Vareomkostning pr. portion</span><span id="rdPPmat">' + money(p.materials) + '</span></div>' +
            // Løn + subtotal 2: fuldt belastet (kun når løn medregnes)
            (_rdPrice.showLabor
                ? '<div class="rd-pp-kv"><span>+ Arbejdsl&#248;n</span><span id="rdPPlabor">' + (p.laborPer != null ? money(p.laborPer) : '&mdash;') + '</span></div>' +
                  '<div class="rd-pp-kv rd-pp-sub' + (!matActive ? ' rd-pp-active' : '') + '"><span>Fuldt belastet pr. portion</span><span id="rdPPfull">' + money(fullPer) + '</span></div>'
                : '') +
            // Løn-kontrol
            '<div class="rd-pp-lonrow">' +
                '<label class="rd-pp-switch"><input type="checkbox" data-pp="lonToggle"' + (_rdPrice.showLabor ? ' checked' : '') + '><span></span></label>' +
                '<span>Medregn l&#248;n:</span>' +
                '<input type="number" class="rd-pp-min" data-pp="workMin" value="' + (_rdDs.workMin != null ? _rdDs.workMin : '') + '" placeholder="0" step="0.5" min="0">' +
                '<span class="rd-pp-minunit">min/batch</span>' +
                '<span class="rd-pp-hint">' + (lr.rate != null ? 'sats ' + _rdRound(lr.rate, 0) + ' kr/t + ' + _rdRound(lr.overhead_pct || 0, 0) + '% overhead' : 'ingen sats') + '</span>' +
            '</div>' +
            (_rdPrice.showLabor
                ? '<div class="rd-pp-basis">' +
                    '<span class="rd-pp-hint" style="margin-right:auto">Beregn DB p&#229;:</span>' +
                    '<span class="rd-pp-basis-btn' + (matActive ? ' rd-active' : '') + '" data-pp="basis" data-val="materials">R&#229;varer</span>' +
                    '<span class="rd-pp-basis-btn' + (!matActive ? ' rd-active' : '') + '" data-pp="basis" data-val="full">Inkl. l&#248;n</span>' +
                  '</div>'
                : '');
    }

    var right = '';
    if (p.hasCost) {
        var verdict = _rdVerdictHtml(p);
        right =
            '<div class="rd-pp-slider">' +
                '<div class="rd-pp-slider-top"><span>M&#229;l-d&#230;kningsbidrag</span><b id="rdPPdb">' + p.db + ' %</b></div>' +
                '<input type="range" min="40" max="88" value="' + p.db + '" data-pp="dbSlider">' +
            '</div>' +
            '<div class="rd-pp-cat">Faktisk pris: ' +
                '<select data-pp="priceCat">' +
                    ['store', 'catering', 'festival', 'produktion', 'waiste'].map(function(c) {
                        return '<option value="' + c + '"' + (c === _rdPrice.priceCat ? ' selected' : '') + '>' + c + '</option>';
                    }).join('') +
                '</select>' +
                '<span class="rd-pp-actual">' + (p.actualIncl != null ? p.actualIncl + ' kr inkl.' : 'ingen') + '</span>' +
            '</div>' +
            '<div class="rd-pp-suggest">' +
                '<div class="rd-pp-suggest-v" id="rdPPsug">' + (p.suggestIncl != null ? p.suggestIncl + ' kr' : '&mdash;') + '</div>' +
                '<div class="rd-pp-suggest-l">foresl&#229;et menupris inkl. moms</div>' +
            '</div>' +
            '<div id="rdPPverdict">' + verdict + '</div>';
    }

    var dirtyNote = (_rdDs.dirty && p.hasCost)
        ? '<div class="rd-pp-dirty">Afspejler sidst gemte opskrift &mdash; kostprisen opdateres n&#229;r du gemmer.</div>'
        : '';
    return '<div class="rd-pp-head">Pris &amp; avance <span class="rd-pp-exmoms">alle beregninger ex moms</span></div>' +
        dirtyNote +
        '<div class="rd-pp-grid"><div>' + left + '</div><div>' + right + '</div></div>';
}

// Grupper composition-linjernes kostpris pr. portion (ex moms): råvarer / emballage / underopskrifter.
// Linjerne summerer ~til total_cost (fulfillment) — det autoritative tal.
function _rdCompGroupCosts() {
    var out = { materials: 0, packaging: 0, sub: 0 };
    if (!_rdComp) return out;
    var base = _rdDs.baseServings || 1;
    (_rdComp.ingredients || []).forEach(function(i) {
        if (i.cost == null) return;
        if ((i.ingredient_group || '').toLowerCase() === 'emballage') out.packaging += i.cost;
        else out.materials += i.cost;
    });
    (_rdComp.sub_recipes || []).forEach(function(s) { if (s.cost != null) out.sub += s.cost; });
    out.materials /= base; out.packaging /= base; out.sub /= base;
    return out;
}

// Kostpris pr. portion for én ingrediens/underopskrift (til andel-kolonnen, Fase 3).
function _rdIngCostPerPortion(productId) {
    if (!_rdComp) return null;
    var base = _rdDs.baseServings || 1;
    var row = (_rdComp.ingredients || []).find(function(i) { return String(i.product_id) === String(productId); });
    return (row && row.cost != null) ? row.cost / base : null;
}
function _rdSubCostPerPortion(recipeId) {
    if (!_rdComp) return null;
    var base = _rdDs.baseServings || 1;
    var row = (_rdComp.sub_recipes || []).find(function(s) { return String(s.recipe_id) === String(recipeId); });
    return (row && row.cost != null) ? row.cost / base : null;
}
// Nævner for andel = summen af alle linjers kostpris pr. portion (så andelene giver 100%).
function _rdTotalLineCostPerPortion() {
    var g = _rdCompGroupCosts();
    return g.materials + g.packaging + g.sub;
}

// ════════════════════════════════════════════════════════════
// INGREDIENTS RENDERING
// ═══════════���═══════════════════���════════════════════════════

function _rdRenderIngredients() {
    var container = document.getElementById('rdIngRows');
    if (!container) return;
    var mult = _rdDs.currentPortions / _rdDs.baseServings;

    // Group ingredients
    var groups = {};
    _rdDs.ingredients.forEach(function(ing, idx) {
        var g = ing.ingredient_group || '';
        if (!groups[g]) groups[g] = [];
        groups[g].push({ ing: ing, idx: idx });
    });

    var emballageKey = null;
    Object.keys(groups).forEach(function(g) { if (g.toLowerCase() === 'emballage') emballageKey = g; });

    var sortedGroups = Object.keys(groups)
        .filter(function(g) { return g.toLowerCase() !== 'emballage'; })
        .sort(function(a, b) { if (!a) return -1; if (!b) return 1; return a.localeCompare(b, 'da'); });

    // Andel-kolonne (Fase 3): vis kun når kostpris-kortet er slået til og cachen er hentet.
    var showCost = _rdVisibleCards.has('cost') && !!_rdComp;
    var costDenom = showCost ? _rdTotalLineCostPerPortion() : 0;

    var html = '';
    var renderGroup = function(groupName) {
        if (groupName) html += '<div class="rd-ing-row rd-group-header"><span class="rd-group-name">' + esc(groupName) + '</span></div>';
        groups[groupName].forEach(function(item) {
            var ing = item.ing;
            var idx = item.idx;
            var product = _rdProductMap[ing.product_id] || {};
            var name = product.name || '#' + ing.product_id;
            var unitName = _rdQuantityUnits[ing.qu_id] || '';
            var baseDisplayAmt = _rdGetDisplayAmount(ing);
            var scaled = _rdRound(baseDisplayAmt * mult, 2);
            var fmt = _rdFormatAmount(scaled, unitName);
            var stockAmt = _rdEffectiveStock(ing.product_id);
            var rawScaled = (parseFloat(ing.amount) || 0) * mult;
            var stockClass = stockAmt >= rawScaled ? 'rd-ok' : (stockAmt > 0 ? 'rd-low' : 'rd-missing');

            var cartHtml = (stockClass === 'rd-missing' || stockClass === 'rd-low')
                ? '<button class="rd-ing-cart" data-pid="' + ing.product_id + '" data-name="' + esc(name) + '" data-amount="' + _rdRound(Math.max(0, rawScaled - stockAmt), 2) + '" title="Tilfoej til indkoebsliste">🛒</button>'
                : '';

            // Kostpris + andel (Fase 3) — kilde: composition-linjer (summerer til total).
            var costLine = '';
            if (showCost) {
                var perP = _rdIngCostPerPortion(ing.product_id);
                if (perP != null) {
                    var share = costDenom > 0 ? (perP / costDenom * 100) : 0;
                    costLine = '<div class="rd-ing-cost">' + _rdKr(perP) + ' kr &middot; ' + _rdRound(share, 0) + ' %' +
                        '<div class="rd-ing-share-bar"><i style="width:' + Math.min(100, share) + '%"></i></div></div>';
                }
            }

            html += '<div class="rd-ing-row">' +
                '<div class="rd-stock-dot ' + stockClass + '" title="Lager: ' + _rdRound(stockAmt, 1) + '"></div>' +
                '<div class="rd-ing-name">' + esc(name) + costLine + '</div>' +
                '<div style="display:flex;align-items:center;gap:4px;">' +
                    '<div class="rd-ing-stepper">' +
                        '<button class="rd-ing-step-btn" data-idx="' + idx + '" data-dir="-1">&minus;</button>' +
                        '<input type="number" class="rd-ing-amount-input" data-idx="' + idx + '" data-display-unit="' + esc(fmt.unit) + '" value="' + fmt.amount + '" step="0.1">' +
                        '<button class="rd-ing-step-btn" data-idx="' + idx + '" data-dir="1">+</button>' +
                    '</div>' +
                    '<span class="rd-ing-unit">' + esc(fmt.unit) + '</span>' +
                '</div>' +
                cartHtml +
                '<button class="rd-ing-remove" data-idx="' + idx + '">&#10005;</button>' +
            '</div>';
        });
    };

    sortedGroups.forEach(renderGroup);
    if (emballageKey && groups[emballageKey]) renderGroup(emballageKey);

    if (_rdDs.ingredients.length === 0) {
        html = '<div style="padding:24px;text-align:center;color:var(--color-text-dim);">Ingen ingredienser. Klik "+ Tilf&#248;j ingrediens".</div>';
    }

    container.innerHTML = html;

    // Bind events via delegation on the table
    var table = document.getElementById('rdIngTable');
    // Remove old listeners by replacing — or use delegation
    table.onclick = function(e) {
        var stepBtn = e.target.closest('.rd-ing-step-btn');
        if (stepBtn) {
            _rdStepIng(parseInt(stepBtn.getAttribute('data-idx')), parseInt(stepBtn.getAttribute('data-dir')));
            return;
        }
        var removeBtn = e.target.closest('.rd-ing-remove');
        if (removeBtn) {
            _rdRemoveIng(parseInt(removeBtn.getAttribute('data-idx')));
            return;
        }
        var cartBtn = e.target.closest('.rd-ing-cart');
        if (cartBtn) {
            var pid = parseInt(cartBtn.getAttribute('data-pid'));
            var pname = cartBtn.getAttribute('data-name');
            var amt = parseFloat(cartBtn.getAttribute('data-amount')) || 1;
            _rdAddToShoppingList(pid, amt, pname);
            return;
        }
    };
    table.onchange = function(e) {
        var amtInput = e.target.closest('.rd-ing-amount-input');
        if (amtInput) {
            _rdUpdateIng(
                parseInt(amtInput.getAttribute('data-idx')),
                amtInput.value,
                amtInput.getAttribute('data-display-unit')
            );
        }
    };
}

function _rdStepIng(idx, dir) {
    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    var ing = _rdDs.ingredients[idx];
    if (!ing) return;
    var baseDisplayAmt = _rdGetDisplayAmount(ing);
    var scaledDisplay = baseDisplayAmt * mult;
    var unitName = _rdQuantityUnits[ing.qu_id] || '';
    var step = _rdGetStepSize(scaledDisplay, unitName);
    var newScaledDisplay = Math.max(0, scaledDisplay + step * dir);
    var newBaseDisplay = newScaledDisplay / mult;
    _rdDs.ingredients[idx].amount = _rdDisplayToRaw(newBaseDisplay, ing.qu_id, ing.product_id);
    _rdMarkChanged();
    _rdRenderIngredients();
    _rdRecalcSummary();
}

function _rdUpdateIng(idx, displayValue, displayUnit) {
    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    var ing = _rdDs.ingredients[idx];
    if (!ing) return;
    var realDisplayValue = parseFloat(displayValue) || 0;
    var origUnit = (_rdQuantityUnits[ing.qu_id] || '').toLowerCase();
    var du = displayUnit.toLowerCase();

    if ((origUnit === 'kg' || origUnit === 'kilo') && du === 'g') realDisplayValue = realDisplayValue / 1000;
    if ((origUnit === 'l' || origUnit === 'liter') && du === 'ml') realDisplayValue = realDisplayValue / 1000;
    if ((origUnit === 'g' || origUnit === 'gram') && du === 'kg') realDisplayValue = realDisplayValue * 1000;
    if (origUnit === 'ml' && du === 'l') realDisplayValue = realDisplayValue * 1000;

    var baseDisplayAmt = realDisplayValue / mult;
    _rdDs.ingredients[idx].amount = _rdDisplayToRaw(baseDisplayAmt, ing.qu_id, ing.product_id);
    _rdMarkChanged();
    _rdRecalcSummary();
}

function _rdRemoveIng(idx) {
    var ing = _rdDs.ingredients[idx];
    if (ing && ing.id) _rdDs.removedIngIds.push(ing.id);
    _rdDs.ingredients.splice(idx, 1);
    _rdMarkChanged();
    _rdRenderIngredients();
    _rdRecalcSummary();
    _rdPopulateGroupDropdown();
}

// ═══════���══════════════════════════════════���═════════════════
// ADD INGREDIENT
// ═══════��═══════════════════════════════��════════════════════

function _rdToggleAddPanel() {
    _rdAddPanelOpen = !_rdAddPanelOpen;
    var panel = document.getElementById('rdAddPanel');
    if (panel) panel.classList.toggle('rd-visible', _rdAddPanelOpen);
    if (_rdAddPanelOpen) {
        var acInput = document.getElementById('rdAcInput');
        var addAmt = document.getElementById('rdAddAmt');
        if (acInput) acInput.value = '';
        if (addAmt) addAmt.value = '';
        var label = document.getElementById('rdAddUnitLabel');
        if (label) label.textContent = '';
        var dd = document.getElementById('rdAcDropdown');
        if (dd) dd.classList.remove('rd-open');
        _rdSelectedProduct = null;
        _rdPopulateGroupDropdown();
        setTimeout(function() { if (acInput) acInput.focus(); }, 100);
    }
}

function _rdOnAcInput(q) {
    var dd = document.getElementById('rdAcDropdown');
    if (!q || q.length < 1) { dd.classList.remove('rd-open'); return; }
    q = q.toLowerCase();
    var matches = _rdProducts
        .filter(function(p) { return p.name && p.name.toLowerCase().indexOf(q) !== -1; })
        .slice(0, 10);
    if (!matches.length) { dd.classList.remove('rd-open'); return; }

    dd.innerHTML = matches.map(function(p) {
        var stockAmt = _rdEffectiveStock(p.id);
        var unitName = _rdQuantityUnits[p.qu_id_stock] || '';
        var dotStyle = stockAmt > 0 ? 'color:var(--color-green-dark)' : 'color:var(--color-red)';
        return '<div class="rd-ac-item" data-pid="' + p.id + '">' +
            '<span class="rd-ac-item-name">' + esc(p.name) + '</span>' +
            '<span class="rd-ac-item-meta"><span style="' + dotStyle + '">&#9679;</span> ' + _rdRound(stockAmt, 1) + ' ' + esc(unitName) + '</span>' +
        '</div>';
    }).join('');
    // Position fixed dropdown under input
    var inputRect = document.getElementById('rdAcInput').getBoundingClientRect();
    dd.style.top = inputRect.bottom + 'px';
    dd.style.left = inputRect.left + 'px';
    dd.style.right = 'auto';
    dd.style.width = inputRect.width + 'px';
    dd.style.maxWidth = inputRect.width + 'px';
    dd.classList.add('rd-open');

    // Bind selection
    dd.onclick = function(e) {
        var item = e.target.closest('.rd-ac-item');
        if (!item) return;
        _rdSelectProduct(parseInt(item.getAttribute('data-pid')));
    };
}

function _rdSelectProduct(pid) {
    _rdSelectedProduct = _rdProductMap[pid];
    if (!_rdSelectedProduct) return;
    document.getElementById('rdAcInput').value = _rdSelectedProduct.name;
    document.getElementById('rdAddUnitLabel').textContent = _rdQuantityUnits[_rdSelectedProduct.qu_id_stock] || '';
    document.getElementById('rdAcDropdown').classList.remove('rd-open');
    document.getElementById('rdAddAmt').focus();
}

function _rdConfirmAdd() {
    if (!_rdSelectedProduct) { _rdShowAlert('Vaelg et produkt foerst', 'error'); return; }
    var amt = parseFloat(document.getElementById('rdAddAmt').value);
    if (!amt || amt <= 0) { _rdShowAlert('Indtast en maengde', 'error'); return; }

    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    var groupSel = document.getElementById('rdAddGroupSelect');
    var group = groupSel ? groupSel.value : '';
    var baseAmt = amt / mult;

    _rdDs.ingredients.push({
        id: null,
        recipe_id: _rdDs.originalRecipeId,
        product_id: _rdSelectedProduct.id,
        amount: baseAmt,
        qu_id: _rdSelectedProduct.qu_id_stock,
        ingredient_group: group || null,
        note: null,
        only_check_single_unit_in_stock: 0,
        not_check_stock_fulfillment: 0,
        variable_amount: null,
        price_factor: 1,
        round_up: 0
    });

    _rdMarkChanged();
    _rdToggleAddPanel();
    _rdPopulateGroupDropdown();
    _rdRenderIngredients();
    _rdRecalcSummary();
    _rdShowAlert(_rdSelectedProduct.name + ' tilfojet', 'success');
}

// ════════════���══════════════════════════════���════════════════
// NESTINGS RENDERING
// ══��═══════════════════════���═════════════════════════════════

function _rdRenderNestings() {
    var container = document.getElementById('rdNestingCards');
    if (!container) return;
    var mult = _rdDs.currentPortions / _rdDs.baseServings;

    if (!_rdDs.nestings.length) {
        container.innerHTML = '<div class="rd-nesting-empty">Ingen underopskrifter</div>';
        return;
    }

    var showCost = _rdVisibleCards.has('cost') && !!_rdComp;
    var costDenom = showCost ? _rdTotalLineCostPerPortion() : 0;

    container.innerHTML = _rdDs.nestings.map(function(n, i) {
        var sub = _rdRecipeMap[n.includes_recipe_id];
        var name = sub ? sub.name : '#' + n.includes_recipe_id;
        var unit = sub ? sub._unit : 'portion';
        var scaledAmt = _rdRound((parseFloat(n.servings) || 0) * mult, 3);
        var fmt = _rdFormatAmount(scaledAmt, unit);

        var costLine = '';
        if (showCost) {
            var perP = _rdSubCostPerPortion(n.includes_recipe_id);
            if (perP != null) {
                var share = costDenom > 0 ? (perP / costDenom * 100) : 0;
                costLine = '<span class="rd-ing-cost" style="display:block">' + _rdKr(perP) + ' kr &middot; ' + _rdRound(share, 0) + ' %</span>';
            }
        }

        return '<div class="rd-nesting-card">' +
            '<span class="rd-nesting-icon">&#x1F4CB;</span>' +
            '<span class="rd-nesting-name">' + esc(name) + costLine + '</span>' +
            '<div class="rd-nesting-amt">' +
                '<input type="number" class="rd-nesting-input" data-idx="' + i + '" data-display-unit="' + esc(fmt.unit) + '" data-orig-unit="' + esc(unit) + '" value="' + fmt.amount + '" step="0.01">' +
                '<span class="rd-nesting-unit">' + esc(fmt.unit) + '</span>' +
            '</div>' +
            '<button class="rd-ing-remove" data-nest-idx="' + i + '">&#10005;</button>' +
        '</div>';
    }).join('');

    // Event delegation
    container.onchange = function(e) {
        var input = e.target.closest('.rd-nesting-input');
        if (input) {
            _rdUpdateNesting(
                parseInt(input.getAttribute('data-idx')),
                input.value,
                input.getAttribute('data-display-unit'),
                input.getAttribute('data-orig-unit')
            );
        }
    };
    container.onclick = function(e) {
        var btn = e.target.closest('[data-nest-idx]');
        if (btn) {
            _rdRemoveNesting(parseInt(btn.getAttribute('data-nest-idx')));
        }
    };
}

function _rdUpdateNesting(idx, displayVal, displayUnit, origUnit) {
    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    var val = parseFloat(displayVal) || 0;
    var du = displayUnit.toLowerCase();
    var ou = origUnit.toLowerCase();
    if ((ou === 'kg' || ou === 'kilo') && du === 'g') val = val / 1000;
    if ((ou === 'l' || ou === 'liter') && du === 'ml') val = val / 1000;
    _rdDs.nestings[idx].servings = val / mult;
    _rdMarkChanged();
}

function _rdRemoveNesting(idx) {
    var n = _rdDs.nestings[idx];
    if (n && n.id) _rdDs.removedNestIds.push(n.id);
    _rdDs.nestings.splice(idx, 1);
    _rdMarkChanged();
    _rdRenderNestings();
}

// ═════��═════════════════════��════════════════════════════════
// ADD NESTING
// ════════════════════════════════════════════════════════════

var _rdSelectedNestRecipe = null;

function _rdToggleAddNestingPanel() {
    _rdAddNestingPanelOpen = !_rdAddNestingPanelOpen;
    var panel = document.getElementById('rdAddNestingPanel');
    if (panel) panel.classList.toggle('rd-visible', _rdAddNestingPanelOpen);
    if (_rdAddNestingPanelOpen) {
        document.getElementById('rdNestAcInput').value = '';
        document.getElementById('rdNestAmt').value = '1';
        document.getElementById('rdNestUnitLabel').textContent = 'portion';
        document.getElementById('rdNestAcDropdown').classList.remove('rd-open');
        _rdSelectedNestRecipe = null;
        setTimeout(function() { document.getElementById('rdNestAcInput').focus(); }, 100);
    }
}

function _rdOnNestAcInput(q) {
    var dd = document.getElementById('rdNestAcDropdown');
    if (!q || q.length < 1) { dd.classList.remove('rd-open'); return; }
    q = q.toLowerCase();
    var matches = _rdRecipes
        .filter(function(r) { return _rdIsActive(r) && r.name.toLowerCase().indexOf(q) !== -1; })
        .slice(0, 10);
    if (!matches.length) { dd.classList.remove('rd-open'); return; }

    dd.innerHTML = matches.map(function(r) {
        return '<div class="rd-ac-item" data-rid="' + r.id + '">' +
            '<span class="rd-ac-item-name">' + esc(r.name) + '</span>' +
            '<span class="rd-ac-item-meta">' + esc(r._group) + ' &middot; ' + r.base_servings + ' ' + esc(r._unit) + '</span>' +
        '</div>';
    }).join('');
    // Position fixed dropdown under input
    var nestInput = document.getElementById('rdNestAcInput');
    var nestRect = nestInput.getBoundingClientRect();
    dd.style.top = nestRect.bottom + 'px';
    dd.style.left = nestRect.left + 'px';
    dd.style.right = 'auto';
    dd.style.width = nestRect.width + 'px';
    dd.style.maxWidth = nestRect.width + 'px';
    dd.classList.add('rd-open');

    dd.onclick = function(e) {
        var item = e.target.closest('.rd-ac-item');
        if (!item) return;
        var rid = parseInt(item.getAttribute('data-rid'));
        _rdSelectedNestRecipe = _rdRecipeMap[rid];
        if (_rdSelectedNestRecipe) {
            document.getElementById('rdNestAcInput').value = _rdSelectedNestRecipe.name;
            document.getElementById('rdNestUnitLabel').textContent = _rdSelectedNestRecipe._unit || 'portion';
            dd.classList.remove('rd-open');
            document.getElementById('rdNestAmt').focus();
        }
    };
}

function _rdConfirmAddNesting() {
    if (!_rdSelectedNestRecipe) { _rdShowAlert('Vaelg en opskrift foerst', 'error'); return; }
    var amt = parseFloat(document.getElementById('rdNestAmt').value);
    if (!amt || amt <= 0) { _rdShowAlert('Indtast en maengde', 'error'); return; }

    _rdDs.nestings.push({
        id: null,
        recipe_id: _rdDs.originalRecipeId,
        includes_recipe_id: _rdSelectedNestRecipe.id,
        servings: amt
    });

    _rdMarkChanged();
    _rdToggleAddNestingPanel();
    _rdRenderNestings();
    _rdRecalcSummary();
    _rdShowAlert(_rdSelectedNestRecipe.name + ' tilfojet som underopskrift', 'success');
}

// ═══════════════════���═════════════════════════════════════���══
// SHOPPING LIST (from designer)
// ════════════════════════════════════════════════════════════

async function _rdAddToShoppingList(productId, stockAmount, productName) {
    // Konvertér til purchase-enhed
    var product = _rdProductMap[productId];
    var purchaseAmount = stockAmount;
    var purchaseUnit = '';

    if (product) {
        var stockQuId = product.qu_id_stock;
        var purchaseQuId = product.qu_id_purchase;
        purchaseUnit = _rdQuantityUnits[stockQuId] || '';

        if (purchaseQuId && purchaseQuId !== stockQuId) {
            // Find konverteringsfaktor stock → purchase
            var factor = _rdGetConversionFactor(productId, stockQuId, purchaseQuId);
            if (factor !== null) {
                purchaseAmount = Math.ceil(stockAmount * factor);
                purchaseUnit = _rdQuantityUnits[purchaseQuId] || '';
            }
        } else {
            purchaseAmount = Math.ceil(stockAmount * 100) / 100;
        }
    }

    try {
        await postGrocyShoppingList([{
            product_id: productId,
            amount: purchaseAmount,
            note: 'Fra opskrift: ' + (_rdDs.name || '')
        }]);
        _rdShowAlert('Tilfojet til indkoeb: ' + purchaseAmount + ' ' + purchaseUnit + ' ' + productName, 'success');
    } catch (err) {
        _rdShowAlert('Fejl: ' + err.message, 'error');
    }
}

function _rdGetConversionFactor(productId, fromQuId, toQuId) {
    if (fromQuId == toQuId) return 1.0;
    var convs = _rdQuConversions || [];
    var pf = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (pf) return pf.factor;
    var pr = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (pr && pr.factor !== 0) return 1.0 / pr.factor;
    var gf = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (gf) return gf.factor;
    var gr = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (gr && gr.factor !== 0) return 1.0 / gr.factor;
    return null;
}

// SAVE — Update existing
// ════════════════════════════════════════════════════════════

async function _rdSaveRecipe() {
    if (_rdDs.mode !== 'modify' || !_rdDs.originalRecipeId) return;

    var name = document.getElementById('rdDName').value.trim();
    if (!name) { _rdShowAlert('Giv opskriften et navn', 'error'); return; }

    try {
        _rdShowAlert('Gemmer...', 'info');

        var baseServings = parseInt(document.getElementById('rdDBaseServings').value) || 1;

        // 1. Update recipe
        await putGrocyRecipe(_rdDs.originalRecipeId, {
            name: name,
            description: document.getElementById('rdDNotes').value || null,
            base_servings: baseServings
        });

        // 2. Update userfields (inkl. aktiv arbejdstid pr. batch)
        await putGrocyRecipeUserfields(_rdDs.originalRecipeId, {
            grupper: document.getElementById('rdDGroup').value,
            recipeunit: document.getElementById('rdDUnit').value,
            recipeunitnumber: String(baseServings),
            arbejdstid_min: _rdDs.workMin != null ? String(_rdDs.workMin) : ''
        });

        // 3. Delete removed ingredients
        for (var i = 0; i < _rdDs.removedIngIds.length; i++) {
            await deleteGrocyRecipePos(_rdDs.removedIngIds[i]);
        }

        // 4. Delete removed nestings
        for (var j = 0; j < _rdDs.removedNestIds.length; j++) {
            await deleteGrocyRecipeNesting(_rdDs.removedNestIds[j]);
        }

        // 5. Update/create ingredients
        for (var k = 0; k < _rdDs.ingredients.length; k++) {
            var ing = _rdDs.ingredients[k];
            if (ing.id) {
                await putGrocyRecipePos(ing.id, {
                    amount: ing.amount,
                    product_id: ing.product_id,
                    qu_id: ing.qu_id,
                    ingredient_group: ing.ingredient_group,
                    note: ing.note
                });
            } else {
                await postGrocyRecipePos({
                    recipe_id: _rdDs.originalRecipeId,
                    product_id: ing.product_id,
                    amount: ing.amount,
                    qu_id: ing.qu_id,
                    only_check_single_unit_in_stock: 0,
                    ingredient_group: ing.ingredient_group || null,
                    not_check_stock_fulfillment: 0,
                    variable_amount: null,
                    price_factor: 1,
                    round_up: 0
                });
            }
        }

        // 6. Update/create nestings
        for (var m = 0; m < _rdDs.nestings.length; m++) {
            var n = _rdDs.nestings[m];
            if (n.id) {
                await putGrocyRecipeNesting(n.id, {
                    servings: n.servings
                });
            } else {
                await postGrocyRecipeNesting({
                    recipe_id: _rdDs.originalRecipeId,
                    includes_recipe_id: n.includes_recipe_id,
                    servings: n.servings
                });
            }
        }

        _rdDs.removedIngIds = [];
        _rdDs.removedNestIds = [];
        _rdDs.dirty = false;
        var marker = document.getElementById('rdDChanged');
        if (marker) marker.classList.remove('rd-visible');

        // Reload data
        await _rdLoadData(true);

        // Refresh ingredients (they now have server IDs)
        _rdDs.ingredients = _rdAllPositions
            .filter(function(p) { return p.recipe_id == _rdDs.originalRecipeId; })
            .map(function(p) { return _rdShallowCopy(p); });
        _rdDs.nestings = _rdAllNestings
            .filter(function(nn) { return nn.recipe_id == _rdDs.originalRecipeId; })
            .map(function(nn) { return _rdShallowCopy(nn); });
        _rdRenderIngredients();
        _rdRenderNestings();
        _rdLoadComposition(_rdDs.originalRecipeId);   // frisk kostpris efter gem (fulfillment-cache ryddet af skrivningen)

        _rdShowAlert('Opskrift gemt!', 'success');

    } catch (err) {
        _rdShowAlert('Fejl ved gem: ' + err.message, 'error');
    }
}

// ══════════════════��════════════════════════���════════════════
// SAVE AS NEW
// ══��═════════════════════════════════════════════════════════

async function _rdSaveAsNew() {
    var name = document.getElementById('rdDName').value.trim();
    if (!name) { _rdShowAlert('Giv opskriften et navn', 'error'); return; }

    try {
        _rdShowAlert('Opretter ny opskrift...', 'info');

        var baseServings = parseInt(document.getElementById('rdDBaseServings').value) || 1;

        // 1. Create recipe
        var resp = await postGrocyRecipe({
            name: name,
            description: document.getElementById('rdDNotes').value || null,
            base_servings: baseServings,
            desired_servings: baseServings,
            not_check_shoppinglist: 0,
            type: 'normal',
            product_id: null
        });

        var newId = parseInt(resp.created_object_id);

        // 2. Set userfields (inkl. aktiv arbejdstid pr. batch)
        await putGrocyRecipeUserfields(newId, {
            grupper: document.getElementById('rdDGroup').value,
            recipeunit: document.getElementById('rdDUnit').value,
            recipeunitnumber: String(baseServings),
            arbejdstid_min: _rdDs.workMin != null ? String(_rdDs.workMin) : ''
        });

        // 3. Create all ingredients
        for (var i = 0; i < _rdDs.ingredients.length; i++) {
            var ing = _rdDs.ingredients[i];
            await postGrocyRecipePos({
                recipe_id: newId,
                product_id: ing.product_id,
                amount: ing.amount,
                qu_id: ing.qu_id,
                only_check_single_unit_in_stock: 0,
                ingredient_group: ing.ingredient_group || null,
                not_check_stock_fulfillment: 0,
                variable_amount: null,
                price_factor: 1,
                round_up: 0
            });
        }

        // 4. Create all nestings
        for (var j = 0; j < _rdDs.nestings.length; j++) {
            var n = _rdDs.nestings[j];
            await postGrocyRecipeNesting({
                recipe_id: newId,
                includes_recipe_id: n.includes_recipe_id,
                servings: n.servings
            });
        }

        // Reload data
        await _rdLoadData(true);

        // Switch to editing the new recipe
        _rdDs.mode = 'modify';
        _rdDs.originalRecipeId = newId;
        _rdDs.removedIngIds = [];
        _rdDs.removedNestIds = [];
        _rdDs.dirty = false;

        var badge = document.getElementById('rdDBadge');
        if (badge) {
            badge.textContent = 'TILPASNING';
            badge.className = 'rd-mode-badge rd-modify';
        }
        var subtitle = document.getElementById('rdDSubtitle');
        if (subtitle) subtitle.innerHTML = 'Gemt som: <strong>' + esc(name) + '</strong>';
        var marker = document.getElementById('rdDChanged');
        if (marker) marker.classList.remove('rd-visible');
        var btnSave = document.getElementById('rdBtnSave');
        if (btnSave) btnSave.style.display = '';

        // Reload ingredients from server (now they have IDs)
        _rdDs.ingredients = _rdAllPositions
            .filter(function(p) { return p.recipe_id == newId; })
            .map(function(p) { return _rdShallowCopy(p); });
        _rdDs.nestings = _rdAllNestings
            .filter(function(nn) { return nn.recipe_id == newId; })
            .map(function(nn) { return _rdShallowCopy(nn); });
        _rdRenderIngredients();
        _rdRenderNestings();
        _rdComp = null;                    // ny opskrift → hent frisk kostpris
        _rdLoadComposition(newId);

        _rdShowAlert('"' + name + '" oprettet som ny opskrift!', 'success');

    } catch (err) {
        _rdShowAlert('Fejl: ' + err.message, 'error');
    }
}

// ═════��════════════════════════════════��═════════════════════
// HELPERS — Navigation
// ═══════��════════════════════════���═══════════════════════════

function _rdSwitchView(id) {
    var views = _rdContainer.querySelectorAll('.rd-view');
    for (var i = 0; i < views.length; i++) { views[i].classList.remove('rd-visible'); }
    var target = document.getElementById(id);
    if (target) target.classList.add('rd-visible');
}

function _rdIsActive(r) {
    if (r.active === undefined || r.active === null) return true;
    return r.active === '1' || r.active === 1 || r.active === true;
}

// ════════════════════════════════════════��═══════════════════
// HELPERS — Dirty tracking + alerts
// ════════════════════════���═══════════════════════════════���═══

function _rdMarkChanged() {
    _rdDs.dirty = true;
    var marker = document.getElementById('rdDChanged');
    if (marker) marker.classList.add('rd-visible');
}

function _rdShowAlert(msg, type) {
    var box = document.getElementById('rdAlertBox');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'rd-alert rd-alert-' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function() { el.remove(); }, 4000);
}

// ═══════���════════════════════════════════════════════════════
// HELPERS — Conversions + formatting
// ══════════════════════════════���═════════════════════════════

function _rdRound(num, dec) {
    if (dec === undefined) dec = 2;
    var p = Math.pow(10, dec);
    return Math.round(num * p) / p;
}

// Effektivt lager: eget lager + summen af børnenes lager (parent/child-substitution,
// spejler grocyAdapter.makeEffectiveStock så visning + consume er enige — #327).
function _rdEffectiveStock(productId) {
    var own = _rdStock[productId] || 0;
    var kids = _rdChildrenByParent[productId];
    if (!kids || !kids.length) return own;
    var sum = own;
    for (var i = 0; i < kids.length; i++) sum += _rdStock[kids[i]] || 0;
    return sum;
}

function _rdGetDisplayAmount(ing) {
    var product = _rdProductMap[ing.product_id];
    if (!product || ing.qu_id == product.qu_id_stock) return parseFloat(ing.amount) || 0;
    var factor = _rdGetConversionFactor(ing.product_id, product.qu_id_stock, ing.qu_id);
    if (factor === null) return parseFloat(ing.amount) || 0;
    return (parseFloat(ing.amount) || 0) * factor;
}

function _rdDisplayToRaw(displayAmount, quId, productId) {
    var product = _rdProductMap[productId];
    if (!product || quId == product.qu_id_stock) return displayAmount;
    var factor = _rdGetConversionFactor(productId, quId, product.qu_id_stock);
    if (factor === null) return displayAmount;
    return displayAmount * factor;
}

function _rdGetConversionFactor(productId, fromQuId, toQuId) {
    if (fromQuId == toQuId) return 1.0;
    var convs = _rdQuConversions;

    var pf = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (pf) return pf.factor;
    var pr = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (pr && pr.factor !== 0) return 1.0 / pr.factor;
    var gf = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (gf) return gf.factor;
    var gr = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (gr && gr.factor !== 0) return 1.0 / gr.factor;
    return _rdFindMultiHopFactor(productId, fromQuId, toQuId);
}

function _rdFindMultiHopFactor(productId, fromQuId, toQuId) {
    var edges = {};
    var relevantConvs = _rdQuConversions.filter(function(c) {
        return c.product_id == productId || c.product_id === null || c.product_id === undefined;
    });
    relevantConvs.forEach(function(c) {
        if (!edges[c.from_qu_id]) edges[c.from_qu_id] = [];
        if (!edges[c.to_qu_id]) edges[c.to_qu_id] = [];
        edges[c.from_qu_id].push({ target: c.to_qu_id, factor: c.factor });
        edges[c.to_qu_id].push({ target: c.from_qu_id, factor: 1.0 / c.factor });
    });
    var visited = {};
    visited[fromQuId] = true;
    var queue = [{ quId: fromQuId, cumulativeFactor: 1.0 }];
    while (queue.length > 0) {
        var curr = queue.shift();
        var neighbors = edges[curr.quId] || [];
        for (var i = 0; i < neighbors.length; i++) {
            if (neighbors[i].target == toQuId) return curr.cumulativeFactor * neighbors[i].factor;
            if (!visited[neighbors[i].target]) {
                visited[neighbors[i].target] = true;
                queue.push({ quId: neighbors[i].target, cumulativeFactor: curr.cumulativeFactor * neighbors[i].factor });
            }
        }
    }
    return null;
}

function _rdGetStepSize(val, unit) {
    var u = (unit || '').toLowerCase();
    if (u === 'stk' || u === 'antal') return 1;
    if (val >= 500) return 50;
    if (val >= 100) return 10;
    if (val >= 10) return 5;
    return 1;
}

function _rdFormatAmount(amount, unitName) {
    var u = (unitName || '').toLowerCase().trim();
    if ((u === 'kg' || u === 'kilo') && amount < 1 && amount > 0)
        return { amount: _rdRound(amount * 1000, 1), unit: 'g' };
    if ((u === 'l' || u === 'liter') && amount < 1 && amount > 0)
        return { amount: _rdRound(amount * 1000, 1), unit: 'ml' };
    if ((u === 'g' || u === 'gram') && amount >= 1000)
        return { amount: _rdRound(amount / 1000, 2), unit: 'kg' };
    if (u === 'ml' && amount >= 1000)
        return { amount: _rdRound(amount / 1000, 2), unit: 'l' };
    return { amount: _rdRound(amount, 2), unit: unitName };
}

function _rdShallowCopy(obj) {
    var copy = {};
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) copy[key] = obj[key];
    }
    return copy;
}

// ════════════════════════════════════════════════════════════
// HELPERS — Weight calculations
// ═════════════════════════════════���══════════════════════════

function _rdResolveWeightUnitIds() {
    if (_rdWeightUnitsCached) return;
    for (var id in _rdQuantityUnits) {
        var n = (_rdQuantityUnits[id] || '').toLowerCase();
        if (n === 'gram' || n === 'g') _rdGramQuId = parseInt(id);
        if (n === 'kilo' || n === 'kg') _rdKiloQuId = parseInt(id);
    }
    _rdWeightUnitsCached = true;
}

function _rdCalcWeightGrams(amount, unit, productId, quId) {
    var u = (unit || '').toLowerCase();
    if (u === 'g' || u === 'gram') return amount;
    if (u === 'kg' || u === 'kilo') return amount * 1000;
    if (u === 'ml') return amount;
    if (u === 'l' || u === 'liter') return amount * 1000;

    if (productId && quId && _rdQuConversions.length > 0) {
        _rdResolveWeightUnitIds();
        if (quId === _rdGramQuId) return amount;
        if (quId === _rdKiloQuId) return amount * 1000;

        var findFactor = function(fromId, toId, prodId) {
            var direct = _rdQuConversions.find(function(c) {
                return c.product_id == prodId && c.from_qu_id == fromId && c.to_qu_id == toId;
            });
            if (direct) return direct.factor;
            var reverse = _rdQuConversions.find(function(c) {
                return c.product_id == prodId && c.from_qu_id == toId && c.to_qu_id == fromId;
            });
            if (reverse && reverse.factor !== 0) return 1 / reverse.factor;
            return null;
        };

        if (_rdGramQuId) { var f = findFactor(quId, _rdGramQuId, productId); if (f !== null) return amount * f; }
        if (_rdKiloQuId) { var f2 = findFactor(quId, _rdKiloQuId, productId); if (f2 !== null) return amount * f2 * 1000; }

        var globalConvs = _rdQuConversions.filter(function(c) { return c.product_id === null || c.product_id === undefined; });
        if (_rdGramQuId) {
            var d = globalConvs.find(function(c) { return c.from_qu_id == quId && c.to_qu_id == _rdGramQuId; });
            if (d) return amount * d.factor;
            var r = globalConvs.find(function(c) { return c.from_qu_id == _rdGramQuId && c.to_qu_id == quId; });
            if (r && r.factor !== 0) return amount * (1 / r.factor);
        }
        if (_rdKiloQuId) {
            var d2 = globalConvs.find(function(c) { return c.from_qu_id == quId && c.to_qu_id == _rdKiloQuId; });
            if (d2) return amount * d2.factor * 1000;
            var r2 = globalConvs.find(function(c) { return c.from_qu_id == _rdKiloQuId && c.to_qu_id == quId; });
            if (r2 && r2.factor !== 0) return amount * (1 / r2.factor) * 1000;
        }
    }
    return 0;
}

function _rdCalcSubRecipeWeightGrams(subRecipeId, scaledServings, seen) {
    var subRecipe = _rdRecipeMap[subRecipeId];
    // Ingen early-return på tom ingrediensliste: en blanding kan bestå udelukkende
    // af andre blandinger, og så ligger hele vægten nedenunder.
    if (!subRecipe) return 0;

    seen = seen || {};
    if (seen[subRecipeId]) return 0;   // cyklus i recipes_nestings
    seen[subRecipeId] = true;

    var subBaseServings = parseFloat(subRecipe.base_servings) || 1;
    var subMult = scaledServings / subBaseServings;
    var total = 0;

    _rdAllPositions.filter(function(p) { return p.recipe_id == subRecipeId; }).forEach(function(ing) {
        if ((ing.ingredient_group || '').toLowerCase() === 'emballage') return;
        var product = _rdProductMap[ing.product_id] || {};
        var stockQuId = product.qu_id_stock || ing.qu_id;
        var stockUnitName = _rdQuantityUnits[stockQuId] || '';
        total += _rdCalcWeightGrams((parseFloat(ing.amount) || 0) * subMult, stockUnitName, ing.product_id, stockQuId);
    });

    // …og underopskriftens EGNE underopskrifter. Manglede før, så en blanding med
    // en blanding i vejede for lidt — og der findes nesting i dybde 2 i drift (#353).
    _rdAllNestings.filter(function(n) { return n.recipe_id == subRecipeId; }).forEach(function(n) {
        total += _rdCalcSubRecipeWeightGrams(n.includes_recipe_id, (parseFloat(n.servings) || 1) * subMult, seen);
    });

    delete seen[subRecipeId];
    return total;
}
