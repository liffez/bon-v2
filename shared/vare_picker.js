/**
 * shared/vare_picker.js
 * ════════════════════════════════════════════════════════════
 * Standalone varepicker — vælg opskrift fra Grocy, angiv antal,
 * og POST til /api/bons/:id/lines.
 *
 * Kræver: api.js (fetchGrocyRecipes, postBonLine) som globale funktioner.
 *
 * Brug:
 *   const picker = new VarePicker({
 *     bonId: 42,
 *     priceCategory: 'catering',
 *     container: document.getElementById('slot'),
 *     onAdded: (line) => { … }
 *   });
 *   picker.toggle();
 * ════════════════════════════════════════════════════════════
 */

var _vpRecipesCache = null;

class VarePicker {
    constructor(opts) {
        this.bonId = opts.bonId;
        this.priceCategory = opts.priceCategory || 'catering';
        this.container = opts.container;
        this.onAdded = opts.onAdded || function() {};
        this.viewName = opts.viewName || 'all';
        this._visible = false;
        this._cats = null;
        this._priceCat = this.priceCategory;
        this._escHandler = null;
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
        this.container.innerHTML = '<div class="vp-picker open"><div class="vp-loading">Henter opskrifter\u2026</div></div>';

        try {
            var recipes = await this._loadRecipes();

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
            picker.innerHTML =
                '<div class="vp-header">' +
                    '<span class="vp-title">Tilf\u00f8j vare</span>' +
                    '<button class="vp-price-toggle" title="Vis/skjul priser">' + priceToggleIcon + '</button>' +
                    '<button class="vp-close">\u00d7</button>' +
                '</div>' +
                '<div class="vp-body">' +
                    '<div class="vp-categories">' +
                        catNames.map(function(c, i) {
                            return '<button class="vp-cat' + (i === 0 ? ' active' : '') + '">' + c + '</button>';
                        }).join('') +
                    '</div>' +
                    '<div class="vp-items">' +
                        self._renderItems(cats[catNames[0]], self._priceCat) +
                    '</div>' +
                '</div>' +
                '<div class="vp-expand-slot"></div>';

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
                } else if (target.closest('.vp-item') && !target.closest('.vp-expand')) {
                    self._selectItem(target.closest('.vp-item'));
                } else if (target.classList.contains('vp-qty-btn')) {
                    self._adjustQty(target);
                } else if (target.classList.contains('vp-save')) {
                    self._save();
                } else if (target.classList.contains('vp-cancel')) {
                    self._cancelExpand();
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
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        this._cats = null;
        this.container.innerHTML = '';
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

        // Clear expand + selection
        this._removeExpand();
        picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });

        var items = (this._cats || {})[catName] || [];
        var itemsEl = picker.querySelector('.vp-items');
        if (itemsEl) itemsEl.innerHTML = this._renderItems(items, this._priceCat);
    }

    /* ── Render items ────────────────────────────────────── */

    _renderItems(items, priceCat) {
        return items.map(function(r) {
            var price = r.prices[priceCat] || 0;
            var name = (r.name || '').trim();
            return '<div class="vp-item" data-recipe-id="' + r.id + '">' +
                '<span class="vp-item-name">' + name + '</span>' +
                '<span class="vp-item-price">' + price + ' kr</span>' +
            '</div>';
        }).join('');
    }

    /* ── Item selection → expand ──────────────────────────── */

    _selectItem(itemEl) {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        var recipeId = parseInt(itemEl.dataset.recipeId);

        // Find recipe
        var recipe = null;
        var cats = this._cats || {};
        for (var key in cats) {
            recipe = cats[key].find(function(r) { return r.id === recipeId; });
            if (recipe) break;
        }
        if (!recipe) return;

        // Clear prev
        this._removeExpand();
        picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });
        itemEl.classList.add('selected');

        var price = recipe.prices[this._priceCat] || 0;
        var name = (recipe.name || '').trim();
        var slot = picker.querySelector('.vp-expand-slot');
        slot.innerHTML =
            '<div class="vp-expand" data-recipe-id="' + recipeId + '">' +
                '<div class="vp-expand-row">' +
                    '<button class="vp-qty-btn" data-delta="-1">\u2212</button>' +
                    '<input class="vp-qty-input" type="number" value="1" min="1">' +
                    '<button class="vp-qty-btn" data-delta="1">+</button>' +
                    '<span class="vp-expand-name">\u00d7 ' + name + '</span>' +
                '</div>' +
                '<input class="vp-special" type="text" placeholder="Extra info\u2026">' +
                '<div class="vp-expand-actions">' +
                    '<button class="vp-save">GEM</button>' +
                    '<button class="vp-cancel">AFBRYD</button>' +
                '</div>' +
            '</div>';

        var qtyInput = slot.querySelector('.vp-qty-input');
        qtyInput.focus();
        qtyInput.select();

        // Clamp on change
        qtyInput.addEventListener('change', function() {
            if (parseInt(qtyInput.value) < 1 || isNaN(parseInt(qtyInput.value))) qtyInput.value = 1;
        });
    }

    /* ── Expand helpers ──────────────────────────────────── */

    _removeExpand() {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        var slot = picker.querySelector('.vp-expand-slot');
        if (slot) slot.innerHTML = '';
    }

    _adjustQty(btn) {
        var delta = parseInt(btn.dataset.delta) || 0;
        var input = btn.parentElement.querySelector('.vp-qty-input');
        var val = Math.max(1, parseInt(input.value || '1') + delta);
        input.value = val;
    }

    _cancelExpand() {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        this._removeExpand();
        picker.querySelectorAll('.vp-item.selected').forEach(function(el) { el.classList.remove('selected'); });
    }

    /* ── Save ────────────────────────────────────────────── */

    async _save() {
        var picker = this.container.querySelector('.vp-picker');
        if (!picker) return;
        var expand = picker.querySelector('.vp-expand');
        if (!expand) return;

        var recipeId = parseInt(expand.dataset.recipeId);
        var recipe = null;
        var cats = this._cats || {};
        for (var key in cats) {
            recipe = cats[key].find(function(r) { return r.id === recipeId; });
            if (recipe) break;
        }
        if (!recipe) return;

        var qty = Math.max(1, parseInt(expand.querySelector('.vp-qty-input').value) || 1);
        var special = expand.querySelector('.vp-special').value.trim() || null;
        var price = recipe.prices[this._priceCat] || 0;

        var saveBtn = expand.querySelector('.vp-save');
        saveBtn.disabled = true;
        saveBtn.textContent = '\u2026';

        try {
            await postBonLine(this.bonId, {
                grocy_recipe_id: recipe.id,
                product_name:    (recipe.name || '').trim(),
                category:        recipe.category || null,
                quantity:         qty,
                unit:            recipe.unit || 'stk',
                unit_price:      price,
                cost_price:      recipe.cost_price || 0,
                co2e:            recipe.co2e || 0,
                special_request: special,
            });

            this.close();
            this.onAdded();

        } catch (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'GEM';
            console.error('Tilf\u00f8j vare fejlede:', err);
        }
    }
}
