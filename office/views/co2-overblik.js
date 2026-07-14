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
           fetchCo2Synonyms, addCo2Synonym, deleteCo2Synonym, fetchCo2RecipeBreakdown */

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
    chartMode: 'category', // 'category' (stacked) | 'total'
    panelStack: [],    // drill-down: recipe_id-historik i nedbrydnings-panelet
    _panelKey: null,
    period: { months: 12 }, // periode for tal + grafer: { months } | { from, to }
    customOpen: false,      // brugerdefineret fra/til-panel åbent?
};

// Periode-label + query-objekt til de periode-baserede endpoints.
function _covPeriodLabel() {
    const p = _covState.period || {};
    if (p.from && p.to) return p.from + ' – ' + p.to;
    return (p.months || 12) + ' mdr';
}

// Periode-vælger: presets (3/6/12/24 mdr) + brugerdefineret fra/til-interval.
function _covPeriodControl() {
    const p = _covState.period || {};
    const isCustom = !!(p.from && p.to);
    const months = isCustom ? null : (p.months || 12);
    const btns = [3, 6, 12, 24].map(m =>
        `<button class="cov-per-btn ${(!isCustom && months === m) ? 'active' : ''}" data-months="${m}">${m} mdr</button>`
    ).join('');
    const customBtn = `<button class="cov-per-btn ${isCustom ? 'active' : ''}" id="covPerCustomToggle">${isCustom ? _covEsc(_covPeriodLabel()) : 'Tilpas…'}</button>`;
    const panel = _covState.customOpen ? `
        <div class="cov-per-panel">
          <input type="date" id="covPerFrom" value="${isCustom ? p.from : ''}">
          <span class="cov-dim">–</span>
          <input type="date" id="covPerTo" value="${isCustom ? p.to : ''}">
          <button class="cov-btn-primary" id="covPerApply">Anvend</button>
        </div>` : '';
    return `<div class="cov-period">
        ${btns}${customBtn}
        <span class="cov-per-busy" id="covPeriodBusy" style="visibility:hidden">↻</span>
        ${panel}
      </div>`;
}

// Kategori-palet (distinkt men jordnær) + grå til "Øvrige"-halen.
const _COV_PALETTE = ['#8e631f', '#4a9d5b', '#3b6ea3', '#c08a3a', '#7a5ba6', '#3f8f8a', '#b5563f'];
const _COV_OTHER_COLOR = '#c9beac';
const _COV_TRANSPORT_CAT = '🚚 Transport';  // separat stak-bane (§2.5), ikke en mad-kategori

function initCo2Overblik(container) {
    _covState.container = container;
    container.innerHTML = '<div class="cov-loading">Indlæser CO₂-overblik…</div>';
    _covLoad();
}
function cleanupCo2Overblik() {
    _covClosePanel();
    _covState.container = null;
    _covState.overview = null;
    _covState.series = null;
}

const _covEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _covNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: d, maximumFractionDigits: d }));

async function _covLoad() {
    try {
        const p = _covState.period;
        const [ov, ts, syn, tr] = await Promise.all([
            fetchCo2Overview(), fetchCo2Timeseries(p),
            fetchCo2Synonyms().catch(() => ({ synonyms: [] })),
            fetchCo2Transport(p).catch(() => null),
        ]);
        _covState.overview = ov;
        _covState.series = ts.months || [];
        _covState.synonyms = syn.synonyms || [];
        _covState.transport = tr;   // { window, methods, total, missing_km_count } | null
        _covRender();
    } catch (e) {
        if (!_covState.container) return;
        _covState.container.innerHTML =
            `<div class="cov-error">Kunne ikke indlæse: ${_covEsc(e.message)}<br>
             <small>Kræver forbindelse til den aktive Grocy-lokation.</small></div>`;
    }
}

// Skift periode → re-fetch KUN de periode-baserede dele (tidsserie + transport);
// dækning/opskrifter/datakvalitet er nutids-tilstand og røres ikke.
async function _covReloadPeriod() {
    const btn = document.getElementById('covPeriodBusy');
    if (btn) btn.style.visibility = 'visible';
    try {
        const p = _covState.period;
        const [ts, tr] = await Promise.all([
            fetchCo2Timeseries(p),
            fetchCo2Transport(p).catch(() => null),
        ]);
        _covState.series = ts.months || [];
        _covState.transport = tr;
        _covRender();
    } catch (e) {
        if (btn) btn.style.visibility = 'hidden';
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
          <div class="cov-head-right">
            ${_covPeriodControl()}
            <button class="cov-btn-ghost" id="covRefresh">↻ Opdatér</button>
          </div>
        </div>

        <div class="cov-kpis">
          ${_covKpi('Dækning', s.coverage_pct + '%', `${s.complete} af ${s.total} opskrifter`, s.coverage_pct >= 80 ? 'green' : (s.coverage_pct >= 40 ? 'amber' : 'red'))}
          ${_covKpi('CO₂ mad · ' + _covPeriodLabel(), _covNum(periodCo2e, 0), 'kg CO₂e · mad + emballage', '')}
          ${_covTransportKpi()}
          ${_covKpi('CO₂ pr. kuvert', perPax != null ? _covNum(perPax) : '—', 'kg CO₂e / kuvert · ekskl. transport', '')}
          ${_covKpi('Komplette opskrifter', String(s.complete), 'med fuldt CO₂-tal', 'green')}
        </div>

        ${_covDataQuality(ov)}
        ${_covSynonyms()}
        ${_covTimeChart(series)}
        ${_covTransport()}
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

/* Blok — transport-CO₂ (docs/CLAUDE_CO2_TRANSPORT.md §2). */

// Vognfarve — samme palette som leveringsmodulet (migration 074 + logistik-legende):
// DB-farven vinder; ellers type-fallback med de præcise seed-hex. Grå for pickup/Ukendt.
function _covMethodColor(m) {
    if (m && m.color) return m.color;
    const t = m && m.type;
    return t === 'volvo' ? '#8e631f'
        : t === 'taxi' ? '#4a8a3a'
        : t === 'bike' ? '#2d6da3'
        : t === 'own-bike' ? '#d98a2b'
        : '#9a948c';
}

// Format hjælpere til transport-tabellen.
const _covKg = (kg) => _covNum(kg, 1) + ' kg';
const _covAvg = (g) => g == null ? '—' : (g >= 1000 ? _covNum(g / 1000, 1) + ' kg' : Math.round(g) + ' g');
function _covCovBadge(pct) {
    if (pct == null) return '<span class="cov-cov cov-cov-na">—</span>';
    const cls = pct >= 80 ? 'cov-cov-hi' : (pct >= 50 ? 'cov-cov-mid' : 'cov-cov-lo');
    return `<span class="cov-cov ${cls}">${pct}%</span>`;
}

function _covTransportKpi() {
    const tr = _covState.transport;
    if (!tr || !tr.total) return '';
    const sub = `kg CO₂e · ${tr.total.coverage_pct}% af leveringer har km-data`;
    return _covKpi('Transport · ' + _covPeriodLabel(), _covNum(tr.total.co2_kg, 0), sub, 'green');
}

function _covTransport() {
    const tr = _covState.transport;
    if (!tr) {
        return `<section class="cov-card"><h2>Transport pr. leveringsmetode</h2>
            <p class="cov-dim">Transport-CO₂ kunne ikke hentes (kræver leveringsmodulet).</p></section>`;
    }
    const methods = tr.methods || [];
    if (!methods.length) {
        return `<section class="cov-card"><h2>Transport pr. leveringsmetode <span class="cov-dim">· ${_covEsc(_covPeriodLabel())}</span></h2>
            <p class="cov-sub">Estimeret ud fra kørte km × CO₂-faktor pr. metode. Faktorer sættes i <code>Settings → Leveringsmetoder</code>.</p>
            <p class="cov-dim">Ingen leveringer i perioden endnu.</p></section>`;
    }

    // Hierarki-forklaring (fra mockup)
    const hierarchy = `
      <div class="cov-tr-hier">
        <div class="cov-tr-step"><b>1 · Rute beregnet</b>Faktiske rute-km (inkl. retur) × faktor — fordelt pr. stop</div>
        <div class="cov-tr-step"><b>2 · Punkt-til-punkt</b>HQ→adresse × afstands-faktor × g/km (+ positionering)</div>
        <div class="cov-tr-step"><b>3 · Ingen km-data</b>Fast CO₂ pr. tur (fallback pr. metode)</div>
        <div class="cov-tr-step"><b>4 · Intet</b>0 — tælles som "mangler data"</div>
      </div>`;

    // Metode-tabel. Leverings-% = andel af ALLE leveringer (inkl. afhentning).
    const totalDeliv = methods.reduce((a, m) => a + (m.deliveries || 0), 0) || 1;
    const delivCell = (m) => `${m.deliveries} <span class="cov-dim">(${Math.round(m.deliveries / totalDeliv * 100)}%)</span>`;
    const rows = methods.map(m => {
        const dot = `<span class="cov-tr-dot" style="background:${_covEsc(_covMethodColor(m))}"></span>`;
        if (m.is_pickup) {
            return `<tr>
              <td>${dot}<span class="cov-tr-name">${_covEsc(m.label)}</span> <span class="cov-dim">· uden for scope</span></td>
              <td class="cov-num">${delivCell(m)}</td>
              <td class="cov-num cov-dim">—</td>
              <td class="cov-num cov-dim">0 kg</td>
              <td class="cov-num cov-dim">—</td>
              <td class="cov-num">${_covCovBadge(null)}</td>
            </tr>`;
        }
        return `<tr>
          <td>${dot}<span class="cov-tr-name">${_covEsc(m.label)}</span></td>
          <td class="cov-num">${delivCell(m)}</td>
          <td class="cov-num">${_covNum(m.km, 0)}</td>
          <td class="cov-num"><b>${_covKg(m.co2_kg)}</b></td>
          <td class="cov-num">${_covAvg(m.avg_g)}</td>
          <td class="cov-num">${_covCovBadge(m.coverage_pct)}</td>
        </tr>`;
    }).join('');

    const t = tr.total;
    const foot = `<tr class="cov-tr-foot">
        <td>I alt <span class="cov-dim">(ekskl. afhentning)</span></td>
        <td class="cov-num">${t.deliveries}</td>
        <td class="cov-num">${_covNum(t.km, 0)}</td>
        <td class="cov-num">${_covKg(t.co2_kg)}</td>
        <td class="cov-num"></td>
        <td class="cov-num">${_covCovBadge(t.coverage_pct)}</td>
      </tr>`;

    // Fordeling pr. metode — tre dimensioner: antal ture, km, CO₂ (alle metoder).
    // Hver søjle normaliseres til sin egen kolonne-max, så man kan se hvem der
    // kører flest ture vs. flest km vs. udleder mest CO₂.
    const maxT = Math.max(1, ...methods.map(m => m.deliveries || 0));
    const maxK = Math.max(1, ...methods.map(m => m.km || 0));
    const maxC = Math.max(1, ...methods.map(m => m.co2_kg || 0));
    const metricCell = (val, max, text, col) =>
        `<span class="cov-tr-m">
           <span class="cov-tr-m-track"><span class="cov-tr-m-fill" style="width:${Math.round((val / max) * 100)}%;background:${col}"></span></span>
           <span class="cov-tr-m-val">${text}</span>
         </span>`;
    const distRows = methods.map(m => {
        const col = _covEsc(_covMethodColor(m));
        const km = m.km || 0, co2 = m.co2_kg || 0;
        return `<div class="cov-tr-drow">
            <span class="cov-tr-dlbl"><span class="cov-tr-dot" style="background:${col}"></span>${_covEsc(m.label)}</span>
            ${metricCell(m.deliveries, maxT, m.deliveries + (m.deliveries === 1 ? ' tur' : ' ture'), col)}
            ${metricCell(km, maxK, m.is_pickup ? '—' : _covNum(km, 0) + ' km', col)}
            ${metricCell(co2, maxC, m.is_pickup ? '—' : _covKg(co2), col)}
          </div>`;
    }).join('');
    const barsBlock = `<div class="cov-tr-dist">
        <div class="cov-tr-dist-h">Fordeling pr. metode</div>
        <div class="cov-tr-drow cov-tr-dhead"><span></span><span>Antal ture</span><span>km</span><span>CO₂</span></div>
        ${distRows}
      </div>`;

    // Datakvalitets-strip (§2.4 — km-data vs. metode/faktor adskilt så tallet er ærligt)
    const unmapped = tr.unmapped_count || 0;
    const dqParts = [];
    if (tr.missing_km_count > 0) {
        dqParts.push(`⚠ <b>${tr.missing_km_count} leveringer mangler km-data</b> — beregnet med fast fallback. Dækning stiger når adresserne geokodes.`);
    }
    if (unmapped > 0) {
        dqParts.push(`<b>${unmapped}</b> uden registreret leveringsmetode (vises som "Ukendt").`);
    }
    const dq = dqParts.length
        ? `<div class="cov-tr-dq">
             <span>${dqParts.join(' · ')}</span>
             <button class="cov-tr-dq-link" id="covTrLogistik">Åbn leveringsmodul →</button>
           </div>`
        : '';

    return `
      <section class="cov-card">
        <h2>Transport pr. leveringsmetode <span class="cov-dim">· ${_covEsc(_covPeriodLabel())}</span></h2>
        <p class="cov-sub">Estimeret ud fra kørte km × CO₂-faktor pr. metode. Faktorer sættes i <code>Settings → Leveringsmetoder</code>. Afhentning tæller 0 (kundens transport er uden for scope).</p>
        ${hierarchy}
        <table class="cov-table cov-tr-table">
          <thead><tr>
            <th>Metode</th><th class="cov-num">Leveringer</th><th class="cov-num">km i alt</th>
            <th class="cov-num">CO₂ i alt</th><th class="cov-num">Gns. pr. levering</th><th class="cov-num">km-dækning</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot>${foot}</tfoot>
        </table>
        ${barsBlock}
        ${dq}
      </section>`;
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
        ${_covMissingRecipes(ov.missing_recipes || [])}
      </section>`;
}

// Impact-rangeret liste: ufuldstændige opskrifter der sælges på bons. Fiks disse
// få lukker mest af hullet. Klik → drill-down (se hvilken råvare der mangler).
function _covMissingRecipes(list) {
    if (!list.length) return '';
    const rows = list.map(r =>
        `<div class="cov-mr-row" data-mr-id="${r.id}" title="Klik → se hvad der mangler i opskriften">
           <span class="cov-mr-name">${_covEsc(r.name)}</span>
           <span class="cov-mr-use">${r.bons} bons <span class="cov-dim">·</span> ${_covNum(r.units, 0)} stk</span>
         </div>`).join('');
    return `
      <div class="cov-mr">
        <h3>Opskrifter uden CO₂-tal <span class="cov-dim">· mest solgt først (seneste 12 mdr) — fiks disse for at lukke mest af hullet</span></h3>
        <div class="cov-mr-list">${rows}</div>
      </div>`;
}

/* Blok 3 — CO₂ over tid. To visninger: stacked pr. kategori (default) + total. */

// Global top-N kategorier (efter samlet bidrag) + "Øvrige"-hale. Farve pr. kategori.
function _covCategoryPlan(series) {
    const totals = {};
    series.forEach(m => Object.entries(m.by_category || {}).forEach(([c, v]) => { totals[c] = (totals[c] || 0) + v; }));
    const sorted = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const TOP = 7;
    const top = sorted.slice(0, TOP);
    const hasOther = sorted.length > TOP;
    let order = hasOther ? [...top, 'Øvrige'] : top;
    const color = new Map(top.map((c, i) => [c, _COV_PALETTE[i % _COV_PALETTE.length]]));
    if (hasOther) color.set('Øvrige', _COV_OTHER_COLOR);
    // Transport-bane øverst i stakken (§2.5) — kun når der er transport-tal.
    // Adskilt fra mad-kategorierne; farve = grøn (som transport-sektionen).
    const hasTransport = series.some(m => (m.transport_co2e || 0) > 0);
    if (hasTransport) { order = [...order, _COV_TRANSPORT_CAT]; color.set(_COV_TRANSPORT_CAT, '#2e7d32'); }
    return { order, color, otherCats: new Set(sorted.slice(TOP)), hasOther, hasTransport,
             hasData: sorted.length > 0 || hasTransport };
}

// Segment-værdier for én måned i plan-rækkefølge (Øvrige = sum af hale, Transport = separat felt).
function _covMonthStack(m, plan) {
    const bc = m.by_category || {};
    return plan.order.map(cat => {
        let v = 0;
        if (cat === _COV_TRANSPORT_CAT) v = m.transport_co2e || 0;
        else if (cat === 'Øvrige') { for (const [c, x] of Object.entries(bc)) if (plan.otherCats.has(c)) v += x; }
        else v = bc[cat] || 0;
        return { cat, v };
    });
}

function _covTimeChart(series) {
    if (!series.length) {
        return `<section class="cov-card cov-chart-card"><h2>CO₂ over tid</h2><p class="cov-dim">Ingen data i perioden endnu — fyldes efterhånden som bons leveres med CO₂-tal.</p></section>`;
    }
    const plan = _covCategoryPlan(series);
    const stacked = _covState.chartMode === 'category' && plan.hasData;
    _covState._chartSeries = series;
    _covState._chartPlan = plan;

    const W = 640, H = 190, pad = 30, padL = 52; // padL: ekstra venstre-plads til y-labels (4-cifrede kg)
    const bw = (W - padL - pad) / series.length;
    const stackTotal = (m) => _covMonthStack(m, plan).reduce((a, s) => a + s.v, 0);
    const max = stacked
        ? Math.max(...series.map(stackTotal), 1)
        : Math.max(...series.map(m => m.co2e || 0), 1);
    const scaleY = (H - pad * 2) / max;

    const cols = series.map((m, i) => {
        const x = padL + i * bw + bw * 0.15;
        const w = bw * 0.7;
        const lbl = m.month.slice(5); // MM
        let segs;
        if (stacked) {
            let acc = 0;
            segs = _covMonthStack(m, plan).filter(s => s.v > 0).map(s => {
                const h = s.v * scaleY;
                acc += h;                     // acc = højde op til segmentets top
                return `<rect x="${x.toFixed(1)}" y="${(H - pad - acc).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"
                    class="cov-chart-seg" fill="${plan.color.get(s.cat)}"><title>${_covEsc(m.month)} · ${_covEsc(s.cat)}: ${_covNum(s.v, 0)} kg</title></rect>`;
            }).join('');
        } else {
            const h = (m.co2e || 0) * scaleY;
            segs = `<rect x="${x.toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" class="cov-chart-bar"></rect>`;
        }
        // Gennemsigtig hit-zone til hover-aflæsning (hele kolonnen).
        const hit = `<rect x="${(padL + i * bw).toFixed(1)}" y="${pad}" width="${bw.toFixed(1)}" height="${H - pad * 2}" class="cov-chart-hit" data-idx="${i}"></rect>`;
        return `${segs}${hit}<text x="${(x + w / 2).toFixed(1)}" y="${H - pad + 12}" text-anchor="middle" class="cov-chart-lbl">${lbl}</text>`;
    }).join('');

    const legend = stacked ? `<div class="cov-chart-legend">${plan.order.map(cat =>
        `<span class="cov-leg"><span class="cov-leg-dot" style="background:${plan.color.get(cat)}"></span>${_covEsc(cat)}</span>`).join('')}</div>` : '';

    return `
      <section class="cov-card cov-chart-card">
        <div class="cov-card-head">
          <h2>CO₂ over tid <span class="cov-dim">· ${_covEsc(_covPeriodLabel())} (kg CO₂e pr. måned)</span></h2>
          <div class="cov-chart-toggle">
            <button class="cov-cm-btn ${stacked ? 'cov-cm-on' : ''}" data-mode="category" ${plan.hasData ? '' : 'disabled'}>Pr. kategori</button>
            <button class="cov-cm-btn ${!stacked ? 'cov-cm-on' : ''}" data-mode="total">Total</button>
          </div>
        </div>
        <div class="cov-chart-readout" id="covChartReadout"><span class="cov-dim">Peg på en måned…</span></div>
        <svg viewBox="0 0 ${W} ${H}" class="cov-chart" preserveAspectRatio="xMidYMid meet">
          <line x1="${padL}" y1="${pad}" x2="${padL}" y2="${H - pad}" class="cov-chart-axis"/>
          <line x1="${padL}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="cov-chart-axis"/>
          <text x="${padL - 6}" y="${pad + 4}" text-anchor="end" class="cov-chart-lbl">${_covNum(max, 0)}</text>
          <text x="${padL - 6}" y="${H - pad}" text-anchor="end" class="cov-chart-lbl">0</text>
          ${cols}
        </svg>
        ${legend}
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
        <p class="cov-sub">Bemærk: enheden varierer — en sandwich er pr. <b>stk</b>, en produktions-batch pr. <b>kg</b>. Tal på tværs af enheder er ikke direkte sammenlignelige. Filtrér fx til "01 Sandwich". <b>Klik en opskrift</b> for at se hvilke råvarer der driver tallet.</p>
        <table class="cov-table cov-recipe-table">
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
        return `<tr class="cov-recipe-row" data-recipe-id="${r.id}" title="Klik → se nedbrydning">
            <td class="cov-recipe-name">${_covEsc(r.name)}${r.category ? `<div class="cov-recipe-cat">${_covEsc(r.category)}</div>` : ''}</td>
            <td class="cov-num">${r.co2e_per_serving != null ? _covNum(r.co2e_per_serving) + unit : '<span class="cov-dim">—</span>'}</td>
            <td>${badge} <span class="cov-row-caret">›</span></td>
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

    // Opskrifter uden CO₂-tal: klik → drill-down (se hvad der mangler).
    el.querySelectorAll('.cov-mr-row').forEach(row => {
        row.addEventListener('click', () => {
            const id = parseInt(row.dataset.mrId, 10);
            if (id) _covOpenPanel(id);
        });
    });

    // Transport-datakvalitet: link til leveringsmodulet.
    const trLog = el.querySelector('#covTrLogistik');
    if (trLog) trLog.addEventListener('click', () => {
        if (window.switchSection) window.switchSection('logistik');
        else if (window.switchView) window.switchView('logistik');
    });

    // Periode-vælger: presets + brugerdefineret interval.
    el.querySelectorAll('.cov-per-btn[data-months]').forEach(b => {
        b.addEventListener('click', () => {
            _covState.period = { months: parseInt(b.dataset.months, 10) };
            _covState.customOpen = false;
            _covReloadPeriod();
        });
    });
    const perToggle = el.querySelector('#covPerCustomToggle');
    if (perToggle) perToggle.addEventListener('click', () => {
        _covState.customOpen = !_covState.customOpen;
        _covRender();
    });
    const perApply = el.querySelector('#covPerApply');
    if (perApply) perApply.addEventListener('click', () => {
        const from = (el.querySelector('#covPerFrom') || {}).value;
        const to = (el.querySelector('#covPerTo') || {}).value;
        if (!from || !to) { alert('Vælg både fra- og til-dato.'); return; }
        if (from > to) { alert('Fra-dato skal være før til-dato.'); return; }
        _covState.period = { from, to };
        _covState.customOpen = false;
        _covReloadPeriod();
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

    _covBindRecipeRows();
    _covBindChartHover();
}

// Opskrift-række → åbn nedbrydnings-panel (gen-bindes efter tabel-re-render).
function _covBindRecipeRows() {
    const el = _covState.container;
    if (!el) return;
    el.querySelectorAll('.cov-recipe-row').forEach(row => {
        row.addEventListener('click', () => _covOpenPanel(parseInt(row.dataset.recipeId, 10), { reset: true }));
    });
}

function _covReRenderTable() {
    const tbody = _covState.container.querySelector('.cov-recipe-table tbody');
    if (tbody) { tbody.innerHTML = _covRecipeRows(_covState.overview.recipes); _covBindRecipeRows(); }
}

/* ─── Graf-aflæsning: fast linje under grafen der opdaterer på hover ────── */

function _covBindChartHover() {
    const el = _covState.container;
    if (!el) return;
    const readout = el.querySelector('#covChartReadout');
    if (!readout) return;
    const series = _covState._chartSeries || [];
    const plan = _covState._chartPlan;
    const stacked = _covState.chartMode === 'category' && plan && plan.hasData;
    const hits = el.querySelectorAll('.cov-chart-hit');

    const show = (i) => {
        const m = series[i];
        if (!m) return;
        if (stacked) {
            const segs = _covMonthStack(m, plan).filter(s => s.v > 0).sort((a, b) => b.v - a.v);
            const tot = segs.reduce((a, s) => a + s.v, 0);
            const chips = segs.slice(0, 4).map(s =>
                `<span class="cov-ro-cat"><span class="cov-leg-dot" style="background:${plan.color.get(s.cat)}"></span>${_covEsc(s.cat)} <b>${_covNum(s.v, 0)}</b> <span class="cov-dim">${tot ? Math.round(s.v / tot * 100) : 0}%</span></span>`).join('');
            readout.innerHTML = `<b>${_covEsc(m.month)}</b> · ${_covNum(tot, 0)} kg CO₂e · ${m.bons} bons<div class="cov-ro-cats">${chips || '<span class="cov-dim">ingen kategori-data</span>'}</div>`;
        } else {
            readout.innerHTML = `<b>${_covEsc(m.month)}</b> · ${_covNum(m.co2e, 0)} kg CO₂e · ${m.bons} bons`
                + (m.co2e_per_pax != null ? ` · <b>${_covNum(m.co2e_per_pax)}</b> kg/kuvert` : '');
        }
    };
    hits.forEach(h => {
        const i = parseInt(h.dataset.idx, 10);
        h.addEventListener('mouseenter', () => { hits.forEach(x => x.classList.remove('cov-chart-hit-active')); h.classList.add('cov-chart-hit-active'); show(i); });
    });
    if (series.length) show(series.length - 1); // default: seneste måned

    // Toggle: kategori ↔ total (re-render kun graf-kortet).
    el.querySelectorAll('.cov-cm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled || btn.dataset.mode === _covState.chartMode) return;
            _covState.chartMode = btn.dataset.mode;
            const card = el.querySelector('.cov-chart-card');
            if (!card) return;
            card.outerHTML = _covTimeChart(_covState._chartSeries || []);
            _covBindChartHover();
        });
    });
}

/* ─── Drill-down-panel: per-råvare-nedbrydning ─────────────────────────── */

async function _covOpenPanel(recipeId, opts = {}) {
    if (!recipeId) return;
    if (opts.reset) _covState.panelStack = [];
    _covEnsurePanel();
    const body = document.getElementById('covPanelBody');
    body.innerHTML = '<div class="cov-loading">Indlæser nedbrydning…</div>';
    document.getElementById('covPanelOverlay').classList.add('cov-panel-open');
    try {
        const data = await fetchCo2RecipeBreakdown(recipeId);
        if (!opts.back) _covState.panelStack.push(recipeId);
        _covRenderPanel(data);
    } catch (e) {
        body.innerHTML = `<div class="cov-error">Kunne ikke hente nedbrydning: ${_covEsc(e.message)}</div>`;
    }
}

function _covEnsurePanel() {
    if (document.getElementById('covPanelOverlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'covPanelOverlay';
    wrap.className = 'cov-panel-overlay';
    wrap.innerHTML = `<div class="cov-panel" role="dialog" aria-label="CO₂-nedbrydning">
        <div class="cov-panel-head">
          <button class="cov-panel-back" id="covPanelBack" title="Tilbage" hidden>‹</button>
          <div class="cov-panel-title" id="covPanelTitle"></div>
          <button class="cov-panel-x" id="covPanelClose" title="Luk (Esc)">✕</button>
        </div>
        <div class="cov-panel-body" id="covPanelBody"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) _covClosePanel(); });
    document.getElementById('covPanelClose').addEventListener('click', _covClosePanel);
    document.getElementById('covPanelBack').addEventListener('click', () => {
        _covState.panelStack.pop();                       // nuværende
        const prev = _covState.panelStack[_covState.panelStack.length - 1];
        if (prev) _covOpenPanel(prev, { back: true });
        else _covClosePanel();
    });
    _covState._panelKey = (e) => { if (e.key === 'Escape') _covClosePanel(); };
    document.addEventListener('keydown', _covState._panelKey);
}

function _covClosePanel() {
    const o = document.getElementById('covPanelOverlay');
    if (o) o.remove();
    if (_covState._panelKey) { document.removeEventListener('keydown', _covState._panelKey); _covState._panelKey = null; }
    _covState.panelStack = [];
}

function _covRenderPanel(d) {
    const title = document.getElementById('covPanelTitle');
    const body = document.getElementById('covPanelBody');
    const back = document.getElementById('covPanelBack');
    if (!title || !body) return;
    back.hidden = _covState.panelStack.length <= 1;

    const unitLbl = d.unit ? 'kg CO₂e / ' + d.unit : 'kg CO₂e';
    title.innerHTML = `${_covEsc(d.name)}${d.category ? ` <span class="cov-dim">· ${_covEsc(d.category)}</span>` : ''}`;

    // Total-header
    const totalTxt = d.complete
        ? `<div class="cov-panel-total"><span class="cov-panel-total-val">${_covNum(d.total_per_serving)}</span> <span class="cov-dim">${_covEsc(unitLbl)}</span></div>`
        : `<div class="cov-panel-total cov-panel-total-partial">
             <span class="cov-panel-total-val">${_covNum(d.total_per_serving)}</span> <span class="cov-dim">${_covEsc(unitLbl)}</span>
             <div class="cov-panel-warn">⚠ Ufuldstændig — tallet mangler data på nogle råvarer (se nedenfor)</div>
           </div>`;

    // Kombinér ingredienser + underopskrifter, sortér efter bidrag (mangler nederst)
    const items = [
        ...d.ingredients.map(x => ({ ...x, _sub: false })),
        ...d.sub_recipes.map(x => ({ ...x, _sub: true })),
    ].sort((a, b) => (b.contribution || -1) - (a.contribution || -1));

    const rows = items.map(x => x._sub ? _covPanelSubRow(x) : _covPanelIngRow(x)).join('');

    body.innerHTML = `
      ${totalTxt}
      <table class="cov-panel-table">
        <thead><tr>
          <th>Råvare</th><th class="cov-num">Mængde</th><th class="cov-num">kg</th>
          <th class="cov-num">Faktor</th><th class="cov-num">Bidrag</th><th class="cov-bar-col">Andel</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="cov-empty">Ingen ingredienser.</td></tr>'}</tbody>
      </table>
      <div class="cov-panel-links">
        <a href="/kitchen/recipes.html?recipe=${d.recipe_id}" target="_blank" class="cov-panel-link">🔍 Åbn i køkken-opskrift</a>
        <a href="/api/recipes/grocy-recipe-link/${d.recipe_id}" target="_blank" class="cov-panel-link">Åbn i Grocy ↗</a>
      </div>`;

    _covBindPanelRows();
}

function _covPanelBar(pct) {
    if (pct == null) return '<span class="cov-dim">—</span>';
    const w = Math.max(2, Math.min(100, pct));
    return `<span class="cov-pbar"><span class="cov-pbar-fill" style="width:${w}%"></span></span><span class="cov-pbar-pct">${Math.round(pct)}%</span>`;
}

function _covPanelIngRow(x) {
    const amt = `${_covNum(x.amount_per_serving, x.amount_per_serving < 1 ? 3 : 2)}${x.unit ? ' ' + _covEsc(x.unit) : ''}`;
    if (x.status === 'ok') {
        const src = x.source ? `<span class="cov-src" title="Kilde">${_covEsc(x.source)}</span>` : '';
        return `<tr>
          <td class="cov-panel-ing">${_covEsc(x.name)}${x.is_packaging ? ' <span class="cov-tag">emb.</span>' : ''}</td>
          <td class="cov-num">${amt}</td>
          <td class="cov-num">${_covNum(x.kg, 3)}</td>
          <td class="cov-num">${_covNum(x.factor)} ${src}</td>
          <td class="cov-num"><b>${_covNum(x.contribution, 3)}</b></td>
          <td class="cov-bar-col">${_covPanelBar(x.pct)}</td>
        </tr>`;
    }
    // Mangler data → status + handling
    let msg, act = '', pid = x.product_id || '';
    if (x.status === 'missing_kgvej') { msg = '<span class="cov-badge cov-badge-blue">Mangler kg-vej</span>'; act = 'goto-vej'; }
    else if (x.status === 'missing_factor' && x.is_packaging) { msg = '<span class="cov-badge cov-badge-amber">Mangler faktor</span>'; act = 'goto-emballage'; }
    else if (x.status === 'missing_factor') { msg = '<span class="cov-badge cov-badge-amber">Mangler faktor</span>'; act = 'manual'; }
    else { msg = '<span class="cov-badge cov-badge-red">Ukendt vare</span>'; }
    const btn = act === 'manual'
        ? `<button class="cov-fix-btn" data-act="manual" data-pid="${pid}" data-name="${_covEsc(x.name)}">Sæt faktor</button>`
        : act ? `<button class="cov-fix-btn" data-act="${act}">Ret →</button>` : '';
    return `<tr class="cov-panel-missing">
      <td class="cov-panel-ing">${_covEsc(x.name)}${x.is_packaging ? ' <span class="cov-tag">emb.</span>' : ''}</td>
      <td class="cov-num">${amt}</td>
      <td class="cov-num">${x.kg != null ? _covNum(x.kg, 3) : '<span class="cov-dim">—</span>'}</td>
      <td colspan="3">${msg} ${btn}</td>
    </tr>`;
}

function _covPanelSubRow(x) {
    const st = x.complete ? '' : ' <span class="cov-badge cov-badge-amber">mangler data</span>';
    return `<tr class="cov-panel-sub" data-sub-id="${x.recipe_id}" title="Klik → åbn underopskrift">
      <td class="cov-panel-ing">↳ ${_covEsc(x.name)} <span class="cov-tag cov-tag-sub">underopskrift</span></td>
      <td class="cov-num">${_covNum(x.servings_per_serving, 3)}</td>
      <td class="cov-num cov-dim">—</td>
      <td class="cov-num cov-dim">—</td>
      <td class="cov-num">${x.contribution != null ? '<b>' + _covNum(x.contribution, 3) + '</b>' : st}</td>
      <td class="cov-bar-col">${_covPanelBar(x.pct)}</td>
    </tr>`;
}

function _covBindPanelRows() {
    const body = document.getElementById('covPanelBody');
    if (!body) return;
    // Drill ned i underopskrift
    body.querySelectorAll('.cov-panel-sub').forEach(row => {
        row.addEventListener('click', () => _covOpenPanel(parseInt(row.dataset.subId, 10)));
    });
    // Ret-knapper
    body.querySelectorAll('.cov-fix-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'goto-vej' && window.switchSection) { _covClosePanel(); window.switchSection('co2', 'vej'); }
            else if (act === 'goto-emballage' && window.switchSection) { _covClosePanel(); window.switchSection('co2', 'emballage'); }
            else if (act === 'manual') _covPanelManualFactor(btn);
        });
    });
}

// Inline manuel faktor i panelet → skriv → genindlæs panel + overblik.
function _covPanelManualFactor(btn) {
    const pid = Number(btn.dataset.pid);
    const name = btn.dataset.name;
    const cell = btn.parentElement;
    cell.innerHTML = `<input type="number" step="any" min="0" class="cov-mf-in" placeholder="kg CO₂e/kg"> <button class="cov-mf-save">✓ Gem</button>`;
    const inp = cell.querySelector('.cov-mf-in');
    inp.focus();
    const save = async () => {
        const v = inp.value.trim();
        if (!v) return;
        try {
            await setCo2ManualFactor(pid, v);
            _covToast(`${name}: faktor sat (manuel)`);
            const cur = _covState.panelStack[_covState.panelStack.length - 1];
            await _covOpenPanel(cur, { back: true });   // genindlæs uden at ændre stack
            _covLoad();                                  // opdater overblikket i baggrunden
        } catch (err) { _covToast('Fejl: ' + err.message, true); }
    };
    cell.querySelector('.cov-mf-save').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
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
