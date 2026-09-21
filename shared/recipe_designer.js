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
          fetchGrocyUserfields, GrocyNum, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ══════════��════════════════════���════════════════════════════

var _rdRecipes       = [];       // all recipes (with userfields)
var _rdRecipeMap     = {};       // recipe_id -> recipe
var _rdProducts      = [];       // raw products array
var _rdProductMap    = {};       // product_id -> product
var _rdQuantityUnits = {};       // qu_id -> unit name
var _rdQuUnitList    = [];       // rå enheds-array — RecipeYield slår navne op i det
var _rdStock         = {};       // product_id -> eget lager (stock-units)
var _rdChildrenByParent = {};    // parent_product_id -> [child product_id] (parent/child-lager)
var _rdQuConversions = [];       // unit conversions (raw)
var _rdAllPositions  = [];       // all recipe positions (raw)
var _rdAllNestings   = [];       // all nestings (raw)
var _rdUfOptions     = {};       // userfield-navn -> [valgmuligheder] (preset-lister fra Grocy)

var _rdContainer     = null;     // root DOM element
var _rdDataLoaded    = false;

// Designer state
var _rdDs = {
    mode: 'new',           // 'new' or 'modify'
    originalRecipeId: null,
    name: '',
    description: '',
    group: '',
    recipeUnit: '',        // userfield recipeunit — hvilken enhed én portion er
    yieldNum: null,        // userfield recipeunitnumber — hvor meget én portion er (null = ikke oplyst)
    productId: null,       // recipes.product_id — varen opskriften PRODUCERER (null = ingen)
    baseServings: 1,
    currentPortions: 1,
    ingredients: [],       // { id?, product_id, amount, qu_id, ingredient_group, note }
    nestings: [],          // { id?, includes_recipe_id, servings }
    removedIngIds: [],     // IDs to DELETE on save
    removedNestIds: [],
    dirty: false,
    workMin: null          // aktiv arbejdstid (min) pr. batch — userfield arbejdstid_min
};

// Det der stod i Grocy da opskriften blev åbnet. Gem sammenligner med det og
// sender KUN det der er ændret (#680) — et Gem uden ændringer skriver intet.
var _rdOrig = null;

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
    showLabor: false,         // løn skjult som standard — opt-in (kan distrahere). Huskes i localStorage.
    dbTarget:  70,
    basis:     'materials',   // 'full' (inkl. løn) | 'materials' (kun vareomkostning)
    priceCat:  'catering'
};

// Husk løn-visning pr. bruger (som kort-valgene).
function _rdLoadLaborPref() {
    try { var v = localStorage.getItem('rd_show_labor'); if (v !== null) _rdPrice.showLabor = (v === '1'); } catch (e) {}
}
function _rdSaveLaborPref() {
    try { localStorage.setItem('rd_show_labor', _rdPrice.showLabor ? '1' : '0'); } catch (e) {}
}

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
            fetchGrocyQuantityUnitConversions(),
            // Valgmulighederne til Gruppe og Enhed kommer fra Grocys egen
            // feltdefinition. Fejler kaldet, bruges værdierne i brug (se nedenfor).
            fetchGrocyUserfields().catch(function() { return []; }),
            // Varegrupper: editoren skal kunne sætte en på en ny vare. Fejler
            // kaldet, bliver feltet bare tomt — en manglende gruppe er lovlig.
            fetchGrocyProductGroups().catch(function() { return []; })
        ]);

        var rawRecipes   = results[0];
        var rawProducts  = results[1];
        var rawQus       = results[2];
        var rawStock     = results[3];
        var rawPos       = results[4];
        var rawNestings  = results[5];
        var rawConvs     = results[6];
        var rawUfDefs    = results[7] || [];
        _rdProductGroups = results[8] || [];

        _rdRecipes = rawRecipes.map(function(r) {
            r._group   = (r.userfields && r.userfields.grupper) || 'Ingen kategori';
            r._unit    = (r.userfields && r.userfields.recipeunit) || 'stk';
            r._unitNum = (r.userfields && r.userfields.recipeunitnumber) || '1';
            return r;
        });

        _rdRecipeMap = {};
        _rdRecipes.forEach(function(r) { _rdRecipeMap[r.id] = r; });

        _rdUfOptions = _rdPresetOptions(rawUfDefs);

        _rdProducts = rawProducts;
        _rdProductMap = {};
        rawProducts.forEach(function(p) { _rdProductMap[p.id] = p; });

        _rdQuantityUnits = {};
        rawQus.forEach(function(qu) { _rdQuantityUnits[qu.id] = qu.name; });
        _rdQuUnitList = rawQus;

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
    _rdEditorWidth(false);
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
    // Editoren (spec §4) arbejder på KLADDE-objektet og erstatter den gamle
    // designer-visning. Den gamle sti står tilbage indtil editoren er
    // verificeret i drift — en omskrivning man ikke kan slå fra, kan ikke
    // sammenlignes med det den erstattede.
    if (window.RecipeEditor && !window.RD_LEGACY) { _rdMountEditor(recipeId); return; }

    _rdDs.mode = 'modify';
    _rdDs.originalRecipeId = recipeId;
    _rdDs.name = recipe.name;
    _rdDs.description = recipe.description || '';
    // Rå værdier fra Grocy — ikke visnings-fallbacks ('Ingen kategori', 'stk'),
    // som ellers ville blive skrevet tilbage ved Gem (#680).
    var uf = recipe.userfields || {};
    _rdDs.group = uf.grupper == null ? '' : String(uf.grupper);
    _rdDs.recipeUnit = uf.recipeunit == null ? '' : String(uf.recipeunit);
    _rdDs.yieldNum = _rdOptNum(uf.recipeunitnumber);
    // Varen opskriften producerer. Grocy giver null eller et id som streng.
    _rdDs.productId = _rdOptNum(recipe.product_id);
    // Decimaler bevares: parseInt gjorde 2,8 portioner til 2.
    _rdDs.baseServings = _rdOptNum(recipe.base_servings) || 1;
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

    _rdOrig = _rdCaptureOrig(recipeId);

    _rdComp = null;                    // ny opskrift åbnet → nulstil kostpris-cache
    _rdShowDesigner();
    _rdLoadComposition(recipeId);      // hent kostpris/breakdown (async)
}
// ════════════════════════════════════════════════════════════
// EDITOREN (spec §4) — kladde-baseret, erstatter designer-visningen
// ════════════════════════════════════════════════════════════

/**
 * Åbn en opskrift (eller en tom) i editoren.
 *
 * Kladden hentes fra `/api/opskrifter/:id/editor`, som leverer PRÆCIS det
 * objekt `/beregn` tager imod og importen producerer (§15). Editoren ser
 * derfor ingen forskel på de tre indgange.
 *
 * `meta` er stamdata editoren tegner med — designeren har dem allerede fra
 * sin egen indlæsning, så editoren henter dem ikke igen.
 */
async function _rdMountEditor(recipeId) {
    _rdSwitchView('rdDesignerView');
    var view = document.getElementById('rdDesignerView');
    view.innerHTML = '<div class="rd-loading"><div class="rd-spinner"></div><p>Henter opskriften...</p></div>';

    var kladde = null, overview = null;
    if (recipeId != null) {
        try {
            var r = await apiFetch('/opskrifter/' + recipeId + '/editor');
            kladde = r.draft; overview = r.overview;
        } catch (e) {
            view.innerHTML = '<div class="rd-loading"><p>Kunne ikke hente opskriften: ' +
                esc(e.message) + '</p></div>';
            return;
        }
    }

    _rdEditorWidth(true);
    window.RecipeEditor.mount(view, {
        draft: kladde,
        overview: overview,
        mode: recipeId == null ? 'new' : 'modify',
        meta: _rdEditorMeta(recipeId),
        onExit: function (gemtId) {
            // Er der gemt, kender listen ikke det nye navn før dataene er
            // hentet igen — ellers viser pickeren den gamle tekst indtil
            // siden genindlæses.
            if (gemtId != null) { _rdLoadData(true); }
            _rdShowStart();
        },
    });
}

/** Stamdata editoren tegner med. Alt er hentet i forvejen af designeren. */
function _rdEditorMeta(recipeId) {
    var grupper = {};
    _rdRecipes.forEach(function (r) {
        var g = (r.userfields || {}).grupper;
        if (g) grupper[g] = 1;
    });

    var r = recipeId == null ? null : _rdRecipeMap[recipeId];
    return {
        groups: Object.keys(grupper).sort(),
        units: _rdQuUnitList,
        products: _rdProducts,
        productGroups: _rdProductGroups,
        stock: _rdStock,
        // Emballage (R7.5) afgøres af SERVEREN — `/beregn` sætter
        // `is_packaging` pr. linje i samme gennemgang som madvægten. Derfor
        // ingen kopi af `co2Materials`-listen her.
        erEmballageGruppe: null,
        productionTypeHint: r ? _rdProductionType(r) : null,
    };
}

/**
 * #329-reglen, aflæst — ikke skrevet af.
 *
 * Gruppen `RR produktion Hurtig` betyder at Bon laver varen ved LEVERET
 * (on_demand); alt andet med en vare laves efter plan (to_stock). Navnet
 * spejler `HURTIG_GROUP` i `services/ingredientResolver.js`; browseren kan
 * ikke require den, så en test holder de to i sync.
 */
var _RD_HURTIG_GROUP = 'RR produktion Hurtig';
function _rdProductionType(recipe) {
    if (!recipe || !recipe.product_id) return null;
    var g = String((recipe.userfields || {}).grupper || '').trim();
    return g === _RD_HURTIG_GROUP ? 'on_demand' : 'to_stock';
}


// ═════════════════════════���══════════════════════════════════
// START NEW
// ════════════════════════════════════════════════════════════

function _rdStartNew() {
    if (window.RecipeEditor && !window.RD_LEGACY) { _rdMountEditor(null); return; }
    _rdDs.mode = 'new';
    _rdDs.originalRecipeId = null;
    _rdDs.name = '';
    _rdDs.description = '';
    _rdDs.group = '';
    _rdDs.recipeUnit = '';     // vælges af brugeren — vi opfinder ikke en enhed
    _rdDs.yieldNum = null;     // ... og heller ikke et udbytte
    _rdDs.productId = null;    // ... og heller ikke en produceret vare
    _rdDs.baseServings = 1;
    _rdDs.currentPortions = 1;
    _rdDs.ingredients = [];
    _rdDs.nestings = [];
    _rdDs.removedIngIds = [];
    _rdDs.removedNestIds = [];
    _rdDs.dirty = false;
    _rdDs.workMin = null;
    _rdOrig = null;

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
                // Én portion = recipeunitnumber × recipeunit. Det er opskriftens
                // udbytte pr. portion, og det lagertræk, kostpris og CO₂ regner på (#680).
                '<div class="rd-meta-field rd-yield-field">' +
                    '<div class="rd-meta-label">1 portion er</div>' +
                    '<div class="rd-yield-pair">' +
                        '<input type="text" class="rd-meta-input rd-yield-num" id="rdDYield" inputmode="decimal" ' +
                            'placeholder="ikke oplyst" value="' + esc(_rdFmtNum(_rdDs.yieldNum)) + '">' +
                        '<select class="rd-meta-select" id="rdDUnit" title="En portion måles i kilo, gram, liter eller antal. Timer og Kr bruges p&#229; service-opskrifterne og kan ikke regnes om til et udbytte.">' +
                            _rdUnitOptionsHtml(_rdDs.recipeUnit) + '</select>' +
                    '</div>' +
                '</div>' +
                '<div class="rd-meta-field rd-short">' +
                    '<div class="rd-meta-label">Base antal</div>' +
                    '<input type="text" class="rd-meta-input" id="rdDBaseServings" inputmode="decimal" value="' + esc(_rdFmtNum(_rdDs.baseServings)) + '">' +
                '</div>' +
            '</div>' +

            // Producerer vare (#683). Egen række, ikke en fjerde meta-kolonne:
            // valget skifter produktionstype, lagertræk og kostpris, og
            // konsekvensen skal have plads til at stå skrevet.
            '<div class="rd-produces" id="rdProducesRow">' +
                '<div class="rd-meta-label">Producerer vare</div>' +
                '<div class="rd-produces-body" id="rdProducesBody"></div>' +
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
                    '<input type="text" class="rd-portions-num" id="rdPortNum" ' +
                        'inputmode="decimal" aria-label="M&#230;ngde" value="' + _rdFmtPortions(_rdDs.currentPortions) + '">' +
                    '<button class="rd-portions-btn" id="rdPortPlus">+</button>' +
                '</div>' +
                '<span class="rd-portions-unit" id="rdPortUnit">' + esc(_rdDs.recipeUnit) + '</span>' +
                '<span class="rd-base-info" id="rdBaseInfo">Base: ' + _rdFmtNum(_rdDs.baseServings) + ' ' + esc(_rdDs.recipeUnit) + '</span>' +
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
                        '<div class="rd-add-hint">Findes varen ikke i Grocy endnu? ' +
                            '<button class="rd-add-new" id="rdAddNewProduct" type="button">+ Opret ny vare</button></div>' +
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
                    '<div class="rd-nest-hint" id="rdNestHint"></div>' +
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
    _rdRenderProduces();
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

    // Felterne skriver i _rdDs — Gem læser derfra og sammenligner med _rdOrig.
    document.getElementById('rdDName').addEventListener('input', function() {
        _rdDs.name = this.value;
        _rdMarkChanged();
    });

    // Meta changes
    document.getElementById('rdDGroup').addEventListener('change', function() {
        _rdDs.group = this.value;
        // Gruppen afgør om en produceret vare er `on_demand` eller `to_stock`.
        _rdRenderProduces();
        _rdMarkChanged();
    });
    document.getElementById('rdDUnit').addEventListener('change', function() {
        _rdDs.recipeUnit = this.value;
        _rdUpdatePortionsDisplay();
        _rdRenderProduces();   // enheden indgår i udbyttet
        _rdMarkChanged();
    });
    var yieldEl = document.getElementById('rdDYield');
    yieldEl.addEventListener('change', function() {
        // Tomt felt = udbyttet er ikke oplyst. Vrøvl rulles tilbage til det der stod.
        var raw = String(this.value).trim();
        var n = raw === '' ? null : _rdOptNum(raw);
        if (raw !== '' && !(n > 0)) { this.value = _rdFmtNum(_rdDs.yieldNum); return; }
        _rdDs.yieldNum = n;
        this.value = _rdFmtNum(n);
        _rdRenderProduces();   // udbyttet står i konsekvens-teksten
        _rdMarkChanged();
    });
    yieldEl.addEventListener('focus', function() { this.select(); });
    document.getElementById('rdDBaseServings').addEventListener('change', function() {
        var n = _rdOptNum(this.value);
        if (!(n > 0)) { this.value = _rdFmtNum(_rdDs.baseServings); return; }
        _rdDs.baseServings = n;
        this.value = _rdFmtNum(n);
        _rdDs.currentPortions = _rdDs.baseServings;
        _rdUpdatePortionsDisplay();
        _rdRenderIngredients();
        _rdRecalcSummary();
        _rdMarkChanged();
    });

    // Notes
    document.getElementById('rdDNotes').addEventListener('input', function() {
        _rdDs.description = this.value;
        _rdMarkChanged();
    });

    // Portions
    document.getElementById('rdPortMinus').addEventListener('click', function() { _rdAdjustPortions(-1); });
    document.getElementById('rdPortPlus').addEventListener('click', function() { _rdAdjustPortions(1); });

    var rdPortInput = document.getElementById('rdPortNum');
    if (rdPortInput) {
        rdPortInput.addEventListener('change', function() { _rdSetPortions(_rdNum(this.value)); });
        // Markér ved fokus: man vil erstatte tallet, ikke sætte markøren midt i det.
        rdPortInput.addEventListener('focus', function() { this.select(); });
        // Enter lukker taltastaturet på tablet i stedet for at lade det stå åbent.
        rdPortInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
        });
    }

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
            if (pp === 'lonToggle') {
                _rdPrice.showLabor = e.target.checked;
                if (!_rdPrice.showLabor) _rdPrice.basis = 'materials';   // ingen løn → DB på råvarer
                _rdSaveLaborPref();
                _rdRenderPrice();
            } else if (pp === 'priceCat') { _rdPrice.priceCat = e.target.value; _rdRenderPrice(); }
        });
        pricePanel.addEventListener('click', function(e) {
            if (e.target.closest('[data-pp="lonAdd"]')) {   // "+ Medregn løn"-link
                _rdPrice.showLabor = true;
                _rdSaveLaborPref();
                _rdRenderPrice();
                return;
            }
            var btn = e.target.closest('[data-pp="basis"]');
            if (btn) { _rdPrice.basis = btn.getAttribute('data-val'); _rdRenderPrice(); }
        });
    }

    // Add ingredient panel
    document.getElementById('rdToggleAddPanel').addEventListener('click', _rdToggleAddPanel);
    document.getElementById('rdConfirmAdd').addEventListener('click', _rdConfirmAdd);
    document.getElementById('rdCancelAdd').addEventListener('click', _rdToggleAddPanel);
    var addNew = document.getElementById('rdAddNewProduct');
    if (addNew) addNew.addEventListener('click', _rdCreateIngredientProduct);

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
        if (clickedOutsideSelector(e, '#rdAddPanel .rd-ac-wrapper')) {
            var dd = document.getElementById('rdAcDropdown');
            if (dd) dd.classList.remove('rd-open');
        }
        if (clickedOutsideSelector(e, '#rdAddNestingPanel .rd-ac-wrapper')) {
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

// Dansk komma skal virke — taltastaturet på en iPad giver ',' og ikke '.'.
// Samme parsing som opskrift-vieweren og produktionsbatchen.
function _rdNum(v) {
    var s = String(v == null ? '' : v).trim().replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
}

function _rdFmtPortions(n) {
    return String(Math.round((n + Number.EPSILON) * 100) / 100).replace('.', ',');
}

// Ét sted der sætter mængden — både knapperne og feltet går igennem her.
// Bemærk: kun VISNINGEN skaleres. `baseServings` (det der gemmes på opskriften)
// røres ikke herfra.
function _rdSetPortions(p) {
    p = Math.round((Math.max(0, p || 0) + Number.EPSILON) * 100) / 100;
    // Tomt eller nulstillet felt falder tilbage til opskriftens eget tal.
    if (p <= 0) p = _rdDs.baseServings;
    _rdDs.currentPortions = p;
    _rdUpdatePortionsDisplay();
    _rdRenderIngredients();
    _rdRenderNestings();
    _rdRecalcSummary();
}

// ± går bevidst i hele trin. Decimaler tastes i feltet.
function _rdAdjustPortions(delta) {
    _rdSetPortions(_rdDs.currentPortions + delta);
}

function _rdUpdatePortionsDisplay() {
    var unit = _rdDs.recipeUnit;
    var el = document.getElementById('rdPortNum');
    if (el) el.value = _rdFmtPortions(_rdDs.currentPortions);
    var unitEl = document.getElementById('rdPortUnit');
    if (unitEl) unitEl.textContent = unit;
    var baseEl = document.getElementById('rdBaseInfo');
    if (baseEl) baseEl.textContent = 'Base: ' + _rdFmtNum(_rdDs.baseServings) + ' ' + unit;
}

// ═════════════���══════════════════════════���═══════════════════
// GROUP DROPDOWN
// ═��════════════════���══════════════════════════════════���══════

function _rdPopulateGroupDropdown() {
    // Værdien er den RÅ gruppe fra Grocy. Tidligere var den visnings-teksten
    // 'Ingen kategori', som et Gem så skrev ind som gruppe (#680).
    var sel = document.getElementById('rdDGroup');
    sel.innerHTML = _rdOptionsHtml('grupper', _rdDs.group, 'Ingen kategori');

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
    _rdLoadLaborPref();
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
    var v = GrocyNum.num(r.userfields[key]);
    return (isFinite(v) && v > 0) ? v : null;
}

function _rdCo2PerUnit() {
    var r = _rdRecipeMap[_rdDs.originalRecipeId];
    var v = r && r.userfields ? GrocyNum.num(r.userfields.Co2e) : NaN;
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
            // Løn-kontrol — skjult som standard, kun et diskret link når fra
            (!_rdPrice.showLabor
                ? '<button class="rd-pp-loan-add" data-pp="lonAdd">+ Medregn l&#248;n i beregningen</button>'
                : '<div class="rd-pp-lonrow">' +
                    '<label class="rd-pp-switch"><input type="checkbox" data-pp="lonToggle" checked><span></span></label>' +
                    '<span>Medregn l&#248;n:</span>' +
                    '<input type="number" class="rd-pp-min" data-pp="workMin" value="' + (_rdDs.workMin != null ? _rdDs.workMin : '') + '" placeholder="0" step="0.5" min="0">' +
                    '<span class="rd-pp-minunit">min/batch</span>' +
                    '<span class="rd-pp-hint">' + (lr.rate != null ? 'sats ' + _rdRound(lr.rate, 0) + ' kr/t + ' + _rdRound(lr.overhead_pct || 0, 0) + '% overhead' : 'ingen sats') + '</span>' +
                  '</div>' +
                  '<div class="rd-pp-basis">' +
                    '<span class="rd-pp-hint" style="margin-right:auto">Beregn DB p&#229;:</span>' +
                    '<span class="rd-pp-basis-btn' + (matActive ? ' rd-active' : '') + '" data-pp="basis" data-val="materials">R&#229;varer</span>' +
                    '<span class="rd-pp-basis-btn' + (!matActive ? ' rd-active' : '') + '" data-pp="basis" data-val="full">Inkl. l&#248;n</span>' +
                  '</div>');
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
                } else if (typeof setEstimatePrice === 'function') {
                    // Uden pris kan opskriften ikke koste noget. Et overslag er
                    // dit eget bud — nok til at regne en salgspris på, indtil
                    // varen får et varenummer (#657).
                    var suNm = _rdQuantityUnits[(product.qu_id_stock || '')] || '';
                    costLine = '<div class="rd-ing-cost rd-ing-nocost">ingen pris ' +
                        '<button class="rd-ing-est" data-pid="' + ing.product_id +
                        '" data-unit="' + esc(suNm) + '">+ overslag</button></div>';
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
        var estBtn = e.target.closest('.rd-ing-est');
        if (estBtn) {
            _rdOpenEstimate(estBtn);
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

/** Inline-felt til et manuelt overslag på en råvare uden pris (#657). */
function _rdOpenEstimate(btn) {
    var box  = btn.parentNode;
    var pid  = parseInt(btn.getAttribute('data-pid'));
    var unit = btn.getAttribute('data-unit') || '';
    var before = box.innerHTML;
    box.innerHTML = '<input type="text" inputmode="decimal" class="rd-ing-est-input" placeholder="0,00"> ' +
        '<span class="rd-ing-est-unit">kr/' + esc(unit) + '</span> ' +
        '<button class="rd-ing-est-save">Gem</button> ' +
        '<button class="rd-ing-est-cancel">Fortryd</button>';
    var input = box.querySelector('.rd-ing-est-input');
    input.focus();

    box.querySelector('.rd-ing-est-cancel').onclick = function(ev) {
        ev.stopPropagation(); box.innerHTML = before;
    };
    var save = async function(ev) {
        ev.stopPropagation();
        var n = parseFloat(String(input.value).trim().replace(/\./g, '').replace(',', '.'));
        if (!isFinite(n) || n <= 0) { _rdShowAlert('Skriv et overslag større end 0', 'error'); return; }
        var btn = box.querySelector('.rd-ing-est-save');
        if (btn) { btn.disabled = true; btn.textContent = 'Regner…'; }
        try {
            var out = await setEstimatePrice(pid, n, true, 'opskrift-editor');
            _rdShowAlert(out && out.refresh_error
                ? 'Overslag gemt, men kostpriserne kunne ikke genberegnes'
                : 'Overslag gemt', out && out.refresh_error ? 'error' : 'success');
            // Kostprisen er nu en anden — hent breakdownet forfra.
            if (_rdDs.originalRecipeId) _rdLoadComposition(_rdDs.originalRecipeId);
        } catch (err) {
            _rdShowAlert('Fejl: ' + err.message, 'error');
            box.innerHTML = before;
        }
    };
    box.querySelector('.rd-ing-est-save').onclick = save;
    input.onkeydown = function(ev) { if (ev.key === 'Enter') save(ev); };
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
    var realDisplayValue = _rdDisplayToOrigUnit(parseFloat(displayValue) || 0, displayUnit,
        _rdQuantityUnits[ing.qu_id] || '');

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

/**
 * ÉN produkt-vælger, to steder.
 *
 * "+ Tilføj ingrediens" og "Producerer vare" gør det samme: find varen — eller
 * opret den, hvis den ikke findes i Grocy endnu. De var skrevet hver for sig,
 * og efter én dag havde de allerede hver sit filter. To kopier af det samme
 * opslag driver fra hinanden; det var præcis sådan `_buildMailVars` blev til
 * tre uenige udgaver.
 *
 * `meta` er det eneste der skiller dem: ingredienserne viser lagerstatus,
 * produceret vare viser hvem der laver varen i forvejen.
 */
function _rdProductDropdown(cfg, q) {
    var dd = document.getElementById(cfg.dropdownId);
    var input = document.getElementById(cfg.inputId);
    if (!dd || !input) return;
    if (!q || q.length < 1) { dd.classList.remove('rd-open'); return; }

    var needle = String(q).toLowerCase();
    // Inaktive varer udelades BEGGE steder. «kål» blev sat inaktiv i en
    // optælling og gav 13 bons `partial` (#645): en inaktiv vare kan hverken
    // forbruges som ingrediens eller lægges på lager som produceret vare.
    var matches = _rdProducts.filter(function(p) {
        return _rdIsActive(p) && p.name && p.name.toLowerCase().indexOf(needle) !== -1;
    }).slice(0, 10);
    if (!matches.length) { dd.classList.remove('rd-open'); return; }

    dd.innerHTML = matches.map(function(p) {
        return '<div class="rd-ac-item" data-pid="' + p.id + '">' +
            '<span class="rd-ac-item-name">' + esc(p.name) + '</span>' +
            '<span class="rd-ac-item-meta">' + cfg.meta(p) + '</span>' +
        '</div>';
    }).join('');

    var rect = input.getBoundingClientRect();
    dd.style.top = rect.bottom + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.right = 'auto';
    dd.style.width = rect.width + 'px';
    dd.style.maxWidth = rect.width + 'px';
    dd.classList.add('rd-open');

    dd.onclick = function(e) {
        var item = e.target.closest('.rd-ac-item');
        if (!item) return;
        cfg.onPick(parseInt(item.getAttribute('data-pid')));
    };
}

/** Lagerstatus — det ingredienserne skal vide. */
function _rdMetaStock(p) {
    var stockAmt = _rdEffectiveStock(p.id);
    var unitName = _rdQuantityUnits[p.qu_id_stock] || '';
    var dotStyle = stockAmt > 0 ? 'color:var(--color-green-dark)' : 'color:var(--color-red)';
    return '<span style="' + dotStyle + '">&#9679;</span> ' + _rdRound(stockAmt, 1) + ' ' + esc(unitName);
}

/** Hvem laver varen i forvejen — det "producerer vare" skal vide. */
function _rdMetaProducer(p) {
    var unitName = _rdQuantityUnits[p.qu_id_stock] || '';
    var other = _rdRecipes.filter(function(r) {
        return Number(r.product_id) === Number(p.id) && Number(r.id) !== Number(_rdDs.originalRecipeId);
    });
    return esc(unitName) + (other.length ? ' &middot; laves allerede af ' + esc(other[0].name) : '');
}

function _rdOnAcInput(q) {
    _rdProductDropdown({
        inputId: 'rdAcInput', dropdownId: 'rdAcDropdown',
        meta: _rdMetaStock, onPick: _rdSelectProduct
    }, q);
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

        // Er underopskriften blevet en vare (#270), hører den hjemme som en
        // ingrediens-linje. Den bliver ikke omdannet af sig selv — det er en
        // opskriftsændring, og den skal et menneske tage stilling til.
        var prod = _rdRecipeProduct(sub);
        var convert = '';
        if (prod) {
            var asStock = _rdNestingAsStock(sub, prod, parseFloat(n.servings) || 0);
            convert = asStock != null
                ? '<button class="rd-nest-convert" data-nest-convert="' + i + '" title="' +
                    esc(sub.name + ' producerer varen ' + prod.name + '. Lægges den ind som ingrediens, trækkes varen i stedet for dens råvarer.') +
                    '">&#8594; vare-linje</button>'
                : '<span class="rd-nest-convert rd-nest-convert-off" title="' +
                    esc(sub.name + ' producerer varen ' + prod.name + ', men udbyttet er ikke oplyst, så mængden kan ikke regnes om. Udfyld "1 portion er" på ' + sub.name + ' først.') +
                    '">&#8594; vare-linje</span>';
        }

        return '<div class="rd-nesting-card' + (prod ? ' rd-nesting-card-legacy' : '') + '">' +
            '<span class="rd-nesting-icon">&#x1F4CB;</span>' +
            '<span class="rd-nesting-name">' + esc(name) + costLine + '</span>' +
            '<div class="rd-nesting-amt">' +
                '<input type="number" class="rd-nesting-input" data-idx="' + i + '" data-display-unit="' + esc(fmt.unit) + '" data-orig-unit="' + esc(unit) + '" value="' + fmt.amount + '" step="0.01">' +
                '<span class="rd-nesting-unit">' + esc(fmt.unit) + '</span>' +
            '</div>' +
            convert +
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
        var conv = e.target.closest('[data-nest-convert]');
        if (conv) { _rdConvertNestingToLine(parseInt(conv.getAttribute('data-nest-convert'))); return; }
        var btn = e.target.closest('[data-nest-idx]');
        if (btn) {
            _rdRemoveNesting(parseInt(btn.getAttribute('data-nest-idx')));
        }
    };
}

function _rdUpdateNesting(idx, displayVal, displayUnit, origUnit) {
    var mult = _rdDs.currentPortions / _rdDs.baseServings;
    // Alle fire veje tilbage — manglede g→kg og ml→l, så 2 kg blev gemt som 2 g (#364).
    var val = _rdDisplayToOrigUnit(parseFloat(displayVal) || 0, displayUnit, origUnit);
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
        var h0 = document.getElementById('rdNestHint');
        if (h0) { h0.innerHTML = ''; h0.className = 'rd-nest-hint'; }
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
        // Producerer opskriften en vare (#270), lægges den ind som ingrediens-linje
        // og ikke som nesting. Mærket viser hvad der sker FØR man vælger.
        var prod = _rdRecipeProduct(r);
        var badge = prod
            ? '<span class="rd-nest-badge rd-nest-badge-vare">&#8594; ' + esc(prod.name) + '</span>'
            : '<span class="rd-nest-badge">underopskrift</span>';
        return '<div class="rd-ac-item" data-rid="' + r.id + '">' +
            '<span class="rd-ac-item-name">' + esc(r.name) + ' ' + badge + '</span>' +
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
        _rdSelectNestRecipe(parseInt(item.getAttribute('data-rid')));
        dd.classList.remove('rd-open');
    };
}

/**
 * Valget af underopskrift.
 *
 * Producerer den en vare (#270), skifter panelet til at tage imod en mængde i
 * VARENS lager-enhed. Det er det tal man tænker i ("25 g Chili Mayo"), og så
 * er der hverken noget at regne om eller noget at regne forkert. Udbyttet
 * vises som oplysning, ikke som mellemregning.
 */
function _rdSelectNestRecipe(rid) {
    _rdSelectedNestRecipe = _rdRecipeMap[rid] || null;
    var hint = document.getElementById('rdNestHint');
    if (!_rdSelectedNestRecipe) { if (hint) hint.innerHTML = ''; return; }

    var r = _rdSelectedNestRecipe;
    var prod = _rdRecipeProduct(r);
    var inp = document.getElementById('rdNestAcInput');
    if (inp) inp.value = r.name;
    var lbl = document.getElementById('rdNestUnitLabel');
    if (lbl) lbl.textContent = prod ? (_rdQuantityUnits[prod.qu_id_stock] || '') : (r._unit || 'portion');

    if (hint) {
        if (prod) {
            var y = _rdNestingAsStock(r, prod, 1);
            var unit = _rdQuantityUnits[prod.qu_id_stock] || '';
            hint.innerHTML = '&#8594; l&#230;gges ind som ingrediensen <strong>' + esc(prod.name) +
                '</strong> &#8212; ikke som underopskrift. R&#229;varerne tr&#230;kkes af "' + esc(r.name) + '" n&#229;r varen laves.' +
                (y != null ? ' (1 portion af ' + esc(r.name) + ' er ' + _rdFmtNum(_rdRound(y, 3)) + ' ' + esc(unit) + ')' : '');
            hint.className = 'rd-nest-hint rd-nest-hint-vare';
        } else {
            hint.innerHTML = 'L&#230;gges ind som underopskrift. M&#230;ngden er antal portioner af ' + esc(r.name) + '.';
            hint.className = 'rd-nest-hint';
        }
    }
    var amtEl = document.getElementById('rdNestAmt');
    if (amtEl) { amtEl.value = prod ? '' : '1'; amtEl.focus(); }
}

function _rdConfirmAddNesting() {
    if (!_rdSelectedNestRecipe) { _rdShowAlert('Vaelg en opskrift foerst', 'error'); return; }
    var amt = parseFloat(document.getElementById('rdNestAmt').value);
    if (!amt || amt <= 0) { _rdShowAlert('Indtast en maengde', 'error'); return; }

    // #270: producerer opskriften en vare, er det varen der skal på linjen.
    // Nestings er ikke forbudt — slider-boksene 77/78 er bevidst indlejrede —
    // men reglen er "har underopskriften en vare, så brug varen".
    var prodSel = _rdRecipeProduct(_rdSelectedNestRecipe);
    // Navnet læses FØR panelet lukkes: _rdToggleAddNestingPanel rydder
    // _rdSelectedNestRecipe når den åbner, og så afhænger kvitteringen af
    // hvilken tilstand panelet stod i.
    var subName = _rdSelectedNestRecipe.name;
    if (prodSel) {
        var multSel = _rdDs.currentPortions / _rdDs.baseServings;
        _rdDs.ingredients.push({
            id: null,
            recipe_id: _rdDs.originalRecipeId,
            product_id: prodSel.id,
            amount: amt / multSel,
            qu_id: prodSel.qu_id_stock,
            ingredient_group: null,
            note: null,
            only_check_single_unit_in_stock: 0,
            not_check_stock_fulfillment: 0,
            variable_amount: null,
            price_factor: 1,
            round_up: 0
        });
        _rdMarkChanged();
        _rdToggleAddNestingPanel();
        _rdPopulateGroupDropdown();
        _rdRenderIngredients();
        _rdRecalcSummary();
        _rdShowAlert(prodSel.name + ' tilføjet som ingrediens (varen laves af "' + subName + '")', 'success');
        return;
    }

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
    _rdShowAlert(subName + ' tilfojet som underopskrift', 'success');
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

// ════════════════════════════════════════════════════════════
// PRODUCERET VARE (#683)
// ════════════════════════════════════════════════════════════
//
// `recipes.product_id` er ikke et felt som de andre. Sættes det, skifter tre
// ting i driften i samme øjeblik, uden at nogen har bedt om dem:
//
//   1. PRODUKTIONSTYPEN. `productionTypeOf` (services/ingredientResolver.js)
//      giver `on_demand` når gruppen er `RR produktion Hurtig`, ellers
//      `to_stock`. `on_demand` betyder at Bon selv laver varen ved LEVERET.
//   2. LAGERTRÆKKET (#329). En `to_stock` underopskrift trækker fremover
//      VAREN, ikke sine råvarer. Hver menu der nester opskriften skifter.
//   3. KOSTPRISEN (#558). Varens pris kommer fra opskriften i stedet for
//      lagerprisen — det flytter kostpris og DB på hver ret der bruger varen.
//
// #270 rullede de otte konverteringer ud én ad gangen med fingerprint før og
// efter, netop fordi konsekvensen er så stor. Her sidder den bag en dropdown,
// og så skal konsekvensen siges FØR der gemmes — ikke opdages ved næste
// optælling. Derfor findes `_rdComputeProducesImpact`.

// Gruppen der gør en produceret vare til `on_demand`. Spejler HURTIG_GROUP i
// services/ingredientResolver.js — browserkode kan ikke require'e den. Testen
// asserterer at de to er ens; driver de fra hinanden, viser designeren noget
// andet end driften gør (samme greb som _vmFindFactor mod quConvert i #358).
var RD_HURTIG_GROUP = 'rr produktion hurtig';

/**
 * Ren funktion: hvad ændrer sig hvis `recipeId` producerer `productId`?
 *
 * Alt kommer ind som argumenter, så den kan efterprøves uden en DOM og uden
 * Grocy. `_rdProducesImpact` er den tynde indpakning der læser modulets state.
 */
function _rdComputeProducesImpact(inp) {
    inp = inp || {};
    var pid = (inp.productId == null || inp.productId === '') ? null : Number(inp.productId);
    var out = {
        productId: pid,
        productName: '',
        stockUnit: '',
        type: null,            // 'on_demand' | 'to_stock' | null
        otherProducers: [],    // andre opskrifter der producerer SAMME vare
        winner: null,          // den opskrift kostprisen faktisk regnes efter
        isWinner: true,
        nestedIn: [],          // opskrifter der nester DENNE — de skifter lagertræk
        yieldStock: null,      // udbytte for hele opskriften, i varens lager-enhed
        yield: null,           // _rdYieldStatus — inkl. hvorfor det evt. ikke kan bestemmes
        productInactive: false
    };
    if (!pid) return out;

    var product = inp.product || null;
    out.productName = (product && product.name) || ('#' + pid);
    out.productInactive = !!(product && !_rdIsActive(product));
    if (product && product.qu_id_stock != null) {
        var u = (inp.units || []).find(function(x) { return Number(x.id) === Number(product.qu_id_stock); });
        out.stockUnit = u ? (u.name || '') : '';
    }

    out.type = String(inp.group || '').trim().toLowerCase() === RD_HURTIG_GROUP
        ? 'on_demand' : 'to_stock';

    // Flere opskrifter kan producere samme vare (Falaffel har tre). `recipeCost.js`
    // vælger den med LAVESTE id — derfor er det ikke nok at nævne dem, vi skal
    // også sige hvilken der vinder. En NY opskrift har endnu intet id og kan
    // per definition ikke være den laveste.
    var mine = inp.recipeId == null ? null : Number(inp.recipeId);
    var producers = (inp.recipes || []).filter(function(r) {
        return Number(r.product_id) === pid && (mine == null || Number(r.id) !== mine);
    });
    out.otherProducers = producers.map(function(r) { return { id: Number(r.id), name: r.name }; });
    if (producers.length) {
        var lowest = out.otherProducers.slice().sort(function(a, b) { return a.id - b.id; })[0];
        out.isWinner = mine != null && mine < lowest.id;
        out.winner = out.isWinner ? { id: mine, name: inp.recipeName || 'denne opskrift' } : lowest;
    }

    if (mine != null) {
        var seen = {};
        (inp.nestings || []).forEach(function(n) {
            if (Number(n.includes_recipe_id) !== mine) return;
            var parent = (inp.recipes || []).find(function(r) { return Number(r.id) === Number(n.recipe_id); });
            if (!parent || seen[parent.id]) return;
            seen[parent.id] = true;
            out.nestedIn.push({ id: Number(parent.id), name: parent.name });
        });
    }

    out.yield = _rdYieldStatus({
        yieldNum: inp.yieldNum, recipeUnit: inp.recipeUnit, baseServings: inp.baseServings
    }, product, inp.units, inp.conversions);
    out.yieldStock = out.yield.amount;

    return out;
}

/**
 * Udbyttet for HELE opskriften, i varens lager-enhed — OG hvorfor det evt. ikke
 * kan bestemmes.
 *
 * `RecipeYield.yieldInStockUnits` giver op tre forskellige steder, og de kræver
 * hver sin handling: udfyld tallet · vælg en rigtig enhed · få enheden regnet om
 * til varens lager-enhed. Sagde advarslen det samme i alle tre tilfælde, ville
 * den bede folk om at udfylde noget der allerede står der — og en anvisning der
 * ikke passer, lærer folk at ignorere advarslen (samme svigt som vagthunden i #359).
 *
 * Reglen lånes: vi kalder RecipeYields EGNE primitiver i samme rækkefølge frem
 * for at skrive en udgave til. En parallel implementering ville drive fra
 * kostprisen og produktionsbatchen, og så ville designeren vise ét tal mens
 * lageret fik et andet (#360). Testen asserterer at de to altid er enige.
 *
 * @returns { ok, amount, reason, unitName, total }
 *   reason: null | 'ingen_vare' | 'mangler_tal' | 'ukendt_enhed' | 'mangler_omregning'
 */
function _rdYieldStatus(vals, product, units, conversions) {
    var out = { ok: false, amount: null, reason: 'ingen_vare', unitName: _rdStr(vals.recipeUnit), total: null };
    if (typeof RecipeYield === 'undefined' || !product) return out;

    var per = vals.yieldNum;
    if (!(per > 0)) { out.reason = 'mangler_tal'; return out; }
    var base = (vals.baseServings > 0) ? vals.baseServings : 1;
    out.total = per * base;

    var quId = RecipeYield.unitIdByName(units || [], out.unitName);
    if (quId == null) { out.reason = 'ukendt_enhed'; return out; }

    var f = RecipeYield.factorToStock(product, quId, conversions || []);
    if (f == null) { out.reason = 'mangler_omregning'; return out; }

    out.ok = true;
    out.amount = out.total * f;
    out.reason = null;
    return out;
}

/** Indpakning over modulets state — bruges af rendering og af Gem. */
function _rdProducesImpact(productId) {
    return _rdComputeProducesImpact({
        recipeId: _rdDs.originalRecipeId,
        recipeName: _rdDs.name,
        productId: productId,
        product: productId ? _rdProductMap[productId] : null,
        group: _rdDs.group,
        yieldNum: _rdDs.yieldNum,
        recipeUnit: _rdDs.recipeUnit,
        baseServings: _rdDs.baseServings,
        recipes: _rdRecipes,
        nestings: _rdAllNestings,
        units: _rdQuUnitList,
        conversions: _rdQuConversions
    });
}

/**
 * Hvad man skal gøre, når udbyttet ikke kan bestemmes.
 *
 * Tre forskellige årsager, tre forskellige handlinger. Den samme tekst til alle
 * tre ville bede om at udfylde et felt der i to af tilfældene allerede står der.
 */
function _rdYieldAdvice(im) {
    var y = im.yield || {};
    if (y.reason === 'ukendt_enhed') {
        return y.unitName
            ? '"' + y.unitName + '" er ikke en måleenhed, så udbyttet kan ikke regnes. ' +
              'Vælg kilo, gram, liter eller antal i feltet "1 portion er" ovenfor.'
            : 'Vælg en enhed i feltet "1 portion er" ovenfor — kilo, gram, liter eller antal.';
    }
    if (y.reason === 'mangler_omregning') {
        // Begge felter ER udfyldt. Det der mangler, er hvad én enhed vejer.
        return 'Opskriften giver ' + _rdFmtNum(_rdRound(y.total, 3)) + ' ' + y.unitName +
            ', men ' + im.productName + ' lagerføres i ' + (im.stockUnit || 'en anden enhed') +
            '. Skriv udbyttet i ' + (im.stockUnit || 'varens egen enhed') + ' ovenfor — ' +
            'eller få det noteret på varen hvor meget ét ' + y.unitName + ' vejer.';
    }
    return 'Udbyttet mangler. Skriv i feltet "1 portion er" ovenfor hvor meget ét hold giver ' +
        '(fx 1,1 kg). Uden det kan varen ikke laves automatisk.';
}

/**
 * Hvad valget betyder, delt i tre.
 *
 * Panelet står fremme for enhver der åbner opskriften — også en i køkkenet der
 * bare skal se hvad der er i den. Derfor er `head` én linje og `warnings` kun
 * det man kan gøre noget ved; resten hører under en foldet forklaring.
 * Bekræftelsen ved Gem viser alle tre, for dér træffes beslutningen.
 */
function _rdProducesInfo(im) {
    var head = im.type === 'on_demand'
        ? 'Laves automatisk når en bon leveres.'
        : 'Laves efter plan og lægges på lager.';
    var warnings = [], details = [];

    if (im.yieldStock != null) {
        details.push('Ét hold giver ' + _rdFmtNum(_rdRound(im.yieldStock, 3)) + ' ' + im.stockUnit + ' af varen.');
    } else {
        warnings.push(_rdYieldAdvice(im));
    }
    if (im.nestedIn.length) {
        warnings.push(im.nestedIn.length + ' opskrift' + (im.nestedIn.length === 1 ? '' : 'er') +
            ' bruger denne som underopskrift og skifter til at trække varen: ' +
            im.nestedIn.map(function(r) { return r.name; }).join(', ') +
            '. Åbn dem og se efter at det er dét du vil.');
    }
    if (im.otherProducers.length) {
        warnings.push(im.otherProducers.map(function(r) { return r.name; }).join(', ') +
            ' laver også ' + im.productName + '. Kostprisen regnes efter ' +
            (im.isWinner ? 'denne opskrift' : im.winner.name) +
            '. Skal kun den ene gælde, så fjern varen fra den anden.');
    }
    if (im.productInactive) {
        warnings.push(im.productName + ' er lagt væk og kan ikke lægges på lager. ' +
            'Hent den frem igen under Lager → Lageroversigt → "Inaktive".');
    }

    details.push('Opskrifter der bruger ' + im.productName + ' trækker varen fra lageret — ikke dens råvarer.');
    details.push('Kostprisen på ' + im.productName + ' regnes ud fra denne opskrift.');
    return { head: head, warnings: warnings, details: details };
}

// ── Panelet ──────────────────────────────────────────────────

function _rdRenderProduces() {
    var body = document.getElementById('rdProducesBody');
    if (!body) return;

    if (!_rdDs.productId) {
        body.innerHTML =
            '<div class="rd-produces-pick">' +
                '<div class="rd-ac-wrapper">' +
                    '<input type="text" class="rd-ac-input" id="rdProdAcInput" placeholder="S&#248;g vare...">' +
                    '<div class="rd-ac-dropdown" id="rdProdAcDropdown"></div>' +
                '</div>' +
                '<button class="rd-add-btn" id="rdProdNew">+ Opret ny vare</button>' +
            '</div>' +
            '<div class="rd-produces-note">Opskriften producerer ingen vare. Menuer der bruger den ' +
                'nester den som underopskrift og tr&#230;kker dens r&#229;varer.</div>';
        _rdBindProducesPicker();
        return;
    }

    var im = _rdProducesImpact(_rdDs.productId);
    var info = _rdProducesInfo(im);
    body.innerHTML =
        '<div class="rd-produces-pick">' +
            '<span class="rd-produces-pill">' + esc(im.productName) +
                (im.stockUnit ? ' <span class="rd-produces-unit">' + esc(im.stockUnit) + '</span>' : '') +
            '</span>' +
            '<span class="rd-produces-type rd-produces-' + im.type + '">' +
                (im.type === 'on_demand' ? 'Laves ved levering' : 'Laves p&#229; lager') +
            '</span>' +
            '<button class="rd-produces-clear" id="rdProdClear">&#10005; Fjern</button>' +
        '</div>' +
        '<div class="rd-produces-note">' + esc(info.head) + '</div>' +
        (info.warnings.length
            ? '<div class="rd-produces-note rd-produces-warn">' +
                info.warnings.map(function(l) { return '<div>&#9888; ' + esc(l) + '</div>'; }).join('') +
              '</div>'
            : '') +
        '<details class="rd-produces-more">' +
            '<summary>Hvad betyder det?</summary>' +
            info.details.map(function(l) { return '<div>' + esc(l) + '</div>'; }).join('') +
        '</details>';

    var clear = document.getElementById('rdProdClear');
    if (clear) clear.addEventListener('click', function() {
        _rdDs.productId = null;
        _rdMarkChanged();
        _rdRenderProduces();
        _rdRenderNestings();
    });
}

function _rdBindProducesPicker() {
    var inp = document.getElementById('rdProdAcInput');
    if (inp) {
        var deb = null;
        inp.addEventListener('input', function() {
            clearTimeout(deb);
            deb = setTimeout(function() { _rdOnProdAcInput(inp.value); }, 150);
        });
    }
    var neu = document.getElementById('rdProdNew');
    if (neu) neu.addEventListener('click', _rdCreateProducedProduct);
}

function _rdOnProdAcInput(q) {
    _rdProductDropdown({
        inputId: 'rdProdAcInput', dropdownId: 'rdProdAcDropdown',
        meta: _rdMetaProducer, onPick: _rdSetProducedProduct
    }, q);
}

function _rdSetProducedProduct(pid) {
    if (!_rdProductMap[pid]) return;
    _rdDs.productId = pid;
    _rdMarkChanged();
    _rdRenderProduces();
    _rdRenderNestings();
}

// ── Opret ny vare — genbruger shared/product_create.js ────────
//
// Ikke en ny formular. Tre steder der kan oprette et produkt med hver sit sæt
// defaults (lager-enhed, produktgruppe, lokation) er præcis dét #358 og #657
// gentagne gange er faldet over.
//
// Én indgang, to kaldesteder: ingrediensen og den producerede vare. De skal
// kunne det samme — at skulle forlade designeren for at oprette en ingrediens,
// mens den producerede vare kunne oprettes på stedet, var en vilkårlig forskel.
function _rdOpenProductCreate(opts) {
    opts = opts || {};
    if (typeof initProductCreate !== 'function') {
        _rdShowAlert('Produktoprettelse er ikke tilgængelig her', 'error');
        return;
    }
    var ov = document.createElement('div');
    ov.className = 'rd-pc-overlay';
    ov.innerHTML =
        '<div class="rd-pc-panel">' +
            '<div class="rd-pc-head">' +
                '<span>' + esc(opts.title || 'Opret vare') + '</span>' +
                '<button class="rd-pc-close" type="button">&#10005;</button>' +
            '</div>' +
            '<div class="rd-pc-mount"></div>' +
        '</div>';
    document.body.appendChild(ov);

    var close = function() {
        if (typeof cleanupProductCreate === 'function') cleanupProductCreate();
        ov.remove();
    };
    ov.querySelector('.rd-pc-close').addEventListener('click', close);
    if (typeof closeOnOutsideClick === 'function') {
        closeOnOutsideClick(ov, close, ov.querySelector('.rd-pc-panel'));
    }

    initProductCreate(ov.querySelector('.rd-pc-mount'), {
        onCreated: function(productId, name) {
            close();
            // Varen findes nu i Grocy, men ikke i designerens hukommelse.
            _rdLoadData(true).then(function() {
                if (opts.onCreated) opts.onCreated(parseInt(productId), name);
            });
        }
    });
}

/** "+ Opret ny vare" fra ingrediens-panelet: opret og vælg, så kun mængden mangler. */
function _rdCreateIngredientProduct() {
    _rdOpenProductCreate({
        title: 'Opret vare — ingrediens i "' + (_rdDs.name || 'denne opskrift') + '"',
        onCreated: function(productId, name) {
            _rdSelectProduct(productId);
            _rdShowAlert(name + ' oprettet — skriv mængden', 'success');
        }
    });
}

/** "+ Opret ny vare" fra "producerer vare". */
function _rdCreateProducedProduct() {
    _rdOpenProductCreate({
        title: 'Opret vare — produceres af "' + (_rdDs.name || 'denne opskrift') + '"',
        onCreated: function(productId, name) {
            _rdSetProducedProduct(productId);
            _rdShowAlert(name + ' oprettet og valgt som produceret vare', 'success');
        }
    });
}

// ── Underopskrift der ER en vare (#270) ──────────────────────

/** Varen en opskrift producerer — eller null. */
function _rdRecipeProduct(recipe) {
    var pid = recipe && _rdOptNum(recipe.product_id);
    return pid ? (_rdProductMap[pid] || null) : null;
}

/**
 * Mængden i varens lager-enhed for `servings` portioner af `recipe`.
 * null = udbyttet kan ikke bestemmes, og så omregnes der ikke — vi gætter aldrig.
 */
function _rdNestingAsStock(recipe, product, servings) {
    if (typeof RecipeYield === 'undefined' || !recipe || !product) return null;
    return RecipeYield.plannedYieldStock(recipe, product, _rdQuUnitList, _rdQuConversions, servings);
}

/** Omdan en nesting til en ingrediens-linje på den vare opskriften producerer. */
function _rdConvertNestingToLine(idx) {
    var n = _rdDs.nestings[idx];
    if (!n) return;
    var sub = _rdRecipeMap[n.includes_recipe_id];
    var product = _rdRecipeProduct(sub);
    if (!product) { _rdShowAlert('Underopskriften producerer ingen vare', 'error'); return; }

    var amt = _rdNestingAsStock(sub, product, parseFloat(n.servings) || 0);
    if (amt == null) {
        _rdShowAlert('Udbyttet på "' + sub.name + '" kan ikke bestemmes — udfyld "1 portion er" på den først', 'error');
        return;
    }
    var unit = _rdQuantityUnits[product.qu_id_stock] || '';
    if (!confirm(sub.name + ' bliver til en ingrediens-linje:\n\n' +
        _rdFmtNum(_rdRound(amt, 4)) + ' ' + unit + ' ' + product.name + '\n\n' +
        'Underopskriften fjernes. Råvarerne trækkes fremover af "' + sub.name + '" når varen laves.')) return;

    if (n.id) _rdDs.removedNestIds.push(n.id);
    _rdDs.nestings.splice(idx, 1);
    _rdDs.ingredients.push({
        id: null,
        recipe_id: _rdDs.originalRecipeId,
        product_id: product.id,
        amount: amt,
        qu_id: product.qu_id_stock,
        ingredient_group: null,
        note: null,
        only_check_single_unit_in_stock: 0,
        not_check_stock_fulfillment: 0,
        variable_amount: null,
        price_factor: 1,
        round_up: 0
    });
    _rdMarkChanged();
    _rdRenderNestings();
    _rdRenderIngredients();
    _rdRecalcSummary();
    _rdShowAlert(sub.name + ' lagt ind som vare-linje', 'success');
}


// ════════════════════════════════════════════════════════════
// SAVE — diff mod det åbnede (#680)
// ════════════════════════════════════════════════════════════
//
// Gem sendte før hvert felt, hver ingredienslinje og hver nesting — også
// dem der ikke var rørt — og flere felter blev skrevet ud fra noget andet
// end det Grocy havde: `recipeunitnumber` blev sat lig `base_servings`,
// `base_servings` blev parseInt'et, en enhed uden for designerens faste
// liste blev til 'stk', og en opskrift uden gruppe fik 'Ingen kategori'.
//
// Nu fotograferes opskriften når den åbnes (_rdCaptureOrig), felterne skriver
// i _rdDs, og Gem sender kun forskellen. Et Gem uden ændringer sender intet.

function _rdOptNum(v) {
    if (v == null || String(v).trim() === '') return null;
    var n = GrocyNum.num(v);
    return isFinite(n) ? n : null;
}

// Tal til et inputfelt: dansk komma, ingen flydende-tal-støj, tomt for null.
function _rdFmtNum(n) {
    if (n == null || !isFinite(n)) return '';
    return String(Math.round(n * 1e6) / 1e6).replace('.', ',');
}

function _rdStr(v) { return v == null ? '' : String(v); }
function _rdText(v) { return _rdStr(v).replace(/\r\n?/g, '\n'); }
function _rdNumEq(a, b) {
    if (a == null || b == null) return a == null && b == null;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

// Preset-lister fra Grocys feltdefinitioner: { grupper: [...], recipeunit: [...] }.
function _rdPresetOptions(defs) {
    var out = {};
    (defs || []).forEach(function(d) {
        if (!d || d.entity !== 'recipes' || !/^preset-/.test(String(d.type || ''))) return;
        out[d.name] = _rdStr(d.config).split(/\r?\n/)
            .map(function(x) { return x.trim(); })
            .filter(function(x) { return x !== ''; });
    });
    return out;
}

// <option>-liste til et preset-felt. Grocys definition er kilden. Værdier der
// står på en opskrift uden at være i definitionen ('stk' på en gammel
// opskrift, 'liter,antal') kommer også med — også opskriftens egen, som
// dermed altid kan vises. En enhed må aldrig forsvinde fordi listen ikke
// kender den: så står feltet tomt, og næste Gem skriver det tomme.
function _rdOptionsHtml(field, current, emptyLabel) {
    var seen = {}, opts = [];
    function add(v) { if (v !== '' && !seen[v]) { seen[v] = true; opts.push(v); } }
    (_rdUfOptions[field] || []).forEach(add);
    var fromGrocy = opts.length;
    _rdRecipes.forEach(function(r) { add(_rdStr(r.userfields && r.userfields[field])); });
    var extra = opts.slice(fromGrocy).sort(function(a, b) { return a.localeCompare(b, 'da'); });
    opts = opts.slice(0, fromGrocy).concat(extra);
    var cur = _rdStr(current);
    return '<option value=""' + (cur === '' ? ' selected' : '') + '>' + esc(emptyLabel) + '</option>' +
        opts.map(function(v) {
            return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>';
        }).join('');
}

/**
 * <option>-liste til "1 portion er"-enheden, delt i to.
 *
 * Grocys preset-liste rummer `Timer` og `Kr`, og de ER i brug — på
 * `x- Service`-opskrifterne (Servicepersonale, Rabat, Engangsbeløb), hvor
 * "1 portion" er en time eller en krone. De må derfor ikke fjernes: en enhed
 * der forsvinder fordi listen ikke kender den, bliver skrevet som tom ved
 * næste Gem (#680). Men de er ikke måleenheder, og de skal ikke stå side om
 * side med kilo.
 *
 * Skellet er ikke en håndskrevet liste: en enhed hører i første gruppe hvis
 * `RecipeYield` kan slå navnet op blandt Grocys egne `quantity_units` — altså
 * præcis når udbyttet kan regnes om. Derfor forklarer grupperingen også
 * hvorfor advarslen kommer, når man vælger noget fra den anden.
 */
function _rdUnitOptionsHtml(current) {
    var seen = {}, alle = [];
    function add(v) { if (v !== '' && !seen[v]) { seen[v] = true; alle.push(v); } }
    (_rdUfOptions.recipeunit || []).forEach(add);
    _rdRecipes.forEach(function(r) { add(_rdStr(r.userfields && r.userfields.recipeunit)); });
    add(_rdStr(current));   // opskriftens egen skal altid kunne vises

    var maal = [], andet = [];
    alle.forEach(function(v) {
        var kendt = typeof RecipeYield !== 'undefined' &&
            RecipeYield.unitIdByName(_rdQuUnitList, v) != null;
        (kendt ? maal : andet).push(v);
    });

    var cur = _rdStr(current);
    var opt = function(v) {
        return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>';
    };
    var html = '<option value=""' + (cur === '' ? ' selected' : '') + '>— vælg —</option>';
    if (maal.length)  html += '<optgroup label="Måleenheder">' + maal.map(opt).join('') + '</optgroup>';
    if (andet.length) html += '<optgroup label="Ikke en måleenhed">' + andet.map(opt).join('') + '</optgroup>';
    return html;
}

// Fotografi af opskriften som Grocy har den — i samme form som _rdCurrentValues.
function _rdCaptureOrig(recipeId) {
    var r = _rdRecipeMap[recipeId];
    if (!r) return null;
    var uf = r.userfields || {};
    var pos = {}, nest = {};
    _rdAllPositions.forEach(function(p) { if (p.recipe_id == recipeId) pos[p.id] = _rdShallowCopy(p); });
    _rdAllNestings.forEach(function(n) { if (n.recipe_id == recipeId) nest[n.id] = _rdShallowCopy(n); });
    return {
        name: _rdStr(r.name),
        description: r.description,
        base_servings: _rdOptNum(r.base_servings),
        product_id: _rdOptNum(r.product_id),
        grupper: _rdStr(uf.grupper),
        recipeunit: _rdStr(uf.recipeunit),
        recipeunitnumber: _rdOptNum(uf.recipeunitnumber),
        arbejdstid_min: _rdOptNum(uf.arbejdstid_min),
        positions: pos,
        nestings: nest
    };
}

function _rdCurrentValues() {
    return {
        name: String(_rdDs.name || '').trim(),
        description: _rdDs.description,
        base_servings: _rdDs.baseServings,
        product_id: _rdDs.productId,
        grupper: _rdStr(_rdDs.group),
        recipeunit: _rdStr(_rdDs.recipeUnit),
        recipeunitnumber: _rdDs.yieldNum,
        arbejdstid_min: _rdDs.workMin,
        ingredients: _rdDs.ingredients,
        nestings: _rdDs.nestings,
        removedIngIds: _rdDs.removedIngIds,
        removedNestIds: _rdDs.removedNestIds
    };
}

function _rdUfNumStr(n) { return n == null ? '' : String(n); }

// Ren funktion: hvad skal sendes for at gå fra `orig` til `cur`?
function _rdBuildSavePlan(orig, cur) {
    orig = orig || { positions: {}, nestings: {} };
    var plan = { recipe: {}, userfields: {}, posPut: [], posPost: [], posDelete: [],
                 nestPut: [], nestPost: [], nestDelete: [] };

    if (cur.name !== String(orig.name || '').trim()) plan.recipe.name = cur.name;
    if (_rdText(cur.description) !== _rdText(orig.description)) plan.recipe.description = cur.description || null;
    if (!_rdNumEq(cur.base_servings, orig.base_servings)) plan.recipe.base_servings = cur.base_servings;
    // Produceret vare. `null` rydder feltet i Grocy — opskriften producerer da ingenting.
    if (!_rdNumEq(cur.product_id, orig.product_id)) plan.recipe.product_id = cur.product_id;

    if (cur.grupper !== _rdStr(orig.grupper)) plan.userfields.grupper = cur.grupper;
    if (cur.recipeunit !== _rdStr(orig.recipeunit)) plan.userfields.recipeunit = cur.recipeunit;
    if (!_rdNumEq(cur.recipeunitnumber, orig.recipeunitnumber)) plan.userfields.recipeunitnumber = _rdUfNumStr(cur.recipeunitnumber);
    if (!_rdNumEq(cur.arbejdstid_min, orig.arbejdstid_min)) plan.userfields.arbejdstid_min = _rdUfNumStr(cur.arbejdstid_min);

    plan.posDelete = (cur.removedIngIds || []).slice();
    plan.nestDelete = (cur.removedNestIds || []).slice();

    (cur.ingredients || []).forEach(function(ing) {
        if (!ing.id) { plan.posPost.push(ing); return; }
        var o = orig.positions[ing.id] || {};
        var body = {};
        ['amount', 'product_id', 'qu_id'].forEach(function(k) {
            if (!_rdNumEq(_rdOptNum(ing[k]), _rdOptNum(o[k]))) body[k] = ing[k];
        });
        ['ingredient_group', 'note'].forEach(function(k) {
            if (_rdStr(ing[k]) !== _rdStr(o[k])) body[k] = ing[k];
        });
        if (Object.keys(body).length) plan.posPut.push({ id: ing.id, body: body });
    });

    (cur.nestings || []).forEach(function(n) {
        if (!n.id) { plan.nestPost.push(n); return; }
        var o = orig.nestings[n.id] || {};
        if (!_rdNumEq(_rdOptNum(n.servings), _rdOptNum(o.servings))) {
            plan.nestPut.push({ id: n.id, body: { servings: n.servings } });
        }
    });
    return plan;
}

/**
 * Bekræftelse når `product_id` ændrer sig.
 *
 * Ikke en spærring — en spærring ville bare føre til at feltet blev sat et
 * andet sted. Men konsekvensen skal have været på skærmen inden, for den
 * viser sig ellers først ved næste optælling (#305/#319's fejlklasse).
 */
function _rdConfirmProducesChange(newProductId) {
    var lines;
    if (!newProductId) {
        var prevId = _rdOrig && _rdOrig.product_id;
        var prevName = prevId ? ((_rdProductMap[prevId] || {}).name || '#' + prevId) : 'varen';
        lines = [
            '"' + _rdDs.name + '" producerer ikke længere ' + prevName + '.',
            '',
            '· Opskrifter der bruger den nester den fremover som underopskrift og trækker dens råvarer.',
            '· Kostprisen på ' + prevName + ' kommer igen fra lagerprisen, ikke fra denne opskrift.',
            '· ' + prevName + ' bliver ikke længere lavet automatisk.'
        ];
    } else {
        var im = _rdProducesImpact(newProductId);
        var info = _rdProducesInfo(im);
        lines = ['"' + _rdDs.name + '" kommer til at producere ' + im.productName + '.', '', '· ' + info.head]
            .concat(info.warnings.map(function(l) { return '· ⚠ ' + l; }))
            .concat(info.details.map(function(l) { return '· ' + l; }));
    }
    return confirm(lines.join('\n') + '\n\nGem?');
}

function _rdPlanIsEmpty(p) {
    return !Object.keys(p.recipe).length && !Object.keys(p.userfields).length &&
        !p.posPut.length && !p.posPost.length && !p.posDelete.length &&
        !p.nestPut.length && !p.nestPost.length && !p.nestDelete.length;
}

async function _rdExecuteSavePlan(recipeId, plan) {
    if (Object.keys(plan.recipe).length) await putGrocyRecipe(recipeId, plan.recipe);
    if (Object.keys(plan.userfields).length) await putGrocyRecipeUserfields(recipeId, plan.userfields);
    for (var i = 0; i < plan.posDelete.length; i++) await deleteGrocyRecipePos(plan.posDelete[i]);
    for (var j = 0; j < plan.nestDelete.length; j++) await deleteGrocyRecipeNesting(plan.nestDelete[j]);
    for (var k = 0; k < plan.posPut.length; k++) await putGrocyRecipePos(plan.posPut[k].id, plan.posPut[k].body);
    for (var l = 0; l < plan.posPost.length; l++) {
        var ing = plan.posPost[l];
        await postGrocyRecipePos({
            recipe_id: recipeId,
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
    for (var m = 0; m < plan.nestPut.length; m++) await putGrocyRecipeNesting(plan.nestPut[m].id, plan.nestPut[m].body);
    for (var q = 0; q < plan.nestPost.length; q++) {
        var n = plan.nestPost[q];
        await postGrocyRecipeNesting({
            recipe_id: recipeId,
            includes_recipe_id: n.includes_recipe_id,
            servings: n.servings
        });
    }
}

// Userfields til en ny opskrift: kun dem der har en værdi.
function _rdNewRecipeUserfields(cur) {
    var uf = {};
    if (cur.grupper !== '') uf.grupper = cur.grupper;
    if (cur.recipeunit !== '') uf.recipeunit = cur.recipeunit;
    if (cur.recipeunitnumber != null) uf.recipeunitnumber = String(cur.recipeunitnumber);
    if (cur.arbejdstid_min != null) uf.arbejdstid_min = String(cur.arbejdstid_min);
    return uf;
}


// SAVE — Update existing
// ════════════════════════════════════════════════════════════

async function _rdSaveRecipe() {
    if (_rdDs.mode !== 'modify' || !_rdDs.originalRecipeId) return;

    var name = String(_rdDs.name || '').trim();
    if (!name) { _rdShowAlert('Giv opskriften et navn', 'error'); return; }

    // Kun det der er ændret siden opskriften blev åbnet sendes til Grocy (#680).
    var plan = _rdBuildSavePlan(_rdOrig, _rdCurrentValues());
    if (_rdPlanIsEmpty(plan)) {
        _rdDs.dirty = false;
        var m0 = document.getElementById('rdDChanged');
        if (m0) m0.classList.remove('rd-visible');
        _rdShowAlert('Ingen ændringer at gemme', 'info');
        return;
    }

    // Produceret vare er ikke et felt som de andre — den flytter produktionstype,
    // lagertræk og kostpris i samme øjeblik (#683). Sig det før, ikke efter.
    if ('product_id' in plan.recipe && !_rdConfirmProducesChange(plan.recipe.product_id)) return;

    try {
        _rdShowAlert('Gemmer...', 'info');

        await _rdExecuteSavePlan(_rdDs.originalRecipeId, plan);

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
        _rdOrig = _rdCaptureOrig(_rdDs.originalRecipeId);   // næste Gem sammenligner med det nu gemte
        _rdRenderProduces();
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
    var name = String(_rdDs.name || '').trim();
    if (!name) { _rdShowAlert('Giv opskriften et navn', 'error'); return; }

    try {
        _rdShowAlert('Opretter ny opskrift...', 'info');

        var baseServings = _rdDs.baseServings;

        // 1. Create recipe
        var resp = await postGrocyRecipe({
            name: name,
            description: _rdDs.description || null,
            base_servings: baseServings,
            desired_servings: baseServings,
            not_check_shoppinglist: 0,
            type: 'normal',
            // En kopi arver ALDRIG den producerede vare. To opskrifter der
            // producerer samme vare er præcis den fælde `buildProducedByIndex`
            // advarer om (laveste id vinder) — vælg varen bevidst bagefter.
            product_id: null
        });

        var newId = parseInt(resp.created_object_id);

        // 2. Set userfields (inkl. aktiv arbejdstid pr. batch).
        // Kun felter med en værdi: udbytte og enhed er dem brugeren har — ved en
        // kopi kildens egne. Er de tomme, forbliver de tomme; vi opfinder ikke et udbytte (#680).
        var newUf = _rdNewRecipeUserfields(_rdCurrentValues());
        if (Object.keys(newUf).length) await putGrocyRecipeUserfields(newId, newUf);

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
        _rdDs.productId = null;              // kopien producerer ingenting (se POST ovenfor)
        _rdOrig = _rdCaptureOrig(newId);
        _rdRenderProduces();
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

/**
 * Editoren har to kolonner og er bredere end den gamle designer.
 *
 * Loftet sidder på SIDENS container (`max-width`), så et barn kan ikke bryde
 * ud af det selv. Klassen ejes her og ikke i editoren: editoren skal ikke
 * kende den side den er monteret i — og så kan den heller ikke glemme at rydde
 * op efter sig.
 */
function _rdEditorWidth(on) {
    if (_rdContainer) _rdContainer.classList.toggle('re-mounted', !!on);
}

function _rdSwitchView(id) {
    if (id !== 'rdDesignerView') _rdEditorWidth(false);
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

// Omvendt af _rdFormatAmount: et tal vist i `displayUnit` tilbage til `origUnit`.
// Ét sted for ingredienser og underopskrifter, så de fire veje ikke kan skride
// fra hinanden igen (#364). Enhedsnavnene er de samme som _rdFormatAmount kender.
function _rdDisplayToOrigUnit(val, displayUnit, origUnit) {
    var du = String(displayUnit || '').toLowerCase().trim();
    var ou = String(origUnit || '').toLowerCase().trim();
    if ((ou === 'kg' || ou === 'kilo') && du === 'g') return val / 1000;
    if ((ou === 'l' || ou === 'liter') && du === 'ml') return val / 1000;
    if ((ou === 'g' || ou === 'gram') && du === 'kg') return val * 1000;
    if (ou === 'ml' && du === 'l') return val * 1000;
    return val;
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
