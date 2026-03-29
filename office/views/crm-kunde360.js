/**
 * office/views/crm-kunde360.js
 * ════════════════════════════════════════════════════════════
 * Kunde 360° profil — info, sentiment, ordrer, aktiviteter, tilbud, mail
 * ════════════════════════════════════════════════════════════
 */

let _k3Container = null;
let _k3Opts = {};
let _k3Active = false;
let _k3CustomerId = null;
let _k3Data = null;
let _k3Tab = 'orders';

function initCrmKunde360(containerEl, opts) {
    _k3Container = containerEl;
    _k3Opts = opts || {};
    _k3Active = true;

    const params = new URLSearchParams(window.location.search);
    _k3CustomerId = params.get('customer') ? parseInt(params.get('customer')) : null;

    if (_k3CustomerId) {
        _k3RenderShell();
        _k3LoadData();
    } else {
        _k3RenderSearch();
    }
}

function cleanupCrmKunde360() {
    _k3Active = false;
    _k3Container = null;
    _k3Data = null;
}

// ─── Search (no customer selected) ──────────────────────────

function _k3RenderSearch() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Kunder';

    _k3Container.innerHTML = `
        <style>
            .k3-search-wrap { max-width: 640px; margin: 40px auto; }
            .k3-search-input {
                width: 100%; padding: 12px 16px; font-size: 15px;
                border: 2px solid var(--color-border, #d7d1ca); border-radius: 10px;
                outline: none; background: var(--color-surface, #fff);
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
            }
            .k3-search-input:focus { border-color: var(--brand-primary, #8e631f); }
            .k3-search-results { margin-top: 8px; }
            .k3-search-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 12px 14px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; border-radius: 6px; transition: background .1s;
            }
            .k3-search-row:hover { background: var(--brand-primary-light, #f1e6b2); }
            .k3-search-name { font-weight: 600; font-size: 14px; }
            .k3-search-company { font-size: 13px; color: var(--color-text-dim, #888); margin-top: 2px; }
            .k3-search-stats { font-size: 13px; color: var(--color-text-dim, #888); text-align: right; }
            .k3-stage-filters { display: flex; gap: 6px; margin: 16px 0; flex-wrap: wrap; }
            .k3-stage-btn {
                padding: 5px 14px; border-radius: 16px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 13px; cursor: pointer;
                font-family: inherit; transition: all .12s;
            }
            .k3-stage-btn:hover { background: var(--color-background, #f5f4f2); }
            .k3-stage-btn.active { background: var(--brand-primary, #8e631f); color: white; border-color: transparent; }
        </style>
        <div class="k3-search-wrap">
            <input type="text" class="k3-search-input" placeholder="Søg kunde, firma, email, telefon..." id="k3SearchInput" autofocus>
            <div class="k3-stage-filters" id="k3StageFilters">
                <button class="k3-stage-btn active" data-stage="all">Alle</button>
                <button class="k3-stage-btn" data-stage="vip">VIP</button>
                <button class="k3-stage-btn" data-stage="active">Aktive</button>
                <button class="k3-stage-btn" data-stage="dormant">Sovende</button>
                <button class="k3-stage-btn" data-stage="lead">Leads</button>
            </div>
            <div class="k3-search-results" id="k3SearchResults"></div>
        </div>
    `;

    let _debounce = null;
    let _stage = 'all';

    const input = document.getElementById('k3SearchInput');
    input.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => _k3DoSearch(input.value, _stage), 250);
    });

    document.getElementById('k3StageFilters').addEventListener('click', (e) => {
        const btn = e.target.closest('.k3-stage-btn');
        if (!btn) return;
        _stage = btn.dataset.stage;
        document.querySelectorAll('.k3-stage-btn').forEach(b => b.classList.toggle('active', b === btn));
        _k3DoSearch(input.value, _stage);
    });

    _k3DoSearch('', 'all');
}

async function _k3DoSearch(q, stage) {
    try {
        const params = {};
        if (q) params.q = q;
        if (stage && stage !== 'all') params.stage = stage;
        params.limit = 30;
        const rows = await fetchCrmCustomers(params);
        _k3RenderSearchResults(rows);
    } catch (err) {
        console.error('[k3] Search error:', err);
    }
}

function _k3RenderSearchResults(rows) {
    const el = document.getElementById('k3SearchResults');
    if (!el) return;

    if (!rows.length) {
        el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen kunder fundet</div>';
        return;
    }

    el.innerHTML = rows.map(r => {
        const stageBadge = r.stage ? '<span style="margin-left:6px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;' +
            (r.stage === 'vip' ? 'background:#f5f0e0;color:#8e631f' :
             r.stage === 'active' ? 'background:#e8f2dc;color:#3d7a0a' :
             r.stage === 'dormant' ? 'background:#f0eded;color:#888' :
             'background:#e0ecf5;color:#2a6fb0') + ';">' + r.stage.toUpperCase() + '</span>' : '';
        return '<div class="k3-search-row" onclick="_k3Navigate(' + r.id + ')">' +
            '<div><span class="k3-search-name">' + r.name + stageBadge + '</span>' +
            (r.company_name ? '<div class="k3-search-company">' + r.company_name + '</div>' : '') + '</div>' +
            '<div class="k3-search-stats">' + (r.total_orders || 0) + ' ordrer · ' +
            Math.round(r.total_revenue || 0).toLocaleString('da-DK') + ' kr</div>' +
        '</div>';
    }).join('');
}

function _k3Navigate(customerId) {
    _k3CustomerId = customerId;
    const url = new URL(window.location);
    url.searchParams.set('customer', customerId);
    history.replaceState({}, '', url);
    _k3RenderShell();
    _k3LoadData();
}

// ─── Profile Shell ──────────────────────────────────────────

function _k3RenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Kunde 360°';

    _k3Container.innerHTML = `
        <style>
            .k3-layout { display: grid; grid-template-columns: 300px 1fr; gap: 12px; height: 100%; }
            @media (max-width: 900px) { .k3-layout { grid-template-columns: 1fr; } }

            .k3-left {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
                overflow-y: auto;
            }
            .k3-right { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }

            .k3-back { font-size: 13px; color: var(--color-text-dim, #888); cursor: pointer; margin-bottom: 14px; }
            .k3-back:hover { color: var(--brand-primary); }

            /* Avatar tile */
            .k3-avatar-row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
            .k3-avatar {
                width: 52px; height: 52px; border-radius: 12px;
                background: linear-gradient(135deg, #C8962A 0%, #8e631f 100%);
                display: flex; align-items: center; justify-content: center;
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 22px; font-weight: 700; color: #fff;
            }
            .k3-name-block { flex: 1; min-width: 0; }
            .k3-name {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 19px; font-weight: 700; line-height: 1.2;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .k3-company { font-size: 13px; color: var(--color-text-dim, #888); margin-top: 2px; }
            .k3-stage-badge {
                display: inline-block; padding: 3px 12px; border-radius: 12px;
                font-size: 11px; font-weight: 700; margin-top: 4px;
            }
            .k3-stage-vip { background: #f5f0e0; color: #8e631f; }
            .k3-stage-active { background: #e8f2dc; color: #3d7a0a; }
            .k3-stage-dormant { background: #f0eded; color: #888; }
            .k3-stage-lead { background: #e0ecf5; color: #2a6fb0; }

            /* Contact info */
            .k3-contact-section { margin: 14px 0; padding: 12px 0; border-top: 1px solid var(--color-border, #eee); }
            .k3-contact-row { font-size: 13px; padding: 5px 0; display: flex; align-items: center; gap: 8px; }
            .k3-contact-row a { color: var(--brand-primary); text-decoration: none; }
            .k3-contact-row a:hover { text-decoration: underline; }
            .k3-contact-icon { width: 20px; text-align: center; font-size: 14px; }

            /* Sentiment trendline */
            .k3-sentiment-section {
                margin: 12px 0; padding: 14px; border-radius: 10px;
                background: var(--color-background, #f5f4f2);
            }
            .k3-sent-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 10px; }
            .k3-sent-dots {
                display: flex; align-items: center; justify-content: center;
                gap: 4px; margin-bottom: 10px;
            }
            .k3-sent-dot {
                width: 28px; height: 28px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 14px;
            }
            .k3-sent-dot.pos { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-sent-dot.neu { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-sent-dot.neg { background: var(--color-sentiment-neg-bg, #FBE9E9); }
            .k3-sent-dot.empty { background: transparent; border: 2px dashed var(--color-border, #d7d1ca); }
            .k3-sent-arrow { color: var(--color-text-dim, #aaa); font-size: 11px; }
            .k3-sent-interp {
                padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 600;
                text-align: center; margin-bottom: 8px;
            }
            .k3-sent-interp.pos { background: var(--color-sentiment-pos-bg); color: var(--color-sentiment-pos); }
            .k3-sent-interp.neu { background: var(--color-sentiment-neu-bg); color: var(--color-sentiment-neu); }
            .k3-sent-interp.neg { background: var(--color-sentiment-neg-bg); color: var(--color-sentiment-neg); }
            .k3-sent-summary { font-size: 11px; color: var(--color-text-dim); text-align: center; }

            /* Stats grid */
            .k3-stat-strip {
                display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
                padding: 12px; background: var(--color-surface, #fff);
                border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
            }
            .k3-stat { text-align: center; padding: 8px 4px; }
            .k3-stat-value {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 20px; font-weight: 700; color: var(--brand-primary);
                line-height: 1.2;
            }
            .k3-stat-value.green { color: var(--color-sentiment-pos, #2E9E6B); }
            .k3-stat-value.gold { color: var(--color-sentiment-neu, #C8962A); }
            .k3-stat-label { font-size: 10px; color: var(--color-text-dim); text-transform: uppercase; margin-top: 3px; }

            /* Products as chips */
            .k3-products { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border, #eee); }
            .k3-products h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 8px; }
            .k3-prod-chips { display: flex; flex-wrap: wrap; gap: 4px; }
            .k3-prod-chip {
                padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 500;
                background: var(--brand-primary-light, #f1e6b2); color: var(--brand-primary, #8e631f);
            }

            /* Quick note */
            .k3-quick-note { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border, #eee); }
            .k3-quick-note h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-dim); margin-bottom: 6px; }
            .k3-qn-textarea {
                width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--color-border);
                font-size: 13px; resize: vertical; min-height: 50px; font-family: inherit;
            }
            .k3-qn-textarea:focus { border-color: var(--brand-primary); outline: none; }
            .k3-qn-btn {
                margin-top: 6px; padding: 5px 14px; border-radius: 6px; border: none;
                background: var(--brand-primary); color: white; font-size: 12px; font-weight: 600; cursor: pointer;
            }

            /* Stage select */
            .k3-stage-select {
                padding: 5px 10px; border-radius: 6px; border: 1px solid var(--color-border);
                font-size: 12px; margin-top: 14px; font-family: inherit;
            }

            /* Tabs */
            .k3-tabs { display: flex; gap: 0; }
            .k3-tab {
                padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
                border-bottom: 2px solid transparent; color: var(--color-text-dim);
                transition: color .12s;
            }
            .k3-tab:hover { color: var(--color-text, #333); }
            .k3-tab.active { border-bottom-color: var(--brand-primary); color: var(--brand-primary); }

            .k3-tab-content {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
                flex: 1; overflow-y: auto;
            }

            /* Orders */
            .k3-order-row {
                display: grid; grid-template-columns: auto 1fr auto auto auto;
                gap: 8px; align-items: center; padding: 8px 0;
                border-bottom: 1px solid var(--color-border, #eee); font-size: 14px; cursor: pointer;
            }
            .k3-order-row:hover { background: var(--brand-primary-light, #f1e6b2); margin: 0 -18px; padding: 8px 18px; }
            .k3-order-bon { font-weight: 600; color: var(--brand-primary); }
            .k3-order-status {
                display: inline-block; padding: 2px 8px; border-radius: 6px;
                font-size: 10px; font-weight: 700; background: #f0f0f0;
            }

            /* Activity form */
            .k3-activity-form { margin-bottom: 16px; padding: 14px; border-radius: 10px; background: var(--color-background, #f5f4f2); border: 1px solid var(--color-border); }
            .k3-af-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
            .k3-af-select { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; font-family: inherit; }
            .k3-af-textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 60px; font-family: inherit; }
            .k3-af-textarea:focus { border-color: var(--brand-primary); outline: none; }
            .k3-af-submit {
                padding: 7px 18px; border-radius: 6px; border: none;
                background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .k3-af-submit:hover { filter: brightness(1.1); }

            .k3-sentiment-btns { display: flex; gap: 6px; }
            .k3-sent-btn {
                width: 38px; height: 38px; border-radius: 50%; border: 2px solid var(--color-border);
                background: var(--color-surface); font-size: 18px; cursor: pointer; display: flex;
                align-items: center; justify-content: center; transition: all .12s;
            }
            .k3-sent-btn:hover { transform: scale(1.08); }
            .k3-sent-btn.selected { border-color: var(--brand-primary); background: var(--brand-primary-light); }

            /* Timeline */
            .k3-timeline { position: relative; }
            .k3-tl-filters { display: flex; gap: 5px; margin-bottom: 14px; flex-wrap: wrap; }
            .k3-tl-filter {
                padding: 4px 12px; border-radius: 16px; border: 1px solid var(--color-border);
                background: var(--color-surface); font-size: 12px; cursor: pointer; font-family: inherit;
            }
            .k3-tl-filter.active { background: var(--brand-primary); color: white; border-color: transparent; }
            .k3-tl-filter:hover:not(.active) { background: var(--color-background); }

            .k3-month-divider {
                display: flex; align-items: center; gap: 10px; margin: 16px 0 8px;
                font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
                color: var(--color-text-dim);
            }
            .k3-month-divider::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }

            .k3-timeline-item {
                display: flex; gap: 12px; padding: 10px 0; font-size: 13px;
                position: relative;
            }
            .k3-tl-left { display: flex; flex-direction: column; align-items: center; width: 32px; flex-shrink: 0; }
            .k3-tl-icon {
                width: 32px; height: 32px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 14px; flex-shrink: 0;
            }
            .k3-tl-icon.type-call { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-tl-icon.type-note { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-tl-icon.type-meeting { background: var(--color-sentiment-pos-bg, #E6F7F0); }
            .k3-tl-icon.type-task { background: #EEF0FB; }
            .k3-tl-icon.type-followup { background: #f0eded; }
            .k3-tl-icon.type-email { background: #f0eded; }
            .k3-tl-icon.type-offer { background: var(--color-sentiment-neu-bg, #FBF3E2); }
            .k3-tl-connector { flex: 1; width: 2px; background: var(--color-border, #eee); margin-top: 4px; }

            .k3-tl-card {
                flex: 1; min-width: 0; background: var(--color-surface, #fff);
                border: 1px solid var(--color-border, #eee); border-radius: 10px;
                padding: 10px 14px; transition: border-color .12s;
            }
            .k3-tl-card:hover { border-color: var(--brand-primary, #8e631f); }
            .k3-tl-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
            .k3-tl-type { font-weight: 600; font-size: 13px; }
            .k3-tl-who {
                padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
                background: var(--color-background, #f5f4f2); color: var(--color-text-dim);
            }
            .k3-tl-time { font-size: 11px; color: var(--color-text-dim); margin-left: auto; white-space: nowrap; }
            .k3-tl-text { color: var(--color-text-dim); font-size: 13px; line-height: 1.5; }
            .k3-tl-footer { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
            .k3-tl-bon-ref {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 3px 8px; border-radius: 6px; font-size: 11px;
                background: var(--brand-primary-light, #f1e6b2); color: var(--brand-primary);
                font-weight: 600;
            }
            .k3-tl-sentiment {
                display: inline-flex; align-items: center; gap: 3px;
                padding: 2px 8px; border-radius: 8px; font-size: 11px; font-weight: 600;
            }
            .k3-tl-sentiment.positive { background: var(--color-sentiment-pos-bg, #E6F7F0); color: var(--color-sentiment-pos, #2E9E6B); }
            .k3-tl-sentiment.negative { background: var(--color-sentiment-neg-bg, #FBE9E9); color: var(--color-sentiment-neg, #C94040); }
            .k3-tl-sentiment.neutral { background: var(--color-sentiment-neu-bg, #FBF3E2); color: var(--color-sentiment-neu, #C8962A); }

            /* Mail */
            .k3-mail-compose { padding: 14px; border-radius: 10px; background: var(--color-background, #f5f4f2); border: 1px solid var(--color-border); margin-bottom: 16px; }
            .k3-mail-field { margin-bottom: 8px; }
            .k3-mail-field label { display: block; font-size: 11px; font-weight: 700; color: var(--color-text-dim); text-transform: uppercase; margin-bottom: 3px; }
            .k3-mail-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; font-family: inherit; }
            .k3-mail-input:focus { border-color: var(--brand-primary); outline: none; }
            .k3-mail-body { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 100px; font-family: inherit; }
            .k3-mail-body:focus { border-color: var(--brand-primary); outline: none; }
            .k3-mail-send { padding: 8px 20px; border-radius: 6px; border: none; background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer; }
            .k3-mail-msg { padding: 12px; margin-bottom: 10px; border-radius: 10px; }
            .k3-mail-msg.in { background: #f0f4f8; border-left: 3px solid #2a6fb0; }
            .k3-mail-msg.out { background: #faf6ee; border-left: 3px solid var(--brand-primary); }
            .k3-mail-msg-header { font-size: 11px; color: var(--color-text-dim); margin-bottom: 4px; display: flex; justify-content: space-between; }
            .k3-mail-msg-body { font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
        </style>

        <div class="k3-layout">
            <div class="k3-left" id="k3Left">
                <div class="k3-back" onclick="_k3GoBack()">← Alle kunder</div>
                <div id="k3Profile">Indlæser...</div>
            </div>
            <div class="k3-right">
                <div class="k3-stat-strip" id="k3StatStrip"></div>
                <div class="k3-tabs" id="k3Tabs">
                    <div class="k3-tab active" data-tab="orders">Ordrer</div>
                    <div class="k3-tab" data-tab="activity">Aktivitet</div>
                    <div class="k3-tab" data-tab="offers">Tilbud</div>
                    <div class="k3-tab" data-tab="mail">Mail</div>
                </div>
                <div class="k3-tab-content" id="k3TabContent"></div>
            </div>
        </div>
    `;

    document.getElementById('k3Tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.k3-tab');
        if (!tab) return;
        _k3Tab = tab.dataset.tab;
        document.querySelectorAll('.k3-tab').forEach(t => t.classList.toggle('active', t === tab));
        _k3RenderTab();
    });
}

// ─── Data loading ───────────────────────────────────────────

async function _k3LoadData() {
    if (!_k3Active || !_k3CustomerId) return;
    try {
        _k3Data = await fetchCrmCustomer(_k3CustomerId);
        _k3RenderProfile();
        _k3RenderStatStrip();
        _k3RenderTab();
    } catch (err) {
        console.error('[k3] Load error:', err);
        const el = document.getElementById('k3Profile');
        if (el) el.textContent = 'Fejl: ' + err.message;
    }
}

// ─── Profile (left panel) ───────────────────────────────────

function _k3RenderProfile() {
    const el = document.getElementById('k3Profile');
    if (!el || !_k3Data) return;
    const c = _k3Data.customer;
    const s = _k3Data.stats;

    const stageClass = 'k3-stage-' + (c.stage || 'active');
    const stageName = { vip: 'VIP', active: 'AKTIV', dormant: 'SOVENDE', lead: 'LEAD' }[c.stage || 'active'];
    const fullName = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
    const initial = (c.company_name || fullName || '?').charAt(0).toUpperCase();

    let html = '';

    // Avatar row
    html += '<div class="k3-avatar-row">' +
        '<div class="k3-avatar">' + initial + '</div>' +
        '<div class="k3-name-block">' +
            '<div class="k3-name">' + fullName + '</div>' +
            (c.company_name ? '<div class="k3-company">' + c.company_name + '</div>' : '') +
            '<span class="k3-stage-badge ' + stageClass + '">' + stageName + '</span>' +
        '</div>' +
    '</div>';

    // Contact info
    html += '<div class="k3-contact-section">' +
        '<div class="k3-contact-row"><span class="k3-contact-icon">📞</span>' +
            (c.phone ? '<a href="tel:' + c.phone.replace(/\s/g, '') + '">' + c.phone + '</a>' : '<span style="color:var(--color-text-dim)">—</span>') + '</div>' +
        '<div class="k3-contact-row"><span class="k3-contact-icon">✉️</span>' +
            (c.email ? '<a href="mailto:' + c.email + '">' + c.email + '</a>' : '<span style="color:var(--color-text-dim)">—</span>') + '</div>' +
    '</div>';

    // Sentiment trendline
    html += _k3BuildSentimentTrend();

    // Products as chips
    if (_k3Data.products.length) {
        html += '<div class="k3-products"><h4>Typiske produkter</h4>' +
            '<div class="k3-prod-chips">' +
            _k3Data.products.slice(0, 6).map(p =>
                '<span class="k3-prod-chip">' + p.product_name + ' (' + p.total_qty + ')</span>'
            ).join('') +
            '</div></div>';
    }

    // Quick note
    html += '<div class="k3-quick-note">' +
        '<h4>Hurtig note</h4>' +
        '<textarea class="k3-qn-textarea" id="k3QuickNote" placeholder="Skriv en hurtig note..."></textarea>' +
        '<button class="k3-qn-btn" onclick="_k3SubmitQuickNote()">Gem note</button>' +
    '</div>';

    // Stage selector
    html += '<select class="k3-stage-select" id="k3StageSelect" onchange="_k3ChangeStage(this.value)">' +
        ['lead', 'active', 'dormant', 'vip'].map(st =>
            '<option value="' + st + '"' + (st === (c.stage || 'active') ? ' selected' : '') + '>' +
                { lead: 'Lead', active: 'Aktiv', dormant: 'Sovende', vip: 'VIP' }[st] + '</option>'
        ).join('') +
    '</select>';

    el.innerHTML = html;
}

// ─── Sentiment trendline ────────────────────────────────────

function _k3BuildSentimentTrend() {
    if (!_k3Data || !_k3Data.activities) return '';

    const sentActivities = _k3Data.activities
        .filter(a => a.sentiment)
        .slice(0, 6);

    // Reverse so oldest is first (left to right = chronological)
    const dots = [...sentActivities].reverse();

    // Pad to 6
    while (dots.length < 6) dots.unshift(null);

    const emojiMap = { positive: '😊', neutral: '😐', negative: '😟' };
    const classMap = { positive: 'pos', neutral: 'neu', negative: 'neg' };

    const dotsHtml = dots.map((d, i) => {
        const dot = d ?
            '<div class="k3-sent-dot ' + classMap[d.sentiment] + '">' + emojiMap[d.sentiment] + '</div>' :
            '<div class="k3-sent-dot empty"></div>';
        const arrow = i < 5 ? '<span class="k3-sent-arrow">›</span>' : '';
        return dot + arrow;
    }).join('');

    // Interpretation
    const recent = sentActivities.slice(0, 3);
    let interpClass = 'neu';
    let interpText = 'Neutral stemning';
    if (recent.length > 0) {
        const posCount = recent.filter(a => a.sentiment === 'positive').length;
        const negCount = recent.filter(a => a.sentiment === 'negative').length;
        if (posCount > negCount) { interpClass = 'pos'; interpText = 'Positiv udvikling'; }
        else if (negCount > posCount) { interpClass = 'neg'; interpText = 'Negativ tendens'; }
    }

    // Counts
    const posTotal = sentActivities.filter(a => a.sentiment === 'positive').length;
    const neuTotal = sentActivities.filter(a => a.sentiment === 'neutral').length;
    const negTotal = sentActivities.filter(a => a.sentiment === 'negative').length;

    return '<div class="k3-sentiment-section">' +
        '<div class="k3-sent-title">Stemning over tid</div>' +
        '<div class="k3-sent-dots">' + dotsHtml + '</div>' +
        '<div class="k3-sent-interp ' + interpClass + '">' + interpText + '</div>' +
        '<div class="k3-sent-summary">😊 ' + posTotal + ' gode · 😐 ' + neuTotal + ' neutrale · 😟 ' + negTotal + ' dårlige</div>' +
    '</div>';
}

// ─── Stat strip (above tabs) ────────────────────────────────

function _k3RenderStatStrip() {
    const el = document.getElementById('k3StatStrip');
    if (!el || !_k3Data) return;
    const s = _k3Data.stats;

    // Find sentiment summary for KPI
    const sentActivities = (_k3Data.activities || []).filter(a => a.sentiment);
    const lastSent = sentActivities.length > 0 ? sentActivities[0].sentiment : null;
    const sentEmoji = { positive: '😊', neutral: '😐', negative: '😟' }[lastSent] || '—';
    const sentClass = lastSent === 'positive' ? 'green' : lastSent === 'negative' ? '' : 'gold';

    // Next event
    const futureOrders = (_k3Data.orders || []).filter(o => o.delivery_date >= new Date().toISOString().slice(0, 10));
    const nextEvent = futureOrders.length > 0 ? futureOrders[futureOrders.length - 1].delivery_date : '—';

    el.innerHTML =
        '<div class="k3-stat"><div class="k3-stat-value">' + (s.total_orders || 0) + '</div><div class="k3-stat-label">Ordrer</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value">' + Math.round(s.total_revenue || 0).toLocaleString('da-DK') + '</div><div class="k3-stat-label">Omsætning</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value ' + sentClass + '">' + sentEmoji + '</div><div class="k3-stat-label">Stemning</div></div>' +
        '<div class="k3-stat"><div class="k3-stat-value">' + nextEvent + '</div><div class="k3-stat-label">Næste event</div></div>';
}

// ─── Tab rendering ──────────────────────────────────────────

function _k3RenderTab() {
    if (!_k3Data) return;
    const el = document.getElementById('k3TabContent');
    if (!el) return;

    if (_k3Tab === 'orders') _k3RenderOrders(el);
    else if (_k3Tab === 'activity') _k3RenderActivity(el);
    else if (_k3Tab === 'offers') _k3RenderOffers(el);
    else if (_k3Tab === 'mail') _k3RenderMail(el);
}

function _k3RenderOrders(el) {
    const orders = _k3Data.orders;
    if (!orders.length) { el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen ordrer</div>'; return; }

    el.innerHTML = orders.map(o =>
        '<div class="k3-order-row" onclick="' + (_k3Opts.openDrawer ? '_k3Opts.openDrawer(' + o.id + ')' : '') + '">' +
            '<span class="k3-order-bon">#' + o.bon_number + '</span>' +
            '<span>' + o.delivery_date + '</span>' +
            '<span>' + (o.pax || '—') + ' pax</span>' +
            '<span>' + (o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '—') + '</span>' +
            '<span class="k3-order-status">' + o.status + '</span>' +
        '</div>'
    ).join('');
}

let _k3ActFilter = 'all';

function _k3RenderActivity(el) {
    const typeIcons = { call: '📞', service_call: '📞', meeting: '🤝', task: '📋', note: '📝', followup: '🔔', offer_sent: '📤', email_in: '📥', email_out: '📤' };
    const typeLabels = { call: 'Opkald', service_call: 'Service-kald', meeting: 'Møde', task: 'Opgave', note: 'Note', followup: 'Opfølgning', offer_sent: 'Tilbud sendt', email_in: 'Mail ind', email_out: 'Mail ud' };
    const typeIconClasses = { call: 'type-call', service_call: 'type-call', meeting: 'type-meeting', task: 'type-task', note: 'type-note', followup: 'type-followup', offer_sent: 'type-offer', email_in: 'type-email', email_out: 'type-email' };
    const sentimentEmoji = { positive: '😊', neutral: '😐', negative: '😟' };
    const sentimentLabel = { positive: 'God', neutral: 'Neutral', negative: 'Dårlig' };
    const resultLabels = { reached: 'Nået', no_answer: 'Intet svar', busy: 'Optaget', voicemail: 'Besked', callback: 'Callback', email_instead: 'Email' };
    const MONTH_NAMES_DA = ['Januar','Februar','Marts','April','Maj','Juni','Juli','August','September','Oktober','November','December'];

    // Activity form
    let html = '<div class="k3-activity-form">' +
        '<div class="k3-af-row">' +
            '<select class="k3-af-select" id="k3ActType">' +
                '<option value="call">Opkald</option>' +
                '<option value="service_call">Service-kald</option>' +
                '<option value="note">Note</option>' +
                '<option value="meeting">Møde</option>' +
                '<option value="task">Opgave</option>' +
                '<option value="followup">Opfølgning</option>' +
            '</select>' +
            '<select class="k3-af-select" id="k3ActResult" style="display:none;">' +
                '<option value="">— Resultat —</option>' +
                '<option value="reached">Nået</option>' +
                '<option value="no_answer">Intet svar</option>' +
                '<option value="busy">Optaget</option>' +
                '<option value="voicemail">Besked</option>' +
                '<option value="callback">Callback</option>' +
                '<option value="email_instead">Email i stedet</option>' +
            '</select>' +
            '<div class="k3-sentiment-btns" id="k3Sentiment" style="display:none;">' +
                '<button class="k3-sent-btn" data-s="positive" onclick="_k3ToggleSentiment(this)">😊</button>' +
                '<button class="k3-sent-btn" data-s="neutral" onclick="_k3ToggleSentiment(this)">😐</button>' +
                '<button class="k3-sent-btn" data-s="negative" onclick="_k3ToggleSentiment(this)">😟</button>' +
            '</div>' +
        '</div>' +
        '<textarea class="k3-af-textarea" id="k3ActText" placeholder="Noter..."></textarea>' +
        '<div class="k3-af-row" style="justify-content:flex-end;">' +
            '<button class="k3-af-submit" onclick="_k3SubmitActivity()">Log aktivitet</button>' +
        '</div>' +
    '</div>';

    // Filter chips
    const filters = [
        { key: 'all', label: 'Alle' },
        { key: 'call', label: 'Opkald' },
        { key: 'note', label: 'Noter' },
        { key: 'meeting', label: 'Møder' },
        { key: 'sentiment', label: '😊 Med smiley' },
    ];
    html += '<div class="k3-tl-filters" id="k3TlFilters">' +
        filters.map(f =>
            '<button class="k3-tl-filter' + (f.key === _k3ActFilter ? ' active' : '') + '" data-filter="' + f.key + '">' + f.label + '</button>'
        ).join('') +
    '</div>';

    // Filter activities
    let activities = _k3Data.activities || [];
    if (_k3ActFilter === 'call') activities = activities.filter(a => ['call', 'service_call'].includes(a.type));
    else if (_k3ActFilter === 'note') activities = activities.filter(a => a.type === 'note');
    else if (_k3ActFilter === 'meeting') activities = activities.filter(a => a.type === 'meeting');
    else if (_k3ActFilter === 'sentiment') activities = activities.filter(a => a.sentiment);

    // Timeline with month dividers
    html += '<div class="k3-timeline">';
    if (activities.length) {
        let lastMonth = '';
        activities.forEach((a, idx) => {
            // Month divider
            const dateStr = (a.created_at || '').substring(0, 7); // "2026-03"
            if (dateStr && dateStr !== lastMonth) {
                lastMonth = dateStr;
                const parts = dateStr.split('-');
                const monthName = MONTH_NAMES_DA[parseInt(parts[1]) - 1] || '';
                html += '<div class="k3-month-divider">' + monthName + ' ' + parts[0] + '</div>';
            }

            const sentBadge = a.sentiment ?
                '<span class="k3-tl-sentiment ' + a.sentiment + '">' + sentimentEmoji[a.sentiment] + ' ' + sentimentLabel[a.sentiment] + '</span>' : '';
            const resultText = a.result ? (resultLabels[a.result] || a.result) : '';
            const label = typeLabels[a.type] || a.type;
            const iconClass = typeIconClasses[a.type] || 'type-note';
            const icon = typeIcons[a.type] || '•';
            const isLast = idx === activities.length - 1;
            const time = (a.created_at || '').substring(0, 16).replace('T', ' ');
            const who = a.user_name || '';

            html += '<div class="k3-timeline-item">' +
                '<div class="k3-tl-left">' +
                    '<div class="k3-tl-icon ' + iconClass + '">' + icon + '</div>' +
                    (!isLast ? '<div class="k3-tl-connector"></div>' : '') +
                '</div>' +
                '<div class="k3-tl-card">' +
                    '<div class="k3-tl-header">' +
                        '<span class="k3-tl-type">' + label + (resultText ? ' → ' + resultText : '') + '</span>' +
                        (who ? '<span class="k3-tl-who">' + who + '</span>' : '') +
                        '<span class="k3-tl-time">' + time + '</span>' +
                    '</div>' +
                    (a.text ? '<div class="k3-tl-text">' + a.text + '</div>' : '') +
                    ((sentBadge || a.bon_number) ? '<div class="k3-tl-footer">' +
                        sentBadge +
                        (a.bon_number ? '<span class="k3-tl-bon-ref">#' + a.bon_number + '</span>' : '') +
                    '</div>' : '') +
                '</div>' +
            '</div>';
        });
    } else {
        html += '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen aktiviteter' +
            (_k3ActFilter !== 'all' ? ' med dette filter' : ' endnu') + '</div>';
    }
    html += '</div>';

    el.innerHTML = html;

    // Wire filter chips
    document.getElementById('k3TlFilters')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.k3-tl-filter');
        if (!btn) return;
        _k3ActFilter = btn.dataset.filter;
        _k3RenderActivity(el);
    });

    // Wire type/result toggling
    const typeEl = document.getElementById('k3ActType');
    const resultEl = document.getElementById('k3ActResult');
    const sentEl = document.getElementById('k3Sentiment');

    typeEl.addEventListener('change', () => {
        const isCall = ['call', 'service_call'].includes(typeEl.value);
        resultEl.style.display = isCall ? '' : 'none';
        if (!isCall) { resultEl.value = ''; sentEl.style.display = 'none'; }
    });
    resultEl.addEventListener('change', () => {
        const show = ['reached', 'callback'].includes(resultEl.value);
        sentEl.style.display = show ? 'flex' : 'none';
    });
}

function _k3RenderOffers(el) {
    if (!_k3Data) { el.innerHTML = ''; return; }
    const offers = _k3Data.orders.filter(o => o.is_offer);
    if (!offers.length) {
        el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen tilbud for denne kunde</div>';
        return;
    }
    el.innerHTML = offers.map(o =>
        '<div class="k3-order-row">' +
            '<span class="k3-order-bon">#' + o.bon_number + '</span>' +
            '<span>' + o.delivery_date + '</span>' +
            '<span>' + (o.total_price ? Math.round(o.total_price).toLocaleString('da-DK') + ' kr' : '—') + '</span>' +
            '<span class="k3-order-status">' + (o.offer_status || o.status) + '</span>' +
        '</div>'
    ).join('');
}

// ─── Activity form helpers ──────────────────────────────────

function _k3ToggleSentiment(btn) {
    document.querySelectorAll('.k3-sent-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

async function _k3SubmitActivity() {
    const type = document.getElementById('k3ActType').value;
    const result = document.getElementById('k3ActResult').value || null;
    const text = document.getElementById('k3ActText').value.trim();
    const sentBtn = document.querySelector('.k3-sent-btn.selected');
    const sentiment = sentBtn ? sentBtn.dataset.s : null;

    if (!text) { alert('Skriv en note'); return; }

    try {
        await postCrmActivity({
            customer_id: _k3CustomerId,
            type, result, sentiment, text,
        });
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3SubmitQuickNote() {
    const textarea = document.getElementById('k3QuickNote');
    const text = textarea ? textarea.value.trim() : '';
    if (!text) { alert('Skriv en note'); return; }

    try {
        await postCrmActivity({
            customer_id: _k3CustomerId,
            type: 'note',
            text,
        });
        textarea.value = '';
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3ChangeStage(stage) {
    try {
        await patchCrmCustomerStage(_k3CustomerId, stage);
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

// ─── Mail tab ───────────────────────────────────────────────

async function _k3RenderMail(el) {
    if (!_k3Data) return;
    const c = _k3Data.customer;
    const email = c.email || '';

    // Compose form
    let html = '<div class="k3-mail-compose">' +
        '<div class="k3-mail-field">' +
            '<label>Til</label>' +
            '<input type="email" class="k3-mail-input" id="k3MailTo" value="' + email + '">' +
        '</div>' +
        '<div class="k3-mail-field">' +
            '<label>Emne</label>' +
            '<input type="text" class="k3-mail-input" id="k3MailSubject" placeholder="Emne...">' +
        '</div>' +
        '<div class="k3-mail-field">' +
            '<label>Besked</label>' +
            '<textarea class="k3-mail-body" id="k3MailBody" placeholder="Skriv din besked..."></textarea>' +
        '</div>' +
        '<button class="k3-mail-send" onclick="_k3SendMail()">Send mail</button>' +
    '</div>';

    // Load existing mail threads for this customer's bons
    try {
        const bonsWithMail = _k3Data.orders.filter(o => o.id);
        let allMessages = [];
        for (const o of bonsWithMail.slice(0, 5)) {
            try {
                const mailData = await fetchBonMail(o.id);
                if (mailData.threads) {
                    for (const t of mailData.threads) {
                        for (const m of (t.messages || [])) {
                            allMessages.push({ ...m, bon_number: o.bon_number });
                        }
                    }
                }
            } catch (e) { /* bon har ingen mail */ }
        }

        allMessages.sort((a, b) => (b.received_at || b.sent_at || '').localeCompare(a.received_at || a.sent_at || ''));

        if (allMessages.length) {
            html += '<h4 style="font-size:11px;text-transform:uppercase;color:var(--color-text-dim);margin:16px 0 8px;">Mail-historik</h4>';
            html += allMessages.slice(0, 20).map(m => {
                const dir = m.direction === 'in' ? 'in' : 'out';
                const who = dir === 'in' ? (m.from_name || m.from_email || 'Ukendt') : 'Ristet Rug';
                const time = (m.received_at || m.sent_at || '').substring(0, 16).replace('T', ' ');
                return '<div class="k3-mail-msg ' + dir + '">' +
                    '<div class="k3-mail-msg-header">' +
                        '<span>' + (dir === 'in' ? '📥' : '📤') + ' ' + who + (m.bon_number ? ' · #' + m.bon_number : '') + '</span>' +
                        '<span>' + time + '</span>' +
                    '</div>' +
                    '<div style="font-size:12px;font-weight:600;margin-bottom:2px;">' + (m.subject || '') + '</div>' +
                    '<div class="k3-mail-msg-body">' + ((m.body_text || '').substring(0, 300)) + '</div>' +
                '</div>';
            }).join('');
        }
    } catch (err) {
        console.error('[k3] Mail load error:', err);
    }

    el.innerHTML = html;
}

async function _k3SendMail() {
    const to = document.getElementById('k3MailTo').value.trim();
    const subject = document.getElementById('k3MailSubject').value.trim();
    const text = document.getElementById('k3MailBody').value.trim();

    if (!to || !subject || !text) { alert('Udfyld alle felter'); return; }

    // Find first bon for this customer to attach mail to
    const bonId = _k3Data && _k3Data.orders.length ? _k3Data.orders[0].id : null;
    if (!bonId) { alert('Ingen bon fundet at knytte mail til'); return; }

    try {
        await sendBonMail(bonId, { to, subject, text });
        alert('Mail sendt!');
        _k3RenderTab();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

function _k3GoBack() {
    const url = new URL(window.location);
    url.searchParams.delete('customer');
    history.replaceState({}, '', url);
    _k3CustomerId = null;
    _k3Data = null;
    _k3RenderSearch();
}

// ─── SSE handler ────────────────────────────────────────────

function _k3HandleSSE(eventType, data) {
    if (!_k3Active || !_k3CustomerId) return;
    if (data.customer_id === _k3CustomerId) {
        _k3LoadData();
    }
}
