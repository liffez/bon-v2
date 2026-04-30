/**
 * office/views/crm-firmaer.js
 * ════════════════════════════════════════════════════════════
 * Listview af firmaer med aggregeret statistik (kunder, bons, omsætning).
 * Klik på firma → cross-link til Firma 360° (Fase 6) via
 *   ?view=kontakter&tab=firmaer&company=ID
 *
 * Filtre:
 *   • Stage (alle | aktive | sovende | VIP)
 *   • Søgning på navn / CVR / legal_name
 *
 * Henter fra GET /api/crm/companies.
 * ════════════════════════════════════════════════════════════
 */

let _cfState = {
    container: null,
    companies: [],
    stage: 'all',
    q: '',
    loading: false,
    debounceTimer: null,
};

function initCrmFirmaer(container, opts = {}) {
    _cfState.container = container;
    _cfState.opts = opts;

    container.innerHTML = `
        <div class="cf-wrap">
            <div class="cf-toolbar">
                <div class="cf-stage-filters">
                    <button class="cf-chip active" data-stage="all">Alle</button>
                    <button class="cf-chip" data-stage="active">Aktive</button>
                    <button class="cf-chip" data-stage="vip">⭐ VIP</button>
                    <button class="cf-chip" data-stage="dormant">Sovende</button>
                </div>
                <input class="cf-search" type="search" placeholder="Søg firma, CVR eller juridisk navn…" />
            </div>
            <div class="cf-status" id="cf-status"></div>
            <div class="cf-list" id="cf-list"></div>
        </div>
    `;

    // Stage-filter
    container.querySelectorAll('.cf-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.cf-chip').forEach(b =>
                b.classList.toggle('active', b === btn)
            );
            _cfState.stage = btn.dataset.stage;
            cfLoad();
        });
    });

    // Søgning
    const searchEl = container.querySelector('.cf-search');
    searchEl.addEventListener('input', () => {
        clearTimeout(_cfState.debounceTimer);
        _cfState.debounceTimer = setTimeout(() => {
            _cfState.q = searchEl.value.trim();
            cfLoad();
        }, 280);
    });

    cfLoad();
}

async function cfLoad() {
    const listEl = document.getElementById('cf-list');
    const statusEl = document.getElementById('cf-status');
    if (!listEl) return;

    _cfState.loading = true;
    statusEl.textContent = 'Henter firmaer…';
    statusEl.className = 'cf-status loading';

    try {
        const params = { limit: 100 };
        if (_cfState.stage !== 'all') params.stage = _cfState.stage;
        if (_cfState.q) params.q = _cfState.q;

        const rows = await fetchCrmCompanies(params);
        _cfState.companies = rows;
        cfRender(rows);
        statusEl.textContent = rows.length + ' firmaer';
        statusEl.className = 'cf-status';
    } catch (err) {
        console.error('crm-firmaer load failed:', err);
        statusEl.textContent = 'Fejl: ' + err.message;
        statusEl.className = 'cf-status error';
    } finally {
        _cfState.loading = false;
    }
}

function cfRender(rows) {
    const listEl = document.getElementById('cf-list');
    if (!rows || rows.length === 0) {
        listEl.innerHTML = `<div class="cf-empty">Ingen firmaer fundet.</div>`;
        return;
    }

    listEl.innerHTML = rows.map(co => {
        const stage = co.aggregated_stage || 'active';
        const stageLabel = stage === 'vip' ? '⭐ VIP'
                         : stage === 'dormant' ? 'Sovende' : 'Aktiv';
        const lastOrder = co.last_order_date
            ? `Senest: ${cfFormatDate(co.last_order_date)}`
            : 'Ingen ordrer';
        const enrichedNote = co.last_enriched_at
            ? `<span class="cf-enriched" title="Sidst beriget ${co.last_enriched_at}">⟳</span>`
            : '';
        const legalNote = co.legal_name && co.legal_name !== co.name
            ? `<div class="cf-legal">${escapeHtml(co.legal_name)}</div>`
            : '';
        const cvrCell = co.cvr ? `<span class="cf-cvr">CVR ${co.cvr}</span>` : '<span class="cf-cvr-empty">— uden CVR —</span>';

        return `
            <div class="cf-row" data-company-id="${co.id}">
                <div class="cf-main">
                    <div class="cf-name-row">
                        <span class="cf-name">${escapeHtml(co.name)}</span>
                        ${enrichedNote}
                        <span class="cf-stage cf-stage-${stage}">${stageLabel}</span>
                    </div>
                    ${legalNote}
                    <div class="cf-meta">
                        ${cvrCell}
                        <span class="cf-sep">·</span>
                        <span>${co.contact_count} kontakt${co.contact_count === 1 ? '' : 'er'}</span>
                    </div>
                </div>
                <div class="cf-stats">
                    <div class="cf-stat-row">
                        <span class="cf-stat-num">${co.total_orders}</span>
                        <span class="cf-stat-lbl">bons</span>
                    </div>
                    <div class="cf-stat-row">
                        <span class="cf-stat-num">${formatKr(co.total_revenue)}</span>
                        <span class="cf-stat-lbl">omsætning</span>
                    </div>
                </div>
                <div class="cf-trail">
                    <div class="cf-last">${lastOrder}</div>
                </div>
            </div>
        `;
    }).join('');

    listEl.querySelectorAll('.cf-row').forEach(el => {
        el.addEventListener('click', () => {
            const companyId = parseInt(el.dataset.companyId, 10);
            if (typeof window.openFirma360 === 'function') {
                window.openFirma360(companyId);
            } else {
                console.warn('openFirma360 ikke defineret');
            }
        });
    });
}

function cfFormatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatKr(n) {
    const v = Math.round(Number(n) || 0);
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.', ',') + ' mio kr';
    if (v >= 1000)    return (v / 1000).toFixed(0) + 'k kr';
    return v + ' kr';
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function cleanupCrmFirmaer() {
    if (_cfState.debounceTimer) clearTimeout(_cfState.debounceTimer);
    _cfState = {
        container: null, companies: [], stage: 'all', q: '',
        loading: false, debounceTimer: null,
    };
}

window.initCrmFirmaer = initCrmFirmaer;
window.cleanupCrmFirmaer = cleanupCrmFirmaer;
