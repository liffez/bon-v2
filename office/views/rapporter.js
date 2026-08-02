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

// ── Globale rapport-filtre ──────────────────────────────────────────
// Periode: preset ('ytd'|'lastyear'|'last12'|'thismonth'|'custom') + custom fra/til.
// Kategori: Set af price_category-koder der SKAL udelades. Huskes i localStorage.
let _rapPeriod = { preset: 'ytd', from: null, to: null };
let _rapExcludeCats = new Set();

const RAP_LS_CATS = 'rap_exclude_cats';
// Rækkefølge på kategori-chips (matcher price_categories i systemet).
const RAP_CAT_ORDER = ['store', 'catering', 'festival', 'produktion', 'waiste'];

// Farver holdt i sync med legomodellens palette (settings.lego_pax_categories),
// så samme begreb har samme farve på tværs af siden. Festival = orange (som lego),
// IKKE grøn — grøn betyder Events i legoen. Butik/Catering/Produktion matcher
// legoens brun/guld/blå.
const CAT_COLORS = {
  store:      '#6d4c16',   // brun  (= lego "Store")
  catering:   '#c49a45',   // guld  (= lego "Mellem")
  festival:   '#d4652a',   // orange (= lego "Festival")
  produktion: '#4a90d9',   // blå   (= lego "Små")
  waiste:     '#c8c2bb'    // grå   (ingen lego-pendant)
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

// Drill-down: åbn Kunde 360° / Firma 360° fra top-kunde-listen.
// Bruger eksisterende globals (graceful degradation hvis ikke loadet endnu).
function _rapDrillCustomer(entityType, id) {
  if (!id) return;
  if (entityType === 'company') {
    if (typeof window.openFirma360 === 'function') window.openFirma360(id);
  } else if (typeof window.openKunde360 === 'function') {
    window.openKunde360(id);
  }
}

function _rapGotoFakturering() {
  if (typeof window.officeGoto === 'function') window.officeGoto('fakturering');
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

  <div class="rap-filterbar" id="rap-filterbar">
    <div class="rap-filter-group">
      <span class="rap-filter-label">Periode</span>
      <div class="rap-toggle rap-period-presets" id="rap-period-presets">
        <button data-preset="ytd" class="active">I år</button>
        <button data-preset="lastyear">Sidste år</button>
        <button data-preset="last12">Seneste 12 mdr.</button>
        <button data-preset="thismonth">Denne måned</button>
        <button data-preset="custom">Egen periode…</button>
      </div>
      <div class="rap-custom-range" id="rap-custom-range" style="display:none">
        <input type="date" id="rap-from" aria-label="Fra dato">
        <span>–</span>
        <input type="date" id="rap-to" aria-label="Til dato">
      </div>
    </div>
    <div class="rap-filter-group">
      <span class="rap-filter-label">Kategorier</span>
      <div class="rap-cat-filter" id="rap-cat-filter"></div>
    </div>
    <span class="rap-period-caption" id="rap-period-caption"></span>
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

  <div class="rap-card" id="rap-giveaways">
    <div class="rap-card-head">
      <h3 class="rap-card-title">Sponsorat &amp; modregning (ikke omsætning)</h3>
      <span style="font-size:.78rem;color:var(--color-text-dim,#7a6f5f)">Ægte værdi givet væk/byttet i år — tælles ikke med i omsætningen</span>
    </div>
    <div id="rap-giveaways-content" class="rap-loading" style="min-height:70px"></div>
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
  _rapPeriod = { preset: 'ytd', from: null, to: null };
  _rapExcludeCats = _rapLoadExcludeCats();

  container.innerHTML = _rapShellHtml();
  _rapWireToggles();
  _rapWireFilters();
  _rapLoadAll();
}

// ─── filter state helpers ───────────────────────────────────────────

function _rapLoadExcludeCats() {
  try {
    const raw = localStorage.getItem(RAP_LS_CATS);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter(c => RAP_CAT_ORDER.includes(c)) : []);
  } catch (_) { return new Set(); }
}

function _rapSaveExcludeCats() {
  try { localStorage.setItem(RAP_LS_CATS, JSON.stringify([..._rapExcludeCats])); } catch (_) {}
}

// Læg én dag til en ISO-dato (til at gøre inklusiv til-dato eksklusiv for serveren).
function _rapAddDay(iso) {
  const p = iso.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10);
}

// Resolve preset → { from, to } med to EKSKLUSIV (server-konvention).
// Returnerer null hvis 'custom' uden begge datoer (så vi ikke fetcher ugyldigt).
// Bruger danske dato-helpers (todayISO/offsetISO) — ikke new Date().toISOString().
function _rapResolvePeriod() {
  const p = _rapPeriod;
  const today = todayISO();                 // Europe/Copenhagen
  const parts = today.split('-').map(Number);
  const year = parts[0];

  if (p.preset === 'custom') {
    if (!p.from || !p.to || p.from > p.to) return null;
    return { from: p.from, to: _rapAddDay(p.to) };
  }
  if (p.preset === 'lastyear') {
    return { from: `${year - 1}-01-01`, to: `${year}-01-01` };
  }
  if (p.preset === 'last12') {
    // Første dag i måneden 11 måneder tilbage (Date.UTC ruller år ved negativ måned).
    const d = new Date(Date.UTC(parts[0], parts[1] - 1 - 11, 1)).toISOString().slice(0, 10);
    return { from: d, to: offsetISO(1) };
  }
  if (p.preset === 'thismonth') {
    return { from: today.slice(0, 7) + '-01', to: offsetISO(1) };
  }
  // ytd (default)
  return { from: `${year}-01-01`, to: offsetISO(1) };
}

// Bygger filter-objektet der sendes til alle fetchers. null = ugyldig custom-periode.
function _rapFilterParams() {
  const period = _rapResolvePeriod();
  if (!period) return null;
  const params = { from: period.from, to: period.to };
  if (_rapExcludeCats.size) params.exclude_cats = [..._rapExcludeCats].join(',');
  return params;
}

// Menneskelæselig etiket for den valgte periode (til caption).
function _rapPeriodLabel() {
  const p = _rapPeriod;
  if (p.preset === 'lastyear') return 'Sidste år';
  if (p.preset === 'last12')   return 'Seneste 12 måneder';
  if (p.preset === 'thismonth') return 'Denne måned';
  if (p.preset === 'custom') {
    if (!p.from || !p.to) return 'Vælg fra- og til-dato';
    return _rapFmtDate(p.from) + ' – ' + _rapFmtDate(p.to);
  }
  return 'År til dato';
}

function _rapFmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
}

function _rapUpdateCaption() {
  const el = document.getElementById('rap-period-caption');
  if (!el) return;
  let txt = 'Viser: ' + _rapPeriodLabel();
  if (_rapExcludeCats.size) {
    const names = [..._rapExcludeCats].map(c => CAT_LABELS[c] || c).join(', ');
    txt += ' · uden ' + names;
  }
  el.textContent = txt;
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
  _rapUpdateCaption();
  const filters = _rapFilterParams();
  // Ugyldig custom-periode (mangler fra/til) → vent, ram ikke serveren med halve datoer.
  if (!filters) return;
  try {
    const [summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats, giveaways] = await Promise.all([
      fetchReportsSummary(filters),
      fetchReportsMonthly(filters),
      fetchReportsTopCustomers(_rapCustSortBy, filters),
      fetchReportsCategories(filters),
      fetchReportsMonthlyTable(filters),
      _rapFetchLego(filters),
      fetchReportsCumulative(null, filters),
      fetchReportsTopCategories(filters),
      // Ikke-fatal: dette kort er additivt og må ALDRIG kunne vælte hele
      // rapportsiden (Promise.all fejler samlet). Fejler det, vises kortet tomt.
      fetchReportsGiveaways(filters).catch(function(err) {
        console.error('[rapporter] giveaways fejlede:', err);
        return null;
      }),
    ]);
    if (!_rapActive) return;
    _rapRenderAll(summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats, giveaways);
  } catch (err) {
    if (!_rapActive) return;
    _rapContainer.innerHTML = '<div style="padding:40px;text-align:center;color:red">Fejl: ' + err.message + '</div>';
  }
}

// ─── render orchestrator ────────────────────────────────────────────

function _rapRenderAll(summary, monthly, topCust, categories, monthlyTable, lego, cumulative, topCats, giveaways) {
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
  _rapRenderGiveaways(giveaways);
}

// ─── Sponsorat & modregning (ikke omsætning) ────────────────────────
function _rapRenderGiveaways(d) {
  const el = document.getElementById('rap-giveaways-content');
  if (!el) return;
  el.classList.remove('rap-loading');
  if (!d) {
    el.innerHTML = '<div style="padding:12px 4px;color:var(--color-text-dim,#7a6f5f)">Kunne ikke hente sponsorat/modregning lige nu.</div>';
    return;
  }
  const types = (d && d.types) || [];
  if (!types.length) {
    el.innerHTML = '<div style="padding:12px 4px;color:var(--color-text-dim,#7a6f5f)">Ingen sponsorat eller modregning registreret i år.</div>';
    return;
  }
  const rows = types.map(t =>
    '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 4px;border-top:1px solid var(--color-border,#e5ded3)">'
      + '<span>' + _rapEsc(t.label) + ' <span style="color:var(--color-text-dim,#7a6f5f)">· ' + t.orders + (t.orders === 1 ? ' bon' : ' bons') + '</span></span>'
      + '<strong>' + _rapFmtKr(Math.round(t.total_excl_moms)) + '</strong>'
    + '</div>'
  ).join('');
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:2px 4px 8px">'
      + '<span style="font-size:.82rem;color:var(--color-text-dim,#7a6f5f)">' + d.orders + ' bons — ægte værdi ex moms</span>'
      + '<span style="font-size:1.35rem;font-family:var(--font-heading,inherit)"><strong>' + _rapFmtKr(Math.round(d.total_excl_moms)) + '</strong></span>'
    + '</div>' + rows;
}

function _rapEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
      label: 'Omsætning (ex moms)',
      delta: _rapDeltaHtml(revenueYtd, revenueYtdPrev, 'pct'),
      sub: 'vs. samme periode året før'
    },
    {
      value: _rapFmt(d.orders_ytd),
      label: 'Ordrer',
      delta: _rapDeltaHtml(d.orders_ytd, d.orders_ytd_prev, 'abs'),
      sub: 'vs. samme periode året før'
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
      sub: d.pending_count != null ? d.pending_count + ' bons' : '',
      // Klik → Fakturering (kun når der faktisk er noget at fakturere)
      action: (d.pending_count > 0) ? 'fakturering' : null
    }
  ];

  el.innerHTML = cards.map(c => `
    <div class="rap-kpi${c.action ? ' rap-clickable' : ''}"${c.action ? ` data-action="${c.action}" title="Åbn fakturering →"` : ''}>
      <div class="rap-kpi-value">${c.value}</div>
      <div class="rap-kpi-label">${c.label}</div>
      ${c.delta ? '<div>' + c.delta + '</div>' : ''}
      ${c.sub ? '<div class="rap-kpi-sub">' + c.sub + '</div>' : ''}
    </div>
  `).join('');

  el.onclick = (e) => {
    const card = e.target.closest('.rap-kpi[data-action="fakturering"]');
    if (card) _rapGotoFakturering();
  };
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
    // top-customers returnerer id + entity_type (company|customer) → klik åbner profil
    const id = item.id;
    const etype = item.entity_type === 'company' ? 'company' : 'customer';
    const drill = id != null;
    const attrs = drill ? ` rap-clickable" data-cust-id="${id}" data-entity-type="${etype}" title="Åbn profil → ${name}` : '';
    return `<div class="rap-bar-row${attrs}">
      <span class="rap-rank">${idx + 1}.</span>
      <span class="rap-name" title="${name}">${name}</span>
      <div class="rap-bar"><div class="rap-bar-fill" style="width:${pct}%"></div></div>
      <span class="rap-value">${displayVal}</span>
    </div>`;
  }).join('') + '</div>';

  el.onclick = (e) => {
    const row = e.target.closest('.rap-bar-row[data-cust-id]');
    if (row) _rapDrillCustomer(row.dataset.entityType, row.dataset.custId);
  };
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

    // Produktion (prep/top-up) er intern produktion, ikke salg. Enheds-tallet er
    // produktionsvolumen — mærkes tydeligt så det ikke læses som solgte enheder.
    const isProd = cat.is_production;
    const labelHtml = isProd
      ? `${label} <span class="rap-cat-note">· produktion (intern, ikke salg)</span>`
      : label;
    const unitsHtml = isProd
      ? `<span class="rap-cat-prod-units" title="Produktionsvolumen — ikke solgte enheder">${_rapFmt(cat.units)} <span class="rap-cat-note">prod.</span></span>`
      : _rapFmt(cat.units);

    tableHtml += `<tr${isProd ? ' class="rap-cat-row-prod"' : ''}>
      <td><span class="rap-cat-dot" style="background:${color}"></span>${labelHtml}</td>
      <td class="text-right">${unitsHtml}</td>
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

/** Returnerer fetch-promise for lego baseret på nuværende state. Kategori-filter følger med. */
function _rapFetchLego(filters) {
  const ff = filters || _rapFilterParams() || {};
  if (_rapLegoCompare === 'none') {
    return fetchReportsLego(_rapLegoMonths, _rapLegoYear, ff);
  }
  // Sammenlignings-tilstand: brug 1. valgte måned (eller indeværende måned hvis ingen valgt).
  const month = _rapLegoMonths[0] || (new Date().getMonth() + 1);
  const thisYear = new Date().getFullYear();
  const yearOffsets = _rapLegoCompare === 'prev2' ? [2, 1, 0] : [1, 0];
  const mm = String(month).padStart(2, '0');
  const periods = yearOffsets.map(off => `${thisYear - off}-${mm}`);
  return fetchReportsLego({ periods }, null, ff);
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
      <th class="text-right">Realiseret (ex moms)</th>
      <th class="text-right">Booket (ex moms)</th>
      <th class="text-right">vs. forrige år</th>
      <th class="text-right">Ordrer</th>
      <th class="text-right">Enheder</th>
      <th class="text-right">Gns. ordreværdi (ex moms)</th>
      <th class="text-right">Ufaktureret (ex moms)</th>
    </tr></thead><tbody>`;

  for (const row of rows) {
    const isCurrent = !!row.is_current;
    const isFuture  = !!row.is_future;
    const cls = isCurrent ? ' class="current"' : (isFuture ? ' class="future"' : '');
    const mtd = isCurrent ? ' <span class="rap-mtd-badge">MTD</span>' : '';
    // Brug *_excl_moms-felter primært (regnskabskonvention)
    const rev     = row.revenue_this_excl_moms ?? row.revenue_this ?? row.revenue ?? 0;
    const revPrev = row.revenue_prev_excl_moms ?? row.revenue_prev ?? 0;

    // Booket pipeline (forventet, ikke leveret endnu)
    const booked = row.revenue_booked_excl_moms ?? row.revenue_booked ?? 0;
    const bookedHtml = booked > 0
      ? `<span class="rap-booked">${_rapFmtKr(booked)}</span>`
      : '—';

    // delta vs prev year — fremtidige måneder kan ikke sammenlignes (intet realiseret endnu)
    let deltaHtml;
    if (isFuture || !revPrev) {
      deltaHtml = '—';
    } else {
      const deltaRev = rev - revPrev;
      const deltaPct = (deltaRev / Math.abs(revPrev) * 100).toFixed(0);
      const arrow = deltaRev >= 0 ? '&#9650;' : '&#9660;';
      const cls2 = deltaRev > 0 ? 'delta-up' : deltaRev < 0 ? 'delta-down' : '';
      deltaHtml = `<span class="${cls2}">${arrow} ${Math.abs(deltaPct)}%</span>`;
    }

    // ufaktureret (ex moms)
    const ufakt = row.pending_invoice_excl_moms ?? row.pending_invoice ?? 0;
    const ufaktHtml = ufakt > 0
      ? `<span class="ufakt-warn rap-ufakt-link" data-action="fakturering" title="Åbn fakturering →">${_rapFmtKr(ufakt)}</span>`
      : '—';

    const avg = row.avg_order_value_excl_moms ?? row.avg_order_value ?? (row.orders ? Math.round(rev / row.orders) : 0);

    html += `<tr${cls}>
      <td>${row.month_label || '?'}${mtd}</td>
      <td class="text-right">${rev > 0 ? _rapFmtKr(rev) : '—'}</td>
      <td class="text-right">${bookedHtml}</td>
      <td class="text-right">${deltaHtml}</td>
      <td class="text-right">${_rapFmt(row.orders)}</td>
      <td class="text-right">${_rapFmt(row.units)}</td>
      <td class="text-right">${avg > 0 ? _rapFmtKr(avg) : '—'}</td>
      <td class="text-right">${ufaktHtml}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  el.innerHTML = html;

  el.onclick = (e) => {
    const link = e.target.closest('[data-action="fakturering"]');
    if (link) _rapGotoFakturering();
  };
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
        const data = await fetchReportsTopCustomers(_rapCustSortBy, _rapFilterParams());
        if (!_rapActive) return;
        _rapRenderTopCustomers(data);
      } catch (err) { /* ignore */ }
    };
  }

  // Lego toggle removed — stacked chart shows both kr + orders side by side
}

// ─── filter bar wiring ──────────────────────────────────────────────

function _rapWireFilters() {
  _rapRenderCatChips();
  _rapUpdateCaption();

  // Periode-presets
  const presets = document.getElementById('rap-period-presets');
  const customRange = document.getElementById('rap-custom-range');
  const fromEl = document.getElementById('rap-from');
  const toEl   = document.getElementById('rap-to');

  if (presets) {
    presets.onclick = (e) => {
      const btn = e.target.closest('button[data-preset]');
      if (!btn) return;
      const preset = btn.dataset.preset;
      presets.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _rapPeriod.preset = preset;

      if (preset === 'custom') {
        if (customRange) customRange.style.display = '';
        // Prefyld med YTD som fornuftigt udgangspunkt hvis tomt → straks gyldigt.
        if (fromEl && !fromEl.value) fromEl.value = todayISO().slice(0, 4) + '-01-01';
        if (toEl && !toEl.value) toEl.value = todayISO();
        _rapPeriod.from = fromEl ? fromEl.value : null;
        _rapPeriod.to   = toEl ? toEl.value : null;
      } else {
        if (customRange) customRange.style.display = 'none';
      }
      _rapUpdateCaption();
      _rapLoadAll();
    };
  }

  const onCustomChange = () => {
    _rapPeriod.preset = 'custom';
    _rapPeriod.from = fromEl ? fromEl.value : null;
    _rapPeriod.to   = toEl ? toEl.value : null;
    _rapUpdateCaption();
    _rapLoadAll();   // _rapLoadAll no-op'er hvis periode er ufuldstændig
  };
  if (fromEl) fromEl.onchange = onCustomChange;
  if (toEl)   toEl.onchange = onCustomChange;

  // Kategori-chips (delegeret)
  const catEl = document.getElementById('rap-cat-filter');
  if (catEl) {
    catEl.onclick = (e) => {
      const chip = e.target.closest('.rap-cat-chip[data-cat]');
      if (!chip) return;
      const code = chip.dataset.cat;
      if (_rapExcludeCats.has(code)) _rapExcludeCats.delete(code);
      else _rapExcludeCats.add(code);
      _rapSaveExcludeCats();
      const nowExcluded = _rapExcludeCats.has(code);
      chip.classList.toggle('excluded', nowExcluded);
      const label = CAT_LABELS[code] || code;
      chip.title = 'Klik for at ' + (nowExcluded ? 'medregne' : 'fjerne') + ' ' + label;
      _rapUpdateCaption();
      _rapLoadAll();
    };
  }
}

function _rapRenderCatChips() {
  const el = document.getElementById('rap-cat-filter');
  if (!el) return;
  el.innerHTML = RAP_CAT_ORDER.map(code => {
    const label = CAT_LABELS[code] || code;
    const color = CAT_COLORS[code] || '#999';
    const excl = _rapExcludeCats.has(code) ? ' excluded' : '';
    return `<button class="rap-cat-chip${excl}" data-cat="${code}" title="Klik for at ${excl ? 'medregne' : 'fjerne'} ${label}">
      <span class="rap-cat-chip-dot" style="background:${color}"></span>${label}
    </button>`;
  }).join('');
}
