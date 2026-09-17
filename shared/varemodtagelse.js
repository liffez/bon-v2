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

// ── Uden en bestilling (#658) ──
//
// Køkkenet bestiller ikke gennem Bon, så varelisten er tom langt de fleste
// gange: 24 af 33 modtagelser havde nul varer. Det der manglede var ikke
// et nyt flow, men en måde at få varerne PÅ listen når intet var bestilt.
//
// Leverandøren udpeger selv sine varer: varenumrene i Grocy bærer et
// handelssted, og handelsstedet er koblet til leverandøren. Derfor er der
// ingen tom søgeboks — man vælger Hørkram og ser sine 87 varer.
var _vmProductById = {};     // grocy product_id → hele produktet (enhedsfelterne bruger det)
var _vmBarcodes = [];        // leverandørernes varenumre
var _vmSupplierShopLoc = {}; // leverandør-nøgle → Grocy shopping_location_id
var _vmPrices = {};          // grocy product_id → { price, reason, reason_text, stock_unit }
var _vmPricesLoaded = false; // kunne pris-status hentes? Ellers påstår vi intet
var _vmPicker = null;        // åben varevælger: { query, onlySupplier }
var _vmCarry = null;         // vare båret med fra lageroversigten (#658)
var _vmDom = {};             // cached DOM refs

// ── FVST-skemaet ──
//
// Kommer fra Whiteboard (services/receiptSchema.js). Før stod det HER, skrevet
// af i hånden:
//
//     _vmBuildTempRow('koel', '🧊', 'Kølevarer', 'max. 5°C', 4.5, 0.1, true, 4.7, 5)
//
// De tal ER tavlens skema. Rettede nogen grænseværdien i tavlens admin, skete
// der ingenting her, og ingen fik det at vide. Nu ejer tavlen skemaet.
//
// _vmSchema.source siger hvor det kom fra: 'whiteboard' (friskt), 'cache'
// (sidst hentede) eller 'builtin' (kopien i receiptSchema.js). Er det ikke
// friskt, siges det i UI'et frem for at se ud som om alt er ajour.
var _vmSchema = null;
var _vmFields = {};          // felt-id → felt fra skemaet
var _vmExtraFields = [];     // felter tavlen har, som Bon v2 ikke har en kolonne til
var _vmExtra = {};           // deres værdier — sendes som extra_fields

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
    _vmExtra = {};
    _vmCarry = _vmReadCarry();

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
            // FVST-skemaet fra tavlen. Serveren svarer ALTID med noget brugbart
            // (tavle → cache → indbygget kopi), så et .catch her fanger kun at
            // Bon v2's egen route er utilgængelig — og selv da skal formularen
            // kunne bruges. Fødevarekontrol er lovpligtig.
            fetchGoodsReceiptSchema().catch(function() { return null; }),
            // #658: varenumrene driver kandidatlisten pr. leverandør, og
            // pris-status siger hvilke varer der mangler et valg. Begge er
            // pynt på en lovpligtig registrering — fejler de, fortsætter vi.
            fetchProductBarcodes().catch(function() { return null; }),
            fetchSupplierPriceOverview().catch(function() { return null; }),
        ]);

        var localStaff = results[0] || [];
        var allSuppliers = results[1] || [];
        _vmShoppingList = results[2] || [];
        var products = results[3] || [];
        var qus = results[4] || [];
        var spRaw = results[5];
        _vmApplySchema(results[7]);
        var spEmployees = Array.isArray(spRaw) ? spRaw : (spRaw && spRaw.employees ? spRaw.employees : []);
        // null = kaldet fejlede. Tom liste ville ellers se ud som "ingen
        // omregninger findes" og udløse en advarsel på HVER vare med afvigende
        // enhed — 22 falske alarmer ved et Grocy-hik.
        _vmConversionsLoaded = Array.isArray(results[6]);
        _vmConversions = _vmConversionsLoaded ? results[6] : [];
        _vmBarcodes = Array.isArray(results[8]) ? results[8] : [];
        _vmPrices = (results[9] && typeof results[9] === 'object') ? results[9] : {};
        _vmPricesLoaded = !!results[9];

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
        _vmProductById = {};
        for (var p = 0; p < products.length; p++) {
            _vmProductNames[products[p].id] = products[p].name;
            _vmProductStockQu[products[p].id] = products[p].qu_id_stock;
            // Enhedsfelterne (§14.6) skal bruge qu_id_purchase og qu_id_consume,
            // ikke kun lager-enheden.
            if (String(products[p].active) === '1') _vmProductById[products[p].id] = products[p];
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

/**
 * Vare båret med fra lageroversigtens "Kom der varer?" (#658).
 *
 * Nøglen ryddes ved læsning: en genindlæsning må ikke lægge varen på igen,
 * og en gammel overførsel må ikke dukke op dagen efter. 30 minutter er
 * rigeligt til at gå fra hylden til skærmen.
 */
function _vmReadCarry() {
    var raw = null;
    try {
        raw = sessionStorage.getItem('vm_carry');
        sessionStorage.removeItem('vm_carry');
    } catch (err) { return null; }
    if (!raw) return null;
    try {
        var c = JSON.parse(raw);
        if (!c) return null;
        if (c.ts && (Date.now() - c.ts) > 30 * 60 * 1000) return null;
        // Retter man flere varer op, skal de alle med. Den enkelte form
        // accepteres stadig, så en side der stod åben fra en tidligere version
        // ikke taber sin overførsel.
        var varer = Array.isArray(c.items) ? c.items : (c.pid ? [c] : []);
        varer = varer.filter(function(v) { return v && v.pid; });
        return varer.length ? varer : null;
    } catch (err) { return null; }
}

/**
 * Læg den medbragte vare på listen.
 *
 * Kaldes EFTER varelisten er bygget fra indkøbslisten — den erstatter
 * _vmState.items, så en vare lagt på før ville forsvinde igen.
 */
function _vmApplyCarry() {
    if (!_vmCarry || !_vmCarry.length) return;

    for (var i = 0; i < _vmCarry.length; i++) {
        var c = _vmCarry[i];
        var pid = c.pid;
        if (!_vmProductById[pid]) continue;   // varen findes ikke (længere) i Grocy
        if (_vmOnList(pid)) continue;         // stod allerede på listen fra bestillingen
        if (!_vmAddProduct(pid, null)) continue;

        var item = _vmState.items[_vmState.items.length - 1];
        // Tallet er allerede tastet én gang i lageroversigten. At taste det igen
        // ville være præcis den friktion der fik folk til at blive dér.
        if (c.qty > 0 && c.qu_id != null) {
            item.qu_id = parseInt(c.qu_id);
            item.unit = _vmQuNames[item.qu_id] || item.unit;
            item.entries = [{ qu_id: item.qu_id, qty: c.qty }];
            item.received = c.qty;
        }
        item.fromCarry = true;
    }
}

/* ── Skemaet ─────────────────────────────────────────────── */

/**
 * Tag imod skemaet fra serveren og læg det i opslagsform.
 *
 * Kom der intet (Bon v2's egen route utilgængelig), bruger vi det tomme
 * skema — og hver _vmField() falder tilbage på sin indbyggede standard, så
 * formularen ser ud som før. En varemodtagelse må aldrig strande på at et
 * skema ikke kunne hentes.
 */
function _vmApplySchema(schema) {
    _vmSchema = schema || null;
    _vmFields = {};
    _vmExtraFields = [];

    var fields = (schema && Array.isArray(schema.fields)) ? schema.fields : [];
    var known = (schema && Array.isArray(schema.known_field_ids)) ? schema.known_field_ids : [];

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (!f || !f.id) continue;
        _vmFields[f.id] = f;
        // Felter Bon v2 ikke har en kolonne til. De renderes generisk og
        // sendes videre til tavlen — så et NYT felt tilføjet i admin virker
        // uden at nogen rører denne fil.
        if (known.indexOf(f.id) === -1) _vmExtraFields.push(f);
    }
}

/**
 * Et felt fra skemaet, med indbygget standard som bund.
 *
 * Standarden er der for de tilfælde hvor skemaet ikke kunne hentes OG feltet
 * er noget Bon v2 selv renderer. Den er bevidst mager: den skal holde
 * formularen i live, ikke være en anden mening om hvad skemaet siger.
 */
function _vmField(id, fallback) {
    return _vmFields[id] || fallback || {};
}

/** Er et felt slået til i skemaet? Et fjernet felt skal ikke renderes. */
function _vmHasField(id) {
    // Intet skema = vis alt, som før. Kun når vi FAKTISK har et skema, kan
    // fraværet af et felt betyde "det er fjernet".
    if (!_vmSchema || !Array.isArray(_vmSchema.fields) || !_vmSchema.fields.length) return true;
    return !!_vmFields[id];
}

/**
 * Linje der fortæller hvor skemaet kom fra — kun når det IKKE er friskt.
 *
 * Uden den ville et forældet skema se præcis ud som et ajourført. Det var
 * hele problemet vi løste: en usynlig uenighed mellem to systemer.
 */
function _vmBuildSchemaNote() {
    if (!_vmSchema || _vmSchema.source === 'whiteboard') return null;

    var note = document.createElement('div');
    note.className = 'vm-schema-note';

    var txt;
    if (_vmSchema.source === 'cache') {
        txt = 'Skemaet er gemt fra sidste kontakt med tavlen'
            + (_vmSchema.fetched_at ? ' (' + _vmFmtDateTime(_vmSchema.fetched_at) + ')' : '')
            + ' — en nylig ændring i tavlens admin er måske ikke med.';
    } else {
        txt = 'Bruger Bon v2\u2019s indbyggede skema — ikke tavlens.'
            + ' Ændringer i tavlens admin slår ikke igennem her.';
    }
    note.textContent = '\u2139\ufe0f ' + txt;
    if (_vmSchema.error) note.title = _vmSchema.error;
    return note;
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
    _vmSupplierShopLoc = {};
    var seen = {};
    var withItems = [];
    var withoutItems = [];

    // Et handelssted i Grocy hører til én leverandør, men en leverandør kan
    // have flere (Inco har to handelssteder). Derfor en liste pr. navn — og
    // den samles FØR dedupliceringen nedenfor, som ellers ville smide de
    // ekstra rækker væk sammen med deres handelssted.
    for (var g = 0; g < suppliers.length; g++) {
        var gName = suppliers[g].supplier_name || '';
        var gLoc = suppliers[g].grocy_location_id;
        if (!gName || gLoc == null) continue;
        if (!_vmSupplierShopLoc[gName]) _vmSupplierShopLoc[gName] = [];
        if (_vmSupplierShopLoc[gName].indexOf(parseInt(gLoc)) < 0) {
            _vmSupplierShopLoc[gName].push(parseInt(gLoc));
        }
    }

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
        // Kandidatlisten slås op på nøglen, ikke på leverandørnavnet — de er
        // ikke altid de samme (matchKey kan være Grocy-lokationsnavnet).
        if (matchKey !== name && _vmSupplierShopLoc[name]) {
            _vmSupplierShopLoc[matchKey] = _vmSupplierShopLoc[name];
        }

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

    // ── FVST toggles — labels og tilstedeværelse fra skemaet.
    //    Et tjek der fjernes i tavlens admin forsvinder også her; state-flaget
    //    bliver stående på true, så et fjernet tjek ikke fejler valideringen.
    var checks = [
        { id: 'date_ok',      fallback: 'Dato/holdbarhed kontrolleret', dom: 'toggleDate',  key: 'dateCheck'  },
        { id: 'label_ok',     fallback: 'M\u00e6rkning kontrolleret',        dom: 'toggleLabel', key: 'labelCheck' },
        { id: 'packaging_ok', fallback: 'Emballage kontrolleret',       dom: 'togglePack',  key: 'packCheck'  },
    ];
    checks.forEach(function(c) {
        if (!_vmHasField(c.id)) return;
        var label = _vmField(c.id).label || c.fallback;
        _vmDom[c.dom] = _vmBuildToggleRow(label, _vmState[c.key], (function(key) {
            return function(v) { _vmState[key] = v; _vmCheckDeviation(); _vmUpdateBtn(); };
        })(c.key));
        content.appendChild(_vmDom[c.dom]);
    });

    // ── Foto
    if (_vmHasField('photo')) content.appendChild(_vmBuildPhotoBtn());

    // ── Afvigelse
    content.appendChild(_vmBuildDeviationBox());

    // ── Manuel åbning af afvigelse (når intet trigger automatisk)
    content.appendChild(_vmBuildManualDeviationBtn());

    // ── Felter tavlen har tilføjet, som Bon v2 ikke selv kender.
    //    Uden dem ville "tavlen ejer skemaet" kun gælde halvt: et NYT felt i
    //    admin ville kræve kode her. Nu renderes det generisk og følger med
    //    videre til FVST-loggen.
    var extras = _vmBuildExtraFieldsSection();
    if (extras) content.appendChild(extras);

    // ── Bemærkning
    content.appendChild(_vmBuildRemarkSection());

    // ── Hvor kom skemaet fra? Vises kun når det ikke er friskt.
    var schemaNote = _vmBuildSchemaNote();
    if (schemaNote) content.appendChild(schemaNote);

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

    // Sæt hver temperaturrække i den tilstand dens toggle faktisk står i.
    //
    // Før kaldte vi bare _vmUpdateTempBadge(), som beregner badgen UDEN at se
    // på om rækken er slået til. En frost-række der starter slukket
    // (toggle_default_off i skemaet) viste derfor et grønt "OK" for en måling
    // der aldrig blev taget — og feltet "Målt på (frostvare)" stod skrivbart,
    // selvom serveren kasserer værdien når toggle er fra. Et felt man kan
    // skrive i, og som stille ikke bliver gemt, er den slags tavse tab hele
    // denne opgave handler om at fjerne.
    //
    // _vmOnTempEnabled sætter badge, talfelt og produktfelt i ét — så
    // starttilstanden og et klik på toggle går gennem samme kode.
    ['koel', 'frys'].forEach(function(type) {
        if (_vmDom[type + 'Input']) _vmOnTempEnabled(type, !!_vmState[type + 'Enabled']);
    });
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
    // Egen klasse ud over vm-card: hjælpesystemet peger på elementer via
    // CSS-selectorer, og alle kortene på siden delte ellers samme klasse.
    card.className = 'vm-card vm-supplier-card';

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
        _vmApplyCarry();
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
                // #657: hvilke varenumre der blev bestilt — prisen hører til dem.
                varenrs: [],
            };
        }
        byProduct[pid].expected += (sl.amount || 0);
        byProduct[pid].slIds.push(sl.id);
        var vn = String((sl.userfields || {}).ordered_varenr || '');
        if (vn && byProduct[pid].varenrs.indexOf(vn) < 0) byProduct[pid].varenrs.push(vn);
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

    var rows = 0;

    // Køl og frys er skemaets 'temperature' og 'temperature_freezer'.
    // Er et af dem fjernet i tavlens admin, forsvinder rækken her.
    if (_vmHasField('temperature')) {
        grid.appendChild(_vmBuildTempRow('koel', _VM_TEMP_DEFAULTS.koel));
        rows++;
    }
    if (_vmHasField('temperature_freezer')) {
        if (rows > 0) {
            var sep = document.createElement('div');
            sep.className = 'vm-temp-separator';
            grid.appendChild(sep);
        }
        grid.appendChild(_vmBuildTempRow('frys', _VM_TEMP_DEFAULTS.frys));
        rows++;
    }

    if (!rows) return document.createComment('ingen temperaturfelter i skemaet');

    card.appendChild(grid);
    return card;
}

/**
 * Standarder pr. temperatur.
 *
 * Værdierne her er en BUND, ikke sandheden — skemaet vinder over dem alle.
 * De findes så formularen holder hvis skemaet ikke kunne hentes.
 *
 * `step` og `emoji` står bevidst kun her: de er indtastnings-ergonomi og
 * pynt, ikke fødevarekontrol, og hører ikke hjemme i et FVST-skema.
 */
var _VM_TEMP_DEFAULTS = {
    koel: {
        fieldId: 'temperature', productFieldId: 'temp_product',
        emoji: '\uD83E\uDDCA', step: 0.1,
        label: 'K\u00f8levarer', hint: 'max. 5\u00b0C',
        default_value: 4.5, warn_above: 4, action_above: 5,
        optional_toggle: true, toggle_default_off: false,
    },
    frys: {
        fieldId: 'temperature_freezer', productFieldId: 'temp_product_freezer',
        emoji: '\u2744\ufe0f', step: 0.5,
        label: 'Frysvarer', hint: 'max. -18\u00b0C',
        default_value: -20, warn_above: -19, action_above: -18,
        optional_toggle: true, toggle_default_off: true,
    },
};

/**
 * Én temperaturrække: overskrift + til/fra, tal + status, og "målt på".
 *
 * Alt der kan ses eller vurderes kommer fra skemaet — label, hint,
 * standardværdi, om rækken starter slået fra, og de to grænser der afgør
 * om badgen viser OK, OBS eller AFVIGELSE.
 *
 * Bemærk `warn_above`/`action_above`: navnene siger "over", men for frost er
 * grænserne negative (-19 / -18) og logikken i _vmOnTempChange sammenligner
 * stadig med >. Det er tavlens egen konvention, og den er bevaret med vilje —
 * ellers ville de to systemer vurdere den samme måling forskelligt.
 */
function _vmBuildTempRow(type, def) {
    var f = _vmField(def.fieldId, def);

    var pick = function(key) { return f[key] !== undefined && f[key] !== null ? f[key] : def[key]; };

    var label       = pick('label');
    var hint        = pick('hint') || '';
    var defaultVal  = pick('default_value');
    var warnLimit   = pick('warn_above');
    var actionLimit = pick('action_above');
    // optional_toggle=false betyder at temperaturen ikke kan slås fra —
    // så starter rækken naturligvis slået til.
    var canToggle   = pick('optional_toggle') !== false;
    var startEnabled = canToggle ? !pick('toggle_default_off') : true;

    var row = document.createElement('div');
    row.className = 'vm-temp-row-item';

    // Grænserne skal med i state — _vmOnTempChange læser dem ved hvert tastetryk.
    _vmState[type + 'WarnLimit'] = warnLimit;
    _vmState[type + 'ActionLimit'] = actionLimit;
    _vmState[type + 'Enabled'] = !!startEnabled;
    _vmState[type + 'Value'] = Number(defaultVal);

    // Header
    var header = document.createElement('div');
    header.className = 'vm-temp-row-header';

    var titleEl = document.createElement('div');
    titleEl.className = 'vm-temp-row-title';
    titleEl.innerHTML = '<span class="vm-emoji">' + def.emoji + '</span> ' + _vmEsc(_vmStripEmoji(label)) +
        (hint ? ' <span class="vm-field-hint">' + _vmEsc(hint) + '</span>' : '');
    header.appendChild(titleEl);

    if (canToggle) {
        var toggle = document.createElement('label');
        toggle.className = 'vm-mini-toggle';
        toggle.title = 'Sl\u00e5 fra hvis ingen ' + _vmStripEmoji(label).toLowerCase();
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!startEnabled;
        cb.addEventListener('change', function() { _vmOnTempEnabled(type, this.checked); });
        toggle.appendChild(cb);
        var slider = document.createElement('span');
        slider.className = 'vm-mini-slider';
        toggle.appendChild(slider);
        header.appendChild(toggle);
    }

    row.appendChild(header);

    // Input group
    var group = document.createElement('div');
    group.className = 'vm-temp-input-group';

    var wrap = document.createElement('div');
    wrap.className = 'vm-temp-input-wrap';

    var input = document.createElement('input');
    input.type = 'number';
    input.step = String(def.step);
    input.value = String(defaultVal);
    input.inputMode = 'decimal';
    input.addEventListener('input', function() { _vmOnTempChange(type, this.value); });
    _vmDom[type + 'Input'] = input;
    wrap.appendChild(input);

    var unit = document.createElement('span');
    unit.className = 'vm-temp-unit';
    unit.textContent = f.unit || '\u00b0C';
    wrap.appendChild(unit);

    group.appendChild(wrap);

    var badge = document.createElement('div');
    badge.className = 'vm-temp-badge';
    badge.innerHTML = '<span class="vm-temp-badge-icon">\ud83c\udf21</span><span>\u2014</span>';
    _vmDom[type + 'Badge'] = badge;
    group.appendChild(badge);

    row.appendChild(group);

    // ── "Målt på": hvilken vare blev temperaturen taget på? ──
    //
    // FVST-loggen kunne fortælle AT der var målt 3,5 °C, men ikke HVAD der
    // blev målt på. Tavlen har feltet som ren tekst — den kender ikke
    // leverancen. Her gør vi: <input list> giver varerne på netop denne
    // leverance som forslag OG tillader fri tekst, hvis der blev målt på
    // noget andet. Samme værdi gemmes begge veje: varenavnet.
    var pf = _vmFields[def.productFieldId];
    if (pf) {
        row.appendChild(_vmBuildTempProductRow(type, def, pf));
    }

    return row;
}

/** Feltet der spørger hvilken vare temperaturen blev målt på. */
function _vmBuildTempProductRow(type, def, field) {
    var wrap = document.createElement('div');
    wrap.className = 'vm-temp-product';

    var listId = 'vm-temp-products-' + type;

    var lbl = document.createElement('label');
    lbl.className = 'vm-temp-product-label';
    lbl.textContent = field.label || 'M\u00e5lt p\u00e5';
    lbl.setAttribute('for', 'vm-temp-product-' + type);
    wrap.appendChild(lbl);

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'vm-temp-product-' + type;
    input.className = 'vm-temp-product-input';
    input.setAttribute('list', listId);
    input.placeholder = field.hint || 'Hvilken vare blev m\u00e5lt?';
    input.autocomplete = 'off';
    input.addEventListener('input', function() {
        _vmState[type + 'Product'] = this.value;
    });
    wrap.appendChild(input);
    _vmDom[type + 'ProductInput'] = input;

    // Forslagene fyldes af _vmSyncTempProductLists() når leverandøren er valgt
    // og varelisten dermed er kendt.
    var list = document.createElement('datalist');
    list.id = listId;
    wrap.appendChild(list);
    _vmDom[type + 'ProductList'] = list;

    return wrap;
}

/**
 * Fyld forslagene med varerne på leverancen.
 *
 * Kaldes når varelisten ændrer sig (leverandørskift, manuelt tilføjet vare).
 * Fri tekst forbliver mulig — listen er forslag, ikke en begrænsning.
 */
function _vmSyncTempProductLists() {
    var names = [];
    var seen = {};
    for (var i = 0; i < _vmState.items.length; i++) {
        var n = (_vmState.items[i].product_name || '').trim();
        if (!n || seen[n]) continue;
        seen[n] = true;
        names.push(n);
    }
    names.sort(function(a, b) { return a.localeCompare(b, 'da'); });

    ['koel', 'frys'].forEach(function(type) {
        var list = _vmDom[type + 'ProductList'];
        if (!list) return;
        list.innerHTML = '';
        for (var j = 0; j < names.length; j++) {
            var opt = document.createElement('option');
            opt.value = names[j];
            list.appendChild(opt);
        }
    });
}

/**
 * Fjern et ledende emoji fra en label.
 *
 * Tavlens labels bærer deres eget ikon ("🧊 Kølevarer"), og rækken her sætter
 * allerede et. Uden det her stod der to.
 */
function _vmStripEmoji(label) {
    return String(label || '').replace(/^[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u2744]+/u, '').trim() || String(label || '');
}

function _vmOnTempEnabled(type, enabled) {
    _vmState[type + 'Enabled'] = enabled;
    var input = _vmDom[type + 'Input'];
    var badge = _vmDom[type + 'Badge'];
    input.disabled = !enabled;

    // Produktfeltet følger sin temperatur: er der ikke målt, er der heller
    // ikke noget at have målt PÅ. Ryddes det ikke, ville et navn fra før
    // toggle blev slået fra stå tilbage i state og ryge med i registreringen.
    var prodInput = _vmDom[type + 'ProductInput'];
    if (prodInput) prodInput.disabled = !enabled;

    if (!enabled) {
        badge.className = 'vm-temp-badge vm-disabled';
        badge.innerHTML = '<span class="vm-temp-badge-icon">\u2014</span><span>Ingen</span>';
        _vmState[type + 'Status'] = null;
        _vmState[type + 'Product'] = '';
        if (prodInput) prodInput.value = '';
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

/* ── Felter fra skemaet som Bon v2 ikke selv kender ──────── */

/**
 * Render de felter tavlen har tilføjet, men som Bon v2 ikke har en kolonne til.
 *
 * DETTE er det der gør koblingen ægte. Uden den ville "tavlen ejer skemaet"
 * kun gælde halvt: labels og grænser ville slå igennem, men et HELT NYT felt
 * i admin ville kræve en kodeændring og en migration i Bon v2 — altså præcis
 * den dobbelt-vedligeholdelse vi er ved at komme af med.
 *
 * Værdierne gemmes i goods_receipts.extra_fields_json og sendes videre til
 * FVST-loggen under tavlens egne felt-id'er.
 *
 * Ukendte felttyper renderes som tekst frem for at blive sprunget over: et
 * felt nogen har lagt i skemaet skal kunne udfyldes, også når vi ikke har
 * lært typen at kende endnu.
 */
function _vmBuildExtraFieldsSection() {
    if (!_vmExtraFields.length) return null;

    var wrap = document.createElement('div');
    wrap.className = 'vm-extra-fields';

    for (var i = 0; i < _vmExtraFields.length; i++) {
        var el = _vmBuildExtraField(_vmExtraFields[i]);
        if (el) wrap.appendChild(el);
    }
    return wrap.children.length ? wrap : null;
}

function _vmBuildExtraField(field) {
    var id = field.id;
    var type = String(field.type || 'text').toLowerCase();

    // Checkbox har sin egen række med til/fra-knap, ligesom FVST-tjekkene.
    if (type === 'checkbox' || type === 'bool') {
        // Et nyt tjek starter SLÅET FRA. Et krav ingen har set endnu må ikke
        // stå som besvaret på forhånd — så ville feltet dokumentere noget der
        // ikke er kontrolleret.
        _vmExtra[id] = false;
        return _vmBuildToggleRow(field.label || id, false, function(v) { _vmExtra[id] = v; });
    }

    var row = document.createElement('div');
    row.className = 'vm-extra-field';

    var lbl = document.createElement('label');
    lbl.className = 'vm-extra-label';
    lbl.textContent = field.label || id;
    lbl.setAttribute('for', 'vm-extra-' + id);
    row.appendChild(lbl);

    if (field.hint) {
        var hint = document.createElement('div');
        hint.className = 'vm-field-hint';
        hint.textContent = field.hint;
        row.appendChild(hint);
    }

    var input;
    if (type === 'select' && Array.isArray(field.options) && field.options.length) {
        input = document.createElement('select');
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '\u2014 v\u00e6lg \u2014';
        input.appendChild(blank);
        for (var i = 0; i < field.options.length; i++) {
            var o = field.options[i];
            var opt = document.createElement('option');
            opt.value = o.value !== undefined ? o.value : o;
            opt.textContent = o.label !== undefined ? o.label : String(o);
            input.appendChild(opt);
        }
    } else if (type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 2;
        if (field.hint) input.placeholder = field.hint;
    } else {
        input = document.createElement('input');
        // 'photo' og andre typer vi ikke renderer særligt bliver til tekst.
        input.type = (type === 'number') ? 'number' : 'text';
        if (type === 'number') input.inputMode = 'decimal';
        if (field.default_value !== undefined && field.default_value !== null) {
            input.value = String(field.default_value);
            _vmExtra[id] = type === 'number' ? Number(field.default_value) : field.default_value;
        }
        if (field.hint) input.placeholder = field.hint;
    }

    input.id = 'vm-extra-' + id;
    input.className = 'vm-extra-input';
    input.addEventListener('input', function() {
        var v = this.value;
        if (type === 'number') {
            var n = parseFloat(v);
            _vmExtra[id] = isNaN(n) ? '' : n;
        } else {
            _vmExtra[id] = v;
        }
    });
    input.addEventListener('change', function() {
        if (input.tagName === 'SELECT') _vmExtra[id] = this.value;
    });
    row.appendChild(input);

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

    var devHint = (_vmFields['deviation'] || {}).hint || 'Udfyldes kun ved afvigelse';
    box.innerHTML =
        '<div><div class="vm-deviation-title">\u26a0\ufe0f Afvigelse registreret</div>' +
        '<div class="vm-deviation-sub">' + _vmEsc(devHint) + '</div></div>';

    // Options
    var optWrap = document.createElement('div');
    var noteLabel = document.createElement('div');
    noteLabel.className = 'vm-deviation-note-label';
    noteLabel.textContent = 'Hvad skete der?';
    optWrap.appendChild(noteLabel);

    var options = document.createElement('div');
    options.className = 'vm-deviation-options';

    // Valgene kommer fra skemaet. Serveren har allerede oversat tavlens
    // værdier til Bon v2's (tavlen skriver 'accepted_no_risk', vi gemmer
    // 'no_risk' — låst af CHECK-constraint i migration 036) og fjernet
    // "Ingen afvigelse", som ikke giver mening inde i afvigelses-sektionen.
    //
    // Listen nedenfor er den bund der bruges hvis skemaet ikke kunne hentes.
    var deviationTypes = [
        { value: 'returned', label: 'Varen er returneret' },
        { value: 'no_risk', label: 'Vurderet \u2014 ingen risiko, anvendes straks' },
        { value: 'discarded', label: 'Varen er kasseret' },
        { value: 'supplier_contacted', label: 'Leverand\u00f8ren er kontaktet' },
        { value: 'other', label: 'Andet' },
    ];
    var devField = _vmFields['deviation'];
    if (devField && Array.isArray(devField.options) && devField.options.length) {
        deviationTypes = devField.options;
    }

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
    var noteField = _vmFields['deviation_note'] || {};
    var noteSection = document.createElement('div');
    noteSection.innerHTML = '<div class="vm-deviation-note-label">' +
        _vmEsc(noteField.label || 'Bem\u00e6rkning ved afvigelse') + '</div>';
    var textarea = document.createElement('textarea');
    textarea.className = 'vm-deviation-note';
    textarea.placeholder = noteField.hint || 'Beskriv afvigelsen og hvad der blev gjort';
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

    // Varelisten er også forslagene til "Målt på". Synkroniseres her frem for
    // ved hvert kaldested, så en vare tilføjet manuelt eller et leverandør-
    // skift altid slår igennem begge steder.
    _vmSyncTempProductLists();

    // Header
    var header = document.createElement('div');
    header.className = 'vm-lager-header';
    var bestilte = _vmState.items.filter(function(it) { return (it.expected || 0) > 0; }).length;
    var metaText = bestilte > 0
        ? (bestilte === _vmState.items.length ? 'Fra indk\u00f8b' : 'Fra indk\u00f8b + tilf\u00f8jet')
        : (_vmState.items.length ? 'Tilf\u00f8jet \u2014 ikke bestilt i Bon' : 'Ingen varer endnu');
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
            'f\u00f8devarekontrollen.';
        el.appendChild(empty);

        if (_vmPicker) {
            el.appendChild(_vmBuildPicker());
        } else {
            var addBtn0 = document.createElement('button');
            addBtn0.className = 'vm-add-item-btn';
            addBtn0.type = 'button';
            addBtn0.textContent = '\uff0b Tilf\u00f8j varer';
            addBtn0.addEventListener('click', _vmOpenPicker);
            el.appendChild(addBtn0);
        }

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
    // Er intet bestilt, er der ikke noget at godkende "som bestilt" — tallene
    // er tastet i hånden, og knappen ville love noget den ikke gør.
    top.innerHTML = bestilte > 0
        ? '<div><div class="vm-godkend-alt-text">\u2713 Alt modtaget som bestilt</div>' +
          '<div class="vm-godkend-alt-sub">Alle varer l\u00e6gges p\u00e5 lager med forventet m\u00e6ngde</div></div>'
        : '<div><div class="vm-godkend-alt-text">' + _vmState.items.length + ' varer tilf\u00f8jet</div>' +
          '<div class="vm-godkend-alt-sub">Tast m\u00e6ngderne nedenfor \u2014 der er ikke bestilt noget at holde dem op mod</div></div>';

    if (bestilte > 0) {
        var godkendBtn = document.createElement('button');
        godkendBtn.className = 'vm-btn-godkend-alt';
        godkendBtn.textContent = 'Godkend alt';
        godkendBtn.addEventListener('click', _vmGodkendAlt);
        top.appendChild(godkendBtn);
    }
    banner.appendChild(top);

    if (bestilte > 0) {
        var detailBtn = document.createElement('button');
        detailBtn.className = 'vm-detail-toggle';
        _vmDom.detailToggleBtn = detailBtn;
        detailBtn.textContent = _vmState.itemListOpen
            ? '\u25be Skjul vareliste'
            : '\u25b8 Juster enkeltvis hvis noget afviger';
        detailBtn.addEventListener('click', _vmToggleItemList);
        banner.appendChild(detailBtn);
    } else {
        _vmState.itemListOpen = true;
    }

    el.appendChild(banner);

    // Enheds-advarsel (#358). Ligger UDEN FOR varelisten med vilje: listen er
    // foldet sammen som default, og "Godkend alt" er den normale vej igennem.
    // En advarsel inde i listen ville derfor ikke blive set af dem der bruger
    // skærmen som den er tænkt.
    var issues = _vmUnitIssueItems();
    if (issues.length > 0) el.appendChild(_vmBuildUnitWarnBanner(issues));

    // Klassen SKAL følge tilstanden ved hver render.
    //
    // Gjorde den ikke det, var listen `display:none` selvom _vmState.itemListOpen
    // var true — og så blev varekortene tegnet, men var usynlige. Det ramte
    // præcis den nye vej: uden en bestilling er der ingen "Juster enkeltvis"-knap
    // til at åbne listen, så INTET tilføjede klassen. Man kunne lægge en vare på,
    // se tælleren gå til 1, og ikke kunne se hverken varen, mængdefelterne eller
    // prisen. Fundet i drift 18. september.
    var list = document.createElement('div');
    list.className = 'vm-item-list' + (_vmState.itemListOpen ? ' vm-open' : '');
    _vmDom.itemList = list;

    for (var i = 0; i < _vmState.items.length; i++) {
        list.appendChild(_vmBuildItemCard(i));
    }

    // Én vej ind: vælgeren rummer både leverandørens varer, søgning,
    // kodefeltet, "opret ny vare" og "notér uden lager".
    if (_vmPicker) {
        list.appendChild(_vmBuildPicker());
    } else {
        var addBtn = document.createElement('button');
        addBtn.className = 'vm-add-item-btn';
        addBtn.type = 'button';
        addBtn.textContent = '\uff0b Tilf\u00f8j varer';
        addBtn.addEventListener('click', _vmOpenPicker);
        list.appendChild(addBtn);
    }

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

/* ── Mængde ↔ poster ──────────────────────────────────────────
 *
 * Linjen bærer to ting der skal blive ved med at passe sammen: posterne
 * (hvad brugeren tastede, i hvilke enheder) og `received` (ét tal i linjens
 * egen enhed). Det sidste er dét indkøbslisten og de eksisterende tests
 * regner med, så det må ikke skifte betydning fordi der nu kan tastes i
 * flere felter. */

/** Startværdier til felterne: gemte poster, ellers linjens eget tal. */
function _vmItemEntries(item) {
    if (Array.isArray(item.entries) && item.entries.length) return item.entries;
    if ((item.received || 0) > 0 && item.qu_id != null) {
        return [{ qu_id: parseInt(item.qu_id), qty: item.received }];
    }
    return [];
}

/**
 * Skriv posterne tilbage på linjen.
 *
 * `received` udtrykkes i linjens EGEN enhed, ikke i lager-enhed. Ellers
 * ville "modtaget 2 af 3 bestilte kasser" blive sammenlignet med et kilotal,
 * og indkøbslistens rest-beregning ville skride. Ved ét felt i linjens egen
 * enhed er tallet præcis det brugeren tastede.
 */
function _vmApplyEntries(item, entries, stockAmount) {
    item.entries = entries;
    item.stockAmount = stockAmount;

    var f = null;
    if (item.grocy_product_id != null && item.qu_id != null && window.MangdeFelter) {
        f = MangdeFelter.factorTo(
            _vmConversions,
            item.grocy_product_id,
            item.qu_id,
            _vmProductStockQu[item.grocy_product_id]
        );
    }
    var v = (f && f > 0) ? (stockAmount / f) : stockAmount;
    item.received = Math.round(v * 1e6) / 1e6;
}

/* ── Pris-status på linjen (#658) ─────────────────────────────
 *
 * 13 varer i drift har flere varenumre uden et foretrukket valg, og de får
 * derfor ingen pris. Valget er ét klik — men kun hvis nogen bliver spurgt.
 * Her bliver de spurgt, dér hvor svaret findes: ved kassen.
 *
 * Linjen er aldrig et krav. Fødevarekontrollen er lovpligtig, prisen er ikke,
 * og en manglende pris må hverken blokere eller larme. */

function _vmBuildPrisRow(index) {
    var item = _vmState.items[index];
    if (!item || !item.grocy_product_id) return null;
    // Kunne pris-status ikke hentes, påstår vi intet — samme regel som
    // enheds-advarslen (#358).
    if (!_vmPricesLoaded) return null;

    var pid = item.grocy_product_id;
    var pi = _vmPriceInfo(pid) || {};
    var row = document.createElement('div');
    row.className = 'vm-pris-row';

    var txt = document.createElement('span');
    txt.className = 'vm-pris-txt';

    // Kom varen fra en kode, VED vi hvilket varenummer der blev leveret, og
    // så er prisen entydig — også for en vare med flere numre.
    var leveret = item.varenrs && item.varenrs.length === 1 ? item.varenrs[0] : null;

    if (pi.price != null) {
        txt.textContent = 'Pris ' + _vmPris(pi.price) + ' kr/' + (pi.stock_unit || '') +
            (leveret ? ' \u00b7 varenr ' + leveret : '');
        row.appendChild(txt);
    } else if (leveret) {
        txt.textContent = 'Varenr ' + leveret + ' \u2014 prisen sl\u00e5s op ved registrering';
        row.appendChild(txt);
    } else {
        txt.className = 'vm-pris-txt vm-pris-mangler';
        // Begrundelsen tilføjes kun når den siger noget nyt: reason_text for
        // 'missing' ER "ingen pris", og "Ingen pris · ingen pris" ligner en fejl.
        var grund = pi.reason_text && pi.reason_text !== 'ingen pris' ? pi.reason_text : '';
        txt.textContent = 'Ingen pris' + (grund ? ' \u00b7 ' + grund : '');
        row.appendChild(txt);

        var fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'vm-pris-fix';
        fix.textContent = 'S\u00e6t pris';
        fix.addEventListener('click', function() { _vmOpenPrisFix(index, row); });
        row.appendChild(fix);
    }

    return row;
}

function _vmPris(n) {
    if (n == null) return '';
    return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
}

/** Foldes ud ved klik: vælg varenummer, eller sæt et overslag. */
async function _vmOpenPrisFix(index, row) {
    var item = _vmState.items[index];
    var pid = item.grocy_product_id;
    if (row.querySelector('.vm-pris-fixbox')) return;

    var box = document.createElement('div');
    box.className = 'vm-pris-fixbox';
    box.textContent = 'Henter varenumre\u2026';
    row.appendChild(box);

    var data;
    try {
        data = await fetchSupplierPrice(pid);
    } catch (err) {
        box.className = 'vm-pris-fixbox vm-pris-fejl';
        box.textContent = 'Kunne ikke hente varenumre: ' + err.message;
        return;
    }

    box.innerHTML = '';
    var kandidater = (data.candidates || []).filter(function(c) { return !c.is_estimate; });

    if (kandidater.length > 1) {
        var lab = document.createElement('div');
        lab.className = 'vm-pris-fixlab';
        lab.textContent = 'Hvilket varenummer gælder for denne vare?';
        box.appendChild(lab);

        var sel = document.createElement('select');
        sel.className = 'vm-pris-select';
        var tom = document.createElement('option');
        tom.value = '';
        tom.textContent = 'V\u00e6lg\u2026';
        sel.appendChild(tom);
        for (var i = 0; i < kandidater.length; i++) {
            var c = kandidater[i];
            var o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.barcode + (c.stock_price != null
                ? ' \u2014 ' + _vmPris(c.stock_price) + ' kr/' + (data.stock_unit || '')
                : ' \u2014 ingen pris');
            if (c.is_preferred) o.selected = true;
            sel.appendChild(o);
        }
        box.appendChild(sel);

        var gem = document.createElement('button');
        gem.type = 'button';
        gem.className = 'vm-pris-gem';
        gem.textContent = 'Gem';
        gem.addEventListener('click', async function() {
            if (!sel.value) return;
            gem.disabled = true;
            try {
                await setPreferredBarcode(pid, parseInt(sel.value));
                await _vmRefreshPris(pid);
                _vmRenderLagerContent();
            } catch (err) {
                gem.disabled = false;
                box.appendChild(_vmFejlLinje(err.message));
            }
        });
        box.appendChild(gem);
    }

    // Overslag: sidste udvej når varen slet ikke har et prissat varenummer.
    // Det taber altid til en leverandørpris, så det kan ikke skygge for noget.
    var oLab = document.createElement('div');
    oLab.className = 'vm-pris-fixlab';
    oLab.textContent = kandidater.length > 1
        ? 'Eller s\u00e6t et overslag (bruges kun hvis der ikke er en leverand\u00f8rpris):'
        : 'S\u00e6t et overslag \u2014 kr pr. ' + (data.stock_unit || 'enhed') + ', ex moms:';
    box.appendChild(oLab);

    var oInp = document.createElement('input');
    oInp.type = 'number';
    oInp.step = 'any';
    oInp.min = '0';
    oInp.className = 'vm-pris-overslag';
    oInp.setAttribute('inputmode', 'decimal');
    if (data.estimate_price != null) oInp.value = data.estimate_price;
    box.appendChild(oInp);

    var oGem = document.createElement('button');
    oGem.type = 'button';
    oGem.className = 'vm-pris-gem';
    oGem.textContent = 'Gem overslag';
    oGem.addEventListener('click', async function() {
        var v = parseFloat(String(oInp.value).replace(',', '.'));
        if (!isFinite(v) || v <= 0) return;
        oGem.disabled = true;
        try {
            await setEstimatePrice(pid, v, false);
            await _vmRefreshPris(pid);
            _vmRenderLagerContent();
        } catch (err) {
            oGem.disabled = false;
            box.appendChild(_vmFejlLinje(err.message));
        }
    });
    box.appendChild(oGem);
}

function _vmFejlLinje(msg) {
    var e = document.createElement('div');
    e.className = 'vm-pris-fejl';
    e.textContent = msg;
    return e;
}

/** Hent status for ÉN vare igen — hele oversigten er for tung her. */
async function _vmRefreshPris(pid) {
    try {
        var d = await fetchSupplierPrice(pid);
        _vmPrices[pid] = {
            price: d.price, reason: d.reason,
            reason_text: d.reason_text, stock_unit: d.stock_unit,
        };
    } catch (err) {
        console.warn('[varemodtagelse] Kunne ikke opdatere pris-status:', err.message);
    }
}

function _vmBuildItemCard(index) {
    var item = _vmState.items[index];
    var card = document.createElement('div');
    card.className = 'vm-item-card vm-s-' + item.status;
    card.dataset.index = index;

    // "Forventet" giver kun mening når noget ER bestilt. Står der 0, er
    // linjen tastet i hånden, og en linje der siger "Forventet: 0" ligner en
    // fejl frem for en tilføjelse.
    var sub = (item.expected || 0) > 0
        ? 'Forventet: ' + item.expected + ' ' + _vmEsc(item.unit)
        : (item.fromCarry
            ? 'Fra lageroversigten — ikke bestilt i Bon'
            : 'Ikke bestilt i Bon');
    card.innerHTML = '<div class="vm-item-name">' + _vmEsc(item.product_name) + '</div>' +
        '<div class="vm-item-expected">' + sub + '</div>';

    // #358: mangler omregningen til lager-enhed, så siges det HER — øverst på
    // kortet, før mængden tastes — med feltet der lukker hullet.
    var unitIssue = _vmUnitIssue(item);
    if (unitIssue) {
        card.classList.add('vm-unit-issue');
        card.appendChild(_vmBuildUnitFix(index, unitIssue));
    }

    // ── Mængde: tastes i de enheder varen findes i (§14.6) ──────────
    //
    // "2 kasser brød og 25 ekstra styk" er sådan mennesker tæller. Det gamle
    // ±-felt tvang alt ned i én enhed, og så skulle man regne i hovedet.
    // Posteringen sker stadig altid i lager-enhed — felterne er kun form.
    var qtyRow = document.createElement('div');
    qtyRow.className = 'vm-qty-row';

    var ql = document.createElement('span');
    ql.className = 'vm-qty-label';
    ql.textContent = 'Modtaget';
    qtyRow.appendChild(ql);

    var prod = item.grocy_product_id ? _vmProductById[item.grocy_product_id] : null;

    if (prod && window.MangdeFelter) {
        var felter = MangdeFelter.create({
            product: prod,
            conversions: _vmConversions,
            unitNames: _vmQuNames,
            // Bestillingens egen enhed skal ALTID kunne tastes, også når den
            // ikke er varens indkøbs-enhed — ellers mister en bestilt linje
            // sit eget tal.
            extraQuIds: item.qu_id != null ? [item.qu_id] : [],
            focusQuId: item.qu_id,
            stockUnitName: _vmQuNames[_vmProductStockQu[item.grocy_product_id]] || '',
            entries: _vmItemEntries(item),
            onChange: (function(idx) {
                return function(entries, stockAmount) {
                    _vmApplyEntries(_vmState.items[idx], entries, stockAmount);
                    _vmUpdateSummary();
                };
            })(index),
        });
        qtyRow.appendChild(felter.el);
    } else {
        // Vare uden Grocy-produkt (noteret, lægges ikke på lager) — ét felt,
        // fri enhed. Der er intet at omregne.
        var plain = document.createElement('input');
        plain.className = 'mf-input';
        plain.type = 'number';
        plain.min = '0';
        plain.step = 'any';
        plain.setAttribute('inputmode', 'decimal');
        plain.value = item.received || '';
        plain.addEventListener('input', (function(idx) {
            return function() {
                _vmState.items[idx].received = parseFloat(this.value) || 0;
                _vmUpdateSummary();
            };
        })(index));
        qtyRow.appendChild(plain);
        var pu = document.createElement('span');
        pu.className = 'vm-qty-unit';
        pu.textContent = item.unit || '';
        qtyRow.appendChild(pu);
    }

    card.appendChild(qtyRow);

    // Pris-status (#658 + #657). Vises hvor varen står, så et manglende valg
    // kan tages mens man har kassen i hånden — ikke opdages i en rapport
    // en uge senere.
    var prisRow = _vmBuildPrisRow(index);
    if (prisRow) card.appendChild(prisRow);

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
        // Posterne skal følge tallet. Lod vi dem stå, ville felterne vise
        // det gamle og linjen bære det nye — to tal om samme mængde.
        _vmState.items[i].entries = [];
        _vmState.items[i].stockAmount = null;
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

/* ── Varevælger: få varerne på listen uden en bestilling (#658) ──────
 *
 * Man står med kasserne. Man leder ikke efter varer — man bekræfter tal.
 * Derfor er der ingen tom søgeboks: leverandøren udpeger selv sine varer,
 * fordi varenumrene i Grocy bærer et handelssted. Søgning er nødudgangen.
 *
 * Det gamle flow var tre prompt()-bokse. Det blev brugt tre gange i hele
 * systemets levetid og gav hver gang en linje der ALDRIG nåede lageret
 * (grocy_product_id = NULL): "Kartoffel 7 Kg", "Brød 4 enhed=7",
 * "spidskål 2 stk" — hvor Spidskål findes i Grocy som produkt 27. Personen
 * kunne ikke vælge den. */

/** Pris-status for en vare — eller null når vi ikke kunne hente den. */
function _vmPriceInfo(pid) {
    if (!_vmPricesLoaded) return null;
    return _vmPrices[pid] || _vmPrices[String(pid)] || null;
}

/** Varer koblet til leverandørens handelssted(er). */
function _vmCandidateIds(supplierKey) {
    var locs = _vmSupplierShopLoc[supplierKey] ||
               _vmSupplierShopLoc[_vmState.supplierName] || [];
    if (!locs.length) return [];
    var ids = {};
    for (var i = 0; i < _vmBarcodes.length; i++) {
        var b = _vmBarcodes[i];
        if (b.shopping_location_id == null) continue;
        if (locs.indexOf(parseInt(b.shopping_location_id)) < 0) continue;
        if (_vmProductById[b.product_id]) ids[b.product_id] = true;
    }
    return Object.keys(ids);
}

function _vmOnList(pid) {
    for (var i = 0; i < _vmState.items.length; i++) {
        if (String(_vmState.items[i].grocy_product_id) === String(pid)) return true;
    }
    return false;
}

/**
 * Slå en indtastet kode op.
 *
 * Vi gemmer LEVERANDØR-varenumre i Grocys stregkodefelt, men nogle varer har
 * også en rigtig stregkode liggende som userfield. Begge prøves, så feltet
 * virker uanset om nummeret er tastet, læst med tastaturets "Scan tekst"
 * eller en dag scannet med kameraet (#662).
 */
function _vmLookupCode(code) {
    var q = String(code == null ? '' : code).trim();
    if (!q) return null;
    var i, b;
    for (i = 0; i < _vmBarcodes.length; i++) {
        b = _vmBarcodes[i];
        if (String(b.barcode || '').trim() === q && _vmProductById[b.product_id]) {
            return { pid: b.product_id, varenr: String(b.barcode).trim() };
        }
    }
    for (i = 0; i < _vmBarcodes.length; i++) {
        b = _vmBarcodes[i];
        var gtin = (b.userfields || {}).hk_gtin;
        if (gtin && String(gtin).trim() === q && _vmProductById[b.product_id]) {
            return { pid: b.product_id, varenr: String(b.barcode).trim() };
        }
    }
    return null;
}

/** Enheden en ny linje starter i: indkøbs-enheden, ellers lager-enheden. */
function _vmStartUnit(pid) {
    var p = _vmProductById[pid];
    if (!p) return null;
    var units = window.MangdeFelter
        ? MangdeFelter.unitsFor({ product: p, conversions: _vmConversions, unitNames: _vmQuNames })
        : [];
    if (units.length) return units[0].qu_id;
    return p.qu_id_stock != null ? parseInt(p.qu_id_stock) : null;
}

/** Læg en Grocy-vare på listen. varenr = det nummer koden blev slået op på. */
function _vmAddProduct(pid, varenr) {
    if (!pid || _vmOnList(pid)) return false;
    var qu = _vmStartUnit(pid);
    _vmState.items.push({
        grocy_product_id: pid,
        product_name: _vmProductNames[pid] || ('Produkt #' + pid),
        expected: 0,              // intet bestilt — der er ikke noget at holde det op mod
        received: 0,
        entries: [],
        unit: qu != null ? (_vmQuNames[qu] || '') : '',
        qu_id: qu,
        status: 'ok',
        notes: '',
        slIds: [],
        // Kom varen fra en kode, VED vi hvilket varenummer der blev leveret —
        // og så er prisen entydig, også for varer med flere numre.
        varenrs: varenr ? [varenr] : [],
        adhoc: true,
    });
    return true;
}

function _vmOpenPicker() {
    _vmPicker = { query: '' };
    _vmRenderLagerContent();
    setTimeout(function() {
        if (_vmDom.pickerCode) _vmDom.pickerCode.focus();
    }, 50);
}

function _vmClosePicker() {
    _vmPicker = null;
    _vmRenderLagerContent();
}

/** Kun til varer der ikke findes i Grocy — noteres, lægges ikke på lager. */
function _vmAddNoteItem() {
    var name = prompt('Varenavn (noteres kun \u2014 l\u00e6gges IKKE p\u00e5 lager):');
    if (!name) return;
    _vmState.items.push({
        grocy_product_id: null,
        product_name: name,
        expected: 0, received: 0, entries: [],
        unit: '', qu_id: null, status: 'ok', notes: '', slIds: [],
        varenrs: [], adhoc: true, noteOnly: true,
    });
    _vmPicker = null;
    _vmRenderLagerContent();
    _vmUpdateSummary();
    _vmUpdateBtn();
}

function _vmBuildPicker() {
    var box = document.createElement('div');
    box.className = 'vm-picker';

    var head = document.createElement('div');
    head.className = 'vm-picker-head';
    head.innerHTML = '<span class="vm-picker-title">Tilf\u00f8j varer</span>';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'vm-picker-x';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Luk';
    closeBtn.addEventListener('click', _vmClosePicker);
    head.appendChild(closeBtn);
    box.appendChild(head);

    // Kodefelt. inputmode=numeric giver taltastatur på iPad/iPhone — og
    // tastaturets "Scan tekst" kan læse varenummeret direkte fra følgesedlen
    // uden at vi skal afkode noget selv. Kameraet er #662.
    var codeRow = document.createElement('div');
    codeRow.className = 'vm-picker-coderow';
    var code = document.createElement('input');
    code.type = 'text';
    code.className = 'vm-picker-code';
    code.setAttribute('inputmode', 'numeric');
    code.placeholder = 'Varenummer \u2014 tast eller scan tekst';
    code.addEventListener('keydown', function(ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        _vmSubmitCode();
    });
    _vmDom.pickerCode = code;
    codeRow.appendChild(code);
    var codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'vm-picker-codebtn';
    codeBtn.textContent = 'Find';
    codeBtn.addEventListener('click', _vmSubmitCode);
    codeRow.appendChild(codeBtn);
    box.appendChild(codeRow);

    var codeMsg = document.createElement('div');
    codeMsg.className = 'vm-picker-codemsg';
    _vmDom.pickerCodeMsg = codeMsg;
    box.appendChild(codeMsg);

    // Søgning
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'vm-picker-search';
    search.placeholder = 'S\u00f8g vare...';
    search.value = _vmPicker.query;
    search.addEventListener('input', function() {
        _vmPicker.query = this.value;
        _vmRenderPickerList();
    });
    _vmDom.pickerSearch = search;
    box.appendChild(search);

    var list = document.createElement('div');
    list.className = 'vm-picker-list';
    _vmDom.pickerList = list;
    box.appendChild(list);

    var foot = document.createElement('div');
    foot.className = 'vm-picker-foot';

    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'vm-picker-link';
    createBtn.textContent = '\uff0b Opret ny vare i Grocy';
    createBtn.addEventListener('click', function() {
        window.open('/kitchen/stock.html?tab=create', '_blank', 'noopener');
    });
    foot.appendChild(createBtn);

    var noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'vm-picker-link vm-picker-link-dim';
    noteBtn.textContent = 'Not\u00e9r vare uden lager';
    noteBtn.title = 'Til varer der ikke findes i Grocy. Registreres p\u00e5 modtagelsen, men l\u00e6gges ikke p\u00e5 lager.';
    noteBtn.addEventListener('click', _vmAddNoteItem);
    foot.appendChild(noteBtn);

    box.appendChild(foot);

    _vmRenderPickerListInto(list);
    return box;
}

function _vmSubmitCode() {
    // Elementet slås op i DOM'en frem for i _vmDom: panelet bygges om ved hver
    // render, og en gemt reference kan pege på et felt der ikke længere er på
    // skærmen. Så ville brugerens tal stå ét sted og handleren læse et andet
    // — tavst, som om intet var tastet.
    var el = _vmContainer
        ? _vmContainer.querySelector('.vm-picker-code')
        : document.querySelector('.vm-picker-code');
    var msg = _vmContainer
        ? _vmContainer.querySelector('.vm-picker-codemsg')
        : document.querySelector('.vm-picker-codemsg');
    if (!el) return;
    var q = el.value.trim();
    if (!q) return;

    var hit = _vmLookupCode(q);
    if (!hit) {
        // Vi gætter ALDRIG på en vare ud fra en ukendt kode, og vi skriver
        // ikke koden ind i Grocy: stregkodefeltet bruges til varenumre, og
        // en fremmed kode derinde ville forurene leverandør-listerne.
        if (msg) {
            msg.className = 'vm-picker-codemsg vm-picker-codemsg-warn';
            msg.textContent = '\u26a0 Ukendt nummer \u2014 s\u00f8g varen frem nedenfor.';
        }
        if (_vmDom.pickerSearch) _vmDom.pickerSearch.focus();
        return;
    }
    if (_vmOnList(hit.pid)) {
        if (msg) {
            msg.className = 'vm-picker-codemsg';
            msg.textContent = (_vmProductNames[hit.pid] || '') + ' st\u00e5r allerede p\u00e5 listen.';
        }
        el.value = '';
        return;
    }
    _vmAddProduct(hit.pid, hit.varenr);
    el.value = '';
    _vmRenderLagerContent();
    _vmUpdateSummary();
    _vmUpdateBtn();
}

function _vmRenderPickerList() {
    if (_vmDom.pickerList) _vmRenderPickerListInto(_vmDom.pickerList);
}

function _vmRenderPickerListInto(list) {
    list.innerHTML = '';
    var q = (_vmPicker && _vmPicker.query ? _vmPicker.query : '').trim().toLowerCase();

    var cands = _vmCandidateIds(_vmState.supplierKey);
    var candSet = {};
    for (var c = 0; c < cands.length; c++) candSet[cands[c]] = true;

    // Leverandørens egne varer først. Uden søgning vises KUN dem — det er
    // dem der plejer at komme, og en liste over alle 181 varer er ikke et
    // svar på "hvad kom der i dag".
    var ids = Object.keys(_vmProductById).filter(function(pid) {
        if (_vmOnList(pid)) return false;
        var navn = (_vmProductNames[pid] || '').toLowerCase();
        if (q) return navn.indexOf(q) >= 0;
        return !!candSet[pid];
    });

    ids.sort(function(a, b) {
        var ca = candSet[a] ? 0 : 1, cb = candSet[b] ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return (_vmProductNames[a] || '').localeCompare(_vmProductNames[b] || '', 'da');
    });

    if (!ids.length) {
        var empty = document.createElement('div');
        empty.className = 'vm-picker-empty';
        empty.textContent = q
            ? 'Ingen varer matcher \u201c' + q + '\u201d.'
            : (cands.length
                ? 'Alle leverand\u00f8rens varer er allerede p\u00e5 listen.'
                : 'Denne leverand\u00f8r har ingen koblede varenumre endnu \u2014 s\u00f8g varen frem.');
        list.appendChild(empty);
        return;
    }

    var vist = ids.slice(0, 80);
    for (var i = 0; i < vist.length; i++) {
        (function(pid) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'vm-picker-item';

            var name = document.createElement('span');
            name.className = 'vm-picker-item-name';
            name.textContent = _vmProductNames[pid] || ('#' + pid);
            row.appendChild(name);

            if (!candSet[pid]) {
                var tag = document.createElement('span');
                tag.className = 'vm-picker-item-tag';
                tag.textContent = 'anden leverand\u00f8r';
                row.appendChild(tag);
            }

            // Mangler varen en pris, siges det HER — så man kan tage stilling
            // mens man står med kassen, i stedet for at opdage det i en rapport.
            var pi = _vmPriceInfo(pid);
            if (pi && pi.price == null) {
                var warn = document.createElement('span');
                warn.className = 'vm-picker-item-nopris';
                warn.textContent = 'ingen pris';
                warn.title = pi.reason_text || '';
                row.appendChild(warn);
            }

            row.addEventListener('click', function() {
                _vmAddProduct(pid, null);
                _vmRenderLagerContent();
                _vmUpdateSummary();
                _vmUpdateBtn();
            });
            list.appendChild(row);
        })(vist[i]);
    }

    if (ids.length > vist.length) {
        var more = document.createElement('div');
        more.className = 'vm-picker-empty';
        more.textContent = '\u2026 og ' + (ids.length - vist.length) + ' mere \u2014 skriv mere i s\u00f8gefeltet.';
        list.appendChild(more);
    }
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
                // §14.4: hvert felt som sin egen post. Serveren summerer med
                // SINE egne omregninger — factor_used følger med som det der
                // gjaldt på tastetidspunktet, ikke som noget serveren stoler på.
                entries: (item.entries && item.entries.length) ? item.entries : null,
                status: item.status,
                notes: item.notes || null,
                shopping_list_id: item.slIds && item.slIds.length > 0 ? item.slIds[0] : null,
                // #657: serveren tager prisen fra det bestilte varenummer. Er der
                // bestilt flere forskellige (pose + spand), kendes prisen ikke.
                ordered_varenrs: item.varenrs && item.varenrs.length ? item.varenrs : null,
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
            // Hvilken vare blev målt? Serveren nulstiller det alligevel når
            // toggle er slået fra — men vi sender ikke noget vi ved er tomt.
            temperature_cool_product: _vmState.koelEnabled ? (_vmState.koelProduct || null) : null,

            temperature_frozen_enabled: _vmState.frysEnabled,
            temperature_frozen_value: _vmState.frysEnabled ? _vmState.frysValue : null,
            temperature_frozen_ok: _vmState.frysEnabled
                ? (_vmState.frysStatus === 'action' ? false : _vmState.frysStatus != null)
                : null,
            temperature_frozen_product: _vmState.frysEnabled ? (_vmState.frysProduct || null) : null,

            date_check_ok: _vmState.dateCheck,
            labeling_check_ok: _vmState.labelCheck,
            packaging_check_ok: _vmState.packCheck,

            has_deviation: _vmState.hasDeviation,
            deviation_type: _vmState.hasDeviation ? _vmState.deviationType : null,
            deviation_note: _vmState.hasDeviation ? _vmState.deviationNote : null,

            photo_path: _vmState.photoPath,
            notes: _vmState.notes || null,
            items: items,

            // Felter tavlen har i skemaet, som Bon v2 ikke har en kolonne til.
            // Serveren filtrerer dem mod skemaet igen — vi sender bare det
            // brugeren har udfyldt.
            extra_fields: _vmExtra,

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
    //
    // Ordlyden siger AFSENDT, ikke modtaget: kaldet er fire-and-forget (en
    // modtagelse m\u00e5 ikke blokeres af et eksternt kald), s\u00e5 p\u00e5 det her tidspunkt
    // ved vi kun at vi fors\u00f8gte. Om Whiteboard tog imod, st\u00e5r i Modtagelseslogen
    // bagefter \u2014 den l\u00e6ser whiteboard_synced_at, som kun s\u00e6ttes ved 2xx.
    // At skrive "Sendt" her ville v\u00e6re samme slags p\u00e5stand som #363 selv.
    var wb = result.whiteboard || {};
    if (wb.configured) {
        details.push('\ud83d\udd17 Sendt afsted til Whiteboards FVST-log \u2014 se status i \ud83d\uddc2 Modtagelseslog');
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
    // Temperaturen og varen den blev målt på hører sammen. Står de hver for
    // sig, kan man ikke se hvilken måling der gælder hvad — og så er
    // produktfeltet skrivbart uden at være læsbart bagefter.
    rows.push(['Køl',  r.temperature_cool_enabled
        ? _vmNum(r.temperature_cool_value) + ' °C'
          + (r.temperature_cool_ok === 0 ? '  ⚠ over grænsen' : '')
          + (r.temperature_cool_product ? '  ·  målt på ' + r.temperature_cool_product : '')
        : 'Ikke relevant']);
    rows.push(['Frys', r.temperature_frozen_enabled
        ? _vmNum(r.temperature_frozen_value) + ' °C'
          + (r.temperature_frozen_ok === 0 ? '  ⚠ over grænsen' : '')
          + (r.temperature_frozen_product ? '  ·  målt på ' + r.temperature_frozen_product : '')
        : 'Ikke relevant']);
    rows.push(['Dato/holdbarhed', r.date_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    rows.push(['Mærkning',        r.labeling_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    rows.push(['Emballage',       r.packaging_check_ok ? 'Kontrolleret' : '⚠ Ikke i orden']);
    if (r.has_deviation) {
        rows.push(['Afvigelse', _vmDeviationLabel(r.deviation_type)]);
        if (r.deviation_note) rows.push(['Bemærkning', r.deviation_note]);
    }

    // Felter tavlen har tilføjet efter Bon v2 blev bygget. De har ingen fast
    // plads i visningen — men de blev udfyldt, så de skal kunne læses.
    if (r.extra_fields_json) {
        try {
            var extra = JSON.parse(r.extra_fields_json) || {};
            Object.keys(extra).forEach(function(k) {
                var v = extra[k];
                if (v === true) v = 'Ja';
                else if (v === false) v = 'Nej';
                rows.push([_vmExtraLabel(k), String(v)]);
            });
        } catch (e) { /* ulæselig JSON må ikke vælte hele detaljevisningen */ }
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

/**
 * Pænt navn på et skema-felt Bon v2 ikke selv kender.
 *
 * Slås op i det skema der er hentet nu. Er feltet siden fjernet i tavlens
 * admin, viser vi felt-id'et — en gammel registrering skal stadig kunne
 * læses, også når skemaet er gået videre.
 */
function _vmExtraLabel(id) {
    var f = _vmFields[id];
    return (f && f.label) ? f.label : id;
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
