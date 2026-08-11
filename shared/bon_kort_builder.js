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
        // Event-specifik: pakkeliste-knap vises kun på prep/top-up-bonner i et event
        { tooltip: 'Pakkeliste',    icon: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="7.5 4.21 12 6.81 16.5 4.21"/><polyline points="7.5 19.79 7.5 14.6 3 12"/><polyline points="21 12 16.5 14.6 16.5 19.79"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>', onclick: 'showPakkeliste', condition: isEventPrep },
        { tooltip: 'Se i logistik', icon: '<rect x="1" y="6" width="13" height="10" rx="1"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="5" cy="18.5" r="2"/><circle cx="17" cy="18.5" r="2"/>', onclick: 'openLogistik' },
        { tooltip: 'Sammentælling', icon: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="14" y2="18"/><polyline points="17 14 20 17 17 20"/>', onclick: 'showSummary' },
    ],
    'kitchen-later': [
        { tooltip: 'Tilføj vare',   icon: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', onclick: 'openRecipePicker' },
        { tooltip: 'Info',          icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', onclick: 'showBonInfo' },
        { tooltip: 'Send flyver',   icon: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>', onclick: 'sendFlyver' },
        { tooltip: 'Send mail',     icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', onclick: 'openBonMail' },
        { tooltip: 'Råvarer',       icon: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>', onclick: 'showRavarer' },
        { tooltip: 'Pakkeliste',    icon: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="7.5 4.21 12 6.81 16.5 4.21"/><polyline points="7.5 19.79 7.5 14.6 3 12"/><polyline points="21 12 16.5 14.6 16.5 19.79"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>', onclick: 'showPakkeliste', condition: isEventPrep },
        { tooltip: 'Se i logistik', icon: '<rect x="1" y="6" width="13" height="10" rx="1"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="5" cy="18.5" r="2"/><circle cx="17" cy="18.5" r="2"/>', onclick: 'openLogistik' },
        { tooltip: 'Sammentælling', icon: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="18" x2="14" y2="18"/><polyline points="17 14 20 17 17 20"/>', onclick: 'showSummary' },
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
// Conditions: action.condition(bonData) skal returnere true for at vise knappen.
// Bruges fx til pakkeliste der kun giver mening på event-prep-bonner.
function isEventPrep(b) {
    return !!(b && b.event_id && b.price_category === 'produktion');
}

function _buildActions(viewName, cardId, bonData) {
    const actions = VIEW_ACTIONS[viewName] || VIEW_ACTIONS['all'];
    return actions
        .filter(a => !a.condition || a.condition(bonData))
        .map(a => {
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

    // Kontekst-klasse styrer bl.a. customer-adresse synlighed
    let contextClass = 'context-office';
    if (viewName === 'kitchen-today') contextClass = 'context-today';
    else if (viewName === 'kitchen-later') contextClass = 'context-later';

    const el = document.createElement('div');
    el.className   = 'bon-card ' + contextClass;
    el.id          = cardId;
    el.dataset.status        = bonData.status;
    el.dataset.payment       = bonData.payment || 'faktura';
    el.dataset.view          = viewName || 'all';   // bruges af buildStatusBar
    el.dataset.priceCategory = bonData.price_category || 'catering';
    el.dataset.orderType     = bonData.order_type || 'delivery';
    el.dataset.deliveryDate  = bonData.delivery_date_raw || '';
    if (bonData.price_category === 'produktion') el.classList.add('bon-production');

    // ── HEADER ──────────────────────────────────────────────────
    const orderTypeLabel = bonData.order_type === 'pickup' ? 'Afhentning' :
                           bonData.order_type === 'event'  ? 'Event'      : 'Levering';
    const paxStr = (bonData.pax && !bonData.units_from_pax) ? `${bonData.pax} pax` : '';
    const dateLabel = bonData.date_short || bonData.date || '';
    const deliveryFlagHtml = mods.deliveryBlock ? _buildDeliveryFlag(bonData, cardId) : '';

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

    // Kunde (delivery-line vises separat i bunden af kortet)
    const customerHtml = mods.customer && bonData.customer
        ? _buildCustomer(bonData.customer, num, null, contextClass)
        : '';

    // Leveringsinfo (etage, port, kode) — står i headeren lige under
    // leveringsindikatoren, så al leveringsinfo er samlet ét sted. Uden
    // etiketten lignede den løs tekst nederst på kortet.
    const deliveryNotesHtml = (mods.deliveryBlock && bonData.delivery_notes)
        ? `<div class="delivery-line"><span class="delivery-line-label">Leveringsinfo</span>${(typeof esc === 'function' ? esc : (s) => s)(bonData.delivery_notes)}</div>`
        : '';

    const prodBadge  = bonData.price_category === 'produktion' ? ' <span class="bon-prod-badge" title="Produktionsbon">🔧</span>' : '';
    const mailBadge  = bonData.unread_mail_count ? ' <span class="bon-mail-badge" title="' + bonData.unread_mail_count + ' ulæst mail">' + mailIcon(14) + '</span>' : '';
    // Event-badge — vises på alle bons der hører til et event. Hjælper køkkenet
    // med at se hvad bonnen er til (prep til Roskilde vs. en almindelig
    // catering-ordre). Klikbar via parent — vi binder ingen handler her, men
    // tooltip viser eventets navn.
    const evEsc = (typeof esc === 'function' ? esc : (s) => s);
    const eventBadge = bonData.event_id
        ? ` <span class="bon-event-badge" title="Event: ${evEsc(bonData.event_name || '')}">🎪 ${evEsc(bonData.event_name || 'Event')}</span>`
        : '';
    // Afhentnings-bons: pickup_time = delivery_time (samme tid) — vis ikke
    // pilen "→ tid" to gange. Kun leverings-bons har en separat leveringstid.
    const levTimeHtml = (bonData.delivery_time && bonData.order_type !== 'pickup')
        ? `<span class="bon-lev-time">→ ${bonData.delivery_time}</span>` : '';
    const paxHtml = paxStr ? `<span class="bon-units-pax">${paxStr}</span>` : '';

    el.innerHTML = `
        ${fortrydHtml}

        <div class="bon-header">
            <div class="bon-header-row1">
                <div class="bon-id">#${bonData.bon_number || id}${prodBadge}${eventBadge}${mailBadge}</div>
                <div class="bon-units">
                    <span class="bon-units-main">${bonData.units}<span class="bon-units-label">${bonData.unit_label || 'ENH'}</span></span>
                    ${paxHtml}
                </div>
            </div>
            <div class="bon-header-row2">
                <span class="bon-pickup">${bonData.pickup_time || ''}</span>
                ${levTimeHtml}
                <span class="bon-sep">·</span>
                <span class="bon-date-short">${dateLabel}</span>
                <span class="bon-mode-group">
                    <span class="bon-sep">·</span>
                    <span class="bon-mode">${orderTypeLabel}</span>
                    ${deliveryFlagHtml}
                </span>
            </div>
            ${deliveryNotesHtml}
        </div>

        <!-- Status-bar (bygges dynamisk) -->
        <div class="bon-status-bar" id="sbar${num}"></div>

        ${mods.prep && bonData.prep ? _buildPrep(bonData.prep, num) : ''}
        ${customerHtml}
        ${_buildKitchenFlags(bonData)}
        ${mods.kitchenInfo ? _buildKitchenInfo(bonData, num) : ''}
        ${mods.alerts && bonData.alerts && bonData.alerts.length ? _buildAlerts(bonData.alerts) : ''}

        <!-- Menu -->
        <div class="bon-menu" id="menu${num}">
            <div class="select-toolbar" id="toolbar${num}">
                <span id="selCount${num}">0 valgt</span>
                <div style="display:flex;gap:6px">
                    <button class="sel-btn" onclick="groupSelected('menu${num}')">Gruppér</button>
                    <button class="sel-btn done" onclick="exitSelect('${cardId}')">Færdig</button>
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
                ${_buildActions(viewName, cardId, bonData)}
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

/**
 * Køkken-synlige kunde-/firma-påmindelser (read-only strip). Kun når der er nogen.
 * Kontoret styrer livscyklus i draweren — køkkenet ser blot påmindelsen.
 */
function _buildKitchenFlags(bonData) {
    const flags = bonData.kitchen_flags;
    if (!flags || !flags.length) return '';
    const e = (typeof esc === 'function' ? esc : (s) => s);
    const rows = flags.map(f =>
        `<div class="bon-paamindelse-item">📌 <span class="bon-paamindelse-title">${e(f.title)}</span>${f.body ? `<span class="bon-paamindelse-body">${e(f.body)}</span>` : ''}</div>`
    ).join('');
    return `<div class="bon-paamindelse" title="Påmindelse fra kontoret">${rows}</div>`;
}

function _buildCustomer(c, num, bonDataForDelivery, contextClass) {
    const company = c.company ? ` · ${c.company}` : '';

    // Telefonnumre i fold-ud med navne
    const detailParts = [
        c.phone ? `<div class="detail-row">📞 <a href="tel:${c.phone}" onclick="event.stopPropagation()">${c.phone}</a> <span class="detail-label">${c.name} · Bestiller</span></div>` : '',
        c.company_phone && c.company_phone !== c.phone ? `<div class="detail-row">📞 <a href="tel:${c.company_phone}" onclick="event.stopPropagation()">${c.company_phone}</a> <span class="detail-label">${c.company || c.name} · Dagskontakt</span></div>` : '',
        c.email ? `<div class="detail-row">${mailIcon(13)} <a href="mailto:${c.email}">${c.email}</a></div>` : '',
    ].filter(Boolean).join('');

    // Delivery block inde i customer details
    const deliveryHtml = bonDataForDelivery ? _buildDeliveryBlock(bonDataForDelivery) : '';
    const allDetails = detailParts + deliveryHtml;
    const hasDetails = allDetails.length > 0;

    // I today-context skjules adressen by default — toggle "▾ adresse" folder den ud
    const addressToggle = (contextClass === 'context-today' && c.address)
        ? `<span class="customer-toggle" onclick="event.stopPropagation(); toggleCustomerAddress(this);" title="Vis adresse">▾ adresse</span>`
        : '';

    return `
        <div class="bon-customer${hasDetails ? '' : ' no-expand'}"
             ${hasDetails ? 'onclick="toggleCustomer(this)"' : ''}>
            <div>
                <div class="customer-name">${c.name}${company}${addressToggle}</div>
                <div class="customer-address">${c.address}</div>
            </div>
            ${hasDetails ? '<div class="customer-expand">▾</div>' : ''}
        </div>
        ${hasDetails ? `<div class="bon-customer-details">${allDetails}</div>` : ''}`;
}

/**
 * Leveringsflag i header-row2 — viser vehicle, pickup eller "ikke planlagt".
 * Klik åbner drawer scrollet til BESTIL BUD-sektionen.
 *
 *   pickup        → ingen flag (mode-badge "Afhentning" siger det selv)
 *   vehicle booket → '🚴 By-expressen' / '🚕 Taxa' osv.
 *   ikke planlagt → '📍 Ikke planlagt' (grå, kursiv)
 */
function _buildDeliveryFlag(bonData, cardId) {
    const orderType = bonData.order_type || '';
    const vehicleLabel = bonData.delivery_vehicle_label || '';
    const method = bonData.delivery_method || '';

    if (orderType === 'pickup') return '';

    if (vehicleLabel) {
        const display = _DELIVERY_METHOD_DISPLAY[method] || { icon: '🚴' };
        return `<span class="bon-flag" onclick="openBonDeliveryFromCard('${cardId}'); event.stopPropagation();" title="${vehicleLabel}">${display.icon} ${vehicleLabel}</span>`;
    }

    // Ikke planlagt — kun ved levering eller event
    return `<span class="bon-flag bon-flag-pending" onclick="openBonDeliveryFromCard('${cardId}'); event.stopPropagation();" title="Klik for at planlægge levering">📍 Ikke planlagt</span>`;
}

// Mapping fra interne koder til pænt label + ikon.
// Læser fra window.DeliveryIcons (shared/delivery_icons.js) der henter settings
// fra /api/settings/delivery-icons. Falder tilbage til hardcoded defaults hvis
// helperen ikke er loadet (fx i isolerede tests).
const _DELIVERY_FALLBACK = {
    bike:   { label: 'Cykel',      icon: '🚴' },
    taxi:   { label: 'Taxa',       icon: '🚕' },
    volvo:  { label: 'Volvo',      icon: '🚙' },
    pickup: { label: 'Afhentning', icon: '🏠' }
};
const _DELIVERY_METHOD_DISPLAY = new Proxy({}, {
    get: function(_t, method) {
        if (window.DeliveryIcons) {
            return window.DeliveryIcons.get(method) || window.DeliveryIcons.defaults[method] || _DELIVERY_FALLBACK[method];
        }
        return _DELIVERY_FALLBACK[method];
    },
});

/**
 * Leveringsindikator under datolinjen.
 * Tre tilstande:
 *   - pickup     → '🏠 Afhentning'
 *   - vehicle    → '{icon} {vehicle_label}'  (booket)
 *   - ikke planlagt → '📍 Ikke planlagt endnu' (grå, kun ved delivery_type='delivery')
 *
 * Datakilde i v1: bons.delivery_vehicle_id (Spor 1).
 * Når Spor 2 lander, udvides til også at læse delivery_route_stops.
 */
function _buildDeliveryIndicator(bonData, num, cardId) {
    const orderType = bonData.order_type || '';
    const vehicleLabel = bonData.delivery_vehicle_label || '';
    const method = bonData.delivery_method || '';

    let icon, label, modifier = '';

    if (orderType === 'pickup') {
        icon = '🏠';
        label = 'Afhentning';
    } else if (vehicleLabel) {
        const display = _DELIVERY_METHOD_DISPLAY[method];
        icon = display ? display.icon : '🚴';
        label = vehicleLabel;
    } else if (orderType === 'event') {
        // Event: typisk levering på sted, men ingen vehicle valgt endnu
        icon = '📍';
        label = 'Ikke planlagt endnu';
        modifier = ' bon-delivery-indicator-pending';
    } else {
        // Levering uden vehicle = ikke planlagt
        icon = '📍';
        label = 'Ikke planlagt endnu';
        modifier = ' bon-delivery-indicator-pending';
    }

    return `<div class="bon-delivery-indicator${modifier}" onclick="openBonDeliveryFromCard('${cardId}')">${icon} ${label}</div>`;
}

// _buildDeliveryBlock er udfaset — leveringsindikator vises nu via
// _buildDeliveryIndicator (under datolinjen), og delivery_notes vises
// inline i bunden af kortet via deliveryNotesHtml.

function _buildKitchenInfo(bonData, num) {
    const text = bonData.kitchen_info || '';
    const hasContent = text.trim().length > 0;
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Close-knap (×) vises kun når der er indhold — den ligger inde i pillen
    // men stopper propagation så pillens click-to-edit ikke trigges samtidig.
    const closeBtn = hasContent
        ? `<button class="kitchen-pill-close" type="button" title="Marker som læst"
                   onclick="event.stopPropagation(); markKitchenInfoRead('${num}')">×</button>`
        : '';

    return `
        <div class="bon-kitchen${hasContent ? '' : ' empty'}" id="kitchen${num}">
            <div class="kitchen-pill" onclick="openKitchenEdit('${num}')">
                <span class="kitchen-pill-text">${hasContent ? _esc(text) : ''}</span>
                <span class="kitchen-pill-edit">✎</span>
                ${closeBtn}
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
        </div>
        <div class="kitchen-info-collapsed" data-kitchen-collapsed="${num}"
             onclick="markKitchenInfoUnread('${num}')" title="Klik for at åbne">
            + Køkkeninfo (læst)
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
            // Titel + note er vedvarende fri-tekst — escapes inden rendering
            const titleText = esc(item.title || 'Gruppe');
            const titleAttr = titleText.replace(/"/g, '&quot;');
            const noteText  = esc(item.note || '');
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
                        <span class="group-title">${titleText}</span>
                        <input class="group-title-input" type="text" value="${titleAttr}"
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
                        <button class="group-dissolve-btn" onclick="dissolveGroup(this)" title="Opløs gruppe">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>
                    <div class="group-note-area${hasNote ? ' open' : ''}">
                        <textarea class="group-note-input" rows="1"
                                  placeholder="Note til denne gruppe…"
                                  oninput="noteChanged(this)">${noteText}</textarea>
                    </div>
                    ${groupItems}
                </div>`;
        }
        return _buildMenuItem(item, num);
    }).join('');
}

function _buildMenuItem(item, num) {
    // Pakke-/tilbehørs-linje markeres med både legacy "emballage" og nyt "is-packaging" class
    const cls = item.style === 'emballage' ? ' emballage is-packaging' : '';
    const cat = item.category || '';
    const note = item.special_request
        ? `<span class="bon-menu-note">${esc(item.special_request)}</span>`
        : '';
    const lineIds = Array.isArray(item.line_ids) ? item.line_ids.join(',') : '';
    const editable = item.line_ids && item.line_ids.length === 1 ? ' qty-editable' : '';
    const qtyAttrs = editable
        ? ` title="Klik for at ændre antal" onclick="openQtyEdit(this)"`
        : '';
    return `
        <div class="bon-menu-item${cls}" draggable="true" data-drag="item" data-category="${esc(cat)}" data-line-ids="${lineIds}">
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
            <span class="bon-menu-qty${editable}"${qtyAttrs}>${item.qty}</span>
            <span class="bon-menu-x">×</span>
            <span class="bon-menu-name">${item.name}${note}</span>
        </div>`;
}

function _buildCo2(co2) {
    const leaf = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a10 10 0 100 20A10 10 0 0012 2z"/>
                <path d="M8 12s1-3 4-3 4 3 4 3-1 3-4 3-4-3-4-3z"/>
            </svg>`;
    // Bagudkompatibelt: string → simpel visning. Objekt → 3-delt (mad · transport · i alt).
    if (co2 && typeof co2 === 'object') {
        const fmt = (kg) => Number(kg || 0).toLocaleString('da-DK', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kg';
        const hasTransport = co2.transport_kg != null && co2.transport_source && co2.transport_source !== 'none';
        const total = (Number(co2.food_kg) || 0) + (hasTransport ? Number(co2.transport_kg) || 0 : 0);
        const method = hasTransport && co2.method ? ` <span class="bon-co2-method">(${co2.method})</span>` : '';
        const parts = [`Mad <b>${fmt(co2.food_kg)}</b>`];
        if (hasTransport) parts.push(`Transport <b>${fmt(co2.transport_kg)}</b>${method}`);
        parts.push(`I alt <b>${fmt(total)} CO₂e</b>`);
        return `<div class="bon-co2">${leaf}<span class="bon-co2-value">${parts.join(' <span class="bon-co2-sep">·</span> ')}</span></div>`;
    }
    return `<div class="bon-co2">${leaf}<span class="bon-co2-value">${co2}</span></div>`;
}

function _buildSummaryPanel(num, cardId) {
    return `
        <div class="summary-panel" id="summary${num}">
            <div class="summary-header">
                <span class="summary-title">Sammentælling</span>
                <div class="summary-toggle" role="tablist" aria-label="Visningsmode">
                    <button type="button" class="summary-mode-btn" data-mode="cat" onclick="setSummaryMode('${cardId}','cat')">Kategori</button>
                    <button type="button" class="summary-mode-btn" data-mode="item" onclick="setSummaryMode('${cardId}','item')">Vare</button>
                </div>
                <button class="summary-close" onclick="closeSummary('${cardId}')">×</button>
            </div>
            <div id="summaryRows${num}"></div>
        </div>`;
}
