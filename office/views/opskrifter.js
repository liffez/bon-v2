/**
 * office/views/opskrifter.js
 * ═══════════════════════════════════════════════════════════
 * Opskrifter & priser — margin-analyse-view.
 * Hovedtabel + KPI-strip + drill-down side-panel.
 *
 * Moms: backend leverer alle tal ex moms. Frontend regner ikke selv.
 * ═══════════════════════════════════════════════════════════
 */

/* globals fetchRecipesOverview, fetchRecipeTargets, putRecipeTargets,
           patchRecipeTarget, putItemPrice, refreshRecipeCosts,
           grocyRecipeLink, fetchRecipeComposition */

const _opsState = {
    container: null,
    data: null,         // sidste overview-response
    targetsData: null,  // { categories, targets }
    selected: null,     // valgt recipe i drill-down
    priceCategory: 'catering',
    periodDays: 365,
    categoryFilter: '',
    searchText: '',
    sortKey: 'default',
    sortDir: 'asc',
    activeFilters: new Set(['active']),
    sseHandler: null,
    compStack: [],      // drill-down: recipe_id-historik i råvare-sektionen
    compCache: {},      // recipe_id → composition-response (per session)
};

function initOpskrifter(container) {
    _opsState.container = container;
    container.innerHTML = '<div style="padding:40px;text-align:center;color:#6a6359">Indlæser opskrifter & priser...</div>';
    _opsLoad();

    // SSE: lyt efter pris/target/kost-opdateringer
    _opsState.sseHandler = (event, data) => {
        if (!_opsState.container) return;
        if (event === 'item_price_updated' || event === 'recipe_costs_refreshed' || event === 'recipe_targets_updated') {
            _opsLoad();
        }
    };
}

function cleanupOpskrifter() {
    _opsState.container = null;
    _opsState.data = null;
    _opsState.selected = null;
    _opsState.sseHandler = null;
    _opsState.compStack = [];
    _opsState.compCache = {};
    _opsClosePanel();
}

// Eksponer SSE-handler globalt så office/index.html kan kalde den
function _opsHandleSSE(event, data) {
    if (_opsState.sseHandler) _opsState.sseHandler(event, data);
}

// ─── Load ────────────────────────────────────────────────────

async function _opsLoad() {
    try {
        const [overview, targets] = await Promise.all([
            fetchRecipesOverview({
                price_category: _opsState.priceCategory,
                period_days: _opsState.periodDays,
                category: _opsState.categoryFilter || undefined,
            }),
            fetchRecipeTargets(),
        ]);
        _opsState.data = overview;
        _opsState.targetsData = targets;
        _opsRender();
    } catch (err) {
        if (_opsState.container) {
            _opsState.container.innerHTML =
                `<div style="padding:40px;color:#bc181b">Fejl: ${_opsEsc(err.message)}</div>`;
        }
    }
}

// ─── Render ──────────────────────────────────────────────────

function _opsRender() {
    if (!_opsState.container || !_opsState.data) return;
    const d = _opsState.data;
    const s = d.summary;

    const lossCount = s.loss_making_count || 0;
    const showLossKpi = lossCount > 0;

    _opsState.container.innerHTML = `
        <div class="ops-shell">
            <div class="ops-topbar">
                <h2>📊 Opskrifter & priser</h2>
                <span class="ops-vat-pill">ALLE PRISER EX MOMS</span>
                <div class="ops-refresh-info">
                    <span>Kostpriser ${_opsStaleLabel(d.cost_refreshed_at, d.cost_stale)}</span>
                    <span class="ops-window-note" title="Kostprisen er et mængdevægtet snit af indkøbene i vinduet. Ændres under ⚙ Indstillinger.">·&nbsp;snit over ${d.price_window_days || 90} dage</span>
                    <button class="ops-btn-secondary" data-act="refresh">↻ Opdater fra Grocy</button>
                </div>
                <div class="ops-right-tools">
                    <button class="ops-btn-secondary" data-act="targets">⚙ Indstillinger</button>
                </div>
                <div class="ops-target-pop" id="ops-target-pop"></div>
            </div>

            <div class="ops-filter-row">
                <div class="ops-filter-group">
                    <span class="ops-filter-label">Priskategori</span>
                    <div class="ops-seg" data-seg="price-cat">
                        <button data-val="catering" class="${_opsState.priceCategory === 'catering' ? 'active' : ''}">Catering</button>
                        <button data-val="festival" class="${_opsState.priceCategory === 'festival' ? 'active' : ''}">Festival</button>
                        <button data-val="store" class="${_opsState.priceCategory === 'store' ? 'active' : ''}">Butik</button>
                    </div>
                </div>
                <div class="ops-filter-group">
                    <span class="ops-filter-label">Periode</span>
                    <select id="ops-period">
                        <option value="30" ${_opsState.periodDays === 30 ? 'selected' : ''}>Sidste 30 dage</option>
                        <option value="90" ${_opsState.periodDays === 90 ? 'selected' : ''}>Sidste 90 dage</option>
                        <option value="180" ${_opsState.periodDays === 180 ? 'selected' : ''}>Sidste 6 måneder</option>
                        <option value="365" ${_opsState.periodDays === 365 ? 'selected' : ''}>Sidste 12 måneder</option>
                    </select>
                </div>
                <div class="ops-filter-group">
                    <span class="ops-filter-label">Kategori</span>
                    <select id="ops-cat">
                        <option value="">Alle</option>
                        ${(_opsState.targetsData?.categories || []).map(c =>
                            `<option value="${_opsEsc(c)}" ${_opsState.categoryFilter === c ? 'selected' : ''}>${_opsEsc(c)}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="ops-spacer"></div>
                <button class="ops-clear-filters ${_opsClearFiltersVisible() ? 'show' : ''}" data-act="clear-filters">✕ Ryd filtre</button>
                <input type="search" id="ops-search" placeholder="Søg opskrift…" value="${_opsEsc(_opsState.searchText)}">
            </div>

            <div class="ops-kpi-strip">
                <div class="ops-kpi info">
                    <div class="ops-kpi-label">Omsætning i perioden</div>
                    <div class="ops-kpi-value">${_opsFmtKr(s.total_revenue_excl_moms)}</div>
                    <div class="ops-kpi-sub">DB: ${_opsFmtKr(s.total_db_kr_excl_moms)}</div>
                </div>
                <div class="ops-kpi info">
                    <div class="ops-kpi-label">Gns. DB% (vægtet)</div>
                    <div class="ops-kpi-value">${_opsFmtPct(s.avg_db_pct_weighted)}</div>
                    <div class="ops-kpi-sub">vægtet på omsætning</div>
                </div>
                <div class="ops-kpi clickable ${_opsState.activeFilters.has('active') ? 'active' : ''}" data-filter="active">
                    <div class="ops-kpi-label">Aktive opskrifter</div>
                    <div class="ops-kpi-value">${s.active_count}</div>
                    <div class="ops-kpi-sub">af ${s.total_count} i Grocy</div>
                </div>
                <div class="ops-kpi primary clickable ${_opsState.activeFilters.has('under-target') ? 'active' : ''}" data-filter="under-target">
                    <div class="ops-kpi-label">Andel under mål</div>
                    <div class="ops-kpi-value">${_opsFmtPct(s.share_under_target_pct)}</div>
                    <div class="ops-kpi-sub">${s.under_target_count} af ${s.active_count} aktive</div>
                </div>
                ${showLossKpi ? `
                <div class="ops-kpi loss clickable ${_opsState.activeFilters.has('loss-making') ? 'active' : ''}" data-filter="loss-making">
                    <div class="ops-kpi-label">Tabsgivende</div>
                    <div class="ops-kpi-value">${lossCount}</div>
                    <div class="ops-kpi-sub">kostpris > salgspris</div>
                </div>` : ''}
                <div class="ops-kpi alert clickable ${_opsState.activeFilters.has('missing-price') ? 'active' : ''}" data-filter="missing-price">
                    <div class="ops-kpi-label">Mangler salgspris</div>
                    <div class="ops-kpi-value">${s.missing_price_count}</div>
                    <div class="ops-kpi-sub">i ${_opsState.priceCategory}</div>
                </div>
                <div class="ops-kpi alert clickable ${_opsState.activeFilters.has('cost-unknown') ? 'active' : ''}" data-filter="cost-unknown"
                     title="Salgbare varer hvor ingen råvarepris er kendt. De ville ellers vise 100 % dækningsbidrag.">
                    <div class="ops-kpi-label">Mangler kostpris</div>
                    <div class="ops-kpi-value">${s.cost_unknown_count ?? 0}</div>
                    <div class="ops-kpi-sub">med salgspris${s.cost_minimum_count ? ' · ' + s.cost_minimum_count + ' delvist kendt' : ''}</div>
                </div>
                ${/* Vises også når filteret er tændt — ellers forsvinder pillen
                      og efterlader en tom tabel uden vej tilbage. */
                  ((s.price_warning_count ?? 0) || _opsState.activeFilters.has('price-warning')) ? `
                <div class="ops-kpi clickable ${_opsState.activeFilters.has('price-warning') ? 'active' : ''}" data-filter="price-warning"
                     title="Kostprisen er komplet, men bygger på mindst én pris der ser forkert ud — en produceret vares lagerpris der afviger fra opskriften, eller et enkeltkøb langt fra gennemsnittet.">
                    <div class="ops-kpi-label">Pris bør ses efter</div>
                    <div class="ops-kpi-value">${s.price_warning_count}</div>
                    <div class="ops-kpi-sub">tallet er der — kilden er i tvivl</div>
                </div>` : ''}
                <div class="ops-kpi clickable ${_opsState.activeFilters.has('not-sold') ? 'active' : ''}" data-filter="not-sold">
                    <div class="ops-kpi-label">Ikke solgt i perioden</div>
                    <div class="ops-kpi-value">${s.not_sold_count}</div>
                    <div class="ops-kpi-sub">overvej inaktiv?</div>
                </div>
                <div class="ops-kpi clickable ${_opsState.activeFilters.has('oko') ? 'active' : ''}" data-filter="oko">
                    <div class="ops-kpi-label">Økologiske</div>
                    <div class="ops-kpi-value">${s.oko_count}</div>
                    <div class="ops-kpi-sub">${s.active_count ? Math.round(s.oko_count / s.active_count * 100) + '% af aktive' : '—'}</div>
                </div>
            </div>

            <div class="ops-table-wrap">
                <table class="ops-table">
                    <thead>
                        <tr>
                            <th data-sort="name">Opskrift <span class="ops-arrow">${_opsSortIndicator('name')}</span></th>
                            <th class="num" data-sort="cost">Kostpris <span class="ops-arrow">${_opsSortIndicator('cost')}</span></th>
                            <th class="num" data-sort="sales">Salgspris <span class="ops-arrow">${_opsSortIndicator('sales')}</span></th>
                            <th class="num" data-sort="db_kr">DB kr <span class="ops-arrow">${_opsSortIndicator('db_kr')}</span></th>
                            <th class="num" data-sort="db_pct">DB % <span class="ops-arrow">${_opsSortIndicator('db_pct')}</span></th>
                            <th class="num" data-sort="sold">Solgt — trend <span class="ops-arrow">${_opsSortIndicator('sold')}</span></th>
                            <th class="num" data-sort="rev">Omsætning <span class="ops-arrow">${_opsSortIndicator('rev')}</span></th>
                            <th class="num ops-col-co2" data-sort="co2_per">CO₂e/stk <span class="ops-arrow">${_opsSortIndicator('co2_per')}</span></th>
                            <th class="num ops-col-co2" data-sort="co2_total">CO₂ total <span class="ops-arrow">${_opsSortIndicator('co2_total')}</span></th>
                        </tr>
                    </thead>
                    <tbody id="ops-tbody"></tbody>
                </table>
            </div>

            <div class="ops-footer-stats">
                <span id="ops-row-count"></span>
                <span>Sparkline viser solgt antal pr. bucket (12 buckets dækker valgt periode)</span>
            </div>
        </div>

        <div class="ops-panel-backdrop" id="ops-backdrop"></div>
        <div class="ops-panel" id="ops-panel">
            <div class="ops-panel-head">
                <div class="ops-panel-title" id="ops-panel-title">—</div>
                <button class="ops-close-btn" data-act="close-panel">×</button>
            </div>
            <div class="ops-panel-body" id="ops-panel-body"></div>
        </div>
    `;

    _opsBindEvents();
    _opsRenderRows();
}

// ─── Tabel-rendering ─────────────────────────────────────────

function _opsFilterAndSort(recipes) {
    const search = (_opsState.searchText || '').toLowerCase();
    let rows = recipes.filter(r => {
        if (search && !(r.name || '').toLowerCase().includes(search)) return false;
        if (_opsState.activeFilters.has('active') && !r.is_active) return false;
        if (_opsState.activeFilters.has('under-target') && !r.under_target) return false;
        if (_opsState.activeFilters.has('loss-making') && !r.loss_making) return false;
        if (_opsState.activeFilters.has('missing-price') && r.sales_price_excl_moms != null) return false;
        if (_opsState.activeFilters.has('cost-unknown') && !r.cost_unknown) return false;
        if (_opsState.activeFilters.has('price-warning') && !(r.cost_price_warnings || []).length) return false;
        if (_opsState.activeFilters.has('not-sold') && r.sold_units !== 0) return false;
        if (_opsState.activeFilters.has('oko') && !r.is_organic) return false;
        return true;
    });

    if (_opsState.sortKey === 'default') {
        // Default: tabsgivende først (omsætning desc), så under-mål (omsætning desc), så resten (db_pct asc)
        rows.sort((a, b) => {
            const aLoss = a.loss_making ? 0 : (a.under_target ? 1 : 2);
            const bLoss = b.loss_making ? 0 : (b.under_target ? 1 : 2);
            if (aLoss !== bLoss) return aLoss - bLoss;
            if (aLoss < 2) {
                return (b.revenue_excl_moms || 0) - (a.revenue_excl_moms || 0);
            }
            const ap = a.db_pct == null ? 999 : a.db_pct;
            const bp = b.db_pct == null ? 999 : b.db_pct;
            return ap - bp;
        });
    } else {
        const key = _opsState.sortKey;
        const dir = _opsState.sortDir === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
            const av = _opsSortValue(a, key);
            const bv = _opsSortValue(b, key);
            if (typeof av === 'string') return dir * av.localeCompare(bv);
            return dir * ((av ?? 0) - (bv ?? 0));
        });
    }
    return rows;
}

function _opsSortValue(r, key) {
    switch (key) {
        case 'name':       return r.name || '';
        case 'cost':       return r.cost_price_excl_moms;
        case 'sales':      return r.sales_price_excl_moms;
        case 'db_kr':      return r.db_kr_excl_moms;
        case 'db_pct':     return r.db_pct;
        case 'sold':       return r.sold_units;
        case 'rev':        return r.revenue_excl_moms;
        case 'co2_per':    return r.co2e_per_unit;
        case 'co2_total':  return r.co2_total_period;
        default:           return 0;
    }
}

function _opsSortIndicator(key) {
    if (_opsState.sortKey !== key) return '↕';
    return _opsState.sortDir === 'asc'
        ? '<span class="ops-sort-ind">↑</span>'
        : '<span class="ops-sort-ind">↓</span>';
}

function _opsRenderRows() {
    const tbody = document.getElementById('ops-tbody');
    if (!tbody || !_opsState.data) return;
    const rows = _opsFilterAndSort(_opsState.data.recipes);

    tbody.innerHTML = rows.map(r => _opsRowHtml(r)).join('') || `
        <tr><td colspan="9" style="text-align:center;padding:30px;color:#6a6359">Ingen opskrifter matcher filtrene</td></tr>
    `;

    const total = _opsState.data.recipes.length;
    const cnt = document.getElementById('ops-row-count');
    if (cnt) cnt.textContent = `Viser ${rows.length} af ${total} opskrifter`;
}

function _opsRowHtml(r) {
    const dbPctCls = r.loss_making ? 'loss'
        : r.under_target ? 'low'
        : (r.db_pct != null && r.db_target_pct != null && r.db_pct >= r.db_target_pct + 5) ? 'good'
        : 'ok';
    const dbBarWidth = r.db_pct != null ? Math.max(0, Math.min(100, r.db_pct)) : 0;

    let rowCls = '';
    if (r.loss_making) rowCls = 'ops-row-loss';
    else if (r.cost_unknown) rowCls = 'ops-row-missing-price';
    else if (r.sales_price_excl_moms == null) rowCls = 'ops-row-missing-price';
    else if (r.under_target) rowCls = 'ops-row-under-target';
    else if (r.sold_units === 0) rowCls = 'ops-row-not-sold';
    if (!r.is_active) rowCls += ' ops-row-inactive';

    // Hvad mangler der pris på? Listen er kort nok til at stå i en tooltip,
    // og uden den er "ukendt" bare en påstand man ikke kan handle på.
    const manglerTxt = (r.cost_missing_prices || []).join(', ');
    // Er kostprisen et MINIMUM, er dækningsbidraget et MAKSIMUM. `Øl -Special`
    // har kun emballagen prissat og ville ellers stå med 99 % — et tal der ser
    // fuldstændig ægte ud. "≤" siger sandheden uden at gætte hvor galt det er.
    // Kun foran et TAL. "≤ —" er meningsløst, og rækker uden salgspris har
    // netop ingen dækningsbidrag at sætte en grænse på.
    const maksMark = (r.cost_is_minimum && r.db_pct != null)
        ? `<span class="ops-min-mark" title="højst — kostprisen mangler pris på: ${_opsEsc(manglerTxt)}">≤ </span>`
        : '';

    const badges = [];
    if (r.is_organic) badges.push('<span class="ops-badge ops-badge-oko">øko</span>');
    if (!r.is_active) badges.push('<span class="ops-badge ops-badge-inactive">inaktiv</span>');
    if (r.sales_price_excl_moms == null) badges.push('<span class="ops-badge ops-badge-no-price">ingen pris</span>');
    if (r.cost_unknown) badges.push(`<span class="ops-badge ops-badge-no-cost" title="Ingen kendt råvarepris${manglerTxt ? ' — mangler: ' + _opsEsc(manglerTxt) : ''}">ingen kostpris</span>`);
    else if (r.cost_is_minimum) badges.push(`<span class="ops-badge ops-badge-part-cost" title="Kostprisen er et minimum — mangler pris på: ${_opsEsc(manglerTxt)}">delvis kostpris</span>`);
    // Advarsler er ikke "mangler" — prisen er kendt, men noget ved den ser
    // forkert ud (#557/#558). Teksten kommer fra serveren, så tabellen,
    // drill-downet og `audit:kostpris-kilder` siger det samme om det samme tal.
    const advarsler = r.cost_price_warnings || [];
    if (advarsler.length) {
        const txt = advarsler.map(_opsWarnTekst).join('\n');
        const antal = advarsler.length > 1 ? ` ${advarsler.length}` : '';
        badges.push(`<span class="ops-badge ops-badge-price-warn" title="${_opsEsc(txt)}">`
                  + `pris?${antal}</span>`);
    }
    if (r.loss_making) badges.push('<span class="ops-badge ops-badge-loss">tab</span>');

    return `
        <tr class="${rowCls}" data-recipe-id="${r.grocy_recipe_id}">
            <td>
                <div class="ops-name-cell">
                    <span class="ops-name">${_opsEsc(r.name)}
                        ${badges.length ? `<span class="ops-badges">${badges.join('')}</span>` : ''}
                    </span>
                    <span class="ops-cat ops-col-cat">${_opsEsc(r.category || '—')}</span>
                </div>
            </td>
            <td class="num">${r.cost_unknown
                ? `<span class="ops-unknown" title="Ingen kendt råvarepris${manglerTxt ? ' — mangler: ' + _opsEsc(manglerTxt) : ''}">ukendt</span>`
                : `${_opsFmtKr(r.cost_price_excl_moms)}${r.cost_is_minimum ? '<span class="ops-min-mark" title="mindst — mangler pris på: ' + _opsEsc(manglerTxt) + '">+</span>' : ''}`}</td>
            <td class="num">${_opsFmtKr(r.sales_price_excl_moms)}</td>
            <td class="num">${r.cost_unknown
                ? '<span class="ops-unknown">—</span>'
                : `${maksMark}${_opsFmtKr(r.db_kr_excl_moms)}`}</td>
            <td class="num">
                <span class="ops-db-pct ${dbPctCls}">${r.cost_unknown
                    ? '<span class="ops-unknown">—</span>'
                    : `${maksMark}${_opsFmtPct(r.db_pct)}`}</span>
                ${(r.db_pct != null && !r.cost_unknown) ? `<span class="ops-db-bar ${dbPctCls}"><span style="width:${dbBarWidth}%"></span></span>` : ''}
                ${(r.db_target_pct != null && !r.cost_unknown) ? `<span style="color:#6a6359;font-size:10px;margin-left:6px">mål ${r.db_target_pct}%</span>` : ''}
            </td>
            <td class="num">
                <span class="ops-sold-cell">
                    ${_opsSparkline(r.period_buckets, r.sold_units)}
                    <span class="ops-sold-num">${r.sold_units || '—'}</span>
                </span>
            </td>
            <td class="num">${_opsFmtKr(r.revenue_excl_moms)}</td>
            <td class="num ops-col-co2">${(r.co2e_per_unit || 0).toFixed(2).replace('.', ',')}</td>
            <td class="num ops-col-co2">${(r.co2_total_period || 0).toFixed(1).replace('.', ',')}</td>
        </tr>
    `;
}

function _opsSparkline(buckets, soldUnits) {
    if (!buckets || soldUnits === 0) return '<span class="ops-sparkline empty"></span>';
    const max = Math.max(...buckets, 1);
    const bars = buckets.map((v, i) => {
        const h = Math.max(2, (v / max) * 100);
        const last = i === buckets.length - 1 ? ' last' : '';
        return `<span class="ops-sb${last}" style="height:${h}%"></span>`;
    }).join('');
    return `<span class="ops-sparkline" title="Solgt pr. periode-bucket">${bars}</span>`;
}

// ─── Event-binding ───────────────────────────────────────────

function _opsBindEvents() {
    const c = _opsState.container;
    if (!c) return;

    // Topbar: refresh + targets
    c.querySelector('[data-act="refresh"]')?.addEventListener('click', _opsHandleRefresh);
    c.querySelector('[data-act="targets"]')?.addEventListener('click', _opsToggleTargetPop);

    // Filtre
    c.querySelector('[data-seg="price-cat"]')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-val]');
        if (!btn) return;
        _opsState.priceCategory = btn.dataset.val;
        _opsLoad();
    });
    c.querySelector('#ops-period')?.addEventListener('change', (e) => {
        _opsState.periodDays = parseInt(e.target.value, 10);
        _opsLoad();
    });
    c.querySelector('#ops-cat')?.addEventListener('change', (e) => {
        _opsState.categoryFilter = e.target.value;
        _opsLoad();
    });
    let searchTimer = null;
    c.querySelector('#ops-search')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const v = e.target.value;
        searchTimer = setTimeout(() => {
            _opsState.searchText = v;
            _opsRenderRows();
        }, 200);
    });
    c.querySelector('[data-act="clear-filters"]')?.addEventListener('click', () => {
        _opsState.activeFilters = new Set(['active']);
        _opsState.categoryFilter = '';
        _opsState.searchText = '';
        _opsLoad();
    });

    // KPI-filtre
    c.querySelectorAll('.ops-kpi.clickable').forEach(kpi => {
        kpi.addEventListener('click', () => {
            const f = kpi.dataset.filter;
            if (_opsState.activeFilters.has(f)) _opsState.activeFilters.delete(f);
            else _opsState.activeFilters.add(f);
            _opsRender();  // re-render hele strip for at opdatere active-state + visible KPIs
        });
    });

    // Sortering
    c.querySelectorAll('.ops-table thead th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (_opsState.sortKey === key) {
                _opsState.sortDir = _opsState.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _opsState.sortKey = key;
                _opsState.sortDir = key === 'name' ? 'asc' : 'desc';
            }
            _opsRender();
        });
    });

    // Tabel-rækker → drill-down
    c.querySelector('#ops-tbody')?.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-recipe-id]');
        if (!tr) return;
        const id = parseInt(tr.dataset.recipeId, 10);
        _opsOpenPanel(id);
    });

    // Panel close
    c.querySelector('[data-act="close-panel"]')?.addEventListener('click', _opsClosePanel);
    c.querySelector('#ops-backdrop')?.addEventListener('click', _opsClosePanel);

    // ESC for at lukke panel + popover
    document.addEventListener('keydown', _opsHandleEsc);
}

function _opsHandleEsc(e) {
    if (e.key !== 'Escape') return;
    if (_opsState.selected) _opsClosePanel();
    document.getElementById('ops-target-pop')?.classList.remove('open');
}

function _opsClearFiltersVisible() {
    return _opsState.categoryFilter ||
        _opsState.searchText ||
        _opsState.activeFilters.size > 1 ||
        !_opsState.activeFilters.has('active');
}

// ─── Refresh-knap ────────────────────────────────────────────

async function _opsHandleRefresh(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Opdaterer...';
    try {
        const r = await refreshRecipeCosts();
        _opsToast(`Opdateret ${r.refreshed} opskrifter på ${r.duration_ms} ms`);
        _opsLoad();
    } catch (err) {
        _opsToast('Fejl: ' + err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = '↻ Opdater fra Grocy';
    }
}

// ─── Targets popover ─────────────────────────────────────────

function _opsToggleTargetPop() {
    const pop = document.getElementById('ops-target-pop');
    if (!pop) return;
    if (pop.classList.contains('open')) {
        pop.classList.remove('open');
        return;
    }
    _opsRenderTargetPop(pop);
    pop.classList.add('open');
}

function _opsRenderTargetPop(pop) {
    const td = _opsState.targetsData || { categories: [], targets: [] };
    const targetMap = {};
    for (const t of td.targets) targetMap[t.category] = t.target_pct;

    const allCats = Array.from(new Set([
        ...td.categories,
        ...td.targets.map(t => t.category),
    ])).sort();

    const vindue = td.price_window_days || 90;
    const vMin = td.price_window_min || 7;
    const vMax = td.price_window_max || 1095;

    pop.innerHTML = `
        <h4>Kostpris</h4>
        <div class="ops-window-row">
            <label for="ops-window-days">Vægt indkøb de seneste</label>
            <span>
                <input type="number" id="ops-window-days" min="${vMin}" max="${vMax}" step="1"
                       value="${vindue}"> dage
            </span>
        </div>
        <div class="ops-window-hint" title="Kostprisen er et mængdevægtet snit af indkøbene i vinduet. Et kort vindue holder gamle, forkerte priser ude; et langt fanger flere varer. Varer uden indkøb i vinduet bruger seneste køb.">
            Mængdevægtet snit af indkøbene i vinduet. Uden indkøb: seneste køb.
        </div>
        <button class="ops-btn-primary ops-pop-wide" data-act="save-window">Gem og genberegn</button>

        <h4>Mål for DB% pr. kategori</h4>
        ${allCats.length === 0 ? '<div style="color:#6a6359;font-size:11px">Ingen kategorier fundet i Grocy</div>' : ''}
        <div class="ops-pop-scroll">
        ${allCats.map(cat => `
            <div class="ops-target-row">
                <span>${_opsEsc(cat)}</span>
                <span>
                    <input type="number" min="0" max="100" step="1"
                           data-cat="${_opsEsc(cat)}"
                           value="${targetMap[cat] != null ? targetMap[cat] : ''}"
                           placeholder="—"> %
                </span>
            </div>
        `).join('')}
        </div>
        <div class="ops-pop-actions">
            <button class="ops-btn-primary" style="flex:1" data-act="save-targets">Gem</button>
            <button class="ops-btn-secondary" data-act="close-targets">Luk</button>
        </div>
    `;

    pop.querySelector('[data-act="close-targets"]')?.addEventListener('click', () => pop.classList.remove('open'));

    pop.querySelector('[data-act="save-window"]')?.addEventListener('click', async (ev) => {
        const input = pop.querySelector('#ops-window-days');
        const v = parseInt(input?.value, 10);
        if (!Number.isFinite(v)) { _opsToast('Skriv et antal dage', true); return; }
        const btn = ev.currentTarget;
        btn.disabled = true;
        const foer = btn.textContent;
        // Genberegningen taler med Grocy og tager et par sekunder. Uden den
        // besked ligner knappen noget der ikke skete.
        btn.textContent = 'Genberegner…';
        try {
            const out = await putRecipePriceWindow(v);
            if (out.refresh_error) {
                // Indstillingen ER gemt — kun genberegningen fejlede. Sig
                // præcis dét, så man ikke tror ændringen gik tabt.
                _opsToast(`Vinduet gemt (${out.days} dage), men kostpriserne kunne ikke `
                        + `genberegnes: ${out.refresh_error}`, true);
            } else {
                _opsToast(`Kostprisen regnes nu over ${out.days} dage`
                        + (out.refreshed != null ? ` · ${out.refreshed} opskrifter genberegnet` : ''));
            }
            pop.classList.remove('open');
            _opsLoad();
        } catch (err) {
            _opsToast('Fejl: ' + err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = foer;
        }
    });
    pop.querySelector('[data-act="save-targets"]')?.addEventListener('click', async () => {
        const inputs = pop.querySelectorAll('input[data-cat]');
        const targets = [];
        for (const input of inputs) {
            const v = input.value.trim();
            if (v === '') continue;
            const num = parseFloat(v);
            if (!Number.isFinite(num)) continue;
            targets.push({ category: input.dataset.cat, target_pct: num });
        }
        try {
            await putRecipeTargets(targets);
            _opsToast('Mål gemt');
            pop.classList.remove('open');
            _opsLoad();
        } catch (err) {
            _opsToast('Fejl: ' + err.message, true);
        }
    });
}

// ─── Drill-down panel ────────────────────────────────────────

function _opsOpenPanel(recipeId) {
    if (!_opsState.data) return;
    const r = _opsState.data.recipes.find(x => x.grocy_recipe_id === recipeId);
    if (!r) return;
    _opsState.selected = r;

    document.getElementById('ops-panel-title').textContent = r.name;
    document.getElementById('ops-panel-body').innerHTML = _opsPanelBodyHtml(r);
    document.getElementById('ops-backdrop').classList.add('open');
    document.getElementById('ops-panel').classList.add('open');

    _opsBindPanelEvents(r);

    // Start råvare-drill-down på den valgte opskrift
    _opsState.compStack = [r.grocy_recipe_id];
    _opsRenderComposition();
}

function _opsClosePanel() {
    _opsState.selected = null;
    document.getElementById('ops-backdrop')?.classList.remove('open');
    document.getElementById('ops-panel')?.classList.remove('open');
}

function _opsPanelBodyHtml(r) {
    // Warning-banner
    let banner = '';
    if (r.loss_making) {
        banner = `<div class="ops-info-banner loss">⚠ TABSGIVENDE — kostpris (${_opsFmtKr(r.cost_price_excl_moms)}) over salgspris (${_opsFmtKr(r.sales_price_excl_moms)})</div>`;
    } else if (r.under_target) {
        const editHtml = r.category
            ? `<div class="ops-target-edit">Mål for <strong>${_opsEsc(r.category)}</strong>:
                 <input type="number" id="ops-inline-target" min="0" max="100" step="1" value="${r.db_target_pct ?? ''}">%
                 <button class="ops-btn-primary" data-act="save-inline-target" data-cat="${_opsEsc(r.category)}">Gem</button>
               </div>`
            : '';
        banner = `<div class="ops-info-banner warn">Under DB-mål (${_opsFmtPct(r.db_pct)} < ${r.db_target_pct}%) ${editHtml}</div>`;
    } else if (r.sales_price_excl_moms == null) {
        banner = `<div class="ops-info-banner miss">Mangler salgspris i ${_opsState.priceCategory}</div>`;
    } else {
        banner = `<div class="ops-info-banner ok">DB-mål nået (${_opsFmtPct(r.db_pct)} ≥ ${r.db_target_pct ?? '—'}%)</div>`;
    }

    // Pris-grid for valgt priskategori (inline edit)
    const priceSection = `
        <div class="ops-panel-section">
            <h4>Salgspris (ex moms) — ${_opsState.priceCategory}</h4>
            <div class="ops-price-grid">
                <span class="label">${_opsEsc(_opsState.priceCategory)}</span>
                <input type="number" min="0" step="0.01"
                       id="ops-price-input"
                       value="${r.sales_price_excl_moms != null ? r.sales_price_excl_moms : ''}"
                       placeholder="—">
                <button class="ops-btn-primary" data-act="save-price">Gem</button>
                <span class="label" style="grid-column:1/-1;font-size:11px">
                    Inkl. moms: <strong>${_opsFmtKr(r.sales_price_excl_moms != null ? Moms.exclToIncl(r.sales_price_excl_moms) : null)}</strong>
                    &nbsp;·&nbsp; DB kr ex moms: <strong>${_opsFmtKr(r.db_kr_excl_moms)}</strong>
                    &nbsp;·&nbsp; DB%: <strong>${_opsFmtPct(r.db_pct)}</strong>
                </span>
                <span class="label" style="grid-column:1/-1;font-size:11px;color:#8a8378">
                    Gemmes også i Grocy (som pris inkl. moms)
                </span>
            </div>
        </div>
    `;

    // Råvarer + underopskrifter (drill-down) — fyldes async efter panel-åbning.
    const compSection = `
        <div class="ops-panel-section">
            <div class="ops-comp-head">
                <h4>Råvarer & underopskrifter</h4>
                <div class="ops-comp-nav" id="ops-comp-nav"></div>
            </div>
            <div class="ops-comp-body" id="ops-comp-body">
                <div class="ops-comp-loading">Indlæser råvarer…</div>
            </div>
        </div>
    `;

    // Volumen-graf (period_buckets)
    const buckets = r.period_buckets || [];
    const maxBucket = Math.max(...buckets, 1);
    const volChart = `
        <div class="ops-panel-section">
            <h4>Volumen i valgt periode (${_opsState.periodDays} dage)</h4>
            <div class="ops-vol-chart">
                ${buckets.map((v, i) => `
                    <div class="ops-vol-bar" style="height:${Math.max(2, (v / maxBucket) * 100)}%">
                        <span class="ops-tooltip">Bucket ${i + 1}: ${v} stk</span>
                    </div>
                `).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#6a6359;margin-top:4px">
                <span>Ældste</span>
                <span>Nu</span>
            </div>
        </div>
    `;

    // Metadata
    const metadata = `
        <div class="ops-panel-section">
            <h4>Metadata</h4>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px">
                <span style="color:#6a6359">Kategori</span><span>${_opsEsc(r.category || '—')}</span>
                <span style="color:#6a6359">CO₂e pr. enhed</span><span>${(r.co2e_per_unit || 0).toFixed(2)} kg</span>
                <span style="color:#6a6359">CO₂ total i periode</span><span>${(r.co2_total_period || 0).toFixed(2)} kg</span>
                <span style="color:#6a6359">Økologisk</span><span>${r.is_organic ? 'Ja' : 'Nej'}</span>
                <span style="color:#6a6359">Status</span><span>${r.is_active ? 'Aktiv' : 'Inaktiv'}</span>
                <span style="color:#6a6359">Grocy ID</span>
                <span><a href="/api/recipes/grocy-recipe-link/${r.grocy_recipe_id}" target="_blank" class="ops-btn-link">${r.grocy_recipe_id} → Åbn i Grocy</a></span>
            </div>
        </div>
    `;

    return banner + priceSection + compSection + volChart + metadata;
}

function _opsBindPanelEvents(r) {
    const body = document.getElementById('ops-panel-body');
    if (!body) return;

    body.querySelector('[data-act="save-price"]')?.addEventListener('click', async () => {
        const input = document.getElementById('ops-price-input');
        const val = parseFloat(input.value);
        if (!Number.isFinite(val) || val < 0) {
            _opsToast('Pris skal være ≥ 0', true);
            return;
        }
        try {
            await putItemPrice({
                item_type: 'recipe',
                item_id: r.grocy_recipe_id,
                price_category_code: _opsState.priceCategory,
                price_excl_moms: val,
            });
            _opsToast('Pris gemt (også i Grocy)');
            _opsClosePanel();
            _opsLoad();
        } catch (err) {
            _opsToast('Fejl: ' + err.message, true);
        }
    });

    body.querySelector('[data-act="save-inline-target"]')?.addEventListener('click', async (e) => {
        const cat = e.currentTarget.dataset.cat;
        const input = document.getElementById('ops-inline-target');
        const val = parseFloat(input.value);
        if (!Number.isFinite(val) || val < 0 || val > 100) {
            _opsToast('Mål skal være 0-100%', true);
            return;
        }
        try {
            await patchRecipeTarget(cat, val);
            _opsToast(`Mål for ${cat} sat til ${val}%`);
            _opsClosePanel();
            _opsLoad();
        } catch (err) {
            _opsToast('Fejl: ' + err.message, true);
        }
    });
}

// ─── Råvare-drill-down (composition) ─────────────────────────
//
// Prisen/volumen/metadata øverst hører til den PRIMÆRT valgte opskrift.
// Kun råvare-sektionen navigerer: klik på en underopskrift eller et produkt
// med egen opskrift (Langtids Stegt Gris) åbner DENS råvarer i samme boks,
// med en "‹ tilbage"-knap. Ét niveau hentes ad gangen fra serveren.

async function _opsRenderComposition() {
    const body = document.getElementById('ops-comp-body');
    const nav = document.getElementById('ops-comp-nav');
    if (!body) return;
    const currentId = _opsState.compStack[_opsState.compStack.length - 1];
    if (!currentId) return;

    // Tilbage-knap (viser forrige opskrifts navn hvis vi er drillet ned)
    if (nav) {
        if (_opsState.compStack.length > 1) {
            const prevId = _opsState.compStack[_opsState.compStack.length - 2];
            const prevName = (_opsState.compCache[prevId] && _opsState.compCache[prevId].name) || 'tilbage';
            nav.innerHTML = `<button class="ops-comp-back" data-act="comp-back">‹ ${_opsEsc(prevName)}</button>`;
        } else {
            nav.innerHTML = '';
        }
    }

    let data = _opsState.compCache[currentId];
    if (!data) {
        body.innerHTML = '<div class="ops-comp-loading">Indlæser råvarer…</div>';
        try {
            data = await fetchRecipeComposition(currentId);
            _opsState.compCache[currentId] = data;
        } catch (err) {
            body.innerHTML = `<div class="ops-comp-empty">Kunne ikke hente råvarer: ${_opsEsc(err.message)}</div>`;
            return;
        }
    }
    // Panelet kan være lukket eller navigeret videre mens vi hentede
    if (_opsState.compStack[_opsState.compStack.length - 1] !== currentId) return;

    body.innerHTML = _opsCompBodyHtml(data);
    _opsBindCompEvents();
}

function _opsCompBodyHtml(data) {
    const drilled = _opsState.compStack.length > 1;
    const ings = data.ingredients || [];
    const subs = data.sub_recipes || [];

    const isEmb = (g) => (g || '').toLowerCase() === 'emballage';
    const mainIngs = ings.filter(i => !isEmb(i.ingredient_group));
    const embIngs  = ings.filter(i => isEmb(i.ingredient_group));

    const ingRow = (i) => {
        const nameHtml = i.producing_recipe_id
            ? `<span class="ops-comp-link" data-comp-recipe="${i.producing_recipe_id}">${_opsEsc(i.name)} <span class="ops-comp-arrow">[→]</span></span>`
            : _opsEsc(i.name);
        return `<tr>
            <td class="ops-comp-name">${_opsStockDot(i.in_stock)}${nameHtml}</td>
            <td class="num">${_opsEsc(_opsCompAmount(i))}</td>
            <td class="num">${_opsCompCost(i.cost)}${i.cost_inherited
                ? '<span class="ops-inherited" title="Forældre-vare uden egen pris — gennemsnit af underprodukterne">~</span>'
                : ''}</td>
        </tr>`;
    };
    const subRow = (s) => `<tr class="ops-comp-sub" data-comp-recipe="${s.recipe_id}">
        <td class="ops-comp-name">
            <span class="ops-comp-link">↳ ${_opsEsc(s.name)} <span class="ops-comp-arrow">[→]</span></span>
            <span class="ops-comp-tag">underopskrift</span>
        </td>
        <td class="num">${_opsEsc(_opsCompServings(s))}</td>
        <td class="num">${_opsCompCost(s.cost)}</td>
    </tr>`;

    const rows = [
        ...mainIngs.map(ingRow),
        ...subs.map(subRow),
        ...embIngs.map(ingRow),
    ].join('');

    const drilledTitle = drilled
        ? `<div class="ops-comp-current">${_opsEsc(data.name)}${data.category ? ` <span class="ops-comp-cat">· ${_opsEsc(data.category)}</span>` : ''}</div>`
        : '';

    const anyMissingCost = ings.some(i => i.cost == null);
    // Samme regel som tabelrækken: er der intet kendt tal, står der "ukendt".
    // Et panel der siger "0,00 kr" om en øl, mens rækken bag det siger
    // "ukendt", modsiger sig selv — og så ved man ikke hvad der gælder.
    const manglendeRaavarer = data.total_cost_missing || [];
    const totalUkendt = data.total_cost_source === 'ukendt'
        || (manglendeRaavarer.length > 0 && !(data.total_cost > 0));
    const manglendeTxt = manglendeRaavarer.join(', ');
    const totalRow = (data.total_cost != null || totalUkendt)
        ? `<tfoot><tr class="ops-comp-total">
             <td>Kostpris i alt</td><td></td><td class="num">${totalUkendt
                ? `<span class="ops-unknown" title="Ingen kendt råvarepris${manglendeTxt ? ' — mangler: ' + _opsEsc(manglendeTxt) : ''}">ukendt</span>`
                : `${manglendeRaavarer.length ? 'mindst ' : ''}${_opsCompCost(data.total_cost)}`}</td>
           </tr></tfoot>`
        : '';
    const costNote = totalUkendt
        ? `<div class="ops-comp-note">Ingen pris registreret på ${manglendeTxt ? _opsEsc(manglendeTxt) : 'råvaren'} i Grocy — kostprisen kan ikke regnes, og der er derfor intet dækningsbidrag at vise.</div>`
        : manglendeRaavarer.length
        ? `<div class="ops-comp-note">Mangler pris på ${_opsEsc(manglendeTxt)} — totalen er derfor et minimum.</div>`
        : anyMissingCost
        ? '<div class="ops-comp-note">— = ingen pris registreret på råvaren i Grocy. ~ = pris arvet som gennemsnit af en forældre-vares underprodukter.</div>'
        : ings.some(i => i.cost_inherited)
        ? '<div class="ops-comp-note">~ = pris arvet som gennemsnit af en forældre-vares underprodukter.</div>'
        : '';

    // Advarslerne hører til HER og ikke kun på rækken: panelet er stedet man
    // kigger når man vil vide hvorfor kostprisen ser ud som den gør.
    const advarsler = data.total_cost_warnings || [];
    const warnNote = advarsler.length
        ? `<div class="ops-comp-note ops-comp-warn">${advarsler
            .map(w => _opsEsc(_opsWarnTekst(w))).join('<br>')}</div>`
        : '';

    const table = rows
        ? `<table class="ops-comp-table">
             <thead><tr><th>Råvare</th><th class="num">Mængde</th><th class="num">Kostpris</th></tr></thead>
             <tbody>${rows}</tbody>
             ${totalRow}
           </table>${costNote}${warnNote}`
        : '<div class="ops-comp-empty">Ingen råvarer registreret på denne opskrift.</div>';

    // Kun køkken-opskrift her — Grocy-linket ligger allerede i metadata-sektionen.
    const links = `<div class="ops-comp-links">
        <a href="/kitchen/recipes.html?recipe=${data.recipe_id}" target="_blank" class="ops-btn-link">🔍 Åbn i køkken-opskrift</a>
    </div>`;

    return drilledTitle + table + links;
}

function _opsCompAmount(i) {
    if (i.amount == null) return '—';
    const n = Number(i.amount).toLocaleString('da-DK', { maximumFractionDigits: 2 });
    return `${n} ${i.unit || ''}`.trim();
}

function _opsCompServings(s) {
    const n = Number(s.servings || 0).toLocaleString('da-DK', { maximumFractionDigits: 2 });
    return `${n} ${s.unit || ''}`.trim();
}

function _opsCompCost(c) {
    if (c == null) return '<span class="ops-comp-nocost" title="Mangler pris i Grocy">—</span>';
    return Number(c).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

// Lille rød/grøn lager-lampe (uafhængig af pris — en udsolgt vare har stadig en pris).
function _opsStockDot(inStock) {
    if (inStock == null) return '';
    return inStock
        ? '<span class="ops-stock-dot ok" title="På lager"></span>'
        : '<span class="ops-stock-dot out" title="Ikke på lager"></span>';
}

function _opsBindCompEvents() {
    const body = document.getElementById('ops-comp-body');
    const nav = document.getElementById('ops-comp-nav');

    nav?.querySelector('[data-act="comp-back"]')?.addEventListener('click', () => {
        if (_opsState.compStack.length > 1) {
            _opsState.compStack.pop();
            _opsRenderComposition();
        }
    });

    body?.querySelectorAll('[data-comp-recipe]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const rid = parseInt(el.getAttribute('data-comp-recipe'), 10);
            if (!rid || _opsState.compStack[_opsState.compStack.length - 1] === rid) return;
            _opsState.compStack.push(rid);
            _opsRenderComposition();
        });
    });
}

// ─── Helpers ─────────────────────────────────────────────────

function _opsFmtKr(n) {
    if (n == null) return '—';
    return n.toLocaleString('da-DK', { maximumFractionDigits: 0 }) + ' kr';
}

function _opsFmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return n.toFixed(1).replace('.', ',') + '%';
}

function _opsStaleLabel(refreshedAt, level) {
    if (!refreshedAt) return '<span class="ops-stale-crit">aldrig opdateret</span>';
    const ms = Date.now() - new Date(refreshedAt).getTime();
    const hours = ms / (1000 * 60 * 60);
    if (hours < 1) return 'opdateret for under en time siden';
    if (hours < 24) return `opdateret for ${Math.round(hours)} timer siden`;
    const days = Math.round(hours / 24);
    if (level === 'critical') return `<span class="ops-stale-crit">opdateret for ${days} dage siden</span>`;
    if (level === 'warn')     return `<span class="ops-stale-warn">opdateret for ${days} dage siden</span>`;
    return `opdateret for ${days} dage siden`;
}

// Serveren formulerer advarslen (`describeWarning`), så tabellen, panelet og
// `audit:kostpris-kilder` siger det samme. Faldet tilbage er kun for en klient
// der møder en ældre server — "undefined" i en tooltip er værre end intet.
function _opsWarnTekst(w) {
    return w?.text || (w?.product ? `${w.product}: prisen bør ses efter.` : 'Prisen bør ses efter.');
}

function _opsEsc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _opsToastTimer = null;
function _opsToast(msg, isError = false) {
    document.querySelectorAll('.ops-toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'ops-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(_opsToastTimer);
    _opsToastTimer = setTimeout(() => el.remove(), 3500);
}
