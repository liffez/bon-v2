/**
 * office/views/co2-overblik.js
 * ═══════════════════════════════════════════════════════════
 * CO₂ F7 — overblik & rapport. Fire blokke:
 *   1. KPI-strip (coverage · CO₂ seneste periode · CO₂ pr. kuvert)
 *   2. Datakvalitet (dækning + hvad mangler mest — indgang til rigtige rapporter)
 *   3. CO₂ over tid (månedlig Σ total_co2e + pr. kuvert)
 *   4. CO₂ pr. opskrift (sortérbar tabel med status)
 *
 * Backend ejer beregningen (routes/co2.js /overview + /timeseries). Frontend
 * regner ikke selv CO₂.
 * ═══════════════════════════════════════════════════════════
 */

/* globals fetchCo2Overview, fetchCo2Timeseries */

const _covState = {
    container: null,
    overview: null,
    series: null,
    search: '',
    filter: '',        // '' | 'complete' | 'partial'
    sortKey: 'co2e',   // 'co2e' | 'name'
    sortDir: 'desc',
};

function initCo2Overblik(container) {
    _covState.container = container;
    container.innerHTML = '<div class="cov-loading">Indlæser CO₂-overblik…</div>';
    _covLoad();
}
function cleanupCo2Overblik() {
    _covState.container = null;
    _covState.overview = null;
    _covState.series = null;
}

const _covEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _covNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: d, maximumFractionDigits: d }));

async function _covLoad() {
    try {
        const [ov, ts] = await Promise.all([fetchCo2Overview(), fetchCo2Timeseries(12)]);
        _covState.overview = ov;
        _covState.series = ts.months || [];
        _covRender();
    } catch (e) {
        if (!_covState.container) return;
        _covState.container.innerHTML =
            `<div class="cov-error">Kunne ikke indlæse: ${_covEsc(e.message)}<br>
             <small>Kræver forbindelse til den aktive Grocy-lokation.</small></div>`;
    }
}

/* ─── Render ──────────────────────────────────────────────── */

function _covRender() {
    const el = _covState.container;
    if (!el) return;
    const ov = _covState.overview;
    const s = ov.summary;

    // Periode-tal fra timeseries
    const series = _covState.series;
    const periodCo2e = series.reduce((a, m) => a + (m.co2e || 0), 0);
    const periodPax = series.reduce((a, m) => a + (m.pax || 0), 0);
    const perPax = periodPax ? periodCo2e / periodPax : null;

    el.innerHTML = `
      <div class="cov-view">
        <div class="cov-head">
          <h1>CO₂ — Overblik</h1>
          <button class="cov-btn-ghost" id="covRefresh">↻ Opdatér</button>
        </div>

        <div class="cov-kpis">
          ${_covKpi('Dækning', s.coverage_pct + '%', `${s.complete} af ${s.total} opskrifter`, s.coverage_pct >= 80 ? 'green' : (s.coverage_pct >= 40 ? 'amber' : 'red'))}
          ${_covKpi('CO₂ · seneste 12 mdr', _covNum(periodCo2e, 0), 'kg CO₂e', '')}
          ${_covKpi('CO₂ pr. kuvert', perPax != null ? _covNum(perPax) : '—', 'kg CO₂e / kuvert', '')}
          ${_covKpi('Komplette opskrifter', String(s.complete), 'med fuldt CO₂-tal', 'green')}
        </div>

        ${_covDataQuality(ov)}
        ${_covTimeChart(series)}
        ${_covRecipeTable(ov.recipes)}
      </div>`;

    _covBind();
}

function _covKpi(label, value, sub, tone) {
    return `<div class="cov-kpi ${tone ? 'cov-kpi-' + tone : ''}">
        <div class="cov-kpi-val">${_covEsc(value)}</div>
        <div class="cov-kpi-lbl">${_covEsc(label)}</div>
        <div class="cov-kpi-sub">${_covEsc(sub)}</div>
    </div>`;
}

/* Blok 2 — datakvalitet: dækningsbjælke + hvad mangler mest */
function _covDataQuality(ov) {
    const s = ov.summary;
    const mf = ov.missing.factor || [];
    const mk = ov.missing.kgvej || [];
    const chips = (arr) => arr.length
        ? arr.map(x => `<span class="cov-miss-chip">${_covEsc(x.name)} <b>${x.count}</b></span>`).join('')
        : '<span class="cov-dim">Intet mangler 🎉</span>';
    return `
      <section class="cov-card">
        <h2>Datakvalitet</h2>
        <p class="cov-sub">Indgangen til rigtige rapporter — jo mere data, jo mere retvisende bliver tallene.</p>
        <div class="cov-bar">
          <div class="cov-bar-fill" style="width:${s.coverage_pct}%"></div>
          <span class="cov-bar-txt">${s.complete} komplette · ${s.partial} mangler data</span>
        </div>
        <div class="cov-miss-grid">
          <div>
            <h3>Mangler kg-vej <span class="cov-dim">(vej i køkkenet)</span></h3>
            <div class="cov-miss-chips">${chips(mk)}</div>
          </div>
          <div>
            <h3>Mangler faktor <span class="cov-dim">(emballage / råvare)</span></h3>
            <div class="cov-miss-chips">${chips(mf)}</div>
          </div>
        </div>
      </section>`;
}

/* Blok 3 — CO₂ over tid: månedlige søjler (total) + pr-kuvert-tal */
function _covTimeChart(series) {
    if (!series.length) {
        return `<section class="cov-card"><h2>CO₂ over tid</h2><p class="cov-dim">Ingen data i perioden endnu — fyldes efterhånden som bons leveres med CO₂-tal.</p></section>`;
    }
    const max = Math.max(...series.map(m => m.co2e || 0), 1);
    const W = 640, H = 180, pad = 28, bw = (W - pad * 2) / series.length;
    const bars = series.map((m, i) => {
        const h = (m.co2e / max) * (H - pad * 2);
        const x = pad + i * bw + bw * 0.15;
        const y = H - pad - h;
        const w = bw * 0.7;
        const lbl = m.month.slice(5); // MM
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"
                    rx="2" class="cov-chart-bar"><title>${m.month}: ${_covNum(m.co2e, 0)} kg · ${m.bons} bons · ${m.co2e_per_pax != null ? _covNum(m.co2e_per_pax) + ' kg/kuvert' : '—'}</title></rect>
                <text x="${(x + w / 2).toFixed(1)}" y="${H - pad + 12}" text-anchor="middle" class="cov-chart-lbl">${lbl}</text>`;
    }).join('');
    return `
      <section class="cov-card">
        <h2>CO₂ over tid <span class="cov-dim">· seneste 12 mdr (kg CO₂e pr. måned)</span></h2>
        <svg viewBox="0 0 ${W} ${H}" class="cov-chart" preserveAspectRatio="xMidYMid meet">
          <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="cov-chart-axis"/>
          ${bars}
        </svg>
      </section>`;
}

/* Blok 4 — CO₂ pr. opskrift: søg + filter + sortérbar tabel */
function _covRecipeTable(recipes) {
    return `
      <section class="cov-card">
        <div class="cov-card-head">
          <h2>CO₂ pr. opskrift</h2>
          <div class="cov-filters">
            <input type="search" id="covSearch" placeholder="Søg opskrift…" value="${_covEsc(_covState.search)}">
            <select id="covFilter">
              <option value="">Alle</option>
              <option value="complete">Komplette</option>
              <option value="partial">Mangler data</option>
            </select>
          </div>
        </div>
        <table class="cov-table">
          <thead><tr>
            <th class="cov-sortable" data-sort="name">Opskrift</th>
            <th class="cov-sortable cov-num" data-sort="co2e">CO₂e / enhed</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${_covRecipeRows(recipes)}</tbody>
        </table>
      </section>`;
}

function _covFilteredRecipes(recipes) {
    const q = _covState.search.trim().toLowerCase();
    let rows = recipes.filter(r => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        if (_covState.filter === 'complete' && !r.complete) return false;
        if (_covState.filter === 'partial' && r.complete) return false;
        return true;
    });
    const dir = _covState.sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
        if (_covState.sortKey === 'name') return a.name.localeCompare(b.name, 'da') * dir;
        return ((a.co2e_per_serving || 0) - (b.co2e_per_serving || 0)) * dir;
    });
    return rows;
}

function _covRecipeRows(recipes) {
    const rows = _covFilteredRecipes(recipes);
    if (!rows.length) return `<tr><td colspan="3" class="cov-empty">Ingen opskrifter matcher.</td></tr>`;
    return rows.map(r => {
        let badge;
        if (r.complete) badge = '<span class="cov-badge cov-badge-green">Komplet</span>';
        else if (r.missing_kgvej.length) badge = `<span class="cov-badge cov-badge-blue" title="${_covEsc(r.missing_kgvej.join(', '))}">Mangler kg-vej</span>`;
        else badge = `<span class="cov-badge cov-badge-amber" title="${_covEsc(r.missing_factor.join(', '))}">Mangler faktor</span>`;
        return `<tr>
            <td class="cov-recipe-name">${_covEsc(r.name)}</td>
            <td class="cov-num">${r.co2e_per_serving != null ? _covNum(r.co2e_per_serving) + ' <span class="cov-dim">kg</span>' : '<span class="cov-dim">—</span>'}</td>
            <td>${badge}</td>
        </tr>`;
    }).join('');
}

/* ─── Events ──────────────────────────────────────────────── */

function _covBind() {
    const el = _covState.container;
    if (!el) return;
    el.querySelector('#covRefresh').addEventListener('click', _covLoad);

    const search = el.querySelector('#covSearch');
    if (search) search.addEventListener('input', () => { _covState.search = search.value; _covReRenderTable(); });
    const filter = el.querySelector('#covFilter');
    if (filter) filter.addEventListener('change', (e) => { _covState.filter = e.target.value; _covReRenderTable(); });

    el.querySelectorAll('.cov-sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (_covState.sortKey === key) _covState.sortDir = _covState.sortDir === 'asc' ? 'desc' : 'asc';
            else { _covState.sortKey = key; _covState.sortDir = key === 'name' ? 'asc' : 'desc'; }
            _covReRenderTable();
        });
    });
}

function _covReRenderTable() {
    const tbody = _covState.container.querySelector('.cov-table tbody');
    if (tbody) tbody.innerHTML = _covRecipeRows(_covState.overview.recipes);
}

window.initCo2Overblik = initCo2Overblik;
window.cleanupCo2Overblik = cleanupCo2Overblik;
