// office/views/crm-ringeliste.js
// ==========================================
// Fanebaseret "Ringeliste" (#232) — ét sted at gå hen for at ringe kunder
// igennem, med en fane pr. anledning (Sæson, Fast rytme, … flere følger).
// Hver fane er en instans af shared/crm_worklist.js — den delte komponent (#229)
// bærer al kort-/log-/snooze-/kampagne-mekanik. Denne fil er kun fane-skallen
// + liste-konfigurationerne.
// ==========================================

let _ringeContainer = null;
let _ringeActive = false;
let _ringeLists = null;    // [{ tab, wl }]
let _ringeIdx = 0;

const _RINGE_TAB_KEY = 'crm_ringeliste_tab';

function _ringeEsc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _ringeKr(v) {
    const n = Math.round(Number(v) || 0);
    return n.toLocaleString('da-DK') + ' kr';
}
function _ringeDate(iso) {
    if (!iso) return '?';
    const mnd = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getDate() + '. ' + mnd[d.getMonth()] + ' ' + d.getFullYear();
}

// ── Liste-konfigurationer ────────────────────────────────────
// Ny fane = ny post her. Ingen ny kode i selve komponenten.
function _ringeBuildLists() {
    if (!window.CrmWorklist) return [];

    const season = CrmWorklist.create({
        key: 'season',
        title: 'Sæson',
        subtitle: (n) => `${n} kunder bestilte på denne tid sidste år`,
        emptyText: 'Ingen sæson-emner lige nu. Kunder dukker op når de har en ordre for 10–14 måneder siden og ikke har bestilt de sidste 60 dage.',
        fetchRows: () => fetchCrmSeason(),
        purposeKey: 'saesonoutreach',
        campaignType: 'seasonal',
        contextName: 'Sæson',
        suggestedCampaignName: () => 'Sæson ' + new Date().getFullYear(),
        getPhone: (r) => r.phone,
        getCompanyId: (r) => r.company_id,
        buildMeta: (r) => `${_ringeEsc(r.company_name || 'Privat')} · ${r.pax || 0} pax · ${_ringeKr(r.total_price)}`,
        buildOpener: (r) => `Sidste år: ${r.pax || 0} pax d. ${_ringeDate(r.last_year_date)} for ${_ringeKr(r.total_price)}. Skal vi holde datoen igen i år?`,
    });

    const rytme = CrmWorklist.create({
        key: 'rytme',
        title: 'Fast rytme',
        subtitle: (n) => `${n} kunder er forsinket ift. deres eget bestillingssnit`,
        emptyText: 'Ingen forsinkede fast-rytme-kunder lige nu.',
        fetchRows: () => fetchCrmRytme(),
        purposeKey: 'fast_rytme',
        campaignType: 'rytme',
        contextName: 'Rytme',
        suggestedCampaignName: () => 'Fast rytme ' + new Date().toLocaleDateString('da-DK', { month: 'short', year: 'numeric' }),
        getPhone: (r) => r.phone,
        getCompanyId: (r) => r.company_id,
        buildMeta: (r) => `${_ringeEsc(r.company_name || 'Privat')} · ${r.order_count} ordrer · sidst ${_ringeDate(r.last_order)}`,
        buildOpener: (r) => `I plejer at bestille ca. hver ${Math.round(r.avg_interval_days)} dage — det er nu ${r.days_since} dage siden. Skal vi sætte en fast levering op?`,
    });

    const coldOffer = CrmWorklist.create({
        key: 'cold_offer',
        title: 'Kolde tilbud',
        subtitle: (n) => `${n} udløbne tilbud uden opfølgning`,
        emptyText: 'Ingen kolde tilbud lige nu. Udløbne, ubesvarede tilbud dukker op her.',
        fetchRows: () => fetchCrmColdOffers(),
        purposeKey: 'tilbud_opfoelgning',
        campaignType: null,   // per-tilbud opfølgning — ikke bulk-kampagne
        contextName: 'Kolde tilbud',
        getPhone: (r) => r.phone,
        getCompanyId: (r) => r.company_id,
        getBonId: (r) => r.bon_id,   // dedupe pr. tilbud
        buildMeta: (r) => `${_ringeEsc(r.company_name || 'Privat')} · tilbud ${_ringeEsc(r.bon_number)} · ${_ringeKr(r.total_price)}`,
        buildOpener: (r) => `Tilbud ${r.bon_number} på ${_ringeKr(r.total_price)} udløb ${_ringeDate(r.offer_valid_until)} uden svar. Skal vi følge op?`,
    });

    return [
        { tab: 'Sæson', wl: season },
        { tab: 'Fast rytme', wl: rytme },
        { tab: 'Kolde tilbud', wl: coldOffer },
    ];
}

function initCrmRingeliste(container) {
    _ringeContainer = container;
    _ringeActive = true;
    _ringeLists = _ringeBuildLists();

    if (!_ringeLists.length) {
        container.innerHTML = '<div style="padding:24px;color:#b00">Ringeliste-komponenten kunne ikke indlæses.</div>';
        return;
    }

    // Gendan sidst valgte fane
    const saved = localStorage.getItem(_RINGE_TAB_KEY);
    const savedIdx = _ringeLists.findIndex(l => l.wl.key === saved);
    _ringeIdx = savedIdx >= 0 ? savedIdx : 0;

    container.innerHTML = `
        <style>
        .ringe-wrap { padding: 24px; max-width: 900px; }
        .ringe-head h2 { margin: 0 0 2px; font-family: var(--font-heading, serif); }
        .ringe-head p { margin: 0 0 16px; color: #888; font-size: 13px; }
        .ringe-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--color-border, #d7d1ca); margin-bottom: 18px; }
        .ringe-tab { padding: 8px 16px; border: none; background: none; cursor: pointer; font-size: 14px;
                     color: #666; border-bottom: 2px solid transparent; font-family: inherit; margin-bottom: -1px; }
        .ringe-tab:hover { color: #333; }
        .ringe-tab.active { color: var(--brand-primary, #8e631f); border-bottom-color: var(--brand-primary, #8e631f); font-weight: 600; }
        </style>
        <div class="ringe-wrap">
            <div class="ringe-head">
                <h2>Ringeliste</h2>
                <p>Kunder du kan ringe til lige nu — vælg en anledning.</p>
            </div>
            <div class="ringe-tabs" id="ringe-tabs"></div>
            <div id="ringe-host"></div>
        </div>`;

    const tabsEl = container.querySelector('#ringe-tabs');
    tabsEl.innerHTML = _ringeLists.map((l, i) =>
        `<button class="ringe-tab ${i === _ringeIdx ? 'active' : ''}" data-idx="${i}">${_ringeEsc(l.tab)}</button>`
    ).join('');
    tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.ringe-tab');
        if (!btn) return;
        _ringeSwitch(parseInt(btn.dataset.idx, 10));
    });

    _ringeMountActive();
}

function _ringeMountActive() {
    if (!_ringeContainer) return;
    const host = _ringeContainer.querySelector('#ringe-host');
    if (!host) return;
    // Detach evt. select-mode fra forrige fane inden ny mount
    if (window.ListCampaignSelect) window.ListCampaignSelect.detach();
    _ringeLists[_ringeIdx].wl.mount(host);
    localStorage.setItem(_RINGE_TAB_KEY, _ringeLists[_ringeIdx].wl.key);
}

function _ringeSwitch(idx) {
    if (idx === _ringeIdx || idx < 0 || idx >= _ringeLists.length) return;
    _ringeLists[_ringeIdx].wl.unmount();
    _ringeIdx = idx;
    _ringeContainer.querySelectorAll('.ringe-tab').forEach((b, i) =>
        b.classList.toggle('active', i === _ringeIdx));
    _ringeMountActive();
}

// SSE fra office/index.html — videresend til den aktive fane.
function _ringeHandleSSE(event) {
    if (!_ringeActive || !_ringeLists) return;
    const cur = _ringeLists[_ringeIdx];
    if (cur && cur.wl) cur.wl.handleSSE(event);
}

function cleanupCrmRingeliste() {
    _ringeActive = false;
    if (_ringeLists && _ringeLists[_ringeIdx]) _ringeLists[_ringeIdx].wl.unmount();
    if (window.ListCampaignSelect) window.ListCampaignSelect.detach();
    _ringeContainer = null;
    _ringeLists = null;
}
