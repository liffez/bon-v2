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
                font-size: 13px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .4px; color: var(--color-text-dim, #888);
                display: flex; justify-content: space-between; align-items: center;
            }
            .inb-count {
                background: var(--brand-primary); color: white;
                padding: 1px 8px; border-radius: 10px; font-size: 11px;
            }
            .inb-mail-row {
                padding: 12px 16px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; transition: background .1s;
            }
            .inb-mail-row:hover { background: #fafafa; }
            .inb-mail-row.selected { background: var(--brand-primary-light, #f1e6b2); }
            .inb-mail-from { font-size: 13px; font-weight: 600; }
            .inb-mail-subject { font-size: 13px; color: var(--color-text, #333); margin-top: 2px; }
            .inb-mail-meta { font-size: 11px; color: var(--color-text-dim, #aaa); margin-top: 3px; display: flex; justify-content: space-between; }
            .inb-mail-parsed { font-size: 11px; color: var(--brand-primary); margin-top: 2px; }

            .inb-preview-panel {
                background: var(--color-surface, #fff); border-radius: 10px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07); padding: 20px; overflow-y: auto;
            }
            .inb-preview-header { margin-bottom: 16px; }
            .inb-preview-from { font-size: 15px; font-weight: 700; }
            .inb-preview-subject { font-size: 14px; margin-top: 4px; }
            .inb-preview-date { font-size: 12px; color: var(--color-text-dim); margin-top: 4px; }
            .inb-preview-body {
                white-space: pre-wrap; font-size: 13px; line-height: 1.6;
                padding: 16px 0; border-top: 1px solid var(--color-border);
                border-bottom: 1px solid var(--color-border);
                max-height: 400px; overflow-y: auto;
            }
            .inb-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
            .inb-action-btn {
                padding: 8px 16px; border-radius: 8px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface); font-size: 13px; cursor: pointer; font-weight: 600;
            }
            .inb-action-btn:hover { background: var(--brand-primary-light); }
            .inb-action-btn.danger { color: #c94040; }
            .inb-action-btn.primary { background: var(--brand-primary); color: white; border-color: transparent; }

            .inb-link-form { margin-top: 12px; padding: 12px; background: #fafafa; border-radius: 8px; border: 1px solid var(--color-border); }
            .inb-link-input {
                width: 100%; padding: 8px 12px; border-radius: 6px;
                border: 1px solid var(--color-border); font-size: 13px; margin-top: 6px;
            }
            .inb-link-submit { margin-top: 8px; }

            .inb-empty { text-align: center; padding: 40px; color: var(--color-text-dim); font-size: 14px; }
        </style>

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
            </div>
        </div>
    `;
}

async function _inbLoadData() {
    if (!_inbActive) return;
    try {
        _inbMails = await fetchUnmatchedMails('open');
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

    el.innerHTML = _inbMails.map(m =>
        '<div class="inb-mail-row' + (_inbSelected && _inbSelected.id === m.id ? ' selected' : '') + '" data-id="' + m.id + '">' +
            '<div class="inb-mail-from">' + (m.from_name || m.from_email || 'Ukendt') + '</div>' +
            '<div class="inb-mail-subject">' + (m.subject || '(intet emne)') + '</div>' +
            '<div class="inb-mail-meta">' +
                '<span>' + (m.from_email || '') + '</span>' +
                '<span>' + (m.received_at || '').substring(0, 16) + '</span>' +
            '</div>' +
            (m.parsed_company ? '<div class="inb-mail-parsed">→ ' + m.parsed_company + '</div>' : '') +
        '</div>'
    ).join('');

    el.querySelectorAll('.inb-mail-row').forEach(row => {
        row.addEventListener('click', () => {
            const id = parseInt(row.dataset.id);
            const mail = _inbMails.find(m => m.id === id);
            if (mail) {
                _inbSelected = mail;
                el.querySelectorAll('.inb-mail-row').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
                _inbRenderPreview(mail);
            }
        });
    });
}

function _inbRenderPreview(mail) {
    const el = document.getElementById('inbPreview');
    if (!el) return;

    el.innerHTML =
        '<div class="inb-preview-header">' +
            '<div class="inb-preview-from">' + (mail.from_name || 'Ukendt') + ' &lt;' + (mail.from_email || '') + '&gt;</div>' +
            '<div class="inb-preview-subject">' + (mail.subject || '(intet emne)') + '</div>' +
            '<div class="inb-preview-date">' + (mail.received_at || '') + ' · ' + (mail.mailbox || '') + '</div>' +
        '</div>' +
        '<div class="inb-preview-body">' + _inbEscape(mail.body_text || '') + '</div>' +
        '<div class="inb-actions">' +
            '<button class="inb-action-btn primary" onclick="_inbShowLinkBon()">Link til Bon</button>' +
            '<button class="inb-action-btn" onclick="_inbShowLinkKunde()">Link til Kunde</button>' +
            '<button class="inb-action-btn danger" onclick="_inbIgnore()">Ignorer</button>' +
        '</div>' +
        '<div id="inbLinkForm"></div>';
}

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

// ─── SSE handler ────────────────────────────────────────────

function _inbHandleSSE(eventType, data) {
    if (!_inbActive) return;
    if (eventType === 'mail_unmatched') {
        _inbLoadData();
    }
}
