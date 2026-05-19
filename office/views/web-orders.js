/**
 * office/views/web-orders.js
 * ════════════════════════════════════════════════════════════
 * "Nye bestillinger" — dedikeret listview for web-bestillinger
 * der endnu ikke er bekræftet af et menneske (#042).
 *
 * Adresserer problemet at en bestilling til august, modtaget i
 * maj, teknisk ligger i databasen men praktisk er usynlig fordi
 * today/later/dashboard filtrerer på delivery_date.
 *
 * Bekræftelse er adskilt fra status-flow: en bon kan godt være
 * NY men acknowledged_at != NULL = "vi har set den".
 *
 * API:
 *   initWebOrders(containerEl, opts)
 *   cleanupWebOrders()
 *   _woHandleSSE(eventType, data)
 * ════════════════════════════════════════════════════════════
 */

/* eslint-disable no-unused-vars */

let _woContainer = null;
let _woOpts = {};
let _woActive = false;
let _woData = [];

const _WO_DAY_NAMES = ['Søn','Man','Tir','Ons','Tor','Fre','Lør'];
const _WO_MONTH_NAMES = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];

function _woFmtDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T12:00:00');
    return `${_WO_DAY_NAMES[d.getDay()]} ${d.getDate()}. ${_WO_MONTH_NAMES[d.getMonth()]}`;
}

function _woDaysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    return Math.round((d - today) / 86400000);
}

function _woFmtAge(createdAt) {
    if (!createdAt) return '';
    // Pars som UTC for at undgå at SQLite's lokale CURRENT_TIMESTAMP
    // bliver tolket som lokal-tid i klienter med anderledes timezone.
    const created = new Date(createdAt.replace(' ', 'T') + 'Z');
    const mins = Math.round((Date.now() - created.getTime()) / 60000);
    if (mins < 1) return 'lige nu';
    if (mins < 60) return `${mins} min siden`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} time${hrs === 1 ? '' : 'r'} siden`;
    const days = Math.round(hrs / 24);
    return `${days} dag${days === 1 ? '' : 'e'} siden`;
}

function _woEscape(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ─── Init / Cleanup ─────────────────────────────────────────

function initWebOrders(containerEl, opts = {}) {
    _woContainer = containerEl;
    _woOpts = opts;
    _woActive = true;

    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Nye bestillinger';

    _woRenderShell();
    _woLoadData();
}

function cleanupWebOrders() {
    _woActive = false;
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Bon v2 — Office';
}

// ─── Shell ──────────────────────────────────────────────────

function _woRenderShell() {
    _woContainer.innerHTML = `
        <style>
            .wo-wrap { padding: 0; max-width: 1100px; margin: 0 auto; }
            .wo-header {
                display: flex; align-items: baseline; justify-content: space-between;
                padding: 16px 20px 12px; border-bottom: 1px solid var(--color-border, #d7d1ca);
                margin-bottom: 16px;
            }
            .wo-header-text { font-family: var(--font-body, 'DM Sans', system-ui, sans-serif); font-size: 13px; color: var(--color-text-dim, #888); }
            .wo-count {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 32px; font-weight: 700; color: #a82828;
                font-variant-numeric: tabular-nums;
            }
            .wo-count.zero { color: #6a9050; }
            .wo-list { padding: 0 20px 40px; display: flex; flex-direction: column; gap: 10px; }
            .wo-card {
                background: var(--color-surface, #fff);
                border: 1px solid var(--color-border, #d7d1ca);
                border-left: 4px solid #a82828;
                border-radius: 8px;
                padding: 14px 16px;
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 12px;
                align-items: start;
            }
            .wo-card.removing { opacity: 0; transform: translateX(40px); transition: opacity .35s, transform .35s; }
            .wo-card-main { min-width: 0; }
            .wo-card-head {
                display: flex; align-items: baseline; gap: 10px;
                margin-bottom: 4px; flex-wrap: wrap;
            }
            .wo-bon-num {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 18px; font-weight: 700; color: var(--brand-primary, #8e631f);
            }
            .wo-customer { font-size: 15px; font-weight: 600; }
            .wo-status-pill {
                display: inline-block; padding: 2px 8px; border-radius: 10px;
                font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px;
                background: var(--color-background, #f5f4f2);
                color: var(--color-text-dim, #888);
            }
            .wo-meta {
                display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px;
                color: var(--color-text, #333); margin-top: 6px;
            }
            .wo-meta-item { display: inline-flex; align-items: center; gap: 5px; }
            .wo-meta-lbl { color: var(--color-text-dim, #888); font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
            .wo-days-far  { color: #4880b8; font-weight: 600; }
            .wo-days-soon { color: #c08020; font-weight: 600; }
            .wo-days-past { color: #a82828; font-weight: 600; }
            .wo-wishes {
                margin-top: 8px; padding: 8px 10px;
                background: #fffaed; border: 1px solid #f0e4b0;
                border-radius: 5px; font-size: 12px; color: #6a5400;
                white-space: pre-wrap; word-break: break-word;
                max-height: 4.5em; overflow: hidden; position: relative;
            }
            .wo-card-foot {
                grid-column: 1 / -1;
                display: flex; gap: 10px; align-items: center;
                margin-top: 8px; padding-top: 8px;
                border-top: 1px dashed var(--color-border-light, #ebe7e2);
                font-size: 11px; color: var(--color-text-dim, #888);
            }
            .wo-card-foot-right { margin-left: auto; display: flex; gap: 8px; }
            .wo-btn {
                padding: 6px 14px; border-radius: 6px; border: 1px solid var(--color-border, #d7d1ca);
                background: #fff; cursor: pointer; font-size: 13px; font-weight: 600;
                color: var(--color-text, #333);
            }
            .wo-btn:hover { background: var(--color-background, #f5f4f2); }
            .wo-btn-primary {
                background: var(--brand-primary, #8e631f); color: #fff; border-color: var(--brand-primary, #8e631f);
            }
            .wo-btn-primary:hover { background: #6f4d18; }
            .wo-empty {
                text-align: center; padding: 60px 20px;
                color: var(--color-text-dim, #888); font-size: 15px;
            }
            .wo-empty-emoji { font-size: 42px; margin-bottom: 8px; }
            .wo-loading { text-align: center; padding: 40px; color: var(--color-text-dim, #888); }
        </style>
        <div class="wo-wrap">
            <div class="wo-header">
                <div>
                    <div class="wo-count" id="wo-count">…</div>
                    <div class="wo-header-text">ubekræftede web-bestillinger</div>
                </div>
                <div class="wo-header-text">Klik <strong>Bekræft modtaget</strong> når du har set bestillingen — den fjernes fra listen uden at status ændres.</div>
            </div>
            <div class="wo-list" id="wo-list">
                <div class="wo-loading">Henter…</div>
            </div>
        </div>
    `;
}

// ─── Data + render ──────────────────────────────────────────

async function _woLoadData() {
    if (!_woActive) return;
    try {
        _woData = await fetchPendingWebOrders();
    } catch (err) {
        console.error('[web-orders] Fejl:', err);
        _woData = [];
    }
    if (!_woActive) return;
    _woRender();
}

function _woRender() {
    const list = document.getElementById('wo-list');
    const countEl = document.getElementById('wo-count');
    if (!list || !countEl) return;

    countEl.textContent = _woData.length;
    countEl.classList.toggle('zero', _woData.length === 0);

    if (_woData.length === 0) {
        list.innerHTML = `
            <div class="wo-empty">
                <div class="wo-empty-emoji">🎉</div>
                <div>Ingen ubekræftede bestillinger</div>
            </div>
        `;
        return;
    }

    list.innerHTML = _woData.map(_woRenderCard).join('');
}

function _woRenderCard(b) {
    const daysUntil = _woDaysUntil(b.delivery_date);
    let daysClass = 'wo-days-soon';
    let daysText  = '';
    if (daysUntil != null) {
        if (daysUntil < 0)        { daysClass = 'wo-days-past'; daysText = `for ${-daysUntil} dag${daysUntil === -1 ? '' : 'e'} siden`; }
        else if (daysUntil === 0) { daysClass = 'wo-days-soon'; daysText = 'i dag'; }
        else if (daysUntil === 1) { daysClass = 'wo-days-soon'; daysText = 'i morgen'; }
        else if (daysUntil < 14)  { daysClass = 'wo-days-soon'; daysText = `om ${daysUntil} dage`; }
        else                      { daysClass = 'wo-days-far';  daysText = `om ${daysUntil} dage`; }
    }
    const time = b.delivery_time ? b.delivery_time.slice(0, 5) : '—';
    const orderTypeLbl = b.order_type === 'pickup' ? '🏠 Afhentning' : '🚚 Levering';

    const companyLine = b.company_name
        ? `<span class="wo-meta-item">🏢 ${_woEscape(b.company_name)}</span>`
        : '';
    const addressLine = (b.address_text && b.delivery_type !== 'pickup')
        ? `<span class="wo-meta-item">📍 ${_woEscape(b.address_text)}${b.postal_code ? `, ${_woEscape(b.postal_code)} ${_woEscape(b.city || '')}` : ''}</span>`
        : '';
    const wishesBlock = b.customer_wishes
        ? `<div class="wo-wishes">${_woEscape(b.customer_wishes)}</div>`
        : '';

    const _feStatus = (typeof statusToFrontend === 'function') ? statusToFrontend(b.status_code) : '';
    const _statusCfg = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses) ? BON_CONFIG.statuses[_feStatus] : null;
    const statusPillStyle = _statusCfg
        ? `background:${_statusCfg.color};color:${_statusCfg.text || '#fff'}`
        : (b.status_color ? `background:${_woEscape(b.status_color)};color:#fff` : '');
    const statusLabel = _statusCfg ? _statusCfg.label : (b.status_label || b.status_code || '');

    return `
        <div class="wo-card" data-bon-id="${b.bon_id}">
            <div class="wo-card-main">
                <div class="wo-card-head">
                    <span class="wo-bon-num">#${_woEscape(b.bon_number)}</span>
                    <span class="wo-customer">${_woEscape(b.customer_name)}</span>
                    <span class="wo-status-pill" style="${statusPillStyle}">${_woEscape(statusLabel)}</span>
                </div>
                <div class="wo-meta">
                    <span class="wo-meta-item">📅 ${_woFmtDate(b.delivery_date)} kl. ${time} <span class="${daysClass}">(${_woEscape(daysText)})</span></span>
                    <span class="wo-meta-item">${orderTypeLbl}</span>
                    ${b.pax ? `<span class="wo-meta-item">👥 ${b.pax} pax</span>` : ''}
                    ${b.customer_email ? `<span class="wo-meta-item">✉️ <a href="mailto:${_woEscape(b.customer_email)}">${_woEscape(b.customer_email)}</a></span>` : ''}
                    ${b.customer_phone ? `<span class="wo-meta-item">📞 <a href="tel:${_woEscape(b.customer_phone)}">${_woEscape(b.customer_phone)}</a></span>` : ''}
                    ${companyLine}
                </div>
                ${addressLine ? `<div class="wo-meta">${addressLine}</div>` : ''}
                ${wishesBlock}
            </div>
            <div></div>
            <div class="wo-card-foot">
                <span>Modtaget ${_woFmtAge(b.created_at)}</span>
                <div class="wo-card-foot-right">
                    <button class="wo-btn" onclick="_woOpenDrawer(${b.bon_id})">Åbn</button>
                    <button class="wo-btn wo-btn-primary" onclick="_woAcknowledge(${b.bon_id}, this)">✓ Bekræft modtaget</button>
                </div>
            </div>
        </div>
    `;
}

// ─── Handlers (globalt scope så onclick virker) ─────────────

function _woOpenDrawer(bonId) {
    if (_woOpts.openDrawer) _woOpts.openDrawer(bonId);
}

async function _woAcknowledge(bonId, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
        await acknowledgeBon(bonId);
        const card = document.querySelector(`.wo-card[data-bon-id="${bonId}"]`);
        if (card) {
            card.classList.add('removing');
            setTimeout(() => {
                _woData = _woData.filter(b => b.bon_id !== bonId);
                _woRender();
                _woTriggerBadgeUpdate();
            }, 350);
        }
    } catch (err) {
        console.error('[web-orders] Acknowledge fejlede:', err);
        btn.disabled = false;
        btn.textContent = '✓ Bekræft modtaget';
        alert('Kunne ikke bekræfte: ' + err.message);
    }
}

function _woTriggerBadgeUpdate() {
    // Lader index.html opdatere sidebar-badge (registreret som global)
    if (typeof window.updateWebOrdersBadge === 'function') {
        window.updateWebOrdersBadge();
    }
}

// ─── SSE handler ────────────────────────────────────────────

function _woHandleSSE(eventType, data) {
    if (!_woActive) return;
    if (eventType === 'bon_created' || eventType === 'bon_updated') {
        _woLoadData();
    }
}
