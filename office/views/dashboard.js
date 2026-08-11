/**
 * office/views/dashboard.js
 * ════════════════════════════════════════════════════════════
 * Office Dashboard view — Fase 3B redesign.
 *
 * API:
 *   initOfficeDashboard(containerEl, opts)
 *   cleanupOfficeDashboard()
 *   _dashHandleSSE(eventType, data)
 * ════════════════════════════════════════════════════════════
 */

/* eslint-disable no-unused-vars */

let _dashContainer = null;
let _dashOpts = {};
let _dashActive = false;
let _dashTopProducts = [];
// "Øvrigt": emballage, drikke, kager. Hentes først når brugeren folder ud —
// null = ikke hentet, [] = hentet og tomt.
let _dashOtherProducts = null;
let _dashOtherOpen = false;
let _dashOtherLoading = false;
let _dashChartHandle = null;
let _dashAccumHandle = null;
let _dashStatsData = null;
let _dashMode = 'enh'; // 'enh' or 'kr'

// WMO weather code → emoji
const _WMO_ICONS = {
    0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️',
    45: '🌫', 48: '🌫',
    51: '🌦', 53: '🌦', 55: '🌧',
    61: '🌧', 63: '🌧', 65: '🌧',
    71: '🌨', 73: '🌨', 75: '❄️',
    80: '🌦', 81: '🌧', 82: '🌧',
    95: '⛈', 96: '⛈', 99: '⛈',
};

const _DAY_NAMES = ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
const _MONTH_NAMES = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];

function _dashFmtDateLong(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return `${_DAY_NAMES[d.getDay()]} ${d.getDate()}. ${_MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}
function _dashFmtDateShort(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return `${_DAY_NAMES[d.getDay()]} ${d.getDate()}. ${_MONTH_NAMES[d.getMonth()]}`;
}

// ─── Init / Cleanup ─────────────────────────────────────────

function initOfficeDashboard(containerEl, opts = {}) {
    _dashContainer = containerEl;
    _dashOpts = opts;
    _dashActive = true;
    _dashMode = localStorage.getItem('dashboard_graf_mode') || 'enh';

    _dashRenderShell();
    _dashWireDelegatedClicks();
    _dashLoadData();
    _dashLoadWeather();
}

// ─── Delegated click handler for navigation chips ───────────
function _dashWireDelegatedClicks() {
    if (!_dashContainer) return;
    _dashContainer.addEventListener('click', (e) => {
        const target = e.target.closest('[data-customer-id], [data-bon-id], [data-goto]');
        if (!target || !_dashContainer.contains(target)) return;

        // Customer → CRM Kunde 360° (ktab='activity' fra opfølgninger → Planlagt-blok synlig)
        const cid = target.dataset.customerId;
        if (cid && typeof window.openKunde360 === 'function') {
            const ktab = target.dataset.ktab;
            window.openKunde360(cid, ktab ? { tab: ktab } : undefined);
            return;
        }

        // Bon → drawer (kommende prep-bons)
        const bid = target.dataset.bonId;
        if (bid && _dashOpts.openDrawer) {
            _dashOpts.openDrawer(bid);
            return;
        }

        // Generisk view-navigation
        const goto = target.dataset.goto;
        if (goto && typeof window.officeGoto === 'function') {
            const params = {};
            if (target.dataset.filter) params.filter = target.dataset.filter;
            if (target.dataset.date)   params.date   = target.dataset.date;
            window.officeGoto(goto, params);
        }
    });
}

function cleanupOfficeDashboard() {
    _dashActive = false;
    _dashOtherProducts = null;
    _dashOtherOpen = false;
    _dashOtherLoading = false;
    if (_dashChartHandle) { _dashChartHandle.destroy(); _dashChartHandle = null; }
    if (_dashAccumHandle) { _dashAccumHandle.destroy(); _dashAccumHandle = null; }
    const topRight = document.getElementById('office-topbar-right');
    if (topRight) topRight.innerHTML = '';
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Bon v2 — Office';
}

// ─── Shell ──────────────────────────────────────────────────

function _dashRenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Dashboard';

    _dashContainer.innerHTML = `
        <style>
            /* ══ DASHBOARD GRID ═════════════════════════════════════ */
            .od-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                grid-template-rows: auto 1fr;
                gap: 9px;
                padding: 0;
                height: 100%;
            }
            @media (max-width: 800px) { .od-grid { grid-template-columns: 1fr; } }

            /* ══ KPI STRIP ══════════════════════════════════════════ */
            .od-kpi-strip {
                grid-column: 1 / -1;
                display: flex; gap: 9px;
            }
            .od-kpi {
                flex: 1;
                background: var(--color-surface, #fff);
                border-radius: 10px;
                padding: 12px 16px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
            }
            .od-kpi-value {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 28px; font-weight: 700; line-height: 1.1;
                color: var(--brand-primary, #8e631f);
                font-variant-numeric: tabular-nums;
            }
            .od-kpi-value.warn { color: #C94040; }
            .od-kpi-label {
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
                font-size: 10px; font-weight: 700; color: var(--color-text-dim, #888);
                text-transform: uppercase; letter-spacing: .4px; margin-top: 2px;
            }
            .od-kpi:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1), 0 0 0 1px rgba(142,99,31,0.15); }
            .od-kpi-sub { font-size: 11px; color: var(--color-text-dim, #888); margin-top: 3px; }
            .kpi-delta {
                display: inline-block; padding: 1px 7px; border-radius: 10px;
                font-size: 10px; font-weight: 700;
            }
            .delta-up   { background: #e8f2dc; color: #3d7a0a; }
            .delta-down { background: #fde8e8; color: #bc181b; }
            .delta-flat { background: var(--color-background, #f5f4f2); color: var(--color-text-dim, #888); }

            /* ══ CLICKABLE ══════════════════════════════════════════ */
            .od-clickable { cursor: pointer; transition: background-color .12s, transform .08s; }
            .od-clickable:hover { background-color: rgba(142,99,31,0.06); }
            .od-clickable:active { transform: translateY(1px); }
            .od-cat-table tr.od-clickable:hover td { background: rgba(142,99,31,0.06); }

            /* ══ DAGENS STATUS-BRIK ════════════════════════════════ */
            .od-kpi-status .od-kpi-value { font-family: var(--font-heading, 'Playfair Display', Georgia, serif); }
            .od-status-chips {
                display: flex; flex-wrap: wrap; gap: 4px;
                margin-top: 6px;
            }
            .od-status-chip {
                display: inline-flex; align-items: center; gap: 5px;
                padding: 2px 7px; border-radius: 10px;
                font-size: 10.5px; font-weight: 700;
                letter-spacing: .3px;
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
                line-height: 1.4;
            }
            .od-status-count {
                border-radius: 8px; padding: 0 5px;
                font-size: 10px; font-weight: 700;
                font-variant-numeric: tabular-nums;
            }
            .od-status-foot {
                font-size: 10.5px; color: var(--color-text-dim, #888);
                margin-top: 6px;
                font-variant-numeric: tabular-nums;
            }
            .od-status-foot strong { color: var(--color-text, #2a2520); font-weight: 600; }

            /* ══ CARDS ══════════════════════════════════════════════ */
            .od-card {
                background: var(--color-surface, #fff);
                border-radius: 10px;
                display: flex; flex-direction: column;
                overflow: hidden;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
                min-height: 0;
            }
            .od-card-head {
                padding: 8px 12px; font-size: 10px; font-weight: 700;
                letter-spacing: .7px; text-transform: uppercase;
                display: flex; align-items: center; gap: 7px;
                flex-shrink: 0; color: var(--color-text-dim, #888);
                border-bottom: 1px solid var(--color-border-light, #ebe7e2);
            }
            .od-card-head.h-brown {
                background: var(--brand-primary, #8e631f); color: rgba(255,255,255,.95);
                border-bottom: none; cursor: pointer; text-decoration: none;
            }
            .od-card-head.h-brown:hover { background: #6d4c16; }
            .od-card-head.h-blue {
                background: #7594b3; color: rgba(255,255,255,.95);
                border-bottom: none; cursor: pointer; text-decoration: none;
            }
            .od-card-head.h-blue:hover { background: #5a7a99; }
            .od-head-r  { margin-left: auto; font-weight: 400; opacity: .75; font-size: 10px; letter-spacing: 0; }
            .od-head-arrow { margin-left: auto; opacity: .5; font-size: 12px; font-style: normal; font-weight: 400; letter-spacing: 0; text-transform: none; }
            .od-card-body { padding: 10px 12px; overflow: hidden; min-height: 0; flex: 1; }

            /* ══ LEFT COLUMN ═══════════════════════════════════════ */
            .od-left-col {
                grid-column: 1; grid-row: 2;
                display: flex; flex-direction: column; gap: 9px; min-height: 0;
            }
            .od-card-graf { flex: 1; min-height: 0; }
            .od-graf-inner { display: flex; flex-direction: column; height: 100%; min-height: 0; }
            .od-graf-head {
                padding: 8px 12px; font-size: 10px; font-weight: 700;
                letter-spacing: .7px; text-transform: uppercase;
                display: flex; align-items: center; gap: 7px;
                flex-shrink: 0; color: var(--color-text-dim, #888);
                border-bottom: 1px solid var(--color-border-light, #ebe7e2);
            }
            .od-graf-head .graf-toggle {
                margin: 0 0 0 auto;
            }

            .od-graf-canvas-area { flex: 1; min-height: 0; padding: 4px 10px 0; position: relative; }
            #grafCanvas { display: block; width: 100%; height: 100%; }

            /* ══ RIGHT COLUMN ═══════════════════════════════════════ */
            .od-right-col {
                grid-column: 2; grid-row: 2;
                display: flex; flex-direction: column; gap: 9px; min-height: 0;
            }

            /* ══ SUMMARY STRIP (compact I dag) ═════════════════════ */
            .od-summary-strip {
                display: flex; margin-bottom: 8px;
                border-radius: 6px; overflow: hidden;
                border: 1px solid var(--color-border-light, #ebe7e2);
            }
            .od-sum-cell {
                flex: 1; text-align: center; padding: 5px 3px;
                border-right: 1px solid var(--color-border-light, #ebe7e2);
                background: #fdfbf3;
            }
            .od-sum-cell:last-child { border-right: none; }
            .od-sum-val { font-size: 18px; font-weight: 900; color: var(--brand-primary, #8e631f); line-height: 1; letter-spacing: -1px; }
            .od-sum-lbl { font-size: 8px; font-weight: 700; color: var(--color-text-dim, #888); text-transform: uppercase; letter-spacing: .3px; margin-top: 1px; }
            .od-sum-prod { background: #f5efe0; flex: 1.4; }
            .od-sum-prod .od-sum-val { font-size: 15px; }

            /* ══ ALERT BAR ═════════════════════════════════════════ */
            .od-alert-bar {
                display: flex; align-items: center; gap: 6px;
                padding: 5px 9px; margin-bottom: 6px;
                background: #fffaed; border: 1px solid #f0d080;
                border-radius: 6px; cursor: pointer;
                font-size: 10px; font-weight: 700; color: #8a6400;
            }
            .od-alert-ok {
                display: flex; align-items: center; gap: 6px;
                padding: 4px 9px; margin-bottom: 6px;
                background: #e8f2dc; border: 1px solid #c5dfa0;
                border-radius: 6px; font-size: 10px; font-weight: 700; color: #7a9c54;
            }
            .od-alert-web {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 12px; margin-bottom: 8px;
                background: #fdecec; border: 1px solid #e8a5a5;
                border-radius: 6px; cursor: pointer;
                font-size: 12px; font-weight: 700; color: #a82828;
                animation: od-pulse 2s ease-in-out infinite;
            }
            .od-alert-web .od-alert-count {
                background: #a82828; color: #fff;
                padding: 1px 8px; border-radius: 10px;
                font-size: 11px; font-weight: 800;
                font-variant-numeric: tabular-nums;
            }
            @keyframes od-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(168, 40, 40, 0); }
                50%      { box-shadow: 0 0 0 4px rgba(168, 40, 40, 0.15); }
            }

            /* ══ KATEGORI TABEL (compact) ══════════════════════════ */
            .od-cat-table { width: 100%; border-collapse: collapse; font-size: 11px; }
            .od-cat-table th {
                text-align: left; font-size: 8px; font-weight: 700; color: var(--color-text-dim, #888);
                text-transform: uppercase; letter-spacing: .3px;
                padding: 2px 4px 3px; border-bottom: 1px solid var(--color-border, #d7d1ca);
            }
            .od-cat-table th.r { text-align: right; }
            .od-cat-table td { padding: 3px 4px; border-bottom: 1px solid var(--color-border-light, #ebe7e2); }
            .od-cat-table td.num { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--brand-primary, #8e631f); text-align: right; }
            .od-cat-table tr:last-child td { border-bottom: none; }
            .od-cat-total td { font-weight: 900; color: var(--brand-primary, #8e631f); border-top: 2px solid var(--color-border, #d7d1ca); border-bottom: none !important; padding-top: 5px; }

            /* ══ PREP LISTE (compact) ══════════════════════════════ */
            .od-prep-list { list-style: none; display: flex; flex-direction: column; gap: 3px; }
            .od-prep-row {
                display: flex; align-items: center; gap: 5px;
                padding: 4px 7px; border-radius: 5px;
                background: var(--color-background, #f5f4f2);
                border-left: 3px solid transparent; font-size: 11px;
            }
            .od-prep-row.warn { background: #fff9f0; border-left-color: #e8a832; }
            .od-prep-row.ok   { background: #e8f2dc; border-left-color: #7a9c54; }
            .od-prep-bon  { font-weight: 900; color: var(--brand-primary, #8e631f); font-size: 9px; min-width: 34px; }
            .od-prep-cust { flex: 1; color: var(--color-text-dim, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .od-prep-enh  { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 11px; min-width: 30px; text-align: right; }
            .od-prep-chips { display: flex; gap: 2px; }
            .od-chip { font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 6px; white-space: nowrap; }
            .od-chip-ok   { background: #e8f2dc; color: #7a9c54; }
            .od-chip-warn { background: #fde8e8; color: #bc181b; }

            /* ══ CRM PANEL ═════════════════════════════════════════ */
            .od-crm-empty { text-align: center; padding: 16px; color: var(--color-text-dim, #888); font-size: 12px; }
            .od-cb-item {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 0; border-bottom: 1px solid var(--color-border, #eee);
            }
            .od-cb-item:last-child { border-bottom: none; }
            .od-cb-av {
                width: 32px; height: 32px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
            }
            .od-cb-av.av-green { background: linear-gradient(135deg, #2E9E6B, #1a7a50); }
            .od-cb-av.av-gold  { background: linear-gradient(135deg, #C8962A, #a07020); }
            .od-cb-av.av-gray  { background: linear-gradient(135deg, #8a8580, #6b6560); }
            .od-cb-info { flex: 1; min-width: 0; }
            .od-cb-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .od-cb-company { font-size: 11px; color: var(--color-text-dim, #888); }
            .od-cb-badge {
                padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700;
                white-space: nowrap; flex-shrink: 0;
            }
            .od-cb-badge.urgent { background: var(--color-sentiment-neg-bg, #FBE9E9); color: var(--color-sentiment-neg, #C94040); }
            .od-cb-badge.today  { background: var(--color-sentiment-neu-bg, #FBF3E2); color: var(--color-sentiment-neu, #C8962A); }
            /* Mine opfølgninger (kompakt) — matcher CRM-dashboardet */
            .od-fu-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; }
            .od-fu-kilde { padding: 1px 7px; border-radius: 9px; font-size: 9px; font-weight: 700; white-space: nowrap; }
            .od-fu-kilde.planlagt { background: var(--color-sentiment-neu-bg, #FBF3E2); color: var(--color-sentiment-neu, #C8962A); }
            .od-fu-kilde.service  { background: #e0ecf5; color: #2a6fb0; }
            .od-fu-time { font-size: 10px; font-weight: 700; color: var(--color-text-dim, #888); white-space: nowrap; }
            .od-fu-time.overdue { color: var(--color-sentiment-neg, #C94040); }
            .od-fu-time.overdue::before { content: "⚑ "; }

            .od-act-item {
                display: flex; align-items: flex-start; gap: 10px;
                padding: 6px 0; font-size: 12px;
            }
            .od-act-dot {
                width: 8px; height: 8px; border-radius: 50%;
                margin-top: 4px; flex-shrink: 0;
            }
            .od-act-dot.dot-green { background: var(--color-sentiment-pos, #2E9E6B); }
            .od-act-dot.dot-gold  { background: var(--color-sentiment-neu, #C8962A); }
            .od-act-dot.dot-gray  { background: var(--color-text-dim, #888); }
            .od-act-dot.dot-red   { background: var(--color-sentiment-neg, #C94040); }
            .od-act-text { flex: 1; color: var(--color-text, #333); }
            .od-act-type { font-weight: 600; }
            .od-act-time { font-size: 10px; color: var(--color-text-dim, #aaa); white-space: nowrap; }

            /* ══ TOPBAR VAGT ═══════════════════════════════════════ */
            .od-topbar-vagt { display: flex; align-items: center; gap: 5px; }
            .od-topbar-label { font-size: 9px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--color-text-dim, #888); margin-right: 2px; }
            .od-topbar-pill {
                display: flex; align-items: center; gap: 4px;
                background: #fdfbf3; border: 1px solid #e8dfc0;
                border-radius: 14px; padding: 2px 8px 2px 3px;
                cursor: default; position: relative;
            }
            .od-topbar-pill:hover .od-topbar-tt { display: block; }
            .od-topbar-av {
                width: 20px; height: 20px; border-radius: 50%;
                background: var(--brand-primary, #8e631f); color: #fff;
                display: flex; align-items: center; justify-content: center;
                font-size: 8px; font-weight: 700;
            }
            .od-topbar-name { font-size: 11px; font-weight: 700; }
            .od-topbar-tid  { font-size: 9px; color: var(--color-text-dim, #888); }
            .od-topbar-tt {
                display: none; position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%);
                background: #5a3d10; color: #fff; font-size: 10px; font-weight: 700;
                padding: 4px 9px; border-radius: 5px; white-space: nowrap; z-index: 200;
                pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .od-topbar-tt::before {
                content: ''; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
                border: 4px solid transparent; border-bottom-color: #5a3d10;
            }
            .od-topbar-count-pill {
                display: flex; align-items: center; gap: 3px;
                background: #fdfbf3; border: 1px solid #e8dfc0;
                border-radius: 14px; padding: 2px 8px;
                cursor: default; position: relative; font-size: 11px; font-weight: 700;
            }
            .od-topbar-count-pill:hover .od-topbar-tt { display: block; }
            .od-topbar-weather {
                display: flex; align-items: center; gap: 4px;
                font-size: 12px; font-weight: 700;
                margin-left: auto;
            }
            .od-topbar-weather .wt-desc { font-size: 9px; color: var(--color-text-dim, #888); }
            .od-topbar-date { color: var(--color-text-dim, #888); font-size: 12px; font-weight: 700; }
            .od-topbar-div { width: 1px; height: 16px; background: var(--color-border, #d7d1ca); }

            .od-loading { text-align: center; padding: 30px; color: var(--color-text-dim, #888); font-size: 12px; }

            /* ══ TOP PRODUKTER — "Øvrigt" ═══════════════════════════ */
            .od-prod-other { margin-top: 6px; border-top: 1px solid var(--gray-mid, #ece9e4); }
            .od-prod-other-toggle {
                display: block;
                width: 100%;
                text-align: left;
                background: none;
                border: none;
                padding: 7px 6px;
                cursor: pointer;
                font-family: inherit;
                font-size: 11px;
                color: var(--color-text-dim, #8a8078);
            }
            .od-prod-other-toggle:hover { color: var(--brown, #8e631f); }
            .od-prod-other-table { opacity: .7; }
            .od-prod-other-table td { padding: 4px 6px; font-size: 11px; }
            .od-prod-other-table td.num { color: var(--color-text-dim, #8a8078); }
        </style>
        <div class="od-grid">
            <!-- KPI Strip -->
            <div class="od-kpi-strip" id="od-kpis"></div>

            <!-- Left: Graf + Top produkter -->
            <div class="od-left-col">
                <div class="od-card od-card-graf">
                    <div class="od-graf-inner">
                        <div class="od-graf-head">
                            <span>📦 Bons · 10 dage</span>
                            <span style="font-weight:400;opacity:.55;font-size:9px;letter-spacing:0;text-transform:none;">grå linje = 2025</span>
                            <div class="graf-toggle">
                                <button class="tog-btn${_dashMode === 'enh' ? ' active' : ''}" id="togEnh" onclick="_dashSetToggle('enh')">Enheder</button>
                                <button class="tog-btn${_dashMode === 'kr' ? ' active' : ''}" id="togKr" onclick="_dashSetToggle('kr')">Kr</button>
                            </div>
                        </div>
                        <div class="od-graf-canvas-area">
                            <canvas id="grafCanvas"></canvas>
                        </div>
                        <div class="staff-row" id="staffRow"></div>
                        <div style="height:60px;flex-shrink:0;padding:0 0 0 0;position:relative;">
                            <canvas id="accumCanvas" style="display:block;width:100%;height:100%;"></canvas>
                            <div style="position:absolute;top:2px;left:12px;font-size:8px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:rgba(142,99,31,0.4);">Akkumuleret</div>
                        </div>
                        <div class="chart-legend" id="grafLegend"></div>
                    </div>
                </div>
                <!-- Top produkter -->
                <div class="od-card" style="flex-shrink:0;" id="od-card-products">
                    <div class="od-card-head" style="justify-content:space-between;">
                        <span>🏆 Top produkter · <span id="od-prod-month"></span></span>
                        <span id="od-prod-sub" style="margin-left:auto;font-weight:400;opacity:.65;font-size:9px;letter-spacing:0;text-transform:none;">efter enheder</span>
                    </div>
                    <div class="od-card-body" id="od-prod-body"><div class="od-loading">Henter...</div></div>
                </div>
            </div>

            <!-- Right: I dag + Prep + CRM -->
            <div class="od-right-col">
                <div class="od-card" style="flex-shrink:0;" id="od-card-today">
                    <a class="od-card-head h-brown" href="/kitchen/today.html" target="_blank">
                        📋 I dag
                        <span class="od-head-arrow">→</span>
                    </a>
                    <div class="od-card-body" id="od-today-body"><div class="od-loading">Henter...</div></div>
                </div>
                <div class="od-card" style="flex:1;min-height:0;" id="od-card-prep">
                    <a class="od-card-head h-blue" href="/kitchen/later.html" target="_blank" id="od-prep-head">
                        ⏳ Prep i morgen
                        <span class="od-head-r" id="od-prep-summary"></span>
                        <span class="od-head-arrow">→</span>
                    </a>
                    <div class="od-card-body" style="padding:6px 10px;overflow-y:auto;" id="od-prep-body"><div class="od-loading">Henter...</div></div>
                </div>
                <!-- CRM: Mine opfølgninger -->
                <div class="od-card" style="flex-shrink:0;">
                    <a class="od-card-head" href="?view=crm-dashboard" style="cursor:pointer;text-decoration:none;color:inherit;">
                        🔔 Mine opfølgninger
                        <span class="od-head-arrow">→</span>
                    </a>
                    <div class="od-card-body" id="od-crm-callbacks" style="padding:8px 12px;max-height:160px;overflow-y:auto;">
                        <div class="od-crm-empty">Henter...</div>
                    </div>
                </div>
                <!-- CRM: Seneste aktivitet -->
                <div class="od-card" style="flex:1;min-height:0;">
                    <a class="od-card-head" href="?view=crm-dashboard" style="cursor:pointer;text-decoration:none;color:inherit;">
                        🔀 Seneste aktivitet
                        <span class="od-head-arrow">→</span>
                    </a>
                    <div class="od-card-body" id="od-crm-activity" style="padding:8px 12px;overflow-y:auto;">
                        <div class="od-crm-empty">Henter...</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ─── Toggle ─────────────────────────────────────────────────

function _dashSetToggle(mode) {
    _dashMode = mode;
    localStorage.setItem('dashboard_graf_mode', mode);
    document.getElementById('togEnh')?.classList.toggle('active', mode === 'enh');
    document.getElementById('togKr')?.classList.toggle('active', mode === 'kr');
    if (_dashChartHandle) _dashChartHandle.setMode(mode);
    if (_dashAccumHandle) _dashAccumHandle.setMode(mode);
    _dashRenderTopProducts();
}

// ─── Data loading ───────────────────────────────────────────

async function _dashLoadData() {
    if (!_dashActive) return;

    try {
        const [todayData, statsData, topProducts] = await Promise.all([
            fetchDashboardToday(),
            fetchDashboardStats(4, 5),
            fetchDashboardTopProducts(),
        ]);

        _dashTopProducts = topProducts;
        _dashStatsData = statsData;
        // Øvrigt-listen er hentet separat og ville ellers vise forældede tal
        // efter en genindlæsning. Hentes igen kun hvis den står åben.
        _dashOtherProducts = null;
        if (_dashOtherOpen) {
            fetchDashboardTopProducts(null, null, 'other')
                .then(rows => { _dashOtherProducts = rows; if (_dashActive) _dashRenderTopProducts(); })
                .catch(err => console.error('[dashboard] Kunne ikke hente øvrige produkter:', err));
        }

        _dashRenderKPIs(todayData);
        _dashRenderToday(todayData);
        _dashRenderPrep(todayData.tomorrow_prep);
        _dashRenderChart(statsData);
        _dashRenderTopProducts();
        _dashRenderTopbar(todayData.date, statsData);
        _dashLoadCRM();
    } catch (err) {
        console.error('[dashboard] Load error:', err);
        if (!_dashActive) return;
        const grid = _dashContainer && _dashContainer.querySelector('.od-grid');
        if (grid) {
            grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--color-text-dim,#888);">
                <p style="font-size:18px;margin-bottom:8px;">Kunne ikke hente dashboard-data</p>
                <p style="font-size:13px;">${err.message || 'Ukendt fejl'}</p>
                <button onclick="_dashLoadData()" style="margin-top:16px;padding:8px 20px;border-radius:6px;border:1px solid var(--color-border,#d7d1ca);background:var(--color-surface,#fff);cursor:pointer;font-size:13px;">Prøv igen</button>
            </div>`;
        }
    }
}

// ─── Topbar ──────────────────────────────────────────────────

function _dashRenderTopbar(dateStr, statsData) {
    const topRight = document.getElementById('office-topbar-right');
    if (!topRight || !_dashActive) return;

    const fmtDate = _dashFmtDateLong(dateStr);

    topRight.innerHTML = `
        <span class="od-topbar-div"></span>
        <span class="od-topbar-date">${fmtDate}</span>
        <span class="od-topbar-div"></span>
        <div class="od-topbar-vagt" id="od-topbar-vagt">
            <span class="od-topbar-label">På vagt</span>
        </div>
        <span class="od-topbar-weather" id="od-topbar-weather"></span>
    `;

    // Vagt pills from stats
    const todayDay = statsData?.days?.find(d => d.is_today);
    const shifts = todayDay?.shifts || [];
    const vagtEl = document.getElementById('od-topbar-vagt');
    if (shifts.length > 0 && vagtEl) {
        if (shifts.length <= 4) {
            for (const s of shifts) {
                const pill = document.createElement('div');
                pill.className = 'od-topbar-pill';
                pill.innerHTML = `
                    <div class="od-topbar-av">${s.init || ''}</div>
                    <div>
                        <div class="od-topbar-name">${s.first_name || ''}</div>
                        <div class="od-topbar-tid">${s.tid || ''}</div>
                    </div>
                    <div class="od-topbar-tt">${s.name || ''} · ${s.tid || ''}</div>
                `;
                vagtEl.appendChild(pill);
            }
        } else {
            const pill = document.createElement('div');
            pill.className = 'od-topbar-count-pill';
            pill.innerHTML = `
                👤 ${shifts.length} på vagt
                <div class="od-topbar-tt">${shifts.map(s => `${s.name || ''} <span style="opacity:.6">${s.tid || ''}</span>`).join('<br>')}</div>
            `;
            vagtEl.appendChild(pill);
        }
    }
}

// ─── Weather (Open-Meteo) ────────────────────────────────────

async function _dashLoadWeather() {
    if (!_dashActive) return;
    try {
        const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=55.70&longitude=12.55&current=temperature_2m,weather_code&timezone=Europe/Copenhagen');
        const data = await r.json();
        if (!data.current) return;
        const temp = Math.round(data.current.temperature_2m);
        const icon = _WMO_ICONS[data.current.weather_code] || '🌡';
        const el = document.getElementById('od-topbar-weather');
        if (el) el.innerHTML = `${icon} ${temp}° <span class="wt-desc">København</span>`;
    } catch (e) { /* stille fejl */ }
}

// ─── KPIs ──────────────────────────────────────────────────

function _dashRenderKPIs(data) {
    if (!_dashActive) return;
    const el = document.getElementById('od-kpis');
    if (!el) return;

    const mtd = data.mtd || {};
    const month = _MONTH_NAMES[new Date().getMonth()];
    const lastYear = new Date().getFullYear() - 1;

    function delta(current, ly) {
        if (!ly || ly === 0) return `<span class="kpi-delta delta-flat">→ afventer</span>`;
        const pct = Math.round(((current - ly) / ly) * 100);
        const abs = Math.abs(pct);
        if (abs < 2) return `<span class="kpi-delta delta-flat">→ ±0% vs. ${lastYear}</span>`;
        if (pct > 0) return `<span class="kpi-delta delta-up">↑ ${abs}% vs. ${lastYear}</span>`;
        return `<span class="kpi-delta delta-down">↓ ${abs}% vs. ${lastYear}</span>`;
    }

    const openWarn = (mtd.open_bons || 0) > 15 ? ' warn' : '';
    const unfactWarn = (mtd.unfactured || 0) > 0 ? ' warn' : '';

    // Regnskabskonvention: omsætning er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c).
    // Backend leverer både *_excl_moms og bagudkomp.-felter.
    const revenue       = mtd.revenue_excl_moms       ?? mtd.revenue       ?? 0;
    const lastYearRev   = mtd.last_year_revenue_excl_moms ?? mtd.last_year_revenue ?? 0;
    const unfactured    = mtd.unfactured_excl_moms    ?? mtd.unfactured    ?? 0;

    // ── Dagens status-brik ──────────────────────────────────
    // Bygger pills i fast rækkefølge (færdig → klar → i gang → godkendt → venter → ny)
    // og samler alle terminal-statusser (LEVERET/FAKTURERET/BETALT/AFSLUTTET) under "LEV".
    const statusTileHtml = _dashBuildStatusTile(data);

    el.innerHTML = `
        <div class="od-kpi od-clickable" data-goto="rapporter" title="Åbn Rapporter">
            <div class="od-kpi-value">${revenue.toLocaleString('da-DK')}</div>
            <div class="od-kpi-label">Omsætning (ex moms) · ${month} MTD</div>
            <div class="od-kpi-sub">${delta(revenue, lastYearRev)}</div>
        </div>
        <div class="od-kpi od-clickable" data-goto="rapporter" title="Åbn Rapporter">
            <div class="od-kpi-value">${(mtd.units || 0).toLocaleString('da-DK')}</div>
            <div class="od-kpi-label">Enheder · ${month} MTD</div>
            <div class="od-kpi-sub">${delta(mtd.units, mtd.last_year_units)}</div>
        </div>
        ${statusTileHtml}
        <div class="od-kpi od-clickable" data-goto="bons" data-filter="open" title="Vis åbne bons">
            <div class="od-kpi-value${openWarn}">${mtd.open_bons || 0}</div>
            <div class="od-kpi-label">Åbne bons</div>
            <div class="od-kpi-sub">NY / VENTER / GODKENDT / IGANG / KLAR</div>
        </div>
        <div class="od-kpi od-clickable" data-goto="fakturering" title="Åbn Fakturering">
            <div class="od-kpi-value${unfactWarn}">${unfactured.toLocaleString('da-DK')}</div>
            <div class="od-kpi-label">Ufaktureret (ex moms)</div>
            <div class="od-kpi-sub">Leverede bons uden faktura</div>
        </div>
    `;
}

// Bygger "Dagens status"-tile (Variant C — pille-række).
// Tomme dage: viser et tomt-but-klikbart tile så layoutet ikke skifter mellem dage.
function _dashBuildStatusTile(data) {
    const breakdown = Array.isArray(data.status_breakdown) ? data.status_breakdown : [];
    const totalBons = data.totals?.bon_count || 0;

    // Saml terminal-statusser under "lev" så pillen ikke fragmenteres.
    const TERMINAL = new Set(['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET']);
    const counts = {};
    for (const row of breakdown) {
        const fe = TERMINAL.has(row.status_code) ? 'lev' : (typeof statusToFrontend === 'function' ? statusToFrontend(row.status_code) : row.status_code.toLowerCase());
        counts[fe] = (counts[fe] || 0) + (row.count || 0);
    }

    // Rækkefølge: færdig → klar → i gang → godkendt → venter → ny
    const ORDER = ['lev', 'klar', 'igang', 'godkendt', 'venter', 'ny'];
    const cfgMap = (typeof BON_CONFIG !== 'undefined' && BON_CONFIG.statuses) ? BON_CONFIG.statuses : {};

    let chipsHtml = '';
    for (const feKey of ORDER) {
        const n = counts[feKey];
        if (!n) continue;
        const cfg = cfgMap[feKey] || {};
        const bg = cfg.color || '#999';
        const fg = cfg.text || '#fff';
        const label = (cfg.label || feKey).toUpperCase();
        // Tæller-badge bruger semi-transparent overlag der virker både på mørke og lyse pills.
        const countBg = (fg === '#ffffff' || fg === '#fff') ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.15)';
        chipsHtml += `<span class="od-status-chip" style="background:${bg};color:${fg};">${esc(label)}<span class="od-status-count" style="background:${countBg};">${n}</span></span>`;
    }

    // Footer-linje: næste pickup + sidst leveret. Begge er valgfri.
    const nextPickup = data.next_pickup ? data.next_pickup.slice(0, 5) : null;
    let lastDel = null;
    if (data.last_delivered_time) {
        const d = typeof parseServerDate === 'function'
            ? parseServerDate(data.last_delivered_time)
            : new Date(data.last_delivered_time);
        if (d && !isNaN(d.getTime())) {
            lastDel = d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
        }
    }
    const footerParts = [];
    if (nextPickup) footerParts.push(`Næste pickup <strong>${nextPickup}</strong>`);
    if (lastDel)    footerParts.push(`Sidst leveret <strong>${lastDel}</strong>`);
    const footerHtml = footerParts.length
        ? `<div class="od-status-foot">${footerParts.join(' · ')}</div>`
        : '';

    const valueText = totalBons === 0
        ? '<span style="opacity:.5;">Ingen bons</span>'
        : `${totalBons} bon${totalBons === 1 ? '' : 's'}`;

    const tooltip = totalBons === 0 ? 'Ingen bons i dag' : 'Vis dagens bons';

    return `
        <div class="od-kpi od-kpi-status od-clickable" data-goto="bons" data-filter="today" title="${tooltip}">
            <div class="od-kpi-value" style="font-size:22px;">${valueText}</div>
            <div class="od-kpi-label">Dagens status</div>
            ${chipsHtml ? `<div class="od-status-chips">${chipsHtml}</div>` : ''}
            ${footerHtml}
        </div>
    `;
}

// ─── Chart ──────────────────────────────────────────────────

function _dashRenderChart(data) {
    if (!_dashActive) return;
    buildChartLegend('grafLegend');
    if (_dashChartHandle) _dashChartHandle.destroy();
    _dashChartHandle = initDashboardChart('grafCanvas', data, {
        showLastYear: true,
    });
    if (_dashChartHandle) _dashChartHandle.setMode(_dashMode);
    setTimeout(() => {
        buildStaffBadges('staffRow', 'grafCanvas', data.days);
        // Accum chart below staff badges
        if (_dashAccumHandle) _dashAccumHandle.destroy();
        _dashAccumHandle = initAccumChart('accumCanvas', 'grafCanvas', data, { mode: _dashMode });
    }, 50);
}

// ─── I dag (right column) ────────────────────────────────────

function _dashRenderToday(data) {
    if (!_dashActive) return;
    const body = document.getElementById('od-today-body');
    const head = document.querySelector('#od-card-today .od-card-head');
    if (!body) return;

    if (head) head.childNodes[0].textContent = `📋 I dag · ${_dashFmtDateShort(data.date)} `;

    const prod = data.production_totals || { bon_count: 0, total_units: 0 };
    let html = `<div class="od-summary-strip">
        <div class="od-sum-cell od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><div class="od-sum-val">${data.totals.bon_count}</div><div class="od-sum-lbl">Bons</div></div>
        <div class="od-sum-cell od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><div class="od-sum-val">${data.totals.total_units}</div><div class="od-sum-lbl">Enheder</div></div>
        <div class="od-sum-cell od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><div class="od-sum-val">${data.totals.total_pax}</div><div class="od-sum-lbl">Pax</div></div>
        <div class="od-sum-cell od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><div class="od-sum-val">${data.next_pickup ? data.next_pickup.slice(0,5) : '—'}</div><div class="od-sum-lbl">1. pickup</div></div>
        ${prod.bon_count > 0 ? `<div class="od-sum-cell od-sum-prod od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons (produktion vises med 🔧 i listen)"><div class="od-sum-val">🔧 ${prod.bon_count}</div><div class="od-sum-lbl">Produktion · ${prod.total_units} enh</div></div>` : ''}
    </div>`;

    // Alert: nye web-bestillinger (vises øverst — forretnings-risiko, #041)
    const webAlert = data.alerts.find(a => a.type === 'new_web_orders');
    if (webAlert) {
        html += `<div class="od-alert-web od-clickable" data-goto="bons" data-filter="ny" title="Åbn liste over nye bestillinger">`
              + `<span>🆕</span><span class="od-alert-count">${webAlert.count}</span>`
              + `<span>${webAlert.message}</span></div>`;
    }

    // Alert: prep
    const prepAlerts = data.alerts.filter(a => a.type === 'prep_missing');
    const missingEmb = prepAlerts.filter(a => a.message.includes('emballage')).length;
    const missingRav = prepAlerts.filter(a => a.message.includes('råvarer')).length;
    if (missingEmb || missingRav) {
        const parts = [];
        if (missingEmb) parts.push(`${missingEmb} mangler emb.`);
        if (missingRav) parts.push(`${missingRav} mangler råv.`);
        html += `<div class="od-alert-bar"><span>⚠</span> ${parts.join(' · ')}</div>`;
    } else if (data.totals.bon_count > 0) {
        html += `<div class="od-alert-ok"><span>✅</span> Alt klar</div>`;
    }

    // Category table
    if (data.categories.length > 0) {
        html += `<table class="od-cat-table">
            <thead><tr><th>Kategori</th><th class="r">Enh</th></tr></thead>
            <tbody>`;
        for (const cat of data.categories) {
            html += `<tr class="od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><td>${cat.name}</td><td class="num">${cat.units}</td></tr>`;
        }
        html += `<tr class="od-cat-total od-clickable" data-goto="bons" data-filter="today" title="Vis dagens bons"><td>Total</td><td class="num">${data.totals.total_units}</td></tr>`;
        html += '</tbody></table>';
    }

    body.innerHTML = html;
}

// ─── Prep (right column) ────────────────────────────────────

function _dashRenderPrep(prep) {
    if (!_dashActive) return;
    const head = document.getElementById('od-prep-head');
    const summary = document.getElementById('od-prep-summary');
    const body = document.getElementById('od-prep-body');
    if (!body) return;

    if (!prep || prep.bon_count === 0) {
        if (summary) summary.textContent = '0 bons';
        body.innerHTML = '<div class="od-loading">Ingen bons i morgen</div>';
        return;
    }

    if (head) head.childNodes[0].textContent = `⏳ Prep · ${_dashFmtDateShort(prep.date)} `;
    if (summary) summary.textContent = `${prep.total_units || prep.total_pax || 0} enh · ${prep.bon_count} bons`;

    let html = '<ul class="od-prep-list">';
    for (const b of prep.bons) {
        const ingOk = b.prep_ingredients_ready;
        const supOk = b.prep_supplies_ready;
        const cls = (ingOk && supOk) ? 'ok' : 'warn';
        const chipIng = ingOk ? '<span class="od-chip od-chip-ok">R✓</span>' : '<span class="od-chip od-chip-warn">R✗</span>';
        const chipSup = supOk ? '<span class="od-chip od-chip-ok">E✓</span>' : '<span class="od-chip od-chip-warn">E✗</span>';
        html += `<li class="od-prep-row ${cls} od-clickable" data-bon-id="${b.id}" title="Åbn bon #${b.bon_number}">
            <span class="od-prep-bon">#${b.bon_number}</span>
            <span class="od-prep-cust">${b.customer_name || ''}</span>
            <span class="od-prep-enh">${b.total_units || b.pax || 0}</span>
            <div class="od-prep-chips">${chipIng}${chipSup}</div>
        </li>`;
    }
    html += '</ul>';
    body.innerHTML = html;
}

// ─── Top Products ───────────────────────────────────────────

function _dashRenderTopProducts() {
    if (!_dashActive) return;
    const body = document.getElementById('od-prod-body');
    const monthEl = document.getElementById('od-prod-month');
    const subEl = document.getElementById('od-prod-sub');
    if (!body) return;

    if (monthEl) monthEl.textContent = _MONTH_NAMES[new Date().getMonth()];
    if (subEl) subEl.textContent = _dashMode === 'kr' ? 'efter omsætning (ex moms)' : 'efter enheder';

    if (!_dashTopProducts || _dashTopProducts.length === 0) {
        body.innerHTML = '<div class="od-loading">Ingen produktdata</div>';
        return;
    }

    // Regnskabskonvention: kr-tal er ex moms (jf. BON_V2_PRINCIPPER.md sektion 6c)
    const col = _dashMode === 'kr' ? 'total_kr_excl_moms' : 'total_enh';
    const fmt = _dashMode === 'kr' ? v => v.toLocaleString('da-DK') + ' kr' : v => v.toLocaleString('da-DK');
    // Fallback hvis backend endnu ikke leverer ex moms-feltet
    const valOf = p => p[col] ?? (_dashMode === 'kr' ? p.total_kr : p.total_enh) ?? 0;
    const sorted = [..._dashTopProducts].sort((a, b) => valOf(b) - valOf(a));
    const max = Math.max(...sorted.map(valOf));

    body.innerHTML = `<table class="prod-table">
        <thead><tr><th>Produkt</th><th class="r">${_dashMode === 'kr' ? 'Kr (ex moms)' : 'Antal'}</th><th class="r">%</th></tr></thead>
        <tbody>${sorted.map(p => {
            const val = valOf(p);
            const pct = max > 0 ? Math.round(val / max * 100) : 0;
            return `<tr>
                <td>${p.product_name}</td>
                <td class="num">${fmt(val)}</td>
                <td class="pct">
                    <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end;">
                        <span style="font-size:10px;color:var(--color-text-dim,#888)">${pct}%</span>
                        <div class="pct-bar-wrap"><div class="pct-bar" style="width:${pct}%"></div></div>
                    </div>
                </td>
            </tr>`;
        }).join('')}</tbody>
    </table>` + _dashOtherHtml(fmt, valOf);

    const toggle = body.querySelector('#od-prod-other-toggle');
    if (toggle) toggle.addEventListener('click', _dashToggleOther);
}

// ─── "Øvrigt" — emballage, drikke, kager ─────────────────────
// Ude af top-listen fordi de følger med næsten hver bon og derfor vinder på
// antal uden at være det man sælger. Stadig tællelige, bare et klik væk.

function _dashOtherHtml(fmt, valOf) {
    const caret = _dashOtherOpen ? '▾' : '▸';
    const count = _dashOtherProducts ? ` (${_dashOtherProducts.length} varer)` : '';
    let inner = '';

    if (_dashOtherOpen) {
        if (_dashOtherLoading) {
            inner = '<div class="od-loading" style="padding:8px 0;">Henter…</div>';
        } else if (!_dashOtherProducts || _dashOtherProducts.length === 0) {
            inner = '<div class="od-loading" style="padding:8px 0;">Ingen</div>';
        } else {
            const sorted = [..._dashOtherProducts].sort((a, b) => valOf(b) - valOf(a));
            inner = `<table class="prod-table od-prod-other-table"><tbody>${sorted.map(p => `<tr>
                <td>${p.product_name}</td>
                <td class="num">${fmt(valOf(p))}</td>
            </tr>`).join('')}</tbody></table>`;
        }
    }

    return `<div class="od-prod-other">
        <button type="button" id="od-prod-other-toggle" class="od-prod-other-toggle"
                aria-expanded="${_dashOtherOpen}">
            <span>${caret} Øvrigt · emballage, drikke, kager${count}</span>
        </button>
        ${inner}
    </div>`;
}

async function _dashToggleOther() {
    _dashOtherOpen = !_dashOtherOpen;

    if (_dashOtherOpen && _dashOtherProducts === null && !_dashOtherLoading) {
        _dashOtherLoading = true;
        _dashRenderTopProducts();
        try {
            _dashOtherProducts = await fetchDashboardTopProducts(null, null, 'other');
        } catch (err) {
            console.error('[dashboard] Kunne ikke hente øvrige produkter:', err);
            _dashOtherProducts = [];
        }
        _dashOtherLoading = false;
    }

    if (_dashActive) _dashRenderTopProducts();
}

// ─── Resize handler ─────────────────────────────────────────

window.addEventListener('resize', () => {
    if (_dashActive && _dashChartHandle) {
        _dashChartHandle.redraw();
        if (_dashStatsData) setTimeout(() => {
            buildStaffBadges('staffRow', 'grafCanvas', _dashStatsData.days);
            if (_dashAccumHandle) _dashAccumHandle.redraw();
        }, 50);
    }
});

// ─── CRM panels ─────────────────────────────────────────────

const _CB_AVATAR_COLORS = ['av-green', 'av-gold', 'av-gray'];

async function _dashLoadCRM() {
    if (!_dashActive) return;
    try {
        const [followups, callLog] = await Promise.all([
            fetchCrmFollowups(),
            fetchCrmCallLog({ limit: 8 }),
        ]);
        _dashRenderFollowups(followups);
        _dashRenderActivityFeed(Array.isArray(callLog) ? callLog : (callLog.rows || []));
    } catch (e) {
        console.error('[dashboard] CRM load:', e);
        const cbEl = document.getElementById('od-crm-callbacks');
        if (cbEl) cbEl.innerHTML = '<div class="od-crm-empty">Kunne ikke hente CRM-data</div>';
    }
}

// Mine opfølgninger (kompakt) — samme datakilde (/followups) som CRM-dashboardet,
// så de to lister stemmer overens. Forfaldne først, møder + fremtidige ikke med.
function _dashRenderFollowups(data) {
    const el = document.getElementById('od-crm-callbacks');
    if (!el) return;
    const items = (data && data.followups) || (Array.isArray(data) ? data : []);
    if (!items.length) {
        el.innerHTML = '<div class="od-crm-empty">Ingen opfølgninger i dag 🎉</div>';
        return;
    }
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : (s) => s;
    el.innerHTML = items.slice(0, 6).map((f, i) => {
        const name = f.name && f.name.trim() ? f.name.trim() : 'Ukendt';
        const init = name.charAt(0).toUpperCase();
        const avClass = _CB_AVATAR_COLORS[i % _CB_AVATAR_COLORS.length];
        const isService = f.kilde === 'service';
        const due = (typeof plannedFmtDue === 'function') ? plannedFmtDue(f.due_at) : { label: f.due_at || '', overdue: false };
        // Callbacks har ingen due_at → vis alder, ellers ser en gammel ud som ny
        const age = (typeof plannedFmtAge === 'function') ? plannedFmtAge(f.age_days, f.created_at) : { label: '', stale: false };
        const timeLabel = due.label || (isService ? (age.label || 'ring tilbage') : '');
        const isStale = !due.label && age.stale;
        const kildeBadge = isService
            ? '<span class="od-fu-kilde service">Service</span>'
            : '<span class="od-fu-kilde planlagt">Planlagt</span>';
        const cid = f.customer_id || '';
        const clickableAttrs = cid ? `class="od-cb-item od-clickable" data-customer-id="${cid}" data-ktab="activity" title="Åbn kundekort"` : 'class="od-cb-item"';
        return '<div ' + clickableAttrs + '>' +
            '<div class="od-cb-av ' + avClass + '">' + init + '</div>' +
            '<div class="od-cb-info">' +
                '<div class="od-cb-name">' + esc(name) + '</div>' +
                (f.company_name ? '<div class="od-cb-company">' + esc(f.company_name) + '</div>' : '') +
            '</div>' +
            '<div class="od-fu-meta">' +
                kildeBadge +
                '<span class="od-fu-time' + (due.overdue || isStale ? ' overdue' : '') + '">' + esc(timeLabel) + '</span>' +
            '</div>' +
        '</div>';
    }).join('');
}

function _dashRenderActivityFeed(items) {
    const el = document.getElementById('od-crm-activity');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = '<div class="od-crm-empty">Ingen seneste aktivitet</div>';
        return;
    }
    const typeIcons = { call: '📞', service_call: '📞', meeting: '🤝', task: '📋', note: '📝', followup: '🔔', email_in: '📥', email_out: '📤' };
    const typeDots = { call: 'dot-green', service_call: 'dot-green', meeting: 'dot-gold', note: 'dot-gold', followup: 'dot-gray', task: 'dot-gray', email_in: 'dot-gray', email_out: 'dot-gray' };
    const typeLabels = { call: 'Opkald', service_call: 'Service', meeting: 'Møde', task: 'Opgave', note: 'Note', followup: 'Opfølgning', email_in: 'Mail ind', email_out: 'Mail ud' };

    el.innerHTML = items.slice(0, 6).map(a => {
        const dotClass = typeDots[a.type] || 'dot-gray';
        const label = typeLabels[a.type] || a.type;
        const name = a.customer_name || '';
        const time = (a.created_at || '').substring(5, 16).replace('T', ' ');
        const text = a.text ? ' — ' + (a.text.length > 40 ? a.text.substring(0, 40) + '...' : a.text) : '';
        const cid = a.customer_id || '';
        const cls = cid ? 'od-act-item od-clickable' : 'od-act-item';
        const attrs = cid ? ` data-customer-id="${cid}" title="Åbn kunde i CRM"` : '';
        return '<div class="' + cls + '"' + attrs + '>' +
            '<div class="od-act-dot ' + dotClass + '"></div>' +
            '<div class="od-act-text"><span class="od-act-type">' + label + '</span> ' + name + text + '</div>' +
            '<span class="od-act-time">' + time + '</span>' +
        '</div>';
    }).join('');
}

// ─── SSE handler ────────────────────────────────────────────

function _dashHandleSSE(eventType, data) {
    if (!_dashActive) return;
    _dashLoadData();
}
