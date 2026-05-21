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
    const card = ta.closest('.bon-card');
    if (card) scheduleSaveMenuGroups(card.id);
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
            <button class="group-dissolve-btn" onclick="dissolveGroup(this)" title="Opløs gruppe">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
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
    scheduleSaveMenuGroups('bon' + menuId.replace('menu', ''));
}

/* ══════════════════════════════════════════════════════════════
   OPLØS GRUPPE — flyt linjer ud, fjern gruppen
   ══════════════════════════════════════════════════════════════ */
function dissolveGroup(btn) {
    const grp = btn.closest('.bon-menu-group');
    if (!grp) return;
    const card      = btn.closest('.bon-card');
    const container = grp.parentNode;
    [...grp.querySelectorAll('.bon-menu-item')]
        .forEach(item => container.insertBefore(item, grp));
    grp.remove();
    if (card) scheduleSaveMenuGroups(card.id);
}

/* ══════════════════════════════════════════════════════════════
   PERSISTÉR MENU-GRUPPER
   Grupper gemmes automatisk — serveren reconciler hele strukturen.
   ══════════════════════════════════════════════════════════════ */
const _groupSaveTimers = {};

function scheduleSaveMenuGroups(cardId) {
    clearTimeout(_groupSaveTimers[cardId]);
    _groupSaveTimers[cardId] = setTimeout(() => {
        delete _groupSaveTimers[cardId];
        _saveMenuGroups(cardId);
    }, 450);
}

function _saveMenuGroups(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const bonId = cardId.replace('bon', '');

    // Fjern tomme grupper fra DOM (fx sidste linje trukket ud)
    card.querySelectorAll('.bon-menu-group').forEach(grp => {
        if (!grp.querySelector('.bon-menu-item')) grp.remove();
    });

    const groups = [...card.querySelectorAll('.bon-menu-group')].map(grp => {
        const titleSpan = grp.querySelector('.group-title');
        const titleInp  = grp.querySelector('.group-title-input');
        const title = (titleSpan && titleSpan.textContent.trim())
                   || (titleInp && titleInp.value.trim())
                   || 'Gruppe';
        const noteEl = grp.querySelector('.group-note-input');
        const note   = noteEl ? noteEl.value.trim() : '';
        const line_ids = [...grp.querySelectorAll('.bon-menu-item')]
            .flatMap(item => (item.dataset.lineIds || '').split(',')
                .map(s => parseInt(s, 10))
                .filter(n => Number.isInteger(n)));
        return { title, note, line_ids };
    }).filter(g => g.line_ids.length);

    saveMenuGroups(bonId, groups)
        .then(() => _flashGroupSaved(bonId, false))
        .catch(err => {
            console.error('Kunne ikke gemme grupper:', err);
            _flashGroupSaved(bonId, true);
        });
}

// Kort kvittering i select-toolbaren (kun synlig i select-mode)
function _flashGroupSaved(bonId, failed) {
    const cnt = document.getElementById('selCount' + bonId);
    if (!cnt) return;
    cnt.textContent = failed ? '⚠ Ikke gemt' : '✓ Gemt';
    cnt.classList.toggle('save-failed', !!failed);
    setTimeout(() => {
        cnt.classList.remove('save-failed');
        const menu = document.getElementById('menu' + bonId);
        if (menu) _updateCount(menu, bonId);
        else cnt.textContent = '0 valgt';
    }, 1600);
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
    const card = inp.closest('.bon-card');
    if (card) scheduleSaveMenuGroups(card.id);
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
    // Persistér hvis flytningen kan have ændret gruppe-medlemskab eller -rækkefølge
    const card = _dragEl.closest('.bon-card');
    if (card && card.querySelector('.bon-menu-group')) scheduleSaveMenuGroups(card.id);
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
   MENU-LINJE ANTAL — inline rediger
   ══════════════════════════════════════════════════════════════ */

function openQtyEdit(qtyEl) {
    if (!qtyEl || qtyEl.classList.contains('editing')) return;
    const itemEl = qtyEl.closest('.bon-menu-item');
    if (!itemEl) return;
    const ids = (itemEl.dataset.lineIds || '').split(',').filter(Boolean);
    if (ids.length !== 1) return;
    const lineId = ids[0];
    const card = qtyEl.closest('.bon-card');
    if (!card) return;
    const bonId = card.id.replace('bon', '');

    const original = qtyEl.textContent.trim();
    const match = original.match(/^([\d.,]+)/);
    const num = match ? parseFloat(match[1].replace(',', '.')) : 1;

    qtyEl.dataset.originalQty = original;
    qtyEl.classList.add('editing');
    itemEl.classList.add('editing-qty');

    qtyEl.innerHTML =
        '<button type="button" class="qty-step qty-minus" tabindex="-1">−</button>' +
        '<input type="number" class="qty-input" min="1" step="1" value="' + num + '">' +
        '<button type="button" class="qty-step qty-plus" tabindex="-1">+</button>';

    const input = qtyEl.querySelector('.qty-input');
    const minus = qtyEl.querySelector('.qty-minus');
    const plus = qtyEl.querySelector('.qty-plus');

    minus.addEventListener('click', (e) => {
        e.stopPropagation();
        input.value = Math.max(1, (parseInt(input.value) || 1) - 1);
        input.focus();
    });
    plus.addEventListener('click', (e) => {
        e.stopPropagation();
        input.value = (parseInt(input.value) || 1) + 1;
        input.focus();
    });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveQtyEdit(qtyEl, bonId, lineId); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelQtyEdit(qtyEl); }
    });
    input.addEventListener('blur', () => {
        // Lille delay så klik på +/− først registreres
        setTimeout(() => {
            if (qtyEl.classList.contains('editing') && !qtyEl.contains(document.activeElement)) {
                saveQtyEdit(qtyEl, bonId, lineId);
            }
        }, 120);
    });

    input.focus();
    input.select();
}

function saveQtyEdit(qtyEl, bonId, lineId) {
    const input = qtyEl.querySelector('.qty-input');
    if (!input) return;
    const newQty = parseInt(input.value);
    const original = qtyEl.dataset.originalQty || '';
    const originalNum = parseInt((original.match(/^([\d.,]+)/) || [])[1]) || 0;

    if (!Number.isFinite(newQty) || newQty < 1) {
        cancelQtyEdit(qtyEl);
        return;
    }
    if (newQty === originalNum) {
        cancelQtyEdit(qtyEl);
        return;
    }

    const itemEl = qtyEl.closest('.bon-menu-item');
    qtyEl.classList.add('saving');
    putBonLine(bonId, lineId, { quantity: newQty })
        .then(() => {
            qtyEl.textContent = String(newQty);
            qtyEl.classList.remove('editing', 'saving');
            if (itemEl) itemEl.classList.remove('editing-qty');
            delete qtyEl.dataset.originalQty;
        })
        .catch(err => {
            console.error('Kunne ikke gemme antal:', err);
            qtyEl.classList.remove('saving');
            cancelQtyEdit(qtyEl);
            alert(err.message || 'Kunne ikke gemme antal');
        });
}

function cancelQtyEdit(qtyEl) {
    const itemEl = qtyEl.closest('.bon-menu-item');
    qtyEl.textContent = qtyEl.dataset.originalQty || qtyEl.textContent;
    qtyEl.classList.remove('editing', 'saving');
    if (itemEl) itemEl.classList.remove('editing-qty');
    delete qtyEl.dataset.originalQty;
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

/**
 * Åbn popout-vindue til bud-bestilling (Spor 1: taxa/By-expressen).
 * window.openDeliveryNote eksponeres af bon_drawer.js.
 */
function openBestilBud(cardId) {
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

    if (typeof window.openDeliveryNote === 'function') {
        window.openDeliveryNote(bonId, null);
    } else {
        alert('Delivery-popout er ikke loaded. Kontakt admin.');
    }
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
var _bmAttachments = [];   // vedhæftninger til igangværende mail
var _bmBonId = null;

async function openBonMail(cardId) {
    const bonId = cardId.replace('bon', '');
    _bmBonId = bonId;
    _bmAttachments = [];
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
            title: mailIcon(17) + ' Mail — #' + esc(String(bonNr)),
            bodyHtml: _renderMailModal(bonId, email, templates, vars)
        });

        // Historik via fælles MailThread-komponent (klik-for-at-folde-ud).
        MailThread.renderHistory(document.getElementById('bmHistoryHost'), {
            threads: threads,
            header: 'Korrespondance',
            emptyText: 'Ingen korrespondance endnu',
            maxHeight: 340,
            onMarkRead: (id) => markBonMailRead(bonId, id),
        });
    } catch (err) {
        openModal({ title: mailIcon(17) + ' Mail', bodyHtml: '<div class="bm-error">Fejl: ' + esc(err.message) + '</div>' });
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

function _renderMailModal(bonId, email, templates, vars) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Historik fyldes ind af MailThread.renderHistory efter modal er åbnet.
    const histHtml = '<div id="bmHistoryHost" class="bm-history"></div>';

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
            <input type="file" id="bmFile" accept=".pdf,.jpg,.jpeg,.png,.gif,.xlsx,.docx" style="display:none" onchange="_bmOnFileSelected(this)">
            <div id="bmAttachments" class="bm-attachments"></div>
            <div class="bm-compose-actions">
                <button class="bm-attach" id="bmAttachBtn" onclick="_bmAttachFile()">📎 Vedhæft</button>
                <button class="bm-cancel" onclick="closeModal()">Annuller</button>
                <button class="bm-send" id="bmSendBtn" onclick="_doSendBonMail('${bonId}')">${mailIcon(13)} Send</button>
            </div>
        </div>`;

    // Store vars for template application
    return '<div class="bm-container" data-vars=\'' + JSON.stringify(vars).replace(/'/g, '&#39;') + '\'>'
        + histHtml + composeHtml + '</div>';
}

/* ── Vedhæftninger i bon-mail-modal ──────────────────────── */
function _bmAttachFile() {
    if (_bmAttachments.length >= 5) { alert('Max 5 vedhæftninger per mail'); return; }
    document.getElementById('bmFile').click();
}

async function _bmOnFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    if (file.size > 10 * 1024 * 1024) { alert('Fil er for stor (max 10 MB)'); return; }

    const btn = document.getElementById('bmAttachBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploader…'; }
    try {
        const result = await uploadAttachment(file, 'bon', _bmBonId ? parseInt(_bmBonId) : null);
        _bmAttachments.push(result);
        _bmRenderAttachmentPills();
    } catch (err) {
        alert('Upload fejl: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📎 Vedhæft'; }
    }
}

function _bmRenderAttachmentPills() {
    const el = document.getElementById('bmAttachments');
    if (!el) return;
    el.innerHTML = _bmAttachments.map((a, i) =>
        '<span class="bm-att-pill">📎 ' + esc(a.filename) + ' (' + Math.round((a.size_bytes || 0) / 1024) + ' KB)'
        + '<span class="bm-att-remove" onclick="_bmRemoveAttachment(' + i + ')"> ✕</span></span>'
    ).join('');
}

function _bmRemoveAttachment(index) {
    _bmAttachments.splice(index, 1);
    _bmRenderAttachmentPills();
}

function _fmtMailDate(isoStr) {
    if (!isoStr) return '';
    const d = parseServerDate(isoStr);
    if (!d || isNaN(d.getTime())) return '';
    const day = d.getDate();
    const mon = d.getMonth() + 1;
    const hr = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return day + '/' + mon + ' ' + hr + ':' + min;
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
        const data = { to, subject, text };
        if (_bmAttachments.length > 0) {
            data.attachments = _bmAttachments.map(a => ({ attachment_id: a.attachment_id }));
        }
        await sendBonMail(bonId, data);
        _bmAttachments = [];
        closeModal();
        // Toast
        const toast = document.createElement('div');
        toast.className = 'bm-toast';
        toast.innerHTML = mailIcon(15) + ' Mail sendt til ' + esc(to);
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
        // Ny markup bruger .bon-units (med .bon-units-label inden i),
        // gammel markup havde .unit-primary. Understøt begge.
        const newEl = card.querySelector('.bon-units');
        if (newEl) {
            // .bon-units har et inline <span class="bon-units-label">ENH</span> efter tallet —
            // opdater kun first text-node.
            const firstText = Array.from(newEl.childNodes).find(n => n.nodeType === 3);
            if (firstText) firstText.textContent = changes.units;
        }
        const legacyEl = card.querySelector('.unit-primary');
        if (legacyEl) legacyEl.textContent = changes.units;
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

function _getSummaryMode() {
    try { return localStorage.getItem('bon-summary-mode') || 'cat'; } catch (e) { return 'cat'; }
}
function _setSummaryModePref(mode) {
    try { localStorage.setItem('bon-summary-mode', mode); } catch (e) {}
}

// Lazy-loadet liste over "tæller-med"-kategorier (sandwich/slider/salat).
// Settings-key: unit_count_categories. Defineres af bruger i Settings → System.
function _getUnitCountCats() {
    return Array.isArray(window._unitCountCats) ? window._unitCountCats : null;
}
async function _ensureUnitCountCats(cardId) {
    if (window._unitCountCatsLoaded) return;
    window._unitCountCatsLoaded = true;
    try {
        const r = await fetch('/api/settings', { credentials: 'include' });
        if (!r.ok) return;
        const rows = await r.json();
        const raw = (rows.find(s => s.key === 'unit_count_categories') || {}).value;
        if (raw) {
            try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) window._unitCountCats = arr;
            } catch {}
        }
    } catch {}
    if (cardId) _renderSummary(cardId);
}

// Returnerer base-navn uden special_request (.bon-menu-note span fjernes)
function _baseMenuName(nameEl) {
    if (!nameEl) return '';
    const clone = nameEl.cloneNode(true);
    clone.querySelectorAll('.bon-menu-note').forEach(n => n.remove());
    return clone.textContent.trim();
}

function _renderSummary(cardId) {
    const num  = cardId.replace('bon', '');
    const rows = document.getElementById('summaryRows' + num);
    const panel = document.getElementById('summary' + num);
    if (!rows || !panel) return;

    const mode = _getSummaryMode();
    panel.querySelectorAll('.summary-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });

    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const card = document.getElementById(cardId);

    // Saml rådata fra DOM
    const items = [];
    card.querySelectorAll('.bon-menu-item').forEach(item => {
        const qtyEl  = item.querySelector('.bon-menu-qty');
        const nameEl = item.querySelector('.bon-menu-name');
        if (!qtyEl || !nameEl) return;
        const qtyText = qtyEl.textContent.trim();
        const match   = qtyText.match(/^([\d.,]+)\s*(.*)$/);
        const qty     = match ? parseFloat(match[1].replace(',', '.')) : 0;
        const unit    = match ? match[2].trim() : '';
        const cat     = (item.dataset.category || '').trim() || 'Andet';
        const baseName = _baseMenuName(nameEl);
        items.push({ qty, unit, cat, baseName });
    });

    if (!items.length) {
        rows.innerHTML = '<div class="summary-row"><span style="color:var(--gray-dark);font-style:italic;font-size:13px;padding:4px 0">Ingen varer</span></div>';
        return;
    }

    // Tæller-med-kategorier (sandwich/slider/salat). Hvis ikke loadet endnu,
    // trigger async load og rerender — vis alt som "tæller-med" indtil da.
    _ensureUnitCountCats(cardId);
    const unitCats = _getUnitCountCats();
    const countsAsUnit = (cat) => unitCats === null ? true : unitCats.includes(cat);

    let html = '';
    let grandTotal = 0;
    let hasNonCounting = false;

    if (mode === 'item') {
        // Grupper per produkt-navn (uden noter) — Kylling + Kylling uden løg = 2 x Kylling
        // Behold kategori-info per item for at vide om gruppen tæller med
        const groups = {};
        for (const it of items) {
            const key = it.baseName + '||' + it.unit;
            if (groups[key]) {
                groups[key].qty += it.qty;
            } else {
                groups[key] = { qty: it.qty, unit: it.unit, name: it.baseName, counts: countsAsUnit(it.cat) };
            }
        }
        const entries = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name, 'da'));
        for (const e of entries) {
            if (e.counts) grandTotal += e.qty;
            else hasNonCounting = true;
            const qtyStr = Number.isInteger(e.qty) ? e.qty : e.qty.toFixed(1);
            const cls = e.counts ? '' : ' summary-row-dim';
            html += `<div class="summary-row${cls}">
                <span class="summary-qty">${qtyStr}</span>
                <span class="summary-name">${_esc(e.name)}${e.unit ? ' <span class="summary-cat">' + _esc(e.unit) + '</span>' : ''}</span>
            </div>`;
        }
    } else {
        // Per kategori (default)
        const categories = {};
        for (const it of items) {
            if (!categories[it.cat]) categories[it.cat] = 0;
            categories[it.cat] += it.qty;
        }
        const catNames = Object.keys(categories).sort((a, b) => a.localeCompare(b, 'da'));
        for (const cat of catNames) {
            const catTotal = categories[cat];
            const counts = countsAsUnit(cat);
            if (counts) grandTotal += catTotal;
            else hasNonCounting = true;
            const qtyStr = Number.isInteger(catTotal) ? catTotal : catTotal.toFixed(1);
            const cls = counts ? '' : ' summary-row-dim';
            html += `<div class="summary-row${cls}">
                <span class="summary-qty">${qtyStr}</span>
                <span class="summary-name">${_esc(_stripCatPrefix(cat))}</span>
            </div>`;
        }
    }

    const gtStr = Number.isInteger(grandTotal) ? grandTotal : grandTotal.toFixed(1);
    const totalLabel = hasNonCounting ? 'Enheder' : 'Total';
    html += `<div class="summary-row summary-total">
        <span class="summary-qty">${gtStr}</span>
        <span class="summary-name">${totalLabel}</span>
    </div>`;
    rows.innerHTML = html;
}

function showSummary(cardId) {
    const num    = cardId.replace('bon', '');
    const panel  = document.getElementById('summary' + num);
    if (!panel) return;
    const isOpen = panel.classList.contains('open');

    // Luk alle andre
    document.querySelectorAll('.summary-panel.open').forEach(p => p.classList.remove('open'));
    if (isOpen) return;

    _renderSummary(cardId);
    panel.classList.add('open');
}

function setSummaryMode(cardId, mode) {
    _setSummaryModePref(mode);
    _renderSummary(cardId);
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
