/**
 * shared/manual_booking_modal.js
 * ════════════════════════════════════════════════════════════
 * Modal til manuel bestilling hos bud-leverandør (taxa, By-expressen).
 *
 * API:
 *   openManualBookingModal({ bonId, defaultVehicleId?, onBooked? })
 *
 * Flow:
 *   1. Hent vehicles (filter: booking_method='manual_clipboard')
 *   2. Vælg vehicle (dropdown — pre-selected hvis defaultVehicleId)
 *   3. Vis preview: clipboard-tekst + manglende felter
 *   4. "Kopiér og åbn {label}" — clipboard.writeText() + window.open()
 *   5. Booking-ref input (valgfri) + faktisk pris (valgfri)
 *   6. "Marker som booket" eller "Spring over"
 *
 * Afhænger af:
 *   shared/api.js    → fetchDeliveryVehicles, fetchBookingPayload, bookDelivery, setDeliveryActualCost
 *   shared/utils.js  → esc()
 *
 * Bygges som standalone overlay — bruger ikke shared/modal.js fordi flowet
 * er mere komplekst (multi-step state, edit mode, fallback-clipboard).
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    let _state = null;
    let _root = null;

    const MISSING_LABELS = {
        bon_id: 'Bon-ID',
        bon_number: 'Bon-nummer',
        customer_name: 'Bestiller-navn',
        customer_phone: 'Bestiller-tlf',
        customer_email: 'Bestiller-email',
        company_name: 'Firma',
        delivery_contact_name: 'Kontakt på dagen (navn)',
        delivery_contact_phone: 'Kontakt på dagen (tlf)',
        delivery_address: 'Leveringsadresse',
        delivery_address_street: 'Vej + nr',
        delivery_address_postal: 'Postnummer',
        delivery_address_city: 'By',
        delivery_date: 'Dato',
        delivery_time: 'Leveringstid',
        pickup_time: 'Afhentningstid',
        total_boxes: 'Antal kasser',
        total_pax: 'Antal personer',
        delivery_notes: 'Leveringsinstruks',
        packaging_lines: 'Pakke-info'
    };

    async function openManualBookingModal({ bonId, defaultVehicleId = null, onBooked = null } = {}) {
        if (!bonId) {
            console.error('[manual_booking_modal] bonId påkrævet');
            return;
        }

        if (_root) closeManualBookingModal();

        _state = {
            bonId,
            defaultVehicleId,
            onBooked,
            vehicles: [],
            selectedVehicleId: null,
            payload: null,
            editedClipboardText: null,
            editing: false,
            copied: false,
            loading: true,
            error: null
        };

        _root = document.createElement('div');
        _root.className = 'mbm-overlay';
        document.body.appendChild(_root);
        requestAnimationFrame(() => _root.classList.add('open'));
        document.addEventListener('keydown', _escHandler);

        _render();

        try {
            const vehicles = await fetchDeliveryVehicles();
            // Inkludér alle aktive vehicles — både manual_clipboard (taxa, By-expressen)
            // og calendar (egen Volvo, egen cykel). Modalen renderer simplere flow
            // for egne køretøjer hvor clipboard ikke er relevant.
            _state.vehicles = vehicles.filter(v => v.is_active !== 0 && v.is_active !== false);

            if (_state.vehicles.length === 0) {
                _state.loading = false;
                _state.error = 'Ingen leveringsmetoder er konfigureret. Tilføj én under Indstillinger → Leveringsmetoder.';
                _render();
                return;
            }

            // Pre-vælg: explicit defaultVehicleId, eller første i listen
            const preselect = defaultVehicleId && _state.vehicles.find(v => v.id === Number(defaultVehicleId));
            _state.selectedVehicleId = preselect ? preselect.id : _state.vehicles[0].id;

            await _loadPayload();
        } catch (err) {
            _state.loading = false;
            _state.error = err.message || 'Kunne ikke indlæse leveringsmetoder';
            _render();
        }
    }

    function closeManualBookingModal() {
        if (!_root) return;
        document.removeEventListener('keydown', _escHandler);
        _root.classList.remove('open');
        const el = _root;
        _root = null;
        _state = null;
        setTimeout(() => el.remove(), 200);
    }

    function _escHandler(e) {
        if (e.key === 'Escape') closeManualBookingModal();
    }

    async function _loadPayload() {
        if (!_state) return;
        _state.loading = true;
        _state.payload = null;
        _state.editedClipboardText = null;
        _state.editing = false;
        _state.copied = false;
        _render();

        try {
            const payload = await fetchBookingPayload(_state.bonId, _state.selectedVehicleId);
            _state.payload = payload;
            _state.loading = false;
            _render();
        } catch (err) {
            _state.loading = false;
            _state.error = err.message || 'Kunne ikke indlæse bestillingsdata';
            _render();
        }
    }

    function _onVehicleChange(e) {
        _state.selectedVehicleId = Number(e.target.value);
        _state.error = null;
        _loadPayload();
    }

    function _toggleEdit() {
        _state.editing = !_state.editing;
        if (_state.editing && _state.editedClipboardText == null) {
            _state.editedClipboardText = _state.payload?.clipboard_text || '';
        }
        _render();
    }

    function _onEditChange(e) {
        _state.editedClipboardText = e.target.value;
    }

    async function _onCopyAndOpen() {
        const text = (_state.editing ? _state.editedClipboardText : _state.payload?.clipboard_text) || '';
        const url = _state.payload?.booking_url;

        let copySucceeded = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                copySucceeded = true;
            }
        } catch (err) {
            console.warn('[manual_booking_modal] clipboard.writeText fejlede:', err);
        }

        if (!copySucceeded) {
            // Fallback: fokus textarea + select så bruger kan Cmd+C
            _state.editing = true;
            _state.editedClipboardText = text;
            _render();
            const ta = _root.querySelector('.mbm-clipboard-edit');
            if (ta) {
                ta.focus();
                ta.select();
            }
            alert('Kunne ikke kopiere automatisk. Tekst er markeret — tryk Cmd+C (Mac) eller Ctrl+C (Win) for at kopiere.');
        } else {
            _state.copied = true;
            _render();
        }

        if (url) {
            try {
                window.open(url, '_blank', 'noopener,noreferrer');
            } catch (err) {
                console.warn('[manual_booking_modal] window.open fejlede:', err);
            }
        }
    }

    async function _onMarkBooked(status) {
        if (!_state.payload) return;
        const refInput = _root.querySelector('.mbm-ref-input');
        const costInput = _root.querySelector('.mbm-cost-input');
        const reference = refInput?.value?.trim() || null;
        const costRaw = costInput?.value?.trim();
        const costAmount = costRaw ? Number(costRaw) : null;

        if (costRaw && (isNaN(costAmount) || costAmount < 0)) {
            alert('Ugyldigt pris-beløb');
            return;
        }

        const btn = _root.querySelector(`[data-action="${status}"]`);
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Gemmer…';
        }

        try {
            const event = await bookDelivery({
                bon_id: _state.bonId,
                vehicle_id: _state.selectedVehicleId,
                reference,
                status
            });

            if (costAmount != null && costAmount > 0) {
                await setDeliveryActualCost({
                    bon_id: _state.bonId,
                    amount_dkk: costAmount,
                    source: 'manual'
                });
            }

            const callback = _state.onBooked;
            closeManualBookingModal();
            if (typeof callback === 'function') {
                try {
                    callback(event);
                } catch (err) {
                    console.error('[manual_booking_modal] onBooked callback fejl:', err);
                }
            }
        } catch (err) {
            alert('Kunne ikke gemme booking: ' + (err.message || 'ukendt fejl'));
            if (btn) {
                btn.disabled = false;
                btn.textContent = status === 'booked' ? 'Marker som booket' : 'Spring over';
            }
        }
    }

    function _render() {
        if (!_root || !_state) return;

        if (_state.loading && !_state.payload) {
            _root.innerHTML = `
                <div class="mbm-panel">
                    <div class="mbm-header">
                        <div class="mbm-title">Bestil levering</div>
                        <button class="mbm-close" data-close>×</button>
                    </div>
                    <div class="mbm-body">
                        <div class="mbm-loading">Indlæser…</div>
                    </div>
                </div>`;
            _bindGlobalHandlers();
            return;
        }

        if (_state.error && !_state.payload) {
            _root.innerHTML = `
                <div class="mbm-panel">
                    <div class="mbm-header">
                        <div class="mbm-title">Bestil levering</div>
                        <button class="mbm-close" data-close>×</button>
                    </div>
                    <div class="mbm-body">
                        <div class="mbm-error">${_esc(_state.error)}</div>
                    </div>
                    <div class="mbm-footer">
                        <button class="mbm-btn mbm-btn-secondary" data-close>Luk</button>
                    </div>
                </div>`;
            _bindGlobalHandlers();
            return;
        }

        const payload = _state.payload;
        const vehicle = payload?.vehicle;
        const bon = payload?.bon;
        const bookingMethod = payload?.booking_method;
        const isOwnVehicle = bookingMethod !== 'manual_clipboard';
        const clipText = _state.editing
            ? (_state.editedClipboardText ?? '')
            : (payload?.clipboard_text || '');

        const vehicleOptions = _state.vehicles.map(v => {
            const tag = v.booking_method === 'manual_clipboard' ? ' — bud' : ' — eget';
            return `<option value="${v.id}" ${v.id === _state.selectedVehicleId ? 'selected' : ''}>${_esc(v.label)}${tag}</option>`;
        }).join('');

        const missing = (payload?.missing_fields || []).filter(k => MISSING_LABELS[k]);
        const missingHtml = missing.length > 0 && !isOwnVehicle
            ? `<div class="mbm-warn">
                  <strong>Manglende felter:</strong>
                  ${missing.map(k => `<span class="mbm-missing-tag">${_esc(MISSING_LABELS[k] || k)}</span>`).join(' ')}
                  <div class="mbm-warn-hint">Felter er markeret med [mangler] i tekst nedenfor.</div>
               </div>`
            : '';

        const warnings = payload?.warnings || [];
        const warningsHtml = warnings.length > 0
            ? `<div class="mbm-warn mbm-warn-config">
                  ${warnings.map(w => {
                      if (w === 'template_not_configured') return '⚠ Template er ikke konfigureret. Tilføj clipboard-tekst under Indstillinger → Leveringsmetoder.';
                      if (w === 'booking_url_not_configured') return '⚠ URL er ikke konfigureret.';
                      return '⚠ ' + _esc(w);
                  }).join('<br>')}
               </div>`
            : '';

        const bonSummary = bon
            ? `<div class="mbm-bon-summary">
                  <div><strong>${_esc(bon.bon_number || '')}</strong> ·
                       ${_esc(bon.delivery_address || '(ingen adresse)')}</div>
                  <div class="mbm-bon-meta">
                       ${bon.delivery_date ? _esc(bon.delivery_date) : ''}
                       ${bon.delivery_time ? ' kl. ' + _esc(bon.delivery_time) : ''}
                       ${bon.boxes ? ' · ' + bon.boxes + ' kasser' : ''}
                       ${bon.pax ? ' · ' + bon.pax + ' pers.' : ''}
                  </div>
               </div>`
            : '';

        const estimatedHtml = payload?.estimated_cost_dkk != null
            ? `<span class="mbm-est">Estimat: ca. ${payload.estimated_cost_dkk} kr</span>`
            : '';

        // Branching: eget køretøj vs ekstern bud-leverandør
        let bodyMiddle, footer, title;
        if (isOwnVehicle) {
            title = 'Tildel levering';
            bodyMiddle = `
                <div class="mbm-own-hint">
                    ${_esc(vehicle?.label || 'Eget køretøj')} er et internt køretøj — ingen ekstern bestilling nødvendig.
                    Klik <strong>Tildel</strong> for at registrere ansvaret på denne bon.
                </div>
                <div class="mbm-form-grid">
                    <div>
                        <label class="mbm-label">Note (valgfri)</label>
                        <input type="text" class="mbm-ref-input" placeholder="fx 'Leif henter'">
                    </div>
                    <div>
                        <label class="mbm-label">Pris (valgfri)</label>
                        <input type="number" class="mbm-cost-input" placeholder="kr" min="0" step="1">
                    </div>
                </div>
            `;
            footer = `
                <button class="mbm-btn mbm-btn-secondary" data-close>Annullér</button>
                <button class="mbm-btn mbm-btn-success" data-action="booked">Tildel</button>
            `;
        } else {
            title = 'Bestil levering';
            const clipboardSection = clipText
                ? (_state.editing
                    ? `<textarea class="mbm-clipboard-edit" rows="14">${_esc(clipText)}</textarea>`
                    : `<pre class="mbm-clipboard">${_esc(clipText)}</pre>`)
                : `<div class="mbm-empty">Ingen template — kontakt admin.</div>`;
            const copyLabel = _state.copied
                ? `Kopiér igen og åbn ${_esc(vehicle?.label || '')}`
                : `Kopiér og åbn ${_esc(vehicle?.label || '')}`;
            const canBook = !!clipText;

            bodyMiddle = `
                ${missingHtml}

                <div class="mbm-clipboard-row">
                    <label class="mbm-label">Bestillings-tekst</label>
                    <button class="mbm-mini-btn" data-action="toggle-edit">${_state.editing ? 'Luk redigering' : 'Rediger'}</button>
                </div>
                ${clipboardSection}

                <button class="mbm-btn mbm-btn-primary" data-action="copy" ${!canBook ? 'disabled' : ''}>
                    ${_esc(copyLabel)}
                </button>

                <div class="mbm-form-grid">
                    <div>
                        <label class="mbm-label">Booking-ref (valgfri)</label>
                        <input type="text" class="mbm-ref-input" placeholder="fx 261.801.254">
                    </div>
                    <div>
                        <label class="mbm-label">Faktisk pris (valgfri)</label>
                        <input type="number" class="mbm-cost-input" placeholder="kr" min="0" step="1">
                    </div>
                </div>
            `;
            footer = `
                <button class="mbm-btn mbm-btn-secondary" data-action="in_progress" ${!canBook ? 'disabled' : ''}>Spring over</button>
                <button class="mbm-btn mbm-btn-success" data-action="booked" ${!canBook ? 'disabled' : ''}>Marker som booket</button>
            `;
        }

        _root.innerHTML = `
            <div class="mbm-panel">
                <div class="mbm-header">
                    <div class="mbm-title">${title}</div>
                    <button class="mbm-close" data-close>×</button>
                </div>
                <div class="mbm-body">
                    ${bonSummary}

                    <label class="mbm-label">Leverandør</label>
                    <select class="mbm-vehicle-select">${vehicleOptions}</select>
                    ${estimatedHtml ? `<div class="mbm-meta-row">${estimatedHtml}</div>` : ''}

                    ${warningsHtml}
                    ${bodyMiddle}
                </div>
                <div class="mbm-footer">${footer}</div>
            </div>`;

        _bindGlobalHandlers();
        _bindContentHandlers();
    }

    function _bindGlobalHandlers() {
        // Klik på overlay (uden for panel) lukker
        _root.onclick = (e) => {
            if (e.target === _root) closeManualBookingModal();
        };
        const closeBtn = _root.querySelector('[data-close]');
        if (closeBtn) closeBtn.onclick = closeManualBookingModal;
    }

    function _bindContentHandlers() {
        const sel = _root.querySelector('.mbm-vehicle-select');
        if (sel) sel.onchange = _onVehicleChange;

        const editBtn = _root.querySelector('[data-action="toggle-edit"]');
        if (editBtn) editBtn.onclick = _toggleEdit;

        const ta = _root.querySelector('.mbm-clipboard-edit');
        if (ta) ta.oninput = _onEditChange;

        const copyBtn = _root.querySelector('[data-action="copy"]');
        if (copyBtn) copyBtn.onclick = _onCopyAndOpen;

        const bookedBtn = _root.querySelector('[data-action="booked"]');
        if (bookedBtn) bookedBtn.onclick = () => _onMarkBooked('booked');

        const skipBtn = _root.querySelector('[data-action="in_progress"]');
        if (skipBtn) skipBtn.onclick = () => _onMarkBooked('in_progress');
    }

    function _esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Eksponer på window
    window.openManualBookingModal = openManualBookingModal;
    window.closeManualBookingModal = closeManualBookingModal;
})();
