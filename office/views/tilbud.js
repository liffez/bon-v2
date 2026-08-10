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
let _tCxItems = [];      // custom free-text items
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
let _tBlocksLoaded = false;
let _tCompany = { name: 'Ristet Rug', cvr: '', address: '', phone: '', email: 'info@ristetrug.dk' };

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

function _tToast(msg) {
    const el = document.createElement('div');
    el.className = 'tilbud-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

/* ── Init / Cleanup ──────────────────────────────────── */

function initTilbud(container, opts) {
    _tC = container;
    _tOpts = opts || {};
    _tMode = 'list';
    _tListFilter = 'all';

    // Load logo + block types (fire-and-forget, cached)
    if (!_tLogoB64) {
        fetch('/assets/logo-b64.txt').then(r => r.text()).then(t => { _tLogoB64 = t.trim(); }).catch(() => {});
    }
    if (!_tBlocksLoaded) {
        _tLoadBlockTypes();
    }

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
            _tBLOCKS = arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(b => ({
                id: b.key,
                label: b.label,
                icon: _tBLOCK_ICONS[b.key] || _tDEFAULT_ICON,
                color: _tBLOCK_COLORS[b.key] || _tDEFAULT_COLOR,
            }));
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
    _tBlocksLoaded = true;
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

async function _tLoadMenuAndRender() {
    if (_tMenu) { _tRenderWizard(); return; }
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
                unit: r.unit || 'stk',
                unitPrice: r.prices?.[_tPriceCat] ?? r.prices?.catering ?? 0,
                costPrice: r.cost_price ?? 0,
            });
        }
    } catch (e) {
        _tC.innerHTML = '<div class="tilbud-empty"><div class="icon">!</div><p>Kunne ikke hente menuen fra Grocy.</p></div>';
        return;
    }
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
                    category: l.block_type || 'Ukendt',
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
    _tCxItems = [];
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
        // Pax per blok
        if (_tTpl === 'event') {
            _tBlockMeta = {};
            _tBLOCKS.forEach(b => {
                const bpax = v('t-bpax-' + b.id);
                if (bpax && parseInt(bpax) > 0) _tBlockMeta[b.id] = { pax: parseInt(bpax) };
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

async function _tCopyBon(bonId) {
    try {
        const bon = await apiFetch(`/bons/${bonId}`);
        _tSiItems = [];
        _tEvBlk = {};
        _tActBlk = new Set();
        if (bon.lines) {
            for (const l of bon.lines) {
                const item = {
                    id: l.grocy_recipe_id || Date.now() + Math.random(),
                    grocy_recipe_id: l.grocy_recipe_id,
                    name: l.product_name,
                    unit: l.unit || 'stk',
                    unitPrice: l.unit_price ?? 0,
                    costPrice: l.cost_price ?? 0,
                    qty: l.quantity || 1,
                    category: l.category || 'Ukendt',
                };
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
        _tToast(`${bon.lines?.length || 0} varer kopieret fra bon ${bon.bon_number}`);
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
        for (const items of Object.values(_tEvBlk)) {
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
        h += `<div class="tilbud-chip ${_tActBlk.has(b.id) ? 'a-' + b.color : ''}" onclick="_tTogBlk('${b.id}')">${b.icon} ${b.label}</div>`;
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

        // Custom item input
        h += `<div class="tilbud-custom-row">
            <div class="tilbud-form-group grow"><label>Fritekst</label><input type="text" id="t-bcn-${b.id}" placeholder="Fx 'S\u00e6rlig ret'"></div>
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

    // Custom item
    h += `<div class="tilbud-custom-row">
        <div class="tilbud-form-group grow"><label>Fritekst</label><input type="text" id="t-cx-n" placeholder="Fx 'Service'"></div>
        <div class="tilbud-form-group short"><label>Pris</label><input type="number" id="t-cx-p" placeholder="0"></div>
        <button class="tilbud-btn tilbud-btn-secondary tilbud-btn-sm" onclick="_tAddCx()" style="align-self:flex-end">+</button>
    </div>`;

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
    if (_tActBlk.has(id)) { _tActBlk.delete(id); delete _tEvBlk[id]; _tColBlk.delete(id); }
    else { _tActBlk.add(id); if (!_tEvBlk[id]) _tEvBlk[id] = []; }
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
    const allP = Object.values(_tMenu).flat();
    const item = allP.find(p => p.id === id);
    if (!item) return;
    const arr = bid ? (_tEvBlk[bid] || (_tEvBlk[bid] = [])) : _tSiItems;
    const idx = arr.findIndex(s => s.id === id);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push({ ...item, qty: 1, category: item.category || '' });
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

function _tAddBCx(bid) {
    const n = document.getElementById(`t-bcn-${bid}`)?.value.trim();
    const p = parseFloat(document.getElementById(`t-bcp-${bid}`)?.value) || 0;
    if (!n) return;
    if (!_tEvBlk[bid]) _tEvBlk[bid] = [];
    _tEvBlk[bid].push({ id: Date.now(), name: n, category: 'Fritekst', unitPrice: p, costPrice: 0, qty: 1 });
    _tRenderWizard();
}

function _tAddCx() {
    const n = document.getElementById('t-cx-n')?.value.trim();
    const p = parseFloat(document.getElementById('t-cx-p')?.value) || 0;
    if (!n) return;
    _tCxItems.push({ name: n, price: p });
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
                h += `<tr><td><strong>${_tEsc(it.name)}</strong></td>`;
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
            h += `<tr><td><strong>${_tEsc(it.name)}</strong></td>`;
            h += `<td class="r">${it.qty}</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(lt)}</td>`;
            h += `<td class="r" style="font-size:.73rem;color:var(--color-text-dim);font-family:'JetBrains Mono',monospace">${_tFk(lc)} (${dbP.toFixed(0)}%)</td>`;
            h += `<td><button class="tilbud-btn-icon danger" onclick="_tRemP(${it.id},'')">\u2715</button></td></tr>`;
        });
    }

    // Custom items
    _tCxItems.forEach((ci, i) => {
        sub += ci.price;
        h += `<tr><td><strong>${_tEsc(ci.name)}</strong></td><td class="r">1</td><td class="r" style="font-family:'JetBrains Mono',monospace">${_tFk(ci.price)}</td><td class="r" style="font-size:.73rem;color:var(--color-text-dim)">\u2014</td><td><button class="tilbud-btn-icon danger" onclick="_tRemCx(${i})">\u2715</button></td></tr>`;
    });

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

function _tRemCx(i) { _tCxItems.splice(i, 1); _tRenderWizard(); }

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
        if (_tDel.type && _tDel.price > 0 && !_tDel.free) h += (dTypes[_tDel.type] || 'Levering') + ' ' + _tFk(_tDel.price);
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
            const cats = {};
            its.forEach(i => { const c = i.category || 'Ukendt'; if (!cats[c]) cats[c] = []; cats[c].push(i); });
            Object.keys(cats).forEach(cat => {
                cats[cat].forEach(i => {
                    h += `<div class="tilbud-pv-row"><span class="rn">${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${_tEsc(i.name)}</span>${sL ? `<span class="rp">${_tFk(i.unitPrice * i.qty)}</span>` : ''}</div>`;
                });
            });
        });
    } else {
        const cats = {};
        _tSiItems.forEach(i => { const c = i.category || 'Ukendt'; if (!cats[c]) cats[c] = []; cats[c].push(i); });
        Object.keys(cats).forEach(cat => {
            cats[cat].forEach(i => {
                const lt = i.unitPrice * i.qty;
                sub += lt;
                h += `<div class="tilbud-pv-row"><span class="rn">${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${_tEsc(i.name)}</span>${sL ? `<span class="rp">${_tFk(lt)}</span>` : ''}</div>`;
            });
        });
    }

    // Custom items
    _tCxItems.forEach(ci => { sub += ci.price; h += `<div class="tilbud-pv-row"><span class="rn">${_tEsc(ci.name)}</span><span class="rp">${_tFk(ci.price)}</span></div>`; });

    // Delivery
    if (_tDel.type) {
        const dp = _tDel.free ? 0 : _tDel.price;
        sub += dp;
        if (dp > 0) h += `<div class="tilbud-pv-row"><span class="rn">\u{1F69A} Levering: ${dTypes[_tDel.type] || ''}${_tDel.note ? ' \u00b7 ' + _tEsc(_tDel.note) : ''}</span><span class="rp">${_tFk(dp)}</span></div>`;
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

    if (isEv) {
        _tBLOCKS.forEach(b => {
            if (!_tActBlk.has(b.id)) return;
            (_tEvBlk[b.id] || []).forEach(it => {
                lines.push({
                    block_type: b.id,
                    grocy_recipe_id: it.grocy_recipe_id || null,
                    product_name: it.name,
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
                quantity: it.qty,
                unit: it.unit || 'stk',
                unit_price: it.unitPrice,
                cost_price: it.costPrice,
                sort_order: order++,
            });
        });
    }

    // Custom items as lines too
    _tCxItems.forEach(ci => {
        lines.push({
            block_type: null,
            grocy_recipe_id: null,
            product_name: ci.name,
            quantity: 1,
            unit: 'stk',
            unit_price: ci.price,
            cost_price: 0,
            sort_order: order++,
        });
    });

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

function _tGenPDF() {
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
            doc.text((dTy[_tDel.type] || 'Levering') + '  ' + fK(_tDel.price), ml, y); y += 4.5;
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
            its.forEach(it => {
                chk(7); doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
                doc.text(`${it.qty > 1 ? it.qty + '\u00d7 ' : ''}${it.name}`, ml, y);
                if (sL) doc.text(fK(it.unitPrice * it.qty), pw - mr, y, { align: 'right' });
                y += 5.5;
            });
            y += 3;
        });
    } else {
        const cats = {};
        _tSiItems.forEach(i => { const c = i.category || 'Ukendt'; if (!cats[c]) cats[c] = []; cats[c].push(i); });
        Object.keys(cats).forEach(cat => {
            chk(10); doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...br);
            doc.text(cat.toUpperCase(), ml, y); y += 4;
            cats[cat].forEach(i => {
                chk(6); const lt = i.unitPrice * i.qty; sub += lt;
                doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
                doc.text(`${i.qty > 1 ? i.qty + '\u00d7 ' : ''}${i.name}`, ml, y);
                if (sL) doc.text(fK(lt), pw - mr, y, { align: 'right' });
                y += 5.5;
            }); y += 2;
        });
    }

    // Custom items
    if (_tCxItems.length) {
        chk(10); doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...br); doc.text('\u00d8VRIGE', ml, y); y += 4;
        _tCxItems.forEach(ci => { chk(6); sub += ci.price; doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx); doc.text(ci.name, ml, y); doc.text(fK(ci.price), pw - mr, y, { align: 'right' }); y += 5.5; }); y += 2;
    }

    // Delivery
    if (_tDel.type) {
        chk(6); const dp = _tDel.free ? 0 : _tDel.price; sub += dp;
        doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...tx);
        doc.text(`Levering: ${dTy[_tDel.type] || ''}${_tDel.note ? ' \u00b7 ' + _tDel.note : ''}`, ml, y); y += 6;
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

    doc.save(`Tilbud_${qi}_${cn.replace(/\s+/g, '_')}.pdf`);
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
        // 1. Generate PDF blob — call _tGenPDF logic but get blob instead of saving
        _tSaveStepFields();
        const { jsPDF } = window.jspdf;
        // We need to re-run the PDF generation but output as blob
        // Easiest: temporarily override doc.save, call _tGenPDF, restore
        let pdfDoc = null;
        const origSave = jsPDF.prototype.save;
        jsPDF.prototype.save = function() { pdfDoc = this; };
        _tGenPDF();
        jsPDF.prototype.save = origSave;
        if (!pdfDoc) throw new Error('PDF generering fejlede');
        const blob = pdfDoc.output('blob');

        // 2. Upload PDF
        btn.textContent = 'Uploader PDF…';
        const cn = _tCust?.company_name || _tCust?.customer_name || 'Kunde';
        const filename = `Tilbud_${_tQuoteNumber || 'ny'}_${cn.replace(/\s+/g, '_')}.pdf`;
        const uploadResult = await uploadAttachment(blob, 'bon', _tQuoteId, filename);

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
