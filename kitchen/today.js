/**
 * kitchen/today.js
 * ════════════════════════════════════════════════════════════
 * View-specifik logik for Køkken I Dag.
 *
 * Afhænger af (skal loades først):
 *   BonConfig.js     → BON_CONFIG
 *   BonConfigBar.js  → VIEW_WINDOWS
 *   shared/utils.js  → statusToFrontend, statusToBackend, mapApiBonToCardData, …
 *   shared/api.js    → fetchBonsToday, patchBonStatus, …
 *   shared/bon_kort.js → createCard, buildStatusBar, updateCard
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════════
   PAGE INIT
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
    updateTodayHeader();
    startClock();
    initKiosk();
    try {
        const bons = await fetchBonsToday();
        renderBons(bons);
        updateCount();
        initSSE();
    } catch (err) {
        console.error('Fejl ved indlæsning af bons:', err);
        const grid = document.getElementById('cardsGrid');
        if (grid) grid.innerHTML = '<div style="padding:40px;color:#8a8580;font-size:15px">Kunne ikke hente dagens bons. Prøv igen.</div>';
    }
});

function renderBons(bons) {
    const grid = document.getElementById('cardsGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const apiBon of bons) {
        const cardData = mapApiBonToCardData(apiBon);
        const card = createCard(cardData, 'kitchen-today');
        grid.appendChild(card);
    }
}

function updateTodayHeader() {
    const el = document.getElementById('todayTitle');
    if (el) el.textContent = formatDanishDate(new Date().toISOString().slice(0, 10));
}

/* ══════════════════════════════════════════════════════════════
   UR — opdateres hvert minut
   ══════════════════════════════════════════════════════════════ */

function startClock() {
    const el = document.getElementById('todayClock');
    if (!el) return;

    function tick() {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
    }

    tick();
    // Synkronisér til næste hele minut, derefter hver 60 s
    const secsToNextMin = 60 - new Date().getSeconds();
    setTimeout(() => { tick(); setInterval(tick, 60000); }, secsToNextMin * 1000);
}

/* ══════════════════════════════════════════════════════════════
   KIOSK MODE — fullscreen, skjul topbar
   Toggle via KIOSK-knap eller URL-param ?kiosk
   ══════════════════════════════════════════════════════════════ */

function initKiosk() {
    // Auto-aktiver fra URL-param
    if (new URLSearchParams(location.search).has('kiosk')) {
        enterKiosk();
    }

    // Knap-toggle
    const btn = document.querySelector('.kiosk-btn');
    if (btn) btn.addEventListener('click', toggleKiosk);

    // Lyt på fullscreen-ændringer (så kiosk deaktiveres ved Escape)
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            document.body.classList.remove('kiosk');
        }
    });
}

function toggleKiosk() {
    if (document.body.classList.contains('kiosk')) {
        exitKiosk();
    } else {
        enterKiosk();
    }
}

function enterKiosk() {
    document.body.classList.add('kiosk');
    if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
    }
}

function exitKiosk() {
    document.body.classList.remove('kiosk');
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
}

/* ══════════════════════════════════════════════════════════════
   SSE — REALTIDSOPDATERINGER
   ══════════════════════════════════════════════════════════════ */

// Undertryk SSE-opdateringer kort efter lokal fortryd for at undgå race condition
const _suppressSSE = {};

function initSSE() {
    connectSSE('/api/sse', {
        connected: () => {
            console.log('SSE tilsluttet');
        },

        bon_status: (data) => {
            // Spring over hvis bon har aktiv SSE-suppress (fortryd pågår)
            if (_suppressSSE[data.bon_id] && Date.now() - _suppressSSE[data.bon_id] < 3000) return;
            delete _suppressSSE[data.bon_id];

            const card = document.getElementById('bon' + data.bon_id);
            if (!card) return;
            const newFe = statusToFrontend(data.new);
            if (card.dataset.status === newFe) return; // Allerede opdateret lokalt
            card.dataset.status = newFe;
            buildStatusBar(card);
            if (newFe === 'lev') startLeveretFade(card);
            updateCount();
        },

        notification: (data) => {
            const card = document.getElementById('bon' + data.bon_id);
            if (!card) return;
            const alertsEl = card.querySelector('.bon-alerts');
            if (alertsEl) {
                const n = data.notification;
                const div = document.createElement('div');
                div.className = 'bon-alert kitchen-info';
                div.innerHTML = `<div class="bon-alert-label">Flyver</div>${esc(n.message)}`;
                alertsEl.prepend(div);
            }
        },

        bon_updated: (data) => {
            fetchBon(data.bon_id).then(apiBon => {
                const card = document.getElementById('bon' + data.bon_id);
                if (!card) return;
                const cardData = mapApiBonToCardData(apiBon);
                const menuEl = card.querySelector('.select-mode-container');
                if (menuEl) menuEl.innerHTML = _buildMenu(cardData.menu, data.bon_id);
                const unitsEl = card.querySelector('.unit-primary');
                if (unitsEl) unitsEl.textContent = cardData.units;
            }).catch(err => console.error('bon_updated fejl:', err));
        }
    });
}

/* ══════════════════════════════════════════════════════════════
   STATUS-SKIFT → API
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('bon:status-changed', async (e) => {
    const { id, oldStatus, newStatus } = e.detail;
    const card = document.getElementById('bon' + id);
    if (!card) return;

    // Leveret-fading
    if (newStatus === 'lev') {
        startLeveretFade(card);
    } else {
        cancelLeveretFade(card);
    }

    // Kald API
    try {
        await patchBonStatus(id, statusToBackend(newStatus));
    } catch (err) {
        console.error('Status-skift fejlede:', err);
        // Revert ved fejl
        card.dataset.status = oldStatus;
        buildStatusBar(card);
        cancelLeveretFade(card);
    }

    updateCount();
});

/* ══════════════════════════════════════════════════════════════
   LEVERET-FADING MED FORTRYD
   ══════════════════════════════════════════════════════════════ */

const _fadeTimers    = {};
const _fadeCdTimers  = {};

function startLeveretFade(card) {
    const cardId = card.id;
    const num    = cardId.replace('bon', '');

    // Ryd evt. eksisterende timers (undgå dobbelt-fade ved SSE)
    clearTimeout(_fadeTimers[cardId]);
    clearInterval(_fadeCdTimers[cardId]);

    card.classList.add('leveret-fading');

    let secs = 8;
    const cdEl = document.getElementById('cd' + num);
    if (cdEl) cdEl.textContent = secs;

    _fadeCdTimers[cardId] = setInterval(() => {
        secs--;
        if (cdEl) cdEl.textContent = secs;
        if (secs <= 0) clearInterval(_fadeCdTimers[cardId]);
    }, 1000);

    _fadeTimers[cardId] = setTimeout(() => {
        clearInterval(_fadeCdTimers[cardId]);
        card.style.transition = 'opacity 0.5s, transform 0.5s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        setTimeout(() => {
            card.style.display = 'none';
            updateCount();
        }, 520);
    }, 8000);
}

function cancelLeveretFade(card) {
    const cardId = card.id;
    clearTimeout(_fadeTimers[cardId]);
    clearInterval(_fadeCdTimers[cardId]);
    card.classList.remove('leveret-fading');
    card.style.opacity = '';
    card.style.transform = '';
    card.style.display = '';
}

/** Fortryd levering — kaldt fra fortryd-overlay onclick */
function fortrydLevering(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;

    const id = cardId.replace('bon', '');

    // Undertryk SSE-events for denne bon i 3 sek (undgå at gammel LEVERET-event overskriver fortryd)
    _suppressSSE[id] = Date.now();

    cancelLeveretFade(card);

    // Sæt status tilbage til igang
    card.dataset.status = 'igang';
    buildStatusBar(card);
    updateCount();
    patchBonStatus(id, statusToBackend('igang')).catch(err => {
        console.error('Fortryd-status fejlede:', err);
    });
}

/* ══════════════════════════════════════════════════════════════
   PREP-CHECKS → API
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('click', async (e) => {
    const badge = e.target.closest('.prep-badge');
    if (!badge) return;

    const card = badge.closest('.bon-card');
    if (!card) return;

    const bonId = card.id.replace('bon', '');

    // Toggle lokalt
    badge.classList.toggle('checked');

    // Læs begge badges
    const badges = card.querySelectorAll('.prep-badge');
    const ingredientsReady = badges[0]?.classList.contains('checked') || false;
    const suppliesReady    = badges[1]?.classList.contains('checked') || false;

    try {
        await patchBonPrep(bonId, ingredientsReady, suppliesReady);
    } catch (err) {
        console.error('Prep-opdatering fejlede:', err);
        badge.classList.toggle('checked'); // revert
    }
});

/* ══════════════════════════════════════════════════════════════
   SAMMENTÆLLING
   ══════════════════════════════════════════════════════════════ */

function showSummary(cardId) {
    const num    = cardId.replace('bon', '');
    const panel  = document.getElementById('summary' + num);
    const rows   = document.getElementById('summaryRows' + num);
    const isOpen = panel.classList.contains('open');

    // Luk alle andre
    document.querySelectorAll('.summary-panel.open').forEach(p => p.classList.remove('open'));
    if (isOpen) return;

    // Tæl varer op
    const totals = {};
    const card   = document.getElementById(cardId);
    card.querySelectorAll('.bon-menu-item').forEach(item => {
        const qtyEl  = item.querySelector('.bon-menu-qty');
        const nameEl = item.querySelector('.bon-menu-name');
        if (!qtyEl || !nameEl) return;
        const qtyText = qtyEl.textContent.trim();
        const name    = nameEl.textContent.trim();
        const match   = qtyText.match(/^([\d.,]+)\s*(.*)$/);
        const qty     = match ? parseFloat(match[1].replace(',', '.')) : 0;
        const unit    = match ? match[2].trim() : '';
        const cat     = item.classList.contains('emballage') ? 'emballage' : 'menu';
        const key     = name + '||' + unit + '||' + cat;
        if (totals[key]) totals[key].qty += qty;
        else totals[key] = { qty, unit, name, cat };
    });

    const entries = Object.values(totals);
    if (!entries.length) {
        rows.innerHTML = '<div class="summary-row"><span style="color:var(--gray-dark);font-style:italic;font-size:13px;padding:4px 0">Ingen varer</span></div>';
    } else {
        entries.sort((a, b) => {
            if (a.cat !== b.cat) return a.cat === 'emballage' ? 1 : -1;
            return a.name.localeCompare(b.name, 'da');
        });
        rows.innerHTML = entries.map(e => {
            const qtyStr = Number.isInteger(e.qty) ? e.qty : e.qty.toFixed(1);
            return `<div class="summary-row">
                <span class="summary-qty">${qtyStr} ${e.unit}</span>
                <span class="summary-name">${esc(e.name)}</span>
                ${e.cat === 'emballage' ? '<span class="summary-cat">emballage</span>' : ''}
            </div>`;
        }).join('');
    }
    panel.classList.add('open');
}

function closeSummary(cardId) {
    const num = cardId.replace('bon', '');
    document.getElementById('summary' + num)?.classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   FILTER-SYSTEM (tap=peek 8s, hold=lock)
   ══════════════════════════════════════════════════════════════ */

const HOLD_MS = 600;
const PEEK_SEC = 8;

const holdTimers   = {};
const peekTimers   = {};
const filterLocked = { igang: false, klar: false, lev: false };
const filterPeek   = { igang: false, klar: false, lev: false };

function btnId(f) { return document.getElementById('btn' + f.charAt(0).toUpperCase() + f.slice(1)); }

function applyFilter(f, on) {
    const body = document.body;
    if (f === 'lev') {
        body.classList.toggle('show-lev', on);
        // Ryd inline styles sat af leveret-fading, så CSS-reglen kan vise kortene
        if (on) {
            document.querySelectorAll('.bon-card[data-status="lev"]').forEach(c => {
                c.style.display = '';
                c.style.opacity = '';
                c.style.transform = '';
                c.classList.remove('leveret-fading');
            });
        }
    } else if (f === 'igang') {
        body.classList.toggle('filter-igang', on);
        // Unlocks klar if locked
        if (on) { filterLocked.klar = false; filterPeek.klar = false; applyFilter('klar', false); btnId('klar').classList.remove('on-klar','peek-klar','locked','peek'); }
    } else if (f === 'klar') {
        body.classList.toggle('filter-klar', on);
        if (on) { filterLocked.igang = false; filterPeek.igang = false; applyFilter('igang', false); btnId('igang').classList.remove('on-igang','peek-igang','locked','peek'); }
    }
    const btn = btnId(f);
    if (on) btn.classList.add('on-' + f);
    else    btn.classList.remove('on-' + f);
}

function holdStart(f) {
    const wasLocked = filterLocked[f];
    holdTimers[f] = setTimeout(() => {
        holdTimers[f] = 'held';
        // Peeking? Cancel peek
        if (filterPeek[f]) { clearInterval(peekTimers[f]); filterPeek[f] = false; btnId(f).classList.remove('peek-' + f, 'peek'); }
        filterLocked[f] = !wasLocked;
        applyFilter(f, !wasLocked);
        btnId(f).classList.toggle('locked', !wasLocked);
    }, HOLD_MS);
}

function holdEnd(f) {
    if (holdTimers[f] === 'held') { holdTimers[f] = null; return; }
    clearTimeout(holdTimers[f]);
    holdTimers[f] = null;

    // Kort tryk → peek
    if (filterPeek[f]) { endPeek(f); return; } // Dobbelt-tap annullerer peek
    if (filterLocked[f]) { filterLocked[f] = false; applyFilter(f, false); btnId(f).classList.remove('locked'); return; }
    startPeek(f);
}

function holdCancel(f) {
    if (holdTimers[f] !== 'held') clearTimeout(holdTimers[f]);
    holdTimers[f] = null;
}

function startPeek(f) {
    filterPeek[f] = true;
    applyFilter(f, true);
    const btn = btnId(f);
    btn.classList.add('peek-' + f);
    btn.classList.remove('peek');
    void btn.offsetWidth;
    btn.classList.add('peek');

    let s = PEEK_SEC;
    peekTimers[f] = setInterval(() => {
        s--;
        if (s <= 0) endPeek(f);
    }, 1000);
}

function endPeek(f) {
    clearInterval(peekTimers[f]);
    filterPeek[f] = false;
    applyFilter(f, filterLocked[f]);
    const btn = btnId(f);
    btn.classList.remove('peek-' + f, 'peek');
    if (!filterLocked[f]) btn.classList.remove('on-' + f);
}

/* ══════════════════════════════════════════════════════════════
   COUNT BADGE
   ══════════════════════════════════════════════════════════════ */

function updateCount() {
    const all = document.querySelectorAll('.bon-card:not([data-status="lev"])');
    const n = [...all].filter(c => c.style.display !== 'none').length;
    const el = document.getElementById('todayCount');
    if (el) el.textContent = n + (n === 1 ? ' bon tilbage' : ' bons tilbage');

    // Leveret-tæller i VIS LEVEREDE-knap
    const levCards = document.querySelectorAll('.bon-card[data-status="lev"]');
    const levEl = document.getElementById('levCount');
    if (levEl) levEl.textContent = levCards.length > 0 ? '(' + levCards.length + ')' : '';
}
