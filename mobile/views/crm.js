/**
 * mobile/views/crm.js
 * ════════════════════════════════════════════════════════════
 * CRM mobil: Service calls liste + Kundesøg + Log samtale.
 * ════════════════════════════════════════════════════════════
 */

var _mcContainer = null;
var _mcUser = null;
var _mcTab = 'calls';     // 'calls' | 'search' | 'inbox'
var _mcCalls = [];
var _mcSearchTimer = null;
var _mcDays = 7;          // 7 | 14 | 30
var _mcPurposes = null;   // cached activity_purposes

// ── Indbakke (mail_threads) ──
var _mcInboxView = 'aabne';   // aabne | udsat | kunde | luk
var _mcThreads = [];
var _mcSheetId = null;

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
        _mcInboxStyle() +
        '<div class="m-tabs">' +
            '<button class="m-tab active" data-tab="calls">Service calls</button>' +
            '<button class="m-tab" data-tab="search">Kunder</button>' +
            '<button class="m-tab" data-tab="inbox">Indbakke<span class="m-tab-badge" id="mcInboxBadge" style="display:none"></span></button>' +
        '</div>' +
        '<div id="mcContent"></div>';

    container.querySelectorAll('.m-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            _mcTab = tab.dataset.tab;
            container.querySelectorAll('.m-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.tab === _mcTab);
            });
            if (_mcTab === 'calls') _mcLoadCalls();
            else if (_mcTab === 'inbox') _mcLoadInbox();
            else _mcShowSearch();
        });
    });

    _mcLoadPurposes();  // non-blocking
    _mcLoadInboxCount(); // non-blocking — badge på Indbakke-fanen
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
                '</div>' +
                '<div class="m-svc-meta">' + _mcEsc(metaParts.join(' · ')) + '</div>' +
                // Stemning · aktiviteter · afstand — samme linje som office' service-kald
                // og ringeliste (shared/crm_contact_context.js).
                (window.CrmContactContext ? CrmContactContext.lineHtml(sc) : '') +
                (lastNote ? '<div class="m-svc-lastnote">📝 ' + _mcEsc(lastNote) + '</div>' : '') +
                '<div class="m-crm-actions">' +
                    (phone
                        ? '<a class="m-crm-btn primary" href="tel:' + phone + '">📞 Ring</a>'
                        : '<button class="m-crm-btn primary" data-action="log" data-idx="' + i + '">📞 Log</button>') +
                    (phone ? '<a class="m-crm-btn" href="sms:' + phone + '">💬 SMS</a>' : '') +
                    (email ? '<a class="m-crm-btn" href="mailto:' + email + '">' + mailIcon(15) + '</a>' : '') +
                    '<button class="m-crm-btn" data-action="expand" data-idx="' + i + '">▼ Historik</button>' +
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

// Aktiviteter (egne + kollegers) over ordrerne — samme udfoldning som i office.
function _mcToggleOrders(idx) {
    var sc = _mcCalls[idx];
    if (!sc) return;
    var slot = document.getElementById('mcOrders' + idx);
    if (!slot || !window.CrmContactContext) return;
    CrmContactContext.toggleHistory(slot, sc.customer_id);
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
                '<button class="m-svc-btn" data-r="email_instead" title="Sendte mail">' + mailIcon(12) + ' Mail</button>' +
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
            // Sortér efter aktivitet (som office: flest ordrer/omsætning øverst), så
            // den kunde der faktisk har historik ligger over evt. tomme dublet-rækker.
            // Tie-break: nyeste kontakt, derefter navn.
            _mcAllCustomers.sort(function(a, b) {
                var oa = a.total_orders || 0, ob = b.total_orders || 0;
                if (ob !== oa) return ob - oa;
                var ra = a.total_revenue || 0, rb = b.total_revenue || 0;
                if (rb !== ra) return rb - ra;
                var ca = String(a.last_contact_at || ''), cb = String(b.last_contact_at || '');
                if (cb !== ca) return cb.localeCompare(ca);
                return _mcNormName(a.name || a.company_name).localeCompare(_mcNormName(b.name || b.company_name), 'da');
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
        var cName = _mcNormName(c.name) || _mcNormName(c.company_name) || '(uden navn)';
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
            // Total orders — vist eksplicit så dublet-rækker (0 ordrer) er nemme
            // at skelne fra den rigtige kunde med historik.
            if (c.total_orders) {
                metaParts.push('<span class="m-cust-ico" title="Antal ordrer">&#128722;</span>' + c.total_orders);
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
                        (c.company_name && c.name ? ' <span class="m-cust-company">' + _mcEsc(_mcNormName(c.company_name)) + '</span>' : '') +
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
    // last_contact_at / callback (created_at) er UTC — parseServerDate undgår
    // dag-skift nær midnat.
    var then = (typeof parseServerDate === 'function') ? parseServerDate(iso) : new Date(iso.replace(' ', 'T') + 'Z');
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
        var activities = resp.activities || [];

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

        // Historik (NY)
        html += _mcRenderHistorik(activities);

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
                // Ens linjer slås sammen — se shared/bon_lines.js.
                var merged = BonLines.mergeLines(o.lines || []);
                var lines = merged.slice(0, 4);
                var moreCount = merged.length - lines.length;

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
        html += '<button class="m-svc-btn" data-r="email_instead" title="Sendte mail">' + mailIcon(12) + ' Mail</button>';
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

        _mcWireHistorik(wrap);

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
                _mcShowCustomer(customerId);
                window.scrollTo({ top: 0, behavior: 'smooth' });
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

// Normalisér navn: kollaps whitespace (nogle importerede rækker har \n i alle
// felter, så dublet-navne ellers ser forskellige ud og sorteres usammenhængende).
function _mcNormName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Historik (timeline) ── */
function _mcInitials(name) {
    if (!name) return '';
    var parts = String(name).trim().split(/\s+/);
    var first = parts[0] && parts[0][0] ? parts[0][0] : '';
    var second = parts[1] && parts[1][0] ? parts[1][0] : '';
    return (first + second).toUpperCase();
}

var _MC_TYPE_LABEL = {
    call:         { ico: '📞', label: 'Opkald' },
    service_call: { ico: '📞', label: 'Service call' },
    note:         { ico: '📝', label: 'Note' },
    meeting:      { ico: '📅', label: 'Møde' },
    task:         { ico: '✓',  label: 'Opgave' },
    followup:     { ico: '🔔', label: 'Opfølgning' },
    email_in:     { ico: mailIcon(14), label: 'Mail ind' },
    email_out:    { ico: '📨', label: 'Mail ud' },
    offer_sent:   { ico: '🤝', label: 'Tilbud sendt' },
};
var _MC_RESULT_LABEL = {
    reached:        'Svar',
    no_answer:      'Ikke fat',
    busy:           'Optaget',
    voicemail:      'Besked',
    callback:       'Ring tb',
    email_instead:  'Mail i stedet',
};
var _MC_SENT_EMOJI = { positive: '😊', neutral: '😐', negative: '😟' };

function _mcTimelineTime(iso) {
    if (!iso) return '';
    var s = String(iso);
    // a.created_at er UTC (CURRENT_TIMESTAMP) — parseServerDate tilføjer 'Z'
    // så klokkeslættet ikke vises 1-2 timer forskudt.
    var then = (typeof parseServerDate === 'function') ? parseServerDate(s) : new Date((s.indexOf('T') === -1 ? s.replace(' ', 'T') : s) + 'Z');
    if (isNaN(then.getTime())) return '';
    var now = new Date();
    var diffMs = now - then;
    var diffDays = Math.floor(diffMs / 86400000);
    var hh = String(then.getHours()).padStart(2, '0');
    var mm = String(then.getMinutes()).padStart(2, '0');
    if (diffDays < 1 && now.getDate() === then.getDate()) return 'i dag ' + hh + ':' + mm;
    var yest = new Date(now); yest.setDate(yest.getDate() - 1);
    if (then.getDate() === yest.getDate() && then.getMonth() === yest.getMonth() && then.getFullYear() === yest.getFullYear()) {
        return 'i går ' + hh + ':' + mm;
    }
    if (diffDays < 30) return diffDays + ' d';
    var months = Math.floor(diffDays / 30);
    if (months < 12) return months + ' mdr';
    return Math.floor(diffDays / 365) + ' år';
}

function _mcDueLabel(dueAt) {
    if (!dueAt) return null;
    var d = new Date(String(dueAt).replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var overdue = d < now;
    var dStr = d.getDate() + '/' + (d.getMonth() + 1);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var clk = (hh === '00' && mm === '00') ? '' : ' kl ' + hh + (mm === '00' ? '' : ':' + mm);
    return { text: 'Ring tb ' + dStr + clk, overdue: overdue };
}

function _mcRenderHistorik(activities) {
    var html = '<div class="m-card" style="margin-top:8px">';
    html += '<div class="m-timeline-head"><div class="m-detail-label" style="margin-bottom:0">Historik</div></div>';

    if (!activities || !activities.length) {
        html += '<div class="m-tl-empty">Ingen aktiviteter endnu</div>';
        html += '</div>';
        return html;
    }

    html += '<div class="m-timeline">';
    activities.forEach(function(a, i) {
        var def = _MC_TYPE_LABEL[a.type] || { ico: '•', label: a.type || '' };
        var typeClass = 't-' + (a.type || '');
        var isCallType = a.type === 'call' || a.type === 'service_call';
        var resultPill = (isCallType && a.result && _MC_RESULT_LABEL[a.result])
            ? '<span class="m-tl-result-pill r-' + a.result + '">' + _mcEsc(_MC_RESULT_LABEL[a.result]) + '</span>'
            : '';
        var purposeChip = (a.purpose_label)
            ? '<span class="m-tl-purpose">' + (a.purpose_emoji ? a.purpose_emoji + ' ' : '') + _mcEsc(a.purpose_label) + '</span>'
            : '';
        var time = _mcTimelineTime(a.created_at);
        var due = (!a.done_at) ? _mcDueLabel(a.due_at) : null;
        var dueHtml = due ? '<span class="m-tl-due' + (due.overdue ? ' overdue' : '') + '">' + _mcEsc(due.text) + '</span>' : '';
        var sent = (a.sentiment && _MC_SENT_EMOJI[a.sentiment])
            ? '<span class="m-tl-sent" title="' + a.sentiment + '">' + _MC_SENT_EMOJI[a.sentiment] + '</span>'
            : '';
        var bonHtml = (a.bon_id && a.bon_number)
            ? '<a class="m-tl-bon-link" data-bon-id="' + a.bon_id + '">#' + _mcEsc(a.bon_number) + '</a>'
            : '';
        var ownerName = a.owner_name || a.user_name;
        var initials = _mcInitials(ownerName);
        var userHtml = initials ? '<span class="m-tl-user" title="' + _mcEsc(ownerName) + '">' + initials + '</span>' : '';
        var extraCls = (i >= 3) ? ' is-extra' : '';

        html +=
            '<div class="m-tl-item' + extraCls + '">' +
                '<div class="m-tl-icon ' + typeClass + '">' + def.ico + '</div>' +
                '<div class="m-tl-head">' +
                    '<span class="m-tl-type">' + _mcEsc(def.label) + '</span>' +
                    resultPill +
                    purposeChip +
                    (time ? '<span class="m-tl-time">' + _mcEsc(time) + '</span>' : '') +
                '</div>' +
                (a.text ? '<div class="m-tl-text" data-expand>' + _mcEsc(a.text) + '</div>' : '') +
                ((dueHtml || sent || bonHtml || userHtml)
                    ? '<div class="m-tl-meta">' + dueHtml + sent + bonHtml + userHtml + '</div>'
                    : '') +
            '</div>';
    });

    if (activities.length > 3) {
        html += '<button class="m-tl-show-more">Vis alle ' + activities.length + ' aktiviteter ▾</button>';
    }
    html += '</div></div>';
    return html;
}

function _mcWireHistorik(wrap) {
    var timeline = wrap.querySelector('.m-timeline');
    if (!timeline) return;

    timeline.querySelectorAll('.m-tl-text[data-expand]').forEach(function(el) {
        el.addEventListener('click', function() {
            el.classList.toggle('expanded');
        });
    });

    timeline.querySelectorAll('.m-tl-bon-link[data-bon-id]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var id = parseInt(el.dataset.bonId);
            if (!id) return;
            window._mSwitchView('bons');
            setTimeout(function() {
                if (typeof _mbShowDetail === 'function') _mbShowDetail(id);
            }, 100);
        });
    });

    var showMoreBtn = timeline.querySelector('.m-tl-show-more');
    if (showMoreBtn) {
        showMoreBtn.addEventListener('click', function() {
            timeline.classList.add('show-all');
            showMoreBtn.style.display = 'none';
        });
    }
}

/* ════════════════ INDBAKKE (mail_threads) ════════════════ */
// CLAUDE_INDBAKKE.md §6. Afløser mailto:-bouncet — svar lever nu i appen.

var _mcInboxCounts = {};
var _MC_INBOX_TABS = [
    { k: 'aabne', label: 'Åbne' }, { k: 'udsat', label: '⏰ Udsat' },
    { k: 'kunde', label: 'Afventer' }, { k: 'luk', label: 'Afsluttet' }
];

function _mcInboxStyle() {
    return '<style>' +
    '.mc-subtabs{display:flex;gap:6px;padding:8px 10px;overflow-x:auto;border-bottom:1px solid var(--color-border,#eee)}' +
    '.mc-sub{font-size:12px;font-weight:700;padding:5px 12px;border-radius:99px;background:var(--color-background,#f5f4f2);color:#6b6258;white-space:nowrap;border:none;font-family:inherit}' +
    '.mc-sub.on{background:var(--brand-primary,#8e631f);color:#fff}' +
    '.mc-sub .b{background:rgba(0,0,0,.15);border-radius:99px;padding:0 5px;margin-left:4px;font-size:10px}' +
    '.mc-sub.on .b{background:rgba(255,255,255,.25)}' +
    '.mc-th{background:#fff;margin:8px 10px;border-radius:12px;padding:11px 13px;box-shadow:0 1px 3px rgba(0,0,0,.06)}' +
    '.mc-th-from{font-weight:800;font-size:14px;color:#2c2620;display:flex;align-items:center;gap:6px}' +
    '.mc-th.unread .mc-th-from::before{content:"";width:8px;height:8px;border-radius:50%;background:#e8a832;display:inline-block;flex-shrink:0}' +
    '.mc-th-subj{font-size:12.5px;color:#5a544c;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mc-th-sent{font-size:10.5px;color:#5a7a36;margin-top:4px}' +
    '.mc-th-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:7px}' +
    '.mc-tag{font-size:10px;font-weight:700;padding:1px 7px;border-radius:99px}' +
    '.mc-tag.bon{background:#e8f0f6;color:#3d5e80}.mc-tag.kontakt{background:#f7f2d9;color:#8a6a1a}' +
    '.mc-tag.lnk{background:#f5f4f2;color:#6b6258}.mc-tag.warn{background:#fef3d6;color:#9a6a10}' +
    '.mc-st{font-size:10px;font-weight:900;padding:1px 8px;border-radius:99px;text-transform:uppercase}' +
    '.mc-st.aaben{background:#fef3d6;color:#9a6a10}.mc-st.afventer_kunde{background:#e8f0f6;color:#3d5e80}.mc-st.afsluttet{background:#e8f2dc;color:#5a7a36}' +
    '.mc-snz{font-size:10px;font-weight:700;padding:1px 7px;border-radius:99px;background:#f3e8f7;color:#7a3d96}' +
    '.mc-sheet-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:flex-end}' +
    '.mc-sheet{background:#fff;width:100%;max-height:85vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0)}' +
    '.mc-sheet-head{padding:12px 14px;border-bottom:1px solid var(--color-border,#eee)}' +
    '.mc-sheet-subj{font-weight:800;font-size:14px;color:#2c2620}' +
    '.mc-sheet-body{flex:1;overflow-y:auto;padding:10px 14px;background:#fbf9f5}' +
    '.mc-sheet-foot{padding:10px 12px;border-top:1px solid var(--color-border,#eee)}' +
    '.mc-sheet-foot textarea{width:100%;border:1px solid var(--color-border,#ddd);border-radius:10px;padding:9px;font-family:inherit;font-size:13px;min-height:60px;resize:vertical}' +
    '.mc-sheet-btns{display:flex;gap:6px;margin-top:8px}' +
    '.mc-sbtn{flex:1;border:1px solid var(--color-border,#ddd);background:#fff;border-radius:10px;padding:10px;font-size:13px;font-weight:700;font-family:inherit;color:#2c2620}' +
    '.mc-sbtn.ok{background:#7a9c54;color:#fff;border-color:#7a9c54}.mc-sbtn.snz{background:#9b59b6;color:#fff;border-color:#9b59b6}.mc-sbtn.primary{background:var(--brand-primary,#8e631f);color:#fff;border-color:var(--brand-primary,#8e631f)}' +
    '.mc-inbox-empty{text-align:center;padding:40px 16px;color:#8a8580}' +
    '</style>';
}

function _mcLoadInboxCount() {
    if (typeof fetchMailThreadCounts !== 'function') return;
    fetchMailThreadCounts().then(function(c) {
        _mcInboxCounts = c || {};
        var b = document.getElementById('mcInboxBadge');
        if (b) {
            if (c && c.aabne > 0) { b.textContent = c.aabne; b.style.display = ''; }
            else b.style.display = 'none';
        }
        if (_mcTab === 'inbox') _mcRenderInboxSubtabs();
    }).catch(function() {});
}

async function _mcLoadInbox() {
    var content = document.getElementById('mcContent');
    if (!content) return;
    content.innerHTML = '<div id="mcSubtabs" class="mc-subtabs"></div><div id="mcInboxList"></div>';
    _mcRenderInboxSubtabs();
    var list = document.getElementById('mcInboxList');
    list.innerHTML = '<div class="mc-inbox-empty">Henter…</div>';
    try {
        _mcThreads = await fetchMailThreads({ status: _mcInboxView });
        _mcRenderInboxList();
    } catch (e) {
        list.innerHTML = '<div class="mc-inbox-empty">Kunne ikke hente indbakke</div>';
    }
    _mcLoadInboxCount();
}

function _mcRenderInboxSubtabs() {
    var el = document.getElementById('mcSubtabs');
    if (!el) return;
    el.innerHTML = _MC_INBOX_TABS.map(function(t) {
        var c = _mcInboxCounts[t.k];
        return '<button class="mc-sub ' + (_mcInboxView === t.k ? 'on' : '') + '" onclick="_mcSetInboxView(\'' + t.k + '\')">' +
            t.label + (c ? ' <span class="b">' + c + '</span>' : '') + '</button>';
    }).join('');
}

function _mcSetInboxView(v) { _mcInboxView = v; _mcLoadInbox(); }

function _mcThTime(iso) {
    return (window.MailThread && MailThread.fmtDate) ? MailThread.fmtDate(iso) : _mcFormatDate(iso);
}

// Link-chip med tag-nummer: kunde → "🔗 Navn · #k-3857"
function _mcLinkChip(link) {
    if (!link) return '<span class="mc-tag warn">⚠ ikke knyttet</span>';
    var num = link.type === 'customer' ? ' · #k-' + link.id : '';
    return '<span class="mc-tag lnk">🔗 ' + _mcEsc(link.label || '') + num + '</span>';
}

function _mcRenderInboxList() {
    var list = document.getElementById('mcInboxList');
    if (!list) return;
    if (!_mcThreads.length) { list.innerHTML = '<div class="mc-inbox-empty">🎉 Intet her</div>'; return; }
    var ST = { aaben: 'Åben', afventer_kunde: 'Afventer', afsluttet: 'Afsluttet' };
    list.innerHTML = _mcThreads.map(function(t) {
        var sent = (t.handling_status !== 'aaben' && t.last_outbound_at)
            ? '<div class="mc-th-sent">↗ Sendt ' + _mcThTime(t.last_outbound_at) + '</div>' : '';
        var linkTag = _mcLinkChip(t.link);
        var snz = (t.snoozed && t.snooze_until) ? '<span class="mc-snz">⏰ ' + _mcThTime(t.snooze_until) + '</span>' : '';
        return '<div class="mc-th ' + (t.has_unread ? 'unread' : '') + '" onclick="_mcOpenInboxThread(' + t.id + ')">' +
            '<div class="mc-th-from">' + _mcEsc(t.from || '') + '</div>' +
            '<div class="mc-th-subj">' + _mcEsc(t.subject || '') + '</div>' + sent +
            '<div class="mc-th-meta"><span class="mc-tag ' + t.src + '">' + t.src + '@</span>' + linkTag +
            '<span class="mc-st ' + t.handling_status + '">' + (ST[t.handling_status] || '') + '</span>' + snz + '</div>' +
        '</div>';
    }).join('');
}

// Sheet'et lægges på document.body (root stacking-context) så det kommer OVER den
// faste bundnav (.m-nav, z-index 50) — ikke fanget i CRM-containerens stacking-context.
function _mcSheetRoot() {
    var r = document.getElementById('mcSheetRoot');
    if (!r) { r = document.createElement('div'); r.id = 'mcSheetRoot'; document.body.appendChild(r); }
    return r;
}

async function _mcOpenInboxThread(id) {
    _mcSheetId = id;
    var host = _mcSheetRoot();
    host.innerHTML = '<div class="mc-sheet-ov"><div class="mc-sheet"><div class="mc-sheet-head"><div class="mc-sheet-subj">Henter…</div></div><div class="mc-sheet-body"></div></div></div>';
    try {
        var data = await fetchMailThread(id);
        var t = data.thread;
        var ST = { aaben: 'Åben', afventer_kunde: 'Afventer', afsluttet: 'Afsluttet' };
        host.innerHTML = '<div class="mc-sheet-ov">' +
            '<div class="mc-sheet">' +
                '<div class="mc-sheet-head">' +
                    '<div class="mc-sheet-subj">' + _mcEsc(t.subject || '') + '</div>' +
                    '<div style="font-size:11px;color:#8a8580;margin-top:3px">' + _mcEsc(t.from || '') + ((t.link && t.link.type === 'customer') ? ' · #k-' + t.link.id : '') + ' · <span class="mc-st ' + t.handling_status + '">' + (ST[t.handling_status] || '') + '</span></div>' +
                '</div>' +
                '<div class="mc-sheet-body" id="mcSheetBody"></div>' +
                '<div class="mc-sheet-foot">' +
                    '<textarea id="mcReplyText" placeholder="Hurtigsvar…"></textarea>' +
                    '<div class="mc-sheet-btns">' +
                        '<button class="mc-sbtn ok" onclick="_mcInboxDone(' + id + ')">✓ Afslut</button>' +
                        '<button class="mc-sbtn snz" onclick="_mcInboxSnooze(' + id + ',3)">⏰ Udsæt</button>' +
                        '<button class="mc-sbtn primary" onclick="_mcInboxReply(' + id + ')">Send</button>' +
                    '</div>' +
                    '<button class="mc-sbtn" style="width:100%;margin-top:6px" onclick="_mcCloseSheet()">Luk</button>' +
                '</div>' +
            '</div></div>';
        closeOnOutsideClick(host.querySelector('.mc-sheet-ov'), _mcCloseSheet);
        var body = document.getElementById('mcSheetBody');
        if (body && window.MailThread && MailThread.renderHistory) {
            MailThread.renderHistory(body, { messages: (data.messages || []).map(function(m) { return Object.assign({}, m, { created_at: m.at, is_read: true }); }) });
        } else if (body) {
            body.textContent = (data.messages || []).map(function(m) { return m.body_text; }).join('\n\n———\n\n');
        }
        _mcLoadInboxCount();
    } catch (e) {
        _mcCloseSheet();
        alert('Kunne ikke åbne tråd: ' + e.message);
    }
}

function _mcCloseSheet() {
    _mcSheetId = null;
    var host = document.getElementById('mcSheetRoot');
    if (host) host.innerHTML = '';
}

async function _mcInboxDone(id) {
    try { await patchMailThread(id, { handling_status: 'afsluttet' }); _mcCloseSheet(); _mcLoadInbox(); }
    catch (e) { alert('Fejl: ' + e.message); }
}

async function _mcInboxSnooze(id, days) {
    try { await patchMailThread(id, { snooze_days: days }); _mcCloseSheet(); _mcLoadInbox(); }
    catch (e) { alert('Fejl: ' + e.message); }
}

async function _mcInboxReply(id) {
    var ta = document.getElementById('mcReplyText');
    var body = ta ? ta.value.trim() : '';
    if (!body) { alert('Skriv et svar først'); return; }
    try { await replyMailThread(id, { body: body, remind_days: 3 }); _mcCloseSheet(); _mcLoadInbox(); }
    catch (e) { alert('Kunne ikke sende: ' + e.message); }
}

/* ── SSE: indbakke live-opdatering ── */
function _mcrmHandleSSE(eventName, data) {
    if (eventName === 'mail_thread_updated' || eventName === 'mail_received' || eventName === 'mail_read') {
        _mcLoadInboxCount();
        if (_mcTab === 'inbox' && !_mcSheetId) _mcLoadInbox();
    }
}
