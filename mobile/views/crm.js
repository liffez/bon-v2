/**
 * mobile/views/crm.js
 * ════════════════════════════════════════════════════════════
 * CRM mobil: Service calls liste + Kundesøg + Log samtale.
 * ════════════════════════════════════════════════════════════
 */

var _mcContainer = null;
var _mcUser = null;
var _mcTab = 'calls';     // 'calls' | 'search'
var _mcCalls = [];
var _mcSearchTimer = null;
var _mcDays = 7;          // 7 | 14 | 30
var _mcOrdersCache = {};  // customerId -> orders
var _mcPurposes = null;   // cached activity_purposes

var _MC_DUE_CHIPS = [
    { key: '1',  label: 'I morgen' },
    { key: '3',  label: '3 dage' },
    { key: '7',  label: '1 uge' },
    { key: '30', label: '1 mdr' },
];

/* ── Entry ── */
async function initMobileCrm(container, user) {
    _mcContainer = container;
    _mcUser = user;

    container.innerHTML =
        '<div class="m-tabs">' +
            '<button class="m-tab active" data-tab="calls">Service calls</button>' +
            '<button class="m-tab" data-tab="search">Kunder</button>' +
        '</div>' +
        '<div id="mcContent"></div>';

    container.querySelectorAll('.m-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            _mcTab = tab.dataset.tab;
            container.querySelectorAll('.m-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.tab === _mcTab);
            });
            if (_mcTab === 'calls') _mcLoadCalls();
            else _mcShowSearch();
        });
    });

    _mcLoadPurposes(); // non-blocking
    await _mcLoadCalls();
}

async function _mcLoadPurposes() {
    if (_mcPurposes) return _mcPurposes;
    try {
        _mcPurposes = await apiFetch('/activity-purposes');
    } catch (e) {
        _mcPurposes = [];
    }
    return _mcPurposes;
}

function _mcPurposeChipsHtml() {
    if (!_mcPurposes || !_mcPurposes.length) return '';
    var html = '<div class="m-svc-form-label">Formål <span class="m-svc-optional">(valgfri)</span></div>';
    html += '<div class="m-svc-purpose-btns">';
    _mcPurposes.forEach(function(p) {
        html += '<button class="m-svc-purp-btn" data-p="' + p.id + '" title="' + _mcEsc(p.description || p.label) + '">' +
            (p.emoji ? p.emoji + ' ' : '') + _mcEsc(p.label) +
        '</button>';
    });
    html += '</div>';
    return html;
}

function _mcDueChipsHtml() {
    var html = '<div class="m-svc-form-label" data-due-label>Ring igen om</div>';
    html += '<div class="m-svc-due-btns" data-due-row>';
    _MC_DUE_CHIPS.forEach(function(d) {
        html += '<button class="m-svc-due-btn" data-due="' + d.key + '">' + d.label + '</button>';
    });
    html += '</div>';
    return html;
}

function _mcWireToggleGroup(root, selector) {
    root.querySelectorAll(selector).forEach(function(btn) {
        btn.addEventListener('click', function() {
            var wasActive = btn.classList.contains('active');
            root.querySelectorAll(selector).forEach(function(b) { b.classList.remove('active'); });
            if (!wasActive) btn.classList.add('active');
        });
    });
}

function _mcComputeDueAt(daysKey) {
    if (!daysKey) return null;
    var d = new Date();
    d.setDate(d.getDate() + parseInt(daysKey));
    d.setHours(10, 0, 0, 0); // default kl 10
    return d.toISOString();
}

function _mcToggleDueVisibility(root, show) {
    var label = root.querySelector('[data-due-label]');
    var row = root.querySelector('[data-due-row]');
    if (label) label.style.display = show ? '' : 'none';
    if (row) row.style.display = show ? '' : 'none';
    if (!show) {
        // Ryd valg når skjult
        if (row) row.querySelectorAll('.m-svc-due-btn.active').forEach(function(b) { b.classList.remove('active'); });
    }
}

/* ── Service calls ── */
async function _mcLoadCalls() {
    var wrap = document.getElementById('mcContent');
    if (!wrap) return;

    // Render toolbar + placeholder on first call
    if (!wrap.querySelector('#mcCallsList')) {
        wrap.innerHTML =
            '<div class="m-svc-toolbar">' +
                '<label class="m-svc-days-label">Vis:' +
                    '<select id="mcDaysSelect">' +
                        '<option value="7">7 dage</option>' +
                        '<option value="14">14 dage</option>' +
                        '<option value="30">30 dage</option>' +
                    '</select>' +
                '</label>' +
                '<span id="mcSvcCount" class="m-svc-count"></span>' +
            '</div>' +
            '<div id="mcCallsList"><div class="m-loading">Henter service calls...</div></div>';

        var daysSel = document.getElementById('mcDaysSelect');
        daysSel.value = String(_mcDays);
        daysSel.addEventListener('change', function() {
            _mcDays = parseInt(daysSel.value);
            _mcOrdersCache = {};
            _mcLoadCalls();
        });
    }

    var list = document.getElementById('mcCallsList');
    list.innerHTML = '<div class="m-loading">Henter service calls...</div>';

    try {
        _mcCalls = await apiFetch('/crm/service-calls?days=' + _mcDays);
    } catch (e) {
        list.innerHTML = '<div class="m-bon-empty">Kunne ikke hente data</div>';
        return;
    }

    var countEl = document.getElementById('mcSvcCount');
    if (countEl) countEl.textContent = _mcCalls.length ? (_mcCalls.length + ' ventende') : '';

    if (!_mcCalls || !_mcCalls.length) {
        list.innerHTML = '<div class="m-bon-empty">🎉 Alle service calls er håndteret!</div>';
        return;
    }

    var sentEmojiMap = { positive: '😊', neutral: '😐', negative: '😟' };

    var html = '';
    _mcCalls.forEach(function(sc, i) {
        var d = sc.days_since_delivery != null ? sc.days_since_delivery : (sc.days_since || 0);
        var dClass = d <= 3 ? 'd-ok' : d <= 7 ? 'd-warn' : 'd-late';
        var dLabel = d === 0 ? 'I dag' : d === 1 ? '1 dag' : (d + ' dage');

        var levDate = sc.delivery_date ? _mcFormatDate(sc.delivery_date) : '';
        var metaParts = [];
        if (levDate) metaParts.push('Lev. ' + levDate);
        if (sc.total_price) metaParts.push(Math.round(sc.total_price).toLocaleString('da-DK') + ' kr');
        if (sc.pax) metaParts.push(sc.pax + ' pax');
        else if (sc.total_units) metaParts.push(sc.total_units + ' enh.');

        var sentEmoji = sentEmojiMap[sc.last_sentiment] || '';
        var lastNote = sc.last_note ? String(sc.last_note).trim() : '';
        if (lastNote.length > 80) lastNote = lastNote.slice(0, 80) + '…';

        var phone = (sc.customer_phone || '').replace(/\s/g, '');
        var email = sc.customer_email || '';

        html +=
            '<div class="m-crm-item" data-idx="' + i + '">' +
                '<div class="m-svc-top">' +
                    '<span class="m-svc-bon">#' + _mcEsc(sc.bon_number || '') + '</span>' +
                    '<span class="m-svc-days ' + dClass + '">' + dLabel + '</span>' +
                '</div>' +
                '<div class="m-svc-name">' +
                    _mcEsc(sc.customer_name || sc.company_name || '?') +
                    (sc.company_name && sc.customer_name ? ' <span class="m-svc-company">· ' + _mcEsc(sc.company_name) + '</span>' : '') +
                    (sentEmoji ? ' <span class="m-svc-last-sent s-' + sc.last_sentiment + '" title="Seneste stemning">' + sentEmoji + '</span>' : '') +
                '</div>' +
                '<div class="m-svc-meta">' + _mcEsc(metaParts.join(' · ')) + '</div>' +
                (lastNote ? '<div class="m-svc-lastnote">📝 ' + _mcEsc(lastNote) + '</div>' : '') +
                '<div class="m-crm-actions">' +
                    (phone
                        ? '<a class="m-crm-btn primary" href="tel:' + phone + '">📞 Ring</a>'
                        : '<button class="m-crm-btn primary" data-action="log" data-idx="' + i + '">📞 Log</button>') +
                    (phone ? '<a class="m-crm-btn" href="sms:' + phone + '">💬 SMS</a>' : '') +
                    (email ? '<a class="m-crm-btn" href="mailto:' + email + '">✉</a>' : '') +
                    '<button class="m-crm-btn" data-action="expand" data-idx="' + i + '">▼ Ordrer</button>' +
                    '<button class="m-crm-btn" data-action="done" data-idx="' + i + '">✓</button>' +
                '</div>' +
                '<div class="m-svc-orders-slot" id="mcOrders' + i + '"></div>' +
                '<div class="m-crm-form-slot" id="mcForm' + i + '"></div>' +
            '</div>';
    });
    list.innerHTML = html;

    list.querySelectorAll('[data-action="done"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            _mcQuickMarkHandled(parseInt(btn.dataset.idx));
        });
    });
    list.querySelectorAll('[data-action="log"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            _mcShowLogForm(parseInt(btn.dataset.idx));
        });
    });
    list.querySelectorAll('[data-action="expand"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            _mcToggleOrders(parseInt(btn.dataset.idx));
        });
    });
    // Tap the card itself (not on buttons/links) opens the log form
    list.querySelectorAll('.m-crm-item').forEach(function(item) {
        item.addEventListener('click', function(ev) {
            if (ev.target.closest('.m-crm-actions')) return;
            if (ev.target.closest('.m-svc-orders-slot')) return;
            if (ev.target.closest('.m-crm-form-slot')) return;
            _mcShowLogForm(parseInt(item.dataset.idx));
        });
    });
}

async function _mcToggleOrders(idx) {
    var sc = _mcCalls[idx];
    if (!sc) return;
    var slot = document.getElementById('mcOrders' + idx);
    if (!slot) return;
    if (slot.innerHTML) { slot.innerHTML = ''; return; }

    slot.innerHTML = '<div class="m-svc-orders-loading">Henter ordrer...</div>';

    try {
        var orders;
        if (_mcOrdersCache[sc.customer_id]) {
            orders = _mcOrdersCache[sc.customer_id];
        } else {
            orders = await apiFetch('/crm/customer-orders/' + sc.customer_id + '?limit=5');
            _mcOrdersCache[sc.customer_id] = orders;
        }

        if (!orders || !orders.length) {
            slot.innerHTML = '<div class="m-svc-orders-empty">Ingen tidligere ordrer</div>';
            return;
        }

        var html = '<div class="m-svc-orders">';
        orders.forEach(function(o) {
            var price = o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '';
            html += '<div class="m-svc-order">' +
                '<div class="m-svc-order-head">' +
                    '<span class="m-svc-order-bon">#' + (o.bon_number || '') + '</span>' +
                    '<span class="m-svc-order-date">' + _mcFormatDate(o.delivery_date) + '</span>' +
                    (o.pax ? '<span class="m-svc-order-pax">' + o.pax + ' pax</span>' : '') +
                    (price ? '<span class="m-svc-order-price">' + price + '</span>' : '') +
                '</div>';

            if (o.lines && o.lines.length) {
                html += '<div class="m-svc-order-lines">';
                o.lines.forEach(function(l) {
                    html += '<div class="m-svc-order-line">' +
                        '<span class="m-svc-order-qty">' + l.quantity + '×</span> ' +
                        _mcEsc(l.product_name || '') +
                        (l.special_request ? ' <span class="m-svc-order-extra">— ' + _mcEsc(l.special_request) + '</span>' : '') +
                    '</div>';
                });
                html += '</div>';
            }
            html += '</div>';
        });
        html += '</div>';
        slot.innerHTML = html;
    } catch (e) {
        slot.innerHTML = '<div class="m-svc-orders-empty">Fejl ved hentning</div>';
    }
}

function _mcShowLogForm(idx) {
    var sc = _mcCalls[idx];
    if (!sc) return;
    var slot = document.getElementById('mcForm' + idx);
    if (!slot) return;
    if (slot.innerHTML) { slot.innerHTML = ''; return; }

    slot.innerHTML =
        '<div class="m-inline-form m-svc-logform">' +
            '<div class="m-svc-form-label">Resultat</div>' +
            '<div class="m-svc-result-btns">' +
                '<button class="m-svc-btn" data-r="reached" title="Fik fat">✓ Svar</button>' +
                '<button class="m-svc-btn" data-r="no_answer" title="Intet svar">✗ Ikke</button>' +
                '<button class="m-svc-btn" data-r="voicemail" title="Lagde besked">Besked</button>' +
                '<button class="m-svc-btn" data-r="callback" title="Skal ringes tilbage">Ring tb</button>' +
                '<button class="m-svc-btn" data-r="email_instead" title="Sendte mail">✉ Mail</button>' +
            '</div>' +
            _mcDueChipsHtml() +
            _mcPurposeChipsHtml() +
            '<div class="m-svc-form-label">Stemning <span class="m-svc-optional">(valgfri)</span></div>' +
            '<div class="m-svc-sentiment-btns">' +
                '<button class="m-svc-sent-btn" data-s="positive">😊 God</button>' +
                '<button class="m-svc-sent-btn" data-s="neutral">😐 Neutral</button>' +
                '<button class="m-svc-sent-btn" data-s="negative">😟 Dårlig</button>' +
            '</div>' +
            '<textarea id="mcNote' + idx + '" placeholder="Note (valgfri)..."></textarea>' +
            '<div class="m-form-actions">' +
                '<button class="m-crm-btn" data-cancel="' + idx + '">Annuller</button>' +
                '<button class="m-crm-btn primary" data-save="' + idx + '" disabled>Gem</button>' +
            '</div>' +
        '</div>';

    // Due-row skjult indtil callback vælges
    _mcToggleDueVisibility(slot, false);

    // Result button toggle — styrer også due-visibility
    slot.querySelectorAll('[data-r]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            slot.querySelectorAll('[data-r]').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            var saveBtn = slot.querySelector('[data-save]');
            if (saveBtn) saveBtn.disabled = false;
            _mcToggleDueVisibility(slot, btn.dataset.r === 'callback');
        });
    });

    // Toggle groups
    _mcWireToggleGroup(slot, '[data-s]');
    _mcWireToggleGroup(slot, '[data-p]');
    _mcWireToggleGroup(slot, '[data-due]');

    slot.querySelector('[data-cancel="' + idx + '"]').addEventListener('click', function() {
        slot.innerHTML = '';
    });

    slot.querySelector('[data-save="' + idx + '"]').addEventListener('click', async function() {
        var resultBtn = slot.querySelector('[data-r].active');
        if (!resultBtn) return;
        var result = resultBtn.dataset.r;
        var sentBtn = slot.querySelector('[data-s].active');
        var sentiment = sentBtn ? sentBtn.dataset.s : null;
        var purposeBtn = slot.querySelector('[data-p].active');
        var purposeId = purposeBtn ? parseInt(purposeBtn.dataset.p) : null;
        var dueBtn = slot.querySelector('[data-due].active');
        var dueAt = (result === 'callback' && dueBtn) ? _mcComputeDueAt(dueBtn.dataset.due) : null;
        var note = (document.getElementById('mcNote' + idx) || {}).value || '';

        var saveBtn = slot.querySelector('[data-save]');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Gemmer...'; }

        try {
            var body = {
                customer_id: sc.customer_id,
                type: 'service_call',
                result: result,
                text: note || _mcResultLabel(result),
            };
            if (sc.bon_id) body.bon_id = sc.bon_id;
            if (sentiment) body.sentiment = sentiment;
            if (purposeId) body.purpose_id = purposeId;
            if (dueAt) body.due_at = dueAt;

            await apiFetch('/crm/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (window._mToast) window._mToast('Service call logget');
            _mcLoadCalls();
        } catch (e) {
            if (window._mToast) window._mToast('Fejl ved gem');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Gem'; }
        }
    });
}

async function _mcQuickMarkHandled(idx) {
    var sc = _mcCalls[idx];
    if (!sc) return;
    try {
        var body = {
            customer_id: sc.customer_id,
            type: 'service_call',
            result: 'reached',
            text: 'Markeret håndteret (hurtig)',
        };
        if (sc.bon_id) body.bon_id = sc.bon_id;
        await apiFetch('/crm/activity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (window._mToast) window._mToast('Håndteret');
        _mcLoadCalls();
    } catch (e) {
        if (window._mToast) window._mToast('Fejl');
    }
}

function _mcResultLabel(r) {
    var map = {
        reached: 'Fik fat',
        no_answer: 'Intet svar',
        voicemail: 'Lagde besked',
        callback: 'Skal ringes tilbage',
        email_instead: 'Sendte mail i stedet',
    };
    return map[r] || 'Håndteret';
}

function _mcFormatDate(iso) {
    if (!iso) return '';
    var s = String(iso).slice(0, 10);
    var parts = s.split('-');
    if (parts.length !== 3) return s;
    return parseInt(parts[2], 10) + '/' + parseInt(parts[1], 10);
}

/* ── Kundeliste ── */
var _mcAllCustomers = null; // cached full list
var _mcStage = 'all';       // all | vip | active | dormant | lead
var _mcSearchQuery = '';

var _MC_STAGES = [
    { key: 'all',      label: 'Alle' },
    { key: 'callback', label: '📞 Ring tb' },
    { key: 'vip',      label: 'VIP' },
    { key: 'active',   label: 'Aktiv' },
    { key: 'dormant',  label: 'Sovende' },
    { key: 'lead',     label: 'Lead' },
];

function _mcShowSearch() {
    var wrap = document.getElementById('mcContent');
    if (!wrap) return;

    var chipsHtml = _MC_STAGES.map(function(s) {
        return '<button class="m-cust-chip' + (s.key === _mcStage ? ' active' : '') +
            '" data-stage="' + s.key + '">' + s.label + '</button>';
    }).join('');

    wrap.innerHTML =
        '<div class="m-cust-chips">' + chipsHtml + '</div>' +
        '<div class="m-search">' +
            '<input type="search" id="mcSearchInput" placeholder="Søg kunde eller firma..." autocomplete="off">' +
        '</div>' +
        '<div id="mcSearchResults"><div class="m-loading">Henter kunder...</div></div>';

    wrap.querySelectorAll('.m-cust-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
            _mcStage = chip.dataset.stage;
            wrap.querySelectorAll('.m-cust-chip').forEach(function(c) {
                c.classList.toggle('active', c.dataset.stage === _mcStage);
            });
            _mcAllCustomers = null; // re-fetch with new stage
            _mcLoadAllCustomers();
        });
    });

    var input = document.getElementById('mcSearchInput');
    input.value = _mcSearchQuery;

    // Load full customer list on first visit
    _mcLoadAllCustomers();

    input.addEventListener('input', function() {
        clearTimeout(_mcSearchTimer);
        _mcSearchQuery = input.value.trim();
        _mcSearchTimer = setTimeout(function() {
            _mcRenderCustomerList(_mcAllCustomers || []);
        }, 150);
    });
}

async function _mcLoadAllCustomers() {
    if (_mcAllCustomers) {
        _mcRenderCustomerList(_mcAllCustomers);
        return;
    }
    try {
        if (_mcStage === 'callback') {
            var resp = await apiFetch('/crm/callbacks');
            _mcAllCustomers = (resp.callbacks || []).map(function(cb) {
                return {
                    id: cb.customer_id,
                    name: cb.customer_name,
                    company_name: cb.company_name,
                    phone: cb.customer_phone,
                    callback_note: cb.text,
                    callback_at: cb.created_at,
                    callback_bon: cb.bon_number,
                };
            });
        } else {
            var qs = '?limit=2000';
            if (_mcStage && _mcStage !== 'all') qs += '&stage=' + encodeURIComponent(_mcStage);
            var data = await apiFetch('/crm/customers' + qs);
            _mcAllCustomers = Array.isArray(data) ? data : (data.customers || []);
            // Sort alphabetically by display name
            _mcAllCustomers.sort(function(a, b) {
                var na = (a.name || a.company_name || '').trim();
                var nb = (b.name || b.company_name || '').trim();
                return na.localeCompare(nb, 'da');
            });
        }
        _mcRenderCustomerList(_mcAllCustomers);
    } catch (e) {
        var results = document.getElementById('mcSearchResults');
        if (results) results.innerHTML = '<div class="m-bon-empty">Kunne ikke hente kunder</div>';
    }
}

function _mcFilterCustomers(customers, query) {
    if (!query) return customers;
    var q = query.toLowerCase();
    return customers.filter(function(c) {
        var haystack = [
            c.name || '', c.company_name || '',
            c.email || '', c.phone || ''
        ].join(' ').toLowerCase();
        return haystack.indexOf(q) !== -1;
    });
}

function _mcRenderCustomerList(customers) {
    var results = document.getElementById('mcSearchResults');
    if (!results) return;

    var filtered = _mcFilterCustomers(customers, _mcSearchQuery);

    if (!filtered.length) {
        results.innerHTML = '<div class="m-bon-empty">' +
            (_mcSearchQuery ? 'Ingen match' : 'Ingen kunder') +
        '</div>';
        return;
    }

    var html = '<div class="m-cust-count">' + filtered.length + ' kunder</div>';
    filtered.forEach(function(c) {
        var cName = (c.name || '').trim() || c.company_name || '(uden navn)';
        var cId = c.id;
        var stage = c.stage || null;
        var stageLabel = _mcStageLabel(stage);

        var metaParts = [];

        if (c.callback_at) {
            // Callback-visning: vis note + tid siden callback blev registreret
            var cbNote = c.callback_note ? String(c.callback_note).trim() : '';
            if (cbNote.length > 60) cbNote = cbNote.slice(0, 60) + '…';
            var cbLabel = '<span class="m-cust-ico" title="Ring tilbage">📞</span>' +
                (cbNote || 'Callback') +
                ' · <span style="color:var(--color-text-dim)">' + _mcTimeAgo(c.callback_at) + '</span>';
            metaParts.push(cbLabel);
        } else {
            // Last order
            if (c.last_order_date) {
                metaParts.push('<span class="m-cust-ico" title="Sidste ordre">&#128230;</span>' + _mcFormatDate(c.last_order_date));
            }
            // Total orders
            if (c.total_orders) {
                metaParts.push(c.total_orders + ' &times;');
            }
            // Last contact
            if (c.last_contact_at) {
                metaParts.push('<span class="m-cust-ico" title="Sidste samtale">&#128172;</span>' + _mcTimeAgo(c.last_contact_at));
            }
        }

        html +=
            '<div class="m-cust-item" data-cid="' + cId + '">' +
                (stage ? '<span class="m-cust-dot st-' + stage + '" title="' + stageLabel + '"></span>' : '<span class="m-cust-dot st-none"></span>') +
                '<div class="m-cust-info">' +
                    '<div class="m-cust-name">' + _mcEsc(cName) +
                        (c.company_name && c.name ? ' <span class="m-cust-company">' + _mcEsc(c.company_name) + '</span>' : '') +
                    '</div>' +
                    (metaParts.length ? '<div class="m-cust-meta">' + metaParts.join(' · ') + '</div>' : '') +
                '</div>' +
                '<span class="m-mig-chevron">&#8250;</span>' +
            '</div>';
    });
    results.innerHTML = html;

    results.querySelectorAll('.m-cust-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mcShowCustomer(parseInt(el.dataset.cid));
        });
    });
}

function _mcStageLabel(s) {
    switch (s) {
        case 'vip': return 'VIP';
        case 'active': return 'Aktiv';
        case 'dormant': return 'Sovende';
        case 'lead': return 'Lead';
        case 'lost': return 'Mistet';
        default: return '';
    }
}

function _mcTimeAgo(iso) {
    if (!iso) return '';
    var then = new Date(iso.replace(' ', 'T'));
    var now = new Date();
    var diffDays = Math.floor((now - then) / 86400000);
    if (diffDays < 1) return 'i dag';
    if (diffDays === 1) return 'i går';
    if (diffDays < 30) return diffDays + ' d';
    var months = Math.floor(diffDays / 30);
    if (months < 12) return months + ' mdr';
    var years = Math.floor(diffDays / 365);
    return years + ' år';
}

async function _mcShowCustomer(customerId) {
    var wrap = document.getElementById('mcContent');
    if (!wrap) return;
    wrap.innerHTML = '<div class="m-loading">Henter kunde...</div>';

    try {
        var results = await Promise.all([
            apiFetch('/crm/customer/' + customerId),
            apiFetch('/crm/customer-orders/' + customerId + '?limit=5').catch(function() { return []; })
        ]);
        var resp = results[0];
        var ordersWithLines = results[1] || [];

        var cust = resp.customer || resp;
        var stats = resp.stats || {};
        var products = resp.products || [];

        var name = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.name || '(uden navn)';
        var stage = cust.stage;
        var stageLabel = _mcStageLabel(stage);

        // Header card
        var html = '<div class="m-card" style="margin-top:8px">';
        html += '<div class="m-cust-head">';
        if (stage) html += '<span class="m-cust-dot st-' + stage + '" title="' + stageLabel + '"></span>';
        html += '<div style="flex:1;min-width:0">';
        html += '<div class="m-cust-detail-name">' + _mcEsc(name) + '</div>';
        if (cust.company_name) html += '<div class="m-cust-detail-company">' + _mcEsc(cust.company_name) + '</div>';
        html += '</div></div>';

        if (cust.phone) html += '<div style="margin-top:8px"><a href="tel:' + cust.phone + '" style="color:var(--brand-primary)">&#128222; ' + _mcEsc(cust.phone) + '</a></div>';
        if (cust.email) html += '<div style="margin-top:4px"><a href="mailto:' + cust.email + '" style="color:var(--brand-primary)">&#9993; ' + _mcEsc(cust.email) + '</a></div>';
        html += '</div>';

        // Stats strip
        if (stats.total_orders) {
            var daysSince = stats.last_order
                ? Math.max(0, Math.floor((new Date() - new Date(stats.last_order)) / 86400000))
                : null;
            html += '<div class="m-cust-stats">';
            html += '<div class="m-cust-stat"><div class="m-cust-stat-num">' + stats.total_orders + '</div><div class="m-cust-stat-lbl">ordrer</div></div>';
            html += '<div class="m-cust-stat"><div class="m-cust-stat-num">' + Math.round((stats.total_revenue || 0) / 1000) + 'k</div><div class="m-cust-stat-lbl">omsætn.</div></div>';
            html += '<div class="m-cust-stat"><div class="m-cust-stat-num">' + Math.round(stats.avg_order || 0).toLocaleString('da-DK') + '</div><div class="m-cust-stat-lbl">gns. kr</div></div>';
            if (daysSince != null) {
                var dsLabel = daysSince < 1 ? 'i dag' : daysSince === 1 ? '1 dag' : daysSince < 30 ? (daysSince + ' d') : (Math.floor(daysSince / 30) + ' mdr');
                html += '<div class="m-cust-stat"><div class="m-cust-stat-num">' + dsLabel + '</div><div class="m-cust-stat-lbl">sidst</div></div>';
            }
            html += '</div>';
        }

        // Typiske produkter
        if (products && products.length) {
            html += '<div class="m-detail-section" style="margin-top:8px">';
            html += '<div class="m-detail-label">Typiske produkter</div>';
            html += '<div class="m-cust-prods">';
            products.slice(0, 6).forEach(function(p) {
                html += '<span class="m-cust-prod">' +
                    _mcEsc(p.product_name || '') +
                    ' <span class="m-cust-prod-qty">' + (p.total_qty || 0) + '×</span>' +
                '</span>';
            });
            html += '</div></div>';
        }

        // Seneste ordrer med vareliste
        if (ordersWithLines && ordersWithLines.length) {
            html += '<div class="m-detail-section" style="margin-top:8px">';
            html += '<div class="m-detail-label">Seneste ordrer</div>';
            ordersWithLines.forEach(function(o) {
                var price = o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '';
                var lines = (o.lines || []).slice(0, 4);
                var moreCount = (o.lines || []).length - lines.length;

                html += '<div class="m-svc-order" data-id="' + o.id + '" style="cursor:pointer">' +
                    '<div class="m-svc-order-head">' +
                        '<span class="m-svc-order-bon">#' + _mcEsc(o.bon_number || '') + '</span>' +
                        '<span class="m-svc-order-date">' + _mcFormatDate(o.delivery_date) + '</span>' +
                        (o.pax ? '<span class="m-svc-order-pax">' + o.pax + ' pax</span>' : '') +
                        (price ? '<span class="m-svc-order-price">' + price + '</span>' : '') +
                    '</div>';

                if (lines.length) {
                    html += '<div class="m-svc-order-lines">';
                    lines.forEach(function(l) {
                        html += '<div class="m-svc-order-line">' +
                            '<span class="m-svc-order-qty">' + l.quantity + '×</span> ' +
                            _mcEsc(l.product_name || '') +
                        '</div>';
                    });
                    if (moreCount > 0) {
                        html += '<div class="m-svc-order-line" style="opacity:.7">… + ' + moreCount + ' flere</div>';
                    }
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }

        // Log samtale
        html += '<div class="m-card" id="mcLogCard" style="margin-top:8px">';
        html += '<div class="m-detail-label">Log samtale</div>';
        html += '<div class="m-inline-form" style="margin-top:8px">';
        html += '<select id="mcLogType">';
        html += '<option value="call">Opkald</option>';
        html += '<option value="note">Note</option>';
        html += '<option value="meeting">Møde</option>';
        html += '</select>';
        // Resultat (kun synlig ved Opkald)
        html += '<div data-result-wrap>';
        html += '<div class="m-svc-form-label">Resultat</div>';
        html += '<div class="m-svc-result-btns">';
        html += '<button class="m-svc-btn" data-r="reached" title="Fik fat">✓ Svar</button>';
        html += '<button class="m-svc-btn" data-r="no_answer" title="Intet svar">✗ Ikke</button>';
        html += '<button class="m-svc-btn" data-r="voicemail" title="Lagde besked">Besked</button>';
        html += '<button class="m-svc-btn" data-r="callback" title="Skal ringes tilbage">Ring tb</button>';
        html += '<button class="m-svc-btn" data-r="email_instead" title="Sendte mail">✉ Mail</button>';
        html += '</div>';
        html += _mcDueChipsHtml();
        html += '</div>';
        // Formål
        html += _mcPurposeChipsHtml();
        html += '<textarea id="mcLogNote" placeholder="Hvad handlede det om?"></textarea>';
        html += '<div class="m-svc-form-label">Stemning <span class="m-svc-optional">(valgfri)</span></div>';
        html += '<div class="m-svc-sentiment-btns" id="mcProfileSent">';
        html += '<button class="m-svc-sent-btn" data-s="positive">😊 God</button>';
        html += '<button class="m-svc-sent-btn" data-s="neutral">😐 Neutral</button>';
        html += '<button class="m-svc-sent-btn" data-s="negative">😟 Dårlig</button>';
        html += '</div>';
        html += '<div class="m-form-actions">';
        html += '<button class="m-crm-btn" id="mcLogBack">&#8249; Tilbage</button>';
        html += '<button class="m-crm-btn primary" id="mcLogSave">Gem</button>';
        html += '</div></div></div>';

        wrap.innerHTML = html;

        var logCard = document.getElementById('mcLogCard');
        var resultWrap = logCard.querySelector('[data-result-wrap]');

        // Vis/skjul resultat-sektion afhængigt af type
        var typeSel = document.getElementById('mcLogType');
        function _mcUpdateLogType() {
            var isCall = typeSel.value === 'call';
            if (resultWrap) resultWrap.style.display = isCall ? '' : 'none';
            if (!isCall) {
                resultWrap.querySelectorAll('.m-svc-btn.active').forEach(function(b) { b.classList.remove('active'); });
                _mcToggleDueVisibility(logCard, false);
            }
        }
        typeSel.addEventListener('change', _mcUpdateLogType);
        _mcUpdateLogType();

        // Due chips skjulte indtil callback valgt
        _mcToggleDueVisibility(logCard, false);

        // Result toggle + due visibility
        resultWrap.querySelectorAll('[data-r]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                resultWrap.querySelectorAll('[data-r]').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                _mcToggleDueVisibility(logCard, btn.dataset.r === 'callback');
            });
        });

        _mcWireToggleGroup(logCard, '[data-s]');
        _mcWireToggleGroup(logCard, '[data-p]');
        _mcWireToggleGroup(logCard, '[data-due]');

        // Back
        document.getElementById('mcLogBack').addEventListener('click', function() {
            _mcShowSearch();
        });

        // Save
        document.getElementById('mcLogSave').addEventListener('click', async function() {
            var type = typeSel.value;
            var note = document.getElementById('mcLogNote').value.trim();
            if (!note) { if (window._mToast) window._mToast('Skriv en note'); return; }

            var sentBtn = logCard.querySelector('[data-s].active');
            var sentiment = sentBtn ? sentBtn.dataset.s : null;
            var purposeBtn = logCard.querySelector('[data-p].active');
            var purposeId = purposeBtn ? parseInt(purposeBtn.dataset.p) : null;
            var resultBtn = (type === 'call') ? logCard.querySelector('[data-r].active') : null;
            var result = resultBtn ? resultBtn.dataset.r : null;
            var dueBtn = (result === 'callback') ? logCard.querySelector('[data-due].active') : null;
            var dueAt = dueBtn ? _mcComputeDueAt(dueBtn.dataset.due) : null;

            try {
                var body = {
                    customer_id: customerId,
                    type: type,
                    text: note,
                };
                if (sentiment) body.sentiment = sentiment;
                if (purposeId) body.purpose_id = purposeId;
                if (result) body.result = result;
                if (dueAt) body.due_at = dueAt;

                await apiFetch('/crm/activity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (window._mToast) window._mToast('Samtale logget');
                document.getElementById('mcLogNote').value = '';
                logCard.querySelectorAll('.m-svc-btn.active, .m-svc-sent-btn.active, .m-svc-purp-btn.active, .m-svc-due-btn.active').forEach(function(b) {
                    b.classList.remove('active');
                });
                _mcToggleDueVisibility(logCard, false);
            } catch (e) {
                if (window._mToast) window._mToast('Fejl ved gem');
            }
        });

        // Bon clicks in customer detail
        wrap.querySelectorAll('.m-svc-order[data-id]').forEach(function(el) {
            el.addEventListener('click', function() {
                window._mSwitchView('bons');
                setTimeout(function() {
                    if (typeof _mbShowDetail === 'function') _mbShowDetail(parseInt(el.dataset.id));
                }, 100);
            });
        });

    } catch (e) {
        wrap.innerHTML = '<div class="m-bon-empty">Kunne ikke hente kunde</div>';
    }
}

function _mcEsc(str) {
    if (str === null || str === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}
