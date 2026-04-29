/**
 * bon_kort_builder.js
 * ════════════════════════════════════════════════════════════
 * DOM-bygning for bon-kortet.
 * Ingen adfærd, ingen state — kun ren HTML/DOM-konstruktion.
 *
 * Afhænger af (skal loades først):
 *   BonConfig.js     → BON_CONFIG
 *   BonConfigBar.js  → VIEW_WINDOWS
 *
 * Funktioner der kaldes fra bon_kort.js (loades EFTER):
 *   buildStatusBar(card) — kaldes i createCard()
 *
 * Load-rækkefølge i HTML:
 *   <script src="BonConfig.js"></script>
 *   <script src="BonConfigBar.js"></script>
 *   <script src="bon_kort_builder.js"></script>   ← denne fil
 *   <script src="bon_kort.js"></script>
 * ════════════════════════════════════════════════════════════
 */

/* ── VIEW_MODULES — hvilke sektioner vises per view ────────── */
const VIEW_MODULES = {
    'kitchen-today':  { prep: true,  customer: true,  alerts: false, co2: false, select: true,  kitchenInfo: true, deliveryBlock: true, summary: true, showRecipePrices: false },
    'kitchen-later':  { prep: true,  customer: true,  alerts: true,  co2: false, select: true,  kitchenInfo: true, deliveryBlock: true, summary: true, showRecipePrices: false },
    'invoice':        { prep: false, customer: true,  alerts: false, co2: false, select: true,  showRecipePrices: true },
    'all':            { prep: false, customer: true,  alerts: true,  co2: true,  select: true,  showRecipePrices: true },
};

/* ── VIEW_ACTIONS — action-knapper per view ────────────────── */
const VIEW_ACTIONS = {
    'kitchen-today': [
        { tooltip: 'Tilføj vare',   icon: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', onclick: 'openRecipePicker' },
        { tooltip: 'Info',          icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', onclick: 'showBonInfo' },
        { tooltip: 'Send flyver',   icon: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>', onclick: 'sendFlyver' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', onclick: 'openBonMail' },
        { tooltip: 'Råvarer',       icon: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>', onclick: 'showRavarer' },
        { tooltip: 'Kort',          icon: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>', onclick: 'openMap' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', onclick: 'showHistorik' },
        { tooltip: 'Sammentælling', icon: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="14" y2="18"/><polyline points="17 14 20 17 17 20"/>', onclick: 'showSummary' },
    ],
    'kitchen-later': [
        { tooltip: 'Tilføj vare',   icon: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', onclick: 'openRecipePicker' },
        { tooltip: 'Info',          icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', onclick: 'showBonInfo' },
        { tooltip: 'Send flyver',   icon: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>', onclick: 'sendFlyver' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', onclick: 'openBonMail' },
        { tooltip: 'Råvarer',       icon: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>', onclick: 'showRavarer' },
        { tooltip: 'Kort',          icon: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>', onclick: 'openMap' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', onclick: 'showHistorik' },
        { tooltip: 'Sammentælling', icon: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="14" y2="18"/><polyline points="17 14 20 17 17 20"/>', onclick: 'showSummary' },
    ],
    'invoice': [
        { tooltip: 'Åbn bon',       icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { tooltip: 'Info',          icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', onclick: 'showBonInfo' },
        { tooltip: 'Fakturér',      icon: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', onclick: 'openBonMail' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', onclick: 'showHistorik' },
    ],
    'all': [
        { tooltip: 'Åbn bon',       icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
        { tooltip: 'Info',          icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', onclick: 'showBonInfo' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', onclick: 'openBonMail' },
        { tooltip: 'Historik',      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', onclick: 'showHistorik' },
    ],
};

/* ── _buildActions ─────────────────────────────────────────── */
function _buildActions(viewName, cardId) {
    const actions = VIEW_ACTIONS[viewName] || VIEW_ACTIONS['all'];
    return actions.map(a => {
        const click = a.onclick ? ` onclick="${a.onclick}('${cardId}')"` : '';
        return `<button class="action-btn" data-tooltip="${a.tooltip}"${click}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${a.icon}</svg>
        </button>`;
    }).join('');
}

/* ══════════════════════════════════════════════════════════════
   createCard(bonData, viewName)
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
    el.dataset.status        = bonData.status;
    el.dataset.payment       = bonData.payment || 'faktura';
    el.dataset.view          = viewName || 'all';   // bruges af buildStatusBar
    el.dataset.priceCategory = bonData.price_category || 'catering';
    if (bonData.price_category === 'produktion') el.classList.add('bon-production');

    // ── HEADER ──────────────────────────────────────────────────
    const orderTypeLabel = bonData.order_type === 'pickup' ? 'Afhentning' :
                           bonData.order_type === 'event'  ? 'Event'      : 'Levering';
    const levStr = bonData.delivery_time ? ` → Lev ${bonData.delivery_time}` : '';
    const paxStr = (bonData.pax && !bonData.units_from_pax) ? `${bonData.pax} pax` : '';

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
                <div class="bon-id">#${bonData.bon_number || id}${bonData.price_category === 'produktion' ? ' <span class="bon-prod-badge" title="Produktionsbon">🔧</span>' : ''}${bonData.unread_mail_count ? ' <span class="bon-mail-badge" title="' + bonData.unread_mail_count + ' ulæst mail">' + mailIcon(14) + '</span>' : ''}</div>
                <div class="bon-time-row">
                    <span class="bon-pickup">${bonData.pickup_time || ''}</span>
                    <span class="bon-lev">${levStr}</span>
                </div>
                <div class="bon-date">${bonData.date || ''} · ${orderTypeLabel}</div>
            </div>
            <div class="bon-header-right">
                <div class="unit-primary">${bonData.units}</div>
                <div class="unit-primary-label">${bonData.unit_label || 'ENHEDER'}</div>
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

        <!-- Vare picker slot (åbnes via + knap) -->
        <div class="vare-picker-slot" id="vpSlot${num}"></div>
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

    // Telefonnumre i fold-ud med navne
    const detailParts = [
        c.phone ? `<div class="detail-row">📞 <a href="tel:${c.phone}" onclick="event.stopPropagation()">${c.phone}</a> <span class="detail-label">${c.name} · Bestiller</span></div>` : '',
        c.company_phone && c.company_phone !== c.phone ? `<div class="detail-row">📞 <a href="tel:${c.company_phone}" onclick="event.stopPropagation()">${c.company_phone}</a> <span class="detail-label">${c.company || c.name} · Dagskontakt</span></div>` : '',
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
    const cat = item.category || '';
    const special = item.special_request
        ? `<div class="bon-menu-special">${esc(item.special_request)}</div>`
        : '';
    return `
        <div class="bon-menu-item${cls}" draggable="true" data-drag="item" data-category="${esc(cat)}">
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
            <span class="bon-menu-name">${item.name}${special}</span>
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

function _buildSummaryPanel(num, cardId) {
    return `
        <div class="summary-panel" id="summary${num}">
            <div class="summary-header">Sammentælling
                <button class="summary-close" onclick="closeSummary('${cardId}')">×</button>
            </div>
            <div id="summaryRows${num}"></div>
        </div>`;
}
