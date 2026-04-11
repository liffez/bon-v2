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
    wrap.innerHTML = '<div class="m-loading">Henter service calls...</div>';

    try {
        _mcCalls = await apiFetch('/crm/service-calls');
    } catch (e) {
        wrap.innerHTML = '<div class="m-bon-empty">Kunne ikke hente data</div>';
        return;
    }

    if (!_mcCalls || !_mcCalls.length) {
        wrap.innerHTML = '<div class="m-bon-empty">Ingen åbne service calls</div>';
        return;
    }

    var html = '';
    _mcCalls.forEach(function(sc, i) {
        var daysStr = '';
        if (sc.days_since != null) {
            daysStr = sc.days_since + ' dage siden';
        }

        html +=
            '<div class="m-crm-item" data-idx="' + i + '">' +
                '<div class="m-crm-item-header">' +
                    '<div class="m-crm-item-name">' + _mcEsc(sc.customer_name || sc.company_name || '?') + '</div>' +
                    '<div class="m-crm-item-date">' + daysStr + '</div>' +
                '</div>' +
                '<div class="m-crm-item-desc">' + _mcEsc(sc.bon_number ? '#' + sc.bon_number : '') +
                    (sc.total_price ? ' · ' + Math.round(sc.total_price) + ' kr' : '') +
                    (sc.pax ? ' · ' + sc.pax + ' pax' : '') +
                '</div>' +
                '<div class="m-crm-actions">' +
                    (sc.customer_phone
                        ? '<a class="m-crm-btn primary" href="tel:' + sc.customer_phone + '">&#128222; Ring</a>'
                        : '') +
                    '<button class="m-crm-btn" data-action="done" data-idx="' + i + '">&#10003; Udført</button>' +
                '</div>' +
                '<div class="m-crm-form-slot" id="mcForm' + i + '"></div>' +
            '</div>';
    });
    wrap.innerHTML = html;

    // Done buttons
    wrap.querySelectorAll('[data-action="done"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            _mcShowDoneForm(parseInt(btn.dataset.idx));
        });
    });
}

function _mcShowDoneForm(idx) {
    var sc = _mcCalls[idx];
    if (!sc) return;
    var slot = document.getElementById('mcForm' + idx);
    if (!slot || slot.innerHTML) return; // Already open

    slot.innerHTML =
        '<div class="m-inline-form">' +
            '<textarea id="mcNote' + idx + '" placeholder="Hvad skete der?"></textarea>' +
            '<div class="m-form-actions">' +
                '<button class="m-crm-btn" data-cancel="' + idx + '">Annuller</button>' +
                '<button class="m-crm-btn primary" data-save="' + idx + '">Gem</button>' +
            '</div>' +
        '</div>';

    slot.querySelector('[data-cancel="' + idx + '"]').addEventListener('click', function() {
        slot.innerHTML = '';
    });

    slot.querySelector('[data-save="' + idx + '"]').addEventListener('click', async function() {
        var note = document.getElementById('mcNote' + idx).value.trim();
        try {
            await apiFetch('/crm/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_id: sc.customer_id,
                    type: 'service_call',
                    result: 'done',
                    note: note || 'Håndteret',
                    user_id: _mcUser.id
                })
            });
            if (window._mToast) window._mToast('Service call lukket');
            _mcLoadCalls();
        } catch (e) {
            if (window._mToast) window._mToast('Fejl ved gem');
        }
    });
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
        html += '<div class="m-form-actions">';
        html += '<button class="m-crm-btn" id="mcLogBack">&#8249; Tilbage</button>';
        html += '<button class="m-crm-btn primary" id="mcLogSave">Gem</button>';
        html += '</div></div></div>';

        wrap.innerHTML = html;

        // Back
        document.getElementById('mcLogBack').addEventListener('click', function() {
            _mcShowSearch();
        });

        // Save
        document.getElementById('mcLogSave').addEventListener('click', async function() {
            var type = document.getElementById('mcLogType').value;
            var note = document.getElementById('mcLogNote').value.trim();
            if (!note) { if (window._mToast) window._mToast('Skriv en note'); return; }

            try {
                await apiFetch('/crm/activity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        customer_id: customerId,
                        type: type,
                        note: note,
                        user_id: _mcUser.id
                    })
                });
                if (window._mToast) window._mToast('Samtale logget');
                document.getElementById('mcLogNote').value = '';
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
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
