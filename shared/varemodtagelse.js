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
    koelStatus: 'ok',  // 'ok' | 'caution' | 'action' | null

    frysEnabled: false,
    frysValue: -20,
    frysStatus: 'ok',

    dateCheck: true,
    labelCheck: true,
    packCheck: true,

    hasDeviation: false,
    deviationManual: false,
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
var _vmConversions = [];     // grocy quantity_unit_conversions — til forhåndstjek (#358)
var _vmConversionsLoaded = false;  // nåede de frem? Uden dem advarer vi ikke — se _vmUnitIssue
var _vmDom = {};             // cached DOM refs

/* ── Entry point ─────────────────────────────────────────── */

async function initVaremodtagelse(el) {
    _vmContainer = el;
    _vmContainer.innerHTML = '<div class="vm-app"><div class="vm-loading">Henter data...</div></div>';

    // Reset state
    _vmState = {
        userId: null, userName: '', supplierName: '', supplierKey: '', locationId: null,
        koelEnabled: true, koelValue: 3, koelStatus: 'ok',
        frysEnabled: false, frysValue: -20, frysStatus: 'ok',
        dateCheck: true, labelCheck: true, packCheck: true,
        hasDeviation: false, deviationManual: false, deviationType: null, deviationNote: '',
        photoPath: null, notes: '',
        items: [], allApproved: false, itemListOpen: false, busy: false,
        canBackdate: false, receivedAt: '',
    };
    _vmDom = {};

    try {
        // Hent current user, users, suppliers, shopping list i parallel
        var currentUser = await checkAuth('/shared/login.html');
        if (!currentUser) return;

        // Backdatering: admin altid, ellers per-bruger-evnen 'modtag_backdate'
        var perms = currentUser.permissions || {};
        _vmState.canBackdate = currentUser.role === 'admin' || !!perms.modtag_backdate;
        _vmState.receivedAt = _vmTodayLocal();

        var results = await Promise.all([
            fetchStaff(),
            fetchPurchasingSuppliers(),
            fetchShoppingList(),
            fetchGrocyProducts(),
            fetchGrocyQuantityUnits(),
            fetch('/api/smartplan/employees').then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; }),
            // Enhedsomregninger til forhåndstjekket (#358). Fejler kaldet, mister vi
            // kun ADVARSLEN — serveren nægter stadig at gætte. Derfor .catch og ikke
            // en fejl der forhindrer en modtagelse i at blive registreret.
            fetchGrocyQuantityUnitConversions().catch(function() { return null; }),
        ]);

        var localStaff = results[0] || [];
        var allSuppliers = results[1] || [];
        _vmShoppingList = results[2] || [];
        var products = results[3] || [];
        var qus = results[4] || [];
        var spRaw = results[5];
        var spEmployees = Array.isArray(spRaw) ? spRaw : (spRaw && spRaw.employees ? spRaw.employees : []);
        // null = kaldet fejlede. Tom liste ville ellers se ud som "ingen
        // omregninger findes" og udløse en advarsel på HVER vare med afvigende
        // enhed — 22 falske alarmer ved et Grocy-hik.
        _vmConversionsLoaded = Array.isArray(results[6]);
        _vmConversions = _vmConversionsLoaded ? results[6] : [];

        // Merge: lokale staff + Smartplan (filtrér duplikater på navn)
        var localNames = {};
        _vmUsers = [];
        for (var li = 0; li < localStaff.length; li++) {
            _vmUsers.push({ name: localStaff[li].name, isOwner: !!localStaff[li].is_owner });
            localNames[localStaff[li].name] = true;
        }
        for (var si = 0; si < spEmployees.length; si++) {
            var spName = spEmployees[si].first_name || spEmployees[si].name;
            if (spName && !localNames[spName]) {
                _vmUsers.push({ name: spName, isOwner: false });
            }
        }

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

        // Auto-select: localStorage → auth user name → første
        var savedName = localStorage.getItem('vm_staff_name');
        var matched = null;
        if (savedName) {
            matched = _vmUsers.find(function(u) { return u.name === savedName; });
        }
        if (!matched) {
            matched = _vmUsers.find(function(u) { return u.name === currentUser.name; });
        }
        if (!matched && _vmUsers.length > 0) {
            matched = _vmUsers[0];
        }
        if (matched) {
            _vmState.userName = matched.name;
        }

        // Build leverandør-dropdown: match suppliers mod shopping list ordered_supplier
        _vmBuildSupplierOptions(allSuppliers, _vmShoppingList);

        _vmBuildPage();
    } catch (err) {
        console.error('[varemodtagelse] Init fejl:', err);

        // Loggen skal kunne åbnes selvom NY modtagelse ikke kan startes.
        // Registreringen kræver Grocy (varer, enheder, leverandører) — men
        // fødevarekontrol-dokumentationen ligger i Bon v2's egen database og
        // er uafhængig af Grocy. Er Grocy nede, må FVST-loggen ikke ryge med.
        var app = document.createElement('div');
        app.className = 'vm-app';
        var content = document.createElement('div');
        content.className = 'vm-content';
        content.appendChild(_vmBuildTopBar());

        var msg = document.createElement('div');
        msg.className = 'vm-loading';
        msg.style.color = '#c0392b';
        msg.textContent = 'Kan ikke starte ny varemodtagelse: ' + err.message;
        content.appendChild(msg);

        var hint = document.createElement('div');
        hint.className = 'vm-hist-empty';
        hint.textContent = 'Tidligere modtagelser kan stadig ses under 🗂 Modtagelseslog.';
        content.appendChild(hint);

        app.appendChild(content);
        _vmContainer.innerHTML = '';
        _vmContainer.appendChild(app);
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

    // Vis ALLE leverandører — med "N varer klar" når der er noget bestilt,
    // ellers bare navnet. På den måde kan man også modtage ad-hoc leverancer.
    _vmSuppliers = [];
    var seen = {};
    var withItems = [];
    var withoutItems = [];

    for (var j = 0; j < suppliers.length; j++) {
        var s = suppliers[j];
        var name = s.supplier_name || '';
        var grocyName = s.grocy_location_display_name || '';
        if (!name || seen[name]) continue;
        seen[name] = true;

        var count = orderedSuppliers[name] || (grocyName && orderedSuppliers[grocyName]) || 0;
        var matchKey = count && orderedSuppliers[grocyName] && !orderedSuppliers[name] ? grocyName : name;

        var entry = {
            key: matchKey,
            label: count > 0 ? (matchKey + ' \u2014 ' + count + ' varer klar') : matchKey,
            count: count,
            supplierName: name,
            grocyName: grocyName,
        };
        if (count > 0) withItems.push(entry);
        else withoutItems.push(entry);
    }

    // Leverandører med bestilte varer først, derefter alfabetisk for resten
    withoutItems.sort(function(a, b) { return a.label.localeCompare(b.label, 'da'); });
    _vmSuppliers = withItems.concat(withoutItems);
}

/* ── Build page ──────────────────────────────────────────── */

function _vmBuildPage() {
    var app = document.createElement('div');
    app.className = 'vm-app';

    var content = document.createElement('div');
    content.className = 'vm-content';

    // ── Topbar: adgang til modtagelsesloggen
    content.appendChild(_vmBuildTopBar());

    // ── FØDEVAREKONTROL divider
    content.appendChild(_vmDivider('F\u00f8devarekontrol'));

    // ── Bruger
    content.appendChild(_vmBuildUserCard());

    // ── Modtagedato (kun brugere med backdate-evnen — til at registrere bilag
    //    med korrekt dato hvis de logges for sent. Alle andre registrerer i dag.)
    if (_vmState.canBackdate) {
        content.appendChild(_vmBuildDateCard());
    }

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

    // ── Manuel åbning af afvigelse (når intet trigger automatisk)
    content.appendChild(_vmBuildManualDeviationBtn());

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
        opt.value = _vmUsers[i].name;
        opt.textContent = _vmUsers[i].name + (_vmUsers[i].isOwner ? ' (ejer)' : '');
        if (_vmUsers[i].name === _vmState.userName) opt.selected = true;
        sel.appendChild(opt);
    }

    sel.addEventListener('change', function() {
        _vmState.userName = this.value;
        localStorage.setItem('vm_staff_name', _vmState.userName);
        _vmUpdateBtn();
    });

    info.appendChild(sel);
    row.appendChild(info);
    card.appendChild(row);
    return card;
}

/* ── Date card (modtagedato) ─────────────────────────────── */

function _vmTodayLocal() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
}

function _vmBuildDateCard() {
    var card = document.createElement('div');
    card.className = 'vm-card';

    var label = document.createElement('div');
    label.className = 'vm-field-label';
    label.textContent = 'Modtagedato';
    card.appendChild(label);

    var input = document.createElement('input');
    input.type = 'date';
    input.className = 'vm-date-input';
    input.value = _vmState.receivedAt;
    input.max = _vmTodayLocal(); // ingen fremtidige datoer
    input.style.cssText = 'width:100%;padding:10px 12px;font-size:16px;' +
        'border:1px solid var(--color-border,#d7d1ca);border-radius:8px;background:#fff;';
    input.addEventListener('change', function() {
        _vmState.receivedAt = this.value || _vmTodayLocal();
    });
    card.appendChild(input);

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
    _vmDom.supplierSelect = sel;

    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'V\u00e6lg leverand\u00f8r...';
    sel.appendChild(emptyOpt);

    for (var i = 0; i < _vmSuppliers.length; i++) {
        var opt = document.createElement('option');
        opt.value = _vmSuppliers[i].key;
        opt.textContent = _vmSuppliers[i].label;
        sel.appendChild(opt);
    }

    // "Andet..." — skriv leverand\u00f8rnavn selv
    var otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = '\u2795 Andet \u2014 skriv selv...';
    sel.appendChild(otherOpt);

    sel.addEventListener('change', function() { _vmOnSupplierChange(this.value); });
    wrap.appendChild(sel);
    card.appendChild(wrap);

    // Fri-tekst input (skjult indtil "Andet" vælges)
    var other = document.createElement('input');
    other.type = 'text';
    other.className = 'vm-field-input';
    other.placeholder = 'Leverand\u00f8rnavn (fx \"Bager p\u00e5 hj\u00f8rnet\")';
    other.style.cssText = 'margin-top:8px;display:none;';
    other.addEventListener('input', function() {
        _vmState.supplierKey = '__other__';
        _vmState.supplierName = this.value.trim();
        // Opdat\u00e9r lager-header med nyt navn
        if (_vmDom.lagerContent && _vmDom.lagerContent.style.display !== 'none') {
            _vmRenderLagerContent();
        }
        _vmUpdateBtn();
    });
    _vmDom.supplierOtherInput = other;
    card.appendChild(other);

    return card;
}

function _vmOnSupplierChange(key) {
    var isOther = key === '__other__';
    _vmState.supplierKey = key;
    _vmState.supplierName = isOther ? (_vmDom.supplierOtherInput ? _vmDom.supplierOtherInput.value.trim() : '') : key;

    if (_vmDom.supplierOtherInput) {
        _vmDom.supplierOtherInput.style.display = isOther ? 'block' : 'none';
        if (isOther) setTimeout(function() { _vmDom.supplierOtherInput.focus(); }, 50);
    }

    if (!key) {
        _vmDom.noSupplierMsg.style.display = 'block';
        _vmDom.lagerContent.style.display = 'none';
        _vmState.items = [];
    } else {
        _vmDom.noSupplierMsg.style.display = 'none';
        _vmDom.lagerContent.style.display = 'flex';

        // Byg items fra shopping list (tom for "Andet")
        if (isOther) {
            _vmState.items = [];
        } else {
            _vmBuildItemsFromShoppingList(key);
        }
        _vmRenderLagerContent();
    }

    _vmUpdateBtn();
}

/* ── Enheds-forhåndstjek (#358) ──────────────────────────────
 *
 * Tallet på skærmen står i INDKØBS-enhed ("4 Kasse"); Grocy fører lageret i
 * lager-enhed (kilo eller stk). Findes omregningen ikke, nægter serveren at
 * gætte — men det opdagede man først EFTER at have trykket Godkend, stående
 * med varerne i hånden, og løsningen lå et andet sted i et andet system.
 *
 * Derfor tjekkes det her, mens varelisten bygges: før der er tastet noget,
 * og hvor den der kender svaret står. Serverens nægtelse bliver stående som
 * sikkerhedsnet — en cachet browser eller et direkte API-kald går uden om det
 * her tjek. */

/**
 * Spejler findConversionFactor i services/quConvert.js — samme rækkefølge,
 * samme sammenligning. Divergerer de to, ville skærmen sige god for noget
 * serveren bagefter nægter, og vi var tilbage ved fejlen vi retter.
 */
function _vmFindFactor(productId, fromQuId, toQuId) {
    if (fromQuId === toQuId) return 1;
    var c = _vmConversions;

    for (var i = 0; i < c.length; i++) {
        if (c[i].product_id === productId && c[i].from_qu_id === fromQuId && c[i].to_qu_id === toQuId) {
            return parseFloat(c[i].factor) || 1;
        }
    }
    for (var j = 0; j < c.length; j++) {
        if (c[j].product_id === productId && c[j].from_qu_id === toQuId && c[j].to_qu_id === fromQuId) {
            return 1 / (parseFloat(c[j].factor) || 1);
        }
    }
    for (var k = 0; k < c.length; k++) {
        if (!c[k].product_id && c[k].from_qu_id === fromQuId && c[k].to_qu_id === toQuId) {
            return parseFloat(c[k].factor) || 1;
        }
    }
    for (var m = 0; m < c.length; m++) {
        if (!c[m].product_id && c[m].from_qu_id === toQuId && c[m].to_qu_id === fromQuId) {
            return 1 / (parseFloat(c[m].factor) || 1);
        }
    }
    return null;
}

/**
 * Mangler varen en omregning til sin lager-enhed?
 * @returns {null|{from:number, to:number, fromName:string, toName:string}}
 */
function _vmUnitIssue(item) {
    if (!_vmConversionsLoaded) return null;             // kunne ikke tjekke — så påstår vi intet
    if (!item || !item.grocy_product_id) return null;   // manuel vare — rører aldrig lageret
    var pid  = parseInt(item.grocy_product_id);
    var from = item.qu_id != null && item.qu_id !== '' ? parseInt(item.qu_id) : null;
    var to   = _vmProductStockQu[item.grocy_product_id] != null
        ? parseInt(_vmProductStockQu[item.grocy_product_id]) : null;

    if (!to) return null;            // ingen lager-enhed i Grocy — serveren melder den
    if (from === null) return null;  // ingen enhed oplyst — serveren afgør (og accepterer kun når den ikke KAN være tvetydig)
    if (from === to) return null;    // samme enhed, intet at omregne
    if (_vmFindFactor(pid, from, to) !== null) return null;

    return {
        from: from,
        to: to,
        fromName: _vmQuNames[from] || ('enhed ' + from),
        toName: _vmQuNames[to] || ('enhed ' + to),
    };
}

function _vmUnitIssueItems() {
    return _vmState.items.filter(function(it) { return _vmUnitIssue(it) !== null; });
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
                // Enhedens NAVN til visning — og dens ID til serverens omregning (#358).
                // Tallet fra indkøbslisten står i INDKØBS-enhed; uden qu_id kan
                // serveren ikke vide det, og Grocy læser tallet som lager-enhed.
                // Det gjorde "10 Antal spidskål" til 10 kg i drift.
                unit: _vmQuNames[sl.qu_id] || _vmQuNames[_vmProductStockQu[pid]] || '',
                qu_id: sl.qu_id != null ? sl.qu_id : (_vmProductStockQu[pid] || null),
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
    grid.appendChild(_vmBuildTempRow('koel', '\uD83E\uDDCA', 'K\u00f8levarer', 'max. 5\u00b0C', 4.5, 0.1, true, 4.7, 5));

    // Separator
    var sep = document.createElement('div');
    sep.className = 'vm-temp-separator';
    grid.appendChild(sep);

    // Frys
    grid.appendChild(_vmBuildTempRow('frys', '\u2744\ufe0f', 'Frysvarer', 'max. -18\u00b0C', -20, 0.5, false, -19, -18));

    card.appendChild(grid);
    return card;
}

function _vmBuildTempRow(type, emoji, title, hint, defaultVal, step, startEnabled, warnLimit, actionLimit) {
    var row = document.createElement('div');
    row.className = 'vm-temp-row-item';
    // Persistér grænseværdier på state så _vmOnTempChange kan læse dem
    _vmState[type + 'WarnLimit'] = warnLimit;
    _vmState[type + 'ActionLimit'] = actionLimit;
    _vmState[type + 'Enabled'] = !!startEnabled;

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
    cb.checked = !!startEnabled;
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
        _vmState[type + 'Status'] = null;
    } else {
        _vmOnTempChange(type, input.value);
    }
    _vmCheckDeviation();
    _vmUpdateBtn();
}

// 3-niveau status: 'ok' (gr\u00f8n) | 'caution' (gul, t\u00e6t p\u00e5 gr\u00e6nse) | 'action' (r\u00f8d, FVST-afvigelse)
// Spejler whiteboard's getNumberInputStatus + updateTempFeedback. Begge k\u00f8l/frys
// m\u00e5ler "max"-gr\u00e6nser, s\u00e5 vi tjekker num > warnLimit / num > actionLimit.
function _vmOnTempChange(type, val) {
    var num = parseFloat(val);
    var badge = _vmDom[type + 'Badge'];
    var warnLimit = _vmState[type + 'WarnLimit'];
    var actionLimit = _vmState[type + 'ActionLimit'];

    if (isNaN(num)) {
        _vmState[type + 'Status'] = null;
        _vmState[type + 'Value'] = null;
        badge.className = 'vm-temp-badge';
        badge.innerHTML = '<span class="vm-temp-badge-icon">\ud83c\udf21</span><span>\u2014</span>';
    } else {
        _vmState[type + 'Value'] = num;
        var status;
        if (actionLimit != null && num > actionLimit) status = 'action';
        else if (warnLimit != null && num > warnLimit) status = 'caution';
        else status = 'ok';
        _vmState[type + 'Status'] = status;

        if (status === 'ok') {
            badge.className = 'vm-temp-badge vm-ok';
            badge.innerHTML = '<span class="vm-temp-badge-icon">\u2705</span><span>OK</span>';
        } else if (status === 'caution') {
            badge.className = 'vm-temp-badge vm-caution';
            badge.innerHTML = '<span class="vm-temp-badge-icon">\u26a0</span><span>OBS</span>';
        } else {
            badge.className = 'vm-temp-badge vm-warn';
            badge.innerHTML = '<span class="vm-temp-badge-icon">\u274c</span><span>AFV.</span>';
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

    // Labels linet op med whiteboard-skemaet (FVST Skema 1) for ensartet
    // brugeroplevelse. V\u00e6rdierne er holdt fast pga. CHECK-constraint i
    // migration 036 (returned/no_risk/discarded/supplier_contacted/other).
    var deviationTypes = [
        { value: 'returned', label: 'Varen er returneret' },
        { value: 'no_risk', label: 'Vurderet \u2014 ingen risiko, anvendes straks' },
        { value: 'discarded', label: 'Varen er kasseret' },
        { value: 'supplier_contacted', label: 'Leverand\u00f8ren er kontaktet' },
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

// Auto-åbner kun ved action-niveau (rød) — caution (gul) er bare "hold øje".
// Brugeren kan altid åbne manuelt via "+ Tilføj bemærkning" (deviationManual).
// Spejler whiteboard's updateDeviationVisibility.
function _vmCheckDeviation() {
    var allChecksOk = _vmState.dateCheck && _vmState.labelCheck && _vmState.packCheck;
    var koelAction = _vmState.koelEnabled && _vmState.koelStatus === 'action';
    var frysAction = _vmState.frysEnabled && _vmState.frysStatus === 'action';
    var autoTrigger = !allChecksOk || koelAction || frysAction;
    _vmState.hasDeviation = autoTrigger || !!_vmState.deviationManual;
    if (_vmDom.deviationBox) {
        _vmDom.deviationBox.classList.toggle('vm-show', _vmState.hasDeviation);
    }

    // Nulstil afvigelses-valg hvis sektionen er helt skjult igen
    if (!_vmState.hasDeviation) {
        _vmState.deviationType = null;
        _vmState.deviationNote = '';
    }
}

/* ── Manual deviation toggle ─────────────────────────────── */

function _vmBuildManualDeviationBtn() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vm-remark-link';
    btn.innerHTML = '<span>＋</span> Registrér afvigelse';
    btn.addEventListener('click', function() {
        _vmState.deviationManual = !_vmState.deviationManual;
        _vmCheckDeviation();
        _vmUpdateBtn();
        if (_vmDom.deviationBox && _vmDom.deviationBox.classList.contains('vm-show')) {
            _vmDom.deviationBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });
    return btn;
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
    var metaText = _vmState.items.length > 0 ? 'Fra indk\u00f8b' : 'Ad-hoc \u2014 tilf\u00f8j varer manuelt';
    var headerName = _vmState.supplierName || 'Ny leverand\u00f8r';
    header.innerHTML = '<div><div class="vm-lager-title">' + _vmEsc(headerName) +
        ' \u2014 ' + _vmState.items.length + ' varer</div>' +
        '<div class="vm-lager-meta">' + metaText + '</div></div>';
    el.appendChild(header);

    if (_vmState.items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'vm-no-supplier-msg';
        empty.style.cssText = 'color:#8a5a00;background:#fff6e0;border:1px solid #f0d48a;' +
            'border-radius:8px;padding:10px 12px;';
        empty.textContent = '\u26a0 Ingen varer l\u00e6gges p\u00e5 lager. Du registrerer kun ' +
            'f\u00f8devarekontrol \u2014 husk s\u00e5 at l\u00e6gge varerne ind via lageropt\u00e6lling.';
        el.appendChild(empty);

        var addBtn0 = document.createElement('button');
        addBtn0.className = 'vm-add-item-btn';
        addBtn0.type = 'button';
        addBtn0.textContent = '\uff0b Tilf\u00f8j vare manuelt';
        addBtn0.addEventListener('click', _vmAddManualItem);
        el.appendChild(addBtn0);

        _vmDom.summaryCard = _vmBuildSummaryCard();
        el.appendChild(_vmDom.summaryCard);
        _vmDom.itemList = el;
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

    // Enheds-advarsel (#358). Ligger UDEN FOR varelisten med vilje: listen er
    // foldet sammen som default, og "Godkend alt" er den normale vej igennem.
    // En advarsel inde i listen ville derfor ikke blive set af dem der bruger
    // skærmen som den er tænkt.
    var issues = _vmUnitIssueItems();
    if (issues.length > 0) el.appendChild(_vmBuildUnitWarnBanner(issues));

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

    // Open "Opret produkt" in new tab \u2014 for varer der ikke findes i Grocy endnu
    var createBtn = document.createElement('button');
    createBtn.className = 'vm-add-item-btn vm-create-product-btn';
    createBtn.type = 'button';
    createBtn.textContent = '\uff0b Opret nyt produkt i Grocy';
    createBtn.addEventListener('click', function() {
        window.open('/kitchen/stock.html?tab=create', '_blank', 'noopener');
    });
    list.appendChild(createBtn);

    // Summary
    _vmDom.summaryCard = _vmBuildSummaryCard();
    list.appendChild(_vmDom.summaryCard);

    el.appendChild(list);
}

/* ── Enheds-advarsel + ret-på-stedet (#358) ──────────────── */

function _vmBuildUnitWarnBanner(issues) {
    var box = document.createElement('div');
    box.className = 'vm-unit-warn-banner';

    var names = issues.map(function(it) {
        var u = _vmUnitIssue(it);
        return _vmEsc(it.product_name) + ' (' + _vmEsc(u.fromName) + ' → ' + _vmEsc(u.toName) + ')';
    }).join(', ');

    box.innerHTML =
        '<div class="vm-unit-warn-title">⚠ ' + issues.length +
        (issues.length === 1 ? ' vare kan ikke lægges på lager' : ' varer kan ikke lægges på lager') + '</div>' +
        '<div class="vm-unit-warn-body">Grocy ved ikke hvor meget der er i én af enhederne: ' + names +
        '. Fødevarekontrollen gemmes uanset — men lageret bliver ikke opdateret for dem.</div>';

    var btn = document.createElement('button');
    btn.className = 'vm-unit-warn-btn';
    btn.type = 'button';
    btn.textContent = 'Ret nu';
    btn.addEventListener('click', function() {
        if (!_vmState.itemListOpen) _vmToggleItemList();
        var first = _vmDom.itemList && _vmDom.itemList.querySelector('.vm-unit-fix');
        if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var inp = first && first.querySelector('.vm-unit-fix-input');
        if (inp) inp.focus();
    });
    box.appendChild(btn);

    return box;
}

/**
 * Feltet der lukker hullet: ét tal, stillet som spørgsmålet det er.
 * Svaret kender den der står med kassen — ikke kontoret, og ikke serveren.
 */
function _vmBuildUnitFix(index, issue) {
    var item = _vmState.items[index];

    var box = document.createElement('div');
    box.className = 'vm-unit-fix';
    box.innerHTML =
        '<div class="vm-unit-fix-title">⚠ Lægges ikke på lager</div>' +
        '<div class="vm-unit-fix-body">Hvor meget er én ' + _vmEsc(issue.fromName) +
        ' i ' + _vmEsc(issue.toName) + '?</div>';

    var row = document.createElement('div');
    row.className = 'vm-unit-fix-row';

    var lead = document.createElement('span');
    lead.className = 'vm-unit-fix-lead';
    lead.textContent = '1 ' + issue.fromName + ' =';

    var input = document.createElement('input');
    input.className = 'vm-unit-fix-input';
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.placeholder = '0';

    var tail = document.createElement('span');
    tail.className = 'vm-unit-fix-tail';
    tail.textContent = issue.toName;

    var saveBtn = document.createElement('button');
    saveBtn.className = 'vm-unit-fix-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Gem';

    var msg = document.createElement('div');
    msg.className = 'vm-unit-fix-msg';

    saveBtn.addEventListener('click', function() {
        var factor = parseFloat(input.value);
        if (!(factor > 0)) {
            msg.className = 'vm-unit-fix-msg vm-err';
            msg.textContent = 'Skriv et tal større end 0.';
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Gemmer…';
        msg.className = 'vm-unit-fix-msg';
        msg.textContent = '';

        postGrocyQuConversion({
            product_id: parseInt(item.grocy_product_id),
            from_qu_id: issue.from,
            to_qu_id: issue.to,
            factor: factor,
        }).then(function(res) {
            // Læg den lokalt ind i samme form som Grocy leverer, så
            // forhåndstjekket er enigt med sig selv uden en ny rundtur.
            _vmConversions.push({
                product_id: parseInt(item.grocy_product_id),
                from_qu_id: issue.from,
                to_qu_id: issue.to,
                factor: factor,
            });

            // packSizeGuard kan advare uden at blokere writet (routes/grocy.js).
            // Den advarsel skal ses — den betyder at tallet strider mod
            // pakkestørrelsen på produktets stregkode.
            if (res && res.pack_size_warning) {
                var w = res.pack_size_warning;
                alert('Gemt — men bemærk: ' + (w.message || JSON.stringify(w)));
            }

            _vmRenderLagerContent();
            if (_vmState.itemListOpen && _vmDom.itemList) _vmDom.itemList.classList.add('vm-open');
            _vmUpdateSummary();
        }).catch(function(err) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Gem';
            msg.className = 'vm-unit-fix-msg vm-err';
            msg.textContent = 'Kunne ikke gemme: ' + (err && err.message ? err.message : 'ukendt fejl');
        });
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });

    row.appendChild(lead);
    row.appendChild(input);
    row.appendChild(tail);
    row.appendChild(saveBtn);
    box.appendChild(row);
    box.appendChild(msg);

    return box;
}

function _vmBuildItemCard(index) {
    var item = _vmState.items[index];
    var card = document.createElement('div');
    card.className = 'vm-item-card vm-s-' + item.status;
    card.dataset.index = index;

    card.innerHTML = '<div class="vm-item-name">' + _vmEsc(item.product_name) + '</div>' +
        '<div class="vm-item-expected">Forventet: ' + item.expected + ' ' + _vmEsc(item.unit) + '</div>';

    // #358: mangler omregningen til lager-enhed, så siges det HER — øverst på
    // kortet, før mængden tastes — med feltet der lukker hullet.
    var unitIssue = _vmUnitIssue(item);
    if (unitIssue) {
        card.classList.add('vm-unit-issue');
        card.appendChild(_vmBuildUnitFix(index, unitIssue));
    }

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
                // Bevar enheds-markeringen: den handler om produktets opsætning
                // i Grocy, ikke om hvordan leverancen så ud (#358).
                cardEl.className = 'vm-item-card vm-s-' + key +
                    (cardEl.querySelector('.vm-unit-fix') ? ' vm-unit-issue' : '');
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

    // #358: "N varer OK \u2192 lager" ville ellers t\u00e6lle varer med der aldrig n\u00e5r frem
    // til lageret, fordi omregningen mangler. Opsummeringen skal ikke love mere
    // end der sker.
    var unitIssues = _vmUnitIssueItems().length;
    if (unitIssues) {
        html += '<div class="vm-summary-line vm-warn-line">\u26a0 ' + unitIssues +
            (unitIssues === 1 ? ' vare mangler enhed' : ' varer mangler enhed') +
            ' \u2014 lager ikke opdateret</div>';
    }

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
        if (!confirm('Afbryd varemodtagelse?')) return;
        // På mobilen: tilbage til bons-viewet i stedet for at reset'e
        if (document.body.classList.contains('zone-mobile') && typeof window._mSwitchView === 'function') {
            window._mSwitchView('bons');
        } else {
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

    // caution (gul) er stadig OK — kun action (rød) kræver deviationType
    var tempFilled = (!_vmState.koelEnabled || _vmState.koelValue !== null) &&
                     (!_vmState.frysEnabled || _vmState.frysValue !== null);
    var deviationOk = !_vmState.hasDeviation || _vmState.deviationType;

    var valid = _vmState.userName &&
                _vmState.supplierKey &&
                tempFilled &&
                deviationOk;

    _vmDom.submitBtn.disabled = !valid || _vmState.busy;
}

/* ── Submit ──────────────────────────────────────────────── */

async function _vmSubmit() {
    if (_vmState.busy) return;

    // Varefri registrering: bekræft at kun fødevarekontrollen gemmes.
    if (_vmState.items.length === 0) {
        if (!confirm('Ingen varer lægges på lager.\n\nKun fødevarekontrollen ' +
            'registreres. Husk at lægge varerne ind via lageroptælling.\n\nFortsæt?')) {
            return;
        }
    }

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
                qu_id: item.qu_id != null ? item.qu_id : null,   // #358 — enheden tallet står i
                status: item.status,
                notes: item.notes || null,
                shopping_list_id: item.slIds && item.slIds.length > 0 ? item.slIds[0] : null,
            };
        });

        var payload = {
            supplier_name: _vmState.supplierName,
            received_by_name: _vmState.userName,
            location_id: _vmState.locationId,

            // _ok udregnes fra status: kun action (rød) er FVST-fejl;
            // caution (gul) er stadig "OK" set fra fødevarekontrol
            temperature_cool_enabled: _vmState.koelEnabled,
            temperature_cool_value: _vmState.koelEnabled ? _vmState.koelValue : null,
            temperature_cool_ok: _vmState.koelEnabled
                ? (_vmState.koelStatus === 'action' ? false : _vmState.koelStatus != null)
                : null,

            temperature_frozen_enabled: _vmState.frysEnabled,
            temperature_frozen_value: _vmState.frysEnabled ? _vmState.frysValue : null,
            temperature_frozen_ok: _vmState.frysEnabled
                ? (_vmState.frysStatus === 'action' ? false : _vmState.frysStatus != null)
                : null,

            date_check_ok: _vmState.dateCheck,
            labeling_check_ok: _vmState.labelCheck,
            packaging_check_ok: _vmState.packCheck,

            has_deviation: _vmState.hasDeviation,
            deviation_type: _vmState.hasDeviation ? _vmState.deviationType : null,
            deviation_note: _vmState.hasDeviation ? _vmState.deviationNote : null,

            photo_path: _vmState.photoPath,
            notes: _vmState.notes || null,
            items: items,

            // Backdatering: send kun modtagedato når brugeren har evnen OG har
            // valgt en dato ≠ i dag. Ellers null → serveren bruger faktisk tidspunkt.
            received_at: (_vmState.canBackdate && _vmState.receivedAt &&
                _vmState.receivedAt !== _vmTodayLocal()) ? _vmState.receivedAt : null,
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

    // Whiteboard-koblingen: sig det ligeud n\u00e5r registreringen kun findes her.
    // Tidligere svarede API'et altid "webhook_sent: true" \u2014 ogs\u00e5 n\u00e5r intet
    // blev sendt \u2014 og s\u00e5 var der ingen der opdagede at FVST-loggen stod tom.
    var wb = result.whiteboard || {};
    if (wb.configured) {
        details.push('\ud83d\udd17 Sendt til Whiteboards FVST-log');
    } else {
        details.push('\u2139\ufe0f Gemt i Bon v2 \u2014 se den under \ud83d\uddc2 Modtagelseslog');
    }

    var detailsEl = overlay.querySelector('.vm-success-details');
    detailsEl.innerHTML = details.join('<br>');

    overlay.classList.add('vm-show');
}

/* ════════════════════════════════════════════════════════════
   MODTAGELSESLOG
   ════════════════════════════════════════════════════════════
   Bon v2's egen liste over varemodtagelser — dokumentationen til
   Fødevarestyrelsen.

   Hvorfor den findes: registreringerne blev gemt korrekt i databasen,
   men INTET sted i Bon v2 viste dem. Whiteboard-koblingen var det
   eneste vindue ind til dem, og da den var slukket, var en registrering
   i praksis usynlig fra det øjeblik succes-skærmen forsvandt.

   Kører i samme container som selve modtagelsen — så den følger med i
   både køkkenets fane og mobilen uden separat montering.
   ════════════════════════════════════════════════════════════ */

var _vmHistDays = 30;
var _vmHistRows = [];

function _vmBuildTopBar() {
    var bar = document.createElement('div');
    bar.className = 'vm-topbar';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vm-log-btn';
    btn.innerHTML = '🗂 Modtagelseslog';
    btn.addEventListener('click', function() { _vmShowHistory(); });
    bar.appendChild(btn);

    return bar;
}

async function _vmShowHistory() {
    var app = document.createElement('div');
    app.className = 'vm-app';

    var content = document.createElement('div');
    content.className = 'vm-content';
    content.innerHTML =
        '<div class="vm-hist-head">' +
          '<button type="button" class="vm-back-btn">← Ny modtagelse</button>' +
          '<div class="vm-hist-title">Modtagelseslog</div>' +
        '</div>' +
        '<div class="vm-hist-filters"></div>' +
        '<div class="vm-hist-list"><div class="vm-loading">Henter...</div></div>';

    app.appendChild(content);
    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(app);

    content.querySelector('.vm-back-btn').addEventListener('click', function() {
        initVaremodtagelse(_vmContainer);
    });

    // Periode-chips. 30 dage dækker den daglige brug; "Alt" bruges når
    // Fødevarestyrelsen beder om en længere periode.
    var filters = content.querySelector('.vm-hist-filters');
    [[30, '30 dage'], [90, '3 måneder'], [365, '1 år'], [0, 'Alt']].forEach(function(opt) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'vm-chip' + (_vmHistDays === opt[0] ? ' vm-chip-active' : '');
        chip.textContent = opt[1];
        chip.addEventListener('click', function() {
            _vmHistDays = opt[0];
            _vmShowHistory();
        });
        filters.appendChild(chip);
    });

    var listEl = content.querySelector('.vm-hist-list');

    try {
        var params = {};
        if (_vmHistDays > 0) {
            var d = new Date();
            d.setDate(d.getDate() - _vmHistDays);
            params.from = _vmIsoDate(d);
        }
        _vmHistRows = await fetchGoodsReceipts(params) || [];
        _vmRenderHistoryList(listEl);
    } catch (err) {
        listEl.innerHTML = '<div class="vm-loading" style="color:#c0392b">Kunne ikke hente loggen: ' +
            _vmEsc(err.message) + '</div>';
    }
}

function _vmRenderHistoryList(listEl) {
    if (!_vmHistRows.length) {
        listEl.innerHTML = '<div class="vm-hist-empty">Ingen varemodtagelser i perioden.</div>';
        return;
    }

    listEl.innerHTML = '';

    _vmHistRows.forEach(function(r) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'vm-hist-card';

        var badges = [];
        if (r.temperature_cool_enabled && r.temperature_cool_value != null) {
            badges.push('<span class="vm-hist-badge' + (r.temperature_cool_ok === 0 ? ' vm-hist-badge-bad' : '') +
                '">🧊 ' + _vmNum(r.temperature_cool_value) + '°</span>');
        }
        if (r.temperature_frozen_enabled && r.temperature_frozen_value != null) {
            badges.push('<span class="vm-hist-badge' + (r.temperature_frozen_ok === 0 ? ' vm-hist-badge-bad' : '') +
                '">❄️ ' + _vmNum(r.temperature_frozen_value) + '°</span>');
        }
        if (r.has_deviation) badges.push('<span class="vm-hist-badge vm-hist-badge-bad">⚠ Afvigelse</span>');
        if (r.photo_path)    badges.push('<span class="vm-hist-badge">📸</span>');
        if (r.item_count)    badges.push('<span class="vm-hist-badge">' + r.item_count + ' varer</span>');
        if (r.status === 'partially_approved') {
            badges.push('<span class="vm-hist-badge vm-hist-badge-warn">Delvist godkendt</span>');
        }

        card.innerHTML =
            '<div class="vm-hist-row1">' +
              '<span class="vm-hist-date">' + _vmEsc(_vmFmtDateTime(r.received_at)) + '</span>' +
              '<span class="vm-hist-nr">' + _vmEsc(r.receipt_number) + '</span>' +
            '</div>' +
            '<div class="vm-hist-row2">' +
              '<strong>' + _vmEsc(r.supplier_name) + '</strong>' +
              (r.received_by_name ? ' <span class="vm-hist-by">· ' + _vmEsc(r.received_by_name) + '</span>' : '') +
            '</div>' +
            (badges.length ? '<div class="vm-hist-badges">' + badges.join('') + '</div>' : '') +
            _vmSyncLine(r);

        card.addEventListener('click', function() { _vmShowReceiptDetail(r.id); });
        listEl.appendChild(card);
    });
}

/* Synkroniserings-linje: er registreringen nået frem til Whiteboards
   FVST-log? Vises kun når den IKKE er — en grøn markering på hver eneste
   række ville bare være støj. */
function _vmSyncLine(r) {
    if (r.whiteboard_synced_at) return '';
    return '<div class="vm-hist-sync">⚠ Ikke i Whiteboards FVST-log</div>';
}

async function _vmShowReceiptDetail(id) {
    var app = document.createElement('div');
    app.className = 'vm-app';
    var content = document.createElement('div');
    content.className = 'vm-content';
    content.innerHTML =
        '<div class="vm-hist-head">' +
          '<button type="button" class="vm-back-btn">← Loggen</button>' +
        '</div>' +
        '<div class="vm-detail"><div class="vm-loading">Henter...</div></div>';
    app.appendChild(content);
    _vmContainer.innerHTML = '';
    _vmContainer.appendChild(app);

    content.querySelector('.vm-back-btn').addEventListener('click', function() { _vmShowHistory(); });

    var box = content.querySelector('.vm-detail');

    var r;
    try {
        r = await fetchGoodsReceipt(id);
    } catch (err) {
        box.innerHTML = '<div class="vm-loading" style="color:#c0392b">Kunne ikke hente: ' + _vmEsc(err.message) + '</div>';
        return;
    }

    var rows = [];
    rows.push(['Modtaget',    _vmFmtDateTime(r.received_at)]);
    rows.push(['Leverandør',  r.supplier_name]);
    rows.push(['Modtaget af', r.received_by_name || '—']);
    rows.push(['Køl',  r.temperature_cool_enabled
        ? _vmNum(r.temperature_cool_value) + ' °C' + (r.temperature_cool_ok === 0 ? '  ⚠ over grænsen' : '')
        : 'Ikke relevant']);
    rows.push(['Frys', r.temperature_frozen_enabled
        ? _vmNum(r.temperature_frozen_value) + ' °C' + (r.temperature_frozen_ok === 0 ? '  ⚠ over grænsen' : '')
        : 'Ikke relevant']);
    rows.push(['Dato/holdbarhed', r.date_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    rows.push(['Mærkning',        r.labeling_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    rows.push(['Emballage',       r.packaging_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    if (r.has_deviation) {
        rows.push(['Afvigelse', _vmDeviationLabel(r.deviation_type)]);
        if (r.deviation_note) rows.push(['Bemærkning', r.deviation_note]);
    }
    if (r.notes) rows.push(['Note', r.notes]);

    var html = '<div class="vm-detail-title">' + _vmEsc(r.receipt_number) + '</div>' +
        '<table class="vm-detail-table">' +
        rows.map(function(row) {
            return '<tr><th>' + _vmEsc(row[0]) + '</th><td>' + _vmEsc(String(row[1])) + '</td></tr>';
        }).join('') +
        '</table>';

    if (r.photo_path) {
        html += '<a class="vm-detail-photo" href="' + _vmEsc(r.photo_path) + '" target="_blank" rel="noopener">' +
            '<img src="' + _vmEsc(r.photo_path) + '" alt="Følgeseddel">' +
            '<span>Åbn foto af følgeseddel</span></a>';
    }

    var items = r.items || [];
    if (items.length) {
        html += '<div class="vm-detail-sub">Varer lagt på lager</div>' +
            '<table class="vm-detail-table vm-detail-items">' +
            items.map(function(it) {
                var qty = (it.received_quantity != null ? _vmNum(it.received_quantity) : '—') +
                    (it.unit ? ' ' + _vmEsc(it.unit) : '');
                var flag = it.status === 'missing' ? ' <span class="vm-hist-badge vm-hist-badge-warn">manglede</span>'
                         : it.grocy_error ? ' <span class="vm-hist-badge vm-hist-badge-bad">Grocy-fejl</span>' : '';
                return '<tr><th>' + _vmEsc(it.product_name) + flag + '</th><td>' + qty + '</td></tr>';
            }).join('') + '</table>';
    } else {
        html += '<div class="vm-detail-sub">Ingen varer lagt på lager ved denne modtagelse</div>';
    }

    // Whiteboard-status + gensend
    html += '<div class="vm-detail-sub">Whiteboard (FVST-log)</div>';
    if (r.whiteboard_synced_at) {
        html += '<div class="vm-detail-sync ok">✓ Sendt ' + _vmEsc(_vmFmtDateTime(r.whiteboard_synced_at)) + '</div>';
    } else {
        html += '<div class="vm-detail-sync warn">⚠ Ikke sendt — registreringen findes kun i Bon v2.</div>' +
            '<button type="button" class="vm-btn vm-btn-secondary vm-resend-btn">Send til Whiteboard</button>';
    }

    box.innerHTML = html;

    var resendBtn = box.querySelector('.vm-resend-btn');
    if (resendBtn) {
        resendBtn.addEventListener('click', async function() {
            resendBtn.disabled = true;
            resendBtn.textContent = 'Sender...';
            try {
                await resendGoodsReceiptWebhook(r.id);
                _vmShowReceiptDetail(r.id);
            } catch (err) {
                alert('Kunne ikke sende: ' + err.message);
                resendBtn.disabled = false;
                resendBtn.textContent = 'Send til Whiteboard';
            }
        });
    }
}

function _vmDeviationLabel(type) {
    var map = {
        returned:           'Varen er returneret',
        no_risk:            'Vurderet — ingen risiko, anvendes straks',
        discarded:          'Varen er kasseret',
        supplier_contacted: 'Leverandøren er kontaktet',
        other:              'Andet',
    };
    return map[type] || type || 'Registreret';
}

/* Serveren gemmer UTC (datetime('now')). parseServerDate normaliserer, så
   tiden vises dansk — ellers ser en aftenmodtagelse ud til at være sket
   to timer tidligere. */
function _vmFmtDateTime(s) {
    if (!s) return '—';
    var d = (typeof parseServerDate === 'function') ? parseServerDate(s) : new Date(s);
    if (!d || isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
        ' kl. ' + d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
}

function _vmIsoDate(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

function _vmNum(v) {
    if (v == null) return '—';
    return String(Math.round(parseFloat(v) * 100) / 100).replace('.', ',');
}

/* ── Utilities ───────────────────────────────────────────── */

function _vmEsc(str) {
    if (!str) return '';
    var el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}
