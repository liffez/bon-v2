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
    // Fase 2 multi-select: id → { id, name }
    selected: new Map(),
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
            <div id="cf-select-bar"></div>
            <div class="cf-list" id="cf-list"></div>
        </div>
    `;
    cfEnsureSelectStyles();

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

        const isChecked = _cfState.selected.has(co.id) ? 'checked' : '';
        return `
            <div class="cf-row" data-company-id="${co.id}">
                <input type="checkbox" class="cf-row-check" ${isChecked} data-company-id="${co.id}">
                <div class="cf-main">
                    <div class="cf-name-row">
                        <span class="cf-name">${escapeHtml(co.name)}</span>
                        ${co.flag_count > 0 ? `<span class="cf-flag-badge" title="${co.flag_count} påmindels${co.flag_count === 1 ? 'e' : 'er'} på firmaet">🚩${co.flag_count > 1 ? co.flag_count : ''}</span>` : ''}
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

    // Klik på række = naviger til Firma 360°. Klik på checkbox = stopPropagation + toggle.
    listEl.querySelectorAll('.cf-row-check').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', (e) => {
            const cid = parseInt(e.target.dataset.companyId, 10);
            cfToggleSelect(cid, e.target.checked);
        });
    });
    listEl.querySelectorAll('.cf-row').forEach(el => {
        el.addEventListener('click', (e) => {
            // Lad checkbox-klik passere uden navigation
            if (e.target.closest('.cf-row-check')) return;
            const companyId = parseInt(el.dataset.companyId, 10);
            if (typeof window.openFirma360 === 'function') {
                window.openFirma360(companyId);
            } else {
                console.warn('openFirma360 ikke defineret');
            }
        });
    });

    cfRenderSelectBar();
}

// Fase 2: multi-select handlers
function cfToggleSelect(companyId, checked) {
    if (checked) {
        const co = _cfState.companies.find(c => c.id === companyId);
        if (co) _cfState.selected.set(companyId, { id: co.id, name: co.name });
    } else {
        _cfState.selected.delete(companyId);
    }
    cfRenderSelectBar();
}

function cfSelectAll() {
    for (const co of _cfState.companies) {
        if (!_cfState.selected.has(co.id)) {
            _cfState.selected.set(co.id, { id: co.id, name: co.name });
        }
    }
    cfRender(_cfState.companies); // re-render checkboxes
}

function cfClearSelection() {
    _cfState.selected.clear();
    cfRender(_cfState.companies);
}

function cfOpenAddToCampaign() {
    if (typeof window.AddToCampaignModal?.open !== 'function') {
        alert('Modal ikke loadet');
        return;
    }
    window.AddToCampaignModal.open({
        companies: Array.from(_cfState.selected.values()),
        customers: [],
        onDone: () => cfClearSelection(),
    });
}

function cfRenderSelectBar() {
    const bar = document.getElementById('cf-select-bar');
    if (!bar) return;
    const count = _cfState.selected.size;
    if (count === 0) {
        bar.innerHTML = '';
        return;
    }
    bar.innerHTML = `
        <div class="cf-select-content">
            <span class="cf-select-count">${count} valgt</span>
            <button class="cf-select-btn cf-select-btn-primary" data-action="add">+ Tilføj til kampagne</button>
            <button class="cf-select-btn" data-action="all">Vælg alle på siden</button>
            <button class="cf-select-btn" data-action="clear">Ryd valg</button>
        </div>
    `;
    bar.querySelector('[data-action="add"]')?.addEventListener('click', cfOpenAddToCampaign);
    bar.querySelector('[data-action="all"]')?.addEventListener('click', cfSelectAll);
    bar.querySelector('[data-action="clear"]')?.addEventListener('click', cfClearSelection);
}

function cfEnsureSelectStyles() {
    if (document.getElementById('cf-select-styles')) return;
    const s = document.createElement('style');
    s.id = 'cf-select-styles';
    s.textContent = `
        .cf-row { align-items: center; }
        .cf-row-check {
            width: 16px; height: 16px; margin-right: 12px;
            accent-color: var(--brand-primary, #8e631f); cursor: pointer; flex-shrink: 0;
        }
        .cf-select-content {
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            margin: 10px 0; padding: 10px 14px; border-radius: 10px;
            background: var(--brand-primary-light, #f1e6b2);
            border: 1px solid color-mix(in srgb, var(--brand-primary, #8e631f) 30%, transparent);
            font-size: 13px;
        }
        .cf-select-count { font-weight: 700; color: var(--brand-primary, #8e631f); }
        .cf-select-btn {
            padding: 6px 12px; border-radius: 6px; border: 1px solid var(--color-border, #d7d1ca);
            background: var(--color-surface, #fff); font-size: 13px; cursor: pointer;
            font-family: inherit;
        }
        .cf-select-btn:hover { filter: brightness(0.97); }
        .cf-select-btn-primary {
            background: var(--brand-primary, #8e631f); color: #fff; border-color: transparent;
            font-weight: 600;
        }
        .cf-select-btn-primary:hover { filter: brightness(1.08); }
    `;
    document.head.appendChild(s);
}

function cfFormatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function cleanupCrmFirmaer() {
    if (_cfState.debounceTimer) clearTimeout(_cfState.debounceTimer);
    _cfState = {
        container: null, companies: [], stage: 'all', q: '',
        loading: false, debounceTimer: null,
        selected: new Map(),
    };
}

window.initCrmFirmaer = initCrmFirmaer;
window.cleanupCrmFirmaer = cleanupCrmFirmaer;
