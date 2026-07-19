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
var _mbMailTemplates = null;    // cache af mail-skabeloner (hentes første gang)

/* Dato-mode (sat når bruger har klikket på en dag i Overblik) */
var _mbDateMode = null;       // 'YYYY-MM-DD' eller null
var _mbDateModeBons = [];

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

/* ── Tids-blok: pickup-tid øverst, leveringstid mindre nedenunder ──
 * Har bonen begge tider vises afhentning (Afh) øverst og levering (Lev)
 * mindre under. Mangler pickup falder vi tilbage til kun leveringstiden. */
function _mbTimeBlock(bon) {
    var pickup   = (bon.pickup_time   || '').slice(0, 5);
    var delivery = (bon.delivery_time || '').slice(0, 5);
    if (pickup && delivery) {
        return '<div class="m-bon-time">' +
            '<div class="m-bon-time-main"><span class="m-bon-time-tag">Afh</span>' + pickup + '</div>' +
            '<div class="m-bon-time-sub"><span class="m-bon-time-tag">Lev</span>' + delivery + '</div>' +
        '</div>';
    }
    var single = delivery || pickup || '—';
    return '<div class="m-bon-time"><div class="m-bon-time-main">' + single + '</div></div>';
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

    var params = new URLSearchParams(window.location.search);

    // Check if we should open a bon detail from URL
    var bonId = params.get('bon');
    if (bonId) {
        await _mbShowDetail(parseInt(bonId));
        return;
    }

    // Klik fra Overblik: vis bons for en bestemt dato
    var bonDate = params.get('bon_date');
    if (bonDate) {
        _mbDateMode = bonDate;
        await _mbLoadDateMode();
        return;
    }

    _mbDateMode = null;
    await _mbLoadList();
}

function cleanupMobileBons() {
    if (_mbSearchTimer) { clearTimeout(_mbSearchTimer); _mbSearchTimer = null; }
    if (_mbSseReloadTimer) { clearTimeout(_mbSseReloadTimer); _mbSseReloadTimer = null; }
    _mbContainer = null;
}

/* ── SSE handler (kaldes fra mobile/index.html) ──
 * Debounced re-load af aktive liste, plus detail-reload hvis brugeren ser
 * den ramte bon. Container-null = view inaktiv, ignorer.
 */
var _mbSseReloadTimer = null;
function _mbHandleSSE(event, data) {
    if (!_mbContainer) return;
    var bonId = data && (data.id || data.bon_id);

    // Detail-view åbent på samme bon → genindlæs straks
    if (_mbDetailBon && bonId && _mbDetailBon.id === bonId) {
        _mbShowDetail(bonId);
        return;
    }

    // Listevisning → debounced re-load af det der vises
    if (_mbSseReloadTimer) return;
    _mbSseReloadTimer = setTimeout(function() {
        _mbSseReloadTimer = null;
        if (!_mbContainer || _mbDetailBon) return;
        if (_mbSearchActive)   return;     // søgeresultater er en bevidst snapshot
        if (_mbDateMode)       _mbLoadDateMode();
        else if (_mbTab === 'nye') _mbLoadNye();
        else                    _mbLoadTabContent();
    }, 600);
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
                '<button class="m-tab' + (_mbTab === 'new'      ? ' active' : '') + '" data-tab="new">Nyt' + badge + '</button>' +
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

/* ── Dato-mode (åbnet fra Overblik) ── */
async function _mbLoadDateMode() {
    _mbContainer.innerHTML = _mbRenderDateModeHeader() +
        '<div id="mbList"><div class="m-loading">Henter bons...</div></div>';
    _mbAttachDateModeHandlers();

    var statuses = 'NY,VENTER,GODKENDT,IGANG,KLAR,LEVERET,FAKTURERET,AFSLUTTET,BETALT';
    try {
        var data = await apiFetch('/bons?date=' + _mbDateMode + '&status=' + statuses + '&limit=500');
        _mbDateModeBons = Array.isArray(data) ? data : (data.bons || []);
    } catch (e) {
        _mbDateModeBons = [];
    }
    _mbRenderDateModeList();
    _mbSetupPullToRefresh();
}

function _mbRenderDateModeHeader() {
    var parts = _mbDateMode.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    var days = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
    var label = days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
    var today = new Date(); today.setHours(0,0,0,0);
    var iso = _mbDateMode;
    var todayIso = _mbIsoDate(today);
    var hint = '';
    if (iso === todayIso) hint = 'I dag';
    else if (iso === _mbIsoDate(new Date(today.getTime() + 86400000))) hint = 'I morgen';
    else if (iso === _mbIsoDate(new Date(today.getTime() - 86400000))) hint = 'I går';

    return (
        '<div class="m-datemode-header">' +
            '<button class="m-detail-back" id="mbDateBack" aria-label="Tilbage til overblik">&#8249;</button>' +
            '<div class="m-datemode-title">' +
                '<div class="m-datemode-date">' + _mbEsc(label) + '</div>' +
                (hint ? '<div class="m-datemode-hint">' + hint + '</div>' : '') +
            '</div>' +
        '</div>'
    );
}

function _mbAttachDateModeHandlers() {
    var back = document.getElementById('mbDateBack');
    if (back) {
        back.addEventListener('click', function() {
            _mbDateMode = null;
            var params = new URLSearchParams(window.location.search);
            params.delete('bon_date');
            params.set('view', 'oversigt');
            history.pushState(null, '', '?' + params.toString());
            if (window._mSwitchView) window._mSwitchView('oversigt');
        });
    }
}

function _mbRenderDateModeList() {
    var list = document.getElementById('mbList');
    if (!list) return;

    if (!_mbDateModeBons.length) {
        list.innerHTML = '<div class="m-bon-empty">Ingen bons denne dag</div>';
        return;
    }

    var bons = _mbDateModeBons.slice().sort(function(a, b) {
        return (a.delivery_time || '').localeCompare(b.delivery_time || '');
    });

    var html = '';
    bons.forEach(function(bon) {
        var s = _mbStatusStyle(bon.status_code || bon.status);
        var name = bon.contact_name_full || bon.customer_name || bon.company_name || 'Ukendt';
        var sub = '#' + (bon.bon_number || bon.id);
        if (bon.total_units) sub += ' · ' + bon.total_units + ' enh.';
        else if (bon.pax) sub += ' · ' + bon.pax + ' pax';

        html +=
            '<div class="m-bon-item" data-id="' + bon.id + '">' +
                _mbTimeBlock(bon) +
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
        var name = bon.contact_name_full || bon.customer_name || bon.company_name || 'Ukendt';
        var sub = '#' + (bon.bon_number || bon.id);
        if (bon.total_units) sub += ' · ' + bon.total_units + ' enh.';
        else if (bon.pax) sub += ' · ' + bon.pax + ' pax';

        html +=
            '<div class="m-bon-item" data-id="' + bon.id + '">' +
                _mbTimeBlock(bon) +
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
        groups[key].sort(_mbCompareByDelivery);
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
            // kontakt@-mail har ingen bon → udvid kortet inline i stedet.
            if (el.dataset.eventType === 'kontakt_mail') {
                el.classList.toggle('expanded');
                return;
            }
            _mbFromSearch = false;
            // Når man trykker på en ulæst mail → spring direkte til mailflowet.
            var focusMail = el.dataset.eventType === 'unread_mail';
            _mbShowDetail(parseInt(el.dataset.bonId), { focusMail: focusMail });
        });
    });

    list.querySelectorAll('.m-nye-markread').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();   // åbn ikke bonen
            _mbMarkNyeMailRead(parseInt(btn.dataset.bonId), parseInt(btn.dataset.mailId), btn);
        });
    });

    list.querySelectorAll('.m-nye-kontaktread').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();   // udvid ikke kortet
            _mbMarkKontaktRead(btn.dataset.mailKind, parseInt(btn.dataset.mailId), btn);
        });
    });
}

/* Markér en kontakt@-mail som håndteret direkte fra Nyt-listen.
 * thread-mail → PATCH /mail/message/:id/read (is_read=1)
 * ufordelt post → POST /mail/unmatched/:id/dismiss (status='ignored')
 * Begge fjerner eventet lokalt + opdaterer badge; server broadcaster så
 * office-visningerne holdes i sync. */
async function _mbMarkKontaktRead(kind, mailId, btn) {
    if (!mailId) return;
    btn.disabled = true;
    btn.innerHTML = 'Markerer…';
    try {
        if (kind === 'unmatched') {
            await apiFetch('/mail/unmatched/' + mailId + '/dismiss', { method: 'POST' });
        } else {
            await apiFetch('/mail/message/' + mailId + '/read', { method: 'PATCH' });
        }
        _mbNyeEvents = _mbNyeEvents.filter(function(ev) {
            return !(ev.event_type === 'kontakt_mail' && ev.mail
                     && ev.mail.id === mailId && ev.mail_kind === kind);
        });
        _mbNyeCount = Math.max(0, _mbNyeCount - 1);
        _mbRenderNye();
        _mbUpdateBadges(_mbNyeCount);
        if (window._mToast) window._mToast(kind === 'unmatched' ? 'Mail håndteret' : 'Mail markeret som læst');
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '&#10003; Markér læst';
        if (window._mToast) window._mToast('Fejl — prøv igen');
    }
}

/* Markér én ulæst mail som læst direkte fra Nyt-listen. Fjerner eventet
 * lokalt (kortet forsvinder med det samme) og opdaterer badge-tæller.
 * Server broadcaster bon_updated → SSE holder de øvrige views i sync. */
async function _mbMarkNyeMailRead(bonId, mailId, btn) {
    if (!bonId || !mailId) return;
    btn.disabled = true;
    btn.innerHTML = 'Markerer…';
    try {
        await apiFetch('/bons/' + bonId + '/mail/' + mailId + '/read', { method: 'PATCH' });
        _mbNyeEvents = _mbNyeEvents.filter(function(ev) {
            return !(ev.event_type === 'unread_mail' && ev.mail && ev.mail.id === mailId);
        });
        _mbNyeCount = Math.max(0, _mbNyeCount - 1);
        _mbRenderNye();
        _mbUpdateBadges(_mbNyeCount);
        if (window._mToast) window._mToast('Mail markeret som læst');
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '&#10003; Markér læst';
        if (window._mToast) window._mToast('Fejl — prøv igen');
    }
}

// kontakt@-mail har ingen bon at åbne → eget kort med udvid-i-stedet-for-naviger
// + "Markér læst" (jf. brugervalg: "Udvid + Markér læst").
var _MB_KONTAKT_BADGE = {
    supplier:       { bg: '#e3edf7', text: '#2c5d8a' },
    customer:       { bg: '#e6f3ea', text: '#2e6b3f' },
    purchase_order: { bg: '#efe7f5', text: '#6a3d8a' },
    unmatched:      { bg: '#fbeed9', text: '#9a6212' },
    thread:         { bg: '#eceae7', text: '#6b6258' },
};

function _mbRenderKontaktCard(ev) {
    var mail = ev.mail || {};
    var badge = _MB_KONTAKT_BADGE[ev.entity_type] || _MB_KONTAKT_BADGE.thread;
    var mailIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>' +
        '<polyline points="22,6 12,13 2,6"/></svg>';

    var subject = mail.subject || '(uden emne)';
    var fromStr = mail.from_name ? (mail.from_name + ' <' + (mail.from_address || '') + '>')
                                 : (mail.from_address || '');
    var whenStr = _mbFormatRelative(ev.event_at);

    var html =
        '<div class="m-bon-item m-bon-nye m-bon-kontakt unseen mail"' +
            ' data-event-type="kontakt_mail"' +
            ' data-mail-kind="' + (ev.mail_kind || 'thread') + '"' +
            ' data-mail-id="' + mail.id + '">' +
            '<div class="m-bon-row1">' +
                '<span class="m-bon-source">' + mailIcon + ' kontakt@</span>' +
                '<span class="m-bon-badge" style="background:' + badge.bg + ';color:' + badge.text + '">' +
                    _mbEsc(ev.entity_label || 'Mail') + '</span>' +
            '</div>' +
            '<div class="m-bon-customer">' + _mbEsc(subject) + '</div>';

    if (fromStr) html += '<div class="m-bon-mail-from">Fra: ' + _mbEsc(fromStr) + '</div>';
    if (mail.preview) html += '<div class="m-bon-mail-preview">"' + _mbEsc(mail.preview) + '"</div>';

    html +=
            '<div class="m-bon-meta-line"><span class="m-bon-when">' + _mbEsc(whenStr) + '</span></div>' +
            '<div class="m-nye-actions">' +
                '<button class="m-nye-kontaktread" data-mail-kind="' + (ev.mail_kind || 'thread') +
                    '" data-mail-id="' + mail.id + '">&#10003; Markér læst</button>' +
            '</div>' +
        '</div>';

    return html;
}

function _mbRenderNyeCard(ev) {
    if (ev.event_type === 'kontakt_mail') return _mbRenderKontaktCard(ev);

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

    var name = bon.contact_name_full || bon.customer_name || bon.company_name || 'Ukendt';
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
            '<div class="m-bon-meta-line">' + _mbEsc(metaLine) + '</div>';

    // Ulæst mail → hurtig "Markér læst" direkte fra Nyt-listen, så kortet
    // forsvinder uden at man først skal åbne bonen.
    if (isMail && mail) {
        html +=
            '<div class="m-nye-actions">' +
                '<button class="m-nye-markread" data-bon-id="' + bon.id +
                    '" data-mail-id="' + mail.id + '">' +
                    '&#10003; Markér læst' +
                '</button>' +
            '</div>';
    }

    html += '</div>';

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
        // event_at er UTC (CURRENT_TIMESTAMP) — parseServerDate tilføjer 'Z'.
        var t = (typeof parseServerDate === 'function') ? parseServerDate(ev.event_at) : new Date(ev.event_at.replace(' ', 'T') + 'Z');
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

// Sortér events efter leveringsdato (+ -tid). Events uden dato lægges nederst.
function _mbCompareByDelivery(a, b) {
    var ad = (a.bon && a.bon.delivery_date) || '';
    var bd = (b.bon && b.bon.delivery_date) || '';
    if (ad !== bd) {
        if (!ad) return 1;
        if (!bd) return -1;
        return ad < bd ? -1 : 1;
    }
    var at = (a.bon && a.bon.delivery_time) || '';
    var bt = (b.bon && b.bon.delivery_time) || '';
    if (at === bt) return 0;
    if (!at) return 1;
    if (!bt) return -1;
    return at < bt ? -1 : 1;
}

function _mbFormatRelative(iso) {
    if (!iso) return '';
    // UTC-timestamp (CURRENT_TIMESTAMP) — parseServerDate tilføjer 'Z'.
    var t = (typeof parseServerDate === 'function') ? parseServerDate(iso) : new Date(iso.replace(' ', 'T') + 'Z');
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
        var name = bon.contact_name_full || bon.customer_name || bon.company_name || 'Ukendt';
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
async function _mbShowDetail(bonId, opts) {
    opts = opts || {};
    _mbContainer.innerHTML = '<div class="m-loading">Henter bon...</div>';

    var params = new URLSearchParams(window.location.search);
    params.set('bon', bonId);
    history.pushState(null, '', '?' + params.toString());

    var unreadMails = [];
    var threads = [];
    try {
        var results = await Promise.all([
            apiFetch('/bons/' + bonId),
            apiFetch('/bons/' + bonId + '/mail').catch(function() { return { threads: [] }; })
        ]);
        _mbDetailBon = results[0];
        threads = (results[1] && results[1].threads) || [];
        threads.forEach(function(t) {
            (t.messages || []).forEach(function(m) {
                if (m.direction === 'in' && !m.is_read) unreadMails.push(m);
            });
        });
    } catch (e) {
        _mbContainer.innerHTML = '<div class="m-bon-empty">Kunne ikke hente bon</div>';
        return;
    }

    var hasMail = threads.some(function(t) { return (t.messages || []).length > 0; });

    var bon = _mbDetailBon;
    var s = _mbStatusStyle(bon.status_code || bon.status);

    var html =
        '<div class="m-detail-header">' +
            '<button class="m-detail-back" id="mbBack">&#8249;</button>' +
            '<div class="m-detail-title">#' + (bon.bon_number || bon.id) + '</div>' +
            '<span class="m-bon-badge" style="background:' + s.bg + ';color:' + s.text + '">' + s.label + '</span>' +
        '</div>';

    // Ulæst mail-banner: dukker op når der er indgående mails der ikke er læst.
    // "Markér som læst" PATCH'er hver besked → bonen forsvinder fra Nye-listen.
    if (unreadMails.length) {
        var ids = unreadMails.map(function(m) { return m.id; }).join(',');
        var label = unreadMails.length === 1
            ? '1 ulæst mail på denne bon'
            : unreadMails.length + ' ulæste mails på denne bon';
        html +=
            '<div class="m-mail-banner" data-mail-ids="' + ids + '">' +
                '<div class="m-mail-banner-text">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                        '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>' +
                        '<polyline points="22,6 12,13 2,6"/>' +
                    '</svg>' +
                    '<span>' + label + '</span>' +
                '</div>' +
                '<button class="m-mail-banner-btn" id="mbMarkMailRead">✓ Markér som læst</button>' +
            '</div>';
    }

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

    if (bon.customer_wishes) {
        html += '<div class="m-detail-section">';
        html += '<details class="m-detail-collapse">';
        html += '<summary><span class="m-detail-label">Kundeønsker</span><span class="m-detail-chevron">▾</span></summary>';
        html += '<div class="m-detail-value m-detail-pre">' + _mbEsc(bon.customer_wishes) + '</div>';
        html += '</details>';
        html += '</div>';
    }

    if (hasMail) {
        html += '<div class="m-detail-section m-mail-section" id="mbMailSection">';
        html += '<div class="m-detail-label">Mailflow</div>';
        html += '<div id="mbMailThread"></div>';
        html += '<div class="m-mail-reply" id="mbMailReply"></div>';
        html += '</div>';
    }

    html += '<div class="m-status-actions" id="mbStatusActions"></div>';

    _mbContainer.innerHTML = html;

    if (hasMail) {
        _mbRenderMailSection(bon, threads);
        // Kommer man fra en ulæst mail i Nye → scroll ned til mailflowet,
        // så man ikke skal forbi alle bon-detaljer for at finde beskeden.
        if (opts.focusMail) {
            var mailSec = document.getElementById('mbMailSection');
            if (mailSec) requestAnimationFrame(function() {
                mailSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    }

    document.getElementById('mbBack').addEventListener('click', function() {
        var p = new URLSearchParams(window.location.search);
        p.delete('bon');
        history.pushState(null, '', '?' + p.toString());
        // Hvis vi er i dato-mode (kommer fra Overblik) → tilbage dertil
        if (_mbDateMode) {
            _mbLoadDateMode();
        } else if (_mbFromSearch && _mbSearchActive) {
            _mbLoadList();
        } else {
            _mbLoadList();
        }
    });

    var markBtn = document.getElementById('mbMarkMailRead');
    if (markBtn) {
        markBtn.addEventListener('click', function() { _mbMarkMailsRead(bon.id, markBtn); });
    }

    _mbLoadTransitions(bon);
}

/* ──────────────────────────────────────────────────────────
 * Mail-sektion på bon-detalje. Bruger den fælles MailThread-
 * komponent + en svar-formular der POSTer til /api/bons/:id/mail.
 * Genbruger PATCH /:id/mail/:msgId/read som onMarkRead-callback
 * så ulæste mails bliver markeret når brugeren folder dem ud.
 * ────────────────────────────────────────────────────────── */
function _mbRenderMailSection(bon, threads) {
    var host = document.getElementById('mbMailThread');
    if (!host || !window.MailThread) return;

    MailThread.renderHistory(host, {
        threads: threads,
        emptyText: 'Ingen mails endnu',
        maxHeight: 360,
        expandUnread: true,
        onMarkRead: function(msgId) {
            return apiFetch('/bons/' + bon.id + '/mail/' + msgId + '/read', { method: 'PATCH' });
        }
    });

    // Find seneste indgående mail til at pre-fylde svaret.
    var allMsgs = [];
    threads.forEach(function(t) {
        (t.messages || []).forEach(function(m) {
            var mm = Object.assign({}, m);
            mm._thread = t;
            allMsgs.push(mm);
        });
    });
    var lastIn = allMsgs
        .filter(function(m) { return m.direction === 'in' && m.from_email; })
        .sort(function(a, b) {
            return String(b.received_at || b.created_at || '')
                .localeCompare(String(a.received_at || a.created_at || ''));
        })[0];

    var lastAny = allMsgs.sort(function(a, b) {
        return String(b.received_at || b.sent_at || b.created_at || '')
            .localeCompare(String(a.received_at || a.sent_at || a.created_at || ''));
    })[0];

    var defaultTo = (lastIn && lastIn.from_email)
        || bon.contact_email || bon.customer_email || '';
    var lastSubject = (lastIn && (lastIn.subject || (lastIn._thread && lastIn._thread.subject)))
        || (lastAny && (lastAny.subject || (lastAny._thread && lastAny._thread.subject)))
        || '';
    var defaultSubject = lastSubject
        ? (/^re:\s/i.test(lastSubject) ? lastSubject : 'Re: ' + lastSubject)
        : '';
    var inReplyTo = lastIn ? (lastIn.message_id_external || '') : '';

    var replyHost = document.getElementById('mbMailReply');
    if (!replyHost) return;

    replyHost.innerHTML =
        '<button type="button" class="m-mail-reply-toggle" id="mbReplyToggle">' +
            '✉ Svar på mailen' +
        '</button>' +
        '<form class="m-mail-reply-form" id="mbReplyForm" hidden>' +
            '<label class="m-mail-reply-label" id="mbReplyTemplateLabel" hidden>Skabelon</label>' +
            '<select id="mbReplyTemplate" hidden>' +
                '<option value="">— Ingen skabelon —</option>' +
            '</select>' +
            '<label class="m-mail-reply-label">Til</label>' +
            '<input type="email" id="mbReplyTo" value="' + _mbEsc(defaultTo) + '" placeholder="kunde@…">' +
            '<label class="m-mail-reply-label">Emne</label>' +
            '<input type="text" id="mbReplySubject" value="' + _mbEsc(defaultSubject) + '">' +
            '<label class="m-mail-reply-label">Besked</label>' +
            '<textarea id="mbReplyBody" rows="6" placeholder="Skriv dit svar…"></textarea>' +
            '<div class="m-mail-reply-actions">' +
                '<button type="button" class="m-mail-reply-cancel" id="mbReplyCancel">Annullér</button>' +
                '<button type="submit" class="m-mail-reply-send" id="mbReplySend">Send svar</button>' +
            '</div>' +
        '</form>';

    var toggle = document.getElementById('mbReplyToggle');
    var form   = document.getElementById('mbReplyForm');
    var cancel = document.getElementById('mbReplyCancel');

    toggle.addEventListener('click', function() {
        form.hidden = false;
        toggle.hidden = true;
        var bodyEl = document.getElementById('mbReplyBody');
        if (bodyEl) bodyEl.focus();
    });
    cancel.addEventListener('click', function() {
        form.hidden = true;
        toggle.hidden = false;
    });
    form.addEventListener('submit', function(ev) {
        ev.preventDefault();
        _mbSendReply(bon.id, inReplyTo);
    });

    _mbPopulateReplyTemplates(bon);
}

/* Henter mail-skabelonerne og fylder svar-formularens skabelon-dropdown.
 * Ved valg substitueres {{variabler}} (via MailThread.buildVars) ind i
 * emne + besked — så kan brugeren redigere inden afsendelse, præcis som i
 * office-draweren. Dropdownen skjules hvis der ingen skabeloner er. */
async function _mbPopulateReplyTemplates(bon) {
    var sel = document.getElementById('mbReplyTemplate');
    if (!sel) return;
    try {
        if (!_mbMailTemplates) _mbMailTemplates = await fetchMailTemplates();
    } catch (e) {
        return; // skabeloner er valgfri convenience — fejl skjules
    }
    var tmpls = _mbMailTemplates || [];
    // Formularen kan være re-renderet imens (anden bon) — tjek at den er der endnu.
    if (sel !== document.getElementById('mbReplyTemplate')) return;
    if (!tmpls.length) return;

    var lbl = document.getElementById('mbReplyTemplateLabel');
    if (lbl) lbl.hidden = false;
    sel.hidden = false;
    sel.innerHTML = '<option value="">— Ingen skabelon —</option>' +
        tmpls.map(function(t) {
            return '<option value="' + _mbEsc(t.key) + '">' + _mbEsc(t.label || t.key) + '</option>';
        }).join('');

    var vars = (window.MailThread && MailThread.buildVars) ? MailThread.buildVars(bon) : {};
    var subst = function(str) {
        var r = str || '';
        Object.keys(vars).forEach(function(k) {
            r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), vars[k] || '');
        });
        return r;
    };

    sel.addEventListener('change', function() {
        var key = sel.value;
        if (!key) return; // "Ingen skabelon" → behold hvad brugeren har skrevet
        var t = tmpls.find(function(x) { return x.key === key; });
        if (!t) return;
        var subjEl = document.getElementById('mbReplySubject');
        var bodyEl = document.getElementById('mbReplyBody');
        if (subjEl && t.subject) subjEl.value = subst(t.subject);
        if (bodyEl) bodyEl.value = subst(t.body_text);
    });
}

async function _mbSendReply(bonId, inReplyTo) {
    var toEl   = document.getElementById('mbReplyTo');
    var subjEl = document.getElementById('mbReplySubject');
    var bodyEl = document.getElementById('mbReplyBody');
    var sendBtn = document.getElementById('mbReplySend');
    if (!toEl || !subjEl || !bodyEl || !sendBtn) return;

    var to = (toEl.value || '').trim();
    var subject = (subjEl.value || '').trim();
    var text = (bodyEl.value || '').trim();
    if (!to)   { toEl.focus();   if (window._mToast) window._mToast('Mangler modtager'); return; }
    if (!text) { bodyEl.focus(); if (window._mToast) window._mToast('Mangler besked');   return; }

    sendBtn.disabled = true;
    var originalText = sendBtn.textContent;
    sendBtn.textContent = 'Sender…';
    try {
        await apiFetch('/bons/' + bonId + '/mail', {
            method: 'POST',
            body: JSON.stringify({ to: to, subject: subject, text: text, inReplyTo: inReplyTo || undefined })
        });
        if (window._mToast) window._mToast('Mail sendt ✓');
        await _mbShowDetail(bonId);
    } catch (e) {
        sendBtn.disabled = false;
        sendBtn.textContent = originalText;
        if (window._mToast) window._mToast((e && e.message) || 'Kunne ikke sende mailen');
    }
}

async function _mbMarkMailsRead(bonId, btn) {
    var banner = btn.closest('.m-mail-banner');
    var ids = (banner.dataset.mailIds || '').split(',').filter(Boolean).map(Number);
    if (!ids.length) return;
    btn.disabled = true;
    btn.textContent = 'Markerer…';
    try {
        // PATCH hver besked. Server broadcaster bon_updated → SSE-handler
        // re-loader detail-viewet og banneret forsvinder.
        for (var i = 0; i < ids.length; i++) {
            await apiFetch('/bons/' + bonId + '/mail/' + ids[i] + '/read', { method: 'PATCH' });
        }
        if (window._mToast) window._mToast('Mail markeret som læst');
        // Server broadcaster bon_updated for hver PATCH → mobile/index.html's
        // SSE-handler kalder _mScheduleNewBadgeReload automatisk. Vi reloader
        // bare detalje-viewet eksplicit her så banneret forsvinder med det
        // samme i stedet for at vente på SSE-debouncen.
        await _mbShowDetail(bonId);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = '✓ Markér som læst';
        if (window._mToast) window._mToast('Fejl — prøv igen');
    }
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

async function _mbChangeStatus(bonId, toCode, confirmNoInvoice) {
    try {
        var payload = { status_code: toCode, user_id: _mbUser.id };
        if (confirmNoInvoice) payload.confirm_no_invoice = true;
        await apiFetch('/bons/' + bonId + '/status', {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
        if (navigator.vibrate) navigator.vibrate(50);
        await _mbShowDetail(bonId);
        if (window._mToast) window._mToast('Status opdateret');
    } catch (e) {
        // Fakturavagt (#319): faktureret uden at der findes en faktura. Spørg én
        // gang og send igen — uden dette ville skiftet fejle med en intetsigende fejl.
        if (!confirmNoInvoice && e && e.code === 'NO_INVOICE_FOUND') {
            if (confirm('Der findes hverken en e-conomic-kladde eller en bogført faktura på denne bon.\n\n'
                        + 'Kunden har så aldrig fået en regning. Er det med vilje?')) {
                return _mbChangeStatus(bonId, toCode, true);
            }
            return;
        }
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
    if (p.get('view') !== 'bons') return;
    if (p.get('bon')) return; // detail håndteres separat
    _mbDetailBon = null;
    var bonDate = p.get('bon_date');
    if (bonDate) {
        _mbDateMode = bonDate;
        _mbLoadDateMode();
    } else if (_mbDateMode) {
        _mbDateMode = null;
        _mbLoadList();
    } else {
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
