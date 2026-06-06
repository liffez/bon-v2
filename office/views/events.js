/**
 * office/views/events.js
 * ════════════════════════════════════════════════════════════
 * Event-modul (let event: alt fra HQ). Spec: docs/CLAUDE_EVENT.md.
 *
 * To tilstande i samme view:
 *   1) Liste — alle events, sorteret aktive først.
 *   2) Detalje — event-overblik med fire bon-roller + P&L + generator-knapper.
 *
 * API:
 *   initEvents(containerEl, opts)
 *   cleanupEvents()
 * ════════════════════════════════════════════════════════════
 */

/* eslint-disable no-unused-vars */

let _evContainer = null;
let _evOpts      = {};
let _evRecipes   = null;        // cache af Grocy-recipes
let _evCurrentId = null;        // null = liste, ellers detalje

function _evEsc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function _evFmtDate(d) { if (!d) return '—'; const dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('da-DK', { day:'2-digit', month:'short', year:'numeric' }); }
function _evFmtKr(n) { if (n == null) return '—'; return Math.round(n).toLocaleString('da-DK') + ' kr'; }

const _EV_MODEL_LABEL = { light: 'Let event (alt fra HQ)', festival: 'Festival (lokal sporing)' };
const _EV_STATUS_LABEL = { planning: 'Planlægning', active: 'Aktiv', done: 'Afsluttet', cancelled: 'Aflyst' };
const _EV_ROLE_LABEL  = { prep: 'Prep / pakkeliste', topup: 'Top-up', sales: 'Dagssalg', expense: 'Udgift' };
const _EV_ROLE_ICON   = { prep: '🎒', topup: '🔄', sales: '💰', expense: '💸' };

async function _evFetch(path, opts) {
    const res = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}));
    if (!res.ok) {
        let msg = res.statusText;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
    }
    return res.json();
}

// ── ENTRY ────────────────────────────────────────────────────────────────

window.initEvents = function initEvents(containerEl, opts) {
    _evContainer = containerEl;
    _evOpts = opts || {};
    _evCurrentId = null;
    _evRender();
};

window.cleanupEvents = function cleanupEvents() {
    _evContainer = null;
    _evCurrentId = null;
};

// ── RENDER LISTE ─────────────────────────────────────────────────────────

async function _evRender() {
    if (!_evContainer) return;
    if (_evCurrentId != null) return _evRenderDetail(_evCurrentId);
    _evContainer.innerHTML = `<div class="ev-loading">Henter events…</div>`;
    try {
        const { events } = await _evFetch('/events');
        _evContainer.innerHTML = `
            <div class="ev-page">
                <div class="ev-toolbar">
                    <h2 class="ev-page-title">Events</h2>
                    <button class="ev-btn ev-btn-primary" data-act="new-event">+ Nyt event</button>
                </div>
                ${events.length === 0
                    ? `<div class="ev-empty">Ingen events endnu. <button class="ev-link" data-act="new-event">Opret det første</button>.</div>`
                    : `<div class="ev-list">${events.map(_evCardHtml).join('')}</div>`}
                <div class="ev-doctrine">
                    <strong>Princip:</strong> Lagertrækket sker fra <em>prep-bonnen</em> (det vi tager med fra HQ).
                    Dagssalget på pladsen trækker ikke HQ-lageret igen — eventet er en midlertidig forlængelse af HQ.
                    Retur kommer hjem som varemodtagelse. (CLAUDE_EVENT.md §5)
                </div>
            </div>`;
        _evContainer.querySelectorAll('[data-act="new-event"]').forEach(b => b.addEventListener('click', _evOpenNewModal));
        _evContainer.querySelectorAll('[data-event-id]').forEach(el => {
            el.addEventListener('click', () => { _evCurrentId = parseInt(el.dataset.eventId); _evRender(); });
        });
    } catch (err) {
        _evContainer.innerHTML = `<div class="ev-error">Kunne ikke hente events: ${_evEsc(err.message)}</div>`;
    }
}

function _evCardHtml(ev) {
    const modelBadge = ev.model === 'light'
        ? `<span class="ev-badge ev-badge-light">🎪 Let</span>`
        : `<span class="ev-badge ev-badge-festival">🎡 Festival</span>`;
    const statusBadge = `<span class="ev-badge ev-status-${ev.status}">${_EV_STATUS_LABEL[ev.status] || ev.status}</span>`;
    const period = ev.end_date && ev.end_date !== ev.start_date
        ? `${_evFmtDate(ev.start_date)} – ${_evFmtDate(ev.end_date)}`
        : _evFmtDate(ev.start_date);
    return `
        <div class="ev-card" data-event-id="${ev.id}">
            <div class="ev-card-head">
                <h3 class="ev-card-title">${_evEsc(ev.name)}</h3>
                <div class="ev-card-badges">${modelBadge} ${statusBadge}</div>
            </div>
            <div class="ev-card-meta">
                <span>${period}</span>
                <span>·</span>
                <span>${_evEsc(ev.location_name)}</span>
                <span>·</span>
                <span>${ev.bon_count} bon${ev.bon_count === 1 ? '' : 'ner'}</span>
            </div>
        </div>`;
}

// ── RENDER DETALJE ───────────────────────────────────────────────────────

async function _evRenderDetail(id) {
    _evContainer.innerHTML = `<div class="ev-loading">Henter event…</div>`;
    try {
        const data = await _evFetch(`/events/${id}/overview`);
        const ev = data.event;
        const bons = data.bons;
        const pnl = data.pnl;
        const byRole = { prep: [], topup: [], sales: [], expense: [] };
        bons.forEach(b => { (byRole[b.role] || (byRole[b.role] = [])).push(b); });

        const period = ev.end_date && ev.end_date !== ev.start_date
            ? `${_evFmtDate(ev.start_date)} – ${_evFmtDate(ev.end_date)}`
            : _evFmtDate(ev.start_date);

        _evContainer.innerHTML = `
            <div class="ev-page">
                <div class="ev-detail-head">
                    <button class="ev-btn ev-btn-ghost" data-act="back">← Tilbage</button>
                    <h2 class="ev-page-title">${_evEsc(ev.name)}</h2>
                    <div class="ev-card-badges">
                        ${ev.model === 'light'
                            ? '<span class="ev-badge ev-badge-light">🎪 Let event</span>'
                            : '<span class="ev-badge ev-badge-festival">🎡 Festival</span>'}
                        <span class="ev-badge ev-status-${ev.status}">${_EV_STATUS_LABEL[ev.status] || ev.status}</span>
                    </div>
                </div>
                <div class="ev-detail-meta">${period} · ${_evEsc(ev.location_name)}${ev.notes ? ' · ' + _evEsc(ev.notes) : ''}</div>

                <div class="ev-pnl-strip">
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.revenue_incl)}</div><div class="ev-pnl-lbl">Omsætning (inkl moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.revenue_excl)}</div><div class="ev-pnl-lbl">Omsætning (ex moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.cost_estimated)}</div><div class="ev-pnl-lbl">Vareforbrug (ex moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.expenses)}</div><div class="ev-pnl-lbl">Udgifter</div></div>
                    <div class="ev-pnl-cell ev-pnl-result"><div class="ev-pnl-val">${_evFmtKr(pnl.result)}</div><div class="ev-pnl-lbl">Resultat</div></div>
                </div>

                <div class="ev-actions">
                    <button class="ev-btn ev-btn-primary" data-act="gen" data-role="prep">+ Generér prep-bon</button>
                    <button class="ev-btn" data-act="gen" data-role="topup">+ Top-up</button>
                    <button class="ev-btn" data-act="gen" data-role="sales">+ Salgsbon</button>
                    <button class="ev-btn" data-act="gen" data-role="expense">+ Udgift</button>
                </div>

                ${_evRoleSection('prep',    byRole.prep)}
                ${_evRoleSection('topup',   byRole.topup)}
                ${_evRoleSection('sales',   byRole.sales)}
                ${_evRoleSection('expense', byRole.expense)}

                ${ev.model === 'light' ? `
                <div class="ev-doctrine">
                    <strong>§5-gate aktiv:</strong> salgsbonner trækker ikke HQ-lager (prep ejer trækket).
                    Når prep-bonnen sættes til <strong>LEVERET</strong> trækkes varerne fra Grocy HQ-lokationen
                    — også selvom det globale auto-deduct-flag står på 0 (Vej B).
                </div>` : ''}
            </div>`;

        _evContainer.querySelector('[data-act="back"]')
            .addEventListener('click', () => { _evCurrentId = null; _evRender(); });
        _evContainer.querySelectorAll('[data-act="gen"]').forEach(btn => {
            btn.addEventListener('click', () => _evOpenGenModal(ev, btn.dataset.role));
        });
        _evContainer.querySelectorAll('[data-bon-id]').forEach(el => {
            el.addEventListener('click', () => {
                const bonId = parseInt(el.dataset.bonId);
                if (_evOpts.openDrawer) _evOpts.openDrawer(bonId);
            });
        });
    } catch (err) {
        _evContainer.innerHTML = `<div class="ev-error">Kunne ikke hente event: ${_evEsc(err.message)} <button class="ev-link" data-act="back">Tilbage</button></div>`;
        _evContainer.querySelector('[data-act="back"]')?.addEventListener('click', () => { _evCurrentId = null; _evRender(); });
    }
}

function _evRoleSection(role, bons) {
    if (!bons || bons.length === 0) {
        return `
            <div class="ev-role-section ev-role-empty">
                <div class="ev-role-head">${_EV_ROLE_ICON[role]} ${_EV_ROLE_LABEL[role]}</div>
                <div class="ev-role-empty-text">Ingen ${role}-bonner endnu.</div>
            </div>`;
    }
    const rows = bons.map(b => `
        <tr data-bon-id="${b.id}">
            <td class="ev-bon-num">${_evEsc(b.bon_number)}</td>
            <td><span class="ev-bon-status" style="background:${b.status_color || '#999'}">${_evEsc(b.status_label)}</span></td>
            <td>${_evFmtDate(b.delivery_date)}</td>
            <td class="ev-num">${b.total_units || 0}</td>
            <td class="ev-num">${_evFmtKr(b.total_price)}</td>
            <td class="ev-bon-flag">${b.inventory_deducted ? '✓ lager trukket' : ''}</td>
        </tr>`).join('');
    return `
        <div class="ev-role-section">
            <div class="ev-role-head">${_EV_ROLE_ICON[role]} ${_EV_ROLE_LABEL[role]} <span class="ev-role-count">(${bons.length})</span></div>
            <table class="ev-bon-table">
                <thead><tr><th>Bon</th><th>Status</th><th>Dato</th><th>Enheder</th><th>Total</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ── MODAL: opret event ───────────────────────────────────────────────────

function _evOpenNewModal() {
    const today = new Date().toISOString().slice(0, 10);
    _evModal(`
        <h3>Nyt event</h3>
        <label>Navn<input type="text" id="evm-name" placeholder="Roskilde 2026" required></label>
        <label>Model
            <select id="evm-model">
                <option value="light" selected>Let (alt fra HQ)</option>
                <option value="festival">Festival (lokal sporing — ikke bygget endnu)</option>
            </select>
        </label>
        <label>Startdato<input type="date" id="evm-start" value="${today}" required></label>
        <label>Slutdato (valgfri)<input type="date" id="evm-end"></label>
        <label>Noter<textarea id="evm-notes" rows="2" placeholder="Plads, kontaktperson, særlige aftaler…"></textarea></label>
    `, async () => {
        const body = {
            name: document.getElementById('evm-name').value.trim(),
            model: document.getElementById('evm-model').value,
            start_date: document.getElementById('evm-start').value,
            end_date: document.getElementById('evm-end').value || null,
            notes: document.getElementById('evm-notes').value.trim() || null,
        };
        if (!body.name) throw new Error('Navn er påkrævet');
        const ev = await _evFetch('/events', { method: 'POST', body: JSON.stringify(body) });
        _evCurrentId = ev.id;
        _evRender();
    });
}

// ── MODAL: generér bon ───────────────────────────────────────────────────

async function _evOpenGenModal(event, role) {
    if (!_evRecipes) {
        try {
            const data = await _evFetch('/grocy/recipes');
            _evRecipes = data.recipes || data;
            if (!Array.isArray(_evRecipes)) _evRecipes = [];
        } catch (e) { _evRecipes = []; }
    }
    const isProd = (role === 'prep' || role === 'topup');
    const isExpense = role === 'expense';
    const priceMode = isProd ? 'produktion' : 'catering';
    // Sortér recipes pænt efter kategori + navn
    const recipes = (_evRecipes || []).slice().sort((a, b) => {
        const ca = (a.category || 'zz'), cb = (b.category || 'zz');
        if (ca !== cb) return ca.localeCompare(cb, 'da');
        return (a.name || '').localeCompare(b.name || '', 'da');
    });
    const recipeOpts = recipes.map(r =>
        `<option value="${r.id}" data-cat="${_evEsc(r.category||'')}" data-unit="${_evEsc(r.unit||'stk')}" data-price="${r.prices?.[priceMode] ?? 0}" data-cost="${r.cost_price ?? 0}" data-co2e="${r.co2e ?? ''}">${_evEsc(r.name)} ${r.category ? '· ' + _evEsc(r.category) : ''}</option>`
    ).join('');

    _evModal(`
        <h3>${_EV_ROLE_ICON[role]} ${_EV_ROLE_LABEL[role]} — ${_evEsc(event.name)}</h3>
        <div class="ev-modal-hint">
            ${isProd
              ? 'Vælg menuer/varer der skal med fra HQ. Priskategori: <strong>produktion</strong> (0 kr). Status: <strong>NY</strong> — havner på køkkenets I dag-tavle.'
              : isExpense
                ? 'Indtast udgift (fee, benzin, bro). Total bliver negativ — udgiften netter ikke mod omsætning, men vises som omkostning.'
                : 'Vælg menuer kunden køber. Priskategori: <strong>catering</strong>. Status: <strong>GODKENDT</strong>.'}
        </div>
        <label>Dato${isProd ? ' (prep-pakning)' : ''}<input type="date" id="evm-date" value="${event.start_date}"></label>
        ${!isExpense ? '<label>Tilføj fra Grocy<select id="evm-recipe"><option value="">— vælg opskrift —</option>' + recipeOpts + '</select></label>' : ''}
        <div class="ev-line-table-wrap">
            <table class="ev-line-table">
                <thead><tr><th>Vare</th><th>Antal</th><th>Enhed</th><th>${isProd ? 'Kostpris ex' : 'Pris/stk incl'}</th><th>Total</th><th></th></tr></thead>
                <tbody id="evm-lines"></tbody>
            </table>
            <button type="button" class="ev-btn ev-btn-small" id="evm-add-line">+ Tom linje</button>
        </div>
        <label>Note (valgfri)<input type="text" id="evm-note" placeholder="${isProd ? 'Pakke-instrukser, hvilken kasse…' : 'Eventuel reference…'}"></label>
    `, async () => {
        const linesEl = document.getElementById('evm-lines');
        const lines = [];
        linesEl.querySelectorAll('tr[data-line]').forEach(row => {
            const name = row.querySelector('[data-f=name]').value.trim();
            if (!name) return;
            lines.push({
                product_name: name,
                grocy_recipe_id: row.dataset.recipeId ? parseInt(row.dataset.recipeId) : null,
                category: row.dataset.category || null,
                quantity: Number(row.querySelector('[data-f=qty]').value) || 1,
                unit: row.querySelector('[data-f=unit]').value || 'stk',
                unit_price: Number(row.querySelector('[data-f=price]').value) || 0,
                cost_price: row.dataset.cost ? Number(row.dataset.cost) : (isProd ? Number(row.querySelector('[data-f=price]').value) : null),
                co2e: row.dataset.co2e ? Number(row.dataset.co2e) : null,
            });
        });
        if (lines.length === 0) throw new Error('Tilføj mindst én linje');
        const body = {
            role,
            delivery_date: document.getElementById('evm-date').value,
            internal_notes: document.getElementById('evm-note').value.trim() || null,
            lines,
        };
        await _evFetch(`/events/${event.id}/bons`, { method: 'POST', body: JSON.stringify(body) });
        _evRender();
    });

    // Tilføj-linje knap (opskrift → fyld tabel)
    const linesEl = document.getElementById('evm-lines');
    const selectEl = document.getElementById('evm-recipe');
    function addLine(data) {
        const tr = document.createElement('tr');
        tr.dataset.line = '1';
        if (data.recipeId) tr.dataset.recipeId = data.recipeId;
        if (data.category) tr.dataset.category = data.category;
        if (data.cost) tr.dataset.cost = data.cost;
        if (data.co2e) tr.dataset.co2e = data.co2e;
        tr.innerHTML = `
            <td><input type="text" data-f="name" value="${_evEsc(data.name || '')}" placeholder="Navn"></td>
            <td><input type="number" data-f="qty" value="${data.qty || 1}" min="1" step="1" style="width:60px"></td>
            <td><input type="text" data-f="unit" value="${_evEsc(data.unit || 'stk')}" style="width:50px"></td>
            <td><input type="number" data-f="price" value="${data.price ?? 0}" step="0.01" style="width:80px"></td>
            <td class="ev-num" data-f="total">—</td>
            <td><button type="button" class="ev-link" data-f="del">×</button></td>`;
        linesEl.appendChild(tr);
        const recalc = () => {
            const q = Number(tr.querySelector('[data-f=qty]').value) || 0;
            const p = Number(tr.querySelector('[data-f=price]').value) || 0;
            tr.querySelector('[data-f=total]').textContent = _evFmtKr(q * p);
        };
        tr.querySelector('[data-f=qty]').addEventListener('input', recalc);
        tr.querySelector('[data-f=price]').addEventListener('input', recalc);
        tr.querySelector('[data-f=del]').addEventListener('click', () => tr.remove());
        recalc();
    }
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const opt = selectEl.options[selectEl.selectedIndex];
            if (!opt || !opt.value) return;
            addLine({
                recipeId: opt.value,
                name: opt.text.split(' ·')[0],
                category: opt.dataset.cat,
                unit: opt.dataset.unit,
                price: Number(opt.dataset.price),
                cost: Number(opt.dataset.cost),
                co2e: opt.dataset.co2e,
                qty: 1,
            });
            selectEl.value = '';
        });
    }
    document.getElementById('evm-add-line').addEventListener('click', () => addLine({}));
    if (isExpense) addLine({ name: 'Udgift', price: 0 });
}

// ── MODAL primitive (rene event handlers — ingen eksterne deps) ──────────

function _evModal(bodyHtml, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'ev-modal-overlay';
    overlay.innerHTML = `
        <div class="ev-modal" role="dialog">
            <form class="ev-modal-form">
                ${bodyHtml}
                <div class="ev-modal-error" style="display:none"></div>
                <div class="ev-modal-actions">
                    <button type="button" class="ev-btn ev-btn-ghost" data-act="cancel">Annullér</button>
                    <button type="submit" class="ev-btn ev-btn-primary">Gem</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);
    const cleanup = () => overlay.remove();
    overlay.querySelector('[data-act=cancel]').addEventListener('click', cleanup);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
    const errEl = overlay.querySelector('.ev-modal-error');
    overlay.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        errEl.style.display = 'none';
        try { await onSubmit(); cleanup(); }
        catch (err) { errEl.style.display = ''; errEl.textContent = err.message || String(err); }
    });
    // Escape
    const onKey = (e) => { if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}
