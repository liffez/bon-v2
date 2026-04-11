/**
 * shared/varemodtagelse.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelse v3 — fødevarekontrol + lager-opdatering.
 *
 * Entry: initVaremodtagelse(containerEl)
 * Prefix: _vm
 *
 * Baseret på mockup varemodtagelse_v4.html og spec CLAUDE_VAREMODTAGELSE_v3.md
 * ════════════════════════════════════════════════════════════
 */

/* ── State ───────────────────────────────────────────────── */

var _vmContainer = null;
var _vmState = {
    userId: null,
    userName: '',
    supplierName: '',
    supplierKey: '',
    locationId: null,

    koelEnabled: true,
    koelValue: 3,
    koelOk: true,

    frysEnabled: true,
    frysValue: -20,
    frysOk: true,

    dateCheck: true,
    labelCheck: true,
    packCheck: true,

    hasDeviation: false,
    deviationType: null,
    deviationNote: '',

    photoPath: null,
    notes: '',

    items: [],
    allApproved: false,
    itemListOpen: false,
    busy: false,
};

var _vmUsers = [];
var _vmSuppliers = [];       // { key, label, count, supplierName }
var _vmShoppingList = [];    // raw Grocy shopping list
var _vmProductNames = {};    // grocy product_id → name
var _vmProductStockQu = {};  // grocy product_id → qu_id_stock
var _vmQuNames = {};         // grocy qu_id → name
var _vmDom = {};             // cached DOM refs

/* ── Entry point ─────────────────────────────────────────── */

async function initVaremodtagelse(el) {
    _vmContainer = el;
    _vmContainer.innerHTML = '<div class="vm-app"><div class="vm-loading">Henter data...</div></div>';

    // Reset state
    _vmState = {
        userId: null, userName: '', supplierName: '', supplierKey: '', locationId: null,
        koelEnabled: true, koelValue: 3, koelOk: true,
        frysEnabled: true, frysValue: -20, frysOk: true,
        dateCheck: true, labelCheck: true, packCheck: true,
        hasDeviation: false, deviationType: null, deviationNote: '',
        photoPath: null, notes: '',
        items: [], allApproved: false, itemListOpen: false, busy: false,
    };
    _vmDom = {};

    try {
        // Hent current user, users, suppliers, shopping list i parallel
        var currentUser = await checkAuth('/shared/login.html');
        if (!currentUser) return;

        var results = await Promise.all([
            fetchStaff(),
            fetchPurchasingSuppliers(),
            fetchShoppingList(),
            fetchGrocyProducts(),
            fetchGrocyQuantityUnits(),
        ]);

        _vmUsers = results[0] || [];
        var allSuppliers = results[1] || [];
        _vmShoppingList = results[2] || [];
        var products = results[3] || [];
        var qus = results[4] || [];

        // Build product name + stock unit lookup
        _vmProductNames = {};
        _vmProductStockQu = {};
        for (var p = 0; p < products.length; p++) {
            _vmProductNames[products[p].id] = products[p].name;
            _vmProductStockQu[products[p].id] = products[p].qu_id_stock;
        }

        // Build QU name lookup
        _vmQuNames = {};
        for (var q = 0; q < qus.length; q++) {
            _vmQuNames[qus[q].id] = qus[q].name;
        }

        // Auto-select staff: check localStorage, then match on auth user name
        var savedStaff = localStorage.getItem('vm_staff_id');
        var matched = null;
        if (savedStaff) {
            matched = _vmUsers.find(function(u) { return u.id === parseInt(savedStaff); });
        }
        if (!matched) {
            matched = _vmUsers.find(function(u) { return u.name === currentUser.name; });
        }
        if (!matched && _vmUsers.length > 0) {
            matched = _vmUsers[0];
        }
        if (matched) {
            _vmState.userId = matched.id;
            _vmState.userName = matched.name;
        }

        // Build leverandør-dropdown: match suppliers mod shopping list ordered_supplier
        _vmBuildSupplierOptions(allSuppliers, _vmShoppingList);

        _vmBuildPage();
    } catch (err) {
        console.error('[varemodtagelse] Init fejl:', err);
        _vmContainer.innerHTML = '<div class="vm-app"><div class="vm-loading" style="color:#c0392b;">Fejl: ' + _vmEsc(err.message) + '</div></div>';
    }
}

/* ── Build supplier options ──────────────────────────────── */

function _vmBuildSupplierOptions(suppliers, shoppingList) {
    // Find bestilte items: has ordered_at + ordered_varenr
    var ordered = shoppingList.filter(function(sl) {
        var uf = sl.userfields || {};
        return uf.ordered_at && uf.ordered_varenr;
    });

    // Unique ordered_supplier values
    var orderedSuppliers = {};
    for (var i = 0; i < ordered.length; i++) {
        var sup = (ordered[i].userfields || {}).ordered_supplier || '';
        if (!sup) continue;
        if (!orderedSuppliers[sup]) orderedSuppliers[sup] = 0;
        orderedSuppliers[sup]++;
    }

    // Match against suppliers table
    _vmSuppliers = [];
    var matched = {};

    for (var j = 0; j < suppliers.length; j++) {
        var s = suppliers[j];
        var name = s.supplier_name || '';
        var grocyName = s.grocy_location_display_name || '';

        // Match on supplier_name or grocy_location_display_name
        var matchKey = null;
        if (orderedSuppliers[name] && !matched[name]) {
            matchKey = name;
        } else if (grocyName && orderedSuppliers[grocyName] && !matched[grocyName]) {
            matchKey = grocyName;
        }

        if (matchKey) {
            matched[matchKey] = true;
            _vmSuppliers.push({
                key: matchKey,
                label: matchKey + ' \u2014 ' + orderedSuppliers[matchKey] + ' varer klar',
                count: orderedSuppliers[matchKey],
                supplierName: name,
                grocyName: grocyName,
            });
        }
    }
}

/* ── Build page ──────────────────────────────────────────── */

function _vmBuildPage() {
    var app = document.createElement('div');
    app.className = 'vm-app';

    var content = document.createElement('div');
    content.className = 'vm-content';

    // ── FØDEVAREKONTROL divider
    content.appendChild(_vmDivider('F\u00f8devarekontrol'));

    // ── Bruger
    content.appendChild(_vmBuildUserCard());

    // ── Leverandør
    content.appendChild(_vmBuildSupplierCard());

    // ── Temperaturer
    content.appendChild(_vmBuildTempCard());

    // ── FVST toggles
    _vmDom.toggleDate = _vmBuildToggleRow('Dato/holdbarhed kontrolleret', _vmState.dateCheck, function(v) { _vmState.dateCheck = v; _vmCheckDeviation(); _vmUpdateBtn(); });
    _vmDom.toggleLabel = _vmBuildToggleRow('M\u00e6rkning kontrolleret', _vmState.labelCheck, function(v) { _vmState.labelCheck = v; _vmCheckDeviation(); _vmUpdateBtn(); });
    _vmDom.togglePack = _vmBuildToggleRow('Emballage kontrolleret', _vmState.packCheck, function(v) { _vmState.packCheck = v; _vmCheckDeviation(); _vmUpdateBtn(); });
    content.appendChild(_vmDom.toggleDate);
    content.appendChild(_vmDom.toggleLabel);
    content.appendChild(_vmDom.togglePack);

    // ── Foto
    content.appendChild(_vmBuildPhotoBtn());

    // ── Afvigelse
    content.appendChild(_vmBuildDeviationBox());

    // ── Bemærkning
    content.appendChild(_vmBuildRemarkSection());

    // ── LAGER divider
    content.appendChild(_vmDivider('Lager'));

    // ── No-supplier placeholder
    _vmDom.noSupplierMsg = document.createElement('div');
    _vmDom.noSupplierMsg.className = 'vm-no-supplier-msg';
    _vmDom.noSupplierMsg.textContent = 'V\u00e6lg leverand\u00f8r ovenfor for at se bestilte varer';
    content.appendChild(_vmDom.noSupplierMsg);

    // ── Lager content (hidden)
    _vmDom.lagerContent = document.createElement('div');
    _vmDom.lagerContent.style.display = 'none';
    _vmDom.lagerContent.style.cssText = 'display:none;flex-direction:column;gap:8px;';
    content.appendChild(_vmDom.lagerContent);

    app.appendChild(content);

    // ── Bottom bar
    app.appendChild(_vmBuildBottomBar());

    // ── Success overlay
    _vmDom.successOverlay = _vmBuildSuccessOverlay();
    app.appendChild(_vmDom.successOverlay);

    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(app);

    // Init temp badges
    _vmUpdateTempBadge('koel');
    _vmUpdateTempBadge('frys');
    _vmUpdateBtn();
}

/* ── Section divider ─────────────────────────────────────── */

function _vmDivider(text) {
    var d = document.createElement('div');
    d.className = 'vm-section-divider';
    d.innerHTML = '<div class="vm-section-divider-line"></div>' +
        '<div class="vm-section-divider-text">' + _vmEsc(text) + '</div>' +
        '<div class="vm-section-divider-line"></div>';
    return d;
}

/* ── User card ───────────────────────────────────────────── */

function _vmBuildUserCard() {
    var card = document.createElement('div');
    card.className = 'vm-card';

    var row = document.createElement('div');
    row.className = 'vm-user-row';

    row.innerHTML = '<div class="vm-user-avatar">\ud83d\udc64</div>';

    var info = document.createElement('div');
    info.className = 'vm-user-info';
    info.innerHTML = '<div class="vm-user-info-label">Registreret af</div>';

    var sel = document.createElement('select');
    sel.className = 'vm-user-select';

    for (var i = 0; i < _vmUsers.length; i++) {
        var opt = document.createElement('option');
        opt.value = _vmUsers[i].id;
        opt.textContent = _vmUsers[i].name;
        if (_vmUsers[i].id === _vmState.userId) opt.selected = true;
        sel.appendChild(opt);
    }

    sel.addEventListener('change', function() {
        _vmState.userId = parseInt(this.value);
        var found = _vmUsers.find(function(u) { return u.id === _vmState.userId; });
        _vmState.userName = found ? found.name : '';
        localStorage.setItem('vm_staff_id', String(_vmState.userId));
        _vmUpdateBtn();
    });

    info.appendChild(sel);
    row.appendChild(info);
    card.appendChild(row);
    return card;
}

/* ── Supplier card ───────────────────────────────────────── */

function _vmBuildSupplierCard() {
    var card = document.createElement('div');
    card.className = 'vm-card';

    var label = document.createElement('div');
    label.className = 'vm-field-label';
    label.innerHTML = 'Leverand\u00f8r <span class="vm-grocy-tag">\ud83d\udce1 Grocy</span>';
    card.appendChild(label);

    var wrap = document.createElement('div');
    wrap.className = 'vm-select-wrap';

    var sel = document.createElement('select');
    sel.className = 'vm-field-input';

    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = _vmSuppliers.length > 0 ? 'V\u00e6lg leverand\u00f8r...' : 'Ingen bestilte leverancer at modtage';
    sel.appendChild(emptyOpt);

    for (var i = 0; i < _vmSuppliers.length; i++) {
        var opt = document.createElement('option');
        opt.value = _vmSuppliers[i].key;
        opt.textContent = _vmSuppliers[i].label;
        sel.appendChild(opt);
    }

    sel.addEventListener('change', function() { _vmOnSupplierChange(this.value); });
    wrap.appendChild(sel);
    card.appendChild(wrap);
    return card;
}

function _vmOnSupplierChange(key) {
    _vmState.supplierKey = key;
    _vmState.supplierName = key; // ordered_supplier matches key

    if (!key) {
        _vmDom.noSupplierMsg.style.display = 'block';
        _vmDom.lagerContent.style.display = 'none';
        _vmState.items = [];
    } else {
        _vmDom.noSupplierMsg.style.display = 'none';
        _vmDom.lagerContent.style.display = 'flex';

        // Build items from shopping list
        _vmBuildItemsFromShoppingList(key);
        _vmRenderLagerContent();
    }

    _vmUpdateBtn();
}

function _vmBuildItemsFromShoppingList(supplierKey) {
    // Filter shopping list for this supplier
    var matching = _vmShoppingList.filter(function(sl) {
        var uf = sl.userfields || {};
        return uf.ordered_supplier === supplierKey && uf.ordered_varenr;
    });

    // Aggregate by product_id
    var byProduct = {};
    for (var i = 0; i < matching.length; i++) {
        var sl = matching[i];
        var pid = sl.product_id;
        if (!byProduct[pid]) {
            byProduct[pid] = {
                grocy_product_id: pid,
                product_name: _vmProductNames[pid] || sl.product_name || 'Produkt #' + pid,
                expected: 0,
                received: 0,
                unit: _vmQuNames[sl.qu_id] || _vmQuNames[_vmProductStockQu[pid]] || '',
                status: 'ok',
                notes: '',
                slIds: [],
            };
        }
        byProduct[pid].expected += (sl.amount || 0);
        byProduct[pid].slIds.push(sl.id);
    }

    _vmState.items = [];
    var keys = Object.keys(byProduct);
    for (var j = 0; j < keys.length; j++) {
        var item = byProduct[keys[j]];
        item.received = item.expected; // default: alt modtaget
        _vmState.items.push(item);
    }
}

/* ── Temperature card ────────────────────────────────────── */

function _vmBuildTempCard() {
    var card = document.createElement('div');
    card.className = 'vm-card';

    var grid = document.createElement('div');
    grid.className = 'vm-temp-grid';

    // Køl
    grid.appendChild(_vmBuildTempRow('koel', '\uD83E\uDDCA', 'K\u00f8levarer', 'max. 5\u00b0C', 3, 0.1));

    // Separator
    var sep = document.createElement('div');
    sep.className = 'vm-temp-separator';
    grid.appendChild(sep);

    // Frys
    grid.appendChild(_vmBuildTempRow('frys', '\u2744\ufe0f', 'Frysvarer', 'max. -18\u00b0C', -20, 0.5));

    card.appendChild(grid);
    return card;
}

function _vmBuildTempRow(type, emoji, title, hint, defaultVal, step) {
    var row = document.createElement('div');
    row.className = 'vm-temp-row-item';

    // Header
    var header = document.createElement('div');
    header.className = 'vm-temp-row-header';

    var titleEl = document.createElement('div');
    titleEl.className = 'vm-temp-row-title';
    titleEl.innerHTML = '<span class="vm-emoji">' + emoji + '</span> ' + _vmEsc(title) +
        ' <span class="vm-field-hint">' + _vmEsc(hint) + '</span>';
    header.appendChild(titleEl);

    var toggle = document.createElement('label');
    toggle.className = 'vm-mini-toggle';
    toggle.title = 'Sl\u00e5 fra hvis ingen ' + title.toLowerCase();
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', function() { _vmOnTempEnabled(type, this.checked); });
    toggle.appendChild(cb);
    var slider = document.createElement('span');
    slider.className = 'vm-mini-slider';
    toggle.appendChild(slider);
    header.appendChild(toggle);

    row.appendChild(header);

    // Input group
    var group = document.createElement('div');
    group.className = 'vm-temp-input-group';

    var wrap = document.createElement('div');
    wrap.className = 'vm-temp-input-wrap';

    var input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(defaultVal);
    input.inputMode = 'decimal';
    input.addEventListener('input', function() { _vmOnTempChange(type, this.value); });
    _vmDom[type + 'Input'] = input;
    wrap.appendChild(input);

    var unit = document.createElement('span');
    unit.className = 'vm-temp-unit';
    unit.textContent = '\u00b0C';
    wrap.appendChild(unit);

    group.appendChild(wrap);

    var badge = document.createElement('div');
    badge.className = 'vm-temp-badge';
    badge.innerHTML = '<span class="vm-temp-badge-icon">\ud83c\udf21</span><span>\u2014</span>';
    _vmDom[type + 'Badge'] = badge;
    group.appendChild(badge);

    row.appendChild(group);
    return row;
}

function _vmOnTempEnabled(type, enabled) {
    _vmState[type + 'Enabled'] = enabled;
    var input = _vmDom[type + 'Input'];
    var badge = _vmDom[type + 'Badge'];
    input.disabled = !enabled;

    if (!enabled) {
        badge.className = 'vm-temp-badge vm-disabled';
        badge.innerHTML = '<span class="vm-temp-badge-icon">\u2014</span><span>Ingen</span>';
        _vmState[type + 'Ok'] = null;
    } else {
        _vmOnTempChange(type, input.value);
    }
    _vmCheckDeviation();
    _vmUpdateBtn();
}

function _vmOnTempChange(type, val) {
    var num = parseFloat(val);
    var badge = _vmDom[type + 'Badge'];
    var limit = type === 'koel' ? 5 : -18;

    if (isNaN(num)) {
        _vmState[type + 'Ok'] = null;
        _vmState[type + 'Value'] = null;
        badge.className = 'vm-temp-badge';
        badge.innerHTML = '<span class="vm-temp-badge-icon">\ud83c\udf21</span><span>\u2014</span>';
    } else {
        var ok = num <= limit;
        _vmState[type + 'Ok'] = ok;
        _vmState[type + 'Value'] = num;
        if (ok) {
            badge.className = 'vm-temp-badge vm-ok';
            badge.innerHTML = '<span class="vm-temp-badge-icon">\u2705</span><span>OK</span>';
        } else {
            badge.className = 'vm-temp-badge vm-warn';
            badge.innerHTML = '<span class="vm-temp-badge-icon">\u274c</span><span>FEJL</span>';
        }
    }

    _vmCheckDeviation();
    _vmUpdateBtn();
}

function _vmUpdateTempBadge(type) {
    var input = _vmDom[type + 'Input'];
    if (input) _vmOnTempChange(type, input.value);
}

/* ── FVST toggle row ─────────────────────────────────────── */

function _vmBuildToggleRow(label, defaultOn, onChange) {
    var row = document.createElement('div');
    row.className = 'vm-toggle-row';

    var span = document.createElement('span');
    span.className = 'vm-toggle-label';
    span.textContent = label;
    row.appendChild(span);

    var toggle = document.createElement('label');
    toggle.className = 'vm-toggle';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = defaultOn;
    cb.addEventListener('change', function() {
        var v = this.checked;
        row.classList.toggle('vm-off', !v);
        onChange(v);
    });
    toggle.appendChild(cb);
    var slider = document.createElement('span');
    slider.className = 'vm-toggle-slider';
    toggle.appendChild(slider);
    row.appendChild(toggle);

    return row;
}

/* ── Photo button ────────────────────────────────────────── */

function _vmBuildPhotoBtn() {
    var btn = document.createElement('button');
    btn.className = 'vm-photo-btn';
    btn.type = 'button';

    btn.innerHTML = '<span class="vm-photo-btn-icon">\ud83d\udcf7</span>' +
        '<div><div class="vm-photo-btn-text">Tag foto af f\u00f8lgeseddel</div>' +
        '<div class="vm-photo-btn-sub">Anbefalet \u2014 gemmes p\u00e5 serveren</div></div>';

    _vmDom.photoBtn = btn;

    // Hidden file input
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.capture = 'environment';
    fileInput.style.display = 'none';
    _vmDom.photoInput = fileInput;

    btn.addEventListener('click', function() { fileInput.click(); });

    fileInput.addEventListener('change', async function() {
        if (!this.files || !this.files[0]) return;
        var file = this.files[0];

        btn.querySelector('.vm-photo-btn-text').textContent = 'Uploader...';

        try {
            var fd = new FormData();
            fd.append('photo', file);
            var result = await postGoodsReceiptPhoto(fd);
            _vmState.photoPath = result.path;

            btn.classList.add('vm-taken');
            btn.querySelector('.vm-photo-btn-icon').textContent = '\u2705';
            btn.querySelector('.vm-photo-btn-text').textContent = 'Foto taget';
        } catch (err) {
            btn.querySelector('.vm-photo-btn-text').textContent = 'Fejl: ' + err.message;
            setTimeout(function() {
                btn.querySelector('.vm-photo-btn-text').textContent = 'Tag foto af f\u00f8lgeseddel';
            }, 3000);
        }
    });

    var wrapper = document.createElement('div');
    wrapper.appendChild(btn);
    wrapper.appendChild(fileInput);
    return wrapper;
}

/* ── Deviation box ───────────────────────────────────────── */

function _vmBuildDeviationBox() {
    var box = document.createElement('div');
    box.className = 'vm-deviation-box';
    _vmDom.deviationBox = box;

    box.innerHTML =
        '<div><div class="vm-deviation-title">\u26a0\ufe0f Afvigelse registreret</div>' +
        '<div class="vm-deviation-sub">Udfyldes kun ved afvigelse</div></div>';

    // Options
    var optWrap = document.createElement('div');
    var noteLabel = document.createElement('div');
    noteLabel.className = 'vm-deviation-note-label';
    noteLabel.textContent = 'Hvad skete der?';
    optWrap.appendChild(noteLabel);

    var options = document.createElement('div');
    options.className = 'vm-deviation-options';

    var deviationTypes = [
        { value: 'returned', label: 'Returneret til leverand\u00f8r' },
        { value: 'no_risk', label: 'Ingen reel risiko \u2014 anvendes' },
        { value: 'discarded', label: 'Kasseret' },
        { value: 'supplier_contacted', label: 'Leverand\u00f8r kontaktet' },
        { value: 'other', label: 'Andet' },
    ];

    for (var i = 0; i < deviationTypes.length; i++) {
        var dt = deviationTypes[i];
        var lbl = document.createElement('label');
        lbl.className = 'vm-deviation-option';

        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'vm-deviation';
        radio.value = dt.value;

        radio.addEventListener('change', (function(val, label) {
            return function() {
                _vmState.deviationType = val;
                options.querySelectorAll('.vm-deviation-option').forEach(function(o) { o.classList.remove('vm-selected'); });
                label.classList.add('vm-selected');
                _vmUpdateBtn();
            };
        })(dt.value, lbl));

        lbl.appendChild(radio);
        lbl.appendChild(document.createTextNode(' ' + dt.label));
        options.appendChild(lbl);
    }

    optWrap.appendChild(options);
    box.appendChild(optWrap);

    // Note textarea
    var noteSection = document.createElement('div');
    noteSection.innerHTML = '<div class="vm-deviation-note-label">Bem\u00e6rkning ved afvigelse</div>';
    var textarea = document.createElement('textarea');
    textarea.className = 'vm-deviation-note';
    textarea.placeholder = 'Beskriv afvigelsen og hvad der blev gjort';
    textarea.addEventListener('input', function() { _vmState.deviationNote = this.value; });
    noteSection.appendChild(textarea);
    box.appendChild(noteSection);

    return box;
}

function _vmCheckDeviation() {
    var allChecksOk = _vmState.dateCheck && _vmState.labelCheck && _vmState.packCheck;
    var koelOk = !_vmState.koelEnabled || _vmState.koelOk !== false;
    var frysOk = !_vmState.frysEnabled || _vmState.frysOk !== false;
    _vmState.hasDeviation = !allChecksOk || !koelOk || !frysOk;
    _vmDom.deviationBox.classList.toggle('vm-show', _vmState.hasDeviation);

    // Reset deviation selection if no longer needed
    if (!_vmState.hasDeviation) {
        _vmState.deviationType = null;
        _vmState.deviationNote = '';
    }
}

/* ── Remark section ──────────────────────────────────────── */

function _vmBuildRemarkSection() {
    var div = document.createElement('div');

    var link = document.createElement('button');
    link.className = 'vm-remark-link';
    link.type = 'button';
    link.innerHTML = '<span>\uff0b</span> Tilf\u00f8j bem\u00e6rkning';

    var area = document.createElement('div');
    area.className = 'vm-remark-area';

    var ta = document.createElement('textarea');
    ta.className = 'vm-remark-textarea';
    ta.placeholder = 'Generel bem\u00e6rkning til leverancen...';
    ta.addEventListener('input', function() { _vmState.notes = this.value; });
    area.appendChild(ta);

    link.addEventListener('click', function() {
        var showing = area.classList.toggle('vm-show');
        link.querySelector('span').textContent = showing ? '\u2212' : '\uff0b';
    });

    div.appendChild(link);
    div.appendChild(area);
    return div;
}

/* ── Lager content ───────────────────────────────────────── */

function _vmRenderLagerContent() {
    var el = _vmDom.lagerContent;
    el.innerHTML = '';

    // Header
    var header = document.createElement('div');
    header.className = 'vm-lager-header';
    header.innerHTML = '<div><div class="vm-lager-title">' + _vmEsc(_vmState.supplierName) +
        ' \u2014 ' + _vmState.items.length + ' varer</div>' +
        '<div class="vm-lager-meta">Fra indk\u00f8b</div></div>';
    el.appendChild(header);

    if (_vmState.items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'vm-no-supplier-msg';
        empty.textContent = 'Ingen bestilte varer for denne leverand\u00f8r';
        el.appendChild(empty);
        return;
    }

    // Godkend alt banner
    var banner = document.createElement('div');
    banner.className = 'vm-godkend-alt-banner';
    _vmDom.godkendBanner = banner;

    var top = document.createElement('div');
    top.className = 'vm-godkend-alt-top';
    top.innerHTML = '<div><div class="vm-godkend-alt-text">\u2713 Alt modtaget som bestilt</div>' +
        '<div class="vm-godkend-alt-sub">Alle varer l\u00e6gges p\u00e5 lager med forventet m\u00e6ngde</div></div>';

    var godkendBtn = document.createElement('button');
    godkendBtn.className = 'vm-btn-godkend-alt';
    godkendBtn.textContent = 'Godkend alt';
    godkendBtn.addEventListener('click', _vmGodkendAlt);
    top.appendChild(godkendBtn);
    banner.appendChild(top);

    var detailBtn = document.createElement('button');
    detailBtn.className = 'vm-detail-toggle';
    _vmDom.detailToggleBtn = detailBtn;
    detailBtn.textContent = '\u25b8 Juster enkeltvis hvis noget afviger';
    detailBtn.addEventListener('click', _vmToggleItemList);
    banner.appendChild(detailBtn);

    el.appendChild(banner);

    // Item list (collapsed)
    var list = document.createElement('div');
    list.className = 'vm-item-list';
    _vmDom.itemList = list;

    for (var i = 0; i < _vmState.items.length; i++) {
        list.appendChild(_vmBuildItemCard(i));
    }

    // Add manual item button
    var addBtn = document.createElement('button');
    addBtn.className = 'vm-add-item-btn';
    addBtn.type = 'button';
    addBtn.textContent = '\uff0b Tilf\u00f8j vare manuelt';
    addBtn.addEventListener('click', _vmAddManualItem);
    list.appendChild(addBtn);

    // Summary
    _vmDom.summaryCard = _vmBuildSummaryCard();
    list.appendChild(_vmDom.summaryCard);

    el.appendChild(list);
}

function _vmBuildItemCard(index) {
    var item = _vmState.items[index];
    var card = document.createElement('div');
    card.className = 'vm-item-card vm-s-' + item.status;
    card.dataset.index = index;

    card.innerHTML = '<div class="vm-item-name">' + _vmEsc(item.product_name) + '</div>' +
        '<div class="vm-item-expected">Forventet: ' + item.expected + ' ' + _vmEsc(item.unit) + '</div>';

    // Qty row
    var qtyRow = document.createElement('div');
    qtyRow.className = 'vm-qty-row';

    qtyRow.innerHTML = '<span class="vm-qty-label">Modtaget</span>';

    var ctrl = document.createElement('div');
    ctrl.className = 'vm-qty-ctrl';

    var minusBtn = document.createElement('button');
    minusBtn.className = 'vm-qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.type = 'button';

    var input = document.createElement('input');
    input.className = 'vm-qty-input';
    input.type = 'number';
    input.value = item.received;
    input.min = '0';
    input.step = 'any';

    var plusBtn = document.createElement('button');
    plusBtn.className = 'vm-qty-btn';
    plusBtn.textContent = '+';
    plusBtn.type = 'button';

    var stepSize = item.unit === 'kg' ? 0.5 : 1;

    minusBtn.addEventListener('click', (function(idx, inp, s) {
        return function() {
            var v = Math.max(0, Math.round((parseFloat(inp.value) || 0) - s) * 10 / 10);
            inp.value = v;
            _vmState.items[idx].received = v;
            _vmUpdateSummary();
        };
    })(index, input, stepSize));

    plusBtn.addEventListener('click', (function(idx, inp, s) {
        return function() {
            var v = Math.round(((parseFloat(inp.value) || 0) + s) * 10) / 10;
            inp.value = v;
            _vmState.items[idx].received = v;
            _vmUpdateSummary();
        };
    })(index, input, stepSize));

    input.addEventListener('change', (function(idx) {
        return function() {
            _vmState.items[idx].received = parseFloat(this.value) || 0;
            _vmUpdateSummary();
        };
    })(index));

    ctrl.appendChild(minusBtn);
    ctrl.appendChild(input);
    ctrl.appendChild(plusBtn);
    qtyRow.appendChild(ctrl);

    qtyRow.innerHTML += '<span class="vm-qty-unit">' + _vmEsc(item.unit) + '</span>';
    // Replace last span with proper one since innerHTML clobbered it
    var unitSpan = document.createElement('span');
    unitSpan.className = 'vm-qty-unit';
    unitSpan.textContent = item.unit;

    // Rebuild properly
    qtyRow.innerHTML = '';
    var ql = document.createElement('span');
    ql.className = 'vm-qty-label';
    ql.textContent = 'Modtaget';
    qtyRow.appendChild(ql);
    qtyRow.appendChild(ctrl);
    qtyRow.appendChild(unitSpan);

    card.appendChild(qtyRow);

    // Status buttons
    var statusBtns = document.createElement('div');
    statusBtns.className = 'vm-status-btns';

    var statuses = [
        { key: 'ok', icon: '\u2713', label: 'OK' },
        { key: 'missing', icon: '\u2212', label: 'Mangler' },
        { key: 'wrong', icon: '\u2194', label: 'Forkert' },
        { key: 'damaged', icon: '\u2715', label: 'Skadet' },
    ];

    for (var s = 0; s < statuses.length; s++) {
        var st = statuses[s];
        var btn = document.createElement('button');
        btn.className = 'vm-status-btn' + (item.status === st.key ? ' vm-sel-' + st.key : '');
        btn.type = 'button';
        btn.innerHTML = '<span class="vm-status-btn-icon">' + st.icon + '</span>' + st.label;

        btn.addEventListener('click', (function(idx, key, cardEl, btnsEl) {
            return function() {
                _vmState.items[idx].status = key;
                cardEl.className = 'vm-item-card vm-s-' + key;
                btnsEl.querySelectorAll('.vm-status-btn').forEach(function(b) {
                    b.className = 'vm-status-btn';
                });
                this.classList.add('vm-sel-' + key);

                // Show/hide note
                var noteArea = cardEl.querySelector('.vm-item-note-area');
                if (noteArea) noteArea.classList.toggle('vm-show', key !== 'ok');

                // Set received to 0 if missing
                if (key === 'missing') {
                    _vmState.items[idx].received = 0;
                    var inp = cardEl.querySelector('.vm-qty-input');
                    if (inp) inp.value = '0';
                }

                _vmUpdateSummary();
            };
        })(index, st.key, card, statusBtns));

        statusBtns.appendChild(btn);
    }

    card.appendChild(statusBtns);

    // Note area (hidden by default)
    var noteArea = document.createElement('div');
    noteArea.className = 'vm-item-note-area' + (item.status !== 'ok' ? ' vm-show' : '');
    noteArea.innerHTML = '<div class="vm-item-note-label">Beskriv problemet</div>';
    var noteTA = document.createElement('textarea');
    noteTA.placeholder = 'Hvad var problemet?';
    noteTA.addEventListener('input', (function(idx) {
        return function() { _vmState.items[idx].notes = this.value; };
    })(index));
    noteArea.appendChild(noteTA);
    card.appendChild(noteArea);

    return card;
}

function _vmBuildSummaryCard() {
    var card = document.createElement('div');
    card.className = 'vm-summary-card';
    card.innerHTML = '<div class="vm-summary-title">Opsummering</div><div class="vm-summary-lines"></div>';
    return card;
}

function _vmUpdateSummary() {
    if (!_vmDom.summaryCard) return;
    var lines = _vmDom.summaryCard.querySelector('.vm-summary-lines');
    if (!lines) return;

    var counts = { ok: 0, missing: 0, wrong: 0, damaged: 0 };
    for (var i = 0; i < _vmState.items.length; i++) {
        var s = _vmState.items[i].status;
        if (counts[s] !== undefined) counts[s]++;
    }

    var html = '';
    if (counts.ok) html += '<div class="vm-summary-line vm-ok">\u2713 ' + counts.ok + ' varer OK \u2192 lager</div>';
    if (counts.missing) html += '<div class="vm-summary-line vm-warn-line">\u26a0 ' + counts.missing + ' mangler</div>';
    if (counts.wrong) html += '<div class="vm-summary-line vm-warn-line">\u2194 ' + counts.wrong + ' forkert</div>';
    if (counts.damaged) html += '<div class="vm-summary-line vm-err-line">\u2715 ' + counts.damaged + ' skadet</div>';

    lines.innerHTML = html;
}

/* ── Godkend alt ─────────────────────────────────────────── */

function _vmGodkendAlt() {
    _vmState.allApproved = true;
    for (var i = 0; i < _vmState.items.length; i++) {
        _vmState.items[i].status = 'ok';
        _vmState.items[i].received = _vmState.items[i].expected;
    }

    // Update banner
    if (_vmDom.godkendBanner) {
        var textEl = _vmDom.godkendBanner.querySelector('.vm-godkend-alt-text');
        if (textEl) textEl.textContent = '\u2713 Alle varer godkendt';
    }

    // Re-render item cards if list is open
    if (_vmDom.itemList && _vmState.itemListOpen) {
        _vmRenderLagerContent();
        _vmDom.itemList.classList.add('vm-open');
        _vmState.itemListOpen = true;
    }

    _vmUpdateSummary();
    _vmUpdateBtn();
}

function _vmToggleItemList() {
    _vmState.itemListOpen = !_vmState.itemListOpen;
    if (_vmDom.itemList) _vmDom.itemList.classList.toggle('vm-open', _vmState.itemListOpen);
    if (_vmDom.detailToggleBtn) {
        _vmDom.detailToggleBtn.textContent = _vmState.itemListOpen
            ? '\u25be Skjul vareliste'
            : '\u25b8 Juster enkeltvis hvis noget afviger';
    }
    _vmUpdateSummary();
}

/* ── Add manual item ─────────────────────────────────────── */

function _vmAddManualItem() {
    var name = prompt('Varenavn:');
    if (!name) return;
    var qty = parseFloat(prompt('Antal:') || '1') || 1;
    var unit = prompt('Enhed (fx kg, stk):') || '';

    _vmState.items.push({
        grocy_product_id: null,
        product_name: name,
        expected: qty,
        received: qty,
        unit: unit,
        status: 'ok',
        notes: '',
        slIds: [],
    });

    _vmRenderLagerContent();
    _vmDom.itemList.classList.add('vm-open');
    _vmState.itemListOpen = true;
    if (_vmDom.detailToggleBtn) _vmDom.detailToggleBtn.textContent = '\u25be Skjul vareliste';
    _vmUpdateSummary();
}

/* ── Bottom bar ──────────────────────────────────────────── */

function _vmBuildBottomBar() {
    var bar = document.createElement('div');
    bar.className = 'vm-bottom-bar';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'vm-btn vm-btn-secondary';
    cancelBtn.textContent = 'Annuller';
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', function() {
        if (confirm('Afbryd varemodtagelse?')) {
            initVaremodtagelse(_vmContainer);
        }
    });
    bar.appendChild(cancelBtn);

    var submitBtn = document.createElement('button');
    submitBtn.className = 'vm-btn vm-btn-primary';
    submitBtn.textContent = '\u2713 Registr\u00e9r varemodtagelse';
    submitBtn.disabled = true;
    submitBtn.type = 'button';
    submitBtn.addEventListener('click', _vmSubmit);
    _vmDom.submitBtn = submitBtn;
    bar.appendChild(submitBtn);

    return bar;
}

function _vmUpdateBtn() {
    if (!_vmDom.submitBtn) return;

    var koelOk = !_vmState.koelEnabled || (_vmState.koelOk !== null && _vmState.koelOk !== false);
    var frysOk = !_vmState.frysEnabled || (_vmState.frysOk !== null && _vmState.frysOk !== false);
    var tempFilled = (!_vmState.koelEnabled || _vmState.koelValue !== null) &&
                     (!_vmState.frysEnabled || _vmState.frysValue !== null);
    var deviationOk = !_vmState.hasDeviation || _vmState.deviationType;

    var valid = _vmState.userId &&
                _vmState.supplierKey &&
                tempFilled &&
                deviationOk;

    _vmDom.submitBtn.disabled = !valid || _vmState.busy;
}

/* ── Submit ──────────────────────────────────────────────── */

async function _vmSubmit() {
    if (_vmState.busy) return;
    _vmState.busy = true;
    _vmDom.submitBtn.disabled = true;
    _vmDom.submitBtn.textContent = 'Registrerer...';

    try {
        // Build items payload
        var items = _vmState.items.map(function(item) {
            return {
                grocy_product_id: item.grocy_product_id,
                product_name: item.product_name,
                expected_quantity: item.expected,
                received_quantity: item.received,
                unit: item.unit,
                status: item.status,
                notes: item.notes || null,
                shopping_list_id: item.slIds && item.slIds.length > 0 ? item.slIds[0] : null,
            };
        });

        var payload = {
            supplier_name: _vmState.supplierName,
            received_by_user_id: _vmState.userId,
            location_id: _vmState.locationId,

            temperature_cool_enabled: _vmState.koelEnabled,
            temperature_cool_value: _vmState.koelEnabled ? _vmState.koelValue : null,
            temperature_cool_ok: _vmState.koelEnabled ? _vmState.koelOk : null,

            temperature_frozen_enabled: _vmState.frysEnabled,
            temperature_frozen_value: _vmState.frysEnabled ? _vmState.frysValue : null,
            temperature_frozen_ok: _vmState.frysEnabled ? _vmState.frysOk : null,

            date_check_ok: _vmState.dateCheck,
            labeling_check_ok: _vmState.labelCheck,
            packaging_check_ok: _vmState.packCheck,

            has_deviation: _vmState.hasDeviation,
            deviation_type: _vmState.hasDeviation ? _vmState.deviationType : null,
            deviation_note: _vmState.hasDeviation ? _vmState.deviationNote : null,

            photo_path: _vmState.photoPath,
            notes: _vmState.notes || null,
            items: items,
        };

        var result = await postGoodsReceipt(payload);
        _vmShowSuccess(result);
    } catch (err) {
        alert('Fejl ved registrering: ' + err.message);
        _vmState.busy = false;
        _vmDom.submitBtn.disabled = false;
        _vmDom.submitBtn.textContent = '\u2713 Registr\u00e9r varemodtagelse';
    }
}

/* ── Success overlay ─────────────────────────────────────── */

function _vmBuildSuccessOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'vm-success-overlay';

    overlay.innerHTML =
        '<div class="vm-success-icon">\u2705</div>' +
        '<div class="vm-success-title">Varemodtagelse registreret</div>' +
        '<div class="vm-success-sub">Lager opdateret</div>' +
        '<div class="vm-success-details"></div>' +
        '<button class="vm-success-btn" type="button">Ny varemodtagelse</button>';

    overlay.querySelector('.vm-success-btn').addEventListener('click', function() {
        initVaremodtagelse(_vmContainer);
    });

    return overlay;
}

function _vmShowSuccess(result) {
    var overlay = _vmDom.successOverlay;
    if (!overlay) return;

    var details = [];
    var grocyResults = result.grocy_results || [];
    var added = grocyResults.filter(function(r) { return r.grocy_added; }).length;
    var failed = grocyResults.filter(function(r) { return !r.grocy_added && !r.skipped; }).length;

    details.push('\ud83d\udce6 ' + result.receipt_number);
    if (added > 0) details.push('\u2705 ' + added + ' varer lagt p\u00e5 lager');
    if (failed > 0) {
        var failedNames = grocyResults.filter(function(r) { return !r.grocy_added && !r.skipped && r.error; })
            .map(function(r) { return r.product_name; }).join(', ');
        details.push('\u26a0\ufe0f ' + failed + ' fejlede (' + failedNames + ') \u2014 ret manuelt i Grocy');
    }

    var missing = _vmState.items.filter(function(i) { return i.status === 'missing'; });
    if (missing.length > 0) details.push('\u26a0 ' + missing.length + ' varer forbliver p\u00e5 indk\u00f8bslisten');

    if (_vmState.koelEnabled) details.push('\ud83e\uddc8 K\u00f8l: ' + _vmState.koelValue + '\u00b0C');
    if (_vmState.frysEnabled) details.push('\u2744\ufe0f Frys: ' + _vmState.frysValue + '\u00b0C');
    if (_vmState.photoPath) details.push('\ud83d\udcf8 Foto af f\u00f8lgeseddel gemt');
    if (_vmState.hasDeviation) details.push('\u26a0 Afvigelse logget');

    var detailsEl = overlay.querySelector('.vm-success-details');
    detailsEl.innerHTML = details.join('<br>');

    overlay.classList.add('vm-show');
}

/* ── Utilities ───────────────────────────────────────────── */

function _vmEsc(str) {
    if (!str) return '';
    var el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}
