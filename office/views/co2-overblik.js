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

/* globals fetchCo2Overview, fetchCo2Timeseries, setCo2ManualFactor,
           fetchCo2Synonyms, addCo2Synonym, deleteCo2Synonym */

const _covState = {
    container: null,
    overview: null,
    series: null,
    synonyms: null,
    search: '',
    filter: '',        // '' | 'complete' | 'partial'
    category: '',      // grupper-filter (fx "01 Sandwich")
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
        const [ov, ts, syn] = await Promise.all([
            fetchCo2Overview(), fetchCo2Timeseries(12),
            fetchCo2Synonyms().catch(() => ({ synonyms: [] })),
        ]);
        _covState.overview = ov;
        _covState.series = ts.months || [];
        _covState.synonyms = syn.synonyms || [];
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
        ${_covSynonyms()}
        ${_covTimeChart(series)}
        ${_covRecipeTable(ov.recipes)}
      </div>`;

    _covBind();
}

/* Synonymer — dublet-vare-regler, synlige + redigerbare (ingen skjult fælde) */
const _COV_SYN_STATUS = {
    applied:            { label: 'Aktiv',            cls: 'cov-badge-green' },
    not_applied:        { label: 'Ikke anvendt endnu', cls: 'cov-badge-amber' },
    mismatch:           { label: '⚠ Forskellige tal', cls: 'cov-badge-red' },
    canonical_no_factor:{ label: 'Kanonisk mangler faktor', cls: 'cov-badge-amber' },
    canonical_missing:  { label: '⚠ Kanonisk vare ukendt', cls: 'cov-badge-red' },
    synonym_missing:    { label: '⚠ Synonym-vare ukendt', cls: 'cov-badge-red' },
};

function _covSynonyms() {
    const rows = _covState.synonyms || [];
    const body = rows.length ? rows.map(r => {
        const st = _COV_SYN_STATUS[r.status] || { label: r.status, cls: 'cov-badge-grey' };
        return `<tr data-syn-id="${r.id}">
            <td><b>${_covEsc(r.synonym_name)}</b> <span class="cov-dim">arver fra</span> ${_covEsc(r.canonical_name)}</td>
            <td class="cov-num">${r.synonym_factor != null ? _covNum(r.synonym_factor) + ' <span class="cov-dim">kg</span>' : '<span class="cov-dim">—</span>'}</td>
            <td><span class="cov-badge ${st.cls}">${st.label}</span>${r.note ? `<div class="cov-dim" style="font-size:12px">${_covEsc(r.note)}</div>` : ''}</td>
            <td><button class="cov-syn-del" data-id="${r.id}" title="Fjern regel">✕</button></td>
        </tr>`;
    }).join('') : `<tr><td colspan="4" class="cov-empty">Ingen synonymer endnu.</td></tr>`;
    return `
      <section class="cov-card">
        <h2>Synonymer <span class="cov-dim">· dublet-varer der deler faktor</span></h2>
        <p class="cov-sub">Her ser du alle antagelser om at to varer er den samme (fx "Små Burgerlommer" = "BurgerLommer - alm"). Tjek at de er rigtige — fjern en der er forkert.</p>
        <table class="cov-table cov-syn-table">
          <thead><tr><th>Regel</th><th class="cov-num">Faktor</th><th>Status</th><th></th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        <div class="cov-syn-add">
          <input type="text" id="covSynSyn" placeholder="Dublet-vare (arver)…">
          <span class="cov-dim">arver faktor fra</span>
          <input type="text" id="covSynCanon" placeholder="Kanonisk vare (har faktoren)…">
          <button class="cov-btn-primary" id="covSynAdd">+ Tilføj synonym</button>
        </div>
      </section>`;
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
    const chip = (x, type) => {
        let act = '';
        if (type === 'kgvej') act = 'goto-vej';
        else if (x.kind === 'emballage') act = 'goto-emballage';
        else if (x.kind === 'raavare' && x.product_id) act = 'manual';
        const tip = act === 'goto-vej' ? 'Klik → Vej tælle-varer'
            : act === 'goto-emballage' ? 'Klik → Emballage-tildeler'
            : act === 'manual' ? 'Klik → sæt faktor manuelt' : '';
        return `<span class="cov-miss-chip ${act ? 'cov-miss-chip-click' : ''}" ${act ? `data-act="${act}"` : ''}
            data-pid="${x.product_id || ''}" data-name="${_covEsc(x.name)}" title="${_covEsc(tip)}">${_covEsc(x.name)} <b>${x.count}</b></span>`;
    };
    const chips = (arr, type) => arr.length
        ? arr.map(x => chip(x, type)).join('')
        : '<span class="cov-dim">Intet mangler 🎉</span>';
    return `
      <section class="cov-card">
        <h2>Datakvalitet</h2>
        <p class="cov-sub">Indgangen til rigtige rapporter — klik en manglende vare for at rette den.</p>
        <div class="cov-bar">
          <div class="cov-bar-fill" style="width:${s.coverage_pct}%"></div>
          <span class="cov-bar-txt">${s.complete} komplette · ${s.partial} mangler data</span>
        </div>
        <div class="cov-miss-grid">
          <div>
            <h3>Mangler kg-vej <span class="cov-dim">(→ vej i køkkenet)</span></h3>
            <div class="cov-miss-chips">${chips(mk, 'kgvej')}</div>
          </div>
          <div>
            <h3>Mangler faktor <span class="cov-dim">(emballage → tildel · råvare → sæt manuelt)</span></h3>
            <div class="cov-miss-chips">${chips(mf, 'factor')}</div>
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
            <select id="covCategory">
              <option value="">Alle kategorier</option>
              ${(_covState.overview.categories || []).map(c => `<option value="${_covEsc(c)}" ${c === _covState.category ? 'selected' : ''}>${_covEsc(c)}</option>`).join('')}
            </select>
            <select id="covFilter">
              <option value="">Alle</option>
              <option value="complete">Komplette</option>
              <option value="partial">Mangler data</option>
            </select>
          </div>
        </div>
        <p class="cov-sub">Bemærk: enheden varierer — en sandwich er pr. <b>stk</b>, en produktions-batch pr. <b>kg</b>. Tal på tværs af enheder er ikke direkte sammenlignelige. Filtrér fx til "01 Sandwich".</p>
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
        if (_covState.category && r.category !== _covState.category) return false;
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
        const unit = r.unit ? ' <span class="cov-dim">kg / ' + _covEsc(r.unit) + '</span>' : ' <span class="cov-dim">kg</span>';
        return `<tr>
            <td class="cov-recipe-name">${_covEsc(r.name)}${r.category ? `<div class="cov-recipe-cat">${_covEsc(r.category)}</div>` : ''}</td>
            <td class="cov-num">${r.co2e_per_serving != null ? _covNum(r.co2e_per_serving) + unit : '<span class="cov-dim">—</span>'}</td>
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
    const cat = el.querySelector('#covCategory');
    if (cat) cat.addEventListener('change', (e) => { _covState.category = e.target.value; _covReRenderTable(); });

    // Datakvalitet-chips: klik → ret varen.
    el.querySelectorAll('.cov-miss-chip-click').forEach(chip => {
        chip.addEventListener('click', () => {
            const act = chip.dataset.act;
            if (act === 'goto-vej' && window.switchSection) window.switchSection('co2', 'vej');
            else if (act === 'goto-emballage' && window.switchSection) window.switchSection('co2', 'emballage');
            else if (act === 'manual') _covManualFactor(chip);
        });
    });

    // Synonymer: tilføj + fjern
    const synAdd = el.querySelector('#covSynAdd');
    if (synAdd) synAdd.addEventListener('click', async () => {
        const syn = el.querySelector('#covSynSyn').value.trim();
        const canon = el.querySelector('#covSynCanon').value.trim();
        if (!syn || !canon) { _covToast('Udfyld begge varer', true); return; }
        synAdd.disabled = true;
        try {
            const r = await addCo2Synonym(canon, syn);
            _covToast(r.warning ? 'Tilføjet — ' + r.warning : (r.propagated ? 'Tilføjet + faktor skrevet' : 'Tilføjet'), !!r.warning);
            await _covLoad();
        } catch (e) { _covToast('Fejl: ' + e.message, true); synAdd.disabled = false; }
    });
    el.querySelectorAll('.cov-syn-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Fjern denne synonym-regel? (faktoren på varen bevares)')) return;
            try { await deleteCo2Synonym(btn.dataset.id); _covToast('Regel fjernet'); await _covLoad(); }
            catch (e) { _covToast('Fejl: ' + e.message, true); }
        });
    });

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

// Råvare-chip → inline manuel faktor-input (source=manual).
function _covManualFactor(chip) {
    if (chip._editing) return;
    chip._editing = true;
    const pid = Number(chip.dataset.pid);
    const name = chip.dataset.name;
    const orig = chip.innerHTML;
    chip.classList.add('cov-miss-chip-edit');
    chip.innerHTML = `${_covEsc(name)} <input type="number" step="any" min="0" class="cov-mf-in" placeholder="kg CO₂e/kg"> <button class="cov-mf-save">✓</button>`;
    const inp = chip.querySelector('.cov-mf-in');
    inp.focus();
    inp.addEventListener('click', (e) => e.stopPropagation());
    const cancel = () => { chip.innerHTML = orig; chip.classList.remove('cov-miss-chip-edit'); chip._editing = false; };
    const save = async (e) => {
        if (e) e.stopPropagation();
        const v = inp.value.trim();
        if (!v) return cancel();
        try { await setCo2ManualFactor(pid, v); _covToast(`${name}: faktor sat (manuel)`); await _covLoad(); }
        catch (err) { _covToast('Fejl: ' + err.message, true); cancel(); }
    };
    chip.querySelector('.cov-mf-save').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter') save(e); });
}

function _covToast(msg, isErr) {
    let t = document.getElementById('covToast');
    if (!t) { t = document.createElement('div'); t.id = 'covToast'; t.className = 'cov-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle('cov-toast-err', !!isErr);
    t.classList.add('cov-toast-show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('cov-toast-show'), 3000);
}

window.initCo2Overblik = initCo2Overblik;
window.cleanupCo2Overblik = cleanupCo2Overblik;
