/**
 * shared/modal.js
 * ════════════════════════════════════════════════════════════
 * Genbrugelig modal-komponent for Bon v2.
 *
 * API:
 *   openModal({ title, bodyHtml })  → vis modal
 *   closeModal()                    → luk modal
 *   showHistorik(cardId)            → hent changelog + vis i modal
 *   showBonInfo(cardId)             → hent fuld bon + vis i modal
 *   showRavarer(cardId)             → hent ingredienser + vis i modal
 *
 * Afhænger af:
 *   shared/api.js    → fetchBon(), fetchBonChangelog(), fetchBonIngredients(), postGrocyShoppingList()
 *   shared/utils.js  → esc(), statusToFrontend(), formatDanishDate()
 *   BonConfig.js     → BON_CONFIG (til status-labels)
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════════
   GENERISK MODAL
   ══════════════════════════════════════════════════════════════ */

let _modalOverlay = null;

function openModal({ title, bodyHtml }) {
    // Luk evt. eksisterende modal
    if (_modalOverlay) closeModal();

    _modalOverlay = document.createElement('div');
    _modalOverlay.className = 'modal-overlay';
    _modalOverlay.innerHTML = `
        <div class="modal-panel">
            <div class="modal-header">
                <div class="modal-title">${title}</div>
                <button class="modal-close" onclick="closeModal()">×</button>
            </div>
            <div class="modal-body">
                ${bodyHtml}
            </div>
        </div>
    `;

    // Klik på overlay (uden for panel) lukker
    _modalOverlay.addEventListener('click', (e) => {
        if (e.target === _modalOverlay) closeModal();
    });

    document.body.appendChild(_modalOverlay);

    // Trigger animation (næste frame)
    requestAnimationFrame(() => {
        _modalOverlay.classList.add('open');
    });

    // Escape lukker
    document.addEventListener('keydown', _modalEscHandler);
}

function closeModal() {
    if (!_modalOverlay) return;

    document.removeEventListener('keydown', _modalEscHandler);

    _modalOverlay.classList.remove('open');
    const el = _modalOverlay;
    _modalOverlay = null;

    // Vent på transition, fjern derefter
    setTimeout(() => {
        el.remove();
    }, 200);
}

function _modalEscHandler(e) {
    if (e.key === 'Escape') closeModal();
}

/* ══════════════════════════════════════════════════════════════
   HISTORIK (CHANGELOG)
   ══════════════════════════════════════════════════════════════ */

/** Danske labels for changelog action-typer */
const _ACTION_LABELS = {
    'create':        'Oprettet',
    'update':        'Opdateret',
    'status_change': 'Statusskift',
    'delete':        'Slettet',
};

/** Danske labels for changelog feltnavne */
const _FIELD_LABELS = {
    'status':                  'Status',
    'kitchen_info':            'Køkkeninfo',
    'prep_ingredients_ready':  'Råvarer klar',
    'prep_supplies_ready':     'Emballage klar',
    'delivery_date':           'Leveringsdato',
    'pickup_time':             'Afhentningstid',
    'delivery_time':           'Leveringstid',
    'pax':                     'Antal kuverter',
    'total_units':             'Antal enheder',
    'delivery_type':           'Leveringstype',
    'delivery_method':         'Leveringsmetode',
    'customer_id':             'Kunde',
    'company_id':              'Firma',
    'delivery_address_id':     'Leveringsadresse',
    'kitchen_selects':         'Køkken vælger',
    'customer_collects':       'Kunde henter',
    'is_offer':                'Tilbud',
};

/** Ikon-tegn per action-type */
const _ACTION_ICONS = {
    'create':        '+',
    'update':        '✎',
    'status_change': '⇄',
    'delete':        '×',
};

/**
 * Formatér dato til dansk: "12. mar 2026 kl. 14:30"
 */
function _formatChangelogDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;

    const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun',
                    'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    const day   = d.getDate();
    const month = months[d.getMonth()];
    const year  = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins  = String(d.getMinutes()).padStart(2, '0');

    return `${day}. ${month} ${year} kl. ${hours}:${mins}`;
}

/**
 * Forsøg at oversætte en statusværdi til dens label.
 * Backend gemmer UPPERCASE koder (IGANG, KLAR, …),
 * BonConfig bruger lowercase keys (igang, klar, …).
 */
function _statusLabel(val) {
    if (!val) return '';
    const key = val.toLowerCase();
    const cfg = BON_CONFIG && BON_CONFIG.statuses && BON_CONFIG.statuses[key];
    return cfg ? cfg.label : val;
}

/**
 * Byg HTML for én changelog-entry
 */
function _buildChangelogEntry(entry) {
    const actionLabel = _ACTION_LABELS[entry.action] || entry.action;
    const actionIcon  = _ACTION_ICONS[entry.action]  || '•';
    const iconClass   = 'action-' + (entry.action || 'update');

    let detailHtml = '';

    // Flyver-entries: speciel rendering med ✈-ikon
    if (entry.field_name === 'notification') {
        const timeStr = _formatChangelogDate(entry.created_at);
        const userStr = entry.user_name ? esc(entry.user_name) : '';
        return '<div class="changelog-entry">'
            + '<div class="changelog-icon action-flyver">\u2708</div>'
            + '<div class="changelog-content">'
            +     '<div class="changelog-action-label">Flyver</div>'
            +     '<div class="changelog-detail">' + esc(entry.notes || entry.new_value || '') + '</div>'
            +     '<div class="changelog-meta">'
            +         '<span class="changelog-time">' + timeStr + '</span>'
            +         (userStr ? '<span class="changelog-user">\u2014 ' + userStr + '</span>' : '')
            +     '</div>'
            + '</div>'
            + '</div>';
    }

    if (entry.action === 'create') {
        detailHtml = '<span class="changelog-detail">Bon oprettet</span>';
    } else if (entry.action === 'status_change') {
        const oldLabel = _statusLabel(entry.old_value);
        const newLabel = _statusLabel(entry.new_value);
        detailHtml = `<div class="changelog-detail">
            <span class="old-value">${esc(oldLabel)}</span>
            <span class="arrow">→</span>
            <span class="new-value">${esc(newLabel)}</span>
        </div>`;
    } else if (entry.field_name) {
        const fieldLabel = _FIELD_LABELS[entry.field_name] || entry.field_name;
        const parts = [`<strong>${esc(fieldLabel)}</strong>`];

        if (entry.old_value && entry.new_value) {
            parts.push(`: <span class="old-value">${esc(entry.old_value)}</span>`);
            parts.push(`<span class="arrow">→</span>`);
            parts.push(`<span class="new-value">${esc(entry.new_value)}</span>`);
        } else if (entry.new_value) {
            parts.push(`: <span class="new-value">${esc(entry.new_value)}</span>`);
        } else if (entry.old_value) {
            parts.push(`: <span class="old-value">${esc(entry.old_value)}</span> (fjernet)`);
        }
        detailHtml = `<div class="changelog-detail">${parts.join('')}</div>`;
    }

    const timeStr = _formatChangelogDate(entry.created_at);
    const userStr = entry.user_name ? esc(entry.user_name) : '';

    return `<div class="changelog-entry">
        <div class="changelog-icon ${iconClass}">${actionIcon}</div>
        <div class="changelog-content">
            <div class="changelog-action-label">${esc(actionLabel)}</div>
            ${detailHtml}
            <div class="changelog-meta">
                <span class="changelog-time">${timeStr}</span>
                ${userStr ? `<span class="changelog-user">— ${userStr}</span>` : ''}
            </div>
        </div>
    </div>`;
}

/**
 * Åbn historik-modal for et bon-kort.
 * Kaldes fra action-bar: onclick="showHistorik('bon123')"
 */
async function showHistorik(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;

    const bonId  = cardId.replace('bon', '');
    const bonNr  = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;

    // Vis loading-tilstand
    openModal({
        title: `Historik — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter historik…</div>',
    });

    try {
        const entries = await fetchBonChangelog(bonId);

        if (!entries || entries.length === 0) {
            // Opdater body med tom-tilstand
            const body = document.querySelector('.modal-body');
            if (body) body.innerHTML = '<div class="changelog-empty">Ingen historik endnu</div>';
            return;
        }

        const html = `<div class="changelog-list">${entries.map(_buildChangelogEntry).join('')}</div>`;

        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
    } catch (err) {
        console.error('Fejl ved hentning af historik:', err);
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = '<div class="changelog-empty">Kunne ikke hente historik. Prøv igen.</div>';
    }
}

/* ══════════════════════════════════════════════════════════════
   BON INFO — FULD DETALJEVISNING
   ══════════════════════════════════════════════════════════════ */

/** Danske labels for info-modal */
const _PAY_LABELS       = { invoice: 'Faktura', card: 'Kort', mobilepay: 'MobilePay', cash: 'Kontant', pos: 'POS' };
const _DEL_TYPE_LABELS  = { delivery: 'Levering', pickup: 'Afhentning', event: 'Event' };
const _DEL_METHOD_LABELS = { bike: 'Cykel', taxi: 'Taxa', volvo: 'Volvo', pickup: 'Afhentning' };
const _PRICE_CAT_LABELS = { store: 'Butik', catering: 'Catering', festival: 'Festival', produktion: 'Produktion', waiste: 'Waiste' };

/** Formatér beløb som dansk kr */
function _fmtKr(v) {
    if (v == null) return '—';
    return Number(v).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

/**
 * Åbn info-modal for et bon-kort eller direkte med bonId.
 * Henter fuld bon via GET /api/bons/:id og viser alle detaljer.
 *
 * Kald fra action-bar:  showBonInfo('bon123')
 * Kald fra kalender:    showBonInfo(123, { showGotoButton: true, bonNumber: '3305' })
 */
async function showBonInfo(cardIdOrBonId, options) {
    var opts = options || {};
    var bonId, bonNr;

    if (typeof cardIdOrBonId === 'string' && cardIdOrBonId.startsWith('bon')) {
        // Kaldt fra bon-kort: cardId = 'bon123'
        var card = document.getElementById(cardIdOrBonId);
        if (!card) return;
        bonId = cardIdOrBonId.replace('bon', '');
        bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;
    } else {
        // Kaldt fra kalender: bonId = 123
        bonId = cardIdOrBonId;
        bonNr = opts.bonNumber ? '#' + opts.bonNumber : '#' + bonId;
    }

    // Brug global edit-handler hvis view har registreret en
    if (!opts.showEditButton && typeof window._bonInfoEditHandler === 'function') {
        opts.showEditButton = true;
        opts.showGotoButton = true;
        opts.onEdit = window._bonInfoEditHandler;
    }

    // Vis loading
    openModal({
        title: `Info — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter bon-data…</div>',
    });

    try {
        const bon = await fetchBon(bonId);
        const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
        const body = overlay && overlay.querySelector('.modal-body');
        if (body) {
            body.innerHTML = _buildBonInfoHtml(bon);

            // Mail-historik (async, non-blocking)
            _loadInfoMail(bonId, body);

            // Knap-sektion (Gå til bon + Rediger)
            if (opts.showGotoButton || opts.showEditButton) {
                var gotoDiv = document.createElement('div');
                gotoDiv.className = 'info-goto-section';

                if (opts.showGotoButton) {
                    var now = new Date();
                    var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
                    var targetPage = (bon.delivery_date <= today) ? '/kitchen/today.html' : '/kitchen/later.html';
                    var gotoBtn = document.createElement('button');
                    gotoBtn.className = 'info-goto-btn';
                    gotoBtn.textContent = 'Gå til bon \u2192';
                    gotoBtn.addEventListener('click', function() {
                        closeModal();
                        window.location.href = targetPage + '#bon' + bonId;
                    });
                    gotoDiv.appendChild(gotoBtn);
                }

                if (opts.showEditButton && typeof opts.onEdit === 'function') {
                    var editBtn = document.createElement('button');
                    editBtn.className = 'info-goto-btn info-edit-btn';
                    editBtn.textContent = 'Rediger';
                    editBtn.addEventListener('click', function() {
                        closeModal();
                        opts.onEdit(bonId);
                    });
                    gotoDiv.appendChild(editBtn);
                }

                body.appendChild(gotoDiv);
            }
        }
    } catch (err) {
        console.error('Fejl ved hentning af bon-info:', err);
        const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
        const body = overlay && overlay.querySelector('.modal-body');
        if (body) body.innerHTML = '<div class="changelog-empty">Kunne ikke hente bon-data. Prøv igen.</div>';
    }
}

/**
 * Hent og vis mail-historik i info-modal (non-blocking).
 */
async function _loadInfoMail(bonId, bodyEl) {
    if (typeof fetchBonMail !== 'function') return;
    try {
        const mailData = await fetchBonMail(bonId);
        const allMsgs = [];
        (mailData.threads || []).forEach(t => (t.messages || []).forEach(m => allMsgs.push(m)));
        if (allMsgs.length === 0) return; // Ingen mails — vis intet

        allMsgs.sort((a, b) => new Date(b.received_at || b.sent_at || b.created_at) - new Date(a.received_at || a.sent_at || a.created_at));
        const unread = allMsgs.filter(m => m.direction === 'in' && !m.is_read).length;

        var section = document.createElement('div');
        section.className = 'info-mail-section';
        section.innerHTML = '<div class="bm-history-header">✉ Mail' + (unread ? ' <span class="bm-badge">' + unread + ' ulæst</span>' : '') + '</div>'
            + '<div class="bm-messages" style="max-height:200px">'
            + allMsgs.slice(0, 10).map(function(m) {
                var isIn = m.direction === 'in';
                var isUnread = isIn && !m.is_read;
                var from = isIn ? (m.from_name || m.from_email || '?') : 'Ristet Rug';
                var d = new Date(m.received_at || m.sent_at || m.created_at);
                var dateStr = d.getDate() + '/' + (d.getMonth()+1) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
                var body = (m.body_text || '').slice(0, 120).replace(/\n/g, ' ');
                return '<div class="bm-msg ' + (isIn ? 'bm-in' : 'bm-out') + (isUnread ? ' bm-unread' : '') + '">'
                    + '<div class="bm-msg-header"><span class="bm-msg-from">' + esc(from) + '</span><span class="bm-msg-date">' + dateStr + '</span></div>'
                    + '<div class="bm-msg-subject">' + esc(m.subject || '') + '</div>'
                    + '<div class="bm-msg-body">' + esc(body) + (body.length >= 120 ? '…' : '') + '</div>'
                    + '</div>';
            }).join('')
            + '</div>';

        // Indsæt før knap-sektionen (eller til sidst)
        var gotoSection = bodyEl.querySelector('.info-goto-section');
        if (gotoSection) bodyEl.insertBefore(section, gotoSection);
        else bodyEl.appendChild(section);
    } catch (err) {
        // Stille fejl — mail er ikke kritisk for info-modal
        console.warn('[info-mail]', err.message);
    }
}

/**
 * Byg HTML for fuld bon-info modal.
 */
function _buildBonInfoHtml(bon) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Status
    const statusFe  = statusToFrontend(bon.status_code);
    const statusCfg = BON_CONFIG && BON_CONFIG.statuses && BON_CONFIG.statuses[statusFe];
    const statusLabel = statusCfg ? statusCfg.label : (bon.status_label || bon.status_code);
    const statusColor = statusCfg ? statusCfg.color : (bon.status_color || '#999');
    const statusText  = statusCfg ? statusCfg.text  : '#fff';

    // Leveringsadresse
    let addrStr = '';
    if (bon.delivery_address) {
        const a = bon.delivery_address;
        addrStr = [a.street_name, a.street_nr].filter(Boolean).join(' ');
        if (a.street_name2) addrStr += ', ' + a.street_name2;
        if (a.postal_code || a.city) addrStr += ', ' + [a.postal_code, a.city].filter(Boolean).join(' ');
    } else if (bon.customer_collects) {
        addrStr = 'Afhentes';
    }

    // Leveringstype + metode
    const delType   = _DEL_TYPE_LABELS[bon.delivery_type] || bon.delivery_type || '';
    const delMethod = _DEL_METHOD_LABELS[bon.delivery_method] || bon.delivery_method || '';
    const deliveryStr = [delType, delMethod].filter(Boolean).join(' · ');

    // Dato
    const dateStr = bon.delivery_date ? formatDanishDate(bon.delivery_date) : '';

    let html = '';

    // ── Overblik ──────────────────────────────────────────────
    html += '<div class="info-section">';
    html += `<div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-value"><span class="info-status-badge" style="background:${statusColor};color:${statusText}">${_esc(statusLabel)}</span></span>
    </div>`;
    if (dateStr)           html += `<div class="info-row"><span class="info-label">Dato</span><span class="info-value">${_esc(dateStr)}</span></div>`;
    if (bon.pickup_time)   html += `<div class="info-row"><span class="info-label">Afhentning</span><span class="info-value">${_esc(bon.pickup_time)}</span></div>`;
    if (bon.delivery_time) html += `<div class="info-row"><span class="info-label">Levering kl.</span><span class="info-value">${_esc(bon.delivery_time)}</span></div>`;
    if (deliveryStr)       html += `<div class="info-row"><span class="info-label">Type</span><span class="info-value">${_esc(deliveryStr)}</span></div>`;
    if (bon.pax)           html += `<div class="info-row"><span class="info-label">Kuverter</span><span class="info-value">${bon.pax}</span></div>`;
    if (bon.total_units)   html += `<div class="info-row"><span class="info-label">Enheder</span><span class="info-value">${bon.total_units}</span></div>`;
    if (bon.boxes)         html += `<div class="info-row"><span class="info-label">Kasser</span><span class="info-value">${bon.boxes}</span></div>`;
    html += '</div>';

    // ── Kunde ─────────────────────────────────────────────────
    const custName = (bon.contact_name_full || '').trim();
    const compName = bon.company_name || '';
    if (custName || compName) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Kunde</div>';
        const nameParts = [custName, compName].filter(Boolean);
        html += `<div class="info-customer-name">${_esc(nameParts.join(' · '))}</div>`;
        if (addrStr) html += `<div class="info-customer-detail">${_esc(addrStr)}</div>`;
        // Telefonnumre: bestiller + dagskontakt
        if (bon.contact_phone) {
            const label = bon.company_phone && bon.company_phone !== bon.contact_phone ? ' <span class="info-phone-label">Bestiller</span>' : '';
            html += `<div class="info-customer-detail">📞 ${_esc(bon.contact_phone)}${label}</div>`;
        }
        if (bon.company_phone && bon.company_phone !== bon.contact_phone) {
            html += `<div class="info-customer-detail">📞 ${_esc(bon.company_phone)} <span class="info-phone-label">Dagskontakt</span></div>`;
        }
        if (bon.contact_email) html += `<div class="info-customer-detail">✉ ${_esc(bon.contact_email)}</div>`;
        html += '</div>';
    }

    // ── Menulinjer ────────────────────────────────────────────
    const lines = bon.lines || [];
    if (lines.length > 0) {
        const mainLines = lines.filter(l => !l.is_accessory);
        const accLines  = lines.filter(l => l.is_accessory);

        html += '<div class="info-section">';
        html += '<div class="info-section-title">Menulinjer</div>';
        html += '<div class="info-lines">';

        for (const l of mainLines) {
            html += _buildInfoLine(l, _esc);
        }
        if (accLines.length > 0) {
            html += '<div class="info-lines-divider"></div>';
            for (const l of accLines) {
                html += _buildInfoLine(l, _esc);
            }
        }
        html += '</div>';

        // Totals
        const lineSum = lines.reduce((s, l) => s + (l.line_total || 0), 0);
        html += '<div class="info-totals">';
        if (bon.delivery_price != null && bon.delivery_price > 0) {
            html += `<div class="info-total-row"><span>Levering</span><span>${_fmtKr(bon.delivery_price)}</span></div>`;
        }
        const grand = (bon.total_with_delivery != null) ? bon.total_with_delivery
                     : (lineSum + (bon.delivery_price || 0));
        if (grand > 0) {
            // Moms: 25% dansk moms (inkluderet i priserne) — se shared/moms.js
            const moms = window.Moms.momsOfIncl(grand);
            html += `<div class="info-total-row"><span>Heraf moms</span><span>${_fmtKr(moms)}</span></div>`;
            html += `<div class="info-total-row info-total-grand"><span>I alt</span><span>${_fmtKr(grand)}</span></div>`;
        }
        html += '</div>';
        html += '</div>';
    }

    // ── Noter ─────────────────────────────────────────────────
    const hasNotes = bon.kitchen_info || bon.customer_wishes || bon.internal_notes || bon.delivery_notes;
    if (hasNotes) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Noter</div>';
        if (bon.kitchen_info)    html += `<div class="info-note"><span class="info-note-label">Køkkeninfo</span><div class="info-note-text">${_esc(bon.kitchen_info)}</div></div>`;
        if (bon.customer_wishes) html += `<div class="info-note"><span class="info-note-label">Kundeønsker</span><div class="info-note-text">${_esc(bon.customer_wishes)}</div></div>`;
        if (bon.delivery_notes)  html += `<div class="info-note"><span class="info-note-label">Leveringsnoter</span><div class="info-note-text">${_esc(bon.delivery_notes)}</div></div>`;
        if (bon.internal_notes)  html += `<div class="info-note"><span class="info-note-label">Intern note</span><div class="info-note-text">${_esc(bon.internal_notes)}</div></div>`;
        html += '</div>';
    }

    // ── Betaling ──────────────────────────────────────────────
    const payLabel  = _PAY_LABELS[bon.payment_type] || bon.payment_type || '';
    const priceCat  = _PRICE_CAT_LABELS[bon.price_category] || bon.price_category || '';
    if (payLabel || priceCat) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Betaling</div>';
        const parts = [payLabel, priceCat ? priceCat + '-priser' : ''].filter(Boolean);
        html += `<div class="info-payment">${_esc(parts.join(' · '))}</div>`;
        html += '</div>';
    }

    // ── Bud / kurerinfo ───────────────────────────────────────
    if (bon.courier_provider || bon.courier_arrival_time || (bon.delivery_cost != null && bon.delivery_cost > 0)) {
        html += '<div class="info-section">';
        html += '<div class="info-section-title">Bud</div>';
        if (bon.courier_provider)      html += `<div class="info-row"><span class="info-label">Firma</span><span class="info-value">${_esc(bon.courier_provider)}</span></div>`;
        if (bon.courier_arrival_time)  html += `<div class="info-row"><span class="info-label">Ankomst</span><span class="info-value">${_esc(bon.courier_arrival_time)}</span></div>`;
        if (bon.delivery_cost != null && bon.delivery_cost > 0) html += `<div class="info-row"><span class="info-label">Omkostning</span><span class="info-value">${_fmtKr(bon.delivery_cost)}</span></div>`;
        html += '</div>';
    }

    return html;
}

/**
 * Byg HTML for én menulinje i info-modalen.
 */
function _buildInfoLine(line, _esc) {
    const special = line.special_request
        ? `<div class="info-line-special">${_esc(line.special_request)}</div>`
        : '';
    const priceStr = line.line_total != null
        ? `<span class="info-line-total">${_fmtKr(line.line_total)}</span>`
        : '';
    const accessoryCls = line.is_accessory ? ' accessory' : '';

    return `<div class="info-line${accessoryCls}">
        <span class="info-line-qty">${line.quantity}</span>
        <span class="info-line-name">${_esc(line.product_name)}${special}</span>
        ${priceStr}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   RÅVARER — INGREDIENSBEHOV
   ══════════════════════════════════════════════════════════════ */

const _STATUS_DOT = {
    mangler: { dot: '🔴', cls: 'ing-status-mangler' },
    lav:     { dot: '🟡', cls: 'ing-status-lav' },
    ok:      { dot: '🟢', cls: 'ing-status-ok' },
};

// Gem seneste råvare-data for toggle
let _ravarerData = null;
let _ravarerLevel = 'production'; // 'production' | 'raw'

/**
 * Åbn råvarer-modal for et bon-kort.
 * Henter aggregerede ingredienser med lagerstatus.
 * Kaldes fra action-bar: onclick="showRavarer('bon123')"
 */
async function showRavarer(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;

    const bonId = cardId.replace('bon', '');
    const bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;

    openModal({
        title: `Råvarer — ${esc(bonNr)}`,
        bodyHtml: '<div class="changelog-empty">Henter ingrediensbehov…</div>',
    });

    try {
        const data = await fetchBonIngredients(bonId);
        _ravarerData = data;
        _ravarerLevel = 'production';
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = _buildRavarerHtml(data);
    } catch (err) {
        console.error('Fejl ved hentning af ingredienser:', err);
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = `<div class="changelog-empty">Kunne ikke hente ingredienser. Prøv igen.</div>`;
    }
}

/**
 * Sæt råvarer-niveau og re-render modal.
 */
function _setRavarerLevel(level) {
    if (!_ravarerData) return;
    _ravarerLevel = level;
    const body = document.querySelector('.modal-body');
    if (body) body.innerHTML = _buildRavarerHtml(_ravarerData);
}

/**
 * Formatér tal til dansk (1.234,56)
 */
function _fmtNum(v) {
    if (v == null) return '—';
    const n = Math.round(v * 100) / 100;
    return n.toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Byg HTML for ingrediens-modal.
 * Understøtter to niveauer: produktion (direkte + underopskrifter) og råvarer (alt fladt).
 * Grupperet efter Grocy ingredient_group med status-dots per linje.
 */
function _buildRavarerHtml(data) {
    const _esc = typeof esc === 'function' ? esc : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Vælg aktivt niveau — brug production/raw hvis tilgængelig, ellers bagudkompatibelt
    const hasLevels = data.production && data.raw;
    const level = hasLevels ? ((_ravarerLevel === 'raw') ? data.raw : data.production) : data;
    const groups = level.groups || data.groups || [];
    const subRecipes = level.sub_recipes || [];

    if (groups.length === 0 && subRecipes.length === 0) {
        let msg = 'Ingen ingredienser fundet.';
        if (data.lines_without_recipe && data.lines_without_recipe.length > 0) {
            msg += ' Ingen linjer har en Grocy-opskrift.';
        }
        return `<div class="changelog-empty">${msg}</div>`;
    }

    let html = '';

    // Toggle-knapper (kun hvis begge niveauer er tilgængelige)
    if (hasLevels) {
        const prodActive = _ravarerLevel === 'production' ? ' active' : '';
        const rawActive  = _ravarerLevel === 'raw' ? ' active' : '';
        html += `<div class="ing-level-toggle">
            <button class="ing-level-btn${prodActive}" onclick="_setRavarerLevel('production')">🔧 Produktion</button>
            <button class="ing-level-btn${rawActive}" onclick="_setRavarerLevel('raw')">📦 Råvarer</button>
        </div>`;
    }

    // Søgefelt
    html += `<div class="ing-search-wrap">
        <input type="text" class="ing-search" placeholder="Søg ingrediens…"
               oninput="_filterIngredients(this.value)">
    </div>`;

    // Render ingrediens-grupper
    for (const group of groups) {
        const groupTitle = group.name || 'Øvrige';

        html += '<div class="ing-group">';
        html += `<div class="ing-group-header" onclick="_toggleIngGroup(this)">
            <span class="ing-group-label">${_esc(groupTitle)}</span>
            <span class="ing-group-toggle">▾</span>
        </div>`;

        html += '<div class="ing-table">';
        for (const ing of group.ingredients) {
            const st = _STATUS_DOT[ing.status] || _STATUS_DOT.ok;
            const showCart = ing.status === 'mangler' || ing.status === 'lav';
            const purchaseAmount = ing.shortfall_purchase || 0;
            const purchaseUnit = ing.purchase_unit || '';
            const cartTitle = purchaseAmount > 0
                ? `Tilføj ${_fmtNum(purchaseAmount)} ${purchaseUnit} til indkøbsliste`
                : 'Tilføj til indkøbsliste';
            const cartBtn = showCart
                ? `<button class="ing-btn-cart" onclick="_addToShoppingList(this, ${ing.product_id}, ${purchaseAmount}, '${_esc(ing.product_name)}')" title="${cartTitle}">🛒</button>`
                : '';

            html += `<div class="ing-row ${st.cls}" data-ing-name="${_esc(ing.product_name.toLowerCase())}">
                <span class="ing-dot">${st.dot}</span>
                <span class="ing-name">${_esc(ing.product_name)}</span>
                <span class="ing-amount">${_fmtNum(ing.amount_needed)}</span>
                <span class="ing-unit">${_esc(ing.unit)}</span>
                <span class="ing-stock">${_fmtNum(ing.amount_stock)}</span>
                <span class="ing-stock-unit">${_esc(ing.stock_unit || ing.unit)}</span>
                <span class="ing-action">${cartBtn}</span>
            </div>`;
        }
        html += '</div></div>';
    }

    // Underopskrifter (kun produktion-niveau)
    if (subRecipes.length > 0) {
        html += '<div class="ing-group">';
        html += `<div class="ing-group-header" onclick="_toggleIngGroup(this)">
            <span class="ing-group-label">🔗 Underopskrifter</span>
            <span class="ing-group-toggle">▾</span>
        </div>`;
        html += '<div class="ing-table">';
        for (const sr of subRecipes) {
            html += `<div class="ing-row ing-sub-recipe" data-ing-name="${_esc(sr.recipe_name.toLowerCase())}">
                <span class="ing-dot">🟢</span>
                <span class="ing-name">${_esc(sr.recipe_name)}</span>
                <span class="ing-amount">${_esc(sr.amount)}</span>
                <span class="ing-unit"></span>
                <span class="ing-stock"></span>
                <span class="ing-stock-unit"></span>
                <span class="ing-action"></span>
            </div>`;
        }
        html += '</div></div>';
    }

    // Linjer uden opskrift
    if (data.lines_without_recipe && data.lines_without_recipe.length > 0) {
        html += `<div class="ing-note">Uden Grocy-opskrift: ${data.lines_without_recipe.map(n => _esc(n)).join(', ')}</div>`;
    }

    return html;
}

/**
 * Filtrér ingredienser i Råvarer-modal baseret på søgeterm.
 * Skjuler rækker der ikke matcher og grupper uden synlige rækker.
 */
function _filterIngredients(term) {
    const q = term.toLowerCase().trim();
    const groups = document.querySelectorAll('.ing-group');

    for (const group of groups) {
        const rows = group.querySelectorAll('.ing-row');
        let visibleCount = 0;

        for (const row of rows) {
            const name = row.getAttribute('data-ing-name') || '';
            const match = !q || name.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) visibleCount++;
        }

        // Skjul hele gruppen hvis ingen synlige rækker
        group.style.display = visibleCount > 0 ? '' : 'none';
    }
}

/**
 * Toggle fold/unfold af en gruppe.
 */
function _toggleIngGroup(headerEl) {
    const group = headerEl.closest('.ing-group');
    if (group) group.classList.toggle('collapsed');
}

/**
 * Tilføj til Grocy indkøbsliste.
 * Bruger shortfall_stock (i lager-enheder) som mængde.
 */
async function _addToShoppingList(btnEl, productId, amount, name) {
    btnEl.disabled = true;
    btnEl.textContent = '…';

    try {
        await postGrocyShoppingList([{ product_id: productId, amount: amount, note: name }]);
        btnEl.textContent = '✓';
        btnEl.classList.add('ing-btn-done');
    } catch (err) {
        console.error('Indkøbsliste fejl:', err);
        btnEl.textContent = '✗';
        btnEl.disabled = false;
        setTimeout(() => { btnEl.textContent = '🛒'; }, 2000);
    }
}
