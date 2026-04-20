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

/* ── Entry ── */
async function initMobileCrm(container, user) {
    _mcContainer = container;
    _mcUser = user;

    container.innerHTML =
        '<div class="m-tabs">' +
            '<button class="m-tab active" data-tab="calls">Service calls</button>' +
            '<button class="m-tab" data-tab="search">Kundesøg</button>' +
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

    await _mcLoadCalls();
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

    // Result button toggle
    slot.querySelectorAll('[data-r]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            slot.querySelectorAll('[data-r]').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            var saveBtn = slot.querySelector('[data-save]');
            if (saveBtn) saveBtn.disabled = false;
        });
    });

    // Sentiment button toggle
    slot.querySelectorAll('[data-s]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var wasActive = btn.classList.contains('active');
            slot.querySelectorAll('[data-s]').forEach(function(b) { b.classList.remove('active'); });
            if (!wasActive) btn.classList.add('active');
        });
    });

    slot.querySelector('[data-cancel="' + idx + '"]').addEventListener('click', function() {
        slot.innerHTML = '';
    });

    slot.querySelector('[data-save="' + idx + '"]').addEventListener('click', async function() {
        var resultBtn = slot.querySelector('[data-r].active');
        if (!resultBtn) return;
        var result = resultBtn.dataset.r;
        var sentBtn = slot.querySelector('[data-s].active');
        var sentiment = sentBtn ? sentBtn.dataset.s : null;
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

/* ── Kundesøg + kundeliste ── */
var _mcAllCustomers = null; // cached full list

function _mcShowSearch() {
    var wrap = document.getElementById('mcContent');
    if (!wrap) return;

    wrap.innerHTML =
        '<div class="m-search">' +
            '<input type="search" id="mcSearchInput" placeholder="Søg kunde eller firma..." autocomplete="off">' +
        '</div>' +
        '<div id="mcSearchResults"><div class="m-loading">Henter kunder...</div></div>';

    var input = document.getElementById('mcSearchInput');

    // Load full customer list on first visit
    _mcLoadAllCustomers();

    input.addEventListener('input', function() {
        clearTimeout(_mcSearchTimer);
        var q = input.value.trim();
        if (q.length < 2) {
            // Show full list again
            _mcRenderCustomerList(_mcAllCustomers || []);
            return;
        }
        _mcSearchTimer = setTimeout(function() { _mcDoSearch(q); }, 300);
    });
}

async function _mcLoadAllCustomers() {
    if (_mcAllCustomers) {
        _mcRenderCustomerList(_mcAllCustomers);
        return;
    }
    try {
        var data = await apiFetch('/customers?q=');
        _mcAllCustomers = data.customers || data || [];
        // Sort alphabetically by display name
        _mcAllCustomers.sort(function(a, b) {
            var na = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || a.company_name || '';
            var nb = b.name || [b.first_name, b.last_name].filter(Boolean).join(' ') || b.company_name || '';
            return na.localeCompare(nb, 'da');
        });
        _mcRenderCustomerList(_mcAllCustomers);
    } catch (e) {
        var results = document.getElementById('mcSearchResults');
        if (results) results.innerHTML = '<div class="m-bon-empty">Kunne ikke hente kunder</div>';
    }
}

function _mcRenderCustomerList(customers) {
    var results = document.getElementById('mcSearchResults');
    if (!results) return;

    if (!customers || !customers.length) {
        results.innerHTML = '<div class="m-bon-empty">Ingen kunder</div>';
        return;
    }

    var html = '<div style="padding:8px 16px;font-size:12px;color:var(--color-text-dim)">' + customers.length + ' kunder</div>';
    customers.forEach(function(c) {
        var fullName = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '';
        var cName = fullName || c.company_name || '(ingen navn)';
        var cId = c.customer_id || c.id;
        var subParts = [];
        if (c.company_name) subParts.push(c.company_name);
        if (c.phone) subParts.push(c.phone.trim());
        html +=
            '<div class="m-bon-item" data-cid="' + cId + '">' +
                '<div class="m-bon-info">' +
                    '<div class="m-bon-name">' + _mcEsc(cName) + '</div>' +
                    '<div class="m-bon-sub">' + _mcEsc(subParts.join(' · ')) + '</div>' +
                '</div>' +
                '<span class="m-mig-chevron">&#8250;</span>' +
            '</div>';
    });
    results.innerHTML = html;

    results.querySelectorAll('.m-bon-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mcShowCustomer(parseInt(el.dataset.cid));
        });
    });
}

async function _mcDoSearch(q) {
    var results = document.getElementById('mcSearchResults');
    if (!results) return;

    try {
        var data = await apiFetch('/customers?q=' + encodeURIComponent(q));
        var customers = data.customers || data || [];
        _mcRenderCustomerList(customers);
    } catch (e) {
        results.innerHTML = '<div class="m-bon-empty">Søgefejl</div>';
    }
}

async function _mcShowCustomer(customerId) {
    var wrap = document.getElementById('mcContent');
    if (!wrap) return;
    wrap.innerHTML = '<div class="m-loading">Henter kunde...</div>';

    try {
        var c = await apiFetch('/crm/customer/' + customerId);

        var html = '<div class="m-card" style="margin-top:8px">';
        html += '<div style="font-size:18px;font-weight:600">' + _mcEsc(c.name) + '</div>';
        if (c.company_name) html += '<div style="color:var(--color-text-dim);margin-top:2px">' + _mcEsc(c.company_name) + '</div>';

        if (c.phone) html += '<div style="margin-top:8px"><a href="tel:' + c.phone + '" style="color:var(--brand-primary)">&#128222; ' + c.phone + '</a></div>';
        if (c.email) html += '<div style="margin-top:4px"><a href="mailto:' + c.email + '" style="color:var(--brand-primary)">&#9993; ' + c.email + '</a></div>';
        html += '</div>';

        // Recent bons
        if (c.recent_orders && c.recent_orders.length) {
            html += '<div class="m-detail-section" style="margin-top:8px">';
            html += '<div class="m-detail-label">Seneste ordrer</div>';
            c.recent_orders.slice(0, 5).forEach(function(o) {
                var os = (typeof _mbStatusStyle === 'function') ? _mbStatusStyle(o.status_code || o.status) : { bg: '#ccc', text: '#333', label: o.status || '?' };
                html +=
                    '<div class="m-bon-item" data-id="' + o.id + '">' +
                        '<div class="m-bon-time">' + (o.delivery_date || '').slice(5, 10) + '</div>' +
                        '<div class="m-bon-info">' +
                            '<div class="m-bon-name">#' + (o.bon_number || o.id) + '</div>' +
                            '<div class="m-bon-sub">' + (o.total_units || o.pax || '') + ' enh.</div>' +
                        '</div>' +
                        '<span class="m-bon-badge" style="background:' + os.bg + ';color:' + os.text + '">' + os.label + '</span>' +
                    '</div>';
            });
            html += '</div>';
        }

        // Log samtale
        html += '<div class="m-card" style="margin-top:8px">';
        html += '<div class="m-detail-label">Log samtale</div>';
        html += '<div class="m-inline-form" style="margin-top:8px">';
        html += '<select id="mcLogType">';
        html += '<option value="call">Opkald</option>';
        html += '<option value="note">Note</option>';
        html += '<option value="meeting">Møde</option>';
        html += '</select>';
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

        // Sentiment toggle on profile
        var sentWrap = document.getElementById('mcProfileSent');
        if (sentWrap) {
            sentWrap.querySelectorAll('[data-s]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var wasActive = btn.classList.contains('active');
                    sentWrap.querySelectorAll('[data-s]').forEach(function(b) { b.classList.remove('active'); });
                    if (!wasActive) btn.classList.add('active');
                });
            });
        }

        // Back
        document.getElementById('mcLogBack').addEventListener('click', function() {
            _mcShowSearch();
        });

        // Save
        document.getElementById('mcLogSave').addEventListener('click', async function() {
            var type = document.getElementById('mcLogType').value;
            var note = document.getElementById('mcLogNote').value.trim();
            if (!note) { if (window._mToast) window._mToast('Skriv en note'); return; }

            var sentBtn = sentWrap ? sentWrap.querySelector('[data-s].active') : null;
            var sentiment = sentBtn ? sentBtn.dataset.s : null;

            try {
                var body = {
                    customer_id: customerId,
                    type: type,
                    text: note,
                };
                if (sentiment) body.sentiment = sentiment;

                await apiFetch('/crm/activity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (window._mToast) window._mToast('Samtale logget');
                document.getElementById('mcLogNote').value = '';
                if (sentWrap) {
                    sentWrap.querySelectorAll('[data-s]').forEach(function(b) { b.classList.remove('active'); });
                }
            } catch (e) {
                if (window._mToast) window._mToast('Fejl ved gem');
            }
        });

        // Bon clicks in customer detail
        wrap.querySelectorAll('.m-bon-item[data-id]').forEach(function(el) {
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
