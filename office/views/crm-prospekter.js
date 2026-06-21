// office/views/crm-prospekter.js
// ==========================================
// Prospekter / leads med ICP-fit scoring.
// ==========================================

let _prosContainer = null;
let _prosActive = false;
let _prosData = null;
let _prosMeta = null;
let _prosIcp = null;
let _prosDebounce = null;
let _prosSearch = '';
let _prosMinKm = '';        // afstands-interval, nedre grænse (km, '' = ingen)
let _prosMaxKm = '';        // afstands-interval, øvre grænse (km, '' = ingen)
let _prosBlacklist = [];    // skjulte brancher
let _prosBranchFilter = ''; // klik på ICP-chip → vis kun denne branche

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
        // ICP-fit beregnes nu server-side (samme kilde som Indsigt-fanen).
        const [data, icp] = await Promise.all([
            fetchRfmProspects({ minKm: _prosMinKm, maxKm: _prosMaxKm }),
            _prosIcp ? Promise.resolve(_prosIcp) : fetchRfmIcp('vip'),
        ]);
        _prosData = data.rows || [];
        _prosMeta = data.meta || null;
        _prosIcp = icp;
        // Synkronisér lokale filter-felter fra serverens sandhed (settings)
        if (_prosMeta) {
            _prosBlacklist = Array.isArray(_prosMeta.blacklist) ? _prosMeta.blacklist : [];
            if (_prosMinKm === '' && _prosMeta.distance_min_km != null) _prosMinKm = String(_prosMeta.distance_min_km);
            if (_prosMaxKm === '' && _prosMeta.distance_max_km != null) _prosMaxKm = String(_prosMeta.distance_max_km);
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
.pros-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
.pros-header h2 { margin: 0; font-family: var(--font-heading, serif); }
.pros-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pros-toolbar input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; width: 200px; }
.pros-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pros-btn-primary { background: var(--brand-primary, #8e631f); color: #fff; }
.pros-icp-strip { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; font-size: 12px; }
.pros-icp-chip { padding: 4px 10px; background: #f5f0e0; border-radius: 12px; color: #8e631f; cursor: pointer; user-select: none; }
.pros-icp-chip:hover { background: #ece0c4; }
.pros-icp-chip.active { background: var(--brand-primary, #8e631f); color: #fff; }
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
.pros-dist { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #666; }
.pros-dist input { width: 56px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; text-align: right; }
.pros-dist-badge { display: inline-block; padding: 1px 7px; background: #eef3e6; color: #3d7a0a; border-radius: 10px; font-size: 11px; white-space: nowrap; }
.pros-bl-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; font-size: 12px; }
.pros-bl-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; background: #f3e6e6; color: #8a3d3d; border-radius: 12px; }
.pros-bl-chip button { border: none; background: none; color: #8a3d3d; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.pros-hide { padding: 4px 8px; border: 1px solid #e3cccc; border-radius: 6px; background: #fff; cursor: pointer; font-size: 12px; color: #8a3d3d; }
.pros-hide:hover { background: #f9efef; }
.pros-note { font-size: 12px; color: #a07b2a; background: #fbf6e8; border-radius: 6px; padding: 6px 10px; margin-bottom: 12px; }
</style>
<div class="pros-wrap">
    <div class="pros-header">
        <h2>Prospekter</h2>
        <div class="pros-toolbar">
            <input type="text" placeholder="Søg..." id="pros-search" oninput="_prosOnSearch(this.value)">
            <span class="pros-dist" title="Filtrér på firma-adressens afstand fra HQ (fugleflugt). OBS: firma-adressen er ofte hovedkontoret, ikke leveringsstedet — tæller ikke i fit-scoren. Tomme felter = ingen grænse.">
                Firma-afstand
                <input type="number" min="0" step="1" id="pros-minkm" placeholder="min"
                    onchange="_prosSetDist('min', this.value)">
                –
                <input type="number" min="0" step="1" id="pros-maxkm" placeholder="max"
                    onchange="_prosSetDist('max', this.value)"> km
            </span>
        </div>
    </div>
    <div class="pros-icp-strip" id="pros-icp-strip"></div>
    <div class="pros-bl-row" id="pros-blacklist"></div>
    <div class="pros-note" id="pros-note" style="display:none"></div>
    <div class="pros-count" id="pros-count"></div>
    <div id="pros-list"></div>
</div>`;
}

function _prosRender() {
    if (!_prosActive || !_prosData) return;

    // Afstands-interval-felter synkroniseres fra state (rør ikke det fokuserede)
    const minKmInput = document.getElementById('pros-minkm');
    if (minKmInput && document.activeElement !== minKmInput) minKmInput.value = _prosMinKm;
    const maxKmInput = document.getElementById('pros-maxkm');
    if (maxKmInput && document.activeElement !== maxKmInput) maxKmInput.value = _prosMaxKm;
    const distActive = _prosMinKm !== '' || _prosMaxKm !== '';

    // ICP strip — chips er klikbare: filtrér listen til den branche
    const strip = document.getElementById('pros-icp-strip');
    if (strip && _prosIcp?.top_branches) {
        strip.innerHTML = '<span style="color:#888">ICP brancher:</span> ' +
            _prosIcp.top_branches.slice(0, 4).map(b => {
                const active = _prosBranchFilter === b.branch;
                return `<span class="pros-icp-chip${active ? ' active' : ''}" title="${active ? 'Klik for at rydde filteret' : 'Vis kun leads i denne branche'}" onclick="_prosToggleBranch('${_prosAttr(b.branch)}')">${_prosEsc(b.branch)} (${b.pct}%)</span>`;
            }).join('');
    }

    // Blacklist-chips (skjulte brancher)
    const blRow = document.getElementById('pros-blacklist');
    if (blRow) {
        blRow.innerHTML = _prosBlacklist.length
            ? '<span style="color:#888">Skjulte brancher:</span> ' + _prosBlacklist.map(b =>
                `<span class="pros-bl-chip">${_prosEsc(b)}<button title="Vis igen" onclick="_prosUnhideBranch('${_prosAttr(b)}')">✕</button></span>`
              ).join('')
            : '';
    }

    // Note: leads skjult af afstands-filter pga. manglende koordinater
    const noteEl = document.getElementById('pros-note');
    if (noteEl) {
        const hidden = _prosMeta && distActive ? (_prosMeta.hidden_no_coords || 0) : 0;
        if (hidden > 0) {
            noteEl.style.display = '';
            noteEl.textContent = `${hidden} firma${hidden === 1 ? '' : 'er'} skjult af afstands-filteret — mangler adresse-koordinater (kør geokodning).`;
        } else if (_prosMeta && !_prosMeta.hq_available) {
            noteEl.style.display = '';
            noteEl.textContent = 'HQ-koordinater er ikke sat — afstand kan ikke beregnes. Sæt dem i delivery-indstillinger.';
        } else {
            noteEl.style.display = 'none';
        }
    }

    // Filter (søgning + branche-fokus er client-side over de hentede rækker)
    let filtered = _prosData;
    if (_prosBranchFilter) filtered = filtered.filter(p => p.branch === _prosBranchFilter);
    if (_prosSearch) {
        const q = _prosSearch.toLowerCase();
        filtered = filtered.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.branch || '').toLowerCase().includes(q) ||
            (p.cvr || '').includes(q)
        );
    }

    const countEl = document.getElementById('pros-count');
    if (countEl) {
        const parts = [`${filtered.length} leads`];
        if (_prosBranchFilter) parts.push(_prosBranchFilter);
        if (_prosSearch) parts.push('filtreret');
        if (distActive) {
            if (_prosMinKm !== '' && _prosMaxKm !== '') parts.push(`${_prosMinKm}–${_prosMaxKm} km`);
            else if (_prosMaxKm !== '') parts.push(`≤ ${_prosMaxKm} km`);
            else parts.push(`≥ ${_prosMinKm} km`);
        }
        countEl.textContent = parts.join(' · ');
    }

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
        const distBadge = p.distance_km != null
            ? `<span class="pros-dist-badge" title="Afstand til firma-adressen (ofte hovedkontor) — fugleflugt fra HQ. Tæller ikke i fit-scoren.">${String(p.distance_km).replace('.', ',')} km</span>` : '';
        const bd = p.fit_breakdown || {};
        const fitTitle = `Branche ${bd.branch ?? 0}` +
            (bd.size != null ? ` · Størrelse ${bd.size}` : '');
        return `
        <div class="pros-card" data-company-id="${p.company_id || 0}" data-customer-id="${cid}" data-name="${_prosAttr(p.name)}"${cardStyle}>
            <div class="pros-info">
                <div class="pros-name"${nameTitle}>${_prosEsc(p.name)}</div>
                <div class="pros-meta">
                    ${p.branch ? _prosEsc(p.branch) + ' · ' : ''}
                    ${p.employee_count ? p.employee_count + ' ansatte · ' : ''}
                    ${p.cvr ? 'CVR ' + _prosEsc(p.cvr) : 'Ingen CVR'}
                    ${distBadge ? ' · ' + distBadge : ''}
                </div>
            </div>
            <div class="pros-fit" title="${_prosAttr(fitTitle)}">
                <div class="pros-fit-val ${fitCls}">${fit}</div>
                <div class="pros-fit-label">ICP-fit</div>
            </div>
            <div class="pros-actions">
                ${p.branch ? `<button class="pros-hide" onclick="_prosHideBranch('${_prosAttr(p.branch)}')" title="Skjul alle firmaer i denne branche">⊘ Branche</button>` : ''}
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

// Klik på ICP-branche-chip → vis kun den branche (klik igen rydder). Client-side.
function _prosToggleBranch(branch) {
    _prosBranchFilter = (_prosBranchFilter === branch) ? '' : branch;
    _prosRender();
}

// Afstands-interval: gem som settings-default (delt forretningspræference) + reload.
// which = 'min' | 'max'
async function _prosSetDist(which, val) {
    const trimmed = (val == null ? '' : String(val)).trim();
    const num = parseFloat(trimmed);
    const clean = trimmed !== '' && Number.isFinite(num) && num > 0 ? String(num) : '';
    if (which === 'min') _prosMinKm = clean; else _prosMaxKm = clean;
    const key = which === 'min' ? 'prospect_distance_min_km' : 'prospect_distance_max_km';
    try { await patchSetting(key, clean); } catch { /* reload viser stadig serverens tilstand */ }
    _prosLoadData();
}

function _prosHideBranch(branch) {
    if (!branch || _prosBlacklist.includes(branch)) return;
    _prosBlacklist = _prosBlacklist.concat([branch]);
    _prosSaveBlacklist();
}

function _prosUnhideBranch(branch) {
    _prosBlacklist = _prosBlacklist.filter(b => b !== branch);
    _prosSaveBlacklist();
}

async function _prosSaveBlacklist() {
    try { await patchSetting('prospect_branch_blacklist', JSON.stringify(_prosBlacklist)); }
    catch { /* reload viser stadig serverens tilstand */ }
    _prosLoadData();
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
