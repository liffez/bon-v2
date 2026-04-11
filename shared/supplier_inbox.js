/**
 * shared/supplier_inbox.js
 * ════════════════════════════════════════════════════════════
 * Leverandørpost — Office sidebar view.
 * Viser PO-tråde med mail: liste + tråd-preview + svar.
 * ════════════════════════════════════════════════════════════
 */

var _siContainer = null;
var _siOpts = {};
var _siActive = false;
var _siThreads = [];
var _siSelected = null;   // thread object
var _siMessages = [];     // messages for selected thread
var _siUnreadFilter = false;

function initSupplierInbox(containerEl, opts) {
    _siContainer = containerEl;
    _siOpts = opts || {};
    _siActive = true;
    _siRenderShell();
    _siLoadData();
    // SSE handled by office/index.html via _siHandleSSE()
}

function cleanupSupplierInbox() {
    _siActive = false;
    _siContainer = null;
    _siThreads = [];
    _siSelected = null;
    _siMessages = [];
}

function _siEsc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function _siRenderShell() {
    var topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Leverandørpost';

    _siContainer.innerHTML =
        '<style>' +
        '.si-layout { display: grid; grid-template-columns: 380px 1fr; gap: 12px; height: 100%; }' +
        '@media (max-width: 800px) { .si-layout { grid-template-columns: 1fr; } }' +

        '.si-list-panel { background: var(--color-surface, #fff); border-radius: 10px;' +
        '  box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow-y: auto; }' +
        '.si-list-header { padding: 14px 16px; border-bottom: 1px solid var(--color-border, #eee);' +
        '  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;' +
        '  color: var(--color-text-dim, #888); display: flex; justify-content: space-between; align-items: center; }' +
        '.si-count { background: var(--brand-primary); color: white; padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 700; }' +

        '.si-thread-row { padding: 12px 16px; border-bottom: 1px solid var(--color-border, #eee);' +
        '  cursor: pointer; transition: background .1s; outline: none; }' +
        '.si-thread-row:hover { background: var(--color-background, #f5f4f2); }' +
        '.si-thread-row.selected { background: var(--brand-primary-light, #f1e6b2); }' +
        '.si-thread-row:focus { box-shadow: inset 0 0 0 2px var(--brand-primary, #8e631f); }' +
        '.si-thread-top { display: flex; justify-content: space-between; align-items: center; }' +
        '.si-thread-supplier { font-size: 14px; font-weight: 600; }' +
        '.si-thread-date { font-size: 11px; color: var(--color-text-dim); }' +
        '.si-thread-subject { font-size: 13px; color: var(--color-text); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
        '.si-thread-meta { font-size: 11px; color: var(--color-text-dim); margin-top: 4px; display: flex; gap: 8px; align-items: center; }' +
        '.si-thread-snippet { font-size: 12px; color: var(--color-text-dim); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }' +
        '.si-unread-badge { background: #e53e3e; color: #fff; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 8px; }' +

        '.si-preview-panel { background: var(--color-surface, #fff); border-radius: 10px;' +
        '  box-shadow: 0 1px 4px rgba(0,0,0,0.07); padding: 24px; overflow-y: auto; display: flex; flex-direction: column; }' +
        '.si-preview-header { margin-bottom: 16px; }' +
        '.si-preview-supplier { font-family: var(--font-heading, Georgia, serif); font-size: 17px; font-weight: 700; }' +
        '.si-preview-details { font-size: 13px; color: var(--color-text-dim); margin-top: 6px; }' +
        '.si-preview-link { font-size: 13px; margin-top: 8px; }' +
        '.si-preview-link a { color: var(--brand-primary); font-weight: 600; text-decoration: none; }' +
        '.si-preview-link a:hover { text-decoration: underline; }' +

        '.si-msgs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;' +
        '  padding: 16px 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); margin: 8px 0; }' +
        '.si-msg { padding: 10px 14px; border-radius: 10px; font-size: 13px; max-width: 85%; }' +
        '.si-msg.out { background: #edf5ff; align-self: flex-end; border: 1px solid #c3dafe; }' +
        '.si-msg.in { background: #fff; align-self: flex-start; border: 1px solid var(--color-border-light, #e8e4e0); }' +
        '.si-msg-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 11px; }' +
        '.si-msg-dir { font-weight: 600; color: var(--color-text-dim); }' +
        '.si-msg-time { color: var(--color-text-dim); }' +
        '.si-msg-new { background: #e53e3e; color: #fff; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 6px; }' +
        '.si-msg-text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }' +

        '.si-reply { display: flex; gap: 8px; align-items: flex-end; }' +
        '.si-reply-input { flex: 1; min-height: 50px; max-height: 120px; resize: vertical;' +
        '  padding: 10px 12px; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px;' +
        '  font-family: inherit; font-size: 13px; }' +
        '.si-reply-input:focus { border-color: var(--brand-primary); outline: none; }' +
        '.si-reply-btn { padding: 8px 18px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer;' +
        '  background: var(--brand-primary, #8e631f); color: #fff; border: none; font-family: inherit; }' +
        '.si-reply-btn:hover { opacity: 0.85; }' +
        '.si-reply-btn:disabled { opacity: 0.4; cursor: not-allowed; }' +

        '.si-empty { text-align: center; padding: 40px; color: var(--color-text-dim); font-size: 14px; }' +
        '.si-filter-btn { font-size: 12px; padding: 4px 12px; border: 1.5px solid var(--color-border, #d7d1ca); border-radius: 14px;' +
        '  background: var(--color-surface, #fff); cursor: pointer; color: var(--color-text-dim); font-family: inherit; }' +
        '.si-filter-btn:hover { border-color: var(--brand-primary); }' +
        '.si-filter-btn.active { background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary); }' +
        '</style>' +

        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;padding:0 4px">' +
            '<button class="si-filter-btn' + (!_siUnreadFilter ? ' active' : '') + '" onclick="_siSetFilter(false)">Alle</button>' +
            '<button class="si-filter-btn' + (_siUnreadFilter ? ' active' : '') + '" onclick="_siSetFilter(true)">Kun ulæste</button>' +
        '</div>' +
        '<div class="si-layout">' +
            '<div class="si-list-panel">' +
                '<div class="si-list-header">' +
                    '<span>Leverandørpost</span>' +
                    '<span class="si-count" id="siCount">0</span>' +
                '</div>' +
                '<div id="siList"></div>' +
            '</div>' +
            '<div class="si-preview-panel" id="siPreview">' +
                '<div class="si-empty">Vælg en tråd fra listen</div>' +
            '</div>' +
        '</div>';
}

function _siSetFilter(unreadOnly) {
    _siUnreadFilter = unreadOnly;
    _siRenderShell();
    _siLoadData();
}

async function _siLoadData() {
    if (!_siActive) return;
    try {
        _siThreads = await fetchOrderMailThreads({ unread_only: _siUnreadFilter }) || [];
        _siRenderList();
        var countEl = document.getElementById('siCount');
        if (countEl) countEl.textContent = _siThreads.length;

        // Update sidebar badge
        var totalUnread = 0;
        for (var i = 0; i < _siThreads.length; i++) totalUnread += (_siThreads[i].unread_count || 0);
        _siUpdateBadge(totalUnread);
    } catch (err) {
        console.error('[supplier-inbox] Load error:', err);
    }
}

function _siRenderList() {
    var listEl = document.getElementById('siList');
    if (!listEl) return;

    if (!_siThreads.length) {
        listEl.innerHTML = '<div class="si-empty">' + (_siUnreadFilter ? 'Ingen ulæste tråde' : 'Ingen leverandørpost endnu') + '</div>';
        return;
    }

    var html = '';
    for (var i = 0; i < _siThreads.length; i++) {
        var t = _siThreads[i];
        var isSelected = _siSelected && _siSelected.purchase_order_id === t.purchase_order_id;
        var dateStr = _siFmtDate(t.thread_updated_at || t.sent_at);
        var delivStr = t.expected_delivery_date ? 'Lev. ' + _siFmtDate(t.expected_delivery_date) : '';

        html += '<div class="si-thread-row' + (isSelected ? ' selected' : '') + '" tabindex="0"' +
            ' data-po-id="' + t.purchase_order_id + '" onclick="_siSelectThread(' + i + ')">';
        html += '<div class="si-thread-top">';
        html += '<span class="si-thread-supplier">' + _siEsc(t.supplier_name || 'Ukendt') + '</span>';
        html += '<span class="si-thread-date">' + dateStr + '</span>';
        html += '</div>';
        html += '<div class="si-thread-subject">Bestilling #PO' + t.purchase_order_id + (t.line_count ? ' · ' + t.line_count + ' varer' : '') + '</div>';
        html += '<div class="si-thread-meta">';
        if (delivStr) html += '<span>' + delivStr + '</span>';
        html += '<span>' + (t.message_count || 0) + ' besked' + ((t.message_count || 0) !== 1 ? 'er' : '') + '</span>';
        if (t.unread_count > 0) html += '<span class="si-unread-badge">' + t.unread_count + ' ulæst' + (t.unread_count !== 1 ? 'e' : '') + '</span>';
        html += '</div>';
        if (t.latest_snippet) {
            html += '<div class="si-thread-snippet">' + _siEsc(t.latest_snippet) + '</div>';
        }
        html += '</div>';
    }

    listEl.innerHTML = html;
}

function _siSelectThread(idx) {
    var t = _siThreads[idx];
    if (!t) return;
    _siSelected = t;
    _siRenderList(); // Update selection
    _siLoadThread(t);
}

async function _siLoadThread(t) {
    var previewEl = document.getElementById('siPreview');
    if (!previewEl) return;

    previewEl.innerHTML = '<div class="si-empty">Indlæser...</div>';

    try {
        var data = await fetchOrderMailThread(t.purchase_order_id);
        _siMessages = data.messages || [];

        // Mark as read
        if (_siMessages.some(function(m) { return m.direction === 'in' && !m.is_read; })) {
            await markOrderMailRead(t.purchase_order_id);
            // Update local count
            t.unread_count = 0;
            _siRenderList();
            // Update sidebar badge
            var totalUnread = 0;
            for (var i = 0; i < _siThreads.length; i++) totalUnread += (_siThreads[i].unread_count || 0);
            _siUpdateBadge(totalUnread);
        }

        _siRenderPreview(t, _siMessages);
    } catch (err) {
        previewEl.innerHTML = '<div class="si-empty">Fejl: ' + _siEsc(err.message) + '</div>';
    }
}

function _siRenderPreview(t, messages) {
    var previewEl = document.getElementById('siPreview');
    if (!previewEl) return;

    var html = '<div class="si-preview-header">';
    html += '<div class="si-preview-supplier">' + _siEsc(t.supplier_name || 'Ukendt') + '</div>';
    html += '<div class="si-preview-details">';
    html += 'Bestilling #PO' + t.purchase_order_id;
    if (t.line_count) html += ' · ' + t.line_count + ' varer';
    if (t.expected_delivery_date) html += ' · Levering: ' + _siFmtDate(t.expected_delivery_date);
    if (t.po_status) html += ' · Status: ' + t.po_status;
    html += '</div>';
    html += '<div class="si-preview-link"><a href="/kitchen/purchasing.html" target="_blank">Gå til bestilling →</a></div>';
    html += '</div>';

    // Messages
    html += '<div class="si-msgs">';
    if (!messages.length) {
        html += '<div class="si-empty">Ingen beskeder i tråden</div>';
    } else {
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            var isOut = m.direction === 'out';
            var time = m.sent_at || m.received_at || m.created_at;
            html += '<div class="si-msg ' + (isOut ? 'out' : 'in') + '">';
            html += '<div class="si-msg-meta">';
            html += '<span class="si-msg-dir">' + (isOut ? '→ Du (kontakt@)' : '← ' + _siEsc(m.from_name || m.from_email || 'Leverandør')) + '</span>';
            html += '<span class="si-msg-time">' + _siFmtDateTime(time) + '</span>';
            if (!isOut && !m.is_read) html += '<span class="si-msg-new">Ny</span>';
            html += '</div>';
            html += '<div class="si-msg-text">' + _siEsc(m.body_text || '').replace(/\n/g, '<br>') + '</div>';
            html += '</div>';
        }
    }
    html += '</div>';

    // Reply
    html += '<div class="si-reply">';
    html += '<textarea class="si-reply-input" id="siReplyInput" placeholder="Skriv svar til ' + _siEsc(t.supplier_name || 'leverandør') + '..."></textarea>';
    html += '<button class="si-reply-btn" id="siReplyBtn" onclick="_siSendReply()">Send</button>';
    html += '</div>';

    previewEl.innerHTML = html;
}

async function _siSendReply() {
    if (!_siSelected) return;
    var input = document.getElementById('siReplyInput');
    var btn = document.getElementById('siReplyBtn');
    if (!input || !input.value.trim()) return;

    btn.disabled = true;
    btn.textContent = 'Sender...';

    try {
        await sendOrderReply(_siSelected.purchase_order_id, input.value.trim());
        // Reload thread
        _siLoadThread(_siSelected);
    } catch (err) {
        alert('Fejl: ' + (err.message || 'Kunne ikke sende'));
        btn.disabled = false;
        btn.textContent = 'Send';
    }
}

function _siUpdateBadge(count) {
    var badge = document.querySelector('.sidebar-link[data-view="leverandorpost"] .sidebar-badge');
    if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }
}

// ── Formatters ────────────────────────────────────────────

function _siFmtDate(iso) {
    if (!iso) return '';
    try {
        var d = new Date(iso);
        var day = d.getDate();
        var months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
        return day + '. ' + months[d.getMonth()];
    } catch (e) { return iso.slice(0, 10); }
}

function _siFmtDateTime(iso) {
    if (!iso) return '';
    try {
        var d = new Date(iso);
        var day = d.getDate();
        var months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
        var hrs = String(d.getHours()).padStart(2, '0');
        var min = String(d.getMinutes()).padStart(2, '0');
        return day + '. ' + months[d.getMonth()] + ' ' + hrs + ':' + min;
    } catch (e) { return iso.slice(0, 16); }
}

// SSE handler for office index
function _siHandleSSE(eventType, data) {
    if (!_siActive) return;
    if (eventType === 'po_mail_received' || eventType === 'po_mail_sent') {
        _siLoadData();
    }
}
