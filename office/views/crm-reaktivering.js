// office/views/crm-reaktivering.js
// ==========================================
// Prioriteret ringeliste over sovende kunder
// med højt RFM-potentiale.
// ==========================================

let _reakContainer = null;
let _reakActive = false;
let _reakData = null;
let _reakDebounce = null;
let _reakPurposes = null;

function initCrmReaktivering(container) {
    _reakContainer = container;
    _reakActive = true;
    container.innerHTML = _reakShellHtml();
    _reakWireSelect();
    _reakLoadData();
}

function cleanupCrmReaktivering() {
    _reakActive = false;
    if (_reakDebounce) clearTimeout(_reakDebounce);
    if (window.ListCampaignSelect) window.ListCampaignSelect.detach();
    _reakContainer = null;
}

function _reakWireSelect() {
    if (!window.ListCampaignSelect || !_reakContainer) return;
    const toolbar = _reakContainer.querySelector('.reak-header');
    const host = _reakContainer.querySelector('#reak-list');
    if (!toolbar || !host) return;
    window.ListCampaignSelect.attach({
        hostEl: host,
        toolbarEl: toolbar,
        contentEl: host,
        rowSelector: '.reak-card',
        getEntityFromRow: (row) => ({
            company_id: parseInt(row.dataset.companyId, 10) || null,
            customer_id: parseInt(row.dataset.customerId, 10) || null,
            name: row.dataset.name || '',
        }),
        contextName: 'Reaktivering',
        suggestedCampaignName: () => `Reaktivering Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()}`,
    });
}

function _reakHandleSSE(event) {
    if (!_reakActive) return;
    if (['crm_activity_created', 'rfm_computed'].includes(event)) {
        if (_reakDebounce) clearTimeout(_reakDebounce);
        _reakDebounce = setTimeout(() => _reakLoadData(), 2000);
    }
}

async function _reakLoadData() {
    if (!_reakActive) return;
    try {
        const [data, purposes] = await Promise.all([
            fetchRfmReactivation(),
            _reakPurposes ? Promise.resolve(_reakPurposes) : fetchActivityPurposes(),
        ]);
        _reakData = data;
        _reakPurposes = purposes;
        _reakRender();
    } catch (err) {
        if (_reakContainer) _reakContainer.querySelector('#reak-list').innerHTML =
            '<p style="color:red">Fejl: ' + err.message + '</p>';
    }
}

function _reakShellHtml() {
    return `
<style>
.reak-wrap { padding: 24px; max-width: 900px; }
.reak-header { margin-bottom: 16px; }
.reak-header h2 { margin: 0 0 4px; font-family: var(--font-heading, serif); }
.reak-header p { margin: 0; color: #888; font-size: 13px; }
.reak-card { background: #fff; border: 1px solid var(--color-border, #d7d1ca); border-radius: 8px;
             padding: 16px; margin-bottom: 12px; transition: box-shadow 0.2s; }
.reak-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
.reak-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.reak-name { font-size: 16px; font-weight: 600; }
.reak-meta { font-size: 12px; color: #888; margin-top: 2px; }
.reak-scores { display: flex; gap: 12px; margin-top: 8px; }
.reak-score { text-align: center; }
.reak-score-val { font-size: 18px; font-weight: 700; }
.reak-score-label { font-size: 10px; color: #888; text-transform: uppercase; }
.reak-potential { font-size: 24px; font-weight: 700; font-family: var(--font-heading, serif);
                  color: var(--brand-primary, #8e631f); }
.reak-opener { background: #f9f7f4; border-radius: 6px; padding: 10px; margin-top: 10px; font-size: 13px;
               font-style: italic; color: #555; }
.reak-actions { display: flex; gap: 8px; margin-top: 10px; }
.reak-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.reak-btn-call { background: #3d7a0a; color: #fff; }
.reak-btn-call:hover { background: #2d5a07; }
.reak-btn-profile { background: #f0ece6; color: #333; }
.reak-log-form { background: #faf8f5; border-radius: 6px; padding: 12px; margin-top: 10px;
                 display: none; }
.reak-log-form.open { display: block; }
.reak-log-form textarea { width: 100%; min-height: 60px; border: 1px solid #ccc; border-radius: 4px;
                          padding: 6px; font-size: 13px; resize: vertical; margin-top: 8px; }
.reak-log-form select { padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; margin-right: 8px; }
.reak-empty { text-align: center; padding: 40px; color: #888; }
</style>
<div class="reak-wrap">
    <div class="reak-header">
        <h2>Re-aktivering</h2>
        <p id="reak-subtitle">Indlæser...</p>
    </div>
    <div id="reak-list"></div>
</div>`;
}

function _reakRender() {
    if (!_reakActive || !_reakData) return;

    const subtitle = document.getElementById('reak-subtitle');
    if (subtitle) subtitle.textContent = `${_reakData.length} sovende kunder med potentiale \u00b7 sorteret efter fit`;

    const list = document.getElementById('reak-list');
    if (!list) return;

    if (_reakData.length === 0) {
        list.innerHTML = '<div class="reak-empty">Ingen sovende kunder med potentiale fundet.<br>Kør RFM-genberegning fra Kundeindsigt for at opdatere.</div>';
        return;
    }

    list.innerHTML = _reakData.map((r, i) => {
        const name = r.is_personal ? (r.primary_contact_name || r.name) : r.name;
        const opener = _reakBuildOpener(r);
        const cid = r.primary_customer_id || 0;
        const isClickable = cid || r.company_id;
        const cardStyle = isClickable ? ' style="cursor:pointer"' : '';
        const nameTitle = cid ? ' title="\u00c5bn kundeprofil"' : '';
        return `
        <div class="reak-card" id="reak-card-${i}" data-company-id="${r.company_id || 0}" data-customer-id="${cid}" data-name="${_reakAttr(name)}"${cardStyle}>
            <div class="reak-top">
                <div>
                    <div class="reak-name"${nameTitle}>${_reakEsc(name)}</div>
                    <div class="reak-meta">
                        ${r.branch ? r.branch + ' \u00b7 ' : ''}
                        ${r.order_count} ordrer \u00b7 Sidst: ${r.last_order_date || '?'}
                        (${r.days_since_last} dage siden)
                    </div>
                    <div class="reak-scores">
                        <div class="reak-score"><div class="reak-score-val">${r.r_score}</div><div class="reak-score-label">R</div></div>
                        <div class="reak-score"><div class="reak-score-val">${r.f_score}</div><div class="reak-score-label">F</div></div>
                        <div class="reak-score"><div class="reak-score-val">${r.m_score}</div><div class="reak-score-label">M</div></div>
                    </div>
                </div>
                <div class="reak-potential">${r.potential_score}</div>
            </div>
            ${opener ? '<div class="reak-opener">' + opener + '</div>' : ''}
            <div class="reak-actions">
                ${r.primary_contact_phone ? '<a href="tel:' + r.primary_contact_phone + '" class="reak-btn reak-btn-call" onclick="_reakShowLog(' + i + ', event)">📞 Ring ' + _reakEsc(r.primary_contact_name || '') + '</a>' : ''}
                <button class="reak-btn reak-btn-call" onclick="_reakShowLog(${i})">📝 Log</button>
                <button class="reak-btn reak-btn-profile" onclick="_reakOpenProfile(${r.primary_customer_id || 0})">Profil →</button>
            </div>
            <div class="reak-log-form" id="reak-form-${i}">
                <select id="reak-result-${i}">
                    <option value="reached">Nået</option>
                    <option value="no_answer">Ingen svar</option>
                    <option value="voicemail">Voicemail</option>
                    <option value="callback">Ring tilbage</option>
                </select>
                <select id="reak-sentiment-${i}">
                    <option value="">Stemning...</option>
                    <option value="positive">😊 Positiv</option>
                    <option value="neutral">😐 Neutral</option>
                    <option value="negative">😟 Negativ</option>
                </select>
                <textarea id="reak-note-${i}" placeholder="Note..."></textarea>
                <div style="margin-top:8px">
                    <button class="reak-btn reak-btn-call" onclick="_reakSubmitLog(${i})">Gem</button>
                    <button class="reak-btn reak-btn-profile" onclick="_reakHideLog(${i})">Annuller</button>
                </div>
            </div>
        </div>`;
    }).join('');

    // Delegeret række-klik: i select-mode toggles valg; ellers åbnes profil
    if (!list._reakClickBound) {
        list.addEventListener('click', (e) => {
            if (e.target.closest('button, a, select, textarea, input')) return;
            const card = e.target.closest('.reak-card');
            if (!card) return;
            if (window.ListCampaignSelect && window.ListCampaignSelect.handleRowClick(card)) return;
            const cid = parseInt(card.dataset.customerId, 10) || 0;
            if (cid) _reakOpenProfile(cid);
        });
        list._reakClickBound = true;
    }

    if (window.ListCampaignSelect) window.ListCampaignSelect.refresh();
}

function _reakAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _reakBuildOpener(r) {
    if (!r.last_order_detail) return null;
    const d = r.last_order_detail;
    const product = d.top_product || 'catering';
    const date = d.delivery_date || '?';
    const monthNames = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
    let dateStr = date;
    try {
        const dt = new Date(date);
        dateStr = monthNames[dt.getMonth()] + ' ' + dt.getFullYear();
    } catch (e) {}
    const pax = d.pax ? d.pax + ' gæster' : '';
    return `Sidst: ${_reakEsc(product)}${pax ? ', ' + pax : ''} (${dateStr})`;
}

function _reakShowLog(idx, event) {
    const form = document.getElementById('reak-form-' + idx);
    if (form) form.classList.add('open');
}

function _reakHideLog(idx) {
    const form = document.getElementById('reak-form-' + idx);
    if (form) form.classList.remove('open');
}

async function _reakSubmitLog(idx) {
    if (!_reakActive || !_reakData[idx]) return;
    const r = _reakData[idx];
    const result = document.getElementById('reak-result-' + idx)?.value;
    const sentiment = document.getElementById('reak-sentiment-' + idx)?.value || null;
    const note = document.getElementById('reak-note-' + idx)?.value?.trim();

    if (!note) { alert('Skriv en note'); return; }

    // Find re_aktivering purpose_id
    const reakPurpose = (_reakPurposes || []).find(p => p.key === 're_aktivering');

    try {
        await postCrmActivity({
            customer_id: r.primary_customer_id,
            type: 'call',
            result: result,
            sentiment: sentiment,
            text: note,
            purpose_id: reakPurpose?.id || null,
        });
        _reakHideLog(idx);
        // Fjern kortet optimistisk
        const card = document.getElementById('reak-card-' + idx);
        if (card) card.style.opacity = '0.3';
        setTimeout(() => _reakLoadData(), 1000);
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

function _reakOpenProfile(customerId) {
    if (!customerId) return;
    if (typeof window.openKunde360 === 'function') {
        window.openKunde360(customerId);
    }
}

function _reakEsc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
