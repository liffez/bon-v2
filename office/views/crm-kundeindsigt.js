// office/views/crm-kundeindsigt.js
// ==========================================
// RFM Dashboard med justerbare sliders,
// firmatabel og ICP-profil.
// ==========================================

let _kiContainer = null;
let _kiActive = false;
let _kiData = null;       // { rows, total, stages }
let _kiConfig = null;     // rfm_config array
let _kiIcp = null;
let _kiSort = 'rfm_total';
let _kiStageFilter = '';
let _kiSearch = '';
let _kiDebounce = null;

function initCrmKundeindsigt(container) {
    _kiContainer = container;
    _kiActive = true;
    container.innerHTML = _kiShellHtml();
    _kiWireEvents();
    _kiLoadAll();
}

function cleanupCrmKundeindsigt() {
    _kiActive = false;
    if (_kiDebounce) clearTimeout(_kiDebounce);
    _kiContainer = null;
}

function _kiHandleSSE(event) {
    if (!_kiActive) return;
    if (event === 'rfm_computed' || event === 'rfm_config_changed') {
        if (_kiDebounce) clearTimeout(_kiDebounce);
        _kiDebounce = setTimeout(() => _kiLoadAll(), 1000);
    }
}

// ─── Data loading ───────────────────────────────────────────

async function _kiLoadAll() {
    if (!_kiActive) return;
    try {
        const [scoresRes, config, icp] = await Promise.all([
            fetchRfmScores(Object.fromEntries(Object.entries({ sort: _kiSort, stage: _kiStageFilter || null, q: _kiSearch || null, limit: 500 }).filter(([,v]) => v != null))),
            fetchRfmConfig(),
            fetchRfmIcp('vip'),
        ]);
        _kiData = scoresRes;
        _kiConfig = config;
        _kiIcp = icp;
        _kiRender();
    } catch (err) {
        if (_kiContainer) _kiContainer.innerHTML = '<p style="color:red">Fejl: ' + err.message + '</p>';
    }
}

// ─── Rendering ──────────────────────────────────────────────

function _kiShellHtml() {
    return `
<style>
.ki-grid { display: grid; grid-template-columns: 300px 1fr; gap: 24px; padding: 24px; }
.ki-sidebar { display: flex; flex-direction: column; gap: 16px; }
.ki-panel { background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px; padding: 16px; }
.ki-panel h3 { margin: 0 0 12px; font-size: 14px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
.ki-slider-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ki-slider-row label { width: 80px; font-size: 13px; }
.ki-slider-row input[type=range] { flex: 1; }
.ki-slider-row .ki-val { width: 36px; text-align: right; font-size: 13px; font-weight: 600; }
.ki-btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.ki-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
.ki-btn-primary:hover { opacity: 0.9; }
.ki-btn-secondary { background: #f0ece6; color: #333; }
.ki-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.ki-stat { flex: 1; min-width: 80px; background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px; padding: 12px; text-align: center; }
.ki-stat-val { font-family: var(--font-heading, serif); font-size: 24px; font-weight: 700; }
.ki-stat-label { font-size: 11px; color: #888; margin-top: 2px; }
.ki-main { display: flex; flex-direction: column; gap: 16px; }
.ki-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ki-filters input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; }
.ki-stage-btn { padding: 4px 12px; border: 1px solid #ccc; border-radius: 16px; background: #fff; cursor: pointer; font-size: 12px; }
.ki-stage-btn.active { border-color: var(--brand-primary, #8e631f); background: var(--brand-primary-light, #f1e6b2); }
.ki-table-wrap { overflow-x: auto; }
.ki-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ki-table th { text-align: left; padding: 8px; border-bottom: 2px solid #ddd; cursor: pointer; white-space: nowrap; user-select: none; }
.ki-table th:hover { color: var(--brand-primary, #8e631f); }
.ki-table td { padding: 8px; border-bottom: 1px solid #eee; }
.ki-table tr:hover { background: #faf8f5; }
.ki-table .ki-bar { display: inline-block; height: 8px; border-radius: 4px; }
.ki-stage-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.ki-stage-vip { background: #f5f0e0; color: #8e631f; }
.ki-stage-active { background: #e8f2dc; color: #3d7a0a; }
.ki-stage-dormant { background: #f0eded; color: #888; }
.ki-stage-lead { background: #e0ecf5; color: #2a6fb0; }
.ki-lock { font-size: 10px; margin-left: 4px; }
.ki-icp { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ki-icp-item { }
.ki-icp-label { font-size: 11px; color: #888; }
.ki-icp-value { font-size: 16px; font-weight: 600; }
.ki-branch-list { list-style: none; padding: 0; margin: 8px 0 0; }
.ki-branch-list li { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; }
.ki-branch-bar { height: 6px; border-radius: 3px; background: var(--brand-primary, #8e631f); }
.ki-coverage { font-size: 12px; margin-top: 8px; padding: 8px; background: #f9f7f4; border-radius: 6px; }
.ki-computing { text-align: center; padding: 20px; color: #888; }
</style>
<div class="ki-grid">
    <div class="ki-sidebar" id="ki-sidebar"></div>
    <div class="ki-main" id="ki-main"></div>
</div>`;
}

function _kiRender() {
    if (!_kiActive || !_kiData) return;
    _kiRenderSidebar();
    _kiRenderMain();
}

function _kiRenderSidebar() {
    const el = document.getElementById('ki-sidebar');
    if (!el) return;

    const cfg = {};
    if (_kiConfig) for (const r of _kiConfig) cfg[r.key] = r.value;

    el.innerHTML = `
        <div class="ki-panel">
            <h3>RFM-vægte</h3>
            ${_kiSlider('w_r', 'Recency (R)', cfg.w_r || 35)}
            ${_kiSlider('w_f', 'Frequency (F)', cfg.w_f || 40)}
            ${_kiSlider('w_m', 'Monetary (M)', cfg.w_m || 25)}
            <div style="margin-top:8px;font-size:11px;color:#888">Normaliseres automatisk til 100%</div>
        </div>
        <div class="ki-panel">
            <h3>Tærskler</h3>
            ${_kiSlider('vip_pct', 'VIP (top %)', cfg.vip_pct || 15, 5, 30)}
            ${_kiSlider('aktiv_pct', 'Aktiv (top %)', cfg.aktiv_pct || 50, 20, 80)}
            ${_kiSlider('recency_days', 'Recency (dage)', cfg.recency_days || 180, 30, 730)}
        </div>
        <div class="ki-panel">
            <h3>Monetary-mål</h3>
            <div style="display:flex;gap:8px">
                <button class="ki-btn ${cfg.monetary_mode !== 'revenue' ? 'ki-btn-primary' : 'ki-btn-secondary'}"
                    onclick="_kiSetMonetary('pax')">Gæster</button>
                <button class="ki-btn ${cfg.monetary_mode === 'revenue' ? 'ki-btn-primary' : 'ki-btn-secondary'}"
                    onclick="_kiSetMonetary('revenue')">Omsætning</button>
            </div>
        </div>
        <button class="ki-btn ki-btn-primary" style="width:100%" onclick="_kiSaveAndCompute()">
            Gem &amp; genberegn
        </button>
        ${_kiIcp ? `
        <div class="ki-panel">
            <h3>ICP-profil (${_kiIcp.source === 'vip' ? 'VIP' : 'Top 25%'})</h3>
            <div class="ki-icp">
                <div class="ki-icp-item"><div class="ki-icp-label">Firmaer</div><div class="ki-icp-value">${_kiIcp.company_count || 0}</div></div>
                <div class="ki-icp-item"><div class="ki-icp-label">Gns. ordrer</div><div class="ki-icp-value">${_kiIcp.avg_orders || 0}</div></div>
                <div class="ki-icp-item"><div class="ki-icp-label">Gns. gæster</div><div class="ki-icp-value">${_kiIcp.avg_guests_per_event || 0}</div></div>
                <div class="ki-icp-item"><div class="ki-icp-label">Top kategori</div><div class="ki-icp-value">${_kiIcp.top_category || '—'}</div></div>
            </div>
            ${_kiIcp.top_branches?.length ? `
            <h3 style="margin-top:12px">Brancher</h3>
            <ul class="ki-branch-list">
                ${_kiIcp.top_branches.map(b => `
                    <li><span style="width:100px">${b.branch}</span>
                        <div class="ki-branch-bar" style="width:${b.pct * 2}px"></div>
                        <span>${b.pct}%</span></li>
                `).join('')}
            </ul>` : ''}
            <div class="ki-coverage">
                Branchedækning: ${_kiIcp.branch_coverage_pct}%
                ${_kiIcp.branch_coverage_pct < 40 ? ' ⚠ For lavt til pålidelig ICP' : ' ✓'}
            </div>
        </div>` : ''}
    `;
}

function _kiSlider(key, label, value, min, max) {
    min = min || 0;
    max = max || 100;
    return `<div class="ki-slider-row">
        <label>${label}</label>
        <input type="range" min="${min}" max="${max}" value="${value}" id="ki-sl-${key}"
            oninput="document.getElementById('ki-sv-${key}').textContent=this.value">
        <span class="ki-val" id="ki-sv-${key}">${value}</span>
    </div>`;
}

function _kiRenderMain() {
    const el = document.getElementById('ki-main');
    if (!el || !_kiData) return;

    const { rows, stages } = _kiData;
    const stageMap = {};
    if (stages) for (const s of stages) stageMap[s.stage] = s.count;

    el.innerHTML = `
        <div class="ki-stats">
            <div class="ki-stat"><div class="ki-stat-val">${rows?.length || 0}</div><div class="ki-stat-label">Firmaer</div></div>
            <div class="ki-stat"><div class="ki-stat-val" style="color:#8e631f">${stageMap.vip || 0}</div><div class="ki-stat-label">VIP</div></div>
            <div class="ki-stat"><div class="ki-stat-val" style="color:#3d7a0a">${stageMap.active || 0}</div><div class="ki-stat-label">Aktive</div></div>
            <div class="ki-stat"><div class="ki-stat-val" style="color:#888">${stageMap.dormant || 0}</div><div class="ki-stat-label">Sovende</div></div>
            <div class="ki-stat"><div class="ki-stat-val" style="color:#2a6fb0">${stageMap.lead || 0}</div><div class="ki-stat-label">Leads</div></div>
        </div>
        <div class="ki-filters">
            <input type="text" placeholder="Søg firma..." value="${_kiSearch}" id="ki-search" style="width:200px">
            <button class="ki-stage-btn ${!_kiStageFilter ? 'active' : ''}" onclick="_kiFilterStage('')">Alle</button>
            <button class="ki-stage-btn ${_kiStageFilter === 'vip' ? 'active' : ''}" onclick="_kiFilterStage('vip')">VIP</button>
            <button class="ki-stage-btn ${_kiStageFilter === 'active' ? 'active' : ''}" onclick="_kiFilterStage('active')">Aktive</button>
            <button class="ki-stage-btn ${_kiStageFilter === 'dormant' ? 'active' : ''}" onclick="_kiFilterStage('dormant')">Sovende</button>
            <button class="ki-stage-btn ${_kiStageFilter === 'lead' ? 'active' : ''}" onclick="_kiFilterStage('lead')">Leads</button>
        </div>
        <div class="ki-table-wrap">
            <table class="ki-table">
                <thead><tr>
                    <th onclick="_kiSetSort('name')">Firma</th>
                    <th onclick="_kiSetSort('rfm_total')" style="width:60px">RFM</th>
                    <th onclick="_kiSetSort('r_score')" style="width:40px">R</th>
                    <th onclick="_kiSetSort('f_score')" style="width:40px">F</th>
                    <th onclick="_kiSetSort('m_score')" style="width:40px">M</th>
                    <th style="width:80px">Stage</th>
                    <th onclick="_kiSetSort('order_count')" style="width:50px">Ordrer</th>
                    <th onclick="_kiSetSort('total_guests')" style="width:60px">Gæster</th>
                    <th onclick="_kiSetSort('total_revenue')" style="width:80px">Revenue</th>
                    <th style="width:70px">Branche</th>
                    <th style="width:90px">Sidst ordre</th>
                </tr></thead>
                <tbody>
                    ${(rows || []).map(r => _kiRow(r)).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function _kiRow(r) {
    const stCls = 'ki-stage-' + (r.stage || 'lead');
    const stLabel = { vip: 'VIP', active: 'Aktiv', dormant: 'Sovende', lead: 'Lead' }[r.stage] || r.stage;
    const name = r.is_personal ? (r.primary_contact_name || r.name) : r.name;
    const daysAgo = r.days_since_last != null ? r.days_since_last + 'd' : '—';
    return `<tr style="cursor:pointer" onclick="_kiOpenCustomer(${r.primary_customer_id || 0})">
        <td>
            <strong>${_kiEsc(name)}</strong>
            ${r.branch ? '<br><span style="font-size:11px;color:#888">' + _kiEsc(r.branch) + '</span>' : ''}
        </td>
        <td><strong>${r.rfm_total}</strong></td>
        <td>${_kiBar(r.r_score, '#4a90d9')}</td>
        <td>${_kiBar(r.f_score, '#5cb85c')}</td>
        <td>${_kiBar(r.m_score, '#f0ad4e')}</td>
        <td><span class="ki-stage-badge ${stCls}">${stLabel}</span>${r.stage_locked ? '<span class="ki-lock">🔒</span>' : ''}</td>
        <td>${r.order_count}</td>
        <td>${r.total_guests}</td>
        <td>${r.total_revenue ? Math.round(r.total_revenue).toLocaleString('da-DK') : '0'}</td>
        <td style="font-size:11px">${_kiEsc(r.branch || '')}</td>
        <td style="font-size:11px">${r.last_order_date || '—'}<br><span style="color:#888">${daysAgo}</span></td>
    </tr>`;
}

function _kiBar(score, color) {
    return `<div style="display:flex;align-items:center;gap:4px">
        <div class="ki-bar" style="width:${score * 0.4}px;background:${color}"></div>
        <span style="font-size:11px">${score}</span>
    </div>`;
}

// ─── Events ─────────────────────────────────────────────────

function _kiWireEvents() {
    // Søge-debounce
    document.addEventListener('input', function(e) {
        if (e.target.id !== 'ki-search') return;
        _kiSearch = e.target.value;
        if (_kiDebounce) clearTimeout(_kiDebounce);
        _kiDebounce = setTimeout(() => _kiLoadAll(), 400);
    });
}

function _kiFilterStage(stage) {
    _kiStageFilter = stage;
    _kiLoadAll();
}

function _kiSetSort(col) {
    _kiSort = col;
    _kiLoadAll();
}

function _kiSetMonetary(mode) {
    // Opdater slider UI midlertidigt
    const cfg = {};
    if (_kiConfig) for (const r of _kiConfig) cfg[r.key] = r.value;
    cfg.monetary_mode = mode;
    _kiConfig = Object.entries(cfg).map(([key, value]) => ({ key, value }));
    _kiRenderSidebar();
}

async function _kiSaveAndCompute() {
    if (!_kiActive) return;
    const updates = {};
    ['w_r', 'w_f', 'w_m', 'vip_pct', 'aktiv_pct', 'recency_days'].forEach(key => {
        const el = document.getElementById('ki-sl-' + key);
        if (el) updates[key] = el.value;
    });
    // Monetary mode
    const cfg = {};
    if (_kiConfig) for (const r of _kiConfig) cfg[r.key] = r.value;
    updates.monetary_mode = cfg.monetary_mode || 'pax';

    try {
        await patchRfmConfig(updates);
        const mainEl = document.getElementById('ki-main');
        if (mainEl) mainEl.innerHTML = '<div class="ki-computing">Genberegner RFM-scores...</div>';
        await triggerRfmCompute();
        await _kiLoadAll();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

function _kiOpenCustomer(customerId) {
    if (!customerId) return;
    if (typeof window.switchView === 'function') {
        window.switchView('crm-kunde360');
        setTimeout(() => {
            if (typeof _k3LoadCustomer === 'function') _k3LoadCustomer(customerId);
        }, 100);
    }
}

function _kiEsc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
