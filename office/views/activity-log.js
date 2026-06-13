/**
 * office/views/activity-log.js
 * ════════════════════════════════════════════════════════════
 * "Log" — kronologisk aktivitetslog under Bons.
 *
 * Viser to slags hændelser fra changelog, nyeste først:
 *   • 📥 Web-bestilling   — en bestilling lagt via bestillingssiden
 *   • 🔄 Statusskift      — NY → IGANG → KLAR → LEVERET … (hvem, hvornår)
 *
 * Data: GET /api/bons/log  (routes/kitchen.js)
 *
 * API:
 *   initActivityLog(containerEl, opts)   — opts.openDrawer(bonId)
 *   cleanupActivityLog()
 *   _alHandleSSE(eventType, data)
 * ════════════════════════════════════════════════════════════
 */

/* eslint-disable no-unused-vars */

let _alContainer = null;
let _alOpts = {};
let _alActive = false;
let _alRows = [];
let _alType = 'all';        // all | orders | status
let _alQuery = '';
let _alOffset = 0;
let _alHasMore = false;
let _alLoading = false;
let _alSseTimer = null;
const _AL_PAGE = 80;

const _AL_DAYS = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
const _AL_MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function _alEscape(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// SQLite CURRENT_TIMESTAMP er UTC — pars som UTC og vis i lokal tid.
function _alParseDate(ts) {
    if (!ts) return null;
    return new Date(ts.replace(' ', 'T') + 'Z');
}

function _alDayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _alDayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'I dag';
    if (diff === 1) return 'I går';
    return `${_AL_DAYS[d.getDay()]} ${d.getDate()}. ${_AL_MONTHS[d.getMonth()]}${that.getFullYear() !== today.getFullYear() ? ' ' + that.getFullYear() : ''}`;
}

function _alTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Status-kode → farvet pille via BON_CONFIG (samme kilde som bon-kort/kalender)
function _alStatusPill(code) {
    if (!code) return '<span class="al-pill al-pill-muted">—</span>';
    const fe = (typeof statusToFrontend === 'function') ? statusToFrontend(code) : '';
    const cfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses) ? BON_CONFIG.statuses[fe] : null;
    const label = cfg ? cfg.label : code;
    const style = cfg ? `background:${cfg.color};color:${cfg.text || '#fff'}` : '';
    return `<span class="al-pill" style="${style}">${_alEscape(label)}</span>`;
}

// ─── Init / Cleanup ─────────────────────────────────────────

function initActivityLog(containerEl, opts = {}) {
    _alContainer = containerEl;
    _alOpts = opts;
    _alActive = true;
    _alType = 'all';
    _alQuery = '';
    _alOffset = 0;
    _alRows = [];

    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Log';

    _alRenderShell();
    _alLoad(true);
}

function cleanupActivityLog() {
    _alActive = false;
    if (_alSseTimer) { clearTimeout(_alSseTimer); _alSseTimer = null; }
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Bon v2 — Office';
}

// ─── Shell ──────────────────────────────────────────────────

function _alRenderShell() {
    _alContainer.innerHTML = `
        <style>
            .al-wrap { padding: 0; max-width: 880px; margin: 0 auto; }
            .al-toolbar {
                display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
                padding: 14px 20px 12px; border-bottom: 1px solid var(--color-border, #d7d1ca);
                position: sticky; top: 0; background: var(--color-background, #f5f4f2); z-index: 5;
            }
            .al-filters { display: flex; gap: 4px; }
            .al-filter {
                padding: 6px 14px; border-radius: 16px; border: 1px solid var(--color-border, #d7d1ca);
                background: #fff; cursor: pointer; font-size: 13px; font-weight: 600;
                color: var(--color-text-dim, #888);
            }
            .al-filter.active {
                background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary, #8e631f);
            }
            .al-search {
                margin-left: auto; padding: 6px 12px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca); font-size: 13px; width: 160px;
            }
            .al-list { padding: 8px 20px 40px; }
            .al-day-head {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 14px; font-weight: 700; color: var(--color-text-dim, #888);
                text-transform: uppercase; letter-spacing: .4px;
                margin: 20px 0 8px; padding-bottom: 4px;
                border-bottom: 1px solid var(--color-border-light, #ebe7e2);
            }
            .al-day-head:first-child { margin-top: 4px; }
            .al-row {
                display: grid; grid-template-columns: 52px 1fr auto; gap: 12px;
                align-items: baseline; padding: 9px 6px; border-radius: 6px;
            }
            .al-row:hover { background: var(--color-surface, #fff); }
            .al-time { font-size: 12px; color: var(--color-text-dim, #888); font-variant-numeric: tabular-nums; }
            .al-body { min-width: 0; font-size: 14px; line-height: 1.5; }
            .al-kind {
                display: inline-flex; align-items: center; gap: 5px;
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px;
                padding: 1px 7px; border-radius: 4px; margin-right: 8px; white-space: nowrap;
            }
            .al-kind-order  { background: #fbeede; color: #9a5b12; }
            .al-kind-status { background: #e7eef5; color: #3b6491; }
            .al-bon-link {
                font-weight: 700; color: var(--brand-primary, #8e631f); cursor: pointer;
                text-decoration: none;
            }
            .al-bon-link:hover { text-decoration: underline; }
            .al-customer { color: var(--color-text, #333); }
            .al-arrow { color: var(--color-text-dim, #aaa); margin: 0 5px; }
            .al-pill {
                display: inline-block; padding: 1px 8px; border-radius: 10px;
                font-size: 11px; font-weight: 700; background: var(--color-background, #f5f4f2);
                color: var(--color-text-dim, #777);
            }
            .al-pill-muted { background: var(--color-background, #f5f4f2); color: var(--color-text-dim, #aaa); }
            .al-who { font-size: 12px; color: var(--color-text-dim, #999); white-space: nowrap; text-align: right; }
            .al-empty { text-align: center; padding: 60px 20px; color: var(--color-text-dim, #888); font-size: 15px; }
            .al-empty-emoji { font-size: 42px; margin-bottom: 8px; }
            .al-loading { text-align: center; padding: 40px; color: var(--color-text-dim, #888); }
            .al-more {
                display: block; margin: 20px auto 0; padding: 9px 24px; border-radius: 8px;
                border: 1px solid var(--color-border, #d7d1ca); background: #fff; cursor: pointer;
                font-size: 13px; font-weight: 600; color: var(--color-text, #333);
            }
            .al-more:hover { background: var(--color-surface, #fff); }
        </style>
        <div class="al-wrap">
            <div class="al-toolbar">
                <div class="al-filters">
                    <button class="al-filter active" data-type="all">Alt</button>
                    <button class="al-filter" data-type="orders">📥 Bestillinger</button>
                    <button class="al-filter" data-type="status">🔄 Statusskift</button>
                </div>
                <input class="al-search" id="al-search" type="search" placeholder="Søg bon-nummer…" />
            </div>
            <div class="al-list" id="al-list">
                <div class="al-loading">Henter…</div>
            </div>
        </div>
    `;

    _alContainer.querySelectorAll('.al-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            if (_alType === btn.dataset.type) return;
            _alType = btn.dataset.type;
            _alContainer.querySelectorAll('.al-filter').forEach(b => b.classList.toggle('active', b === btn));
            _alLoad(true);
        });
    });

    const search = _alContainer.querySelector('#al-search');
    let searchTimer = null;
    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            _alQuery = search.value.trim();
            _alLoad(true);
        }, 300);
    });
}

// ─── Data ───────────────────────────────────────────────────

async function _alLoad(reset) {
    if (!_alActive || _alLoading) return;
    _alLoading = true;
    if (reset) { _alOffset = 0; _alRows = []; }

    try {
        const data = await fetchActivityLog({
            type: _alType,
            q: _alQuery,
            limit: _AL_PAGE,
            offset: _alOffset
        });
        if (!_alActive) return;
        _alRows = reset ? data.rows : _alRows.concat(data.rows);
        _alHasMore = data.has_more;
        _alOffset = _alRows.length;
    } catch (err) {
        console.error('[activity-log] Fejl:', err);
        if (reset) _alRows = [];
    } finally {
        _alLoading = false;
    }
    if (_alActive) _alRender();
}

function _alRender() {
    const list = document.getElementById('al-list');
    if (!list) return;

    if (_alRows.length === 0) {
        list.innerHTML = `
            <div class="al-empty">
                <div class="al-empty-emoji">🗒️</div>
                <div>Ingen hændelser endnu</div>
            </div>`;
        return;
    }

    let html = '';
    let lastDay = null;
    for (const r of _alRows) {
        const d = _alParseDate(r.created_at);
        if (!d) continue;
        const key = _alDayKey(d);
        if (key !== lastDay) {
            html += `<div class="al-day-head">${_alEscape(_alDayLabel(d))}</div>`;
            lastDay = key;
        }
        html += _alRenderRow(r, d);
    }

    if (_alHasMore) {
        html += `<button class="al-more" id="al-more">Indlæs flere</button>`;
    }
    list.innerHTML = html;

    const moreBtn = document.getElementById('al-more');
    if (moreBtn) moreBtn.addEventListener('click', () => { moreBtn.textContent = 'Henter…'; _alLoad(false); });
}

function _alRenderRow(r, d) {
    const isOrder = r.action === 'create';
    const bonLabel = r.bon_number ? `#${_alEscape(r.bon_number)}` : `#${r.bon_id}`;
    const cust = _alEscape(r.customer_name || '—');
    const who = r.user_name ? _alEscape(r.user_name) : (isOrder ? 'web' : 'system');

    let kind, detail;
    if (isOrder) {
        kind = `<span class="al-kind al-kind-order">📥 Bestilling</span>`;
        detail = `Ny web-bestilling — <span class="al-customer">${cust}</span>`;
    } else {
        kind = `<span class="al-kind al-kind-status">🔄 Status</span>`;
        detail = `${_alStatusPill(r.old_value)}<span class="al-arrow">→</span>${_alStatusPill(r.new_value)} <span class="al-customer">${cust}</span>`;
    }

    return `
        <div class="al-row">
            <div class="al-time">${_alTime(d)}</div>
            <div class="al-body">
                ${kind}
                <a class="al-bon-link" onclick="_alOpen(${r.bon_id})">${bonLabel}</a>
                ${detail}
            </div>
            <div class="al-who">${who}</div>
        </div>`;
}

// ─── Handlers (globalt scope så onclick virker) ─────────────

function _alOpen(bonId) {
    if (_alOpts.openDrawer) _alOpts.openDrawer(bonId);
}

// ─── SSE ────────────────────────────────────────────────────

function _alHandleSSE(eventType, data) {
    if (!_alActive) return;
    // Ny bestilling eller statusskift → genindlæs første side (debounced).
    if (eventType === 'bon_created' || eventType === 'bon_status') {
        if (_alSseTimer) clearTimeout(_alSseTimer);
        _alSseTimer = setTimeout(() => _alLoad(true), 600);
    }
}
