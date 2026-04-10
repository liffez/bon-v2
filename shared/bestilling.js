/**
 * shared/bestilling.js
 * ════════════════════════════════════════════════════════════
 * Bestillings-komponent — Tab 2 i kitchen/purchasing.html.
 *
 * Entry: initBestilling(containerEl)
 * Prefix: _bs  (private globals)
 *
 * Flow:
 *   1. Henter shopping_list + products + barcodes + suppliers
 *   2. Bygger leverandørgrupper (pr. grocy_location_id)
 *   3. Viser leverandørkort grupperet (API / E-mail / Mangler)
 *   4. Ordreview: matchede varer med pills + beregningslinje,
 *      umatchede med inline Hoka-kobling
 *   5. Per-vare "Læg i kurv" → kurv-sidebar → "Gå til hoka.dk"
 * ════════════════════════════════════════════════════════════
 */

/* ── State ───────────────────────────────────────────────── */

var _bsContainer      = null;
var _bsShoppingList   = [];     // Grocy shopping_list items
var _bsProducts       = {};     // product_id → product
var _bsBarcodes       = [];     // Grocy product_barcodes
var _bsQUnits         = {};     // qu_id → name
var _bsHandelssteder  = [];     // fra /api/purchasing/suppliers
var _bsSupplierGroups = {};     // grocyLocationId → group
var _bsCurrentGroup   = null;   // valgt leverandørgruppe
var _bsCart           = [];     // { productName, qty, price, packName, entry }
var _bsGrocyLocNames  = {};     // grocy_location_id → name (fra Grocy shopping_locations)
var _bsHokaOk         = false;  // er Hoka konfigureret?
var _bsBusy           = false;
var _bsFavoritesCache  = [];    // [{varenummer, name, brand, pricePerKg, isAgreementItem, ...}]
var _bsFavoritesLoaded = false;
var _bsFavoritesLoading = false;

/* ── Entry point ─────────────────────────────────────────── */

async function initBestilling(el) {
    _bsContainer = el;
    _bsContainer.innerHTML = '<div class="bs-container"><div class="bs-loading"><div class="bs-spinner"></div><div>Henter data...</div></div></div>';

    try {
        await _bsLoadData();
        _bsBuildSupplierGroups();
        await _bsEnrichWithSnapshots();
        _bsRender();
        _bsLoadFavoritesCache(); // Non-blocking — kører i baggrunden
    } catch (err) {
        console.error('[bestilling] Init fejl:', err);
        _bsContainer.innerHTML = '<div class="bs-container"><div class="bs-error">Fejl ved indlæsning: ' + err.message + '</div></div>';
    }
}

/* ── Data loading ────────────────────────────────────────── */

async function _bsLoadData() {
    var results = await Promise.all([
        fetchShoppingList(),
        fetchGrocyProducts(),
        fetchProductBarcodes(),
        fetchGrocyQuantityUnits(),
        fetchPurchasingSuppliers(),
        fetchHokaStatus().catch(function() { return { ok: false }; }),
        fetchShoppingLocations().catch(function() { return []; }),
    ]);

    _bsShoppingList = results[0] || [];
    var productsArr = results[1] || [];
    _bsBarcodes = results[2] || [];
    var qunitsArr = results[3] || [];
    _bsHandelssteder = results[4] || [];
    _bsHokaOk = results[5] && results[5].ok;

    // Byg Grocy shopping_location navne-lookup
    var grocyLocs = results[6] || [];
    _bsGrocyLocNames = {};
    for (var gl = 0; gl < grocyLocs.length; gl++) {
        _bsGrocyLocNames[String(grocyLocs[gl].id)] = grocyLocs[gl].name || grocyLocs[gl].description || 'Lokation ' + grocyLocs[gl].id;
    }

    _bsProducts = {};
    for (var i = 0; i < productsArr.length; i++) {
        _bsProducts[productsArr[i].id] = productsArr[i];
    }

    _bsQUnits = {};
    for (var j = 0; j < qunitsArr.length; j++) {
        _bsQUnits[qunitsArr[j].id] = qunitsArr[j].name || qunitsArr[j].name_plural || '';
    }
}

/* ── Barcode sorting (aftale first, then cheapest) ───────── */

function _bsSortBarcodes(barcodes) {
    return barcodes.slice().sort(function(a, b) {
        var aAft = (a.userfields && a.userfields.is_agreement_item === '1') ? 0 : 1;
        var bAft = (b.userfields && b.userfields.is_agreement_item === '1') ? 0 : 1;
        if (aAft !== bAft) return aAft - bAft;
        var aP = parseFloat(a.last_price) || 9999;
        var bP = parseFloat(b.last_price) || 9999;
        return aP - bP;
    });
}

/* ── Pack size helper ────────────────────────────────────── */

function _bsPackSize(bc) {
    if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
        var unitCode = bc.userfields && bc.userfields.supplier_unit_code;
        var unit = null;
        if (unitCode) {
            for (var i = 0; i < bc._hoka.salesUnits.length; i++) {
                if (bc._hoka.salesUnits[i].code === unitCode) { unit = bc._hoka.salesUnits[i]; break; }
            }
        }
        if (!unit) {
            for (var j = 0; j < bc._hoka.salesUnits.length; j++) {
                if (bc._hoka.salesUnits[j].isDefault) { unit = bc._hoka.salesUnits[j]; break; }
            }
        }
        if (!unit) unit = bc._hoka.salesUnits[0];
        if (unit && unit.quantity && unit.quantity > 0) return unit.quantity;
    }
    if (bc.userfields && bc.userfields.pack_size_stock_unit) {
        var ps = parseFloat(bc.userfields.pack_size_stock_unit);
        if (ps > 0) return ps;
    }
    return parseFloat(bc.amount) || 1;
}

function _bsPackName(bc) {
    return bc.note || bc.barcode || 'Pakke';
}

function _bsIsAftale(bc) {
    if (bc._hoka) return bc._hoka.isAgreementItem === true;
    return !!(bc.userfields && bc.userfields.is_agreement_item === '1');
}

/* ── Calc qty from need + pack size ──────────────────────── */

function _bsCalcQty(need, bc) {
    var packSize = _bsPackSize(bc);
    return Math.max(1, Math.ceil(need / packSize));
}

/* ── Build supplier groups ───────────────────────────────── */

function _bsBuildSupplierGroups() {
    var locMap = {};
    for (var i = 0; i < _bsHandelssteder.length; i++) {
        var h = _bsHandelssteder[i];
        if (h.grocy_location_id) {
            locMap[String(h.grocy_location_id)] = h;
        }
    }

    var bcByProduct = {};
    for (var b = 0; b < _bsBarcodes.length; b++) {
        var bc = _bsBarcodes[b];
        if (!bcByProduct[bc.product_id]) bcByProduct[bc.product_id] = [];
        bcByProduct[bc.product_id].push(bc);
    }

    _bsSupplierGroups = {};

    // Aggregér shopping_list items per product_id (samme produkt kan være der flere gange)
    var aggregated = {}; // product_id → { items: [], totalAmount }
    for (var s = 0; s < _bsShoppingList.length; s++) {
        var slItem = _bsShoppingList[s];
        var pid = slItem.product_id;
        if (!aggregated[pid]) {
            aggregated[pid] = { items: [slItem], totalAmount: parseFloat(slItem.amount) || 0 };
        } else {
            aggregated[pid].items.push(slItem);
            aggregated[pid].totalAmount += parseFloat(slItem.amount) || 0;
        }
    }

    var productIds = Object.keys(aggregated);
    for (var p = 0; p < productIds.length; p++) {
        var agg = aggregated[productIds[p]];
        var item = agg.items[0]; // Primær shopping_list item (bruges til ID)
        var product = _bsProducts[item.product_id];
        if (!product) continue;

        var grocyLocId = String(product.shopping_location_id || '__none__');
        var handelssted = locMap[grocyLocId];

        if (!_bsSupplierGroups[grocyLocId]) {
            _bsSupplierGroups[grocyLocId] = {
                grocyLocationId: grocyLocId,
                supplierId: handelssted ? handelssted.supplier_id : null,
                supplierName: handelssted ? handelssted.supplier_name : 'Ukendt',
                displayName: handelssted
                    ? (handelssted.grocy_location_display_name || handelssted.supplier_name)
                    : (_bsGrocyLocNames[grocyLocId] || 'Uden leverandør'),
                integrationType: handelssted ? handelssted.integration_type : 'none',
                webshopUrl: handelssted ? handelssted.webshop_url : null,
                contactEmail: handelssted ? handelssted.contact_email : null,
                items: [],
            };
        }

        var productBarcodes = bcByProduct[item.product_id] || [];
        var supplierIdForGroup = _bsSupplierGroups[grocyLocId] ? _bsSupplierGroups[grocyLocId].supplierId : null;
        var matchedBarcodes = _bsSortBarcodes(productBarcodes.filter(function(bc) {
            if (String(bc.shopping_location_id) === grocyLocId) return true;
            if (supplierIdForGroup && bc.shopping_location_id) {
                var bcLoc = locMap[String(bc.shopping_location_id)];
                if (bcLoc && bcLoc.supplier_id === supplierIdForGroup) return true;
            }
            return false;
        }));

        var need = agg.totalAmount; // Aggregeret behov
        var defaultBc = matchedBarcodes.length > 0 ? matchedBarcodes[0] : null;

        _bsSupplierGroups[grocyLocId].items.push({
            item: item,
            allItems: agg.items, // Alle shopping_list items for dette produkt
            product: product,
            barcodes: matchedBarcodes,
            matched: matchedBarcodes.length > 0,
            selectedBcIdx: 0,
            selectedBarcode: defaultBc,
            need: need,
            needUnit: _bsQUnits[product.qu_id_stock] || 'stk',
            qty: defaultBc ? _bsCalcQty(need, defaultBc) : Math.max(1, Math.ceil(need)),
            inCart: false,
            cartBusy: false,
        });
    }
}

/* ── Enrich barcodes with live Hoka snapshot data ────────── */

async function _bsEnrichWithSnapshots() {
    var varenumre = [];
    var keys = Object.keys(_bsSupplierGroups);
    for (var k = 0; k < keys.length; k++) {
        var g = _bsSupplierGroups[keys[k]];
        if (g.integrationType !== 'api') continue;
        for (var i = 0; i < g.items.length; i++) {
            var bcs = g.items[i].barcodes;
            for (var b = 0; b < bcs.length; b++) {
                if (bcs[b].barcode) varenumre.push(bcs[b].barcode);
            }
        }
    }

    if (varenumre.length === 0) return;

    console.log('[bestilling] Henter Hoka snapshots for', varenumre.length, 'varenumre...');

    try {
        var res = await fetch('/api/horkram/snapshots?ids=' + varenumre.join(','));
        if (!res.ok) {
            console.warn('[bestilling] Snapshot-kald fejlede: HTTP', res.status, '— fortsætter uden beriging');
            return;
        }
        var data = await res.json();

        var snapMap = {};
        var products = data.products || [];
        for (var s = 0; s < products.length; s++) {
            snapMap[products[s].varenummer] = products[s];
        }

        console.log('[bestilling] Snapshot-beriging: modtog', products.length, '/', varenumre.length);

        for (var k2 = 0; k2 < keys.length; k2++) {
            var g2 = _bsSupplierGroups[keys[k2]];
            if (g2.integrationType !== 'api') continue;

            for (var i2 = 0; i2 < g2.items.length; i2++) {
                var entry = g2.items[i2];

                for (var b2 = 0; b2 < entry.barcodes.length; b2++) {
                    var snap = snapMap[entry.barcodes[b2].barcode];
                    if (snap) entry.barcodes[b2]._hoka = snap;
                }

                entry.barcodes = _bsSortBarcodes(entry.barcodes);
                entry.selectedBcIdx   = 0;
                entry.selectedBarcode = entry.barcodes[0] || null;

                if (entry.selectedBarcode) {
                    entry.qty = _bsCalcQty(entry.need, entry.selectedBarcode);
                }
            }
        }

        console.log('[bestilling] Snapshot-beriging færdig');
    } catch (err) {
        console.warn('[bestilling] Snapshot enrichment fejlede:', err.message, '— fortsætter uden');
    }
}

/* ── Favorites cache (background load) ───────────────────── */

async function _bsLoadFavoritesCache() {
    if (_bsFavoritesLoading || _bsFavoritesLoaded || !_bsHokaOk) return;
    _bsFavoritesLoading = true;

    try {
        var listsRes = await fetch('/api/horkram/favorites');
        if (!listsRes.ok) throw new Error('HTTP ' + listsRes.status);
        var listsData = await listsRes.json();
        var lists = listsData.lists || [];
        console.log('[bestilling] Henter favoritter fra', lists.length, 'lister...');

        var allProducts = new Map();
        for (var i = 0; i < lists.length; i++) {
            var list = lists[i];
            try {
                var res = await fetch('/api/horkram/favorites/' + list.id + '/all');
                if (!res.ok) { console.warn('[bestilling] Favoritliste', list.name, 'fejlede: HTTP', res.status); continue; }
                var data = await res.json();
                var products = data.products || [];
                for (var j = 0; j < products.length; j++) {
                    var p = products[j];
                    if (!allProducts.has(p.varenummer)) {
                        p._fromLists = [list.name];
                        allProducts.set(p.varenummer, p);
                    } else {
                        var existing = allProducts.get(p.varenummer);
                        if (!existing._fromLists) existing._fromLists = [];
                        if (existing._fromLists.indexOf(list.name) === -1) existing._fromLists.push(list.name);
                    }
                }
                console.log('[bestilling] Favoritter fra "' + list.name + '": ' + products.length + ' produkter');
            } catch (listErr) {
                console.warn('[bestilling] Favoritliste', list.id, 'fejlede:', listErr.message);
            }
        }

        _bsFavoritesCache = Array.from(allProducts.values());
        _bsFavoritesLoaded = true;
        console.log('[bestilling] Favorit-cache klar:', _bsFavoritesCache.length, 'unikke produkter');
    } catch (err) {
        console.warn('[bestilling] Favorit-cache fejlede:', err.message);
    } finally {
        _bsFavoritesLoading = false;
    }
}

/* ── Main render ─────────────────────────────────────────── */

function _bsRender() {
    if (_bsCurrentGroup) {
        _bsRenderOrderView();
    } else {
        _bsRenderSupplierCards();
    }
}

/* ── Supplier cards view (grouped by integration type) ───── */

function _bsRenderSupplierCards() {
    var root = document.createElement('div');
    root.className = 'bs-container';

    // Check for uncoupled
    var noneGroup = _bsSupplierGroups['__none__'];
    var hasUncoupled = (noneGroup && noneGroup.items.length > 0);
    if (hasUncoupled) {
        root.appendChild(_bsCreateSetupBar());
    }

    // Group suppliers by integration type
    var apiGroups = [], emailGroups = [], noneGroups = [];
    var keys = Object.keys(_bsSupplierGroups);
    for (var k = 0; k < keys.length; k++) {
        var g = _bsSupplierGroups[keys[k]];
        if (g.items.length === 0) continue;
        if (g.integrationType === 'api') apiGroups.push(g);
        else if (g.integrationType === 'email' || g.integrationType === 'webshop') emailGroups.push(g);
        else noneGroups.push(g);
    }

    if (apiGroups.length > 0) {
        root.appendChild(_bsCardSection('API-integration', apiGroups));
    }
    if (emailGroups.length > 0) {
        root.appendChild(_bsCardSection('E-mail / Webshop', emailGroups));
    }
    if (noneGroups.length > 0) {
        root.appendChild(_bsCardSection('Mangler opsætning', noneGroups));
    }

    if (apiGroups.length + emailGroups.length + noneGroups.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'bs-empty';
        empty.innerHTML = '<div style="font-size:32px;margin-bottom:8px;">📭</div>Indkøbslisten er tom. Tilføj varer i Indkøbsliste-tabben.';
        root.appendChild(empty);
    }

    _bsContainer.innerHTML = '';
    _bsContainer.appendChild(root);
}

function _bsCardSection(title, groups) {
    var frag = document.createDocumentFragment();

    var hdr = document.createElement('div');
    hdr.className = 'bs-section-header';
    hdr.textContent = title;
    frag.appendChild(hdr);

    for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        var matched = group.items.filter(function(e) { return e.matched; }).length;
        var unmatched = group.items.length - matched;
        var card = document.createElement('div');
        card.className = 'bs-supplier-card';

        var iconClass = group.integrationType === 'api' ? 'bs-sico--api'
            : (group.integrationType === 'webshop' || group.integrationType === 'email') ? 'bs-sico--email'
            : 'bs-sico--none';
        var initials = (group.displayName || '??').substring(0, 2).toUpperCase();

        var metaText = group.integrationType === 'api' ? 'Bestilling via hoka.dk API'
            : group.integrationType === 'webshop' ? 'Webshop' + (group.contactEmail ? ' · ' + _bsEsc(group.contactEmail) : '')
            : group.integrationType === 'email' ? 'E-mail' + (group.contactEmail ? ' · ' + _bsEsc(group.contactEmail) : '')
            : 'Ikke koblet — klik for vareliste + kopiér til mail';

        card.innerHTML =
            '<div class="bs-sico ' + iconClass + '">' + _bsEsc(initials) + '</div>' +
            '<div class="bs-sc-info">' +
                '<div class="bs-sc-name">' + _bsEsc(group.displayName) + '</div>' +
                '<div class="bs-sc-meta">' + metaText + '</div>' +
            '</div>' +
            '<div class="bs-sc-right">' +
                '<div class="bs-sc-count-pill ' + iconClass + '">' + group.items.length + ' varer</div>' +
                '<div class="bs-sc-koblet">' + matched + ' koblet' + (unmatched > 0 ? ' · ' + unmatched + ' umatched' : '') + '</div>' +
            '</div>' +
            '<span class="bs-sc-chevron">›</span>';

        // Alle kort er klikbare — ukoblede åbner vareliste med kopiér-til-mail
        card.addEventListener('click', (function(g) {
            return function() {
                _bsCurrentGroup = g;
                _bsCart = [];
                _bsRender();
            };
        })(group));

        frag.appendChild(card);
    }

    return frag;
}

/* ── Setup bar ───────────────────────────────────────────── */

function _bsCreateSetupBar() {
    var bar = document.createElement('div');
    bar.className = 'bs-setup-bar';
    bar.innerHTML =
        '<span class="bs-setup-icon">⚙️</span>' +
        '<span class="bs-setup-text">Nogle varer mangler leverandørkobling. Opsæt Grocy-lokationer.</span>' +
        '<button class="bs-setup-btn" id="bsSetupBtn">Opsæt nu</button>';
    setTimeout(function() {
        var btn = document.getElementById('bsSetupBtn');
        if (btn) btn.addEventListener('click', _bsOpenSetupModal);
    }, 0);
    return bar;
}

async function _bsOpenSetupModal() {
    try {
        var data = await fetchPurchasingGrocyLocations();
        var locs = data.locations || [];
        var suppliers = data.suppliers || [];

        var modal = document.createElement('div');
        modal.className = 'bs-setup-modal';
        modal.id = 'bsSetupModal';

        var title = document.createElement('h3');
        title.textContent = 'Kobl Grocy-lokationer til leverandører';
        title.style.cssText = 'margin-bottom:12px;font-size:16px;';
        modal.appendChild(title);

        for (var i = 0; i < locs.length; i++) {
            var loc = locs[i];
            var row = document.createElement('div');
            row.className = 'bs-setup-row';
            var name = document.createElement('span');
            name.className = 'bs-setup-loc-name';
            name.textContent = loc.grocy_location_name;
            row.appendChild(name);
            var sel = document.createElement('select');
            sel.dataset.grocyLocId = loc.grocy_location_id;
            sel.innerHTML = '<option value="">-- Vælg leverandør --</option>';
            for (var s = 0; s < suppliers.length; s++) {
                var opt = document.createElement('option');
                opt.value = suppliers[s].id;
                opt.textContent = suppliers[s].name + ' (' + suppliers[s].integration_type + ')';
                if (loc.linked_supplier_id && loc.linked_supplier_id === suppliers[s].id) opt.selected = true;
                sel.appendChild(opt);
            }
            row.appendChild(sel);
            modal.appendChild(row);
        }

        var actions = document.createElement('div');
        actions.className = 'bs-setup-actions';
        actions.innerHTML =
            '<button class="bs-add-btn bs-add-btn--primary" id="bsSetupSave">Gem koblinger</button>' +
            '<button class="bs-add-btn" id="bsSetupCancel" style="border:1px solid var(--color-border);">Luk</button>';
        modal.appendChild(actions);

        var bar = _bsContainer.querySelector('.bs-setup-bar');
        if (bar) bar.insertAdjacentElement('afterend', modal);
        else _bsContainer.querySelector('.bs-container').prepend(modal);

        document.getElementById('bsSetupSave').addEventListener('click', async function() {
            var selects = modal.querySelectorAll('select');
            for (var j = 0; j < selects.length; j++) {
                var grocyLocId = parseInt(selects[j].dataset.grocyLocId);
                var supplierId = selects[j].value ? parseInt(selects[j].value) : null;
                if (supplierId) await linkGrocyLocation({ grocy_location_id: grocyLocId, supplier_id: supplierId });
            }
            await _bsLoadData();
            _bsBuildSupplierGroups();
            _bsRender();
        });

        document.getElementById('bsSetupCancel').addEventListener('click', function() { modal.remove(); });
    } catch (err) {
        _bsToast('Fejl: ' + err.message, 'err');
    }
}

/* ── Order view ──────────────────────────────────────────── */

function _bsRenderOrderView() {
    var group = _bsCurrentGroup;
    var root = document.createElement('div');
    root.className = 'bs-container';

    // Topbar
    var topbar = document.createElement('div');
    topbar.className = 'bs-order-topbar';
    var backBtn = document.createElement('button');
    backBtn.className = 'bs-back-btn';
    backBtn.textContent = '‹';
    backBtn.addEventListener('click', function() { _bsCurrentGroup = null; _bsCart = []; _bsRender(); });
    topbar.appendChild(backBtn);
    var title = document.createElement('span');
    title.className = 'bs-order-title';
    title.textContent = group.displayName;
    topbar.appendChild(title);
    if (group.integrationType === 'api') {
        var badge = document.createElement('span');
        badge.className = 'bs-order-badge';
        badge.textContent = 'hoka.dk · API';
        topbar.appendChild(badge);
    }
    root.appendChild(topbar);

    if (group.integrationType === 'api') {
        root.appendChild(_bsRenderApiOrderView(group));
    } else {
        root.appendChild(_bsRenderExternalOrderView(group));
    }

    _bsContainer.innerHTML = '';
    _bsContainer.appendChild(root);
}

/* ── API order view (Hørkram) — two column ───────────────── */

function _bsRenderApiOrderView(group) {
    var wrap = document.createElement('div');
    wrap.className = 'bs-order-view';

    var left = document.createElement('div');
    left.className = 'bs-oleft';

    if (!_bsHokaOk) {
        var warn = document.createElement('div');
        warn.className = 'bs-error';
        warn.style.cssText = 'margin:12px 14px;text-align:left;padding:12px;background:#fff3e0;border-radius:8px;color:#e65100;';
        warn.textContent = '⚠️ Hørkram ikke konfigureret. Sæt HOKA_USERNAME + HOKA_PASSWORD i .env.';
        left.appendChild(warn);
    }

    var matched = group.items.filter(function(e) { return e.matched; });
    var unmatched = group.items.filter(function(e) { return !e.matched; });

    // Matched section
    if (matched.length > 0) {
        var sec = document.createElement('div');
        sec.className = 'bs-section-header';
        sec.textContent = 'Klar til bestilling — ' + matched.length + ' varer';
        left.appendChild(sec);
        for (var i = 0; i < matched.length; i++) {
            left.appendChild(_bsRenderMatchedItem(matched[i], group));
        }
    }

    // Unmatched section
    if (unmatched.length > 0) {
        var sec2 = document.createElement('div');
        sec2.className = 'bs-section-header';
        sec2.textContent = 'Ingen barcode hos ' + _bsEsc(group.displayName) + ' — ' + unmatched.length + ' vare' + (unmatched.length > 1 ? 'r' : '');
        left.appendChild(sec2);
        for (var u = 0; u < unmatched.length; u++) {
            left.appendChild(_bsRenderUnmatchedItem(unmatched[u], group));
        }
    }

    wrap.appendChild(left);
    wrap.appendChild(_bsRenderCartSidebar(group));
    return wrap;
}

/* ── Matched item row (with pills + calc line) ───────────── */

function _bsRenderMatchedItem(entry, group) {
    var wrap = document.createElement('div');
    wrap.className = 'bs-oitem' + (entry.inCart ? ' bs-oitem--added' : '');

    // Main row: name + need + varenr + qty + button
    var main = document.createElement('div');
    main.className = 'bs-oim';

    var info = document.createElement('div');
    info.className = 'bs-oi';
    var nameEl = document.createElement('div');
    nameEl.className = 'bs-on';
    nameEl.textContent = entry.product.name;
    info.appendChild(nameEl);

    var meta = document.createElement('div');
    meta.className = 'bs-om';
    if (!entry.inCart) {
        meta.innerHTML = 'Behov: <strong style="color:var(--brand-primary)">' + entry.need + ' ' + _bsEsc(entry.needUnit) + '</strong>';
    }
    if (entry.selectedBarcode) {
        var vnSpan = document.createElement('span');
        vnSpan.className = 'bs-vn';
        vnSpan.textContent = 'Nr. ' + entry.selectedBarcode.barcode;
        meta.appendChild(document.createTextNode(' \u00A0'));
        meta.appendChild(vnSpan);
    }
    info.appendChild(meta);
    main.appendChild(info);

    // Qty controls
    var qc = document.createElement('div');
    qc.className = 'bs-qc';
    if (!entry.inCart) {
        var minus = document.createElement('button');
        minus.className = 'bs-qb';
        minus.textContent = '−';
        minus.addEventListener('click', function() { if (entry.qty > 1) { entry.qty--; _bsRenderOrderView(); } });
        qc.appendChild(minus);

        var qInput = document.createElement('input');
        qInput.className = 'bs-qv-input';
        qInput.type = 'number';
        qInput.min = '1';
        qInput.value = entry.qty;
        qInput.addEventListener('change', function() {
            var v = parseInt(this.value);
            if (v >= 1) { entry.qty = v; } else { entry.qty = 1; this.value = 1; }
            _bsRenderOrderView();
        });
        qInput.addEventListener('click', function(e) { e.stopPropagation(); this.select(); });
        qc.appendChild(qInput);

        var plus = document.createElement('button');
        plus.className = 'bs-qb';
        plus.textContent = '+';
        plus.addEventListener('click', function() { entry.qty++; _bsRenderOrderView(); });
        qc.appendChild(plus);
    } else {
        var qv = document.createElement('span');
        qv.className = 'bs-qv';
        qv.style.color = 'var(--color-green, #6a8f3a)';
        qv.textContent = entry.qty;
        qc.appendChild(qv);
    }
    main.appendChild(qc);

    // Action button
    var btn = document.createElement('button');
    if (entry.inCart) {
        btn.className = 'bs-kb bs-kb--done';
        btn.textContent = 'I kurv ✓';
    } else if (entry.cartBusy) {
        btn.className = 'bs-kb bs-kb--busy';
        btn.textContent = '...';
    } else {
        btn.className = 'bs-kb';
        btn.textContent = 'Læg i kurv';
        btn.addEventListener('click', function() { _bsAddToBasket(entry, group); });
    }
    main.appendChild(btn);
    wrap.appendChild(main);

    // Pills row (only if not in cart or if multiple barcodes)
    if (entry.barcodes.length > 0) {
        var pills = document.createElement('div');
        pills.className = 'bs-pills';
        for (var p = 0; p < entry.barcodes.length; p++) {
            var bc = entry.barcodes[p];
            var isSelected = (p === entry.selectedBcIdx);
            var isAft = _bsIsAftale(bc);
            var pill = document.createElement('button');
            pill.className = 'bs-pill' + (isSelected ? ' bs-pill--on' : '') + (isAft ? ' bs-pill--aftale' : '');

            var pillHtml = '';
            if (isAft) pillHtml += '<span class="bs-pill-aftale">Aftale</span>';
            pillHtml += '<span class="bs-pill-name">' + _bsEsc(_bsPackName(bc)) + '</span>';
            var price = parseFloat(bc.last_price);
            if (price) pillHtml += '<span class="bs-pill-price">' + price.toFixed(0) + ' kr</span>';
            pill.innerHTML = pillHtml;

            if (!entry.inCart) {
                pill.addEventListener('click', (function(e, idx) {
                    return function() {
                        e.selectedBcIdx = idx;
                        e.selectedBarcode = e.barcodes[idx];
                        e.qty = _bsCalcQty(e.need, e.selectedBarcode);
                        _bsRenderOrderView();
                    };
                })(entry, p));
            }
            pills.appendChild(pill);
        }
        wrap.appendChild(pills);
    }

    // Calc line (coverage)
    if (entry.selectedBarcode && !entry.inCart) {
        var packSize = _bsPackSize(entry.selectedBarcode);
        var total = +(entry.qty * packSize).toFixed(2);
        var diff = +(total - entry.need).toFixed(2);

        var calc = document.createElement('div');
        calc.className = 'bs-icalc';
        if (diff === 0) {
            calc.innerHTML = '<span class="bs-calc-ok">= ' + total + ' ' + _bsEsc(entry.needUnit) + '</span> \u00A0·\u00A0 dækker præcis';
        } else if (diff > 0) {
            calc.innerHTML = '<span class="bs-calc-ok">= ' + total + ' ' + _bsEsc(entry.needUnit) + '</span> \u00A0·\u00A0 <span class="bs-calc-over">+' + diff + ' ' + _bsEsc(entry.needUnit) + ' over behov</span>';
        } else {
            calc.innerHTML = '<span class="bs-calc-under">= ' + total + ' ' + _bsEsc(entry.needUnit) + '</span> \u00A0·\u00A0 <span class="bs-calc-under">mangler ' + Math.abs(diff) + ' ' + _bsEsc(entry.needUnit) + '</span>';
        }
        wrap.appendChild(calc);
    }

    return wrap;
}

/* ── Unmatched item row ──────────────────────────────────── */

function _bsRenderUnmatchedItem(entry, group) {
    var wrap = document.createElement('div');
    wrap.className = 'bs-um';

    var top = document.createElement('div');
    top.className = 'bs-um-top';

    var name = document.createElement('div');
    name.className = 'bs-un';
    name.textContent = entry.product.name;
    top.appendChild(name);

    if (group.integrationType === 'api') {
        var linkBtn = document.createElement('button');
        linkBtn.className = 'bs-lb';
        linkBtn.textContent = 'Kobl varenr.';
        linkBtn.addEventListener('click', function() {
            var existing = wrap.querySelector('.bs-lp');
            if (existing) { existing.remove(); linkBtn.classList.remove('bs-lb--act'); return; }
            linkBtn.classList.add('bs-lb--act');
            wrap.appendChild(_bsCreateLinkPanel(entry, group));
        });
        top.appendChild(linkBtn);
    }

    var skipBtn = document.createElement('button');
    skipBtn.className = 'bs-lb';
    skipBtn.textContent = 'Spring over';
    skipBtn.addEventListener('click', function() { wrap.style.opacity = '0.3'; wrap.style.pointerEvents = 'none'; });
    top.appendChild(skipBtn);

    wrap.appendChild(top);
    return wrap;
}

/* ── Link panel (manuelt varenr. + Hoka-søgning) ─────────── */

/**
 * To måder at koble en umatched vare:
 * 1. Indtast varenr. manuelt (fra hoka.dk) → henter produktdata via snapshot API
 * 2. Søg i Hoka-katalog (sekundær) → vælg fra resultater
 */
function _bsCreateLinkPanel(entry, group) {
    var panel = document.createElement('div');
    panel.className = 'bs-lp';

    // ── Tab 1: Manuelt varenr. (primær) ─────────────────
    var manualRow = document.createElement('div');
    manualRow.className = 'bs-lrow';
    var manualInput = document.createElement('input');
    manualInput.className = 'bs-linp';
    manualInput.placeholder = 'Indtast Hørkram varenr...';
    manualInput.type = 'text';
    manualInput.inputMode = 'numeric';
    manualRow.appendChild(manualInput);
    var manualBtn = document.createElement('button');
    manualBtn.className = 'bs-lbtn';
    manualBtn.textContent = 'Hent →';
    manualRow.appendChild(manualBtn);
    panel.appendChild(manualRow);

    var manualHelp = document.createElement('div');
    manualHelp.style.cssText = 'font-size:11px;color:var(--color-text-dim,#777);margin-bottom:8px;';
    manualHelp.innerHTML = 'Find varenr. på <a href="https://www.hoka.dk/da-dk" target="_blank" style="color:var(--brand-primary);">hoka.dk</a> og indtast det her.';
    panel.appendChild(manualHelp);

    var manualResult = document.createElement('div');
    panel.appendChild(manualResult);

    manualBtn.addEventListener('click', function() {
        _bsLinkByVarenr(manualInput.value.trim(), manualResult, entry, group);
    });
    manualInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') _bsLinkByVarenr(manualInput.value.trim(), manualResult, entry, group);
    });

    // ── Separator ───────────────────────────────────────
    var sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--color-border,#d7d1ca);margin:10px 0 8px;padding-top:8px;font-size:11px;color:var(--color-text-dim,#777);';
    sep.textContent = 'Eller søg i Hørkram-katalog:';
    panel.appendChild(sep);

    // ── Tab 2: Søg i katalog (sekundær) ─────────────────
    var searchRow = document.createElement('div');
    searchRow.className = 'bs-lrow';
    var searchInput = document.createElement('input');
    searchInput.className = 'bs-linp';
    searchInput.placeholder = 'Søg på produktnavn...';
    searchInput.value = entry.product.name;
    searchRow.appendChild(searchInput);
    var searchBtn = document.createElement('button');
    searchBtn.className = 'bs-lbtn';
    searchBtn.style.background = 'var(--color-text-dim,#777)';
    searchBtn.textContent = 'Søg';
    searchRow.appendChild(searchBtn);
    panel.appendChild(searchRow);

    var searchResults = document.createElement('div');
    panel.appendChild(searchResults);

    searchBtn.addEventListener('click', function() { _bsCatalogSearch(searchInput.value, searchResults, entry, group); });
    var timer = null;
    searchInput.addEventListener('input', function() {
        clearTimeout(timer);
        timer = setTimeout(function() { _bsCatalogSearch(searchInput.value, searchResults, entry, group); }, 400);
    });

    return panel;
}

/* ── Link by manual varenr. (parsed product lookup) ──────── */

async function _bsLinkByVarenr(varenr, resultDiv, entry, group) {
    if (!varenr || varenr.length < 3) {
        _bsToast('Indtast et gyldigt varenr.', 'err');
        return;
    }
    resultDiv.innerHTML = '<div style="font-size:12px;color:var(--color-text-dim);padding:8px 0;">Henter produkt ' + _bsEsc(varenr) + '...</div>';

    try {
        // Bruger parsed product endpoint — returnerer normaliseret data
        var product = await fetchHokaProduct(varenr);

        resultDiv.innerHTML = '';
        var row = document.createElement('div');
        row.className = 'bs-lres';
        var priceStr = product.pricePerUnit ? (product.pricePerUnit + ' kr') : '';
        if (product.pricePerKg) priceStr += (priceStr ? ' · ' : '') + product.pricePerKg + ' kr/kg';
        row.innerHTML =
            '<div>' +
                '<div class="bs-lr-n">' + _bsEsc(product.name) +
                    (product.isAgreementItem ? ' <span style="color:#6a8f3a;font-size:10px;">★ Aftale</span>' : '') +
                '</div>' +
                '<div class="bs-lr-m">Varenr. ' + _bsEsc(product.varenummer) +
                    (product.brand ? ' · ' + _bsEsc(product.brand) : '') +
                '</div>' +
            '</div>' +
            (priceStr ? '<span class="bs-lr-p">' + _bsEsc(priceStr) + '</span>' : '');
        var koblBtn = document.createElement('button');
        koblBtn.className = 'bs-lr-k';
        koblBtn.textContent = '+ Kobl';
        koblBtn.addEventListener('click', function() { _bsLinkBarcode(entry, product, group); });
        row.appendChild(koblBtn);
        resultDiv.appendChild(row);
    } catch (err) {
        resultDiv.innerHTML = '<div style="font-size:12px;color:#bc181b;padding:8px 0;">Varenr. ' + _bsEsc(varenr) + ' ikke fundet. ' + _bsEsc(err.message) + '</div>';
    }
}

/* ── Catalog search (parsed + aftale-enriched) ───────────── */

async function _bsCatalogSearch(q, resultsDiv, entry, group) {
    if (!q || q.length < 2) { resultsDiv.innerHTML = ''; return; }

    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);

    // Trin 1: Søg i favorites-cache øjeblikkeligt (client-side)
    var favResults = [];
    if (_bsFavoritesLoaded && _bsFavoritesCache.length > 0) {
        favResults = _bsFavoritesCache.filter(function(p) {
            var searchable = ((p.name || '') + ' ' + (p.brand || '') + ' ' + (p.varenummer || '')).toLowerCase();
            return terms.every(function(t) { return searchable.indexOf(t) !== -1; });
        }).slice(0, 10);
    }

    if (favResults.length > 0) {
        _bsRenderSearchResults(resultsDiv, favResults, entry, group, 'Fra dine favoritter');
    } else {
        resultsDiv.innerHTML = '<div style="font-size:12px;color:var(--color-text-dim);padding:4px 0;">Søger...</div>';
    }

    // Trin 2: Hent catalog-resultater (asynkront)
    try {
        var data = await fetchHokaSearch(q);
        var catItems = data.results || [];

        var favVarenumre = {};
        for (var f = 0; f < favResults.length; f++) favVarenumre[favResults[f].varenummer] = true;
        var newCatItems = catItems.filter(function(p) { return !favVarenumre[p.varenummer]; });

        var combined = favResults.concat(newCatItems).slice(0, 12);

        if (combined.length === 0) {
            resultsDiv.innerHTML = '<div style="font-size:12px;color:var(--color-text-dim);padding:4px 0;">Ingen resultater for "' + _bsEsc(q) + '"</div>';
            return;
        }

        resultsDiv.innerHTML = '';
        var favCount = favResults.length;
        var catOnlyCount = Math.min(newCatItems.length, 12 - favCount);

        if (favCount > 0) {
            _bsRenderSearchResults(resultsDiv, favResults, entry, group, 'Fra dine favoritter');
        }
        if (catOnlyCount > 0) {
            _bsRenderSearchResults(resultsDiv, newCatItems.slice(0, catOnlyCount), entry, group,
                favCount > 0 ? 'Øvrige resultater' : null);
        }

        if (data.totalResults > combined.length) {
            var more = document.createElement('div');
            more.style.cssText = 'font-size:11px;padding:8px 0;text-align:center;';
            more.innerHTML = '...og ' + (data.totalResults - combined.length) + ' flere — ' +
                '<a href="https://www.hoka.dk/da-dk" target="_blank" ' +
                'style="color:var(--brand-primary);font-weight:700;">Åbn hoka.dk →</a>' +
                '<br><span style="font-size:10px;color:var(--color-text-dim);">Søg dér, kopiér varenr., og brug "Hent" feltet ovenfor</span>';
            resultsDiv.appendChild(more);
        }
    } catch (err) {
        if (favResults.length === 0) {
            resultsDiv.innerHTML = '<div style="font-size:12px;color:#bc181b;padding:4px 0;">Søgefejl: ' + _bsEsc(err.message) + '</div>';
        }
        console.warn('[bestilling] Catalog-søgning fejlede:', err.message);
    }
}

function _bsRenderSearchResults(container, items, entry, group, sectionLabel) {
    if (sectionLabel) {
        var lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--color-text-dim,#777);padding:6px 0 3px;';
        lbl.textContent = sectionLabel;
        container.appendChild(lbl);
    }

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var row = document.createElement('div');
        row.className = 'bs-lres';

        var priceStr = '';
        if (item.pricePerKg) priceStr = item.pricePerKg + ' kr/kg';
        else if (item.pricePerUnit) priceStr = item.pricePerUnit + ' kr';
        else if (item.listPricePerKg) priceStr = item.listPricePerKg + ' kr/kg';

        var aftaleTag = item.isAgreementItem ? ' <span style="color:#6a8f3a;font-size:10px;font-weight:700;">★ Aftale</span>' : '';
        var favTag = item._fromLists && item._fromLists.length > 0
            ? ' <span style="font-size:10px;color:var(--color-text-dim,#777);">⭐ ' + _bsEsc(item._fromLists[0]) + '</span>' : '';

        row.innerHTML =
            '<div>' +
                '<div class="bs-lr-n">' + _bsEsc(item.name) + aftaleTag + '</div>' +
                '<div class="bs-lr-m">Varenr. ' + _bsEsc(item.varenummer) +
                    (item.brand ? ' · ' + _bsEsc(item.brand) : '') + favTag +
                '</div>' +
            '</div>' +
            (priceStr ? '<span class="bs-lr-p">' + _bsEsc(priceStr) + '</span>' : '');

        var koblBtn = document.createElement('button');
        koblBtn.className = 'bs-lr-k';
        koblBtn.textContent = '+ Kobl';
        koblBtn.addEventListener('click', (function(hokaItem) {
            return function() { _bsLinkBarcode(entry, hokaItem, group); };
        })(item));
        row.appendChild(koblBtn);
        container.appendChild(row);
    }
}

/* ── Link barcode (create in Grocy) ──────────────────────── */

async function _bsLinkBarcode(entry, hokaProduct, group) {
    try {
        var varenr = String(hokaProduct.varenummer || hokaProduct.Id || hokaProduct.id);
        var dispName = hokaProduct.name || varenr;
        var lastPrice = hokaProduct.pricePerUnit || null;

        // Refresh barcode-cache for præcist check
        _bsBarcodes = await fetchProductBarcodes();

        // Tjek om barcode allerede eksisterer (for dette eller andet produkt)
        var existingForProduct = _bsBarcodes.find(function(bc) { return bc.barcode === varenr && bc.product_id === entry.product.id; });
        var existingForOther = _bsBarcodes.find(function(bc) { return bc.barcode === varenr && bc.product_id !== entry.product.id; });

        if (existingForProduct) {
            _bsToast(dispName + ' er allerede koblet til dette produkt', 'ok');
        } else if (existingForOther) {
            // Barcode tilhører et andet produkt — tilbyd at flytte den
            var otherProduct = _bsProducts[existingForOther.product_id];
            var otherName = otherProduct ? otherProduct.name : 'Produkt #' + existingForOther.product_id;
            var moveIt = confirm(
                'Varenr. ' + varenr + ' (' + dispName + ') er allerede koblet til:\n\n' +
                '  → ' + otherName + '\n\n' +
                'Vil du flytte koblingen til ' + entry.product.name + '?\n\n' +
                '(Hvis det er et duplikat, bør produkterne merges i Grocy)'
            );
            // Log duplikat-kandidat uanset om brugeren flytter eller ej
            try {
                await apiFetch('/settings/duplicates', {
                    method: 'POST',
                    body: JSON.stringify({
                        product_id_a: entry.product.id,
                        product_name_a: entry.product.name,
                        product_id_b: existingForOther.product_id,
                        product_name_b: otherName,
                        barcode: varenr,
                        barcode_name: dispName,
                    }),
                });
            } catch (logErr) { console.warn('[bestilling] Duplikat-log fejl:', logErr.message); }

            if (moveIt) {
                try {
                    await apiFetch('/grocy/product-barcodes/' + existingForOther.id, { method: 'DELETE' });
                    await createProductBarcode({
                        product_id: entry.product.id,
                        barcode: varenr,
                        shopping_location_id: parseInt(group.grocyLocationId) || null,
                        note: dispName,
                        last_price: lastPrice ? String(lastPrice) : null,
                    });
                    _bsToast('Koblet: ' + dispName + ' (flyttet fra ' + otherName + ')', 'ok');
                } catch (moveErr) {
                    _bsToast('Fejl ved flytning: ' + moveErr.message, 'err');
                }
            } else {
                return; // Brugeren annullerede
            }
        } else {
            try {
                await createProductBarcode({
                    product_id: entry.product.id,
                    barcode: varenr,
                    shopping_location_id: parseInt(group.grocyLocationId) || null,
                    note: dispName,
                    last_price: lastPrice ? String(lastPrice) : null,
                });
                _bsToast('Koblet: ' + dispName, 'ok');
            } catch (createErr) {
                // UNIQUE constraint = barcode oprettet af en anden i mellemtiden
                if (createErr.message && createErr.message.indexOf('UNIQUE') !== -1) {
                    _bsToast(dispName + ' er allerede koblet', 'ok');
                } else {
                    throw createErr;
                }
            }
        }

        // Rebuild uanset hvad — varen bør nu flytte fra umatched til matched
        _bsBarcodes = await fetchProductBarcodes();
        _bsBuildSupplierGroups();
        await _bsEnrichWithSnapshots();
        _bsCurrentGroup = _bsSupplierGroups[group.grocyLocationId] || null;
        _bsRender();
    } catch (err) {
        _bsToast('Fejl: ' + err.message, 'err');
    }
}

/* ── Add to basket (Hoka API) ────────────────────────────── */

async function _bsAddToBasket(entry, group) {
    if (entry.cartBusy || entry.inCart || !_bsHokaOk) {
        if (!_bsHokaOk) _bsToast('Hørkram er ikke konfigureret', 'err');
        return;
    }
    entry.cartBusy = true;
    _bsRenderOrderView();

    try {
        var bc = entry.selectedBarcode;
        if (!bc) throw new Error('Ingen barcode valgt');

        var varenummer = bc.barcode;
        var salesUnitCode = null;
        var salesUnitQty  = 1;

        if (bc.userfields && bc.userfields.supplier_unit_code) {
            salesUnitCode = bc.userfields.supplier_unit_code;
            salesUnitQty  = parseFloat(bc.userfields.supplier_unit_qty) || 1;
        } else if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
            var su = bc._hoka.salesUnits.find(function(u) { return u.isDefault; }) || bc._hoka.salesUnits[0];
            if (su) { salesUnitCode = su.code; salesUnitQty = su.quantity || 1; }
        }

        // Hvis vi stadig ingen salesUnitCode har, hent produktdata fra Hoka
        if (!salesUnitCode) {
            try {
                var prodData = await fetchHokaProduct(varenummer);
                if (prodData && prodData.salesUnits && prodData.salesUnits.length > 0) {
                    var defUnit = prodData.salesUnits.find(function(u) { return u.isDefault; }) || prodData.salesUnits[0];
                    salesUnitCode = defUnit.code;
                    salesUnitQty = defUnit.quantity || 1;
                }
            } catch (e) { console.warn('[bestilling] Kunne ikke hente produkt-data for', varenummer, e.message); }
        }

        await putHokaBasket([{
            varenummer:        varenummer,
            quantity:          entry.qty,
            salesUnitCode:     salesUnitCode || 'st',
            salesUnitQuantity: salesUnitQty,
        }]);

        entry.inCart = true;
        entry.cartBusy = false;
        var price = bc.last_price ? parseFloat(bc.last_price) * entry.qty : null;
        _bsCart.push({
            productName: entry.product.name,
            packName: _bsPackName(bc),
            qty: entry.qty,
            price: price,
            entry: entry,
        });
        _bsToast(entry.product.name + ' lagt i kurv', 'ok');
        _bsRenderOrderView();
    } catch (err) {
        entry.cartBusy = false;
        _bsToast('Fejl: ' + err.message, 'err');
        _bsRenderOrderView();
    }
}

/* ── Cart sidebar ────────────────────────────────────────── */

function _bsRenderCartSidebar(group) {
    var cart = document.createElement('div');
    cart.className = 'bs-bside';

    var hdr = document.createElement('div');
    hdr.className = 'bs-bhdr';
    hdr.innerHTML = 'Kurv til ' + _bsEsc(group.displayName) + ' <span style="font-size:11px;font-weight:400;color:var(--color-text-dim,#777)">' + _bsCart.length + ' vare' + (_bsCart.length !== 1 ? 'r' : '') + '</span>';
    cart.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'bs-bbody';
    if (_bsCart.length === 0) {
        body.innerHTML = '<div class="bs-bempty">Ingen varer lagt i kurv endnu</div>';
    } else {
        var total = 0;
        for (var i = 0; i < _bsCart.length; i++) {
            var ci = _bsCart[i];
            var row = document.createElement('div');
            row.className = 'bs-birow';
            row.innerHTML =
                '<div class="bs-bdot"></div>' +
                '<div class="bs-bname">' + _bsEsc(ci.productName) + (ci.packName ? ' ' + _bsEsc(ci.packName) : '') + '</div>' +
                '<div class="bs-bqty">' + ci.qty + ' stk</div>';
            body.appendChild(row);
            if (ci.price != null) total += ci.price;
        }
    }
    cart.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'bs-bfoot';
    var totalVal = 0;
    for (var t = 0; t < _bsCart.length; t++) { if (_bsCart[t].price) totalVal += _bsCart[t].price; }
    foot.innerHTML =
        '<div class="bs-btr">Estimeret <span>' + (totalVal > 0 ? 'ca. ' + totalVal.toFixed(0) + ' kr' : '—') + '</span></div>';

    var goBtn = document.createElement('button');
    goBtn.className = 'bs-ghoka';
    goBtn.textContent = 'Gå til kurv på hoka.dk';
    goBtn.disabled = _bsCart.length === 0;
    goBtn.addEventListener('click', function() { _bsFinishOrder(group); });
    foot.appendChild(goBtn);

    var favBtn = document.createElement('button');
    favBtn.className = 'bs-gfav';
    favBtn.textContent = 'Se favoritter på hoka.dk';
    favBtn.addEventListener('click', function() { window.open('https://www.hoka.dk/da-dk/favorites', '_blank'); });
    foot.appendChild(favBtn);

    cart.appendChild(foot);
    return cart;
}

/* ── Finish order ────────────────────────────────────────── */

async function _bsFinishOrder(group) {
    if (_bsCart.length === 0 || _bsBusy) return;
    _bsBusy = true;
    try {
        var lines = _bsCart.map(function(ci) {
            var bc = ci.entry.selectedBarcode;
            return {
                grocy_product_id: ci.entry.product.id,
                grocy_shopping_list_id: ci.entry.item.id,
                supplier_sku: bc ? bc.barcode : null,
                product_name: ci.productName,
                quantity_ordered: ci.qty,
                price_per_pack: bc && bc.last_price ? parseFloat(bc.last_price) : null,
            };
        });

        await createPendingOrder({
            supplier_id: group.supplierId,
            supplier_name: group.supplierName,
            grocy_location_id: parseInt(group.grocyLocationId) || null,
            sent_via: 'api',
            items: lines,
        });

        for (var i = 0; i < _bsCart.length; i++) {
            // Opdater ALLE shopping_list items for dette produkt (kan være aggregeret fra flere)
            var slItems = _bsCart[i].entry.allItems || [_bsCart[i].entry.item];
            for (var si = 0; si < slItems.length; si++) {
                try {
                    await updateShoppingListItem(slItems[si].id, {
                        userfields: {
                            ordered_at: new Date().toISOString(),
                            ordered_qty: _bsCart[i].qty,
                            ordered_supplier: group.supplierName,
                            ordered_varenr: _bsCart[i].entry.selectedBarcode ? _bsCart[i].entry.selectedBarcode.barcode : '',
                        },
                    });
                } catch (e) { console.warn('[bestilling] Kunne ikke opdatere shopping list item:', e.message); }
            }
        }

        window.open('https://www.hoka.dk/da-dk/checkout', '_blank');
        _bsToast('Ordre oprettet — godkend på hoka.dk', 'ok');
        _bsCart = [];
        _bsCurrentGroup = null;
        await _bsLoadData();
        _bsBuildSupplierGroups();
        _bsRender();
    } catch (err) {
        _bsToast('Fejl ved ordre: ' + err.message, 'err');
    } finally {
        _bsBusy = false;
    }
}

/* ── External order view (webshop / email) ───────────────── */

function _bsRenderExternalOrderView(group) {
    var wrap = document.createElement('div');

    // Vis kobling-info for ukoblede leverandører
    if (group.integrationType === 'none') {
        var setupInfo = document.createElement('div');
        setupInfo.style.cssText = 'background:var(--brand-primary-light,#f1e6b2);border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
        setupInfo.innerHTML =
            '<span>⚙️</span>' +
            '<span style="flex:1;">Denne lokation er ikke koblet til en leverandør. ' +
            'Du kan stadig se varerne og kopiere listen til mail.</span>';
        var setupBtn = document.createElement('button');
        setupBtn.style.cssText = 'background:var(--brand-primary);color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;';
        setupBtn.textContent = 'Kobl leverandør';
        setupBtn.addEventListener('click', function() {
            _bsCurrentGroup = null;
            _bsRender();
            setTimeout(_bsOpenSetupModal, 100);
        });
        setupInfo.appendChild(setupBtn);
        wrap.appendChild(setupInfo);
    }

    var actions = document.createElement('div');
    actions.className = 'bs-external-actions';
    if (group.webshopUrl) {
        var webBtn = document.createElement('a');
        webBtn.className = 'bs-external-btn bs-external-btn--webshop';
        webBtn.textContent = '🌐 Åbn webshop';
        webBtn.href = group.webshopUrl;
        webBtn.target = '_blank';
        actions.appendChild(webBtn);
    }
    var copyBtn = document.createElement('button');
    copyBtn.className = 'bs-external-btn bs-external-btn--copy';
    copyBtn.textContent = '📋 Kopiér til mail';
    copyBtn.addEventListener('click', function() { _bsCopyToClipboard(group); });
    actions.appendChild(copyBtn);
    if (group.contactEmail) {
        var mailBtn = document.createElement('a');
        mailBtn.className = 'bs-external-btn bs-external-btn--copy';
        mailBtn.textContent = '📧 Send mail';
        mailBtn.href = 'mailto:' + group.contactEmail + '?subject=Bestilling%20Ristet%20Rug&body=' + encodeURIComponent(_bsBuildOrderText(group));
        actions.appendChild(mailBtn);
    }
    wrap.appendChild(actions);

    var sec = document.createElement('div');
    sec.className = 'bs-section-header';
    sec.textContent = 'Varer (' + group.items.length + ')';
    wrap.appendChild(sec);

    for (var i = 0; i < group.items.length; i++) {
        var entry = group.items[i];
        var row = document.createElement('div');
        row.className = 'bs-oitem';
        row.innerHTML =
            '<div class="bs-oim">' +
                '<div class="bs-oi"><div class="bs-on">' + _bsEsc(entry.product.name) + '</div></div>' +
                '<span class="bs-qv">' + entry.qty + ' ' + _bsEsc(entry.needUnit) + '</span>' +
            '</div>';
        wrap.appendChild(row);
    }

    var poBtn = document.createElement('button');
    poBtn.className = 'bs-ghoka';
    poBtn.style.cssText = 'margin:16px 0;max-width:300px;';
    poBtn.textContent = 'Registrér bestilling';
    poBtn.addEventListener('click', function() { _bsRegisterExternalOrder(group); });
    wrap.appendChild(poBtn);

    return wrap;
}

function _bsBuildOrderText(group) {
    var lines = ['Bestilling fra Ristet Rug', ''];
    for (var i = 0; i < group.items.length; i++) {
        var e = group.items[i];
        lines.push(e.qty + ' ' + e.needUnit + '  ' + e.product.name);
    }
    return lines.join('\n');
}

function _bsCopyToClipboard(group) {
    navigator.clipboard.writeText(_bsBuildOrderText(group)).then(function() {
        _bsToast('Kopieret til udklipsholder', 'ok');
    }).catch(function() { _bsToast('Kunne ikke kopiere', 'err'); });
}

async function _bsRegisterExternalOrder(group) {
    if (_bsBusy) return;
    _bsBusy = true;
    try {
        await createPendingOrder({
            supplier_id: group.supplierId,
            supplier_name: group.supplierName,
            grocy_location_id: parseInt(group.grocyLocationId) || null,
            sent_via: group.integrationType,
            items: group.items.map(function(e) {
                return { grocy_product_id: e.product.id, grocy_shopping_list_id: e.item.id, product_name: e.product.name, quantity_ordered: e.qty };
            }),
        });
        _bsToast('Bestilling registreret', 'ok');
        _bsCurrentGroup = null;
        await _bsLoadData();
        _bsBuildSupplierGroups();
        _bsRender();
    } catch (err) { _bsToast('Fejl: ' + err.message, 'err'); }
    finally { _bsBusy = false; }
}

/* ── Utilities ───────────────────────────────────────────── */

function _bsEsc(str) {
    if (!str) return '';
    var el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

function _bsToast(msg, type) {
    var toast = document.createElement('div');
    toast.className = 'bs-toast bs-toast--' + (type || 'ok');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3000);
}
