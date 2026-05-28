// office/views/crm-prospekter.js
// ==========================================
// Prospekter / leads med ICP-fit scoring.
// ==========================================

let _prosContainer = null;
let _prosActive = false;
let _prosData = null;
let _prosIcp = null;
let _prosDebounce = null;
let _prosSearch = '';

function initCrmProspekter(container) {
    _prosContainer = container;
    _prosActive = true;
    container.innerHTML = _prosShellHtml();
    _prosWireSelect();
    _prosLoadData();
}

function cleanupCrmProspekter() {
    _prosActive = false;
    if (_prosDebounce) clearTimeout(_prosDebounce);
    if (window.ListCampaignSelect) window.ListCampaignSelect.detach();
    _prosContainer = null;
}

function _prosWireSelect() {
    if (!window.ListCampaignSelect || !_prosContainer) return;
    const toolbar = _prosContainer.querySelector('.pros-toolbar');
    const host = _prosContainer.querySelector('#pros-list');
    if (!toolbar || !host) return;
    window.ListCampaignSelect.attach({
        hostEl: host,
        toolbarEl: toolbar,
        contentEl: host,
        rowSelector: '.pros-card',
        getEntityFromRow: (row) => ({
            company_id: parseInt(row.dataset.companyId, 10) || null,
            customer_id: parseInt(row.dataset.customerId, 10) || null,
            name: row.dataset.name || '',
        }),
        contextName: 'Prospekter',
        suggestedCampaignName: () => `Outreach ${_prosDanishMonth()}`,
    });
}

function _prosDanishMonth() {
    const months = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];
    const d = new Date();
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

function _prosHandleSSE(event) {
    if (!_prosActive) return;
    if (['rfm_computed', 'crm_stage_changed'].includes(event)) {
        if (_prosDebounce) clearTimeout(_prosDebounce);
        _prosDebounce = setTimeout(() => _prosLoadData(), 2000);
    }
}

async function _prosLoadData() {
    if (!_prosActive) return;
    try {
        const [data, icp] = await Promise.all([
            fetchRfmProspects(),
            _prosIcp ? Promise.resolve(_prosIcp) : fetchRfmIcp('vip'),
        ]);
        _prosData = data;
        _prosIcp = icp;

        // Beregn ICP-fit client-side
        if (_prosIcp?.top_branches?.length) {
            const topBranches = new Set(_prosIcp.top_branches.slice(0, 3).map(b => b.branch));
            const avgEmp = _prosIcp.avg_employees || 50;

            for (const p of _prosData) {
                let fit = 0;
                if (p.branch && topBranches.has(p.branch)) fit += 40;
                if (p.employee_count) {
                    const ratio = p.employee_count / avgEmp;
                    if (ratio >= 0.3 && ratio <= 3) fit += 30;
                    else if (ratio >= 0.1 && ratio <= 5) fit += 15;
                }
                if (p.branch) fit += 10; // Har branchedata = bedre kvalitet
                p.icp_fit = fit;
            }
            _prosData.sort((a, b) => (b.icp_fit || 0) - (a.icp_fit || 0));
        }

        _prosRender();
    } catch (err) {
        if (_prosContainer) _prosContainer.querySelector('#pros-list').innerHTML =
            '<p style="color:red">Fejl: ' + err.message + '</p>';
    }
}

function _prosShellHtml() {
    return `
<style>
.pros-wrap { padding: 24px; max-width: 900px; }
.pros-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.pros-header h2 { margin: 0; font-family: var(--font-heading, serif); }
.pros-toolbar { display: flex; gap: 8px; align-items: center; }
.pros-toolbar input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; width: 200px; }
.pros-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pros-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
.pros-icp-strip { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; font-size: 12px; }
.pros-icp-chip { padding: 4px 10px; background: #f5f0e0; border-radius: 12px; color: #8e631f; }
.pros-card { background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px;
             padding: 14px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.pros-card:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
.pros-info { flex: 1; }
.pros-name { font-size: 15px; font-weight: 600; }
.pros-meta { font-size: 12px; color: #888; margin-top: 2px; }
.pros-fit { text-align: center; min-width: 60px; }
.pros-fit-val { font-size: 22px; font-weight: 700; font-family: var(--font-heading, serif); }
.pros-fit-high { color: #3d7a0a; }
.pros-fit-mid { color: #f0ad4e; }
.pros-fit-low { color: #888; }
.pros-fit-label { font-size: 10px; color: #888; }
.pros-actions { display: flex; gap: 6px; margin-left: 12px; }
.pros-btn-sm { padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff;
               cursor: pointer; font-size: 12px; }
.pros-btn-sm:hover { background: #f5f3f0; }
.pros-empty { text-align: center; padding: 40px; color: #888; }
.pros-count { font-size: 13px; color: #888; margin-bottom: 12px; }
</style>
<div class="pros-wrap">
    <div class="pros-header">
        <h2>Prospekter</h2>
        <div class="pros-toolbar">
            <input type="text" placeholder="Søg..." id="pros-search" oninput="_prosOnSearch(this.value)">
        </div>
    </div>
    <div class="pros-icp-strip" id="pros-icp-strip"></div>
    <div class="pros-count" id="pros-count"></div>
    <div id="pros-list"></div>
</div>`;
}

function _prosRender() {
    if (!_prosActive || !_prosData) return;

    // ICP strip
    const strip = document.getElementById('pros-icp-strip');
    if (strip && _prosIcp?.top_branches) {
        strip.innerHTML = '<span style="color:#888">ICP brancher:</span> ' +
            _prosIcp.top_branches.slice(0, 4).map(b =>
                `<span class="pros-icp-chip">${_prosEsc(b.branch)} (${b.pct}%)</span>`
            ).join('');
    }

    // Filter
    let filtered = _prosData;
    if (_prosSearch) {
        const q = _prosSearch.toLowerCase();
        filtered = _prosData.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.branch || '').toLowerCase().includes(q) ||
            (p.cvr || '').includes(q)
        );
    }

    const countEl = document.getElementById('pros-count');
    if (countEl) countEl.textContent = `${filtered.length} leads` + (_prosSearch ? ` (filtreret)` : '');

    const list = document.getElementById('pros-list');
    if (!list) return;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="pros-empty">Ingen leads fundet.' +
            (_prosSearch ? ' Prøv en anden søgning.' : '') + '</div>';
        return;
    }

    list.innerHTML = filtered.map((p, i) => {
        const fit = p.icp_fit || 0;
        const fitCls = fit >= 50 ? 'pros-fit-high' : fit >= 25 ? 'pros-fit-mid' : 'pros-fit-low';
        const cid = p.primary_customer_id || 0;
        const isClickable = cid || p.company_id;
        const cardStyle = isClickable ? ' style="cursor:pointer"' : '';
        const nameTitle = cid ? ' title="Åbn kundeprofil"' : '';
        return `
        <div class="pros-card" data-company-id="${p.company_id || 0}" data-customer-id="${cid}" data-name="${_prosAttr(p.name)}"${cardStyle}>
            <div class="pros-info">
                <div class="pros-name"${nameTitle}>${_prosEsc(p.name)}</div>
                <div class="pros-meta">
                    ${p.branch ? p.branch + ' · ' : ''}
                    ${p.employee_count ? p.employee_count + ' ansatte · ' : ''}
                    ${p.company_type ? p.company_type + ' · ' : ''}
                    ${p.cvr ? 'CVR ' + p.cvr : 'Ingen CVR'}
                </div>
            </div>
            <div class="pros-fit">
                <div class="pros-fit-val ${fitCls}">${fit}</div>
                <div class="pros-fit-label">ICP-fit</div>
            </div>
            <div class="pros-actions">
                ${p.primary_contact_phone ? '<a href="tel:' + p.primary_contact_phone + '" class="pros-btn-sm">📞</a>' : ''}
                <button class="pros-btn-sm" onclick="_prosOpenProfile(${p.primary_customer_id || 0})">Profil</button>
                <button class="pros-btn-sm" onclick="_prosActivate(${p.company_id})" title="Aktiver">✓ Aktiv</button>
            </div>
        </div>`;
    }).join('');

    // Delegeret række-klik: i select-mode toggles valg; ellers åbnes profil
    if (!list._prosClickBound) {
        list.addEventListener('click', (e) => {
            // Knapper og links har egen handler — lad dem passere
            if (e.target.closest('button, a')) return;
            const card = e.target.closest('.pros-card');
            if (!card) return;
            // Select-mode: ListCampaignSelect overtager
            if (window.ListCampaignSelect && window.ListCampaignSelect.handleRowClick(card)) return;
            // Default: åbn profil hvis customer findes
            const cid = parseInt(card.dataset.customerId, 10) || 0;
            if (cid) _prosOpenProfile(cid);
        });
        list._prosClickBound = true;
    }

    // Genskab visuel state for valgte rækker efter re-render
    if (window.ListCampaignSelect) window.ListCampaignSelect.refresh();
}

function _prosAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _prosOnSearch(val) {
    _prosSearch = val;
    if (_prosDebounce) clearTimeout(_prosDebounce);
    _prosDebounce = setTimeout(() => _prosRender(), 200);
}

function _prosOpenProfile(customerId) {
    if (!customerId) return;
    if (typeof window.openKunde360 === 'function') {
        window.openKunde360(customerId);
    }
}

async function _prosActivate(companyId) {
    if (!companyId || !confirm('Marker som aktiv?')) return;
    try {
        await patchRfmStage(companyId, 'active');
        _prosLoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

function _prosEsc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
