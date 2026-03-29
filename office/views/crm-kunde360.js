/**
 * office/views/crm-kunde360.js
 * ════════════════════════════════════════════════════════════
 * Kunde 360° profil — info, ordrer, aktiviteter, tilbud
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
            .k3-search-wrap { max-width: 600px; margin: 40px auto; }
            .k3-search-input {
                width: 100%; padding: 12px 16px; font-size: 15px;
                border: 2px solid var(--color-border, #d7d1ca); border-radius: 10px;
                outline: none; background: var(--color-surface, #fff);
            }
            .k3-search-input:focus { border-color: var(--brand-primary, #8e631f); }
            .k3-search-results { margin-top: 8px; }
            .k3-search-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 14px; border-bottom: 1px solid var(--color-border, #eee);
                cursor: pointer; border-radius: 6px;
            }
            .k3-search-row:hover { background: var(--brand-primary-light, #f1e6b2); }
            .k3-search-name { font-weight: 600; }
            .k3-search-company { font-size: 12px; color: var(--color-text-dim, #888); }
            .k3-search-stats { font-size: 12px; color: var(--color-text-dim, #888); text-align: right; }
            .k3-stage-filters { display: flex; gap: 6px; margin: 16px 0; flex-wrap: wrap; }
            .k3-stage-btn {
                padding: 4px 12px; border-radius: 16px; border: 1px solid var(--color-border, #ddd);
                background: var(--color-surface, #fff); font-size: 12px; cursor: pointer;
            }
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
        const stageBadge = r.stage ? '<span style="margin-left:6px;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;' +
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
            .k3-layout { display: grid; grid-template-columns: 320px 1fr; gap: 12px; height: 100%; }
            @media (max-width: 900px) { .k3-layout { grid-template-columns: 1fr; } }

            .k3-left {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
                overflow-y: auto;
            }
            .k3-right { overflow-y: auto; }

            .k3-back { font-size: 12px; color: var(--color-text-dim, #888); cursor: pointer; margin-bottom: 12px; }
            .k3-back:hover { color: var(--brand-primary); }
            .k3-name { font-size: 20px; font-weight: 700; margin-bottom: 2px; }
            .k3-company { font-size: 14px; color: var(--color-text-dim, #888); margin-bottom: 12px; }
            .k3-stage-badge {
                display: inline-block; padding: 2px 10px; border-radius: 12px;
                font-size: 11px; font-weight: 700; margin-bottom: 12px;
            }
            .k3-stage-vip { background: #f5f0e0; color: #8e631f; }
            .k3-stage-active { background: #e8f2dc; color: #3d7a0a; }
            .k3-stage-dormant { background: #f0eded; color: #888; }
            .k3-stage-lead { background: #e0ecf5; color: #2a6fb0; }

            .k3-contact-row { font-size: 13px; padding: 4px 0; display: flex; gap: 8px; }
            .k3-contact-label { color: var(--color-text-dim, #888); min-width: 50px; }

            .k3-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 16px 0; }
            .k3-stat { text-align: center; }
            .k3-stat-value { font-size: 18px; font-weight: 900; color: var(--brand-primary); }
            .k3-stat-label { font-size: 10px; color: var(--color-text-dim); text-transform: uppercase; }

            .k3-products { margin-top: 16px; }
            .k3-products h4 { font-size: 11px; text-transform: uppercase; color: var(--color-text-dim); margin-bottom: 6px; }
            .k3-prod-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }

            .k3-tabs { display: flex; gap: 0; margin-bottom: 12px; }
            .k3-tab {
                padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
                border-bottom: 2px solid transparent; color: var(--color-text-dim);
            }
            .k3-tab.active { border-bottom-color: var(--brand-primary); color: var(--brand-primary); }

            .k3-tab-content {
                background: var(--color-surface, #fff); border-radius: 10px;
                padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
            }

            .k3-order-row {
                display: grid; grid-template-columns: auto 1fr auto auto auto;
                gap: 8px; align-items: center; padding: 8px 0;
                border-bottom: 1px solid var(--color-border, #eee); font-size: 13px; cursor: pointer;
            }
            .k3-order-row:hover { background: var(--brand-primary-light, #f1e6b2); margin: 0 -18px; padding: 8px 18px; }
            .k3-order-bon { font-weight: 600; color: var(--brand-primary); }
            .k3-order-status {
                display: inline-block; padding: 1px 6px; border-radius: 4px;
                font-size: 10px; font-weight: 700; background: #f0f0f0;
            }

            .k3-activity-form { margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fafafa; border: 1px solid var(--color-border); }
            .k3-af-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
            .k3-af-select { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; }
            .k3-af-textarea { width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 60px; }
            .k3-af-submit {
                padding: 6px 16px; border-radius: 6px; border: none;
                background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer;
            }

            .k3-sentiment-btns { display: flex; gap: 6px; }
            .k3-sent-btn {
                width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--color-border);
                background: var(--color-surface); font-size: 18px; cursor: pointer; display: flex;
                align-items: center; justify-content: center;
            }
            .k3-sent-btn.selected { border-color: var(--brand-primary); background: var(--brand-primary-light); }

            .k3-timeline-item {
                padding: 10px 0; border-bottom: 1px solid var(--color-border, #eee); font-size: 13px;
            }
            .k3-tl-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
            .k3-tl-type { font-weight: 600; }
            .k3-tl-time { font-size: 11px; color: var(--color-text-dim); margin-left: auto; }
            .k3-tl-text { color: var(--color-text-dim); }
            .k3-tl-sentiment {
                display: inline-block; margin-left: 6px; padding: 0 4px; border-radius: 4px; font-size: 10px;
            }
            .k3-tl-sentiment.positive { background: #e8f2dc; }
            .k3-tl-sentiment.negative { background: #fde8e8; }
            .k3-tl-sentiment.neutral { background: #f5f0e0; }

            .k3-stage-select { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 12px; margin-top: 12px; }

            .k3-mail-compose { padding: 12px; border-radius: 8px; background: #fafafa; border: 1px solid var(--color-border); margin-bottom: 16px; }
            .k3-mail-field { margin-bottom: 8px; }
            .k3-mail-field label { display: block; font-size: 11px; font-weight: 700; color: var(--color-text-dim); text-transform: uppercase; margin-bottom: 3px; }
            .k3-mail-input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; }
            .k3-mail-body { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--color-border); font-size: 13px; resize: vertical; min-height: 100px; font-family: inherit; }
            .k3-mail-send { padding: 8px 20px; border-radius: 6px; border: none; background: var(--brand-primary); color: white; font-size: 13px; font-weight: 600; cursor: pointer; }
            .k3-mail-msg { padding: 10px; margin-bottom: 12px; border-radius: 8px; }
            .k3-mail-msg.in { background: #f0f4f8; border-left: 3px solid #2a6fb0; }
            .k3-mail-msg.out { background: #faf6ee; border-left: 3px solid var(--brand-primary); }
            .k3-mail-msg-header { font-size: 11px; color: var(--color-text-dim); margin-bottom: 4px; display: flex; justify-content: space-between; }
            .k3-mail-msg-body { font-size: 13px; white-space: pre-wrap; }
        </style>

        <div class="k3-layout">
            <div class="k3-left" id="k3Left">
                <div class="k3-back" onclick="_k3GoBack()">← Alle kunder</div>
                <div id="k3Profile">Indlæser...</div>
            </div>
            <div class="k3-right">
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
        _k3RenderTab();
    } catch (err) {
        console.error('[k3] Load error:', err);
        const el = document.getElementById('k3Profile');
        if (el) el.textContent = 'Fejl: ' + err.message;
    }
}

function _k3RenderProfile() {
    const el = document.getElementById('k3Profile');
    if (!el || !_k3Data) return;
    const c = _k3Data.customer;
    const s = _k3Data.stats;

    const stageClass = 'k3-stage-' + (c.stage || 'active');
    const stageName = { vip: 'VIP', active: 'AKTIV', dormant: 'SOVENDE', lead: 'LEAD' }[c.stage || 'active'];

    el.innerHTML =
        '<div class="k3-name">' + (c.first_name || '') + ' ' + (c.last_name || '') + '</div>' +
        (c.company_name ? '<div class="k3-company">' + c.company_name + '</div>' : '') +
        '<span class="k3-stage-badge ' + stageClass + '">' + stageName + '</span>' +

        '<div class="k3-contact-row"><span class="k3-contact-label">📞</span>' +
            (c.phone ? '<a href="tel:' + c.phone.replace(/\s/g, '') + '">' + c.phone + '</a>' : '—') + '</div>' +
        '<div class="k3-contact-row"><span class="k3-contact-label">✉</span>' +
            (c.email || '—') + '</div>' +

        '<div class="k3-stats-grid">' +
            '<div class="k3-stat"><div class="k3-stat-value">' + (s.total_orders || 0) + '</div><div class="k3-stat-label">Ordrer</div></div>' +
            '<div class="k3-stat"><div class="k3-stat-value">' + Math.round(s.total_revenue || 0).toLocaleString('da-DK') + '</div><div class="k3-stat-label">Omsætning</div></div>' +
            '<div class="k3-stat"><div class="k3-stat-value">' + Math.round(s.avg_order || 0).toLocaleString('da-DK') + '</div><div class="k3-stat-label">Gns. ordre</div></div>' +
            '<div class="k3-stat"><div class="k3-stat-value">' + (s.last_order || '—') + '</div><div class="k3-stat-label">Seneste</div></div>' +
        '</div>' +

        (_k3Data.products.length ? '<div class="k3-products"><h4>Top produkter</h4>' +
            _k3Data.products.map(p =>
                '<div class="k3-prod-row"><span>' + p.product_name + '</span><span>' + p.total_qty + ' stk</span></div>'
            ).join('') + '</div>' : '') +

        '<select class="k3-stage-select" id="k3StageSelect" onchange="_k3ChangeStage(this.value)">' +
            ['lead', 'active', 'dormant', 'vip'].map(st =>
                '<option value="' + st + '"' + (st === (c.stage || 'active') ? ' selected' : '') + '>' +
                    { lead: 'Lead', active: 'Aktiv', dormant: 'Sovende', vip: 'VIP' }[st] + '</option>'
            ).join('') +
        '</select>';
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

function _k3RenderActivity(el) {
    const typeIcons = { call: '📞', service_call: '📞', meeting: '🤝', task: '📋', note: '📝', followup: '🔔', offer_sent: '📤', email_in: '📥', email_out: '📤' };
    const sentimentEmoji = { positive: '😊', neutral: '😐', negative: '😟' };

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

    // Timeline
    const activities = _k3Data.activities;
    if (activities.length) {
        html += activities.map(a => {
            const sentBadge = a.sentiment ? '<span class="k3-tl-sentiment ' + a.sentiment + '">' + (sentimentEmoji[a.sentiment] || '') + '</span>' : '';
            const resultText = a.result ? ' → ' + a.result : '';
            return '<div class="k3-timeline-item">' +
                '<div class="k3-tl-header">' +
                    '<span>' + (typeIcons[a.type] || '•') + '</span>' +
                    '<span class="k3-tl-type">' + a.type + resultText + '</span>' +
                    sentBadge +
                    (a.bon_number ? '<span style="font-size:11px;color:var(--color-text-dim);">#' + a.bon_number + '</span>' : '') +
                    '<span class="k3-tl-time">' + (a.created_at || '').substring(0, 16) + '</span>' +
                '</div>' +
                '<div class="k3-tl-text">' + (a.text || '') + '</div>' +
            '</div>';
        }).join('');
    } else {
        html += '<div style="text-align:center;padding:20px;color:var(--color-text-dim);">Ingen aktiviteter endnu</div>';
    }

    el.innerHTML = html;

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
        sentEl.style.display = resultEl.value === 'reached' ? 'flex' : 'none';
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
                const time = (m.received_at || m.sent_at || '').substring(0, 16);
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
