/**
 * office/views/crm-dashboard.js
 * ════════════════════════════════════════════════════════════
 * CRM Dashboard — KPIs, briefing, suggestions, pipeline, callbacks, activity
 * ════════════════════════════════════════════════════════════
 */

let _crmContainer = null;
let _crmOpts = {};
let _crmActive = false;
let _crmSvcDays = 7;

function initCrmDashboard(containerEl, opts) {
    _crmContainer = containerEl;
    _crmOpts = opts || {};
    _crmActive = true;
    _crmRenderShell();
    _crmWireDelegatedClicks();
    _crmLoadData();
}

function _crmWireDelegatedClicks() {
    if (!_crmContainer) return;
    _crmContainer.addEventListener('click', (e) => {
        const target = e.target.closest(
            '[data-customer-id], [data-scroll], [data-goto], [data-view], [data-nav]'
        );
        if (!target || !_crmContainer.contains(target)) return;
        // Lad eksisterende interaktive child-elementer (telefon-link,
        // log-formular-knapper m.fl.) køre uforstyrret.
        if (e.target.closest('a, button, input, select, textarea')) return;

        const cid = target.dataset.customerId;
        if (cid) { _crmOpenKunde(parseInt(cid, 10), target.dataset.ktab); return; }

        // Navigér til en anden CRM-sektion (fx Ringeliste), evt. forudvalgt fane
        const nav = target.dataset.nav;
        if (nav && typeof window.switchSection === 'function') {
            if (target.dataset.navTab) {
                try { localStorage.setItem('crm_ringeliste_tab', target.dataset.navTab); } catch (_) {}
            }
            window.switchSection('crm', nav);
            return;
        }

        const scrollId = target.dataset.scroll;
        if (scrollId) {
            const sec = document.getElementById(scrollId);
            if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const goto = target.dataset.goto;
        if (goto && typeof window.officeGoto === 'function') {
            const params = {};
            if (target.dataset.filter) params.filter = target.dataset.filter;
            window.officeGoto(goto, params);
            return;
        }

        const view = target.dataset.view;
        if (view && typeof window.switchView === 'function') {
            window.switchView(view);
        }
    });
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
            .crm-grid {
                display: grid;
                grid-template-columns: 1fr 340px;
                grid-template-rows: auto auto auto 1fr;
                gap: 12px; padding: 0;
            }
            @media (max-width: 900px) { .crm-grid { grid-template-columns: 1fr; } }

            .crm-kpi-strip { grid-column: 1 / -1; display: flex; gap: 9px; flex-wrap: wrap; }
            .crm-kpi {
                flex: 1; min-width: 120px;
                background: var(--color-surface, #fff);
                border-radius: 10px; padding: 14px 16px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
                transition: box-shadow .12s;
            }
            .crm-kpi:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1), 0 0 0 1px rgba(142,99,31,0.15); }
            .crm-kpi-value {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 28px; font-weight: 700; line-height: 1.1;
                color: var(--brand-primary, #8e631f);
                font-variant-numeric: tabular-nums;
            }
            .crm-kpi-value.warn { color: #C94040; }
            .crm-kpi-value.green { color: var(--color-sentiment-pos, #2E9E6B); }
            .crm-kpi-label {
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
                font-size: 10px; font-weight: 700; color: var(--color-text-dim, #888);
                text-transform: uppercase; letter-spacing: .4px; margin-top: 2px;
            }

            .crm-card {
                background: var(--color-surface, #fff);
                border-radius: 10px; padding: 18px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
            }
            .crm-card h3 {
                font-size: 10px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .5px; color: var(--color-text-dim, #888);
                margin: 0 0 12px 0;
            }

            /* Briefing */
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

            /* Suggestions with hover-actions */
            .crm-suggestion {
                padding: 12px; margin-bottom: 8px; border-radius: 8px;
                border: 1px solid var(--color-border, #eee);
                cursor: pointer; transition: border-color .15s;
                position: relative;
            }
            .crm-suggestion:hover { border-color: var(--brand-primary, #8e631f); }
            .crm-sug-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
            .crm-sug-icon { font-size: 16px; }
            .crm-sug-title { font-size: 14px; font-weight: 600; }
            .crm-sug-detail { font-size: 12px; color: var(--color-text-dim, #888); }
            .crm-sug-reason { font-size: 11px; color: var(--color-text-dim, #aaa); margin-top: 4px; }
            .crm-sug-actions {
                display: flex; gap: 6px; margin-top: 8px;
                opacity: 0; transition: opacity .15s;
            }
            .crm-suggestion:hover .crm-sug-actions { opacity: 1; }
            .crm-sug-btn {
                padding: 4px 12px; border-radius: 6px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 12px; cursor: pointer;
                font-family: inherit; transition: background .1s;
            }
            .crm-sug-btn:hover { background: var(--brand-primary-light, #f1e6b2); }
            .crm-sug-btn.primary {
                background: var(--brand-primary, #8e631f); color: white; border-color: transparent;
            }
            .crm-sug-btn.primary:hover { filter: brightness(1.1); }

            /* Pipeline board */
            .crm-pipeline { grid-column: 1 / -1; }
            .crm-pipe-filters { display: flex; gap: 5px; margin-bottom: 12px; }
            .crm-pipe-filter {
                padding: 4px 12px; border-radius: 16px; border: 1px solid var(--color-border);
                background: var(--color-surface); font-size: 12px; cursor: pointer; font-family: inherit;
            }
            .crm-pipe-filter.active { background: var(--brand-primary); color: white; border-color: transparent; }
            .crm-pipe-board {
                display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
                min-height: 120px;
            }
            @media (max-width: 900px) { .crm-pipe-board { grid-template-columns: repeat(2, 1fr); } }
            .crm-pipe-col { }
            .crm-pipe-col-head {
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
                color: var(--color-text-dim); padding: 6px 0; margin-bottom: 6px;
                border-bottom: 2px solid var(--color-border);
                display: flex; justify-content: space-between; align-items: center;
            }
            .crm-pipe-count {
                background: var(--color-background); padding: 1px 7px; border-radius: 8px;
                font-size: 10px; font-weight: 700;
            }
            .crm-pipe-card {
                background: var(--color-background, #f5f4f2); border: 1px solid var(--color-border);
                border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;
                cursor: pointer; transition: all .15s;
                font-size: 12px;
            }
            .crm-pipe-card:hover { border-color: var(--brand-primary); background: var(--brand-primary-light, #f1e6b2); }
            .crm-pipe-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
            .crm-pipe-name-link { cursor: pointer; }
            .crm-pipe-name-link:hover { text-decoration: underline; color: var(--brand-primary, #8e631f); }
            .crm-pipe-meta { color: var(--color-text-dim); font-size: 11px; }
            .crm-pipe-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
            .crm-pipe-tag {
                padding: 1px 8px; border-radius: 8px; font-size: 10px; font-weight: 700;
            }
            .crm-pipe-tag.catering { background: var(--color-sentiment-pos-bg); color: var(--color-sentiment-pos); }
            .crm-pipe-tag.festival { background: var(--color-sentiment-neu-bg); color: var(--color-sentiment-neu); }
            .crm-pipe-tag.produktion { background: #EEF0FB; color: #5B5EA6; }
            .crm-pipe-tag.store { background: var(--brand-primary-light); color: var(--brand-primary); }
            .crm-pipe-pax { font-size: 11px; color: var(--color-text-dim); }

            /* Drag & drop */
            .crm-pipe-card[draggable="true"] { cursor: grab; }
            .crm-pipe-card.dragging { opacity: 0.4; transform: scale(0.95); }
            .crm-pipe-col.drag-over { background: var(--brand-primary-light, #f1e6b2); border-radius: 8px; }
            .crm-pipe-drop-zone {
                min-height: 40px; border: 2px dashed transparent; border-radius: 8px;
                transition: border-color .15s, background .15s;
            }
            .crm-pipe-col.drag-over .crm-pipe-drop-zone {
                border-color: var(--brand-primary, #8e631f);
                background: rgba(142,99,31,0.05);
            }

            /* Callbacks panel */
            .crm-cb-item {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 0; border-bottom: 1px solid var(--color-border, #eee);
            }
            .crm-cb-item:last-child { border-bottom: none; }
            .crm-cb-av {
                width: 32px; height: 32px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
            }
            .crm-cb-av.av-0 { background: linear-gradient(135deg, #2E9E6B, #1a7a50); }
            .crm-cb-av.av-1 { background: linear-gradient(135deg, #C8962A, #a07020); }
            .crm-cb-av.av-2 { background: linear-gradient(135deg, #8a8580, #6b6560); }
            .crm-cb-info { flex: 1; min-width: 0; }
            .crm-cb-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .crm-cb-company { font-size: 11px; color: var(--color-text-dim); }
            .crm-cb-badge {
                padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700;
                white-space: nowrap; flex-shrink: 0;
            }
            .crm-cb-badge.urgent { background: var(--color-sentiment-neg-bg); color: var(--color-sentiment-neg); }
            .crm-cb-badge.today { background: var(--color-sentiment-neu-bg); color: var(--color-sentiment-neu); }

            /* Mine opfølgninger (Fase 4) */
            .crm-fu-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .crm-fu-head h3 { margin: 0; }
            .crm-fu-ringeliste {
                background: none; border: none; color: var(--brand-primary, #8e631f);
                font-size: 12px; font-weight: 700; cursor: pointer; padding: 0; white-space: nowrap;
            }
            .crm-fu-ringeliste:hover { text-decoration: underline; }
            .crm-fu-item {
                display: flex; align-items: center; gap: 10px;
                padding: 9px 0; border-bottom: 1px solid var(--color-border, #eee);
            }
            .crm-fu-item:last-child { border-bottom: none; }
            .crm-fu-info { flex: 1; min-width: 0; }
            .crm-fu-name-row { display: flex; align-items: baseline; gap: 8px; }
            .crm-fu-name { font-size: 13px; font-weight: 600; }
            .crm-fu-company { font-size: 11px; color: var(--color-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .crm-fu-text { font-size: 12px; color: var(--color-text); margin-top: 1px; }
            .crm-fu-bon {
                display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 700;
                color: #3a6a9a; background: #e8f0f7; border-radius: 8px; padding: 0 6px;
            }
            .crm-fu-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
            .crm-fu-kilde { padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 700; white-space: nowrap; }
            .crm-fu-kilde.planlagt { background: var(--color-sentiment-neu-bg, #FBF3E2); color: var(--color-sentiment-neu, #C8962A); }
            .crm-fu-kilde.service { background: #e0ecf5; color: #2a6fb0; }
            .crm-fu-time { font-size: 11px; font-weight: 700; color: var(--color-text-dim); white-space: nowrap; }
            .crm-fu-time.overdue { color: var(--color-sentiment-neg, #C94040); }
            .crm-fu-time.overdue::before { content: "⚑ "; }
            .crm-fu-ring {
                flex-shrink: 0; font-size: 11px; font-weight: 700; text-decoration: none;
                color: var(--brand-primary, #8e631f); border: 1px solid var(--color-border);
                border-radius: 6px; padding: 4px 8px;
            }
            .crm-fu-ring:hover { background: var(--brand-primary-light, #f1e6b2); }

            /* Activity feed */
            .crm-act-item {
                display: flex; align-items: flex-start; gap: 10px;
                padding: 6px 0; font-size: 12px;
            }
            .crm-act-dot {
                width: 8px; height: 8px; border-radius: 50%;
                margin-top: 4px; flex-shrink: 0;
            }
            .crm-act-dot.dot-green { background: var(--color-sentiment-pos); }
            .crm-act-dot.dot-gold { background: var(--color-sentiment-neu); }
            .crm-act-dot.dot-gray { background: var(--color-text-dim); }
            .crm-act-dot.dot-red { background: var(--color-sentiment-neg); }
            .crm-act-text { flex: 1; color: var(--color-text); }
            .crm-act-type { font-weight: 600; }
            .crm-act-time { font-size: 10px; color: var(--color-text-dim, #aaa); white-space: nowrap; }

            /* Service calls */
            .crm-svc-header {
                display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
            }
            .crm-svc-header select {
                padding: 4px 8px; border-radius: 6px; border: 1px solid var(--color-border, #ddd);
                font-size: 12px; background: var(--color-surface, #fff); font-family: inherit;
            }
            .crm-svc-header .crm-svc-label {
                font-size: 12px; color: var(--color-text-dim, #888);
            }
            .crm-svc-header .crm-svc-count {
                margin-left: auto; font-size: 12px; font-weight: 700;
                color: var(--brand-primary, #8e631f);
            }
            .crm-svc-item {
                border: 1px solid var(--color-border, #eee); border-radius: 8px;
                padding: 10px 12px; margin-bottom: 8px;
                transition: border-color .15s;
            }
            .crm-svc-item:hover { border-color: var(--brand-primary, #8e631f); }
            .crm-svc-top {
                display: grid; grid-template-columns: auto 1fr auto auto auto;
                gap: 8px; align-items: center; font-size: 13px;
            }
            .crm-svc-bon { font-weight: 600; color: var(--brand-primary, #8e631f); }
            .crm-svc-customer { cursor: pointer; }
            .crm-svc-customer:hover { text-decoration: underline; }
            .crm-svc-meta { font-size: 11px; color: var(--color-text-dim, #888); white-space: nowrap; }
            .crm-svc-last-sent {
                display: inline-block; padding: 1px 6px; border-radius: 10px;
                font-size: 13px; line-height: 1; vertical-align: middle;
                border: 1px solid transparent; cursor: help;
            }
            .crm-svc-last-sent.s-positive { background: var(--color-sentiment-pos-bg, #E6F7F0); border-color: var(--color-sentiment-pos, #2E9E6B); }
            .crm-svc-last-sent.s-neutral  { background: var(--color-sentiment-neu-bg, #FBF3E2); border-color: var(--color-sentiment-neu, #C8962A); }
            .crm-svc-last-sent.s-negative { background: var(--color-sentiment-neg-bg, #FBE9E9); border-color: var(--color-sentiment-neg, #C94040); }
            .crm-svc-days { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 700; white-space: nowrap; }
            .crm-svc-days.d-ok { background: #e8f2dc; color: #3d7a0a; }
            .crm-svc-days.d-warn { background: #fef3cd; color: #856404; }
            .crm-svc-days.d-late { background: #fde8e8; color: #c94040; }
            .crm-svc-actions { display: flex; gap: 4px; align-items: center; }
            .crm-svc-action-btn {
                display: inline-flex; align-items: center; justify-content: center;
                padding: 4px 10px; border-radius: 6px;
                border: 1px solid var(--color-border, #ddd);
                background: transparent; text-decoration: none;
                font-size: 12px; cursor: pointer; transition: all .12s;
                font-family: inherit; white-space: nowrap; color: inherit;
            }
            .crm-svc-action-btn:hover {
                background: var(--brand-primary-light, #f1e6b2);
                border-color: var(--brand-primary, #8e631f);
            }
            .crm-svc-action-btn.primary {
                background: var(--brand-primary, #8e631f); color: #fff; border-color: transparent;
            }
            .crm-svc-action-btn.primary:hover { filter: brightness(1.1); }
            .crm-svc-action-btn.success {
                background: var(--color-sentiment-pos, #2E9E6B); color: #fff; border-color: transparent;
            }
            .crm-svc-action-btn.success:hover { filter: brightness(1.1); }
            .crm-svc-expand { cursor: pointer; font-size: 11px; color: var(--color-text-dim, #888); }
            .crm-svc-expand:hover { color: var(--brand-primary, #8e631f); }
            .crm-svc-orders {
                margin-top: 10px; padding-top: 10px;
                border-top: 1px solid var(--color-border, #eee);
            }
            .crm-svc-order {
                margin-bottom: 8px; font-size: 12px;
            }
            .crm-svc-order-head {
                display: flex; align-items: center; gap: 8px; margin-bottom: 3px;
            }
            .crm-svc-order-bon { font-family: monospace; font-weight: 700; color: var(--brand-primary, #8e631f); font-size: 12px; }
            .crm-svc-order-lines {
                padding-left: 12px; border-left: 2px solid var(--brand-primary-light, #f1e6b2);
            }
            .crm-svc-order-line { padding: 1px 0; color: #555; font-size: 12px; }
            .crm-svc-order-qty { color: var(--brand-primary, #8e631f); font-weight: 700; }
            .crm-svc-order-extra { color: var(--color-text-dim, #aaa); font-style: italic; }
            /* Log form */
            .crm-svc-logform {
                margin-top: 10px; padding: 12px;
                border-top: 1px solid var(--color-border, #eee);
                background: var(--color-background, #f5f4f2); border-radius: 0 0 8px 8px;
            }
            .crm-svc-logform label { font-size: 11px; font-weight: 700; color: var(--color-text-dim, #888); text-transform: uppercase; letter-spacing: .3px; }
            .crm-svc-result-btns { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0 10px; }
            .crm-svc-result-btn {
                padding: 4px 10px; border-radius: 16px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 11px; cursor: pointer; font-family: inherit;
                transition: all .12s;
            }
            .crm-svc-result-btn:hover { border-color: var(--brand-primary, #8e631f); }
            .crm-svc-result-btn.active { background: var(--brand-primary, #8e631f); color: #fff; border-color: transparent; }
            .crm-svc-sentiment-btns { display: flex; gap: 6px; margin: 6px 0 10px; }
            .crm-svc-sentiment-btn {
                padding: 4px 10px; border-radius: 16px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 12px; cursor: pointer;
                transition: all .12s;
            }
            .crm-svc-sentiment-btn:hover { border-color: var(--brand-primary, #8e631f); }
            .crm-svc-sentiment-btn.active { border-width: 2px; }
            .crm-svc-sentiment-btn.active[data-s="positive"] { border-color: var(--color-sentiment-pos, #2E9E6B); background: var(--color-sentiment-pos-bg, #e8f2dc); }
            .crm-svc-sentiment-btn.active[data-s="neutral"] { border-color: var(--color-sentiment-neu, #C8962A); background: var(--color-sentiment-neu-bg, #fef3cd); }
            .crm-svc-sentiment-btn.active[data-s="negative"] { border-color: var(--color-sentiment-neg, #C94040); background: var(--color-sentiment-neg-bg, #fde8e8); }
            .crm-svc-logform textarea {
                width: 100%; padding: 6px 8px; border: 1px solid var(--color-border, #ddd);
                border-radius: 6px; font-size: 12px; font-family: inherit; resize: vertical;
                min-height: 40px; box-sizing: border-box;
            }
            .crm-svc-logform-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

            .crm-empty { text-align: center; padding: 20px; color: var(--color-text-dim, #aaa); font-size: 13px; }

            /* ══ CLICKABLE ══════════════════════════════════════════ */
            .crm-clickable { cursor: pointer; transition: background-color .12s, transform .08s; }
            .crm-clickable:hover { background-color: rgba(142,99,31,0.06); }
            .crm-clickable:active { transform: translateY(1px); }
        </style>

        <div class="crm-grid">
            <div class="crm-kpi-strip" id="crmKpiStrip"></div>

            <div class="crm-card" id="crmBriefing">
                <h3>Daglig briefing</h3>
                <div id="crmBriefingList"></div>
            </div>

            <div class="crm-card" id="crmCallbacksPanel">
                <div class="crm-fu-head">
                    <h3>🔔 Mine opfølgninger</h3>
                    <button class="crm-fu-ringeliste" type="button" onclick="_crmGotoRingeliste()">Se ringeliste →</button>
                </div>
                <div id="crmCallbacksList"></div>
            </div>

            <div class="crm-card" style="grid-column: 1 / -1;" id="crmServiceCalls">
                <h3>📞 Service-kald</h3>
                <div class="crm-svc-header">
                    <span class="crm-svc-label">Leveringer fra de seneste</span>
                    <select id="crmSvcDaysSelect" onchange="_crmChangeSvcDays(+this.value)">
                        <option value="7">7 dage</option>
                        <option value="10">10 dage</option>
                        <option value="14">14 dage</option>
                        <option value="21">21 dage</option>
                        <option value="30">30 dage</option>
                    </select>
                    <span class="crm-svc-count" id="crmSvcCount"></span>
                </div>
                <div id="crmServiceCallsList"></div>
            </div>

            <div class="crm-card" style="grid-column: 1 / -1;" id="crmMeetings">
                <h3>🤝 Kommende bookede møder</h3>
                <div id="crmMeetingsList"></div>
            </div>

            <div class="crm-card" id="crmActivityPanel">
                <h3>🔀 Seneste aktivitet</h3>
                <div id="crmActivityList"></div>
            </div>

            <div class="crm-card crm-pipeline" id="crmPipeline">
                <h3>Pipeline</h3>
                <div class="crm-pipe-filters" id="crmPipeFilters">
                    <button class="crm-pipe-filter active" data-cat="">Alle</button>
                    <button class="crm-pipe-filter" data-cat="catering">Catering</button>
                    <button class="crm-pipe-filter" data-cat="festival">Festival</button>
                    <button class="crm-pipe-filter" data-cat="produktion">Produktion</button>
                </div>
                <div class="crm-pipe-board" id="crmPipeBoard"></div>
            </div>

            <div class="crm-card" id="crmSuggestions">
                <div class="crm-card-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <h3 style="margin:0;display:flex;align-items:center;gap:6px;">Smart forslag
                        <button id="crmSugInfoBtn" type="button" title="Hvordan laves forslagene?"
                                onclick="_crmToggleSugInfo()"
                                style="width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:1px solid var(--color-border,#d7d1ca);background:var(--color-surface,#fff);color:var(--color-text-dim,#888);font-size:11px;cursor:pointer;font-family:inherit;padding:0;">ⓘ</button>
                    </h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button id="crmSnoozedBtn" type="button" onclick="_crmToggleSnoozedPanel()"
                                style="display:none;padding:6px 12px;border-radius:8px;border:1px solid var(--color-border,#d7d1ca);background:var(--color-surface,#fff);color:var(--color-text-dim,#888);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;"></button>
                        <button class="crm-sug-action-btn" id="crmReactivateBtn" type="button"
                                style="padding:6px 12px;border-radius:8px;border:1px solid var(--brand-primary,#8e631f);background:var(--color-surface,#fff);color:var(--brand-primary,#8e631f);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">
                            🔄 Reaktivér sovende
                        </button>
                    </div>
                </div>
                <div id="crmSugInfo" style="display:none;margin-bottom:12px;padding:12px 14px;background:var(--brand-primary-light,#f1e6b2);border-radius:8px;font-size:12.5px;line-height:1.55;color:var(--color-text,#3a2f25);">
                    <strong>Sådan laves forslagene:</strong> de genereres automatisk ud fra dine kunder og bons — ingen manuel kuration. Seks typer indgår:
                    <ul style="margin:8px 0 0;padding-left:18px;">
                        <li>📞 <strong>Forsinket</strong> — fast kunde der er over sit normale bestillingsinterval</li>
                        <li>⭐ <strong>Anbefaling</strong> — kunde med en frisk positiv stemning (godt øjeblik at bede om en anmeldelse/henvisning)</li>
                        <li>📅 <strong>Sæson</strong> — bestilte på denne tid sidste år, intet for nylig</li>
                        <li>🆕 <strong>Nyt lead</strong> — oprettet men endnu ikke kontaktet</li>
                        <li>💤 <strong>Sovende</strong> — højværdikunde uden ordre i lang tid</li>
                        <li>🧾 <strong>Udløbende tilbud</strong> — tilbud der snart udløber</li>
                    </ul>
                    Listen <strong>blander typerne</strong> (round-robin), så ingen type fylder det hele. Et forslag <strong>forsvinder når du har handlet på det</strong> — og du kan <strong>skjule</strong> et kort i 14 dage med “🙈 Skjul”, så de næste i køen kommer til.
                    <div id="crmReviewStat" style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08);"></div>
                </div>
                <div id="crmSnoozedPanel" style="display:none;margin-bottom:12px;"></div>
                <div id="crmSuggestionsList"></div>
            </div>
        </div>
    `;

    // Pipeline filter clicks
    document.getElementById('crmPipeFilters')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.crm-pipe-filter');
        if (!btn) return;
        document.querySelectorAll('.crm-pipe-filter').forEach(b => b.classList.toggle('active', b === btn));
        _crmLoadPipeline(btn.dataset.cat || '');
    });

    // Reaktivér sovende (Fase 5): åbner modal med filtre + opretter kampagne
    document.getElementById('crmReactivateBtn')?.addEventListener('click', _crmOpenReactivateModal);
}

// ─── Data loading ───────────────────────────────────────────

async function _crmLoadData() {
    if (!_crmActive) return;

    try {
        const [stats, briefing, suggestions, serviceCalls, followups, callLog, meetings, snoozed, reviewStat] = await Promise.all([
            fetchCrmStats(),
            fetchCrmBriefing(),
            fetchCrmSuggestions(),
            fetchCrmServiceCalls(7),
            fetchCrmFollowups(),
            fetchCrmCallLog({ limit: 6 }),
            fetchCrmUpcomingMeetings({ days: 30, limit: 10 }),
            fetchSnoozedSuggestions().catch(() => []),
            fetchReviewStats().catch(() => null),
        ]);

        _crmRenderKPIs(stats);
        _crmRenderBriefing(briefing);
        _crmRenderSuggestions(suggestions);
        _crmRenderSnoozedButton(snoozed);
        _crmRenderReviewStat(reviewStat);
        _crmRenderServiceCalls(serviceCalls);
        _crmRenderFollowups(followups);
        _crmRenderUpcomingMeetings(meetings);
        _crmRenderActivityFeed(Array.isArray(callLog) ? callLog : (callLog.rows || []));
        _crmLoadPipeline('');
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
        { label: 'Service-kald', value: stats.service_calls_pending, warn: stats.service_calls_pending > 0, scroll: 'crmServiceCalls' },
        { label: 'Callbacks',    value: stats.callbacks_pending,     warn: stats.callbacks_pending > 0,     scroll: 'crmCallbacksPanel' },
        { label: 'Svær at nå',   value: stats.hard_to_reach,         warn: stats.hard_to_reach > 0,         scroll: 'crmCallbacksPanel' },
        { label: 'Reach rate',   value: stats.reach_rate + '%',      warn: false, green: parseInt(stats.reach_rate) > 60 },
        { label: 'Bons i dag',   value: stats.bons_today,            warn: false, goto: 'bons', filter: 'today' },
    ];

    el.innerHTML = kpis.map(k => {
        const clickable = (k.scroll || k.goto) ? ' crm-clickable' : '';
        const attrs = [];
        if (k.scroll) attrs.push('data-scroll="' + k.scroll + '"');
        if (k.goto)   attrs.push('data-goto="' + k.goto + '"');
        if (k.filter) attrs.push('data-filter="' + k.filter + '"');
        return '<div class="crm-kpi' + clickable + '" ' + attrs.join(' ') + '>' +
            '<div class="crm-kpi-value' + (k.warn ? ' warn' : k.green ? ' green' : '') + '">' + k.value + '</div>' +
            '<div class="crm-kpi-label">' + k.label + '</div>' +
        '</div>';
    }).join('') +
    '<div class="crm-kpi crm-clickable" style="opacity:0.7" data-view="crm-kundeindsigt" title="Åbn Kundeindsigt">' +
        '<div class="crm-kpi-value" style="font-size:16px">📊</div>' +
        '<div class="crm-kpi-label">Kundeindsigt</div>' +
    '</div>';
}

function _crmRenderBriefing(items) {
    const el = document.getElementById('crmBriefingList');
    if (!el) return;

    if (!items.length) {
        el.innerHTML = '<div class="crm-empty">Ingen briefing-punkter i dag</div>';
        return;
    }

    const linkToScroll = {
        svc:         'crmServiceCalls',
        callbacks:   'crmCallbacksPanel',
        meetings:    'crmMeetings',
        suggestions: 'crmSuggestions',
    };
    el.innerHTML = items.map(item => {
        let attrs = '';
        let clickable = '';
        if (item.customer_id) {
            attrs = ' data-customer-id="' + item.customer_id + '" title="Åbn kundeprofil"';
            clickable = ' crm-clickable';
        } else if (item.nav) {
            // Navigér til en anden CRM-sektion (fx Ringeliste), evt. på en bestemt fane
            attrs = ' data-nav="' + item.nav + '"' + (item.navTab ? ' data-nav-tab="' + item.navTab + '"' : '') + ' title="Åbn liste"';
            clickable = ' crm-clickable';
        } else if (linkToScroll[item.link]) {
            attrs = ' data-scroll="' + linkToScroll[item.link] + '"';
            clickable = ' crm-clickable';
        }
        return '<div class="crm-briefing-item' + clickable + '"' + attrs + '>' +
            '<span class="crm-briefing-icon">' + item.icon + '</span>' +
            '<span>' + item.text + '</span>' +
            '<span class="crm-briefing-type ' + item.type + '">' + item.type + '</span>' +
        '</div>';
    }).join('');
}

function _crmRenderSuggestions(suggestions) {
    const el = document.getElementById('crmSuggestionsList');
    if (!el) return;

    if (!suggestions.length) {
        el.innerHTML = '<div class="crm-empty">Ingen forslag lige nu — godt arbejde!</div>';
        return;
    }

    el.innerHTML = suggestions.slice(0, 8).map(s => {
        const ring = s.phone ? '<a class="crm-sug-btn primary" href="tel:' + s.phone.replace(/\s/g, '') + '">📞 Ring</a>' : '';
        // 'review' → log at vi har spurgt (kortet forsvinder via dedupe ved næste reload);
        // alle andre forslag → åbn profil.
        // "Skjul" snoozer (kunde + type) i 14 dage → frigør slotten så andre roterer ind.
        const skjul = '<button class="crm-sug-btn" title="Skjul dette forslag i 14 dage" onclick="_crmSnoozeSuggestion(' + s.customer_id + ', \'' + s.type + '\')">🙈 Skjul</button>';
        const actionBtns = (s.action === 'review'
            ? ring + '<button class="crm-sug-btn" onclick="_crmReviewPick(this, ' + s.customer_id + ')">⭐ Spurgt…</button>'
            : ring + '<button class="crm-sug-btn" onclick="_crmOpenKunde(' + s.customer_id + ')">👤 Profil</button>') + skjul;
        return '<div class="crm-suggestion" data-customer-id="' + s.customer_id + '">' +
            '<div class="crm-sug-header">' +
                '<span class="crm-sug-icon">' + s.icon + '</span>' +
                '<span class="crm-sug-title">' + s.title + '</span>' +
            '</div>' +
            '<div class="crm-sug-detail">' + s.detail + '</div>' +
            '<div class="crm-sug-reason">' + s.reason + '</div>' +
            '<div class="crm-sug-actions">' + actionBtns + '</div>' +
        '</div>';
    }).join('');
}

function _crmRenderServiceCalls(calls) {
    const el = document.getElementById('crmServiceCallsList');
    if (!el) return;

    // Update count badge
    const countEl = document.getElementById('crmSvcCount');
    if (countEl) countEl.textContent = calls.length ? calls.length + ' ventende' : '';

    if (!calls.length) {
        el.innerHTML = '<div class="crm-empty">🎉 Alle service-kald er håndteret!</div>';
        return;
    }

    const sentimentEmojiMap = { positive: '😊', neutral: '😐', negative: '😟' };
    const sentimentLabelMap = { positive: 'Seneste: God', neutral: 'Seneste: Neutral', negative: 'Seneste: Dårlig' };

    el.innerHTML = calls.map((c, i) => {
        const phone = (c.customer_phone || '').replace(/\s/g, '');
        const email = c.customer_email || '';
        const d = c.days_since_delivery || 0;
        const dClass = d <= 3 ? 'd-ok' : d <= 7 ? 'd-warn' : 'd-late';
        const dLabel = d === 0 ? 'I dag' : d === 1 ? '1 dag' : d + ' dage';
        const paxUnits = [];
        if (c.pax) paxUnits.push(c.pax + ' pax');
        if (c.total_units) paxUnits.push(c.total_units + ' enh.');
        const priceStr = c.total_price ? Math.round(c.total_price).toLocaleString('da-DK') + ' kr' : '';
        const lastSentEmoji = sentimentEmojiMap[c.last_sentiment] || '';
        const lastSentLabel = sentimentLabelMap[c.last_sentiment] || '';
        const lastSentDate = c.last_sentiment_at ? (' (' + c.last_sentiment_at.substring(0, 10) + ')') : '';

        return '<div class="crm-svc-item" id="crmSvc' + i + '">' +
            '<div class="crm-svc-top">' +
                '<span class="crm-svc-bon">#' + c.bon_number + '</span>' +
                '<span>' +
                    '<span class="crm-svc-customer" onclick="_crmOpenKunde(' + c.customer_id + ')">' +
                        c.customer_name + (c.company_name ? ' · ' + c.company_name : '') +
                    '</span>' +
                    (lastSentEmoji ?
                        ' <span class="crm-svc-last-sent s-' + c.last_sentiment + '" title="' + lastSentLabel + lastSentDate + '">' +
                            lastSentEmoji +
                        '</span>' : '') +
                    (paxUnits.length || priceStr ?
                        '<span class="crm-svc-meta" style="margin-left:8px;">' +
                            (paxUnits.join(' / ') + (priceStr ? ' · ' + priceStr : '')) +
                        '</span>' : '') +
                '</span>' +
                '<span class="crm-svc-days ' + dClass + '">' + dLabel + '</span>' +
                '<span class="crm-svc-actions">' +
                    (phone ?
                        '<a href="tel:' + phone + '" class="crm-svc-action-btn primary" onclick="_crmRingOgLog(event,' + i + ',' + c.customer_id + ',' + (c.bon_id || 'null') + ')">📞 Ring</a>' :
                        '<button class="crm-svc-action-btn primary" onclick="_crmOpenLogForm(' + i + ',' + c.customer_id + ',' + (c.bon_id || 'null') + ')" title="Intet telefonnummer">📞 Log</button>') +
                    '<button class="crm-svc-action-btn success" onclick="_crmMarkHandled(' + c.customer_id + ',' + (c.bon_id || 'null') + ')" title="Markér håndteret">✓</button>' +
                    (email ? '<a href="mailto:' + email + '" class="crm-svc-action-btn" title="Send mail">📧</a>' : '') +
                '</span>' +
                '<span class="crm-svc-expand" onclick="_crmToggleOrders(' + c.customer_id + ',' + i + ')">' +
                    '▼ ordrer' +
                '</span>' +
            '</div>' +
            '<div id="crmSvcOrders' + i + '" style="display:none;"></div>' +
            '<div id="crmSvcLogForm' + i + '" style="display:none;"></div>' +
        '</div>';
    }).join('');
}

async function _crmChangeSvcDays(days) {
    _crmSvcDays = days;
    _crmReloadServiceCalls();
}

async function _crmReloadServiceCalls() {
    if (!_crmActive) return;
    try {
        const calls = await fetchCrmServiceCalls(_crmSvcDays);
        _crmRenderServiceCalls(calls);
    } catch (err) {
        console.error('[crm] Service calls reload error:', err);
    }
}

async function _crmToggleOrders(customerId, idx) {
    const el = document.getElementById('crmSvcOrders' + idx);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = '<div class="crm-svc-orders"><span style="font-size:12px;color:var(--color-text-dim);">Henter ordrer...</span></div>';
    try {
        const orders = await fetchCrmCustomerOrders(customerId, 5);
        if (!orders.length) {
            el.innerHTML = '<div class="crm-svc-orders"><span style="font-size:12px;color:var(--color-text-dim);">Ingen tidligere ordrer</span></div>';
            return;
        }
        el.innerHTML = '<div class="crm-svc-orders">' + orders.map(o => {
            const statusLabel = o.status_label || o.status || '';
            return '<div class="crm-svc-order">' +
                '<div class="crm-svc-order-head">' +
                    '<span class="crm-svc-order-bon">' + (o.bon_number || '') + '</span>' +
                    '<span style="font-size:12px;color:var(--color-text-dim);">' + (o.delivery_date || '') + '</span>' +
                    (o.pax ? '<span style="font-size:12px;">' + o.pax + ' pax</span>' : '') +
                    '<span style="font-size:13px;font-weight:700;margin-left:auto;">' +
                        (o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '') +
                    '</span>' +
                    (statusLabel ? '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--color-background);font-weight:700;">' + statusLabel + '</span>' : '') +
                '</div>' +
                (o.lines && o.lines.length ? '<div class="crm-svc-order-lines">' +
                    o.lines.map(l =>
                        '<div class="crm-svc-order-line">' +
                            '<span class="crm-svc-order-qty">' + l.quantity + '×</span> ' +
                            (l.product_name || '') +
                            (l.special_request ? ' <span class="crm-svc-order-extra"> — ' + l.special_request + '</span>' : '') +
                        '</div>'
                    ).join('') +
                '</div>' : '') +
            '</div>';
        }).join('') + '</div>';
    } catch (err) {
        el.innerHTML = '<div class="crm-svc-orders"><span style="font-size:12px;color:var(--color-sentiment-neg);">Fejl: ' + (err.message || 'ukendt') + '</span></div>';
    }
}

function _crmRingOgLog(event, idx, customerId, bonId) {
    // tel: link opens natively (FaceTime/Phone on Mac), then open log form
    _crmOpenLogForm(idx, customerId, bonId);
}

function _crmOpenLogForm(idx, customerId, bonId) {
    const el = document.getElementById('crmSvcLogForm' + idx);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML =
        '<div class="crm-svc-logform">' +
            '<label>Resultat</label>' +
            '<div class="crm-svc-result-btns">' +
                '<button class="crm-svc-result-btn" data-r="reached" onclick="_crmSelResult(this)">✓ Svar</button>' +
                '<button class="crm-svc-result-btn" data-r="no_answer" onclick="_crmSelResult(this)">✗ Intet svar</button>' +
                '<button class="crm-svc-result-btn" data-r="busy" onclick="_crmSelResult(this)">📵 Optaget</button>' +
                '<button class="crm-svc-result-btn" data-r="voicemail" onclick="_crmSelResult(this)">📩 Besked</button>' +
                '<button class="crm-svc-result-btn" data-r="callback" onclick="_crmSelResult(this)">⏎ Callback</button>' +
                '<button class="crm-svc-result-btn" data-r="email_instead" onclick="_crmSelResult(this)">' + mailIcon(12) + ' Mail</button>' +
            '</div>' +
            '<div id="crmSvcSentiment' + idx + '">' +
                '<label>Stemning <span style="font-weight:400;text-transform:none;letter-spacing:0;opacity:.7;">(valgfrit)</span></label>' +
                '<div class="crm-svc-sentiment-btns">' +
                    '<button class="crm-svc-sentiment-btn" data-s="positive" onclick="_crmSelSentiment(this)">😊 God</button>' +
                    '<button class="crm-svc-sentiment-btn" data-s="neutral" onclick="_crmSelSentiment(this)">😐 Neutral</button>' +
                    '<button class="crm-svc-sentiment-btn" data-s="negative" onclick="_crmSelSentiment(this)">😟 Dårlig</button>' +
                '</div>' +
            '</div>' +
            '<label style="margin-top:6px;display:block;">Note</label>' +
            '<textarea id="crmSvcNote' + idx + '" placeholder="Valgfrit..."></textarea>' +
            '<div class="crm-svc-logform-actions">' +
                '<button class="crm-svc-action-btn" onclick="document.getElementById(\'crmSvcLogForm' + idx + '\').style.display=\'none\'">Annuller</button>' +
                '<button class="crm-svc-action-btn primary" id="crmSvcSaveBtn' + idx + '" disabled onclick="_crmSaveLog(' + idx + ',' + customerId + ',' + bonId + ')">Gem</button>' +
            '</div>' +
        '</div>';
}

function _crmSelResult(btn) {
    const container = btn.closest('.crm-svc-logform');
    if (!container) return;
    container.querySelectorAll('.crm-svc-result-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Sentiment er altid tilgængeligt — uanset resultat-valg
    const saveBtn = container.querySelector('[id^="crmSvcSaveBtn"]');
    if (saveBtn) saveBtn.disabled = false;
}

function _crmSelSentiment(btn) {
    const container = btn.closest('.crm-svc-sentiment-btns');
    if (!container) return;
    container.querySelectorAll('.crm-svc-sentiment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function _crmSaveLog(idx, customerId, bonId) {
    const container = document.getElementById('crmSvcLogForm' + idx);
    if (!container) return;
    const resultBtn = container.querySelector('.crm-svc-result-btn.active');
    if (!resultBtn) return;
    const result = resultBtn.dataset.r;
    const sentimentBtn = container.querySelector('.crm-svc-sentiment-btn.active');
    const sentiment = sentimentBtn ? sentimentBtn.dataset.s : null;
    const note = (document.getElementById('crmSvcNote' + idx) || {}).value || '';

    const saveBtn = document.getElementById('crmSvcSaveBtn' + idx);
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Gemmer...'; }

    try {
        const data = {
            customer_id: customerId,
            type: 'service_call',
            result: result,
            text: note || undefined,
        };
        if (bonId) data.bon_id = bonId;
        if (sentiment) data.sentiment = sentiment;
        await postCrmActivity(data);
        // Reload service calls
        _crmReloadServiceCalls();
    } catch (err) {
        console.error('[crm] Save log error:', err);
        alert('Kunne ikke gemme: ' + (err.message || 'Ukendt fejl'));
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Gem'; }
    }
}

async function _crmMarkHandled(customerId, bonId) {
    try {
        const data = {
            customer_id: customerId,
            type: 'service_call',
            result: 'reached',
            text: 'Markeret håndteret (hurtig)',
        };
        if (bonId) data.bon_id = bonId;
        await postCrmActivity(data);
        _crmReloadServiceCalls();
    } catch (err) {
        console.error('[crm] Mark handled error:', err);
        alert('Kunne ikke markere: ' + (err.message || 'Ukendt fejl'));
    }
}

// CRM-trik A (outcome-måling): "⭐ Spurgt…" folder en lille udfalds-vælger ud i
// kortet, så vi fanger hvad kunden svarede (vil anmelde / måske / nej). Det er
// det der gør at vi senere kan se om trikket virker.
function _crmReviewPick(btn, customerId) {
    const actions = btn.closest('.crm-suggestion')?.querySelector('.crm-sug-actions');
    if (!actions) return;
    actions.innerHTML =
        '<span style="font-size:12px;color:var(--color-text-dim,#888);align-self:center;">Hvad sagde de?</span>' +
        '<button class="crm-sug-btn primary" onclick="_crmLogReview(' + customerId + ', \'success\')">👍 Vil anmelde</button>' +
        '<button class="crm-sug-btn" onclick="_crmLogReview(' + customerId + ', \'pending\')">🤷 Måske</button>' +
        '<button class="crm-sug-btn" onclick="_crmLogReview(' + customerId + ', \'declined\')">👎 Nej</button>' +
        '<button class="crm-sug-btn" title="Fortryd" onclick="_crmLoadData()">✕</button>';
}

// Log anbefalings-aktiviteten med udfald. Purpose 'anbefaling' dedupe'r kortet væk;
// outcome måler effekten. SSE crm_activity_created → _crmLoadData genindlæser feeden.
async function _crmLogReview(customerId, outcome) {
    const LABELS = { success: 'vil anmelde', pending: 'måske/senere', declined: 'nej tak' };
    try {
        const purposes = await fetchActivityPurposes();
        const p = (purposes || []).find(x => x.key === 'anbefaling');
        await postCrmActivity({
            customer_id: customerId,
            type: 'note',
            text: 'Bedt om anbefaling — ' + (LABELS[outcome] || outcome),
            purpose_id: p ? p.id : null,
            outcome: outcome,
        });
        _crmLoadData();
    } catch (err) {
        console.error('[crm] Log review error:', err);
        alert('Kunne ikke logge: ' + (err.message || 'Ukendt fejl'));
        _crmLoadData();
    }
}

// Fold info-panelet om hvordan forslagene laves ind/ud.
function _crmToggleSugInfo() {
    const el = document.getElementById('crmSugInfo');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// Skjul (snooze) et forslag i 14 dage — kun denne kunde + denne type. Frigør
// slotten så de næste i køen roterer ind. Optimistisk: fjern kortet straks,
// genindlæs derefter så et nyt forslag fylder pladsen.
async function _crmSnoozeSuggestion(customerId, type) {
    try {
        const card = document.querySelector('.crm-suggestion[data-customer-id="' + customerId + '"]');
        if (card) card.style.opacity = '0.4';
        await snoozeSuggestion({ customer_id: customerId, type: type });
        _crmLoadData();
    } catch (err) {
        console.error('[crm] Snooze error:', err);
        alert('Kunne ikke skjule: ' + (err.message || 'Ukendt fejl'));
        _crmLoadData();
    }
}

// "N skjult"-knap: vises kun når der er aktive snoozes.
let _crmSnoozedCache = [];
function _crmRenderSnoozedButton(list) {
    _crmSnoozedCache = Array.isArray(list) ? list : [];
    const btn = document.getElementById('crmSnoozedBtn');
    if (!btn) return;
    if (_crmSnoozedCache.length === 0) {
        btn.style.display = 'none';
        const panel = document.getElementById('crmSnoozedPanel');
        if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    } else {
        btn.style.display = '';
        btn.textContent = '🙈 ' + _crmSnoozedCache.length + ' skjult';
    }
}

// Outcome-måling (CRM-trik A): vis hvor godt anbefalings-trikket virker i ⓘ-panelet.
function _crmRenderReviewStat(stat) {
    const el = document.getElementById('crmReviewStat');
    if (!el) return;
    if (!stat || !stat.asked) {
        el.innerHTML = '<span style="color:var(--color-text-dim,#888);">📊 Anbefalinger (180 dage): endnu ingen registreret.</span>';
        return;
    }
    el.innerHTML = '📊 <strong>Anbefalinger (180 dage):</strong> ' + stat.asked + ' spurgt · ' +
        (stat.success || 0) + ' vil anmelde · ' + (stat.declined || 0) + ' nej · ' + (stat.pending || 0) + ' afventer';
}

// Fold listen over skjulte forslag ind/ud (hver med "Vis igen"-fortryd).
function _crmToggleSnoozedPanel() {
    const panel = document.getElementById('crmSnoozedPanel');
    if (!panel) return;
    if (panel.style.display !== 'none' && panel.innerHTML) {
        panel.style.display = 'none';
        return;
    }
    const TYPE_LABELS = {
        overdue_customer: 'Forsinket', review_ask: 'Anbefaling', season_reminder: 'Sæson',
        uncontacted_lead: 'Nyt lead', dormant_highvalue: 'Sovende', expiring_offer: 'Udløbende tilbud',
        company_anniversary: 'Jubilæum',
    };
    panel.innerHTML = '<div style="padding:12px 14px;background:var(--color-bg,#f5f4f2);border:1px solid var(--color-border,#d7d1ca);border-radius:8px;font-size:12.5px;">' +
        '<strong>Skjulte forslag</strong> — kommer automatisk tilbage efter 14 dage:' +
        _crmSnoozedCache.map(s =>
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--color-border,#e5e0d8);">' +
                '<span>' + (TYPE_LABELS[s.type] || s.type) + ' · <strong>' + (s.customer_name || ('#' + s.customer_id)) + '</strong>' +
                    (s.company_name ? ' · ' + s.company_name : '') + '</span>' +
                '<button class="crm-sug-btn" onclick="_crmUnsnooze(' + s.customer_id + ', \'' + s.type + '\')">↩︎ Vis igen</button>' +
            '</div>'
        ).join('') +
    '</div>';
    panel.style.display = 'block';
}

// Fortryd et skjul → forslaget kan komme tilbage på listen.
async function _crmUnsnooze(customerId, type) {
    try {
        await unsnoozeSuggestion({ customer_id: customerId, type: type });
        const panel = document.getElementById('crmSnoozedPanel');
        if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
        _crmLoadData();
    } catch (err) {
        console.error('[crm] Unsnooze error:', err);
        alert('Kunne ikke vise igen: ' + (err.message || 'Ukendt fejl'));
    }
}

// Mine opfølgninger (Fase 4) — forfaldne/dagens planlagte + åbne callbacks i én liste.
// Forfaldne først (rød ⚑), derefter dagens. Møder + fremtidige vises IKKE her.
function _crmRenderFollowups(data) {
    const el = document.getElementById('crmCallbacksList');
    if (!el) return;
    const items = (data && data.followups) || (Array.isArray(data) ? data : []);
    if (!items.length) {
        el.innerHTML = '<div class="crm-empty">Ingen opfølgninger i dag 🎉</div>';
        return;
    }
    el.innerHTML = items.slice(0, 12).map((f, i) => {
        const name = f.name && f.name.trim() ? f.name.trim() : 'Ukendt';
        const init = name.charAt(0).toUpperCase();
        const avClass = 'av-' + (i % 3);
        const cid = f.customer_id || '';
        const due = (typeof plannedFmtDue === 'function') ? plannedFmtDue(f.due_at) : { label: f.due_at || '', overdue: false };
        const isService = f.kilde === 'service';
        // Callback uden due_at → vis "ring tilbage" som tidspunkt
        const timeLabel = due.label || (isService ? 'ring tilbage' : '');
        const kildeBadge = isService
            ? '<span class="crm-fu-kilde service">Service</span>'
            : '<span class="crm-fu-kilde planlagt">Planlagt</span>';
        const bonChip = f.bon_number ? '<span class="crm-fu-bon">#' + escapeHtml(f.bon_number) + '</span>' : '';
        const ringBtn = f.phone
            ? '<a class="crm-fu-ring" href="tel:' + escapeHtml(f.phone) + '" title="Ring til ' + escapeHtml(name) + '">📞 Ring</a>'
            : '';
        const rowAttrs = cid
            ? ' class="crm-fu-item crm-clickable" data-customer-id="' + cid + '" data-ktab="activity" title="Åbn kundekort"'
            : ' class="crm-fu-item"';
        return '<div' + rowAttrs + '>' +
            '<div class="crm-cb-av ' + avClass + '">' + init + '</div>' +
            '<div class="crm-fu-info">' +
                '<div class="crm-fu-name-row">' +
                    '<span class="crm-fu-name">' + escapeHtml(name) + '</span>' +
                    (f.company_name ? '<span class="crm-fu-company">' + escapeHtml(f.company_name) + '</span>' : '') +
                '</div>' +
                '<div class="crm-fu-text">' + escapeHtml(f.text || '') + bonChip + '</div>' +
            '</div>' +
            '<div class="crm-fu-meta">' +
                kildeBadge +
                '<span class="crm-fu-time' + (due.overdue ? ' overdue' : '') + '">' + escapeHtml(timeLabel) + '</span>' +
            '</div>' +
            ringBtn +
        '</div>';
    }).join('');
}

function _crmGotoRingeliste() {
    if (typeof window.switchSection === 'function') window.switchSection('crm', 'ringeliste');
}

function _crmRenderUpcomingMeetings(items) {
    const el = document.getElementById('crmMeetingsList');
    if (!el) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        el.innerHTML = '<div class="crm-empty">Ingen kommende bookede møder</div>';
        return;
    }

    const dayNames = ['søn','man','tir','ons','tor','fre','lør'];
    const sourceBadge = {
        public_smagning: { label: 'Online', cls: 'progress' },
        public_kontakt:  { label: 'Online', cls: 'progress' },
        token_link:      { label: 'Mail-link', cls: 'insight' },
        internal:        { label: 'Intern',    cls: 'motivation' }
    };

    el.innerHTML = list.map(m => {
        const due = new Date(m.due_at);
        const isValid = !isNaN(due.getTime());
        const dayLabel = isValid ? dayNames[due.getDay()] + '. d. ' + due.getDate() + '/' + (due.getMonth()+1) : '';
        const timeLabel = isValid
            ? String(due.getHours()).padStart(2,'0') + ':' + String(due.getMinutes()).padStart(2,'0')
            : '';
        const dur = m.duration_min ? ' (' + m.duration_min + ' min)' : '';
        const mtLabel = (m.meeting_type_emoji ? m.meeting_type_emoji + ' ' : '') + (m.meeting_type_label || 'Møde');
        const customerName = [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Ukendt';
        const co = m.company_name ? ' · ' + escapeHtml(m.company_name) : '';
        const guest = m.guest_count ? ' · ' + m.guest_count + ' gæster' : '';
        const evtype = m.event_type ? ' · ' + escapeHtml(m.event_type) : '';
        const owner = m.owner_name ? ' · ' + escapeHtml(m.owner_name) : '';
        const src = sourceBadge[m.booked_via];
        const srcHtml = src ? '<span class="crm-briefing-type ' + src.cls + '" style="margin-left:8px">' + src.label + '</span>' : '';

        const cid = m.customer_id || '';
        const rowAttrs = cid
            ? ' class="crm-mt-row crm-clickable" data-customer-id="' + cid + '" title="Åbn kunde i CRM"'
            : ' class="crm-mt-row"';
        return '<div' + rowAttrs + ' style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--color-border,#eee);font-size:13px;">' +
            '<div style="font-family:var(--font-heading,\'Playfair Display\',serif);font-size:18px;font-weight:700;color:var(--brand-primary,#8e631f);min-width:90px;">' +
                escapeHtml(timeLabel) + '<span style="font-size:11px;color:var(--color-text-dim,#888);font-weight:400;margin-left:4px">' + escapeHtml(dayLabel) + '</span>' +
            '</div>' +
            '<div style="flex:1;min-width:0;">' +
                '<div style="font-weight:600">' +
                    escapeHtml(customerName) + escapeHtml(co) +
                '</div>' +
                '<div style="font-size:12px;color:var(--color-text-dim,#888)">' +
                    escapeHtml(mtLabel) + dur + escapeHtml(guest) + escapeHtml(evtype) + escapeHtml(owner) +
                '</div>' +
            '</div>' +
            srcHtml +
        '</div>';
    }).join('');
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
    );
}

function _crmRenderActivityFeed(items) {
    const el = document.getElementById('crmActivityList');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = '<div class="crm-empty">Ingen seneste aktivitet</div>';
        return;
    }
    const typeDots = { call: 'dot-green', service_call: 'dot-green', meeting: 'dot-gold', note: 'dot-gold', followup: 'dot-gray', task: 'dot-gray', email_in: 'dot-gray', email_out: 'dot-gray' };
    const typeLabels = { call: 'Opkald', service_call: 'Service', meeting: 'Møde', task: 'Opgave', note: 'Note', followup: 'Opfølgning', email_in: 'Mail ind', email_out: 'Mail ud' };

    el.innerHTML = items.slice(0, 6).map(a => {
        const dotClass = typeDots[a.type] || 'dot-gray';
        const label = typeLabels[a.type] || a.type;
        const name = a.customer_name || '';
        const time = (a.created_at || '').substring(5, 16).replace('T', ' ');
        const text = a.text ? ' — ' + (a.text.length > 35 ? a.text.substring(0, 35) + '...' : a.text) : '';
        const cid = a.customer_id || '';
        const cls = cid ? 'crm-act-item crm-clickable' : 'crm-act-item';
        const attrs = cid ? ' data-customer-id="' + cid + '" title="Åbn kunde i CRM"' : '';
        return '<div class="' + cls + '"' + attrs + '>' +
            '<div class="crm-act-dot ' + dotClass + '"></div>' +
            '<div class="crm-act-text"><span class="crm-act-type">' + label + '</span> ' + name + text + '</div>' +
            '<span class="crm-act-time">' + time + '</span>' +
        '</div>';
    }).join('');
}

// ─── Pipeline ───────────────────────────────────────────────

async function _crmLoadPipeline(category) {
    if (!_crmActive) return;
    try {
        const data = await fetchCrmPipeline(category || undefined);
        _crmRenderPipeline(data);
    } catch (err) {
        console.error('[crm] Pipeline error:', err);
        const el = document.getElementById('crmPipeBoard');
        if (el) el.innerHTML = '<div class="crm-empty" style="grid-column:1/-1;">Kunne ikke hente pipeline</div>';
    }
}

let _crmDragBonId = null;

function _crmRenderPipeline(columns) {
    const el = document.getElementById('crmPipeBoard');
    if (!el) return;

    const catTagClass = { catering: 'catering', festival: 'festival', produktion: 'produktion', store: 'store' };

    el.innerHTML = Object.entries(columns).map(([key, col]) =>
        '<div class="crm-pipe-col" data-column="' + key + '">' +
            '<div class="crm-pipe-col-head">' +
                '<span>' + col.label + '</span>' +
                '<span class="crm-pipe-count">' + col.items.length + '</span>' +
            '</div>' +
            '<div class="crm-pipe-drop-zone">' +
            (col.items.length ? col.items.map(item => {
                const cid = item.customer_id || '';
                const nameAttrs = cid
                    ? ' class="crm-pipe-name crm-pipe-name-link" data-customer-id="' + cid + '" title="Åbn kundeprofil"'
                    : ' class="crm-pipe-name"';
                return '<div class="crm-pipe-card" draggable="true" data-bon-id="' + item.id + '">' +
                    '<div' + nameAttrs + '>' + (item.company_name || item.customer_name || 'Ukendt') + '</div>' +
                    '<div class="crm-pipe-meta">' +
                        '#' + (item.bon_number || '') + ' · ' + (item.delivery_date || '') +
                        (item.customer_name && item.company_name ? ' · ' + item.customer_name : '') +
                    '</div>' +
                    '<div class="crm-pipe-footer">' +
                        '<span class="crm-pipe-tag ' + (catTagClass[item.price_category] || 'store') + '">' +
                            (item.price_category || 'store') +
                        '</span>' +
                        (item.pax ? '<span class="crm-pipe-pax">👥 ' + item.pax + '</span>' : '') +
                    '</div>' +
                '</div>';
            }).join('') : '<div class="crm-empty" style="padding:10px;font-size:11px;">Slip her</div>') +
            '</div>' +
        '</div>'
    ).join('');

    // Wire drag & drop
    el.querySelectorAll('.crm-pipe-card[draggable]').forEach(card => {
        card.addEventListener('dragstart', (e) => {
            _crmDragBonId = parseInt(card.dataset.bonId);
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.dataset.bonId);
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            el.querySelectorAll('.crm-pipe-col').forEach(c => c.classList.remove('drag-over'));
            _crmDragBonId = null;
        });
        // Click → navnefelt åbner kundeprofil, resten åbner bon-drawer
        card.addEventListener('click', (e) => {
            if (_crmDragBonId) return;
            const nameLink = e.target.closest('.crm-pipe-name-link');
            if (nameLink && card.contains(nameLink)) {
                const cid = parseInt(nameLink.dataset.customerId);
                if (cid) _crmOpenKunde(cid);
                return;
            }
            const bonId = parseInt(card.dataset.bonId);
            if (_crmOpts.openDrawer) _crmOpts.openDrawer(bonId);
        });
    });

    el.querySelectorAll('.crm-pipe-col').forEach(col => {
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            col.classList.add('drag-over');
        });
        col.addEventListener('dragleave', (e) => {
            if (!col.contains(e.relatedTarget)) {
                col.classList.remove('drag-over');
            }
        });
        col.addEventListener('drop', async (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const bonId = parseInt(e.dataTransfer.getData('text/plain'));
            const targetColumn = col.dataset.column;
            if (!bonId || !targetColumn) return;

            try {
                await movePipelineCard(bonId, targetColumn);
                // Re-fetch pipeline to reflect new state
                const activeFilter = document.querySelector('.crm-pipe-filter.active');
                _crmLoadPipeline(activeFilter ? activeFilter.dataset.cat || '' : '');
            } catch (err) {
                console.error('[crm] Pipeline move error:', err);
                alert('Kunne ikke flytte: ' + (err.message || 'Ukendt fejl'));
            }
        });
    });
}

// ─── Navigation helpers ─────────────────────────────────────

function _crmOpenKunde(customerId, tab) {
    if (_crmOpts.openKunde360) {
        _crmOpts.openKunde360(customerId, tab ? { tab } : undefined);
    }
}

// ─── Reaktivér sovende modal (Fase 5) ───────────────────────

function _crmOpenReactivateModal() {
    // Standard-forslag fra spec: 180 dage, 5000 kr min revenue
    const defaultName = 'Reaktivering — sovende ' + new Date().toLocaleDateString('da-DK', { month: 'long', year: 'numeric' });
    const overlay = document.createElement('div');
    overlay.className = 'reakt-modal-overlay';
    overlay.innerHTML = `
        <style>
            .reakt-modal-overlay {
                position: fixed; inset: 0; background: rgba(0,0,0,0.45);
                display: flex; align-items: center; justify-content: center;
                z-index: 9999;
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
            }
            .reakt-modal {
                background: var(--color-surface, #fff); border-radius: 12px;
                width: 460px; max-width: 92vw;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            }
            .reakt-modal-head {
                padding: 18px 22px; border-bottom: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: space-between; align-items: center;
            }
            .reakt-modal-title {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 19px; font-weight: 700; margin: 0;
            }
            .reakt-close {
                background: none; border: none; font-size: 22px; cursor: pointer;
                color: var(--color-text-dim, #888);
            }
            .reakt-body { padding: 18px 22px; }
            .reakt-field { margin-bottom: 12px; }
            .reakt-label {
                display: block; font-size: 12px; font-weight: 600;
                text-transform: uppercase; letter-spacing: .04em;
                color: var(--color-text-dim, #888); margin-bottom: 4px;
            }
            .reakt-input {
                width: 100%; box-sizing: border-box;
                padding: 9px 12px; font-size: 14px;
                border: 1px solid var(--color-border, #d7d1ca);
                border-radius: 8px; font-family: inherit;
            }
            .reakt-row {
                display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
            }
            .reakt-hint { font-size: 12px; color: var(--color-text-dim, #888); margin-top: 4px; }
            .reakt-error { background: #fdecea; color: #a13d2e; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-top: 8px; display: none; }
            .reakt-footer {
                padding: 14px 22px; border-top: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: flex-end; gap: 10px;
            }
            .reakt-btn {
                padding: 9px 18px; border-radius: 8px; border: none;
                font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
            }
            .reakt-btn-cancel { background: transparent; color: var(--color-text-dim); }
            .reakt-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
            .reakt-btn-primary:hover { filter: brightness(1.08); }
            .reakt-btn-primary:disabled { background: var(--color-border, #d7d1ca); cursor: not-allowed; }
        </style>
        <div class="reakt-modal" role="dialog" aria-modal="true">
            <div class="reakt-modal-head">
                <h3 class="reakt-modal-title">🔄 Reaktivér sovende</h3>
                <button class="reakt-close" data-action="cancel" aria-label="Luk">×</button>
            </div>
            <div class="reakt-body">
                <p style="margin:0 0 14px 0;font-size:13px;color:var(--color-text-dim);">
                    Opretter en kampagne med alle kunder der opfylder filteret nedenfor.
                </p>
                <div class="reakt-field">
                    <label class="reakt-label" for="reakt-name">Kampagne-navn</label>
                    <input type="text" class="reakt-input" id="reakt-name" value="${_crmEsc(defaultName)}" autofocus>
                </div>
                <div class="reakt-row">
                    <div class="reakt-field">
                        <label class="reakt-label" for="reakt-days">Dage siden ordre</label>
                        <input type="number" class="reakt-input" id="reakt-days" min="30" value="180">
                        <div class="reakt-hint">Minimum 30 dage</div>
                    </div>
                    <div class="reakt-field">
                        <label class="reakt-label" for="reakt-revenue">Min. omsætning (kr)</label>
                        <input type="number" class="reakt-input" id="reakt-revenue" min="0" value="5000" step="500">
                        <div class="reakt-hint">Lifetime total</div>
                    </div>
                </div>
                <div class="reakt-error" id="reakt-error"></div>
            </div>
            <div class="reakt-footer">
                <button class="reakt-btn reakt-btn-cancel" data-action="cancel">Annullér</button>
                <button class="reakt-btn reakt-btn-primary" data-action="ok">Opret kampagne</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-action="cancel"]').forEach(b => b.addEventListener('click', close));

    const submitBtn = overlay.querySelector('[data-action="ok"]');
    const errEl = overlay.querySelector('#reakt-error');
    const showError = (msg) => { errEl.textContent = msg; errEl.style.display = ''; };

    submitBtn.addEventListener('click', async () => {
        const name = overlay.querySelector('#reakt-name').value.trim();
        const days = parseInt(overlay.querySelector('#reakt-days').value);
        const revenue = parseFloat(overlay.querySelector('#reakt-revenue').value) || 0;
        if (!name) return showError('Indtast et navn.');
        if (!days || days < 30) return showError('Dage skal være mindst 30.');

        submitBtn.disabled = true;
        submitBtn.textContent = 'Opretter…';
        errEl.style.display = 'none';

        try {
            const r = await createCampaignFromSuggestion({
                type: 'dormant',
                filter: { days_since_last: days, min_total_revenue: revenue },
                campaign_name: name,
            });
            close();
            // Toast med resultat + link til outreach
            const skippedReasons = (r.skipped || []).reduce((acc, s) => {
                acc[s.reason] = (acc[s.reason] || 0) + 1; return acc;
            }, {});
            const skippedText = Object.entries(skippedReasons).map(([reason, n]) =>
                `${n} ${({
                    do_not_contact: 'må ikke kontaktes',
                    no_marketing_consent_b2c: 'mangler samtykke',
                    duplicate_company: 'samme firma',
                    already_member: 'allerede medlem',
                }[reason] || reason)}`
            ).join(', ');

            _crmShowReactToast(
                r.added,
                r.campaign_id,
                name,
                skippedText,
            );
        } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Opret kampagne';
            // apiFetch sætter err.status + err.message (med body.error som message).
            // Vi klassificerer fejlen på beskeden frem for et body-objekt.
            const code = err.message;
            if (err.status === 409 && code === 'name_in_use') {
                showError('Navnet er allerede i brug — vælg et andet.');
            } else if (err.status === 409 && code === 'name_closed') {
                showError('Navnet bruges af en lukket kampagne — vælg et andet eller genåben den manuelt.');
            } else if (err.status === 400 && code === 'no_candidates') {
                showError('Ingen kunder matcher filteret. Prøv at sænke kravene.');
            } else if (err.status === 400 && code === 'campaign_name_required') {
                showError('Indtast et navn.');
            } else if (err.status === 400 && code === 'unsupported_type') {
                showError('Ukendt forslags-type.');
            } else {
                showError(err.message || 'Ukendt fejl');
            }
        }
    });
}

function _crmEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function _crmShowReactToast(added, campaignId, name, skippedText) {
    const existing = document.querySelector('.reakt-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'reakt-toast';
    t.innerHTML = `
        <style>
            .reakt-toast {
                position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
                background: #2c7a3d; color: #fff; padding: 14px 20px; border-radius: 10px;
                font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); z-index: 10000;
                display: flex; gap: 14px; align-items: center;
                animation: reakt-toast-in .18s ease-out;
                max-width: 600px;
            }
            .reakt-toast-link {
                background: rgba(255,255,255,0.2); color: #fff; padding: 4px 10px;
                border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 12px;
            }
            .reakt-toast-link:hover { background: rgba(255,255,255,0.3); }
            @keyframes reakt-toast-in {
                from { opacity: 0; transform: translate(-50%, 10px); }
                to   { opacity: 1; transform: translate(-50%, 0); }
            }
        </style>
        <span>${added} kunder tilføjet til "${_crmEsc(name)}"${skippedText ? ` · ${_crmEsc(skippedText)} sprunget over` : ''}</span>
        <a class="reakt-toast-link" href="/office/?view=crm&pill=outreach&campaign=${campaignId}">Åbn kampagne →</a>
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
}

// ─── SSE handler ────────────────────────────────────────────

function _crmDashHandleSSE(eventType, data) {
    if (!_crmActive) return;
    if (eventType === 'crm_activity_created') {
        _crmLoadData();
    }
}
