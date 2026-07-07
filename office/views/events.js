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
let _evState     = {};          // forecast/days/categories/event — fylders ved render

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

// ── SSE: hold event-detaljen live ────────────────────────────────────────
// Når en bon under eventet skifter status eller opdateres (fx fra bon-draweren),
// gen-renderes detaljen så Prep/Dagssalg/Udgift-listerne afspejler det uden
// manuel reload. Guards: kun ved åbent event-detalje, spring over hvis man er
// midt i en inline-redigering (forecast/åbningstider) eller har en modal åben.
// Debounced — status + updated-events lander ofte sammen.
let _evSSETimer = null;
window._evHandleSSE = function _evHandleSSE(eventName, data) {
    if (_evCurrentId == null || !_evContainer) return;
    const fa = document.activeElement;
    if (fa && _evContainer.contains(fa) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(fa.tagName)) return;
    if (document.querySelector('.ev-modal-overlay')) return;
    clearTimeout(_evSSETimer);
    _evSSETimer = setTimeout(() => {
        if (_evCurrentId != null && _evContainer) _evRenderDetail(_evCurrentId);
    }, 350);
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
        const forecast = data.forecast || [];
        const days = data.days || [];
        const categories = data.categories || [];
        // Gem på state så generator-modal kan finde måltal pr. kategori pr. dag
        _evState.forecast = forecast;
        _evState.days = days;
        _evState.categories = categories;
        _evState.prepped = data.prepped || {};   // "date|category" → allerede prepped
        _evState.event = ev;
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
                    <div class="ev-detail-actions">
                        <button class="ev-btn ev-btn-small" data-act="edit-event">✎ Redigér</button>
                        <button class="ev-btn ev-btn-small ev-btn-danger" data-act="delete-event">🗑 Slet</button>
                    </div>
                </div>
                <div class="ev-detail-meta">${period} · ${_evEsc(ev.location_name)}${ev.event_address ? ' · 📍 ' + _evEsc(ev.event_address) : ''}</div>

                <div class="ev-pnl-strip">
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.revenue_incl)}</div><div class="ev-pnl-lbl">Omsætning (inkl moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.revenue_excl)}</div><div class="ev-pnl-lbl">Omsætning (ex moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.cost_estimated)}</div><div class="ev-pnl-lbl">Vareforbrug (ex moms)</div></div>
                    <div class="ev-pnl-cell"><div class="ev-pnl-val">${_evFmtKr(pnl.expenses_excl ?? pnl.expenses)}</div><div class="ev-pnl-lbl">Udgifter (ex moms)</div></div>
                    <div class="ev-pnl-cell ev-pnl-result"><div class="ev-pnl-val">${_evFmtKr(pnl.result)}</div><div class="ev-pnl-lbl">Resultat</div></div>
                    <div class="ev-pnl-cell ev-pnl-bank"><div class="ev-pnl-val">${_evFmtKr(pnl.bank_reconciled || 0)}</div><div class="ev-pnl-lbl">🏦 Bank-afstemt (inkl moms)${pnl.bank_reconciled_tx ? ' · ' + pnl.bank_reconciled_tx + ' indb.' : ' · intet afstemt'}</div></div>
                    <div class="ev-pnl-cell ev-pnl-co2"><div class="ev-pnl-val">${_evFmtNum(pnl.co2e_total || 0)}</div><div class="ev-pnl-lbl">🌱 CO₂e (kg)</div></div>
                </div>

                <div class="ev-meta-tools">
                    <div class="ev-info-block collapsed" id="ev-info-block">
                        <button type="button" class="ev-info-toggle" data-act="info-toggle" aria-expanded="false">
                            <span class="ev-info-ico">📝</span>
                            <span class="ev-info-title">Info</span>
                            <span class="ev-info-preview" id="ev-info-preview"></span>
                            <span class="ev-info-caret">▾</span>
                        </button>
                        <div class="ev-info-body" id="ev-info-body" hidden>
                            <textarea class="ev-info-text" id="ev-info-text" rows="5"
                                placeholder="Kontaktpersoner, telefonnumre, åbningstider, check-in-procedure, parkering, prep-noter…&#10;Flere linjer er ok.">${_evEsc(ev.notes || '')}</textarea>
                            <span class="ev-info-status" id="ev-info-status"></span>
                        </div>
                    </div>
                    <div class="ev-attach-block" id="ev-attach-block">
                        <button type="button" class="ev-attach-pill" data-act="attach-toggle" aria-expanded="false">
                            📎 <span class="ev-attach-pill-label">Filer</span>
                            <span class="ev-attach-count" id="ev-attach-count" hidden></span>
                            <span class="ev-attach-caret">▾</span>
                        </button>
                        <input type="file" id="ev-attach-input" hidden multiple
                            accept="application/pdf,image/*,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
                        <div class="ev-attach-pop" id="ev-attach-pop" hidden>
                            <div class="ev-attach-pop-head">
                                <span>Vedhæftninger</span>
                                <button class="ev-btn ev-btn-small" data-act="attach-add">+ Tilføj fil</button>
                            </div>
                            <span class="ev-attach-status" id="ev-attach-status"></span>
                            <div class="ev-attach-list" id="ev-attach-list"></div>
                        </div>
                    </div>
                </div>

                ${_evForecastTable(ev, days, categories, forecast)}

                <div class="ev-actions">
                    <button class="ev-btn ev-btn-primary" data-act="gen" data-role="prep">+ Generér prep-bon</button>
                    <button class="ev-btn" data-act="gen" data-role="topup">+ Top-up</button>
                    <button class="ev-btn" data-act="gen" data-role="sales">+ Salgsbon</button>
                    <button class="ev-btn" data-act="gen" data-role="expense">+ Udgift</button>
                    <button class="ev-btn" data-act="find-payment">🔍 Find indbetaling</button>
                </div>

                ${_evRoleSection('prep',    byRole.prep)}
                ${_evRoleSection('topup',   byRole.topup)}
                ${_evRoleSection('sales',   byRole.sales)}
                ${_evRoleSection('expense', byRole.expense)}

                <div class="ev-return-section" id="evReturnSection">
                    <div class="ev-return-head">
                        <div class="ev-role-head">↩️ Retur &amp; afstemning</div>
                        <button class="ev-btn" data-act="return-calc">Beregn retur-forslag</button>
                    </div>
                    <div class="ev-return-body" id="evReturnBody">
                        <div class="ev-return-intro">Når eventet er slut: beregn hvad der er tilbage (pakket − solgt), tæl fysisk, og bogfør resten tilbage på HQ-lageret.</div>
                    </div>
                </div>

                ${ev.model === 'light' ? `
                <div class="ev-doctrine">
                    <strong>§5-gate aktiv:</strong> salgsbonner trækker ikke HQ-lager (prep ejer trækket).
                    Når prep-bonnen sættes til <strong>LEVERET</strong> trækkes varerne fra Grocy HQ-lokationen
                    — også selvom det globale auto-deduct-flag står på 0 (Vej B).
                </div>` : ''}
            </div>`;

        _evContainer.querySelector('[data-act="back"]')
            .addEventListener('click', () => { _evCurrentId = null; _evRender(); });
        _evContainer.querySelector('[data-act="edit-event"]')
            ?.addEventListener('click', () => _evOpenEventModal(ev));
        _evContainer.querySelector('[data-act="delete-event"]')
            ?.addEventListener('click', () => _evDeleteEvent(ev));
        _evContainer.querySelectorAll('[data-act="gen"]').forEach(btn => {
            btn.addEventListener('click', () => _evOpenGenModal(ev, btn.dataset.role));
        });
        _evContainer.querySelectorAll('[data-bon-id]').forEach(el => {
            el.addEventListener('click', () => {
                const bonId = parseInt(el.dataset.bonId);
                if (_evOpts.openDrawer) _evOpts.openDrawer(bonId);
            });
        });
        _evBindForecastHandlers(ev);
        _evContainer.querySelector('[data-act="return-calc"]')
            ?.addEventListener('click', () => _evLoadReturnSuggestion(ev));
        _evContainer.querySelector('[data-act="find-payment"]')
            ?.addEventListener('click', () => _evOpenFindPayment(ev));
        _evBindInfoNotes(ev);
        _evBindAttachments(ev);
    } catch (err) {
        _evContainer.innerHTML = `<div class="ev-error">Kunne ikke hente event: ${_evEsc(err.message)} <button class="ev-link" data-act="back">Tilbage</button></div>`;
        _evContainer.querySelector('[data-act="back"]')?.addEventListener('click', () => { _evCurrentId = null; _evRender(); });
    }
}

// ── RETUR (§6) ───────────────────────────────────────────────────────────

async function _evLoadReturnSuggestion(ev) {
    const body = document.getElementById('evReturnBody');
    if (!body) return;
    body.innerHTML = '<div class="ev-return-intro">Beregner event-beholdning…</div>';
    try {
        const data = await _evFetch(`/events/${ev.id}/return-suggestion`);
        const items = data.items || [];
        if (items.length === 0) {
            body.innerHTML = '<div class="ev-return-intro">Ingen råvarer at returnere — opret prep-bons (og evt. salgsbons) først.</div>';
            return;
        }
        body.innerHTML = `
            <div class="ev-return-explain">
                <strong>Forslag</strong> = pakket (prep + top-up) − solgt. Justér "Faktisk talt" til det I tæller på pladsen (differencen er spild). Klik <em>Bogfør retur</em> for at lægge det tilbage på HQ.
            </div>
            <div class="ev-return-tablewrap">
            <table class="ev-return-table">
                <thead><tr><th>Råvare</th><th>Pakket</th><th>Solgt</th><th>Forslag (rest)</th><th>Faktisk talt</th></tr></thead>
                <tbody>
                ${items.map(it => `
                    <tr data-ret-pid="${it.product_id}">
                        <td class="ev-ret-name">${_evEsc(it.product_name)}</td>
                        <td class="ev-num">${_evFmtNum(it.prepped)} <span class="ev-ret-unit">${_evEsc(it.unit)}</span></td>
                        <td class="ev-num">${_evFmtNum(it.sold)}</td>
                        <td class="ev-num ev-ret-suggest">${_evFmtNum(it.suggested_rest)}</td>
                        <td><input type="number" min="0" step="any" class="ev-ret-input" value="${_evFmtNum(it.suggested_rest)}" data-ret-pid="${it.product_id}"></td>
                    </tr>`).join('')}
                </tbody>
            </table>
            </div>
            <div class="ev-return-actions">
                <span id="evReturnStatus" class="ev-fc-status"></span>
                <button class="ev-btn ev-btn-primary" data-act="return-book">↩️ Bogfør retur til HQ</button>
            </div>`;
        body.querySelector('[data-act="return-book"]')?.addEventListener('click', () => _evBookReturn(ev, body));
    } catch (err) {
        body.innerHTML = `<div class="ev-error">Kunne ikke beregne retur: ${_evEsc(err.message)}</div>`;
    }
}

async function _evBookReturn(ev, body) {
    const items = [];
    body.querySelectorAll('.ev-ret-input').forEach(inp => {
        const pid = parseInt(inp.dataset.retPid);
        const amt = Number(inp.value);
        if (pid && amt > 0) items.push({ product_id: pid, amount: amt });
    });
    if (items.length === 0) { alert('Ingen mængder at returnere.'); return; }
    const btn = body.querySelector('[data-act="return-book"]');
    const status = document.getElementById('evReturnStatus');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Bogfører…';
    try {
        const res = await _evFetch(`/events/${ev.id}/return`, { method: 'POST', body: JSON.stringify({ items }) });
        const failed = (res.results || []).filter(r => !r.success);
        if (status) {
            status.textContent = `✓ ${res.returned_count} råvarer lagt på HQ-lager${failed.length ? ` · ${failed.length} fejl` : ''}`;
            status.className = 'ev-fc-status ' + (failed.length ? 'err' : 'ok');
        }
    } catch (err) {
        if (status) { status.textContent = 'Fejl: ' + err.message; status.className = 'ev-fc-status err'; }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function _evFmtNum(n) {
    const v = Number(n) || 0;
    return v < 1 ? v.toFixed(2) : (v < 10 ? v.toFixed(1) : String(Math.round(v)));
}

// ── FORECAST TABEL ───────────────────────────────────────────────────────
// Pr. dag (rækker) × kategori (kolonner) — pr-celle indtaster brugeren hvor
// mange færdige produkter (sandwich/slider/kage/drikke) der forventes solgt.
// Køkkenet bruger tallene som måltal når de pakker. Auto-gem på blur.

function _evForecastKey(date, cat) { return date + '|' + cat; }

function _evParseOpenHours(ev) {
    try { return ev && ev.open_hours_json ? (JSON.parse(ev.open_hours_json) || {}) : {}; }
    catch { return {}; }
}

function _evForecastTable(ev, days, categories, forecast) {
    const map = {};
    for (const f of forecast) map[_evForecastKey(f.forecast_date, f.category)] = f.expected_qty;
    const openHours = _evParseOpenHours(ev);

    // Tomt event uden Grocy-kategorier: vis info-tekst
    if (categories.length === 0) {
        return `<div class="ev-forecast ev-forecast-empty">
            Forecast-tabellen kræver Grocy-kategorier (recipes med <code>grupper</code>-userfield og <code>sellable=1</code>).
            Ingen tilgængelige lige nu.
        </div>`;
    }
    if (days.length === 0) {
        return `<div class="ev-forecast ev-forecast-empty">Sæt en startdato på eventet for at planlægge forecast.</div>`;
    }

    // Beregn kolonne-totaler
    const colTotals = {};
    for (const cat of categories) colTotals[cat] = 0;
    for (const d of days) for (const cat of categories) colTotals[cat] += (map[_evForecastKey(d, cat)] || 0);
    const grandTotal = Object.values(colTotals).reduce((a, b) => a + b, 0);

    let html = `
    <div class="ev-forecast">
        <div class="ev-forecast-head">
            <div class="ev-forecast-title">📋 Forecast — forventet salg pr. kategori</div>
            <div class="ev-forecast-hint">Tal-input pr. celle. Auto-gemmer. Driver pakkeliste-måltal + top-up-forslag.</div>
        </div>
        <div class="ev-forecast-tablewrap">
        <table class="ev-forecast-table">
            <thead>
                <tr>
                    <th class="ev-fc-day">Dag</th>
                    <th class="ev-fc-oh">Åbent</th>
                    ${categories.map(c => `<th class="ev-fc-cat">${_evEsc(c)}</th>`).join('')}
                    <th class="ev-fc-total">Total</th>
                    <th class="ev-fc-act"></th>
                </tr>
            </thead>
            <tbody>`;
    for (const d of days) {
        let rowTotal = 0;
        const cells = categories.map(cat => {
            const qty = map[_evForecastKey(d, cat)] || 0;
            rowTotal += qty;
            return `<td><input type="number" min="0" step="1" value="${qty || ''}" placeholder="0"
                    data-fc-date="${d}" data-fc-cat="${_evEsc(cat)}" class="ev-fc-input"></td>`;
        }).join('');
        html += `<tr>
            <td class="ev-fc-day">${_evFmtDate(d)}</td>
            <td class="ev-fc-oh"><input type="text" class="ev-oh-input" maxlength="40"
                value="${_evEsc(openHours[d] || '')}" placeholder="fx 10–18" data-oh-date="${d}"
                title="Åbningstid på pladsen denne dag — vises også i prep-modalen"></td>
            ${cells}
            <td class="ev-fc-total" data-fc-rowtotal="${d}">${rowTotal || ''}</td>
            <td class="ev-fc-act">
                <button class="ev-btn ev-btn-small" data-act="gen-from-forecast" data-fc-date="${d}" title="Generér prep-bon der dækker dagens forecast">+ Prep</button>
            </td>
        </tr>`;
    }
    html += `</tbody>
            <tfoot>
                <tr>
                    <th class="ev-fc-day">Total</th>
                    <th class="ev-fc-oh"></th>
                    ${categories.map(c => `<th class="ev-fc-total" data-fc-coltotal="${_evEsc(c)}">${colTotals[c] || ''}</th>`).join('')}
                    <th class="ev-fc-total ev-fc-grand">${grandTotal || ''}</th>
                    <th></th>
                </tr>
            </tfoot>
        </table>
        </div>
        <div class="ev-forecast-foot">
            <span id="ev-fc-status" class="ev-fc-status"></span>
        </div>
    </div>`;
    return html;
}

// Inline-redigerbart info-panel på event-overblikket. Bundet til events.notes
// (fuldt wired: PATCH /events/:id → changelog → SSE). Auto-gem debounced på
// input + gem ved blur. SSE-handleren guarder mod re-render mens feltet har
// fokus (jf. _evHandleSSE), så auto-gemmet klobrer ikke teksten.
function _evBindInfoNotes(ev) {
    const ta = _evContainer.querySelector('#ev-info-text');
    if (!ta) return;
    const statusEl = _evContainer.querySelector('#ev-info-status');
    const setStatus = (t, cls) => {
        if (!statusEl) return;
        statusEl.textContent = t;
        statusEl.className = 'ev-info-status' + (cls ? ' ' + cls : '');
    };
    const autoGrow = () => {
        // Mål aldrig når feltet er skjult/for smalt (under view-skift eller
        // re-render, eller i et kollapset viewport) — så wrapper teksten til
        // hundredvis af linjer og en forkert kæmpe-højde fryses. Feltet er
        // altid >200px i en rigtig browser (panel max-width 800). CSS
        // min-height + overflow-y:auto + max-height er backstop.
        if (ta.clientWidth < 200) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 400) + 'px';
    };
    let timer = null;
    const save = async () => {
        const val = ta.value.trim() || null;
        if (val === (ev.notes || null)) return;   // ingen ændring → intet kald
        try {
            setStatus('Gemmer…');
            await _evFetch(`/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify({ notes: val }) });
            ev.notes = val;
            if (_evState.event) _evState.event.notes = val;
            setStatus('✓ Gemt', 'ok');
            setTimeout(() => setStatus(''), 1500);
        } catch (err) {
            setStatus('Fejl: ' + err.message, 'err');
        }
    };
    ta.addEventListener('input', () => { autoGrow(); clearTimeout(timer); timer = setTimeout(save, 600); });
    ta.addEventListener('blur', () => { clearTimeout(timer); save(); });

    // Sammenklap: én linje når lukket (preview af noten), foldes ud til
    // redigering. Default lukket så info-feltet ikke stjæler hele overblikket.
    const block   = _evContainer.querySelector('#ev-info-block');
    const body    = _evContainer.querySelector('#ev-info-body');
    const toggle  = _evContainer.querySelector('[data-act="info-toggle"]');
    const preview = _evContainer.querySelector('#ev-info-preview');
    const updatePreview = () => {
        if (!preview) return;
        const val = (ev.notes || '').trim();
        if (!val) {
            preview.textContent = 'Tilføj kontakt, åbningstider, check-in…';
            preview.classList.add('ghost');
        } else {
            const lines = val.split('\n').filter(l => l.trim());
            const first = lines[0] || val;
            preview.textContent = (first.length > 70 ? first.slice(0, 70) + '…' : first) +
                (lines.length > 1 ? `  (+${lines.length - 1})` : '');
            preview.classList.remove('ghost');
        }
    };
    const setOpen = (open) => {
        if (!block || !body || !toggle) return;
        block.classList.toggle('collapsed', !open);
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) requestAnimationFrame(() => { autoGrow(); ta.focus(); });
    };
    // Preview afspejler den gemte note; opdatér når feltet forlades (efter gem).
    ta.addEventListener('blur', () => setTimeout(updatePreview, 50));
    toggle?.addEventListener('click', () => setOpen(body.hidden));
    updatePreview();
}

// Vedhæftninger på eventet (kort, billeder, PDF, dokumenter). Genbruger den
// generiske polymorfe attachments-tabel med entity_type='event'. Upload +
// liste + download/vis + slet. Billeder/PDF åbnes til visning; andre hentes.
const _EV_ATT_ICON = { image: '🖼', pdf: '📄', document: '📎' };

function _evBindAttachments(ev) {
    const block    = _evContainer.querySelector('#ev-attach-block');
    const listEl   = _evContainer.querySelector('#ev-attach-list');
    const input    = _evContainer.querySelector('#ev-attach-input');
    const addBtn   = _evContainer.querySelector('[data-act="attach-add"]');
    const pill     = _evContainer.querySelector('[data-act="attach-toggle"]');
    const pop      = _evContainer.querySelector('#ev-attach-pop');
    const countEl  = _evContainer.querySelector('#ev-attach-count');
    const statusEl = _evContainer.querySelector('#ev-attach-status');
    if (!listEl || !input) return;

    const setStatus = (t, cls) => {
        if (!statusEl) return;
        statusEl.textContent = t || '';
        statusEl.className = 'ev-attach-status' + (cls ? ' ' + cls : '');
    };

    const setCount = (n) => {
        if (!countEl) return;
        countEl.textContent = n;
        countEl.hidden = !n;
        pill?.classList.toggle('has-files', !!n);
    };

    // Popover åbnes/lukkes; luk ved klik udenfor + Escape.
    let outsideHandler = null;
    const closePop = () => {
        if (!pop || pop.hidden) return;
        pop.hidden = true;
        pill?.setAttribute('aria-expanded', 'false');
        if (outsideHandler) { document.removeEventListener('mousedown', outsideHandler, true); document.removeEventListener('keydown', escHandler, true); outsideHandler = null; }
    };
    const escHandler = (e) => { if (e.key === 'Escape') closePop(); };
    const openPop = () => {
        if (!pop) return;
        pop.hidden = false;
        pill?.setAttribute('aria-expanded', 'true');
        outsideHandler = (e) => { if (block && !block.contains(e.target)) closePop(); };
        document.addEventListener('mousedown', outsideHandler, true);
        document.addEventListener('keydown', escHandler, true);
    };
    pill?.addEventListener('click', () => { pop && pop.hidden ? openPop() : closePop(); });

    const render = (items) => {
        setCount(items.length);
        if (!items.length) {
            listEl.innerHTML = '<div class="ev-attach-empty">Ingen filer endnu. Vedhæft kort, billeder, PDF…</div>';
            return;
        }
        listEl.innerHTML = items.map(a => {
            const icon = _EV_ATT_ICON[a.file_type] || '📎';
            const viewable = a.file_type === 'image' || a.file_type === 'pdf';
            const openUrl = viewable ? attachmentInlineUrl(a.id) : attachmentUrl(a.id);
            const by = a.uploaded_by_name ? ` · ${_evEsc(a.uploaded_by_name)}` : '';
            return `<div class="ev-attach-item" data-att-id="${a.id}">
                <a class="ev-attach-link" href="${openUrl}" target="_blank" rel="noopener" title="${viewable ? 'Åbn' : 'Hent'}">
                    <span class="ev-attach-ico">${icon}</span>
                    <span class="ev-attach-name">${_evEsc(a.file_name)}</span>
                </a>
                <span class="ev-attach-meta">${_evFmtDate((a.created_at || '').slice(0, 10))}${by}</span>
                <a class="ev-attach-dl" href="${attachmentUrl(a.id)}" title="Hent">⬇</a>
                <button class="ev-attach-del" data-att-del="${a.id}" title="Slet">✕</button>
            </div>`;
        }).join('');
        listEl.querySelectorAll('[data-att-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.attDel, 10);
                if (!confirm('Slet denne vedhæftning?')) return;
                try {
                    await deleteAttachment(id);
                    load();
                } catch (err) { setStatus('Kunne ikke slette: ' + err.message, 'err'); }
            });
        });
    };

    const load = async () => {
        try {
            const { attachments } = await fetchAttachments('event', ev.id);
            render(attachments || []);
        } catch (err) {
            listEl.innerHTML = `<div class="ev-attach-empty">Kunne ikke hente vedhæftninger: ${_evEsc(err.message)}</div>`;
        }
    };

    addBtn?.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        const files = [...input.files];
        input.value = '';   // så samme fil kan vælges igen senere
        if (!files.length) return;
        let done = 0;
        for (const f of files) {
            setStatus(`Uploader ${done + 1}/${files.length}…`);
            try {
                await uploadAttachment(f, 'event', ev.id);
                done++;
            } catch (err) {
                setStatus(`${_evEsc(f.name)}: ${err.message}`, 'err');
            }
        }
        if (done) setStatus(`✓ ${done} fil${done > 1 ? 'er' : ''} tilføjet`, 'ok');
        setTimeout(() => setStatus(''), 2500);
        load();
    });

    load();
}

function _evBindForecastHandlers(ev) {
    const inputs = _evContainer.querySelectorAll('.ev-fc-input');
    if (inputs.length === 0) return;
    let saveTimer = null;
    const status = () => _evContainer.querySelector('#ev-fc-status');
    const showStatus = (text, cls) => {
        const s = status();
        if (!s) return;
        s.textContent = text;
        s.className = 'ev-fc-status' + (cls ? ' ' + cls : '');
    };

    const saveAll = async () => {
        const items = [];
        _evContainer.querySelectorAll('.ev-fc-input').forEach(inp => {
            const qty = parseInt(inp.value, 10);
            if (!qty || qty <= 0) return;
            items.push({ forecast_date: inp.dataset.fcDate, category: inp.dataset.fcCat, expected_qty: qty });
        });
        try {
            showStatus('Gemmer…');
            const res = await _evFetch(`/events/${ev.id}/forecast`, { method: 'PUT', body: JSON.stringify({ items }) });
            _evState.forecast = res.forecast || [];
            // Genberegn række/kolonne-totaler i UI uden full re-render
            _evRecalcForecastTotals();
            showStatus('✓ Gemt', 'ok');
            setTimeout(() => showStatus(''), 1500);
        } catch (err) {
            showStatus('Fejl: ' + err.message, 'err');
        }
    };
    const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveAll, 400);
    };

    inputs.forEach(inp => {
        inp.addEventListener('input', () => { _evRecalcForecastTotals(); scheduleSave(); });
        inp.addEventListener('blur', () => { clearTimeout(saveTimer); saveAll(); });
    });

    // Åbningstider pr. dag — gemmes som JSON på eventet (PATCH), separat fra
    // forecast-items. Debounced så vi ikke spammer mens der tastes.
    let ohTimer = null;
    const saveOpenHours = async () => {
        const obj = {};
        _evContainer.querySelectorAll('.ev-oh-input').forEach(inp => {
            const v = inp.value.trim();
            if (v) obj[inp.dataset.ohDate] = v;
        });
        const json = Object.keys(obj).length ? JSON.stringify(obj) : null;
        try {
            showStatus('Gemmer…');
            await _evFetch(`/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify({ open_hours_json: json }) });
            if (_evState.event) _evState.event.open_hours_json = json;
            showStatus('✓ Gemt', 'ok');
            setTimeout(() => showStatus(''), 1500);
        } catch (err) {
            showStatus('Fejl: ' + err.message, 'err');
        }
    };
    _evContainer.querySelectorAll('.ev-oh-input').forEach(inp => {
        inp.addEventListener('input', () => { clearTimeout(ohTimer); ohTimer = setTimeout(saveOpenHours, 600); });
        inp.addEventListener('blur', () => { clearTimeout(ohTimer); saveOpenHours(); });
    });

    _evContainer.querySelectorAll('[data-act="gen-from-forecast"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const date = btn.dataset.fcDate;
            _evOpenGenModal(_evState.event, 'prep', { forecastDate: date });
        });
    });
}

function _evRecalcForecastTotals() {
    if (!_evContainer) return;
    const rows = new Map();   // date → sum
    const cols = new Map();   // cat → sum
    let grand = 0;
    _evContainer.querySelectorAll('.ev-fc-input').forEach(inp => {
        const v = parseInt(inp.value, 10) || 0;
        rows.set(inp.dataset.fcDate, (rows.get(inp.dataset.fcDate) || 0) + v);
        cols.set(inp.dataset.fcCat, (cols.get(inp.dataset.fcCat) || 0) + v);
        grand += v;
    });
    _evContainer.querySelectorAll('[data-fc-rowtotal]').forEach(td => {
        const t = rows.get(td.dataset.fcRowtotal) || 0;
        td.textContent = t || '';
    });
    _evContainer.querySelectorAll('[data-fc-coltotal]').forEach(th => {
        const t = cols.get(th.dataset.fcColtotal) || 0;
        th.textContent = t || '';
    });
    const g = _evContainer.querySelector('.ev-fc-grand');
    if (g) g.textContent = grand || '';
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

// ── MODAL: opret/redigér event ───────────────────────────────────────────
// ev = null → opret. ev = objekt → redigér (PATCH).

function _evOpenNewModal() { _evOpenEventModal(null); }

function _evOpenEventModal(ev) {
    const isEdit = !!ev;
    const today = new Date().toISOString().slice(0, 10);
    const v = (s) => _evEsc(s == null ? '' : s);
    const statusOpt = (val, lbl) => `<option value="${val}" ${ev && ev.status === val ? 'selected' : ''}>${lbl}</option>`;
    // DAWA-state: pickedAddr = valgt forslag (struktureret + koordinater),
    // addrDirty = brugeren har rørt feltet siden modal-åbning.
    let pickedAddr = null, addrDirty = false;
    _evModal(`
        <h3>${isEdit ? 'Redigér event' : 'Nyt event'}</h3>
        <label>Navn<input type="text" id="evm-name" placeholder="Roskilde 2026" value="${v(ev && ev.name)}" required></label>
        <label>Model
            <select id="evm-model" ${isEdit ? 'disabled' : ''}>
                <option value="light" ${!ev || ev.model === 'light' ? 'selected' : ''}>Let (alt fra HQ)</option>
                <option value="festival" ${ev && ev.model === 'festival' ? 'selected' : ''}>Festival (lokal sporing — ikke bygget endnu)</option>
            </select>
        </label>
        ${isEdit ? `<label>Status
            <select id="evm-status">
                ${statusOpt('planning', 'Planlægning')}
                ${statusOpt('active', 'Aktiv')}
                ${statusOpt('done', 'Afsluttet')}
                ${statusOpt('cancelled', 'Aflyst')}
            </select>
        </label>` : ''}
        <label>Startdato<input type="date" id="evm-start" value="${ev ? v(ev.start_date) : today}" required></label>
        <label>Slutdato (valgfri)<input type="date" id="evm-end" value="${v(ev && ev.end_date)}"></label>
        <label>Adresse / sted (valgfri)
            <span class="ev-dawa-wrap">
                <input type="text" id="evm-address" placeholder="Festivalpladsen, Darupvej 19, Roskilde" value="${v(ev && ev.event_address)}" autocomplete="off">
                <span class="ev-dawa-results" id="evm-address-results"></span>
            </span>
            <span class="ev-dawa-hint" id="evm-address-hint">${ev && ev.event_address_id ? '✓ DAWA-valideret adresse med koordinater' : ''}</span>
        </label>
        <label>Noter<textarea id="evm-notes" rows="3" placeholder="Kontaktperson, særlige aftaler, parkering…">${v(ev && ev.notes)}</textarea></label>
    `, async () => {
        const addrText = document.getElementById('evm-address').value.trim();
        const body = {
            name: document.getElementById('evm-name').value.trim(),
            start_date: document.getElementById('evm-start').value,
            end_date: document.getElementById('evm-end').value || null,
            event_address: addrText || null,
            notes: document.getElementById('evm-notes').value.trim() || null,
        };
        if (!body.name) throw new Error('Navn er påkrævet');
        if (!body.start_date) throw new Error('Startdato er påkrævet');
        // DAWA-valgt adresse → opret struktureret addresses-række NU (med
        // koordinater) og peg eventet på den. Fritekst-redigering rydder
        // koblingen — bons falder så tilbage til geokodnings-forsøget.
        if (pickedAddr && addrText) {
            const r = await fetch('/api/addresses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ ...pickedAddr, label: body.name }),
            });
            if (!r.ok) throw new Error('Kunne ikke gemme adressen');
            body.event_address_id = (await r.json()).id;
        } else if (addrDirty) {
            body.event_address_id = null;
        }
        if (isEdit) {
            body.status = document.getElementById('evm-status').value;
            await _evFetch(`/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        } else {
            body.model = document.getElementById('evm-model').value;
            const created = await _evFetch('/events', { method: 'POST', body: JSON.stringify(body) });
            _evCurrentId = created.id;
        }
        _evRender();
    });

    // DAWA-autocomplete på adressefeltet — valideret adresse + koordinater
    // allerede ved event-oprettelsen (i stedet for først senere på bonnen).
    const addrInput = document.getElementById('evm-address');
    const addrResults = document.getElementById('evm-address-results');
    const addrHint = document.getElementById('evm-address-hint');
    let dawaTimer = null;
    addrInput.addEventListener('input', () => {
        addrDirty = true;
        pickedAddr = null;
        if (addrHint) addrHint.textContent = addrInput.value.trim()
            ? 'Fritekst — vælg et forslag for valideret adresse med koordinater' : '';
        clearTimeout(dawaTimer);
        const q = addrInput.value.trim();
        if (q.length < 3) { addrResults.style.display = 'none'; return; }
        dawaTimer = setTimeout(async () => {
            try {
                const resp = await fetch(`https://api.dataforsyningen.dk/adresser/autocomplete?q=${encodeURIComponent(q)}&per_side=5`);
                const data = await resp.json();
                addrResults.innerHTML = '';
                if (!Array.isArray(data) || data.length === 0) { addrResults.style.display = 'none'; return; }
                addrResults.style.display = 'block';
                for (const item of data) {
                    const div = document.createElement('div');
                    div.className = 'ev-dawa-item';
                    div.textContent = item.tekst;
                    // mousedown (ikke click) så valget når at fyre før input-blur
                    div.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        const a = item.adresse || {};
                        pickedAddr = {
                            street_name: a.vejnavn || item.tekst,
                            street_nr: a.husnr || null,
                            postal_code: a.postnr || null,
                            city: a.postnrnavn || null,
                            lat: a.y ?? null,
                            lon: a.x ?? null,
                        };
                        addrInput.value = item.tekst;
                        addrResults.style.display = 'none';
                        if (addrHint) addrHint.textContent = '✓ DAWA-valideret — koordinater gemmes med eventet';
                    });
                    addrResults.appendChild(div);
                }
            } catch (err) {
                console.warn('DAWA fejl:', err);
            }
        }, 300);
    });
    addrInput.addEventListener('blur', () => {
        setTimeout(() => { if (addrResults) addrResults.style.display = 'none'; }, 150);
    });
}

// Slet event (med bekræftelse). Afkobler bons og sletter eventet.
async function _evDeleteEvent(ev) {
    const ok = confirm(`Slet eventet "${ev.name}"?\n\nTilknyttede bons (prep, salg osv.) bevares som almindelige bons — de bliver bare afkoblet fra eventet. Forecast slettes. Dette kan ikke fortrydes.`);
    if (!ok) return;
    try {
        const res = await _evFetch(`/events/${ev.id}`, { method: 'DELETE' });
        const n = res.unlinked_bons || 0;
        _evCurrentId = null;
        _evRender();
        // Lille kvittering
        setTimeout(() => {
            const tb = _evContainer && _evContainer.querySelector('.ev-toolbar');
            if (tb) {
                const note = document.createElement('span');
                note.className = 'ev-fc-status ok';
                note.style.marginLeft = '12px';
                note.textContent = `✓ Event slettet${n ? ` · ${n} bons afkoblet` : ''}`;
                tb.appendChild(note);
                setTimeout(() => note.remove(), 4000);
            }
        }, 100);
    } catch (err) {
        alert('Kunne ikke slette event: ' + err.message);
    }
}

// ── MODAL: generér bon ───────────────────────────────────────────────────

async function _evOpenGenModal(event, role, opts) {
    opts = opts || {};
    if (!_evRecipes) {
        try {
            const data = await _evFetch('/grocy/recipes');
            _evRecipes = data.recipes || data;
            if (!Array.isArray(_evRecipes)) _evRecipes = [];
        } catch (e) { _evRecipes = []; }
    }
    const isProd = (role === 'prep' || role === 'topup');
    const isExpense = role === 'expense';
    // Salg/udgift bruger FESTIVAL-salgspris (events sælges til festivalpris).
    const priceMode = isProd ? 'produktion' : 'festival';

    // Salgsbon: pre-fyld linjerne fra eventets prep-bonner (de færdige menuer
    // vi tog med). Hentes før modalen bygges så addLine kan fyre dem ind nederst.
    let salesPrefill = null;
    if (role === 'sales') {
        try { salesPrefill = await _evFetch(`/events/${event.id}/sales-prefill`); }
        catch (e) { salesPrefill = null; }
    }

    // Top-up: default-dato = i dag hvis vi står midt i eventet (det er en
    // morgen-beregning), ellers start_date. Lokal dato — IKKE toISOString
    // (UTC-"i dag"-buggen).
    const isTopup = role === 'topup';
    let defaultDate = opts.forecastDate || event.start_date;
    if (isTopup && !opts.forecastDate) {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const end = event.end_date || event.start_date;
        if (today >= event.start_date && today <= end) defaultDate = today;
    }
    // Gruppér recipes efter kategori (Grocy `grupper`) som <optgroup>
    const recipes = (_evRecipes || []).slice().sort((a, b) => {
        const ca = (a.category || 'zz'), cb = (b.category || 'zz');
        if (ca !== cb) return ca.localeCompare(cb, 'da');
        return (a.name || '').localeCompare(b.name || '', 'da');
    });
    const byCat = {};
    for (const r of recipes) {
        const cat = r.category || '(uden kategori)';
        (byCat[cat] = byCat[cat] || []).push(r);
    }
    const recipeOpts = Object.keys(byCat).sort((a, b) => a.localeCompare(b, 'da')).map(cat =>
        `<optgroup label="${_evEsc(cat)}">` +
        byCat[cat].map(r =>
            `<option value="${r.id}" data-cat="${_evEsc(r.category||'')}" data-unit="${_evEsc(r.unit||'stk')}" data-price="${r.prices?.[priceMode] ?? 0}" data-cost="${r.cost_price ?? 0}" data-co2e="${r.co2e ?? ''}">${_evEsc(r.name)}</option>`
        ).join('') +
        `</optgroup>`
    ).join('');

    // Måltal pr. kategori — hvis vi åbnede modalen fra "+ Prep dag N",
    // viser vi en strip øverst med forecast for den dag. Baseline = allerede
    // prepped (fra eksisterende bons) så strippen viser reel fremdrift; det
    // brugeren tilføjer i denne modal lægges oveni (top-up-flow).
    const forecastDate = opts.forecastDate || null;
    let targetStrip = '';
    const _prepped = _evState.prepped || {};
    if (forecastDate && Array.isArray(_evState.forecast)) {
        const todayTargets = _evState.forecast.filter(f => f.forecast_date === forecastDate);
        if (todayTargets.length > 0) {
            targetStrip = `<div class="ev-target-strip">
                <div class="ev-target-head">📋 Måltal — ${_evFmtDate(forecastDate)} <span class="ev-target-sub">(allerede prepped + denne bon / forecast)</span></div>
                ${todayTargets.map(t => {
                    const base = _prepped[`${forecastDate}|${t.category}`] || 0;
                    return `
                    <div class="ev-target-pill ${base >= t.expected_qty ? 'ev-target-met' : ''}" data-target-cat="${_evEsc(t.category)}" data-target-base="${base}">
                        <span class="ev-target-cat">${_evEsc(t.category)}</span>
                        <span class="ev-target-progress"><span class="ev-target-current" data-target-current="${_evEsc(t.category)}">${base}</span> / ${t.expected_qty}</span>
                    </div>`;
                }).join('')}
            </div>`;
        }
    }

    _evModal(`
        <h3>${_EV_ROLE_ICON[role]} ${_EV_ROLE_LABEL[role]} — ${_evEsc(event.name)}</h3>
        <div class="ev-modal-hint">
            ${isTopup
              ? 'Forslaget = <strong>forecast − beregnet rest på pladsen</strong> (preppet − solgt). Resten er et gæt ud fra de registrerede salgsbons — <em>justér frit</em>. Bonnen er 0 kr (produktion), status <strong>GODKENDT</strong>.'
              : isProd
              ? 'Vælg menuer/varer der skal med fra HQ. Bonnen er bevidst <strong>0 kr</strong> (produktion) — kolonnen <em>Kostpris ex</em> snapshottes pr. linje og driver Vareforbrug i P&amp;L. Status: <strong>GODKENDT</strong> — havner på køkkenets I dag-tavle på prep-datoen.'
              : isExpense
                ? 'Indtast udgift (fee, benzin, bro) — eller vælg en udgifts-menu fra Grocy (fylder kun <em>navnet</em>; beløb og antal taster du selv). Total bliver negativ; udgiften netter ikke mod omsætning, men vises som omkostning. <strong>⚠ Sæt moms pr. linje</strong> — default er <em>uden moms</em> (Grocy-kostpris og service er ex moms), skift til <em>med moms</em> for kvitteringer hvor beløbet er incl moms.'
                : 'Pre-udfyldt fra eventets <strong>prep-bonner</strong> (de færdige menuer vi tog med). Priskategori: <strong>festival</strong>. Antal = preppet — <em>justér ned</em> for spild, smagsprøver mm. Status: <strong>BETALT</strong> — omsætningen tæller med i økonomirapporten med det samme. Delrapporterer du, så opdater <em>samme</em> bon hen ad dagen.'}
        </div>
        ${targetStrip}
        <label>Dato${isProd ? ' (prep-pakning)' : ''}<input type="date" id="evm-date" value="${defaultDate}"></label>
        ${isTopup ? '<div id="evm-topup" class="ev-topup-strip"></div>' : ''}
        <div class="ev-modal-oh" id="evm-oh" style="display:none"></div>
        <label>Tilføj fra Grocy<select id="evm-recipe"><option value="">— vælg ${isExpense ? 'produkt' : 'opskrift'} —</option>${recipeOpts}</select></label>
        <div class="ev-line-table-wrap">
            <table class="ev-line-table">
                <thead><tr><th>Vare</th><th>Antal</th><th>Enhed</th><th>${isProd ? 'Kostpris ex' : (isExpense ? 'Beløb' : 'Pris/stk incl')}</th>${isExpense ? '<th>Moms</th>' : ''}<th>Total</th><th></th></tr></thead>
                <tbody id="evm-lines"></tbody>
            </table>
            <button type="button" class="ev-btn ev-btn-small" id="evm-add-line">+ Fritekst-linje</button>
        </div>
        <label>Note (valgfri)<input type="text" id="evm-note" placeholder="${isProd ? 'Pakke-instrukser, hvilken kasse…' : 'Eventuel reference…'}"></label>
    `, async () => {
        const linesEl = document.getElementById('evm-lines');
        const lines = [];
        linesEl.querySelectorAll('tr[data-line]').forEach(row => {
            const name = row.querySelector('[data-f=name]').value.trim();
            if (!name) return;
            // Prod-bons: pris-feltet ER kostprisen (kolonnen hedder "Kostpris ex").
            // unit_price tvinges til 0 (prep/top-up = 0 kr, spec §3) og feltet
            // snapshottes som cost_price så vareforbrug/P&L får rigtige tal.
            const fieldVal = Number(row.querySelector('[data-f=price]').value) || 0;
            const momsSel = row.querySelector('[data-f=moms]');
            lines.push({
                product_name: name,
                grocy_recipe_id: row.dataset.recipeId ? parseInt(row.dataset.recipeId) : null,
                category: row.dataset.category || null,
                quantity: Number(row.querySelector('[data-f=qty]').value) || 1,
                unit: row.querySelector('[data-f=unit]').value || 'stk',
                unit_price: isProd ? 0 : fieldVal,
                cost_price: isProd ? fieldVal : (row.dataset.cost ? Number(row.dataset.cost) : null),
                co2e: row.dataset.co2e ? Number(row.dataset.co2e) : null,
                // Kun udgiftslinjer bærer moms-flag (uden moms = 0). Server tvinger
                // alle andre linjetyper til incl moms uanset.
                moms_included: momsSel ? Number(momsSel.value) : 1,
            });
        });
        if (lines.length === 0) throw new Error('Tilføj mindst én linje');
        const body = {
            role,
            delivery_date: document.getElementById('evm-date').value,
            internal_notes: document.getElementById('evm-note').value.trim() || null,
            lines,
        };
        // Salg/udgift på et event sælges til festivalpris (matcher pre-fill + priceMode).
        if (!isProd && !isExpense) body.price_category_code = 'festival';
        await _evFetch(`/events/${event.id}/bons`, { method: 'POST', body: JSON.stringify(body) });
        _evRender();
    });

    // Åbningstid for valgt dato (fra forecast-tabellens "Åbent"-kolonne)
    const ohMap = _evParseOpenHours(_evState.event || event);
    const ohEl = document.getElementById('evm-oh');
    const dateEl = document.getElementById('evm-date');
    const updateOh = () => {
        if (!ohEl || !dateEl) return;
        const t = ohMap[dateEl.value];
        ohEl.textContent = t ? `🕐 Åbent på pladsen denne dag: ${t}` : '';
        ohEl.style.display = t ? '' : 'none';
    };
    if (dateEl) { dateEl.addEventListener('change', updateOh); updateOh(); }

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
        const momsVal = String(data.momsIncluded ?? 0);
        tr.innerHTML = `
            <td><input type="text" data-f="name" value="${_evEsc(data.name || '')}" placeholder="Navn"></td>
            <td><input type="number" data-f="qty" value="${data.qty || 1}" min="1" step="1" style="width:60px"></td>
            <td><input type="text" data-f="unit" value="${_evEsc(data.unit || 'stk')}" style="width:50px"></td>
            <td><input type="number" data-f="price" value="${data.price ?? 0}" step="0.01" style="width:80px"></td>
            ${isExpense ? `<td><select data-f="moms" class="ev-moms-sel"><option value="0">uden moms</option><option value="1">med moms</option></select></td>` : ''}
            <td class="ev-num" data-f="total">—</td>
            <td><button type="button" class="ev-link" data-f="del">×</button></td>`;
        linesEl.appendChild(tr);
        const momsSel = tr.querySelector('[data-f=moms]');
        if (momsSel) {
            momsSel.value = momsVal;
            const syncMomsWarn = () => momsSel.classList.toggle('ev-moms-warn', momsSel.value === '0');
            momsSel.addEventListener('change', syncMomsWarn);
            syncMomsWarn();
        }
        const recalc = () => {
            const q = Number(tr.querySelector('[data-f=qty]').value) || 0;
            const p = Number(tr.querySelector('[data-f=price]').value) || 0;
            tr.querySelector('[data-f=total]').textContent = _evFmtKr(q * p);
            _evRecalcTargets();
        };
        tr.querySelector('[data-f=qty]').addEventListener('input', recalc);
        tr.querySelector('[data-f=price]').addEventListener('input', recalc);
        tr.querySelector('[data-f=del]').addEventListener('click', () => { tr.remove(); _evRecalcTargets(); });
        recalc();
    }

    function _evRecalcTargets() {
        // Tæl linjer pr. kategori i denne modal + læg allerede-prepped baseline til
        const sums = {};
        linesEl.querySelectorAll('tr[data-line]').forEach(row => {
            const cat = row.dataset.category;
            if (!cat) return;
            const q = Number(row.querySelector('[data-f=qty]').value) || 0;
            sums[cat] = (sums[cat] || 0) + q;
        });
        document.querySelectorAll('[data-target-current]').forEach(el => {
            const cat = el.dataset.targetCurrent;
            const pill = el.closest('.ev-target-pill');
            const base = pill ? (Number(pill.dataset.targetBase) || 0) : 0;
            const v = base + (sums[cat] || 0);
            el.textContent = v;
            if (pill) {
                const totalText = pill.querySelector('.ev-target-progress')?.textContent || '';
                const expected = parseInt(totalText.split('/').pop().trim(), 10) || 0;
                pill.classList.toggle('ev-target-met', v >= expected && expected > 0);
                pill.classList.toggle('ev-target-over', v > expected && expected > 0);
            }
        });
    }
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const opt = selectEl.options[selectEl.selectedIndex];
            if (!opt || !opt.value) return;
            if (isExpense) {
                // Udgifts-menuen bruges KUN til at fylde linjenavnet. Beløbet tastes
                // manuelt (pris=0) og moms vælges pr. linje (default uden moms). Vi
                // kobler bevidst IKKE recipe-id/kategori/cost/co2e på — en udgift må
                // ikke tælle som enheder eller bære menuens CO₂ ind i event-footprintet.
                addLine({ name: opt.text.split(' ·')[0], unit: opt.dataset.unit, price: 0, momsIncluded: 0, qty: 1 });
            } else {
                addLine({
                    recipeId: opt.value,
                    name: opt.text.split(' ·')[0],
                    category: opt.dataset.cat,
                    unit: opt.dataset.unit,
                    // Prod-modal viser kostprisen i pris-feltet (kolonne "Kostpris ex")
                    // — salgspris for produktion er pr. definition 0 og sættes ved submit.
                    price: Math.round((isProd ? Number(opt.dataset.cost) : Number(opt.dataset.price)) * 100) / 100,
                    cost: Number(opt.dataset.cost),
                    co2e: opt.dataset.co2e,
                    momsIncluded: 1,
                    qty: 1,
                });
            }
            selectEl.value = '';
        });
    }
    document.getElementById('evm-add-line').addEventListener('click', () => addLine({}));
    if (isExpense) addLine({ name: 'Udgift', price: 0, momsIncluded: 0 });

    // Salgsbon: fyld de pre-udfyldte menuer (fra prep-bonnerne) ind. Antal =
    // preppet (start-gæt, justeres ned for spild). Pris = festival-salgspris.
    if (role === 'sales' && salesPrefill && Array.isArray(salesPrefill.lines)) {
        for (const l of salesPrefill.lines) {
            addLine({
                recipeId: l.grocy_recipe_id || null,
                name:     l.product_name,
                category: l.category,
                unit:     l.unit,
                price:    l.unit_price,
                cost:     l.cost_price,
                co2e:     l.co2e,
                qty:      l.quantity,
            });
        }
    }

    // Top-up: §6-forslaget (forecast − beregnet rest) for valgt dato.
    // Pre-fylder linjerne med de allokerede produkter og viser kategori-tabel
    // + råvare-tjek (hent mere / rigeligt på pladsen). Dato-skift genberegner
    // og ERSTATTER linjerne (de er auto-genererede — manuelt arbejde lægges
    // ovenpå bagefter).
    async function loadTopupSuggestion(date) {
        const host = document.getElementById('evm-topup');
        if (!host) return;
        host.innerHTML = '<div class="ev-topup-loading">Beregner forslag — forecast minus rest på pladsen…</div>';
        try {
            const s = await _evFetch(`/events/${event.id}/topup-suggestion?date=${encodeURIComponent(date)}`);
            const fetchList   = (s.raw || []).filter(r => r.fetch > 0);
            const surplusList = (s.raw || []).filter(r => r.surplus > 0.01);
            host.innerHTML = `
                <div class="ev-topup-note">${s.sales_bon_count > 0
                    ? `Rest beregnet ud fra <strong>${s.sales_bon_count} registreret${s.sales_bon_count === 1 ? '' : 'e'} salgsbon${s.sales_bon_count === 1 ? '' : 'ner'}</strong>. Er aftensalget ikke tastet endnu, er resten sat for højt — justér forslaget op.`
                    : '⚠ <strong>Ingen salgsbons registreret endnu</strong> — beregningen antager at intet er solgt. Tjek pladsen og justér frit.'}</div>
                ${(s.categories || []).length ? `
                <table class="ev-topup-table">
                    <thead><tr><th>Kategori</th><th>Forecast</th><th>Preppet</th><th>Solgt</th><th>Rest</th><th>Forslag</th></tr></thead>
                    <tbody>${s.categories.map(c => `
                        <tr class="${c.suggestion > 0 ? 'ev-topup-need' : ''}">
                            <td>${_evEsc(c.category)}</td>
                            <td class="ev-num">${c.forecast}</td>
                            <td class="ev-num">${c.prepped}</td>
                            <td class="ev-num">${c.sold}</td>
                            <td class="ev-num">${c.rest}</td>
                            <td class="ev-num ev-topup-sug">${c.suggestion > 0 ? '+' + c.suggestion : '✓ dækket'}</td>
                        </tr>`).join('')}</tbody>
                </table>` : '<div class="ev-topup-empty">Intet forecast og intet preppet for denne dag — sæt forecast i tabellen på event-siden, eller tilføj linjer manuelt.</div>'}
                ${(s.warnings || []).map(w => `<div class="ev-topup-warn">⚠ ${_evEsc(w)}</div>`).join('')}
                ${(fetchList.length || surplusList.length) ? `
                <details class="ev-topup-raw">
                    <summary>📦 Råvare-tjek: ${fetchList.length ? `<strong>${fetchList.length} at hente</strong>` : 'intet at hente'} · ${surplusList.length} rigeligt på pladsen</summary>
                    ${fetchList.length ? `<div class="ev-topup-raw-grp">
                        <div class="ev-topup-raw-h">🛒 Hent mere fra HQ</div>
                        ${fetchList.map(r => `<div class="ev-topup-raw-row"><span>${_evEsc(r.product_name)}</span><span class="ev-num">${_evFmtNum(r.fetch)} ${_evEsc(r.unit)}</span></div>`).join('')}
                    </div>` : ''}
                    ${surplusList.length ? `<div class="ev-topup-raw-grp">
                        <div class="ev-topup-raw-h">✅ Rigeligt på pladsen — behøver ikke hentes</div>
                        ${surplusList.map(r => `<div class="ev-topup-raw-row ev-topup-dim"><span>${_evEsc(r.product_name)}</span><span class="ev-num">${_evFmtNum(r.surplus)} ${_evEsc(r.unit)}</span></div>`).join('')}
                    </div>` : ''}
                </details>` : ''}`;
            // Pre-fyld linjer med de allokerede produkter (erstatter auto-fill).
            linesEl.innerHTML = '';
            for (const p of (s.products || [])) {
                const rec = (_evRecipes || []).find(r => r.id === p.grocy_recipe_id);
                addLine({
                    recipeId: p.grocy_recipe_id || null,
                    name:     p.product_name,
                    category: p.category,
                    unit:     p.unit,
                    qty:      p.quantity,
                    // Prod-modal: pris-feltet ER kostprisen (kolonne "Kostpris ex").
                    price:    Math.round((rec?.cost_price ?? 0) * 100) / 100,
                    cost:     rec?.cost_price ?? 0,
                    co2e:     rec?.co2e ?? '',
                });
            }
        } catch (err) {
            host.innerHTML = `<div class="ev-topup-warn">Kunne ikke beregne forslag: ${_evEsc(err.message)}</div>`;
        }
    }
    if (isTopup) {
        loadTopupSuggestion(defaultDate);
        dateEl?.addEventListener('change', () => loadTopupSuggestion(dateEl.value));
    }
}

// ── "Find indbetaling": ukoblede bank-poster nær event-datoen → opret salgsbon ──

const _EV_CAT_LABEL = {
    event_cash: '🎪 event-kontant', invoice_check: '📄 faktura',
    large_check: '🔍 stort ukoblet', invoice_paid: 'afregnet', minor: 'småt',
};
async function _evOpenFindPayment(ev) {
    let data;
    try { data = await fetchCandidatesForEvent(ev.id); }
    catch (e) { alert('Kunne ikke hente indbetalinger: ' + e.message); return; }
    const rows = data.rows || [];
    const rowsHtml = rows.length
        ? rows.map(tx => `
            <div class="ev-fp-row">
                <div class="ev-fp-info">
                    <div class="ev-fp-tekst">${_evEsc(String(tx.tekst || '').slice(0, 42))} <span class="ev-fp-cat">${_EV_CAT_LABEL[tx.category] || ''}</span></div>
                    <div class="ev-fp-meta">${_evEsc(tx.dato)}</div>
                </div>
                <div class="ev-fp-kr">${_evFmtKr(tx.beloeb)}</div>
                <button type="button" class="ev-btn ev-btn-primary ev-fp-add" data-tx="${tx.id}" data-kr="${tx.beloeb}">Opret salgsbon</button>
            </div>`).join('')
        : `<div class="ev-fp-empty">Ingen ukoblede indbetalinger ±14 dage omkring ${_evEsc(ev.start_date)}.<br>Ligger afregningen længere væk, så søg den frem i Pengestrøm.</div>`;
    const overlay = document.createElement('div');
    overlay.className = 'ev-modal-overlay';
    overlay.innerHTML = `
        <div class="ev-modal" role="dialog">
            <div class="ev-fp-head">🔍 Find indbetaling — ${_evEsc(ev.name)}</div>
            <div class="ev-fp-sub">Ukoblede bank-indbetalinger nær event-datoen. "Opret salgsbon" laver en BETALT salgsbon på eventet og kobler beløbet (festivalpris). Justér linjer/gebyr bagefter i Pengestrøm hvis du vil dele brutto + afgift.</div>
            <div class="ev-fp-list">${rowsHtml}</div>
            <div class="ev-modal-error" style="display:none"></div>
            <div class="ev-modal-actions"><button type="button" class="ev-btn ev-btn-ghost" data-act="close">Luk</button></div>
        </div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    const cleanup = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act=close]').addEventListener('click', cleanup);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
    const errEl = overlay.querySelector('.ev-modal-error');
    overlay.querySelectorAll('.ev-fp-add').forEach(btn => {
        btn.addEventListener('click', async () => {
            const txId = parseInt(btn.getAttribute('data-tx'), 10);
            const kr = Number(btn.getAttribute('data-kr'));
            btn.disabled = true; btn.textContent = 'Opretter…'; errEl.style.display = 'none';
            try {
                await createBonFromCfTx({ transaction_id: txId, event_id: ev.id, payment_type: 'card',
                    lines: [{ name: 'Direkte salg', amount: kr, quantity: 1, category: 'Event-salg' }] });
                cleanup();
                _evRenderDetail(ev.id);   // refresh — eventet viser nu omsætning + bank-afstemt
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Opret salgsbon';
                errEl.style.display = ''; errEl.textContent = e.message || String(e);
            }
        });
    });
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
