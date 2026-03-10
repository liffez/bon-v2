/**
 * bon_kort.js
 * ════════════════════════════════════════════════════════════
 * Al logik for bon-kortet.
 * Ingen forretningslogik — kun ren komponent-logik.
 *
 * Afhænger af (skal loades først):
 *   BonConfig.js     → BON_CONFIG
 *   BonConfigBar.js  → VIEW_WINDOWS
 *
 * Load-rækkefølge i HTML:
 *   <script src="BonConfig.js"></script>
 *   <script src="BonConfigBar.js"></script>
 *   <script src="bon_kort.js"></script>
 * ════════════════════════════════════════════════════════════
 */

/* ── INTERNE TILSTANDE ─────────────────────────────────────── */
const _prevStatus    = {};   // cardId → forrige status (til fortryd)
const _fortrydTimers = {};   // cardId → setTimeout-reference

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
const _countdownIntervals = {};  // cardId → setInterval-reference

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
   createCard(bonData)
   ══════════════════════════════════════════════════════════════

   Bygger et komplet bon-kort DOM-element fra et JSON-objekt.
   Returnerer elementet — kalder selv buildStatusBar() på det.

   bonData-schema:
   {
     id:            number,          // bonnummer, f.eks. 3288
     status:        string,          // 'igang', 'klar', 'lev', ...
     payment:       string,          // 'faktura' | 'kontant'
     pickup_time:   string,          // '10:30'
     delivery_time: string,          // '11:00' (valgfri)
     date:          string,          // 'Man 9. marts'
     units:         number,          // primær enhed (hvad køkkenet laver)
     unit_label:    string,          // 'stk', 'ps', 'bakke', ...
     pax:           number,          // antal personer (valgfri)
     customer: {
       name:        string,
       company:     string,          // valgfri
       address:     string,
       phone:       string,          // valgfri
       email:       string,          // valgfri
     },
     delivery_address: string,       // valgfri, hvis forskellig fra kunde
     order_type:    string,          // 'catering' | 'pickup' | 'event'
     alerts: [                       // valgfri
       { type: 'kitchen-info' | 'delivery-info', text: string }
     ],
     prep: [                         // valgfri
       { id: string, label: string, checked: boolean }
     ],
     menu: [                         // valgfri
       { type: 'item',    qty: string, name: string, style?: 'emballage' }
       { type: 'divider' }
       { type: 'group',   title: string, note?: string, items: [...] }
     ],
     co2:           string,          // valgfri, f.eks. '2.4 kg CO₂e'
     modules: {                      // valgfri — overskriver view-defaults
       prep:        boolean,
       customer:    boolean,
       alerts:      boolean,
       co2:         boolean,
       select:      boolean,
     }
   }

   Moduler der vises afhænger af viewet (data-view på container).
   Kan overstyres per kort via bonData.modules.
   ══════════════════════════════════════════════════════════════ */

const VIEW_MODULES = {
    'kitchen-today':  { prep: true,  customer: true,  alerts: false, co2: false, select: true,  kitchenInfo: true, deliveryBlock: true, summary: true },
    'kitchen-later':  { prep: false, customer: true,  alerts: true,  co2: false, select: false },
    'invoice':        { prep: false, customer: true,  alerts: false, co2: false, select: true  },
    'all':            { prep: false, customer: true,  alerts: true,  co2: true,  select: true  },
};


/* ── Action-knapper per view ────────────────────────────────
   Kitchen-zonen bruger køkken-relevante actions.
   Office-zonen vil bruge andre (tilføjes ved behov).
   ────────────────────────────────────────────────────────── */
const VIEW_ACTIONS = {
    'kitchen-today': [
        { tooltip: 'Tilføj vare',   icon: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>' },
        { tooltip: 'Send flyver',   icon: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
        { tooltip: 'Råvarer',       icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' },
        { tooltip: 'Kort',          icon: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
        { tooltip: 'Sammentælling', icon: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="14" y2="18"/><polyline points="17 14 20 17 17 20"/>', onclick: 'showSummary' },
    ],
    'kitchen-later': [
        { tooltip: 'Åbn bon',       icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    ],
    'invoice': [
        { tooltip: 'Åbn bon',       icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { tooltip: 'Fakturér',      icon: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    ],
    'all': [
        { tooltip: 'Åbn bon',       icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
    ],
};

function _buildActions(viewName, cardId) {
    const actions = VIEW_ACTIONS[viewName] || VIEW_ACTIONS['all'];
    return actions.map(a => {
        const click = a.onclick ? ` onclick="${a.onclick}('${cardId}')"` : '';
        return `<button class="action-btn" data-tooltip="${a.tooltip}"${click}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${a.icon}</svg>
        </button>`;
    }).join('');
}

function createCard(bonData, viewName) {
    const id     = bonData.id;
    const cardId = 'bon' + id;
    const num    = id;

    // Bestem aktive moduler
    const viewMods  = VIEW_MODULES[viewName] || VIEW_MODULES['all'];
    const mods      = Object.assign({}, viewMods, bonData.modules || {});

    const el = document.createElement('div');
    el.className   = 'bon-card';
    el.id          = cardId;
    el.dataset.status  = bonData.status;
    el.dataset.payment = bonData.payment || 'faktura';
    el.dataset.view    = viewName || 'all';   // bruges af buildStatusBar

    // ── HEADER ──────────────────────────────────────────────────
    const orderTypeLabel = bonData.order_type === 'pickup' ? 'Afhentning' :
                           bonData.order_type === 'event'  ? 'Event'      : 'Levering';
    const levStr = bonData.delivery_time ? ` → Lev ${bonData.delivery_time}` : '';
    const paxStr = bonData.pax ? `${bonData.pax} pax` : '';

    // Fortryd: overlay for kitchen-today, generisk bar for andre views
    const isKitchenToday = viewName === 'kitchen-today';
    const fortrydHtml = isKitchenToday
        ? `<div class="fortryd-overlay" onclick="fortrydLevering('${cardId}')">
               <div class="fortryd-pill">Fortryd levering <span class="fortryd-cd" id="cd${num}">8</span></div>
           </div>`
        : `<div class="fortryd-bar" id="fortryd${num}">
               <span>Forsvinder om <strong><span id="countdown${num}">8</span>s</strong></span>
               <button class="fortryd-btn" onclick="fortryd('${cardId}')">Fortryd</button>
           </div>`;

    // Kunde med delivery-block
    const customerHtml = mods.customer && bonData.customer
        ? _buildCustomer(bonData.customer, num, mods.deliveryBlock ? bonData : null)
        : '';

    el.innerHTML = `
        ${fortrydHtml}

        <div class="bon-header">
            <div class="bon-header-left">
                <div class="bon-id">#${bonData.bon_number || id}</div>
                <div class="bon-time-row">
                    <span class="bon-pickup">${bonData.pickup_time || ''}</span>
                    <span class="bon-lev">${levStr}</span>
                </div>
                <div class="bon-date">${bonData.date || ''} · ${orderTypeLabel}</div>
            </div>
            <div class="bon-header-right">
                <div class="unit-primary">${bonData.units}</div>
                <div class="unit-primary-label">${bonData.unit_label || 'stk'}</div>
                ${paxStr ? `<div class="unit-secondary">${paxStr}</div>` : ''}
            </div>
        </div>

        <!-- Status-bar (bygges dynamisk) -->
        <div class="bon-status-bar" id="sbar${num}"></div>

        ${mods.prep && bonData.prep ? _buildPrep(bonData.prep, num) : ''}
        ${customerHtml}
        ${mods.kitchenInfo ? _buildKitchenInfo(bonData, num) : ''}
        ${mods.alerts && bonData.alerts && bonData.alerts.length ? _buildAlerts(bonData.alerts) : ''}

        <!-- Menu -->
        <div class="bon-menu" id="menu${num}">
            <div class="select-toolbar" id="toolbar${num}">
                <span id="selCount${num}">0 valgt</span>
                <div style="display:flex;gap:6px">
                    <button class="sel-btn" onclick="groupSelected('menu${num}')">Gruppér</button>
                    <button class="sel-btn cancel" onclick="exitSelect('${cardId}')">Annuller</button>
                </div>
            </div>
            <div class="select-mode-container">
                ${bonData.menu ? _buildMenu(bonData.menu, num) : ''}
            </div>
        </div>

        ${mods.co2 && bonData.co2 ? _buildCo2(bonData.co2) : ''}

        <!-- Actions — sæt per view -->
        <div class="bon-actions">
            <div class="bon-actions-left">
                ${_buildActions(viewName, cardId)}
            </div>
            ${mods.select ? `
            <button class="select-toggle-btn" id="selBtn${num}" onclick="enterSelect('${cardId}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7" rx="1"/>
                    <rect x="14" y="3" width="7" height="7" rx="1"/>
                    <rect x="3" y="14" width="7" height="7" rx="1"/>
                    <rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
            </button>` : ''}
            ${mods.summary ? _buildSummaryPanel(num, cardId) : ''}
        </div>
    `;

    // Byg status-bar nu hvor elementet eksisterer
    buildStatusBar(el);

    return el;
}

/* ── Hjælpefunktioner til createCard ───────────────────────── */

function _buildPrep(prepItems, num) {
    const badges = prepItems.map(p => `
        <div class="prep-badge${p.checked ? ' checked' : ''}" data-prep-id="${p.id}">
            <div class="prep-check"></div>
            ${p.label}
        </div>`).join('');
    return `<div class="bon-prep">${badges}</div>`;
}

function _buildCustomer(c, num, bonDataForDelivery) {
    const company = c.company ? ` · ${c.company}` : '';
    const detailParts = [
        c.phone ? `<div class="detail-row">📞 <a href="tel:${c.phone}">${c.phone}</a></div>` : '',
        c.email ? `<div class="detail-row">✉ <a href="mailto:${c.email}">${c.email}</a></div>` : '',
    ].filter(Boolean).join('');

    // Delivery block inde i customer details
    const deliveryHtml = bonDataForDelivery ? _buildDeliveryBlock(bonDataForDelivery) : '';
    const allDetails = detailParts + deliveryHtml;
    const hasDetails = allDetails.length > 0;

    return `
        <div class="bon-customer${hasDetails ? '' : ' no-expand'}"
             ${hasDetails ? 'onclick="toggleCustomer(this)"' : ''}>
            <div>
                <div class="customer-name">${c.name}${company}</div>
                <div class="customer-address">${c.address}</div>
            </div>
            ${hasDetails ? '<div class="customer-expand">▾</div>' : ''}
        </div>
        ${hasDetails ? `<div class="bon-customer-details">${allDetails}</div>` : ''}`;
}

function _buildKitchenInfo(bonData, num) {
    const text = bonData.kitchen_info || '';
    const hasContent = text.trim().length > 0;
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    return `
        <div class="bon-kitchen${hasContent ? '' : ' empty'}" id="kitchen${num}">
            <div class="kitchen-pill" onclick="openKitchenEdit('${num}')">
                <span class="kitchen-pill-text">${hasContent ? _esc(text) : ''}</span>
                <span class="kitchen-pill-edit">✎</span>
            </div>
            <button class="kitchen-add-btn" onclick="openKitchenEdit('${num}')">+ Køkkeninfo</button>
            <div class="kitchen-edit">
                <textarea class="kitchen-edit-input" id="kitchenInput${num}"
                    oninput="autoResizeKitchen(this)">${hasContent ? _esc(text) : ''}</textarea>
                <div class="kitchen-edit-actions">
                    <button class="kitchen-save-btn" onclick="saveKitchenEdit('${num}')">Gem</button>
                    <button class="kitchen-cancel-btn" onclick="cancelKitchenEdit('${num}')">Annuller</button>
                </div>
            </div>
        </div>`;
}

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

function _buildDeliveryBlock(bonData) {
    const notes = bonData.delivery_notes || '';
    const method = bonData.delivery_method || '';
    if (!notes && !method) return '';
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const parts = [];
    if (method) parts.push(method);
    if (notes) parts.push(_esc(notes));
    return `
        <div class="delivery-block">
            <div class="delivery-label">Leveringsinfo</div>
            <div class="delivery-text">${parts.join(' · ')}</div>
        </div>`;
}

function _buildSummaryPanel(num, cardId) {
    return `
        <div class="summary-panel" id="summary${num}">
            <div class="summary-header">Sammentælling
                <button class="summary-close" onclick="closeSummary('${cardId}')">×</button>
            </div>
            <div id="summaryRows${num}"></div>
        </div>`;
}

function _buildAlerts(alerts) {
    const items = alerts.map(a => `
        <div class="bon-alert ${a.type}">
            <div class="bon-alert-label">${a.type === 'kitchen-info' ? 'Køkkeninfo' : 'Leveringsinfo'}</div>
            ${a.text}
        </div>`).join('');
    return `<div class="bon-alerts">${items}</div>`;
}

function _buildMenu(menuItems, num) {
    return menuItems.map(item => {
        if (item.type === 'divider') {
            return `<div class="bon-menu-divider"></div>`;
        }
        if (item.type === 'group') {
            const groupItems = item.items.map(gi => _buildMenuItem(gi, num)).join('');
            const hasNote = item.note && item.note.trim();
            return `
                <div class="bon-menu-group">
                    <div class="group-header" draggable="true" data-drag="group">
                        <div class="group-drag-handle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="9" cy="5" r="1" fill="currentColor"/>
                                <circle cx="9" cy="12" r="1" fill="currentColor"/>
                                <circle cx="9" cy="19" r="1" fill="currentColor"/>
                                <circle cx="15" cy="5" r="1" fill="currentColor"/>
                                <circle cx="15" cy="12" r="1" fill="currentColor"/>
                                <circle cx="15" cy="19" r="1" fill="currentColor"/>
                            </svg>
                        </div>
                        <div class="group-select" onclick="toggleGroupSelect(this,'menu${num}')"></div>
                        <span class="group-title">${item.title}</span>
                        <input class="group-title-input" type="text" value="${item.title}"
                               onblur="finishTitle(this)" onkeydown="titleKey(event,this)">
                        <button class="group-note-btn ${hasNote ? 'has-note' : 'empty'}" onclick="toggleNote(this)">
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
                    <div class="group-note-area${hasNote ? ' open' : ''}">
                        <textarea class="group-note-input" rows="1"
                                  placeholder="Note til denne gruppe…"
                                  oninput="noteChanged(this)">${item.note || ''}</textarea>
                    </div>
                    ${groupItems}
                </div>`;
        }
        return _buildMenuItem(item, num);
    }).join('');
}

function _buildMenuItem(item, num) {
    const cls = item.style === 'emballage' ? ' emballage' : '';
    return `
        <div class="bon-menu-item${cls}" draggable="true" data-drag="item">
            <div class="drag-handle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="9" cy="5" r="1" fill="currentColor"/>
                    <circle cx="9" cy="12" r="1" fill="currentColor"/>
                    <circle cx="9" cy="19" r="1" fill="currentColor"/>
                    <circle cx="15" cy="5" r="1" fill="currentColor"/>
                    <circle cx="15" cy="12" r="1" fill="currentColor"/>
                    <circle cx="15" cy="19" r="1" fill="currentColor"/>
                </svg>
            </div>
            <div class="item-select" onclick="toggleItem(this,'menu${num}')"></div>
            <span class="bon-menu-qty">${item.qty}</span>
            <span class="bon-menu-name">${item.name}</span>
        </div>`;
}

function _buildCo2(co2str) {
    return `
        <div class="bon-co2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a10 10 0 100 20A10 10 0 0012 2z"/>
                <path d="M8 12s1-3 4-3 4 3 4 3-1 3-4 3-4-3-4-3z"/>
            </svg>
            <span class="bon-co2-value">${co2str}</span>
        </div>`;
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
   INIT
   Bygger status-bar på alle kort ved sideload.
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.bon-card').forEach(card => buildStatusBar(card));
});
