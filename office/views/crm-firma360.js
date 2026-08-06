/**
 * office/views/crm-firma360.js
 * ════════════════════════════════════════════════════════════
 * Firma 360° — detaljeret firma-overblik med 6 faner.
 *
 *   • Oversigt   — stamdata + kontaktpunkter + stat-strip + berig-knap
 *   • Kontakter  — kunder under firmaet, klik → Kunde 360°
 *   • Bons       — alle bons aggregeret på firma-niveau
 *   • Tilbud     — alle tilbud aggregeret
 *   • Mail       — mail-tråde tværs af alle kunder under firmaet (TODO Fase 6+)
 *   • Aktivitet  — crm_activities aggregeret via firmaets kunder (TODO Fase 6+)
 *
 * Berig-knappen i Oversigt-fanen bygges fuldt ud i Fase 3 (modal-flow).
 * I Fase 6 stub'es der til en preview→bekræft-dialog uden modal-UI.
 * ════════════════════════════════════════════════════════════
 */

let _f3State = {
    container: null,
    companyId: null,
    data: null,
    tab: 'oversigt',
    opts: {},
    modalEl: null,
    toastTimer: null,
};

async function initCrmFirma360(container, opts = {}) {
    _f3State.container = container;
    _f3State.companyId = opts.companyId;
    _f3State.opts = opts;

    if (!_f3State.companyId) {
        container.innerHTML = '<div class="f3-empty">Intet firma valgt.</div>';
        return;
    }

    // Læs initial tab fra URL
    const params = new URLSearchParams(window.location.search);
    _f3State.tab = params.get('ftab') || 'oversigt';

    container.innerHTML = `<div class="f3-loading">Henter firma…</div>`;

    try {
        _f3State.data = await fetchCrmCompany(_f3State.companyId);
        _f3RenderShell();
        _f3RenderTab(_f3State.tab);
    } catch (err) {
        console.error('Firma 360° load fejlede:', err);
        container.innerHTML = `<div class="f3-error">Fejl: ${escapeHtml(err.message)}</div>`;
    }
}

function _f3RenderShell() {
    const { company, aggregations, contact_points } = _f3State.data;
    const stage = aggregations.aggregated_stage || 'active';
    const stageLabel = stage === 'vip' ? '⭐ VIP' : stage === 'dormant' ? 'Sovende' : 'Aktiv';
    const lastEnriched = company.last_enriched_at
        ? `<div class="f3-enriched">Sidst beriget ${_f3FormatDate(company.last_enriched_at)} · ${escapeHtml(company.last_enriched_source || 'CVR')}</div>`
        : '';

    const legalLine = company.legal_name && company.legal_name !== company.name
        ? `<div class="f3-legal">${escapeHtml(company.legal_name)}</div>`
        : '';

    _f3State.container.innerHTML = `
        <div class="f3-wrap">
            <div class="f3-back">
                <button class="f3-back-btn" id="f3-back">← Tilbage til firmaer</button>
            </div>

            <header class="f3-header">
                <div class="f3-h-main">
                    <h1 class="f3-name">${escapeHtml(company.name)}</h1>
                    ${legalLine}
                    <div class="f3-h-meta">
                        <span class="f3-stage f3-stage-${stage}">${stageLabel}</span>
                        <span class="f3-meta-pill f3-id-pill" title="Firma-id (brug til sammenlægning)">#${company.id}</span>
                        ${company.cvr ? `<span class="f3-meta-pill">CVR ${company.cvr}</span>` : '<span class="f3-meta-pill empty">— uden CVR —</span>'}
                        ${company.ean ? `<span class="f3-meta-pill">EAN ${company.ean}</span>` : ''}
                    </div>
                </div>
                <div class="f3-h-stats">
                    <div class="f3-stat">
                        <div class="f3-stat-num">${aggregations.contact_count || 0}</div>
                        <div class="f3-stat-lbl">kontakter</div>
                    </div>
                    <div class="f3-stat">
                        <div class="f3-stat-num">${aggregations.total_orders || 0}</div>
                        <div class="f3-stat-lbl">bons</div>
                    </div>
                    <div class="f3-stat">
                        <div class="f3-stat-num">${formatKr(aggregations.total_revenue || 0)}</div>
                        <div class="f3-stat-lbl">omsætning</div>
                    </div>
                </div>
            </header>

            <nav class="f3-tabs">
                <button class="f3-tab" data-tab="oversigt">Oversigt</button>
                <button class="f3-tab" data-tab="kontakter">Kontakter (${aggregations.contact_count || 0})</button>
                <button class="f3-tab" data-tab="bons">Bons (${aggregations.total_orders || 0})</button>
                <button class="f3-tab" data-tab="tilbud">Tilbud</button>
                <button class="f3-tab" data-tab="mail">Mail</button>
                <button class="f3-tab" data-tab="aktivitet">Aktivitet</button>
            </nav>

            <div class="f3-tab-content" id="f3-tab-content"></div>
        </div>
    `;

    _f3State.container.querySelectorAll('.f3-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === _f3State.tab);
        btn.addEventListener('click', () => _f3SwitchTab(btn.dataset.tab));
    });

    _f3State.container.querySelector('#f3-back')?.addEventListener('click', () => {
        if (typeof window.closeFirma360 === 'function') window.closeFirma360();
    });

    // Stash lastEnriched i bunden
    if (lastEnriched) {
        const tabContent = document.getElementById('f3-tab-content');
        if (tabContent) {
            // Tilføjes til oversigt-fanen efter render
        }
    }
}

function _f3SwitchTab(tab) {
    if (_f3State.tab === tab) return;
    _f3State.tab = tab;
    const url = new URL(window.location);
    url.searchParams.set('ftab', tab);
    history.replaceState({}, '', url);

    _f3State.container.querySelectorAll('.f3-tab').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tab === tab)
    );
    _f3RenderTab(tab);
}

function _f3RenderTab(tab) {
    const el = document.getElementById('f3-tab-content');
    if (!el) return;
    if (tab === 'oversigt')      _f3RenderOversigt(el);
    else if (tab === 'kontakter') _f3RenderKontakter(el);
    else if (tab === 'bons')      _f3RenderBons(el);
    else if (tab === 'tilbud')    _f3RenderTilbud(el);
    else if (tab === 'mail')      _f3RenderMail(el);
    else if (tab === 'aktivitet') _f3RenderAktivitet(el);
}

// ─── OVERSIGT-FANEN ────────────────────────────────────────────

function _f3RenderOversigt(el) {
    const { company, aggregations, contact_points, rfm } = _f3State.data;
    const addr = (company.street_name || company.city)
        ? `${escapeHtml(company.street_name || '')} ${escapeHtml(company.street_nr || '')}<br>${escapeHtml(company.postal_code || '')} ${escapeHtml(company.city || '')}`
        : '<span class="f3-muted">— ingen adresse registreret —</span>';

    const cpsByKind = { email: [], phone: [] };
    for (const cp of contact_points) cpsByKind[cp.kind]?.push(cp);

    el.innerHTML = `
        <div class="f3-oversigt-grid">
            <!-- VENSTRE: stamdata + handlinger -->
            <div class="f3-card">
                <div class="f3-card-h">
                    <span class="f3-card-title">Stamdata</span>
                </div>
                <div class="f3-card-b">
                    ${_f3EditableRow('Navn', 'name', company.name)}
                    ${_f3EditableRow('CVR', 'cvr', company.cvr)}
                    ${_f3EditableRow('EAN', 'ean', company.ean)}
                    ${_f3EditableRow('Juridisk', 'legal_name', company.legal_name)}
                    <div class="f3-row"><span class="f3-lbl">Branche</span><span class="f3-val">${company.branch ? escapeHtml(company.branch) : '<span class="f3-muted">—</span>'}</span></div>
                    <div class="f3-row"><span class="f3-lbl">Selskabsform</span><span class="f3-val">${company.company_type ? escapeHtml(company.company_type) : '<span class="f3-muted">—</span>'}</span></div>
                    <div class="f3-row"><span class="f3-lbl">Ansatte</span><span class="f3-val">${company.employee_count ? company.employee_count : '<span class="f3-muted">—</span>'}</span></div>
                    <div class="f3-row"><span class="f3-lbl">Adresse</span><span class="f3-val">${addr}</span></div>
                    <div class="f3-row"><span class="f3-lbl">Faktura</span><span class="f3-val">${company.invoice_method ? escapeHtml(company.invoice_method) : '<span class="f3-muted">—</span>'}</span></div>
                    <div class="f3-row"><span class="f3-lbl">e-conomic</span><span class="f3-val">${company.economic_customer_id ? escapeHtml(company.economic_customer_id) : '<span class="f3-muted">—</span>'}</span></div>

                    <div class="f3-actions">
                        <button class="f3-btn f3-btn-primary" id="f3-enrich-btn">⟳ Berig fra CVR</button>
                        <button class="f3-btn" id="f3-paste-btn">📋 Tilføj fra kontaktside</button>
                    </div>
                    ${company.last_enriched_at ? `<div class="f3-enriched-note">Sidst beriget ${_f3FormatDate(company.last_enriched_at)} · ${escapeHtml(company.last_enriched_source || 'CVR')}</div>` : ''}
                </div>
            </div>

            <!-- HØJRE: kontaktpersoner + firma-adresser -->
            <div class="f3-col-stack">
                ${_f3RenderKontaktpersonerCard()}

                <div class="f3-card">
                    <div class="f3-card-h">
                        <span class="f3-card-title">Firma-adresser (${contact_points.length})</span>
                        <div class="f3-card-h-meta">
                            <span class="f3-pill f3-pill-pub">PUB</span> offentlig
                            <span class="f3-pill f3-pill-priv">PRIV</span> personlig
                        </div>
                    </div>
                    <div class="f3-card-sub">Firmaets egne email- og telefonnumre (typisk fra CVR) — ikke personer.</div>
                    <div class="f3-cp-list">
                        ${contact_points.length === 0 ? '<div class="f3-empty">Ingen firma-adresser endnu.</div>' : ''}
                        ${contact_points.map(cp => _f3RenderCp(cp)).join('')}
                    </div>
                    <div class="f3-cp-add">
                        <button class="f3-btn-sm" data-add-kind="email">+ Tilføj email</button>
                        <button class="f3-btn-sm" data-add-kind="phone">+ Tilføj telefon</button>
                    </div>
                </div>
            </div>
        </div>

        ${_f3RenderFlagsCard()}

        ${rfm ? _f3RenderRfm(rfm) : ''}
    `;

    // Event-binding
    el.querySelector('#f3-enrich-btn')?.addEventListener('click', _f3OpenEnrich);
    el.querySelector('#f3-paste-btn')?.addEventListener('click', _f3OpenPaste);
    el.querySelectorAll('.f3-edit-btn[data-edit-field]').forEach(btn =>
        btn.addEventListener('click', () => _f3StartEditField(btn.dataset.editField)));
    el.querySelectorAll('.f3-cp-toggle-public').forEach(btn =>
        btn.addEventListener('click', _f3HandleTogglePublic));
    el.querySelectorAll('.f3-cp-delete').forEach(btn =>
        btn.addEventListener('click', _f3HandleDeleteCp));
    el.querySelectorAll('.f3-btn-sm[data-add-kind]').forEach(btn =>
        btn.addEventListener('click', () => _f3HandleAddCp(btn.dataset.addKind)));

    // Kontaktpersoner: række → Kunde 360°, "Se alle" → Kontakter-fanen
    el.querySelectorAll('.f3-kp-row').forEach(row =>
        row.addEventListener('click', () => {
            const cid = parseInt(row.dataset.customerId, 10);
            if (cid && typeof window.openKunde360 === 'function') window.openKunde360(cid);
        }));
    el.querySelector('#f3-kp-goto')?.addEventListener('click', () => _f3SwitchTab('kontakter'));

    // Flag-handlers
    el.querySelectorAll('.f3-flag-remove').forEach(btn =>
        btn.addEventListener('click', () => _f3RemoveFlag(parseInt(btn.dataset.flagId, 10))));
    el.querySelector('#f3-flag-add-btn')?.addEventListener('click', _f3AddFlag);
}

// Kontaktpersoner på Oversigt. "Kontakter" (personer) og "Kontaktpunkter"
// (email/telefon) betyder det samme i almindeligt dansk, så et firma hvis
// eneste synlige kort hed "Kontaktpunkter" så ud til at mangle sine
// kontaktpersoner — også når de lå der på deres egen fane. Personerne står
// derfor nu øverst på Oversigt, og adresse-kortet hedder "Firma-adresser".
function _f3RenderKontaktpersonerCard() {
    const list = _f3State.data?.customers || [];
    const MAX = 5;   // hold kortet kompakt; resten ligger på fanen
    const shown = list.slice(0, MAX);
    const rest = list.length - shown.length;

    const rows = shown.map(c => `
        <div class="f3-kp-row" data-customer-id="${c.id}" title="Åbn ${escapeHtml(c.name.trim() || 'kunde')}">
            <div class="f3-kp-main">
                <div class="f3-kp-name">${escapeHtml(c.name.trim() || '(uden navn)')}</div>
                <div class="f3-kp-meta">
                    ${c.email ? escapeHtml(c.email) : '<span class="f3-muted">— ingen email —</span>'}
                    ${c.phone ? ' · ' + escapeHtml(c.phone) : ''}
                </div>
            </div>
            <span class="f3-kp-orders">${c.order_count || 0} bons</span>
        </div>`).join('');

    return `
        <div class="f3-card">
            <div class="f3-card-h">
                <span class="f3-card-title">Kontaktpersoner (${list.length})</span>
                <button class="f3-btn-sm" id="f3-kp-goto">Se alle →</button>
            </div>
            <div class="f3-card-sub">Personerne hos firmaet. Klik for at åbne Kunde 360°.</div>
            <div class="f3-kp-list">
                ${list.length === 0 ? '<div class="f3-empty">Ingen kontaktpersoner endnu — tilføj dem under fanen Kontakter.</div>' : rows}
                ${rest > 0 ? `<div class="f3-kp-more">+ ${rest} mere under fanen Kontakter</div>` : ''}
            </div>
        </div>`;
}

// ─── Redigerbare stamdata-felter (CVR / EAN / juridisk navn) ─

const _F3_FIELD_META = {
    name:       { label: 'Navn',    placeholder: 'Firmanavn (vises i lister)' },
    cvr:        { label: 'CVR',     placeholder: '8 cifre',  inputmode: 'numeric' },
    ean:        { label: 'EAN',     placeholder: '13 cifre', inputmode: 'numeric' },
    legal_name: { label: 'Juridisk', placeholder: 'Juridisk navn' },
};

function _f3EditableRow(label, field, value) {
    const val = value
        ? (field === 'legal_name' ? escapeHtml(value) : escapeHtml(String(value)))
        : '<span class="f3-muted">—</span>';
    return `<div class="f3-row f3-row-editable" data-field-row="${field}">
        <span class="f3-lbl">${label}</span>
        <span class="f3-val">${val}</span>
        <button class="f3-edit-btn" data-edit-field="${field}" title="Ret ${label}">✎</button>
    </div>`;
}

function _f3StartEditField(field) {
    const meta = _F3_FIELD_META[field];
    const row = _f3State.container?.querySelector(`[data-field-row="${field}"]`);
    if (!meta || !row || row.classList.contains('editing')) return;

    const current = _f3State.data?.company?.[field] ?? '';
    row.classList.add('editing');
    row.innerHTML = `
        <span class="f3-lbl">${meta.label}</span>
        <span class="f3-edit-wrap">
            <input type="text" class="f3-edit-input" value="${escapeHtml(String(current))}"
                   placeholder="${meta.placeholder}"${meta.inputmode ? ` inputmode="${meta.inputmode}"` : ''}>
            <button class="f3-btn-sm f3-edit-save">Gem</button>
            <button class="f3-btn-sm f3-edit-cancel">Annullér</button>
        </span>`;

    const input = row.querySelector('.f3-edit-input');
    input.focus();
    input.select();

    const save = () => _f3SaveField(field, input.value);
    row.querySelector('.f3-edit-save').addEventListener('click', save);
    row.querySelector('.f3-edit-cancel').addEventListener('click', _f3Reload);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); _f3Reload(); }
    });
}

async function _f3SaveField(field, rawValue) {
    const before = _f3State.data?.company?.[field] ?? null;
    const value = rawValue.trim();

    // Klient-side validering (serveren validerer også)
    if (field === 'name') {
        if (value === '') {
            _f3ShowToast('Firmanavn må ikke være tomt', 'error'); return;
        }
    } else if (field === 'cvr') {
        const digits = value.replace(/\D/g, '');
        if (digits !== '' && digits.length !== 8) {
            _f3ShowToast('CVR skal være 8 cifre', 'error'); return;
        }
    } else if (field === 'ean') {
        const digits = value.replace(/\D/g, '');
        if (digits !== '' && digits.length !== 13) {
            _f3ShowToast('EAN skal være 13 cifre', 'error'); return;
        }
    }

    try {
        await patchCompanyIdentifiers(_f3State.companyId, { [field]: value });
    } catch (err) {
        _f3ShowToast('Kunne ikke gemme: ' + (err.message || 'fejl'), 'error');
        return;
    }

    await _f3Reload();
    _f3ShowToast(_F3_FIELD_META[field].label + ' opdateret', 'success');

    // Hvis CVR blev ændret, tilbyd at hente firmadata fra det nye nummer
    if (field === 'cvr') {
        const after = value.replace(/\D/g, '');
        if (after && after !== (before || '') &&
            window.confirm('CVR rettet. Vil du hente firmadata (juridisk navn, branche, kontaktpunkter) fra det nye CVR nu?')) {
            _f3OpenEnrich();
        }
    }
}

// ─── Påmindelser (CLAUDE_KUNDE_FLAGS.md) ────────────────────

function _f3RenderFlagsCard() {
    const flags = _f3State.data?.flags || [];
    const items = flags.length === 0
        ? '<div class="f3-empty">Ingen aktive påmindelser. Tilføj én nedenfor.</div>'
        : flags.map(f => {
            const ack = f.ack_count || 0;
            const ackMeta = ack > 0
                ? ' · Forstået på ' + ack + ' bon' + (ack === 1 ? '' : 'er')
                : '';
            return `
                <div class="f3-flag-card" data-flag-id="${f.id}">
                    <button class="f3-flag-remove" title="Fjern permanent" data-flag-id="${f.id}">×</button>
                    <div class="f3-flag-title">🚩 ${escapeHtml(f.title)}</div>
                    ${f.body ? `<div class="f3-flag-body">${escapeHtml(f.body)}</div>` : ''}
                    <div class="f3-flag-meta">Tilføjet ${_f3FormatDate(f.created_at)}${f.created_by_name ? ' af ' + escapeHtml(f.created_by_name) : ''}${ackMeta}</div>
                </div>
            `;
        }).join('');

    return `
        <div class="f3-card f3-flags-section">
            <div class="f3-card-h">
                <span class="f3-card-title">Påmindelser ${flags.length > 0 ? `(${flags.length})` : ''}</span>
                <span class="f3-card-h-meta">Hejses på fremtidige bonner</span>
            </div>
            <div class="f3-card-b">
                <div class="f3-flag-list">${items}</div>
                <div class="f3-flag-add">
                    <input type="text" id="f3-flag-title" class="f3-flag-input" placeholder="Titel (fx 'Fakturaer skal til Anne')">
                    <textarea id="f3-flag-body" class="f3-flag-textarea" placeholder="Detalje (valgfri)"></textarea>
                    <label class="f3-flag-kitchen"><input type="checkbox" id="f3-flag-office-only"> 🔒 Kun kontor <span class="f3-flag-hint">(køkkenet ser den ikke)</span></label>
                    <button class="f3-btn f3-btn-primary" id="f3-flag-add-btn">+ Tilføj påmindelse</button>
                </div>
            </div>
        </div>
    `;
}

async function _f3AddFlag() {
    const title = (document.getElementById('f3-flag-title')?.value || '').trim();
    const body  = (document.getElementById('f3-flag-body')?.value  || '').trim();
    if (!title) { alert('Skriv en titel'); return; }
    try {
        const officeOnly = document.getElementById('f3-flag-office-only')?.checked;
        await createFlag('company', _f3State.companyId, title, body || null, !officeOnly);
        document.getElementById('f3-flag-title').value = '';
        document.getElementById('f3-flag-body').value  = '';
        const oo = document.getElementById('f3-flag-office-only'); if (oo) oo.checked = false;
        await _f3Reload();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _f3RemoveFlag(flagId) {
    if (!confirm('Fjern denne påmindelse permanent?')) return;
    try {
        await dismissFlagApi(flagId, null, 'Fjernet fra firmakortet');
        await _f3Reload();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _f3Reload() {
    _f3State.data = await fetchCrmCompany(_f3State.companyId);
    // Re-render også shell'en så header (navn/legal/CVR/EAN) afspejler nye stamdata.
    _f3RenderShell();
    _f3RenderTab(_f3State.tab || 'oversigt');
}

function _f3RenderCp(cp) {
    const isPub = cp.is_public === 1;
    const sourceLabel = {
        cvr: 'CVR', nemhandel: 'NemHandel', website: 'web',
        form: 'form', mail: 'mail', manual: 'manuel'
    }[cp.source] || cp.source;
    const icon = cp.kind === 'email' ? mailIcon(13) : phoneIcon(13);
    return `
        <div class="f3-cp-row" data-cp-id="${cp.id}">
            <div class="f3-cp-ico f3-cp-ico-${cp.kind}">${icon}</div>
            <div class="f3-cp-main">
                <div class="f3-cp-value">${escapeHtml(cp.value)}${cp.is_primary ? ' <span class="f3-cp-primary">primær</span>' : ''}</div>
                <div class="f3-cp-meta">
                    <span class="f3-pill ${isPub ? 'f3-pill-pub' : 'f3-pill-priv'}">${isPub ? 'PUB' : 'PRIV'}</span>
                    <span class="f3-pill f3-pill-source">${sourceLabel}</span>
                    ${cp.purpose ? `<span class="f3-cp-purpose">${escapeHtml(cp.purpose)}</span>` : ''}
                </div>
            </div>
            <div class="f3-cp-actions">
                <button class="f3-cp-toggle-public" title="${isPub ? 'Markér som personlig' : 'Markér som offentlig'}">${isPub ? '🔒' : '🔓'}</button>
                <button class="f3-cp-delete" title="Slet">🗑</button>
            </div>
        </div>
    `;
}

function _f3RenderRfm(rfm) {
    return `
        <div class="f3-card f3-rfm">
            <div class="f3-card-h"><span class="f3-card-title">RFM-score</span></div>
            <div class="f3-card-b f3-rfm-b">
                <div class="f3-rfm-cell"><div class="f3-rfm-num">${rfm.r_score ?? '—'}</div><div class="f3-rfm-lbl">R</div></div>
                <div class="f3-rfm-cell"><div class="f3-rfm-num">${rfm.f_score ?? '—'}</div><div class="f3-rfm-lbl">F</div></div>
                <div class="f3-rfm-cell"><div class="f3-rfm-num">${rfm.m_score ?? '—'}</div><div class="f3-rfm-lbl">M</div></div>
                <div class="f3-rfm-cell"><div class="f3-rfm-num">${rfm.rfm_total ?? '—'}</div><div class="f3-rfm-lbl">total</div></div>
                <div class="f3-rfm-cell"><div class="f3-rfm-stage">${escapeHtml(rfm.rfm_stage || '—')}</div><div class="f3-rfm-lbl">stage</div></div>
            </div>
        </div>
    `;
}

// ─── KONTAKTER-FANEN ───────────────────────────────────────────

function _f3RenderKontakter(el) {
    const { customers } = _f3State.data;
    const listHtml = (!customers || customers.length === 0)
        ? '<div class="f3-empty">Ingen kontaktpersoner under dette firma endnu.</div>'
        : `<div class="f3-cust-list">
            ${customers.map(c => `
                <div class="f3-cust-row" data-customer-id="${c.id}">
                    <div class="f3-cust-main">
                        <div class="f3-cust-name">${escapeHtml(c.name.trim() || '(uden navn)')}</div>
                        <div class="f3-cust-meta">
                            ${c.email ? escapeHtml(c.email) : '<span class="f3-muted">— ingen email —</span>'}
                            ${c.phone ? ' · ' + escapeHtml(c.phone) : ''}
                            ${c.stage ? ` · <span class="f3-pill f3-pill-stage f3-pill-stage-${c.stage}">${escapeHtml(c.stage)}</span>` : ''}
                        </div>
                    </div>
                    <div class="f3-cust-stats">
                        <span class="f3-cust-orders">${c.order_count || 0} bons</span>
                        ${c.last_order_date ? `<span class="f3-cust-last">${_f3FormatDate(c.last_order_date)}</span>` : ''}
                    </div>
                </div>
            `).join('')}
        </div>`;

    el.innerHTML = `
        <div class="f3-kontakter-bar">
            <button class="f3-add-kontakt-btn" id="f3-add-kontakt">+ Tilføj kontaktperson</button>
        </div>
        <div id="f3-kontakt-form"></div>
        ${listHtml}
    `;

    el.querySelector('#f3-add-kontakt')?.addEventListener('click', _f3OpenAddKontakt);
    el.querySelectorAll('.f3-cust-row').forEach(row => {
        row.addEventListener('click', () => {
            const cid = parseInt(row.dataset.customerId, 10);
            if (typeof window.openKunde360 === 'function') window.openKunde360(cid);
        });
    });
}

function _f3OpenAddKontakt() {
    const holder = document.getElementById('f3-kontakt-form');
    const btn = document.getElementById('f3-add-kontakt');
    if (!holder) return;
    if (holder.dataset.open === '1') { holder.dataset.open = '0'; holder.innerHTML = ''; if (btn) btn.disabled = false; return; }
    holder.dataset.open = '1';
    if (btn) btn.disabled = true;
    holder.innerHTML = `
        <div class="f3-kontakt-form">
            <div class="f3-kf-row">
                <input type="text" id="f3-kf-first" placeholder="Fornavn *" autocomplete="off">
                <input type="text" id="f3-kf-last" placeholder="Efternavn" autocomplete="off">
            </div>
            <div class="f3-kf-row">
                <input type="email" id="f3-kf-email" placeholder="Email" autocomplete="off">
                <input type="tel" id="f3-kf-phone" placeholder="Telefon" autocomplete="off">
            </div>
            <div class="f3-kf-actions">
                <button class="f3-kf-save" id="f3-kf-save">Gem kontaktperson</button>
                <button class="f3-kf-cancel" id="f3-kf-cancel">Annullér</button>
                <span class="f3-kf-msg" id="f3-kf-msg"></span>
            </div>
        </div>
    `;
    const first = document.getElementById('f3-kf-first');
    first?.focus();
    document.getElementById('f3-kf-cancel')?.addEventListener('click', _f3OpenAddKontakt);
    document.getElementById('f3-kf-save')?.addEventListener('click', _f3SaveKontakt);
    holder.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); _f3SaveKontakt(); }
            else if (e.key === 'Escape') { e.preventDefault(); _f3OpenAddKontakt(); }
        });
    });
}

async function _f3SaveKontakt() {
    const first = document.getElementById('f3-kf-first')?.value.trim();
    const last = document.getElementById('f3-kf-last')?.value.trim();
    const email = document.getElementById('f3-kf-email')?.value.trim();
    const phone = document.getElementById('f3-kf-phone')?.value.trim();
    const msg = document.getElementById('f3-kf-msg');
    const saveBtn = document.getElementById('f3-kf-save');
    if (!first) {
        if (msg) { msg.textContent = 'Fornavn mangler'; msg.className = 'f3-kf-msg f3-kf-msg-err'; }
        document.getElementById('f3-kf-first')?.focus();
        return;
    }
    if (saveBtn) saveBtn.disabled = true;
    if (msg) { msg.textContent = 'Gemmer…'; msg.className = 'f3-kf-msg'; }
    try {
        await apiFetch('/customers', {
            method: 'POST',
            body: JSON.stringify({
                first_name: first,
                last_name: last || null,
                email: email || null,
                phone: phone || null,
                company_id: _f3State.companyId,
            }),
        });
        await _f3Reload();
    } catch (err) {
        if (saveBtn) saveBtn.disabled = false;
        if (msg) { msg.textContent = 'Fejl: ' + err.message; msg.className = 'f3-kf-msg f3-kf-msg-err'; }
    }
}

// ─── BONS-FANEN ────────────────────────────────────────────────

async function _f3RenderBons(el) {
    el.innerHTML = '<div class="f3-loading">Henter bons…</div>';
    try {
        const rows = await apiFetch('/bons?company_id=' + _f3State.companyId + '&limit=100');
        const list = Array.isArray(rows) ? rows : (rows.bons || []);
        if (list.length === 0) {
            el.innerHTML = '<div class="f3-empty">Ingen bons på dette firma.</div>';
            return;
        }
        el.innerHTML = `
            <table class="f3-table">
                <thead><tr><th>Bon#</th><th>Dato</th><th>Kunde</th><th>Pax</th><th>Status</th><th>Beløb</th></tr></thead>
                <tbody>
                    ${list.map(b => `
                        <tr data-bon-id="${b.id}">
                            <td>${b.bon_number || b.id}</td>
                            <td>${_f3FormatDate(b.delivery_date)}</td>
                            <td>${escapeHtml((b.customer_first_name || '') + ' ' + (b.customer_last_name || '')) || '<span class="f3-muted">—</span>'}</td>
                            <td>${b.pax || '—'}</td>
                            <td><span class="f3-pill f3-pill-status">${escapeHtml(b.status_label || b.status_code || '—')}</span></td>
                            <td>${formatKr(b.total_price || 0)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        el.querySelectorAll('tr[data-bon-id]').forEach(tr => {
            tr.addEventListener('click', () => {
                const bonId = tr.dataset.bonId;
                if (_f3State.opts.openDrawer) _f3State.opts.openDrawer(bonId);
            });
        });
    } catch (err) {
        el.innerHTML = `<div class="f3-error">Fejl: ${escapeHtml(err.message)}</div>`;
    }
}

// ─── TILBUD-FANEN ──────────────────────────────────────────────

async function _f3RenderTilbud(el) {
    el.innerHTML = '<div class="f3-loading">Henter tilbud…</div>';
    try {
        const list = await apiFetch('/quotes?company_id=' + _f3State.companyId);
        if (!list || list.length === 0) {
            el.innerHTML = '<div class="f3-empty">Ingen tilbud på dette firma.</div>';
            return;
        }
        el.innerHTML = `
            <table class="f3-table">
                <thead><tr><th>Tilbud#</th><th>Dato</th><th>Pax</th><th>Status</th><th>Beløb</th></tr></thead>
                <tbody>
                    ${list.map(q => `
                        <tr>
                            <td>${q.bon_number || q.id}</td>
                            <td>${_f3FormatDate(q.delivery_date)}</td>
                            <td>${q.pax || '—'}</td>
                            <td><span class="f3-pill f3-pill-status">${escapeHtml(q.offer_status || q.status_code || '—')}</span></td>
                            <td>${formatKr(q.total_price || 0)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        el.innerHTML = `<div class="f3-error">Fejl: ${escapeHtml(err.message)}</div>`;
    }
}

// ─── MAIL-FANEN (placeholder) ──────────────────────────────────

function _f3RenderMail(el) {
    el.innerHTML = `
        <div class="f3-empty">
            Mail-historik tværs af alle kunder under firmaet er ikke implementeret endnu.<br>
            <span class="f3-muted-sm">(Aggregeret view kommer i en senere opgave — i dag findes mail per kunde i Personer-fanen.)</span>
        </div>
    `;
}

// ─── AKTIVITET-FANEN ───────────────────────────────────────────

const _F3_ACT_ICONS = {
    call: '📞', service_call: '📞', meeting: '🤝', task: '📋', note: '📝',
    followup: '🔔', offer_sent: '📤', email_in: '📥', email_out: '📤', dismissed_flag: '🚩',
};
const _F3_ACT_LABELS = {
    call: 'Opkald', service_call: 'Service-kald', meeting: 'Møde', task: 'Opgave', note: 'Note',
    followup: 'Opfølgning', offer_sent: 'Tilbud sendt', email_in: 'Mail ind', email_out: 'Mail ud',
    dismissed_flag: 'Påmindelse afsluttet',
};
const _F3_RESULT_LABELS = {
    reached: 'Nået', no_answer: 'Intet svar', busy: 'Optaget', voicemail: 'Besked',
    callback: 'Callback', email_instead: 'Email',
};
const _F3_SENT = { positive: '😊 God', neutral: '😐 Neutral', negative: '😟 Dårlig' };

// Aktivitet aggregeret på tværs af firmaets kontaktpersoner.
// Hver række viser HVEM den lå på — det er pointen med firma-niveauet.
function _f3RenderAktivitet(el) {
    const activities = _f3State.data?.activities || [];
    if (!activities.length) {
        el.innerHTML = `
            <div class="f3-empty">
                Ingen aktivitet registreret på firmaets kontaktpersoner endnu.<br>
                <span class="f3-muted-sm">Opkald, noter og møder logget på en kontaktperson dukker op her.</span>
            </div>`;
        return;
    }

    const rows = activities.map(a => {
        const isFlag = a.type === 'dismissed_flag';
        const isMeeting = a.type === 'meeting';
        const icon = _F3_ACT_ICONS[a.type] || '•';
        let label = _F3_ACT_LABELS[a.type] || a.type;
        if (isMeeting && a.meeting_type_label) label = a.meeting_type_label;
        const result = a.result ? ' → ' + (_F3_RESULT_LABELS[a.result] || a.result) : '';

        // Planlagt→udført / stadig planlagt (jf. CLAUDE_CRM_PLANLAGT.md)
        let annot = '';
        if (a.due_at && a.done_at) annot = '<span class="f3-act-annot">✓ planlagt → udført</span>';
        else if (a.due_at && !a.done_at) annot = '<span class="f3-act-annot planlagt">⏰ planlagt</span>';

        // Møder vises på deres mødetidspunkt; øvrige på udført-/oprettet-tidspunkt
        const when = (isMeeting && a.due_at) ? a.due_at : (a.done_at || a.created_at);
        const whoOn = a.customer_name && a.customer_name.trim()
            ? `<span class="f3-act-who" title="Aktiviteten ligger på denne kontaktperson">${escapeHtml(a.customer_name.trim())}</span>`
            : (isFlag ? '<span class="f3-act-who f3-act-who-company">på firmaet</span>' : '');
        const bon = a.bon_number ? `<span class="f3-act-bon">#${escapeHtml(a.bon_number)}</span>` : '';
        const sent = a.sentiment ? `<span class="f3-act-sent ${a.sentiment}">${_F3_SENT[a.sentiment] || a.sentiment}</span>` : '';
        const purpose = a.purpose_label ? `<span class="f3-act-purpose">${a.purpose_emoji || ''} ${escapeHtml(a.purpose_label)}</span>` : '';

        return `
            <div class="f3-act-item${isFlag ? ' f3-act-readonly' : ''}">
                <div class="f3-act-icon">${icon}</div>
                <div class="f3-act-body">
                    <div class="f3-act-head">
                        <span class="f3-act-type">${escapeHtml(label)}${escapeHtml(result)}</span>
                        ${annot}${whoOn}${bon}
                        <span class="f3-act-time">${_f3FormatDate(when)}</span>
                    </div>
                    ${a.text ? `<div class="f3-act-text">${escapeHtml(a.text)}</div>` : ''}
                    ${isFlag && a.note ? `<div class="f3-act-note">${escapeHtml(a.note)}</div>` : ''}
                    ${(sent || purpose || a.user_name) ? `<div class="f3-act-foot">${sent}${purpose}${a.user_name ? `<span class="f3-act-user">${escapeHtml(a.user_name)}</span>` : ''}</div>` : ''}
                </div>
            </div>`;
    }).join('');

    el.innerHTML = `
        <div class="f3-card">
            <div class="f3-card-h"><span class="f3-card-title">Aktivitet på tværs af firmaets kontaktpersoner (${activities.length})</span></div>
            <div class="f3-card-b"><div class="f3-act-list">${rows}</div></div>
        </div>`;
}

// ─── BERIG-FLOW (Fase 3: fuld modal-UI med diff-checkboxes) ────

async function _f3OpenEnrich() {
    const btn = document.getElementById('f3-enrich-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Henter forslag…';

    try {
        const preview = await fetchCompanyEnrichPreview(_f3State.companyId);
        if (!preview.found) {
            _f3ShowToast('Ingen match: ' + (preview.besked || 'CVR ikke fundet'), 'error');
            return;
        }
        _f3RenderEnrichModal(preview);
    } catch (err) {
        _f3ShowToast('Fejl: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '⟳ Berig fra CVR';
        }
    }
}

function _f3RenderEnrichModal(preview) {
    const { konfidens, kilde, diff } = preview;
    const company = _f3State.data.company;

    const writableFields = diff.fields.filter(f => f.writable);
    const derivedFields  = diff.fields.filter(f => !f.writable);
    const changedCount   = writableFields.filter(f => f.changed).length;
    const newCpsCount    = diff.contact_points.filter(cp => !cp.already_exists).length;

    // Header-sub
    const cvrBit  = company.cvr ? `CVR ${company.cvr}` : 'CVR ikke sat';
    const legalBit = company.legal_name ? ` · ${escapeHtml(company.legal_name)}` : '';
    const subtitle = `${cvrBit}${legalBit} · ${escapeHtml(kilde || '')}`;

    // Statusbar
    const konfPct = Math.round((konfidens || 0) * 100);
    let statusClass = 'success';
    if (konfPct < 80) statusClass = 'warn';
    const statusMsg = `✓ Match fundet · konfidens ${konfPct}% · ${changedCount} felt${changedCount === 1 ? '' : 'er'} har ny data, ${writableFields.length - changedCount} er uændrede`;

    // Felter-sektion
    const fieldsHtml = writableFields.map(f => _f3RenderDiffRow(f, false)).join('') +
                       derivedFields.map(f => _f3RenderDiffRow(f, true)).join('');

    // Contact_points-sektion
    const cpsHtml = diff.contact_points.length === 0
        ? '<div class="f3-empty" style="padding:16px 22px;">Ingen kontaktpunkter fundet i CVR.</div>'
        : diff.contact_points.map(cp => _f3RenderEnrichCpRow(cp)).join('');

    const overlay = document.createElement('div');
    overlay.className = 'f3-overlay';
    overlay.innerHTML = `
        <div class="f3-modal" id="f3-enrich-modal">
            <div class="f3-modal-h">
                <div>
                    <h2>⟳ Berig fra CVR</h2>
                    <div class="f3-modal-sub">${escapeHtml(subtitle)}</div>
                </div>
                <button class="f3-modal-close" type="button" data-close>×</button>
            </div>
            <div class="f3-modal-status ${statusClass}">${statusMsg}</div>
            <div class="f3-modal-b">
                <div class="f3-diff-section">
                    <div class="f3-diff-section-h">Stamdata</div>
                    ${fieldsHtml}
                </div>
                <div class="f3-diff-section">
                    <div class="f3-diff-section-h">Kontaktpunkter fra CVR<span class="lbl-extra">— alle markeres automatisk som offentlig (PUB)</span></div>
                    ${cpsHtml}
                </div>
            </div>
            <div class="f3-modal-f">
                <div class="f3-modal-f-info" id="f3-modal-info">
                    <span id="f3-modal-changes-count">${changedCount}</span> ændring(er) + <span id="f3-modal-cps-count">${newCpsCount}</span> nye kontaktpunkt(er) gemmes
                </div>
                <div class="f3-modal-f-actions">
                    <button class="f3-btn" type="button" data-close>Annullér</button>
                    <button class="f3-btn f3-btn-primary" type="button" id="f3-modal-accept">✓ Accepter valgte</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    _f3State.modalEl = overlay;

    // Bindings
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) _f3CloseEnrichModal();
    });
    overlay.querySelectorAll('[data-close]').forEach(b =>
        b.addEventListener('click', _f3CloseEnrichModal)
    );
    document.addEventListener('keydown', _f3HandleEscape);

    // Live update af change-count når checkboxes toggles
    overlay.querySelectorAll('.f3-diff-cb').forEach(cb => {
        cb.addEventListener('change', () => _f3UpdateModalCounts(overlay));
    });

    overlay.querySelector('#f3-modal-accept').addEventListener('click',
        () => _f3HandleAcceptEnrich(preview));
}

function _f3RenderDiffRow(f, derived) {
    const proposedDisplay = f.proposed === null || f.proposed === undefined || f.proposed === ''
        ? '<span class="empty" style="font-style:italic">— ingen data —</span>'
        : escapeHtml(String(f.proposed));
    const currentEmpty = f.current === null || f.current === undefined || f.current === '';
    const currentDisplay = currentEmpty
        ? '<span class="empty" style="font-style:italic">— ikke sat —</span>'
        : escapeHtml(String(f.current));

    const rowClass = derived ? 'derived' : (f.changed ? '' : 'unchanged');
    const cbAttrs = derived
        ? 'disabled'
        : (f.changed ? 'checked' : 'disabled');

    return `
        <div class="f3-diff-row ${rowClass}" data-field-key="${escapeHtml(f.key)}" data-writable="${derived ? '0' : '1'}">
            <input type="checkbox" class="f3-diff-cb" ${cbAttrs}>
            <div class="f3-diff-label">${escapeHtml(f.label)}</div>
            <div class="f3-diff-current ${currentEmpty ? 'empty' : ''}">${currentDisplay}</div>
            <div class="f3-diff-new">${proposedDisplay}</div>
        </div>
    `;
}

function _f3RenderEnrichCpRow(cp) {
    const icon = cp.kind === 'email' ? mailIcon(13) : phoneIcon(13);
    const exists = !!cp.already_exists;
    const valueDisplay = exists
        ? `${escapeHtml(cp.value)} <span class="f3-ct-already">— allerede registreret${cp.existing_is_public === 1 ? ' (offentlig)' : ' (personlig)'}</span>`
        : escapeHtml(cp.value);
    const cbAttrs = exists ? 'disabled' : 'checked';
    const meta = cp.kind === 'email'
        ? 'Officiel email registreret i CVR'
        : 'Officielt telefonnummer registreret i CVR';

    return `
        <div class="f3-ct-row ${exists ? 'exists' : ''}" data-cp-kind="${cp.kind}" data-cp-value="${escapeHtml(cp.value)}">
            <input type="checkbox" class="f3-diff-cb" ${cbAttrs}>
            <div class="f3-ct-icon ${cp.kind}">${icon}</div>
            <div>
                <div class="f3-ct-value">${valueDisplay}</div>
                <div class="f3-ct-meta">${meta}</div>
            </div>
            <span class="f3-pill f3-pill-pub">PUB</span>
        </div>
    `;
}

function _f3UpdateModalCounts(overlay) {
    const fieldChecked = overlay.querySelectorAll('.f3-diff-row[data-writable="1"] .f3-diff-cb:checked').length;
    const cpsChecked   = overlay.querySelectorAll('.f3-ct-row:not(.exists) .f3-diff-cb:checked').length;
    overlay.querySelector('#f3-modal-changes-count').textContent = fieldChecked;
    overlay.querySelector('#f3-modal-cps-count').textContent     = cpsChecked;
    const acceptBtn = overlay.querySelector('#f3-modal-accept');
    if (acceptBtn) acceptBtn.disabled = fieldChecked === 0 && cpsChecked === 0;
}

async function _f3HandleAcceptEnrich(preview) {
    const overlay = _f3State.modalEl;
    if (!overlay) return;
    const acceptBtn = overlay.querySelector('#f3-modal-accept');
    if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.textContent = 'Gemmer…';
    }

    // Saml valgte felter
    const fieldKeys = [];
    const proposed_data = {};
    const fieldByKey = {};
    for (const f of preview.diff.fields) fieldByKey[f.key] = f;

    overlay.querySelectorAll('.f3-diff-row[data-writable="1"]').forEach(row => {
        const cb = row.querySelector('.f3-diff-cb');
        if (cb && cb.checked) {
            const key = row.dataset.fieldKey;
            fieldKeys.push(key);
            proposed_data[key] = fieldByKey[key]?.proposed ?? null;
        }
    });

    // Saml valgte contact_points
    const cps = [];
    overlay.querySelectorAll('.f3-ct-row:not(.exists)').forEach(row => {
        const cb = row.querySelector('.f3-diff-cb');
        if (cb && cb.checked) {
            cps.push({
                kind: row.dataset.cpKind,
                value: row.dataset.cpValue,
                is_public: 1,
            });
        }
    });

    try {
        const result = await applyCompanyEnrich(_f3State.companyId, {
            fields: fieldKeys,
            contact_points: cps,
            kilde: preview.kilde,
            konfidens: preview.konfidens,
            proposed_data,
        });

        const fields = result.fields_updated || 0;
        const cpsNew = result.contact_points_created || 0;
        const cpsTouch = result.contact_points_updated || 0;
        const parts = [];
        if (fields > 0) parts.push(`${fields} felt${fields === 1 ? '' : 'er'} opdateret`);
        if (cpsNew > 0) parts.push(`${cpsNew} kontaktpunkt(er) tilføjet`);
        if (cpsTouch > 0) parts.push(`${cpsTouch} kontaktpunkt(er) bekræftet`);
        const msg = parts.length > 0
            ? '✓ Firma beriget — ' + parts.join(', ')
            : '✓ Firma beriget (ingen ændringer)';

        _f3CloseEnrichModal();
        _f3ShowToast(msg, 'success');

        // Reload data + re-render shell + nuværende fane
        _f3State.data = await fetchCrmCompany(_f3State.companyId);
        _f3RenderShell();
        _f3RenderTab(_f3State.tab);
    } catch (err) {
        _f3ShowToast('Fejl: ' + err.message, 'error');
        if (acceptBtn) {
            acceptBtn.disabled = false;
            acceptBtn.textContent = '✓ Accepter valgte';
        }
    }
}

function _f3CloseEnrichModal() {
    if (_f3State.modalEl) {
        _f3State.modalEl.remove();
        _f3State.modalEl = null;
    }
    document.removeEventListener('keydown', _f3HandleEscape);
}

function _f3HandleEscape(e) {
    if (e.key === 'Escape') _f3CloseEnrichModal();
}

// ─── PASTE-FLOW (Fase 4: manuel "Tilføj fra kontaktside") ───────

function _f3OpenPaste() {
    const overlay = document.createElement('div');
    overlay.className = 'f3-overlay';
    overlay.innerHTML = `
        <div class="f3-modal" id="f3-paste-modal" style="max-width:680px">
            <div class="f3-modal-h">
                <div>
                    <h2>📋 Tilføj offentlige kontakter</h2>
                    <div class="f3-modal-sub">Vi henter <strong>ikke</strong> siden automatisk — du skal selv åbne den og klistre indholdet ind.</div>
                </div>
                <button class="f3-modal-close" type="button" data-close>×</button>
            </div>
            <div class="f3-modal-status">
                <strong>Sådan gør du:</strong> 1) Åbn firmaets kontaktside i en ny fane · 2) Markér og kopiér teksten (Cmd/Ctrl+A → Cmd/Ctrl+C) · 3) Klistr ind nedenfor.
            </div>
            <div class="f3-modal-b" id="f3-paste-body">
                <div style="padding:16px 22px">
                    <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-dim);font-weight:600;display:block;margin-bottom:4px">
                        Kilde-URL (gemmes kun som reference)
                    </label>
                    <div style="display:flex;gap:6px;margin-bottom:14px">
                        <input type="url" id="f3-paste-url" placeholder="https://firma.dk/kontakt"
                               style="flex:1;padding:8px 12px;border:1px solid var(--color-border, #d7d1ca);border-radius:6px;font-size:13px;font-family:inherit"/>
                        <button type="button" id="f3-paste-url-open" class="f3-btn" title="Åbn URL i ny fane så du kan kopiere indholdet" disabled>🔗 Åbn</button>
                    </div>

                    <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-dim);font-weight:600;display:block;margin-bottom:4px">
                        Klistret indhold <span style="color:var(--color-text-dim);font-weight:400;text-transform:none;letter-spacing:0">(her sker det egentlige arbejde — knappen nedenfor aktiveres når der er klistret nok ind)</span>
                    </label>
                    <textarea id="f3-paste-text" rows="8" placeholder="Klistr HTML eller tekst her — fx fra kontaktsidens kildekode eller almindelig kopi-indsæt"
                              style="width:100%;padding:8px 12px;border:1px solid var(--color-border, #d7d1ca);border-radius:6px;font-size:13px;font-family:monospace;resize:vertical"></textarea>
                </div>
            </div>
            <div class="f3-modal-f">
                <div class="f3-modal-f-info">
                    Min 50 tegn, max 500 KB
                </div>
                <div class="f3-modal-f-actions">
                    <button class="f3-btn" type="button" data-close>Annullér</button>
                    <button class="f3-btn f3-btn-primary" type="button" id="f3-paste-find" disabled>Find kontakter →</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    _f3State.modalEl = overlay;

    overlay.addEventListener('click', e => { if (e.target === overlay) _f3CloseEnrichModal(); });
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', _f3CloseEnrichModal));
    document.addEventListener('keydown', _f3HandleEscape);

    const textEl = overlay.querySelector('#f3-paste-text');
    const findBtn = overlay.querySelector('#f3-paste-find');
    const urlEl = overlay.querySelector('#f3-paste-url');
    const urlOpenBtn = overlay.querySelector('#f3-paste-url-open');
    textEl.addEventListener('input', () => {
        findBtn.disabled = textEl.value.trim().length < 50;
    });
    const updateUrlOpen = () => {
        const v = urlEl.value.trim();
        urlOpenBtn.disabled = !/^https?:\/\/\S+/i.test(v);
    };
    urlEl.addEventListener('input', updateUrlOpen);
    updateUrlOpen();
    urlOpenBtn.addEventListener('click', () => {
        const v = urlEl.value.trim();
        if (/^https?:\/\/\S+/i.test(v)) window.open(v, '_blank', 'noopener,noreferrer');
    });
    findBtn.addEventListener('click', _f3HandlePasteFind);
}

async function _f3HandlePasteFind() {
    const overlay = _f3State.modalEl;
    if (!overlay) return;
    const text = overlay.querySelector('#f3-paste-text').value;
    const url  = overlay.querySelector('#f3-paste-url').value.trim() || null;
    const findBtn = overlay.querySelector('#f3-paste-find');
    findBtn.disabled = true;
    findBtn.textContent = 'Søger…';

    try {
        const result = await extractCompanyContacts(_f3State.companyId, text, url);
        _f3RenderPasteResults(result);
    } catch (err) {
        _f3ShowToast('Fejl: ' + err.message, 'error');
        findBtn.disabled = false;
        findBtn.textContent = 'Find kontakter →';
    }
}

function _f3RenderPasteResults(result) {
    const overlay = _f3State.modalEl;
    if (!overlay) return;
    const candidates = result.candidates || [];
    const stats = result.stats || {};

    if (candidates.length === 0) {
        overlay.querySelector('#f3-paste-body').innerHTML = `
            <div class="f3-empty">
                Ingen emails eller telefoner fundet i indholdet.<br>
                <span class="f3-muted-sm">Prøv at klistre footer/kontakt-sektion ind hvis indholdet var en lang side.</span>
            </div>
        `;
        overlay.querySelector('.f3-modal-f').innerHTML = `
            <div class="f3-modal-f-info">Intet at gemme</div>
            <div class="f3-modal-f-actions">
                <button class="f3-btn" type="button" data-close>Luk</button>
            </div>
        `;
        overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', _f3CloseEnrichModal));
        return;
    }

    // Grupper kandidater
    const publics = candidates.filter(c => c.classification === 'public' && !c.already_exists);
    const unknowns = candidates.filter(c => c.classification === 'unknown' && !c.already_exists);
    const personals = candidates.filter(c => c.classification === 'personal' && !c.already_exists);
    const exists = candidates.filter(c => c.already_exists);

    function renderRow(c, idx, defaultChecked) {
        const icon = c.kind === 'email' ? mailIcon(13) : phoneIcon(13);
        const valLabel = c.already_exists
            ? `${escapeHtml(c.value)} <span class="f3-ct-already">— allerede registreret${c.existing_is_public === 1 ? ' (offentlig)' : ' (personlig)'}</span>`
            : escapeHtml(c.value);
        const cbAttrs = c.already_exists ? 'disabled' : (defaultChecked ? 'checked' : '');
        const snippet = c.context_snippet ? `<div class="f3-ct-meta">${escapeHtml(c.context_snippet)}</div>` : '';
        return `
            <div class="f3-ct-row ${c.already_exists ? 'exists' : ''}" data-idx="${idx}">
                <input type="checkbox" class="f3-diff-cb" ${cbAttrs}/>
                <div class="f3-ct-icon ${c.kind}">${icon}</div>
                <div>
                    <div class="f3-ct-value">${valLabel}</div>
                    ${snippet}
                </div>
                <span class="f3-pill f3-pill-pub">PUB</span>
            </div>
        `;
    }

    let html = '';
    if (publics.length > 0) {
        html += `
            <div class="f3-diff-section">
                <div class="f3-diff-section-h">✓ Foreslået offentlig (${publics.length})</div>
                ${publics.map(c => renderRow(c, candidates.indexOf(c), true)).join('')}
            </div>
        `;
    }
    if (unknowns.length > 0) {
        html += `
            <div class="f3-diff-section">
                <div class="f3-diff-section-h">? Ukendt — du vælger (${unknowns.length})</div>
                ${unknowns.map(c => renderRow(c, candidates.indexOf(c), false)).join('')}
            </div>
        `;
    }
    if (personals.length > 0) {
        html += `
            <div class="f3-diff-section">
                <div class="f3-diff-section-h">⚠ Ligner personlige (${personals.length}) <span class="lbl-extra">— markér selv hvis offentlige</span></div>
                ${personals.map(c => renderRow(c, candidates.indexOf(c), false)).join('')}
            </div>
        `;
    }
    if (exists.length > 0) {
        html += `
            <div class="f3-diff-section">
                <div class="f3-diff-section-h">— Allerede registreret (${exists.length})</div>
                ${exists.map(c => renderRow(c, candidates.indexOf(c), false)).join('')}
            </div>
        `;
    }

    overlay.querySelector('#f3-paste-body').innerHTML = html;

    const sourceText = result.source_url
        ? `Kilde: ${escapeHtml(result.source_url)}`
        : 'Ingen kilde-URL angivet';
    const truncNote = stats.truncated
        ? ' · <span style="color:var(--brand-primary)">listen er afkortet — klistr en mindre/mere præcis del ind hvis du mangler nogen</span>'
        : '';

    overlay.querySelector('.f3-modal-f').innerHTML = `
        <div class="f3-modal-f-info">
            ${stats.total_emails_found || 0} emails + ${stats.total_phones_found || 0} telefoner fundet · ${sourceText}${truncNote}
        </div>
        <div class="f3-modal-f-actions">
            <button class="f3-btn" type="button" data-close>Annullér</button>
            <button class="f3-btn f3-btn-primary" type="button" id="f3-paste-save">✓ Tilføj valgte</button>
        </div>
    `;
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', _f3CloseEnrichModal));

    // Live count
    const updateCount = () => {
        const checked = overlay.querySelectorAll('.f3-ct-row .f3-diff-cb:checked').length;
        const btn = overlay.querySelector('#f3-paste-save');
        if (btn) {
            btn.textContent = checked === 0 ? '✓ Tilføj valgte' : `✓ Tilføj ${checked} valgte`;
            btn.disabled = checked === 0;
        }
    };
    overlay.querySelectorAll('.f3-ct-row .f3-diff-cb').forEach(cb => cb.addEventListener('change', updateCount));
    updateCount();

    overlay.querySelector('#f3-paste-save').addEventListener('click', () => _f3HandlePasteSave(candidates, result.source_url));
}

async function _f3HandlePasteSave(candidates, sourceUrl) {
    const overlay = _f3State.modalEl;
    if (!overlay) return;
    const btn = overlay.querySelector('#f3-paste-save');
    btn.disabled = true;
    btn.textContent = 'Gemmer…';

    const selected = [];
    overlay.querySelectorAll('.f3-ct-row[data-idx]').forEach(row => {
        const cb = row.querySelector('.f3-diff-cb');
        if (cb && cb.checked) {
            const idx = parseInt(row.dataset.idx, 10);
            const c = candidates[idx];
            if (c) selected.push(c);
        }
    });

    let created = 0, errors = 0;
    const note = sourceUrl ? `Indsat via paste-flow fra ${sourceUrl}` : 'Indsat via paste-flow';
    for (const c of selected) {
        try {
            await createContactPoint({
                entity_type: 'company',
                entity_id: _f3State.companyId,
                kind: c.kind,
                value: c.value,
                source: 'website',
                is_public: 1,
                verified_at: new Date().toISOString(),
                notes: note,
            });
            created++;
        } catch (err) {
            errors++;
            console.error('paste-save fejlede for', c.value, err);
        }
    }

    _f3CloseEnrichModal();
    if (created > 0) {
        _f3ShowToast(`✓ ${created} kontaktpunkt${created === 1 ? '' : 'er'} tilføjet${errors > 0 ? ` (${errors} fejl)` : ''}`, 'success');
    } else if (errors > 0) {
        _f3ShowToast(`Fejl: ${errors} kontaktpunkt(er) kunne ikke gemmes`, 'error');
    }

    // Reload firma + render shell
    _f3State.data = await fetchCrmCompany(_f3State.companyId);
    _f3RenderShell();
    _f3RenderTab(_f3State.tab);
}

// ─── Toast ──────────────────────────────────────────────────────

function _f3ShowToast(msg, kind) {
    let toast = document.getElementById('f3-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'f3-toast';
        toast.className = 'f3-toast';
        document.body.appendChild(toast);
    }
    toast.className = 'f3-toast ' + (kind || '');
    toast.textContent = msg;
    requestAnimationFrame(() => toast.classList.add('show'));
    if (_f3State.toastTimer) clearTimeout(_f3State.toastTimer);
    _f3State.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}

// ─── KONTAKTPUNKTER: toggle / delete / add ────────────────────

async function _f3HandleTogglePublic(e) {
    const row = e.target.closest('.f3-cp-row');
    if (!row) return;
    const id = parseInt(row.dataset.cpId, 10);
    try {
        await toggleContactPublic(id);
        await _f3ReloadCps();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _f3HandleDeleteCp(e) {
    const row = e.target.closest('.f3-cp-row');
    if (!row) return;
    const id = parseInt(row.dataset.cpId, 10);
    if (!confirm('Slet dette kontaktpunkt?')) return;
    try {
        await deleteContactPoint(id);
        await _f3ReloadCps();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _f3HandleAddCp(kind) {
    const label = kind === 'email' ? 'email' : 'telefonnummer';
    const value = prompt('Indtast ' + label + ':');
    if (!value || !value.trim()) return;
    const isPub = confirm('Skal dette markeres som offentligt (PUB)?\n\nKlik OK for offentligt, Annullér for personligt.');
    try {
        await createContactPoint({
            entity_type: 'company',
            entity_id: _f3State.companyId,
            kind,
            value: value.trim(),
            source: 'manual',
            is_public: isPub ? 1 : 0,
        });
        await _f3ReloadCps();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _f3ReloadCps() {
    _f3State.data = await fetchCrmCompany(_f3State.companyId);
    if (_f3State.tab === 'oversigt') _f3RenderTab('oversigt');
}

// ─── Helpers ────────────────────────────────────────────────────

function _f3FormatDate(iso) {
    if (!iso) return '—';
    // last_enriched_at / flag created_at er UTC — parseServerDate undgår
    // off-by-one på datoen for hændelser i UTC-aftenvinduet.
    const d = (typeof parseServerDate === 'function') ? parseServerDate(iso) : new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
}

function cleanupCrmFirma360() {
    if (_f3State.modalEl) _f3CloseEnrichModal();
    if (_f3State.toastTimer) clearTimeout(_f3State.toastTimer);
    const toast = document.getElementById('f3-toast');
    if (toast) toast.classList.remove('show');
    document.removeEventListener('keydown', _f3HandleEscape);
    _f3State = { container: null, companyId: null, data: null, tab: 'oversigt', opts: {}, modalEl: null, toastTimer: null };
}

window.initCrmFirma360 = initCrmFirma360;
window.cleanupCrmFirma360 = cleanupCrmFirma360;
