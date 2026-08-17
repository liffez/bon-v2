/**
 * shared/vare_picker.js
 * ════════════════════════════════════════════════════════════
 * Standalone varepicker — vælg opskrift fra Grocy, angiv antal,
 * og POST til /api/bons/:id/lines.
 *
 * Flow: Klik vare → fast antal-bar vises under listen i fuld bredde →
 * Enter eller klik "Tilføj" sender med det samme. Pickeren forbliver åben.
 *
 * Kræver: api.js (fetchGrocyRecipes, postBonLine) som globale funktioner.
 * ════════════════════════════════════════════════════════════
 */

var _vpRecipesCache = null;
var _vpPriceCatsCache = null;

class VarePicker {
    constructor(opts) {
        this.bonId = opts.bonId; // null/undefined = detached mode (onAdded får line-objekt, ingen POST)
        this.priceCategory = opts.priceCategory || 'catering';
        this.container = opts.container;
        this.onAdded = opts.onAdded || function() {};
        this.onClose = opts.onClose || function() {};
        this.viewName = opts.viewName || 'all';
        this.showPriceCategorySelector = !!opts.showPriceCategorySelector;
        // 'sales' (default) viser salgsprisen for den valgte priskategori.
        // 'cost' viser kostprisen — brugt af event-prep, hvor bonnen er 0 kr
        // (produktion) og kostprisen er det tal der driver Vareforbrug i P&L.
        this.priceField = opts.priceField === 'cost' ? 'cost' : 'sales';
        this._visible = false;
        this._cats = null;
        this._priceCat = this.priceCategory;
        this._priceCats = null; // [{code,label}, ...] loaded when selector enabled
        this._escHandler = null;
        this._saving = false;
        this._selectedRecipeId = null;
    }

    /* ── Public API ──────────────────────────────────────── */

    toggle() { this._visible ? this.close() : this.open(); }

    async open() {
        // Close all other open pickers
        document.querySelectorAll('.vp-picker.open').forEach(function(p) {
            p.classList.remove('open');
            p.innerHTML = '';
        });

        this._visible = true;
        this._selectedRecipeId = null;
        this.container.innerHTML = '<div class="vp-picker open"><div class="vp-loading">Henter opskrifter\u2026</div></div>';

        try {
            var recipes = await this._loadRecipes();
            if (this.showPriceCategorySelector) {
                this._priceCats = await this._loadPriceCategories();
            }

            // Group by category
            var cats = {};
            recipes.forEach(function(r) {
                var cat = r.category || 'Andet';
                if (!cats[cat]) cats[cat] = [];
                cats[cat].push(r);
            });
            var catNames = Object.keys(cats);
            if (!catNames.length) {
                this.container.querySelector('.vp-picker').innerHTML = '<div class="vp-loading">Ingen opskrifter fundet</div>';
                return;
            }

            this._cats = cats;
            this._priceCat = this.priceCategory;

            var showPrice = this._showPrices();
            var priceToggleIcon = showPrice ? '\u25CE' : '\u25C9';
            var hideCls = showPrice ? '' : ' vp-hide-prices';

            var self = this;
            var picker = this.container.querySelector('.vp-picker');
            picker.className = 'vp-picker open' + hideCls;
            var priceCatSelectorHtml = '';
            if (this.showPriceCategorySelector && this._priceCats && this._priceCats.length) {
                priceCatSelectorHtml = '<select class="vp-pricecat-select" title="Priskategori">' +
                    this._priceCats.map(function(pc) {
                        var sel = (pc.code === self._priceCat) ? ' selected' : '';
                        return '<option value="' + pc.code + '"' + sel + '>' + pc.label + '</option>';
                    }).join('') +
                '</select>';
            }
            picker.innerHTML =
                '<div class="vp-header">' +
                    '<span class="vp-title">Tilf\u00f8j vare</span>' +
                    priceCatSelectorHtml +
                    '<button type="button" class="vp-price-toggle" title="Vis/skjul priser">' + priceToggleIcon + '</button>' +
                    '<button type="button" class="vp-close">\u00d7</button>' +
                '</div>' +
                '<div class="vp-body">' +
                    '<div class="vp-categories">' +
                        catNames.map(function(c, i) {
                            return '<button type="button" class="vp-cat' + (i === 0 ? ' active' : '') + '">' + c + '</button>';
                        }).join('') +
                    '</div>' +
                    '<div class="vp-items">' +
                        self._renderItems(cats[catNames[0]], self._priceCat) +
                    '</div>' +
                '</div>' +
                '<div class="vp-action-bar" style="display:none">' +
                    '<div class="vp-action-row">' +
                        '<button type="button" class="vp-qty-btn" data-delta="-1">\u2212</button>' +
                        '<input class="vp-qty-input" type="number" value="1" min="1">' +
                        '<button type="button" class="vp-qty-btn" data-delta="1">+</button>' +
                        '<span class="vp-action-name"></span>' +
                        '<button type="button" class="vp-action-add">Tilf\u00f8j</button>' +
                    '</div>' +
                    '<input class="vp-special" type="text" placeholder="Extra info\u2026">' +
                '</div>' +
                '<div class="vp-flash-slot"></div>';

            // Event delegation
            picker.addEventListener('click', function(e) {
                var target = e.target;
                if (target.classList.contains('vp-close')) {
                    self.close();
                } else if (target.classList.contains('vp-price-toggle')) {
                    e.stopPropagation();
                    self._togglePrices();
                } else if (target.classList.contains('vp-cat')) {
                    self._selectCat(target);
                } else if (target.classList.contains('vp-qty-btn')) {
                    e.stopPropagation();
                    self._adjustQty(target);
                } else if (target.classList.contains('vp-action-add')) {
                    e.stopPropagation();
                    self._addSelected();
                } else if (target.closest('.vp-item')) {
                    self._selectItem(target.closest('.vp-item'));
                }
            });

            // Price-category selector (detached mode)
            picker.addEventListener('change', function(e) {
                if (e.target.classList.contains('vp-pricecat-select')) {
                    self._priceCat = e.target.value;
                    var activeCatBtn = picker.querySelector('.vp-cat.active');
                    var catName = activeCatBtn ? activeCatBtn.textContent : Object.keys(self._cats || {})[0];
                    var items = (self._cats || {})[catName] || [];
                    var itemsEl = picker.querySelector('.vp-items');
                    if (itemsEl) itemsEl.innerHTML = self._renderItems(items, self._priceCat);
                    self._syncItemHighlight(picker);
                }
            });

            // Enter in qty input → add
            picker.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && e.target.classList.contains('vp-qty-input')) {
                    e.preventDefault();
                    self._addSelected();
                }
            });

            // Escape handler
            this._escHandler = function(e) {
                if (e.key === 'Escape') self.close();
            };
            document.addEventListener('keydown', this._escHandler);

        } catch (err) {
            this.container.querySelector('.vp-picker').innerHTML = '<div class="vp-loading">Fejl: ' + err.message + '</div>';
        }
    }

    close() {
        this._visible = false;
        this._selectedRecipeId = null;
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        this._cats = null;
        this.container.innerHTML = '';
        this.onClose();
    }

    /** Update bonId + priceCategory (e.g. when drawer re-loads) */
    update(opts) {
        if (opts.bonId !== undefined) this.bonId = opts.bonId;
        if (opts.priceCategory !== undefined) {
            this.priceCategory = opts.priceCategory;
            this._priceCat = opts.priceCategory;
        }
    }

    /* ── Recipes cache ───────────────────────────────────── */

    async _loadRecipes() {
        if (!_vpRecipesCache) _vpRecipesCache = await fetchGrocyRecipes();
        return _vpRecipesCache;
    }

    async _loadPriceCategories() {
        if (!_vpPriceCatsCache) {
            try { _vpPriceCatsCache = await fetchPriceCategories(); }
            catch (e) { _vpPriceCatsCache = []; }
        }
        return _vpPriceCatsCache;
    }

    /* ── Price toggle ────────────────────────────────────── */

    _showPrices() {
        var key = 'vp-show-prices-' + this.viewName;
        var stored = localStorage.getItem(key);
        return stored !== null ? stored === '1' : true;
    }

    _togglePrices() {
        var key = 'vp-show-prices-' + this.viewName;
        var current = this._showPrices();
        localStorage.setItem(key, current ? '0' : '1');
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        picker.classList.toggle('vp-hide-prices', current);
        var btn = picker.querySelector('.vp-price-toggle');
        if (btn) btn.textContent = current ? '\u25C9' : '\u25CE';
    }

    /* ── Category selection ──────────────────────────────── */

    _selectCat(btn) {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        var catName = btn.textContent;

        picker.querySelectorAll('.vp-cat').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');

        var items = (this._cats || {})[catName] || [];
        var itemsEl = picker.querySelector('.vp-items');
        if (itemsEl) itemsEl.innerHTML = this._renderItems(items, this._priceCat);

        // Behold action-bar synlig hvis der er en selected recipe i denne kategori
        this._syncItemHighlight(picker);
    }

    /* ── Render items ────────────────────────────────────── */

    _renderItems(items, priceCat) {
        var selectedId = this._selectedRecipeId;
        var useCost = (this.priceField === 'cost');
        return items.map(function(r) {
            var price = useCost ? (r.cost_price || 0) : (r.prices[priceCat] || 0);
            var priceTxt = useCost
                ? (Math.round(price * 100) / 100).toLocaleString('da-DK')
                : price;
            var priceTitle = useCost ? ' title="Kostpris ex moms"' : '';
            var name = (r.name || '').trim();
            var cls = 'vp-item' + (r.id === selectedId ? ' selected' : '');
            return '<div class="' + cls + '" data-recipe-id="' + r.id + '">' +
                '<span class="vp-item-name">' + name + '</span>' +
                '<span class="vp-item-price"' + priceTitle + '>' + priceTxt + ' kr</span>' +
            '</div>';
        }).join('');
    }

    /* ── Item selection → show action bar ─────────────────── */

    _selectItem(itemEl) {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker || this._saving) return;
        var recipeId = parseInt(itemEl.dataset.recipeId);

        // Find recipe
        var recipe = this._findRecipe(recipeId);
        if (!recipe) return;

        // Toggle off if same
        if (this._selectedRecipeId === recipeId) {
            this._selectedRecipeId = null;
            this._hideActionBar(picker);
            picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });
            return;
        }

        this._selectedRecipeId = recipeId;

        // Highlight
        picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });
        itemEl.classList.add('selected');

        // Show action bar
        var bar = picker.querySelector('.vp-action-bar');
        var nameEl = bar.querySelector('.vp-action-name');
        nameEl.textContent = '\u00d7 ' + (recipe.name || '').trim();
        bar.style.display = '';

        // Reset qty
        var qtyInput = bar.querySelector('.vp-qty-input');
        qtyInput.value = 1;
        qtyInput.focus();
        qtyInput.select();
    }

    _hideActionBar(picker) {
        var bar = picker.querySelector('.vp-action-bar');
        if (bar) bar.style.display = 'none';
    }

    _syncItemHighlight(picker) {
        // After category switch, re-highlight if selected recipe is in current items
        var id = this._selectedRecipeId;
        if (!id) return;
        var found = picker.querySelector('.vp-item[data-recipe-id="' + id + '"]');
        if (found) {
            found.classList.add('selected');
        }
    }

    _findRecipe(recipeId) {
        var cats = this._cats || {};
        for (var key in cats) {
            var r = cats[key].find(function(r) { return r.id === recipeId; });
            if (r) return r;
        }
        return null;
    }

    /* ── Adjust qty ──────────────────────────────────────── */

    _adjustQty(btn) {
        var delta = parseInt(btn.dataset.delta) || 0;
        var bar = btn.closest('.vp-action-bar');
        if (!bar) return;
        var input = bar.querySelector('.vp-qty-input');
        if (!input) return;
        var val = Math.max(1, parseInt(input.value || '1') + delta);
        input.value = val;
        input.focus();
        input.select();
    }

    /* ── Add selected item ──────────────────────────────── */

    async _addSelected() {
        if (this._saving || !this._selectedRecipeId) return;
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;

        var recipe = this._findRecipe(this._selectedRecipeId);
        if (!recipe) return;

        var bar = picker.querySelector('.vp-action-bar');
        var qtyInput = bar.querySelector('.vp-qty-input');
        var qty = Math.max(1, parseInt(qtyInput ? qtyInput.value : '1') || 1);
        var price = recipe.prices[this._priceCat] || 0;
        var specialInput = bar.querySelector('.vp-special');
        var specialText = (specialInput && specialInput.value) ? specialInput.value.trim() : null;

        // Disable while saving
        this._saving = true;
        var addBtn = bar.querySelector('.vp-action-add');
        if (addBtn) { addBtn.disabled = true; addBtn.textContent = '\u2026'; }

        var line = {
            grocy_recipe_id: recipe.id,
            product_name:    (recipe.name || '').trim(),
            category:        recipe.category || null,
            quantity:         qty,
            unit:            recipe.unit || 'stk',
            unit_price:      price,
            cost_price:      recipe.cost_price || 0,
            co2e:            recipe.co2e || 0,
            special_request: specialText,
            price_category:  this._priceCat,
        };

        try {
            if (this.bonId != null) {
                await postBonLine(this.bonId, line);
            }
            // Detached mode: ingen POST — caller håndterer line via onAdded

            // Reset add button, clear selection, hide action bar, reset special input
            if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Tilf\u00f8j'; }
            this._selectedRecipeId = null;
            picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });
            if (specialInput) specialInput.value = '';
            this._hideActionBar(picker);

            // Flash confirmation
            var flashSlot = picker.querySelector('.vp-flash-slot');
            if (flashSlot) {
                flashSlot.innerHTML = '<div class="vp-added-flash">\u2714 ' + qty + '\u00d7 ' + (recipe.name || '').trim() + '</div>';
                setTimeout(function() { if (flashSlot) flashSlot.innerHTML = ''; }, 1500);
            }

            this.onAdded(line);

        } catch (err) {
            if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Tilf\u00f8j'; }
            console.error('Tilf\u00f8j vare fejlede:', err);
        } finally {
            this._saving = false;
        }
    }
}
