/**
 * kitchen/later.js
 * ════════════════════════════════════════════════════════════
 * View-specifik logik for Køkken Senere.
 *
 * Afhænger af (skal loades først):
 *   BonConfig.js     → BON_CONFIG
 *   BonConfigBar.js  → VIEW_WINDOWS
 *   shared/utils.js  → statusToFrontend, statusToBackend, mapApiBonToCardData, …
 *   shared/api.js    → fetchBonsLater, patchBonStatus, patchBonPrep, …
 *   shared/bon_kort.js → createCard, buildStatusBar
 * ════════════════════════════════════════════════════════════
 */

/* Terminale statusser — bons med disse statusser hører ikke hjemme i viewet */
const TERMINAL_STATUSES = new Set(['lev', 'faktureret', 'betalt', 'afsluttet', 'aflyst']);

/* ══════════════════════════════════════════════════════════════
   PAGE INIT
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
    const currentUser = await checkAuth();
    if (!currentUser) return;
    renderKitchenTopbar(document.body, { user: currentUser });

    initFlyverBanner();
    try {
        const bons = await fetchBonsLater();
        renderLater(bons);
        updateCount();
        initSSE();
        scrollToBonHash();
    } catch (err) {
        console.error('Fejl ved indlæsning af bons:', err);
        document.getElementById('dateGroups').innerHTML =
            '<div class="empty-state">Kunne ikke hente kommende bons. Prøv igen.</div>';
    }
});

/* ══════════════════════════════════════════════════════════════
   RENDERING
   ══════════════════════════════════════════════════════════════ */

function renderLater(bons) {
    const dateGroupsEl  = document.getElementById('dateGroups');
    const tilbudEl      = document.getElementById('tilbudSection');
    dateGroupsEl.innerHTML = '';
    tilbudEl.innerHTML     = '';

    // Split ordrer og tilbud
    const ordrer = bons.filter(b => !b.is_offer);
    const tilbud = bons.filter(b => b.is_offer);

    // Gruppér ordrer efter delivery_date
    const groups = groupByDate(ordrer);

    if (groups.length === 0 && tilbud.length === 0) {
        dateGroupsEl.innerHTML = '<div class="empty-state">Ingen kommende bons de næste 28 dage.</div>';
        return;
    }

    // Render dato-sektioner
    for (const group of groups) {
        const section = buildDateSection(group.date, group.bons);
        dateGroupsEl.appendChild(section);
    }

    // Render tilbud-sektion
    if (tilbud.length > 0) {
        tilbudEl.appendChild(buildTilbudSection(tilbud));
    }
}

function groupByDate(bons) {
    const map = new Map();
    for (const bon of bons) {
        const key = bon.delivery_date;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(bon);
    }
    // Sorteret efter dato (allerede sorteret fra backend, men for safety)
    return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bons]) => ({ date, bons }));
}

function buildDateSection(dateStr, bons) {
    const section = document.createElement('div');
    section.className = 'date-section';
    section.dataset.date = dateStr;

    const header = document.createElement('div');
    header.className = 'date-header';
    header.innerHTML = `
        <span class="date-header-date">${formatDanishDate(dateStr)}</span>
        <span class="date-header-count">${bons.length} ${bons.length === 1 ? 'bon' : 'bons'}</span>
    `;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    for (const apiBon of bons) {
        const cardData = mapApiBonToCardData(apiBon);
        const card = createCard(cardData, 'kitchen-later');
        grid.appendChild(card);
    }
    section.appendChild(grid);

    return section;
}

function buildTilbudSection(tilbud) {
    const section = document.createElement('div');
    section.className = 'tilbud-section';

    const header = document.createElement('div');
    header.className = 'tilbud-header';
    header.innerHTML = `
        <span>Tilbud</span>
        <span class="tilbud-header-count">${tilbud.length} ${tilbud.length === 1 ? 'tilbud' : 'tilbud'}</span>
    `;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    for (const apiBon of tilbud) {
        const cardData = mapApiBonToCardData(apiBon);
        const card = createCard(cardData, 'kitchen-later');
        grid.appendChild(card);
    }
    section.appendChild(grid);

    return section;
}

/* ══════════════════════════════════════════════════════════════
   SSE — REALTIDSOPDATERINGER
   ══════════════════════════════════════════════════════════════ */

function initSSE() {
    connectSSE('/api/sse?client_id=' + getClientId(), {
        connected: () => {
            console.log('SSE tilsluttet (later)');
        },

        bon_status: (data) => {
            const card = document.getElementById('bon' + data.id);
            const newFe = statusToFrontend(data.new);

            if (card) {
                // Kort eksisterer allerede
                if (TERMINAL_STATUSES.has(newFe)) {
                    // Fjern kortet — status er terminal for dette view
                    card.remove();
                    removeEmptyDateSections();
                    updateCount();
                } else {
                    // Opdater status på kortet
                    card.dataset.status = newFe;
                    buildStatusBar(card);
                }
            }
            // Vi indsætter ikke nye kort via SSE — kræver fuld bon-data
            // Brugeren kan refreshe for at se nye bons
        },

        notification: (data) => {
            // Card-level alert
            const card = document.getElementById('bon' + data.id);
            if (card) {
                const alertsEl = card.querySelector('.bon-alerts');
                if (alertsEl) {
                    const n = data.notification;
                    const div = document.createElement('div');
                    div.className = 'bon-alert kitchen-info';
                    div.innerHTML = `<div class="bon-alert-label">Flyver</div>${esc(n.message)}`;
                    alertsEl.prepend(div);
                }
            }
            // Globalt flyver-banner
            handleFlyverSSE(data);
        },

        bon_updated: (data) => {
            fetchBon(data.id).then(apiBon => {
                const card = document.getElementById('bon' + data.id);
                if (!card) return;
                const cardData = mapApiBonToCardData(apiBon);
                const menuEl = card.querySelector('.select-mode-container');
                if (menuEl) menuEl.innerHTML = _buildMenu(cardData.menu, data.id);
                const unitsEl = card.querySelector('.unit-primary');
                if (unitsEl) unitsEl.textContent = cardData.units;
            }).catch(err => console.error('bon_updated fejl:', err));
        }
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
   HJÆLPEFUNKTIONER
   ══════════════════════════════════════════════════════════════ */

function removeEmptyDateSections() {
    document.querySelectorAll('.date-section').forEach(section => {
        const cards = section.querySelectorAll('.bon-card');
        if (cards.length === 0) section.remove();
    });
    // Også tilbud-sektion
    const tilbudEl = document.getElementById('tilbudSection');
    if (tilbudEl) {
        const cards = tilbudEl.querySelectorAll('.bon-card');
        if (cards.length === 0) tilbudEl.innerHTML = '';
    }
}

function updateCount() {
    const all = document.querySelectorAll('.bon-card');
    const n = all.length;
    const el = document.getElementById('laterCount');
    if (el) el.textContent = n + (n === 1 ? ' bon' : ' bons');
}

/* Sammentælling — nu i shared/bon_kort.js */
