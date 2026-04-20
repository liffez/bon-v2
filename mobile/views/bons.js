/**
 * mobile/views/bons.js
 * ════════════════════════════════════════════════════════════
 * Bonliste (I dag / I morgen tabs) + Bon-detalje med statusskift.
 * ════════════════════════════════════════════════════════════
 */

/* ── State ── */
var _mbContainer = null;
var _mbUser = null;
var _mbTab = 'today';
var _mbBonsToday = [];
var _mbBonsTomorrow = [];
var _mbBonsDayAfter = [];
var _mbDetailBon = null;

function _mbIsoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
}

/* ── Status config (fra BonConfig.js) ── */
function _mbStatusStyle(code) {
    var s = BON_CONFIG.statuses[code] || BON_CONFIG.statuses[(code || '').toLowerCase()];
    if (!s) return { bg: '#ccc', text: '#333', label: code || '?' };
    return { bg: s.color, text: s.text, label: s.label };
}

/* ── Entry ── */
async function initMobileBons(container, user) {
    _mbContainer = container;
    _mbUser = user;
    _mbDetailBon = null;

    // Check if we should open a bon detail from URL
    var params = new URLSearchParams(window.location.search);
    var bonId = params.get('bon');
    if (bonId) {
        await _mbShowDetail(parseInt(bonId));
        return;
    }

    await _mbLoadList();
}

function cleanupMobileBons() {
    _mbContainer = null;
}

/* ── List view ── */
async function _mbLoadList() {
    _mbContainer.innerHTML =
        '<div class="m-tabs">' +
            '<button class="m-tab' + (_mbTab === 'today' ? ' active' : '') + '" data-tab="today">I dag</button>' +
            '<button class="m-tab' + (_mbTab === 'tomorrow' ? ' active' : '') + '" data-tab="tomorrow">I morgen</button>' +
            '<button class="m-tab' + (_mbTab === 'dayafter' ? ' active' : '') + '" data-tab="dayafter">Overmorgen</button>' +
        '</div>' +
        '<div id="mbList"><div class="m-loading">Henter bons...</div></div>';

    // Tab clicks
    _mbContainer.querySelectorAll('.m-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            _mbTab = tab.dataset.tab;
            _mbContainer.querySelectorAll('.m-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.tab === _mbTab);
            });
            _mbRenderList();
        });
    });

    // Fetch
    var statuses = 'NY,VENTER,GODKENDT,IGANG,KLAR,LEVERET';
    try {
        var tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        var dayAfter = new Date();
        dayAfter.setDate(dayAfter.getDate() + 2);

        var results = await Promise.all([
            apiFetch('/bons?date=today&status=' + statuses),
            apiFetch('/bons?date=' + _mbIsoDate(tomorrow) + '&status=' + statuses),
            apiFetch('/bons?date=' + _mbIsoDate(dayAfter) + '&status=' + statuses)
        ]);
        _mbBonsToday = (results[0].bons || results[0] || []);
        _mbBonsTomorrow = (results[1].bons || results[1] || []);
        _mbBonsDayAfter = (results[2].bons || results[2] || []);
    } catch (e) {
        _mbBonsToday = [];
        _mbBonsTomorrow = [];
        _mbBonsDayAfter = [];
    }

    _mbRenderList();

    // Pull to refresh (simple)
    _mbSetupPullToRefresh();
}

function _mbRenderList() {
    var list = document.getElementById('mbList');
    if (!list) return;
    var bons = _mbTab === 'today' ? _mbBonsToday
             : _mbTab === 'tomorrow' ? _mbBonsTomorrow
             : _mbBonsDayAfter;

    if (!bons.length) {
        var emptyLabel = _mbTab === 'today' ? 'i dag'
                       : _mbTab === 'tomorrow' ? 'i morgen'
                       : 'overmorgen';
        list.innerHTML = '<div class="m-bon-empty">Ingen bons ' + emptyLabel + '</div>';
        return;
    }

    // Sort by delivery_time
    bons.sort(function(a, b) {
        return (a.delivery_time || '').localeCompare(b.delivery_time || '');
    });

    var html = '';
    bons.forEach(function(bon) {
        var s = _mbStatusStyle(bon.status_code || bon.status);
        var time = (bon.delivery_time || '').slice(0, 5) || '—';
        var name = bon.customer_name || bon.company_name || 'Ukendt';
        var sub = '#' + (bon.bon_number || bon.id);
        if (bon.total_units) sub += ' · ' + bon.total_units + ' enh.';
        else if (bon.pax) sub += ' · ' + bon.pax + ' pax';

        html +=
            '<div class="m-bon-item" data-id="' + bon.id + '">' +
                '<div class="m-bon-time">' + time + '</div>' +
                '<div class="m-bon-info">' +
                    '<div class="m-bon-name">' + _mbEsc(name) + '</div>' +
                    '<div class="m-bon-sub">' + sub + '</div>' +
                '</div>' +
                '<span class="m-bon-badge" style="background:' + s.bg + ';color:' + s.text + '">' + s.label + '</span>' +
            '</div>';
    });
    list.innerHTML = html;

    // Click handlers
    list.querySelectorAll('.m-bon-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mbShowDetail(parseInt(el.dataset.id));
        });
    });
}

/* ── Detail view ── */
async function _mbShowDetail(bonId) {
    _mbContainer.innerHTML = '<div class="m-loading">Henter bon...</div>';

    // Update URL
    var params = new URLSearchParams(window.location.search);
    params.set('bon', bonId);
    history.pushState(null, '', '?' + params.toString());

    try {
        _mbDetailBon = await apiFetch('/bons/' + bonId);
    } catch (e) {
        _mbContainer.innerHTML = '<div class="m-bon-empty">Kunne ikke hente bon</div>';
        return;
    }

    var bon = _mbDetailBon;
    var s = _mbStatusStyle(bon.status_code || bon.status);

    var html =
        '<div class="m-detail-header">' +
            '<button class="m-detail-back" id="mbBack">&#8249;</button>' +
            '<div class="m-detail-title">#' + (bon.bon_number || bon.id) + '</div>' +
            '<span class="m-bon-badge" style="background:' + s.bg + ';color:' + s.text + '">' + s.label + '</span>' +
        '</div>';

    // Kunde
    html += '<div class="m-detail-section">';
    if (bon.customer_name || bon.company_name) {
        html += '<div class="m-detail-label">Kunde</div>';
        html += '<div class="m-detail-value">' + _mbEsc(bon.customer_name || '');
        if (bon.company_name) html += ' <span style="color:var(--color-text-dim)">(' + _mbEsc(bon.company_name) + ')</span>';
        html += '</div>';
    }

    // Telefon
    var phone = bon.customer_phone || bon.day_contact_phone;
    if (phone) {
        html += '<div class="m-detail-label">Telefon</div>';
        html += '<div class="m-detail-value"><a href="tel:' + phone + '">' + phone + '</a></div>';
    }

    // Levering
    html += '<div class="m-detail-label">Levering</div>';
    var deliveryStr = '';
    if (bon.delivery_date) {
        var d = new Date(bon.delivery_date);
        var days = ['søn','man','tir','ons','tor','fre','lør'];
        deliveryStr = days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth()+1);
    }
    if (bon.delivery_time) deliveryStr += ' kl. ' + bon.delivery_time.slice(0,5);
    if (bon.delivery_type) deliveryStr += ' (' + bon.delivery_type + ')';
    html += '<div class="m-detail-value">' + (deliveryStr || '—') + '</div>';

    // Adresse
    var addrObj = bon.delivery_address || bon.address || null;
    var addrStr = bon.address_line || '';
    if (addrObj && typeof addrObj === 'object') {
        addrStr = [addrObj.street_name, addrObj.street_nr, addrObj.postal_code, addrObj.city].filter(Boolean).join(' ');
    } else if (typeof addrObj === 'string') {
        addrStr = addrObj;
    }
    if (addrStr) {
        html += '<div class="m-detail-label">Adresse</div>';
        html += '<div class="m-detail-value"><a href="https://maps.google.com/?q=' + encodeURIComponent(addrStr) + '" target="_blank">' + _mbEsc(addrStr) + ' &#8599;</a></div>';
    }

    // Enheder/pax
    html += '<div class="m-detail-label">Enheder / Pax</div>';
    html += '<div class="m-detail-value">' + (bon.total_units || '—') + ' enh. / ' + (bon.pax || '—') + ' pax</div>';

    html += '</div>';

    // Linjer
    if (bon.lines && bon.lines.length) {
        html += '<div class="m-detail-section">';
        html += '<div class="m-detail-label">Varer</div>';
        html += '<ul class="m-detail-lines">';
        bon.lines.forEach(function(line) {
            html += '<li class="m-detail-line">' +
                '<span class="m-detail-line-name">' + _mbEsc(line.product_name || line.name || '?') + '</span>' +
                '<span class="m-detail-line-qty">' + (line.quantity || '') + ' ' + (line.unit || '') + '</span>' +
            '</li>';
        });
        html += '</ul></div>';
    }

    // Køkkeninfo
    if (bon.kitchen_info) {
        html += '<div class="m-detail-section">';
        html += '<div class="m-detail-label">Køkkeninfo</div>';
        html += '<div class="m-detail-value">' + _mbEsc(bon.kitchen_info) + '</div>';
        html += '</div>';
    }

    // Status actions
    html += '<div class="m-status-actions" id="mbStatusActions"></div>';

    _mbContainer.innerHTML = html;

    // Back button
    document.getElementById('mbBack').addEventListener('click', function() {
        var p = new URLSearchParams(window.location.search);
        p.delete('bon');
        history.pushState(null, '', '?' + p.toString());
        _mbLoadList();
    });

    // Load transitions
    _mbLoadTransitions(bon);
}

async function _mbLoadTransitions(bon) {
    var actionsEl = document.getElementById('mbStatusActions');
    if (!actionsEl) return;

    var code = (bon.status_code || bon.status || '').toUpperCase();
    try {
        var transitions = await apiFetch('/statuses/' + code + '/transitions');
        if (!transitions || !transitions.length) {
            actionsEl.innerHTML = '';
            return;
        }

        actionsEl.innerHTML = '';
        transitions.forEach(function(t) {
            var ts = _mbStatusStyle(t.to_code || t.to);
            var btn = document.createElement('button');
            btn.className = 'm-status-btn';
            btn.style.background = ts.bg;
            btn.style.color = ts.text;
            btn.textContent = ts.label;
            btn.addEventListener('click', function() { _mbChangeStatus(bon.id, t.to_code || t.to); });
            actionsEl.appendChild(btn);
        });
    } catch (e) {
        actionsEl.innerHTML = '';
    }
}

async function _mbChangeStatus(bonId, toCode) {
    try {
        await apiFetch('/bons/' + bonId + '/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status_code: toCode, user_id: _mbUser.id })
        });
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(50);
        // Refresh detail
        await _mbShowDetail(bonId);
        if (window._mToast) window._mToast('Status opdateret');
    } catch (e) {
        if (window._mToast) window._mToast('Fejl ved statusskift');
    }
}

/* ── Pull to refresh ── */
function _mbSetupPullToRefresh() {
    var content = _mbContainer;
    var startY = 0, pulling = false;

    content.addEventListener('touchstart', function(e) {
        if (content.scrollTop === 0) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    content.addEventListener('touchend', function(e) {
        if (pulling && e.changedTouches[0].clientY - startY > 80) {
            _mbLoadList();
        }
        pulling = false;
    }, { passive: true });
}

/* ── popstate for back from detail ── */
window.addEventListener('popstate', function() {
    if (!_mbContainer) return;
    var p = new URLSearchParams(window.location.search);
    if (p.get('view') === 'bons' && !p.get('bon') && _mbDetailBon) {
        _mbDetailBon = null;
        _mbLoadList();
    }
});

/* ── Escape helper ── */
function _mbEsc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
