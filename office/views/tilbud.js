/**
 * office/views/tilbud.js — Tilbudsliste + 5-trins wizard
 *
 * Exported: initTilbud(container, opts), cleanupTilbud(), _tilbudHandleSSE(event, data)
 */

/* ── State ───────────────────────────────────────────── */

let _tC = null;          // container
let _tOpts = {};
let _tMode = 'list';     // 'list' | 'wizard'
let _tQuoteId = null;    // null = ny, number = eksisterende
let _tStep = 0;
let _tTpl = null;        // 'event' | 'single'
let _tCust = null;       // { customer_id, company_id, customer_name, ... }
let _tEvBlk = {};        // { blockId: [items] }
let _tSiItems = [];      // items for single template
let _tActBlk = new Set();
let _tColBlk = new Set();
let _tColCat = new Set();   // foldbare kategorier i Sammensæt: 'cat' (single) eller 'bid::cat' (event)
let _tDel = { type: null, price: 0, note: '', free: false };
let _tMaxStep = 0;       // højeste besøgte step (alle klikbare op til denne)
let _tPriceMode = 'total';
let _tDiscountPct = 0;
let _tShowDB = false;
let _tPriceCat = 'catering';
let _tMenu = null;       // { 'Kategori': [items] }
let _tQuoteNumber = '';
let _tQuoteStatus = null; // 'draft' | 'sent' | 'won' | 'lost' | 'expired'
let _tKS = null;         // KundeSoeg instance
let _tListFilter = 'all';
let _tDeliveryAddressId = null;
let _tLogoB64 = null;    // loaded async from assets/logo-b64.txt

// Form fields (step 1)
let _tDeliveryDate = '';
let _tDeliveryTime = '';
let _tPickupTime = '';
let _tPax = '';
let _tTotalUnits = '';
let _tDeliveryType = 'delivery';
let _tDeliveryAddress = '';
let _tDeliveryNotes = '';
let _tDeliveryMethod = '';
let _tDayContactName = '';
let _tDayContactPhone = '';
let _tPaymentType = '';
let _tCustomerWishes = '';
let _tInvoiceInfo = '';
let _tKitchenInfo = '';
let _tInternalNotes = '';
let _tOfferNote = '';
let _tBlockMeta = {};    // { blockKey: { pax: N } }
let _tValidDays = 30;

// Block types + company info — loaded from settings, cached in module scope
let _tBLOCKS = [];
let _tCompany = { name: 'Ristet Rug', cvr: '', address: '', phone: '', email: 'info@ristetrug.dk' };
// { kategorinavn: 'last' | 'hidden' } — se migration 143. Kun visning på tilbuddet;
// priser og de gemte linjer er upåvirkede.
let _tCatDisplay = {};

// Default block icons (matched by key prefix)
const _tBLOCK_ICONS = { morning: '\u{1F305}', amsnack: '\u2615', lunch: '\u{1F37D}\uFE0F', pmsnack: '\u{1F36A}' };
const _tBLOCK_COLORS = { morning: 'morning', amsnack: 'amsnack', lunch: 'lunch', pmsnack: 'pmsnack' };
const _tDEFAULT_ICON = '\u{1F4CB}';
const _tDEFAULT_COLOR = 'morning'; // fallback color class

const _tCAT_ORDER = ['Sandwich','Salat','Kager','Slider','Drikke','Burger','Frugt'];

const _tSTATUS = {
    draft:    { label: 'Kladde',     color: '#8a8580' },
    sent:     { label: 'Sendt',      color: '#7594b3' },
    won:      { label: 'Vundet',     color: '#6ab04c' },
    lost:     { label: 'Tabt',       color: '#bc181b' },
    expired:  { label: 'Udl\u00f8bet',    color: '#d7d1ca' },
};

/* ── Helpers ──────────────────────────────────────────── */

function _tFk(n) { return Math.round(n).toLocaleString('da-DK') + ' kr'; }
function _tFd(d) { return new Date(d + 'T00:00:00').toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' }); }
function _tEsc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function _tSortedCats() {
    if (!_tMenu) return [];
    // Naturlig sortering: kategorier med tal-prefix (01, 02, ...) sorteres numerisk først.
    // Kategorier uden prefix faldback til _tCAT_ORDER (bagudkompatibilitet).
    return Object.keys(_tMenu).sort((a, b) => {
        const numA = a.match(/^(\d+)/);
        const numB = b.match(/^(\d+)/);
        if (numA && numB) return parseInt(numA[1]) - parseInt(numB[1]);
        if (numA) return -1;
        if (numB) return 1;
        const ai = _tCAT_ORDER.indexOf(a), bi = _tCAT_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

// ms: en besked der remser varenavne op skal have tid til at blive læst.
function _tToast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'tilbud-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
}

/* ── Init / Cleanup ──────────────────────────────────── */

async function initTilbud(container, opts) {
    _tC = container;
    _tOpts = opts || {};
    _tMode = 'list';
    _tListFilter = 'all';

    if (!_tLogoB64) {
        fetch('/assets/logo-b64.txt').then(r => r.text()).then(t => { _tLogoB64 = t.trim(); }).catch(() => {});
    }

    // Blok-typer og kategori-visning hentes HVER gang viewet åbnes, og der
    // ventes på dem før noget renderes.
    //
    // Før lå de bag et `_tBlocksLoaded`-flag og blev kaldt fire-and-forget. Det
    // gav to fejl på én gang: en ændring i Settings (blok-rækkefølge, "emballage
    // nederst") slog først igennem efter en hård genindlæsning af hele office —
    // så det lignede at indstillingen ikke virkede — og et deep-link til et
    // tilbud kunne nå at rendere med default-blokkene før svaret var hjemme.
    //
    // Reglerne bruges ved VISNING, så de gælder også eksisterende tilbud; der
    // skal intet gemmes for at få dem til at slå igennem.
    await _tLoadBlockTypes();

    // Deep link: ?customer=ID → new wizard with customer pre-loaded
    if (_tOpts.customer_id) {
        _tResetWizard();
        _tMode = 'wizard';
        // Pre-load customer after menu is loaded
        _tLoadMenuAndRender().then(() => {
            _tPreloadCustomer(_tOpts.customer_id);
        });
        return;
    }

    // Deep link: ?id=QUOTE_ID → open existing quote
    if (_tOpts.id) {
        _tOpenQuote(parseInt(_tOpts.id));
        return;
    }

    _tRenderList();
}

function cleanupTilbud() {
    _tC = null;
    _tKS = null;
    _tMenu = null;
}

async function _tLoadBlockTypes() {
    try {
        const settings = await apiFetch('/settings');
        const raw = settings.find(s => s.key === 'offer_block_types');
        if (raw) {
            const arr = JSON.parse(raw.value);
            // Dublet-nøgler filtreres fra. Nøglen er blokkens identitet — to
            // ens ville dele `_tEvBlk[id]` og rendere det samme indhold to
            // gange. Settings blokerer det ved gem, men data der allerede
            // ligger sådan skal ikke kunne vælte et tilbud.
            const seen = new Set();
            _tBLOCKS = arr
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                .filter(b => { if (!b?.key || seen.has(b.key)) return false; seen.add(b.key); return true; })
                .map(b => ({
                    id: b.key,
                    label: b.label,
                    icon: _tBLOCK_ICONS[b.key] || _tDEFAULT_ICON,
                    color: _tBLOCK_COLORS[b.key] || _tDEFAULT_COLOR,
                }));
        }
        // Visningsregler pr. varekategori på kundens tilbud (migration 143)
        const cd = settings.find(s => s.key === 'offer_category_display');
        if (cd?.value) {
            try {
                const parsed = JSON.parse(cd.value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) _tCatDisplay = parsed;
            } catch (_) { /* ugyldig JSON → alt vises som hidtil */ }
        }

        // Company info
        const sv = (key, fallback) => { const s = settings.find(x => x.key === key); return s ? s.value : fallback; };
        _tCompany = {
            name: sv('company_name', 'Ristet Rug'),
            cvr: sv('company_cvr', ''),
            address: sv('company_address', ''),
            phone: sv('company_phone', ''),
            email: sv('company_email', 'info@ristetrug.dk'),
        };
    } catch (_) {}
    if (!_tBLOCKS.length) {
        _tBLOCKS = [
            { id: 'morning', label: 'Morgenmad', icon: '\u{1F305}', color: 'morning' },
            { id: 'amsnack', label: 'Formiddagssnack', icon: '\u2615', color: 'amsnack' },
            { id: 'lunch', label: 'Frokost', icon: '\u{1F37D}\uFE0F', color: 'lunch' },
            { id: 'pmsnack', label: 'Eftermiddagssnack', icon: '\u{1F36A}', color: 'pmsnack' },
        ];
    }
}

function _tilbudHandleSSE(event, data) {
    if (!_tC) return;
    // Backend sender bon_*-events efter Patch F (maj 2026).
    // Patch I (maj 2026) skifter frontend fra quote_* til bon_*.
    // Re-render altid i list-mode — _tRenderList henter /api/quotes som
    // selv filtrerer på is_offer=1. Convert-flow sender is_offer=false,
    // hvilket vi også vil re-rendere så bonen forsvinder fra listen.
    if (event === 'bon_created' || event === 'bon_updated') {
        if (_tMode === 'list') _tRenderList();
    }
}

/* ── Menu loading ────────────────────────────────────── */

/**
 * Giv de indlæste varer deres rigtige kategori fra Grocy.
 *
 * `bon_lines.category` blev aldrig gemt fra tilbudsmodulet før nu, så alle
 * eksisterende tilbud har NULL eller tidsblokken ("lunch") stående i feltet.
 * Emballage-reglen matcher på kategorien og kunne derfor ikke virke på dem:
 * "Salat boks (emballage)" lå spredt mellem maden på et gammelt tilbud, uanset
 * hvad der stod i Settings.
 *
 * Linjen kender sin opskrift, og Grocy kender opskriftens kategori — så den
 * kan udledes i stedet for at skulle backfilles i databasen. Grocy er kilden;
 * derfor overskrives feltet også når det HAR en værdi (den er i praksis
 * blok-navnet på gamle tilbud). Fritekst har ingen opskrift og røres ikke.
 *
 * Gemmes tilbuddet igen, skrives den rigtige kategori nu med til `bon_lines`.
 */
/**
 * Menuen slået op på opskrift-id. Ét sted, fordi flere ting har brug for at
 * spørge Grocy "hvad hedder og koster den her vare NU?" — kategori-opslaget
 * ved indlæsning og pris-opslaget ved kopiering af en tidligere ordre.
 *
 * `_tMenu` er bygget for den gældende priskategori (`_tPriceCat`) og hentes
 * forfra når kategorien skiftes, så priserne herfra er altid de rigtige.
 */
/**
 * Mærke på en linje hvis prisen IKKE kunne hentes frisk fra Grocy — fritekst
 * uden opskrift, eller en opskrift der er udgået. Vises kun i pristabellen på
 * trin 3, som er den interne visning. Kundens preview og PDF er urørt: dér skal
 * der ikke stå forbehold om vores egne priser.
 */
function _tStaleMark(it) {
    if (!it?.stalePrice) return '';
    return ' <span title="Opskriften findes ikke i Grocy længere — prisen er den gamle ordres. Fritekst-linjer markeres ikke; deres pris er skrevet i hånden."'
         + ' style="color:#b8860b;font-size:.8rem;cursor:help">⚠</span>';
}

function _tMenuIndex() {
    const byId = new Map();
    if (!_tMenu) return byId;
    Object.values(_tMenu).flat().forEach(p => { if (p.grocy_recipe_id) byId.set(p.grocy_recipe_id, p); });
    return byId;
}

function _tApplyMenuCategories() {
    if (!_tMenu) return;
    const menu = _tMenuIndex();

    const fix = arr => (arr || []).forEach(it => {
        if (!it.grocy_recipe_id) return;
        const m = menu.get(it.grocy_recipe_id);
        if (m?.category) it.category = m.category;
    });

    Object.values(_tEvBlk).forEach(fix);
    fix(_tSiItems);
}

async function _tLoadMenuAndRender() {
    if (_tMenu) { _tApplyMenuCategories(); _tRenderWizard(); return; }
    try {
        const recipes = await apiFetch('/grocy/recipes');
        _tMenu = {};
        for (const r of recipes) {
            // Spring leveringsopskrifter over \u2014 h\u00e5ndteres via bons.delivery_method/delivery_price.
            // Ellers dobbeltt\u00e6lles levering hvis kunden v\u00e6lger fra menuen OG der s\u00e6ttes delivery_price.
            if (r.category === 'x-Levering') continue;

            const cat = r.category || '\u00d8vrige';
            if (!_tMenu[cat]) _tMenu[cat] = [];
            _tMenu[cat].push({
                id: r.id,
                grocy_recipe_id: r.id,
                name: r.name,
                // Kategorien var kun n\u00f8glen i _tMenu, ikke en egenskab p\u00e5 varen.
                // Derfor kom den aldrig med i bon_lines.category ved gem \u2014 og
                // d\u00e9t felt er hvad enheds-t\u00e6llingen matcher mod.
                category: cat,
                unit: r.unit || 'stk',
                unitPrice: r.prices?.[_tPriceCat] ?? r.prices?.catering ?? 0,
                costPrice: r.cost_price ?? 0,
            });
        }
    } catch (e) {
        _tC.innerHTML = '<div class="tilbud-empty"><div class="icon">!</div><p>Kunne ikke hente menuen fra Grocy.</p></div>';
        return;
    }
    _tApplyMenuCategories();
    _tRenderWizard();
}

async function _tPreloadCustomer(customerId) {
    try {
        const custs = await apiFetch('/customers?q=');
        const c = custs.find(x => x.id === customerId);
        if (c && _tKS) {
            _tKS.select(c);
        }
    } catch (_) {}
}

/* ── Liste ───────────────────────────────────────────── */

async function _tRenderList() {
    if (!_tC) return;
    _tMode = 'list';

    let quotes = [];
    try {
        const params = _tListFilter !== 'all' ? { status: _tListFilter } : {};
        quotes = await fetchQuotes(params);
    } catch (e) {
        _tC.innerHTML = '<div class="tilbud-empty"><p>Fejl ved hentning af tilbud.</p></div>';
        return;
    }

    // Badge
    const badge = document.getElementById('quotes-badge');
    if (badge) {
        const draftCount = quotes.filter(q => q.status === 'draft').length;
        if (draftCount > 0 || _tListFilter === 'all') {
            // Re-fetch all for badge count if we have a filter active
            try {
                const all = _tListFilter !== 'all' ? await fetchQuotes({}) : quotes;
                const dc = all.filter(q => q.status === 'draft').length;
                badge.textContent = dc;
                badge.style.display = dc > 0 ? '' : 'none';
            } catch (_) {}
        }
    }

    const filters = ['all', 'draft', 'sent', 'won', 'lost'];
    const filterLabels = { all: 'Alle', draft: 'Kladder', sent: 'Sendt', won: 'Vundet', lost: 'Tabt' };

    let h = `
        <div style="padding: 24px;">
            <div class="tilbud-header">
                <h2>Tilbud</h2>
                <button class="tilbud-btn tilbud-btn-primary" onclick="_tNewQuote()">+ Nyt tilbud</button>
            </div>
            <div class="tilbud-filters">
                ${filters.map(f => `<button class="tilbud-filter ${_tListFilter === f ? 'active' : ''}" onclick="_tSetFilter('${f}')">${filterLabels[f]}</button>`).join('')}
            </div>`;

    if (!quotes.length) {
        h += `<div class="tilbud-empty">
            <div class="icon">\u{1F4CB}</div>
            <p>${_tListFilter === 'all' ? 'Ingen tilbud endnu.' : 'Ingen tilbud med denne status.'}</p>
            <button class="tilbud-btn tilbud-btn-primary" onclick="_tNewQuote()">+ Opret dit f\u00f8rste tilbud</button>
        </div>`;
    } else {
        h += `<table class="tilbud-table">
            <thead><tr><th>Nr.</th><th>Kunde</th><th>Dato</th><th>Levering</th><th class="r">Pax</th><th class="r">Pris</th><th>Status</th></tr></thead>
            <tbody>`;
        for (const q of quotes) {
            const s = _tSTATUS[q.status] || _tSTATUS.draft;
            h += `<tr onclick="_tOpenQuote(${q.id})">
                <td class="mono"><strong>${_tEsc(q.quote_number)}</strong></td>
                <td>${_tEsc(q.company_name || q.customer_name || '\u2014')}</td>
                <td>${q.quote_date ? _tFd(q.quote_date) : '\u2014'}</td>
                <td>${q.delivery_date ? _tFd(q.delivery_date) : '\u2014'}</td>
                <td class="r">${q.pax || '\u2014'}</td>
                <td class="r mono">${q.total_price != null ? _tFk(q.total_price) : '\u2014'}</td>
                <td><span class="tilbud-status" style="background:${s.color}20;color:${s.color}">${s.label}</span></td>
            </tr>`;
        }
        h += '</tbody></table>';
    }
    h += '</div>';
    _tC.innerHTML = h;
}

function _tSetFilter(f) {
    _tListFilter = f;
    _tRenderList();
}

function _tNewQuote() {
    _tResetWizard();
    _tMenu = null; // force reload for fresh prices
    _tMode = 'wizard';
    _tLoadMenuAndRender();
}

async function _tOpenQuote(id) {
    try {
        const q = await fetchQuote(id);
        _tResetWizard();
        _tQuoteId = q.id;
        _tQuoteNumber = q.quote_number;
        _tQuoteStatus = q.status || 'draft';
        _tTpl = q.template;
        _tPriceCat = q.price_category || 'catering';
        _tPriceMode = q.price_mode || 'total';
        _tDiscountPct = q.discount_percent || 0;
        _tDeliveryDate = q.delivery_date || '';
        _tDeliveryTime = q.delivery_time || '';
        _tPickupTime = q.pickup_time || '';
        _tPax = q.pax ? String(q.pax) : '';
        _tTotalUnits = q.total_units ? String(q.total_units) : '';
        _tDeliveryType = q.delivery_type || 'delivery';
        _tDeliveryAddressId = q.delivery_address_id;
        _tDeliveryAddress = q.delivery_address || '';
        _tDeliveryNotes = q.delivery_note || '';
        _tDeliveryMethod = q.delivery_method || '';
        _tDayContactName = q.day_contact_name || '';
        _tDayContactPhone = q.day_contact_phone || '';
        _tPaymentType = q.payment_type || '';
        _tCustomerWishes = q.customer_wishes || '';
        _tInvoiceInfo = q.invoice_info || '';
        _tKitchenInfo = q.kitchen_info || '';
        _tInternalNotes = q.notes || '';
        _tOfferNote = q.offer_note || '';
        _tBlockMeta = q.offer_block_metadata || {};
        _tValidDays = 30;
        _tDel = {
            type: q.delivery_price > 0 ? 'custom' : null,
            price: q.delivery_price || 0,
            note: q.delivery_note || '',
            free: false,
        };

        if (q.valid_until && q.quote_date) {
            const diff = (new Date(q.valid_until) - new Date(q.quote_date)) / (1000 * 60 * 60 * 24);
            _tValidDays = Math.round(diff) || 30;
        }

        // Load customer info
        if (q.customer_id) {
            _tCust = {
                customer_id: q.customer_id,
                company_id: q.company_id,
                customer_name: q.customer_name,
                company_name: q.company_name,
                email: q.customer_email,
                phone: q.customer_phone,
            };
        }

        // Load lines into blocks/items
        if (q.lines) {
            for (const l of q.lines) {
                const item = {
                    id: l.grocy_recipe_id || Date.now() + Math.random(),
                    grocy_recipe_id: l.grocy_recipe_id,
                    name: l.product_name,
                    unit: l.unit || 'stk',
                    unitPrice: l.unit_price ?? 0,
                    costPrice: l.cost_price ?? 0,
                    qty: l.quantity || 1,
                    // Varens egen kategori — ikke tidsblokken. `block_type` er
                    // null på enkeltbestillinger, så hver eneste vare endte som
                    // "Ukendt" i preview og PDF efter en genindlæsning.
                    category: l.category || l.block_type || 'Ukendt',
                };
                if (_tTpl === 'event' && l.block_type) {
                    if (!_tEvBlk[l.block_type]) _tEvBlk[l.block_type] = [];
                    _tActBlk.add(l.block_type);
                    _tEvBlk[l.block_type].push(item);
                } else {
                    _tSiItems.push(item);
                }
            }
        }

        // Efter linjerne: slukkede blokke får deres gemte indhold tilbage.
        // Rækkefølgen betyder noget — _tActBlk skal være fyldt af linjerne først,
        // så en blok der ER tændt ikke får overskrevet sit rigtige indhold.
        _tRestoreBlockStash();

        _tMode = 'wizard';
        _tStep = 0;
        _tMaxStep = 4; // eksisterende tilbud: alle steps klikbare
        _tMenu = null; // force reload with correct price_category
        _tLoadMenuAndRender();
    } catch (e) {
        _tToast('Fejl: ' + e.message);
    }
}

function _tResetWizard() {
    _tQuoteId = null;
    _tQuoteNumber = '';
    _tQuoteStatus = null;
    _tStep = 0;
    _tMaxStep = 0;
    _tTpl = null;
    _tCust = null;
    _tEvBlk = {};
    _tSiItems = [];
    _tActBlk = new Set();
    _tColBlk = new Set();
    _tColCat = new Set();
    _tDel = { type: null, price: 0, note: '', free: false };
    _tPriceMode = 'total';
    _tDiscountPct = 0;
    _tShowDB = false;
    _tPriceCat = 'catering';
    _tKS = null;
    _tDeliveryAddressId = null;
    _tDeliveryDate = '';
    _tDeliveryTime = '';
    _tPickupTime = '';
    _tPax = '';
    _tTotalUnits = '';
    _tDeliveryType = 'delivery';
    _tDeliveryAddress = '';
    _tDeliveryNotes = '';
    _tDeliveryMethod = '';
    _tDayContactName = '';
    _tDayContactPhone = '';
    _tPaymentType = '';
    _tCustomerWishes = '';
    _tInvoiceInfo = '';
    _tKitchenInfo = '';
    _tInternalNotes = '';
    _tOfferNote = '';
    _tBlockMeta = {};
    _tValidDays = 30;
}

/* ── Wizard shell ────────────────────────────────────── */

function _tRenderWizard() {
    if (!_tC) return;
    const steps = ['Skabelon', 'Kunde', 'Sammens\u00e6t', 'Priser', 'Preview'];
    let h = `<div class="tilbud-wizard">
        <div style="padding:12px 24px 0;display:flex;align-items:center;gap:12px">
            <button class="tilbud-btn tilbud-btn-ghost tilbud-btn-sm" onclick="_tBackToList()">\u2190 Tilbage</button>
            <span style="font-size:.85rem;color:var(--color-text-dim)">${_tQuoteNumber ? 'Tilbud ' + _tEsc(_tQuoteNumber) : 'Nyt tilbud'}</span>
        </div>
        <div class="tilbud-steps">`;
    steps.forEach((s, i) => {
        const cls = i === _tStep ? 'active' : (i <= _tMaxStep ? 'done' : '');
        h += `<div class="tilbud-step-ind ${cls}" onclick="_tGoTo(${i})" style="${i > _tMaxStep ? 'opacity:.4;cursor:default' : ''}"><span class="tilbud-step-num">${i + 1}</span>${s}</div>`;
    });
    h += '</div><div class="tilbud-step-content">';

    if (_tStep === 0) h += _tBuildStep0();
    else if (_tStep === 1) h += _tBuildStep1();
    else if (_tStep === 2) h += _tBuildStep2();
    else if (_tStep === 3) h += _tBuildStep3();
    else if (_tStep === 4) h += _tBuildStep4();

    h += '</div></div>';
    _tC.innerHTML = h;

    // Post-render setup
    if (_tStep === 1) _tSetupStep1();
    if (_tStep === 2) _tSetupStep2();
}

function _tGoTo(n) { if (n <= _tMaxStep) { _tSaveStepFields(); _tStep = n; _tRenderWizard(); } }
function _tNext() {
    if (_tStep === 0 && !_tTpl) return;
    _tSaveStepFields();
    if (_tStep < 4) { _tStep++; if (_tStep > _tMaxStep) _tMaxStep = _tStep; _tRenderWizard(); }
}
function _tPrev() { if (_tStep > 0) { _tSaveStepFields(); _tStep--; _tRenderWizard(); } }

function _tBackToList() {
    _tMode = 'list';
    _tRenderList();
}

function _tSaveStepFields() {
    // Persist form field values from DOM into state
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    if (_tStep === 1) {
        const dd = v('t-ev-date');     if (dd !== undefined) _tDeliveryDate = dd;
        const dt = v('t-ev-time');     if (dt !== undefined) _tDeliveryTime = dt;
        const px = v('t-ev-pax');      if (px !== undefined) _tPax = px;
        const un = v('t-ev-units');    if (un !== undefined) _tTotalUnits = un;
        const dm = v('t-del-method');  if (dm !== undefined) _tDeliveryMethod = dm;
        const dn = v('t-del-notes');   if (dn !== undefined) _tDeliveryNotes = dn;
        const dc = v('t-day-contact'); if (dc !== undefined) _tDayContactName = dc;
        const dp = v('t-day-phone');   if (dp !== undefined) _tDayContactPhone = dp;
        const pt = v('t-payment');     if (pt !== undefined) _tPaymentType = pt;
        const cw = v('t-cust-wishes'); if (cw !== undefined) _tCustomerWishes = cw;
        const ii = v('t-invoice-info');if (ii !== undefined) _tInvoiceInfo = ii;
        const ki = v('t-kitchen-info');if (ki !== undefined) _tKitchenInfo = ki;
        const in_ = v('t-internal-notes'); if (in_ !== undefined) _tInternalNotes = in_;
        // Pax per blok. Nøglerne opdateres i stedet for at blive bygget forfra —
        // _tBlockMeta bærer også `stash` (indholdet af slukkede blokke), og en
        // nulstilling her ville smide det væk hver gang man forlod trin 1.
        if (_tTpl === 'event') {
            _tBLOCKS.forEach(b => {
                const bpax = v('t-bpax-' + b.id);
                if (bpax === undefined) return;          // feltet var ikke i DOM'en
                const meta = _tBlockMeta[b.id] || {};
                const n = parseInt(bpax);
                if (n > 0) meta.pax = n; else delete meta.pax;
                if (Object.keys(meta).length) _tBlockMeta[b.id] = meta;
                else delete _tBlockMeta[b.id];
            });
        }
    }
    if (_tStep === 3) {
        const dp = v('t-disc-pct');  if (dp !== undefined) _tDiscountPct = parseFloat(dp) || 0;
        const vd = v('t-val-days');  if (vd !== undefined) _tValidDays = parseInt(vd) || 30;
        const on = v('t-offer-note'); if (on !== undefined) _tOfferNote = on;
    }
}

/* ── Step 0: Skabelon ────────────────────────────────── */

function _tBuildStep0() {
    return `
        <h2>V\u00e6lg skabelon</h2><p class="tilbud-step-desc">Hvilken type tilbud?</p>
        <div class="tilbud-tpl-grid">
            <div class="tilbud-tpl-card ${_tTpl === 'event' ? 'selected' : ''}" onclick="_tSelTpl('event')">
                <div class="tilbud-tpl-icon">\u{1F389}</div>
                <div class="tilbud-tpl-name">Event / Catering</div>
                <div class="tilbud-tpl-desc">Tidsblokke med morgen, frokost, snack. Pris pr. pax.</div>
            </div>
            <div class="tilbud-tpl-card ${_tTpl === 'single' ? 'selected' : ''}" onclick="_tSelTpl('single')">
                <div class="tilbud-tpl-icon">\u{1F4E6}</div>
                <div class="tilbud-tpl-name">Enkeltbestilling</div>
                <div class="tilbud-tpl-desc">Sandwich-ordrer, frokostpakker. Samlet pris.</div>
            </div>
        </div>`;
}

function _tSelTpl(t) {
    _tTpl = t;
    // Auto-advance til Kunde-step \u2014 ingen grund til ekstra klik
    _tNext();
}

/* ── Step 1: Kunde ───────────────────────────────────── */

function _tBuildStep1() {
    const timeOpts = _tBuildTimeOptions();
    const delMethodOpts = ['', 'cykel', 'taxa', 'volvo', 'afhentning'].map(v =>
        `<option value="${v}" ${_tDeliveryMethod === v ? 'selected' : ''}>${v ? v.charAt(0).toUpperCase() + v.slice(1) : 'V\u00e6lg...'}</option>`).join('');

    return `
        <h2>Kunde & levering</h2><p class="tilbud-step-desc">Kunde, leveringsinfo og detaljer.</p>

        <!-- KUNDE -->
        <div class="tilbud-options"><div class="tilbud-options-title">Kunde</div>
            <div id="t-kunde-soeg"></div>
            ${_tCust ? `<div style="margin-top:6px;font-size:.82rem;color:var(--color-text-dim)">Valgt: <strong>${_tEsc(_tCust.company_name || _tCust.customer_name || '')}</strong></div>` : ''}
            <div class="tilbud-form-grid" style="margin-top:10px">
                <div class="tilbud-form-group"><label>Dagskontakt</label><input type="text" id="t-day-contact" value="${_tEsc(_tDayContactName)}" placeholder="Kontaktperson p\u00e5 dagen"></div>
                <div class="tilbud-form-group"><label>Telefon</label><input type="tel" id="t-day-phone" value="${_tEsc(_tDayContactPhone)}" placeholder="Telefon"></div>
            </div>
        </div>

        <!-- LEVERING -->
        <div class="tilbud-options"><div class="tilbud-options-title">Levering</div>
            <div class="tilbud-form-grid">
                <div class="tilbud-form-group"><label>Leveringsdato</label><input type="date" id="t-ev-date" value="${_tDeliveryDate}"></div>
                <div class="tilbud-form-group"><label>Leveringstid</label><select id="t-ev-time">${timeOpts.replace(new RegExp(`value="${_tDeliveryTime}"`), `value="${_tDeliveryTime}" selected`)}</select></div>
                <div class="tilbud-form-group"><label>Pax</label><input type="number" id="t-ev-pax" value="${_tPax}" min="0" placeholder="Antal personer"></div>
                <div class="tilbud-form-group"><label>Enheder</label><input type="number" id="t-ev-units" value="${_tTotalUnits}" min="0" placeholder="Total enheder"></div>
            </div>
            ${_tTpl === 'event' && _tBLOCKS.length ? `
            <div style="margin-top:10px">
                <label style="font-size:.74rem;font-weight:600;color:var(--color-text-dim);text-transform:uppercase;letter-spacing:.04em">Pax pr. blok <span style="font-weight:400;text-transform:none;letter-spacing:0">(tom = samlet pax)</span></label>
                <div class="tilbud-form-grid" style="margin-top:6px">
                    ${_tBLOCKS.map(b => `<div class="tilbud-form-group"><label>${_tEsc(b.label)}</label><input type="number" id="t-bpax-${b.id}" value="${_tBlockMeta[b.id]?.pax || ''}" min="0" placeholder="${_tPax || '\u2014'}"></div>`).join('')}
                </div>
            </div>` : ''}
            <div class="tilbud-form-grid" style="margin-top:10px">
                <div class="tilbud-form-group"><label>Leveringstype</label>
                    <select id="t-del-type-sel" onchange="_tDeliveryType=this.value">
                        <option value="delivery" ${_tDeliveryType === 'delivery' ? 'selected' : ''}>Levering</option>
                        <option value="pickup" ${_tDeliveryType === 'pickup' ? 'selected' : ''}>Afhentning</option>
                        <option value="event" ${_tDeliveryType === 'event' ? 'selected' : ''}>Event</option>
                    </select>
                </div>
                <div class="tilbud-form-group"><label>Leveringsmetode</label><select id="t-del-method">${delMethodOpts}</select></div>
            </div>
            <div class="tilbud-form-grid" style="margin-top:10px">
                <div class="tilbud-form-group full tilbud-dawa-wrap">
                    <label>Leveringsadresse</label>
                    <input type="text" id="t-ev-loc" value="${_tEsc(_tDeliveryAddress)}" placeholder="S\u00f8g adresse..." autocomplete="off">
                    <div class="tilbud-dawa-results" id="t-dawa-res"></div>
                </div>
                <div class="tilbud-form-group full"><label>Leveringsinfo</label><input type="text" id="t-del-notes" value="${_tEsc(_tDeliveryNotes)}" placeholder="Etage, port, kode..."></div>
            </div>
        </div>

        <!-- PRISKATEGORI & BETALING -->
        <div class="tilbud-options"><div class="tilbud-options-title">Pris & betaling</div>
            <div class="tilbud-form-grid">
                <div class="tilbud-form-group"><label>Priskategori</label>
                    <select id="t-price-cat" onchange="_tPriceCat=this.value">
                        <option value="catering" ${_tPriceCat === 'catering' ? 'selected' : ''}>Catering</option>
                        <option value="store" ${_tPriceCat === 'store' ? 'selected' : ''}>Butik</option>
                        <option value="festival" ${_tPriceCat === 'festival' ? 'selected' : ''}>Festival</option>
                        <option value="produktion" ${_tPriceCat === 'produktion' ? 'selected' : ''}>Produktion</option>
                        <option value="waiste" ${_tPriceCat === 'waiste' ? 'selected' : ''}>Waiste</option>
                    </select>
                </div>
                <div class="tilbud-form-group"><label>Betaling</label>
                    <select id="t-payment">
                        <option value="" ${!_tPaymentType ? 'selected' : ''}>V\u00e6lg...</option>
                        <option value="invoice" ${_tPaymentType === 'invoice' ? 'selected' : ''}>Faktura</option>
                        <option value="card" ${_tPaymentType === 'card' ? 'selected' : ''}>Kort</option>
                        <option value="mobilepay" ${_tPaymentType === 'mobilepay' ? 'selected' : ''}>MobilePay</option>
                        <option value="cash" ${_tPaymentType === 'cash' ? 'selected' : ''}>Kontant</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- NOTER -->
        <div class="tilbud-options"><div class="tilbud-options-title">Noter</div>
            <div class="tilbud-form-group"><label>Kunde\u00f8nsker</label><textarea id="t-cust-wishes" rows="2" placeholder="Fx 'Ingen svinek\u00f8d, 5 veganske'">${_tEsc(_tCustomerWishes)}</textarea></div>
            <div class="tilbud-form-group"><label>Faktura info</label><textarea id="t-invoice-info" rows="2" placeholder="EAN, faktura-adresse, ref...">${_tEsc(_tInvoiceInfo)}</textarea></div>
            <div class="tilbud-form-group"><label>K\u00f8kken info</label><textarea id="t-kitchen-info" rows="2" placeholder="Intern info til k\u00f8kkenet">${_tEsc(_tKitchenInfo)}</textarea></div>
            <div class="tilbud-form-group"><label>Interne noter</label><textarea id="t-internal-notes" rows="2" placeholder="Interne noter (ses ikke af kunde)">${_tEsc(_tInternalNotes)}</textarea></div>
        </div>

        ${_tCust ? _tBuildOrderHistory() : ''}
        <div class="tilbud-btn-row">
            <button class="tilbud-btn tilbud-btn-secondary" onclick="_tPrev()">\u2190 Tilbage</button>
            <div style="display:flex;gap:8px">
                ${_tSaveBtn()}
                <button class="tilbud-btn tilbud-btn-primary" onclick="_tNext()">N\u00e6ste \u2192</button>
            </div>
        </div>`;
}

function _tBuildTimeOptions() {
    let h = '<option value="">--:--</option>';
    for (let hr = 6; hr <= 22; hr++) {
        for (let m = 0; m < 60; m += 15) {
            const v = String(hr).padStart(2, '0') + ':' + String(m).padStart(2, '0');
            h += `<option value="${v}">${v}</option>`;
        }
    }
    return h;
}

function _tSetupStep1() {
    // KundeSoeg
    const ksEl = document.getElementById('t-kunde-soeg');
    if (ksEl && typeof KundeSoeg !== 'undefined') {
        _tKS = new KundeSoeg({
            container: ksEl,
            onSelect: (data) => {
                _tCust = data;
                if (data && data.customer_id) {
                    _tLoadOrderHistory(data.customer_id);
                }
            }
        });
        // Pre-select if we have a customer
        if (_tCust && _tCust.customer_id) {
            _tKS.selected = _tCust;
            _tKS.state = 'SELECTED';
            _tKS.render();
        }
    }

    // DAWA
    const locInput = document.getElementById('t-ev-loc');
    const dawaRes = document.getElementById('t-dawa-res');
    if (locInput && dawaRes) {
        let dawaTimer = null;
        locInput.addEventListener('input', () => {
            clearTimeout(dawaTimer);
            const q = locInput.value.trim();
            if (q.length < 3) { dawaRes.classList.remove('show'); return; }
            dawaTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`https://api.dataforsyningen.dk/autocomplete?q=${encodeURIComponent(q)}&type=adresse&fuzzy=`);
                    const data = await res.json();
                    if (!data.length) { dawaRes.classList.remove('show'); return; }
                    dawaRes.innerHTML = data.slice(0, 8).map(d =>
                        `<div class="tilbud-dawa-item" data-tekst="${_tEsc(d.tekst)}" data-href="${_tEsc(d.adresse?.href || '')}">${_tEsc(d.tekst)}</div>`
                    ).join('');
                    dawaRes.classList.add('show');
                } catch (_) { dawaRes.classList.remove('show'); }
            }, 250);
        });
        dawaRes.addEventListener('click', async (e) => {
            const item = e.target.closest('.tilbud-dawa-item');
            if (!item) return;
            const tekst = item.dataset.tekst;
            locInput.value = tekst;
            _tDeliveryAddress = tekst;
            dawaRes.classList.remove('show');

            // Save address via API
            try {
                const parts = tekst.split(',');
                const streetParts = (parts[0] || '').trim().split(/\s+/);
                const nr = streetParts.pop() || '';
                const street = streetParts.join(' ');
                const cityParts = (parts[1] || '').trim().split(/\s+/);
                const postal = cityParts.shift() || '';
                const city = cityParts.join(' ');
                const saved = await apiFetch('/addresses', {
                    method: 'POST',
                    body: JSON.stringify({ street_name: street, street_nr: nr, postal_code: postal, city: city })
                });
                _tDeliveryAddressId = saved.id;
            } catch (_) {}
        });
        locInput.addEventListener('blur', () => { setTimeout(() => dawaRes.classList.remove('show'), 200); });
    }
}

/* ── Ordrehistorik ───────────────────────────────────── */

let _tOrderHistory = [];

async function _tLoadOrderHistory(customerId) {
    try {
        _tOrderHistory = await apiFetch(`/crm/customer-orders/${customerId}`);
        const el = document.getElementById('t-oh');
        if (el) el.outerHTML = _tBuildOrderHistory();
    } catch (_) { _tOrderHistory = []; }
}

function _tBuildOrderHistory() {
    if (!_tOrderHistory.length) return '<div id="t-oh"></div>';
    return `<div id="t-oh" class="tilbud-oh show">
        <div class="tilbud-oh-title">Seneste ordrer</div>
        <table class="tilbud-oh-tbl">
            <thead><tr><th>Bon#</th><th>Dato</th><th class="r">Pax</th><th class="r">Pris</th><th></th></tr></thead>
            <tbody>${_tOrderHistory.slice(0, 10).map(o => `
                <tr>
                    <td><strong>${_tEsc(o.bon_number || String(o.id))}</strong></td>
                    <td>${o.delivery_date ? _tFd(o.delivery_date) : '\u2014'}</td>
                    <td class="r">${o.pax || '\u2014'}</td>
                    <td class="r" style="font-family:'JetBrains Mono',monospace">${o.total_price != null ? _tFk(o.total_price) : '\u2014'}</td>
                    <td style="text-align:right"><button class="tilbud-copy-btn" onclick="_tCopyBon(${o.id})">\u{1F4CB} Kopi\u00e9r</button></td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>`;
}

/**
 * Kopiér en tidligere ordre ind i tilbuddet — MÆNGDERNE, ikke priserne. (#428)
 *
 * `bon_lines.unit_price` er et snapshot fra dengang den bon blev oprettet. Det
 * er rigtigt for den gamle bon, men forkert som udgangspunkt for et nyt tilbud:
 * en ordre fra sidste år sendte sidste års priser til kunden, uden varsel. Værre
 * endnu så funktionen slet ikke på `_tPriceCat` — en butiks-bon kopieret ind i
 * et catering-tilbud gav butikspriser, også når ordren var helt frisk.
 *
 * Priser, kostpriser og kategori hentes nu fra `_tMenu`, som er bygget for
 * tilbuddets gældende priskategori. Linjen bærer `grocy_recipe_id`, så opslaget
 * er direkte.
 *
 * Det der IKKE kan slås op — fritekst uden opskrift, og opskrifter der er
 * udgået i Grocy — beholder den gamle pris og markeres `stalePrice`, så det
 * er synligt hvilke tal der ikke er friske. De må ikke lande i stilhed.
 */
async function _tCopyBon(bonId) {
    try {
        const bon = await apiFetch(`/bons/${bonId}`);
        const menu = _tMenuIndex();
        const stale = [];

        _tSiItems = [];
        _tEvBlk = {};
        _tActBlk = new Set();

        if (bon.lines) {
            for (const l of bon.lines) {
                // Fritekst har aldrig haft en Grocy-pris — den er skrevet i hånden
                // og skal kopieres som den er. Den er IKKE "uden aktuel pris":
                // der er intet at hente, og et forbehold ville være ren støj.
                //
                // En vare der HAR en opskrift men ikke findes i menuen, er noget
                // andet: dens pris plejede at komme fra Grocy, og det tal vi nu
                // bærer med er et gammelt snapshot. Dét er værd at sige.
                const isFreeText = !l.grocy_recipe_id;
                const m = isFreeText ? null : menu.get(l.grocy_recipe_id);
                if (!isFreeText && !m) stale.push(l.product_name);

                const item = {
                    id: m ? m.id : (Date.now() + Math.random()),
                    grocy_recipe_id: l.grocy_recipe_id || null,
                    name: l.product_name,
                    unit: m?.unit || l.unit || 'stk',
                    // Grocy er kilden til både pris og kategori — jf. den samlede
                    // kategori-hentning. Kun mængden kommer fra den gamle ordre.
                    unitPrice: m ? m.unitPrice : (l.unit_price ?? 0),
                    costPrice: m ? m.costPrice : (l.cost_price ?? 0),
                    category: m ? m.category : (isFreeText ? 'Fritekst' : (l.category || 'Ukendt')),
                    qty: l.quantity || 1,
                    stalePrice: !isFreeText && !m,
                };

                // `getBonLines` returnerer ikke `block_type`, så en kopieret ordre
                // kan ikke lægges tilbage i sine oprindelige tidsblokke. Alt havner
                // i én blok som hidtil — se #427, som udvider kopieringen.
                if (_tTpl === 'event') {
                    const block = 'lunch';
                    if (!_tEvBlk[block]) _tEvBlk[block] = [];
                    _tActBlk.add(block);
                    _tEvBlk[block].push(item);
                } else {
                    _tSiItems.push(item);
                }
            }
        }

        if (bon.pax) _tPax = String(bon.pax);

        const n = bon.lines?.length || 0;
        const priceCatLabel = _tPriceCat || 'catering';
        let msg = `${n} vare${n === 1 ? '' : 'r'} kopieret fra bon ${bon.bon_number} — priser fra ${priceCatLabel}`;
        if (stale.length) {
            msg += ` · ${stale.length} findes ikke i Grocy længere (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? '…' : ''})`;
        }
        _tToast(msg, stale.length ? 9000 : 4000);

        _tStep = 2;
        _tRenderWizard();
    } catch (e) {
        _tToast('Fejl: ' + e.message);
    }
}

/* ── Step 2: Sammensæt ───────────────────────────────── */

function _tBuildStep2() {
    const isEv = _tTpl === 'event';
    let h = `<h2>Sammens\u00e6t menu</h2><p class="tilbud-step-desc">${isEv ? 'T\u00e6nd tidsblokke og fyld med retter.' : 'V\u00e6lg retter fra menuen.'}</p>`;

    // Customer wishes callout
    if (_tCustomerWishes) {
        h += `<div class="tilbud-wishes"><strong>Kunde \u00f8nsker:</strong> ${_tEsc(_tCustomerWishes)}</div>`;
    }

    // Stats bar
    h += _tBuildStats();

    if (isEv) {
        h += _tBuildEventUI();
    } else {
        h += _tBuildSingleUI();
    }

    h += `<div class="tilbud-btn-row">
        <button class="tilbud-btn tilbud-btn-secondary" onclick="_tPrev()">\u2190 Tilbage</button>
        <div style="display:flex;gap:8px">
            ${_tSaveBtn()}
            <button class="tilbud-btn tilbud-btn-primary" onclick="_tNext()">N\u00e6ste \u2192</button>
        </div>
    </div>`;
    return h;
}

function _tSetupStep2() {
    // Search field listener for single template
    const si = document.getElementById('t-si-search');
    if (si) {
        si.addEventListener('input', () => {
            const q = si.value.toLowerCase();
            document.querySelectorAll('.tilbud-menu-item[data-name]').forEach(el => {
                el.style.display = el.dataset.name.includes(q) ? '' : 'none';
            });
            document.querySelectorAll('.tilbud-cat-title[data-cat]').forEach(el => {
                const items = el.parentElement.querySelectorAll(`.tilbud-menu-item[data-cat="${el.dataset.cat}"]`);
                const vis = Array.from(items).some(i => i.style.display !== 'none');
                el.style.display = vis ? '' : 'none';
            });
        });
    }
}

function _tBuildStats() {
    const isEv = _tTpl === 'event';
    let cnt = 0, sale = 0, cost = 0;
    if (isEv) {
        // Kun tændte blokke. En slukket blok beholder sit indhold (så den kan
        // tændes igen), men indgår hverken i tilbuddet eller i tallene her —
        // ellers ville stribestatistikken modsige pristabellen.
        for (const [bid, items] of Object.entries(_tEvBlk)) {
            if (!_tActBlk.has(bid)) continue;
            items.forEach(it => { cnt += it.qty; sale += it.unitPrice * it.qty; cost += it.costPrice * it.qty; });
        }
    } else {
        _tSiItems.forEach(it => { cnt += it.qty; sale += it.unitPrice * it.qty; cost += it.costPrice * it.qty; });
    }

    let h = '<div class="tilbud-stats">';
    if (isEv) h += `<div class="tilbud-stat"><span class="tilbud-stat-label">Pax:</span><span class="tilbud-stat-value">${parseInt(_tPax) || '\u2014'}</span></div>`;
    h += `<div class="tilbud-stat"><span class="tilbud-stat-label">Valgt:</span><span class="tilbud-stat-value">${cnt}</span></div>`;
    h += `<div class="tilbud-stat"><span class="tilbud-stat-label">Pris:</span><span class="tilbud-stat-value">${_tFk(sale)}</span></div>`;
    if (_tShowDB) {
        const db = sale > 0 ? ((sale - cost) / sale * 100) : 0;
        h += `<div class="tilbud-stat"><span class="tilbud-stat-label">DB%:</span><span class="tilbud-stat-value">${db.toFixed(1)}%</span></div>`;
    }
    h += `<div style="margin-left:auto"><button class="tilbud-btn tilbud-btn-secondary tilbud-btn-sm" onclick="_tShowDB=!_tShowDB;_tRenderWizard()" style="font-size:.7rem">${_tShowDB ? 'Skjul DB' : 'Vis DB'}</button></div>`;
    h += '</div>';
    return h;
}

/**
 * Indholdet af SLUKKEDE blokke lægges i `offer_block_metadata[blok].stash`.
 *
 * En slukket blok er ikke en del af tilbuddet, så dens varer må ikke ligge i
 * `bon_lines` — der ville de tælle med i priser, enheder og pakkeliste, og de
 * ville følge med over i en rigtig bon ved konvertering. Men de skal heller ikke
 * være væk: office slukker en blok for at se tilbuddet uden den, ikke for at
 * kassere en times arbejde.
 *
 * `offer_block_metadata` er allerede en fri JSON-kolonne til blok-metadata
 * (migration 024, bruges til pax pr. blok), så det kræver ingen skemaændring —
 * og alt nedstrøms for tilbuddet er uberørt, fordi bon_lines ser ud præcis som
 * før.
 */
function _tSyncBlockStash() {
    if (_tTpl !== 'event') return;
    _tBLOCKS.forEach(b => {
        const meta = _tBlockMeta[b.id] || {};
        const items = _tEvBlk[b.id] || [];

        if (!_tActBlk.has(b.id) && items.length) {
            meta.stash = items.map(it => ({
                id: it.id,
                grocy_recipe_id: it.grocy_recipe_id ?? null,
                name: it.name,
                unit: it.unit || 'stk',
                category: it.category ?? null,
                unitPrice: it.unitPrice,
                costPrice: it.costPrice,
                qty: it.qty,
            }));
        } else {
            delete meta.stash;   // tændt igen — varerne ligger i bon_lines nu
        }

        if (Object.keys(meta).length) _tBlockMeta[b.id] = meta;
        else delete _tBlockMeta[b.id];
    });
}

/** Læg gemte varer tilbage i deres blok ved indlæsning. Blokken forbliver slukket. */
function _tRestoreBlockStash() {
    for (const [bid, meta] of Object.entries(_tBlockMeta || {})) {
        if (!Array.isArray(meta?.stash) || !meta.stash.length) continue;
        if (_tActBlk.has(bid)) continue;    // blokken er tændt — bon_lines ejer indholdet
        _tEvBlk[bid] = meta.stash.map(s => ({ ...s, qty: s.qty || 1 }));
    }
}

/**
 * Kundens syn på varelisten: skjulte kategorier væk, "nederst"-kategorier bagest.
 *
 * Emballage stod midt imellem maden på tilbuddet og virkede umotiveret — på
 * bon-kortet ligger den allerede dæmpet nederst. Reglerne konfigureres i
 * Settings → Tilbud — opbygning (migration 143).
 *
 * VIGTIGT: dette er kun visning. Kaldere skal beregne beløb på den RÅ liste —
 * en skjult emballagelinje koster stadig det den koster.
 */
function _tOfferItems(items) {
    const rule = it => _tCatDisplay[it.category || ''] || 'show';
    return (items || [])
        .filter(it => rule(it) !== 'hidden')
        .map((it, idx) => ({ it, idx, last: rule(it) === 'last' ? 1 : 0 }))
        .sort((a, b) => a.last - b.last || a.idx - b.idx)   // stabil: bevarer rækkefølgen indbyrdes
        .map(x => x.it);
}

/** Samme regel for kategori-grupperede visninger: skjulte ud, "nederst" bagest. */
function _tOfferCategories(cats) {
    return Object.keys(cats)
        .filter(c => (_tCatDisplay[c] || 'show') !== 'hidden')
        .sort((a, b) => ((_tCatDisplay[a] || '') === 'last' ? 1 : 0) - ((_tCatDisplay[b] || '') === 'last' ? 1 : 0));
}

function _tEffectivePax(blockKey) {
    const meta = _tBlockMeta[blockKey];
    return (meta?.pax > 0) ? meta.pax : (parseInt(_tPax) || 1);
}

function _tBlockLabel(blockKey) {
    const b = _tBLOCKS.find(x => x.id === blockKey);
    return b ? b.label : blockKey;
}

function _tBuildEventUI() {
    let h = '<div class="tilbud-block-chips">';
    _tBLOCKS.forEach(b => {
        const on = _tActBlk.has(b.id);
        // En slukket blok kan stadig indeholde varer. Vis hvor mange, så det er
        // synligt at der ligger noget gemt bag chippen — ellers ser den tom ud.
        const stashed = !on ? (_tEvBlk[b.id] || []).reduce((s, i) => s + (i.qty || 0), 0) : 0;
        const badge = stashed
            ? `<span class="tilbud-chip-stash" title="${stashed} vare${stashed !== 1 ? 'r' : ''} gemt — tænd blokken for at få dem tilbage">${stashed}</span>`
            : '';
        h += `<div class="tilbud-chip ${on ? 'a-' + b.color : ''}${stashed ? ' has-stash' : ''}" onclick="_tTogBlk('${b.id}')">${b.icon} ${b.label}${badge}</div>`;
    });
    h += '</div>';

    if (!_tActBlk.size) {
        h += '<p style="color:var(--color-text-dim);padding:16px 0;text-align:center">T\u00e6nd en tidsblok ovenfor.</p>';
        return h;
    }

    const pax = parseInt(_tPax) || 1;

    _tBLOCKS.forEach(b => {
        if (!_tActBlk.has(b.id)) return;
        const its = _tEvBlk[b.id] || [];
        const cnt = its.reduce((s, i) => s + i.qty, 0);
        const bPax = _tEffectivePax(b.id);
        const bp = its.reduce((s, i) => s + i.unitPrice * i.qty, 0);
        const col = _tColBlk.has(b.id);
        const paxPill = `<span style="font-size:.7rem;background:rgba(142,99,31,.1);padding:2px 7px;border-radius:10px;margin-left:6px">${bPax} pax</span>`;

        h += `<div class="tilbud-block tilbud-block-${b.color}">
            <div class="tilbud-block-hdr" onclick="_tTogCol('${b.id}')">
                <div class="tilbud-block-hdr-left"><span class="tilbud-chevron ${col ? 'collapsed' : ''}">\u25BC</span>${b.icon} ${b.label}${paxPill}</div>
                <div class="tilbud-block-hdr-right"><span class="tilbud-block-count">${cnt} vare${cnt !== 1 ? 'r' : ''}</span><span class="tilbud-block-price">${_tFk(bp)}</span></div>
            </div>
            <div class="tilbud-block-body ${col ? 'collapsed' : ''}">`;

        _tSortedCats().forEach(cat => {
            const catItems = _tMenu[cat] || [];
            if (!catItems.length) return;
            const catKey = `${b.id}::${cat}`;
            const catCol = _tColCat.has(catKey);
            const selCnt = catItems.reduce((s, it) => s + (its.find(x => x.id === it.id) ? 1 : 0), 0);
            const selBadge = selCnt ? `<span class="tilbud-cat-badge">${selCnt}</span>` : '';
            h += `<div class="tilbud-cat-title clickable" onclick="_tTogColCat('${catKey.replace(/'/g, "\\'")}')">
                <span class="tilbud-chevron ${catCol ? 'collapsed' : ''}">▼</span>${_tEsc(cat)}${selBadge}
            </div>`;
            if (!catCol) {
                catItems.forEach(it => {
                    const sel = its.find(x => x.id === it.id);
                    h += _tBuildMI(it, !!sel, sel?.qty || 1, b.id);
                });
            }
        });

        // Fritekst-varer h\u00f8rer til blokken p\u00e5 lige fod med menuvarerne, men
        // findes ikke i _tMenu og fanges derfor ikke af kategori-loopet ovenfor.
        h += _tBuildExtraItems(its, b.id);

        // Custom item input
        h += `<div class="tilbud-custom-row">
            <div class="tilbud-form-group grow"><label>Fritekst</label><input type="text" id="t-bcn-${b.id}" placeholder="Fx 'S\u00e6rlig ret'"></div>
            <div class="tilbud-form-group short"><label>Antal</label><input type="number" id="t-bcq-${b.id}" min="1" value="1"></div>
            <div class="tilbud-form-group short"><label>Pris</label><input type="number" id="t-bcp-${b.id}" placeholder="0"></div>
            <button class="tilbud-btn tilbud-btn-secondary tilbud-btn-sm" onclick="_tAddBCx('${b.id}')" style="align-self:flex-end">+</button>
        </div></div></div>`;
    });

    return h;
}

function _tBuildSingleUI() {
    let h = `<div class="tilbud-search-box"><input type="text" id="t-si-search" placeholder="S\u00f8g vare..."></div>`;

    _tSortedCats().forEach(cat => {
        const items = _tMenu[cat] || [];
        if (!items.length) return;
        const catKey = cat;
        const catCol = _tColCat.has(catKey);
        const selCnt = items.reduce((s, it) => s + (_tSiItems.find(x => x.id === it.id) ? 1 : 0), 0);
        const selBadge = selCnt ? `<span class="tilbud-cat-badge">${selCnt}</span>` : '';
        h += `<div class="tilbud-cat-title clickable" data-cat="${_tEsc(cat)}" onclick="_tTogColCat('${catKey.replace(/'/g, "\\'")}')">
            <span class="tilbud-chevron ${catCol ? 'collapsed' : ''}">▼</span>${_tEsc(cat)}${selBadge}
        </div>`;
        if (!catCol) {
            items.forEach(it => {
                const sel = _tSiItems.find(x => x.id === it.id);
                h += _tBuildMI(it, !!sel, sel?.qty || 1, null);
            });
        }
    });

    h += _tBuildExtraItems(_tSiItems, null);

    // Custom item
    h += `<div class="tilbud-custom-row">
        <div class="tilbud-form-group grow"><label>Fritekst</label><input type="text" id="t-cx-n" placeholder="Fx 'Service'"></div>
        <div class="tilbud-form-group short"><label>Antal</label><input type="number" id="t-cx-q" min="1" value="1"></div>
        <div class="tilbud-form-group short"><label>Pris</label><input type="number" id="t-cx-p" placeholder="0"></div>
        <button class="tilbud-btn tilbud-btn-secondary tilbud-btn-sm" onclick="_tAddCx()" style="align-self:flex-end">+</button>
    </div>`;

    return h;
}

/**
 * Valgte varer der IKKE findes i Grocy-menuen — fritekst, og linjer fra et gemt
 * tilbud hvis opskriften siden er fjernet i Grocy.
 *
 * Sammensæt-trinnet renderer ellers kun ved at løbe menuens kategorier igennem
 * og slå op i det valgte. Alt uden for menuen faldt derfor helt ud af billedet:
 * en fritekst-linje blev talt med i blok-headeren og i pristabellen, men rækken
 * kunne hverken ses, tælles op eller slettes dér hvor man sammensætter.
 */
function _tBuildExtraItems(items, bid) {
    const inMenu = new Set(Object.values(_tMenu || {}).flat().map(p => p.id));
    const extras = (items || []).filter(it => !inMenu.has(it.id));
    if (!extras.length) return '';

    // Ikke bare "Fritekst": her ender også en gemt vare hvis opskriften siden er
    // fjernet fra Grocy. Den skal stadig kunne ses og rettes, ikke forsvinde.
    let h = `<div class="tilbud-cat-title">Fritekst og øvrige</div>`;
    for (const it of extras) h += _tBuildMI(it, true, it.qty || 1, bid);
    return h;
}

function _tBuildMI(it, sel, qty, bid) {
    const ctx = bid ? `'${bid}'` : 'null';
    return `<div class="tilbud-menu-item ${sel ? 'selected' : ''}" data-name="${_tEsc(it.name.toLowerCase())}" data-cat="${_tEsc(it.category || '')}">
        <input type="checkbox" ${sel ? 'checked' : ''} onchange="_tTogMI(${it.id},${ctx})">
        <div class="tilbud-mi-info"><div class="tilbud-mi-name">${_tEsc(it.name)}</div></div>
        <div class="tilbud-mi-price">${it.unitPrice} kr</div>
        ${sel ? `<div class="tilbud-qty-ctrl">
            <button class="tilbud-qty-btn" onclick="_tChgQ(${it.id},-1,${ctx})">−</button>
            <input type="number" class="tilbud-qty-input" value="${qty}" min="1" onchange="_tSetQ(${it.id},this.value,${ctx})">
            <button class="tilbud-qty-btn" onclick="_tChgQ(${it.id},1,${ctx})">+</button>
        </div>` : ''}
    </div>`;
}

function _tTogBlk(id) {
    if (_tActBlk.has(id)) {
        // Slukket blok beholder sit indhold. Før smed `delete _tEvBlk[id]` hele
        // blokken væk ved et enkelt klik, uden varsel og uden fortrydelse — et
        // fejlklik på "Frokost" kostede alt arbejdet i den.
        //
        // Det er sikkert at lade det ligge: alt der læser blokke (pristabel,
        // preview, gem, PDF) springer inaktive blokke over, så en slukket blok
        // tæller stadig ikke med i tilbuddet. Den kan bare tændes igen.
        _tActBlk.delete(id);
        _tColBlk.delete(id);
    } else {
        _tActBlk.add(id);
        if (!_tEvBlk[id]) _tEvBlk[id] = [];
    }
    _tRenderWizard();
}

function _tTogCol(id) {
    if (_tColBlk.has(id)) _tColBlk.delete(id); else _tColBlk.add(id);
    _tRenderWizard();
}

function _tTogColCat(key) {
    if (_tColCat.has(key)) _tColCat.delete(key); else _tColCat.add(key);
    _tRenderWizard();
}

function _tTogMI(id, bid) {
    const arr = bid ? (_tEvBlk[bid] || (_tEvBlk[bid] = [])) : _tSiItems;
    const idx = arr.findIndex(s => s.id === id);

    // Fravalg først: en fritekst-vare findes ikke i menuen, og opslaget nedenfor
    // ville ellers afvise at fjerne den igen.
    if (idx >= 0) {
        arr.splice(idx, 1);
    } else {
        const item = Object.values(_tMenu).flat().find(p => p.id === id);
        if (!item) return;
        arr.push({ ...item, qty: 1, category: item.category || null });
    }

    if (bid) _tEvBlk[bid] = arr;
    _tRenderWizard();
}

function _tChgQ(id, d, bid) {
    const arr = bid ? _tEvBlk[bid] : _tSiItems;
    const it = arr?.find(s => s.id === id);
    if (it) it.qty = Math.max(1, it.qty + d);
    _tRenderWizard();
}

function _tSetQ(id, v, bid) {
    const arr = bid ? _tEvBlk[bid] : _tSiItems;
    const it = arr?.find(s => s.id === id);
    if (it) it.qty = Math.max(1, parseInt(v) || 1);
    _tRenderWizard();
}

// Fritekst-vare i samme form som en menuvare, så den arver antals-kontrol,
// sletning og gem/genindlæsning uden særbehandling.
function _tFreeItem(name, qty, price) {
    return {
        id: Date.now() + Math.random(),
        grocy_recipe_id: null,
        name,
        unit: 'stk',
        category: 'Fritekst',
        unitPrice: price,
        costPrice: 0,
        qty: Math.max(1, parseInt(qty) || 1),
    };
}

function _tAddBCx(bid) {
    const n = document.getElementById(`t-bcn-${bid}`)?.value.trim();
    const q = document.getElementById(`t-bcq-${bid}`)?.value;
    const p = parseFloat(document.getElementById(`t-bcp-${bid}`)?.value) || 0;
    if (!n) return;
    if (!_tEvBlk[bid]) _tEvBlk[bid] = [];
    _tEvBlk[bid].push(_tFreeItem(n, q, p));
    _tRenderWizard();
}

function _tAddCx() {
    const n = document.getElementById('t-cx-n')?.value.trim();
    const q = document.getElementById('t-cx-q')?.value;
    const p = parseFloat(document.getElementById('t-cx-p')?.value) || 0;
    if (!n) return;
    // Læg den i _tSiItems, ikke i en sideliste. Ved genindlæsning af et gemt
    // tilbud havner fritekst-linjer alligevel dér (de har intet block_type),
    // så den gamle parallelle _tCxItems gjorde bare at samme linje blev vist
    // og talt forskelligt før og efter gem.
    _tSiItems.push(_tFreeItem(n, q, p));
    _tRenderWizard();
}

/* ── Step 3: Priser ──────────────────────────────────── */

function _tBuildStep3() {
    let h = `<h2>Priser & levering</h2><p class="tilbud-step-desc">Prisvisning, rabat og leveringsinfo.</p>`;

    // Price mode
    h += `<div class="tilbud-options">
        <div class="tilbud-options-title">Prisvisning i tilbud</div>
        <div class="tilbud-pm">
            <button class="tilbud-pm-opt ${_tPriceMode === 'total' ? 'active' : ''}" onclick="_tSetPM('total')">Kun total</button>
            <button class="tilbud-pm-opt ${_tPriceMode === 'block' ? 'active' : ''}" onclick="_tSetPM('block')">Pr. blok</button>
            <button class="tilbud-pm-opt ${_tPriceMode === 'line' ? 'active' : ''}" onclick="_tSetPM('line')">Linje</button>
        </div>
    </div>`;

    // Discount
    h += `<div class="tilbud-options">
        <div class="tilbud-options-title">Rabat</div>
        <div class="tilbud-discount">
            <input type="number" id="t-disc-pct" value="${_tDiscountPct}" min="0" max="100" onchange="_tDiscountPct=parseFloat(this.value)||0;_tRenderWizard()"> <span>%</span>
        </div>
    </div>`;

    // Validity
    h += `<div class="tilbud-options">
        <div class="tilbud-options-title">Gyldighed</div>
        <select id="t-val-days" onchange="_tValidDays=parseInt(this.value)||30">
            <option value="14" ${_tValidDays === 14 ? 'selected' : ''}>14 dage</option>
            <option value="30" ${_tValidDays === 30 ? 'selected' : ''}>30 dage</option>
            <option value="60" ${_tValidDays === 60 ? 'selected' : ''}>60 dage</option>
        </select>
    </div>`;

    // Delivery
    h += `<div class="tilbud-options">
        <div class="tilbud-options-title">Levering</div>
        <div class="tilbud-form-grid">
            <div class="tilbud-form-group"><label>Leveringstype</label>
                <select id="t-del-type" onchange="_tUpdateDel()">
                    <option value="" ${!_tDel.type ? 'selected' : ''}>Ingen</option>
                    <option value="byx" ${_tDel.type === 'byx' ? 'selected' : ''}>Byekspressen</option>
                    <option value="taxa" ${_tDel.type === 'taxa' ? 'selected' : ''}>El-taxa</option>
                    <option value="rr" ${_tDel.type === 'rr' ? 'selected' : ''}>RR leverer</option>
                    <option value="custom" ${_tDel.type === 'custom' ? 'selected' : ''}>Anden</option>
                </select>
            </div>
            <div class="tilbud-form-group"><label>Pris</label><input type="number" id="t-del-price" value="${_tDel.price}" onchange="_tUpdateDel()"></div>
            <div class="tilbud-form-group full"><label>Note</label><input type="text" id="t-del-note" value="${_tEsc(_tDel.note)}" placeholder="Leveringsinfo" onchange="_tUpdateDel()"></div>
        </div>
    </div>`;

    // Kundenote (vises på PDF)
    h += `<div class="tilbud-options">
        <div class="tilbud-options-title">Note til kunden (vises p\u00e5 tilbuddet)</div>
        <textarea id="t-offer-note" rows="3" placeholder="Fx 'Vi ser frem til at byde jer velkommen...'" style="width:100%;font-family:var(--font-body);font-size:.88rem;padding:9px 12px;border:1.5px solid var(--color-border);border-radius:8px;resize:vertical">${_tEsc(_tOfferNote)}</textarea>
    </div>`;

    // Price table
    h += _tBuildPriceTable();

    h += `<div class="tilbud-btn-row">
        <button class="tilbud-btn tilbud-btn-secondary" onclick="_tPrev()">\u2190 Tilbage</button>
        <div style="display:flex;gap:8px">
            ${_tSaveBtn()}
            <button class="tilbud-btn tilbud-btn-primary" onclick="_tNext()">N\u00e6ste \u2192</button>
        </div>
    </div>`;
    return h;
}

function _tSetPM(m) { _tPriceMode = m; _tRenderWizard(); }

function _tUpdateDel() {
    const ty = document.getElementById('t-del-type')?.value || '';
    const pr = parseFloat(document.getElementById('t-del-price')?.value) || 0;
    const nt = document.getElementById('t-del-note')?.value.trim() || '';
    _tDel = { type: ty || null, price: pr, note: nt, free: false };
}

function _tBuildPriceTable() {
    const isEv = _tTpl === 'event';
    const sBT = _tPriceMode === 'block', sL = _tPriceMode === 'line';

    let h = `<table class="tilbud-price-tbl"><thead><tr><th>Post</th><th class="r">Antal</th><th class="r">Pris</th><th class="r">Intern</th><th style="width:36px"></th></tr></thead><tbody>`;
    let sub = 0, costT = 0;

    if (isEv) {
        _tBLOCKS.forEach(b => {
            if (!_tActBlk.has(b.id)) return;
            const its = _tEvBlk[b.id] || [];
            if (!its.length) return;
            const bPax = _tEffectivePax(b.id);
            let blockTotal = 0;

            h += `<tr class="chapter"><td colspan="5">${b.icon} ${b.label} <span style="font-size:.72rem;font-weight:400;color:var(--color-text-dim)">${bPax} pax</span></td></tr>`;

            its.forEach(it => {
                const lt = it.unitPrice * it.qty;
                const lc = it.costPrice * it.qty;
                sub += lt; costT += lc; blockTotal += lt;
                const ltU = window.Moms.inclToExcl(lt);
                const dbP = ltU > 0 ? ((ltU - lc) / ltU * 100) : 0;
                h += `<tr><td><strong>${_tEsc(it.name)}</strong>${_tStaleMark(it)}</td>`;
                h += `<td class="r">${it.qty}</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(lt)}</td>`;
                h += `<td class="r" style="font-size:.73rem;color:var(--color-text-dim);font-family:'JetBrains Mono',monospace">${_tFk(lc)} (${dbP.toFixed(0)}%)</td>`;
                h += `<td><button class="tilbud-btn-icon danger" onclick="_tRemP(${it.id},'${b.id}')">\u2715</button></td></tr>`;
            });

            // Blokpris (altid vist — nyttigt i alle modes)
            if (bPax > 0) {
                const perPax = Math.round(blockTotal / bPax);
                h += `<tr class="subtotal"><td colspan="2"></td><td class="r" style="font-family:'JetBrains Mono',monospace;font-size:.73rem">${_tFk(blockTotal)} <span style="color:var(--color-text-dim)">(${perPax} kr/pax)</span></td><td></td><td></td></tr>`;
            }
        });
    } else {
        _tSiItems.forEach(it => {
            const lt = it.unitPrice * it.qty;
            const lc = it.costPrice * it.qty;
            sub += lt; costT += lc;
            const ltU = window.Moms.inclToExcl(lt);
            const dbP = ltU > 0 ? ((ltU - lc) / ltU * 100) : 0;
            h += `<tr><td><strong>${_tEsc(it.name)}</strong>${_tStaleMark(it)}</td>`;
            h += `<td class="r">${it.qty}</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(lt)}</td>`;
            h += `<td class="r" style="font-size:.73rem;color:var(--color-text-dim);font-family:'JetBrains Mono',monospace">${_tFk(lc)} (${dbP.toFixed(0)}%)</td>`;
            h += `<td><button class="tilbud-btn-icon danger" onclick="_tRemP(${it.id},'')">\u2715</button></td></tr>`;
        });
    }

    // Delivery
    if (_tDel.type) {
        const dp = _tDel.free ? 0 : _tDel.price;
        sub += dp;
        h += `<tr><td>\u{1F69A} Levering${_tDel.note ? ' \u00b7 ' + _tEsc(_tDel.note) : ''}</td><td class="r">1</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tDel.free ? 'Gratis' : _tFk(dp)}</td><td class="r">\u2014</td><td></td></tr>`;
    }

    const dA = sub * (_tDiscountPct / 100);
    const tot = sub - dA;
    const subUMoms = window.Moms.inclToExcl(tot);
    const moms = tot - subUMoms;
    const globalPax = parseInt(_tPax) || 0;

    h += `<tr class="subtotal"><td colspan="2">Subtotal (u/moms)</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(subUMoms)}</td><td></td><td></td></tr>`;
    if (_tDiscountPct > 0) h += `<tr class="subtotal"><td colspan="2">Rabat (${_tDiscountPct}%)</td><td class="r" style="font-family:'JetBrains Mono',monospace;color:#6ab04c">\u2212${_tFk(dA)}</td><td></td><td></td></tr>`;
    h += `<tr class="subtotal"><td colspan="2">Moms (25%)</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(moms)}</td><td></td><td></td></tr>`;
    h += `<tr class="total-row"><td colspan="2">Total inkl. moms</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(tot)}</td><td></td><td></td></tr>`;
    if (globalPax > 0) h += `<tr class="subtotal"><td colspan="2"></td><td class="r" style="font-family:'JetBrains Mono',monospace;font-size:.74rem">${_tFk(tot / globalPax)} pr. pax</td><td></td><td></td></tr>`;

    h += '</tbody></table>';
    return h;
}

function _tRemP(id, bid) {
    if (bid) _tEvBlk[bid] = (_tEvBlk[bid] || []).filter(s => s.id !== id);
    else _tSiItems = _tSiItems.filter(s => s.id !== id);
    _tRenderWizard();
}


/* ── Step 4: Preview ─────────────────────────────────── */

function _tBuildStep4() {
    const isEv = _tTpl === 'event', globalPax = parseInt(_tPax) || 1;
    const sL = _tPriceMode === 'line', sBT = _tPriceMode === 'block';
    const today = todayISO();
    const expStr = offsetISO(_tValidDays);
    const cn = _tCust?.company_name || _tCust?.customer_name || 'Kunde';
    const dTypes = { byx: 'Byekspressen', taxa: 'El-taxa', rr: 'RR leverer', custom: 'Levering' };

    const canDelete = _tQuoteId && _tQuoteStatus === 'draft';
    let h = `<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <button class="tilbud-btn tilbud-btn-primary" onclick="_tSaveQuote()">Gem tilbud</button>
        <button class="tilbud-btn tilbud-btn-secondary" onclick="_tGenPDF()">Download PDF</button>
        <button class="tilbud-btn tilbud-btn-secondary" onclick="_tSendQuoteMail()">${mailIcon(13)} Send til kunde</button>
        ${_tQuoteId ? `<button class="tilbud-btn tilbud-btn-secondary" onclick="_tConvertToBon()">Opret som bon</button>` : ''}
        ${canDelete ? `<button class="tilbud-btn tilbud-btn-danger" onclick="_tDeleteQuote()" style="margin-left:auto">Slet tilbud</button>` : ''}
    </div>`;

    if (!_tCust) {
        h += `<div style="background:#fff4e0;border:1px solid #f0c674;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:.86rem;color:#7a5a1f">
            \u26A0 Ingen kunde valgt. Tilbuddet vises uden kundenavn. <a href="#" onclick="event.preventDefault();_tGoTo(1)" style="color:#7a5a1f;font-weight:600;text-decoration:underline">G\u00e5 til Kunde \u2192</a>
        </div>`;
    }

    h += `<div class="tilbud-preview">
        <div class="tilbud-pv-header">
            <div class="tilbud-pv-logo">${_tLogoB64 ? '<img src="data:image/png;base64,' + _tLogoB64 + '" style="height:55px">' : 'RISTET RUG<small>Sandwich \u00b7 Catering</small>'}</div>
            <div class="tilbud-pv-meta"><strong>Tilbud ${_tEsc(_tQuoteNumber || '(ny)')}</strong><br>Dato: ${_tFd(today)}<br>Gyldig til: ${_tFd(expStr)}</div>
        </div>
        <div class="tilbud-pv-customer">
            <strong>${_tEsc(cn)}</strong><br>
            ${_tCust?.email ? _tEsc(_tCust.email) : ''}${_tCust?.phone ? ' \u00b7 ' + _tEsc(_tCust.phone) : ''}
            ${isEv ? '<br>Pax: ' + globalPax : ''}
        </div>`;

    // Leveringsadresse
    if (_tDeliveryDate || _tDeliveryAddress) {
        const isPickup = _tDeliveryType === 'pickup';
        h += `<div class="tilbud-pv-notes" style="margin-top:12px;margin-bottom:16px"><strong>${isPickup ? 'Afhentning' : 'Levering'}</strong><br>`;
        if (_tDeliveryDate) {
            const dayNames = ['S\u00f8ndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','L\u00f8rdag'];
            const d = new Date(_tDeliveryDate + 'T00:00:00');
            h += dayNames[d.getDay()] + ' ' + _tFd(_tDeliveryDate);
            if (_tDeliveryTime) h += ' kl. ' + _tDeliveryTime;
            h += '<br>';
        }
        if (_tDeliveryAddress) h += _tEsc(_tDeliveryAddress) + '<br>';
        if (_tDeliveryNotes) h += _tEsc(_tDeliveryNotes) + '<br>';
        // Samme regel som varelinjerne: i "kun total" står der ingen delpriser
        // på tilbuddet — heller ikke her i leveringsboksen.
        if (_tDel.type && _tDel.price > 0 && !_tDel.free) {
            h += (dTypes[_tDel.type] || 'Levering') + ((sL || sBT) ? ' ' + _tFk(_tDel.price) : '');
        }
        h += '</div>';
    }

    // Kundenote
    if (_tOfferNote) {
        h += `<div style="margin-bottom:16px;font-size:.86rem;line-height:1.6;color:var(--color-text)">${_tOfferNote.replace(/\n/g, '<br>')}</div>`;
    }

    h += `<div class="tilbud-pv-title">${isEv ? 'Tilbud p\u00e5 catering' : 'Tilbud'}</div>
        <div class="tilbud-pv-subtitle">${isEv && _tDeliveryDate ? _tFd(_tDeliveryDate) : ''}${isEv && _tDeliveryAddress ? ' \u00b7 ' + _tEsc(_tDeliveryAddress) : ''}</div>`;

    let sub = 0;

    if (isEv) {
        _tBLOCKS.forEach(b => {
            if (!_tActBlk.has(b.id)) return;
            const its = _tEvBlk[b.id] || [];
            if (!its.length) return;
            const bPax = _tEffectivePax(b.id);
            const bt = its.reduce((s, i) => s + i.unitPrice * i.qty, 0);
            sub += bt;
            let blockHdr = `${b.icon} ${b.label}`;
            if (sBT || sL) {
                const perPax = bPax > 0 ? Math.round(bt / bPax) : 0;
                blockHdr += `<span class="bt">${_tFk(bt)}${perPax ? ` (${perPax} kr/pax)` : ''}</span>`;
            }
            h += `<div class="tilbud-pv-block-hdr">${blockHdr}</div>`;
            // `bt` er allerede summeret over ALLE varer ovenfor \u2014 her filtreres
            // kun visningen, s\u00e5 en skjult kategori t\u00e6ller stadig med i prisen.
            _tOfferItems(its).forEach(i => {
                h += `<div class="tilbud-pv-row"><span class="rn">${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${_tEsc(i.name)}</span>${sL ? `<span class="rp">${_tFk(i.unitPrice * i.qty)}</span>` : ''}</div>`;
            });
        });
    } else {
        // Bel\u00f8bet summeres over alle varer, uafh\u00e6ngigt af hvad der vises.
        _tSiItems.forEach(i => { sub += i.unitPrice * i.qty; });
        const cats = {};
        _tSiItems.forEach(i => { const c = i.category || 'Ukendt'; if (!cats[c]) cats[c] = []; cats[c].push(i); });
        _tOfferCategories(cats).forEach(cat => {
            cats[cat].forEach(i => {
                h += `<div class="tilbud-pv-row"><span class="rn">${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${_tEsc(i.name)}</span>${sL ? `<span class="rp">${_tFk(i.unitPrice * i.qty)}</span>` : ''}</div>`;
            });
        });
    }

    // Delivery
    //
    // Leveringen fulgte ikke prismoden: i "kun total" stod den som eneste linje
    // p\u00e5 hele tilbuddet med et bel\u00f8b ud for sig, mens alle varerne var uden.
    // Den er en linje som de andre og skal opf\u00f8re sig som dem \u2014 bel\u00f8bet vises
    // kun n\u00e5r tilbuddet i \u00f8vrigt viser bel\u00f8b (linje- eller blokpris).
    //
    // Selve linjen vises altid: den b\u00e6rer hvor og hvordan der leveres, og PDF'en
    // har hele tiden skrevet den uanset pris. De to var uenige.
    if (_tDel.type) {
        const dp = _tDel.free ? 0 : _tDel.price;
        sub += dp;
        const showPrice = (sL || sBT) && dp > 0;
        h += `<div class="tilbud-pv-row"><span class="rn">\u{1F69A} Levering: ${dTypes[_tDel.type] || ''}${_tDel.note ? ' \u00b7 ' + _tEsc(_tDel.note) : ''}</span>`
           + (showPrice ? `<span class="rp">${_tFk(dp)}</span>` : '')
           + `</div>`;
    }

    const dA = sub * (_tDiscountPct / 100), tot = sub - dA, subUMoms = window.Moms.inclToExcl(tot), moms = tot - subUMoms;
    h += `<div class="tilbud-pv-totals">
        <div class="tilbud-pv-tl"><span class="tl">Subtotal (u/moms)</span><span class="tv">${_tFk(subUMoms)}</span></div>
        ${_tDiscountPct > 0 ? `<div class="tilbud-pv-tl"><span class="tl">Rabat (${_tDiscountPct}%)</span><span class="tv" style="color:#6ab04c">\u2212${_tFk(dA)}</span></div>` : ''}
        <div class="tilbud-pv-tl"><span class="tl">Moms (25%)</span><span class="tv">${_tFk(moms)}</span></div>
        <div class="tilbud-pv-tl big"><span class="tl">Total inkl. moms</span><span class="tv">${_tFk(tot)}</span></div>
    </div>`;
    if (globalPax > 0) h += `<div class="tilbud-pv-pax">Svarende til <strong>${_tFk(tot / globalPax)}</strong> pr. pax inkl. moms</div>`;
    if (_tCustomerWishes) h += `<div class="tilbud-pv-notes"><strong>Kunde \u00f8nsker:</strong><br>${_tEsc(_tCustomerWishes)}</div>`;
    const _fc = _tCompany;
    h += `<div class="tilbud-pv-footer"><div><strong>${_tEsc(_fc.name)}</strong>${_fc.cvr ? ' \u00b7 CVR: ' + _tEsc(_fc.cvr) : ''}<br>${_tEsc(_fc.address || '')}${_fc.email ? ' \u00b7 ' + _tEsc(_fc.email) : ''}${_fc.phone ? ' \u00b7 ' + _tEsc(_fc.phone) : ''}</div><div style="text-align:right">Gyldigt i ${_tValidDays} dage.<br>Priser i DKK.</div></div>`;
    h += '</div>';

    h += `<div class="tilbud-btn-row">
        <button class="tilbud-btn tilbud-btn-secondary" onclick="_tPrev()">\u2190 Tilbage</button>
        <div style="display:flex;gap:8px">
            <button class="tilbud-btn tilbud-btn-primary" onclick="_tSaveQuote()">Gem tilbud</button>
        </div>
    </div>`;
    return h;
}

/* ── Save / Convert / PDF ────────────────────────────── */

function _tCollectLines() {
    const lines = [];
    const isEv = _tTpl === 'event';
    let order = 0;

    // `category` skal med. Uden den faldt backenden tilbage på `block_type`
    // (tidsblokken, fx "morning") eller NULL — og `bon_lines.category` er dét
    // enheds-tællingen matcher mod `unit_count_categories`. Et konverteret
    // tilbud ville derfor tælle nul enheder på dashboard og ugeoversigt.
    if (isEv) {
        _tBLOCKS.forEach(b => {
            if (!_tActBlk.has(b.id)) return;
            (_tEvBlk[b.id] || []).forEach(it => {
                lines.push({
                    block_type: b.id,
                    grocy_recipe_id: it.grocy_recipe_id || null,
                    product_name: it.name,
                    category: it.category || null,
                    quantity: it.qty,
                    unit: it.unit || 'stk',
                    unit_price: it.unitPrice,
                    cost_price: it.costPrice,
                    sort_order: order++,
                });
            });
        });
    } else {
        _tSiItems.forEach(it => {
            lines.push({
                block_type: null,
                grocy_recipe_id: it.grocy_recipe_id || null,
                product_name: it.name,
                category: it.category || null,
                quantity: it.qty,
                unit: it.unit || 'stk',
                unit_price: it.unitPrice,
                cost_price: it.costPrice,
                sort_order: order++,
            });
        });
    }

    return lines;
}

// Gem-knappen hører til på HVERT trin, ikke kun de sidste to.
//
// Wizarden havde kun "Gem tilbud" på trin 3 og 4, så et tilbud man blev
// afbrudt i — telefonen ringer på trin 1 — var tabt. Hverken frontend eller
// `POST /api/quotes` kræver andet end at der trykkes: alle felter er nullable,
// og tilbuddet får sit T-nummer med det samme. Der var altså intet der
// forhindrede det; knappen manglede bare.
function _tSaveBtn() {
    const label = _tQuoteId ? 'Gem' : 'Gem kladde';
    return `<button class="tilbud-btn tilbud-btn-secondary" onclick="_tSaveQuote()"
                    title="Gemmer som kladde — du kan altid vende tilbage og gøre tilbuddet færdigt">${label}</button>`;
}

async function _tSaveQuote() {
    _tSaveStepFields();
    _tSyncBlockStash();

    // `bons.delivery_date` er NOT NULL i skemaet, så et tilbud kan ikke gemmes
    // uden dato — uanset hvor tidligt i forløbet man er. Uden dette tjek kommer
    // afvisningen som en rå SQL-besked i en toast ("NOT NULL constraint failed").
    // Sig det på dansk og sæt markøren i feltet i stedet.
    if (!_tDeliveryDate) {
        _tToast('Sæt en leveringsdato — den kan altid ændres bagefter');
        if (_tStep !== 1) { _tStep = 1; _tRenderWizard(); }
        requestAnimationFrame(() => {
            const el = document.getElementById('t-ev-date');
            if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
        });
        return;
    }

    const payload = {
        customer_id: _tCust?.customer_id ?? null,
        company_id: _tCust?.company_id ?? null,
        price_category: _tPriceCat,
        template: _tTpl,
        delivery_date: _tDeliveryDate || null,
        delivery_time: _tDeliveryTime || null,
        pickup_time: _tPickupTime || null,
        pax: parseInt(_tPax) || null,
        total_units: parseInt(_tTotalUnits) || null,
        delivery_type: _tDeliveryType || 'delivery',
        delivery_address_id: _tDeliveryAddressId ?? null,
        delivery_price: _tDel.type ? (_tDel.free ? 0 : _tDel.price) : 0,
        delivery_note: _tDeliveryNotes || _tDel.note || null,
        delivery_method: _tDeliveryMethod || null,
        day_contact_name: _tDayContactName || null,
        day_contact_phone: _tDayContactPhone || null,
        payment_type: _tPaymentType || null,
        price_mode: _tPriceMode,
        discount_percent: _tDiscountPct,
        customer_wishes: _tCustomerWishes || null,
        invoice_info: _tInvoiceInfo || null,
        kitchen_info: _tKitchenInfo || null,
        notes: _tInternalNotes || null,
        offer_note: _tOfferNote || null,
        offer_block_metadata: Object.keys(_tBlockMeta).length ? _tBlockMeta : null,
        // Gemmes i DB som offer_valid_until — en dags forskydning her
        // fik tilbud til at udløbe for tidligt.
        valid_until: offsetISO(_tValidDays),
        lines: _tCollectLines(),
    };

    try {
        if (_tQuoteId) {
            const saved = await updateQuote(_tQuoteId, payload);
            _tQuoteNumber = saved.quote_number;
            if (saved.status) _tQuoteStatus = saved.status;
            _tToast(`Tilbud ${saved.quote_number} opdateret`);
        } else {
            const saved = await createQuote(payload);
            _tQuoteId = saved.id;
            _tQuoteNumber = saved.quote_number;
            _tQuoteStatus = 'draft';
            _tToast(`Tilbud ${saved.quote_number} oprettet`);
        }
        _tRenderWizard(); // Re-render to show updated number + convert button
    } catch (e) {
        _tToast('Fejl: ' + e.message);
    }
}

async function _tConvertToBon() {
    if (!_tQuoteId) { _tToast('Gem tilbuddet f\u00f8rst'); return; }
    try {
        await _tSaveQuote();
        const result = await convertQuoteToBon(_tQuoteId);
        _tToast(`Tilbud konverteret til bon ${result.bon_number}`);
        // Navigate to bons list
        if (typeof switchView === 'function') switchView('bons');
    } catch (e) {
        _tToast('Fejl: ' + e.message);
    }
}

async function _tDeleteQuote() {
    if (!_tQuoteId) return;
    const label = _tQuoteNumber ? `tilbud ${_tQuoteNumber}` : 'dette tilbud';
    if (!confirm(`Slet ${label}?\n\nKan ikke fortrydes.`)) return;
    try {
        await deleteQuote(_tQuoteId);
        _tToast('Tilbud slettet');
        _tBackToList();
    } catch (e) {
        _tToast('Fejl: ' + (e.message || 'Kunne ikke slette tilbud'));
    }
}

/**
 * Bygger tilbuds-PDF'en og returnerer { doc, filename } UDEN at gemme den.
 *
 * Download-knappen (_tGenPDF) gemmer dokumentet; mail-flowet (_tDoSendMail)
 * beder om det og laver en blob i stedet. Tidligere delte de kode ved at
 * monkey-patche `jsPDF.prototype.save` — men jsPDF lægger `save` på selve
 * INSTANSEN, ikke på prototypen, så patchet blev aldrig ramt: PDF'en
 * downloadede sig selv og mailen fejlede altid med "PDF generering fejlede".
 */
function _tBuildPDF() {
    _tSaveStepFields();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pw = 210, ph = 297, ml = 25, mr = 25, mt = 25, cw = pw - ml - mr;
    let y = mt;
    const isEv = _tTpl === 'event', globalPax = parseInt(_tPax) || 1;
    const sL = _tPriceMode === 'line', sBT = _tPriceMode === 'block';
    const cn = _tCust?.company_name || _tCust?.customer_name || 'Kunde';
    const qi = _tQuoteNumber || 'Ny';
    const today = new Date(), exp = new Date(today); exp.setDate(exp.getDate() + _tValidDays);
    const br = [142, 99, 31], tx = [44, 36, 22], dm = [122, 111, 95], cr = [245, 244, 242], gn = [106, 176, 76];
    const bc = { morning: [212, 160, 23], amsnack: [194, 114, 46], lunch: [74, 124, 89], pmsnack: [194, 114, 46] };
    const dTy = { byx: 'Byekspressen', taxa: 'El-taxa', rr: 'RR leverer', custom: 'Levering' };
    const dayNames = ['s\u00f8ndag','mandag','tirsdag','onsdag','torsdag','fredag','l\u00f8rdag'];

    function chk(n) { if (y + n > ph - 28) { doc.addPage(); y = mt; } }
    function fD(d) { return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' }); }
    function fK(n) { return Math.round(n).toLocaleString('da-DK') + ' kr'; }

    // Header — logo or text fallback
    if (_tLogoB64) {
        try { doc.addImage('data:image/png;base64,' + _tLogoB64, 'PNG', ml, y - 5, 32, 20); } catch (_) {}
    } else {
        doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(...br);
        doc.text('RISTET RUG', ml, y + 4);
        doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm);
        doc.text('Sandwich \u00b7 Catering', ml, y + 9);
    }

    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx);
    doc.text(`Tilbud ${qi}`, pw - mr, y, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm);
    doc.text(`Dato: ${fD(today)}`, pw - mr, y + 5, { align: 'right' });
    doc.text(`Gyldig til: ${fD(exp)}`, pw - mr, y + 10, { align: 'right' });
    y += 17; doc.setDrawColor(...br); doc.setLineWidth(0.6); doc.line(ml, y, pw - mr, y); y += 8;

    // Customer box
    const custH = isEv ? 18 : 12;
    doc.setFillColor(...cr); doc.roundedRect(ml, y, cw, custH, 2, 2, 'F');
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx); doc.text(cn, ml + 5, y + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...dm);
    let cl = '';
    if (_tCust?.email) cl += _tCust.email + '  ';
    if (_tCust?.phone) cl += _tCust.phone;
    doc.text(cl, ml + 5, y + 12);
    if (isEv) doc.text(`Pax: ${globalPax}`, ml + 5, y + 18);
    y += custH + 6;

    // Leveringsadresse
    if (_tDeliveryDate || _tDeliveryAddress) {
        chk(20);
        const isPickup = _tDeliveryType === 'pickup';
        doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx);
        doc.text(isPickup ? 'Afhentning' : 'Levering', ml, y); y += 5;
        doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm);
        if (_tDeliveryDate) {
            const dd = new Date(_tDeliveryDate + 'T00:00:00');
            let dStr = dayNames[dd.getDay()].charAt(0).toUpperCase() + dayNames[dd.getDay()].slice(1) + ' ' + fD(dd);
            if (_tDeliveryTime) dStr += ' kl. ' + _tDeliveryTime;
            doc.text(dStr, ml, y); y += 4.5;
        }
        if (_tDeliveryAddress) { doc.text(_tDeliveryAddress, ml, y); y += 4.5; }
        if (_tDeliveryNotes) { doc.text(_tDeliveryNotes, ml, y); y += 4.5; }
        if (_tDel.type && _tDel.price > 0 && !_tDel.free) {
            // Delpriser vises kun når tilbuddet i øvrigt gør det (jf. preview).
            doc.text((dTy[_tDel.type] || 'Levering') + ((sL || sBT) ? '  ' + fK(_tDel.price) : ''), ml, y); y += 4.5;
        }
        y += 3;
    }

    // Kundenote
    if (_tOfferNote) {
        chk(15);
        const noteLines = doc.splitTextToSize(_tOfferNote, cw);
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
        doc.text(noteLines, ml, y); y += noteLines.length * 4.5 + 4;
    }

    // Title
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx);
    doc.text(isEv ? 'Tilbud p\u00e5 catering' : 'Tilbud', ml, y); y += 8;

    let sub = 0;

    // Items
    if (isEv) {
        _tBLOCKS.forEach(b => {
            if (!_tActBlk.has(b.id)) return;
            const its = _tEvBlk[b.id] || []; if (!its.length) return;
            const bPax = _tEffectivePax(b.id);
            const bt = its.reduce((s, i) => s + i.unitPrice * i.qty, 0); sub += bt;
            chk(14); doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...(bc[b.id] || br));
            doc.text(b.label, ml, y);
            if (sBT || sL) {
                const perPax = bPax > 0 ? Math.round(bt / bPax) : 0;
                doc.setFontSize(9); doc.text(fK(bt) + (perPax ? `  (${perPax} kr/pax)` : ''), pw - mr, y, { align: 'right' });
            }
            y += 1.5; doc.setDrawColor(...(bc[b.id] || br)); doc.setLineWidth(0.4); doc.line(ml, y, pw - mr, y); y += 5;
            // `bt` er allerede summeret over alle varer \u2014 her filtreres kun visningen.
            _tOfferItems(its).forEach(it => {
                chk(7); doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
                doc.text(`${it.qty > 1 ? it.qty + '\u00d7 ' : ''}${it.name}`, ml, y);
                if (sL) doc.text(fK(it.unitPrice * it.qty), pw - mr, y, { align: 'right' });
                y += 5.5;
            });
            y += 3;
        });
    } else {
        _tSiItems.forEach(i => { sub += i.unitPrice * i.qty; });   // bel\u00f8b: alle varer
        const cats = {};
        _tSiItems.forEach(i => { const c = i.category || 'Ukendt'; if (!cats[c]) cats[c] = []; cats[c].push(i); });
        _tOfferCategories(cats).forEach(cat => {
            chk(10); doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...br);
            doc.text(cat.toUpperCase(), ml, y); y += 4;
            cats[cat].forEach(i => {
                chk(6);
                doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
                doc.text(`${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${i.name}`, ml, y);
                if (sL) doc.text(fK(i.unitPrice * i.qty), pw - mr, y, { align: 'right' });
                y += 5.5;
            }); y += 2;
        });
    }

    // Delivery \u2014 samme regel som i forh\u00e5ndsvisningen: linjen altid, bel\u00f8bet
    // kun n\u00e5r tilbuddet i \u00f8vrigt viser bel\u00f8b. PDF'en skrev den hidtil aldrig,
    // s\u00e5 i linjeprismode s\u00e5 kunden alle varepriser undtagen leveringens.
    if (_tDel.type) {
        chk(6); const dp = _tDel.free ? 0 : _tDel.price; sub += dp;
        doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
        doc.text(`Levering: ${dTy[_tDel.type] || ''}${_tDel.note ? ' \u00b7 ' + _tDel.note : ''}`, ml, y);
        if ((sL || sBT) && dp > 0) doc.text(fK(dp), pw - mr, y, { align: 'right' });
        y += 6;
    }

    // Totals
    chk(26); y += 4; const ttx = pw - mr - 55;
    const dA = sub * (_tDiscountPct / 100), tot = sub - dA, subUMoms = window.Moms.inclToExcl(tot), moms = tot - subUMoms;
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm);
    doc.text('Subtotal (u/moms)', ttx, y); doc.text(fK(subUMoms), pw - mr, y, { align: 'right' }); y += 5;
    if (_tDiscountPct > 0) { doc.setTextColor(...gn); doc.text(`Rabat (${_tDiscountPct}%)`, ttx, y); doc.text(`\u2212${fK(dA)}`, pw - mr, y, { align: 'right' }); y += 5; }
    doc.setTextColor(...dm); doc.text('Moms (25%)', ttx, y); doc.text(fK(moms), pw - mr, y, { align: 'right' }); y += 2;
    doc.setDrawColor(...tx); doc.setLineWidth(0.5); doc.line(ttx, y, pw - mr, y); y += 5;
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx);
    doc.text('Total inkl. moms', ttx, y); doc.text(fK(tot), pw - mr, y, { align: 'right' }); y += 5;
    if (globalPax > 0) { doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm); doc.text(`Svarende til ${fK(tot / globalPax)} pr. pax inkl. moms`, pw - mr, y, { align: 'right' }); y += 6; }

    // Wishes
    if (_tCustomerWishes) {
        chk(15); y += 4; doc.setFillColor(...cr);
        const nl = doc.splitTextToSize(_tCustomerWishes, cw - 10);
        const nh = nl.length * 4 + 10; doc.roundedRect(ml, y, cw, nh, 2, 2, 'F');
        doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx); doc.text('Kunde \u00f8nsker:', ml + 5, y + 5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm); doc.text(nl, ml + 5, y + 10);
    }

    // Footer
    const fy = ph - 18; doc.setDrawColor(200, 195, 185); doc.setLineWidth(0.2); doc.line(ml, fy, pw - mr, fy);
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(...tx);
    doc.text(_tCompany.name + (_tCompany.cvr ? ' \u00b7 CVR: ' + _tCompany.cvr : ''), ml, fy + 5);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...dm);
    const footParts = [_tCompany.address, _tCompany.email, _tCompany.phone].filter(Boolean);
    doc.text(footParts.join(' \u00b7 '), ml, fy + 9);
    doc.text(`Gyldigt i ${_tValidDays} dage. Priser i DKK.`, pw - mr, fy + 5, { align: 'right' });

    return { doc, filename: `Tilbud_${qi}_${cn.replace(/\s+/g, '_')}.pdf` };
}

/** Download-knappen: byg PDF'en og gem den lokalt. */
function _tGenPDF() {
    const { doc, filename } = _tBuildPDF();
    doc.save(filename);
}

/** Send tilbud som mail med PDF vedhæftet */
async function _tSendQuoteMail() {
    if (!_tQuoteId) { _tToast('Gem tilbuddet først', 'warning'); return; }
    const email = _tCust?.email;
    if (!email) { _tToast('Kunden har ingen email', 'warning'); return; }

    // Show send form if not visible
    let container = document.getElementById('tilbudMailSend');
    if (container && container.style.display !== 'none') {
        container.style.display = 'none';
        return;
    }
    if (!container) {
        container = document.createElement('div');
        container.id = 'tilbudMailSend';
        container.className = 'tilbud-mail-send';
        // Insert after the button row
        const btnRow = document.querySelector('.tilbud-step-content > div:first-child');
        if (btnRow) btnRow.after(container);
        else return;
    }
    container.style.display = 'block';

    const cn = _tCust?.company_name || _tCust?.customer_name || 'Kunde';
    container.innerHTML = `
        <div style="background:var(--color-background, #f5f4f2);border:1px solid var(--color-border, #d7d1ca);border-radius:8px;padding:12px;margin-bottom:16px;">
            <div style="font-weight:600;margin-bottom:8px;">${mailIcon(14)} Send tilbud til kunde</div>
            <div style="margin-bottom:6px;">
                <label style="font-size:11px;display:block;">Til</label>
                <input type="email" id="tMailTo" value="${_tEsc(email)}" style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:13px;">
            </div>
            <div style="margin-bottom:6px;">
                <label style="font-size:11px;display:block;">Emne</label>
                <input type="text" id="tMailSubject" value="Tilbud ${_tEsc(_tQuoteNumber || '')}" style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:13px;">
            </div>
            <div style="margin-bottom:6px;">
                <label style="font-size:11px;display:block;">Besked</label>
                <textarea id="tMailBody" rows="4" style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:13px;resize:vertical;">Kære ${_tEsc(cn)},

Vedhæftet finder du vores tilbud ${_tEsc(_tQuoteNumber || '')}.

Vi ser frem til at høre fra jer.

Med venlig hilsen
Ristet Rug</textarea>
            </div>
            <div class="bm-attachments" id="tMailAttachments">
                <span class="bm-att-pill">📎 Tilbud_${_tEsc(_tQuoteNumber || 'ny')}.pdf <span style="color:var(--color-text-dim);font-size:10px;">(genereres ved send)</span></span>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="tilbud-btn tilbud-btn-primary" id="tMailSendBtn" onclick="_tDoSendMail()">${mailIcon(13)} Send</button>
                <button class="tilbud-btn tilbud-btn-secondary" onclick="document.getElementById('tilbudMailSend').style.display='none'">Annuller</button>
            </div>
        </div>`;
}

async function _tDoSendMail() {
    const to = document.getElementById('tMailTo').value.trim();
    const subject = document.getElementById('tMailSubject').value.trim();
    const text = document.getElementById('tMailBody').value.trim();
    const btn = document.getElementById('tMailSendBtn');

    if (!to) { alert('Indtast email-adresse'); return; }
    if (!text) { alert('Skriv en besked'); return; }

    btn.disabled = true;
    btn.textContent = 'Genererer PDF…';

    try {
        // 1. Byg PDF'en og hent den som blob (samme dokument som download-knappen)
        const { doc: pdfDoc, filename } = _tBuildPDF();
        const blob = pdfDoc.output('blob');
        if (!blob || !blob.size) throw new Error('PDF generering fejlede — tom fil');

        // 2. Upload PDF
        btn.textContent = 'Uploader PDF…';
        const uploadResult = await uploadAttachment(blob, 'bon', _tQuoteId, filename);
        if (!uploadResult || !uploadResult.attachment_id) {
            throw new Error('PDF blev ikke gemt — mailen er ikke sendt');
        }

        // 3. Send mail with attachment
        btn.textContent = 'Sender mail…';
        const bonId = _tQuoteId; // Tilbud er bon med is_offer=1
        await sendBonMail(bonId, {
            to, subject, text,
            attachments: [{ attachment_id: uploadResult.attachment_id }]
        });

        // 4. Success
        btn.innerHTML = mailIcon(13) + ' Sendt!';
        _tToast('Tilbud sendt til ' + to, 'success');
        setTimeout(() => {
            const container = document.getElementById('tilbudMailSend');
            if (container) container.style.display = 'none';
        }, 2000);

    } catch (err) {
        console.error('[tilbud] Send mail fejl:', err);
        alert('Fejl ved afsendelse: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = mailIcon(13) + ' Send';
    }
}
