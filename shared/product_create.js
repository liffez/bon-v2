/**
 * shared/product_create.js
 * ════════════════════════════════════════════════════════════
 * Opret produkt — komponent til kitchen/stock.html (tab 3).
 *
 * Tre sektioner: Grunddata, Workflow, Stregkode/varenummer.
 * Submit-flow: produkt → QU-konvertering → userfields →
 * barcode → barcode-userfields → initial lager.
 * Partial-success: warnings i resultatkort, ingen rollback.
 *
 * Pre-fill via options.barcode (fra ?tab=create&barcode=...) →
 * Hørkram-lookup udfylder navn/pris/salgsenhed hvis muligt.
 *
 * Export: initProductCreate(containerEl, options)
 * ════════════════════════════════════════════════════════════
 */

/* global fetchGrocyQuantityUnits, fetchGrocyLocations, fetchGrocyProductGroups,
          fetchShoppingLocations, fetchGrocyUserfields, fetchGrocyProducts,
          fetchProductBarcodes,
          postGrocyProduct, postGrocyQuConversion, putGrocyProductUserfields,
          createProductBarcode, updateProductBarcodeUserfields, postGrocyStockAdd,
          apiFetch */

var _pc = {
    container: null,
    master: {
        units:             [],
        locations:         [],
        productGroups:     [],
        shoppingLocations: [],
        productUserfields: [],
        existingProducts:  [],
        productBarcodes:   []
    },
    priceMode: 'total',          // 'total' | 'per_unit'
    prefillBarcode: null,
    onCreated: null,             // valgfri callback(productId, name, warnings) — bruges af opret/kobl-draweren
    submitting: false,
    dupNameDismissed: false,
    dupBarcodeDismissed: false,
    dupNameTimer: null
};

function initProductCreate(containerEl, options) {
    _pc.container = containerEl;
    _pc.prefillBarcode = (options && options.barcode) || null;
    _pc.onCreated = (options && typeof options.onCreated === 'function') ? options.onCreated : null;
    containerEl.innerHTML = '<div class="pc-loading">Indlæser master-data…</div>';

    Promise.all([
        fetchGrocyQuantityUnits(),
        fetchGrocyLocations(),
        fetchGrocyProductGroups(),
        fetchShoppingLocations(),
        fetchGrocyUserfields().catch(function() { return []; }),
        fetchGrocyProducts().catch(function() { return []; }),
        fetchProductBarcodes().catch(function() { return []; })
    ]).then(function(res) {
        _pc.master.units             = res[0] || [];
        _pc.master.locations         = res[1] || [];
        _pc.master.productGroups     = res[2] || [];
        _pc.master.shoppingLocations = res[3] || [];
        _pc.master.productUserfields = (res[4] || []).filter(function(uf) { return uf.entity === 'products'; });
        _pc.master.existingProducts  = res[5] || [];
        _pc.master.productBarcodes   = res[6] || [];
        _pcRenderForm();
        if (_pc.prefillBarcode) {
            _pcPrefillFromBarcode(_pc.prefillBarcode);
        }
    }).catch(function(err) {
        containerEl.innerHTML = '<div class="pc-error">Fejl ved indlæsning: ' + _pcEsc(err.message || err) + '</div>';
    });
}

function cleanupProductCreate() {
    _pc.container = null;
    _pc.onCreated = null;
    _pc.prefillBarcode = null;
}

/* ── Helpers ────────────────────────────────────────────── */

function _pcEsc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function _pcVal(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

function _pcSet(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val == null ? '' : val;
}

function _pcFindUnit(name) {
    var lower = String(name || '').toLowerCase();
    return _pc.master.units.find(function(u) {
        return (u.name || '').toLowerCase() === lower ||
               (u.name_plural || '').toLowerCase() === lower;
    });
}

function _pcDefaultStockUnit() {
    return _pcFindUnit('kilo')
        || _pcFindUnit('kg')
        || _pcFindUnit('kilogram')
        || _pcFindUnit('antal')
        || _pcFindUnit('stk')
        || _pc.master.units[0];
}

function _pcUnitOptions(selectedId) {
    return _pc.master.units.map(function(u) {
        return '<option value="' + u.id + '"' + (u.id == selectedId ? ' selected' : '') + '>' + _pcEsc(u.name) + '</option>';
    }).join('');
}

function _pcStockUnitOptions(selectedId) {
    var allowed = ['kilo', 'kg', 'kilogram', 'stk', 'styk', 'stykke', 'stykker', 'antal'];
    var filtered = _pc.master.units.filter(function(u) {
        return allowed.indexOf((u.name || '').toLowerCase()) !== -1 ||
               allowed.indexOf((u.name_plural || '').toLowerCase()) !== -1;
    });
    var list = filtered.length > 0 ? filtered : _pc.master.units;
    return list.map(function(u) {
        return '<option value="' + u.id + '"' + (u.id == selectedId ? ' selected' : '') + '>' + _pcEsc(u.name) + '</option>';
    }).join('');
}

function _pcLocationOptions(selectedId) {
    return _pc.master.locations.map(function(l) {
        return '<option value="' + l.id + '"' + (l.id == selectedId ? ' selected' : '') + '>' + _pcEsc(l.name) + '</option>';
    }).join('');
}

function _pcProductGroupOptions() {
    return '<option value="">— ingen —</option>' +
        _pc.master.productGroups.map(function(g) {
            return '<option value="' + g.id + '">' + _pcEsc(g.name) + '</option>';
        }).join('');
}

function _pcShoppingLocationOptions() {
    return '<option value="">— ingen —</option>' +
        _pc.master.shoppingLocations.map(function(s) {
            return '<option value="' + s.id + '">' + _pcEsc(s.name) + '</option>';
        }).join('');
}

function _pcGetUserfield(name) {
    return _pc.master.productUserfields.find(function(uf) { return uf.name === name; }) || null;
}

/* ── Render form ───────────────────────────────────────── */

function _pcRenderForm() {
    var stockQu    = _pcDefaultStockUnit();
    var purchaseQu = stockQu;
    var firstLoc   = _pc.master.locations[0];
    var hverdagUf  = _pcGetUserfield('HverDag');
    // CO₂ håndteres ikke længere her — det gamle products.Co2e er deprecated (→ Co2e_OLD, CO₂ F1).
    // Det nye vægt-felt (kg/stk) tilføjes i CO₂ F2 (docs/CLAUDE_CO2.md §3).
    var stockName  = (stockQu && stockQu.name) || '';

    _pc.container.innerHTML =
        '<div class="pc-wrap">' +
            '<h2 class="pc-title">Opret produkt</h2>' +
            '<p class="pc-subtitle">Felter med <span class="pc-req">*</span> er påkrævet.</p>' +

            '<div class="pc-section">' +
                '<h3>Grunddata</h3>' +
                '<div class="pc-field">' +
                    '<label>Navn <span class="pc-req">*</span></label>' +
                    '<input type="text" id="pcName" placeholder="fx Smør Lurpak 500g" autocomplete="off">' +
                    '<div id="pcNameWarn" class="pc-name-warn"></div>' +
                '</div>' +
                '<div class="pc-row">' +
                    '<div class="pc-field">' +
                        '<label>Indkøbs-QU <span class="pc-req">*</span></label>' +
                        '<select id="pcQuPurchase">' + _pcUnitOptions(purchaseQu && purchaseQu.id) + '</select>' +
                    '</div>' +
                    '<div class="pc-field">' +
                        '<label>Lager-QU <span class="pc-req">*</span></label>' +
                        '<select id="pcQuStock">' + _pcStockUnitOptions(stockQu && stockQu.id) + '</select>' +
                    '</div>' +
                '</div>' +
                '<div class="pc-hint">Kilo for vægt-baserede varer, Stk for tællelige (fx løg, æg, hvidløg).</div>' +
                '<div id="pcQuConversion"></div>' +
                '<div id="pcWeightField"></div>' +
                '<div class="pc-row">' +
                    '<div class="pc-field">' +
                        '<label>Default-lokation <span class="pc-req">*</span></label>' +
                        '<select id="pcLocation">' + _pcLocationOptions(firstLoc && firstLoc.id) + '</select>' +
                    '</div>' +
                    '<div class="pc-field">' +
                        '<label>Varegruppe</label>' +
                        '<select id="pcProductGroup">' + _pcProductGroupOptions() + '</select>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<div class="pc-section">' +
                '<h3>Workflow</h3>' +
                '<div class="pc-field">' +
                    '<label>Primær leverandør</label>' +
                    '<select id="pcShoppingLocation">' + _pcShoppingLocationOptions() + '</select>' +
                '</div>' +
                '<div class="pc-row">' +
                    '<div class="pc-field">' +
                        '<label>Min. beholdning <span class="pc-hintspan">(udløser indkøbsliste)</span></label>' +
                        '<input type="number" id="pcMinStock" min="0" step="0.1" placeholder="0">' +
                    '</div>' +
                    (hverdagUf ?
                        '<div class="pc-field">' +
                            '<label>' + _pcEsc(hverdagUf.caption || 'Check-interval') + ' <span class="pc-hintspan">(dage mellem lagercheck)</span></label>' +
                            '<input type="number" id="pcHverdag" min="1" step="1" placeholder="fx 7, 14 eller 30">' +
                        '</div>'
                        : '<div class="pc-field"></div>') +
                '</div>' +
                '<div class="pc-row pc-row-3">' +
                    '<div class="pc-field">' +
                        '<label>Antal på lager nu <span class="pc-hintspan">(<span id="pcStockUnitLabel">' + _pcEsc(stockName) + '</span>)</span></label>' +
                        '<input type="number" id="pcInitialAmount" min="0" step="any" placeholder="0">' +
                        '<div id="pcAmountHint" class="pc-amount-hint"></div>' +
                    '</div>' +
                    '<div class="pc-field">' +
                        '<div class="pc-label-row">' +
                            '<label>Pris <span class="pc-hintspan">(valgfri)</span></label>' +
                            '<div class="pc-mode-toggle" id="pcPriceModeToggle">' +
                                '<button type="button" class="active" data-mode="total">Total</button>' +
                                '<button type="button" data-mode="per_unit">Pr. <span id="pcPriceUnitLabel">' + _pcEsc(stockName) + '</span></button>' +
                            '</div>' +
                        '</div>' +
                        '<input type="number" id="pcInitialPrice" min="0" step="0.01" placeholder="0.00">' +
                    '</div>' +
                    '<div class="pc-field">' +
                        '<label>Bedst før <span class="pc-hintspan">(valgfri)</span></label>' +
                        '<input type="date" id="pcBestBefore">' +
                    '</div>' +
                '</div>' +
                '<div class="pc-hint">Står du med varen i hånden? Udfyld antal, så registrerer vi det på lageret. Lad være tom hvis du kun planlægger.</div>' +
            '</div>' +

            '<div class="pc-section pc-collapsible' + (_pc.prefillBarcode ? ' open' : '') + '" id="pcSecBarcode">' +
                '<h3 class="pc-toggle">' +
                    '<span>+ Tilføj stregkode/varenummer (valgfrit)</span>' +
                    '<span class="pc-chev">›</span>' +
                '</h3>' +
                '<div class="pc-section-body">' +
                    '<div class="pc-field">' +
                        '<label>Stregkode / Varenummer</label>' +
                        '<input type="text" id="pcBarcode" placeholder="EAN eller leverandørens varenummer" autocomplete="off">' +
                        '<div id="pcBarcodeStatus" class="pc-barcode-status"></div>' +
                    '</div>' +
                    '<div class="pc-row">' +
                        '<div class="pc-field">' +
                            '<label>Salgsenhed-kode <span class="pc-hintspan">(fx ks, stk)</span></label>' +
                            '<input type="text" id="pcSupplierUnitCode" placeholder="ks">' +
                        '</div>' +
                        '<div class="pc-field">' +
                            '<label>Salgsenhed-antal</label>' +
                            '<input type="number" id="pcSupplierUnitQty" min="0" step="0.1" placeholder="1">' +
                        '</div>' +
                    '</div>' +
                    '<div class="pc-field">' +
                        '<label>Pris pr. enhed <span class="pc-hintspan">(seneste købspris)</span></label>' +
                        '<input type="number" id="pcLastPrice" min="0" step="0.01" placeholder="0.00">' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<div class="pc-submit-bar">' +
                '<button class="pc-btn-primary" id="pcSubmitBtn">✓ Opret produkt</button>' +
                '<div class="pc-status" id="pcStatus"></div>' +
            '</div>' +
        '</div>';

    _pcWireEvents();
    if (_pc.prefillBarcode) {
        _pcSet('pcBarcode', _pc.prefillBarcode);
    }
    _pcCheckQuConversion();
    _pcCheckWeightField();
    setTimeout(function() {
        var nameEl = document.getElementById('pcName');
        if (nameEl) nameEl.focus();
    }, 50);
}

function _pcWireEvents() {
    document.getElementById('pcQuPurchase').addEventListener('change', _pcCheckQuConversion);
    document.getElementById('pcQuStock').addEventListener('change', _pcOnStockQuChange);
    document.getElementById('pcInitialAmount').addEventListener('input', _pcUpdateAmountHint);
    document.getElementById('pcSubmitBtn').addEventListener('click', _pcSubmit);
    document.getElementById('pcName').addEventListener('input', _pcOnNameInput);
    document.getElementById('pcBarcode').addEventListener('input', _pcOnBarcodeInput);

    var toggle = document.getElementById('pcPriceModeToggle');
    toggle.querySelectorAll('button').forEach(function(b) {
        b.addEventListener('click', function() {
            _pc.priceMode = b.dataset.mode;
            toggle.querySelectorAll('button').forEach(function(x) {
                x.classList.toggle('active', x.dataset.mode === _pc.priceMode);
            });
        });
    });

    var sec = document.getElementById('pcSecBarcode');
    sec.querySelector('.pc-toggle').addEventListener('click', function() {
        sec.classList.toggle('open');
    });

    document.getElementById('pcShoppingLocation').addEventListener('change', _pcMaybeAutoLookupBarcode);
    document.getElementById('pcBarcode').addEventListener('change', _pcMaybeAutoLookupBarcode);
}

function _pcOnStockQuChange() {
    _pcCheckQuConversion();
    _pcCheckWeightField();
    _pcUpdateAmountHint();
    var sel = document.getElementById('pcQuStock');
    var chosen = _pc.master.units.find(function(u) { return u.id == sel.value; });
    var name = (chosen && chosen.name) || '';
    var stockLbl = document.getElementById('pcStockUnitLabel');
    var priceLbl = document.getElementById('pcPriceUnitLabel');
    if (stockLbl) stockLbl.textContent = name;
    if (priceLbl) priceLbl.textContent = name;
}

function _pcCheckQuConversion() {
    var purchaseId = _pcVal('pcQuPurchase');
    var stockId    = _pcVal('pcQuStock');
    var box        = document.getElementById('pcQuConversion');
    if (!box) return;
    if (!purchaseId || !stockId || purchaseId === stockId) {
        box.innerHTML = '';
        return;
    }
    var purchaseUnit = _pc.master.units.find(function(u) { return u.id == purchaseId; });
    var stockUnit    = _pc.master.units.find(function(u) { return u.id == stockId; });
    box.innerHTML =
        '<div class="pc-qu-conversion">' +
            '<strong>QU-konvertering kræves:</strong> ' +
            '1 ' + _pcEsc((purchaseUnit && purchaseUnit.name) || '?') + ' = ' +
            '<input type="number" id="pcQuFactor" min="0" step="any" placeholder="?"> ' +
            _pcEsc((stockUnit && stockUnit.name) || '?') +
            '<div class="pc-qu-helper">Fx hvis 1 kasse = 6000 g, skriv <strong>6000</strong>.</div>' +
        '</div>';
    var fac = document.getElementById('pcQuFactor');
    if (fac) fac.addEventListener('input', _pcUpdateAmountHint);
}

function _pcUpdateAmountHint() {
    var hintEl = document.getElementById('pcAmountHint');
    if (!hintEl) return;
    var amount = parseFloat(_pcVal('pcInitialAmount'));
    var purchaseId = _pcVal('pcQuPurchase');
    var stockId    = _pcVal('pcQuStock');
    if (!amount || !purchaseId || !stockId || purchaseId === stockId) {
        hintEl.textContent = '';
        return;
    }
    var factor = parseFloat(_pcVal('pcQuFactor'));
    if (!factor || factor <= 0) {
        hintEl.textContent = '';
        return;
    }
    var purchaseUnit = _pc.master.units.find(function(u) { return u.id == purchaseId; });
    var packs = amount / factor;
    var roundedPacks = Math.round(packs * 100) / 100;
    hintEl.textContent = '≈ ' + roundedPacks + ' ' + ((purchaseUnit && purchaseUnit.name) || '');
}

/* ── CO₂ kg-vej (vægt pr. stk) — spec CLAUDE_CO2.md §3 ──────────────
 * Tællevarer (stock = Antal) mangler en vej til kg. Uden den kan varen
 * hverken indgå i CO₂- eller kostpris-beregning (de deler kg-konverteringen).
 * Feltet er VALGFRIT — varen oprettes uanset; mangler den, flages det.
 * "Vej N stk → Y gram" (ikke 1 — en serviet på 1,2 g kan ikke vejes enkeltvis).
 */
function _pcIsWeightUnit(unit) {
    if (!unit) return false;
    var n = (unit.name || '').toLowerCase();
    return ['kilo', 'kg', 'kilogram', 'gram', 'g'].indexOf(n) !== -1;
}

function _pcCheckWeightField() {
    var box = document.getElementById('pcWeightField');
    if (!box) return;
    var stockId   = _pcVal('pcQuStock');
    var stockUnit = _pc.master.units.find(function(u) { return u.id == stockId; });
    // Allerede vægt-baseret (Kilo/Gram) → ingen kg-vej nødvendig
    if (!stockUnit || _pcIsWeightUnit(stockUnit)) { box.innerHTML = ''; return; }
    box.innerHTML =
        '<div class="pc-qu-conversion">' +
            '<strong>CO₂ kg-vej</strong> <span class="pc-hintspan">(vægt pr. ' +
                _pcEsc(stockUnit.name) + ' — til CO₂ + kostpris, valgfri)</span>' +
            '<div class="pc-weight-row">Vej ' +
                '<input type="number" id="pcWeighCount" min="1" step="1" value="1"> ' +
                _pcEsc(stockUnit.name) + ' → ' +
                '<input type="number" id="pcWeighGrams" min="0" step="any" placeholder="gram"> g' +
            '</div>' +
            '<div id="pcWeightPreview" class="pc-qu-helper">Uden vægt kan varen ikke indgå i CO₂-/kostpris-beregning — kan tilføjes senere.</div>' +
        '</div>';
    var c = document.getElementById('pcWeighCount');
    var g = document.getElementById('pcWeighGrams');
    if (c) c.addEventListener('input', _pcUpdateWeightPreview);
    if (g) g.addEventListener('input', _pcUpdateWeightPreview);
}

function _pcUpdateWeightPreview() {
    var el = document.getElementById('pcWeightPreview');
    if (!el) return;
    var cnt  = parseFloat(_pcVal('pcWeighCount')) || 1;
    var gram = parseFloat(_pcVal('pcWeighGrams'));
    if (!gram || gram <= 0 || cnt <= 0) {
        el.textContent = 'Uden vægt kan varen ikke indgå i CO₂-/kostpris-beregning — kan tilføjes senere.';
        return;
    }
    var perG  = gram / cnt;
    var perKg = perG / 1000;
    el.textContent = '1 stk ≈ ' + (Math.round(perG * 100) / 100) + ' g = ' +
                     (Math.round(perKg * 100000) / 100000) + ' kg';
}

function _pcStringSimilarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return 1;
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

function _pcOnNameInput() {
    _pc.dupNameDismissed = false;
    if (_pc.dupNameTimer) clearTimeout(_pc.dupNameTimer);
    _pc.dupNameTimer = setTimeout(_pcCheckDuplicateName, 200);
}

function _pcCheckDuplicateName() {
    var warnEl = document.getElementById('pcNameWarn');
    if (!warnEl) return;
    if (_pc.dupNameDismissed) { warnEl.innerHTML = ''; warnEl.className = 'pc-name-warn'; return; }
    var name = _pcVal('pcName');
    if (name.length < 3) { warnEl.innerHTML = ''; warnEl.className = 'pc-name-warn'; return; }

    var lower = name.toLowerCase();
    var exact = _pc.master.existingProducts.find(function(p) {
        return (p.name || '').toLowerCase() === lower;
    });

    var matches;
    if (exact) {
        matches = [{ product: exact, sim: 1 }];
    } else {
        var scored = _pc.master.existingProducts.map(function(p) {
            return { product: p, sim: _pcStringSimilarity(name, p.name || '') };
        }).filter(function(x) { return x.sim >= 0.6; });
        scored.sort(function(a, b) { return b.sim - a.sim; });
        matches = scored.slice(0, 3);
    }

    if (matches.length === 0) {
        warnEl.innerHTML = '';
        warnEl.className = 'pc-name-warn';
        return;
    }

    var headerText = exact
        ? '⚠ Et produkt med dette navn findes allerede:'
        : '⚠ Lignende produkter findes allerede:';
    var rows = matches.map(function(m) {
        var pct = Math.round(m.sim * 100);
        var loc = _pc.master.locations.find(function(l) { return l.id == m.product.location_id; });
        var locName = loc ? loc.name : '';
        return '<div class="pc-dup-row">' +
            '<span class="pc-dup-name">' + _pcEsc(m.product.name) + '</span>' +
            (locName ? '<span class="pc-dup-meta">' + _pcEsc(locName) + '</span>' : '') +
            '<span class="pc-dup-pct">' + pct + '%</span>' +
            '<span class="pc-dup-id">id ' + m.product.id + '</span>' +
        '</div>';
    }).join('');

    warnEl.innerHTML =
        '<div class="pc-dup-header">' + headerText + '</div>' +
        '<div class="pc-dup-list">' + rows + '</div>' +
        '<button type="button" class="pc-dup-dismiss" id="pcDupNameDismiss">Fortsæt alligevel</button>';
    warnEl.className = exact ? 'pc-name-warn pc-name-warn-error' : 'pc-name-warn pc-name-warn-info';
    var btn = document.getElementById('pcDupNameDismiss');
    if (btn) btn.addEventListener('click', function() {
        _pc.dupNameDismissed = true;
        warnEl.innerHTML = '';
        warnEl.className = 'pc-name-warn';
    });
}

function _pcOnBarcodeInput() {
    _pc.dupBarcodeDismissed = false;
    _pcCheckDuplicateBarcode();
}

function _pcCheckDuplicateBarcode() {
    var statusEl = document.getElementById('pcBarcodeStatus');
    if (!statusEl) return;
    var bc = _pcVal('pcBarcode');
    if (!bc || bc.length < 4) {
        if (statusEl.classList.contains('pc-barcode-status-dup')) {
            statusEl.innerHTML = '';
            statusEl.className = 'pc-barcode-status';
        }
        return;
    }
    if (_pc.dupBarcodeDismissed) return;

    var existing = _pc.master.productBarcodes.find(function(b) {
        return String(b.barcode || '').trim() === bc;
    });
    if (!existing) {
        if (statusEl.classList.contains('pc-barcode-status-dup')) {
            statusEl.innerHTML = '';
            statusEl.className = 'pc-barcode-status';
        }
        return;
    }
    var product = _pc.master.existingProducts.find(function(p) { return p.id == existing.product_id; });
    var prodName = product ? product.name : '(ukendt produkt id ' + existing.product_id + ')';
    statusEl.innerHTML =
        '<div class="pc-dup-header">⚠ Stregkode/varenummer er allerede koblet til:</div>' +
        '<div class="pc-dup-list">' +
            '<div class="pc-dup-row">' +
                '<span class="pc-dup-name">' + _pcEsc(prodName) + '</span>' +
                '<span class="pc-dup-id">produkt-id ' + existing.product_id + '</span>' +
            '</div>' +
        '</div>' +
        '<button type="button" class="pc-dup-dismiss" id="pcDupBcDismiss">Fortsæt alligevel</button>';
    statusEl.className = 'pc-barcode-status pc-barcode-status-dup';
    var btn = document.getElementById('pcDupBcDismiss');
    if (btn) btn.addEventListener('click', function() {
        _pc.dupBarcodeDismissed = true;
        statusEl.innerHTML = '';
        statusEl.className = 'pc-barcode-status';
    });
}

/* ── Hørkram pre-fill ────────────────────────────────────── */

function _pcMaybeAutoLookupBarcode() {
    var barcode = _pcVal('pcBarcode');
    if (!barcode || !_pc.prefillBarcode || barcode !== _pc.prefillBarcode) return;
    _pcPrefillFromBarcode(barcode);
}

function _pcPrefillFromBarcode(barcode) {
    var statusEl = document.getElementById('pcBarcodeStatus');
    if (statusEl) {
        statusEl.className = 'pc-barcode-status pc-barcode-status-info';
        statusEl.textContent = 'Søger i Hørkram-katalog…';
    }

    apiFetch('/horkram/product/' + encodeURIComponent(barcode))
        .then(function(data) {
            if (!data || !data.name) {
                if (statusEl) {
                    statusEl.className = 'pc-barcode-status';
                    statusEl.textContent = 'Ingen Hørkram-match — udfyld manuelt.';
                }
                return;
            }
            if (!_pcVal('pcName')) _pcSet('pcName', data.name);

            var defaultUnit = (data.salesUnits || []).find(function(u) { return u.isDefault; })
                || (data.salesUnits || [])[0];
            if (defaultUnit && defaultUnit.code && !_pcVal('pcSupplierUnitCode')) {
                _pcSet('pcSupplierUnitCode', defaultUnit.code);
            }
            if (defaultUnit && defaultUnit.quantity && !_pcVal('pcSupplierUnitQty')) {
                _pcSet('pcSupplierUnitQty', defaultUnit.quantity);
            }
            if (data.pricePerUnit && !_pcVal('pcLastPrice')) {
                _pcSet('pcLastPrice', data.pricePerUnit);
            }
            _pc.dupNameDismissed = false;
            _pcCheckDuplicateName();
            if (statusEl) {
                statusEl.className = 'pc-barcode-status pc-barcode-status-ok';
                statusEl.textContent = '✓ Pre-udfyldt fra Hørkram (' + _pcEsc(data.name) + ')';
            }
        })
        .catch(function() {
            if (statusEl) {
                statusEl.className = 'pc-barcode-status';
                statusEl.textContent = 'Hørkram-opslag kunne ikke gennemføres — udfyld manuelt.';
            }
        });
}

/* ── Submit ───────────────────────────────────────────── */

function _pcShowStatus(msg, type) {
    var el = document.getElementById('pcStatus');
    if (!el) return;
    el.className = 'pc-status pc-status-' + (type || 'info');
    el.innerHTML = msg;
}

function _pcSubmit() {
    if (_pc.submitting) return;
    var btn = document.getElementById('pcSubmitBtn');
    btn.disabled = true;
    _pc.submitting = true;

    var name              = _pcVal('pcName');
    var quPurchase        = _pcVal('pcQuPurchase');
    var quStock           = _pcVal('pcQuStock');
    var locationId        = _pcVal('pcLocation');
    var productGroupId    = _pcVal('pcProductGroup');
    var shoppingLocationId = _pcVal('pcShoppingLocation');
    var minStock          = _pcVal('pcMinStock');
    var hverdag           = _pcVal('pcHverdag');
    var initialAmount     = _pcVal('pcInitialAmount');
    var initialPrice      = _pcVal('pcInitialPrice');
    var bestBefore        = _pcVal('pcBestBefore');
    var barcode           = _pcVal('pcBarcode');
    var supplierUnitCode  = _pcVal('pcSupplierUnitCode');
    var supplierUnitQty   = _pcVal('pcSupplierUnitQty');
    var lastPrice         = _pcVal('pcLastPrice');

    if (!name) { _pcShowStatus('Navn er påkrævet', 'error'); btn.disabled = false; _pc.submitting = false; return; }
    if (!quPurchase || !quStock) { _pcShowStatus('Indkøbs-QU og Lager-QU er påkrævet', 'error'); btn.disabled = false; _pc.submitting = false; return; }
    if (!locationId) { _pcShowStatus('Default-lokation er påkrævet', 'error'); btn.disabled = false; _pc.submitting = false; return; }

    var quFactor = 1;
    if (quPurchase !== quStock) {
        quFactor = parseFloat(_pcVal('pcQuFactor'));
        if (!quFactor || quFactor <= 0) {
            _pcShowStatus('Konverteringsfaktor mellem QU er påkrævet', 'error');
            btn.disabled = false; _pc.submitting = false; return;
        }
    }

    _pcShowStatus('Opretter produkt…', 'info');

    var productPayload = {
        name: name,
        qu_id_purchase: parseInt(quPurchase),
        qu_id_stock: parseInt(quStock),
        location_id: parseInt(locationId)
    };
    if (productGroupId)     productPayload.product_group_id     = parseInt(productGroupId);
    if (shoppingLocationId) productPayload.shopping_location_id = parseInt(shoppingLocationId);
    if (minStock)           productPayload.min_stock_amount     = parseFloat(minStock);

    var warnings = [];
    var productId = null;

    postGrocyProduct(productPayload)
        .then(function(res) {
            productId = res && res.created_object_id;
            if (!productId) throw new Error('Produkt ikke oprettet — manglende id i svar');
        })
        .then(function() {
            if (quPurchase === quStock) return;
            return postGrocyQuConversion({
                product_id: productId,
                from_qu_id: parseInt(quPurchase),
                to_qu_id: parseInt(quStock),
                factor: quFactor
            }).catch(function(e) {
                warnings.push('QU-konvertering kunne ikke oprettes: ' + e.message);
            });
        })
        .then(function() {
            // CO₂ kg-vej: opret Antal→Kilo-konvertering (spec §3). Valgfrit.
            var kiloUnit = _pcFindUnit('kilo') || _pcFindUnit('kg') || _pcFindUnit('kilogram');
            var stockUnit = _pc.master.units.find(function(u) { return u.id == parseInt(quStock); });
            if (!kiloUnit || _pcIsWeightUnit(stockUnit)) return; // allerede vægt-baseret
            var gram = parseFloat(_pcVal('pcWeighGrams'));
            var cnt  = parseFloat(_pcVal('pcWeighCount')) || 1;
            if (!gram || gram <= 0) {
                warnings.push('CO₂ kg-vej mangler — varen kan ikke indgå i CO₂-/kostpris-beregning før den er sat.');
                return;
            }
            var kgPerStk = (gram / cnt) / 1000;
            return postGrocyQuConversion({
                product_id: productId,
                from_qu_id: parseInt(quStock),
                to_qu_id: kiloUnit.id,
                factor: kgPerStk
            }).catch(function(e) {
                warnings.push('CO₂ kg-vej kunne ikke oprettes: ' + e.message);
            });
        })
        .then(function() {
            var ufBody = {};
            if (hverdag && _pcGetUserfield('HverDag')) ufBody.HverDag = hverdag;
            if (Object.keys(ufBody).length === 0) return;
            return putGrocyProductUserfields(productId, ufBody).catch(function(e) {
                warnings.push('Userfields kunne ikke gemmes: ' + e.message);
            });
        })
        .then(function() {
            if (!barcode) return;
            var bcPayload = {
                product_id: productId,
                barcode: barcode,
                qu_id: parseInt(quPurchase),
                amount: 0,
                note: name
            };
            if (shoppingLocationId) bcPayload.shopping_location_id = parseInt(shoppingLocationId);
            if (lastPrice)          bcPayload.last_price           = parseFloat(lastPrice);
            return createProductBarcode(bcPayload)
                .then(function(bcRes) {
                    var bcId = bcRes && bcRes.created_object_id;
                    if (bcId && (supplierUnitCode || supplierUnitQty)) {
                        var ufPayload = {};
                        if (supplierUnitCode) ufPayload.supplier_unit_code = supplierUnitCode;
                        if (supplierUnitQty)  ufPayload.supplier_unit_qty  = supplierUnitQty;
                        return updateProductBarcodeUserfields(bcId, ufPayload).catch(function(e) {
                            warnings.push('Salgsenhed-felter kunne ikke gemmes: ' + e.message);
                        });
                    }
                })
                .catch(function(e) {
                    warnings.push('Stregkode kunne ikke oprettes: ' + e.message);
                });
        })
        .then(function() {
            var amountNum = parseFloat(initialAmount);
            if (isNaN(amountNum) || amountNum <= 0) return;
            var stockBody = {
                amount: amountNum,
                transaction_type: 'purchase',
                best_before_date: bestBefore || '2999-12-31'
            };
            var priceVal = parseFloat(initialPrice);
            if (!isNaN(priceVal) && priceVal > 0) {
                stockBody.price = _pc.priceMode === 'per_unit' ? priceVal : (priceVal / amountNum);
            }
            return postGrocyStockAdd(productId, stockBody).catch(function(e) {
                warnings.push('Lagerbeholdning kunne ikke registreres: ' + e.message);
            });
        })
        .then(function() {
            // Opret/kobl-draweren overtager efter-flowet (læg på liste + luk).
            // Ellers vis det normale resultatkort.
            if (_pc.onCreated) {
                _pc.onCreated(productId, name, warnings);
            } else {
                _pcShowResult(productId, name, warnings);
            }
        })
        .catch(function(err) {
            _pcShowStatus('Fejl: ' + (err.message || err), 'error');
            btn.disabled = false;
            _pc.submitting = false;
        });
}

function _pcShowResult(productId, name, warnings) {
    var warnHtml = warnings.length > 0
        ? '<div class="pc-warn-box"><strong>Produktet er oprettet, men:</strong><br>' +
            warnings.map(function(w) { return '• ' + _pcEsc(w); }).join('<br>') +
          '</div>'
        : '';

    _pc.container.innerHTML =
        '<div class="pc-wrap">' +
            '<div class="pc-result-card">' +
                '<div class="pc-result-icon">✓</div>' +
                '<h3>Produkt oprettet</h3>' +
                '<p class="pc-result-id">"' + _pcEsc(name) + '" — Grocy id ' + productId + '</p>' +
                warnHtml +
                '<div class="pc-result-actions">' +
                    '<button class="pc-btn-secondary" id="pcAgainBtn">Opret endnu ét</button>' +
                    '<button class="pc-btn-secondary" id="pcDoneBtn">Tilbage til lager</button>' +
                '</div>' +
            '</div>' +
        '</div>';

    document.getElementById('pcAgainBtn').addEventListener('click', function() {
        _pc.prefillBarcode = null;
        _pc.submitting = false;
        _pc.dupNameDismissed = false;
        _pc.dupBarcodeDismissed = false;
        _pc.master.existingProducts = [];
        _pc.master.productBarcodes = [];
        fetchGrocyProducts().then(function(p) { _pc.master.existingProducts = p || []; });
        fetchProductBarcodes().then(function(b) { _pc.master.productBarcodes = b || []; });
        _pcRenderForm();
    });
    document.getElementById('pcDoneBtn').addEventListener('click', function() {
        if (typeof window._pcOnDone === 'function') window._pcOnDone();
    });
}
