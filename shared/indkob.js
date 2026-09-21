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
var _ibProductGroups   = {};   // grocy product_group id → name (kategori)

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

// Purchase orders
var _ibPendingOrders   = [];
var _ibMailThreadOpen  = null;  // PO id with open mail thread
var _ibMailThreadData  = {};    // PO id → { thread, messages }
var _ibSupMailOpen     = null;  // groupKey with open supplier mail thread
var _ibSupMailData     = {};    // groupKey → { supplier, thread, messages }
var _ibSupMailUnread   = {};    // groupKey → unread_count
var _ibSupMailCompose  = {};    // groupKey → { subject } draft

// UI state
var _ibOpenGroups      = {};
var _ibCartItems       = [];
var _ibShowOrdered     = {};
var _ibPanelOpen       = null;  // 'missing'|'expiring'|null
var _ibLinkPanelId     = null;
/* Det man har tastet i kobl-panelet, holdt uden for DOM'en. _ibRender() bygger
   hele listen forfra — og efterslæbet (snapshots, favoritter, leverandørpost)
   udløser en render sekunder efter at panelet er åbnet. Uden dette forsvinder
   teksten mens man skriver; fokus og markør blev gendannet, men ikke værdien. */
var _ibLinkDraft       = {};
/* Bestillingsteksten — sådan hedder varen hos DENNE leverandør. Gemmes på
   stregkodens `note` og er det bestillingsmailen skriver; varenummeret kan
   være vores eget interne, som leverandøren ikke kender. Samme grund til at
   den bor uden for DOM'en som varenr-draften ovenfor. */
var _ibLinkNoteDraft   = {};
/* Sat når panelet retter et EKSISTERENDE varenummer (chippens ✎) i stedet for
   at lægge et nyt til. Holder barcode-id'et, ikke produktets. */
var _ibLinkEditBcId    = null;
var _ibMoOpen          = null;
var _ibBusy            = false;
var _ibFocusGroup      = null;  // grocy_location_id in focus mode
var _ibFocusMode       = false;
var _ibSearchTerm      = '';
var _ibToastTimer      = null;
var _ibSSE             = null;
var _ibViewMode        = 'combined';  // 'combined' (efter kategori) | 'order' (efter leverandør)

/* Kaldes af view-switcheren når indkøbslisten forlades. Slipper containeren,
   så igangværende async-arbejde ikke skriver i den næste visning. */
function cleanupIndkob() {
    _ibContainer = null;
}

/* ── Init ──────────────────────────────────────────────────── */
async function initIndkob(el) {
    _ibContainer = el;
    try {
        var savedView = localStorage.getItem('ib_view_mode');
        if (savedView === 'combined' || savedView === 'order') _ibViewMode = savedView;
    } catch (e) { /* localStorage utilgængelig — behold default */ }
    _ibShowLoading();

    try {
        await _ibLoadAll();
        _ibBuildGroups();

        // Bind event delegation once
        _ibContainer.addEventListener('click', _ibHandleClick);
        _ibContainer.addEventListener('input', _ibHandleInput);
        _ibContainer.addEventListener('change', _ibHandleInput);
        _ibContainer.addEventListener('keydown', _ibHandleKeydown);

        _ibRender();

        // Non-blocking enrichment
        _ibEnrichSnapshots();
        _ibLoadFavCache();
        _ibLoadVolatile();

        // Load supplier-mail unread overview (non-blocking)
        _ibLoadSupMailOverview().then(function() {
            _ibRender();
            // Auto-open supplier mail panel if URL has ?supplier_mail=<id>
            try {
                var qs = new URLSearchParams(window.location.search);
                var supParam = qs.get('supplier_mail');
                if (supParam) {
                    var targetId = parseInt(supParam);
                    for (var key in _ibGroups) {
                        if (_ibGroups[key].supplierId === targetId) {
                            _ibOpenGroups[key] = true;
                            _ibToggleSupMail(key);
                            break;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        });

        // SSE for PO mail + supplier mail events.
        //
        // Guarden er ikke pyntet: initIndkob() kaldes forfra HVER gang office
        // skifter til Indkøb-visningen (office/index.html), og hver gang
        // purchasing.html mounter fanen. Uden guarden stablede hvert skift en
        // ny stream ovenpå den forrige, som aldrig blev lukket. Lytterne herunder
        // læser kun modul-globals (_ibContainer m.fl.), som initIndkob opdaterer
        // — så den eksisterende forbindelse kan trygt genbruges mod en ny
        // container. manageSSE() lukker den ved navigation.
        if (!_ibSSE) {
            _ibSSE = manageSSE(function() {
                var es = new EventSource('/api/sse');
                es.addEventListener('po_mail_received', function(e) {
                    var data = JSON.parse(e.data);
                    _ibHandlePoMail(data);
                });
                es.addEventListener('po_mail_sent', function(e) {
                    var data = JSON.parse(e.data);
                    _ibHandlePoMail(data);
                });
                es.addEventListener('supplier_mail_received', function(e) {
                    var data = JSON.parse(e.data);
                    _ibHandleSupplierMailEvent(data);
                });
                es.addEventListener('supplier_mail_sent', function(e) {
                    var data = JSON.parse(e.data);
                    _ibHandleSupplierMailEvent(data);
                });
                return es;
            });
        }
    } catch (err) {
        console.error('[indkob] init fejl:', err);
        if (!_ibContainer) return;
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
        fetchGrocyProductGroups().catch(function() { return []; }),
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

    // Product groups → map (kategori-navne til Samlet liste)
    var pgArr = results[7] || [];
    _ibProductGroups = {};
    for (var pg = 0; pg < pgArr.length; pg++) {
        _ibProductGroups[pgArr[pg].id] = pgArr[pg].name;
    }

    // Load pending orders (non-blocking — don't fail init if this errors)
    try {
        _ibPendingOrders = await fetchPendingOrders() || [];
    } catch (e) {
        console.warn('[indkob] PO-load fejl:', e.message);
        _ibPendingOrders = [];
    }
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

    // Collect all hoka barcodes (by shopping_location OR numeric barcode format)
    var hokaIds = [];
    var seen = {};
    for (var key in _ibGroups) {
        var g = _ibGroups[key];
        for (var i = 0; i < g.items.length; i++) {
            var entry = g.items[i];
            for (var b = 0; b < entry.barcodes.length; b++) {
                var bc = entry.barcodes[b];
                var id = String(bc.barcode);
                if (seen[id]) continue;
                // Include if it's on a Hørkram location OR is a pure numeric barcode (likely Hørkram varenr)
                if (_ibIsHokaBarcode(bc) || /^\d{4,9}$/.test(id)) {
                    hokaIds.push(id);
                    seen[id] = true;
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

    // Check dropsize for api groups (non-blocking, after DOM is ready)
    setTimeout(function() { _ibCheckDropsize(); }, 100);
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
                // Label-opløsning: koblings-display-navn → Grocy lokationsnavn → leverandørnavn
                displayName: handler ? (handler.grocy_location_display_name || (loc ? loc.name : null) || handler.supplier_name) : (loc ? loc.name : 'Uden leverandør'),
                channelName: loc ? loc.name : null,
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

    // Match pending orders to groups by grocy_location_id
    for (var gk2 in _ibGroups) {
        var grp = _ibGroups[gk2];
        grp.pendingOrders = _ibPendingOrders.filter(function(po) {
            return String(po.grocy_location_id) === String(gk2);
        });
        // Calculate total unread mail across POs
        grp.totalUnreadMail = 0;
        for (var pi = 0; pi < grp.pendingOrders.length; pi++) {
            grp.totalUnreadMail += (grp.pendingOrders[pi].unread_mail || 0);
        }
    }

    // Kurven holdt referencer til de GAMLE entry-objekter; en rebuild (fx via
    // indkommende leverandør-mail over SSE) laver nye entries, så de gamle
    // referencer bliver forældede og "Gå til kurv" finder ingenting. Re-bind
    // kurven til de nye entries via product.id, så identitets-opslagene virker.
    _ibReconcileCart();
}

/* Re-bind _ibCartItems til de aktuelle entry-objekter (nøglet på product.id). */
function _ibReconcileCart() {
    if (!_ibCartItems || !_ibCartItems.length) return;
    var wanted = {};
    _ibCartItems.forEach(function(e) { if (e && e.product) wanted[e.product.id] = true; });
    var fresh = [];
    for (var gk in _ibGroups) {
        var its = _ibGroups[gk].items;
        for (var i = 0; i < its.length; i++) {
            var ent = its[i];
            if (ent.product && wanted[ent.product.id]) {
                ent.inCart = true;
                fresh.push(ent);
            }
        }
    }
    _ibCartItems = fresh;
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
        return GrocyNum.num(bc.userfields.pack_size_stock_unit) || 1;
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
    if (!_ibContainer) return;
    _ibContainer.innerHTML = '<div class="ib-loading"><div class="ib-loading-spinner"></div><div>Indlæser indkøbsliste...</div></div>';
}

function _ibRender() {
    // Afmonteret? Så hører vi ikke længere til i containeren. initIndkob's
    // efterslæb (snapshots, favoritter, leverandørpost, SSE) fyrer LÆNGE efter
    // at brugeren kan have skiftet visning — og contentEl genbruges af alle
    // office-views, så en sen render ville overskrive den visning der står der nu.
    if (!_ibContainer) return;
    var html = '';

    // Toolbar
    html += _ibRenderToolbar();

    // Panels (Manglende / Udløbende)
    html += _ibRenderPanels();

    if (_ibViewMode === 'combined') {
        // ── Samlet liste — grupperet efter produktkategori ──────
        html += _ibRenderCombined();
    } else {
        // ── Klar til bestilling — leverandørgrupper ─────────────
        // Sort groups: api first, then email/manual/webshop, then intern, then none
        var groupKeys = Object.keys(_ibGroups);
        var typeOrder = { api: 0, email: 1, webshop: 1, manual: 2, intern: 3, none: 4 };
        groupKeys.sort(function(a, b) {
            var ga = _ibGroups[a], gb = _ibGroups[b];
            var oa = ga.integrationType in typeOrder ? typeOrder[ga.integrationType] : 4;
            var ob = gb.integrationType in typeOrder ? typeOrder[gb.integrationType] : 4;
            if (oa !== ob) return oa - ob;
            return (ga.displayName || '').localeCompare(gb.displayName || '', 'da');
        });

        // Quick-jump strip — gør det nemt at finde leverandør-grupper når der er mange
        if (groupKeys.length > 2) {
            html += '<div class="ib-jump-strip">';
            for (var qj = 0; qj < groupKeys.length; qj++) {
                var qg = _ibGroups[groupKeys[qj]];
                var unreadBadge = _ibSupMailUnread[groupKeys[qj]] || 0;
                var icoCls = qg.integrationType || 'manual';
                html += '<button class="ib-jump-pill ib-jp-' + icoCls + '" data-ib="jump-to" data-group="' + groupKeys[qj] + '">';
                html += '<span class="ib-jp-name">' + _ibEsc(qg.displayName || qg.supplierName || '?') + '</span>';
                if (unreadBadge > 0) html += '<span class="ib-jp-mail">' + mailIcon(11) + ' ' + unreadBadge + '</span>';
                html += '</button>';
            }
            html += '</div>';
        }

        // Content
        html += '<div class="ib-content">';

        if (groupKeys.length === 0 && _ibShoppingList.length === 0) {
            html += '<div class="ib-empty"><div class="ib-empty-icon">🛒</div>'
                + '<div class="ib-empty-title">Indkøbslisten er tom</div>'
                + '<div class="ib-empty-sub">Tilføj varer via Manglende-panelet eller "+ Tilføj vare"</div></div>';
        }

        for (var gi = 0; gi < groupKeys.length; gi++) {
            html += _ibRenderGroup(groupKeys[gi]);
        }

        html += '</div>'; // .ib-content
    }

    // Sticky bund-bar — vises i begge grupperinger
    html += _ibRenderBottomBar();

    // Preserve scroll position + input-fokus under re-render
    var scrollY = window.scrollY;
    var fa = document.activeElement;
    var focusSel = null, selStart = 0, selEnd = 0;
    if (fa && _ibContainer.contains(fa) && (fa.tagName === 'INPUT' || fa.tagName === 'TEXTAREA')) {
        var dib = fa.getAttribute('data-ib');
        var dpid = fa.getAttribute('data-product-id');
        if (dib) {
            focusSel = '[data-ib="' + dib + '"]' + (dpid ? '[data-product-id="' + dpid + '"]' : '');
        } else if (fa.id) {
            focusSel = '#' + fa.id;
        }
        try { selStart = fa.selectionStart; selEnd = fa.selectionEnd; } catch (e) { /* number input */ }
    }

    _ibContainer.innerHTML = html;
    window.scrollTo(0, scrollY);

    if (focusSel) {
        var fel = _ibContainer.querySelector(focusSel);
        if (fel) {
            fel.focus();
            try { fel.setSelectionRange(selStart, selEnd); } catch (e) { /* number input */ }
        }
    }

    // Bind link result buttons (dynamic, can't use delegation)
    _ibContainer.querySelectorAll('[data-ib="lp-results"] [data-ib="lp-link"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var varenr = this.getAttribute('data-varenr');
            var name = this.getAttribute('data-name');
            var pid = this.closest('[data-lp-product]').getAttribute('data-lp-product');
            // Hørkram-resultat ⇒ Hørkram-lokationen (se _ibRenderLinkPanel).
            _ibLinkBarcode(parseInt(pid), varenr, name, _ibHokaLocationId());
        });
    });

    // Hydrér mail-historik via fælles MailThread-komponent
    _ibHydrateMail();
}

/* Fyld mail-historik-placeholders (PO- og leverandør-tråde) med
   den fælles MailThread-komponent efter _ibRender's innerHTML. */
function _ibHydrateMail() {
    if (typeof MailThread === 'undefined') return;
    _ibContainer.querySelectorAll('.ib-mail-host[data-mt-messages]').forEach(function(el) {
        var msgs = [];
        try { msgs = JSON.parse(decodeURIComponent(el.dataset.mtMessages)); } catch (e) { /* tom */ }
        el.removeAttribute('data-mt-messages');
        MailThread.renderHistory(el, { messages: msgs, emptyText: 'Ingen beskeder endnu' });
    });
    _ibContainer.querySelectorAll('.ib-sig-hint').forEach(function(el) {
        MailThread.renderSignatureHint(el);
    });
}

/* ── Efter kategori (combined view) ────────────────────────────
   Samme handlingsbare rækker som leverandør-grupperingen, men grupperet
   efter produktkategori (Grocy product_group). Brugeren kan lægge i kurv,
   markere og koble herfra — det er ikke et separat tjek-view. */
function _ibRenderCombined() {
    // Flad liste af ikke-bestilte varer på tværs af alle grupper
    var entries = [];
    for (var gk in _ibGroups) {
        var gItems = _ibGroups[gk].items;
        for (var i = 0; i < gItems.length; i++) {
            if (!gItems[i].isOrdered) entries.push(gItems[i]);
        }
    }

    // Søgefilter
    if (_ibSearchTerm) {
        var q = _ibSearchTerm.toLowerCase();
        entries = entries.filter(function(e) {
            return (e.product.name || '').toLowerCase().indexOf(q) >= 0;
        });
    }

    var html = '<div class="ib-content ib-combined">';

    if (entries.length === 0) {
        html += '<div class="ib-empty"><div class="ib-empty-icon">🛒</div>'
            + '<div class="ib-empty-title">'
            + (_ibSearchTerm ? 'Ingen varer matcher søgningen' : 'Indkøbslisten er tom')
            + '</div>'
            + '<div class="ib-empty-sub">Tilføj varer via Manglende-panelet eller "+ Tilføj vare"</div></div>';
        html += '</div>';
        return html;
    }

    // Grupper efter produktkategori
    var cats = {};
    for (var j = 0; j < entries.length; j++) {
        var cat = _ibProductGroups[entries[j].product.product_group_id] || 'Uden kategori';
        if (!cats[cat]) cats[cat] = [];
        cats[cat].push(entries[j]);
    }
    var catNames = Object.keys(cats).sort(function(a, b) {
        if (a === 'Uden kategori') return 1;
        if (b === 'Uden kategori') return -1;
        return a.localeCompare(b, 'da');
    });

    for (var c = 0; c < catNames.length; c++) {
        var list = cats[catNames[c]];
        list.sort(function(a, b) {
            return (a.product.name || '').localeCompare(b.product.name || '', 'da');
        });
        html += '<div class="ib-cmb-cat">' + _ibEsc(catNames[c])
            + ' <span class="ib-cmb-cat-n">' + list.length + '</span></div>';
        html += '<div class="ib-cmb-cat-items">';
        for (var k = 0; k < list.length; k++) {
            var ent = list[k];
            var supGroup = _ibGroups[_ibFindGroupForEntry(ent)];
            // Genbrug den fulde handlingsrække — showSupplier=true viser leverandør-tag
            html += _ibRenderItem(ent, supGroup, true);
        }
        html += '</div>';
    }

    html += '</div>'; // .ib-content
    return html;
}

function _ibRenderToolbar() {
    var missingN = _ibMissingProducts.length;
    var dueN = _ibDueProducts.length;

    var h = '<div class="ib-toolbar">';
    h += '<input class="ib-search" placeholder="Søg vare..." data-ib="search" value="' + _ibEsc(_ibSearchTerm) + '">';
    h += '<div class="ib-sep"></div>';
    h += '<button class="ib-btn primary" data-ib="add-product">+ Tilføj vare</button>';
    h += '<button class="ib-btn" data-ib="open-create" title="Kun hvis varen ikke findes via søgning — opret en ny Grocy-vare eller kobl et Hørkram-varenummer">+ Opret/kobl</button>';
    h += '<button class="ib-btn" data-ib="toggle-missing">📉 Manglende ';
    h += missingN ? '<span class="ib-nb ib-nb-or">' + missingN + '</span>' : '';
    h += '</button>';
    h += '<button class="ib-btn" data-ib="toggle-expiring">⏰ Udløbende ';
    h += dueN ? '<span class="ib-nb ib-nb-rd">' + dueN + '</span>' : '';
    h += '</button>';
    h += '<div class="ib-right">';
    // Fokus er en underfunktion af "Klar til bestilling" — vises kun i det view
    if (_ibViewMode === 'order') {
        if (_ibFocusMode) {
            h += '<button class="ib-focus-back" style="display:flex" data-ib="focus-back">‹ Alle leverandører</button>';
        }
        h += '<div class="ib-view-toggle ib-focus-toggle">';
        h += '<button class="ib-vt' + (!_ibFocusMode ? ' on' : '') + '" data-ib="view-list">≡ Liste</button>';
        h += '<button class="ib-vt' + (_ibFocusMode ? ' on' : '') + '" data-ib="view-focus">⊡ Fokus</button>';
        h += '</div>';
    }
    // Primær akse: samme liste, to grupperinger
    h += '<div class="ib-view-toggle">';
    h += '<button class="ib-vt' + (_ibViewMode === 'combined' ? ' on' : '') + '" data-ib="view-combined">Efter kategori</button>';
    h += '<button class="ib-vt' + (_ibViewMode === 'order' ? ' on' : '') + '" data-ib="view-order">Efter leverandør</button>';
    h += '</div></div></div>';
    return h;
}

function _ibRenderPanels() {
    var h = '';

    // Add product panel — øverst, lige under toolbaren, så feltet er nemt at nå
    if (_ibPanelOpen === 'add-product') {
        h += '<div class="ib-panel open" data-ib-panel="add-product">';
        h += '<div class="ib-panel-inner">';
        h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">';
        h += '<div style="position:relative;flex:1">';
        h += '<input class="ib-panel-qi" style="width:100%;padding:8px 10px;font-size:13px" id="ibAddProdQ" placeholder="Søg Grocy-produkt..." data-ib="add-product-search">';
        h += '<div id="ibAddProdAC" class="ib-add-ac" style="display:none"></div>';
        h += '</div>';
        h += '<input class="ib-panel-qi" type="number" min="1" value="1" style="width:60px;text-align:center" id="ibAddProdQty">';
        h += '<button class="ib-panel-add" data-ib="add-product-confirm" style="white-space:nowrap">Tilføj</button>';
        h += '</div>';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">';
        h += '<div id="ibAddProdSel" style="font-size:12px;color:var(--color-text-dim,#777)">Søg efter produktnavn...</div>';
        h += '<a href="/kitchen/stock.html?tab=create" target="_blank" rel="noopener" style="font-size:12px;color:var(--brand-primary,#8e631f);text-decoration:none;font-weight:600;white-space:nowrap">+ Opret nyt produkt</a>';
        h += '</div>';
        h += '</div></div>';
    }

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
            h += '<div class="ib-panel-meta">Min: ' + _ibFmtNum(minStock) + ' · Lager: ' + _ibFmtNum(parseFloat(mp.amount) || 0);
            if (locName) h += ' · ' + _ibEsc(locName);
            h += '</div></div>';
            h += '<div class="ib-panel-qc"><span class="ib-panel-qlabel" title="Antal enheder at tilføje til indkøbslisten">Antal enheder</span>';
            h += '<button class="ib-panel-qb" data-ib="panel-minus" data-idx="' + m + '">−</button>';
            h += '<input class="ib-panel-qi" type="number" value="' + suggest + '" min="1" data-idx="' + m + '">';
            h += '<button class="ib-panel-qb" data-ib="panel-plus" data-idx="' + m + '">+</button>';
            h += '<button class="ib-panel-rowadd" data-ib="add-panel-row" data-panel="missing" data-idx="' + m + '" data-product-id="' + prod.id + '" title="Tilføj denne vare til indkøbslisten">+ Tilføj</button>';
            h += '</div></div>';
        }
        h += '</div>';
        h += '<div class="ib-panel-foot">';
        h += '<span class="ib-panel-selall" data-ib="selall-missing">Fravælg alle</span>';
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
            h += '<div class="ib-panel-meta">Udløber: ' + (dp.best_before_date || '?') + ' · Lager: ' + _ibFmtNum(parseFloat(dp.amount) || 0) + '</div></div>';
            h += '<div class="ib-panel-qc"><span class="ib-panel-qlabel" title="Antal enheder at tilføje til indkøbslisten">Antal enheder</span>';
            h += '<button class="ib-panel-qb" data-ib="panel-minus" data-idx="' + d + '">−</button>';
            h += '<input class="ib-panel-qi" type="number" value="1" min="1" data-idx="' + d + '">';
            h += '<button class="ib-panel-qb" data-ib="panel-plus" data-idx="' + d + '">+</button>';
            h += '<button class="ib-panel-rowadd" data-ib="add-panel-row" data-panel="expiring" data-idx="' + d + '" data-product-id="' + dprod.id + '" title="Tilføj denne vare til indkøbslisten">+ Tilføj</button>';
            h += '</div></div>';
        }
        h += '</div>';
        h += '<div class="ib-panel-foot">';
        h += '<span class="ib-panel-selall" data-ib="selall-expiring">Fravælg alle</span>';
        h += '<button class="ib-panel-cancel" data-ib="close-expiring">Luk</button>';
        h += '<button class="ib-panel-add rd" data-ib="add-expiring">Tilføj valgte til listen</button>';
        h += '</div></div>';
    }

    return h;
}

function _ibRenderPanelBadges() {
    if (!_ibContainer) return;
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

    // Count, estimate price, and CO2
    var estTotal = 0;
    var co2Total = 0;
    for (var r = 0; r < readyItems.length; r++) {
        estTotal += _ibPackPrice(readyItems[r].selectedBarcode, readyItems[r].qty);
        var hoka = readyItems[r].selectedBarcode && readyItems[r].selectedBarcode._hoka;
        if (hoka && hoka.co2e) co2Total += hoka.co2e * (readyItems[r].qty || 1);
    }

    // Icon
    var icoClass = g.integrationType || 'manual';
    var icoLabel = g.displayName.substring(0, 2).toUpperCase();

    var h = '<div class="ib-group' + (hidden ? ' style="display:none"' : '') + (_ibFocusMode && _ibFocusGroup === key ? ' ib-focused' : '') + '" data-group="' + key + '">';

    // Header
    h += '<div class="ib-group-hdr" data-ib="group-toggle" data-group="' + key + '">';
    h += '<div class="ib-group-ico ' + icoClass + '">' + icoLabel + '</div>';
    h += '<div class="ib-group-inf"><div class="ib-group-name">' + _ibEsc(g.displayName) + '</div>';
    // Kanal-undertekst: vis leverandør + Grocy-kanal når de afviger fra header-labelen
    if (g.grocyLocationId !== '__none__' && g.integrationType !== 'none') {
        var chanBits = [];
        if (g.supplierName && g.displayName !== g.supplierName) chanBits.push('købes via ' + g.supplierName);
        if (g.channelName && g.channelName !== g.displayName) chanBits.push('kanal: ' + g.channelName);
        if (chanBits.length) h += '<div class="ib-group-channel">' + _ibEsc(chanBits.join(' · ')) + '</div>';
    }
    if (g.notes) h += '<div class="ib-group-note">' + _ibEsc(g.notes) + '</div>';
    h += '</div>';

    // Pills
    h += '<div class="ib-group-pills">';
    if (readyItems.length) h += '<span class="ib-sgp kl">' + readyItems.length + ' klar</span>';
    if (unmatchedItems.length) h += '<span class="ib-sgp um">' + unmatchedItems.length + ' umatched</span>';
    if (orderedItems.length) h += '<span class="ib-sgp bs">' + orderedItems.length + ' bestilt</span>';
    if (estTotal > 0) h += '<span class="ib-sgp es">ca. ' + Math.round(estTotal) + ' kr</span>';
    if (co2Total > 0) h += '<span class="ib-sgp co2">🌱 ' + co2Total.toFixed(1) + ' kg CO₂e</span>';
    var supUnread = _ibSupMailUnread[key] || 0;
    if (supUnread > 0) {
        h += '<span class="ib-sgp ib-sup-mail-pill" data-ib="toggle-sup-mail" data-group="' + key + '" title="' + supUnread + ' ulæst leverandør-mail">' + mailIcon(12) + ' ' + supUnread + '</span>';
    }
    h += '</div>';

    // Action buttons (Skriv mail + integration-specific action)
    if (g.supplierId) {
        h += '<button class="ib-group-mail-btn" data-ib="toggle-sup-mail" data-group="' + key + '" title="Skriv til leverandør">' + mailIcon(16) + '</button>';
    }
    h += _ibRenderGroupAction(g, key);

    h += '<div class="ib-group-chev' + (isOpen ? ' open' : '') + '">›</div>';
    h += '</div>'; // header

    // Body
    h += '<div class="ib-group-body' + (isOpen ? ' open' : '') + '" data-group-body="' + key + '">';

    // Supplier mail thread (always available — uafhængigt af integration_type)
    if (_ibSupMailOpen === key) {
        h += _ibRenderSupMailSection(g, key);
    }

    // Dropsize banner placeholder (filled async for api groups)
    if (g.integrationType === 'api') {
        h += '<div class="ib-dropsize" id="ibDropsize_' + key + '"></div>';
    }

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
        // Går en bestilling galt, skal den kunne rulles tilbage i ÉN handling.
        // Fortryd pr. vare lå bag denne kollapsede sektion: med 12 varer var det
        // 12 klik bag noget man først skulle finde — og indtil da kunne varerne
        // ikke bestilles igen.
        h += '<button class="ib-bs-undo" data-ib="undo-order-all" data-group="' + key + '"'
           + ' title="Sætter varerne tilbage på bestillingslisten">Fortryd alle</button>';
        if (g.totalUnreadMail > 0) {
            h += '<span class="ib-mail-badge" title="' + g.totalUnreadMail + ' ulæst mail">' + mailIcon(12) + ' ' + g.totalUnreadMail + '</span>';
        } else if (g.pendingOrders && g.pendingOrders.some(function(po) { return po.sent_via === 'email'; })) {
            h += '<span class="ib-mail-icon" title="Mail sendt">' + mailIcon(13) + '</span>';
        }
        h += '</div>';
        h += '<div class="ib-bs-section' + (showOrd ? ' open' : '') + '">';
        h += '<div class="ib-shdr">Bestilt</div>';
        for (var oi = 0; oi < orderedItems.length; oi++) {
            h += _ibRenderOrderedItem(orderedItems[oi]);
        }
        // PO mail threads (per PO with sent_via=email)
        if (g.pendingOrders) {
            for (var poi = 0; poi < g.pendingOrders.length; poi++) {
                var po = g.pendingOrders[poi];
                if (po.sent_via === 'email' && po.mail_thread_id) {
                    h += _ibRenderPoMailSection(po);
                }
            }
        }
        h += '</div>';
    }

    h += '</div>'; // body

    // Manual order dialog
    if (g.integrationType === 'email' || g.integrationType === 'manual') {
        h += _ibRenderManualDialog(g, key);
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
    // Fallback: gruppen er ikke koblet til en leverandør i Settings, men kurven
    // har items fra den (typisk pga. Hørkram-barcode på en vare). Vis en
    // synlig warning-knap så brugeren ikke står stille med en kurv der ikke
    // kan tømmes — klik åbner en modal med admin-instruks.
    var hasCartItems = (_ibCartItems || []).some(function(e) {
        return _ibFindGroupForEntry(e) === key;
    });
    if (hasCartItems) {
        return '<button class="ib-group-act warn" data-ib="cart-blocked" data-group="' + key + '">⚠ Kurv ikke klar →</button>';
    }
    return '';
}

/* ── Item render ───────────────────────────────────────────── */
function _ibRenderItem(entry, group, showSupplier) {
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
    if (showSupplier && group) {
        // "Mangler leverandør" = ingen shopping_location overhovedet (__none__).
        // En gruppe med lokation men uden V2-kobling har stadig en destination.
        var isNone = group.grocyLocationId === '__none__';
        h += '<span class="ib-item-sup' + (isNone ? ' warn' : '') + '">'
            + (isNone ? '⚠ mangler leverandør' : ('→ ' + _ibEsc(group.displayName))) + '</span>';
    }
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
            // Stjernen gør valget permanent. Uden den er et klik på chippen kun
            // for DENNE bestilling — og en leverandør uden pris i systemet
            // sorterer bagerst, så den ville skulle vælges forfra hver gang.
            h += '<button class="ib-cp-star' + (uf.is_preferred === '1' ? ' on' : '') + '"' +
                 ' data-ib="toggle-preferred" data-product-id="' + p.id + '" data-bc-id="' + bc.id + '"' +
                 ' title="' + (uf.is_preferred === '1' ? 'Fjern som foretrukken' : 'Gør til foretrukken leverandør for denne vare') + '">★</button>';
            h += '<button class="ib-cp-edit" data-ib="edit-varenr" data-product-id="' + p.id + '"' +
                 ' data-bc-id="' + bc.id + '" title="Ret eller fjern dette varenummer">✎</button>';
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

            // Hvem kan levere denne chip. Samme label-opløsning som gruppe-
            // headeren (visningsnavn → lokationsnavn), ellers stod der "Emballage"
            // over for "Hørkram" — og det er præcis dét man skal kunne skelne.
            var locName = _ibSupplierLabelForLocation(bc.shopping_location_id);
            if (locName && entry.barcodes.length > 1) {
                h += '<div class="ib-cp-meta">' + _ibEsc(locName) + '</div>';
            }

            h += '</div>';
        }
        // Et produkt kan købes hos flere — chips-rækken er bygget til det, men
        // indtil nu kunne man kun lægge det FØRSTE varenummer ind (kobl-panelet
        // fandtes kun på varer helt uden stregkode).
        h += '<button class="ib-chip-add" data-ib="open-link" data-product-id="' + p.id + '">+ Varenr.</button>';
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

        // Show "Læg i kurv" if group is api-type OR the selected barcode is a Hørkram barcode
        // _ibIsHokaBarcode checks shopping_location, _hoka checks enrichment data
        var canAddToCart = group.integrationType === 'api' ||
            (entry.selectedBarcode && (_ibIsHokaBarcode(entry.selectedBarcode) || entry.selectedBarcode._hoka));
        if (canAddToCart) {
            if (entry.inCart) {
                h += '<button class="ib-kb done">I kurv ✓</button>';
            } else {
                h += '<button class="ib-kb" data-ib="add-to-cart" data-product-id="' + p.id + '">Læg i kurv</button>';
            }
            if (entry._cartError) {
                h += '<div class="ib-cart-error">⚠ ' + _ibEsc(entry._cartError) + '</div>';
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
        // "Uden leverandør"-blok (ingen shopping_location): drawer-genvej.
        // Varer i en rigtig leverandørgruppe uden barcode beholder det inline
        // link-panel — det har INT-varenummer-generering som draweren ikke har.
        if (group.grocyLocationId === '__none__') {
            h += '<button class="ib-kb kobl" data-ib="open-couple" data-product-id="' + p.id + '">Kobl →</button>';
        } else {
            h += '<button class="ib-kb kobl" data-ib="open-link" data-product-id="' + p.id + '">Kobl varenr.</button>';
        }
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
        if (hoka.co2e) {
            badges.push('<span class="ib-badge co2">🌱 ' + hoka.co2e.toFixed(1) + ' kg CO₂e</span>');
        }
    }
    return badges;
}

/* ── Link panel ────────────────────────────────────────────── */
/*
 * To veje, fordi de fører til hver sit sted:
 *
 *  1. Hørkram-søgning  → nummeret hører til Hørkrams katalog, så stregkoden
 *     lægges på Hørkram-lokationen. Kun sådan kan varen lægges i deres kurv —
 *     også når produktet i øvrigt hører til en anden gruppe (fx Emballage).
 *  2. Leverandørens eget varenummer → lægges på DENNE gruppes lokation.
 *     Feltet er fri tekst: nogle leverandører har intet nummer, kun en fast
 *     betegnelse. Har de heller ikke det, laver Bon et internt (INT-nnnn).
 *
 * Bestillingsteksten er et FELT FOR SIG (stregkodens `note`), fordi den skal
 * i mailen mens et internt nummer ikke skal — se shared/supplier_order_lines.js.
 */
/* Varenummer og bestillingstekst ryddes ALTID sammen: de er to felter i det
   samme panel, og en efterladt note ville dukke op på næste vare man kobler. */
function _ibClearLinkDraft(productId) {
    delete _ibLinkDraft[productId];
    delete _ibLinkNoteDraft[productId];
}

function _ibRenderLinkPanel(entry) {
    var pid = entry.product.id;
    var group = _ibGroups[_ibFindGroupForEntry(entry)] || {};
    var supLabel = group.displayName || group.supplierName || 'denne leverandør';
    var isHokaGroup = group.integrationType === 'api';
    var hasHoka = !!_ibHokaLocationId();

    // Retter vi en eksisterende chip? Så hører nummeret til DEN chips leverandør,
    // ikke til gruppens — de kan være forskellige (Hørkram-nummer i Serviwet-gruppen).
    var editBc = null;
    if (_ibLinkEditBcId) {
        editBc = entry.barcodes.filter(function(b) { return b.id === _ibLinkEditBcId; })[0] || null;
    }
    if (editBc) {
        supLabel = _ibSupplierLabelForLocation(editBc.shopping_location_id) || supLabel;
    }

    var h = '<div class="ib-lp" data-lp-product="' + pid + '">';

    // ── Leverandørens eget varenummer ──
    h += '<div class="ib-lp-block">';
    h += '<div class="ib-lp-note"><b>' + (editBc ? 'Ret varenummer hos ' : 'Varenummer hos ') + _ibEsc(supLabel) + '</b>' +
         (editBc ? ' — deres eget nummer, eller det interne Bon har lavet.'
                 : ' — deres eget nummer. Har de ikke et, kan Bon lave et internt nedenfor.') +
         '</div>';
    h += '<div class="ib-lp-row">';
    h += '<input class="ib-lp-inp" placeholder="fx 4471 — eller lad Bon lave et internt nummer nedenfor"' +
         ' data-ib="lp-varenr" data-product-id="' + pid + '"' +
         ' value="' + _ibEsc(_ibLinkDraft[pid] || '') + '">';
    h += '<button class="ib-lp-btn" data-ib="lp-save-varenr" data-product-id="' + pid + '">Gem</button>';
    if (editBc) {
        h += '<button class="ib-lp-btn ghost" data-ib="lp-cancel-edit" data-product-id="' + pid + '">Annullér</button>';
    }
    h += '</div>';

    // Bestillingsteksten. Står under nummeret, fordi den er dét leverandøren
    // reelt bestiller efter — vores Grocy-navn ("Burgerlommer") kan ikke skelne
    // 11×11 fra 14×14 cm.
    h += '<div class="ib-lp-sub">Sådan hedder varen hos ' + _ibEsc(supLabel) + '</div>';
    h += '<div class="ib-lp-row">';
    h += '<input class="ib-lp-inp" placeholder="fx Burgerlommer, brune, 11 x 11 cm., pakke af 1.000 stk."' +
         ' data-ib="lp-note" data-product-id="' + pid + '"' +
         ' value="' + _ibEsc(_ibLinkNoteDraft[pid] || '') + '">';
    h += '</div>';
    h += '<div class="ib-lp-hint">Det er denne tekst der står i bestillingen — ikke varenummeret, ' +
         'hvis det er et Bon selv har lavet. Tom: så bruges varens navn i Grocy.</div>';

    h += '<div class="ib-lp-msg" data-ib="lp-msg" data-product-id="' + pid + '"></div>';
    h += '</div>';

    // Under redigering giver hverken katalog-søgning eller INT-generering mening
    // — begge ville lave et NYT nummer ved siden af det man er i gang med at rette.
    if (editBc) {
        // Sletningen står som en stille linje, ikke som en rød knap ved siden af
        // "Gem": den er sjældnere end at rette, og en fyldt rød knap dér læses som
        // hovedhandlingen. Den navngiver også sit eget omfang — "Fjern" alene kunne
        // lige så godt betyde varen eller hele linjen på indkøbslisten.
        h += '<div class="ib-lp-foot">Skal nummeret slet ikke stå her? ' +
             '<button class="ib-lp-link danger" data-ib="lp-delete-varenr" data-product-id="' + pid + '"' +
             ' data-bc-id="' + editBc.id + '">Fjern varenummeret hos ' + _ibEsc(supLabel) + '</button>' +
             '<div class="ib-lp-foot-sub">Varen bliver på indkøbslisten — den mister kun koblingen til ' + _ibEsc(supLabel) + '.</div>' +
             '</div>';
        h += '</div>';
        return h;
    }

    // ── Hørkram-katalog ── (kun når der ER en Hørkram-kobling at lægge det på)
    if (hasHoka) {
        h += '<div class="ib-lp-block">';
        h += '<div class="ib-lp-note">' +
             (isHokaGroup ? 'Slå op i ' + _ibEsc(_ibCatalogName()) + '-kataloget:'
                          : 'Køber du den hos ' + _ibEsc(_ibCatalogName()) + ' i stedet? Slå op i deres katalog:') +
             '</div>';
        h += '<div class="ib-lp-row">';
        h += '<input class="ib-lp-inp" placeholder="Søg produktnavn eller varenr. hos ' + _ibEsc(_ibCatalogName()) + '..."' +
             ' data-ib="lp-input" data-product-id="' + pid + '" value="' + _ibEsc(entry.product.name || '') + '">';
        h += '<button class="ib-lp-btn" data-ib="lp-search" data-product-id="' + pid + '">Søg</button>';
        h += '</div>';
        h += '<div data-ib="lp-results" data-product-id="' + pid + '"></div>';
        h += '</div>';
    }

    // ── Nødløsning ──
    h += '<div class="ib-lp-foot">Har ' + _ibEsc(supLabel) + ' ikke et varenummer? ' +
         '<button class="ib-lp-link" data-ib="lp-gen-int" data-product-id="' + pid + '">' +
         'Lav et internt nummer</button>' +
         '<div class="ib-lp-foot-sub">Kun til os — det kommer ikke med i bestillingen. ' +
         'Skriv teksten ovenfor først, så bruges den.</div></div>';

    h += '</div>';
    return h;
}

/* Leverandør-label for en Grocy-lokation: koblingens visningsnavn, ellers
   lokationens eget navn. Samme rækkefølge som _ibBuildGroups bruger. */
function _ibSupplierLabelForLocation(locId) {
    if (!locId) return '';
    for (var i = 0; i < _ibHandelssteder.length; i++) {
        var hs = _ibHandelssteder[i];
        if (String(hs.grocy_location_id) === String(locId)) {
            return hs.grocy_location_display_name || (_ibLocations[locId] ? _ibLocations[locId].name : '') || hs.supplier_name || '';
        }
    }
    return _ibLocations[locId] ? _ibLocations[locId].name : '';
}

/*
 * Leverandøren med et søgbart katalog (integration_type 'api'). Mekanikken har
 * altid været generisk — det var kun teksten der sagde "Hørkram". Bon skal kunne
 * køre hos et køkken med en anden grossist, og så må skærmen ikke påstå vores.
 * Ét katalog ad gangen: adapteren (routes/horkram.js) er stadig leverandør-
 * specifik, så vi udnævner det første api-handelssted.
 */
function _ibCatalogSupplier() {
    for (var i = 0; i < _ibHandelssteder.length; i++) {
        var hs = _ibHandelssteder[i];
        if (hs.integration_type === 'api' && hs.grocy_location_id) {
            return {
                locationId: hs.grocy_location_id,
                name: hs.supplier_name || hs.grocy_location_display_name || 'leverandøren',
            };
        }
    }
    return null;
}

function _ibCatalogName() {
    var c = _ibCatalogSupplier();
    return c ? c.name : 'leverandøren';
}

/* Katalog-leverandørens lokation — null hvis ingen er koblet. */
function _ibHokaLocationId() {
    var c = _ibCatalogSupplier();
    return c ? c.locationId : null;
}

/* Åbn panelet med et eksisterende varenummer i feltet. */
function _ibOpenEditVarenr(productId, barcodeId) {
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    var bc = entry.barcodes.filter(function(b) { return b.id === barcodeId; })[0];
    if (!bc) return;

    // Samme chip igen ⇒ luk (samme toggle-adfærd som "+ Varenr.").
    if (_ibLinkPanelId === productId && _ibLinkEditBcId === barcodeId) {
        _ibLinkEditBcId = null;
        _ibLinkPanelId = null;
        _ibClearLinkDraft(productId);
        _ibRender();
        return;
    }

    _ibLinkPanelId = productId;
    _ibLinkEditBcId = barcodeId;
    _ibLinkDraft[productId] = bc.barcode || '';
    _ibLinkNoteDraft[productId] = bc.note || '';
    _ibRender();
    var inp = _ibContainer && _ibContainer.querySelector('[data-ib="lp-varenr"][data-product-id="' + productId + '"]');
    if (inp) { inp.focus(); inp.select(); }
}

/* Fjern et varenummer helt. Varen mister leverandøren, ikke omvendt — så hvis
   det var den sidste chip, falder varen tilbage til "Mangler barcode". */
async function _ibDeleteVarenr(productId, barcodeId) {
    if (_ibBusy) return;
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    var bc = entry.barcodes.filter(function(b) { return b.id === barcodeId; })[0];
    if (!bc) return;

    var sup = _ibSupplierLabelForLocation(bc.shopping_location_id);
    var msg = 'Fjern varenummeret "' + bc.barcode + '"' + (sup ? ' hos ' + sup : '') +
              ' fra ' + (entry.product.name || 'varen') + '?';
    if (entry.barcodes.length === 1) {
        msg += '\n\nDet er det eneste varenummer på varen — den kan ikke bestilles bagefter.';
    }
    if (!window.confirm(msg)) return;

    var msgEl = _ibContainer && _ibContainer.querySelector('[data-ib="lp-msg"][data-product-id="' + productId + '"]');
    _ibBusy = true;
    try {
        await deleteProductBarcode(barcodeId);
        _ibLinkEditBcId = null;
        _ibLinkPanelId = null;
        _ibClearLinkDraft(productId);
        _ibToast('Varenr. ' + bc.barcode + ' fjernet');

        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (err) {
        var t = 'Kunne ikke fjerne: ' + (err.message || '');
        if (msgEl) msgEl.innerHTML = '<span class="ib-lp-err">' + _ibEsc(t) + '</span>';
        _ibToast(t, true);
    } finally {
        _ibBusy = false;
    }
}

/*
 * Marker ét varenummer som det foretrukne for produktet — og ryd de øvrige.
 * "Foretrukken leverandør for dette produkt" er entydig; to markerede ville
 * gøre sorteringen tilfældig. Settings' egen toggle rører kun én række ad
 * gangen (og kender kun Hørkram-koblinger), så oprydningen sker her.
 */
async function _ibTogglePreferred(productId, barcodeId) {
    if (_ibBusy) return;
    var entry = _ibFindEntry(productId);
    if (!entry) return;
    var target = entry.barcodes.filter(function(b) { return b.id === barcodeId; })[0];
    if (!target) return;

    var turningOn = !(target.userfields && target.userfields.is_preferred === '1');
    _ibBusy = true;
    try {
        // Ryd først de andre, så der aldrig er to markerede undervejs.
        for (var i = 0; i < entry.barcodes.length; i++) {
            var bc = entry.barcodes[i];
            if (bc.id === barcodeId) continue;
            if (bc.userfields && bc.userfields.is_preferred === '1') {
                await updateProductBarcodeUserfields(bc.id, { is_preferred: '' });
                bc.userfields.is_preferred = '';
            }
        }
        await updateProductBarcodeUserfields(barcodeId, { is_preferred: turningOn ? '1' : '' });
        if (!target.userfields) target.userfields = {};
        target.userfields.is_preferred = turningOn ? '1' : '';

        _ibToast(turningOn ? 'Foretrukket: ' + _ibChipLabel(target) : 'Foretrukket fjernet');

        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (err) {
        _ibToast('Kunne ikke gemme foretrukket: ' + (err.message || ''), true);
    } finally {
        _ibBusy = false;
    }
}

/* Gemmer leverandørens eget varenummer på gruppens egen lokation. */
async function _ibSaveFreeVarenr(productId) {
    var inp = _ibContainer && _ibContainer.querySelector('[data-ib="lp-varenr"][data-product-id="' + productId + '"]');
    var msgEl = _ibContainer && _ibContainer.querySelector('[data-ib="lp-msg"][data-product-id="' + productId + '"]');
    if (!inp) return;

    var varenr = inp.value.trim();
    if (!varenr) {
        if (msgEl) msgEl.innerHTML = '<span class="ib-lp-err">Skriv varenummeret eller betegnelsen først</span>';
        inp.focus();
        return;
    }

    var entry = _ibFindEntry(productId);
    if (!entry) return;

    // Tom bestillingstekst ⇒ varens navn i Grocy, så linjen aldrig står uden
    // vare. Det er også dét de eksisterende koblinger har i note-feltet.
    var noteInp = _ibContainer && _ibContainer.querySelector('[data-ib="lp-note"][data-product-id="' + productId + '"]');
    var note = (noteInp ? noteInp.value : (_ibLinkNoteDraft[productId] || '')).trim()
               || (entry.product.name || '');

    // Rettelse af et eksisterende nummer — ikke et nyt ved siden af.
    if (_ibLinkEditBcId) {
        await _ibUpdateVarenr(productId, _ibLinkEditBcId, varenr, note, msgEl);
        return;
    }

    var groupKey = _ibFindGroupForEntry(entry);
    var locId = parseInt(groupKey) || null;

    await _ibLinkBarcode(productId, varenr, note, locId, msgEl);
}

/* Ret et eksisterende varenummer. Lokationen røres ikke — det er stadig samme
   leverandørs nummer, det er bare skrevet om. */
async function _ibUpdateVarenr(productId, barcodeId, varenr, note, msgEl) {
    if (_ibBusy) return;
    var entry = _ibFindEntry(productId);
    var bc = entry && entry.barcodes.filter(function(b) { return b.id === barcodeId; })[0];
    if (!bc) return;

    // Begge felter uændrede ⇒ intet at skrive. Noten tælles med: man kan
    // rette teksten alene, og et tidligt exit på nummeret ville kaste den væk.
    if (String(bc.barcode) === String(varenr) && String(bc.note || '') === String(note || '')) {
        _ibLinkEditBcId = null;
        _ibLinkPanelId = null;
        _ibClearLinkDraft(productId);
        _ibRender();
        return;
    }

    _ibBusy = true;
    try {
        await updateProductBarcode(barcodeId, { barcode: String(varenr), note: String(note || '') });

        _ibLinkEditBcId = null;
        _ibLinkPanelId = null;
        _ibClearLinkDraft(productId);
        _ibToast(String(bc.barcode) === String(varenr)
            ? 'Bestillingstekst opdateret'
            : 'Varenr. ændret til ' + varenr);

        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (err) {
        var dup = err.code === 'BARCODE_DUPLICATE' || err.status === 409;
        var t = dup ? 'Varenummeret er allerede koblet til en vare'
                    : (err.message || 'Kunne ikke gemme');
        if (msgEl) msgEl.innerHTML = '<span class="ib-lp-err">' + _ibEsc(t) + '</span>';
        _ibToast(t, true);
    } finally {
        _ibBusy = false;
    }
}

/* HVILKE varer bestillingen omfatter — én regel for alle tre flader.
 *
 * Har man markeret noget, er det DET man bestiller. Ellers alt der er klar.
 * Reglen er dialogens egen, for den er det man SER lige før afsendelse.
 *
 * Fladerne var uenige: dialogen viste de markerede, mens mailen og kopiér-
 * listen sendte `_marked || matched` — altså ALT der var koblet, uanset
 * markering. Markerede man én vare, viste forhåndsvisningen én og mailen
 * sendte hele listen. Det ramte en rigtig leverandør 21. september 2026.
 */
function _ibOrderSelection(g) {
    if (!g || !g.items) return [];
    var klar = g.items.filter(function(e) { return !e.isOrdered && e.matched; });
    var markeret = g.items.filter(function(e) { return !e.isOrdered && e._marked; });
    return markeret.length ? markeret : klar;
}

/* Listens entry → varen som LEVERANDØREN ser den. Forhåndsvisningen, kopiér-
   listen og ordrelinjen til mailen skal beskrive den SAMME bestilling; tre
   kopier af denne mapping ville før eller siden vise hver sit. */
function _ibOrderItem(e) {
    var bc = e.selectedBarcode;
    return {
        product_name: e.product.name,
        note: bc ? (bc.note || null) : null,
        barcode: bc ? bc.barcode : null,
        quantity: e.qty,
        unit: e.needUnit,
    };
}

/* ── Manual order dialog ───────────────────────────────────── */
function _ibRenderManualDialog(g, key) {
    var isOpen = _ibMoOpen === key;
    var itemsToShow = _ibOrderSelection(g);

    var h = '<div class="ib-mo-dlg' + (isOpen ? ' open' : '') + '" data-mo-group="' + key + '">';
    h += '<div class="ib-mo-title">Registrér bestilling — ' + _ibEsc(g.displayName) + '</div>';
    h += '<div class="ib-mo-list">';
    for (var i = 0; i < itemsToShow.length; i++) {
        var vare = _ibOrderItem(itemsToShow[i]);
        var nr = SupplierOrderLines.supplierNumber(vare);
        h += '<div class="ib-mo-item"><span class="ib-mo-iname">' + _ibEsc(SupplierOrderLines.supplierLabel(vare)) + '</span>';
        h += '<span class="ib-mo-iqty">' + _ibEsc(SupplierOrderLines.quantityText(vare)) + (nr ? ' · Nr. ' + _ibEsc(nr) : '') + '</span></div>';
    }
    h += '</div>';
    h += '<div class="ib-mo-acts">';
    h += '<button class="ib-mo-btn ib-mo-copy" data-ib="mo-copy" data-group="' + key + '">📋 Kopiér liste</button>';
    if (g.contactPhone) h += '<button class="ib-mo-btn ib-mo-tlf" data-ib="mo-phone" data-group="' + key + '">📞 Ring</button>';
    if (g.contactEmail) h += '<button class="ib-mo-btn ib-mo-mail" data-ib="mo-mail" data-group="' + key + '">' + mailIcon(12) + ' Send &amp; bestil</button>';
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
    var totalItems = 0;
    var missingCount = 0;
    var staged = [];   // per-leverandør: varer lagt i kurv / markeret, klar til afgivelse

    var groupKeys = Object.keys(_ibGroups);
    var typeOrder = { api: 0, email: 1, webshop: 1, manual: 2, intern: 3, none: 4 };
    groupKeys.sort(function(a, b) {
        var oa = _ibGroups[a].integrationType in typeOrder ? typeOrder[_ibGroups[a].integrationType] : 4;
        var ob = _ibGroups[b].integrationType in typeOrder ? typeOrder[_ibGroups[b].integrationType] : 4;
        return oa - ob;
    });

    for (var gi = 0; gi < groupKeys.length; gi++) {
        var gk = groupKeys[gi];
        var g = _ibGroups[gk];
        for (var i = 0; i < g.items.length; i++) {
            if (g.items[i].isOrdered) continue;
            totalItems++;
            if (gk === '__none__') missingCount++;
        }
        var cartN = g.items.filter(function(e) { return e.inCart && !e.isOrdered; }).length;
        if (cartN) {
            if (g.integrationType === 'api' && g.supplierId) {
                staged.push({ key: gk, name: g.displayName, label: cartN + ' i kurv',
                    action: 'goto-cart', btn: 'Gå til kurv →', cls: 'api' });
            } else {
                // Kurv-varer i en gruppe uden api-kobling — kan ikke afgives endnu
                staged.push({ key: gk, name: g.displayName, label: cartN + ' i kurv',
                    action: 'cart-blocked', btn: '⚠ Kurv ikke klar', cls: 'blocked' });
            }
        }
        if (g.integrationType === 'email' || g.integrationType === 'manual') {
            var markN = g.items.filter(function(e) { return e._marked && !e.isOrdered; }).length;
            if (markN) staged.push({ key: gk, name: g.displayName, label: markN + ' valgt',
                action: 'bb-finalize', btn: 'Registrér →', cls: 'manual' });
        }
    }

    var h = '<div class="ib-bottom">';
    if (staged.length) {
        h += '<div class="ib-bb-staged">';
        for (var s = 0; s < staged.length; s++) {
            var st = staged[s];
            h += '<div class="ib-bb-sup ib-bb-' + st.cls + '">';
            h += '<span class="ib-bb-sup-nm">' + _ibEsc(st.name) + '</span>';
            h += '<span class="ib-bb-sup-cnt">' + st.label + '</span>';
            h += '<button class="ib-bb-act" data-ib="' + st.action + '" data-group="' + st.key + '">' + st.btn + '</button>';
            h += '</div>';
        }
        h += '</div>';
    }
    h += '<div class="ib-bb-stat"><strong>' + totalItems + ' varer</strong> på listen';
    if (missingCount) h += ' · <span class="ib-bb-warn">' + missingCount + ' mangler leverandør</span>';
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

        case 'add-panel-row':
            _ibAddSinglePanelRow(
                btn.getAttribute('data-panel'),
                btn.getAttribute('data-idx'),
                btn.getAttribute('data-product-id')
            );
            break;

        case 'selall-missing':
        case 'selall-expiring':
            // Toggle: alle valgt → fravælg alle; ellers vælg alle (#257).
            var selPanel = _ibContainer.querySelector('[data-ib-panel="' + (action.indexOf('missing') >= 0 ? 'missing' : 'expiring') + '"]');
            if (selPanel) {
                var selChks = selPanel.querySelectorAll('.ib-panel-chk');
                var allOn = selChks.length > 0 && Array.prototype.every.call(selChks, function(c) { return c.checked; });
                var newVal = !allOn;
                selChks.forEach(function(chk) { chk.checked = newVal; });
                btn.textContent = newVal ? 'Fravælg alle' : 'Vælg alle';
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
            // Stod panelet i rette-tilstand, skal "+ Varenr." lægge et NYT til —
            // ikke fortsætte med at rette det forrige.
            if (_ibLinkPanelId === parseInt(productId) && !_ibLinkEditBcId) _ibClearLinkDraft(productId);
            if (_ibLinkEditBcId) _ibClearLinkDraft(productId);
            _ibLinkPanelId = (_ibLinkPanelId === parseInt(productId) && !_ibLinkEditBcId) ? null : parseInt(productId);
            _ibLinkEditBcId = null;
            _ibRender();
            // Fokus i varenr-feltet: panelet åbnes netop for at skrive dér.
            if (_ibLinkPanelId) {
                var inp = _ibContainer.querySelector('[data-ib="lp-varenr"][data-product-id="' + productId + '"]');
                if (inp) inp.focus();
            }
            break;

        case 'skip-item':
            e.target.closest('.ib-item').style.opacity = '0.3';
            break;

        case 'edit-varenr':
            _ibOpenEditVarenr(parseInt(productId), parseInt(btn.getAttribute('data-bc-id')));
            break;

        case 'lp-cancel-edit':
            _ibLinkEditBcId = null;
            _ibLinkPanelId = null;
            _ibClearLinkDraft(productId);
            _ibRender();
            break;

        case 'lp-delete-varenr':
            _ibDeleteVarenr(parseInt(productId), parseInt(btn.getAttribute('data-bc-id')));
            break;

        case 'toggle-preferred':
            _ibTogglePreferred(parseInt(productId), parseInt(btn.getAttribute('data-bc-id')));
            break;

        case 'lp-save-varenr':
            _ibSaveFreeVarenr(parseInt(productId));
            break;

        case 'lp-search':
            _ibLinkSearch(parseInt(productId));
            break;

        case 'lp-gen-int':
            _ibGenerateIntBarcode(parseInt(productId));
            break;

        case 'undo-order-all':
            _ibUndoOrderAll(btn.getAttribute('data-group'));
            break;

        case 'undo-order':
            _ibUndoOrder(productId);
            break;

        case 'toggle-po-mail':
            _ibTogglePoMail(parseInt(btn.getAttribute('data-po-id')));
            break;

        case 'po-mail-send':
            _ibSendPoMailReply(parseInt(btn.getAttribute('data-po-id')));
            break;

        case 'jump-to':
            var jumpGroup = btn.getAttribute('data-group');
            _ibOpenGroups[jumpGroup] = true;
            _ibRender();
            setTimeout(function() {
                var el = _ibContainer.querySelector('.ib-group[data-group="' + jumpGroup + '"]');
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    el.classList.add('ib-flash');
                    setTimeout(function() { el.classList.remove('ib-flash'); }, 1500);
                }
            }, 50);
            break;

        case 'toggle-sup-mail':
            e.stopPropagation();
            _ibToggleSupMail(group);
            break;

        case 'close-sup-mail':
            e.stopPropagation();
            _ibSupMailOpen = null;
            _ibRender();
            break;

        case 'sup-mail-send':
            _ibSendSupMail(group);
            break;

        case 'sup-mail-chip':
            var chipEmail = btn.getAttribute('data-email');
            var toInp = _ibContainer.querySelector('.ib-sup-mail-to-input[data-group="' + group + '"]');
            if (toInp && chipEmail) {
                toInp.value = chipEmail;
                toInp.focus();
            }
            break;

        case 'goto-cart':
            _ibGotoCart(group);
            break;

        case 'bb-finalize':
            // Fra bund-baren: hop til leverandør-gruppering og åbn bestil-dialogen
            _ibViewMode = 'order';
            try { localStorage.setItem('ib_view_mode', 'order'); } catch (eF) { /* noop */ }
            _ibOpenGroups[group] = true;
            _ibMoOpen = group;
            _ibRender();
            setTimeout(function() {
                var el = _ibContainer.querySelector('.ib-group[data-group="' + group + '"]');
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    el.classList.add('ib-flash');
                    setTimeout(function() { el.classList.remove('ib-flash'); }, 1500);
                }
            }, 60);
            break;

        case 'cart-blocked':
            _ibShowCartBlockedModal(group);
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
            _ibCreateProductionBon(group);
            break;

        case 'create-single-bon':
            _ibCreateProductionBon(group, productId);
            break;

        case 'prod-check':
            _ibToast('Råvarekontrol — kommer snart');
            break;

        case 'view-combined':
            _ibViewMode = 'combined';
            _ibFocusMode = false;
            _ibFocusGroup = null;
            try { localStorage.setItem('ib_view_mode', 'combined'); } catch (e2) { /* noop */ }
            _ibRender();
            break;

        case 'view-order':
            _ibViewMode = 'order';
            try { localStorage.setItem('ib_view_mode', 'order'); } catch (e3) { /* noop */ }
            _ibRender();
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
            _ibPanelOpen = _ibPanelOpen === 'add-product' ? null : 'add-product';
            _ibRender();
            break;

        case 'open-create':
            _ibOpenDrawer({ mode: 'create' });
            break;

        case 'open-couple':
            _ibOpenDrawer({ mode: 'couple', productId: productId });
            break;

        case 'add-product-confirm':
            _ibAddProductConfirm();
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
    if (el.getAttribute('data-ib') === 'add-product-search') {
        clearTimeout(el._debounce);
        el._debounce = setTimeout(function() { _ibAddProductAutocomplete(el.value); }, 200);
        return;
    }
    if (el.getAttribute('data-ib') === 'lp-varenr') {
        _ibLinkDraft[el.getAttribute('data-product-id')] = el.value;
        return;
    }
    if (el.getAttribute('data-ib') === 'lp-note') {
        _ibLinkNoteDraft[el.getAttribute('data-product-id')] = el.value;
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

/* Enter i kobl-panelets felter gør det knappen ved siden af gør. Uden det
   indsender Enter ingenting, og man skal ramme knappen med musen. */
function _ibHandleKeydown(e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    var action = el.getAttribute && el.getAttribute('data-ib');
    if (action !== 'lp-varenr' && action !== 'lp-input') return;
    e.preventDefault();
    var pid = parseInt(el.getAttribute('data-product-id'));
    if (action === 'lp-varenr') _ibSaveFreeVarenr(pid);
    else _ibLinkSearch(pid);
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
        var suQty = GrocyNum.num((bc.userfields && bc.userfields.supplier_unit_qty) || '1') || 1;

        // Use salesUnits from hoka if available
        if (bc._hoka && bc._hoka.salesUnits && bc._hoka.salesUnits.length > 0) {
            suCode = bc._hoka.salesUnits[0].code || suCode;
            suQty = bc._hoka.salesUnits[0].quantity || suQty;
        }

        var res = await putHokaBasket([{
            varenummer: bc.barcode,
            quantity: entry.qty,
            salesUnitCode: suCode,
            salesUnitQuantity: suQty,
        }]);

        // Backend afviser varer hvor salgsenheden ikke kunne slås op (#419) —
        // den gætter ikke længere. Vi må derfor heller ikke sige "lagt i kurv".
        var rej = (res && res.rejected || []).filter(function(r) {
            return String(r.varenummer) === String(bc.barcode);
        })[0];
        if (rej) {
            entry._cartError = rej.message;
            _ibToast(rej.message, true);
            _ibRender();
            return;
        }

        entry._cartError = null;
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
    if (_ibBusy) return;
    var g = _ibGroups[groupKey];
    if (!g) return;

    // Defensiv: hvis gruppen ikke er koblet til en supplier i Settings, kan vi
    // ikke registrere en pending purchase order. Vis admin-modal i stedet for
    // at ende i en 400 fra backend.
    if (g.integrationType !== 'api' || !g.supplierId) {
        _ibShowCartBlockedModal(groupKey);
        return;
    }

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
            items: lines,
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

async function _ibConfirmManualOrder(groupKey, sendEmail, mailTekst) {
    var g = _ibGroups[groupKey];
    if (!g || _ibBusy) return;

    var items = _ibOrderSelection(g);
    if (!items.length) {
        _ibToast('Ingen varer at bestille');
        return;
    }

    // Kommer vi fra kladden, har kontoret lige læst og rettet hele mailen —
    // så ville en bekræftelse oven i være et klik uden indhold. Uden kladde
    // (ældre kaldevej) spørges der stadig, og bekræftelsen siger HVAD og til HVEM.
    if (sendEmail && !mailTekst) {
        var modtager = g.contactEmail || '';
        var navne = items.slice(0, 6).map(function(e) {
            return '• ' + SupplierOrderLines.supplierLabel(_ibOrderItem(e))
                 + ' — ' + SupplierOrderLines.quantityText(_ibOrderItem(e));
        }).join('\n');
        if (items.length > 6) navne += '\n• … og ' + (items.length - 6) + ' mere';
        if (!window.confirm(
            'Send bestilling til ' + g.displayName + '?\n\n' +
            items.length + ' ' + (items.length === 1 ? 'vare' : 'varer') +
            (modtager ? ' til ' + modtager : '') + ':\n\n' + navne +
            '\n\nMailen sendes med det samme og kan ikke kaldes tilbage.')) {
            return;
        }
    }

    _ibBusy = true;

    try {
        var lines = items.map(function(e) {
            var vare = _ibOrderItem(e);
            vare.product_id = e.product.id;
            vare.unit = vare.unit || 'stk';
            // Serveren bygger mailens linje af note+barcode; varenr er det
            // felt purchase_order_lines gemmer.
            vare.varenr = vare.barcode;
            return vare;
        });

        var result = await createPendingOrder({
            supplier_id: g.supplierId,
            grocy_location_id: parseInt(groupKey) || null,
            items: lines,
            send_email: sendEmail ? true : false,
            email_subject: mailTekst ? mailTekst.subject : undefined,
            email_body: mailTekst ? mailTekst.body : undefined,
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
        if (result && result.email_sent) {
            _ibToast('Bestilling sendt til ' + g.displayName + ' (' + items.length + ' varer)');
        } else {
            _ibToast('Bestilling registreret — ' + items.length + ' varer');
        }
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

/* Ruller en hel gruppes bestilte varer tilbage på listen.
 *
 * Bekræftelsen siger EKSPLICIT at mailen ikke kaldes tilbage. Uden den linje
 * ville "Fortryd" læses som "annullér bestillingen hos leverandøren", og så
 * ville man tro man havde afbestilt noget der er på vej.
 */
async function _ibUndoOrderAll(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g || _ibBusy) return;

    var bestilte = g.items.filter(function(e) { return e.isOrdered; });
    if (!bestilte.length) { _ibToast('Ingen bestilte varer'); return; }

    // Ligger der bestillinger fra flere dage, skal det siges — ellers ruller
    // man uforvarende gamle med tilbage.
    //
    // ordered_at er UTC. `.slice(0,10)` ville give UTC-DATOEN, som mellem
    // midnat og kl. 02 dansk tid peger på I GÅR (#133) — set i en test der
    // tilfældigvis løb over midnat. Grupper derfor på den LOKALE dato.
    var datoer = {};
    bestilte.forEach(function(e) {
        var d = parseServerDate((e.item.userfields || {}).ordered_at || '');
        if (d && !isNaN(d.getTime())) {
            datoer[d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()] = d;
        }
    });
    var noegler = Object.keys(datoer).sort(function(a, b) { return datoer[a] - datoer[b]; });
    var naarTekst = noegler.length > 1
        ? '\n\nBemærk: de er bestilt på ' + noegler.length + ' forskellige dage (' +
          _ibFmtDate(datoer[noegler[0]].toISOString()) + '–' +      // utc-ok: _ibFmtDate viser lokal tid
          _ibFmtDate(datoer[noegler[noegler.length - 1]].toISOString()) + ').'
        : (noegler.length === 1
            ? '\n\nBestilt ' + _ibFmtDate(datoer[noegler[0]].toISOString()) + '.'   // utc-ok: do.
            : '');

    if (!window.confirm(
        'Fortryd ' + bestilte.length + ' bestilt' + (bestilte.length === 1 ? ' vare' : 'e varer') +
        ' hos ' + g.displayName + '?' + naarTekst +
        '\n\nDe kommer tilbage på bestillingslisten, så de kan bestilles igen.' +
        '\nEn mail der allerede er sendt, kaldes IKKE tilbage.')) {
        return;
    }

    _ibBusy = true;
    var fejlede = [];
    try {
        for (var i = 0; i < bestilte.length; i++) {
            var entry = bestilte[i];
            for (var j = 0; j < entry.allItems.length; j++) {
                try {
                    await updateShoppingListItem(entry.allItems[j].id, {
                        userfields: { ordered_at: '', ordered_qty: '', ordered_supplier: '', ordered_varenr: '' }
                    });
                } catch (e1) {
                    fejlede.push(entry.product.name);
                    break;   // resten af DENNE vares rækker springes over
                }
            }
        }
        // En delvis rulning siges højt — ellers ser listen rigtig ud mens
        // nogle varer stadig står som bestilt.
        _ibToast(fejlede.length
            ? (bestilte.length - fejlede.length) + ' af ' + bestilte.length + ' fortrudt — disse fejlede: ' + fejlede.join(', ')
            : bestilte.length + ' varer er tilbage på listen',
            fejlede.length > 0);
        await _ibReloadShoppingList();
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
    } else {
        // Tidligere fejlede dette tavst (kun console.warn) → brugeren troede add var i stykker.
        _ibToast('Ingen varer valgt eller kunne ikke tilføjes', true);
    }
}

// Tilføj ÉN vare fra et panel (Manglende/Udløbende) direkte til indkøbslisten.
// Bruger antallet fra rækkens egen stepper. Panelet forbliver åbent så man
// kan tilføje flere. Fejl vises som toast (ikke tavs console.warn).
async function _ibAddSinglePanelRow(panelType, idx, productId) {
    var panelEl = _ibContainer.querySelector('[data-ib-panel="' + panelType + '"]');
    var input = panelEl ? panelEl.querySelector('.ib-panel-qi[data-idx="' + idx + '"]') : null;
    var qty = input ? (parseFloat(input.value) || 1) : 1;
    try {
        await addShoppingListProduct(parseInt(productId), qty);
        _ibToast('Tilføjet til listen');
        await _ibReloadShoppingList();
        _ibLoadVolatile();   // panelet gen-renderes; _ibPanelOpen bevares → forbliver åbent
    } catch (err) {
        _ibToast('Kunne ikke tilføje: ' + err.message, true);
    }
}

function _ibCopyOrderList(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g) return;

    var items = _ibOrderSelection(g);

    // Samme regel som bestillingsmailen (shared/supplier_order_lines.js):
    // leverandørens egen betegnelse, og vores interne numre udeladt. De to
    // flader skriver til den samme leverandør og må ikke vise hver sit.
    var text = SupplierOrderLines.copyList(items.map(_ibOrderItem),
                                           'Bestilling — ' + g.displayName);

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
            _ibToast('Kopieret til udklipsholder');
        });
    } else {
        _ibToast('Kunne ikke kopiere — brug HTTPS');
    }
}

function _ibMailOrder(groupKey) {
    // "Send & bestil" åbner mailen som KLADDE. En bekræftelse kunne kun svare
    // ja/nej til en tekst man ikke kunne røre — og man vil tit skrive noget
    // med ("kan I levere onsdag?"). Selve afsendelsen sker fra kladden.
    _ibOpenMailDraft(groupKey);
}

/* ── Ordremailen som kladde ────────────────────────────────── */
var _ibDraftEl = null;

function _ibCloseMailDraft() {
    if (_ibDraftEl && _ibDraftEl.parentNode) _ibDraftEl.parentNode.removeChild(_ibDraftEl);
    _ibDraftEl = null;
    document.removeEventListener('keydown', _ibDraftKey);
}

function _ibDraftKey(e) {
    if (e.key === 'Escape') _ibCloseMailDraft();
}

async function _ibOpenMailDraft(groupKey) {
    var g = _ibGroups[groupKey];
    if (!g || _ibBusy) return;

    var items = _ibOrderSelection(g);
    if (!items.length) { _ibToast('Ingen varer at bestille'); return; }

    var kladde;
    try {
        kladde = await fetchOrderMailDraft({
            supplier_id: g.supplierId,
            items: items.map(_ibOrderItem),
        });
    } catch (err) {
        _ibToast(err && err.code === 'NO_EMAIL'
            ? g.displayName + ' har ingen mailadresse — sæt den i Indstillinger → Indkøb'
            : 'Kunne ikke hente kladden: ' + ((err && err.message) || ''), true);
        return;
    }

    _ibCloseMailDraft();
    var ov = document.createElement('div');
    ov.className = 'ib-cb-overlay ib-md-overlay';
    ov.innerHTML =
        '<div class="ib-cb-modal ib-md-modal">' +
          '<div class="ib-md-head">Bestilling til ' + _ibEsc(kladde.supplier_name) + '</div>' +
          '<div class="ib-md-to">Til <b>' + _ibEsc(kladde.to) + '</b>' +
            '<span class="ib-md-to-hint">rettes under Indstillinger → Indkøb</span></div>' +
          '<label class="ib-md-lbl">Emne</label>' +
          '<input class="ib-md-subject" data-ib-md="subject" value="' + _ibEsc(kladde.subject) + '">' +
          '<label class="ib-md-lbl">Besked</label>' +
          '<textarea class="ib-md-body" data-ib-md="body" rows="16"></textarea>' +
          '<div class="ib-md-note">Et svar-mærke sættes automatisk på emnet, så svaret lander på bestillingen.</div>' +
          '<div class="ib-md-acts">' +
            '<button class="ib-md-btn" data-ib-md="cancel">Annullér</button>' +
            '<button class="ib-md-btn primary" data-ib-md="send">Send bestilling (' +
              kladde.item_count + ' ' + (kladde.item_count === 1 ? 'vare' : 'varer') + ')</button>' +
          '</div>' +
        '</div>';
    document.body.appendChild(ov);
    _ibDraftEl = ov;

    // Brødteksten sættes som VÆRDI, ikke som markup — den er fri tekst.
    var body = ov.querySelector('[data-ib-md="body"]');
    body.value = kladde.body;

    ov.addEventListener('click', function(e) {
        var act = e.target.getAttribute && e.target.getAttribute('data-ib-md');
        if (act === 'cancel' || e.target === ov) { _ibCloseMailDraft(); return; }
        if (act !== 'send') return;

        var subj = ov.querySelector('[data-ib-md="subject"]').value.trim();
        var txt  = body.value.trim();
        if (!txt) { _ibToast('Skriv en besked først', true); body.focus(); return; }

        _ibCloseMailDraft();
        _ibConfirmManualOrder(groupKey, true, { subject: subj, body: txt });
    });
    document.addEventListener('keydown', _ibDraftKey);
    ov.querySelector('[data-ib-md="subject"]').focus();
}

/* ── Link/search panel ─────────────────────────────────────── */
async function _ibLinkSearch(productId) {
    var inp = _ibContainer.querySelector('[data-ib="lp-input"][data-product-id="' + productId + '"]');
    var resultsEl = _ibContainer.querySelector('[data-ib="lp-results"][data-product-id="' + productId + '"]');
    if (!inp || !resultsEl) return;

    var q = inp.value.trim();
    if (!q) return;

    resultsEl.innerHTML = '<div class="ib-lp-loading">Søger i ' + _ibEsc(_ibCatalogName()) + '-katalog...</div>';

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

    var html = '<div class="ib-lp-source">Søgning i ' + _ibEsc(_ibCatalogName()) + '-katalog</div>';

    if (favResults.length) {
        html += '<div class="ib-lp-note" style="margin-top:6px">Fra dine favoritter hos ' + _ibEsc(_ibCatalogName()) + ':</div>';
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
        html = '<div class="ib-lp-loading">Ingen resultater for "' + _ibEsc(q) + '" i ' + _ibEsc(_ibCatalogName()) + '-katalog</div>';
    }

    resultsEl.innerHTML = html;

    // Bind link buttons (dynamic content, not in delegation)
    resultsEl.querySelectorAll('[data-ib="lp-link"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var varenr = this.getAttribute('data-varenr');
            var name = this.getAttribute('data-name');
            // Fra Hørkrams katalog ⇒ Hørkram-lokationen, så varen kan lægges
            // i deres kurv uanset hvilken gruppe produktet ellers hører til.
            _ibLinkBarcode(productId, varenr, name, _ibHokaLocationId());
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

/*
 * locationId er nu et ARGUMENT, ikke et gæt. Tidligere blev et rent numerisk
 * varenummer tvunget over på Hørkram-lokationen — hvilket er rigtigt for et
 * nummer der KOMMER fra Hørkrams katalog, men forkert for enhver anden
 * leverandør der også bruger tal. Kalderen ved hvor nummeret kommer fra; det
 * gør denne funktion ikke.
 */
async function _ibLinkBarcode(productId, varenr, name, locationId, msgEl) {
    if (_ibBusy) return;
    _ibBusy = true;

    try {
        await createProductBarcode({
            product_id: parseInt(productId),
            barcode: String(varenr),
            shopping_location_id: locationId || null,
            note: name,
        });

        _ibLinkPanelId = null;
        _ibClearLinkDraft(productId);
        _ibToast('Varenr. ' + varenr + ' koblet til ' + name);

        // Refresh
        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (err) {
        var dup = err.code === 'BARCODE_DUPLICATE' || err.status === 409;
        var msg = dup ? 'Varenummeret er allerede koblet til en vare'
                      : (err.message || 'Kunne ikke koble');
        // Panelet er stadig åbent — vis fejlen dér, ikke kun i en toast der
        // forsvinder af sig selv mens man står med varen.
        if (msgEl) msgEl.innerHTML = '<span class="ib-lp-err">' + _ibEsc(msg) + '</span>';
        _ibToast(msg, true);
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
    var d = parseServerDate(isoStr);
    if (!d || isNaN(d.getTime())) return isoStr;
    return d.getDate() + '. ' + ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'][d.getMonth()];
}

/* ── Dropsize check ────────────────────────────────────────── */
async function _ibCheckDropsize() {
    for (var key in _ibGroups) {
        var g = _ibGroups[key];
        if (g.integrationType !== 'api') continue;

        var el = document.getElementById('ibDropsize_' + key);
        if (!el) continue;

        // Calculate subtotal for this group
        var subtotal = 0;
        g.items.forEach(function(entry) {
            if (!entry.isOrdered && entry.matched) {
                subtotal += _ibPackPrice(entry.selectedBarcode, entry.qty);
            }
        });

        try {
            var ds = await fetchHokaDropsize(subtotal);
            // Parse Hoka response — Model.HasReachedLimit, Model.MinimumDropSize (Danish format "1.500,00")
            var model = ds.Model || ds;
            var reached = model.HasReachedLimit || model.hasReachedLimit || false;
            var minStr = model.MinimumDropSize || model.minimumDropSize || '0';
            var missStr = model.MissingAmount || model.missingAmount || '0';
            // Parse Danish number format: "1.500,00" → 1500
            var minimum = parseFloat(String(minStr).replace(/\./g, '').replace(',', '.')) || 0;
            var missing = parseFloat(String(missStr).replace(/\./g, '').replace(',', '.')) || 0;

            if (!reached && minimum > 0) {
                el.innerHTML = '<div class="ib-dropsize-warn">'
                    + '⚠ Minimumsbeløb ikke nået — mangler <strong>' + Math.round(missing) + ' kr</strong>'
                    + ' (minimum ' + Math.round(minimum) + ' kr)</div>';
            } else {
                el.innerHTML = '';
            }
        } catch (e) {
            // Silently ignore — dropsize is non-critical
            el.innerHTML = '';
        }
    }
}

/* ── INT-varenumre ─────────────────────────────────────────── */
function _ibNextIntNumber() {
    var max = 0;
    _ibBarcodes.forEach(function(bc) {
        if (bc.barcode && /^INT-\d+$/.test(bc.barcode)) {
            var num = parseInt(bc.barcode.substring(4));
            if (num > max) max = num;
        }
    });
    return 'INT-' + String(max + 1).padStart(4, '0');
}

async function _ibGenerateIntBarcode(grocyProductId) {
    var p = _ibProducts[grocyProductId];
    if (!p) { _ibToast('Produkt ikke fundet', true); return; }

    // Lokationen er DEN GRUPPE panelet står i — ikke produktets default
    // handelssted. De to er sjældent ens for en emballagevare, og et internt
    // nummer på den forkerte leverandør er tavst forkert: varen ser koblet ud
    // og dukker op i en andens bestilling. Falder tilbage på produktets eget
    // felt hvis gruppen ikke kan bestemmes.
    var entry = _ibFindEntry(grocyProductId);
    var groupKey = entry ? _ibFindGroupForEntry(entry) : null;
    var shopLocId = parseInt(groupKey) || p.shopping_location_id || null;

    // Bestillingsteksten hvis den er skrevet, ellers varens navn. Uden den ville
    // mailen stå med "INT-0001" — et nummer kun vi kender.
    var noteInp = _ibContainer && _ibContainer.querySelector('[data-ib="lp-note"][data-product-id="' + grocyProductId + '"]');
    var note = (noteInp ? noteInp.value : (_ibLinkNoteDraft[grocyProductId] || '')).trim()
               || (p.name || '');

    var intNr = _ibNextIntNumber();

    try {
        await createProductBarcode({
            product_id: grocyProductId,
            barcode: intNr,
            shopping_location_id: shopLocId,
            note: note,
        });

        _ibToast(p.name + ' → ' + intNr);

        // Reload barcodes and rebuild
        _ibBarcodes = await fetchProductBarcodes();
        _ibBuildGroups();
        _ibLinkPanelId = null;
        _ibClearLinkDraft(grocyProductId);
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || ''), true);
    }
}

/* ── Produktionsbon ────────────────────────────────────────── */
async function _ibCreateProductionBon(groupKey, singleProductId) {
    if (_ibBusy) return;
    var g = _ibGroups[groupKey];
    if (!g) return;

    // Collect items — either a single product or all non-ordered items
    var items = [];
    g.items.forEach(function(entry) {
        if (entry.isOrdered) return;
        var p = entry.product;
        if (!p) return;
        if (singleProductId && p.id != singleProductId) return;
        // Use qty if set, otherwise fall back to shopping list need amount
        var qty = entry.qty || Math.ceil(parseFloat(entry.need) || 1);
        items.push({ entry: entry, product: p, qty: qty });
    });

    if (!items.length) { _ibToast('Ingen varer at oprette bon for', true); return; }

    // Default: i morgen (lokal dato — ikke UTC, der ellers viser forkert dag efter midnat)
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    var dateStr = tomorrow.getFullYear() + '-'
        + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-'
        + String(tomorrow.getDate()).padStart(2, '0');

    // Prompt for date
    var chosen = prompt('Produktionsbon dato (ÅÅÅÅ-MM-DD):', dateStr);
    if (!chosen) return;

    _ibBusy = true;
    try {
        // Create bon — intern produktion, ingen kunde/levering
        var bon = await createBon({
            delivery_date: chosen,
            status_id: 3, // GODKENDT
            price_category_id: 4, // produktion
            is_internal: 1,
            delivery_type: 'pickup',
            customer_collects: 1,
            kitchen_selects: 1,
            internal_notes: 'Produktionsbon oprettet fra indkøb',
        });

        if (!bon || !bon.id) { _ibToast('Fejl ved oprettelse af bon', true); return; }

        // Add lines
        var lineCount = 0;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var p = item.product;
            var entry = item.entry;

            try {
                await postBonLine(bon.id, {
                    product_name: p.name,
                    grocy_recipe_id: p.grocy_recipe_id || null,
                    quantity: item.qty,
                    unit: entry.needUnit || p.qu_id_stock_name || 'stk',
                    unit_price: 0,
                    cost_price: 0,
                });
                lineCount++;
            } catch (e) {
                console.error('[indkob] line error:', e);
            }

            // Fjern fra Grocy shopping list — én entry kan dække flere sl-linjer
            var slItems = entry.allItems || [];
            for (var j = 0; j < slItems.length; j++) {
                if (!slItems[j] || !slItems[j].id) continue;
                try { await deleteShoppingListItem(slItems[j].id); } catch (e) { /* */ }
            }
        }

        _ibToast('Produktionsbon #' + bon.bon_number + ' oprettet (' + lineCount + ' linjer)');

        // Reload
        _ibShoppingList = await fetchShoppingList();
        _ibBuildGroups();
        _ibMoOpen = null;
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || ''), true);
    } finally {
        _ibBusy = false;
    }
}

/* ── Tilføj vare: autocomplete + confirm ───────────────────── */
var _ibAddProdSelected = null; // { id, name }

function _ibAddProductAutocomplete(q) {
    var ac = document.getElementById('ibAddProdAC');
    if (!ac) return;
    if (!q || q.trim().length < 2) { ac.style.display = 'none'; return; }

    q = q.trim().toLowerCase();

    // Inaktive varer SKJULES ikke — 39 af 225 i grocy-hq er det, og en skjult
    // vare får brugeren til at oprette en dublet ved siden af den der findes
    // (begge Tørrepapir ligger inaktive på Serviwets lokation). De mærkes og
    // lægges sidst, og tilføjelsen tager dem i brug igen.
    var aktive = [], inaktive = [];
    var productIds = Object.keys(_ibProducts);
    for (var i = 0; i < productIds.length && (aktive.length + inaktive.length) < 12; i++) {
        var p = _ibProducts[productIds[i]];
        if (!p || !p.name || p.name.toLowerCase().indexOf(q) < 0) continue;
        (grocyProductActive(p) ? aktive : inaktive).push(p);
    }
    var matches = aktive.concat(inaktive);

    if (!matches.length) { ac.style.display = 'none'; return; }

    ac.innerHTML = matches.map(function(p) {
        var group = p.product_group || '';
        var ude = !grocyProductActive(p);
        return '<div class="ib-add-ac-item' + (ude ? ' ude' : '') + '" data-pid="' + p.id + '">'
            + '<span class="ib-add-ac-name">' + _ibEsc(p.name) + '</span>'
            + (ude ? '<span class="ib-add-ac-ude">ikke i brug</span>' : '')
            + (group ? '<span class="ib-add-ac-meta">' + _ibEsc(group) + '</span>' : '')
            + '</div>';
    }).join('');
    ac.style.display = 'block';

    ac.querySelectorAll('.ib-add-ac-item').forEach(function(item) {
        item.addEventListener('click', function() {
            var pid = parseInt(item.dataset.pid);
            var prod = _ibProducts[pid];
            _ibAddProdSelected = prod
                ? { id: prod.id, name: prod.name, inactive: !grocyProductActive(prod) }
                : null;
            var inp = document.getElementById('ibAddProdQ');
            if (inp) inp.value = prod ? prod.name : '';
            ac.style.display = 'none';
            var selEl = document.getElementById('ibAddProdSel');
            if (selEl) selEl.innerHTML = prod
                ? '<span style="color:#6a8f3a;font-weight:700">✓ ' + _ibEsc(prod.name) + '</span>'
                  + (grocyProductActive(prod) ? ''
                     : '<span class="ib-add-ac-ude" style="margin-left:6px">tages i brug igen</span>')
                : 'Søg efter produktnavn...';
            var qtyInp = document.getElementById('ibAddProdQty');
            if (qtyInp) qtyInp.focus();
        });
    });
}

async function _ibAddProductConfirm() {
    if (_ibBusy) return;
    if (!_ibAddProdSelected) { _ibToast('Vælg et produkt først', true); return; }
    var qtyInp = document.getElementById('ibAddProdQty');
    var qty = parseInt(qtyInp ? qtyInp.value : 1) || 1;

    _ibBusy = true;
    try {
        // Varen er sat ud af brug i Grocy. At lægge den på indkøbslisten ER at
        // tage den i brug igen, så vi gør det — men siger det højt, for det er
        // en beslutning nogen har truffet den anden vej.
        var genaktiveret = false;
        if (_ibAddProdSelected.inactive) {
            await putGrocyProduct(_ibAddProdSelected.id, { active: 1 }, 'indkob');
            genaktiveret = true;
            var gp = _ibProducts[_ibAddProdSelected.id];
            if (gp) gp.active = 1;
        }

        await addShoppingListProduct(_ibAddProdSelected.id, qty, 1);
        _ibToast(_ibAddProdSelected.name + ' tilføjet (' + qty + ')'
                 + (genaktiveret ? ' — og taget i brug igen' : ''));
        _ibAddProdSelected = null;
        _ibPanelOpen = null;

        // Reload shopping list and re-render
        _ibShoppingList = await fetchShoppingList();
        _ibBuildGroups();
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || ''), true);
    } finally {
        _ibBusy = false;
    }
}

/* ── PO Mail thread ────────────────────────────────────────── */

function _ibRenderPoMailSection(po) {
    var isOpen = _ibMailThreadOpen === po.id;
    var h = '<div class="ib-po-mail" data-po-id="' + po.id + '">';
    h += '<div class="ib-po-mail-header" data-ib="toggle-po-mail" data-po-id="' + po.id + '">';
    h += '<span class="ib-po-mail-icon' + (po.unread_mail > 0 ? ' unread' : '') + '">' + mailIcon(13) + '</span>';
    h += '<span class="ib-po-mail-label">Bestillingsmail</span>';
    if (po.unread_mail > 0) {
        h += '<span class="ib-po-mail-count">' + po.unread_mail + ' ny' + (po.unread_mail !== 1 ? 'e' : '') + '</span>';
    }
    if (po.expected_delivery_date) {
        h += '<span class="ib-po-mail-date">Lev. ' + _ibFmtDate(po.expected_delivery_date) + '</span>';
    }
    h += '<span class="ib-po-mail-chev' + (isOpen ? ' open' : '') + '">›</span>';
    h += '</div>';

    if (isOpen) {
        var threadData = _ibMailThreadData[po.id];
        h += '<div class="ib-po-mail-body">';
        if (!threadData) {
            h += '<div class="ib-po-mail-loading">Indlæser...</div>';
        } else {
            h += _ibRenderMailMessages(threadData.messages || []);
            h += '<div class="ib-po-mail-reply">';
            h += '<textarea class="ib-po-mail-input" data-po-id="' + po.id + '" placeholder="Skriv svar..."></textarea>';
            h += '<button class="ib-btn ib-btn-sm" data-ib="po-mail-send" data-po-id="' + po.id + '">Send</button>';
            h += '</div>';
            h += '<div class="ib-sig-hint"></div>';
        }
        h += '</div>';
    }

    h += '</div>';
    return h;
}

/* Returnerer en placeholder — fyldes af _ibHydrateMail() efter render
   med den fælles MailThread-komponent (klik-for-at-folde-ud). */
function _ibRenderMailMessages(messages) {
    var json = encodeURIComponent(JSON.stringify(messages || []));
    return '<div class="ib-mail-host" data-mt-messages="' + json + '"></div>';
}

/* ── Supplier mail (fri kommunikation, uafhængigt af PO) ─────── */

function _ibRenderSupMailSection(g, key) {
    var data = _ibSupMailData[key];
    var draft = _ibSupMailCompose[key] || {};
    var supContactEmail = (data && data.supplier && data.supplier.contact_email) || g.contactEmail || '';
    var supNotes = (data && data.supplier && data.supplier.notes) || g.notes || '';
    var defaultTo = supContactEmail;

    // Parse notes for ekstra mini-leverandør-emails
    var contacts = parseEmailsFromNotes(supNotes);
    contacts = contacts.filter(function(c) { return c.email !== (defaultTo || '').toLowerCase(); });

    var h = '<div class="ib-sup-mail" data-group="' + key + '">';
    h += '<div class="ib-sup-mail-hdr">';
    h += '<span class="ib-sup-mail-title">' + mailIcon(14) + ' Skriv til ' + _ibEsc(g.supplierName) + '</span>';
    h += '<button class="ib-sup-mail-close" data-ib="close-sup-mail" data-group="' + key + '">✕</button>';
    h += '</div>';

    // Tråd-historik
    if (data && data.messages && data.messages.length > 0) {
        h += '<div class="ib-sup-mail-msgs">' + _ibRenderMailMessages(data.messages) + '</div>';
    } else if (data) {
        h += '<div class="ib-sup-mail-empty">Ingen tidligere mails — start en ny tråd nedenfor.</div>';
    } else {
        h += '<div class="ib-sup-mail-loading">Indlæser tråd...</div>';
    }

    // Compose
    h += '<div class="ib-sup-mail-compose">';
    h += '<input class="ib-sup-mail-to-input" placeholder="Modtager email..." value="' + _ibEsc(defaultTo) + '" data-ib="sup-mail-to" data-group="' + key + '">';

    // Quick-pick chips fra notes
    if (contacts.length > 0) {
        h += '<div class="ib-sup-mail-chips">';
        for (var ci = 0; ci < contacts.length; ci++) {
            h += '<span class="ib-sup-mail-chip" data-ib="sup-mail-chip" data-group="' + key + '" data-email="' + _ibEsc(contacts[ci].email) + '" title="' + _ibEsc(contacts[ci].email) + '">' +
                _ibEsc(contacts[ci].label) + '</span>';
        }
        h += '</div>';
        h += '<div class="ib-sup-mail-hint">Klik en kontakt for at indsætte. Adresser er fundet i leverandørens noter.</div>';
    } else if (!defaultTo) {
        h += '<div class="ib-sup-mail-hint">Tip: Sæt en standard-email på leverandøren under Settings → Indkøb → Leverandører.</div>';
    }

    h += '<input class="ib-sup-mail-subject" placeholder="Emne (fx \'Forespørgsel om aftalepris\')" value="' + _ibEsc(draft.subject || '') + '" data-ib="sup-mail-subject" data-group="' + key + '">';
    h += '<textarea class="ib-sup-mail-input" placeholder="Skriv besked..." data-ib="sup-mail-text" data-group="' + key + '"></textarea>';
    h += '<div class="ib-sig-hint"></div>';
    h += '<div class="ib-sup-mail-actions">';
    h += '<button class="ib-btn ib-btn-sm" data-ib="sup-mail-send" data-group="' + key + '">Send</button>';
    h += '</div>';
    h += '</div>';
    h += '</div>';
    return h;
}

async function _ibToggleSupMail(key) {
    if (_ibSupMailOpen === key) {
        _ibSupMailOpen = null;
        _ibRender();
        return;
    }
    _ibSupMailOpen = key;
    var g = _ibGroups[key];
    if (!g || !g.supplierId) {
        _ibToast('Leverandøren er ikke koblet i V2', true);
        _ibSupMailOpen = null;
        return;
    }
    // Auto-open the group body if it's collapsed
    _ibOpenGroups[key] = true;
    _ibRender(); // Show loading state

    try {
        var data = await fetchSupplierMail(g.supplierId);
        _ibSupMailData[key] = data;
        // Reset unread badge after open
        if (_ibSupMailUnread[key]) {
            await markSupplierMailRead(g.supplierId);
            _ibSupMailUnread[key] = 0;
        }
    } catch (err) {
        _ibSupMailData[key] = { thread: null, messages: [] };
        console.error('[indkob] Supplier mail load fejl:', err);
    }
    _ibRender();
}

async function _ibSendSupMail(key) {
    var g = _ibGroups[key];
    if (!g) return;
    var toEl      = _ibContainer.querySelector('.ib-sup-mail-to-input[data-group="' + key + '"]');
    var subjectEl = _ibContainer.querySelector('.ib-sup-mail-subject[data-group="' + key + '"]');
    var textEl    = _ibContainer.querySelector('.ib-sup-mail-input[data-group="' + key + '"]');
    var to      = toEl ? toEl.value.trim() : '';
    var subject = subjectEl ? subjectEl.value.trim() : '';
    var body    = textEl ? textEl.value.trim() : '';
    if (!to)      { _ibToast('Modtager-email er påkrævet', true); return; }
    if (!subject) { _ibToast('Skriv et emne først', true); return; }
    if (!body)    { _ibToast('Skriv en besked først', true); return; }

    try {
        await sendSupplierMail(g.supplierId, { subject: subject, body: body, to: to });
        _ibToast('Mail sendt til ' + g.supplierName);
        _ibSupMailCompose[key] = {}; // clear draft
        // Reload thread
        var data = await fetchSupplierMail(g.supplierId);
        _ibSupMailData[key] = data;
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke sende'), true);
    }
}

async function _ibHandleSupplierMailEvent(data) {
    // Indkommende mail på en supplier-tråd → opdater badge
    var supId = data && data.supplier_id;
    if (!supId) return;
    for (var key in _ibGroups) {
        if (_ibGroups[key].supplierId === supId) {
            _ibSupMailUnread[key] = (data.unread_count != null ? data.unread_count : (_ibSupMailUnread[key] || 0) + 1);
            // Hvis tråden er åben, hent den friske data
            if (_ibSupMailOpen === key) {
                try {
                    var fresh = await fetchSupplierMail(supId);
                    _ibSupMailData[key] = fresh;
                    await markSupplierMailRead(supId);
                    _ibSupMailUnread[key] = 0;
                } catch (e) { /* ignore */ }
            }
            _ibRender();
            return;
        }
    }
}

async function _ibLoadSupMailOverview() {
    try {
        var data = await fetchSupplierMailOverview(true);
        _ibSupMailUnread = {};
        if (data && data.threads) {
            for (var i = 0; i < data.threads.length; i++) {
                var t = data.threads[i];
                // Find group for this supplier
                for (var key in _ibGroups) {
                    if (_ibGroups[key].supplierId === t.supplier_id && t.unread_count > 0) {
                        _ibSupMailUnread[key] = t.unread_count;
                    }
                }
            }
        }
    } catch (e) { /* lydløs degradering */ }
}

async function _ibTogglePoMail(poId) {
    if (_ibMailThreadOpen === poId) {
        _ibMailThreadOpen = null;
        _ibRender();
        return;
    }
    _ibMailThreadOpen = poId;
    _ibRender(); // Show loading state

    try {
        var data = await fetchOrderMailThread(poId);
        _ibMailThreadData[poId] = data;

        // Mark as read
        if (data.messages && data.messages.some(function(m) { return m.direction === 'in' && !m.is_read; })) {
            await markOrderMailRead(poId);
            // Update local PO data
            for (var i = 0; i < _ibPendingOrders.length; i++) {
                if (_ibPendingOrders[i].id === poId) {
                    _ibPendingOrders[i].unread_mail = 0;
                    break;
                }
            }
            _ibBuildGroups();
        }
    } catch (err) {
        _ibMailThreadData[poId] = { thread: null, messages: [] };
        console.error('[indkob] PO mail load fejl:', err);
    }
    _ibRender();
}

async function _ibSendPoMailReply(poId) {
    var textarea = _ibContainer.querySelector('textarea[data-po-id="' + poId + '"]');
    if (!textarea) return;
    var text = textarea.value.trim();
    if (!text) return;

    try {
        await sendOrderReply(poId, text);
        // Reload thread
        var data = await fetchOrderMailThread(poId);
        _ibMailThreadData[poId] = data;
        _ibToast('Svar sendt');
        _ibRender();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke sende'), true);
    }
}

async function _ibHandlePoMail(data) {
    // Refresh pending orders to get updated unread_mail counts
    try {
        _ibPendingOrders = await fetchPendingOrders() || [];
        _ibBuildGroups();

        // If thread is open, reload it
        if (_ibMailThreadOpen && data.purchase_order_id === _ibMailThreadOpen) {
            var threadData = await fetchOrderMailThread(_ibMailThreadOpen);
            _ibMailThreadData[_ibMailThreadOpen] = threadData;
            await markOrderMailRead(_ibMailThreadOpen);
            for (var i = 0; i < _ibPendingOrders.length; i++) {
                if (_ibPendingOrders[i].id === _ibMailThreadOpen) {
                    _ibPendingOrders[i].unread_mail = 0;
                    break;
                }
            }
            _ibBuildGroups();
        }

        _ibRender();
    } catch (err) {
        console.warn('[indkob] PO mail SSE reload fejl:', err.message);
    }
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

/* ── Cart-blocked modal: vises når kurven har items men supplier-kobling
   mangler. Køkken-personalet kan ikke selv fixe det — admin skal sætte
   koblingen op i Settings → Indkøb → Leverandører. */
function _ibShowCartBlockedModal(groupKey) {
    _ibCloseCartBlockedModal();
    var g = _ibGroups[groupKey];
    if (!g) return;

    var cartCount = (_ibCartItems || []).filter(function(e) {
        return _ibFindGroupForEntry(e) === groupKey;
    }).length;

    var overlay = document.createElement('div');
    overlay.className = 'ib-cb-overlay';
    overlay.innerHTML =
        '<div class="ib-cb-modal">' +
            '<div class="ib-cb-title">⚠ Kurven kan ikke afgives</div>' +
            '<div class="ib-cb-body">' +
                '<p><strong>' + _ibEsc(g.displayName) + '</strong> er ikke koblet til en leverandør i Settings, ' +
                'så vi kan ikke registrere bestillingen automatisk.</p>' +
                (cartCount > 0
                    ? '<p>Kurven indeholder <strong>' + cartCount + ' vare' + (cartCount === 1 ? '' : 'r') + '</strong> der venter.</p>'
                    : '') +
                '<div class="ib-cb-admin-box">' +
                    '<div class="ib-cb-admin-lbl">🛠 Skal sættes op af en admin</div>' +
                    '<div class="ib-cb-admin-steps">' +
                        '<div>1. Åbn <strong>Settings → Indkøb → Leverandører</strong></div>' +
                        '<div>2. Find <em>' + _ibEsc(g.displayName) + '</em> og klik "Rediger"</div>' +
                        '<div>3. Vælg den Grocy-lokation der svarer til <em>' + _ibEsc(g.displayName) + '</em> og gem</div>' +
                    '</div>' +
                '</div>' +
                '<p class="ib-cb-hint">Når koblingen er på plads, dukker den grønne ' +
                '<em>Gå til kurv →</em>-knap op her, og bestillingen kan afgives som normalt.</p>' +
            '</div>' +
            '<div class="ib-cb-foot">' +
                '<button class="ib-cb-btn-close">Luk</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);

    // Modal hører ikke under _ibContainer, så vi binder close-handlers direkte
    closeOnOutsideClick(overlay, _ibCloseCartBlockedModal);
    overlay.querySelector('.ib-cb-btn-close').addEventListener('click', _ibCloseCartBlockedModal);
    var escHandler = function(e) {
        if (e.key === 'Escape') {
            _ibCloseCartBlockedModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
    overlay._escHandler = escHandler;
}

function _ibCloseCartBlockedModal() {
    var existing = document.querySelector('.ib-cb-overlay');
    if (!existing) return;
    if (existing._escHandler) document.removeEventListener('keydown', existing._escHandler);
    existing.remove();
}

/* ══ Opret / kobl vare — drawer (CLAUDE_INDKOB_6H.md Del 3 + 4) ══
   To trin: 1) find Hørkram-varenummer, 2) knyt til Grocy-vare.
   Body-appended (overlever _ibRender). Gren A = eksisterende Grocy-vare,
   Gren B = helt ny vare via product_create.js. */
var _ibDrawer            = null;
var _ibDrawerMode        = 'create';    // 'create' | 'couple'
var _ibDrawerTarget      = 'existing';  // 'existing' | 'new'
var _ibDrawerVarenr      = '';
var _ibDrawerHokaName    = '';
var _ibDrawerHokaPrice   = null;
var _ibDrawerGrocyId     = null;
var _ibDrawerGrocyName   = '';
var _ibDrawerBusy        = false;
var _ibDrawerPcMounted   = false;
var _ibDrawerManualTimer = null;

function _ibOpenDrawer(opts) {
    _ibCloseDrawer();
    opts = opts || {};
    _ibDrawerMode      = opts.mode === 'couple' ? 'couple' : 'create';
    _ibDrawerTarget    = 'existing';
    _ibDrawerVarenr    = '';
    _ibDrawerHokaName  = '';
    _ibDrawerHokaPrice = null;
    _ibDrawerGrocyId   = null;
    _ibDrawerGrocyName = '';
    _ibDrawerBusy      = false;
    _ibDrawerPcMounted = false;

    var coupleProduct = null;
    if (_ibDrawerMode === 'couple' && opts.productId) {
        var ce = _ibFindEntry(opts.productId);
        if (ce) {
            coupleProduct      = ce.product;
            _ibDrawerGrocyId   = ce.product.id;
            _ibDrawerGrocyName = ce.product.name;
        }
    }

    var title = _ibDrawerMode === 'couple'
        ? 'Kobl varenummer · ' + _ibEsc(_ibDrawerGrocyName)
        : 'Opret / kobl vare';

    var scrim = document.createElement('div');
    scrim.className = 'ib-dr-scrim';
    scrim.innerHTML =
        '<div class="ib-dr-drawer" role="dialog" aria-label="Opret eller kobl vare">' +
            '<div class="ib-dr-head"><h3>' + title + '</h3>' +
                '<button class="ib-dr-x" data-dr="close" aria-label="Luk">×</button></div>' +
            '<div class="ib-dr-body">' +
                _ibDrawerStep1Html() +
                _ibDrawerStep2Html(coupleProduct) +
            '</div>' +
            '<div class="ib-dr-foot">' +
                '<button class="ib-dr-btn" data-dr="close">Annuller</button>' +
                '<button class="ib-dr-btn save" data-dr="save">Læg på liste</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(scrim);
    _ibDrawer = scrim;

    scrim.addEventListener('click', _ibDrawerClick);
    scrim.addEventListener('input', _ibDrawerInput);
    scrim.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' && ev.target.classList.contains('ib-dr-hkq')) {
            ev.preventDefault();
            _ibDrawerHkSearch();
        }
    });
    var esc = function(ev) { if (ev.key === 'Escape') _ibCloseDrawer(); };
    document.addEventListener('keydown', esc);
    scrim._esc = esc;

    setTimeout(function() { scrim.classList.add('on'); }, 20);
    _ibDrawerSyncFoot();

    // Couple-mode: forudfyld Hørkram-søgning med varenavnet og kør den
    if (_ibDrawerMode === 'couple' && _ibDrawerGrocyName) {
        var hkq = scrim.querySelector('.ib-dr-hkq');
        if (hkq) hkq.value = _ibDrawerGrocyName;
        _ibDrawerHkSearch();
    }
}

function _ibCloseDrawer() {
    var existing = document.querySelector('.ib-dr-scrim');
    if (!existing) return;
    if (existing._esc) document.removeEventListener('keydown', existing._esc);
    if (_ibDrawerPcMounted && typeof cleanupProductCreate === 'function') {
        try { cleanupProductCreate(); } catch (e) { /* noop */ }
    }
    existing.remove();
    _ibDrawer = null;
    _ibDrawerPcMounted = false;
}

function _ibDrawerStep1Html() {
    return '' +
        '<div class="ib-dr-step ib-dr-hk">' +
            '<div class="ib-dr-step-ttl">🔖 1 · Find varenummer hos Hørkram</div>' +
            '<div class="ib-dr-note">Bestemmer hvad systemet bestiller. Uden det kan varen ikke bestilles automatisk.</div>' +
            '<div class="ib-dr-help"><b>Sådan finder du varenummeret:</b> Søg på produktnavnet herunder — ' +
                'eller åbn <a href="https://www.hoka.dk" target="_blank" rel="noopener">hoka.dk ↗</a>, ' +
                'find varen og kopiér varenummeret ind i feltet nederst.</div>' +
            '<div class="ib-dr-search">' +
                '<input class="ib-dr-hkq" placeholder="Søg på Hørkram… (navn eller varenr.)">' +
                '<button class="ib-dr-btn primary" data-dr="hk-search">Søg</button>' +
            '</div>' +
            '<div class="ib-dr-hkresults" data-dr-hkresults></div>' +
            '<div class="ib-dr-divider"><span>eller indsæt manuelt</span></div>' +
            '<label class="ib-dr-lbl">Varenummer (fra hoka.dk)</label>' +
            '<input class="ib-dr-hkmanual" placeholder="fx 17942607" data-dr="hk-manual">' +
            '<div class="ib-dr-hkstatus" data-dr-hkstatus></div>' +
        '</div>';
}

function _ibDrawerStep2Html(coupleProduct) {
    var h = '<div class="ib-dr-step">' +
        '<div class="ib-dr-step-ttl">📦 2 · Knyt til Grocy-vare</div>';
    if (_ibDrawerMode !== 'couple') {
        h += '<div class="ib-dr-tgl">' +
            '<button class="ib-dr-tgl-b on" data-dr="target-existing">Eksisterende vare</button>' +
            '<button class="ib-dr-tgl-b" data-dr="target-new">Helt ny vare</button>' +
        '</div>';
    }
    h += '<div class="ib-dr-target" data-dr-target="existing">';
    if (coupleProduct) {
        h += '<div class="ib-dr-locked">' +
            '<div><div class="ib-dr-locked-nm">' + _ibEsc(coupleProduct.name) + '</div>' +
            '<div class="ib-dr-locked-sub">findes i Grocy · mangler kun varenummer</div></div>' +
            '<span class="ib-dr-locked-tag">valgt</span></div>';
    } else {
        h += '<label class="ib-dr-lbl">Søg eksisterende Grocy-vare</label>' +
            '<input class="ib-dr-grocyq" placeholder="fx Opvaskemiddel…" data-dr="grocy-search">' +
            '<div class="ib-dr-grocyresults" data-dr-grocyresults></div>';
    }
    h += '</div>';
    h += '<div class="ib-dr-target" data-dr-target="new" style="display:none">' +
        '<div class="ib-dr-pc-mount" data-dr-pcmount></div>' +
    '</div>';
    h += '</div>';
    return h;
}

function _ibDrawerSetTarget(t) {
    if (!_ibDrawer || _ibDrawerMode === 'couple') return;
    _ibDrawerTarget = t;
    _ibDrawer.querySelectorAll('[data-dr-target]').forEach(function(el) {
        el.style.display = el.getAttribute('data-dr-target') === t ? '' : 'none';
    });
    var bE = _ibDrawer.querySelector('[data-dr="target-existing"]');
    var bN = _ibDrawer.querySelector('[data-dr="target-new"]');
    if (bE) bE.classList.toggle('on', t === 'existing');
    if (bN) bN.classList.toggle('on', t === 'new');
    if (t === 'new' && !_ibDrawerPcMounted) _ibDrawerMountNew();
    _ibDrawerSyncFoot();
}

function _ibDrawerSyncFoot() {
    if (!_ibDrawer) return;
    var save = _ibDrawer.querySelector('[data-dr="save"]');
    // Gren B (ny vare) har product_create's egen submit-knap
    if (save) save.style.display = _ibDrawerTarget === 'existing' ? '' : 'none';
}

function _ibDrawerMountNew() {
    if (!_ibDrawer) return;
    var mount = _ibDrawer.querySelector('[data-dr-pcmount]');
    if (!mount) return;
    if (typeof initProductCreate !== 'function') {
        mount.innerHTML = '<div class="ib-dr-note">Produktoprettelse er ikke tilgængelig her.</div>';
        return;
    }
    _ibDrawerPcMounted = true;
    initProductCreate(mount, {
        barcode: _ibDrawerVarenr || null,
        onCreated: _ibDrawerOnProductCreated,
    });
}

async function _ibDrawerHkSearch() {
    if (!_ibDrawer) return;
    var inp = _ibDrawer.querySelector('.ib-dr-hkq');
    var box = _ibDrawer.querySelector('[data-dr-hkresults]');
    var q = inp ? inp.value.trim() : '';
    if (!q || !box) return;
    box.innerHTML = '<div class="ib-dr-loading">Søger i Hørkram-katalog…</div>';
    try {
        var data = await fetchHokaSearch(q);
        var results = (data.results || []).slice(0, 8);
        if (!results.length) {
            box.innerHTML = '<div class="ib-dr-loading">Ingen resultater for "' + _ibEsc(q) + '"</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var vr = String(r.varenummer || r.id || '');
            html += '<div class="ib-dr-res' + (vr === _ibDrawerVarenr ? ' sel' : '') + '" data-dr-res="' + _ibEsc(vr) + '"' +
                ' data-dr-resname="' + _ibEsc(r.name || '') + '"' +
                (r.pricePerKg ? ' data-dr-resprice="' + r.pricePerKg + '"' : '') + '>' +
                '<div><div class="ib-dr-res-nm">' + _ibEsc(r.name || '') +
                    (r.isAgreementItem ? ' <span class="ib-dr-agr">Aftale</span>' : '') + '</div>' +
                '<div class="ib-dr-res-sub">Varenr. ' + _ibEsc(vr) +
                    (r.pricePerKg ? ' · ' + _ibFmtNum(r.pricePerKg) + ' kr/kg' : '') + '</div></div>' +
                '<button class="ib-dr-btn sm" data-dr="hk-pick">Vælg</button></div>';
        }
        box.innerHTML = html;
    } catch (err) {
        box.innerHTML = '<div class="ib-dr-loading">Søgefejl: ' + _ibEsc(err.message || '') + '</div>';
    }
}

function _ibDrawerSetVarenr(varenr, name, price) {
    _ibDrawerVarenr    = String(varenr || '').trim();
    _ibDrawerHokaName  = name || '';
    _ibDrawerHokaPrice = (price != null && price !== '' && !isNaN(price)) ? parseFloat(price) : null;
    if (!_ibDrawer) return;
    var manual = _ibDrawer.querySelector('.ib-dr-hkmanual');
    if (manual) manual.value = _ibDrawerVarenr;
    var status = _ibDrawer.querySelector('[data-dr-hkstatus]');
    if (status) {
        status.className = 'ib-dr-hkstatus ok';
        status.textContent = '✓ ' + (_ibDrawerHokaName || ('varenr. ' + _ibDrawerVarenr));
    }
    _ibDrawer.querySelectorAll('.ib-dr-res').forEach(function(el) {
        el.classList.toggle('sel', el.getAttribute('data-dr-res') === _ibDrawerVarenr);
    });
}

function _ibDrawerOnManual(val) {
    var v = String(val || '').trim();
    _ibDrawerVarenr    = v;
    _ibDrawerHokaName  = '';
    _ibDrawerHokaPrice = null;
    if (_ibDrawer) {
        _ibDrawer.querySelectorAll('.ib-dr-res').forEach(function(el) { el.classList.remove('sel'); });
    }
    var status = _ibDrawer && _ibDrawer.querySelector('[data-dr-hkstatus]');
    if (!status) return;
    if (!v) { status.className = 'ib-dr-hkstatus'; status.textContent = ''; return; }
    status.className = 'ib-dr-hkstatus pending';
    status.textContent = 'Tjekker hos Hørkram…';
    clearTimeout(_ibDrawerManualTimer);
    _ibDrawerManualTimer = setTimeout(function() {
        var checking = v;
        lookupHokaVarenr(v).then(function(res) {
            if (_ibDrawerVarenr !== checking || !_ibDrawer) return;
            var st = _ibDrawer.querySelector('[data-dr-hkstatus]');
            if (!st) return;
            if (res.found) {
                _ibDrawerHokaName  = res.name || '';
                _ibDrawerHokaPrice = res.pricePerUnit || res.pricePerKg || null;
                st.className = 'ib-dr-hkstatus ok';
                st.textContent = '✓ ' + (_ibDrawerHokaName || ('varenr. ' + v)) +
                    (_ibDrawerHokaPrice ? ' · ' + _ibFmtNum(_ibDrawerHokaPrice) + ' kr' : '');
            } else {
                st.className = 'ib-dr-hkstatus warn';
                st.textContent = '⚠ Varenummeret blev ikke fundet hos Hørkram — du kan stadig koble.';
            }
        });
    }, 550);
}

function _ibDrawerGrocySearch(q) {
    var box = _ibDrawer && _ibDrawer.querySelector('[data-dr-grocyresults]');
    if (!box) return;
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) { box.innerHTML = ''; return; }
    var hits = [];
    for (var id in _ibProducts) {
        var p = _ibProducts[id];
        if (p && p.name && p.name.toLowerCase().indexOf(q) >= 0) {
            hits.push(p);
            if (hits.length >= 12) break;
        }
    }
    if (!hits.length) {
        box.innerHTML = '<div class="ib-dr-note">Ingen match — skift til "Helt ny vare" hvis den ikke findes.</div>';
        return;
    }
    var html = '';
    for (var i = 0; i < hits.length; i++) {
        html += '<div class="ib-dr-res' + (hits[i].id === _ibDrawerGrocyId ? ' sel' : '') + '"' +
            ' data-dr-grocy="' + hits[i].id + '" data-dr-grocyname="' + _ibEsc(hits[i].name) + '">' +
            '<div><div class="ib-dr-res-nm">' + _ibEsc(hits[i].name) + '</div>' +
            '<div class="ib-dr-res-sub">eksisterende Grocy-vare</div></div>' +
            '<button class="ib-dr-btn sm" data-dr="grocy-pick">Vælg</button></div>';
    }
    box.innerHTML = html;
}

async function _ibDrawerSave() {
    if (_ibDrawerBusy) return;
    var varenr = _ibDrawerVarenr;
    if (!varenr) { _ibToast('Indtast eller vælg et varenummer først', true); return; }
    if (!_ibDrawerGrocyId) { _ibToast('Vælg en Grocy-vare først', true); return; }
    _ibDrawerBusy = true;
    var saveBtn = _ibDrawer && _ibDrawer.querySelector('[data-dr="save"]');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Gemmer…'; }

    function _restoreBtn() {
        _ibDrawerBusy = false;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Læg på liste'; }
    }

    try {
        // Numerisk Hørkram-varenr → barcode lander i første api-handelssted
        var locId = null;
        if (/^\d+$/.test(varenr)) {
            for (var hi = 0; hi < _ibHandelssteder.length; hi++) {
                if (_ibHandelssteder[hi].integration_type === 'api' && _ibHandelssteder[hi].grocy_location_id) {
                    locId = _ibHandelssteder[hi].grocy_location_id;
                    break;
                }
            }
        }
        var bcPayload = {
            product_id: parseInt(_ibDrawerGrocyId),
            barcode: String(varenr),
            note: _ibDrawerHokaName || _ibDrawerGrocyName || '',
        };
        if (locId) bcPayload.shopping_location_id = locId;
        if (_ibDrawerHokaPrice) bcPayload.last_price = _ibDrawerHokaPrice;

        try {
            await createProductBarcode(bcPayload);
        } catch (bcErr) {
            if (bcErr.code === 'BARCODE_DUPLICATE' || bcErr.status === 409) {
                _ibToast('Varenummeret er allerede koblet til denne vare', true);
                _restoreBtn();
                return;
            }
            throw bcErr;
        }

        // Couple-varen ligger allerede på listen — undgå dublet sl-linje
        if (_ibDrawerMode === 'create') {
            await addShoppingListProduct(parseInt(_ibDrawerGrocyId), 1, 1);
        }

        _ibToast('✓ varenr. ' + varenr + ' koblet til "' + (_ibDrawerGrocyName || '') + '" · lagt på listen');
        _ibCloseDrawer();
        await _ibDrawerRefreshIndkob();
    } catch (err) {
        _ibToast('Fejl: ' + (err.message || 'Kunne ikke gemme'), true);
        _restoreBtn();
    }
}

async function _ibDrawerOnProductCreated(productId, name, warnings) {
    if (warnings && warnings.length) {
        console.warn('[indkob] produkt oprettet med advarsler:', warnings);
    }
    try {
        await addShoppingListProduct(parseInt(productId), 1, 1);
    } catch (err) {
        _ibToast('Produkt oprettet, men kunne ikke lægges på listen: ' + (err.message || ''), true);
        _ibCloseDrawer();
        await _ibDrawerRefreshIndkob();
        return;
    }
    var msg = '✓ "' + name + '" oprettet i Grocy';
    if (_ibDrawerVarenr) msg += ' + koblet til varenr. ' + _ibDrawerVarenr;
    msg += ' · lagt på listen';
    _ibToast(msg);
    _ibCloseDrawer();
    await _ibDrawerRefreshIndkob();
}

async function _ibDrawerRefreshIndkob() {
    try {
        var res = await Promise.all([fetchShoppingList(), fetchProductBarcodes(), fetchGrocyProducts()]);
        _ibShoppingList = res[0] || [];
        _ibBarcodes     = res[1] || [];
        var prods = res[2] || [];
        _ibProducts = {};
        for (var i = 0; i < prods.length; i++) _ibProducts[prods[i].id] = prods[i];
        _ibBuildGroups();
        _ibRender();
        _ibEnrichSnapshots();
    } catch (e) {
        console.warn('[indkob] refresh efter drawer fejlede:', e.message);
    }
}

function _ibDrawerClick(e) {
    if (isOutsideClick(e, _ibDrawer)) { _ibCloseDrawer(); return; }
    var btn = e.target.closest('[data-dr]');
    if (!btn) return;
    switch (btn.getAttribute('data-dr')) {
        case 'close':
            _ibCloseDrawer();
            break;
        case 'hk-search':
            _ibDrawerHkSearch();
            break;
        case 'hk-pick':
            var res = btn.closest('[data-dr-res]');
            if (res) _ibDrawerSetVarenr(res.getAttribute('data-dr-res'), res.getAttribute('data-dr-resname'), res.getAttribute('data-dr-resprice'));
            break;
        case 'grocy-pick':
            var gr = btn.closest('[data-dr-grocy]');
            if (gr && _ibDrawer) {
                _ibDrawerGrocyId   = parseInt(gr.getAttribute('data-dr-grocy'));
                _ibDrawerGrocyName = gr.getAttribute('data-dr-grocyname') || '';
                _ibDrawer.querySelectorAll('[data-dr-grocy]').forEach(function(el) {
                    el.classList.toggle('sel', el === gr);
                });
            }
            break;
        case 'target-existing':
            _ibDrawerSetTarget('existing');
            break;
        case 'target-new':
            _ibDrawerSetTarget('new');
            break;
        case 'save':
            _ibDrawerSave();
            break;
    }
}

function _ibDrawerInput(e) {
    var act = e.target.getAttribute('data-dr');
    if (act === 'hk-manual') {
        _ibDrawerOnManual(e.target.value);
    } else if (act === 'grocy-search') {
        clearTimeout(e.target._t);
        var gv = e.target.value;
        e.target._t = setTimeout(function() { _ibDrawerGrocySearch(gv); }, 200);
    }
}
