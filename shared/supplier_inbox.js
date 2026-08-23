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
var _siSelected = null;   // thread object (m. kind: 'po'|'supplier')
var _siMessages = [];     // messages for selected thread
var _siUnreadFilter = false;
var _siKindFilter = 'all'; // 'all' | 'po' | 'supplier'

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

        '.si-msgs { flex: 1; overflow-y: auto;' +
        '  padding: 16px 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); margin: 8px 0; }' +

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

        '.si-new-btn { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700;' +
        '  padding:5px 14px; border-radius:14px; background: var(--brand-primary, #8e631f); color:#fff;' +
        '  border:1.5px solid var(--brand-primary); cursor:pointer; font-family:inherit; }' +
        '.si-new-btn:hover { opacity: 0.88; }' +

        '.si-modal-overlay { position:fixed; inset:0; background: rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; z-index:9000; }' +
        '.si-modal { background:#fff; border-radius:14px; padding:24px; width: 92%; max-width:560px; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.25); }' +
        '.si-modal h3 { font-family: var(--font-heading, Georgia, serif); margin:0 0 14px; color: var(--brand-primary); font-size:18px; }' +
        '.si-modal label { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color: var(--color-text-dim); margin-bottom:4px; }' +
        '.si-modal input, .si-modal select, .si-modal textarea { width:100%; padding:9px 12px; border:1.5px solid var(--color-border, #d7d1ca); border-radius:8px;' +
        '  font-size:14px; font-family:inherit; background:#fff; color: var(--color-text); box-sizing:border-box; outline:none; }' +
        '.si-modal input:focus, .si-modal select:focus, .si-modal textarea:focus { border-color: var(--brand-primary); }' +
        '.si-modal textarea { min-height:120px; resize:vertical; }' +
        '.si-modal-row { margin-bottom:12px; }' +
        '.si-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }' +
        '.si-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:12px;' +
        '  background: var(--brand-primary-light, #f1e6b2); color: var(--brand-primary, #8e631f); font-size:11px;' +
        '  font-weight:700; cursor:pointer; border:1px solid transparent; transition: all .12s; }' +
        '.si-chip:hover { background:#e8d8b8; border-color: var(--brand-primary); }' +
        '.si-chip-hint { font-size:11px; color: var(--color-text-dim); margin-top:4px; font-style:italic; }' +
        '.si-modal-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }' +
        '.si-modal-cancel { padding:9px 18px; border-radius:8px; background:#fff; border:1.5px solid var(--color-border); font-weight:600; cursor:pointer; font-family:inherit; }' +
        '.si-modal-send { padding:9px 22px; border-radius:8px; background: var(--brand-primary); color:#fff; border:none; font-weight:700; cursor:pointer; font-family:inherit; }' +
        '.si-modal-send:disabled { opacity:0.55; cursor:not-allowed; }' +
        '</style>' +

        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;padding:0 4px;flex-wrap:wrap">' +
            '<button class="si-filter-btn' + (!_siUnreadFilter ? ' active' : '') + '" onclick="_siSetFilter(false)">Alle</button>' +
            '<button class="si-filter-btn' + (_siUnreadFilter ? ' active' : '') + '" onclick="_siSetFilter(true)">Kun ulæste</button>' +
            '<span style="width:1px;height:18px;background:var(--color-border,#d7d1ca);margin:0 4px"></span>' +
            '<button class="si-filter-btn' + (_siKindFilter === 'all' ? ' active' : '') + '" onclick="_siSetKind(\'all\')">Alle typer</button>' +
            '<button class="si-filter-btn' + (_siKindFilter === 'po' ? ' active' : '') + '" onclick="_siSetKind(\'po\')">📦 Bestillinger</button>' +
            '<button class="si-filter-btn' + (_siKindFilter === 'supplier' ? ' active' : '') + '" onclick="_siSetKind(\'supplier\')">' + mailIcon(12) + ' Generel</button>' +
            '<span style="margin-left:auto"></span>' +
            '<button class="si-new-btn" onclick="_siOpenNewMailModal()">' + mailIcon(13) + ' Ny mail</button>' +
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

function _siSetKind(kind) {
    _siKindFilter = kind;
    _siRenderShell();
    _siLoadData();
}

async function _siLoadData() {
    if (!_siActive) return;
    try {
        var poList = [];
        var supList = [];
        if (_siKindFilter === 'all' || _siKindFilter === 'po') {
            poList = await fetchOrderMailThreads({ unread_only: _siUnreadFilter }) || [];
            poList = poList.map(function(t) { return Object.assign({ kind: 'po' }, t); });
        }
        if (_siKindFilter === 'all' || _siKindFilter === 'supplier') {
            var supRes = await fetchSupplierMailOverview(_siUnreadFilter);
            var arr = (supRes && supRes.threads) || [];
            supList = arr.map(function(t) { return Object.assign({ kind: 'supplier' }, t); });
        }
        _siThreads = poList.concat(supList);
        _siThreads.sort(function(a, b) {
            var da = a.thread_updated_at || a.updated_at || a.last_at || '';
            var db = b.thread_updated_at || b.updated_at || b.last_at || '';
            return db.localeCompare(da);
        });
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
        var isSelected = _siSelected && _siThreadKey(_siSelected) === _siThreadKey(t);
        var dateStr = _siFmtDate(t.thread_updated_at || t.updated_at || t.last_at || t.sent_at);
        var subjectLine, snippet, prefixIcon;
        if (t.kind === 'supplier') {
            subjectLine = (t.subject || 'Generel kommunikation');
            snippet = t.last_body || '';
            prefixIcon = mailIcon(12) + ' ';
        } else {
            subjectLine = 'Bestilling #PO' + t.purchase_order_id + (t.line_count ? ' · ' + t.line_count + ' varer' : '');
            snippet = t.latest_snippet || '';
            prefixIcon = '📦 ';
        }

        html += '<div class="si-thread-row' + (isSelected ? ' selected' : '') + '" tabindex="0"' +
            ' onclick="_siSelectThread(' + i + ')">';
        html += '<div class="si-thread-top">';
        html += '<span class="si-thread-supplier">' + _siEsc(t.supplier_name || 'Ukendt') + '</span>';
        html += '<span class="si-thread-date">' + dateStr + '</span>';
        html += '</div>';
        html += '<div class="si-thread-subject">' + prefixIcon + _siEsc(subjectLine) + '</div>';
        html += '<div class="si-thread-meta">';
        if (t.kind === 'po' && t.expected_delivery_date) {
            html += '<span>Lev. ' + _siFmtDate(t.expected_delivery_date) + '</span>';
        }
        var msgCount = t.message_count || t.msg_count || 0;
        html += '<span>' + msgCount + ' besked' + (msgCount !== 1 ? 'er' : '') + '</span>';
        if (t.unread_count > 0) html += '<span class="si-unread-badge">' + t.unread_count + ' ulæst' + (t.unread_count !== 1 ? 'e' : '') + '</span>';
        html += '</div>';
        if (snippet) {
            html += '<div class="si-thread-snippet">' + _siEsc(snippet) + '</div>';
        }
        html += '</div>';
    }

    listEl.innerHTML = html;
}

function _siThreadKey(t) {
    return (t.kind || 'po') + ':' + (t.kind === 'supplier' ? t.supplier_id : t.purchase_order_id);
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
        var data;
        if (t.kind === 'supplier') {
            data = await fetchSupplierMail(t.supplier_id);
        } else {
            data = await fetchOrderMailThread(t.purchase_order_id);
        }
        _siMessages = data.messages || [];

        // Mark as read
        if (_siMessages.some(function(m) { return m.direction === 'in' && !m.is_read; })) {
            if (t.kind === 'supplier') {
                await markSupplierMailRead(t.supplier_id);
            } else {
                await markOrderMailRead(t.purchase_order_id);
            }
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
    if (t.kind === 'supplier') {
        html += mailIcon(13) + ' Generel kommunikation';
        if (t.subject) html += ' · ' + _siEsc(t.subject);
    } else {
        html += '📦 Bestilling #PO' + t.purchase_order_id;
        if (t.line_count) html += ' · ' + t.line_count + ' varer';
        if (t.expected_delivery_date) html += ' · Levering: ' + _siFmtDate(t.expected_delivery_date);
        if (t.po_status) html += ' · Status: ' + t.po_status;
    }
    html += '</div>';
    html += '<div class="si-preview-link"><a href="/kitchen/purchasing.html" target="_blank">Gå til indkøb →</a></div>';
    html += '</div>';

    // Messages — fælles MailThread-komponent (fyldes efter innerHTML)
    html += '<div class="si-msgs" id="siMsgHost"></div>';

    // Reply
    html += '<div class="si-reply">';
    html += '<textarea class="si-reply-input" id="siReplyInput" placeholder="Skriv svar til ' + _siEsc(t.supplier_name || 'leverandør') + '..."></textarea>';
    html += '<button class="si-reply-btn" id="siReplyBtn" onclick="_siSendReply()">Send</button>';
    html += '</div>';
    html += '<div id="siReplySigHint" style="padding:0 14px 10px"></div>';

    previewEl.innerHTML = html;

    MailThread.renderHistory(previewEl.querySelector('#siMsgHost'), {
        messages: messages,
        emptyText: 'Ingen beskeder i tråden',
    });
    MailThread.renderSignatureHint(previewEl.querySelector('#siReplySigHint'));
}

async function _siSendReply() {
    if (!_siSelected) return;
    var input = document.getElementById('siReplyInput');
    var btn = document.getElementById('siReplyBtn');
    if (!input || !input.value.trim()) return;

    btn.disabled = true;
    btn.textContent = 'Sender...';

    try {
        if (_siSelected.kind === 'supplier') {
            // Reply genbruger eksisterende emne for at holde tråden
            var subject = _siSelected.subject || ('Til ' + (_siSelected.supplier_name || 'leverandør'));
            await sendSupplierMail(_siSelected.supplier_id, {
                subject: subject,
                body: input.value.trim(),
                to: _siSelected.supplier_email || ''
            });
        } else {
            await sendOrderReply(_siSelected.purchase_order_id, input.value.trim());
        }
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
        var d = parseServerDate(iso);
        if (!d) return iso.slice(0, 10);
        var day = d.getDate();
        var months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
        return day + '. ' + months[d.getMonth()];
    } catch (e) { return iso.slice(0, 10); }
}

function _siFmtDateTime(iso) {
    if (!iso) return '';
    try {
        var d = parseServerDate(iso);
        if (!d) return iso.slice(0, 16);
        var day = d.getDate();
        var months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
        var hrs = String(d.getHours()).padStart(2, '0');
        var min = String(d.getMinutes()).padStart(2, '0');
        return day + '. ' + months[d.getMonth()] + ' ' + hrs + ':' + min;
    } catch (e) { return iso.slice(0, 16); }
}

/* ── Ny mail-modal ──────────────────────────────────────── */

var _siSuppliersCache = null;
var _siSelectedSupplierId = null;

async function _siOpenNewMailModal() {
    // Hent leverandører hvis ikke cached
    if (!_siSuppliersCache) {
        try {
            var raw = await fetchPurchasingSuppliers();
            // De-dup på supplier_id (samme leverandør kan figurere flere gange pga grocy_locations)
            var seen = {};
            _siSuppliersCache = [];
            for (var i = 0; i < raw.length; i++) {
                var sid = raw[i].supplier_id;
                if (!sid || seen[sid]) continue;
                seen[sid] = 1;
                _siSuppliersCache.push({
                    id: sid,
                    name: raw[i].supplier_name,
                    email: raw[i].contact_email,
                    notes: raw[i].supplier_notes
                });
            }
            _siSuppliersCache.sort(function(a, b) { return (a.name || '').localeCompare(b.name || '', 'da'); });
        } catch (e) {
            alert('Kunne ikke hente leverandører: ' + e.message);
            return;
        }
    }
    _siSelectedSupplierId = null;
    _siRenderNewMailModal();
}

function _siRenderNewMailModal() {
    var existing = document.getElementById('siNewMailOverlay');
    if (existing) existing.remove();

    var supOpts = '<option value="">— Vælg leverandør —</option>';
    for (var i = 0; i < _siSuppliersCache.length; i++) {
        var s = _siSuppliersCache[i];
        supOpts += '<option value="' + s.id + '"' + (s.id === _siSelectedSupplierId ? ' selected' : '') + '>' + _siEsc(s.name) + '</option>';
    }

    var selSup = _siSuppliersCache.find(function(s) { return s.id === _siSelectedSupplierId; });
    var defaultTo = (selSup && selSup.email) || '';
    var contacts = selSup ? parseEmailsFromNotes(selSup.notes) : [];
    // Filter contacts der allerede er i defaultTo
    contacts = contacts.filter(function(c) { return c.email !== (defaultTo || '').toLowerCase(); });

    var chipsHtml = '';
    if (contacts.length > 0) {
        chipsHtml = '<div class="si-chips">';
        for (var k = 0; k < contacts.length; k++) {
            chipsHtml += '<span class="si-chip" onclick="_siPickContact(\'' + _siEsc(contacts[k].email) + '\')" title="' + _siEsc(contacts[k].email) + '">' +
                _siEsc(contacts[k].label) + '</span>';
        }
        chipsHtml += '</div>';
        chipsHtml += '<div class="si-chip-hint">Klik en kontakt for at indsætte. Adresser er fundet i leverandørens noter.</div>';
    }

    var hint = '';
    if (selSup && !defaultTo && contacts.length === 0) {
        hint = '<div class="si-chip-hint">Tip: Tilføj en standard-email på leverandøren under Settings → Indkøb → Leverandører.</div>';
    }

    var html = '<div class="si-modal-overlay" id="siNewMailOverlay">' +
        '<div class="si-modal">' +
            '<h3>' + mailIcon(16) + ' Ny mail til leverandør</h3>' +

            '<div class="si-modal-row">' +
                '<label>Leverandør</label>' +
                '<select id="siNewMailSupplier" onchange="_siNewMailSupplierChange()">' + supOpts + '</select>' +
            '</div>' +

            '<div class="si-modal-row">' +
                '<label>Til (email)</label>' +
                '<input type="email" id="siNewMailTo" value="' + _siEsc(defaultTo) + '" placeholder="modtager@firma.dk">' +
                chipsHtml +
                hint +
            '</div>' +

            '<div class="si-modal-row">' +
                '<label>Emne</label>' +
                '<input type="text" id="siNewMailSubject" placeholder="Fx \'Forespørgsel om aftalepris\'">' +
            '</div>' +

            '<div class="si-modal-row">' +
                '<label>Besked</label>' +
                '<textarea id="siNewMailBody" placeholder="Skriv besked..."></textarea>' +
                '<div id="siNewMailSigHint"></div>' +
            '</div>' +

            '<div class="si-modal-actions">' +
                '<button class="si-modal-cancel" onclick="_siCloseNewMailModal()">Annuller</button>' +
                '<button class="si-modal-send" id="siNewMailSendBtn" onclick="_siSendNewMail()"' + (selSup ? '' : ' disabled') + '>Send</button>' +
            '</div>' +
        '</div>' +
    '</div>';

    document.body.insertAdjacentHTML('beforeend', html);
    closeOnOutsideClick(document.getElementById('siNewMailOverlay'), _siCloseNewMailModal);
    MailThread.renderSignatureHint(document.getElementById('siNewMailSigHint'));
    setTimeout(function() {
        var subEl = document.getElementById('siNewMailSubject');
        if (subEl && selSup) subEl.focus();
        else {
            var supEl = document.getElementById('siNewMailSupplier');
            if (supEl) supEl.focus();
        }
    }, 100);
}

function _siNewMailSupplierChange() {
    var sel = document.getElementById('siNewMailSupplier');
    _siSelectedSupplierId = sel ? parseInt(sel.value) || null : null;
    _siRenderNewMailModal();
}

function _siPickContact(email) {
    var inp = document.getElementById('siNewMailTo');
    if (inp) {
        inp.value = email;
        inp.focus();
    }
}

function _siCloseNewMailModal() {
    var overlay = document.getElementById('siNewMailOverlay');
    if (overlay) overlay.remove();
    _siSelectedSupplierId = null;
}

async function _siSendNewMail() {
    var sup = _siSuppliersCache.find(function(s) { return s.id === _siSelectedSupplierId; });
    if (!sup) { alert('Vælg en leverandør'); return; }
    var to      = document.getElementById('siNewMailTo').value.trim();
    var subject = document.getElementById('siNewMailSubject').value.trim();
    var body    = document.getElementById('siNewMailBody').value.trim();
    if (!to)      { alert('Modtager-email er påkrævet'); return; }
    if (!subject) { alert('Skriv et emne først'); return; }
    if (!body)    { alert('Skriv en besked først'); return; }

    var btn = document.getElementById('siNewMailSendBtn');
    btn.disabled = true;
    btn.textContent = 'Sender...';

    try {
        var res = await sendSupplierMail(sup.id, { subject: subject, body: body, to: to });
        _siCloseNewMailModal();
        await _siLoadData();
        // Auto-select den nye tråd
        for (var i = 0; i < _siThreads.length; i++) {
            if (_siThreads[i].kind === 'supplier' && _siThreads[i].supplier_id === sup.id && _siThreads[i].thread_id === res.thread_id) {
                _siSelectThread(i);
                break;
            }
        }
    } catch (err) {
        alert('Fejl: ' + (err.message || 'Kunne ikke sende'));
        btn.disabled = false;
        btn.textContent = 'Send';
    }
}

// SSE handler for office index
function _siHandleSSE(eventType, data) {
    if (!_siActive) return;
    if (eventType === 'po_mail_received' || eventType === 'po_mail_sent' ||
        eventType === 'supplier_mail_received' || eventType === 'supplier_mail_sent') {
        _siLoadData();
    }
}
