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
    const barEl     = document.getElementById('sbar' + num);
    if (!barEl) return;

    const curStatus = card.dataset.status;
    const payment   = card.dataset.payment || 'faktura';

    // Find view-vinduet
    const viewEl   = card.closest('[data-view]');
    const viewName = viewEl ? viewEl.dataset.view : 'all';
    let   window_  = VIEW_WINDOWS[viewName]
        ? [...VIEW_WINDOWS[viewName]]
        // Uden et vindue vises alle statusser der er kort-knapper. Filteret er
        // undtagelsen (i dag kun AFLYST), ikke en hvidliste — så en ny status
        // dukker op af sig selv, som hidtil.
        : Object.keys(BON_CONFIG.statuses)
              .filter(k => BON_CONFIG.statuses[k].cardButton !== false);

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

    // Vis fortryd-bar i 8 sekunder
    const fortrydEl = document.getElementById('fortryd' + num);
    if (fortrydEl) {
        fortrydEl.classList.add('visible');
        clearTimeout(_fortrydTimers[cardId]);
        _fortrydTimers[cardId] = setTimeout(() => {
            fortrydEl.classList.remove('visible');
        }, 8000);
    }
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

    const fortrydEl = document.getElementById('fortryd' + num);
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
    const items = [...menu.querySelectorAll('.bon-menu-item')].filter(item =>
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

    menu.insertBefore(grp, items[0]);
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
        const tg = e.target.closest('.bon-menu-group');
        if (tg && tg !== _dragEl) tg.classList.add('drag-over-group');
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
   INIT
   Bygger status-bar på alle kort ved sideload.
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.bon-card').forEach(card => buildStatusBar(card));
});
