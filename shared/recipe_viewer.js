/**
 * shared/recipe_viewer.js
 * ════════════════════════════════════════════════════════════
 * Recipe Viewer component for Bon v2.
 * Ported from bontools recipe-viewer.html, adapted to bon-v2
 * architecture: MPA, vanilla JS, API via shared/api.js.
 *
 * Export: initRecipeViewer(containerEl)
 * ════════════════════════════════════════════════════════════
 */

/* global fetchGrocyRecipesRaw, fetchGrocyProducts, fetchGrocyQuantityUnits,
          fetchGrocyStock, fetchGrocyRecipesPos, fetchGrocyRecipesNestings,
          fetchGrocyQuantityUnitConversions, postGrocyShoppingList,
          postGrocyConsume, esc */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

var _rvRecipes        = [];       // all recipes (filtered to active)
var _rvProducts       = {};       // product_id -> product
var _rvQuantityUnits  = {};       // qu_id -> unit name
var _rvStock          = {};       // product_id -> amount
var _rvRecipeMap      = {};       // recipe_id -> recipe object
var _rvAllRecipesPos  = {};       // recipe_id -> [ingredients]
var _rvAllNestings    = [];       // all nestings (raw)
var _rvQuConversions  = [];       // unit conversions (raw)

var _rvCurrentRecipe  = null;
var _rvCurrentPortions = 1;
var _rvBaseServings   = 1;
var _rvSelectedGroup  = null;
var _rvNavigationStack = [];
var _rvIngredients    = [];       // current recipe's ingredient positions
var _rvNestings       = [];       // current recipe's nestings

var _rvContainer      = null;     // root DOM element

// Cached weight unit IDs
var _rvGramQuId  = null;
var _rvKiloQuId  = null;
var _rvWeightUnitsCached = false;

// ════════════════════════════════════════════════════════════
// PUBLIC: initRecipeViewer
// ════════════════════════════════════════════════════════════

function initRecipeViewer(containerEl) {
    _rvContainer = containerEl;
    _rvContainer.innerHTML = '<div class="rv-loading"><div class="rv-spinner"></div><p>Henter opskrifter...</p></div>';
    _rvLoadData();
}

// ════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════

async function _rvLoadData() {
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

        var rawRecipes    = results[0];
        var rawProducts   = results[1];
        var rawQus        = results[2];
        var rawStock      = results[3];
        var rawPos        = results[4];
        var rawNestings   = results[5];
        var rawConvs      = results[6];

        // Process recipes: attach group/unit from userfields, filter active
        _rvRecipes = rawRecipes
            .filter(function(r) {
                if (r.active === undefined || r.active === null) return true;
                return r.active === '1' || r.active === 1 || r.active === true;
            })
            .map(function(r) {
                r.group = (r.userfields && r.userfields.grupper) || 'Ingen kategori';
                r.recipeUnit = (r.userfields && r.userfields.recipeunit) || 'stk';
                return r;
            });

        // Recipe map
        _rvRecipeMap = {};
        _rvRecipes.forEach(function(r) { _rvRecipeMap[r.id] = r; });

        // Products map + attach producing recipe
        _rvProducts = {};
        rawProducts.forEach(function(p) {
            _rvProducts[p.id] = p;
            var producing = _rvRecipes.find(function(r) { return r.product_id == p.id; });
            if (producing) _rvProducts[p.id].producingRecipeId = producing.id;
        });

        // Quantity units map
        _rvQuantityUnits = {};
        rawQus.forEach(function(qu) { _rvQuantityUnits[qu.id] = qu.name; });

        // Stock map
        _rvStock = {};
        rawStock.forEach(function(s) { _rvStock[s.product_id] = parseFloat(s.amount) || 0; });

        // All recipe positions grouped by recipe_id
        _rvAllRecipesPos = {};
        rawPos.forEach(function(pos) {
            if (!_rvAllRecipesPos[pos.recipe_id]) _rvAllRecipesPos[pos.recipe_id] = [];
            _rvAllRecipesPos[pos.recipe_id].push(pos);
        });

        // Nestings + conversions
        _rvAllNestings = rawNestings;
        _rvQuConversions = rawConvs;

        // Reset weight unit cache
        _rvWeightUnitsCached = false;
        _rvGramQuId = null;
        _rvKiloQuId = null;

        // Render list
        _rvRenderShell();
        _rvRenderGroupChips();
        _rvFilterRecipes();

    } catch (err) {
        _rvContainer.innerHTML = '<div class="rv-alert rv-alert-error">Fejl ved hentning af data: ' + esc(err.message) + '</div>';
    }
}

// ════════════════════════════════════════════════════════════
// SHELL RENDERING
// ════════════════════════════════════════════════════════════

function _rvRenderShell() {
    _rvContainer.innerHTML = '' +
        '<div id="rvAlertBox"></div>' +
        '<div id="rvListView">' +
            '<div class="rv-filter-section">' +
                '<input type="text" class="rv-search-input" id="rvSearchInput" placeholder="Sog opskrifter...">' +
                '<div class="rv-group-chips" id="rvGroupChips"></div>' +
            '</div>' +
            '<ul class="rv-recipe-list" id="rvRecipeList"></ul>' +
            '<div class="rv-empty" id="rvEmptyState" style="display:none;"><p>Ingen opskrifter fundet</p></div>' +
        '</div>' +
        '<div class="rv-detail-view" id="rvDetailView">' +
            '<div class="rv-detail-header">' +
                '<button class="rv-back-btn" id="rvBackBtn">Tilbage til listen</button>' +
                '<div class="rv-detail-name" id="rvDetailName">-</div>' +
                '<div class="rv-detail-group" id="rvDetailGroup">-</div>' +
            '</div>' +
            '<div class="rv-portions-section">' +
                '<span class="rv-portions-label">Portioner:</span>' +
                '<div class="rv-portions-control">' +
                    '<button class="rv-portions-btn" id="rvPortionsMinus">&minus;</button>' +
                    '<span class="rv-portions-display" id="rvPortionsDisplay">1</span>' +
                    '<button class="rv-portions-btn" id="rvPortionsPlus">+</button>' +
                '</div>' +
                '<span class="rv-portions-unit" id="rvPortionsUnit"></span>' +
                '<span class="rv-total-weight">Vaegt: <span id="rvTotalWeight">0 g</span></span>' +
            '</div>' +
            '<div class="rv-ingredients-section">' +
                '<div class="rv-section-title">Ingredienser</div>' +
                '<ul class="rv-ingredient-list" id="rvIngredientList"></ul>' +
            '</div>' +
            '<div class="rv-consume-section" id="rvConsumeSection">' +
                '<div class="rv-action-row">' +
                    '<button class="rv-consume-btn" id="rvConsumeBtn">Traek fra lager</button>' +
                    '<button class="rv-shopping-all-btn" id="rvShoppingAllBtn">🛒 Tilfoej manglende til indkoeb</button>' +
                '</div>' +
                '<div class="rv-consume-result" id="rvConsumeResult"></div>' +
            '</div>' +
            '<div class="rv-note-section" id="rvNoteSection" style="display:none;">' +
                '<h3>Fremgangsmaade</h3>' +
                '<div class="rv-note-content" id="rvNoteContent"></div>' +
            '</div>' +
        '</div>';

    // Bind events
    var searchInput = document.getElementById('rvSearchInput');
    var debounceTimer = null;
    searchInput.addEventListener('input', function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(_rvFilterRecipes, 200);
    });

    document.getElementById('rvBackBtn').addEventListener('click', _rvGoBack);
    document.getElementById('rvPortionsMinus').addEventListener('click', function() { _rvAdjustPortions(-1); });
    document.getElementById('rvPortionsPlus').addEventListener('click', function() { _rvAdjustPortions(1); });
    document.getElementById('rvConsumeBtn').addEventListener('click', _rvConsumeRecipe);
    document.getElementById('rvShoppingAllBtn').addEventListener('click', _rvAddAllMissingToShoppingList);

    // Delegated click for cart buttons
    _rvContainer.addEventListener('click', function(e) {
        var cartBtn = e.target.closest('.rv-cart-btn');
        if (cartBtn) {
            e.stopPropagation();
            var info = JSON.parse(cartBtn.getAttribute('data-rv-stock-info'));
            _rvOnStockDotClick(info.productId, info.productName, info.needed, info.stock, info.unit);
        }
    });
}

// ════════════════════════════════════════════════════════════
// ALERTS
// ════════════════════════════════════════════════════════════

function _rvShowAlert(message, type) {
    var box = document.getElementById('rvAlertBox');
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'rv-alert rv-alert-' + type;
    div.textContent = message;
    box.appendChild(div);
    setTimeout(function() { div.remove(); }, 4000);
}

// ════════════════════════════════════════════════════════════
// LIST VIEW
// ════════════════════════════════════════════════════════════

function _rvRenderGroupChips() {
    var groupSet = {};
    _rvRecipes.forEach(function(r) { groupSet[r.group] = true; });
    var groups = Object.keys(groupSet).sort(function(a, b) { return a.localeCompare(b, 'da'); });

    var container = document.getElementById('rvGroupChips');
    if (!container) return;

    var html = '<button class="rv-chip ' + (_rvSelectedGroup === null ? 'active' : '') + '" data-rv-group="__all__">Alle</button>';
    groups.forEach(function(g) {
        html += '<button class="rv-chip ' + (_rvSelectedGroup === g ? 'active' : '') + '" data-rv-group="' + esc(g) + '">' + esc(g) + '</button>';
    });
    container.innerHTML = html;

    // Bind chip clicks via delegation
    container.onclick = function(e) {
        var btn = e.target.closest('.rv-chip');
        if (!btn) return;
        var group = btn.getAttribute('data-rv-group');
        _rvSelectedGroup = (group === '__all__') ? null : group;
        _rvRenderGroupChips();
        _rvFilterRecipes();
    };
}

function _rvFilterRecipes() {
    var input = document.getElementById('rvSearchInput');
    var search = input ? input.value.toLowerCase().trim() : '';

    var filtered = _rvRecipes.slice();

    if (_rvSelectedGroup) {
        filtered = filtered.filter(function(r) { return r.group === _rvSelectedGroup; });
    }

    if (search.length >= 2) {
        filtered = filtered.filter(function(r) { return r.name.toLowerCase().indexOf(search) !== -1; });
    }

    filtered.sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });
    _rvRenderRecipeList(filtered);
}

function _rvRenderRecipeList(recipes) {
    var list = document.getElementById('rvRecipeList');
    var empty = document.getElementById('rvEmptyState');
    if (!list || !empty) return;

    if (recipes.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';

    var html = '';
    recipes.forEach(function(r) {
        html += '<li class="rv-recipe-item" data-rv-recipe-id="' + r.id + '">' +
            '<div>' +
                '<div class="rv-recipe-name">' + esc(r.name) + '</div>' +
                '<div class="rv-recipe-meta">' + esc(r.group) + '</div>' +
            '</div>' +
            '<div class="rv-recipe-arrow">&rarr;</div>' +
        '</li>';
    });
    list.innerHTML = html;

    // Bind click via delegation
    list.onclick = function(e) {
        var item = e.target.closest('.rv-recipe-item');
        if (!item) return;
        var id = parseInt(item.getAttribute('data-rv-recipe-id'));
        if (id) _rvOpenRecipe(id, true);
    };
}

// ════════════════════════════════════════════════════════════
// DETAIL VIEW
// ════════════════════════════════════════════════════════════

function _rvOpenRecipe(recipeId, addToStack) {
    var recipe = _rvRecipeMap[recipeId];
    if (!recipe) return;

    // Push current to navigation stack
    if (addToStack && _rvCurrentRecipe) {
        _rvNavigationStack.push({
            recipeId: _rvCurrentRecipe.id,
            portions: _rvCurrentPortions
        });
    }

    _rvCurrentRecipe = recipe;
    _rvBaseServings = parseInt(recipe.base_servings) || 1;
    _rvCurrentPortions = _rvBaseServings;

    // Get nestings for this recipe
    _rvNestings = _rvAllNestings.filter(function(n) { return n.recipe_id == recipeId; });

    // Get ingredients
    _rvIngredients = _rvAllRecipesPos[recipeId] || [];

    // Switch views
    document.getElementById('rvListView').style.display = 'none';
    document.getElementById('rvDetailView').classList.add('visible');

    // Update back button
    var backBtn = document.getElementById('rvBackBtn');
    if (_rvNavigationStack.length > 0) {
        var prev = _rvRecipeMap[_rvNavigationStack[_rvNavigationStack.length - 1].recipeId];
        backBtn.textContent = '\u2190 ' + (prev ? prev.name : 'Tilbage');
    } else {
        backBtn.textContent = '\u2190 Tilbage til listen';
    }

    // Fill header
    document.getElementById('rvDetailName').textContent = recipe.name;
    document.getElementById('rvDetailGroup').textContent = recipe.group;
    document.getElementById('rvPortionsDisplay').textContent = _rvCurrentPortions;
    document.getElementById('rvPortionsUnit').textContent = '(\u00e1 1 ' + (recipe.recipeUnit || 'stk') + ')';

    // Render ingredients
    _rvRenderIngredients();

    // Notes
    var noteSection = document.getElementById('rvNoteSection');
    if (recipe.description && recipe.description.trim()) {
        noteSection.style.display = 'block';
        document.getElementById('rvNoteContent').innerHTML = recipe.description;
    } else {
        noteSection.style.display = 'none';
    }

    // Reset consume result
    var consumeResult = document.getElementById('rvConsumeResult');
    consumeResult.style.display = 'none';
    consumeResult.className = 'rv-consume-result';

    // Scroll to top
    window.scrollTo(0, 0);
}

function _rvRenderIngredients() {
    var list = document.getElementById('rvIngredientList');
    if (!list) return;

    var multiplier = _rvCurrentPortions / _rvBaseServings;
    var totalWeightGrams = 0;
    var html = '';

    // Group ingredients by ingredient_group
    var groups = {};
    _rvIngredients.forEach(function(ing) {
        var group = ing.ingredient_group || '';
        if (!groups[group]) groups[group] = [];
        groups[group].push(ing);
    });

    // Sort group names: empty first, then alpha, emballage LAST (after nestings)
    var emballageGroup = null;
    var otherGroups = [];
    Object.keys(groups).forEach(function(g) {
        if (g.toLowerCase() === 'emballage') {
            emballageGroup = g;
        } else {
            otherGroups.push(g);
        }
    });
    otherGroups.sort(function(a, b) {
        if (a === '') return -1;
        if (b === '') return 1;
        return a.localeCompare(b, 'da');
    });

    // Render non-emballage groups
    otherGroups.forEach(function(groupName) {
        if (groupName) {
            html += '<li class="rv-ingredient-group-header">' + esc(groupName) + '</li>';
        }
        groups[groupName].forEach(function(ing) {
            html += _rvRenderIngredientItem(ing, multiplier);
            // Weight calc
            var product = _rvProducts[ing.product_id] || {};
            var stockQuId = product.qu_id_stock || ing.qu_id;
            var stockUnitName = _rvQuantityUnits[stockQuId] || '';
            var baseAmount = parseFloat(ing.amount) || 0;
            totalWeightGrams += _rvCalculateWeightGrams(
                baseAmount * multiplier, stockUnitName, ing.product_id, stockQuId
            );
        });
    });

    // Sub-recipes
    if (_rvNestings && _rvNestings.length > 0) {
        html += '<li class="rv-ingredient-group-header">Underopskrifter</li>';

        _rvNestings.forEach(function(nesting) {
            var subRecipe = _rvRecipeMap[nesting.includes_recipe_id];
            if (!subRecipe) return;

            var servings = parseFloat(nesting.servings) || 1;
            var scaledServings = servings * multiplier;
            var nestingUnit = (subRecipe.recipeUnit || 'stk').toLowerCase().trim();

            var isWeightUnit = ['kg', 'kilo', 'g', 'gram', 'l', 'liter', 'ml'].indexOf(nestingUnit) !== -1;
            var displayText;

            if (isWeightUnit) {
                var subWeightG = _rvCalculateSubRecipeWeightGrams(nesting.includes_recipe_id, scaledServings);
                totalWeightGrams += subWeightG;
                displayText = subWeightG > 0 ? _rvFormatWeight(subWeightG) : '\u2013 g';
            } else {
                var fmt = _rvFormatAmount(scaledServings, subRecipe.recipeUnit || 'stk');
                displayText = fmt.amount + ' ' + fmt.unit;
                totalWeightGrams += _rvCalculateSubRecipeWeightGrams(nesting.includes_recipe_id, scaledServings);
            }

            html += '<li class="rv-ingredient-item rv-nesting-item">' +
                '<div class="rv-stock-dot ok"></div>' +
                '<div class="rv-ingredient-name">' +
                    '<span class="rv-ingredient-link" data-rv-sub-recipe="' + subRecipe.id + '">' + esc(subRecipe.name) + ' [\u2192]</span>' +
                '</div>' +
                '<div class="rv-ingredient-amount">' + esc(displayText) + '</div>' +
                '<div class="rv-ingredient-stock"></div>' +
            '</li>';
        });
    }

    // Emballage LAST
    if (emballageGroup && groups[emballageGroup]) {
        html += '<li class="rv-ingredient-group-header">' + esc(emballageGroup) + '</li>';
        groups[emballageGroup].forEach(function(ing) {
            html += _rvRenderIngredientItem(ing, multiplier);
        });
    }

    if (_rvIngredients.length === 0 && (!_rvNestings || _rvNestings.length === 0)) {
        list.innerHTML = '<li style="padding: 20px; color: var(--color-text-dim);">Ingen ingredienser</li>';
        document.getElementById('rvTotalWeight').textContent = '0 g';
        return;
    }

    list.innerHTML = html;
    document.getElementById('rvTotalWeight').textContent = _rvFormatWeight(totalWeightGrams);

    // Bind sub-recipe clicks + stock dot clicks via delegation
    list.onclick = function(e) {
        var subLink = e.target.closest('[data-rv-sub-recipe]');
        if (subLink) {
            var subId = parseInt(subLink.getAttribute('data-rv-sub-recipe'));
            if (subId) _rvOpenRecipe(subId, true);
            return;
        }
        var prodLink = e.target.closest('[data-rv-producing-recipe]');
        if (prodLink) {
            e.stopPropagation();
            var rId = parseInt(prodLink.getAttribute('data-rv-producing-recipe'));
            if (rId) _rvOpenRecipe(rId, true);
            return;
        }
        var dot = e.target.closest('.rv-stock-dot[data-rv-stock-info]');
        if (dot) {
            var info = JSON.parse(dot.getAttribute('data-rv-stock-info'));
            _rvOnStockDotClick(info.productId, info.productName, info.needed, info.stock, info.unit);
        }
    };
}

function _rvRenderIngredientItem(ing, multiplier) {
    var product = _rvProducts[ing.product_id] || {};
    var productName = ing.product_name || product.name || ('Produkt #' + ing.product_id);

    // Display amount: convert from stock unit to display unit
    var unitName = _rvQuantityUnits[ing.qu_id] || '';
    var baseDisplayAmount = _rvGetDisplayAmount(ing);
    var amount = _rvRound(baseDisplayAmount * multiplier);

    // Stock comparison in stock units
    var baseStockAmount = parseFloat(ing.amount) || 0;
    var neededStock = _rvRound(baseStockAmount * multiplier);
    var stockAmount = _rvRound(_rvStock[ing.product_id] || 0);

    // Stock status
    var statusClass = 'unknown';
    if (stockAmount >= neededStock) {
        statusClass = 'ok';
    } else if (stockAmount > 0) {
        statusClass = 'low';
    } else {
        statusClass = 'missing';
    }

    // Sub-recipe link if product has a producing recipe
    var hasRecipeLink = product.producingRecipeId;
    var nameHtml = hasRecipeLink
        ? '<span class="rv-ingredient-link" data-rv-producing-recipe="' + product.producingRecipeId + '">' + esc(productName) + ' [\u2192]</span>'
        : esc(productName);

    var stockUnitName = _rvQuantityUnits[product.qu_id_stock] || unitName;

    var stockInfoJson = esc(JSON.stringify({
        productId: ing.product_id,
        productName: productName,
        needed: neededStock,
        stock: stockAmount,
        unit: stockUnitName
    }));

    var fmt = _rvFormatAmount(amount, unitName);

    var cartBtn = (statusClass === 'rv-status-missing' || statusClass === 'rv-status-low')
        ? '<button class="rv-cart-btn" data-rv-stock-info="' + stockInfoJson + '" title="Tilfoej til indkoebsliste">🛒</button>'
        : '';

    return '<li class="rv-ingredient-item">' +
        '<div class="rv-stock-dot ' + statusClass + '" data-rv-stock-info="' + stockInfoJson + '" title="Lager: ' + stockAmount + '"></div>' +
        '<div class="rv-ingredient-name">' + nameHtml + '</div>' +
        '<div class="rv-ingredient-amount">' + esc(String(fmt.amount)) + ' ' + esc(fmt.unit) + '</div>' +
        '<div class="rv-ingredient-stock">lager: ' + stockAmount + '</div>' +
        cartBtn +
    '</li>';
}

// ════════════════════════════════════════════════════════════
// PORTIONS
// ════════════════════════════════════════════════════════════

function _rvAdjustPortions(delta) {
    _rvCurrentPortions = Math.max(1, _rvCurrentPortions + delta);
    document.getElementById('rvPortionsDisplay').textContent = _rvCurrentPortions;
    _rvRenderIngredients();
}

// ════════════════════════════════════════════════════════════
// STOCK DOT CLICK (shopping list)
// ════════════════════════════════════════════════════════════

function _rvOnStockDotClick(productId, productName, neededAmount, stockAmount, unitName) {
    if (stockAmount >= neededAmount) {
        var extra = confirm(productName + '\n\nNok paa lager!\nPaa lager: ' + stockAmount + ' ' + unitName + '\nBrug for: ' + neededAmount + ' ' + unitName + '\n\nVil du alligevel tilfoeje til indkoebsliste?');
        if (extra) {
            var amt = prompt('Hvor meget vil du bestille?\n(' + unitName + ')', neededAmount);
            if (amt && parseFloat(amt) > 0) {
                _rvAddToShoppingList(productId, parseFloat(amt), productName);
            }
        }
    } else if (stockAmount > 0) {
        var missing = _rvRound(neededAmount - stockAmount);
        if (confirm(productName + '\n\nLavt lager!\nPaa lager: ' + stockAmount + ' ' + unitName + '\nBrug for: ' + neededAmount + ' ' + unitName + '\nMangler: ' + missing + ' ' + unitName + '\n\nTilfoej ' + missing + ' ' + unitName + ' til indkoebsliste?')) {
            _rvAddToShoppingList(productId, missing, productName);
        }
    } else {
        if (confirm(productName + '\n\nIkke paa lager!\nBrug for: ' + neededAmount + ' ' + unitName + '\n\nTilfoej til indkoebsliste?')) {
            _rvAddToShoppingList(productId, neededAmount, productName);
        }
    }
}

async function _rvAddToShoppingList(productId, amount, productName) {
    try {
        await postGrocyShoppingList([{
            product_id: productId,
            amount: amount,
            note: 'Fra opskrift: ' + (_rvCurrentRecipe ? _rvCurrentRecipe.name : '')
        }]);
        _rvShowAlert('Tilfojet til indkoebsliste: ' + productName, 'success');
    } catch (err) {
        _rvShowAlert('Fejl: ' + err.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// ADD ALL MISSING TO SHOPPING LIST
// ════════════════════════════════════════════════════════════

async function _rvAddAllMissingToShoppingList() {
    if (!_rvCurrentRecipe) return;
    var multiplier = _rvCurrentPortions / _rvBaseServings;
    var items = [];

    _rvIngredients.forEach(function(ing) {
        var baseAmount = parseFloat(ing.amount) || 0;
        var neededStock = baseAmount * multiplier;
        var stockAmount = _rvStock[ing.product_id] || 0;
        if (stockAmount >= neededStock) return; // nok på lager

        var missing = _rvRound(Math.max(0, neededStock - stockAmount));
        if (missing <= 0) return;

        var product = _rvProducts[ing.product_id] || {};
        items.push({
            product_id: ing.product_id,
            amount: missing,
            note: 'Fra opskrift: ' + _rvCurrentRecipe.name
        });
    });

    if (items.length === 0) {
        _rvShowAlert('Alle ingredienser er paa lager!', 'success');
        return;
    }

    try {
        await postGrocyShoppingList(items);
        _rvShowAlert(items.length + ' varer tilfojet til indkoebsliste', 'success');
    } catch (err) {
        _rvShowAlert('Fejl: ' + err.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// CONSUME RECIPE
// ════════════════════════════════════════════════════════════

async function _rvConsumeRecipe() {
    if (!_rvCurrentRecipe) return;

    var multiplier = _rvCurrentPortions / _rvBaseServings;
    var recipeName = _rvCurrentRecipe.name;

    // Build items to consume
    var itemsToConsume = [];

    // Direct ingredients (inkl. emballage — vi tracker emballage-lager)
    _rvIngredients.forEach(function(ing) {
        var baseAmount = parseFloat(ing.amount) || 0;
        var amount = _rvRound(baseAmount * multiplier);
        if (amount <= 0) return;
        var product = _rvProducts[ing.product_id] || {};
        itemsToConsume.push({
            product_id: ing.product_id,
            amount: amount,
            name: product.name || ('Produkt #' + ing.product_id),
            source: recipeName
        });
    });

    // Sub-recipe ingredients recursively
    if (_rvNestings && _rvNestings.length > 0) {
        _rvCollectSubRecipeIngredients(
            _rvCurrentRecipe.id, multiplier, itemsToConsume, {}
        );
    }

    if (itemsToConsume.length === 0) {
        _rvShowConsumeResult('Ingen ingredienser at traekke fra lager.', 'error');
        return;
    }

    // Build summary
    var summary = itemsToConsume.map(function(item) {
        var unit = _rvGetUnitForProduct(item.product_id);
        return '  \u2022 ' + item.name + ': ' + item.amount + ' ' + unit;
    }).join('\n');

    var ok = confirm(
        'Traek fra lager for "' + recipeName + '" (' + _rvCurrentPortions + ' portioner)\n\n' +
        itemsToConsume.length + ' varer:\n' + summary + '\n\n' +
        'Vil du fortsaette?'
    );
    if (!ok) return;

    // Execute via postGrocyConsume
    var btn = document.getElementById('rvConsumeBtn');
    btn.disabled = true;
    btn.textContent = 'Traekker fra lager...';

    try {
        // Merge duplicate product_ids (same product from main + sub-recipe)
        var merged = {};
        itemsToConsume.forEach(function(item) {
            if (!merged[item.product_id]) {
                merged[item.product_id] = { product_id: item.product_id, amount: 0, name: item.name };
            }
            merged[item.product_id].amount += item.amount;
        });

        var consumeLines = Object.values(merged).map(function(m) {
            return { product_id: m.product_id, amount: _rvRound(m.amount) };
        });

        // Use the bon-v2 per-produkt consume endpoint
        var result = await postGrocyConsumeProducts(consumeLines);

        btn.disabled = false;
        btn.textContent = 'Traek fra lager';

        if (result.ok) {
            _rvShowConsumeResult('Alle ' + result.consumed + ' varer trukket fra lager!', 'success');
        } else {
            // Byg pæn fejlbesked med produktnavne
            var failedItems = (result.results || []).filter(function(r) { return !r.success; });
            var failedNames = failedItems.map(function(r) {
                // Find produktnavn fra merged consume-liste
                var item = consumeLines.find(function(c) { return c.product_id === r.product_id; });
                var name = item ? (merged[r.product_id] || {}).name || ('Produkt #' + r.product_id) : ('Produkt #' + r.product_id);
                // Parse Grocy fejl til dansk
                var reason = '';
                if (r.error && r.error.indexOf('Amount to be consumed') !== -1) {
                    reason = ' (ikke nok på lager)';
                } else if (r.error && r.error.indexOf('No transaction') !== -1) {
                    reason = ' (ikke på lager)';
                }
                return name + reason;
            });
            var msg = result.consumed + ' trukket fra lager. ' + result.failed + ' fejlede: ' + failedNames.join(', ');
            _rvShowConsumeResult(msg, 'error');
        }

        // Refresh stock
        try {
            var freshStock = await fetchGrocyStock();
            _rvStock = {};
            freshStock.forEach(function(s) { _rvStock[s.product_id] = parseFloat(s.amount) || 0; });
            _rvRenderIngredients();
        } catch (e) { /* ignore refresh error */ }

    } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Traek fra lager';
        _rvShowConsumeResult('Fejl: ' + err.message, 'error');
    }
}

function _rvCollectSubRecipeIngredients(recipeId, parentMultiplier, itemsToConsume, visited) {
    if (visited[recipeId]) return;
    visited[recipeId] = true;

    var nestings = _rvAllNestings.filter(function(n) { return n.recipe_id == recipeId; });

    nestings.forEach(function(nesting) {
        var subRecipeId = nesting.includes_recipe_id;
        var subRecipe = _rvRecipeMap[subRecipeId];
        if (!subRecipe) return;

        var subBaseServings = parseInt(subRecipe.base_servings) || 1;
        var nestingServings = parseFloat(nesting.servings) || 1;
        var subMultiplier = (nestingServings * parentMultiplier) / subBaseServings;

        var subIngredients = _rvAllRecipesPos[subRecipeId] || [];

        subIngredients.forEach(function(ing) {
            var group = (ing.ingredient_group || '').toLowerCase();
            if (group === 'emballage') return;
            var baseAmount = parseFloat(ing.amount) || 0;
            var amount = _rvRound(baseAmount * subMultiplier);
            if (amount <= 0) return;
            var product = _rvProducts[ing.product_id] || {};
            itemsToConsume.push({
                product_id: ing.product_id,
                amount: amount,
                name: product.name || ('Produkt #' + ing.product_id),
                source: subRecipe.name
            });
        });

        _rvCollectSubRecipeIngredients(subRecipeId, subMultiplier * subBaseServings, itemsToConsume, visited);
    });
}

function _rvGetUnitForProduct(productId) {
    var product = _rvProducts[productId];
    if (product && product.qu_id_stock) return _rvQuantityUnits[product.qu_id_stock] || '';
    var ing = _rvIngredients.find(function(i) { return i.product_id == productId; });
    if (ing && ing.qu_id) return _rvQuantityUnits[ing.qu_id] || '';
    return '';
}

function _rvShowConsumeResult(message, type) {
    // Inline result under knap
    var el = document.getElementById('rvConsumeResult');
    if (el) {
        el.textContent = message;
        el.className = 'rv-consume-result ' + type;
        el.style.display = '';
        if (type === 'success') {
            setTimeout(function() { el.style.display = 'none'; }, 5000);
        }
    }
    // Toast overlay
    _rvShowToast(message, type);
}

function _rvShowToast(message, type) {
    // Fjern evt. eksisterende toast
    var old = document.getElementById('rvToast');
    if (old) old.remove();

    var toast = document.createElement('div');
    toast.id = 'rvToast';
    toast.className = 'rv-toast rv-toast-' + type;
    toast.textContent = (type === 'success' ? '✓ ' : '⚠ ') + message;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(function() { toast.classList.add('rv-toast-visible'); });

    // Auto-dismiss
    setTimeout(function() {
        toast.classList.remove('rv-toast-visible');
        setTimeout(function() { toast.remove(); }, 300);
    }, type === 'success' ? 4000 : 8000);
}

// ════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════

function _rvGoBack() {
    if (_rvNavigationStack.length > 0) {
        var prev = _rvNavigationStack.pop();
        _rvOpenRecipe(prev.recipeId, false);
        _rvCurrentPortions = prev.portions;
        document.getElementById('rvPortionsDisplay').textContent = _rvCurrentPortions;
        _rvRenderIngredients();
    } else {
        _rvShowList();
    }
}

function _rvShowList() {
    document.getElementById('rvDetailView').classList.remove('visible');
    document.getElementById('rvListView').style.display = 'block';
    _rvCurrentRecipe = null;
    _rvNavigationStack = [];
    window.scrollTo(0, 0);
}

// ════════════════════════════════════════════════════════════
// UNIT CONVERSION HELPERS
// ════════════════════════════════════════════════════════════

function _rvGetDisplayAmount(ing) {
    var product = _rvProducts[ing.product_id];
    if (!product || ing.qu_id == product.qu_id_stock) return parseFloat(ing.amount) || 0;
    var factor = _rvGetConversionFactor(ing.product_id, product.qu_id_stock, ing.qu_id);
    if (factor === null) return parseFloat(ing.amount) || 0;
    return (parseFloat(ing.amount) || 0) * factor;
}

function _rvGetConversionFactor(productId, fromQuId, toQuId) {
    if (fromQuId == toQuId) return 1.0;
    var convs = _rvQuConversions;

    // Product-specific forward
    var pf = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (pf) return pf.factor;
    // Product-specific reverse
    var pr = convs.find(function(c) { return c.product_id == productId && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (pr && pr.factor !== 0) return 1.0 / pr.factor;
    // Global forward
    var gf = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == fromQuId && c.to_qu_id == toQuId; });
    if (gf) return gf.factor;
    // Global reverse
    var gr = convs.find(function(c) { return (c.product_id === null || c.product_id === undefined) && c.from_qu_id == toQuId && c.to_qu_id == fromQuId; });
    if (gr && gr.factor !== 0) return 1.0 / gr.factor;
    // Multi-hop BFS
    return _rvFindMultiHopFactor(productId, fromQuId, toQuId);
}

function _rvFindMultiHopFactor(productId, fromQuId, toQuId) {
    var edges = {};
    _rvQuConversions.forEach(function(c) {
        if (c.product_id != productId && c.product_id !== null && c.product_id !== undefined) return;
        if (!edges[c.from_qu_id]) edges[c.from_qu_id] = [];
        if (!edges[c.to_qu_id]) edges[c.to_qu_id] = [];
        edges[c.from_qu_id].push({ target: c.to_qu_id, factor: c.factor });
        edges[c.to_qu_id].push({ target: c.from_qu_id, factor: 1.0 / c.factor });
    });
    var visited = {};
    visited[fromQuId] = true;
    var queue = [{ quId: fromQuId, cumulativeFactor: 1.0 }];
    while (queue.length > 0) {
        var cur = queue.shift();
        var neighbors = edges[cur.quId] || [];
        for (var i = 0; i < neighbors.length; i++) {
            var n = neighbors[i];
            if (n.target == toQuId) return cur.cumulativeFactor * n.factor;
            if (!visited[n.target]) {
                visited[n.target] = true;
                queue.push({ quId: n.target, cumulativeFactor: cur.cumulativeFactor * n.factor });
            }
        }
    }
    return null;
}

// ════════════════════════════════════════════════════════════
// WEIGHT CALCULATION
// ════════════════════════════════════════════════════════════

function _rvResolveWeightUnitIds() {
    if (_rvWeightUnitsCached) return;
    for (var idStr in _rvQuantityUnits) {
        var name = _rvQuantityUnits[idStr].toLowerCase();
        var id = parseInt(idStr);
        if (name === 'gram' || name === 'g') _rvGramQuId = id;
        if (name === 'kilo' || name === 'kg') _rvKiloQuId = id;
    }
    _rvWeightUnitsCached = true;
}

function _rvCalculateSubRecipeWeightGrams(subRecipeId, scaledServings) {
    var subRecipe = _rvRecipeMap[subRecipeId];
    var ingredients = _rvAllRecipesPos[subRecipeId];
    if (!subRecipe || !ingredients || ingredients.length === 0) return 0;

    var subBaseServings = parseFloat(subRecipe.base_servings) || 1;
    var subMultiplier = scaledServings / subBaseServings;

    var totalGrams = 0;
    ingredients.forEach(function(ing) {
        if ((ing.ingredient_group || '').toLowerCase() === 'emballage') return;
        var product = _rvProducts[ing.product_id] || {};
        var stockQuId = product.qu_id_stock || ing.qu_id;
        var stockUnitName = _rvQuantityUnits[stockQuId] || '';
        var amount = (parseFloat(ing.amount) || 0) * subMultiplier;
        totalGrams += _rvCalculateWeightGrams(amount, stockUnitName, ing.product_id, stockQuId);
    });
    return totalGrams;
}

function _rvCalculateWeightGrams(amount, unit, productId, quId) {
    var u = unit.toLowerCase();
    if (u === 'g' || u === 'gram') return amount;
    if (u === 'kg' || u === 'kilo') return amount * 1000;
    if (u === 'ml') return amount;
    if (u === 'l' || u === 'liter') return amount * 1000;

    if (productId && quId && _rvQuConversions.length > 0) {
        _rvResolveWeightUnitIds();

        if (quId === _rvGramQuId) return amount;
        if (quId === _rvKiloQuId) return amount * 1000;

        var findFactor = function(fromId, toId, prodId) {
            var direct = _rvQuConversions.find(function(c) {
                return c.product_id == prodId && c.from_qu_id == fromId && c.to_qu_id == toId;
            });
            if (direct) return direct.factor;
            var reverse = _rvQuConversions.find(function(c) {
                return c.product_id == prodId && c.from_qu_id == toId && c.to_qu_id == fromId;
            });
            if (reverse && reverse.factor !== 0) return 1 / reverse.factor;
            return null;
        };

        // Product-specific: quId -> Gram
        if (_rvGramQuId) {
            var f1 = findFactor(quId, _rvGramQuId, productId);
            if (f1 !== null) return amount * f1;
        }
        // Product-specific: quId -> Kilo -> * 1000
        if (_rvKiloQuId) {
            var f2 = findFactor(quId, _rvKiloQuId, productId);
            if (f2 !== null) return amount * f2 * 1000;
        }
        // Global: quId -> Gram
        if (_rvGramQuId) {
            var globalConvs = _rvQuConversions.filter(function(c) {
                return c.product_id === null || c.product_id === undefined;
            });
            var dG = globalConvs.find(function(c) { return c.from_qu_id == quId && c.to_qu_id == _rvGramQuId; });
            if (dG) return amount * dG.factor;
            var rG = globalConvs.find(function(c) { return c.from_qu_id == _rvGramQuId && c.to_qu_id == quId; });
            if (rG && rG.factor !== 0) return amount * (1 / rG.factor);
        }
        // Global: quId -> Kilo
        if (_rvKiloQuId) {
            var globalConvs2 = _rvQuConversions.filter(function(c) {
                return c.product_id === null || c.product_id === undefined;
            });
            var dK = globalConvs2.find(function(c) { return c.from_qu_id == quId && c.to_qu_id == _rvKiloQuId; });
            if (dK) return amount * dK.factor * 1000;
            var rK = globalConvs2.find(function(c) { return c.from_qu_id == _rvKiloQuId && c.to_qu_id == quId; });
            if (rK && rK.factor !== 0) return amount * (1 / rK.factor) * 1000;
        }
    }

    return 0;
}

// ════════════════════════════════════════════════════════════
// FORMATTING HELPERS
// ════════════════════════════════════════════════════════════

function _rvRound(num, decimals) {
    if (decimals === undefined) decimals = 2;
    var p = Math.pow(10, decimals);
    return Math.round(num * p) / p;
}

function _rvFormatAmount(amount, unitName) {
    var u = (unitName || '').toLowerCase().trim();

    // kg -> g when < 1
    if ((u === 'kg' || u === 'kilo') && amount < 1 && amount > 0) {
        return { amount: _rvRound(amount * 1000), unit: 'g' };
    }
    // liter -> ml when < 1
    if ((u === 'l' || u === 'liter') && amount < 1 && amount > 0) {
        return { amount: _rvRound(amount * 1000), unit: 'ml' };
    }
    // g -> kg when >= 1000
    if ((u === 'g' || u === 'gram') && amount >= 1000) {
        return { amount: _rvRound(amount / 1000), unit: 'kg' };
    }
    // ml -> liter when >= 1000
    if (u === 'ml' && amount >= 1000) {
        return { amount: _rvRound(amount / 1000), unit: 'l' };
    }

    return { amount: _rvRound(amount), unit: unitName };
}

function _rvFormatWeight(grams) {
    if (grams >= 1000) {
        return _rvRound(grams / 1000, 2) + ' kg';
    }
    return _rvRound(grams) + ' g';
}
