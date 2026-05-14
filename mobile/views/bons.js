/**
 * mobile/views/bons.js
 * ════════════════════════════════════════════════════════════
 * Bonliste (I dag / I morgen / Overmorgen / Nye + søg) + Bon-detalje.
 *
 * Nye-tab: events fra GET /api/bons/new (ny bon + ulæst mail) med
 * IntersectionObserver der auto-markerer events som set efter 2s.
 *
 * Søg-overlay: alternativ tilstand af tabs-row med live-søg (300ms debounce)
 * på tværs af alle datoer/statusser/tilbud.
 *
 * Spec: docs/CLAUDE_MOBIL_NYE_OG_SOEG.md
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

/* Nye-tab state — _mbNyeCount initialiseres fra global hvis tilgængelig
   (sat af initial count_only-kald i mobile/index.html) */
var _mbNyeEvents = [];          // alle hentede events (kan vokse via "Vis flere")
var _mbNyeCount = (typeof window !== 'undefined' && window._mNewBonsCount) || 0;
var _mbNyeHasMore = false;
var _mbNyeOffset = 0;

/* Søg state */
var _mbSearchActive = false;
var _mbLastTabBeforeSearch = 'today';
var _mbSearchQuery = '';
var _mbSearchResults = [];
var _mbSearchOffset = 0;
var _mbSearchTimer = null;
var _mbFromSearch = false;      // detail åbnet fra søg? → back skal tilbage til søg

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
    if (_mbSearchTimer) { clearTimeout(_mbSearchTimer); _mbSearchTimer = null; }
    _mbContainer = null;
}

/* ── Tabs-row (normal eller søg) ── */
function _mbRenderTabsRow() {
    if (_mbSearchActive) {
        return (
            '<div class="m-search-row">' +
                '<button class="m-search-back" id="mbSearchBack" aria-label="Tilbage">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                        '<line x1="19" y1="12" x2="5" y2="12"/>' +
                        '<polyline points="12 19 5 12 12 5"/>' +
                    '</svg>' +
                '</button>' +
                '<div class="m-search-input-wrap">' +
                    '<span class="m-search-input-icon">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                            '<circle cx="11" cy="11" r="8"/>' +
                            '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
                        '</svg>' +
                    '</span>' +
                    '<input type="text" class="m-search-input" id="mbSearchInput"' +
                        ' placeholder="Søg bonnummer, kunde, firma, telefon…" autofocus>' +
                    '<button class="m-search-clear" id="mbSearchClear" aria-label="Ryd"' +
                        ' style="display:' + (_mbSearchQuery ? '' : 'none') + '">&times;</button>' +
                '</div>' +
            '</div>'
        );
    }

    var badge = _mbNyeCount > 0 ? '<span class="m-tab-badge">' + _mbNyeCount + '</span>' : '';
    return (
        '<div class="m-tabs-row">' +
            '<div class="m-tabs">' +
                '<button class="m-tab' + (_mbTab === 'today'    ? ' active' : '') + '" data-tab="today">I dag</button>' +
                '<button class="m-tab' + (_mbTab === 'tomorrow' ? ' active' : '') + '" data-tab="tomorrow">I morgen</button>' +
                '<button class="m-tab' + (_mbTab === 'dayafter' ? ' active' : '') + '" data-tab="dayafter">Overmorgen</button>' +
                '<button class="m-tab' + (_mbTab === 'new'      ? ' active' : '') + '" data-tab="new">Nye' + badge + '</button>' +
            '</div>' +
            '<button class="m-search-btn" id="mbSearchOpen" aria-label="Søg">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="11" cy="11" r="8"/>' +
                    '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
                '</svg>' +
            '</button>' +
        '</div>'
    );
}

function _mbAttachTabsRowHandlers() {
    if (_mbSearchActive) {
        document.getElementById('mbSearchBack').addEventListener('click', _mbCloseSearch);
        var input = document.getElementById('mbSearchInput');
        input.value = _mbSearchQuery;
        input.addEventListener('input', _mbOnSearchInput);
        // autofocus virker ikke pålideligt på iOS — sæt eksplicit
        setTimeout(function() { input.focus(); }, 50);
        document.getElementById('mbSearchClear').addEventListener('click', function() {
            _mbSearchQuery = '';
            input.value = '';
            document.getElementById('mbSearchClear').style.display = 'none';
            _mbLoadSearchResults();
        });
    } else {
        _mbContainer.querySelectorAll('.m-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                _mbTab = tab.dataset.tab;
                _mbContainer.querySelectorAll('.m-tab').forEach(function(t) {
                    t.classList.toggle('active', t.dataset.tab === _mbTab);
                });
                _mbLoadTabContent();
            });
        });
        document.getElementById('mbSearchOpen').addEventListener('click', _mbOpenSearch);
    }
}

/* ── List view (top-level) ── */
async function _mbLoadList() {
    _mbContainer.innerHTML = _mbRenderTabsRow() +
        '<div id="mbList"><div class="m-loading">Henter…</div></div>';
    _mbAttachTabsRowHandlers();

    if (_mbSearchActive) {
        await _mbLoadSearchResults();
    } else {
        await _mbLoadTabContent();
    }

    _mbSetupPullToRefresh();
}

async function _mbLoadTabContent() {
    if (_mbTab === 'new') {
        await _mbLoadNye();
        return;
    }
    await _mbLoadDateTab();
}

/* ── Date-tabs (I dag / I morgen / Overmorgen) ── */
async function _mbLoadDateTab() {
    var list = document.getElementById('mbList');
    if (list) list.innerHTML = '<div class="m-loading">Henter bons...</div>';

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
        _mbBonsToday    = (results[0].bons || results[0] || []);
        _mbBonsTomorrow = (results[1].bons || results[1] || []);
        _mbBonsDayAfter = (results[2].bons || results[2] || []);
    } catch (e) {
        _mbBonsToday = []; _mbBonsTomorrow = []; _mbBonsDayAfter = [];
    }

    _mbRenderDateList();
}

function _mbRenderDateList() {
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

    bons.sort(function(a, b) {
        return (a.delivery_time || '').localeCompare(b.delivery_time || '');
    });

    var html = '';
    bons.forEach(function(bon) {
        var s = _mbStatusStyle(bon.status_code || bon.status);
        var time = (bon.delivery_time || '').slice(0, 5) || '—';
        var name = bon.contact_name_full || bon.customer_name || bon.company_name || 'Ukendt';
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

    list.querySelectorAll('.m-bon-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mbFromSearch = false;
            _mbShowDetail(parseInt(el.dataset.id));
        });
    });
}

/* ── Nye-tab ── */
async function _mbLoadNye(append) {
    var list = document.getElementById('mbList');
    if (!list) return;
    if (!append) {
        list.innerHTML = '<div class="m-loading">Henter nye…</div>';
        _mbNyeOffset = 0;
        _mbNyeEvents = [];
    }

    try {
        var data = await apiFetch('/bons/new?limit=30&offset=' + _mbNyeOffset);
        _mbNyeCount = data.count || 0;
        _mbNyeHasMore = !!data.has_more;
        var fresh = data.events || [];
        _mbNyeEvents = append ? _mbNyeEvents.concat(fresh) : fresh;
        _mbNyeOffset += fresh.length;
    } catch (e) {
        if (!append) _mbNyeEvents = [];
    }

    _mbRenderNye();
    _mbUpdateBadges(_mbNyeCount);
}

function _mbRenderNye() {
    var list = document.getElementById('mbList');
    if (!list) return;

    if (!_mbNyeEvents.length) {
        list.innerHTML =
            '<div class="m-bon-empty m-nye-empty">' +
                '<div class="m-nye-empty-emoji">🎉</div>' +
                '<div>Fanget op — ingen pending bons eller ulæste mails.</div>' +
            '</div>';
        return;
    }

    // Pending-inbox-model: items forsvinder kun ved reel handling
    // (status-skift eller mail markeret som læst). Ingen "Marker alle læst".
    var html = '';

    // Gruppér events i tidsbuckets (efter created_at hhv. received_at)
    var groups = _mbGroupEventsByTime(_mbNyeEvents);
    ['now', 'today', 'yesterday', 'older'].forEach(function(key) {
        if (!groups[key].length) return;
        html += '<div class="m-section-head">' + _mbGroupLabel(key) + '</div>';
        groups[key].forEach(function(ev) {
            html += _mbRenderNyeCard(ev);
        });
    });

    if (_mbNyeHasMore) {
        html += '<button class="m-show-more" id="mbShowMore">Vis flere ↓</button>';
    }

    list.innerHTML = html;

    var moreBtn = document.getElementById('mbShowMore');
    if (moreBtn) moreBtn.addEventListener('click', function() { _mbLoadNye(true); });

    list.querySelectorAll('.m-bon-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mbFromSearch = false;
            _mbShowDetail(parseInt(el.dataset.bonId));
        });
    });
}

function _mbRenderNyeCard(ev) {
    var bon = ev.bon;
    var mail = ev.mail;
    var s = _mbStatusStyle(bon.status_code);

    var isMail = ev.event_type === 'unread_mail';
    var isWeb  = bon.source === 'web';

    var srcIcon, srcLabel;
    if (isMail) {
        srcIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>' +
            '<polyline points="22,6 12,13 2,6"/></svg>';
        srcLabel = 'Ulæst mail';
    } else if (isWeb) {
        srcIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<circle cx="12" cy="12" r="10"/>' +
            '<line x1="2" y1="12" x2="22" y2="12"/>' +
            '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
        srcLabel = 'Web-bestilling';
    } else {
        srcIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M12 20h9"/>' +
            '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        srcLabel = 'Manuel';
    }

    // Alle items i pending-inboxen er per definition uset/pending →
    // rød kant via .unseen. Forsvinder først når status ændres eller
    // mail markeres læst (server-side handling).
    var classes = 'm-bon-item m-bon-nye unseen';
    if (isMail) classes += ' mail';

    var name = bon.contact_name_full || bon.company_name || 'Ukendt';
    if (bon.contact_name_full && bon.company_name) {
        name = bon.contact_name_full + ' — ' + bon.company_name;
    }

    var whenStr = _mbFormatRelative(ev.event_at);
    var metaLine = '#' + bon.bon_number;
    if (bon.delivery_date) metaLine += ' · Lev. ' + _mbFormatDeliveryShort(bon.delivery_date, bon.delivery_time);
    if (bon.pax) metaLine += ' · ' + bon.pax + ' pax';

    var html =
        '<div class="' + classes + '"' +
            ' data-bon-id="' + bon.id + '"' +
            ' data-event-type="' + ev.event_type + '"' +
            (mail ? ' data-mail-id="' + mail.id + '"' : '') + '>' +
            '<div class="m-bon-row1">' +
                '<span class="m-bon-source">' + srcIcon + ' ' + srcLabel + '</span>' +
                '<span class="m-bon-badge" style="background:' + s.bg + ';color:' + s.text + '">' + s.label + '</span>' +
            '</div>' +
            '<div class="m-bon-customer">' + _mbEsc(name) + '</div>';

    if (mail && mail.preview) {
        html += '<div class="m-bon-mail-preview">"' + _mbEsc(mail.preview) + '"</div>';
    }

    html +=
            '<div class="m-bon-meta-line"><span class="m-bon-when">' + _mbEsc(whenStr) + '</span></div>' +
            '<div class="m-bon-meta-line">' + _mbEsc(metaLine) + '</div>' +
        '</div>';

    return html;
}

function _mbGroupEventsByTime(events) {
    var now = new Date();
    var oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterdayStart = new Date(todayStart.getTime() - 24 * 3600 * 1000);

    var groups = { now: [], today: [], yesterday: [], older: [] };
    events.forEach(function(ev) {
        if (!ev.event_at) return;
        var t = new Date(ev.event_at.replace(' ', 'T'));
        if (t >= oneHourAgo) groups.now.push(ev);
        else if (t >= todayStart) groups.today.push(ev);
        else if (t >= yesterdayStart) groups.yesterday.push(ev);
        else groups.older.push(ev);
    });
    return groups;
}

function _mbGroupLabel(key) {
    return { now: 'Lige nu', today: 'Tidligere i dag', yesterday: 'I går', older: 'Ældre' }[key];
}

function _mbFormatRelative(iso) {
    if (!iso) return '';
    var t = new Date(iso.replace(' ', 'T'));
    var diff = (Date.now() - t.getTime()) / 1000;  // sek
    if (diff < 60) return 'Lige nu';
    if (diff < 3600) return 'For ' + Math.floor(diff / 60) + ' min siden';
    var todayStart = new Date(); todayStart.setHours(0,0,0,0);
    if (t >= todayStart) return 'Kl. ' + String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
    var yesterdayStart = new Date(todayStart.getTime() - 24 * 3600 * 1000);
    if (t >= yesterdayStart) return 'I går kl. ' + String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
    var days = ['søn','man','tir','ons','tor','fre','lør'];
    return days[t.getDay()] + ' ' + t.getDate() + '/' + (t.getMonth() + 1);
}

function _mbFormatDeliveryShort(dateStr, timeStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    var days = ['søn','man','tir','ons','tor','fre','lør'];
    var s = days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
    if (timeStr) s += ' kl. ' + timeStr.slice(0,5);
    return s;
}

// Beslutning 12 (14. maj 2026): pending-inbox-model.
// Items i Nye-listen forsvinder KUN ved reel handling — bons skal have
// deres status ændret (NY → noget andet), mails skal markeres som læst.
// Derfor er der ingen auto-mark IntersectionObserver, ingen visuel seen-
// state, og ingen "Marker alle læst"-knap længere. Alle kort vises som
// rød kant indtil de håndteres et andet sted i systemet.

/* ── Badge-opdatering ── */
function _mbUpdateBadges(count) {
    // Top-tab badge
    var tab = _mbContainer && _mbContainer.querySelector('.m-tab[data-tab="new"]');
    if (tab) {
        var existing = tab.querySelector('.m-tab-badge');
        if (count > 0) {
            if (existing) existing.textContent = count;
            else tab.insertAdjacentHTML('beforeend', '<span class="m-tab-badge">' + count + '</span>');
        } else if (existing) {
            existing.remove();
        }
    }
    // Bottom-nav badge (global helper i mobile/index.html)
    if (window._mUpdateNewBadge) window._mUpdateNewBadge(count);
}

/* ── Søg-overlay ── */
function _mbOpenSearch() {
    if (_mbSearchActive) return;
    _mbLastTabBeforeSearch = _mbTab;
    _mbSearchActive = true;
    _mbSearchQuery = '';
    _mbSearchOffset = 0;
    _mbSearchResults = [];
    _mbLoadList();
}

function _mbCloseSearch() {
    _mbSearchActive = false;
    _mbTab = _mbLastTabBeforeSearch;
    if (_mbSearchTimer) { clearTimeout(_mbSearchTimer); _mbSearchTimer = null; }
    _mbLoadList();
}

function _mbOnSearchInput(e) {
    var val = e.target.value;
    _mbSearchQuery = val;
    document.getElementById('mbSearchClear').style.display = val ? '' : 'none';
    if (_mbSearchTimer) clearTimeout(_mbSearchTimer);
    _mbSearchTimer = setTimeout(function() {
        _mbSearchOffset = 0;
        _mbLoadSearchResults();
    }, 300);
}

async function _mbLoadSearchResults(append) {
    var list = document.getElementById('mbList');
    if (!list) return;
    if (!append) list.innerHTML = '<div class="m-loading">Søger…</div>';

    var qs;
    if (_mbSearchQuery) {
        qs = '/bons?q=' + encodeURIComponent(_mbSearchQuery) +
             '&limit=30&offset=' + _mbSearchOffset +
             '&sort=delivery_date&dir=desc';
    } else {
        qs = '/bons?limit=30&offset=' + _mbSearchOffset + '&sort=delivery_date&dir=desc';
    }

    var fresh;
    try {
        var data = await apiFetch(qs);
        fresh = (data.bons || data || []);
    } catch (e) {
        fresh = [];
    }
    _mbSearchResults = append ? _mbSearchResults.concat(fresh) : fresh;
    _mbSearchOffset += fresh.length;

    _mbRenderSearchResults(fresh.length === 30);
}

function _mbRenderSearchResults(hasMore) {
    var list = document.getElementById('mbList');
    if (!list) return;

    var q = _mbSearchQuery;
    var countLabel;
    if (q) {
        countLabel = '<strong>' + _mbSearchResults.length + '</strong> resultater for <strong>"' + _mbEsc(q) + '"</strong>';
    } else {
        countLabel = 'Seneste ' + _mbSearchResults.length + ' bonner';
    }

    var html = '<div class="m-result-count">' + countLabel + '</div>';

    if (!_mbSearchResults.length) {
        html += '<div class="m-bon-empty">Ingen bonner fundet' + (q ? ' for "' + _mbEsc(q) + '"' : '') + '</div>';
        list.innerHTML = html;
        return;
    }

    _mbSearchResults.forEach(function(bon) {
        var s = _mbStatusStyle(bon.status_code || bon.status);
        var name = bon.contact_name_full || bon.company_name || 'Ukendt';
        var meta = '';
        if (bon.delivery_date) meta += 'Lev. ' + _mbFormatDeliveryShort(bon.delivery_date, bon.delivery_time);
        if (bon.pax) meta += ' · ' + bon.pax + ' pax';
        if (bon.contact_name_full && bon.company_name) {
            meta += ' · ' + bon.contact_name_full;
        }

        var highlightedName = q ? _mbHighlight(name, q) : _mbEsc(name);
        var highlightedBonNr = q ? _mbHighlight('#' + bon.bon_number, q) : '#' + bon.bon_number;

        html +=
            '<div class="m-result-item" data-bon-id="' + bon.id + '">' +
                '<div class="m-result-row1">' +
                    '<span class="m-result-bonnr">' + highlightedBonNr + '</span>' +
                    '<span class="m-result-customer">' + highlightedName + '</span>' +
                    '<span class="m-result-status" style="background:' + s.bg + ';color:' + s.text + '">' + s.label + '</span>' +
                '</div>' +
                '<div class="m-result-meta">' + _mbEsc(meta) + '</div>' +
            '</div>';
    });

    if (hasMore) {
        html += '<button class="m-show-more" id="mbSearchMore">Vis 30 ældre ↓</button>';
    }

    list.innerHTML = html;

    list.querySelectorAll('.m-result-item').forEach(function(el) {
        el.addEventListener('click', function() {
            _mbFromSearch = true;
            _mbShowDetail(parseInt(el.dataset.bonId));
        });
    });

    var more = document.getElementById('mbSearchMore');
    if (more) more.addEventListener('click', function() { _mbLoadSearchResults(true); });
}

function _mbHighlight(text, q) {
    if (!q || !text) return _mbEsc(text);
    var safe = _mbEsc(text);
    var safeQ = _mbEsc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + safeQ + ')', 'gi'), '<mark>$1</mark>');
}

/* ── Detail view ── */
async function _mbShowDetail(bonId) {
    _mbContainer.innerHTML = '<div class="m-loading">Henter bon...</div>';

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

    var custName = bon.contact_name_full || bon.customer_name || '';
    html += '<div class="m-detail-section">';
    if (custName || bon.company_name) {
        html += '<div class="m-detail-label">Kunde</div>';
        html += '<div class="m-detail-value">' + _mbEsc(custName);
        if (bon.company_name) html += ' <span style="color:var(--color-text-dim)">(' + _mbEsc(bon.company_name) + ')</span>';
        html += '</div>';
    }

    var phone = bon.contact_phone || bon.customer_phone || bon.day_contact_phone;
    if (phone) {
        html += '<div class="m-detail-label">Telefon</div>';
        html += '<div class="m-detail-value"><a href="tel:' + phone + '">' + phone + '</a></div>';
    }

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

    html += '<div class="m-detail-label">Enheder / Pax</div>';
    html += '<div class="m-detail-value">' + (bon.total_units || '—') + ' enh. / ' + (bon.pax || '—') + ' pax</div>';

    html += '</div>';

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

    if (bon.kitchen_info) {
        html += '<div class="m-detail-section">';
        html += '<div class="m-detail-label">Køkkeninfo</div>';
        html += '<div class="m-detail-value">' + _mbEsc(bon.kitchen_info) + '</div>';
        html += '</div>';
    }

    html += '<div class="m-status-actions" id="mbStatusActions"></div>';

    _mbContainer.innerHTML = html;

    document.getElementById('mbBack').addEventListener('click', function() {
        var p = new URLSearchParams(window.location.search);
        p.delete('bon');
        history.pushState(null, '', '?' + p.toString());
        // Tilbage til søg hvis vi kom derfra, ellers normal liste
        if (_mbFromSearch && _mbSearchActive) {
            _mbLoadList();
        } else {
            _mbLoadList();
        }
    });

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
            var toCode = t.code || t.to_code || t.to;
            var ts = _mbStatusStyle(toCode);
            var btn = document.createElement('button');
            btn.className = 'm-status-btn';
            btn.style.background = ts.bg;
            btn.style.color = ts.text;
            btn.textContent = ts.label;
            btn.addEventListener('click', function() { _mbChangeStatus(bon.id, toCode); });
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
            body: JSON.stringify({ status_code: toCode, user_id: _mbUser.id })
        });
        if (navigator.vibrate) navigator.vibrate(50);
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
    if (str === null || str === undefined) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}
