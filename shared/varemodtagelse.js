/**
 * shared/varemodtagelse.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelses-komponent — Tab 3 i kitchen/purchasing.html.
 *
 * Entry: initVaremodtagelse(containerEl)
 * Prefix: _vm  (private globals)
 *
 * Flow:
 *   1. Henter ventende purchase_orders (status=sent/confirmed)
 *   2. Viser ordrekort → klik åbner detalje
 *   3. Detalje: linjer med modtaget/skadet felter
 *   4. Godkend → POST /api/receiving/complete
 *   5. Succesview med opsummering
 *
 * Bruger eksisterende routes/receiving.js fusion-endpoint.
 * ════════════════════════════════════════════════════════════
 */

/* ── State ───────────────────────────────────────────────── */

var _vmContainer    = null;
var _vmOrders       = [];     // ventende purchase_orders
var _vmCurrentOrder = null;   // valgt ordre med linjer
var _vmLines        = [];     // redigerbar linje-state
var _vmBusy         = false;

/* ── Entry point ─────────────────────────────────────────── */

async function initVaremodtagelse(el) {
    _vmContainer = el;
    _vmContainer.innerHTML = '<div class="vm-container"><div class="vm-loading">Henter ordrer...</div></div>';

    try {
        await _vmLoadOrders();
        _vmRenderOrderList();
    } catch (err) {
        console.error('[varemodtagelse] Init fejl:', err);
        _vmContainer.innerHTML = '<div class="vm-container"><div class="vm-loading" style="color:#c62828;">Fejl: ' + err.message + '</div></div>';
    }
}

/* ── Data loading ────────────────────────────────────────── */

async function _vmLoadOrders() {
    _vmOrders = await fetchPendingOrders();
    // Filtrer til relevante statusser
    _vmOrders = _vmOrders.filter(function(o) {
        return o.status === 'sent' || o.status === 'confirmed' || o.status === 'draft';
    });
}

/* ── Order list ──────────────────────────────────────────── */

function _vmRenderOrderList() {
    var root = document.createElement('div');
    root.className = 'vm-container';

    // Header
    var header = document.createElement('div');
    header.className = 'vm-header';

    var h2 = document.createElement('h2');
    h2.textContent = 'Varemodtagelse';
    header.appendChild(h2);

    // Whiteboard link (sekundær)
    var wbLink = document.createElement('a');
    wbLink.className = 'vm-wb-link';
    wbLink.href = 'https://whiteboard.ristetrug.dk?open=varemodtagelse';
    wbLink.target = '_blank';
    wbLink.innerHTML = '📋 Åbn FVST-registrering';
    header.appendChild(wbLink);

    root.appendChild(header);

    // Empty state
    if (_vmOrders.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'vm-empty';
        empty.innerHTML =
            '<div class="vm-empty-icon">📭</div>' +
            '<div>Ingen ventende ordrer</div>' +
            '<div style="font-size:13px;margin-top:4px;">Bestil varer i Bestilling-tabben for at se dem her.</div>';
        root.appendChild(empty);
        _vmContainer.innerHTML = '';
        _vmContainer.appendChild(root);
        return;
    }

    // Order grid
    var grid = document.createElement('div');
    grid.className = 'vm-order-grid';

    for (var i = 0; i < _vmOrders.length; i++) {
        var order = _vmOrders[i];
        var card = document.createElement('div');
        card.className = 'vm-order-card';

        var supplierName = order.supplier_name || 'Ukendt leverandør';
        var lineCount = order.line_count || order.lines?.length || '?';
        var dateStr = order.expected_delivery_date
            ? new Date(order.expected_delivery_date).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short' })
            : 'Ukendt dato';

        card.innerHTML =
            '<div class="vm-oc-supplier">' + _vmEsc(supplierName) + '</div>' +
            '<div class="vm-oc-meta">' +
                '<span>📅 ' + dateStr + '</span>' +
                '<span>📦 ' + lineCount + ' varer</span>' +
            '</div>' +
            '<span class="vm-oc-badge">' + (order.status || 'sent') + '</span>';

        card.addEventListener('click', (function(o) {
            return function() { _vmOpenOrder(o); };
        })(order));

        grid.appendChild(card);
    }

    root.appendChild(grid);
    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(root);
}

/* ── Order detail ────────────────────────────────────────── */

async function _vmOpenOrder(order) {
    _vmContainer.innerHTML = '<div class="vm-container"><div class="vm-loading">Henter ordrelinjer...</div></div>';

    try {
        _vmCurrentOrder = await fetchPendingOrder(order.id);

        // Build editable lines
        var orderLines = _vmCurrentOrder.lines || [];
        _vmLines = orderLines.map(function(line) {
            var expected = line.quantity_ordered || line.unit_quantity || 0;
            return {
                line: line,
                productName: line.supplier_product_name || line.product_name || 'Produkt #' + (line.item_id || line.grocy_product_id || '?'),
                expected: expected,
                received: expected,   // pre-fill = bestilt (default: alt ok)
                damaged: 0,
                discrepancyType: 'none',
                note: '',
            };
        });

        _vmRenderDetail();
    } catch (err) {
        _vmContainer.innerHTML = '<div class="vm-container"><div class="vm-loading" style="color:#c62828;">Fejl: ' + err.message + '</div></div>';
    }
}

function _vmRenderDetail() {
    var root = document.createElement('div');
    root.className = 'vm-container';

    // Topbar
    var topbar = document.createElement('div');
    topbar.className = 'vm-detail-topbar';

    var backBtn = document.createElement('button');
    backBtn.className = 'vm-back-btn';
    backBtn.textContent = '← Tilbage';
    backBtn.addEventListener('click', function() {
        _vmCurrentOrder = null;
        _vmLines = [];
        _vmRenderOrderList();
    });
    topbar.appendChild(backBtn);

    var title = document.createElement('span');
    title.className = 'vm-detail-title';
    title.textContent = (_vmCurrentOrder.supplier_name || 'Ordre') + ' #' + _vmCurrentOrder.id;
    topbar.appendChild(title);

    root.appendChild(topbar);

    // Info
    if (_vmCurrentOrder.expected_delivery_date) {
        var info = document.createElement('p');
        info.style.cssText = 'font-size:13px;color:var(--color-text-dim);margin-bottom:16px;';
        info.textContent = 'Forventet levering: ' + new Date(_vmCurrentOrder.expected_delivery_date).toLocaleDateString('da-DK');
        root.appendChild(info);
    }

    // Lines table
    if (_vmLines.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'vm-empty';
        empty.textContent = 'Ingen linjer på denne ordre.';
        root.appendChild(empty);
    } else {
        var table = document.createElement('table');
        table.className = 'vm-lines-table';

        var thead = document.createElement('thead');
        thead.innerHTML =
            '<tr>' +
            '<th>Produkt</th>' +
            '<th>Bestilt</th>' +
            '<th>Modtaget</th>' +
            '<th>Skadet</th>' +
            '<th>Status</th>' +
            '</tr>';
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        for (var i = 0; i < _vmLines.length; i++) {
            tbody.appendChild(_vmRenderLine(i));
        }
        table.appendChild(tbody);
        root.appendChild(table);
    }

    // Approve bar
    root.appendChild(_vmRenderApproveBar());

    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(root);
}

function _vmRenderLine(index) {
    var l = _vmLines[index];
    var tr = document.createElement('tr');

    if (l.discrepancyType === 'missing') {
        tr.className = 'vm-missing';
    } else if (l.discrepancyType !== 'none') {
        tr.className = 'vm-discrepancy';
    }

    // Product name
    var tdName = document.createElement('td');
    tdName.style.fontWeight = '600';
    tdName.textContent = l.productName;
    tr.appendChild(tdName);

    // Expected
    var tdExpected = document.createElement('td');
    tdExpected.textContent = l.expected;
    tr.appendChild(tdExpected);

    // Received input
    var tdReceived = document.createElement('td');
    var recInput = document.createElement('input');
    recInput.className = 'vm-qty-input';
    recInput.type = 'number';
    recInput.min = '0';
    recInput.value = l.received;
    recInput.addEventListener('change', (function(idx) {
        return function() {
            _vmLines[idx].received = parseInt(this.value) || 0;
            _vmUpdateDiscrepancy(idx);
            _vmRenderDetail();
        };
    })(index));
    tdReceived.appendChild(recInput);
    tr.appendChild(tdReceived);

    // Damaged input
    var tdDamaged = document.createElement('td');
    var dmgInput = document.createElement('input');
    dmgInput.className = 'vm-qty-input';
    dmgInput.type = 'number';
    dmgInput.min = '0';
    dmgInput.value = l.damaged;
    dmgInput.addEventListener('change', (function(idx) {
        return function() {
            _vmLines[idx].damaged = parseInt(this.value) || 0;
            _vmUpdateDiscrepancy(idx);
            _vmRenderDetail();
        };
    })(index));
    tdDamaged.appendChild(dmgInput);
    tr.appendChild(tdDamaged);

    // Discrepancy type
    var tdDisc = document.createElement('td');
    if (l.discrepancyType !== 'none') {
        var badge = document.createElement('span');
        badge.className = 'vm-disc-type vm-disc--' + l.discrepancyType;
        var labels = { short: 'Mangler', over: 'For mange', damaged: 'Beskadiget', missing: 'Mangler helt' };
        badge.textContent = labels[l.discrepancyType] || l.discrepancyType;
        tdDisc.appendChild(badge);
    } else {
        tdDisc.innerHTML = '<span style="color:#4caf50;font-weight:600;">✓ OK</span>';
    }
    tr.appendChild(tdDisc);

    return tr;
}

function _vmUpdateDiscrepancy(index) {
    var l = _vmLines[index];
    if (l.received === 0 && l.expected > 0) {
        l.discrepancyType = 'missing';
    } else if (l.damaged > 0) {
        l.discrepancyType = 'damaged';
    } else if (l.received < l.expected) {
        l.discrepancyType = 'short';
    } else if (l.received > l.expected) {
        l.discrepancyType = 'over';
    } else {
        l.discrepancyType = 'none';
    }
}

/* ── Approve bar ─────────────────────────────────────────── */

function _vmRenderApproveBar() {
    var bar = document.createElement('div');
    bar.className = 'vm-approve-bar';

    var discCount = _vmLines.filter(function(l) { return l.discrepancyType !== 'none'; }).length;
    var totalItems = _vmLines.length;

    var summary = document.createElement('div');
    summary.className = 'vm-approve-summary';
    summary.innerHTML = '<strong>' + totalItems + ' varer</strong>' +
        (discCount > 0 ? ', <span style="color:#e65100;">' + discCount + ' med afvigelse</span>' : ', alle OK');
    bar.appendChild(summary);

    var btn = document.createElement('button');
    btn.className = 'vm-approve-btn';
    btn.textContent = 'Godkend modtagelse';
    btn.disabled = _vmBusy;
    btn.addEventListener('click', _vmConfirmApprove);
    bar.appendChild(btn);

    return bar;
}

/* ── Confirm + Approve ───────────────────────────────────── */

function _vmConfirmApprove() {
    var overlay = document.createElement('div');
    overlay.className = 'vm-confirm-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'vm-confirm-dialog';
    dialog.innerHTML =
        '<h3>Godkend modtagelse?</h3>' +
        '<p>Dette opdaterer lageret i Grocy og kan ikke fortrydes.</p>';

    var actions = document.createElement('div');
    actions.className = 'vm-confirm-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'vm-confirm-cancel';
    cancelBtn.textContent = 'Annuller';
    cancelBtn.addEventListener('click', function() { overlay.remove(); });

    var okBtn = document.createElement('button');
    okBtn.className = 'vm-confirm-ok';
    okBtn.textContent = 'Godkend';
    okBtn.addEventListener('click', function() {
        overlay.remove();
        _vmDoApprove();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

async function _vmDoApprove() {
    if (_vmBusy) return;
    _vmBusy = true;

    try {
        // Build items for receiving/complete endpoint
        var items = _vmLines.map(function(l) {
            var stockQty = l.received - l.damaged;
            return {
                product_id: l.line.item_id || l.line.grocy_product_id,
                quantity_expected: l.expected,
                quantity_received: stockQty > 0 ? stockQty : 0,
                quantity_damaged: l.damaged,
                status: l.discrepancyType === 'none' ? 'ok'
                    : l.discrepancyType === 'missing' ? 'missing'
                    : l.discrepancyType === 'damaged' ? 'damaged'
                    : l.discrepancyType === 'short' ? 'short'
                    : 'ok',
                note: l.note || null,
            };
        });

        var result = await postReceivingComplete({
            purchase_order_id: _vmCurrentOrder.id,
            supplier: _vmCurrentOrder.supplier_name || 'Ukendt',
            receiver: 'Køkken', // TODO: brugerens navn fra auth
            items: items,
        });

        // Handle partial shopping_list updates for partial deliveries
        for (var i = 0; i < _vmLines.length; i++) {
            var l = _vmLines[i];
            var slId = l.line.shopping_list_id || l.line.grocy_shopping_list_id;
            if (!slId) continue;

            if (l.received < l.expected && l.received > 0) {
                // Delvis modtagelse: reducer qty i stedet for at slette
                var remaining = l.expected - l.received;
                try {
                    await updateShoppingListItem(slId, { amount: remaining });
                } catch (e) {
                    console.warn('[varemodtagelse] Kunne ikke opdatere shopping list:', e.message);
                }
            } else if (l.received >= l.expected) {
                // Fuld modtagelse: slet fra shopping list
                try {
                    await deleteShoppingListItem(slId);
                } catch (e) {
                    console.warn('[varemodtagelse] Kunne ikke slette shopping list item:', e.message);
                }
            }
            // Hvis received === 0 (missing): behold på listen (gør intet)
        }

        _vmRenderSuccess(result);
    } catch (err) {
        alert('Fejl ved godkendelse: ' + err.message);
    } finally {
        _vmBusy = false;
    }
}

/* ── Success view ────────────────────────────────────────── */

function _vmRenderSuccess(result) {
    var root = document.createElement('div');
    root.className = 'vm-container';

    var success = document.createElement('div');
    success.className = 'vm-success';

    success.innerHTML = '<div class="vm-success-icon">✅</div>';

    var title = document.createElement('div');
    title.className = 'vm-success-title';
    title.textContent = 'Modtagelse godkendt';
    success.appendChild(title);

    var grocyAdded = result.grocy ? result.grocy.added : 0;
    var grocyFailed = result.grocy ? result.grocy.failed : 0;

    var details = document.createElement('div');
    details.className = 'vm-success-details';
    details.textContent = grocyAdded + ' varer lagt på lager' +
        (grocyFailed > 0 ? ', ' + grocyFailed + ' fejlede' : '');
    success.appendChild(details);

    // Discrepancies
    var discLines = _vmLines.filter(function(l) { return l.discrepancyType !== 'none'; });
    if (discLines.length > 0) {
        var discDiv = document.createElement('div');
        discDiv.className = 'vm-success-discrepancies';
        discDiv.innerHTML = '<strong>Afvigelser:</strong>';
        for (var i = 0; i < discLines.length; i++) {
            var d = discLines[i];
            var labels = { short: 'Mangler', over: 'For mange', damaged: 'Beskadiget', missing: 'Mangler helt' };
            var p = document.createElement('div');
            p.style.cssText = 'margin-top:4px;';
            p.textContent = '• ' + d.productName + ' — ' + (labels[d.discrepancyType] || d.discrepancyType) +
                ' (bestilt: ' + d.expected + ', modtaget: ' + d.received + ')';
            discDiv.appendChild(p);
        }
        success.appendChild(discDiv);
    }

    // Grocy errors
    if (grocyFailed > 0 && result.grocy && result.grocy.results) {
        var errDiv = document.createElement('div');
        errDiv.className = 'vm-success-discrepancies';
        errDiv.style.background = '#ffebee';
        errDiv.innerHTML = '<strong>Grocy-fejl:</strong>';
        var errs = result.grocy.results.filter(function(r) { return !r.success; });
        for (var e = 0; e < errs.length; e++) {
            var ep = document.createElement('div');
            ep.style.cssText = 'margin-top:4px;color:#c62828;';
            ep.textContent = '• Produkt #' + errs[e].product_id + ': ' + (errs[e].error || 'Ukendt fejl');
            errDiv.appendChild(ep);
        }
        success.appendChild(errDiv);
    }

    var backBtn = document.createElement('button');
    backBtn.className = 'vm-success-back';
    backBtn.textContent = 'Tilbage til indkøbsliste';
    backBtn.addEventListener('click', async function() {
        _vmCurrentOrder = null;
        _vmLines = [];
        await _vmLoadOrders();
        _vmRenderOrderList();
    });
    success.appendChild(backBtn);

    root.appendChild(success);
    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(root);
}

/* ── Utilities ───────────────────────────────────────────── */

function _vmEsc(str) {
    if (!str) return '';
    var el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}
