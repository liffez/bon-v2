/**
 * office/views/co2-emballage.js
 * ═══════════════════════════════════════════════════════════
 * CO₂ F3 — materiale-faktortabel + emballage-tildeler.
 * Spec: docs/CLAUDE_CO2.md §6 + §8 + §9.
 *
 * To dele på én side:
 *   1. Materialer & faktorer — den lille reference (~8 materialer). Faktorer
 *      udfyldes løbende fra Klimakompasset; gem → auto re-resolve rammer alle
 *      koblede varer.
 *   2. Emballagevarer — Grocy-varer i emballage-grupper. Tildel ét materiale
 *      pr. vare; når materialets faktor kendes, resolves co2e_per_kg straks.
 *
 * Backenden ejer al resolve-/skrive-logik (routes/co2.js). Frontenden regner
 * ikke selv CO₂.
 * ═══════════════════════════════════════════════════════════
 */

/* globals fetchCo2Materials, patchCo2Material, reresolveCo2Material,
           fetchCo2Packaging, assignCo2Material, clearCo2Material */

const _co2State = {
    container: null,
    materials: [],
    products: [],
    search: '',
    statusFilter: '',   // '' | 'unassigned' | 'pending_factor' | 'ok'
    sseHandler: null,
};

const CO2_STATUS = {
    unassigned:       { label: 'Ikke tildelt',   cls: 'co2-badge-grey' },
    pending_factor:   { label: 'Mangler faktor', cls: 'co2-badge-amber' },
    needs_resolve:    { label: 'Skal opdateres', cls: 'co2-badge-blue' },
    unknown_material: { label: 'Ukendt materiale', cls: 'co2-badge-red' },
    ok:               { label: 'OK',             cls: 'co2-badge-green' },
};

function initCo2Emballage(container) {
    _co2State.container = container;
    container.innerHTML = '<div class="co2-loading">Indlæser CO₂-emballage…</div>';
    _co2Load();
}

function cleanupCo2Emballage() {
    _co2State.container = null;
    _co2State.materials = [];
    _co2State.products = [];
    _co2State.sseHandler = null;
}

const _co2Num = (n) => (n == null ? '' : String(n).replace('.', ','));
const _co2Esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function _co2Load() {
    try {
        const [m, p] = await Promise.all([fetchCo2Materials(), fetchCo2Packaging()]);
        _co2State.materials = m.materials || [];
        _co2State.products = p.products || [];
        _co2Render();
    } catch (e) {
        if (!_co2State.container) return;
        _co2State.container.innerHTML =
            `<div class="co2-error">Kunne ikke indlæse: ${_co2Esc(e.message)}<br>
             <small>Kræver forbindelse til den aktive Grocy-lokation.</small></div>`;
    }
}

/* ─── Render ──────────────────────────────────────────────── */

function _co2Render() {
    const el = _co2State.container;
    if (!el) return;

    const prods = _co2State.products;
    const counts = {
        total: prods.length,
        ok: prods.filter(p => p.status === 'ok').length,
        pending: prods.filter(p => p.status === 'pending_factor' || p.status === 'needs_resolve').length,
        unassigned: prods.filter(p => p.status === 'unassigned').length,
        unknown: prods.filter(p => p.status === 'unknown_material').length,
    };

    el.innerHTML = `
      <div class="co2-view">
        <div class="co2-head">
          <h1>CO₂ — Emballage</h1>
          <button class="co2-btn-ghost" id="co2Refresh">↻ Opdatér</button>
        </div>
        <p class="co2-intro">
          Tildel hver emballagevare ét materiale. Udfyld materialets faktor (kg CO₂e/kg)
          fra Klimakompasset når du har den — den slår straks igennem på alle koblede varer.
        </p>

        <div class="co2-kpis">
          ${_co2Kpi('Emballagevarer', counts.total, '')}
          ${_co2Kpi('Klar (OK)', counts.ok, 'green')}
          ${_co2Kpi('Mangler faktor', counts.pending, 'amber')}
          ${_co2Kpi('Uden materiale', counts.unassigned, 'grey')}
          ${counts.unknown ? _co2Kpi('Ukendt materiale', counts.unknown, 'red') : ''}
        </div>

        <section class="co2-card">
          <h2>Materialer &amp; faktorer</h2>
          <p class="co2-sub">Faktor = kg CO₂e pr. kg. Tom = mangler stadig (varer kan kobles alligevel).</p>
          <table class="co2-table co2-materials">
            <thead><tr>
              <th>Materiale</th><th>Typiske varer</th>
              <th>Faktor (kg CO₂e/kg)</th><th>Version</th><th>Varer</th><th></th>
            </tr></thead>
            <tbody>${_co2State.materials.map(_co2MaterialRow).join('')}</tbody>
          </table>
        </section>

        <section class="co2-card">
          <div class="co2-card-head">
            <h2>Emballagevarer</h2>
            <div class="co2-filters">
              <input type="search" id="co2Search" placeholder="Søg vare…" value="${_co2Esc(_co2State.search)}">
              <select id="co2StatusFilter">
                <option value="">Alle</option>
                <option value="unassigned">Uden materiale</option>
                <option value="pending_factor">Mangler faktor</option>
                <option value="ok">Klar (OK)</option>
              </select>
            </div>
          </div>
          <table class="co2-table co2-products">
            <thead><tr>
              <th>Vare</th><th>Gruppe</th><th>Materiale</th>
              <th>kg CO₂e/kg</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>${_co2ProductRows()}</tbody>
          </table>
        </section>
      </div>`;

    _co2Bind();
}

function _co2Kpi(label, value, tone) {
    return `<div class="co2-kpi ${tone ? 'co2-kpi-' + tone : ''}">
        <div class="co2-kpi-val">${value}</div>
        <div class="co2-kpi-lbl">${label}</div>
    </div>`;
}

function _co2MaterialRow(m) {
    const usedBy = _co2State.products.filter(p => p.co2e_material === m.key).length;
    return `<tr data-mat-id="${m.id}" data-mat-key="${_co2Esc(m.key)}">
        <td class="co2-mat-name">${_co2Esc(m.label)}</td>
        <td class="co2-dim">${_co2Esc(m.typical_items || '')}</td>
        <td><input class="co2-factor-in" type="text" inputmode="decimal"
             value="${_co2Num(m.factor)}" placeholder="—"></td>
        <td><input class="co2-version-in" type="text"
             value="${_co2Esc(m.version || '')}" placeholder="fx Klimakompas 2025"></td>
        <td class="co2-used">${usedBy}</td>
        <td><button class="co2-btn-save" data-act="save-mat">Gem</button></td>
    </tr>`;
}

function _co2FilteredProducts() {
    const q = _co2State.search.trim().toLowerCase();
    const sf = _co2State.statusFilter;
    return _co2State.products.filter(p => {
        if (q && !p.name.toLowerCase().includes(q)) return false;
        if (sf === 'ok' && p.status !== 'ok') return false;
        if (sf === 'unassigned' && p.status !== 'unassigned') return false;
        if (sf === 'pending_factor' &&
            !(p.status === 'pending_factor' || p.status === 'needs_resolve')) return false;
        return true;
    });
}

function _co2ProductRows() {
    const rows = _co2FilteredProducts();
    if (!rows.length) return `<tr><td colspan="6" class="co2-empty">Ingen varer matcher.</td></tr>`;
    return rows.map(_co2ProductRow).join('');
}

function _co2ProductRow(p) {
    const st = CO2_STATUS[p.status] || CO2_STATUS.unassigned;
    const opts = ['<option value="">— vælg materiale —</option>']
        .concat(_co2State.materials.map(m =>
            `<option value="${_co2Esc(m.key)}" ${m.key === p.co2e_material ? 'selected' : ''}>${_co2Esc(m.label)}</option>`))
        .join('');
    return `<tr data-pid="${p.id}">
        <td class="co2-prod-name">${_co2Esc(p.name)}</td>
        <td class="co2-dim">${_co2Esc(p.product_group || '')}</td>
        <td><select class="co2-mat-select" data-act="assign">${opts}</select></td>
        <td class="co2-perkg">${p.co2e_per_kg != null ? _co2Num(p.co2e_per_kg) : '<span class="co2-dim">—</span>'}</td>
        <td><span class="co2-badge ${st.cls}">${st.label}</span></td>
        <td>${p.co2e_material
            ? `<button class="co2-btn-clear" data-act="clear" title="Ryd tildeling">✕</button>`
            : ''}</td>
    </tr>`;
}

/* ─── Events ──────────────────────────────────────────────── */

function _co2Bind() {
    const el = _co2State.container;
    if (!el) return;

    el.querySelector('#co2Refresh').addEventListener('click', _co2Load);

    const search = el.querySelector('#co2Search');
    search.addEventListener('input', () => {
        _co2State.search = search.value;
        _co2ReRenderProducts();
    });
    el.querySelector('#co2StatusFilter').addEventListener('change', (e) => {
        _co2State.statusFilter = e.target.value;
        _co2ReRenderProducts();
    });

    // Materiale: gem faktor + version → auto re-resolve
    el.querySelectorAll('[data-act="save-mat"]').forEach(btn => {
        btn.addEventListener('click', () => _co2SaveMaterial(btn.closest('tr')));
    });

    // Vare: tildel materiale
    el.querySelectorAll('.co2-mat-select[data-act="assign"]').forEach(sel => {
        sel.addEventListener('change', () => _co2AssignProduct(sel.closest('tr'), sel.value));
    });

    // Vare: ryd
    el.querySelectorAll('[data-act="clear"]').forEach(btn => {
        btn.addEventListener('click', () => _co2ClearProduct(btn.closest('tr')));
    });
}

// Kun produkt-tabellen gen-renderes ved søgning/filter (bevar materiale-inputs).
function _co2ReRenderProducts() {
    const tbody = _co2State.container.querySelector('.co2-products tbody');
    if (!tbody) return;
    tbody.innerHTML = _co2ProductRows();
    tbody.querySelectorAll('.co2-mat-select[data-act="assign"]').forEach(sel => {
        sel.addEventListener('change', () => _co2AssignProduct(sel.closest('tr'), sel.value));
    });
    tbody.querySelectorAll('[data-act="clear"]').forEach(btn => {
        btn.addEventListener('click', () => _co2ClearProduct(btn.closest('tr')));
    });
}

async function _co2SaveMaterial(tr) {
    const id = tr.dataset.matId;
    const factor = tr.querySelector('.co2-factor-in').value.trim();
    const version = tr.querySelector('.co2-version-in').value.trim();
    const btn = tr.querySelector('[data-act="save-mat"]');
    btn.disabled = true; btn.textContent = 'Gemmer…';
    try {
        const r = await patchCo2Material(id, { factor, version });
        const updated = r.reresolve && typeof r.reresolve.updated === 'number' ? r.reresolve.updated : 0;
        _co2Toast(updated
            ? `Gemt — ${updated} vare${updated === 1 ? '' : 'r'} opdateret`
            : 'Gemt');
        await _co2Load();
    } catch (e) {
        _co2Toast('Fejl: ' + e.message, true);
        btn.disabled = false; btn.textContent = 'Gem';
    }
}

async function _co2AssignProduct(tr, material) {
    const pid = Number(tr.dataset.pid);
    try {
        if (!material) { await clearCo2Material(pid); }
        else { await assignCo2Material(pid, material); }
        // Opdatér lokal state + gen-render produkter (undgå fuld reload for hastighed).
        await _co2Load();
    } catch (e) {
        _co2Toast('Fejl: ' + e.message, true);
    }
}

async function _co2ClearProduct(tr) {
    const pid = Number(tr.dataset.pid);
    try {
        await clearCo2Material(pid);
        await _co2Load();
    } catch (e) {
        _co2Toast('Fejl: ' + e.message, true);
    }
}

/* ─── Toast ───────────────────────────────────────────────── */

function _co2Toast(msg, isErr) {
    let t = document.getElementById('co2Toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'co2Toast';
        t.className = 'co2-toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle('co2-toast-err', !!isErr);
    t.classList.add('co2-toast-show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('co2-toast-show'), 3000);
}

// Eksponer for office/index.html view-registry
window.initCo2Emballage = initCo2Emballage;
window.cleanupCo2Emballage = cleanupCo2Emballage;
