/* ══════════════════════════════════════════════════════════════
   indkob.js — Merged indkøbsliste + bestilling (accordion UI)
   Entry: initIndkob(containerEl)
   Prefix: _ib
   ══════════════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────────────── */
var _ibContainer       = null;

// Grocy data
var _ibShoppingList    = [];
var _ibProducts        = {};   // product_id → product
var _ibBarcodes        = [];
var _ibQUnits          = {};   // qu_id → { id, name, name_plural }
var _ibLocations       = {};   // grocy shopping_location id → { id, name }

// V2 supplier data
var _ibHandelssteder   = [];

// Hoka live
var _ibHokaOk          = false;
var _ibFavCache        = [];
var _ibFavLoaded       = false;
var _ibFavLoading      = false;

// Derived — leverandørgrupper
var _ibGroups          = {};

// Volatile (Manglende / Udløbende)
var _ibMissingProducts = [];
var _ibDueProducts     = [];

// UI state
var _ibOpenGroups      = {};
var _ibCartItems       = [];
var _ibShowOrdered     = {};
var _ibPanelOpen       = null;  // 'missing'|'expiring'|null
var _ibLinkPanelId     = null;
var _ibMoOpen          = null;
var _ibBusy            = false;
var _ibFocusGroup      = null;  // grocy_location_id in focus mode
var _ibFocusMode       = false;
var _ibSearchTerm      = '';
var _ibToastTimer      = null;

/* ── Init ──────────────────────────────────────────────────── */
async function initIndkob(el) {
    _ibContainer = el;
    _ibShowLoading();

    try {
        await _ibLoadAll();
        _ibBuildGroups();

        // Bind event delegation once
        _ibContainer.addEventListener('click', _ibHandleClick);
        _ibContainer.addEventListener('input', _ibHandleInput);
        _ibContainer.addEventListener('change', _ibHandleInput);

        _ibRender();

        // Non-blocking enrichment
        _ibEnrichSnapshots();
        _ibLoadFavCache();
        _ibLoadVolatile();
    } catch (err) {
        console.error('[indkob] init fejl:', err);
        _ibContainer.innerHTML = '<div class="ib-empty"><div class="ib-empty-icon">⚠️</div>'
            + '<div class="ib-empty-title">Kunne ikke indlæse indkøbsdata</div>'
            + '<div class="ib-empty-sub">' + (err.message || 'Ukendt fejl') + '</div></div>';
    }
}

/* ── Data loading ──────────────────────────────────────────── */
async function _ibLoadAll() {
    var results = await Promise.all([
        fetchShoppingList(),
        fetchGrocyProducts(),
        fetchProductBarcodes(),
        fetchGrocyQuantityUnits(),
        fetchShoppingLocations(),
        fetchPurchasingSuppliers(),
        fetchHokaStatus().catch(function() { return { ok: false }; }),
    ]);

    _ibShoppingList = results[0] || [];

    // Products → map
    var prodArr = results[1] || [];
    _ibProducts = {};
    for (var i = 0; i < prodArr.length; i++) {
        _ibProducts[prodArr[i].id] = prodArr[i];
    }

    _ibBarcodes = results[2] || [];

    // QU → map
    var quArr = results[3] || [];
    _ibQUnits = {};
    for (var j = 0; j < quArr.length; j++) {
        _ibQUnits[quArr[j].id] = quArr[j];
    }

    // Locations → map
    var locArr = results[4] || [];
    _ibLocations = {};
    for (var k = 0; k < locArr.length; k++) {
        _ibLocations[locArr[k].id] = locArr[k];
    }

    _ibHandelssteder = results[5] || [];
    _ibHokaOk = !!(results[6] && results[6].ok);
}

async function _ibReloadShoppingList() {
    _ibShoppingList = await fetchShoppingList() || [];
    _ibBarcodes = await fetchProductBarcodes() || [];
    _ibBuildGroups();
    _ibRender();
}

async function _ibLoadVolatile() {
    try {
        var data = await fetchGrocyStockVolatile(5);
        _ibMissingProducts = data.missing_products || [];
        _ibDueProducts = (data.due_products || []).concat(data.overdue_products || []);
        _ibRenderPanelBadges();
    } catch (e) {
        console.warn('[indkob] volatile fejl:', e.message);
    }
}

async function _ibLoadFavCache() {
    if (_ibFavLoading || _ibFavLoaded) return;
    _ibFavLoading = true;
    try {
        var lists = await fetchHokaFavorites();
        if (lists && lists.lists && lists.lists.length > 0) {
            var data = await fetchHokaFavoritesAll(lists.lists[0].id);
            _ibFavCache = data.products || [];
        }
        _ibFavLoaded = true;
    } catch (e) {
        console.warn('[indkob] favs fejl:', e.message);
    }
    _ibFavLoading = false;
}

/* ── Snapshot enrichment ───────────────────────────────────── */
async function _ibEnrichSnapshots() {
    if (!_ibHokaOk) return;

    // Collect all hoka barcodes
    var hokaIds = [];
    for (var key in _ibGroups) {
        var g = _ibGroups[key];
        for (var i = 0; i < g.items.length; i++) {
            var entry = g.items[i];
            for (var b = 0; b < entry.barcodes.length; b++) {
                var bc = entry.barcodes[b];
                if (_ibIsHokaBarcode(bc)) {
                    hokaIds.push(bc.barcode);
                }
            }
        }
    }

    if (!hokaIds.length) return;

    // Batch in chunks of 20
    for (var start = 0; start < hokaIds.length; start += 20) {
        var chunk = hokaIds.slice(start, start + 20);
        try {
            var data = await fetchHokaSnapshots(chunk);
            var prods = data.products || [];
            for (var p = 0; p < prods.length; p++) {
                var snap = prods[p];
                // Find matching barcode and attach
                _ibAttachSnapshot(snap);
            }
        } catch (e) {
            console.warn('[indkob] snapshot chunk fejl:', e.message);
        }
    }

    // Re-sort barcodes with live data
    for (var gk in _ibGroups) {
        var grp = _ibGroups[gk];
        for (var gi = 0; gi < grp.items.length; gi++) {
            var ent = grp.items[gi];
            ent.barcodes = _ibSortBarcodes(ent.barcodes);
            ent.selectedBcIdx = 0;
            ent.selectedBarcode = ent.barcodes[0] || null;
            ent.qty = _ibCalcQty(ent.need, ent.selectedBarcode);
        }
    }

    _ibRender();
}

function _ibAttachSnapshot(snap) {
    var varenr = String(snap.varenummer || snap.id || '');
    for (var i = 0; i < _ibBarcodes.length; i++) {
        if (String(_ibBarcodes[i].barcode) === varenr) {
            _ibBarcodes[i]._hoka = snap;
        }
    }
    // Also on group items
    for (var gk in _ibGroups) {
        var grp = _ibGroups[gk];
        for (var gi = 0; gi < grp.items.length; gi++) {
            var ent = grp.items[gi];
            for (var b = 0; b < ent.barcodes.length; b++) {
                if (String(ent.barcodes[b].barcode) === varenr) {
                    ent.barcodes[b]._hoka = snap;
                }
            }
        }
    }
}

function _ibIsHokaBarcode(bc) {
    // Barcodes at Hørkram shopping locations
    var locId = bc.shopping_location_id;
    for (var i = 0; i < _ibHandelssteder.length; i++) {
        var h = _ibHandelssteder[i];
        if (String(h.grocy_location_id) === String(locId) && h.integration_type === 'api') {
            return true;
        }
    }
    return false;
}

/* ── Group building ────────────────────────────────────────── */
function _ibBuildGroups() {
    _ibGroups = {};

    // Build handler map: grocy_location_id → handelssted
    // API returns: supplier_name, supplier_notes, grocy_location_display_name
    var hsMap = {};
    for (var h = 0; h < _ibHandelssteder.length; h++) {
        var hs = _ibHandelssteder[h];
        if (hs.grocy_location_id) hsMap[String(hs.grocy_location_id)] = hs;
    }

    // Barcodes by product_id
    var bcByProduct = {};
    for (var b = 0; b < _ibBarcodes.length; b++) {
        var bc = _ibBarcodes[b];
        var pid = bc.product_id;
        if (!bcByProduct[pid]) bcByProduct[pid] = [];
        bcByProduct[pid].push(bc);
    }

    // Group shopping list items by product_id first (aggregate)
    var itemsByProduct = {};
    for (var s = 0; s < _ibShoppingList.length; s++) {
        var sl = _ibShoppingList[s];
        var productId = sl.product_id;
        if (!productId) continue;
        if (!itemsByProduct[productId]) itemsByProduct[productId] = [];
        itemsByProduct[productId].push(sl);
    }

    // Process each product
    for (var pId in itemsByProduct) {
        var items = itemsByProduct[pId];
        var product = _ibProducts[pId];
        if (!product) continue;

        var allBarcodes = bcByProduct[pId] || [];

        // Determine primary group: product.shopping_location_id
        var shopLocId = String(product.shopping_location_id || '');
        var groupKey = shopLocId || '__none__';

        // Check if ordered
        var firstItem = items[0];
        var uf = firstItem.userfields || {};
        var isOrdered = !!uf.ordered_varenr;

        // Aggregate need
        var totalNeed = 0;
        for (var n = 0; n < items.length; n++) {
            totalNeed += parseFloat(items[n].amount) || 0;
        }

        // Stock unit name
        var stockQuId = product.qu_id_stock;
        var needUnit = (_ibQUnits[stockQuId] && _ibQUnits[stockQuId].name) || 'stk';

        // Sort barcodes
        var sortedBc = _ibSortBarcodes(allBarcodes);

        // Build entry
        var entry = {
            item: firstItem,
            allItems: items,
            product: product,
            barcodes: sortedBc,
            matched: sortedBc.length > 0,
            selectedBcIdx: 0,
            selectedBarcode: sortedBc[0] || null,
            need: totalNeed,
            needUnit: needUnit,
            qty: _ibCalcQty(totalNeed, sortedBc[0] || null),
            inCart: false,
            isOrdered: isOrdered,
            orderedAt: uf.ordered_at || null,
            orderedSupplier: uf.ordered_supplier || null,
        };

        // Init group if needed
        if (!_ibGroups[groupKey]) {
            var handler = hsMap[shopLocId];
            var loc = _ibLocations[shopLocId];
            _ibGroups[groupKey] = {
                grocyLocationId: groupKey,
                supplierId: handler ? handler.supplier_id : null,
                supplierName: handler ? handler.supplier_name : (loc ? loc.name : 'Ukendt'),
                displayName: handler ? (handler.grocy_location_display_name || handler.supplier_name) : (loc ? loc.name : 'Uden leverandør'),
                integrationType: handler ? handler.integration_type : 'none',
                contactEmail: handler ? handler.contact_email : null,
                contactPhone: handler ? handler.contact_phone : null,
                webshopUrl: handler ? handler.webshop_url : null,
                notes: handler ? handler.supplier_notes : null,
                items: [],
            };
        }

        _ibGroups[groupKey].items.push(entry);
    }

    // Sort items within each group: unordered first, then ordered
    for (var gk in _ibGroups) {
        _ibGroups[gk].items.sort(function(a, b) {
            if (a.isOrdered !== b.isOrdered) return a.isOrdered ? 1 : -1;
            return (a.product.name || '').localeCompare(b.product.name || '', 'da');
        });
    }
}

/* ── Barcode sorting ───────────────────────────────────────── */
function _ibSortBarcodes(barcodes) {
    return barcodes.slice().sort(function(a, b) {
        // 1. Foretrukken
        var aFav = (a.userfields && a.userfields.is_preferred === '1') ? 0 : 1;
        var bFav = (b.userfields && b.userfields.is_preferred === '1') ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        // 2. Aftale (live)
        var aAft = (a._hoka && a._hoka.isAgreementItem) ? 0 : ((a.userfields && a.userfields.is_agreement_item === '1') ? 0 : 1);
        var bAft = (b._hoka && b._hoka.isAgreementItem) ? 0 : ((b.userfields && b.userfields.is_agreement_item === '1') ? 0 : 1);
        if (aAft !== bAft) return aAft - bAft;
        // 3. Billigste pris pr. kg
        var aP = _ibPricePerKg(a) || 9999;
        var bP = _ibPricePerKg(b) || 9999;
        return aP - bP;
    });
}

/* ── Price helpers ─────────────────────────────────────────── */
function _ibPricePerKg(bc) {
    if (bc._hoka && bc._hoka.pricePerKg) return bc._hoka.pricePerKg;
    var price = parseFloat(bc.last_price);
    var packKg = _ibPackSizeKg(bc);
    if (price && packKg) return Math.round((price / packKg) * 10) / 10;
    return null;
}

function _ibPackSizeKg(bc) {
    if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
        return bc._hoka.salesUnits[0].quantity || 1;
    }
    if (bc.userfields && bc.userfields.pack_size_stock_unit) {
        return parseFloat(bc.userfields.pack_size_stock_unit) || 1;
    }
    return 1;
}

function _ibCalcQty(needKg, bc) {
    if (!bc) return 1;
    var packKg = _ibPackSizeKg(bc);
    return Math.max(1, Math.ceil(needKg / packKg));
}

function _ibPackPrice(bc, qty) {
    if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
        var su = bc._hoka.salesUnits[0];
        return (su.price || 0) * (qty || 1);
    }
    var price = parseFloat(bc.last_price) || 0;
    return price * (qty || 1);
}

function _ibChipLabel(bc) {
    if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
        var su = bc._hoka.salesUnits[0];
        return su.name || su.code || bc.note || bc.barcode;
    }
    return bc.note || bc.barcode;
}

/* ── Render ────────────────────────────────────────────────── */
function _ibShowLoading() {
    _ibContainer.innerHTML = '<div class="ib-loading"><div class="ib-loading-spinner"></div><div>Indlæser indkøbsliste...</div></div>';
}

function _ibRender() {
    var html = '';

    // Toolbar
    html += _ibRenderToolbar();

    // Panels (Manglende / Udløbende)
    html += _ibRenderPanels();

    // Content
    html += '<div class="ib-content">';

    var groupKeys = Object.keys(_ibGroups);
    if (groupKeys.length === 0 && _ibShoppingList.length === 0) {
        html += '<div class="ib-empty"><div class="ib-empty-icon">🛒</div>'
            + '<div class="ib-empty-title">Indkøbslisten er tom</div>'
            + '<div class="ib-empty-sub">Tilføj varer via Manglende-panelet eller "+ Tilføj vare"</div></div>';
    }

    // Sort groups: api first, then email/manual/webshop, then intern, then none
    var typeOrder = { api: 0, email: 1, webshop: 1, manual: 2, intern: 3, none: 4 };
    groupKeys.sort(function(a, b) {
        var ga = _ibGroups[a], gb = _ibGroups[b];
        var oa = ga.integrationType in typeOrder ? typeOrder[ga.integrationType] : 4;
        var ob = gb.integrationType in typeOrder ? typeOrder[gb.integrationType] : 4;
        if (oa !== ob) return oa - ob;
        return (ga.displayName || '').localeCompare(gb.displayName || '', 'da');
    });

    for (var gi = 0; gi < groupKeys.length; gi++) {
        html += _ibRenderGroup(groupKeys[gi]);
    }

    html += '</div>'; // .ib-content

    // Bottom bar
    html += _ibRenderBottomBar();

    // Preserve scroll position during re-render
    var scrollY = window.scrollY;
    _ibContainer.innerHTML = html;
    window.scrollTo(0, scrollY);

    // Bind link result buttons (dynamic, can't use delegation)
    _ibContainer.querySelectorAll('[data-ib="lp-results"] [data-ib="lp-link"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var varenr = this.getAttribute('data-varenr');
            var name = this.getAttribute('data-name');
            var pid = this.closest('[data-lp-product]').getAttribute('data-lp-product');
            _ibLinkBarcode(parseInt(pid), varenr, name);
        });
    });
}

function _ibRenderToolbar() {
    var missingN = _ibMissingProducts.length;
    var dueN = _ibDueProducts.length;

    var h = '<div class="ib-toolbar">';
    h += '<input class="ib-search" placeholder="Søg vare..." data-ib="search" value="' + _ibEsc(_ibSearchTerm) + '">';
    h += '<div class="ib-sep"></div>';
    h += '<button class="ib-btn primary" data-ib="add-product">+ Tilføj vare</button>';
    h += '<button class="ib-btn" data-ib="toggle-missing">📉 Manglende ';
    h += missingN ? '<span class="ib-nb ib-nb-or">' + missingN + '</span>' : '';
    h += '</button>';
    h += '<button class="ib-btn" data-ib="toggle-expiring">⏰ Udløbende ';
    h += dueN ? '<span class="ib-nb ib-nb-rd">' + dueN + '</span>' : '';
    h += '</button>';
    h += '<div class="ib-right">';
    if (_ibFocusMode) {
        h += '<button class="ib-focus-back" style="display:flex" data-ib="focus-back">‹ Alle leverandører</button>';
    }
    h += '<div class="ib-view-toggle">';
    h += '<button class="ib-vt' + (!_ibFocusMode ? ' on' : '') + '" data-ib="view-list">≡ Liste</button>';
    h += '<button class="ib-vt' + (_ibFocusMode ? ' on' : '') + '" data-ib="view-focus">⊡ Fokus</button>';
    h += '</div></div></div>';
    return h;
}

function _ibRenderPanels() {
    var h = '';

    // Missing
    if (_ibMissingProducts.length > 0) {
        var mo = _ibPanelOpen === 'missing';
        h += '<div class="ib-banner" data-ib="banner-missing">';
        h += '<div class="ib-banner-icon">📉</div>';
        h += '<div class="ib-banner-text"><div class="ib-banner-title">' + _ibMissingProducts.length + ' varer under minimumsgrænse</div>';
        h += '<div class="ib-banner-sub">Klik for at se forslag og tilføje til indkøbslisten</div></div>';
        h += '<div class="ib-banner-pill">' + _ibMissingProducts.length + ' forslag</div>';
        h += '<div class="ib-banner-chev' + (mo ? ' open' : '') + '">›</div></div>';

        h += '<div class="ib-panel' + (mo ? ' open' : '') + '" data-ib-panel="missing">';
        h += '<div class="ib-panel-inner">';
        for (var m = 0; m < _ibMissingProducts.length; m++) {
            var mp = _ibMissingProducts[m];
            var prod = mp.product || {};
            var minStock = parseFloat(prod.min_stock_amount) || 0;
            var curStock = parseFloat(mp.amount_missing) || (minStock - (parseFloat(mp.amount) || 0));
            var suggest = Math.max(1, Math.ceil(minStock - (parseFloat(mp.amount) || 0)));
            var locName = _ibLocations[prod.shopping_location_id] ? _ibLocations[prod.shopping_location_id].name : '';

            h += '<div class="ib-panel-item">';
            h += '<input type="checkbox" class="ib-panel-chk" checked data-product-id="' + prod.id + '">';
            h += '<div class="ib-panel-info"><div class="ib-panel-name">' + _ibEsc(prod.name) + '</div>';
            h += '<div class="ib-panel-meta">Min: ' + minStock + ' · Lager: ' + (parseFloat(mp.amount) || 0);
            if (locName) h += ' · ' + _ibEsc(locName);
            h += '</div></div>';
            h += '<div class="ib-panel-qc">';
            h += '<button class="ib-panel-qb" data-ib="panel-minus" data-idx="' + m + '">−</button>';
            h += '<input class="ib-panel-qi" type="number" value="' + suggest + '" min="1" data-idx="' + m + '">';
            h += '<button class="ib-panel-qb" data-ib="panel-plus" data-idx="' + m + '">+</button>';
            h += '</div></div>';
        }
        h += '</div>';
        h += '<div class="ib-panel-foot">';
        h += '<span class="ib-panel-selall" data-ib="selall-missing">Vælg alle</span>';
        h += '<button class="ib-panel-cancel" data-ib="close-missing">Luk</button>';
        h += '<button class="ib-panel-add" data-ib="add-missing">Tilføj valgte til listen</button>';
        h += '</div></div>';
    }

    // Due / Expiring
    if (_ibDueProducts.length > 0) {
        var eo = _ibPanelOpen === 'expiring';
        h += '<div class="ib-banner udl" data-ib="banner-expiring">';
        h += '<div class="ib-banner-icon">⏰</div>';
        h += '<div class="ib-banner-text"><div class="ib-banner-title">' + _ibDueProducts.length + ' varer udløber snart</div>';
        h += '<div class="ib-banner-sub">Klik for at tilføje til indkøbslisten</div></div>';
        h += '<div class="ib-banner-pill rd">' + _ibDueProducts.length + ' varer</div>';
        h += '<div class="ib-banner-chev' + (eo ? ' open' : '') + '">›</div></div>';

        h += '<div class="ib-panel udl' + (eo ? ' open' : '') + '" data-ib-panel="expiring">';
        h += '<div class="ib-panel-inner">';
        for (var d = 0; d < _ibDueProducts.length; d++) {
            var dp = _ibDueProducts[d];
            var dprod = dp.product || {};
            h += '<div class="ib-panel-item">';
            h += '<input type="checkbox" class="ib-panel-chk" checked data-product-id="' + dprod.id + '">';
            h += '<div class="ib-panel-info"><div class="ib-panel-name">' + _ibEsc(dprod.name) + '</div>';
            h += '<div class="ib-panel-meta">Udløber: ' + (dp.best_before_date || '?') + ' · ' + (parseFloat(dp.amount) || 0) + '</div></div>';
            h += '<div class="ib-panel-qc">';
            h += '<button class="ib-panel-qb" data-ib="panel-minus" data-idx="' + d + '">−</button>';
            h += '<input class="ib-panel-qi" type="number" value="' + Math.max(1, Math.ceil(parseFloat(dp.amount) || 1)) + '" min="1" data-idx="' + d + '">';
            h += '<button class="ib-panel-qb" data-ib="panel-plus" data-idx="' + d + '">+</button>';
            h += '</div></div>';
        }
        h += '</div>';
        h += '<div class="ib-panel-foot">';
        h += '<span class="ib-panel-selall" data-ib="selall-expiring">Vælg alle</span>';
        h += '<button class="ib-panel-cancel" data-ib="close-expiring">Luk</button>';
        h += '<button class="ib-panel-add rd" data-ib="add-expiring">Tilføj valgte til listen</button>';
        h += '</div></div>';
    }

    return h;
}

function _ibRenderPanelBadges() {
    // Update badge counts in toolbar without full re-render
    var misBtn = _ibContainer.querySelector('[data-ib="toggle-missing"]');
    if (misBtn) {
        var nb = misBtn.querySelector('.ib-nb');
        if (nb) nb.textContent = _ibMissingProducts.length;
        else if (_ibMissingProducts.length) {
            var span = document.createElement('span');
            span.className = 'ib-nb ib-nb-or';
            span.textContent = _ibMissingProducts.length;
            misBtn.appendChild(span);
        }
    }
    var expBtn = _ibContainer.querySelector('[data-ib="toggle-expiring"]');
    if (expBtn) {
        var nb2 = expBtn.querySelector('.ib-nb');
        if (nb2) nb2.textContent = _ibDueProducts.length;
        else if (_ibDueProducts.length) {
            var span2 = document.createElement('span');
            span2.className = 'ib-nb ib-nb-rd';
            span2.textContent = _ibDueProducts.length;
            expBtn.appendChild(span2);
        }
    }
    // Note: panels render on first open, not here — avoids scroll-jump
}

/* ── Group render ──────────────────────────────────────────── */
function _ibRenderGroup(key) {
    var g = _ibGroups[key];
    var isOpen = !!_ibOpenGroups[key];
    var hidden = _ibFocusMode && _ibFocusGroup !== key;

    // Filter by search
    var allItems = g.items;
    if (_ibSearchTerm) {
        var q = _ibSearchTerm.toLowerCase();
        allItems = allItems.filter(function(e) {
            return (e.product.name || '').toLowerCase().indexOf(q) >= 0;
        });
        if (allItems.length === 0) return '';
    }

    var readyItems = allItems.filter(function(e) { return !e.isOrdered && e.matched; });
    var unmatchedItems = allItems.filter(function(e) { return !e.isOrdered && !e.matched; });
    var orderedItems = allItems.filter(function(e) { return e.isOrdered; });

    // Count and estimate
    var estTotal = 0;
    for (var r = 0; r < readyItems.length; r++) {
        estTotal += _ibPackPrice(readyItems[r].selectedBarcode, readyItems[r].qty);
    }

    // Icon
    var icoClass = g.integrationType || 'manual';
    var icoLabel = g.displayName.substring(0, 2).toUpperCase();

    var h = '<div class="ib-group' + (hidden ? ' style="display:none"' : '') + (_ibFocusMode && _ibFocusGroup === key ? ' ib-focused' : '') + '" data-group="' + key + '">';

    // Header
    h += '<div class="ib-group-hdr" data-ib="group-toggle" data-group="' + key + '">';
    h += '<div class="ib-group-ico ' + icoClass + '">' + icoLabel + '</div>';
    h += '<div class="ib-group-inf"><div class="ib-group-name">' + _ibEsc(g.displayName) + '</div>';
    if (g.notes) h += '<div class="ib-group-note">' + _ibEsc(g.notes) + '</div>';
    h += '</div>';

    // Pills
    h += '<div class="ib-group-pills">';
    if (readyItems.length) h += '<span class="ib-sgp kl">' + readyItems.length + ' klar</span>';
    if (unmatchedItems.length) h += '<span class="ib-sgp um">' + unmatchedItems.length + ' umatched</span>';
    if (orderedItems.length) h += '<span class="ib-sgp bs">' + orderedItems.length + ' bestilt</span>';
    if (estTotal > 0) h += '<span class="ib-sgp es">ca. ' + Math.round(estTotal) + ' kr</span>';
    h += '</div>';

    // Action button
    h += _ibRenderGroupAction(g, key);

    h += '<div class="ib-group-chev' + (isOpen ? ' open' : '') + '">›</div>';
    h += '</div>'; // header

    // Body
    h += '<div class="ib-group-body' + (isOpen ? ' open' : '') + '" data-group-body="' + key + '">';

    // Ready items
    if (readyItems.length) {
        h += '<div class="ib-shdr">Klar til bestilling — ' + readyItems.length + ' varer</div>';
        for (var ri = 0; ri < readyItems.length; ri++) {
            h += _ibRenderItem(readyItems[ri], g);
        }
    }

    // Unmatched
    if (unmatchedItems.length) {
        h += '<div class="ib-shdr">Ingen barcode hos ' + _ibEsc(g.displayName) + ' — ' + unmatchedItems.length + ' varer</div>';
        for (var ui = 0; ui < unmatchedItems.length; ui++) {
            h += _ibRenderItem(unmatchedItems[ui], g);
        }
    }

    // Ordered (collapsed)
    if (orderedItems.length) {
        var showOrd = !!_ibShowOrdered[key];
        h += '<div class="ib-bs-tog" data-ib="toggle-ordered" data-group="' + key + '">';
        h += '<span class="ib-bs-chev' + (showOrd ? ' open' : '') + '">›</span>';
        h += '<span>' + orderedItems.length + ' vare' + (orderedItems.length !== 1 ? 'r' : '') + ' bestilt — ' + (showOrd ? 'skjul' : 'vis') + '</span>';
        h += '</div>';
        h += '<div class="ib-bs-section' + (showOrd ? ' open' : '') + '">';
        h += '<div class="ib-shdr">Bestilt</div>';
        for (var oi = 0; oi < orderedItems.length; oi++) {
            h += _ibRenderOrderedItem(orderedItems[oi]);
        }
        h += '</div>';
    }

    h += '</div>'; // body

    // Manual order dialog
    if (g.integrationType === 'email' || g.integrationType === 'manual') {
        h += _ibRenderManualDialog(g, key, readyItems);
    }

    // Production dialog
    if (g.integrationType === 'intern') {
        h += _ibRenderProdDialog(g, key, readyItems);
    }

    h += '</div>'; // .ib-group
    return h;
}

function _ibRenderGroupAction(g, key) {
    if (g.integrationType === 'api') {
        return '<button class="ib-group-act hoka" data-ib="goto-cart" data-group="' + key + '">Gå til kurv →</button>';
    }
    if (g.integrationType === 'email' || g.integrationType === 'manual') {
        return '<button class="ib-group-act reg" data-ib="register-order" data-group="' + key + '">Registrér bestilling</button>';
    }
    if (g.integrationType === 'webshop') {
        return '<button class="ib-group-act web" data-ib="open-webshop" data-group="' + key + '">Åbn webshop →</button>';
    }
    if (g.integrationType === 'intern') {
        return '<button class="ib-group-act prod" data-ib="create-prod-bon" data-group="' + key + '">Opret produktionsbon →</button>';
    }
    return '';
}

/* ── Item render ───────────────────────────────────────────── */
function _ibRenderItem(entry, group) {
    var p = entry.product;
    var h = '<div class="ib-item" data-product-id="' + p.id + '">';
    h += '<div class="ib-item-main">';

    // Image
    h += '<div class="ib-item-img">';
    if (entry.selectedBarcode && entry.selectedBarcode._hoka && entry.selectedBarcode._hoka.image) {
        h += '<img src="' + _ibEsc(entry.selectedBarcode._hoka.image) + '" onerror="this.parentElement.textContent=\'📦\'">';
    } else {
        h += '📦';
    }
    h += '</div>';

    // Body
    h += '<div class="ib-item-body">';
    h += '<div class="ib-item-top">';
    h += '<span class="ib-item-name">' + _ibEsc(p.name) + '</span>';
    h += '<span class="ib-item-need">Behov: <strong>' + _ibFmtNum(entry.need) + ' ' + _ibEsc(entry.needUnit) + '</strong></span>';
    h += '</div>';

    // Chips
    if (entry.matched && entry.barcodes.length > 0) {
        h += '<div class="ib-chips">';
        for (var c = 0; c < entry.barcodes.length; c++) {
            var bc = entry.barcodes[c];
            var isOn = c === entry.selectedBcIdx;
            var uf = bc.userfields || {};

            h += '<div class="ib-chip' + (isOn ? ' on' : '') + '" data-ib="select-chip" data-product-id="' + p.id + '" data-bc-idx="' + c + '">';
            h += '<div class="ib-cp-top">';
            if (uf.is_preferred === '1') h += '<span class="ib-cp-fav">Foretrukket</span>';
            if (uf.is_agreement_item === '1' || (bc._hoka && bc._hoka.isAgreementItem)) h += '<span class="ib-cp-aftale">Aftale</span>';
            h += '</div>';
            h += '<div class="ib-cp-name">' + _ibEsc(_ibChipLabel(bc)) + '</div>';

            // Price line
            var priceKg = _ibPricePerKg(bc);
            var unitPrice = bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits[0] ? bc._hoka.salesUnits[0].price : parseFloat(bc.last_price);
            var priceParts = [];
            if (unitPrice) priceParts.push(_ibFmtNum(unitPrice) + ' kr');
            if (priceKg) priceParts.push(_ibFmtNum(priceKg) + ' kr/kg');
            priceParts.push('Nr. ' + bc.barcode);
            h += '<div class="ib-cp-price">' + priceParts.join(' · ') + '</div>';

            // Supplier meta (delivery info etc)
            var locName = _ibLocations[bc.shopping_location_id] ? _ibLocations[bc.shopping_location_id].name : '';
            if (locName && entry.barcodes.length > 1) {
                h += '<div class="ib-cp-meta">' + _ibEsc(locName) + '</div>';
            }

            h += '</div>';
        }
        h += '</div>';

        // Calc line
        var totalKg = _ibPackSizeKg(entry.selectedBarcode) * entry.qty;
        var covClass = totalKg >= entry.need ? 'ok' : 'under';
        if (totalKg > entry.need * 1.5) covClass = 'over';
        h += '<div class="ib-calc"><span class="' + covClass + '">= ' + _ibFmtNum(totalKg) + ' ' + _ibEsc(entry.needUnit) + '</span>';
        h += ' · dækker ' + _ibFmtNum(entry.need) + ' ' + _ibEsc(entry.needUnit) + ' behov';
        var selPriceKg = _ibPricePerKg(entry.selectedBarcode);
        if (selPriceKg) h += ' · <span style="color:var(--brand-primary);font-weight:700">' + _ibFmtNum(selPriceKg) + ' kr/kg valgt</span>';
        h += '</div>';

        // Badges
        var badges = _ibGetBadges(entry);
        if (badges.length) {
            h += '<div class="ib-badges">';
            for (var bi = 0; bi < badges.length; bi++) h += badges[bi];
            h += '</div>';
        }
    } else {
        // Unmatched
        h += '<div class="ib-badges"><span style="font-size:11px;color:var(--color-text-dim)">Mangler barcode</span></div>';
    }

    h += '</div>'; // body

    // Controls
    h += '<div class="ib-item-ctrl">';
    if (entry.matched) {
        h += '<button class="ib-qb" data-ib="qty-minus" data-product-id="' + p.id + '">−</button>';
        h += '<input class="ib-qi" type="number" min="0" value="' + entry.qty + '" data-ib="qty-input" data-product-id="' + p.id + '">';
        h += '<button class="ib-qb" data-ib="qty-plus" data-product-id="' + p.id + '">+</button>';

        if (group.integrationType === 'api') {
            if (entry.inCart) {
                h += '<button class="ib-kb done">I kurv ✓</button>';
            } else {
                h += '<button class="ib-kb" data-ib="add-to-cart" data-product-id="' + p.id + '">Læg i kurv</button>';
            }
        } else if (group.integrationType === 'intern') {
            h += '<button class="ib-kb bon" data-ib="create-single-bon" data-product-id="' + p.id + '">Opret bon →</button>';
        } else {
            if (entry._marked) {
                h += '<button class="ib-kb done">Valgt ✓</button>';
            } else {
                h += '<button class="ib-kb mark" data-ib="mark-selected" data-product-id="' + p.id + '">Marker valgt</button>';
            }
        }
    } else {
        h += '<button class="ib-kb kobl" data-ib="open-link" data-product-id="' + p.id + '">Kobl varenr.</button>';
        h += '<button class="ib-kb" data-ib="skip-item" data-product-id="' + p.id + '">Spring over</button>';
    }
    h += '</div>'; // ctrl

    h += '</div>'; // main

    // Link panel (if open)
    if (_ibLinkPanelId === p.id) {
        h += _ibRenderLinkPanel(entry);
    }

    h += '</div>'; // item
    return h;
}

function _ibRenderOrderedItem(entry) {
    var p = entry.product;
    var uf = entry.item.userfields || {};
    var h = '<div class="ib-item done">';
    h += '<div class="ib-item-main">';
    h += '<div class="ib-item-img">📦</div>';
    h += '<div class="ib-item-body">';
    h += '<div class="ib-item-top"><span class="ib-item-name">' + _ibEsc(p.name) + '</span></div>';
    h += '<div class="ib-badges"><span class="ib-badge best">Bestilt';
    if (uf.ordered_at) h += ' ' + _ibFmtDate(uf.ordered_at);
    if (uf.ordered_qty) h += ' · ' + uf.ordered_qty;
    if (uf.ordered_varenr) h += ' · Nr. ' + uf.ordered_varenr;
    h += '</span></div>';
    h += '</div>';
    h += '<div class="ib-item-ctrl">';
    h += '<button class="ib-kb" style="font-size:11px;color:var(--color-text-dim)" data-ib="undo-order" data-product-id="' + p.id + '">Fortryd</button>';
    h += '</div></div></div>';
    return h;
}

function _ibGetBadges(entry) {
    var badges = [];
    var bc = entry.selectedBarcode;
    if (!bc) return badges;
    var hoka = bc._hoka;
    if (hoka) {
        if (hoka.isOrganic || (bc.userfields && bc.userfields.hk_organic === '1')) {
            badges.push('<span class="ib-badge oko">🌿 Øko</span>');
        }
        if (hoka.countryCode === 'DK' || (bc.userfields && bc.userfields.hk_country === 'DK')) {
            badges.push('<span class="ib-badge land">🇩🇰 DK</span>');
        }
    }
    return badges;
}

/* ── Link panel ────────────────────────────────────────────── */
function _ibRenderLinkPanel(entry) {
    var h = '<div class="ib-lp" data-lp-product="' + entry.product.id + '">';
    h += '<div class="ib-lp-note">Indtast varenr. fra <a href="https://www.hoka.dk" target="_blank">hoka.dk</a>, eller søg:</div>';
    h += '<div class="ib-lp-row">';
    h += '<input class="ib-lp-inp" placeholder="Varenr. eller søg produktnavn..." data-ib="lp-input" data-product-id="' + entry.product.id + '" value="' + _ibEsc(entry.product.name || '') + '">';
    h += '<button class="ib-lp-btn" data-ib="lp-search" data-product-id="' + entry.product.id + '">Søg</button>';
    h += '</div>';
    h += '<div data-ib="lp-results" data-product-id="' + entry.product.id + '"></div>';
    h += '</div>';
    return h;
}

/* ── Manual order dialog ───────────────────────────────────── */
function _ibRenderManualDialog(g, key, readyItems) {
    var isOpen = _ibMoOpen === key;
    var markedItems = readyItems.filter(function(e) { return e._marked; });
    var itemsToShow = markedItems.length ? markedItems : readyItems;

    var h = '<div class="ib-mo-dlg' + (isOpen ? ' open' : '') + '" data-mo-group="' + key + '">';
    h += '<div class="ib-mo-title">Registrér bestilling — ' + _ibEsc(g.displayName) + '</div>';
    h += '<div class="ib-mo-list">';
    for (var i = 0; i < itemsToShow.length; i++) {
        var e = itemsToShow[i];
        var bcNote = e.selectedBarcode ? ('Nr. ' + e.selectedBarcode.barcode) : '';
        h += '<div class="ib-mo-item"><span class="ib-mo-iname">' + _ibEsc(e.product.name) + '</span>';
        h += '<span class="ib-mo-iqty">' + e.qty + ' ' + _ibEsc(e.needUnit) + (bcNote ? ' · ' + bcNote : '') + '</span></div>';
    }
    h += '</div>';
    h += '<div class="ib-mo-acts">';
    h += '<button class="ib-mo-btn ib-mo-copy" data-ib="mo-copy" data-group="' + key + '">📋 Kopiér liste</button>';
    if (g.contactEmail) h += '<button class="ib-mo-btn ib-mo-mail" data-ib="mo-mail" data-group="' + key + '">✉ Send mail</button>';
    if (g.contactPhone) h += '<button class="ib-mo-btn ib-mo-tlf" data-ib="mo-phone" data-group="' + key + '">📞 Ring ' + _ibEsc(g.displayName) + '</button>';
    h += '<button class="ib-mo-btn ib-mo-ok" data-ib="mo-confirm" data-group="' + key + '">✓ Bekræft bestilt</button>';
    h += '</div></div>';
    return h;
}

/* ── Production dialog ─────────────────────────────────────── */
function _ibRenderProdDialog(g, key, readyItems) {
    var isOpen = _ibMoOpen === key;
    var h = '<div class="ib-prod-dlg' + (isOpen ? ' open' : '') + '" data-prod-group="' + key + '">';
    h += '<div class="ib-prod-title">Opret produktionsbon — ' + _ibEsc(g.displayName) + '</div>';
    h += '<div class="ib-prod-info">' + readyItems.length + ' interne produktioner mangler.<br>';
    h += 'Der oprettes én bon per produkt med tilknyttet opskrift fra Grocy.</div>';
    h += '<div class="ib-prod-acts">';
    h += '<button class="ib-prod-btn ib-prod-create" data-ib="prod-create" data-group="' + key + '">Opret ' + readyItems.length + ' produktionsbons</button>';
    h += '<button class="ib-prod-btn ib-prod-check" data-ib="prod-check" data-group="' + key + '">Tjek råvarer først →</button>';
    h += '</div></div>';
    return h;
}

/* ── Bottom bar ────────────────────────────────────────────── */
function _ibRenderBottomBar() {
    var totalItems = _ibShoppingList.length;
    var cartCount = _ibCartItems.length;
    var markedCount = 0;
    for (var gk in _ibGroups) {
        var g = _ibGroups[gk];
        for (var i = 0; i < g.items.length; i++) {
            if (g.items[i]._marked) markedCount++;
        }
    }

    var h = '<div class="ib-bottom">';
    h += '<div class="ib-bb-stat"><strong>' + totalItems + ' varer</strong> på listen';
    if (cartCount) h += ' · <strong>' + cartCount + '</strong> i Hørkrams kurv';
    if (markedCount) h += ' · <strong>' + markedCount + '</strong> valgt til bestilling';
    h += '</div>';
    h += '</div>';
    return h;
}

/* ── Event handling (delegation) ────────────────────────────── */
function _ibHandleClick(e) {
    var btn = e.target.closest('[data-ib]');

    // If click landed on a gap (e.g. inside .ib-item-ctrl but not on a button),
    // check if the target is a known container and find the nearest action button
    if (!btn && e.target.closest('.ib-item-ctrl')) {
        // Find the last button in ctrl (the action button)
        var ctrl = e.target.closest('.ib-item-ctrl');
        var actionBtn = ctrl.querySelector('[data-ib]:last-of-type') || ctrl.querySelector('.ib-kb[data-ib]');
        if (actionBtn) btn = actionBtn;
    }

    if (!btn) return;
    var action = btn.getAttribute('data-ib');
    var productId = btn.getAttribute('data-product-id') || btn.closest('[data-product-id]')?.getAttribute('data-product-id');
    var group = btn.getAttribute('data-group') || btn.closest('[data-group]')?.getAttribute('data-group');

    switch (action) {
        case 'group-toggle':
            // Ignore if click came from an action button inside the header
            if (e.target.closest('.ib-group-act')) break;
            _ibOpenGroups[group] = !_ibOpenGroups[group];
            if (_ibFocusMode) { _ibFocusGroup = group; }
            _ibRender();
            break;

        case 'toggle-ordered':
            _ibShowOrdered[group] = !_ibShowOrdered[group];
            _ibRender();
            break;

        case 'toggle-missing':
            _ibPanelOpen = _ibPanelOpen === 'missing' ? null : 'missing';
            _ibRender();
            break;

        case 'toggle-expiring':
            _ibPanelOpen = _ibPanelOpen === 'expiring' ? null : 'expiring';
            _ibRender();
            break;

        case 'banner-missing':
            _ibPanelOpen = _ibPanelOpen === 'missing' ? null : 'missing';
            _ibRender();
            break;

        case 'banner-expiring':
            _ibPanelOpen = _ibPanelOpen === 'expiring' ? null : 'expiring';
            _ibRender();
            break;

        case 'close-missing':
            _ibPanelOpen = null;
            _ibRender();
            break;

        case 'close-expiring':
            _ibPanelOpen = null;
            _ibRender();
            break;

        case 'add-missing':
            _ibAddFromPanel('missing');
            break;

        case 'add-expiring':
            _ibAddFromPanel('expiring');
            break;

        case 'selall-missing':
        case 'selall-expiring':
            var panel = _ibContainer.querySelector('[data-ib-panel="' + (action.indexOf('missing') >= 0 ? 'missing' : 'expiring') + '"]');
            if (panel) {
                panel.querySelectorAll('.ib-panel-chk').forEach(function(chk) { chk.checked = true; });
            }
            break;

        case 'select-chip':
            _ibSelectChip(productId, parseInt(btn.getAttribute('data-bc-idx')));
            break;

        case 'qty-minus':
            _ibChangeQty(productId, -1);
            break;

        case 'qty-plus':
            _ibChangeQty(productId, 1);
            break;

        case 'add-to-cart':
            _ibAddToCart(productId);
            break;

        case 'mark-selected':
            _ibMarkSelected(productId);
            break;

        case 'open-link':
            _ibLinkPanelId = _ibLinkPanelId === parseInt(productId) ? null : parseInt(productId);
            _ibRender();
            break;

        case 'skip-item':
            e.target.closest('.ib-item').style.opacity = '0.3';
            break;

        case 'lp-search':
            _ibLinkSearch(parseInt(productId));
            break;

        case 'undo-order':
            _ibUndoOrder(productId);
            break;

        case 'goto-cart':
            _ibGotoCart(group);
            break;

        case 'register-order':
            _ibMoOpen = _ibMoOpen === group ? null : group;
            _ibRender();
            break;

        case 'create-prod-bon':
            _ibMoOpen = _ibMoOpen === group ? null : group;
            _ibRender();
            break;

        case 'open-webshop':
            var g = _ibGroups[group];
            if (g && g.webshopUrl) window.open(g.webshopUrl, '_blank');
            break;

        case 'mo-copy':
            _ibCopyOrderList(group);
            break;

        case 'mo-mail':
            _ibMailOrder(group);
            break;

        case 'mo-phone':
            var grp = _ibGroups[group];
            if (grp && grp.contactPhone) window.open('tel:' + grp.contactPhone);
            break;

        case 'mo-confirm':
            _ibConfirmManualOrder(group);
            break;

        case 'prod-create':
            _ibToast('Produktionsbons — kommer snart');
            break;

        case 'prod-check':
            _ibToast('Råvarekontrol — kommer snart');
            break;

        case 'view-list':
            _ibFocusMode = false;
            _ibFocusGroup = null;
            _ibRender();
            break;

        case 'view-focus':
            _ibFocusMode = true;
            _ibToast('Fokus-mode — klik en leverandørgruppe');
            _ibRender();
            break;

        case 'focus-back':
            _ibFocusMode = false;
            _ibFocusGroup = null;
            _ibRender();
            break;

        case 'add-product':
            _ibToast('Tilføj vare — kommer snart');
            break;
    }
}

function _ibHandleInput(e) {
    var el = e.target;
    if (el.getAttribute('data-ib') === 'search') {
        _ibSearchTerm = el.value;
        clearTimeout(el._debounce);
        el._debounce = setTimeout(function() { _ibRender(); }, 250);
        return;
    }
    if (el.getAttribute('data-ib') === 'qty-input') {
        var pid = el.getAttribute('data-product-id');
        var entry = _ibFindEntry(pid);
        if (entry) {
            entry.qty = Math.max(0, parseInt(el.value) || 0);
        }
    }
}

/* ── Actions ───────────────────────────────────────────────── */
function _ibSelectChip(productId, bcIdx) {
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    entry.selectedBcIdx = bcIdx;
    entry.selectedBarcode = entry.barcodes[bcIdx] || null;
    entry.qty = _ibCalcQty(entry.need, entry.selectedBarcode);
    _ibRender();
}

function _ibChangeQty(productId, delta) {
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    entry.qty = Math.max(0, entry.qty + delta);
    _ibRender();
}

function _ibMarkSelected(productId) {
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    entry._marked = true;
    _ibRender();
}

async function _ibAddToCart(productId) {
    var entry = _ibFindEntry(productId);
    if (!entry || !entry.selectedBarcode) return;
    if (_ibBusy) { console.warn('[indkob] addToCart blocked — busy'); return; }

    var bc = entry.selectedBarcode;
    _ibBusy = true;

    try {
        var suCode = (bc.userfields && bc.userfields.supplier_unit_code) || 'ks';
        var suQty = parseFloat((bc.userfields && bc.userfields.supplier_unit_qty) || '1') || 1;

        // Use salesUnits from hoka if available
        if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
            suCode = bc._hoka.salesUnits[0].code || suCode;
            suQty = bc._hoka.salesUnits[0].quantity || suQty;
        }

        await putHokaBasket([{
            varenummer: bc.barcode,
            quantity: entry.qty,
            salesUnitCode: suCode,
            salesUnitQuantity: suQty,
        }]);

        entry.inCart = true;
        _ibCartItems.push(entry);
        _ibToast('Lagt i kurv: ' + entry.product.name);
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke lægge i kurv'), true);
    } finally {
        _ibBusy = false;
    }
}

async function _ibGotoCart(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g) return;

    // Collect cart items for this group
    var cartForGroup = _ibCartItems.filter(function(e) {
        return _ibFindGroupForEntry(e) === groupKey;
    });

    if (cartForGroup.length === 0) {
        _ibToast('Ingen varer i kurven for ' + g.displayName);
        return;
    }

    _ibBusy = true;

    try {
        // Create purchase order
        var lines = cartForGroup.map(function(e) {
            return {
                product_id: e.product.id,
                product_name: e.product.name,
                quantity: e.qty,
                barcode: e.selectedBarcode ? e.selectedBarcode.barcode : null,
            };
        });

        await createPendingOrder({
            supplier_id: g.supplierId,
            grocy_location_id: parseInt(groupKey),
            lines: lines,
        });

        // Set ordered_* userfields in Grocy
        var now = new Date().toISOString();
        for (var i = 0; i < cartForGroup.length; i++) {
            var e = cartForGroup[i];
            for (var j = 0; j < e.allItems.length; j++) {
                try {
                    await updateShoppingListItem(e.allItems[j].id, {
                        userfields: {
                            ordered_at: now,
                            ordered_qty: String(e.qty),
                            ordered_supplier: g.displayName,
                            ordered_varenr: e.selectedBarcode ? e.selectedBarcode.barcode : '',
                        }
                    });
                } catch (ue) {
                    console.warn('[indkob] userfield update fejl:', ue.message);
                }
            }
        }

        // Open hoka.dk checkout
        window.open('https://www.hoka.dk/da-dk/checkout', '_blank');

        _ibToast('Bestilling registreret — åbner hoka.dk');

        // Reload
        await _ibReloadShoppingList();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke registrere'), true);
    } finally {
        _ibBusy = false;
    }
}

async function _ibConfirmManualOrder(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g || _ibBusy) return;

    var items = g.items.filter(function(e) { return !e.isOrdered && (e._marked || e.matched); });
    if (!items.length) {
        _ibToast('Ingen varer at bestille');
        return;
    }

    _ibBusy = true;

    try {
        var lines = items.map(function(e) {
            return {
                product_id: e.product.id,
                product_name: e.product.name,
                quantity: e.qty,
                barcode: e.selectedBarcode ? e.selectedBarcode.barcode : null,
            };
        });

        await createPendingOrder({
            supplier_id: g.supplierId,
            grocy_location_id: parseInt(groupKey) || null,
            lines: lines,
        });

        var now = new Date().toISOString();
        for (var i = 0; i < items.length; i++) {
            var e = items[i];
            for (var j = 0; j < e.allItems.length; j++) {
                try {
                    await updateShoppingListItem(e.allItems[j].id, {
                        userfields: {
                            ordered_at: now,
                            ordered_qty: String(e.qty),
                            ordered_supplier: g.displayName,
                            ordered_varenr: e.selectedBarcode ? e.selectedBarcode.barcode : '',
                        }
                    });
                } catch (ue) {
                    console.warn('[indkob] userfield update fejl:', ue.message);
                }
            }
        }

        _ibMoOpen = null;
        _ibToast('Bestilling registreret — ' + items.length + ' varer');
        await _ibReloadShoppingList();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke registrere'), true);
    } finally {
        _ibBusy = false;
    }
}

async function _ibUndoOrder(productId) {
    var entry = _ibFindEntry(productId);
    if (!entry || _ibBusy) return;

    _ibBusy = true;
    try {
        for (var i = 0; i < entry.allItems.length; i++) {
            await updateShoppingListItem(entry.allItems[i].id, {
                userfields: {
                    ordered_at: '',
                    ordered_qty: '',
                    ordered_supplier: '',
                    ordered_varenr: '',
                }
            });
        }
        _ibToast('Bestilling fortrudt: ' + entry.product.name);
        await _ibReloadShoppingList();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke fortryde'), true);
    } finally {
        _ibBusy = false;
    }
}

async function _ibAddFromPanel(type) {
    var panelEl = _ibContainer.querySelector('[data-ib-panel="' + (type === 'missing' ? 'missing' : 'expiring') + '"]');
    if (!panelEl) return;

    var items = type === 'missing' ? _ibMissingProducts : _ibDueProducts;
    var checks = panelEl.querySelectorAll('.ib-panel-chk');
    var inputs = panelEl.querySelectorAll('.ib-panel-qi');
    var added = 0;

    for (var i = 0; i < checks.length; i++) {
        if (!checks[i].checked) continue;
        var prodId = checks[i].getAttribute('data-product-id');
        var qty = parseFloat(inputs[i].value) || 1;

        try {
            await addShoppingListProduct(parseInt(prodId), qty);
            added++;
        } catch (err) {
            console.warn('[indkob] tilføj fejl:', err.message);
        }
    }

    if (added > 0) {
        _ibToast(added + ' vare' + (added !== 1 ? 'r' : '') + ' tilføjet til listen');
        _ibPanelOpen = null;
        await _ibReloadShoppingList();
        _ibLoadVolatile();
    }
}

function _ibCopyOrderList(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g) return;

    var items = g.items.filter(function(e) { return !e.isOrdered && (e._marked || e.matched); });
    var lines = items.map(function(e) {
        var bc = e.selectedBarcode;
        return e.product.name + '\t' + e.qty + ' ' + e.needUnit + (bc ? '\tNr. ' + bc.barcode : '');
    });

    var text = 'Bestilling — ' + g.displayName + '\n' + lines.join('\n');

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
            _ibToast('Kopieret til udklipsholder');
        });
    } else {
        _ibToast('Kunne ikke kopiere — brug HTTPS');
    }
}

function _ibMailOrder(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g || !g.contactEmail) return;

    var items = g.items.filter(function(e) { return !e.isOrdered && (e._marked || e.matched); });
    var body = items.map(function(e) {
        return e.product.name + ' — ' + e.qty + ' ' + e.needUnit;
    }).join('\n');

    window.open('mailto:' + g.contactEmail + '?subject=' + encodeURIComponent('Bestilling fra Ristet Rug') + '&body=' + encodeURIComponent(body));
}

/* ── Link/search panel ─────────────────────────────────────── */
async function _ibLinkSearch(productId) {
    var inp = _ibContainer.querySelector('[data-ib="lp-input"][data-product-id="' + productId + '"]');
    var resultsEl = _ibContainer.querySelector('[data-ib="lp-results"][data-product-id="' + productId + '"]');
    if (!inp || !resultsEl) return;

    var q = inp.value.trim();
    if (!q) return;

    resultsEl.innerHTML = '<div class="ib-lp-loading">Søger...</div>';

    // Search favorites first
    var favResults = [];
    if (_ibFavLoaded && _ibFavCache.length) {
        var qLower = q.toLowerCase();
        favResults = _ibFavCache.filter(function(f) {
            return (f.name || '').toLowerCase().indexOf(qLower) >= 0 || String(f.varenummer) === q;
        }).slice(0, 5);
    }

    // Search catalog
    var catalogResults = [];
    try {
        var data = await fetchHokaSearch(q);
        catalogResults = (data.results || []).slice(0, 5);
    } catch (e) {
        console.warn('[indkob] hoka search fejl:', e.message);
    }

    var html = '';

    if (favResults.length) {
        html += '<div class="ib-lp-note" style="margin-top:6px">Fra dine favoritter:</div>';
        for (var f = 0; f < favResults.length; f++) {
            html += _ibRenderLinkResult(favResults[f], productId, true);
        }
    }

    if (catalogResults.length) {
        html += '<div class="ib-lp-note" style="margin-top:6px">Øvrige resultater:</div>';
        for (var c = 0; c < catalogResults.length; c++) {
            html += _ibRenderLinkResult(catalogResults[c], productId, false);
        }
    }

    if (!favResults.length && !catalogResults.length) {
        html = '<div class="ib-lp-loading">Ingen resultater for "' + _ibEsc(q) + '"</div>';
    }

    resultsEl.innerHTML = html;

    // Bind link buttons (dynamic content, not in delegation)
    resultsEl.querySelectorAll('[data-ib="lp-link"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var varenr = this.getAttribute('data-varenr');
            var name = this.getAttribute('data-name');
            _ibLinkBarcode(productId, varenr, name);
        });
    });
}


function _ibRenderLinkResult(item, productId, isFav) {
    var h = '<div class="ib-lp-res">';
    h += '<div style="flex:1"><div class="ib-lp-rn">' + _ibEsc(item.name || '');
    if (isFav && item.isAgreementItem) h += ' <span style="color:var(--ib-green);font-size:10px">★ Aftale</span>';
    h += '</div>';
    h += '<div class="ib-lp-rm">Nr. ' + (item.varenummer || item.id || '?') + '</div></div>';
    if (item.pricePerKg) h += '<span class="ib-lp-rp">' + _ibFmtNum(item.pricePerKg) + ' kr/kg</span>';
    h += '<button class="ib-lp-rk" data-ib="lp-link" data-varenr="' + (item.varenummer || item.id || '') + '" data-name="' + _ibEsc(item.name || '') + '">+ Kobl</button>';
    h += '</div>';
    return h;
}

async function _ibLinkBarcode(productId, varenr, name) {
    if (_ibBusy) return;
    _ibBusy = true;

    try {
        // Determine shopping_location_id from group
        var entry = _ibFindEntry(productId);
        var groupKey = _ibFindGroupForEntry(entry);
        var locId = parseInt(groupKey) || null;

        await createProductBarcode({
            product_id: parseInt(productId),
            barcode: String(varenr),
            shopping_location_id: locId,
            note: name,
        });

        _ibLinkPanelId = null;
        _ibToast('Barcode koblet: ' + name);

        // Refresh
        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke koble'), true);
    } finally {
        _ibBusy = false;
    }
}

/* ── Helpers ───────────────────────────────────────────────── */
function _ibFindEntry(productId) {
    productId = parseInt(productId);
    for (var gk in _ibGroups) {
        var g = _ibGroups[gk];
        for (var i = 0; i < g.items.length; i++) {
            if (g.items[i].product.id === productId) return g.items[i];
        }
    }
    return null;
}

function _ibFindGroupForEntry(entry) {
    if (!entry) return null;
    for (var gk in _ibGroups) {
        var g = _ibGroups[gk];
        for (var i = 0; i < g.items.length; i++) {
            if (g.items[i] === entry) return gk;
        }
    }
    return null;
}

function _ibEsc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _ibFmtNum(n) {
    if (n === null || n === undefined) return '?';
    var num = parseFloat(n);
    if (isNaN(num)) return '?';
    if (num === Math.floor(num)) return String(Math.floor(num));
    return num.toFixed(1).replace('.', ',');
}

function _ibFmtDate(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.getDate() + '. ' + ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'][d.getMonth()];
}

function _ibToast(msg, isError) {
    var existing = document.querySelector('.ib-toast');
    if (existing) existing.remove();
    clearTimeout(_ibToastTimer);

    var t = document.createElement('div');
    t.className = 'ib-toast' + (isError ? ' error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    _ibToastTimer = setTimeout(function() { if (t.parentNode) t.remove(); }, 2500);
}
