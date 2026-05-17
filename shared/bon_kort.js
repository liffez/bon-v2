/**
 * bon_kort.js
 * ════════════════════════════════════════════════════════════
 * Adfærd og state for bon-kortet.
 * Ingen DOM-bygning — det ligger i bon_kort_builder.js.
 *
 * Afhænger af (skal loades først):
 *   BonConfig.js            → BON_CONFIG
 *   BonConfigBar.js         → VIEW_WINDOWS
 *   bon_kort_builder.js     → createCard, VIEW_MODULES, VIEW_ACTIONS, _build*
 *
 * Load-rækkefølge i HTML:
 *   <script src="BonConfig.js"></script>
 *   <script src="BonConfigBar.js"></script>
 *   <script src="bon_kort_builder.js"></script>
 *   <script src="bon_kort.js"></script>            ← denne fil
 * ════════════════════════════════════════════════════════════
 */

/* ── INTERNE TILSTANDE ─────────────────────────────────────── */
const _prevStatus    = {};   // cardId → forrige status (til fortryd)
const _fortrydTimers = {};   // cardId → setTimeout-reference
const _countdownIntervals = {};  // cardId → setInterval-reference

/* ══════════════════════════════════════════════════════════════
   STATUS-BAR
   ══════════════════════════════════════════════════════════════ */

/**
 * Bygger (eller genbygger) status-baren på et kort.
 * Kaldes ved init og efter hvert status-skift.
 *
 * Logik:
 * 1. Find view-vinduet fra nærmeste data-view ancestor
 * 2. Filtrer 'faktureret' fra ved kontant-betaling
 * 3. Byg knapper — aktiv status får farvet baggrund
 * 4. Tilbud + aktiv → tilføj konverterings-knap
 */
function buildStatusBar(card) {
    const cardId    = card.id;
    const num       = cardId.replace('bon', '');
    // Brug querySelector på kortet direkte — virker både før og efter DOM-indsætning
    const barEl     = card.querySelector('.bon-status-bar');
    if (!barEl) return;

    const curStatus = card.dataset.status;
    const payment   = card.dataset.payment || 'faktura';

    // View er gemt direkte på kortet af createCard()
    const viewName = card.dataset.view || 'all';
    let   window_  = VIEW_WINDOWS[viewName]
        ? [...VIEW_WINDOWS[viewName]]
        : Object.keys(BON_CONFIG.statuses);

    // Kontant m.fl.: spring faktureret over
    if (BON_CONFIG.skipFaktureret.includes(payment)) {
        window_ = window_.filter(s => s !== 'faktureret');
    }

    barEl.innerHTML = '';

    window_.forEach(statusKey => {
        const s       = BON_CONFIG.statuses[statusKey];
        const isActive = statusKey === curStatus;
        const btn     = document.createElement('button');
        btn.className = 'sbar-btn' + (isActive ? ' active' : '');
        btn.textContent = s.label;
        btn.dataset.target = statusKey;

        if (isActive) {
            btn.style.background = s.color;
            btn.style.color      = s.text;
        }

        btn.addEventListener('click', () => setStatus(card, statusKey));
        barEl.appendChild(btn);
    });

    // Tilbud: tilføj konverterings-knap hvis aktiv status er tilbud
    if (curStatus === 'tilbud') {
        const target  = BON_CONFIG.tilbudTarget;
        const ts      = BON_CONFIG.statuses[target];
        const cvtBtn  = document.createElement('button');
        cvtBtn.className   = 'sbar-btn convert-btn';
        cvtBtn.textContent = '→ ' + ts.label;
        cvtBtn.dataset.target = target;
        cvtBtn.addEventListener('click', () => setStatus(card, target));
        barEl.appendChild(cvtBtn);
    }
}

/* ══════════════════════════════════════════════════════════════
   STATUS-SKIFT
   ══════════════════════════════════════════════════════════════ */

/**
 * Sætter ny status på et kort.
 * Opdaterer data-status, genbygger status-bar, viser fortryd-bar.
 */
function setStatus(card, newStatus) {
    const cardId    = card.id;
    const num       = cardId.replace('bon', '');
    const oldStatus = card.dataset.status;

    if (oldStatus === newStatus) return;

    // Gem til fortryd
    _prevStatus[cardId] = oldStatus;

    // Opdater
    card.dataset.status = newStatus;
    buildStatusBar(card);

    // Vis fortryd-bar med nedtælling (8 sek)
    const fortrydEl    = card.querySelector('.fortryd-bar');
    const countdownEl  = card.querySelector('.countdown');
    if (fortrydEl) {
        fortrydEl.classList.add('visible');
        clearTimeout(_fortrydTimers[cardId]);
        clearInterval(_countdownIntervals[cardId]);

        let secs = 8;
        if (countdownEl) countdownEl.textContent = secs;

        _countdownIntervals[cardId] = setInterval(() => {
            secs--;
            if (countdownEl) countdownEl.textContent = secs;
            if (secs <= 0) clearInterval(_countdownIntervals[cardId]);
        }, 1000);

        _fortrydTimers[cardId] = setTimeout(() => {
            fortrydEl.classList.remove('visible');
            clearInterval(_countdownIntervals[cardId]);
        }, 8000);
    }

    // Dispatch event — today.html lytter
    // 'lev' i kitchen-today er en terminal handling: kortet fjernes fra viewet
    card.dispatchEvent(new CustomEvent('bon:status-changed', {
        bubbles: true,
        detail: { id: num, oldStatus, newStatus, view: card.dataset.view }
    }));
}

/**
 * Fortryd seneste status-skift.
 */
function fortryd(cardId) {
    const card = document.getElementById(cardId);
    const num  = cardId.replace('bon', '');
    if (!_prevStatus[cardId]) return;

    card.dataset.status = _prevStatus[cardId];
    buildStatusBar(card);
    _prevStatus[cardId] = null;

    const fortrydEl = card.querySelector('.fortryd-bar');
    if (fortrydEl) fortrydEl.classList.remove('visible');
    clearTimeout(_fortrydTimers[cardId]);
}

/* ══════════════════════════════════════════════════════════════
   KUNDE-TOGGLE
   ══════════════════════════════════════════════════════════════ */
function toggleCustomer(el) {
    el.classList.toggle('expanded');
}

/* Adresse-toggle i today-context: folder customer-address ud/ind på .bon-card.
   Kaldes fra .customer-toggle's egen onclick (stop propagation så bon-customer
   ikke fold-ud-handler trigges samtidig). */
function toggleCustomerAddress(el) {
    const card = el.closest('.bon-card');
    if (!card) return;
    const showing = card.classList.toggle('show-address');
    el.textContent = showing ? '▴ skjul' : '▾ adresse';
}

/* ══════════════════════════════════════════════════════════════
   KØKKENINFO — marker som læst (session-scope, in-memory)
   ══════════════════════════════════════════════════════════════ */
function markKitchenInfoRead(num) {
    const wrap = document.getElementById('kitchen' + num);
    if (!wrap) return;
    wrap.classList.add('read');
}
function markKitchenInfoUnread(num) {
    const wrap = document.getElementById('kitchen' + num);
    if (!wrap) return;
    wrap.classList.remove('read');
}

/* ══════════════════════════════════════════════════════════════
   NOTER PÅ GRUPPER
   ══════════════════════════════════════════════════════════════ */
function toggleNote(btn) {
    const area = btn.closest('.bon-menu-group').querySelector('.group-note-area');
    const open = area.classList.toggle('open');
    if (open) area.querySelector('.group-note-input').focus();
}

function noteChanged(ta) {
    const btn = ta.closest('.bon-menu-group').querySelector('.group-note-btn');
    if (!btn) return;
    ta.value.trim()
        ? (btn.classList.remove('empty'), btn.classList.add('has-note'))
        : (btn.classList.remove('has-note'), btn.classList.add('empty'));
}

/* ══════════════════════════════════════════════════════════════
   SELECT MODE (vælg + gruppér linjer)
   ══════════════════════════════════════════════════════════════ */
function enterSelect(cardId) {
    const card = document.getElementById(cardId);
    const num  = cardId.replace('bon', '');
    card.querySelector('.select-mode-container').classList.add('select-mode');
    document.getElementById('toolbar' + num).classList.add('visible');
    document.getElementById('selBtn'  + num).classList.add('active');
}

function exitSelect(cardId) {
    const card = document.getElementById(cardId);
    const num  = cardId.replace('bon', '');
    const menu = card.querySelector('.select-mode-container');
    menu.classList.remove('select-mode');
    document.getElementById('toolbar' + num).classList.remove('visible');
    document.getElementById('selBtn'  + num).classList.remove('active');
    menu.querySelectorAll('.item-select.checked, .group-select.checked')
        .forEach(el => el.classList.remove('checked'));
    _updateCount(menu, num);
}

function toggleItem(el, menuId) {
    el.classList.toggle('checked');
    _updateCount(document.getElementById(menuId), menuId.replace('menu', ''));
}

function toggleGroupSelect(el, menuId) {
    el.classList.toggle('checked');
    const on = el.classList.contains('checked');
    el.closest('.bon-menu-group').querySelectorAll('.item-select')
        .forEach(i => on ? i.classList.add('checked') : i.classList.remove('checked'));
    _updateCount(document.getElementById(menuId), menuId.replace('menu', ''));
}

function _updateCount(menu, num) {
    const n  = menu.querySelectorAll('.item-select.checked').length;
    const el = document.getElementById('selCount' + num);
    if (el) el.textContent = n + ' valgt';
}

/* ══════════════════════════════════════════════════════════════
   GRUPPÉR VALGTE LINJER
   ══════════════════════════════════════════════════════════════ */
function groupSelected(menuId) {
    const menu  = document.getElementById(menuId);
    // Items live inside .select-mode-container (nested child), not directly in menu
    const container = menu.querySelector('.select-mode-container') || menu;
    const items = [...container.querySelectorAll('.bon-menu-item')].filter(item =>
        item.querySelector('.item-select')?.classList.contains('checked') &&
        !item.closest('.bon-menu-group')
    );

    if (!items.length) {
        const el   = document.getElementById('selCount' + menuId.replace('menu', ''));
        const orig = el.textContent;
        el.textContent = 'Vælg løse linjer';
        setTimeout(() => el.textContent = orig, 2000);
        return;
    }

    const grp = document.createElement('div');
    grp.className = 'bon-menu-group';
    grp.innerHTML = `
        <div class="group-header" draggable="true" data-drag="group">
            <div class="group-drag-handle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="9"  cy="5"  r="1" fill="currentColor"/>
                    <circle cx="9"  cy="12" r="1" fill="currentColor"/>
                    <circle cx="9"  cy="19" r="1" fill="currentColor"/>
                    <circle cx="15" cy="5"  r="1" fill="currentColor"/>
                    <circle cx="15" cy="12" r="1" fill="currentColor"/>
                    <circle cx="15" cy="19" r="1" fill="currentColor"/>
                </svg>
            </div>
            <div class="group-select" onclick="toggleGroupSelect(this,'${menuId}')"></div>
            <span class="group-title hidden"></span>
            <input class="group-title-input visible" type="text"
                   placeholder="Gruppenavn…"
                   onblur="finishTitle(this)"
                   onkeydown="titleKey(event,this)">
            <button class="group-note-btn empty" onclick="toggleNote(this)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
            </button>
            <button class="group-edit-btn" onclick="editTitle(this)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
            </button>
        </div>
        <div class="group-note-area">
            <textarea class="group-note-input" rows="1"
                      placeholder="Note til denne gruppe…"
                      oninput="noteChanged(this)"></textarea>
        </div>`;

    container.insertBefore(grp, items[0]);
    items.forEach(item => {
        item.querySelector('.item-select')?.classList.remove('checked');
        grp.appendChild(item);
    });
    grp.querySelector('.group-title-input').focus();
    _updateCount(menu, menuId.replace('menu', ''));
}

/* ══════════════════════════════════════════════════════════════
   GRUPPENAVN
   ══════════════════════════════════════════════════════════════ */
function editTitle(btn) {
    const h   = btn.closest('.group-header');
    const inp = h.querySelector('.group-title-input');
    h.querySelector('.group-title').classList.add('hidden');
    inp.classList.add('visible');
    inp.value = h.querySelector('.group-title').textContent;
    inp.select(); inp.focus();
}

function finishTitle(inp) {
    const h = inp.closest('.group-header');
    const t = h.querySelector('.group-title');
    t.textContent = inp.value.trim() || 'Gruppe';
    t.classList.remove('hidden');
    inp.classList.remove('visible');
}

function titleKey(e, inp) {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.blur(); }
}

/* ══════════════════════════════════════════════════════════════
   DRAG AND DROP (menu-linjer og grupper)
   ══════════════════════════════════════════════════════════════ */
let _dragEl   = null;
let _dragType = null;

document.addEventListener('dragstart', e => {
    const gh   = e.target.closest('[data-drag="group"]');
    const item = e.target.closest('[data-drag="item"]');
    if (gh && !item) { _dragEl = gh.closest('.bon-menu-group'); _dragType = 'group'; }
    else if (item)   { _dragEl = item; _dragType = 'item'; }
    if (_dragEl) {
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => _dragEl?.classList.add('dragging'), 0);
    }
});

document.addEventListener('dragend', () => {
    _dragEl?.classList.remove('dragging');
    document.querySelectorAll('.drag-over, .drag-over-group')
        .forEach(el => el.classList.remove('drag-over', 'drag-over-group'));
    _dragEl = null; _dragType = null;
});

document.addEventListener('dragover', e => {
    if (!_dragEl) return; e.preventDefault();
    document.querySelectorAll('.drag-over, .drag-over-group')
        .forEach(el => el.classList.remove('drag-over', 'drag-over-group'));
    if (_dragType === 'group') {
        // Grupper kan droppes ved andre grupper…
        const tg = e.target.closest('.bon-menu-group');
        if (tg && tg !== _dragEl) { tg.classList.add('drag-over-group'); return; }
        // …eller ved løse (ugrupperede) menu-items
        const ti = e.target.closest('.bon-menu-item');
        if (ti && !ti.closest('.bon-menu-group')) ti.classList.add('drag-over');
    } else {
        const ti = e.target.closest('[data-drag="item"]');
        if (ti && ti !== _dragEl) ti.classList.add('drag-over');
    }
});

document.addEventListener('drop', e => {
    if (!_dragEl) return; e.preventDefault();
    const tg = document.querySelector('.drag-over-group');
    const ti = document.querySelector('.drag-over');
    if (tg) tg.parentNode.insertBefore(_dragEl, tg);
    else if (ti) ti.parentNode.insertBefore(_dragEl, ti);
    document.querySelectorAll('.drag-over, .drag-over-group')
        .forEach(el => el.classList.remove('drag-over', 'drag-over-group'));
});

/* ══════════════════════════════════════════════════════════════
   KØKKENINFO — inline edit
   ══════════════════════════════════════════════════════════════ */
function openKitchenEdit(num) {
    const el = document.getElementById('kitchen' + num);
    el.classList.add('editing');
    const input = document.getElementById('kitchenInput' + num);
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    autoResizeKitchen(input);
}

function saveKitchenEdit(num) {
    const el = document.getElementById('kitchen' + num);
    const input = document.getElementById('kitchenInput' + num);
    const val = input.value.trim();

    // Opdater pill-tekst
    el.querySelector('.kitchen-pill-text').textContent = val;
    el.classList.toggle('empty', !val);
    el.classList.remove('editing');

    // Gem via API
    patchBonKitchenInfo(num, val || null).catch(err => {
        console.error('Køkkeninfo gem fejlede:', err);
    });
}

function cancelKitchenEdit(num) {
    const el = document.getElementById('kitchen' + num);
    const input = document.getElementById('kitchenInput' + num);
    // Gendan original tekst fra pill
    input.value = el.querySelector('.kitchen-pill-text').textContent;
    el.classList.remove('editing');
}

function autoResizeKitchen(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
}

/* ══════════════════════════════════════════════════════════════
   RECIPE PICKER — delegerer til VarePicker (shared/vare_picker.js)
   ══════════════════════════════════════════════════════════════ */

// VarePicker-instanser per kort (bonId → VarePicker)
var _cardPickers = {};

/**
 * Åbn Google Maps med bonens leveringsadresse.
 * Simpel placeholder — erstattes af logistikmodul senere.
 */
function openMap(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const addrEl = card.querySelector('.customer-address');
    const addr = addrEl ? addrEl.textContent.trim() : '';
    if (!addr || addr === 'Afhentes') return;
    const q = encodeURIComponent(addr);
    window.open(`https://www.google.com/maps/search/?api=1&query=${q}`, '_blank');
}

/**
 * Åbn manual booking-modal (Spor 1: bestil hos taxa/By-expressen).
 * Modal-komponenten skal være loaded i HTML-filen (manual_booking_modal.js).
 */
/**
 * Klik på leveringsindikator på bon-kort → åbner drawer scrollet til bestil-bud-sektion.
 * Bruger view-specifikke drawer-instanser via window._bonInfoEditHandler eller
 * window.BonDrawer fallback.
 */
function openBonDeliveryFromCard(cardId) {
    const num = cardId.replace('bon', '');
    const bonId = parseInt(num);
    if (!bonId) return;

    if (typeof window._bonInfoEditHandler === 'function') {
        window._bonInfoEditHandler(bonId, { scrollTo: 'bestil-bud' });
    } else if (typeof BonDrawer === 'function') {
        const d = new BonDrawer();
        d.open(bonId, { scrollTo: 'bestil-bud' });
    } else {
        console.warn('Ingen drawer-handler registreret');
    }
}

function openBestilBud(cardId) {
    if (typeof window.openManualBookingModal !== 'function') {
        alert('Bestillings-modal er ikke loaded. Kontakt admin.');
        return;
    }
    const card = document.getElementById(cardId);
    if (!card) return;

    // Bud kan ikke bestilles ved afhentning/event — bonnen skal leveres
    const orderType = card.dataset.orderType || '';
    if (orderType === 'pickup' || orderType === 'event') {
        alert('Denne bon er sat til ' + (orderType === 'pickup' ? 'afhentning' : 'event') + '. Bestilling af bud kræver leveringstype "Levering".');
        return;
    }

    const num = cardId.replace('bon', '');
    const bonId = parseInt(num);
    if (!bonId) return;
    window.openManualBookingModal({ bonId });
}

function openRecipePicker(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const num = cardId.replace('bon', '');
    const slot = document.getElementById('vpSlot' + num);
    if (!slot) return;

    // Lazy-create VarePicker instance
    if (!_cardPickers[num]) {
        _cardPickers[num] = new VarePicker({
            bonId: parseInt(num),
            priceCategory: card.dataset.priceCategory || 'catering',
            container: slot,
            viewName: card.dataset.view || 'all',
            onAdded: function() { /* SSE handles re-render */ }
        });
    }
    _cardPickers[num].toggle();
}

function closeRecipePicker(cardId) {
    const num = cardId.replace('bon', '');
    if (_cardPickers[num]) _cardPickers[num].close();
}

/* ══════════════════════════════════════════════════════════════
   BON MAIL — modal med historik + compose
   ══════════════════════════════════════════════════════════════ */

var _mailTemplates = null; // cache

async function openBonMail(cardId) {
    const bonId = cardId.replace('bon', '');
    openModal({ title: 'Mail — Henter...', bodyHtml: '<div style="text-align:center;padding:24px;color:var(--color-text-dim)">Henter mails…</div>' });

    try {
        const [bon, mailData, templates] = await Promise.all([
            fetchBon(bonId),
            fetchBonMail(bonId),
            _mailTemplates || fetchMailTemplates().then(t => { _mailTemplates = t; return t; })
        ]);

        const email = bon.contact_email || bon.customer_email || '';
        const bonNr = bon.bon_number || bonId;
        const threads = mailData.threads || [];

        // Build template vars from bon data
        const vars = _buildMailVars(bon);

        openModal({
            title: '✉ Mail — #' + esc(String(bonNr)),
            bodyHtml: _renderMailModal(bonId, email, threads, templates, vars)
        });
    } catch (err) {
        openModal({ title: '✉ Mail', bodyHtml: '<div class="bm-error">Fejl: ' + esc(err.message) + '</div>' });
    }
}

function _buildMailVars(bon) {
    const lines = bon.lines || [];
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Menu lines
    const menuLines = lines.filter(l => (l.category || '').toLowerCase() !== 'emballage' && (l.category || '').toLowerCase() !== 'levering');
    const menuUdenPriser = menuLines.map(l => l.quantity + '× ' + l.product_name).join('\n');
    const menuMedPriser = menuLines.map(l => {
        const price = l.unit_price ? (l.quantity * l.unit_price).toLocaleString('da-DK') + ' kr' : '';
        return l.quantity + '× ' + l.product_name + (price ? '  ' + price : '');
    }).join('\n');

    // Totals — line_total er incl. moms (jf. BON_V2_PRINCIPPER.md sektion 6b)
    const totalInklMoms = lines.reduce((s, l) => s + (l.line_total || 0), 0);
    const totalExMoms   = window.Moms.inclToExcl(totalInklMoms);
    const moms          = window.Moms.momsOfIncl(totalInklMoms);

    // CO2
    const co2Lines = menuLines.filter(l => l.co2e).map(l =>
        l.product_name + ': ' + l.co2e + ' kg CO₂e × ' + l.quantity + ' = ' + (l.co2e * l.quantity).toFixed(2)
    ).join('\n');
    const co2Total = menuLines.reduce((s, l) => s + ((l.co2e || 0) * l.quantity), 0).toFixed(2);

    // Address/postnummer
    const addrObj = bon.delivery_address || {};
    const addr = typeof addrObj === 'string' ? addrObj : [addrObj.street_name, addrObj.street_nr, addrObj.postal_code, addrObj.city].filter(Boolean).join(' ');
    const postnummer = (typeof addrObj === 'object' && addrObj.postal_code) ? String(addrObj.postal_code) : (addr.match(/(\d{4})\s/) || [])[1] || '';

    return {
        kundeNavn: bon.customer_name || bon.contact_name || '',
        bonNummer: bon.bon_number || '',
        leveringsDato: bon.delivery_date || '',
        leveringsTidspunkt: bon.delivery_time || bon.pickup_time || '',
        leveringsAdresse: addr,
        postnummer: postnummer,
        telefon: bon.customer_phone || '',
        pax: String(bon.pax || ''),
        firmanavn: bon.company_name || '',
        menuUdenPriser: menuUdenPriser,
        menuMedPriser: menuMedPriser,
        totalPris: totalInklMoms.toLocaleString('da-DK', { minimumFractionDigits: 2 }) + ' kr',
        totalExMoms: totalExMoms.toLocaleString('da-DK', { minimumFractionDigits: 2 }) + ' kr',
        momsBeloeb: moms.toLocaleString('da-DK', { minimumFractionDigits: 2 }) + ' kr',
        co2PerLinje: co2Lines,
        co2Total: co2Total + ' kg CO₂e',
    };
}

function _renderMailModal(bonId, email, threads, templates, vars) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // ── HISTORIK ──────────────────────────────────────────
    let histHtml = '';
    let totalUnread = 0;
    const allMsgs = [];
    threads.forEach(t => (t.messages || []).forEach(m => { m._threadSubject = t.subject; allMsgs.push(m); }));
    allMsgs.sort((a, b) => new Date(b.received_at || b.sent_at || b.created_at) - new Date(a.received_at || a.sent_at || a.created_at));

    if (allMsgs.length > 0) {
        const unread = allMsgs.filter(m => m.direction === 'in' && !m.is_read);
        totalUnread = unread.length;

        histHtml = '<div class="bm-history">';
        histHtml += '<div class="bm-history-header">Korrespondance' + (totalUnread ? ' <span class="bm-badge">' + totalUnread + ' ulæst</span>' : '') + '</div>';
        histHtml += '<div class="bm-messages">';
        allMsgs.forEach(m => {
            const isIn = m.direction === 'in';
            const isUnread = isIn && !m.is_read;
            const dateStr = _fmtMailDate(m.received_at || m.sent_at || m.created_at);
            const from = isIn ? (m.from_name || m.from_email || '?') : 'Ristet Rug';
            const bodyPreview = (m.body_text || '').slice(0, 200).replace(/\n/g, ' ');
            const readClick = isUnread ? ' onclick="_markMailRead(\'' + bonId + '\',' + m.id + ',this)"' : '';

            histHtml += '<div class="bm-msg ' + (isIn ? 'bm-in' : 'bm-out') + (isUnread ? ' bm-unread' : '') + '"' + readClick + '>';
            histHtml += '<div class="bm-msg-header"><span class="bm-msg-from">' + _esc(from) + '</span><span class="bm-msg-date">' + dateStr + '</span></div>';
            histHtml += '<div class="bm-msg-subject">' + _esc(m.subject || '') + '</div>';
            histHtml += '<div class="bm-msg-body">' + _esc(bodyPreview) + (bodyPreview.length >= 200 ? '…' : '') + '</div>';
            if (m.attachments && m.attachments.length > 0) {
                histHtml += '<div class="bm-msg-attach">📎 ' + m.attachments.map(a => _esc(a.filename)).join(', ') + '</div>';
            }
            histHtml += '</div>';
        });
        histHtml += '</div></div>';
    } else {
        histHtml = '<div class="bm-no-mail">Ingen korrespondance endnu</div>';
    }

    // ── COMPOSE ──────────────────────────────────────────
    const tmplOptions = (templates || []).map(t =>
        '<option value="' + _esc(t.key) + '">' + _esc(t.label || t.key) + '</option>'
    ).join('');

    const composeHtml = `
        <div class="bm-compose">
            <div class="bm-compose-header">Skriv mail</div>
            <div class="bm-field">
                <label>Til</label>
                <input type="email" id="bmTo" value="${_esc(email)}" placeholder="email@example.com">
            </div>
            <div class="bm-field">
                <label>Skabelon</label>
                <select id="bmTemplate" onchange="_applyMailTemplate('${bonId}')">
                    <option value="">— Ingen skabelon —</option>
                    ${tmplOptions}
                </select>
            </div>
            <div class="bm-field">
                <label>Emne</label>
                <input type="text" id="bmSubject" placeholder="Emne…">
            </div>
            <div class="bm-field">
                <label>Besked</label>
                <textarea id="bmBody" rows="8" placeholder="Skriv besked…"></textarea>
            </div>
            <div class="bm-compose-actions">
                <button class="bm-cancel" onclick="closeModal()">Annuller</button>
                <button class="bm-send" id="bmSendBtn" onclick="_doSendBonMail('${bonId}')">✉ Send</button>
            </div>
        </div>`;

    // Store vars for template application
    return '<div class="bm-container" data-vars=\'' + JSON.stringify(vars).replace(/'/g, '&#39;') + '\'>'
        + histHtml + composeHtml + '</div>';
}

function _fmtMailDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const day = d.getDate();
    const mon = d.getMonth() + 1;
    const hr = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return day + '/' + mon + ' ' + hr + ':' + min;
}

async function _markMailRead(bonId, msgId, el) {
    if (el) el.classList.remove('bm-unread');
    try {
        await markBonMailRead(bonId, msgId);
    } catch (err) {
        console.error('[mail] Markér læst fejl:', err);
    }
}

async function _applyMailTemplate(bonId) {
    const sel = document.getElementById('bmTemplate');
    const key = sel.value;
    if (!key) {
        document.getElementById('bmSubject').value = '';
        document.getElementById('bmBody').value = '';
        return;
    }

    const container = document.querySelector('.bm-container');
    const vars = container ? JSON.parse(container.dataset.vars || '{}') : {};

    // Find template
    const tmpl = (_mailTemplates || []).find(t => t.key === key);
    if (!tmpl) return;

    // Substitute vars
    const subst = (str) => {
        let r = str || '';
        for (const [k, v] of Object.entries(vars)) {
            r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v || '');
        }
        return r;
    };

    document.getElementById('bmSubject').value = subst(tmpl.subject);
    document.getElementById('bmBody').value = subst(tmpl.body_text);
}

async function _doSendBonMail(bonId) {
    const to = document.getElementById('bmTo').value.trim();
    const subject = document.getElementById('bmSubject').value.trim();
    const text = document.getElementById('bmBody').value.trim();
    const btn = document.getElementById('bmSendBtn');

    if (!to) { document.getElementById('bmTo').focus(); return; }
    if (!text && !subject) { document.getElementById('bmSubject').focus(); return; }

    btn.disabled = true;
    btn.textContent = 'Sender…';

    try {
        await sendBonMail(bonId, { to, subject, text });
        closeModal();
        // Toast
        const toast = document.createElement('div');
        toast.className = 'bm-toast';
        toast.textContent = '✉ Mail sendt til ' + to;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    } catch (err) {
        console.error('[mail] Send fejl:', err);
        btn.textContent = 'Fejl — prøv igen';
        btn.disabled = false;
    }
}

/* ══════════════════════════════════════════════════════════════
   updateCard(id, changes)
   ══════════════════════════════════════════════════════════════
   Opdaterer et eksisterende kort i DOM'en.
   Bruges af SSE-handler til realtidsopdateringer.

   changes: { status?, units?, prep?, alerts?, ... }
   ══════════════════════════════════════════════════════════════ */
function updateCard(id, changes) {
    const card = document.getElementById('bon' + id);
    if (!card) return;

    if (changes.status !== undefined) {
        card.dataset.status = changes.status;
        buildStatusBar(card);
    }

    if (changes.units !== undefined) {
        const el = card.querySelector('.unit-primary');
        if (el) el.textContent = changes.units;
    }

    // Tilføj flere felter efter behov
}

/* ══════════════════════════════════════════════════════════════
   SAMMENTÆLLING — totaler per kategori
   ══════════════════════════════════════════════════════════════ */
function _stripCatPrefix(cat) {
    // Fjern ledende sorteringskode som "01 ", "03 " osv.
    return cat.replace(/^\d+\s+/, '');
}

function showSummary(cardId) {
    const num    = cardId.replace('bon', '');
    const panel  = document.getElementById('summary' + num);
    const rows   = document.getElementById('summaryRows' + num);
    if (!panel || !rows) return;
    const isOpen = panel.classList.contains('open');

    // Luk alle andre
    document.querySelectorAll('.summary-panel.open').forEach(p => p.classList.remove('open'));
    if (isOpen) return;

    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Tæl varer op, grupperet per kategori
    const categories = {};
    const card = document.getElementById(cardId);
    card.querySelectorAll('.bon-menu-item').forEach(item => {
        const qtyEl  = item.querySelector('.bon-menu-qty');
        const nameEl = item.querySelector('.bon-menu-name');
        if (!qtyEl || !nameEl) return;
        const qtyText = qtyEl.textContent.trim();
        const match   = qtyText.match(/^([\d.,]+)\s*(.*)$/);
        const qty     = match ? parseFloat(match[1].replace(',', '.')) : 0;
        const unit    = match ? match[2].trim() : '';
        const cat     = (item.dataset.category || '').trim() || 'Andet';
        const name    = nameEl.textContent.trim();
        const key     = name + '||' + unit;

        if (!categories[cat]) categories[cat] = {};
        if (categories[cat][key]) categories[cat][key].qty += qty;
        else categories[cat][key] = { qty, unit, name };
    });

    const catNames = Object.keys(categories).sort((a, b) => a.localeCompare(b, 'da'));
    if (!catNames.length) {
        rows.innerHTML = '<div class="summary-row"><span style="color:var(--gray-dark);font-style:italic;font-size:13px;padding:4px 0">Ingen varer</span></div>';
    } else {
        let html = '';
        let grandTotal = 0;
        for (const cat of catNames) {
            const entries = Object.values(categories[cat]);
            const catTotal = entries.reduce((sum, e) => sum + e.qty, 0);
            grandTotal += catTotal;
            const qtyStr = Number.isInteger(catTotal) ? catTotal : catTotal.toFixed(1);
            html += `<div class="summary-row">
                <span class="summary-qty">${qtyStr}</span>
                <span class="summary-name">${_esc(_stripCatPrefix(cat))}</span>
            </div>`;
        }
        const gtStr = Number.isInteger(grandTotal) ? grandTotal : grandTotal.toFixed(1);
        html += `<div class="summary-row summary-total">
            <span class="summary-qty">${gtStr}</span>
            <span class="summary-name">Total</span>
        </div>`;
        rows.innerHTML = html;
    }
    panel.classList.add('open');
}

function closeSummary(cardId) {
    const num = cardId.replace('bon', '');
    document.getElementById('summary' + num)?.classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   INIT
   Bygger status-bar på alle kort ved sideload.
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.bon-card').forEach(card => buildStatusBar(card));
});
