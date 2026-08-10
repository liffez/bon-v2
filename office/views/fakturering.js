/**
 * office/views/fakturering.js
 * ═══════════════════════════════════════════════════════════
 * Fakturerings-arbejdsliste — master-detail splitview.
 * Viser LEVERET bonner med payment_type = invoice.
 * ═══════════════════════════════════════════════════════════
 */

/* globals apiFetch, fetchInvoiceQueue, patchBonStatus, patchCompanyEconomic,
           patchCustomerEconomic, patchBon, connectSSE,
           previewEconomicDraft, createEconomicDraft, fetchEconomicReadiness,
           suggestEconomicCustomer, createEconomicCustomer, fetchDeliveryCustomerPrice */

let _faktData = null;
let _faktSelected = null;
let _faktContainer = null;
let _faktOpts = {};
let _faktToastTimer = null;

// ── SSE handler (global for office/index.html) ───────────────
function _faktHandleSSE(event, data) {
    if (!_faktContainer) return;
    if (event === 'bon_status' || event === 'bon_updated' || event === 'bon_created') {
        _faktLoadQueue();
    }
}

function initFakturering(container, opts) {
    _faktContainer = container;
    _faktOpts = opts || {};
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-dim,#888)">Indlæser fakturering...</div>';
    _faktLoadQueue();
}

function cleanupFakturering() {
    _faktContainer = null;
    _faktData = null;
    _faktSelected = null;
}

async function _faktLoadQueue() {
    try {
        _faktData = await fetchInvoiceQueue(true);
        _faktRender();
    } catch (err) {
        if (_faktContainer) {
            _faktContainer.innerHTML = `<div style="padding:40px;color:#bc181b">Fejl: ${err.message}</div>`;
        }
    }
}

// ── Main render ───────────────────────────────────────────────
function _faktRender() {
    if (!_faktContainer || !_faktData) return;
    const { pending, done, summary } = _faktData;

    const monthName = new Date().toLocaleDateString('da-DK', { month: 'long' });

    _faktContainer.innerHTML = `
        <div class="fakt-shell">
            <!-- Summary -->
            <div class="fakt-summary">
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Afventer fakturering</div>
                    <div class="fakt-sum-val">${summary.pending_count}</div>
                    <div class="fakt-sum-sub">bonner &middot; status Leveret</div>
                </div>
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Ufaktureret beløb</div>
                    <div class="fakt-sum-val">${_faktFmt(summary.pending_amount)} kr</div>
                    <div class="fakt-sum-sub">inkl. moms &middot; ${_faktFmt(Moms.inclToExcl(summary.pending_amount))} kr ex</div>
                </div>
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Heraf EAN</div>
                    <div class="fakt-sum-val">${summary.ean_count}</div>
                    <div class="fakt-sum-sub">offentlige kunder</div>
                </div>
                ${summary.drafts_waiting ? `
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Kladder venter</div>
                    <div class="fakt-sum-val">${summary.drafts_waiting}</div>
                    <div class="fakt-sum-sub">sendt &middot; afventer bogføring i e-conomic</div>
                </div>` : ''}
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Faktureret ${monthName}</div>
                    <div class="fakt-sum-val">${_faktFmt(summary.done_amount_month)} kr</div>
                    <div class="fakt-sum-sub">${summary.done_count_month} bonner &middot; inkl. moms &middot; ${_faktFmt(Moms.inclToExcl(summary.done_amount_month))} kr ex</div>
                </div>
            </div>

            <!-- Master-detail -->
            <div class="fakt-master-detail">
                <div class="fakt-list" id="fakt-list-panel"></div>
                <div class="fakt-detail" id="fakt-detail-panel">
                    <div class="fakt-detail-empty">
                        <div class="fakt-detail-empty-icon">💰</div>
                        <div>Vælg en bon fra listen</div>
                    </div>
                </div>
            </div>
        </div>
        <div class="fakt-toast" id="fakt-toast"></div>
    `;

    _faktRenderList();

    // Auto-select first pending
    if (pending.length > 0) {
        _faktSelectBon(pending[0]);
    }
}

// ── List panel ───────────────────────────────────────────────
function _faktRenderList(filter) {
    const listEl = document.getElementById('fakt-list-panel');
    if (!listEl || !_faktData) return;

    const { pending, done } = _faktData;
    const q = (filter || '').toLowerCase();

    const filterBon = (b) => {
        if (!q) return true;
        const s = `${b.bon_number} ${b.company?.name || ''} ${b.customer?.first_name || ''} ${b.customer?.last_name || ''}`.toLowerCase();
        return s.includes(q);
    };

    const filteredPending = pending.filter(filterBon);
    const filteredDone = done.filter(b => {
        if (!q) return true;
        return `${b.bon_number} ${b.company_name || ''} ${b.customer_name || ''}`.toLowerCase().includes(q);
    });

    const monthName = new Date().toLocaleDateString('da-DK', { month: 'long', year: 'numeric' });

    // Søgefeltet er INDE i listEl — bevar fokus + markør hen over re-render
    // så man ikke skal klikke i feltet igen efter hvert tegn.
    withFocusPreserved(listEl, () => {
        listEl.innerHTML = `
            <div class="fakt-list-filter">
                <input type="text" placeholder="Søg bon, kunde…" id="fakt-search" value="${_escHtml(filter || '')}">
            </div>
            <div class="fakt-section-header">
                <span>Afventer fakturering &middot; ${filteredPending.length}</span>
            </div>
            ${filteredPending.map(b => _faktRowHtml(b, false)).join('')}
            ${filteredDone.length > 0 ? `
                <div class="fakt-section-header">
                    <span>Faktureret — ${monthName} &middot; ${filteredDone.length}</span>
                </div>
                ${filteredDone.map(b => _faktDoneRowHtml(b)).join('')}
            ` : ''}
        `;
    });

    // Search
    const searchEl = document.getElementById('fakt-search');
    let debounce;
    searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => _faktRenderList(searchEl.value), 200);
    });

    // Click handlers
    listEl.querySelectorAll('[data-bon-id]').forEach(row => {
        row.addEventListener('click', () => {
            const id = parseInt(row.dataset.bonId);
            const bon = pending.find(b => b.id === id) || done.find(b => b.id === id);
            if (bon) _faktSelectBon(bon);
        });
    });
}

function _faktRowHtml(bon, isDone) {
    const days = bon.days_since_delivery || 0;
    const dotColor = days <= 3 ? '#5a8a3a' : days <= 7 ? '#e8a832' : '#bc181b';
    const displayName = bon.company?.name || `${bon.customer?.first_name || ''} ${bon.customer?.last_name || ''}`.trim() || 'Ukendt';
    const isEan = !!bon.company?.ean;
    const badgeHtml = isEan
        ? '<span class="fakt-badge fakt-badge-ean">EAN</span>'
        : '<span class="fakt-badge fakt-badge-normal">Faktura</span>';
    const dateStr = _faktDateShort(bon.delivery_date);
    const selected = _faktSelected?.id === bon.id ? ' selected' : '';
    // Udkast sendt til e-conomic → vis overstreget (bliver i køen til faktureret).
    const drafted = bon.economic_draft_number != null;
    const draftCls = drafted ? ' fakt-row-drafted' : '';
    const draftBadge = drafted
        ? `<span class="fakt-badge fakt-badge-draft" title="Kladde sendt til e-conomic">&#9993; Kladde ${bon.economic_draft_number}</span>`
        : '';

    return `
        <div class="fakt-row${selected}${draftCls}" data-bon-id="${bon.id}">
            <div class="fakt-row-age">
                <div class="fakt-age-dot" style="background:${dotColor}"></div>
                <div class="fakt-age-days">${days}d</div>
            </div>
            <div class="fakt-row-body">
                <div class="fakt-row-top">
                    <span class="fakt-bon-num">#${bon.bon_number}</span>
                    <span class="fakt-bon-amount">${_faktFmt(bon.line_total)} kr</span>
                </div>
                <div class="fakt-row-kunde">${_escHtml(displayName)}</div>
                <div class="fakt-row-sub">
                    ${dateStr} &middot; ${bon.pax || 0} pax
                    ${badgeHtml}${draftBadge}
                </div>
            </div>
        </div>
    `;
}

function _faktDoneRowHtml(bon) {
    const displayName = bon.company_name || bon.customer_name || 'Ukendt';
    const dateStr = _faktDateShort(bon.delivery_date);
    const fDate = bon.faktureret_date ? _faktDateShort(bon.faktureret_date.slice(0, 10)) : '';
    const selected = _faktSelected?.id === bon.id ? ' selected' : '';

    return `
        <div class="fakt-row done${selected}" data-bon-id="${bon.id}">
            <div class="fakt-row-age">
                <div class="fakt-age-dot" style="background:#5a8a3a"></div>
                <div class="fakt-age-days" style="color:#5a8a3a">&#10003;</div>
            </div>
            <div class="fakt-row-body">
                <div class="fakt-row-top">
                    <span class="fakt-bon-num">#${bon.bon_number}</span>
                    <span class="fakt-bon-amount">${_faktFmt(bon.line_total)} kr</span>
                </div>
                <div class="fakt-row-kunde">${_escHtml(displayName)}</div>
                <div class="fakt-row-sub">${dateStr}${fDate ? ' &middot; Faktureret ' + fDate : ''}</div>
            </div>
        </div>
    `;
}

// ── Select & detail ──────────────────────────────────────────
function _faktSelectBon(bon) {
    _faktSelected = bon;

    // Update list selection
    document.querySelectorAll('.fakt-row').forEach(r => {
        r.classList.toggle('selected', parseInt(r.dataset.bonId) === bon.id);
    });

    const detailEl = document.getElementById('fakt-detail-panel');
    if (!detailEl) return;

    // If done bon (no lines), show minimal
    if (!bon.lines) {
        detailEl.innerHTML = `
            <div class="fakt-detail-content">
                <div class="fakt-detail-top">
                    <div class="fakt-detail-bon-id">#${bon.bon_number}</div>
                    <div class="fakt-detail-top-right">
                        <button class="fakt-btn-ghost" onclick="_faktOpenBon(${bon.id})">Åbn bon &#8599;</button>
                    </div>
                </div>
                <div class="fakt-invoiced-stamp">&#10003; Faktureret</div>
            </div>
        `;
        return;
    }

    const isPending = bon.status_code === 'LEVERET';
    const isEan = !!bon.company?.ean;
    const eanBadge = isEan
        ? `<span class="fakt-badge fakt-badge-ean" style="font-size:12px;padding:4px 10px">EAN ${_escHtml(bon.company.ean)}</span>`
        : '';

    detailEl.innerHTML = `
        <div class="fakt-detail-content">
            <!-- Top -->
            <div class="fakt-detail-top">
                <div class="fakt-detail-bon-id">#${bon.bon_number}</div>
                <div class="fakt-detail-top-right">
                    ${eanBadge}
                    <button class="fakt-btn-ghost" onclick="_faktOpenBon(${bon.id})">Åbn bon &#8599;</button>
                </div>
            </div>

            <!-- Action bar top -->
            ${isPending ? _faktActionBarHtml(bon) : `
                <div class="fakt-action-bar">
                    <div class="fakt-invoiced-stamp">&#10003; Faktureret</div>
                </div>
            `}

            <!-- Levering -->
            <div class="fakt-card">
                <div class="fakt-card-header">Levering</div>
                <div class="fakt-card-body">
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Dato</div>
                        <div class="fakt-info-val big">${_faktDateLong(bon.delivery_date)}</div>
                    </div>
                    ${bon.pickup_time || bon.delivery_time ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Tid</div>
                        <div class="fakt-info-val">${bon.pickup_time || ''} ${bon.delivery_time ? '&rarr; levering ' + bon.delivery_time : ''}</div>
                    </div>` : ''}
                    ${bon.delivery_address ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Adresse</div>
                        <div class="fakt-info-val"><strong>${_escHtml(bon.delivery_address.street_name || '')} ${_escHtml(bon.delivery_address.street_nr || '')}</strong><br>${_escHtml(bon.delivery_address.postal_code || '')} ${_escHtml(bon.delivery_address.city || '')}</div>
                    </div>` : ''}
                    ${bon.day_contact_name ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Dagskontakt</div>
                        <div class="fakt-info-val">${_escHtml(bon.day_contact_name)}${bon.day_contact_phone ? ' &middot; ' + _escHtml(bon.day_contact_phone) : ''}</div>
                    </div>` : ''}
                    ${bon.delivery_method ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Metode</div>
                        <div class="fakt-info-val">${_faktDeliveryLabel(bon.delivery_method)}</div>
                    </div>
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Leveringspris<br><span style="font-size:10px;opacity:.7">til kunde, faktureres</span></div>
                        <div class="fakt-info-val" id="fakt-delivery-price"></div>
                    </div>` : ''}
                </div>
            </div>

            <!-- Kunde & firma -->
            <div class="fakt-card">
                <div class="fakt-card-header">Kunde &amp; firma</div>
                <div class="fakt-card-body">
                    ${bon.customer ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Kontakt</div>
                        <div class="fakt-info-val">
                            <strong>${_escHtml(bon.customer.first_name || '')} ${_escHtml(bon.customer.last_name || '')}</strong>
                            ${bon.customer.email ? '<br>' + _escHtml(bon.customer.email) : ''}
                            ${bon.customer.phone ? '<br>' + _escHtml(bon.customer.phone) : ''}
                        </div>
                    </div>` : ''}
                    ${bon.company ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Firma</div>
                        <div class="fakt-info-val"><strong>${_escHtml(bon.company.name)}</strong>${bon.company.legal_name && bon.company.legal_name !== bon.company.name ? '<br><span style="font-size:11px;color:var(--color-text-dim);">' + _escHtml(bon.company.legal_name) + '</span>' : ''}${bon.company.cvr ? '<br>CVR ' + _escHtml(bon.company.cvr) : ''}</div>
                    </div>
                    ${bon.company.ean ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">EAN</div>
                        <div class="fakt-info-val mono"><strong>${_escHtml(bon.company.ean)}</strong></div>
                    </div>` : ''}
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">e-conomic<br><span style="font-size:10px;opacity:.7">firma-nr</span></div>
                        <div class="fakt-info-val" id="fakt-eco-firma"></div>
                    </div>
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">e-conomic<br><span style="font-size:10px;opacity:.7">kontakt-nr</span></div>
                        <div class="fakt-info-val" id="fakt-eco-kontakt"></div>
                    </div>
                    ` : `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">e-conomic<br><span style="font-size:10px;opacity:.7">kunde-nr</span></div>
                        <div class="fakt-info-val" id="fakt-eco-privat"></div>
                    </div>
                    `}
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Betaling</div>
                        <div class="fakt-info-val">${_escHtml(bon.payment_type_label || bon.payment_type || '')}</div>
                    </div>
                </div>
            </div>

            <!-- Ordre -->
            <div class="fakt-card">
                <div class="fakt-card-header">Ordre</div>
                <div class="fakt-card-body">
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Pax / enheder</div>
                        <div class="fakt-info-val"><strong>${bon.pax || 0} pax</strong>${bon.total_units ? ' &middot; ' + bon.total_units + ' enheder' : ''}</div>
                    </div>
                    ${bon.price_category_label ? `
                    <div class="fakt-info-row">
                        <div class="fakt-info-label">Priskategori</div>
                        <div class="fakt-info-val">${_escHtml(bon.price_category_label)}</div>
                    </div>` : ''}
                </div>
            </div>

            <!-- Køkken info -->
            ${bon.kitchen_note ? `
            <div class="fakt-card">
                <div class="fakt-card-header">Køkken info</div>
                <div class="fakt-card-body" style="padding:12px 16px">
                    <div class="fakt-kitchen-note" style="margin:0">${_escHtml(bon.kitchen_note)}</div>
                </div>
            </div>` : ''}

            <!-- Varer -->
            <div class="fakt-card">
                <div class="fakt-card-header">Varer</div>
                <div class="fakt-card-body">
                    <table class="fakt-varer">
                        <thead><tr><th style="width:30px">Ant</th><th>Produkt</th><th style="text-align:right">Pris</th></tr></thead>
                        <tbody>
                            ${/* Ens linjer slås sammen — samme visning som fakturaudkastet (shared/bon_lines.js) */ ''}
                            ${BonLines.mergeLines(bon.lines).map(l => `
                            <tr>
                                <td class="fakt-varer-qty">${l.quantity}</td>
                                <td>
                                    <div class="fakt-varer-name">${_escHtml(l.product_name)}</div>
                                    ${l.special_request || l.notes ? `<div class="fakt-varer-sub">${_escHtml(l.special_request || l.notes || '')}</div>` : ''}
                                </td>
                                <td class="fakt-varer-price${(l.line_total || 0) === 0 ? ' fakt-varer-zero' : ''}">${_faktFmt(l.line_total || 0)} kr</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                    ${(() => {
                        // Beregn ex/moms/incl konsistent med §6b. bon.line_total er INCL.
                        const m = window.Moms.computeMomsFields(bon.line_total || 0);
                        return `
                            <div class="fakt-sum-row">
                                <span>Subtotal (ekskl. moms)</span>
                                <span>${_faktFmt(m.total_excl_moms)} kr</span>
                            </div>
                            <div class="fakt-sum-row">
                                <span>Moms (25%)</span>
                                <span>${_faktFmt(m.moms_amount)} kr</span>
                            </div>
                            <div class="fakt-sum-row fakt-sum-row-total">
                                <span><strong>Total (inkl. moms)</strong></span>
                                <span><strong>${_faktFmt(m.total_incl_moms)} kr</strong></span>
                            </div>
                        `;
                    })()}
                </div>
            </div>

            <!-- Noter -->
            ${bon.customer_note || bon.invoice_note || bon.internal_note ? `
            <div class="fakt-card">
                <div class="fakt-card-header">Noter</div>
                <div class="fakt-card-body">
                    ${_faktNoteRow('Kundeønsker', bon.customer_note)}
                    ${_faktNoteRow('Faktura info', bon.invoice_note)}
                    ${_faktNoteRow('Interne noter', bon.internal_note)}
                </div>
            </div>` : ''}

            <!-- Action bar bottom -->
            ${isPending ? _faktActionBarHtml(bon, true) : ''}
        </div>
    `;

    // Render e-conomic fields
    if (bon.company) {
        _faktRenderEcoField('fakt-eco-firma', bon.company.economic_customer_id, 'firma', bon);
        _faktRenderEcoField('fakt-eco-kontakt', bon.customer?.economic_contact_id, 'kontakt', bon);
    } else if (bon.customer) {
        _faktRenderEcoField('fakt-eco-privat', bon.customer.economic_customer_id, 'privat', bon);
    }
    if (bon.delivery_method) _faktRenderDeliveryPrice(bon);
}

// ── Leveringspris (kunde) — vises/sættes ved fakturering ─────
function _faktRenderDeliveryPrice(bon) {
    const el = document.getElementById('fakt-delivery-price');
    if (!el) return;
    const has = bon.delivery_price != null && Number(bon.delivery_price) > 0;
    el.innerHTML = has
        ? `<div class="fakt-eco-field"><span class="fakt-eco-num">${_faktFmt(bon.delivery_price)} kr</span>
             <button class="fakt-eco-edit-btn" onclick="_faktDeliveryPriceEdit(${bon.id})">ret</button></div>`
        : `<div class="fakt-eco-field"><span class="fakt-eco-empty">Ikke sat — faktureres ikke</span>
             <button class="fakt-eco-edit-btn" onclick="_faktDeliveryPriceEdit(${bon.id})">+ Sæt / foreslå</button></div>`;
}

async function _faktDeliveryPriceEdit(bonId) {
    const el = document.getElementById('fakt-delivery-price');
    if (!el) return;
    const bon = _faktSelected;
    el.innerHTML = `<span style="font-size:12px;color:var(--color-text-dim)">Henter By-ex-pris…</span>`;
    let s = {};
    try { s = await fetchDeliveryCustomerPrice(bonId); } catch (e) { /* fortsæt — manuel indtastning */ }
    const cur = (bon && bon.delivery_price) || (s && s.current_delivery_price) || '';
    const sug = s && s.suggested_incl != null ? s.suggested_incl : null;
    const srcLabel = s && s.source === 'receipt' ? 'fra By-ex kvittering'
                   : s && s.source === 'estimate' ? 'By-ex estimat (hvad By-ex ville forlange)' : '';
    el.innerHTML = `
        <div class="fakt-eco-input-wrap">
            <input class="fakt-eco-input" id="fakt-dp-input" value="${cur}" placeholder="kr incl moms" style="width:90px">
            <button class="fakt-eco-save-btn" onclick="_faktDeliveryPriceSave(${bonId})">Gem</button>
            <button class="fakt-eco-cancel-btn" onclick="_faktSelectBon(_faktSelected)">&#10005;</button>
        </div>
        ${sug != null ? `<div style="font-size:11px;margin-top:5px">💡 Foreslået <strong>${_faktFmt(sug)} kr</strong>
            <span style="color:var(--color-text-dim)">${srcLabel} + ${s.markup_pct}%</span>
            <button class="fakt-eco-edit-btn" style="margin-left:6px" onclick="document.getElementById('fakt-dp-input').value='${sug}'">brug</button></div>` : ''}`;
    document.getElementById('fakt-dp-input')?.focus();
}

async function _faktDeliveryPriceSave(bonId) {
    const inp = document.getElementById('fakt-dp-input');
    if (!inp) return;
    const val = parseFloat((inp.value || '').replace(',', '.'));
    if (isNaN(val) || val < 0) { _faktShowToast('Ugyldig pris'); return; }
    try {
        await patchBon(bonId, { delivery_price: Math.round(val * 100) / 100 });
        if (_faktSelected) _faktSelected.delivery_price = val;
        _faktShowToast(`Leveringspris sat til ${_faktFmt(val)} kr`);
        if (_faktSelected) _faktSelectBon(_faktSelected);
    } catch (err) {
        _faktShowToast('Kunne ikke gemme: ' + (err.body?.error || err.message));
    }
}

function _faktActionBarHtml(bon, isBottom) {
    const drafted = bon.economic_draft_number != null;
    const ecoBtns = drafted
        ? `<span class="fakt-eco-draft-tag">&#9993; Kladde ${bon.economic_draft_number} sendt</span>
           <button class="fakt-btn-ghost" onclick="_faktPreviewEconomic(${bon.id})">Forhåndsvis</button>`
        : `<button class="fakt-btn-ghost" onclick="_faktPreviewEconomic(${bon.id})">Forhåndsvis</button>
           <button class="fakt-btn-eco" onclick="_faktSendEconomic(${bon.id})">&#128229; Send til e-conomic</button>`;
    return `
        <div class="fakt-action-bar">
            <button class="fakt-btn-green" onclick="_faktMarkFaktureret(${bon.id})">&#10003; Markér faktureret</button>
            <div style="flex:1"></div>
            ${isBottom
                ? `<button class="fakt-btn-ghost" onclick="_faktOpenBon(${bon.id})">Åbn og rediger bon &#8599;</button>`
                : ecoBtns
            }
        </div>
    `;
}

function _faktNoteRow(label, value) {
    if (!value) return '';
    return `
        <div class="fakt-info-row">
            <div class="fakt-info-label">${label}</div>
            <div class="fakt-info-val">${_escHtml(value)}</div>
        </div>
    `;
}

// ── E-conomic: send udkast / forhåndsvisning ─────────────────
async function _faktSendEconomic(bonId) {
    const bon = _faktData?.pending.find(b => b.id === bonId);
    if (!bon) return;
    try {
        const res = await createEconomicDraft(bonId);
        bon.economic_draft_number = res.economic_draft_number;
        if (_faktData.summary) _faktData.summary.drafts_waiting = (_faktData.summary.drafts_waiting || 0) + 1;
        _faktShowToast(`Kladde ${res.economic_draft_number} oprettet i e-conomic for #${bon.bon_number}`);
        _faktRender();
        _faktSelectBon(bon);
    } catch (err) {
        if (err.status === 422 && err.body?.readiness) {
            _faktEcoOverlay(`Bon #${bon.bon_number} kan ikke sendes endnu`,
                `<p class="fakt-eco-block-lead">Følgende mangler i e-conomic, før et udkast kan oprettes:</p>
                 ${_faktReadinessHtml(err.body.readiness, bonId)}`);
        } else if (err.status === 409) {
            bon.economic_draft_number = err.body?.economic_draft_number ?? bon.economic_draft_number;
            _faktShowToast(`Udkast findes allerede (kladde ${err.body?.economic_draft_number || ''})`);
            _faktSelectBon(bon);
        } else {
            _faktShowToast('e-conomic: ' + (err.body?.error || err.message));
        }
    }
}

async function _faktPreviewEconomic(bonId) {
    const bon = _faktData?.pending.find(b => b.id === bonId) || _faktSelected;
    try {
        const pv = await previewEconomicDraft(bonId);
        let body;
        if (pv.payload) {
            const p = pv.payload;
            const exTotal = p.lines.reduce((s, l) => s + (l.unitNetPrice || 0) * (l.quantity || 0), 0);
            const inclTotal = window.Moms.exclToIncl(exTotal);
            const momsAmt = inclTotal - exTotal;
            body = `
                <div class="fakt-eco-pv-meta">
                    <div><span>Modtager</span><strong>${_escHtml(p.recipient?.name || '')}</strong></div>
                    <div><span>e-conomic kunde-nr</span><strong>${p.customer?.customerNumber ?? '—'}</strong></div>
                    <div><span>Reference</span><strong>${_escHtml(p.references?.other || '')}</strong></div>
                    <div><span>Fakturadato</span><strong>${_escHtml(p.date || '')}</strong></div>
                    ${p.delivery ? `<div><span>Leveringsdato</span><strong>${_escHtml(p.delivery.deliveryDate || '')}</strong></div>` : ''}
                </div>
                <table class="fakt-eco-pv-table">
                    <thead><tr><th>Varenr</th><th>Tekst</th><th class="r">Antal</th><th class="r">Stk-pris (ex)</th><th class="r">Linje (ex)</th></tr></thead>
                    <tbody>
                        ${p.lines.map(l => `<tr>
                            <td class="mono">${_escHtml(l.product?.productNumber || '')}</td>
                            <td>${_escHtml(l.description || '')}${l.discountPercentage ? ` <span class="fakt-eco-pv-disc">−${l.discountPercentage}%</span>` : ''}</td>
                            <td class="r">${l.quantity}</td>
                            <td class="r">${_faktFmt(l.unitNetPrice)}</td>
                            <td class="r">${_faktFmt((l.unitNetPrice || 0) * (l.quantity || 0))}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
                <div class="fakt-eco-pv-sums">
                    <div><span>Linje-priser (ex moms)</span><span>${_faktFmt(exTotal)} kr</span></div>
                    <div><span>Moms (25%, beregnes af e-conomic)</span><span>${_faktFmt(momsAmt)} kr</span></div>
                    <div class="tot"><span><strong>Total til kunde (incl moms)</strong></span><span><strong>${_faktFmt(inclTotal)} kr</strong></span></div>
                </div>
                <p class="fakt-eco-pv-note">Forhåndsvisning — intet er sendt. e-conomic beregner selv momsen ud fra varens momskode.</p>`;
        } else {
            body = `<p class="fakt-eco-block-lead">Udkastet kan ikke bygges endnu:</p>${_faktReadinessHtml(pv.readiness, bonId)}`;
            if (!pv.settings_ok) body += `<p class="fakt-eco-pv-note">⚠ e-conomic-indstillinger (betalingsbetingelse/layout) mangler i Settings.</p>`;
        }
        _faktEcoOverlay(`Forhåndsvisning — kladde til e-conomic (#${bon?.bon_number ?? bonId})`, body);
    } catch (err) {
        _faktShowToast('Forhåndsvisning fejlede: ' + (err.body?.error || err.message));
    }
}

function _faktReadinessHtml(r, bonId) {
    if (!r) return '';
    const items = [];
    if (r.missingCustomer) items.push('Kunden mangler et e-conomic kunde-nr (tilføj det under “Kunde &amp; firma”).');
    if (r.eanWithoutContact) items.push('EAN-kunde uden kontaktperson — e-conomic kræver en kontakt for at sende EAN-faktura.');
    if (r.missingProducts && r.missingProducts.length) {
        items.push(`${r.missingProducts.length} vare(r) mangler et e-conomic varenr:`);
    }
    const showSuggest = bonId && (r.missingCustomer || r.eanWithoutContact);
    return `
        <ul class="fakt-eco-block-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>
        ${r.missingProducts && r.missingProducts.length ? `
        <ul class="fakt-eco-block-products">
            ${r.missingProducts.map(p => `<li>${_escHtml(p.product_name)} <span class="mono">(recipe ${p.grocy_recipe_id ?? '—'})</span></li>`).join('')}
        </ul>` : ''}
        ${showSuggest ? `<button class="fakt-btn-eco" style="margin-top:12px" onclick="_faktSuggestEconomic(${bonId})">&#128269; Foreslå kunde fra e-conomic</button>` : ''}`;
}

// ── Foreslå + kobl kunde/kontakt fra e-conomic ───────────────
async function _faktSuggestEconomic(bonId) {
    _faktEcoOverlay('Søger i e-conomic…', '<p class="fakt-eco-pv-note">Slår firmaet op + henter kontakter…</p>');
    let s;
    try { s = await suggestEconomicCustomer(bonId); }
    catch (err) { _faktEcoOverlay('Forslag fejlede', `<p>${_escHtml(err.body?.error || err.message)}</p>`); return; }

    const cands = s.customer_candidates || [];
    const coName = s.company?.name || s.person?.name || '';
    let html = `<p class="fakt-eco-block-lead">For <strong>${_escHtml(coName)}</strong>${s.company?.cvr ? ` <span class="mono">(CVR ${_escHtml(s.company.cvr)})</span>` : ''}:</p>`;

    // 1) Kunde-kandidater
    if (cands.length) {
        html += `<div class="fakt-sug-sec">Kunde i e-conomic</div>`;
        html += cands.map(c => {
            const already = (s.company?.already || s.person?.already) === c.number;
            return `<div class="fakt-sug-row">
                <div><strong>#${c.number}</strong> ${_escHtml(c.name)} <span class="fakt-sug-tag">${c.match.toUpperCase()}-match</span>${c.cvr ? ` <span class="mono">${_escHtml(c.cvr)}</span>` : ''}</div>
                ${already ? '<span class="fakt-eco-saved">koblet &#10003;</span>'
                          : `<button class="fakt-sug-btn" onclick="_faktCoupleCustomer('${s.target_type}',${s.target_id},'${c.number}',${bonId})">Kobl</button>`}
            </div>`;
        }).join('');
    } else {
        html += `<div class="fakt-sug-none">Ingen kunde fundet i e-conomic for dette firma.
            <div style="margin-top:8px"><button class="fakt-sug-btn" onclick="_faktCreateEconomic(${bonId})">&#10133; Opret i e-conomic</button></div>
        </div>`;
    }

    // 2) Kontakter (kun hvis vi har et kundenummer at hænge dem på)
    if (s.contacts && s.person) {
        html += `<div class="fakt-sug-sec">Kontaktperson — bonens person: <strong>${_escHtml(s.person.name)}</strong></div>`;
        if (s.contacts.list.length) {
            html += s.contacts.list.slice(0, 8).map(ct => {
                const already = s.person.already === ct.number;
                const sug = s.contacts.suggested && s.contacts.suggested.number === ct.number;
                return `<div class="fakt-sug-row">
                    <div>${_escHtml(ct.name)}${ct.email ? ` <span class="mono">${_escHtml(ct.email)}</span>` : ''} ${sug ? '<span class="fakt-sug-tag">foreslået</span>' : ''}</div>
                    ${already ? '<span class="fakt-eco-saved">koblet &#10003;</span>'
                              : `<button class="fakt-sug-btn" onclick="_faktCoupleContact(${s.person.id},'${ct.number}',${bonId})">Kobl</button>`}
                </div>`;
            }).join('');
        }
        if (s.contacts.person_is_new) {
            html += `<div class="fakt-sug-none">Bonens person matcher ingen eksisterende kontakt → <strong>ny kontakt</strong>.
                <div style="margin-top:8px"><button class="fakt-sug-btn" onclick="_faktCreateEconomic(${bonId})">&#10133; Opret kontakt i e-conomic</button></div>
            </div>`;
        }
    }

    _faktEcoOverlay('Foreslå kunde/kontakt fra e-conomic', html);
}

async function _faktCoupleCustomer(targetType, targetId, ecoNumber, bonId) {
    try {
        if (targetType === 'company') await patchCompanyEconomic(targetId, ecoNumber);
        else await patchCustomerEconomic(targetId, { economic_customer_id: ecoNumber });
        _faktShowToast(`Kunde koblet til e-conomic #${ecoNumber}`);
        await _faktLoadQueue();
        _faktSuggestEconomic(bonId);   // genåbn så kontakt-koblingen kan gøres
    } catch (err) { _faktShowToast('Kobling fejlede: ' + (err.body?.error || err.message)); }
}

async function _faktCreateEconomic(bonId) {
    try {
        const r = await createEconomicCustomer(bonId);
        const msg = r.created_customer
            ? `Kunde oprettet i e-conomic (#${r.economic_customer_id})${r.economic_contact_id ? ` + kontakt #${r.economic_contact_id}` : ''}`
            : `Kontakt oprettet i e-conomic (#${r.economic_contact_id})`;
        _faktShowToast(msg);
        await _faktLoadQueue();
        _faktCloseEcoOverlay();
        const bon = _faktData?.pending.find(b => b.id === bonId);
        if (bon) _faktSelectBon(bon);
    } catch (err) {
        if (err.status === 409) _faktShowToast('Allerede koblet i e-conomic');
        else _faktShowToast('Oprettelse fejlede: ' + (err.body?.error || err.message));
    }
}

async function _faktCoupleContact(customerId, contactNumber, bonId) {
    try {
        await patchCustomerEconomic(customerId, { economic_contact_id: contactNumber });
        _faktShowToast(`Kontakt koblet (#${contactNumber})`);
        await _faktLoadQueue();
        _faktCloseEcoOverlay();
        const bon = _faktData?.pending.find(b => b.id === bonId);
        if (bon) _faktSelectBon(bon);
    } catch (err) { _faktShowToast('Kobling fejlede: ' + (err.body?.error || err.message)); }
}

function _faktEcoOverlay(title, bodyHtml) {
    _faktCloseEcoOverlay();
    const ov = document.createElement('div');
    ov.className = 'fakt-eco-overlay';
    ov.id = 'fakt-eco-overlay';
    ov.innerHTML = `
        <div class="fakt-eco-modal">
            <div class="fakt-eco-modal-head">
                <span>${title}</span>
                <button class="fakt-eco-modal-x" onclick="_faktCloseEcoOverlay()">&#10005;</button>
            </div>
            <div class="fakt-eco-modal-body">${bodyHtml}</div>
        </div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) _faktCloseEcoOverlay(); });
    document.body.appendChild(ov);
}

function _faktCloseEcoOverlay() {
    const ov = document.getElementById('fakt-eco-overlay');
    if (ov) ov.remove();
}

// ── E-conomic inline edit ────────────────────────────────────
function _faktRenderEcoField(elId, currentValue, type, bon) {
    const el = document.getElementById(elId);
    if (!el) return;

    if (currentValue) {
        el.innerHTML = `
            <div class="fakt-eco-field">
                <span class="fakt-eco-num">${_escHtml(currentValue)}</span>
                <button class="fakt-eco-edit-btn" onclick="_faktEditEco('${elId}', '${_escHtml(currentValue)}', '${type}', ${bon.id})">rediger</button>
            </div>
        `;
    } else {
        el.innerHTML = `
            <div class="fakt-eco-field">
                <span class="fakt-eco-empty">Ikke angivet</span>
                <button class="fakt-eco-edit-btn" onclick="_faktEditEco('${elId}', '', '${type}', ${bon.id})">+ Tilføj</button>
            </div>
        `;
    }
}

function _faktEditEco(elId, currentValue, type, bonId) {
    const el = document.getElementById(elId);
    if (!el) return;

    el.innerHTML = `
        <div class="fakt-eco-input-wrap">
            <input class="fakt-eco-input" id="${elId}-input" value="${_escHtml(currentValue)}" placeholder="Nummer...">
            <button class="fakt-eco-save-btn" onclick="_faktSaveEco('${elId}', '${type}', ${bonId})">Gem</button>
            <button class="fakt-eco-cancel-btn" onclick="_faktSelectBon(_faktSelected)">&#10005;</button>
        </div>
    `;

    const input = document.getElementById(elId + '-input');
    input.focus();
    input.select();

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _faktSaveEco(elId, type, bonId);
        if (e.key === 'Escape') _faktSelectBon(_faktSelected);
    });
}

async function _faktSaveEco(elId, type, bonId) {
    const input = document.getElementById(elId + '-input');
    if (!input) return;
    const value = input.value.trim();
    const bon = _faktSelected;
    if (!bon) return;

    try {
        if (type === 'firma' && bon.company) {
            await patchCompanyEconomic(bon.company.id, value);
            bon.company.economic_customer_id = value || null;
        } else if (type === 'kontakt' && bon.customer) {
            await patchCustomerEconomic(bon.customer.id, { economic_contact_id: value });
            bon.customer.economic_contact_id = value || null;
        } else if (type === 'privat' && bon.customer) {
            await patchCustomerEconomic(bon.customer.id, { economic_customer_id: value });
            bon.customer.economic_customer_id = value || null;
        }

        // Show saved flash
        const el = document.getElementById(elId);
        if (el) {
            el.innerHTML = `<span class="fakt-eco-saved">Gemt &#10003;</span>`;
            setTimeout(() => _faktRenderEcoField(elId, value || null, type, bon), 1500);
        }
    } catch (err) {
        const el = document.getElementById(elId);
        if (el) el.innerHTML = `<span style="color:#bc181b;font-size:12px">Kunne ikke gemme: ${err.message}</span>`;
        setTimeout(() => _faktRenderEcoField(elId, null, type, bon), 3000);
    }
}

// ── Markér faktureret ────────────────────────────────────────
async function _faktMarkFaktureret(bonId) {
    const bon = _faktData?.pending.find(b => b.id === bonId);
    if (!bon) return;

    // Show confirm dialog
    const result = await _faktConfirmDialog(bon);
    if (result === null) return; // cancelled

    try {
        // 1. PATCH status → FAKTURERET
        //    Fakturavagt (#319): findes der hverken kladde eller bogført faktura,
        //    afviser serveren med 409 NO_INVOICE_FOUND. Vi spørger ÉN gang og
        //    sender igen med bekræftelsen — vagten blokerer aldrig.
        try {
            await patchBonStatus(bonId, 'FAKTURERET');
        } catch (statusErr) {
            if (statusErr.code !== 'NO_INVOICE_FOUND') throw statusErr;
            const goAhead = confirm(
                'Der findes hverken en e-conomic-kladde eller en bogført faktura på bon #'
                + bon.bon_number + '.\n\n'
                + 'Markerer du den som faktureret nu, forlader den faktureringskøen '
                + '— og kunden har aldrig fået en regning.\n\nEr det med vilje?'
            );
            if (!goAhead) return;
            await patchBonStatus(bonId, 'FAKTURERET', undefined, undefined, true);
        }

        // 2. Save invoice ref if provided
        if (result.trim()) {
            const noteText = bon.invoice_note
                ? bon.invoice_note + '\nFakturanr: ' + result.trim()
                : 'Fakturanr: ' + result.trim();
            await patchBon(bonId, { invoice_note: noteText });
        }

        // 3. Animate & remove
        const row = document.querySelector(`.fakt-row[data-bon-id="${bonId}"]`);
        if (row) {
            row.style.transition = 'opacity .4s, transform .4s';
            row.style.opacity = '0.2';
            row.style.transform = 'translateX(-20px)';
        }

        _faktShowToast(`Bon #${bon.bon_number} markeret som Faktureret`);

        // Reload after animation
        setTimeout(() => _faktLoadQueue(), 500);

    } catch (err) {
        _faktShowToast('Fejl: ' + err.message);
    }
}

function _faktConfirmDialog(bon) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fakt-confirm-overlay';
        overlay.innerHTML = `
            <div class="fakt-confirm-dialog">
                <h3>Markér bon #${bon.bon_number} som faktureret?</h3>
                <label>Fakturanummer (valgfrit)</label>
                <input type="text" id="fakt-confirm-ref" placeholder="F-2026-0042">
                <div class="fakt-confirm-buttons">
                    <button class="fakt-btn-ghost" id="fakt-confirm-cancel">Annuller</button>
                    <button class="fakt-btn-green" id="fakt-confirm-ok" style="padding:9px 18px;font-size:13px">&#10003; Markér faktureret</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = document.getElementById('fakt-confirm-ref');
        const cancel = document.getElementById('fakt-confirm-cancel');
        const ok = document.getElementById('fakt-confirm-ok');

        input.focus();

        function close(val) {
            overlay.remove();
            resolve(val);
        }

        cancel.addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        ok.addEventListener('click', () => close(input.value));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') close(input.value);
            if (e.key === 'Escape') close(null);
        });
    });
}

// ── Open bon in drawer ───────────────────────────────────────
function _faktOpenBon(bonId) {
    if (_faktOpts.openDrawer) {
        _faktOpts.openDrawer(bonId);
    }
}

// ── Helpers ──────────────────────────────────────────────────
function _faktFmt(n) {
    if (n == null) return '0';
    return Math.round(n).toLocaleString('da-DK');
}

function _faktDateShort(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
    const day = d.getDate();
    const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    return `${days[d.getDay()].charAt(0).toUpperCase() + days[d.getDay()].slice(1)} ${day}. ${months[d.getMonth()]}`;
}

function _faktDateLong(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function _faktDeliveryLabel(method) {
    const m = { bike: 'Cykellevering', taxi: 'Taxa', van: 'Varevogn', pickup: 'Afhentning' };
    return m[method] || method || '';
}

function _escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _faktShowToast(msg) {
    const el = document.getElementById('fakt-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_faktToastTimer);
    _faktToastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
