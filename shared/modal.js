/**
 * shared/modal.js
 * ════════════════════════════════════════════════════════════
 * Genbrugelig modal-komponent for Bon v2.
 *
 * API:
 *   openModal({ title, bodyHtml })  → vis modal
 *   closeModal()                    → luk modal
 *   showHistorik(cardId)            → hent changelog + vis i modal
 *
 * Afhænger af:
 *   shared/api.js    → fetchBonChangelog()
 *   shared/utils.js  → esc()
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
