/**
 * office/views/crm-dashboard.js
 * ════════════════════════════════════════════════════════════
 * CRM Dashboard — briefing, stats, suggestions, service calls
 * ════════════════════════════════════════════════════════════
 */

let _crmContainer = null;
let _crmOpts = {};
let _crmActive = false;

function initCrmDashboard(containerEl, opts) {
    _crmContainer = containerEl;
    _crmOpts = opts || {};
    _crmActive = true;
    _crmRenderShell();
    _crmLoadData();
}

function cleanupCrmDashboard() {
    _crmActive = false;
    _crmContainer = null;
    const topRight = document.getElementById('office-topbar-right');
    if (topRight) topRight.innerHTML = '';
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Bon v2 — Office';
}

// ─── Shell ──────────────────────────────────────────────────

function _crmRenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'CRM';

    _crmContainer.innerHTML = `
        <style>
            .crm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0; }
            @media (max-width: 800px) { .crm-grid { grid-template-columns: 1fr; } }

            .crm-kpi-strip { grid-column: 1 / -1; display: flex; gap: 9px; flex-wrap: wrap; }
            .crm-kpi {
                flex: 1; min-width: 130px;
                background: var(--color-surface, #fff);
                border-radius: 10px; padding: 14px 16px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
            }
            .crm-kpi-value {
                font-size: 28px; font-weight: 900; line-height: 1.1;
                color: var(--brand-primary, #8e631f);
                font-variant-numeric: tabular-nums;
            }
            .crm-kpi-value.warn { color: #c94040; }
            .crm-kpi-label {
                font-size: 10px; font-weight: 700; color: var(--color-text-dim, #888);
                text-transform: uppercase; letter-spacing: .4px; margin-top: 2px;
            }

            .crm-card {
                background: var(--color-surface, #fff);
                border-radius: 10px; padding: 18px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
            }
            .crm-card h3 {
                font-size: 13px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .4px; color: var(--color-text-dim, #888);
                margin: 0 0 12px 0;
            }

            .crm-briefing-item {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 0; border-bottom: 1px solid var(--color-border, #eee);
                font-size: 13px; cursor: pointer;
            }
            .crm-briefing-item:last-child { border-bottom: none; }
            .crm-briefing-item:hover { color: var(--brand-primary, #8e631f); }
            .crm-briefing-icon { font-size: 18px; flex-shrink: 0; }
            .crm-briefing-type {
                display: inline-block; padding: 1px 6px; border-radius: 4px;
                font-size: 10px; font-weight: 700; margin-left: auto; flex-shrink: 0;
            }
            .crm-briefing-type.action { background: #fde8e8; color: #c94040; }
            .crm-briefing-type.urgent { background: #fde8e8; color: #c94040; }
            .crm-briefing-type.insight { background: #e8f2dc; color: #3d7a0a; }
            .crm-briefing-type.progress { background: #e0ecf5; color: #2a6fb0; }
            .crm-briefing-type.motivation { background: #f5f0e0; color: #8e631f; }

            .crm-suggestion {
                padding: 12px; margin-bottom: 8px; border-radius: 8px;
                border: 1px solid var(--color-border, #eee);
                cursor: pointer; transition: border-color .15s;
            }
            .crm-suggestion:hover { border-color: var(--brand-primary, #8e631f); }
            .crm-sug-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
            .crm-sug-icon { font-size: 16px; }
            .crm-sug-title { font-size: 14px; font-weight: 600; }
            .crm-sug-detail { font-size: 12px; color: var(--color-text-dim, #888); }
            .crm-sug-reason { font-size: 11px; color: var(--color-text-dim, #aaa); margin-top: 4px; }
            .crm-sug-actions { display: flex; gap: 6px; margin-top: 8px; }
            .crm-sug-btn {
                padding: 4px 12px; border-radius: 6px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 12px; cursor: pointer;
            }
            .crm-sug-btn:hover { background: var(--brand-primary-light, #f1e6b2); }
            .crm-sug-btn.primary {
                background: var(--brand-primary, #8e631f); color: white; border-color: transparent;
            }

            .crm-svc-row {
                display: grid; grid-template-columns: auto 1fr auto auto;
                gap: 8px; align-items: center;
                padding: 8px 0; border-bottom: 1px solid var(--color-border, #eee);
                font-size: 13px;
            }
            .crm-svc-row:last-child { border-bottom: none; }
            .crm-svc-bon { font-weight: 600; color: var(--brand-primary, #8e631f); }
            .crm-svc-customer { cursor: pointer; }
            .crm-svc-customer:hover { text-decoration: underline; }
            .crm-svc-days { font-size: 11px; color: var(--color-text-dim, #888); text-align: right; }
            .crm-svc-phone { font-size: 12px; color: var(--color-text-dim, #888); }

            .crm-empty { text-align: center; padding: 20px; color: var(--color-text-dim, #aaa); font-size: 13px; }
        </style>

        <div class="crm-grid">
            <div class="crm-kpi-strip" id="crmKpiStrip"></div>

            <div class="crm-card" id="crmBriefing">
                <h3>Daglig briefing</h3>
                <div id="crmBriefingList"></div>
            </div>

            <div class="crm-card" id="crmSuggestions">
                <h3>Smart forslag</h3>
                <div id="crmSuggestionsList"></div>
            </div>

            <div class="crm-card" style="grid-column: 1 / -1;" id="crmServiceCalls">
                <h3>Service-kald ventende</h3>
                <div id="crmServiceCallsList"></div>
            </div>
        </div>
    `;
}

// ─── Data loading ───────────────────────────────────────────

async function _crmLoadData() {
    if (!_crmActive) return;

    try {
        const [stats, briefing, suggestions, serviceCalls] = await Promise.all([
            fetchCrmStats(),
            fetchCrmBriefing(),
            fetchCrmSuggestions(),
            fetchCrmServiceCalls(7),
        ]);

        _crmRenderKPIs(stats);
        _crmRenderBriefing(briefing);
        _crmRenderSuggestions(suggestions);
        _crmRenderServiceCalls(serviceCalls);
    } catch (err) {
        console.error('[crm] Load error:', err);
        if (!_crmActive) return;
        const grid = _crmContainer && _crmContainer.querySelector('.crm-grid');
        if (grid) {
            grid.innerHTML = '<div class="crm-empty" style="grid-column:1/-1;padding:40px;">' +
                '<p style="font-size:16px;margin-bottom:8px;">Kunne ikke hente CRM-data</p>' +
                '<p style="font-size:12px;">' + (err.message || 'Ukendt fejl') + '</p>' +
                '<button onclick="_crmLoadData()" style="margin-top:12px;padding:6px 16px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-surface);cursor:pointer;">Prøv igen</button>' +
                '</div>';
        }
    }
}

// ─── Render functions ───────────────────────────────────────

function _crmRenderKPIs(stats) {
    const el = document.getElementById('crmKpiStrip');
    if (!el) return;

    const kpis = [
        { label: 'Service-kald', value: stats.service_calls_pending, warn: stats.service_calls_pending > 0 },
        { label: 'Callbacks', value: stats.callbacks_pending, warn: stats.callbacks_pending > 0 },
        { label: 'Svær at nå', value: stats.hard_to_reach, warn: stats.hard_to_reach > 0 },
        { label: 'Reach rate', value: stats.reach_rate + '%', warn: false },
        { label: 'Bons i dag', value: stats.bons_today, warn: false },
    ];

    el.innerHTML = kpis.map(k =>
        '<div class="crm-kpi">' +
            '<div class="crm-kpi-value' + (k.warn ? ' warn' : '') + '">' + k.value + '</div>' +
            '<div class="crm-kpi-label">' + k.label + '</div>' +
        '</div>'
    ).join('');
}

function _crmRenderBriefing(items) {
    const el = document.getElementById('crmBriefingList');
    if (!el) return;

    if (!items.length) {
        el.innerHTML = '<div class="crm-empty">Ingen briefing-punkter i dag</div>';
        return;
    }

    el.innerHTML = items.map(item =>
        '<div class="crm-briefing-item">' +
            '<span class="crm-briefing-icon">' + item.icon + '</span>' +
            '<span>' + item.text + '</span>' +
            '<span class="crm-briefing-type ' + item.type + '">' + item.type + '</span>' +
        '</div>'
    ).join('');
}

function _crmRenderSuggestions(suggestions) {
    const el = document.getElementById('crmSuggestionsList');
    if (!el) return;

    if (!suggestions.length) {
        el.innerHTML = '<div class="crm-empty">Ingen forslag lige nu — godt arbejde!</div>';
        return;
    }

    el.innerHTML = suggestions.slice(0, 8).map(s =>
        '<div class="crm-suggestion" data-customer-id="' + s.customer_id + '">' +
            '<div class="crm-sug-header">' +
                '<span class="crm-sug-icon">' + s.icon + '</span>' +
                '<span class="crm-sug-title">' + s.title + '</span>' +
            '</div>' +
            '<div class="crm-sug-detail">' + s.detail + '</div>' +
            '<div class="crm-sug-reason">' + s.reason + '</div>' +
            '<div class="crm-sug-actions">' +
                (s.phone ? '<a class="crm-sug-btn primary" href="tel:' + s.phone.replace(/\s/g, '') + '">📞 Ring</a>' : '') +
                '<button class="crm-sug-btn" onclick="_crmOpenKunde(' + s.customer_id + ')">👤 Profil</button>' +
            '</div>' +
        '</div>'
    ).join('');
}

function _crmRenderServiceCalls(calls) {
    const el = document.getElementById('crmServiceCallsList');
    if (!el) return;

    if (!calls.length) {
        el.innerHTML = '<div class="crm-empty">Ingen ventende service-kald</div>';
        return;
    }

    el.innerHTML = calls.map(c =>
        '<div class="crm-svc-row">' +
            '<span class="crm-svc-bon">#' + c.bon_number + '</span>' +
            '<span class="crm-svc-customer" onclick="_crmOpenKunde(' + c.customer_id + ')">' +
                c.customer_name + (c.company_name ? ' · ' + c.company_name : '') +
            '</span>' +
            '<span class="crm-svc-phone">' + (c.customer_phone || '') + '</span>' +
            '<span class="crm-svc-days">' + c.days_since_delivery + 'd siden</span>' +
        '</div>'
    ).join('');
}

// ─── Navigation helpers ─────────────────────────────────────

function _crmOpenKunde(customerId) {
    if (_crmOpts.openKunde360) {
        _crmOpts.openKunde360(customerId);
    }
}

// ─── SSE handler ────────────────────────────────────────────

function _crmDashHandleSSE(eventType, data) {
    if (!_crmActive) return;
    if (eventType === 'crm_activity_created') {
        _crmLoadData();
    }
}
