/* ══════════════════════════════════════════════════════════════
   indkob_settings.js — Indkøbsindstillinger (kitchen slide-in + office page)
   Entry: initIndkobSettings(containerEl, { mode: 'panel'|'page' })
   Prefix: _is
   ══════════════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────────────── */
var _isContainer    = null;
var _isMode         = 'panel';
var _isActiveTab    = 0;
var _isTabLoaded    = [false, false, false, false];

// Tab 1 data
var _isSuppliers    = [];
var _isGrocyLocs    = [];    // merged locations from purchasing endpoint
var _isSupDropdown  = [];    // supplier dropdown list
var _isEditId       = null;  // supplier id being edited

// Tab 2 data
var _isProducts     = [];
var _isAllProducts  = [];    // unfiltered
var _isProdDirty    = {};    // productId → { field: newValue }
var _isProdCols     = null;  // user column prefs
var _isProdFilter   = { q: '', supplier: '', group: '' };

// Tab 3 data
var _isHokaHealth   = null;
var _isHkTab        = 0;
var _isBarcodes     = [];
var _isHkFavs       = [];
var _isUnlinked     = [];
var _isAllBarcodes  = [];
var _isDeadBarcodes = {};  // varenr → true (udgåede hos Hoka)
var _isDeadChecked  = false;
var _isAddPackProductId = null;  // product_id with open pack-size search panel

// Tab 4 data (duplikat-kandidater)
var _isDupRows      = [];
var _isDupFilter    = 'pending';

var _isToastTimer   = null;

/* ── Column definitions for Tab 2 ──────────────────────────── */
var _IS_PROD_COLS = [
    { key: 'supplier',    label: 'Leverandør',     default: true  },
    { key: 'min_stock',   label: 'Minimumsgrænse', default: true  },
    { key: 'unit',        label: 'Enhed',          default: true  },
    { key: 'group',       label: 'Produktgruppe',  default: false },
    { key: 'price_kg',    label: 'Pris/kg',        default: false },
    { key: 'updated',     label: 'Sidst opdateret',default: false },
];

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
async function initIndkobSettings(containerEl, options) {
    _isContainer = containerEl;
    _isMode = (options && options.mode) || 'panel';
    _isActiveTab = 0;
    _isTabLoaded = [false, false, false, false];
    _isEditId = null;
    _isProdDirty = {};

    _isLoadColPrefs();
    _isRenderShell();

    var loadErr = null;
    try {
        var results = await Promise.all([
            fetchPurchasingSuppliers(),
            fetchPurchasingGrocyLocations(),
            fetchHokaStatus().catch(function() { return null; }),
        ]);
        _isSuppliers  = results[0] || [];
        var locData   = results[1] || {};
        _isGrocyLocs  = locData.locations || [];
        _isSupDropdown = locData.suppliers || [];
        _isHokaHealth = results[2];
    } catch (err) {
        console.error('[is] init load error:', err);
        loadErr = err;
        _isSuppliers = [];
        _isGrocyLocs = [];
        _isSupDropdown = [];
    }

    _isTabLoaded[0] = true;
    if (loadErr) {
        var body = document.getElementById('isBody');
        if (body) {
            body.innerHTML = '<div class="is-section" style="text-align:center;padding:40px 20px">' +
                '<div style="font-size:32px;margin-bottom:8px">⚠</div>' +
                '<div style="font-weight:700;color:#c44;margin-bottom:6px">Kunne ikke indlæse indkøbsdata</div>' +
                '<div style="font-size:13px;color:var(--color-text-dim,#777)">' + (loadErr.message || 'Ukendt fejl') + '</div>' +
                '<button class="is-add-btn" style="margin-top:18px" onclick="window.location.reload()">Prøv igen</button>' +
                '</div>';
        }
        return;
    }
    _isRenderTab(0);
}

/* ── Column prefs ──────────────────────────────────────────── */
function _isLoadColPrefs() {
    try {
        var saved = localStorage.getItem('ib_settings_product_cols');
        if (saved) { _isProdCols = JSON.parse(saved); return; }
    } catch (e) { /* ignore */ }
    _isProdCols = {};
    _IS_PROD_COLS.forEach(function(c) { _isProdCols[c.key] = c.default; });
}
function _isSaveColPrefs() {
    try { localStorage.setItem('ib_settings_product_cols', JSON.stringify(_isProdCols)); } catch (e) { /* */ }
}
function _isColOn(key) { return _isProdCols && _isProdCols[key]; }

/* ══════════════════════════════════════════════════════════════
   SHELL — header + tabs + body
   ══════════════════════════════════════════════════════════════ */
function _isRenderShell() {
    var modeClass = _isMode === 'page' ? ' is-mode-page' : '';
    _isContainer.innerHTML =
        '<div class="is-shell' + modeClass + '">' +
            '<div class="is-hdr">' +
                '<span style="font-size:16px">⚙</span>' +
                '<span class="is-hdr-title">Indkøbsindstillinger</span>' +
                '<button class="is-hdr-close" data-is="close">&times;</button>' +
            '</div>' +
            '<div class="is-tabs">' +
                '<div class="is-tab on" data-is="tab" data-idx="0">Leverandører</div>' +
                '<div class="is-tab" data-is="tab" data-idx="1">Produkter</div>' +
                '<div class="is-tab" data-is="tab" data-idx="2">Hørkram</div>' +
                '<div class="is-tab" data-is="tab" data-idx="3">Duplikater</div>' +
            '</div>' +
            '<div class="is-body" id="isBody"></div>' +
        '</div>';

    // Event delegation on container
    _isContainer.addEventListener('click', _isHandleClick);
    _isContainer.addEventListener('change', _isHandleChange);
    _isContainer.addEventListener('input', _isHandleInput);
}

/* ══════════════════════════════════════════════════════════════
   EVENT DELEGATION
   ══════════════════════════════════════════════════════════════ */
function _isHandleClick(e) {
    var t = e.target.closest('[data-is]');
    if (!t) return;
    var action = t.dataset.is;
    var rawId = t.dataset.id || null;
    var id = rawId && /^\d+$/.test(rawId) ? parseInt(rawId) : rawId;

    // Tabs
    if (action === 'tab') {
        var idx = parseInt(t.dataset.idx);
        if (idx === _isActiveTab) return;
        _isActiveTab = idx;
        _isContainer.querySelectorAll('.is-tab').forEach(function(el, i) {
            el.classList.toggle('on', i === idx);
        });
        if (!_isTabLoaded[idx]) {
            _isTabLoaded[idx] = true;
            _isLoadTabData(idx);
        } else {
            _isRenderTab(idx);
        }
        return;
    }

    if (action === 'close') {
        if (typeof toggleIndkobSettings === 'function') toggleIndkobSettings();
        return;
    }

    // ─── Tab 4: Duplikater ───
    if (action === 'dup-act') { _isUpdateDuplicate(id, t.dataset.status); return; }

    // ─── Tab 1: Suppliers ───
    if (action === 'sup-edit')    { _isEditSupplier(id); return; }
    if (action === 'sup-delete')  { _isDeleteSupplier(id); return; }
    if (action === 'sup-save')    { _isSaveSupplier(); return; }
    if (action === 'sup-cancel')  { _isEditId = null; _isRenderTab(0); return; }
    if (action === 'sup-add')     { _isAddSupplier(); return; }
    if (action === 'gloc-create-supplier') {
        _isCreateSupplierForLocation(parseInt(t.dataset.locid), t.dataset.locname);
        return;
    }
    if (action === 'sup-mail')    { _isOpenSupplierMail(id); return; }

    // ─── Tab 2: Products ───
    if (action === 'prod-save')    { _isProdBulkSave(); return; }
    if (action === 'prod-discard') { _isProdDirty = {}; _isRenderTab(1); return; }
    if (action === 'col-toggle') {
        var col = t.dataset.col;
        _isProdCols[col] = !_isProdCols[col];
        _isSaveColPrefs();
        _isRenderTab(1);
        return;
    }

    // ─── Tab 3: Hørkram ───
    if (action === 'hk-tab') {
        _isHkTab = parseInt(t.dataset.idx);
        _isRenderHkBody();
        return;
    }
    if (action === 'hk-search')      { _isHkDoSearch(); return; }
    if (action === 'hk-link')        { _isHkLinkToGrocy(id); return; }
    if (action === 'hk-update-price'){ _isHkUpdatePrice(id); return; }
    if (action === 'hk-fav-import')  { _isHkFavImport(id); return; }
    if (action === 'hk-fav-link')    { _isHkFavLinkUnlinked(id); return; }
    if (action === 'hk-unlinked-search') { _isHkUnlinkedSearch(id); return; }
    if (action === 'hk-unlinked-pick') { _isHkUnlinkedPick(t); return; }
    if (action === 'hk-batch-update'){ _isHkBatchPriceUpdate(); return; }
    if (action === 'hk-check-dead') { _isHkCheckDead(); return; }
    if (action === 'hk-bc-save')     { _isHkBcSave(); return; }
    if (action === 'hk-bc-pref')     { _isHkBcTogglePref(id); return; }
    if (action === 'hk-add-pack')    { _isHkAddPackToggle(parseInt(id)); return; }
    if (action === 'hk-pack-search') { _isHkPackSearch(parseInt(id)); return; }
    if (action === 'hk-pack-link')   { _isHkPackLink(t); return; }
    if (action === 'hk-bc-delete')   { _isHkBcDelete(parseInt(id)); return; }
}

function _isHandleChange(e) {
    var t = e.target.closest('[data-is]');
    if (!t) return;
    var action = t.dataset.is;

    if (action === 'gloc-select') {
        _isGlocChange(parseInt(t.dataset.locid), t.value);
        return;
    }
    if (action === 'gloc-name') {
        _isGlocNameChange(parseInt(t.dataset.locid), t.value);
        return;
    }
    if (action === 'prod-supplier' || action === 'prod-minstock') {
        _isProdFieldChange(t);
        return;
    }
    if (action === 'dup-filter') {
        _isDupFilter = t.value;
        _isLoadDuplicates();
        return;
    }
}

function _isHandleInput(e) {
    var t = e.target;
    if (t.dataset && t.dataset.is === 'prod-search') {
        _isProdFilter.q = t.value.toLowerCase();
        // Søgefeltet er INDE i den re-renderede tab — bevar fokus + markør.
        withFocusPreserved(_isContainer, _isProdFilterAndRender);
    }
}

/* ══════════════════════════════════════════════════════════════
   TAB DATA LOADING (lazy)
   ══════════════════════════════════════════════════════════════ */
async function _isLoadTabData(idx) {
    var body = document.getElementById('isBody');
    body.innerHTML = '<div class="is-loading">Indlæser...</div>';

    try {
        if (idx === 1) {
            var results = await Promise.all([
                fetchGrocyProducts(),
                fetchShoppingLocations(),
                fetchProductBarcodes(),
            ]);
            var allProds = results[0] || [];
            var shopLocs = results[1] || [];
            _isBarcodes = results[2] || [];

            // Build shopping location map
            var locMap = {};
            shopLocs.forEach(function(l) { locMap[l.id] = l.name || l.description || ('Lok ' + l.id); });

            // Enrich products
            _isAllProducts = allProds.map(function(p) {
                return {
                    id: p.id,
                    name: p.name,
                    group: p.product_group_id ? (p.product_group || '') : '',
                    group_id: p.product_group_id || null,
                    unit: p.qu_id_stock_name || '',
                    shopping_location_id: p.shopping_location_id || null,
                    shopping_location_name: p.shopping_location_id ? (locMap[p.shopping_location_id] || '') : '',
                    min_stock_amount: p.min_stock_amount || 0,
                    userfields: p.userfields || {},
                };
            }).sort(function(a, b) { return a.name.localeCompare(b.name, 'da'); });
            _isProducts = _isAllProducts.slice();
        }

        if (idx === 2) {
            var results2 = await Promise.all([
                fetchProductBarcodes(),
                fetchHokaStatus().catch(function() { return null; }),
                fetchHokaFavorites().catch(function() { return []; }),
            ]);
            _isAllBarcodes = results2[0] || [];
            _isHokaHealth = results2[1];
            _isHkFavs = results2[2] || [];
            if (_isHkFavs.lists) _isHkFavs = _isHkFavs.lists;

            // Find unlinked Grocy products (no HK barcode)
            var hkLocIds = _isGrocyLocs
                .filter(function(l) { return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name); })
                .map(function(l) { return l.grocy_location_id; });
            var linkedProductIds = {};
            _isAllBarcodes.forEach(function(bc) {
                if (hkLocIds.indexOf(bc.shopping_location_id) >= 0) {
                    linkedProductIds[bc.product_id] = true;
                }
            });
            if (_isAllProducts.length === 0) {
                var prods = await fetchGrocyProducts();
                _isAllProducts = (prods || []).map(function(p) {
                    return { id: p.id, name: p.name, group: p.product_group || '', group_id: p.product_group_id };
                });
            }
            _isUnlinked = _isAllProducts.filter(function(p) {
                return !linkedProductIds[p.id] && p.shopping_location_id !== null;
            });
        }

        if (idx === 3) {
            _isDupRows = await _isFetchDuplicates(_isDupFilter);
        }
    } catch (err) {
        console.error('[is] tab data error:', err);
        body.innerHTML = '<div class="is-loading">Fejl ved indlæsning: ' + (err.message || '') + '</div>';
        return;
    }

    _isRenderTab(idx);
}

/* ══════════════════════════════════════════════════════════════
   TAB RENDER DISPATCH
   ══════════════════════════════════════════════════════════════ */
function _isRenderTab(idx) {
    var body = document.getElementById('isBody');
    if (!body) return;
    if (idx === 0) _isRenderSuppliers(body);
    if (idx === 1) _isRenderProducts(body);
    if (idx === 2) _isRenderHorkram(body);
    if (idx === 3) _isRenderDuplicates(body);
}

/* ══════════════════════════════════════════════════════════════
   TAB 1 — LEVERANDØRER
   ══════════════════════════════════════════════════════════════ */
function _isRenderSuppliers(body) {
    // Grocy-lokationsnavne pr. id — /purchasing/suppliers leverer kun koblingens
    // display_name, så uden dette opslag ender en kobling uden eget visningsnavn
    // som "Lok 7" i stedet for "Emballage".
    var locNames = {};
    _isGrocyLocs.forEach(function(l) { locNames[l.grocy_location_id] = l.grocy_location_name; });

    // Group suppliers (deduplicate by supplier_id, collect grocy_location_ids)
    var supMap = {};
    var supOrder = [];
    _isSuppliers.forEach(function(r) {
        if (!supMap[r.supplier_id]) {
            supMap[r.supplier_id] = {
                id: r.supplier_id, name: r.supplier_name, type: r.integration_type,
                email: r.contact_email, phone: r.contact_phone,
                webshop: r.webshop_url, notes: r.supplier_notes, active: r.is_active,
                locs: []
            };
            supOrder.push(r.supplier_id);
        }
        if (r.grocy_location_id) {
            supMap[r.supplier_id].locs.push({
                id: r.grocy_location_id,
                name: r.grocy_location_display_name || locNames[r.grocy_location_id]
                    || ('Lok ' + r.grocy_location_id)
            });
        }
    });

    var html = '<div class="is-section"><div class="is-section-title">Leverandører</div>';

    // Supplier table
    html += '<table class="is-sup-table"><thead><tr>' +
        '<th>Navn</th><th>Type</th><th>Kontakt</th><th>Grocy-lokationer</th><th style="width:60px"></th>' +
        '</tr></thead><tbody>';

    supOrder.forEach(function(sid) {
        var s = supMap[sid];
        html += '<tr>';
        // Name
        html += '<td><div class="is-sup-name">' + _isEsc(s.name) + '</div>';
        if (s.notes) html += '<div class="is-sup-note">' + _isEsc(s.notes) + '</div>';
        html += '</td>';
        // Type badge
        html += '<td><span class="is-it-badge is-it-' + s.type + '">' + s.type + '</span></td>';
        // Contact
        html += '<td>';
        if (s.email) html += '<div style="font-size:12px">' + _isEsc(s.email) + '</div>';
        if (s.phone) html += '<div style="font-size:11px;color:var(--color-text-dim)">' + _isEsc(s.phone) + '</div>';
        html += '</td>';
        // Grocy locations
        html += '<td>';
        if (s.locs.length) {
            s.locs.forEach(function(l) {
                html += '<span class="is-loc-chip">' + _isEsc(l.name) + '</span>';
            });
        } else {
            html += '<span class="is-loc-chip unlinked">Ikke koblet</span>';
        }
        html += '</td>';
        // Actions
        html += '<td style="white-space:nowrap">' +
            '<button class="is-icon-btn" data-is="sup-mail" data-id="' + s.id + '" title="Skriv mail til leverandør">' + mailIcon(14) + '</button> ' +
            '<button class="is-icon-btn" data-is="sup-edit" data-id="' + s.id + '" title="Rediger">✏</button> ' +
            '<button class="is-icon-btn del" data-is="sup-delete" data-id="' + s.id + '" title="Slet">✕</button>' +
            '</td>';
        html += '</tr>';

        // Inline edit form
        if (_isEditId === s.id) {
            html += '<tr><td colspan="5">' + _isEditForm(s) + '</td></tr>';
        }
    });
    html += '</tbody></table>';
    html += '<button class="is-add-btn" data-is="sup-add">+ Tilføj leverandør</button>';

    // New supplier form
    if (_isEditId === -1) {
        html += _isEditForm({ id: -1, name: '', type: 'manual', email: '', phone: '', webshop: '', notes: '', active: 1 });
    }

    // Grocy-location linking section
    html += '<div class="is-gloc-section"><div class="is-section-title">Grocy-lokationer — kobling til leverandør</div>';
    // Selve forklaringen af de to begreber ligger i hjælpesystemet (H) — her står
    // kun det man skal bruge for at udfylde felterne.
    html += '<div class="is-gloc-help">Binder stedet varen købes (Grocy) sammen med ' +
        'den vi sender bestillingen til (Bon). Visningsnavnet er det gruppen hedder i ' +
        'indkøbslisten — tomt = lokationens eget navn. <b>Tryk H</b> for hele forklaringen.</div>';
    _isGrocyLocs.forEach(function(loc) {
        html += '<div class="is-gloc-row">';
        html += '<span class="is-gloc-name">' + _isEsc(loc.grocy_location_name) + '</span>';
        if (loc.linked_supplier_id) {
            html += '<span class="is-gloc-linked">✓ ' + _isEsc(loc.linked_supplier_name) + '</span>';
        } else {
            html += '<span class="is-gloc-unlinked">Ikke koblet</span>';
        }
        html += '<select class="is-gloc-sel" data-is="gloc-select" data-locid="' + loc.grocy_location_id + '">';
        html += '<option value="">— Vælg leverandør —</option>';
        _isSupDropdown.forEach(function(s) {
            var sel = loc.linked_supplier_id === s.id ? ' selected' : '';
            html += '<option value="' + s.id + '"' + sel + '>' + _isEsc(s.name) + ' (' + s.integration_type + ')</option>';
        });
        html += '</select>';
        // Ukoblet lokation: lav leverandøren herfra i stedet for at sende folk op
        // i tabellen, oprette den, og finde vejen tilbage hertil. Navnet er
        // næsten altid det samme som lokationens.
        if (!loc.linked_supplier_id) {
            html += '<button class="is-gloc-new" data-is="gloc-create-supplier"' +
                ' data-locid="' + loc.grocy_location_id + '"' +
                ' data-locname="' + _isEsc(loc.grocy_location_name) + '">+ Opret leverandør</button>';
        }
        // Visningsnavn — kun meningsfuldt når lokationen faktisk er koblet.
        if (loc.linked_supplier_id) {
            html += '<input class="is-gloc-nm" data-is="gloc-name" data-locid="' + loc.grocy_location_id + '"' +
                ' placeholder="' + _isEsc(loc.grocy_location_name) + '"' +
                ' title="Vises som gruppenavn i indkøbslisten"' +
                ' maxlength="80" value="' + _isEsc(loc.display_name || '') + '">';
        }
        html += '</div>';
    });
    html += '</div></div>';

    body.innerHTML = html;
}

function _isEditForm(s) {
    var isNew = s.id === -1;
    var types = ['api', 'email', 'manual', 'webshop', 'intern'];
    var typeOpts = types.map(function(t) {
        return '<option value="' + t + '"' + (s.type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    return '<div class="is-edit-form">' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Navn</label>' +
            '<input class="is-edit-input" id="isEdName" value="' + _isEsc(s.name) + '">' +
        '</div>' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Integration</label>' +
            '<select class="is-edit-select" id="isEdType">' + typeOpts + '</select>' +
        '</div>' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Bestillingsmail</label>' +
            '<input class="is-edit-input" id="isEdEmail" value="' + _isEsc(s.email || '') + '" placeholder="bestilling@leverandoer.dk">' +
            (!s.email && s.id !== -1 ? '<div class="is-edit-hint">Ingen mail — bestilling sker manuelt</div>' : '') +
        '</div>' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Telefon</label>' +
            '<input class="is-edit-input" id="isEdPhone" value="' + _isEsc(s.phone || '') + '">' +
        '</div>' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Webshop URL</label>' +
            '<input class="is-edit-input" id="isEdWebshop" value="' + _isEsc(s.webshop || '') + '">' +
        '</div>' +
        '<div class="is-edit-row">' +
            '<label class="is-edit-label">Noter</label>' +
            '<input class="is-edit-input" id="isEdNotes" value="' + _isEsc(s.notes || '') + '">' +
        '</div>' +
        '<div class="is-edit-actions">' +
            '<button class="is-btn is-btn-secondary" data-is="sup-cancel">Annuller</button> ' +
            '<button class="is-btn is-btn-primary" data-is="sup-save">' + (isNew ? 'Opret' : 'Gem') + '</button>' +
        '</div>' +
    '</div>';
}

function _isEditSupplier(id) {
    _isEditId = id;
    _isRenderTab(0);
}

/**
 * Åbn supplier-mail panel for en leverandør.
 * - I 'panel'-mode (slide-in fra purchasing.html): lukker settings-panelet og
 *   folder mail-panelet ud i Indkøb-tabben uden side-skift.
 * - I 'page'-mode (settings/index.html): åbner purchasing.html i ny fane.
 */
function _isOpenSupplierMail(id) {
    if (_isMode === 'panel' && typeof toggleIndkobSettings === 'function' && typeof _ibGroups !== 'undefined') {
        // Vi er allerede på purchasing.html — find gruppen og folde panel ud inline
        for (var key in _ibGroups) {
            if (_ibGroups[key].supplierId === id) {
                toggleIndkobSettings(); // luk settings-panelet
                _ibOpenGroups[key] = true;
                _ibToggleSupMail(key);
                // Scroll til gruppen
                setTimeout(function() {
                    var el = document.querySelector('.ib-group[data-group="' + key + '"]');
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 200);
                return;
            }
        }
        // Fallback: hvis ingen matchende gruppe (leverandør har ingen aktive varer)
        _isToast('Leverandøren har ingen varer i indkøbslisten. Åbner mail-panel...', false);
        toggleIndkobSettings();
        // Lav en virtuel åbning via window-helper
        window.location.href = '/kitchen/purchasing.html?supplier_mail=' + id;
        return;
    }
    // Page-mode (settings/index.html) — åbn purchasing.html i ny fane
    var url = '/kitchen/purchasing.html?supplier_mail=' + id;
    window.open(url, '_blank', 'noopener');
}

async function _isSaveSupplier() {
    var data = {
        name: document.getElementById('isEdName').value.trim(),
        integration_type: document.getElementById('isEdType').value,
        contact_email: document.getElementById('isEdEmail').value.trim() || null,
        contact_phone: document.getElementById('isEdPhone').value.trim() || null,
        webshop_url: document.getElementById('isEdWebshop').value.trim() || null,
        notes: document.getElementById('isEdNotes').value.trim() || null,
    };
    if (!data.name) { _isToast('Navn er påkrævet', true); return; }

    try {
        if (_isEditId === -1) {
            await createSupplier(data);
            _isToast('Leverandør oprettet');
        } else {
            await updateSupplier(_isEditId, data);
            _isToast('Leverandør gemt');
        }
        _isEditId = null;
        await _isReloadSuppliers();
        _isRenderTab(0);
    } catch (err) {
        _isToast('Fejl: ' + (err.message || 'Ukendt'), true);
    }
}

async function _isDeleteSupplier(id) {
    var sup = _isSupDropdown.find(function(s) { return s.id === id; });
    var name = sup ? sup.name : 'leverandør #' + id;
    if (!confirm('Deaktiver ' + name + '?')) return;

    try {
        await deleteSupplier(id);
        _isToast('Leverandør deaktiveret');
        await _isReloadSuppliers();
        _isRenderTab(0);
    } catch (err) {
        _isToast('Fejl: ' + (err.message || 'Ukendt'), true);
    }
}

function _isAddSupplier() {
    _isEditId = -1;
    _isRenderTab(0);
}

/* Gemmer visningsnavnet på en kobling. Kaldes fra 'change' (blur/Enter), ikke
   fra 'input' — ellers ville hvert tastetryk blive et PATCH-kald. */
/*
 * Opret leverandøren ud fra en ukoblet Grocy-lokation og kobl dem med det samme.
 * De to ting hedder næsten altid det samme ("Trykkeri Friheden" som butik i
 * Grocy, "Trykkeri Friheden" som den vi mailer til), men de LEVER to steder —
 * og det var dét der var uklart: lokationen dukkede op i listen uden nogen vej
 * til at gøre den til en leverandør.
 *
 * Typen sættes til 'manual' som det forsigtige udgangspunkt; formularen åbnes
 * bagefter, så mail og type kan udfyldes med det samme.
 */
async function _isCreateSupplierForLocation(locId, locName) {
    var name = (locName || '').trim();
    if (!name) return;

    var existing = _isSupDropdown.filter(function(s) {
        return (s.name || '').trim().toLowerCase() === name.toLowerCase();
    })[0];

    try {
        var sup = existing;
        if (!sup) {
            sup = await createSupplier({ name: name, integration_type: 'manual' });
        }
        await linkGrocyLocation({ grocy_location_id: locId, supplier_id: sup.id });
        await _isReloadSuppliers();
        _isToast(existing ? ('Koblet til eksisterende leverandør ' + name)
                          : ('Leverandør "' + name + '" oprettet og koblet'));
        // Åbn formularen, så mail/telefon/type kan udfyldes nu frem for senere.
        _isEditId = sup.id;
        _isRenderTab(0);
    } catch (err) {
        _isToast('Kunne ikke oprette leverandør: ' + (err.message || ''), true);
    }
}

async function _isGlocNameChange(locId, value) {
    try {
        var res = await patchGrocyLocationName(locId, value);
        // Hold den lokale kopi i sync, så en re-render (fx efter en anden
        // kobling) ikke viser den gamle værdi igen.
        for (var i = 0; i < _isGrocyLocs.length; i++) {
            if (_isGrocyLocs[i].grocy_location_id === locId) {
                _isGrocyLocs[i].display_name = res.display_name || null;
                break;
            }
        }
        _isToast(res.display_name ? ('Visningsnavn: ' + res.display_name) : 'Visningsnavn ryddet');
    } catch (err) {
        _isToast('Kunne ikke gemme visningsnavn: ' + (err.message || ''), true);
    }
}

async function _isGlocChange(locId, supplierIdStr) {
    try {
        if (supplierIdStr) {
            await linkGrocyLocation({
                grocy_location_id: locId,
                supplier_id: parseInt(supplierIdStr)
            });
            _isToast('Kobling gemt');
        } else {
            await unlinkGrocyLocation(locId);
            _isToast('Kobling fjernet');
        }
        await _isReloadSuppliers();
        // Re-render: rækken får (eller mister) visningsnavn-feltet sammen med
        // koblingen. Uden det dukker feltet først op ved næste sideindlæsning.
        _isRenderTab(0);
    } catch (err) {
        _isToast('Fejl: ' + (err.message || 'Ukendt'), true);
        _isRenderTab(0); // revert UI
    }
}

async function _isReloadSuppliers() {
    var results = await Promise.all([
        fetchPurchasingSuppliers(),
        fetchPurchasingGrocyLocations(),
    ]);
    _isSuppliers = results[0] || [];
    var locData = results[1] || {};
    _isGrocyLocs = locData.locations || [];
    _isSupDropdown = locData.suppliers || [];
}

/* ══════════════════════════════════════════════════════════════
   TAB 2 — PRODUKTER (batch editor)
   ══════════════════════════════════════════════════════════════ */
function _isRenderProducts(body) {
    var dirtyCount = Object.keys(_isProdDirty).length;

    // Column picker
    var html = '<div class="is-col-picker">';
    html += '<div class="is-col-picker-title">Vis kolonner</div>';
    html += '<div class="is-col-chips">';
    _IS_PROD_COLS.forEach(function(c) {
        var on = _isColOn(c.key) ? ' on' : '';
        html += '<span class="is-col-chip' + on + '" data-is="col-toggle" data-col="' + c.key + '">' + c.label + '</span>';
    });
    html += '</div></div>';

    // Filter bar
    html += '<div class="is-prod-filter">';
    html += '<input class="is-prod-search" placeholder="Søg produkt..." data-is="prod-search" value="' + _isEsc(_isProdFilter.q) + '">';
    // Supplier filter
    html += '<select class="is-prod-sel" data-is="prod-filter-sup">';
    html += '<option value="">Alle leverandører</option><option value="none">Ingen leverandør</option>';
    _isGrocyLocs.forEach(function(l) {
        var sel = _isProdFilter.supplier == l.grocy_location_id ? ' selected' : '';
        html += '<option value="' + l.grocy_location_id + '"' + sel + '>' + _isEsc(l.grocy_location_name) + '</option>';
    });
    html += '</select>';
    if (dirtyCount > 0) {
        html += '<span style="color:#e8a832;font-size:12px;font-weight:700">' + dirtyCount + ' ændringer</span>';
    }
    html += '</div>';

    // Product table
    html += '<div style="overflow-x:auto"><table class="is-prod-tbl"><thead><tr>';
    html += '<th>Produkt</th>';
    if (_isColOn('supplier'))  html += '<th>Leverandør</th>';
    if (_isColOn('min_stock')) html += '<th>Min. grænse</th>';
    if (_isColOn('unit'))      html += '<th>Enhed</th>';
    if (_isColOn('group'))     html += '<th>Gruppe</th>';
    if (_isColOn('price_kg'))  html += '<th>Pris/kg</th>';
    if (_isColOn('updated'))   html += '<th>Opdateret</th>';
    html += '</tr></thead><tbody>';

    _isProducts.forEach(function(p) {
        var dirty = _isProdDirty[p.id];
        var cls = dirty ? ' class="dirty"' : '';
        html += '<tr' + cls + '>';

        // Name
        html += '<td><div class="is-prod-name">';
        if (dirty) html += '<span class="is-dirty-dot"></span>';
        html += _isEsc(p.name) + '</div>';
        if (_isColOn('group') && p.group) html += '<div class="is-prod-group">' + _isEsc(p.group) + '</div>';
        html += '</td>';

        // Supplier dropdown
        if (_isColOn('supplier')) {
            var curSup = dirty && dirty.shopping_location_id !== undefined ? dirty.shopping_location_id : p.shopping_location_id;
            html += '<td><select class="is-cell-sel" data-is="prod-supplier" data-pid="' + p.id + '">';
            html += '<option value="">—</option>';
            _isGrocyLocs.forEach(function(l) {
                var sel = curSup == l.grocy_location_id ? ' selected' : '';
                html += '<option value="' + l.grocy_location_id + '"' + sel + '>' + _isEsc(l.grocy_location_name) + '</option>';
            });
            html += '</select></td>';
        }

        // Min stock
        if (_isColOn('min_stock')) {
            var curMin = dirty && dirty.min_stock_amount !== undefined ? dirty.min_stock_amount : p.min_stock_amount;
            html += '<td><input class="is-cell-num" type="number" min="0" step="1" value="' + (curMin || 0) +
                '" data-is="prod-minstock" data-pid="' + p.id + '"></td>';
        }

        // Unit (read-only)
        if (_isColOn('unit')) {
            html += '<td style="font-size:12px">' + _isEsc(p.unit || '') + '</td>';
        }

        // Group (only in col, not inline with name)
        if (_isColOn('group') && !true) { /* shown under name already */ }

        // Price/kg
        if (_isColOn('price_kg')) {
            var priceKg = (p.userfields && p.userfields.supplier_price_per_kg) || '';
            html += '<td style="font-size:12px;text-align:right">' + (priceKg ? priceKg + ' kr' : '—') + '</td>';
        }

        // Updated
        if (_isColOn('updated')) {
            var upd = (p.userfields && p.userfields.price_updated_at) || '';
            html += '<td style="font-size:11px;color:var(--color-text-dim)">' + (upd ? upd.substring(0, 10) : '—') + '</td>';
        }

        html += '</tr>';
    });
    html += '</tbody></table></div>';

    // Bulk bar
    if (dirtyCount > 0) {
        html += '<div class="is-bulk-bar">';
        html += '<div class="is-bulk-info"><strong>' + dirtyCount + '</strong> ændringer venter</div>';
        html += '<button class="is-btn is-btn-secondary" data-is="prod-discard">Fortryd alle</button> ';
        html += '<button class="is-btn is-btn-success" data-is="prod-save">Gem i Grocy</button>';
        html += '</div>';
    }

    body.innerHTML = html;

    // Bind supplier filter change (not in delegation because it's a select without data-is on change)
    var supFilter = body.querySelector('[data-is="prod-filter-sup"]');
    if (supFilter) {
        supFilter.addEventListener('change', function() {
            _isProdFilter.supplier = this.value;
            _isProdFilterAndRender();
        });
    }
}

function _isProdFieldChange(el) {
    var pid = parseInt(el.dataset.pid);
    if (!_isProdDirty[pid]) _isProdDirty[pid] = {};

    if (el.dataset.is === 'prod-supplier') {
        _isProdDirty[pid].shopping_location_id = el.value ? parseInt(el.value) : null;
    } else if (el.dataset.is === 'prod-minstock') {
        _isProdDirty[pid].min_stock_amount = parseFloat(el.value) || 0;
    }

    // Update dirty count display
    var countEl = _isContainer.querySelector('.is-bulk-info strong');
    var bulkBar = _isContainer.querySelector('.is-bulk-bar');
    var dirtyCount = Object.keys(_isProdDirty).length;
    if (dirtyCount > 0 && !bulkBar) {
        _isRenderTab(1); // re-render to show bulk bar
    } else if (countEl) {
        countEl.textContent = dirtyCount;
    }
}

function _isProdFilterAndRender() {
    _isProducts = _isAllProducts.filter(function(p) {
        if (_isProdFilter.q && p.name.toLowerCase().indexOf(_isProdFilter.q) < 0) return false;
        if (_isProdFilter.supplier === 'none' && p.shopping_location_id) return false;
        if (_isProdFilter.supplier && _isProdFilter.supplier !== 'none' &&
            p.shopping_location_id != _isProdFilter.supplier) return false;
        return true;
    });
    _isRenderTab(1);
}

async function _isProdBulkSave() {
    var ids = Object.keys(_isProdDirty);
    if (!ids.length) return;

    var body = document.getElementById('isBody');
    var bar = body.querySelector('.is-bulk-bar');
    if (bar) {
        bar.innerHTML = '<div class="is-bulk-info">Gemmer 0/' + ids.length + '...</div>';
    }

    var done = 0;
    var errors = [];
    var CONCURRENT = 5;

    // Process in chunks of CONCURRENT
    for (var i = 0; i < ids.length; i += CONCURRENT) {
        var chunk = ids.slice(i, i + CONCURRENT);
        var promises = chunk.map(function(pid) {
            return putGrocyProduct(parseInt(pid), _isProdDirty[pid])
                .then(function() { done++; })
                .catch(function(err) { done++; errors.push(pid); });
        });
        await Promise.all(promises);
        if (bar) {
            bar.querySelector('.is-bulk-info').textContent = 'Gemmer ' + done + '/' + ids.length + '...';
        }
    }

    // Clear saved items
    ids.forEach(function(pid) {
        if (errors.indexOf(pid) < 0) {
            // Update local data
            var prod = _isAllProducts.find(function(p) { return p.id == pid; });
            if (prod && _isProdDirty[pid]) {
                if (_isProdDirty[pid].shopping_location_id !== undefined)
                    prod.shopping_location_id = _isProdDirty[pid].shopping_location_id;
                if (_isProdDirty[pid].min_stock_amount !== undefined)
                    prod.min_stock_amount = _isProdDirty[pid].min_stock_amount;
            }
            delete _isProdDirty[pid];
        }
    });

    if (errors.length) {
        _isToast(errors.length + ' fejlede — prøv igen', true);
    } else {
        _isToast('Gemt (' + done + ' produkter)');
    }
    _isRenderTab(1);
}

/* ══════════════════════════════════════════════════════════════
   TAB 3 — HØRKRAM
   ══════════════════════════════════════════════════════════════ */
function _isRenderHorkram(body) {
    var h = _isHokaHealth || {};
    var statusDot = h.hasSession ? 'ok' : 'err';
    var statusText = h.configured
        ? (h.hasSession ? 'Proxy OK · Logget ind' + (h.expiresIn ? ' · Session: ' + Math.round(h.expiresIn / 60) + ' min' : '') : 'Proxy OK · Ikke logget ind')
        : 'Proxy ikke konfigureret';

    // Count HK barcodes
    var hkBcCount = _isAllBarcodes.filter(function(bc) {
        return _isIsHkBarcode(bc);
    }).length;

    var html = '';
    // Status line
    html += '<div class="is-hk-status"><span class="is-hk-dot ' + statusDot + '"></span>' + statusText + '</div>';

    // Price bar
    html += '<div class="is-hk-pricebar">';
    html += '<span class="is-hk-pricebar-text"><strong>' + hkBcCount + '</strong> produkter med HK-barcodes</span>';
    html += '<button class="is-btn is-btn-primary" data-is="hk-batch-update" style="font-size:11px">↻ Opdater priser nu</button>';
    html += '</div>';

    // Sub-tabs
    html += '<div class="is-hk-tabs">';
    var hkTabLabels = ['Opslag', 'Favoritter', 'Ny kobling', 'Alle koblinger'];
    hkTabLabels.forEach(function(label, i) {
        var on = _isHkTab === i ? ' on' : '';
        var count = '';
        if (i === 2) count = ' <span class="is-hk-count">' + _isUnlinked.length + '</span>';
        if (i === 3) count = ' <span class="is-hk-count">' + _isAllBarcodes.length + '</span>';
        html += '<div class="is-hk-tab' + on + '" data-is="hk-tab" data-idx="' + i + '">' + label + count + '</div>';
    });
    html += '</div>';

    // Sub-tab body
    html += '<div id="isHkBody"></div>';

    body.innerHTML = html;
    _isRenderHkBody();
}

function _isRenderHkBody() {
    var el = document.getElementById('isHkBody');
    if (!el) return;

    // Update tab active state
    _isContainer.querySelectorAll('.is-hk-tab').forEach(function(t, i) {
        t.classList.toggle('on', i === _isHkTab);
    });

    if (_isHkTab === 0) _isRenderHkLookup(el);
    else if (_isHkTab === 1) _isRenderHkFavorites(el);
    else if (_isHkTab === 2) _isRenderHkUnlinked(el);
    else if (_isHkTab === 3) _isRenderHkAllLinks(el);
}

/* ── Hørkram: Opslag ───────────────────────────────────────── */
function _isRenderHkLookup(el) {
    el.innerHTML =
        '<div class="is-hk-lookup">' +
            '<div class="is-hk-search-row">' +
                '<input class="is-hk-inp" id="isHkQ" placeholder="Varenr. eller søg produktnavn...">' +
                '<button class="is-btn is-btn-primary" data-is="hk-search">Søg</button>' +
            '</div>' +
            '<div id="isHkResult"></div>' +
        '</div>';

    // Enter to search
    var inp = document.getElementById('isHkQ');
    if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') _isHkDoSearch(); });
}

async function _isHkDoSearch() {
    var q = (document.getElementById('isHkQ') || {}).value;
    if (!q || !q.trim()) return;
    q = q.trim();

    var resultEl = document.getElementById('isHkResult');
    if (!resultEl) return;
    resultEl.innerHTML = '<div class="is-loading">Søger...</div>';

    try {
        var isNumeric = /^\d{3,}$/.test(q);
        var product;

        if (isNumeric) {
            product = await fetchHokaProduct(q);
        } else {
            var searchResult = await fetchHokaSearch(q);
            var results = searchResult.results || searchResult || [];
            if (!results.length) {
                resultEl.innerHTML = '<div class="is-loading">Ingen resultater for "' + _isEsc(q) + '"</div>';
                return;
            }
            // Show first result as card, list rest
            product = results[0];
        }

        if (!product) {
            resultEl.innerHTML = '<div class="is-loading">Produkt ikke fundet</div>';
            return;
        }

        _isRenderHkProductCard(resultEl, product);
    } catch (err) {
        resultEl.innerHTML = '<div class="is-loading" style="color:#bc181b">Fejl: ' + _isEsc(err.message || '') + '</div>';
    }
}

function _isRenderHkProductCard(el, p) {
    var name = p.name || p.productName || '';
    var varenr = p.varenummer || p.productNumber || p.id || '';
    var brand = p.brand || p.producerName || '';
    var priceFmt = p.price != null ? p.price.toFixed(2) + ' kr' : '';
    var priceKg = p.pricePerKg != null ? p.pricePerKg.toFixed(2) + ' kr/kg' : '';
    var agreement = p.isAgreementItem ? '<span class="is-it-badge is-it-api" style="margin-left:4px">★ Aftale</span>' : '';

    el.innerHTML =
        '<div class="is-hk-result">' +
            '<div class="is-hkr-top">' +
                '<div class="is-hkr-img">📦</div>' +
                '<div class="is-hkr-info">' +
                    '<div class="is-hkr-name">' + _isEsc(name) + agreement + '</div>' +
                    '<div class="is-hkr-meta">Varenr. ' + _isEsc(varenr) + (brand ? ' · ' + _isEsc(brand) : '') + '</div>' +
                '</div>' +
                '<div class="is-hkr-price">' + priceFmt + (priceKg ? '<br><span style="font-size:11px;color:var(--color-text-dim)">' + priceKg + '</span>' : '') + '</div>' +
            '</div>' +
            '<div class="is-hkr-actions">' +
                '<button class="is-btn is-btn-primary" data-is="hk-link" data-id="' + _isEsc(varenr) + '" style="font-size:11px">Kobl til Grocy-produkt</button> ' +
                '<button class="is-btn is-btn-secondary" data-is="hk-update-price" data-id="' + _isEsc(varenr) + '" style="font-size:11px">Opdater pris</button>' +
            '</div>' +
            '<div id="isHkLinkPanel"></div>' +
        '</div>';

    // Store product data for linking
    el._isHkProduct = p;
}

async function _isHkLinkToGrocy(varenr) {
    var panel = document.getElementById('isHkLinkPanel');
    if (!panel) return;

    // Show Grocy product autocomplete
    panel.innerHTML =
        '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--color-border-light)">' +
            '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Vælg Grocy-produkt:</div>' +
            '<div style="position:relative">' +
                '<input class="is-hk-inp" id="isHkLinkQ" placeholder="Søg Grocy-produkt..." style="width:100%">' +
                '<div class="is-autocomplete" id="isHkLinkAC" style="display:none"></div>' +
            '</div>' +
        '</div>';

    var inp = document.getElementById('isHkLinkQ');
    var ac = document.getElementById('isHkLinkAC');
    var debounce = null;

    inp.addEventListener('input', function() {
        clearTimeout(debounce);
        debounce = setTimeout(async function() {
            var val = inp.value.trim();
            if (val.length < 2) { ac.style.display = 'none'; return; }

            // Filter local products
            var matches = _isAllProducts.filter(function(p) {
                return p.name.toLowerCase().indexOf(val.toLowerCase()) >= 0;
            }).slice(0, 15);

            if (!matches.length) { ac.style.display = 'none'; return; }

            ac.innerHTML = matches.map(function(p) {
                return '<div class="is-ac-item" data-pid="' + p.id + '">' +
                    '<div class="is-ac-name">' + _isEsc(p.name) + '</div>' +
                    '<div class="is-ac-meta">' + _isEsc(p.group || '') + '</div>' +
                '</div>';
            }).join('');
            ac.style.display = 'block';

            ac.querySelectorAll('.is-ac-item').forEach(function(item) {
                item.addEventListener('click', function() {
                    _isHkDoLink(varenr, parseInt(item.dataset.pid));
                    ac.style.display = 'none';
                });
            });
        }, 200);
    });

    inp.focus();
}

async function _isHkDoLink(varenr, grocyProductId) {
    var resultEl = document.getElementById('isHkResult');
    var product = resultEl && resultEl._isHkProduct;

    // Find shopping_location_id for Hørkram
    var hkLocs = _isGrocyLocs.filter(function(l) {
        return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name);
    });
    var shopLocId = hkLocs.length ? hkLocs[0].grocy_location_id : null;

    try {
        var bcData = {
            product_id: grocyProductId,
            barcode: String(varenr),
        };
        if (shopLocId) bcData.shopping_location_id = shopLocId;

        var bc = await createProductBarcode(bcData);

        // Set userfields if we have product data
        var packSizeWarning = null;
        if (bc && bc.id && product) {
            var uf = {};
            if (product.isAgreementItem) uf.is_agreement_item = '1';
            if (product.salesUnits && product.salesUnits.length) {
                var su = product.salesUnits[0];
                if (su.code) uf.supplier_unit_code = su.code;
                if (su.quantity) uf.supplier_unit_qty = String(su.quantity);
            }
            if (product.packSize) uf.pack_size_stock_unit = String(product.packSize);
            if (Object.keys(uf).length) {
                var ufRes = await updateProductBarcodeUserfields(bc.id, uf);
                if (ufRes && ufRes.pack_size_warning) packSizeWarning = ufRes.pack_size_warning;
            }
        }

        // Refresh barcodes
        _isAllBarcodes = await fetchProductBarcodes();

        // F13-guard: advar hvis pakkestørrelsen divergerer fra Grocy's
        // enhedskonvertering — ellers bekræft koblingen som normalt.
        if (packSizeWarning) {
            _isToast('⚠ ' + packSizeWarning.message, true, 12000);
        } else {
            _isToast('Barcode koblet!');
        }
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

async function _isHkUpdatePrice(varenr) {
    try {
        var snap = await fetchHokaSnapshots([varenr]);
        var items = snap.products || snap.items || snap || [];
        if (!items.length) { _isToast('Ingen snapshot data', true); return; }

        var item = items[0];
        var priceKg = item.pricePerKg || item.price_per_kg;
        if (!priceKg) { _isToast('Ingen pris/kg i snapshot', true); return; }

        // Find Grocy product via barcode
        var bc = _isAllBarcodes.find(function(b) { return b.barcode === String(varenr); });
        if (!bc) { _isToast('Barcode ikke fundet i Grocy', true); return; }

        await putGrocyProductUserfields(bc.product_id, {
            supplier_price_per_kg: String(priceKg),
            price_updated_at: new Date().toISOString(),
        });

        _isToast('Pris opdateret: ' + priceKg.toFixed(2) + ' kr/kg');
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

/* ── Hørkram: Favoritter ───────────────────────────────────── */
function _isRenderHkFavorites(el) {
    if (!_isHkFavs || !_isHkFavs.length) {
        el.innerHTML = '<div class="is-loading">Ingen favoritter fundet</div>';
        return;
    }

    var html = '';
    _isHkFavs.forEach(function(fav) {
        var type = fav.type === 'custom' ? '⭐' : '📋';
        var favId = fav.id || '';
        html += '<div class="is-hk-favrow">';
        html += '<span style="font-size:16px;flex-shrink:0">' + type + '</span>';
        html += '<span class="is-hk-favname">' + _isEsc(fav.name || fav.listName || '') + '</span>';
        html += '<span class="is-hk-favmeta" id="isHkFavCount_' + _isEsc(favId) + '"></span>';
        html += '<button class="is-btn is-btn-secondary" data-is="hk-fav-import" data-id="' + _isEsc(favId) + '" style="font-size:11px">Importer priser</button> ';
        html += '<button class="is-btn is-btn-secondary" data-is="hk-fav-link" data-id="' + _isEsc(favId) + '" style="font-size:11px">Kobl ukoblede</button>';
        html += '</div>';
    });

    el.innerHTML = html || '<div class="is-loading">Ingen favoritter</div>';
}

async function _isHkFavImport(listId) {
    _isToast('Henter favoritter...');
    try {
        var products = await fetchHokaFavoritesAll(listId);
        var items = products.products || products || [];
        if (!items.length) { _isToast('Ingen produkter i listen', true); return; }

        // Get varenumre
        var varenumre = items.map(function(p) { return p.varenummer || p.productNumber || ''; }).filter(Boolean);
        if (!varenumre.length) { _isToast('Ingen varenumre fundet', true); return; }

        // Batch snapshots in chunks of 20
        var updated = 0;
        var errors = 0;
        for (var i = 0; i < varenumre.length; i += 20) {
            var chunk = varenumre.slice(i, i + 20);
            try {
                var snaps = await fetchHokaSnapshots(chunk);
                var snapItems = snaps.products || snaps.items || snaps || [];

                for (var j = 0; j < snapItems.length; j++) {
                    var snap = snapItems[j];
                    var vn = snap.varenummer || snap.productNumber || '';
                    var priceKg = snap.pricePerKg || snap.price_per_kg;
                    if (!priceKg || !vn) continue;

                    var bc = _isAllBarcodes.find(function(b) { return b.barcode === String(vn); });
                    if (!bc) continue;

                    try {
                        await putGrocyProductUserfields(bc.product_id, {
                            supplier_price_per_kg: String(priceKg),
                            price_updated_at: new Date().toISOString(),
                        });
                        updated++;
                    } catch (e) { errors++; }
                }
            } catch (e) { errors += chunk.length; }

            _isToast('Opdaterer... ' + Math.min(i + 20, varenumre.length) + '/' + varenumre.length);
        }

        _isToast('Færdig: ' + updated + ' opdateret' + (errors ? ', ' + errors + ' fejl' : ''));
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

async function _isHkFavLinkUnlinked(listId) {
    // Switch to "Ny kobling" tab with this list pre-selected
    _isHkTab = 2;
    _isRenderHkBody();
    _isToast('Vis ukoblede produkter — brug "Søg og kobl" per vare');
}

/* ── Hørkram: Ny kobling ───────────────────────────────────── */
function _isRenderHkUnlinked(el) {
    var prods = _isUnlinked.slice(0, 50); // cap at 50

    var html = '<div class="is-section">';
    html += '<div style="font-size:12px;color:var(--color-text-dim);margin-bottom:12px">' +
        _isUnlinked.length + ' produkter uden Hørkram-barcode</div>';

    if (!prods.length) {
        html += '<div class="is-loading">Alle produkter har Hørkram-barcode!</div>';
    } else {
        prods.forEach(function(p) {
            html += '<div class="is-hk-row" id="isUl' + p.id + '">';
            html += '<span class="is-hk-row-name">' + _isEsc(p.name) + '</span>';
            html += '<span class="is-hk-row-meta">' + _isEsc(p.group || '') + '</span>';
            html += '<button class="is-btn is-btn-secondary" data-is="hk-unlinked-search" data-id="' + p.id + '" style="font-size:11px">Søg og kobl →</button>';
            html += '</div>';
        });
    }
    html += '</div>';
    el.innerHTML = html;
}

async function _isHkUnlinkedSearch(grocyProductId) {
    var rowEl = document.getElementById('isUl' + grocyProductId);
    if (!rowEl) return;

    var prod = _isAllProducts.find(function(p) { return p.id === grocyProductId; });
    if (!prod) return;

    // Check if already expanded
    var existingPanel = rowEl.querySelector('.is-hk-link-results');
    if (existingPanel) { existingPanel.remove(); return; }

    var panel = document.createElement('div');
    panel.className = 'is-hk-link-results';
    panel.style.cssText = 'padding:8px 0;border-top:1px solid var(--color-border-light);margin-top:6px';
    panel.innerHTML = '<div class="is-loading" style="padding:6px 0">Søger i Hørkram...</div>';
    rowEl.appendChild(panel);

    try {
        var searchResult = await fetchHokaSearch(prod.name);
        var results = searchResult.results || searchResult || [];

        if (!results.length) {
            panel.innerHTML = '<div style="font-size:12px;color:var(--color-text-dim);padding:6px 0">Ingen match fundet</div>';
            return;
        }

        // Score results
        var scored = results.slice(0, 5).map(function(r) {
            var rName = (r.name || r.productName || '').toLowerCase();
            var pName = prod.name.toLowerCase();
            var sim = _isStringSimilarity(pName, rName);
            var conf = sim > 0.85 ? 'høj' : (sim > 0.6 ? 'medium' : 'lav');
            var confColor = sim > 0.85 ? '#6a8f3a' : (sim > 0.6 ? '#e8a832' : '#bc181b');
            return { product: r, similarity: sim, conf: conf, confColor: confColor };
        });

        panel.innerHTML = scored.map(function(s) {
            var p = s.product;
            var vn = p.varenummer || p.productNumber || '';
            var name = p.name || p.productName || '';
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">' +
                '<span style="color:' + s.confColor + ';font-weight:700;font-size:10px;width:50px">' + s.conf + '</span>' +
                '<span style="flex:1">' + _isEsc(name) + ' <span style="color:var(--color-text-dim)">(' + _isEsc(vn) + ')</span></span>' +
                '<button class="is-btn is-btn-primary" data-is="hk-unlinked-pick" data-varenr="' + _isEsc(vn) + '" data-gpid="' + grocyProductId + '" style="font-size:10px;padding:3px 8px">Kobl</button>' +
            '</div>';
        }).join('');
    } catch (err) {
        panel.innerHTML = '<div style="font-size:12px;color:#bc181b;padding:6px 0">Fejl: ' + _isEsc(err.message || '') + '</div>';
    }
}

async function _isHkUnlinkedPick(btnEl) {
    var varenr = btnEl.dataset.varenr;
    var gpid = parseInt(btnEl.dataset.gpid);

    var hkLocs = _isGrocyLocs.filter(function(l) {
        return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name);
    });
    var shopLocId = hkLocs.length ? hkLocs[0].grocy_location_id : null;

    try {
        var bcData = { product_id: gpid, barcode: varenr };
        if (shopLocId) bcData.shopping_location_id = shopLocId;
        await createProductBarcode(bcData);

        _isToast('Koblet!');
        _isAllBarcodes = await fetchProductBarcodes();

        // Remove from unlinked list
        _isUnlinked = _isUnlinked.filter(function(p) { return p.id !== gpid; });
        _isRenderHkUnlinked(document.getElementById('isHkBody'));
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

/* ── Hørkram: Alle koblinger (grupperet per produkt) ──────── */
var _isHkAllFilter = '';

function _isRenderHkAllLinks(el) {
    var bcs = _isAllBarcodes.filter(_isIsHkBarcode);
    var deadCount = 0;
    bcs.forEach(function(bc) { if (_isDeadBarcodes[bc.barcode]) deadCount++; });

    // Build product groups
    var groups = {};
    bcs.forEach(function(bc) {
        if (!groups[bc.product_id]) {
            var prod = _isAllProducts.find(function(p) { return p.id === bc.product_id; });
            groups[bc.product_id] = { product: prod, barcodes: [] };
        }
        groups[bc.product_id].barcodes.push(bc);
    });

    var html = '<div class="is-section">';

    // Search bar + Tjek udgåede
    html += '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">';
    html += '<input class="is-hk-inp" id="isHkAllQ" placeholder="Søg produkt eller varenr..." value="' + _isEsc(_isHkAllFilter) + '" style="flex:1">';
    if (!_isDeadChecked && bcs.length > 0) {
        html += '<button class="is-btn is-btn-secondary" data-is="hk-check-dead" style="font-size:11px;padding:4px 10px">Tjek udgåede</button>';
    }
    html += '</div>';

    // Summary line
    html += '<div style="font-size:11px;color:var(--color-text-dim,#999);margin-bottom:10px">';
    html += bcs.length + ' koblinger på ' + Object.keys(groups).length + ' produkter';
    if (deadCount > 0) {
        html += ' · <span style="color:#bc181b;font-weight:700">' + deadCount + ' udgåede</span>';
    }
    html += ' · Alle priser ekskl. moms';
    html += '</div>';

    // Warning banner for dead products
    if (deadCount > 0) {
        html += '<div style="background:#fde8e8;border:1px solid #f5c6c6;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px">';
        html += '<strong style="color:#bc181b">⚠ ' + deadCount + ' varenumre findes ikke længere hos Hørkram</strong>';
        html += '<div style="color:#666;margin-top:4px">Disse produkter bør kobles til nye varenumre eller fjernes.</div>';
        html += '</div>';
    }

    if (!bcs.length) {
        html += '<div class="is-loading">Ingen Hørkram-barcodes fundet</div>';
    } else {
        // Sort groups: dead first, then alphabetically
        var sortedPids = Object.keys(groups).sort(function(a, b) {
            var ga = groups[a], gb = groups[b];
            var aDead = ga.barcodes.some(function(bc) { return _isDeadBarcodes[bc.barcode]; }) ? 0 : 1;
            var bDead = gb.barcodes.some(function(bc) { return _isDeadBarcodes[bc.barcode]; }) ? 0 : 1;
            if (aDead !== bDead) return aDead - bDead;
            var aName = ga.product ? ga.product.name : '';
            var bName = gb.product ? gb.product.name : '';
            return aName.localeCompare(bName, 'da');
        });

        // Filter by search
        var filterLc = _isHkAllFilter.toLowerCase();

        sortedPids.forEach(function(pid) {
            var g = groups[pid];
            var prodName = g.product ? g.product.name : 'Produkt #' + pid;

            // Filter: match product name or any barcode number
            if (filterLc) {
                var nameMatch = prodName.toLowerCase().indexOf(filterLc) >= 0;
                var bcMatch = g.barcodes.some(function(bc) { return (bc.barcode || '').indexOf(filterLc) >= 0; });
                if (!nameMatch && !bcMatch) return;
            }

            // Count dead barcodes in this group
            var groupDeadCount = 0;
            g.barcodes.forEach(function(bc) { if (_isDeadBarcodes[bc.barcode]) groupDeadCount++; });

            var groupBorderStyle = groupDeadCount > 0 ? ' style="border-color:#f5c6c6"' : '';
            html += '<div class="is-hk-group"' + groupBorderStyle + '>';

            // Group header
            var hdrBg = groupDeadCount > 0 ? ' style="background:#fef5f5"' : '';
            html += '<div class="is-hk-group-header"' + hdrBg + '>';
            html += '<span class="is-hk-group-name">' + _isEsc(prodName);
            if (groupDeadCount > 0) {
                html += ' <span class="is-hk-dead-badge">' + groupDeadCount + ' udgået</span>';
            }
            html += '</span>';
            html += '<button class="is-btn is-btn-secondary" data-is="hk-add-pack" data-id="' + pid + '" style="font-size:10px;padding:2px 10px">+ Vare variant</button>';
            html += '</div>';

            html += '<table class="is-prod-tbl" style="margin-bottom:0"><thead><tr>' +
                '<th>Varenr.</th><th>Beskrivelse</th><th>Enhed</th><th>Kr/kg ekskl. moms</th><th>Opdateret</th><th>Foretr.</th><th style="width:30px"></th>' +
                '</tr></thead><tbody>';

            g.barcodes.forEach(function(bc) {
                var bcUf = bc.userfields || {};
                var pref = bcUf.is_preferred === '1';
                var isDead = _isDeadBarcodes[bc.barcode];
                var packNote = bc.note || '';
                var unitCode = bcUf.supplier_unit_code || '';
                var priceKg = (g.product && g.product.userfields && g.product.userfields.supplier_price_per_kg) || '';
                var scrapedAt = bcUf.hk_scraped_at || '';

                var rowStyle = isDead ? ' style="background:#fef0f0"' : '';
                html += '<tr' + rowStyle + '>';

                // Varenr + dead badge
                html += '<td style="font-size:12px;font-family:monospace">';
                if (isDead) {
                    html += '<span style="color:#bc181b">' + _isEsc(bc.barcode || '') + '</span> <span class="is-hk-dead-badge">Udgået</span>';
                } else {
                    html += _isEsc(bc.barcode || '');
                }
                html += '</td>';

                // Beskrivelse (pakkeform)
                html += '<td style="font-size:12px;' + (isDead ? 'color:var(--color-text-dim)' : '') + '">' + _isEsc(packNote) + '</td>';

                // Enhed
                html += '<td style="font-size:12px;color:var(--color-text-dim)">' + _isEsc(unitCode || '—') + '</td>';

                // Pris/kg
                html += '<td style="font-size:12px;text-align:right">' + (priceKg ? priceKg + ' kr' : '—') + '</td>';

                // Opdateret (relative dato)
                html += '<td>' + _isHkFmtAge(scrapedAt) + '</td>';

                // Foretrukket
                html += '<td><button class="is-btn' + (pref ? ' is-btn-success' : ' is-btn-secondary') + '" data-is="hk-bc-pref" data-id="' + bc.id + '" style="font-size:10px;padding:2px 6px">' + (pref ? '★' : '☆') + '</button></td>';

                // Slet
                html += '<td><button class="is-icon-btn del" data-is="hk-bc-delete" data-id="' + bc.id + '" title="Fjern kobling" style="font-size:11px">✕</button></td>';
                html += '</tr>';
            });
            html += '</tbody></table>';

            // Inline pack-size search panel
            if (_isAddPackProductId === parseInt(pid)) {
                html += '<div class="is-hk-pack-panel">' +
                    '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Søg i Hørkram-katalog:</div>' +
                    '<div style="display:flex;gap:6px">' +
                        '<input class="is-hk-inp" id="isPackQ" data-pid="' + pid + '" placeholder="Varenr. eller produktnavn..." style="flex:1">' +
                        '<button class="is-btn is-btn-primary" data-is="hk-pack-search" data-id="' + pid + '" style="font-size:11px">Søg</button>' +
                    '</div>' +
                    '<div id="isPackResults"></div>' +
                '</div>';
            }

            html += '</div>';
        });
    }
    html += '</div>';
    el.innerHTML = html;

    // Bind search filter
    var filterInp = el.querySelector('#isHkAllQ');
    if (filterInp) {
        var debounce = null;
        filterInp.addEventListener('input', function() {
            clearTimeout(debounce);
            debounce = setTimeout(function() {
                _isHkAllFilter = filterInp.value.trim();
                _isRenderHkAllLinks(el);
                // Restore focus + cursor
                var inp2 = el.querySelector('#isHkAllQ');
                if (inp2) { inp2.focus(); inp2.setSelectionRange(inp2.value.length, inp2.value.length); }
            }, 200);
        });
    }

    // Bind Enter key on pack search input
    var packInp = el.querySelector('#isPackQ');
    if (packInp) packInp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') _isHkPackSearch(parseInt(packInp.dataset.pid));
    });
}

/** Format scraped-at dato som relativ aldring med farve */
function _isHkFmtAge(iso) {
    if (!iso) return '<span style="font-size:11px;color:var(--color-text-dim)">—</span>';
    try {
        var d = new Date(iso);
        var now = new Date();
        var diffMs = now - d;
        var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return '<span style="font-size:11px;color:var(--color-text-dim)">i dag</span>';
        if (diffDays === 1) return '<span style="font-size:11px;color:var(--color-text-dim)">i går</span>';
        if (diffDays < 7) return '<span style="font-size:11px;color:var(--color-text-dim)">' + diffDays + ' dage siden</span>';
        if (diffDays < 30) return '<span style="font-size:11px;color:#ba7517;font-weight:600">' + diffDays + ' dage siden</span>';
        var months = Math.floor(diffDays / 30);
        return '<span style="font-size:11px;color:#bc181b;font-weight:600">' + months + ' mdr. siden</span>';
    } catch (e) {
        return '<span style="font-size:11px;color:var(--color-text-dim)">—</span>';
    }
}

function _isHkAddPackToggle(productId) {
    _isAddPackProductId = (_isAddPackProductId === productId) ? null : productId;
    _isRenderHkAllLinks(document.getElementById('isHkBody'));
    if (_isAddPackProductId) {
        var inp = document.getElementById('isPackQ');
        if (inp) inp.focus();
    }
}

async function _isHkPackSearch(productId) {
    var inp = document.getElementById('isPackQ');
    var resultsEl = document.getElementById('isPackResults');
    if (!inp || !resultsEl) return;
    var q = inp.value.trim();
    if (!q) return;

    resultsEl.innerHTML = '<div class="is-loading">Søger i Hørkram...</div>';

    try {
        var isNumeric = /^\d{3,}$/.test(q);
        var results = [];
        if (isNumeric) {
            var prod = await fetchHokaProduct(q);
            if (prod) results = [prod];
        } else {
            var data = await fetchHokaSearch(q);
            results = (data.results || data || []).slice(0, 8);
        }

        if (!results.length) {
            resultsEl.innerHTML = '<div class="is-loading">Ingen resultater for "' + _isEsc(q) + '"</div>';
            return;
        }

        var html = '';
        results.forEach(function(p) {
            var varenr = p.varenummer || p.productNumber || p.id || '';
            var name = p.name || p.productName || '';
            var pack = p.packSize ? p.packSize + ' ' + (p.packUnit || '') : '';
            var price = p.pricePerKg ? p.pricePerKg.toFixed(2) + ' kr/kg' : '';
            html += '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--color-border-light,#eee)">';
            html += '<div style="flex:1"><div style="font-size:12px;font-weight:600">' + _isEsc(name) + '</div>';
            html += '<div style="font-size:11px;color:var(--color-text-dim)">Nr. ' + _isEsc(String(varenr)) + (pack ? ' · ' + pack : '') + (price ? ' · ' + price : '') + '</div></div>';
            html += '<button class="is-btn is-btn-primary" data-is="hk-pack-link" data-varenr="' + _isEsc(String(varenr)) + '" data-name="' + _isEsc(name) + '" data-pid="' + productId + '" style="font-size:10px;padding:3px 10px">+ Kobl</button>';
            html += '</div>';
        });
        resultsEl.innerHTML = html;
    } catch (err) {
        resultsEl.innerHTML = '<div class="is-loading" style="color:#bc181b">Fejl: ' + _isEsc(err.message || '') + '</div>';
    }
}

async function _isHkPackLink(btn) {
    var varenr = btn.dataset.varenr;
    var name = btn.dataset.name;
    var productId = parseInt(btn.dataset.pid);
    if (!varenr || !productId) return;

    // Find Hørkram shopping_location_id
    var hkLocs = _isGrocyLocs.filter(function(l) {
        return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name);
    });
    var shopLocId = hkLocs.length ? hkLocs[0].grocy_location_id : null;

    try {
        var bcData = { product_id: productId, barcode: String(varenr), note: name };
        if (shopLocId) bcData.shopping_location_id = shopLocId;
        var bc = await createProductBarcode(bcData);

        // Set userfields from snapshot
        if (bc && bc.id) {
            try {
                var snap = await fetchHokaSnapshots([varenr]);
                var items = snap.products || snap.items || [];
                if (items.length && items[0].salesUnits && items[0].salesUnits.length) {
                    var su = items[0].salesUnits[0];
                    var uf = {};
                    if (su.code) uf.supplier_unit_code = su.code;
                    if (su.quantity) uf.supplier_unit_qty = String(su.quantity);
                    if (items[0].isAgreementItem) uf.is_agreement_item = '1';
                    if (Object.keys(uf).length) await updateProductBarcodeUserfields(bc.id, uf);
                }
            } catch (e) { console.warn('[settings] Userfield-sæt fejl:', e.message); }
        }

        _isToast('Pakstørrelse koblet: ' + name);
        _isAddPackProductId = null;
        _isAllBarcodes = await fetchProductBarcodes();
        _isRenderHkAllLinks(document.getElementById('isHkBody'));
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

async function _isHkBcDelete(bcId) {
    var bc = _isAllBarcodes.find(function(b) { return b.id === bcId; });
    var label = bc ? 'varenr. ' + bc.barcode : 'barcode #' + bcId;
    if (!confirm('Fjern koblingen til ' + label + '?')) return;

    try {
        await deleteProductBarcode(bcId);
        _isToast('Kobling fjernet');
        _isAllBarcodes = await fetchProductBarcodes();
        _isRenderHkAllLinks(document.getElementById('isHkBody'));
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

async function _isHkBcTogglePref(bcId) {
    var bc = _isAllBarcodes.find(function(b) { return b.id === bcId; });
    if (!bc) return;

    var uf = bc.userfields || {};
    var newPref = uf.is_preferred === '1' ? '' : '1';

    try {
        await updateProductBarcodeUserfields(bcId, { is_preferred: newPref });
        // Update local
        if (!bc.userfields) bc.userfields = {};
        bc.userfields.is_preferred = newPref;
        _isToast(newPref ? 'Sat som foretrukket' : 'Foretrukket fjernet');
        _isRenderHkAllLinks(document.getElementById('isHkBody'));
    } catch (err) {
        _isToast('Fejl: ' + (err.message || ''), true);
    }
}

/* ── Hørkram: Tjek udgåede varenumre ───────────────────────── */
async function _isHkCheckDead() {
    var hkBcs = _isAllBarcodes.filter(_isIsHkBarcode);
    if (!hkBcs.length) return;

    var varenumre = hkBcs.map(function(bc) { return bc.barcode; }).filter(Boolean);
    var total = varenumre.length;
    var foundSet = {};

    _isToast('Tjekker ' + total + ' varenumre...');

    // Batch snapshots — found products appear in results, missing ones don't
    for (var i = 0; i < varenumre.length; i += 20) {
        var chunk = varenumre.slice(i, i + 20);
        try {
            var snaps = await fetchHokaSnapshots(chunk);
            var items = snaps.products || snaps.items || snaps || [];
            items.forEach(function(s) {
                var vn = s.varenummer || s.productNumber || '';
                if (vn) foundSet[vn] = true;
            });
        } catch (e) {
            // On error, don't mark as dead — we don't know
            chunk.forEach(function(vn) { foundSet[vn] = true; });
        }
    }

    // Mark missing
    _isDeadBarcodes = {};
    varenumre.forEach(function(vn) {
        if (!foundSet[vn]) _isDeadBarcodes[vn] = true;
    });
    _isDeadChecked = true;

    var deadCount = Object.keys(_isDeadBarcodes).length;
    if (deadCount > 0) {
        _isToast('⚠ ' + deadCount + ' udgåede varenumre fundet', true);
    } else {
        _isToast('Alle ' + total + ' varenumre aktive ✓');
    }

    // Re-render
    var hkBody = document.getElementById('isHkBody');
    if (hkBody && _isHkTab === 3) _isRenderHkAllLinks(hkBody);
}

/* ── Hørkram: Batch price update ───────────────────────────── */
async function _isHkBatchPriceUpdate() {
    var hkBcs = _isAllBarcodes.filter(_isIsHkBarcode);
    if (!hkBcs.length) { _isToast('Ingen HK-barcodes', true); return; }

    var varenumre = hkBcs.map(function(bc) { return bc.barcode; }).filter(Boolean);
    var total = varenumre.length;
    var updated = 0;
    var errors = 0;
    var foundSet = {};

    // Show progress
    var body = document.getElementById('isBody');
    var pricebar = body.querySelector('.is-hk-pricebar');
    if (pricebar) {
        pricebar.innerHTML = '<div class="is-progress"><div class="is-progress-bar"><div class="is-progress-fill" id="isHkProg" style="width:0%"></div></div>' +
            '<div class="is-progress-text" id="isHkProgText">Opdaterer 0/' + total + '...</div></div>';
    }

    for (var i = 0; i < varenumre.length; i += 20) {
        var chunk = varenumre.slice(i, i + 20);
        try {
            var snaps = await fetchHokaSnapshots(chunk);
            var snapItems = snaps.products || snaps.items || snaps || [];

            // Track which varenumre were found
            snapItems.forEach(function(s) {
                var vn = s.varenummer || s.productNumber || '';
                if (vn) foundSet[vn] = true;
            });

            for (var j = 0; j < snapItems.length; j++) {
                var snap = snapItems[j];
                var vn = snap.varenummer || snap.productNumber || '';
                var priceKg = snap.pricePerKg || snap.price_per_kg;
                if (!priceKg || !vn) continue;

                var bc = hkBcs.find(function(b) { return b.barcode === String(vn); });
                if (!bc) continue;

                try {
                    var now = new Date().toISOString();
                    await putGrocyProductUserfields(bc.product_id, {
                        supplier_price_per_kg: String(priceKg),
                        price_updated_at: now,
                    });
                    // Update local cache
                    var localProd = _isAllProducts.find(function(p) { return p.id === bc.product_id; });
                    if (localProd) {
                        if (!localProd.userfields) localProd.userfields = {};
                        localProd.userfields.supplier_price_per_kg = String(priceKg);
                        localProd.userfields.price_updated_at = now;
                    }
                    updated++;
                } catch (e) { errors++; }
            }
        } catch (e) {
            errors += chunk.length;
            // On error, don't mark as dead
            chunk.forEach(function(vn) { foundSet[vn] = true; });
        }

        var pct = Math.round((i + chunk.length) / total * 100);
        var progFill = document.getElementById('isHkProg');
        var progText = document.getElementById('isHkProgText');
        if (progFill) progFill.style.width = pct + '%';
        if (progText) progText.textContent = 'Opdaterer ' + Math.min(i + 20, total) + '/' + total + '...';
    }

    // Side-effect: detect dead barcodes
    _isDeadBarcodes = {};
    varenumre.forEach(function(vn) {
        if (!foundSet[vn]) _isDeadBarcodes[vn] = true;
    });
    _isDeadChecked = true;
    var deadCount = Object.keys(_isDeadBarcodes).length;

    var msg = 'Færdig: ' + updated + ' opdateret';
    if (errors) msg += ', ' + errors + ' fejl';
    if (deadCount) msg += ', ' + deadCount + ' udgåede';
    _isToast(msg, errors > 0 || deadCount > 0);

    // Re-render
    setTimeout(function() {
        _isRenderTab(2);
    }, 1500);
}

/* ══════════════════════════════════════════════════════════════
   TAB 4 — DUPLIKATER (produkt-duplikat-kandidater)
   Flyttet fra settings/index.html (CLAUDE_SETTINGS_REORG.md DEL 3).
   API uændret: /settings/duplicates* (routes/settings.js).
   ══════════════════════════════════════════════════════════════ */
async function _isFetchDuplicates(filter) {
    var f = filter || 'pending';
    var url = f === 'all' ? '/settings/duplicates/all' : '/settings/duplicates?status=' + f;
    try {
        return await apiFetch(url) || [];
    } catch (err) {
        console.warn('[is] Duplikater fejl:', err.message);
        return [];
    }
}

async function _isLoadDuplicates() {
    _isDupRows = await _isFetchDuplicates(_isDupFilter);
    var body = document.getElementById('isBody');
    if (body) _isRenderDuplicates(body);
}

function _isRenderDuplicates(body) {
    var rows = _isDupRows || [];
    var filterOpts = [
        ['pending', 'Afventer (ubehandlet)'],
        ['all', 'Alle'],
        ['merged', 'Merget'],
        ['not_duplicate', 'Ikke duplikat'],
        ['ignored', 'Ignoreret'],
    ];
    var optsHtml = filterOpts.map(function(o) {
        return '<option value="' + o[0] + '"' + (o[0] === _isDupFilter ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');

    var html = '<div class="is-section">' +
        '<h3 style="margin:0 0 6px">Duplikat-kandidater</h3>' +
        '<p style="font-size:13px;color:var(--color-text-dim,#777);margin-bottom:12px">Produkter der sandsynligvis er duplikater i Grocy — opdaget automatisk ved bestilling når samme Hørkram-varenr. bruges af flere produkter.</p>' +
        '<div style="margin-bottom:12px"><select data-is="dup-filter" style="padding:6px 10px;border:1px solid var(--color-border);border-radius:4px;font-size:13px">' + optsHtml + '</select></div>';

    if (!rows.length) {
        html += '<div style="text-align:center;padding:24px;color:var(--color-text-dim,#777);font-size:14px">Ingen duplikat-kandidater fundet.</div>';
    } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
            '<thead><tr style="text-align:left;border-bottom:2px solid var(--color-border)">' +
            '<th style="padding:6px 8px">Produkt A</th><th style="padding:6px 8px">Produkt B</th>' +
            '<th style="padding:6px 8px">Varenr.</th><th style="padding:6px 8px">Fundet</th>' +
            '<th style="padding:6px 8px">Status</th><th></th></tr></thead><tbody>';
        rows.forEach(function(r) {
            var statusBadge = r.status === 'pending' ? '<span style="color:#e65100;font-weight:700">⏳ Afventer</span>'
                : r.status === 'merged' ? '<span style="color:#2e7d32">✓ Merget</span>'
                : r.status === 'not_duplicate' ? '<span style="color:#1565c0">↗ Ikke duplikat</span>'
                : '<span style="color:#777">— Ignoreret</span>';
            var date = r.created_at
                ? (typeof parseServerDate === 'function' ? parseServerDate(r.created_at) : new Date(r.created_at)).toLocaleDateString('da-DK')
                : '';
            var actions = '';
            if (r.status === 'pending') {
                actions =
                    '<button class="is-add-btn" data-is="dup-act" data-id="' + r.id + '" data-status="merged" style="font-size:11px;padding:3px 8px;margin-right:4px">✓ Merget</button>' +
                    '<button class="is-add-btn" data-is="dup-act" data-id="' + r.id + '" data-status="not_duplicate" style="font-size:11px;padding:3px 8px;margin-right:4px">↗ Ikke dup.</button>' +
                    '<button class="is-add-btn" data-is="dup-act" data-id="' + r.id + '" data-status="ignored" style="font-size:11px;padding:3px 8px">— Ignorer</button>';
            }
            html += '<tr style="border-bottom:1px solid var(--color-border)">' +
                '<td style="padding:6px 8px"><strong>' + _isEsc(r.product_name_a || ('#' + r.product_id_a)) + '</strong><br><span style="font-size:11px;color:#777">ID: ' + r.product_id_a + '</span></td>' +
                '<td style="padding:6px 8px"><strong>' + _isEsc(r.product_name_b || ('#' + r.product_id_b)) + '</strong><br><span style="font-size:11px;color:#777">ID: ' + r.product_id_b + '</span></td>' +
                '<td style="padding:6px 8px"><code>' + _isEsc(r.barcode || '') + '</code><br><span style="font-size:11px;color:#777">' + _isEsc(r.barcode_name || '') + '</span></td>' +
                '<td style="padding:6px 8px;font-size:12px">' + date + '</td>' +
                '<td style="padding:6px 8px">' + statusBadge + '</td>' +
                '<td style="padding:6px 8px;white-space:nowrap">' + actions + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
    }
    html += '</div>';
    body.innerHTML = html;
}

async function _isUpdateDuplicate(id, status) {
    try {
        await apiFetch('/settings/duplicates/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ status: status }),
        });
        _isToast('Duplikat opdateret');
        _isLoadDuplicates();
    } catch (err) {
        _isToast('Fejl: ' + err.message, true);
    }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */
function _isIsHkBarcode(bc) {
    // HK barcodes are linked to Hørkram shopping locations
    var hkLocs = _isGrocyLocs.filter(function(l) {
        return l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name);
    }).map(function(l) { return l.grocy_location_id; });
    return bc.shopping_location_id && hkLocs.indexOf(bc.shopping_location_id) >= 0;
}

function _isToast(msg, isError, durationMs) {
    // Remove existing
    var existing = document.querySelector('.is-toast');
    if (existing) existing.remove();
    clearTimeout(_isToastTimer);

    var el = document.createElement('div');
    el.className = 'is-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    _isToastTimer = setTimeout(function() { el.remove(); }, durationMs || 3000);
}

function _isEsc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function _isStringSimilarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return 1;

    // Simple Dice coefficient on bigrams
    var bigramsA = [];
    var bigramsB = [];
    for (var i = 0; i < a.length - 1; i++) bigramsA.push(a.substring(i, i + 2));
    for (var j = 0; j < b.length - 1; j++) bigramsB.push(b.substring(j, j + 2));

    if (!bigramsA.length || !bigramsB.length) return 0;

    var intersection = 0;
    var used = {};
    bigramsA.forEach(function(bg) {
        for (var k = 0; k < bigramsB.length; k++) {
            if (!used[k] && bigramsB[k] === bg) {
                intersection++;
                used[k] = true;
                break;
            }
        }
    });

    return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

// CommonJS export-guard — eksponerer _isStringSimilarity for test-runnere
// (T_INDKOB_ADMIN). Wrappet i typeof-check så browser-loading ikke fejler.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _isStringSimilarity: _isStringSimilarity };
}
