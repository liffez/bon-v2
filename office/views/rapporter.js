/* ===== Rapporter view ===== */

let _rapContainer = null;
let _rapActive = false;
let _rapCharts = {};       // canvasId -> chart handle
let _rapLegoMonths = [];   // empty = all months
let _rapLegoYear = null;
// Sammenligningstilstand for lego-rapporten:
//   'none'  = vælg 1-2 måneder i indeværende år (oprindelig opførsel)
//   'prev1' = samme måned i år + sidste år (2 perioder)
//   'prev2' = samme måned i år + sidste år + 2 år tilbage (3 perioder)
let _rapLegoCompare = 'none';
let _rapDebounce = null;
let _rapCustSortBy = 'revenue';
let _rapLegoMode = 'revenue';
let _rapMonthlyMode = 'kr';

const CAT_COLORS = {
  store:      '#6d4c16',
  catering:   '#c49a45',
  festival:   '#7a9c54',
  produktion: '#7594b3',
  waiste:     '#c8c2bb'
};

const CAT_LABELS = {
  store:      'Butik',
  catering:   'Catering',
  festival:   'Festival',
  produktion: 'Produktion',
  waiste:     'Waiste'
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];

// ─── helpers ────────────────────────────────────────────────────────
function _rapFmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('da-DK');
}

function _rapFmtKr(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('da-DK') + ' kr';
}

function _rapDeltaHtml(current, prev, mode) {
  // mode: 'pct' | 'abs'
  if (prev == null || prev === 0) return '<span class="rap-kpi-delta delta-neutral">—</span>';
  let delta, text;
  if (mode === 'abs') {
    delta = current - prev;
    text = (delta >= 0 ? '+' : '') + _rapFmt(delta);
  } else {
    delta = ((current - prev) / Math.abs(prev) * 100);
    text = (delta >= 0 ? '+' : '') + delta.toFixed(0) + '%';
  }
  const cls = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-neutral';
  return `<span class="rap-kpi-delta ${cls}">${text}</span>`;
}

// ─── shell HTML ─────────────────────────────────────────────────────
// Konvention: Rapport-modulet viser regnskabs-tal — alle kr-tal er ex moms.
// Se BON_V2_PRINCIPPER.md sektion 6c.
function _rapShellHtml() {
  return `
<div class="rap-grid">
  <div class="rap-grid-header" style="padding:8px 0 4px;font-size:13px;color:var(--color-text-dim,#7a6f5f)">
    <strong style="color:var(--color-text,#2c2416)">Rapporter</strong> — alle omsætnings-tal er <strong>ex moms</strong> (regnskabskonvention)
  </div>
  <div class="rap-kpi-strip" id="rap-kpis">
    <div class="rap-kpi rap-loading" style="min-height:90px"></div>
    <div class="rap-kpi rap-loading" style="min-height:90px"></div>
    <div class="rap-kpi rap-loading" style="min-height:90px"></div>
    <div class="rap-kpi rap-loading" style="min-height:90px"></div>
  </div>

  <div class="rap-card">
    <div class="rap-card-head">
      <h3 class="rap-card-title">Månedsomsætning (ex moms)</h3>
      <div class="rap-toggle" id="rap-monthly-toggle">
        <button class="active" data-mode="kr">Kr</button>
        <button data-mode="enh">Enh</button>
      </div>
    </div>
    <div class="rap-canvas-wrap"><canvas id="rap-monthly-canvas"></canvas></div>
  </div>

  <div class="rap-two-col">
    <div class="rap-card" id="rap-top-cust">
      <div class="rap-card-head">
        <h3 class="rap-card-title">Top kunder (omsætning ex moms)</h3>
        <div class="rap-toggle" id="rap-cust-toggle">
          <button class="active" data-by="revenue">Omsætning</button>
          <button data-by="orders">Ordrer</button>
        </div>
      </div>
      <div id="rap-cust-list" class="rap-loading" style="min-height:200px"></div>
    </div>
    <div class="rap-card" id="rap-categories">
      <div class="rap-card-head">
        <h3 class="rap-card-title">Priskategori-fordeling (ex moms)</h3>
      </div>
      <div id="rap-cat-content" class="rap-loading" style="min-height:200px"></div>
    </div>
  </div>

  <div class="rap-card">
    <div class="rap-card-head">
      <h3 class="rap-card-title">Legoklods-sammenligning (ex moms)</h3>
      <span id="rap-lego-hint" style="font-size:.78rem;color:var(--color-text-dim,#7a6f5f)">Vælg 1-2 måneder til sammenligning</span>
    </div>
    <div class="rap-lego-compare" id="rap-lego-compare" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
    <div class="rap-lego-months" id="rap-lego-months"></div>
    <div class="rap-canvas-wrap" style="height:340px"><canvas id="rap-lego-canvas"></canvas></div>
  </div>

  <div class="rap-card">
    <div class="rap-card-head">
      <h3 class="rap-card-title">Akkumuleret omsætning (ex moms)</h3>
    </div>
    <div class="rap-canvas-wrap" style="height:240px"><canvas id="rap-cumul-canvas"></canvas></div>
  </div>

  <div class="rap-two-col">
    <div class="rap-card" id="rap-top-cats">
      <div class="rap-card-head">
        <h3 class="rap-card-title">Top kategorier (enheder)</h3>
      </div>
      <div id="rap-cats-list" class="rap-loading" style="min-height:200px"></div>
    </div>
    <div class="rap-card" id="rap-month-table-card">
      <div class="rap-card-head">
        <h3 class="rap-card-title">Månedsoversigt (omsætning ex moms)</h3>
      </div>
      <div id="rap-month-table-content" style="overflow-x:auto" class="rap-loading" style="min-height:200px"></div>
    </div>
  </div>
</div>`;
}

// ─── init / cleanup ─────────────────────────────────────────────────

function initRapporter(container, opts) {
  _rapContainer = container;
  _rapActive = true;
  _rapLegoMonths = [];
  _rapLegoYear = null;
  _rapLegoCompare = 'none';
  _rapCustSortBy = 'revenue';
  _rapLegoMode = 'revenue';
  _rapMonthlyMode = 'kr';

  container.innerHTML = _rapShellHtml();
  _rapWireToggles();
  _rapLoadAll();
}

function cleanupRapporter() {
  _rapActive = false;
  // destroy chart handles
  for (const key of Object.keys(_rapCharts)) {
    const h = _rapCharts[key];
    if (h && typeof h.destroy === 'function') h.destroy();
  }
  _rapCharts = {};
  if (_rapDebounce) { clearTimeout(_rapDebounce); _rapDebounce = null; }
  _rapContainer = null;
}

function _rapportHandleSSE(event, data) {
  if (!_rapActive) return;
  if (_rapDebounce) clearTimeout(_rapDebounce);
  _rapDebounce = setTimeout(() => { _rapLoadAll(); }, 2000);
}

// ─── data loading ───────────────────────────────────────────────────

async function _rapLoadAll() {
  if (!_rapActive) return;
  try {
    const [summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats] = await Promise.all([
      fetchReportsSummary(),
      fetchReportsMonthly(),
      fetchReportsTopCustomers(_rapCustSortBy),
      fetchReportsCategories(),
      fetchReportsMonthlyTable(),
      _rapFetchLego(),
      fetchReportsCumulative(),
      fetchReportsTopCategories(),
    ]);
    if (!_rapActive) return;
    _rapRenderAll(summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats);
  } catch (err) {
    if (!_rapActive) return;
    _rapContainer.innerHTML = '<div style="padding:40px;text-align:center;color:red">Fejl: ' + err.message + '</div>';
  }
}

// ─── render orchestrator ────────────────────────────────────────────

function _rapRenderAll(summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats) {
  // destroy existing charts
  for (const key of Object.keys(_rapCharts)) {
    const h = _rapCharts[key];
    if (h && typeof h.destroy === 'function') h.destroy();
  }
  _rapCharts = {};

  _rapRenderKPIs(summary);
  _rapRenderMonthlyChart(monthly);
  _rapRenderTopCustomers(topCust);
  _rapRenderCategories(categories);
  _rapRenderLegoModel(lego);
  _rapRenderCumulative(cumulative);
  _rapRenderTopCategories(topCats);
  _rapRenderMonthlyTable(monthlyTable);
}

// ─── KPIs ───────────────────────────────────────────────────────────

function _rapRenderKPIs(d) {
  const el = document.getElementById('rap-kpis');
  if (!el) return;

  // Regnskabskonvention: alle revenue-tal er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c).
  // Backend leverer både *_excl_moms og bagudkomp.-felter; vi bruger ex moms primært.
  const revenueYtd      = d.revenue_ytd_excl_moms      ?? d.revenue_ytd;
  const revenueYtdPrev  = d.revenue_ytd_prev_excl_moms ?? d.revenue_ytd_prev;
  const avgOrder        = d.avg_order_value_excl_moms  ?? d.avg_order_value;
  const avgOrderPrev    = d.avg_order_prev_excl_moms   ?? d.avg_order_prev;
  const pendingInvoice  = d.pending_invoice_excl_moms  ?? d.pending_invoice;

  const cards = [
    {
      value: _rapFmtKr(revenueYtd),
      label: 'Omsætning YTD (ex moms)',
      delta: _rapDeltaHtml(revenueYtd, revenueYtdPrev, 'pct'),
      sub: ''
    },
    {
      value: _rapFmt(d.orders_ytd),
      label: 'Ordrer YTD',
      delta: _rapDeltaHtml(d.orders_ytd, d.orders_ytd_prev, 'abs'),
      sub: ''
    },
    {
      value: _rapFmtKr(avgOrder),
      label: 'Gns. ordreværdi (ex moms)',
      delta: _rapDeltaHtml(avgOrder, avgOrderPrev, 'pct'),
      sub: ''
    },
    {
      value: _rapFmtKr(pendingInvoice),
      label: 'Ufaktureret (ex moms)',
      delta: '',
      sub: d.pending_count != null ? d.pending_count + ' bons' : ''
    }
  ];

  el.innerHTML = cards.map(c => `
    <div class="rap-kpi">
      <div class="rap-kpi-value">${c.value}</div>
      <div class="rap-kpi-label">${c.label}</div>
      ${c.delta ? '<div>' + c.delta + '</div>' : ''}
      ${c.sub ? '<div class="rap-kpi-sub">' + c.sub + '</div>' : ''}
    </div>
  `).join('');
}

// ─── Monthly bar chart ──────────────────────────────────────────────

function _rapRenderMonthlyChart(data) {
  if (typeof initMonthlyBarChart !== 'function') {
    // fallback: show placeholder
    const wrap = document.getElementById('rap-monthly-canvas');
    if (wrap && wrap.parentElement) wrap.parentElement.innerHTML = '<div style="padding:40px;text-align:center;color:#a09890">Chart ikke tilgængelig</div>';
    return;
  }
  const handle = initMonthlyBarChart('rap-monthly-canvas', data);
  if (handle) {
    _rapCharts['rap-monthly-canvas'] = handle;
    if (typeof handle.setMode === 'function') handle.setMode(_rapMonthlyMode);
  }
}

// ─── Top customers ──────────────────────────────────────────────────

function _rapRenderTopCustomers(data) {
  const el = document.getElementById('rap-cust-list');
  if (!el) return;
  el.classList.remove('rap-loading');

  const items = data.customers || data || [];
  if (!items.length) {
    el.innerHTML = '<div style="padding:20px;color:#a09890;text-align:center">Ingen data</div>';
    return;
  }

  const byRevenue = _rapCustSortBy === 'revenue';
  // Regnskabskonvention: revenue er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c)
  const revOf = i => i.revenue_excl_moms ?? i.revenue ?? 0;
  const maxVal = Math.max(...items.map(i => byRevenue ? revOf(i) : (i.orders || 0)), 1);

  el.innerHTML = '<div class="rap-bar-list">' + items.map((item, idx) => {
    const val = byRevenue ? revOf(item) : (item.orders || 0);
    const pct = (val / maxVal * 100).toFixed(1);
    const displayVal = byRevenue ? _rapFmtKr(val) : _rapFmt(val);
    const name = item.display_name || item.company_name || item.customer_name || 'Ukendt';
    return `<div class="rap-bar-row">
      <span class="rap-rank">${idx + 1}.</span>
      <span class="rap-name" title="${name}">${name}</span>
      <div class="rap-bar"><div class="rap-bar-fill" style="width:${pct}%"></div></div>
      <span class="rap-value">${displayVal}</span>
    </div>`;
  }).join('') + '</div>';
}

// ─── Categories (stacked bar + table) ───────────────────────────────

function _rapRenderCategories(data) {
  const el = document.getElementById('rap-cat-content');
  if (!el) return;
  el.classList.remove('rap-loading');

  const cats = data.this_year || data.categories || [];
  const prevCats = data.prev_year || [];
  if (!cats.length) {
    el.innerHTML = '<div style="padding:20px;color:#a09890;text-align:center">Ingen data</div>';
    return;
  }

  // Build prev year lookup by code
  const prevByCode = {};
  for (const pc of prevCats) prevByCode[pc.code] = pc;

  // Regnskabskonvention: revenue er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c)
  const revOf = c => c.revenue_excl_moms ?? c.revenue ?? 0;
  const totalRev = cats.reduce((s, c) => s + revOf(c), 0) || 1;

  // stacked bar
  let barHtml = '<div class="rap-stacked-bar">';
  for (const cat of cats) {
    const pct = (revOf(cat) / totalRev * 100).toFixed(1);
    const color = CAT_COLORS[cat.code] || '#999';
    const label = CAT_LABELS[cat.code] || cat.label || cat.code || '?';
    barHtml += `<div class="rap-stacked-segment" style="width:${pct}%;background:${color}" title="${label}: ${pct}%"></div>`;
  }
  barHtml += '</div>';

  // table
  let tableHtml = `<table class="rap-cat-table">
    <thead><tr>
      <th>Kategori</th><th class="text-right">Enheder</th><th class="text-right">Omsætning (ex moms)</th><th class="text-right">Andel</th><th class="text-right">Delta</th>
    </tr></thead><tbody>`;

  for (const cat of cats) {
    const catRev = revOf(cat);
    const pct = (catRev / totalRev * 100).toFixed(1);
    const color = CAT_COLORS[cat.code] || '#999';
    const label = CAT_LABELS[cat.code] || cat.label || cat.code || '?';
    const prevRev = revOf(prevByCode[cat.code] || {});
    const deltaVal = catRev - prevRev;
    const deltaCls = deltaVal > 0 ? 'delta-up' : deltaVal < 0 ? 'delta-down' : '';
    const deltaText = deltaVal !== 0 ? ((deltaVal > 0 ? '+' : '') + _rapFmtKr(deltaVal)) : '—';

    tableHtml += `<tr>
      <td><span class="rap-cat-dot" style="background:${color}"></span>${label}</td>
      <td class="text-right">${_rapFmt(cat.units)}</td>
      <td class="text-right">${_rapFmtKr(catRev)}</td>
      <td class="text-right">${pct}%</td>
      <td class="text-right ${deltaCls}">${deltaText}</td>
    </tr>`;
  }
  tableHtml += '</tbody></table>';

  el.innerHTML = barHtml + tableHtml;
}

// ─── Lego model ─────────────────────────────────────────────────────

const _RAP_COMPARE_OPTIONS = [
  { key: 'none',  label: 'I år',            hint: 'Vælg 1-2 måneder til sammenligning' },
  { key: 'prev1', label: 'Vs. sidste år',   hint: 'Vælg 1 måned — sammenlignes mod samme måned sidste år' },
  { key: 'prev2', label: 'Sidste 3 år',     hint: 'Vælg 1 måned — sammenlignes på tværs af de sidste 3 år' },
];

/** Returnerer fetch-promise for lego baseret på nuværende state. */
function _rapFetchLego() {
  if (_rapLegoCompare === 'none') {
    return fetchReportsLego(_rapLegoMonths, _rapLegoYear);
  }
  // Sammenlignings-tilstand: brug 1. valgte måned (eller indeværende måned hvis ingen valgt).
  const month = _rapLegoMonths[0] || (new Date().getMonth() + 1);
  const thisYear = new Date().getFullYear();
  const yearOffsets = _rapLegoCompare === 'prev2' ? [2, 1, 0] : [1, 0];
  const mm = String(month).padStart(2, '0');
  const periods = yearOffsets.map(off => `${thisYear - off}-${mm}`);
  return fetchReportsLego({ periods });
}

function _rapRenderLegoModel(data) {
  // Sammenlignings-tilstand chips (ovenover måneds-chips)
  const compareEl = document.getElementById('rap-lego-compare');
  if (compareEl) {
    compareEl.innerHTML = _RAP_COMPARE_OPTIONS.map(opt =>
      `<button class="rap-month-chip${_rapLegoCompare === opt.key ? ' active' : ''}" data-compare="${opt.key}" title="${opt.hint}">${opt.label}</button>`
    ).join('');
    compareEl.onclick = (e) => {
      const btn = e.target.closest('[data-compare]');
      if (!btn) return;
      const key = btn.dataset.compare;
      if (key === _rapLegoCompare) return;
      _rapLegoCompare = key;
      // I sammenligningstilstand må vi kun have 1 valgt måned (ellers giver perioder ikke mening)
      if (key !== 'none' && _rapLegoMonths.length > 1) {
        _rapLegoMonths = [_rapLegoMonths[_rapLegoMonths.length - 1]];
      }
      // Opdatér active-state på compare-chips
      compareEl.querySelectorAll('[data-compare]').forEach(b => {
        b.classList.toggle('active', b.dataset.compare === key);
      });
      _rapRefreshLegoUI();
      _rapDebouncedReloadLego();
    };
  }

  _rapRefreshLegoUI();

  const chipsEl = document.getElementById('rap-lego-months');
  if (chipsEl) {
    chipsEl.onclick = (e) => {
      const btn = e.target.closest('.rap-month-chip');
      if (!btn) return;
      if (btn.classList.contains('reset')) {
        _rapLegoMonths = [];
      } else {
        const m = parseInt(btn.dataset.month);
        const idx = _rapLegoMonths.indexOf(m);
        if (idx >= 0) {
          _rapLegoMonths.splice(idx, 1);
        } else {
          // Max 2 i 'none'-mode, max 1 i compare-mode
          const limit = _rapLegoCompare === 'none' ? 2 : 1;
          if (_rapLegoMonths.length >= limit) _rapLegoMonths.shift();
          _rapLegoMonths.push(m);
        }
      }
      _rapRenderLegoChipsOnly();
      _rapDebouncedReloadLego();
    };
  }

  _rapRenderLegoChart(data);
}

function _rapDebouncedReloadLego() {
  if (_rapDebounce) clearTimeout(_rapDebounce);
  _rapDebounce = setTimeout(async () => {
    try {
      const lego = await _rapFetchLego();
      if (!_rapActive) return;
      _rapRenderLegoChart(lego);
    } catch (err) { /* ignore */ }
  }, 200);
}

/** Render måneds-chips + hint-tekst i overensstemmelse med nuværende state. */
function _rapRefreshLegoUI() {
  const hintEl = document.getElementById('rap-lego-hint');
  if (hintEl) {
    const opt = _RAP_COMPARE_OPTIONS.find(o => o.key === _rapLegoCompare);
    if (opt) hintEl.textContent = opt.hint;
  }
  const chipsEl = document.getElementById('rap-lego-months');
  if (!chipsEl) return;
  let html = '';
  for (let m = 0; m < 12; m++) {
    const active = _rapLegoMonths.includes(m + 1);
    html += `<button class="rap-month-chip${active ? ' active' : ''}" data-month="${m + 1}">${MONTH_NAMES[m]}</button>`;
  }
  html += `<button class="rap-month-chip reset${_rapLegoMonths.length === 0 ? ' active' : ''}">Nulstil</button>`;
  chipsEl.innerHTML = html;
}

function _rapRenderLegoChipsOnly() {
  const chipsEl = document.getElementById('rap-lego-months');
  if (!chipsEl) return;
  const chips = chipsEl.querySelectorAll('.rap-month-chip');
  chips.forEach(btn => {
    if (btn.classList.contains('reset')) {
      btn.classList.toggle('active', _rapLegoMonths.length === 0);
    } else {
      const m = parseInt(btn.dataset.month);
      btn.classList.toggle('active', _rapLegoMonths.includes(m));
    }
  });
}

function _rapRenderLegoChart(data) {
  if (typeof initLegoStackedChart !== 'function') {
    const wrap = document.getElementById('rap-lego-canvas');
    if (wrap && wrap.parentElement) wrap.parentElement.innerHTML = '<div style="padding:40px;text-align:center;color:#a09890">Chart ikke tilgængelig</div>';
    return;
  }
  if (_rapCharts['rap-lego-canvas'] && typeof _rapCharts['rap-lego-canvas'].destroy === 'function') {
    _rapCharts['rap-lego-canvas'].destroy();
  }
  const handle = initLegoStackedChart('rap-lego-canvas', data);
  if (handle) {
    _rapCharts['rap-lego-canvas'] = handle;
  }
}

// ─── Cumulative ─────────────────────────────────────────────────────

function _rapRenderCumulative(data) {
  if (typeof initMultiYearAccumChart !== 'function') {
    const wrap = document.getElementById('rap-cumul-canvas');
    if (wrap && wrap.parentElement) wrap.parentElement.innerHTML = '<div style="padding:40px;text-align:center;color:#a09890">Chart ikke tilgængelig</div>';
    return;
  }
  if (_rapCharts['rap-cumul-canvas'] && typeof _rapCharts['rap-cumul-canvas'].destroy === 'function') {
    _rapCharts['rap-cumul-canvas'].destroy();
  }
  const handle = initMultiYearAccumChart('rap-cumul-canvas', data, {
    currentYear: new Date().getFullYear().toString()
  });
  if (handle) {
    _rapCharts['rap-cumul-canvas'] = handle;
  }
}

// ─── Top categories ─────────────────────────────────────────────────

function _rapRenderTopCategories(data) {
  const el = document.getElementById('rap-cats-list');
  if (!el) return;
  el.classList.remove('rap-loading');

  const items = data.categories || data || [];
  if (!items.length) {
    el.innerHTML = '<div style="padding:20px;color:#a09890;text-align:center">Ingen data</div>';
    return;
  }

  const maxVal = Math.max(...items.map(i => i.units || 0), 1);

  el.innerHTML = '<div class="rap-bar-list">' + items.map((item, idx) => {
    const pct = ((item.units || 0) / maxVal * 100).toFixed(1);
    const pctLabel = item.pct != null ? item.pct.toFixed(1) + '%' : '';
    return `<div class="rap-bar-row">
      <span class="rap-rank">${idx + 1}.</span>
      <span class="rap-name" title="${item.name || item.category || '?'}">${item.name || item.category || '?'}</span>
      <div class="rap-bar"><div class="rap-bar-fill" style="width:${pct}%;background:${CAT_COLORS[item.code] || '#8e631f'}"></div></div>
      <span class="rap-value">${_rapFmt(item.units)} ${pctLabel ? '(' + pctLabel + ')' : ''}</span>
    </div>`;
  }).join('') + '</div>';
}

// ─── Monthly table ──────────────────────────────────────────────────

function _rapRenderMonthlyTable(data) {
  const el = document.getElementById('rap-month-table-content');
  if (!el) return;
  el.classList.remove('rap-loading');

  const rows = data.rows || data.months || [];
  if (!rows.length) {
    el.innerHTML = '<div style="padding:20px;color:#a09890;text-align:center">Ingen data</div>';
    return;
  }

  // Regnskabskonvention: alle revenue-tal er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c)
  let html = `<table class="rap-month-table">
    <thead><tr>
      <th>Måned</th>
      <th class="text-right">Omsætning (ex moms)</th>
      <th class="text-right">vs. forrige år</th>
      <th class="text-right">Ordrer</th>
      <th class="text-right">Enheder</th>
      <th class="text-right">Gns. ordreværdi (ex moms)</th>
      <th class="text-right">Ufaktureret (ex moms)</th>
    </tr></thead><tbody>`;

  for (const row of rows) {
    const isCurrent = !!row.is_current;
    const cls = isCurrent ? ' class="current"' : '';
    const mtd = isCurrent ? ' <span class="rap-mtd-badge">MTD</span>' : '';
    // Brug *_excl_moms-felter primært (regnskabskonvention)
    const rev     = row.revenue_this_excl_moms ?? row.revenue_this ?? row.revenue ?? 0;
    const revPrev = row.revenue_prev_excl_moms ?? row.revenue_prev ?? 0;

    // delta vs prev year
    const deltaRev = rev - revPrev;
    let deltaHtml;
    if (!revPrev) {
      deltaHtml = '—';
    } else {
      const deltaPct = (deltaRev / Math.abs(revPrev) * 100).toFixed(0);
      const arrow = deltaRev >= 0 ? '&#9650;' : '&#9660;';
      const cls2 = deltaRev > 0 ? 'delta-up' : deltaRev < 0 ? 'delta-down' : '';
      deltaHtml = `<span class="${cls2}">${arrow} ${Math.abs(deltaPct)}%</span>`;
    }

    // ufaktureret (ex moms)
    const ufakt = row.pending_invoice_excl_moms ?? row.pending_invoice ?? 0;
    const ufaktHtml = ufakt > 0
      ? `<span class="ufakt-warn">${_rapFmtKr(ufakt)}</span>`
      : '—';

    const avg = row.avg_order_value_excl_moms ?? row.avg_order_value ?? (row.orders ? Math.round(rev / row.orders) : 0);

    html += `<tr${cls}>
      <td>${row.month_label || '?'}${mtd}</td>
      <td class="text-right">${_rapFmtKr(rev)}</td>
      <td class="text-right">${deltaHtml}</td>
      <td class="text-right">${_rapFmt(row.orders)}</td>
      <td class="text-right">${_rapFmt(row.units)}</td>
      <td class="text-right">${_rapFmtKr(avg)}</td>
      <td class="text-right">${ufaktHtml}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// ─── toggle wiring ──────────────────────────────────────────────────

function _rapWireToggles() {
  // Monthly toggle (Kr / Enh)
  const monthlyToggle = document.getElementById('rap-monthly-toggle');
  if (monthlyToggle) {
    monthlyToggle.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.classList.contains('active')) return;
      monthlyToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _rapMonthlyMode = btn.dataset.mode;
      const h = _rapCharts['rap-monthly-canvas'];
      if (h && typeof h.setMode === 'function') h.setMode(_rapMonthlyMode);
    };
  }

  // Customer toggle (Omsætning / Ordrer)
  const custToggle = document.getElementById('rap-cust-toggle');
  if (custToggle) {
    custToggle.onclick = async (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.classList.contains('active')) return;
      custToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _rapCustSortBy = btn.dataset.by;
      try {
        const data = await fetchReportsTopCustomers(_rapCustSortBy);
        if (!_rapActive) return;
        _rapRenderTopCustomers(data);
      } catch (err) { /* ignore */ }
    };
  }

  // Lego toggle removed — stacked chart shows both kr + orders side by side
}
