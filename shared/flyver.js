/**
 * shared/flyver.js
 * ════════════════════════════════════════════════════════════
 * Flyver-system: send + modtag urgente beskeder fra bons.
 *
 * API (globale funktioner):
 *   sendFlyver(cardId)              — åbner send-modal fra et bon-kort (action-bar)
 *   openFlyverComposer(bonId, nr)   — åbner send-modal direkte (bon-drawer m.fl.)
 *   initFlyverBanner()              — kald én gang ved page load
 *   handleFlyverSSE(data)           — kald fra SSE notification-handler
 *
 * Afhængigheder:
 *   shared/utils.js   → getClientId(), esc()
 *   shared/api.js     → postFlyver(), fetchUnreadNotifications(),
 *                        markNotificationRead(), fetchBon()
 *   shared/modal.js   → openModal(), closeModal()
 * ════════════════════════════════════════════════════════════
 */

/* ── Intern state ──────────────────────────────────────────── */

let _unreadQueue = [];     // Array af notification-objekter
let _bannerEl    = null;   // Banner DOM-element (persistent)
let _flyverIndex = 0;      // Aktuel position i kø (detail-modal)
let _flyverBonCache = {};  // bon_id → bon (hentet til detail-modalen)

/* ══════════════════════════════════════════════════════════════
   SEND FLYVER (action-button handler)
   ══════════════════════════════════════════════════════════════ */

function sendFlyver(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const bonId = cardId.replace('bon', '');
    const bonNr = card.querySelector('.bon-id')?.textContent?.trim() || '#' + bonId;
    openFlyverComposer(bonId, bonNr);
}

/**
 * \u00c5bner flyver-send-modalen direkte ud fra et bon-id.
 * Bruges hvor der ikke findes et bon-kort i DOM'en (fx bon-draweren).
 */
function openFlyverComposer(bonId, bonNr) {
    if (!bonId) return;
    bonNr = (bonNr ? String(bonNr) : '#' + bonId).trim();

    openModal({
        title: 'Send flyver \u2014 ' + esc(bonNr),
        bodyHtml: '<div class="flyver-send">'
            + '<textarea class="flyver-textarea" id="flyverMsg" '
            +     'placeholder="Skriv besked til k\u00f8kkenet\u2026" rows="3"></textarea>'
            + '<div class="flyver-send-actions">'
            +     '<button class="flyver-cancel-btn" onclick="closeModal()">Annuller</button>'
            +     '<button class="flyver-send-btn" id="flyverSendBtn" '
            +         'onclick="_doSendFlyver(\'' + bonId + '\')">'
            +         '\u2708 Send</button>'
            + '</div>'
            + '</div>',
    });

    requestAnimationFrame(() => {
        document.getElementById('flyverMsg')?.focus();
    });
}

async function _doSendFlyver(bonId) {
    const textarea = document.getElementById('flyverMsg');
    const btn      = document.getElementById('flyverSendBtn');
    const message  = textarea?.value?.trim();
    if (!message) { textarea?.focus(); return; }

    btn.disabled = true;
    btn.textContent = 'Sender\u2026';

    try {
        await postFlyver(bonId, message, getClientId());
        closeModal();
    } catch (err) {
        console.error('Flyver-fejl:', err);
        btn.textContent = 'Fejl \u2014 pr\u00f8v igen';
        btn.disabled = false;
    }
}

/* ══════════════════════════════════════════════════════════════
   BANNER — globalt notifikationsbar
   ══════════════════════════════════════════════════════════════ */

function initFlyverBanner() {
    if (!_bannerEl) {
        _bannerEl = document.createElement('div');
        _bannerEl.id = 'flyverBanner';
        _bannerEl.className = 'flyver-banner hidden';
        _bannerEl.addEventListener('click', _openFlyverModal);
        document.body.prepend(_bannerEl);
    }
    _loadUnread();
}

function _updateBanner() {
    if (!_bannerEl) return;
    if (_unreadQueue.length === 0) {
        _bannerEl.classList.add('hidden');
        return;
    }
    _bannerEl.classList.remove('hidden');
    if (_unreadQueue.length === 1) {
        _bannerEl.innerHTML = '<span class="flyver-banner-icon">\u2708</span>'
            + '<span class="flyver-banner-text">' + esc(_unreadQueue[0].message) + '</span>';
    } else {
        _bannerEl.innerHTML = '<span class="flyver-banner-icon">\u2708</span>'
            + '<span class="flyver-banner-text">' + _unreadQueue.length + ' beskeder</span>';
    }
}

async function _loadUnread() {
    try {
        const unread = await fetchUnreadNotifications(getClientId());
        _unreadQueue = unread;
        _updateBanner();
    } catch (err) {
        console.error('Kunne ikke hente ul\u00e6ste flyvere:', err);
    }
}

/* ══════════════════════════════════════════════════════════════
   SSE HANDLER (kaldes fra view-JS)
   ══════════════════════════════════════════════════════════════ */

function handleFlyverSSE(data) {
    // Ignorér egne flyvere
    if (data.sender_client_id === getClientId()) return;

    const notif = data.notification;
    if (!notif || notif.type !== 'flyver') return;

    // Tilføj til kø (undgå dubletter)
    if (!_unreadQueue.find(n => n.id === notif.id)) {
        // Tilføj bon_number fra SSE-data hvis muligt
        // Patch F: notification-event bruger nu {id} (bon-id'et) — ikke {bon_id}
        if (data.id && !notif.bon_number) {
            notif.bon_number = null; // hentes i detail-modal
        }
        _unreadQueue.unshift(notif);
    }
    _updateBanner();
}

/* ══════════════════════════════════════════════════════════════
   DETAIL-MODAL — vis + kvittér flyvere
   ══════════════════════════════════════════════════════════════ */

function _openFlyverModal() {
    if (_unreadQueue.length === 0) return;
    _flyverIndex = 0;
    _renderFlyverDetail();
}

async function _renderFlyverDetail() {
    const notif = _unreadQueue[_flyverIndex];
    if (!notif) { closeModal(); _updateBanner(); return; }

    const count = _unreadQueue.length;
    const pos   = _flyverIndex + 1;

    var navHtml = '';
    if (count > 1) {
        navHtml = '<div class="flyver-nav">'
            + '<button onclick="_flyverPrev()"' + (_flyverIndex === 0 ? ' disabled' : '') + '>\u2190 Forrige</button>'
            + '<span>' + pos + ' af ' + count + '</span>'
            + '<button onclick="_flyverNext()"' + (_flyverIndex >= count - 1 ? ' disabled' : '') + '>N\u00e6ste \u2192</button>'
            + '</div>';
    }

    var timeStr = '';
    if (notif.created_at) {
        timeStr = new Date(notif.created_at + 'Z').toLocaleString('da-DK', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });
    }

    openModal({
        title: '\u2708 Flyver' + (count > 1 ? ' (' + pos + '/' + count + ')' : ''),
        bodyHtml: '<div class="flyver-detail">'
            + '<div class="flyver-detail-time">' + timeStr + '</div>'
            + '<div class="flyver-detail-message">' + esc(notif.message) + '</div>'
            + '<div class="flyver-detail-bon" id="flyverBonData">Henter bon-data\u2026</div>'
            + navHtml
            + '<div class="flyver-detail-actions">'
            +     '<button class="flyver-goto-btn" onclick="_gotoFlyverBon(' + notif.bon_id + ')">'
            +         'G\u00e5 til bon \u2192</button>'
            +     '<button class="flyver-ack-btn" onclick="_ackFlyver(' + notif.id + ',' + notif.bon_id + ')">'
            +         'Forst\u00e5et</button>'
            + '</div>'
            + '</div>',
    });

    // Hent bon-data asynkront
    // Brug querySelector på .modal-overlay:last-of-type for at undgå
    // at ramme et element i en gammel modal der stadig fader ud (200ms delay)
    if (notif.bon_id) {
        try {
            const bon = await fetchBon(notif.bon_id);
            _flyverBonCache[notif.bon_id] = bon;
            const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
            const bonEl = overlay && overlay.querySelector('#flyverBonData');
            if (bonEl) bonEl.innerHTML = _buildFlyverBonSummary(bon);
        } catch (err) {
            const overlay = document.querySelector('.modal-overlay:last-of-type') || document.querySelector('.modal-overlay');
            const bonEl = overlay && overlay.querySelector('#flyverBonData');
            if (bonEl) bonEl.innerHTML = '<em>Kunne ikke hente bon-data</em>';
        }
    }
}

function _buildFlyverBonSummary(bon) {
    // Ens linjer slås sammen — se shared/bon_lines.js.
    var lines = BonLines.mergeLines(bon.lines || []).filter(function(l) { return !l.is_accessory; });
    var linesHtml = lines.map(function(l) {
        return '<div class="flyver-bon-line">' + l.quantity + '\u00d7 ' + esc(l.product_name) + '</div>';
    }).join('');

    var customerName = (bon.contact_name_full || '').trim();
    var companyName  = bon.company_name || '';
    var nameStr      = [customerName, companyName].filter(Boolean).join(' / ');

    var timeInfo = '';
    if (bon.delivery_time) timeInfo = ' kl. ' + bon.delivery_time;
    if (bon.pickup_time)   timeInfo = ' kl. ' + bon.pickup_time;

    return '<div class="flyver-bon-summary">'
        + '<div class="flyver-bon-header">'
        +     '<strong>' + esc(bon.bon_number) + '</strong>'
        +     (nameStr ? ' \u2014 ' + esc(nameStr) : '')
        +     timeInfo
        + '</div>'
        + '<div class="flyver-bon-lines">' + linesHtml + '</div>'
        + '</div>';
}

async function _gotoFlyverBon(bonId) {
    closeModal();

    var card = document.getElementById('bon' + bonId);
    if (card) {
        // Kortet kan være filtreret væk — en leveret bon ligger stadig i DOM'en
        // med display:none. Uden dette scroller vi til noget usynligt, og
        // knappen ser ud som om den ikke gjorde noget.
        if (typeof window.revealBonCard === 'function') window.revealBonCard(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flyver-highlight');
        setTimeout(function() { card.classList.remove('flyver-highlight'); }, 2000);
        return;
    }

    // Bonen er ikke på denne side.
    // Office har ingen kort-side — dér er draweren stedet at gå hen.
    if (!document.body.classList.contains('zone-kitchen')) { _openBonElsewhere(bonId); return; }

    // I køkkenet vil man se KORTET. Leveringsdatoen afgør hvilken side det står på.
    var bon = _flyverBonCache[bonId];
    if (!bon) {
        try { bon = await fetchBon(bonId); _flyverBonCache[bonId] = bon; } catch (err) { bon = null; }
    }
    var page = _kitchenPageForBon(bon);
    if (page) { _navigateToBon(page, bonId); return; }

    // Ukendt dato, eller en bon i fortiden som hverken står i I dag eller Senere
    _openBonElsewhere(bonId);
}

/** Hvilken køkken-side står bonens kort på? null hvis ingen af dem. */
function _kitchenPageForBon(bon) {
    var dato = bon && bon.delivery_date;
    if (!dato || typeof todayISO !== 'function') return null;
    var iDag = todayISO();
    if (dato === iDag) return '/kitchen/today.html';
    if (dato >  iDag)  return '/kitchen/later.html';
    return null;   // fortiden findes hverken i I dag eller Senere
}

/**
 * Naviger til en bon på en anden side.
 * Er vi allerede på siden, er et hash-skift ikke en navigation — så skal der
 * genindlæses, ellers sker der ingenting.
 */
function _navigateToBon(page, bonId) {
    if (window.location.pathname === page) {
        window.location.hash = 'bon' + bonId;
        window.location.reload();
    } else {
        window.location.href = page + '#bon' + bonId;
    }
}

/** Sidste udvej: vis bonen i sidens drawer. */
function _openBonElsewhere(bonId) {
    if (typeof window._bonInfoEditHandler === 'function') { window._bonInfoEditHandler(bonId); return; }
    if (typeof window.openDrawer === 'function') { window.openDrawer(bonId); return; }
    _navigateToBon('/kitchen/today.html', bonId);
}

function _flyverPrev() {
    if (_flyverIndex > 0) { _flyverIndex--; _renderFlyverDetail(); }
}

function _flyverNext() {
    if (_flyverIndex < _unreadQueue.length - 1) { _flyverIndex++; _renderFlyverDetail(); }
}

async function _ackFlyver(notifId, bonId) {
    try {
        await markNotificationRead(bonId, notifId, getClientId());
    } catch (err) {
        console.error('Kvittering fejlede:', err);
    }

    // Fjern fra lokal kø
    _unreadQueue = _unreadQueue.filter(function(n) { return n.id !== notifId; });

    if (_unreadQueue.length === 0) {
        closeModal();
        _updateBanner();
    } else {
        if (_flyverIndex >= _unreadQueue.length) _flyverIndex = _unreadQueue.length - 1;
        _renderFlyverDetail();
        _updateBanner();
    }
}
