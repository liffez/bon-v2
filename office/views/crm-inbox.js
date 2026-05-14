/**
 * office/views/crm-inbox.js
 * ════════════════════════════════════════════════════════════
 * CRM Indbakke — ufordelte mails fra mail_unmatched
 * ════════════════════════════════════════════════════════════
 */

let _inbContainer = null;
let _inbOpts = {};
let _inbActive = false;
let _inbMails = [];
let _inbSelected = null;
let _inbMailbox = '';        // '' = alle, 'bon' = bon@, 'kontakt' = kontakt@
let _inbFromDate = '2026-01-01';

function initCrmInbox(containerEl, opts) {
    _inbContainer = containerEl;
    _inbOpts = opts || {};
    _inbActive = true;
    _inbRenderShell();
    _inbLoadData();
}

function cleanupCrmInbox() {
    _inbActive = false;
    _inbContainer = null;
    _inbMails = [];
    _inbSelected = null;
    _inbMailbox = '';
    _inbFromDate = '2026-01-01';
}

function _inbRenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Mail Indbakke';

    _inbContainer.innerHTML = `
        <style>
            .inb-layout { display: grid; grid-template-columns: 380px 1fr; gap: 12px; height: 100%; }
            @media (max-width: 800px) { .inb-layout { grid-template-columns: 1fr; } }

            .inb-list-panel {
                background: var(--color-surface, #fff); border-radius: 10px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow-y: auto;
            }
            .inb-list-header {
                padding: 14px 16px; border-bottom: 1px solid var(--color-border, #eee);
                font-size: 11px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .5px; color: var(--color-text-dim, #888);
                display: flex; justify-content: space-between; align-items: center;
            }
            .inb-count {
                background: var(--brand-primary); color: white;
                padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 700;
            }
            .inb-mail-row {
                padding: 12px 16px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; transition: background .1s;
                outline: none;
            }
            .inb-mail-row:hover { background: var(--color-background, #f5f4f2); }
            .inb-mail-row.selected { background: var(--brand-primary-light, #f1e6b2); }
            .inb-mail-row:focus { box-shadow: inset 0 0 0 2px var(--brand-primary, #8e631f); }
            .inb-mail-from { font-size: 14px; font-weight: 600; }
            .inb-mail-subject { font-size: 13px; color: var(--color-text, #333); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .inb-mail-meta { font-size: 11px; color: var(--color-text-dim, #aaa); margin-top: 4px; display: flex; justify-content: space-between; }
            .inb-mail-parsed { font-size: 11px; color: var(--brand-primary); margin-top: 2px; font-weight: 600; }

            .inb-preview-panel {
                background: var(--color-surface, #fff); border-radius: 10px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07); padding: 24px; overflow-y: auto;
            }
            .inb-preview-header { margin-bottom: 16px; }
            .inb-preview-from {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 17px; font-weight: 700;
            }
            .inb-preview-subject { font-size: 15px; margin-top: 6px; font-weight: 500; }
            .inb-preview-date { font-size: 12px; color: var(--color-text-dim); margin-top: 6px; }
            .inb-preview-body {
                white-space: pre-wrap; font-size: 14px; line-height: 1.7;
                padding: 16px 0; border-top: 1px solid var(--color-border);
                border-bottom: 1px solid var(--color-border);
                max-height: 400px; overflow-y: auto;
            }
            .inb-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
            .inb-action-btn {
                padding: 8px 18px; border-radius: 8px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface); font-size: 13px; cursor: pointer; font-weight: 600;
                font-family: inherit; transition: background .1s;
            }
            .inb-action-btn:hover { background: var(--brand-primary-light); }
            .inb-action-btn.danger { color: #c94040; }
            .inb-action-btn.danger:hover { background: var(--color-sentiment-neg-bg); }
            .inb-action-btn.primary { background: var(--brand-primary); color: white; border-color: transparent; }
            .inb-action-btn.primary:hover { filter: brightness(1.1); }

            .inb-link-form { margin-top: 12px; padding: 14px; background: var(--color-background, #f5f4f2); border-radius: 10px; border: 1px solid var(--color-border); }
            .inb-link-input {
                width: 100%; padding: 8px 12px; border-radius: 6px;
                border: 1px solid var(--color-border); font-size: 13px; margin-top: 6px;
                font-family: inherit;
            }
            .inb-link-input:focus { border-color: var(--brand-primary); outline: none; }
            .inb-link-submit { margin-top: 8px; }

            .inb-empty { text-align: center; padding: 40px; color: var(--color-text-dim); font-size: 14px; }
            .inb-hint { font-size: 11px; color: var(--color-text-dim); padding: 8px 16px; text-align: center; }
            .inb-filter-btn { font-size: 12px; padding: 4px 12px; border: 1.5px solid var(--color-border, #d7d1ca); border-radius: 14px; background: var(--color-surface, #fff); cursor: pointer; color: var(--color-text-dim); font-family: inherit; }
            .inb-filter-btn:hover { border-color: var(--brand-primary); }
            .inb-filter-btn.active { background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary); }

            /* ── Bounce-styling ───────────────────────────────────── */
            .inb-mail-row.is-bounce {
                border-left: 3px solid #c94040;
            }
            .inb-bounce-badge {
                display: inline-block;
                background: #c94040;
                color: white;
                font-size: 9px;
                font-weight: 800;
                padding: 1px 6px;
                border-radius: 4px;
                letter-spacing: 0.5px;
                margin-right: 6px;
                vertical-align: middle;
            }
            .inb-mail-bounce-target {
                font-size: 11px;
                color: #c94040;
                margin-top: 4px;
                font-weight: 500;
            }
            .inb-mail-bounce-target code, .inb-mail-bounce-target strong {
                color: var(--color-text, #333);
            }
            .inb-bounce-panel {
                margin: 12px 0 16px;
                padding: 16px 18px;
                background: #fbe9e9;
                border-left: 4px solid #c94040;
                border-radius: 6px;
            }
            .inb-bounce-title {
                font-size: 14px;
                font-weight: 800;
                color: #c94040;
                margin-bottom: 8px;
            }
            .inb-bounce-recipient {
                font-size: 13px;
                color: #4a3210;
                margin-bottom: 10px;
            }
            .inb-bounce-recipient code {
                background: rgba(0,0,0,0.06);
                padding: 1px 6px;
                border-radius: 3px;
                font-family: 'Menlo', monospace;
                font-size: 12px;
            }
            .inb-bounce-customer {
                font-size: 14px;
                padding: 10px 0;
                color: var(--color-text, #333);
            }
            .inb-bounce-customer.inb-bounce-no-match {
                color: #8a8580;
                font-style: italic;
                font-size: 13px;
            }
            .inb-bounce-tel {
                color: var(--brand-primary, #8e631f);
                text-decoration: none;
                font-weight: 700;
            }
            .inb-bounce-tel:hover {
                text-decoration: underline;
            }
            .inb-bounce-no-phone {
                color: #aaa;
                font-style: italic;
                font-size: 13px;
            }
            .inb-bounce-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
                flex-wrap: wrap;
            }
        </style>

        <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;padding:0 4px">
            <div style="display:flex;gap:4px">
                <button class="inb-filter-btn ${_inbMailbox === '' ? 'active' : ''}" onclick="_inbSetMailbox('')">Alle</button>
                <button class="inb-filter-btn ${_inbMailbox === 'bon' ? 'active' : ''}" onclick="_inbSetMailbox('bon')">bon@</button>
                <button class="inb-filter-btn ${_inbMailbox === 'kontakt' ? 'active' : ''}" onclick="_inbSetMailbox('kontakt')">kontakt@</button>
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-left:auto">
                <label style="font-size:12px;color:var(--color-text-dim)">Fra:</label>
                <input type="date" id="inbFromDate" value="${_inbFromDate}" onchange="_inbSetFromDate(this.value)" oninput="_inbSetFromDate(this.value)" style="font-size:12px;padding:4px 8px;border:1px solid var(--color-border);border-radius:6px">
            </div>
        </div>
        <div class="inb-layout">
            <div class="inb-list-panel">
                <div class="inb-list-header">
                    <span>Ufordelte mails</span>
                    <span class="inb-count" id="inbCount">0</span>
                </div>
                <div id="inbList"></div>
            </div>
            <div class="inb-preview-panel" id="inbPreview">
                <div class="inb-empty">Vælg en mail fra listen</div>
                <div class="inb-hint">↑↓ piltaster for navigation</div>
            </div>
        </div>
    `;
}

async function _inbLoadData() {
    if (!_inbActive) return;
    try {
        const params = new URLSearchParams({ status: 'open' });
        if (_inbFromDate) params.set('from_date', _inbFromDate);
        if (_inbMailbox) params.set('mailbox', _inbMailbox);
        _inbMails = await apiFetch('/mail/unmatched?' + params.toString());
        _inbRenderList();
        document.getElementById('inbCount').textContent = _inbMails.length;
        if (_inbSelected) {
            const still = _inbMails.find(m => m.id === _inbSelected.id);
            if (still) _inbRenderPreview(still);
            else { _inbSelected = null; document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Vælg en mail fra listen</div>'; }
        }
    } catch (err) {
        console.error('[inbox] Load error:', err);
    }
}

function _inbRenderList() {
    const el = document.getElementById('inbList');
    if (!el) return;

    if (!_inbMails.length) {
        el.innerHTML = '<div class="inb-empty">Ingen ufordelte mails</div>';
        return;
    }

    el.innerHTML = _inbMails.map(m => {
        const bounceBadge = m.is_bounce
            ? '<span class="inb-bounce-badge">🚨 BOUNCE</span>'
            : '';
        const bounceSubtitle = m.is_bounce && m.bounce_recipient
            ? '<div class="inb-mail-bounce-target">↳ ' + _inbEscape(m.bounce_recipient) +
              (m.bounce_customer_name ? ' · <strong>' + _inbEscape(m.bounce_customer_name) + '</strong>' : ' · <em>ukendt kunde</em>') +
              '</div>'
            : '';
        return '<div class="inb-mail-row' + (_inbSelected && _inbSelected.id === m.id ? ' selected' : '') + (m.is_bounce ? ' is-bounce' : '') + '" data-id="' + m.id + '" tabindex="0">' +
            '<div class="inb-mail-from">' + bounceBadge + (m.from_name || m.from_email || 'Ukendt') + '</div>' +
            '<div class="inb-mail-subject">' + (m.subject || '(intet emne)') + '</div>' +
            '<div class="inb-mail-meta">' +
                '<span>' + (m.from_email || '') + '</span>' +
                '<span>' + (m.received_at || '').substring(0, 16) + '</span>' +
            '</div>' +
            bounceSubtitle +
            (m.parsed_company ? '<div class="inb-mail-parsed">→ ' + _inbEscape(m.parsed_company) + '</div>' : '') +
        '</div>';
    }).join('');

    el.querySelectorAll('.inb-mail-row').forEach(row => {
        row.addEventListener('click', () => _inbSelectRow(row));
        row.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = row.nextElementSibling;
                if (next && next.classList.contains('inb-mail-row')) {
                    next.focus();
                    _inbSelectRow(next);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('inb-mail-row')) {
                    prev.focus();
                    _inbSelectRow(prev);
                }
            } else if (e.key === 'Enter') {
                _inbSelectRow(row);
            }
        });
    });
}

function _inbSelectRow(row) {
    const id = parseInt(row.dataset.id);
    const mail = _inbMails.find(m => m.id === id);
    if (mail) {
        _inbSelected = mail;
        document.querySelectorAll('.inb-mail-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        _inbRenderPreview(mail);
    }
}

function _inbRenderPreview(mail) {
    const el = document.getElementById('inbPreview');
    if (!el) return;

    // Bounce-banner — vises prominent når mail er en bounce
    let bouncePanel = '';
    if (mail.is_bounce) {
        let customerLine = '';
        if (mail.bounce_customer_id) {
            const name = mail.bounce_customer_name || 'Ukendt';
            const company = mail.bounce_customer_company ? ' (' + _inbEscape(mail.bounce_customer_company) + ')' : '';
            const phone = mail.bounce_customer_phone
                ? '<a href="tel:' + _inbEscape(mail.bounce_customer_phone) + '" class="inb-bounce-tel">📞 ' + _inbEscape(mail.bounce_customer_phone) + '</a>'
                : '<span class="inb-bounce-no-phone">Intet telefonnummer</span>';
            customerLine =
                '<div class="inb-bounce-customer">' +
                    '<strong>' + _inbEscape(name) + '</strong>' + company + ' · ' + phone +
                '</div>' +
                '<div class="inb-bounce-actions">' +
                    '<button class="inb-action-btn primary" onclick="_inbOpenBounceCustomer(' + mail.bounce_customer_id + ')">' +
                        'Åbn kunde →' +
                    '</button>' +
                    '<button class="inb-action-btn" onclick="_inbMarkBounceHandled()">Markér som behandlet</button>' +
                '</div>';
        } else if (mail.bounce_recipient) {
            customerLine =
                '<div class="inb-bounce-customer inb-bounce-no-match">' +
                    'Ingen kunde med denne email i CRM — søg manuelt via "Link til Kunde" nedenfor' +
                '</div>';
        } else {
            customerLine =
                '<div class="inb-bounce-customer inb-bounce-no-match">' +
                    'Kunne ikke parse modtager-adressen ud af bouncen. Læs body manuelt.' +
                '</div>';
        }

        bouncePanel =
            '<div class="inb-bounce-panel">' +
                '<div class="inb-bounce-title">🚨 Mail blev IKKE leveret</div>' +
                (mail.bounce_recipient
                    ? '<div class="inb-bounce-recipient">Forsøgt sendt til: <code>' + _inbEscape(mail.bounce_recipient) + '</code></div>'
                    : '') +
                customerLine +
            '</div>';
    }

    el.innerHTML =
        '<div class="inb-preview-header">' +
            '<div class="inb-preview-from">' + (mail.from_name || 'Ukendt') + ' &lt;' + (mail.from_email || '') + '&gt;</div>' +
            '<div class="inb-preview-subject">' + (mail.subject || '(intet emne)') + '</div>' +
            '<div class="inb-preview-date">' + (mail.received_at || '') + ' · ' + (mail.mailbox || '') + '</div>' +
        '</div>' +
        bouncePanel +
        '<div class="inb-preview-body">' + _inbEscape(mail.body_text || '') + '</div>' +
        '<div class="inb-actions">' +
            '<button class="inb-action-btn primary" onclick="_inbShowLinkBon()">Link til Bon</button>' +
            '<button class="inb-action-btn" onclick="_inbShowLinkKunde()">Link til Kunde</button>' +
            '<button class="inb-action-btn danger" onclick="_inbIgnore()">Ignorer</button>' +
        '</div>' +
        '<div id="inbLinkForm"></div>';
}

// ─── Bounce-handlers ────────────────────────────────────────

function _inbOpenBounceCustomer(customerId) {
    // Naviger til Kunde 360° (via Kontakter-tab i CRM)
    if (typeof window.openKunde360 === 'function') {
        window.openKunde360(customerId);
    } else if (typeof window.officeGoto === 'function') {
        window.officeGoto('crm', { pill: 'kontakter', tab: 'personer', customer: customerId });
    }
}
window._inbOpenBounceCustomer = _inbOpenBounceCustomer;

async function _inbMarkBounceHandled() {
    if (!_inbSelected) return;
    if (!confirm('Markér bouncen som behandlet?\n\nGør dette efter du har:\n  1. Kontaktet kunden\n  2. Opdateret deres email-adresse')) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'ignored' });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Bounce markeret som behandlet</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}
window._inbMarkBounceHandled = _inbMarkBounceHandled;

function _inbEscape(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _inbShowLinkBon() {
    const el = document.getElementById('inbLinkForm');
    if (!el) return;
    el.innerHTML =
        '<div class="inb-link-form">' +
            '<strong>Link til bon</strong>' +
            '<input type="text" class="inb-link-input" id="inbBonSearch" placeholder="Skriv bonnummer...">' +
            '<button class="inb-action-btn primary inb-link-submit" onclick="_inbLinkToBon()">Link</button>' +
        '</div>';
    document.getElementById('inbBonSearch').focus();
}

function _inbShowLinkKunde() {
    const el = document.getElementById('inbLinkForm');
    if (!el) return;
    el.innerHTML =
        '<div class="inb-link-form">' +
            '<strong>Link til kunde</strong>' +
            '<input type="text" class="inb-link-input" id="inbKundeSearch" placeholder="Søg kunde...">' +
            '<div id="inbKundeResults" style="margin-top:8px;"></div>' +
        '</div>';

    const input = document.getElementById('inbKundeSearch');
    input.focus();
    let debounce = null;
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
            if (!input.value.trim()) return;
            try {
                const rows = await fetchCrmCustomers({ q: input.value, limit: 5 });
                const resultsEl = document.getElementById('inbKundeResults');
                if (resultsEl) {
                    resultsEl.innerHTML = rows.map(r =>
                        '<div style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;" onclick="_inbLinkToCustomer(' + r.id + ')">' +
                            '<strong>' + r.name + '</strong>' +
                            (r.company_name ? ' · ' + r.company_name : '') +
                        '</div>'
                    ).join('');
                }
            } catch (err) { console.error(err); }
        }, 300);
    });
}

async function _inbLinkToBon() {
    if (!_inbSelected) return;
    const input = document.getElementById('inbBonSearch');
    const bonNumber = input ? input.value.trim().replace('#', '') : '';
    if (!bonNumber) { alert('Skriv et bonnummer'); return; }

    try {
        const bons = await apiFetch('/bons?q=' + bonNumber + '&limit=1');
        const rows = Array.isArray(bons) ? bons : (bons.rows || []);
        if (!rows.length) { alert('Bon ikke fundet'); return; }
        await patchUnmatchedMail(_inbSelected.id, { status: 'linked', linked_bon_id: rows[0].id });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Mail linket til bon #' + rows[0].bon_number + '</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _inbLinkToCustomer(customerId) {
    if (!_inbSelected) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'linked', linked_customer_id: customerId });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Mail linket til kunde</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _inbIgnore() {
    if (!_inbSelected) return;
    if (!confirm('Ignorer denne mail?')) return;
    try {
        await patchUnmatchedMail(_inbSelected.id, { status: 'ignored' });
        _inbSelected = null;
        _inbLoadData();
        document.getElementById('inbPreview').innerHTML = '<div class="inb-empty">Mail ignoreret</div>';
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

// ─── Filter handlers ────────────────────────────────────────

function _inbSetMailbox(mb) {
    _inbMailbox = mb;
    _inbSelected = null;
    _inbRenderShell();
    _inbLoadData();
}

function _inbSetFromDate(d) {
    _inbFromDate = d || '';
    _inbSelected = null;
    const el = document.getElementById('inbFromDate');
    if (el) el.value = _inbFromDate;
    _inbLoadData();
}

// ─── SSE handler ────────────────────────────────────────────

function _inbHandleSSE(eventType, data) {
    if (!_inbActive) return;
    if (eventType === 'mail_unmatched') {
        _inbLoadData();
    }
}
