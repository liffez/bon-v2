/**
 * office/views/crm-outreach.js
 * ════════════════════════════════════════════════════════════
 * Outreach-kampagne pipeline-board.
 * Kanban med 4 åbne kolonner + collapsible Tabt-sektion.
 *
 * Campaign-selector øverst: "Alle aktive kampagner" eller specifik.
 * Drag-drop: PATCH /campaigns/:c/members/:m status.
 *   - Multi-kampagne-modal i global visning når kunde er i flere åbne kampagner
 *   - Lost-reason-modal ved drop på Tabt (lost_reason påkrævet)
 *
 * SSE: campaign_created/updated, campaign_members_added,
 *      campaign_member_updated, campaign_member_removed.
 *
 * Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 4.
 * ════════════════════════════════════════════════════════════
 */

let _coContainer = null;
let _coCampaigns = [];
let _coData = null;       // { active_campaign_id, columns }
let _coActiveCampaign = null; // null = global, eller campaign_id
let _coDragMember = null;
let _coShowLost = false;
let _coLoading = false;

async function initCrmOutreach(container) {
    _coContainer = container;
    // Initial: læs evt. ?campaign= fra URL
    const params = new URLSearchParams(window.location.search);
    const c = params.get('campaign');
    _coActiveCampaign = c ? parseInt(c, 10) : null;
    _coShowLost = params.get('lost') === '1';

    _coRenderShell();
    // Wire toolbar-knapper (én gang, ved shell-render)
    const newBtn = document.getElementById('co-new-btn');
    if (newBtn) newBtn.addEventListener('click', _coOpenNewCampaignModal);
    const importBtn = document.getElementById('co-import-btn');
    if (importBtn) importBtn.addEventListener('click', _coOpenImportDrawer);
    await _coLoadCampaigns();
    await _coLoadPipeline();
}

function cleanupCrmOutreach() {
    _coContainer = null;
    _coCampaigns = [];
    _coData = null;
    _coDragMember = null;
}

async function _coLoadCampaigns() {
    try {
        _coCampaigns = await fetchCampaigns(); // kun aktive
        _coRenderSelector();
    } catch (err) {
        console.error('outreach load campaigns:', err);
        _coCampaigns = [];
    }
}

async function _coLoadPipeline() {
    if (_coLoading) return;
    _coLoading = true;
    try {
        _coData = await fetchCampaignPipeline(_coActiveCampaign);
        _coRenderBoard();
    } catch (err) {
        console.error('outreach pipeline load:', err);
        const board = document.getElementById('co-board');
        if (board) board.innerHTML = '<div class="co-empty">Kunne ikke hente pipeline: ' + (err.message || 'ukendt fejl') + '</div>';
    } finally {
        _coLoading = false;
    }
}

function _coRenderShell() {
    const topTitle = document.getElementById('office-topbar-title');
    if (topTitle) topTitle.textContent = 'Outreach — Kampagner';

    _coContainer.innerHTML = `
        <style>
            .co-wrap { padding: 0; }
            .co-toolbar {
                display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
                margin-bottom: 14px;
            }
            .co-toolbar-label {
                font-size: 12px; font-weight: 600; text-transform: uppercase;
                letter-spacing: .04em; color: var(--color-text-dim);
            }
            .co-select {
                padding: 8px 12px; border-radius: 8px;
                border: 1px solid var(--color-border, #d7d1ca);
                background: var(--color-surface, #fff); font-size: 14px;
                font-family: inherit; min-width: 240px;
            }
            .co-new-btn {
                padding: 8px 14px; border-radius: 8px; border: none;
                background: var(--brand-primary, #8e631f); color: #fff;
                font-size: 14px; font-weight: 600; cursor: pointer;
                font-family: inherit;
            }
            .co-new-btn:hover { filter: brightness(1.08); }
            .co-empty {
                padding: 30px; text-align: center; color: var(--color-text-dim);
                background: var(--color-surface, #fff); border-radius: 10px;
            }

            /* Kanban-board */
            .co-board {
                display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 12px;
            }
            @media (max-width: 1100px) {
                .co-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            }
            .co-col {
                background: var(--color-surface, #fff);
                border-radius: 10px; padding: 12px;
                min-height: 200px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            .co-col.drag-over { background: var(--brand-primary-light, #f1e6b2); }
            .co-col-head {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 10px; padding-bottom: 6px;
                border-bottom: 2px solid var(--color-border, #e7e2db);
            }
            .co-col-label {
                font-size: 13px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .04em;
            }
            .co-col-count {
                background: var(--color-background, #f5f4f2); color: var(--color-text-dim);
                font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
            }
            .co-col[data-status="lead"] .co-col-label        { color: #2a6fb0; }
            .co-col[data-status="contacted"] .co-col-label   { color: #8e631f; }
            .co-col[data-status="negotiating"] .co-col-label { color: #b8761c; }
            .co-col[data-status="won"] .co-col-label         { color: #2c7a3d; }

            .co-drop-zone { min-height: 60px; display: flex; flex-direction: column; gap: 8px; }
            .co-drop-empty {
                color: var(--color-text-dim); font-size: 12px; font-style: italic;
                text-align: center; padding: 16px 0;
            }

            .co-card {
                background: var(--color-background, #f8f6f3);
                border-radius: 8px; padding: 10px 12px;
                border-left: 3px solid var(--brand-primary, #8e631f);
                cursor: grab; user-select: none;
                font-size: 13px;
                transition: transform .12s, box-shadow .12s;
            }
            .co-card:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
            .co-card.dragging { opacity: 0.4; cursor: grabbing; }
            .co-card[data-type="b2c"] { border-left-color: #2a6fb0; }
            .co-card[data-type="b2b_only"] { border-left-color: #8e631f; }
            .co-card[data-type="b2b_with_contact"] { border-left-color: #2c7a3d; }
            .co-card-campaign {
                font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
                color: var(--color-text-dim); margin-bottom: 4px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .co-card-name { font-weight: 700; display: flex; align-items: center; gap: 6px; }
            .co-card-icon { font-size: 14px; }
            .co-card-sub { font-size: 12px; color: var(--color-text-dim); margin-top: 2px; }
            .co-card-footer {
                display: flex; justify-content: space-between; align-items: center;
                margin-top: 6px; gap: 6px;
            }
            .co-multi-badge {
                background: #b8761c; color: #fff; font-size: 10px;
                padding: 1px 6px; border-radius: 6px; font-weight: 600;
            }
            .co-assigned {
                font-size: 11px; color: var(--color-text-dim);
            }

            /* Tabt-sektion */
            .co-lost {
                margin-top: 18px; background: var(--color-surface, #fff);
                border-radius: 10px; padding: 12px;
            }
            .co-lost-head {
                display: flex; justify-content: space-between; align-items: center;
                cursor: pointer; user-select: none;
            }
            .co-lost-title { font-weight: 700; color: var(--color-text-dim); font-size: 13px; }
            .co-lost-toggle { font-size: 11px; color: var(--color-text-dim); }
            .co-lost-list {
                display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                gap: 8px; margin-top: 10px;
            }
            .co-lost-card {
                background: var(--color-background, #f8f6f3); padding: 8px 10px;
                border-radius: 6px; font-size: 12px; opacity: 0.75;
            }
            .co-lost-reason {
                font-size: 11px; color: #a13d2e; margin-top: 2px; font-style: italic;
            }

            /* Drop-zone til Tabt — vises kun mens drag er i gang */
            .co-lost-dropzone {
                margin-top: 12px; padding: 16px; text-align: center;
                background: var(--color-surface, #fff);
                border: 2px dashed var(--color-border, #d7d1ca);
                border-radius: 10px; color: var(--color-text-dim);
                font-size: 13px; font-style: italic;
                display: none;
            }
            body.co-dragging .co-lost-dropzone { display: block; }
            .co-lost-dropzone.drag-over {
                border-color: #a13d2e; color: #a13d2e;
                background: #fdecea;
            }

            /* Modals — multi-kampagne + lost-reason */
            .co-modal-overlay {
                position: fixed; inset: 0; background: rgba(0,0,0,0.45);
                display: flex; align-items: center; justify-content: center;
                z-index: 9999;
            }
            .co-modal {
                background: var(--color-surface, #fff); border-radius: 12px;
                width: 420px; max-width: 92vw;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            }
            .co-modal-header {
                padding: 16px 22px; border-bottom: 1px solid var(--color-border);
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 18px; font-weight: 700;
            }
            .co-modal-body { padding: 18px 22px; }
            .co-modal-footer {
                padding: 14px 22px; border-top: 1px solid var(--color-border);
                display: flex; justify-content: flex-end; gap: 10px;
            }
            .co-radio-row {
                display: block; padding: 8px 0; cursor: pointer; font-size: 14px;
            }
            .co-radio-row input { margin-right: 8px; }
            .co-modal-input, .co-modal-textarea {
                width: 100%; box-sizing: border-box; padding: 9px 12px;
                font-size: 14px; border: 1px solid var(--color-border);
                border-radius: 8px; font-family: inherit; margin-top: 8px;
            }
            .co-modal-textarea { min-height: 60px; resize: vertical; }
            .co-quick-reasons {
                display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
            }
            .co-quick-reason {
                padding: 5px 10px; border-radius: 6px;
                border: 1px solid var(--color-border); background: var(--color-surface);
                font-size: 12px; cursor: pointer; font-family: inherit;
            }
            .co-quick-reason:hover { background: var(--brand-primary-light); }
            .co-btn {
                padding: 8px 16px; border-radius: 8px; border: none;
                font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
            }
            .co-btn-cancel { background: transparent; color: var(--color-text-dim); }
            .co-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
            .co-btn-primary:hover { filter: brightness(1.08); }
        </style>
        <div class="co-wrap">
            <div class="co-toolbar">
                <span class="co-toolbar-label">Kampagne:</span>
                <select class="co-select" id="co-select" disabled>
                    <option>Henter…</option>
                </select>
                <button class="co-new-btn" id="co-new-btn" type="button">+ Ny kampagne</button>
                <button class="co-new-btn co-import-btn" id="co-import-btn" type="button" style="display:none;background:var(--color-surface,#fff);color:var(--brand-primary,#8e631f);border:1px solid var(--brand-primary,#8e631f);">📋 Importér</button>
                <span style="flex:1"></span>
                <span class="co-toolbar-label" id="co-summary"></span>
            </div>
            <div class="co-board" id="co-board"></div>
            <div class="co-lost" id="co-lost-section" data-status="lost" style="display:none;">
                <div class="co-lost-head" onclick="_coToggleLost()">
                    <span class="co-lost-title" id="co-lost-title">Tabte (0)</span>
                    <span class="co-lost-toggle" id="co-lost-toggle">▸ Vis</span>
                </div>
                <div id="co-lost-list" style="display:none;"></div>
            </div>
            <!-- Drop-zone til Tabt: vises kun mens drag er i gang -->
            <div class="co-lost-dropzone" id="co-lost-dropzone" data-status="lost">
                <span>⬇ Træk hertil for at markere som tabt</span>
            </div>
        </div>
    `;
}

function _coRenderSelector() {
    const sel = document.getElementById('co-select');
    if (!sel) return;
    sel.disabled = false;
    const opts = ['<option value="">Alle aktive kampagner</option>'];
    for (const c of _coCampaigns) {
        const selected = c.id === _coActiveCampaign ? ' selected' : '';
        opts.push('<option value="' + c.id + '"' + selected + '>' +
            _coEsc(c.name) + (c.open_count ? ' (' + c.open_count + ')' : '') +
            '</option>');
    }
    sel.innerHTML = opts.join('');
    sel.onchange = () => {
        _coActiveCampaign = sel.value ? parseInt(sel.value, 10) : null;
        const url = new URL(window.location);
        if (_coActiveCampaign) url.searchParams.set('campaign', _coActiveCampaign);
        else url.searchParams.delete('campaign');
        history.replaceState({}, '', url);
        _coUpdateImportBtn();
        _coLoadPipeline();
    };
    _coUpdateImportBtn();
}

function _coUpdateImportBtn() {
    // Import-knap vises kun når en specifik kampagne er valgt (paste-import
    // tilføjer til ÉN kampagne — "alle aktive kampagner" giver ikke mening).
    const btn = document.getElementById('co-import-btn');
    if (!btn) return;
    btn.style.display = _coActiveCampaign ? '' : 'none';
}

function _coOpenImportDrawer() {
    if (!_coActiveCampaign) return;
    if (typeof window.CampaignImportDrawer?.open !== 'function') {
        alert('Import-komponent ikke loadet');
        return;
    }
    const camp = _coCampaigns.find(c => c.id === _coActiveCampaign);
    window.CampaignImportDrawer.open({
        campaignId: _coActiveCampaign,
        campaignName: camp?.name || ('Kampagne #' + _coActiveCampaign),
        onDone: () => { _coLoadPipeline(); },
    });
}

function _coRenderBoard() {
    const board = document.getElementById('co-board');
    if (!board || !_coData) return;
    const cols = _coData.columns;

    const openCols = ['lead', 'contacted', 'negotiating', 'won'];
    board.innerHTML = openCols.map(key => {
        const col = cols[key];
        return '<div class="co-col" data-status="' + key + '">' +
            '<div class="co-col-head">' +
                '<span class="co-col-label">' + _coEsc(col.label) + '</span>' +
                '<span class="co-col-count">' + col.members.length + '</span>' +
            '</div>' +
            '<div class="co-drop-zone" data-status="' + key + '">' +
                (col.members.length === 0
                    ? '<div class="co-drop-empty">Slip her</div>'
                    : col.members.map(m => _coRenderCard(m)).join('')) +
            '</div>' +
        '</div>';
    }).join('');

    // Tabt-sektion
    const lostSection = document.getElementById('co-lost-section');
    const lostMembers = cols.lost.members;
    if (lostMembers.length > 0) {
        lostSection.style.display = '';
        document.getElementById('co-lost-title').textContent = 'Tabte (' + lostMembers.length + ')';
        const lostList = document.getElementById('co-lost-list');
        lostList.className = 'co-lost-list';
        lostList.style.display = _coShowLost ? 'grid' : 'none';
        document.getElementById('co-lost-toggle').textContent = _coShowLost ? '▾ Skjul' : '▸ Vis';
        lostList.innerHTML = lostMembers.map(m => _coRenderLostCard(m)).join('');
    } else {
        lostSection.style.display = 'none';
    }

    // Wire drag-drop
    _coWireDragDrop();

    // Summary
    const totals = openCols.reduce((sum, k) => sum + cols[k].members.length, 0);
    const sum = document.getElementById('co-summary');
    if (sum) sum.textContent = totals + ' aktive · ' + lostMembers.length + ' tabte';
}

function _coRenderCard(m) {
    const icon = m.card_type === 'b2c' ? '👤'
        : m.card_type === 'b2b_with_contact' ? '👤' : '🏢';

    let primary, secondary;
    if (m.card_type === 'b2b_with_contact') {
        primary = m.contact_person || m.company_name || 'Ukendt';
        secondary = m.company_name && primary !== m.company_name ? m.company_name : null;
    } else if (m.card_type === 'b2b_only') {
        primary = m.company_name || 'Ukendt firma';
        secondary = m.company_city || null;
    } else {
        primary = m.contact_person || 'Privatkunde';
        secondary = 'Privatkunde';
    }

    // I global visning vis kampagne-label øverst.
    // I kampagne-specifik visning: ingen label nødvendig.
    const campaignLabel = !_coActiveCampaign
        ? '<div class="co-card-campaign">' + _coEsc(m.campaign_name) + '</div>'
        : '';

    // Multi-kampagne badge: kun relevant i global visning, og kun hvis i >1 åbne
    const multiBadge = (!_coActiveCampaign && m.in_n_open_campaigns > 1)
        ? '<span class="co-multi-badge" title="I ' + m.in_n_open_campaigns + ' åbne kampagner">⚠ ' + m.in_n_open_campaigns + ' kamp.</span>'
        : '';

    const assigned = m.assigned_name
        ? '<span class="co-assigned">' + _coEsc(m.assigned_name) + '</span>'
        : '';

    return '<div class="co-card" draggable="true" data-member-id="' + m.member_id +
        '" data-customer-id="' + (m.customer_id || '') +
        '" data-campaign-id="' + m.campaign_id +
        '" data-type="' + m.card_type + '">' +
        campaignLabel +
        '<div class="co-card-name"><span class="co-card-icon">' + icon + '</span><span>' + _coEsc(primary) + '</span></div>' +
        (secondary ? '<div class="co-card-sub">' + _coEsc(secondary) + '</div>' : '') +
        '<div class="co-card-footer">' +
            multiBadge +
            assigned +
        '</div>' +
    '</div>';
}

function _coRenderLostCard(m) {
    const primary = m.card_type === 'b2b_only'
        ? (m.company_name || 'Ukendt')
        : (m.contact_person || m.company_name || 'Ukendt');
    const campaignLabel = !_coActiveCampaign
        ? '<div class="co-card-campaign">' + _coEsc(m.campaign_name) + '</div>'
        : '';
    return '<div class="co-lost-card">' +
        campaignLabel +
        '<div><strong>' + _coEsc(primary) + '</strong></div>' +
        (m.lost_reason ? '<div class="co-lost-reason">' + _coEsc(m.lost_reason) + '</div>' : '') +
    '</div>';
}

function _coToggleLost() {
    _coShowLost = !_coShowLost;
    const list = document.getElementById('co-lost-list');
    const toggle = document.getElementById('co-lost-toggle');
    if (list) list.style.display = _coShowLost ? 'grid' : 'none';
    if (toggle) toggle.textContent = _coShowLost ? '▾ Skjul' : '▸ Vis';
    const url = new URL(window.location);
    if (_coShowLost) url.searchParams.set('lost', '1');
    else url.searchParams.delete('lost');
    history.replaceState({}, '', url);
}
window._coToggleLost = _coToggleLost;

function _coWireDragDrop() {
    document.querySelectorAll('.co-card[draggable]').forEach(card => {
        card.addEventListener('dragstart', (e) => {
            _coDragMember = {
                member_id: parseInt(card.dataset.memberId, 10),
                campaign_id: parseInt(card.dataset.campaignId, 10),
                customer_id: card.dataset.customerId ? parseInt(card.dataset.customerId, 10) : null,
                current_status: card.closest('.co-col')?.dataset.status,
            };
            card.classList.add('dragging');
            document.body.classList.add('co-dragging'); // viser Tabt-drop-zone
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            document.body.classList.remove('co-dragging');
            document.querySelectorAll('.co-col, .co-lost-dropzone').forEach(c => c.classList.remove('drag-over'));
            _coDragMember = null;
        });
    });

    const dropTargets = [
        ...document.querySelectorAll('.co-col'),
        ...document.querySelectorAll('.co-lost-dropzone'),
    ];
    dropTargets.forEach(zone => {
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            zone.classList.add('drag-over');
        });
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
        });
        zone.addEventListener('drop', async (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (!_coDragMember) return;
            const targetStatus = zone.dataset.status;
            if (targetStatus === _coDragMember.current_status) return;
            await _coHandleDrop(_coDragMember, targetStatus);
        });
    });
}

async function _coHandleDrop(drag, targetStatus) {
    // Lost-status kræver lost_reason — åbn modal først
    if (targetStatus === 'lost') {
        _coOpenLostReasonModal(drag);
        return;
    }
    // Direkte status-skift
    try {
        await patchCampaignMember(drag.campaign_id, drag.member_id, { member_status: targetStatus });
        // SSE re-loader os; men for snappy UX gør vi det manuelt nu
        await _coLoadPipeline();
    } catch (err) {
        console.error('outreach drop:', err);
        alert('Kunne ikke flytte: ' + (err.message || 'ukendt fejl'));
    }
}

// Opret-ny-kampagne modal — åbnes fra toolbar-knappen
function _coOpenNewCampaignModal() {
    const overlay = document.createElement('div');
    overlay.className = 'co-modal-overlay';
    overlay.innerHTML = `
        <div class="co-modal" role="dialog" aria-modal="true">
            <div class="co-modal-header">Ny kampagne</div>
            <div class="co-modal-body">
                <p style="margin:0 0 8px 0;font-size:13px;color:var(--color-text-dim);">
                    Opret en tom kampagne. Tilføj medlemmer bagefter fra Kontakter
                    eller via paste-import.
                </p>
                <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--color-text-dim);">Navn</label>
                <input type="text" class="co-modal-input" id="co-new-name" placeholder="fx Forår 2026 — Kantiner" autofocus>
                <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--color-text-dim);margin-top:12px;display:block;">Beskrivelse <span style="font-weight:400;text-transform:none;letter-spacing:0;">(valgfri)</span></label>
                <textarea class="co-modal-textarea" id="co-new-desc" placeholder="Hvad er formålet med kampagnen?"></textarea>
                <div id="co-new-error" style="display:none;color:#a13d2e;font-size:13px;margin-top:8px;"></div>
            </div>
            <div class="co-modal-footer">
                <button class="co-btn co-btn-cancel" data-action="cancel" type="button">Annullér</button>
                <button class="co-btn co-btn-primary" data-action="ok" type="button">Opret</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#co-new-name');
    const descInput = overlay.querySelector('#co-new-desc');
    const errEl = overlay.querySelector('#co-new-error');
    const submitBtn = overlay.querySelector('[data-action="ok"]');

    const close = () => overlay.remove();
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const submit = async () => {
        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        if (!name) {
            errEl.textContent = 'Indtast et navn.';
            errEl.style.display = '';
            nameInput.focus();
            return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Opretter…';
        errEl.style.display = 'none';
        try {
            const created = await createCampaign({ name, description: desc || null });
            close();
            // Re-load campaigns + vælg den nye + re-load pipeline
            _coActiveCampaign = created.id;
            const url = new URL(window.location);
            url.searchParams.set('campaign', created.id);
            history.replaceState({}, '', url);
            await _coLoadCampaigns();
            await _coLoadPipeline();
        } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Opret';
            // Håndtér 409 name_in_use / name_closed (reopenable)
            if (err.status === 409 && err.body) {
                if (err.body.error === 'name_in_use') {
                    errEl.textContent = 'Navnet er allerede i brug af en aktiv kampagne.';
                } else if (err.body.error === 'name_closed' && err.body.reopenable && err.body.existing_id) {
                    const ok = window.confirm(
                        `Der findes en lukket kampagne med navnet "${name}". Vil du genåbne den?`,
                    );
                    if (!ok) { errEl.textContent = 'Genåbning afvist.'; errEl.style.display = ''; return; }
                    try {
                        await reopenCampaign(err.body.existing_id);
                        close();
                        _coActiveCampaign = err.body.existing_id;
                        const url = new URL(window.location);
                        url.searchParams.set('campaign', err.body.existing_id);
                        history.replaceState({}, '', url);
                        await _coLoadCampaigns();
                        await _coLoadPipeline();
                        return;
                    } catch (reopenErr) {
                        errEl.textContent = 'Kunne ikke genåbne: ' + (reopenErr.message || 'ukendt fejl');
                    }
                } else {
                    errEl.textContent = err.body.error || err.message || 'Ukendt fejl';
                }
            } else {
                errEl.textContent = err.message || 'Ukendt fejl';
            }
            errEl.style.display = '';
        }
    };
    submitBtn.addEventListener('click', submit);
    [nameInput, descInput].forEach(el => el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.target === nameInput || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
        }
        if (e.key === 'Escape') close();
    }));
}

// Lost-reason modal
function _coOpenLostReasonModal(drag) {
    const overlay = document.createElement('div');
    overlay.className = 'co-modal-overlay';
    overlay.innerHTML = `
        <div class="co-modal" role="dialog" aria-modal="true">
            <div class="co-modal-header">Hvorfor tabt?</div>
            <div class="co-modal-body">
                <p style="margin:0 0 8px 0;font-size:13px;color:var(--color-text-dim);">
                    En grund er påkrævet — så vi kan lære af tabte leads.
                </p>
                <input type="text" class="co-modal-input" id="co-lost-reason-input" placeholder="Fri tekst — eller vælg nedenfor" autofocus>
                <div class="co-quick-reasons">
                    <button class="co-quick-reason" data-reason="Pris">Pris</button>
                    <button class="co-quick-reason" data-reason="Timing">Timing</button>
                    <button class="co-quick-reason" data-reason="Ikke budget">Ikke budget</button>
                    <button class="co-quick-reason" data-reason="Bruger anden leverandør">Bruger anden leverandør</button>
                    <button class="co-quick-reason" data-reason="Andet">Andet</button>
                </div>
            </div>
            <div class="co-modal-footer">
                <button class="co-btn co-btn-cancel" data-action="cancel">Annullér</button>
                <button class="co-btn co-btn-primary" data-action="ok">Markér som tabt</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#co-lost-reason-input');
    overlay.querySelectorAll('.co-quick-reason').forEach(b => {
        b.addEventListener('click', () => { input.value = b.dataset.reason; input.focus(); });
    });
    const close = () => overlay.remove();
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-action="ok"]').addEventListener('click', async () => {
        const reason = input.value.trim();
        if (!reason) {
            input.style.borderColor = '#a13d2e';
            input.focus();
            return;
        }
        try {
            await patchCampaignMember(drag.campaign_id, drag.member_id, {
                member_status: 'lost',
                lost_reason: reason,
            });
            close();
            await _coLoadPipeline();
        } catch (err) {
            alert('Kunne ikke gemme: ' + (err.message || 'ukendt fejl'));
        }
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') overlay.querySelector('[data-action="ok"]').click();
        if (e.key === 'Escape') close();
    });
}

function _coEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

// SSE handler — kaldes fra office/index.html
function _coHandleSSE(eventType, _data) {
    if (!_coContainer) return;
    // Alle outreach-events triggerer re-load
    if (eventType === 'campaign_created' || eventType === 'campaign_updated') {
        _coLoadCampaigns().then(() => _coLoadPipeline());
    } else {
        _coLoadPipeline();
    }
}

window.initCrmOutreach = initCrmOutreach;
window.cleanupCrmOutreach = cleanupCrmOutreach;
window._coHandleSSE = _coHandleSSE;
