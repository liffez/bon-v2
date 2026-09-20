/**
 * views/delivery/note.js
 * ══════════════════════════════════════════════════════════════
 * Popout-vinduet til manuel bud-bestilling.
 *
 * Standalone HTML-side (åbnes via window.open fra bon-drawer/-kort).
 * Vinduet kommunikerer med hovedvinduet via SSE (live opdatering) og
 * lukker sig selv når booking er gemt — drawer i hovedvinduet opdaterer
 * også via SSE.
 *
 * Spec: docs/CLAUDE_DELIVERY_POPOUT.md
 * ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const MISSING_LABELS = {
        bon_id: 'Bon-ID', bon_number: 'Bon-nummer',
        customer_name: 'Bestiller-navn', customer_phone: 'Bestiller-tlf', customer_email: 'Bestiller-email',
        company_name: 'Firma',
        delivery_contact_name: 'Kontakt på dagen (navn)', delivery_contact_phone: 'Kontakt på dagen (tlf)',
        delivery_address: 'Leveringsadresse',
        delivery_address_street: 'Vej + nr', delivery_address_postal: 'Postnummer', delivery_address_city: 'By',
        delivery_date: 'Dato', delivery_time: 'Leveringstid', pickup_time: 'Afhentningstid',
        total_boxes: 'Antal kasser', total_pax: 'Antal personer',
        delivery_notes: 'Leveringsinstruks',
        packaging_lines: 'Pakke-info'
    };

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Kun http/https må blive et klikbart link. URL'en kommer fra vores egen
    // Settings, men en 'javascript:'-streng dér skal ikke kunne køre her.
    function httpUrlOrNull(raw) {
        if (!raw) return null;
        try {
            const u = new URL(String(raw).trim());
            return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
        } catch (e) {
            return null;
        }
    }

    // Vist tekst = hvor man lander ('taxa.nu'), ikke hele URL'en.
    function urlHostLabel(href) {
        try {
            return new URL(href).hostname.replace(/^www\./, '');
        } catch (e) {
            return href;
        }
    }

    // ── Parse bonId fra URL ───────────────────────────────────
    const pathMatch = window.location.pathname.match(/\/delivery\/note\/(\d+)/);
    const bonId = pathMatch ? Number(pathMatch[1]) : null;
    const initialVehicleParam = new URLSearchParams(window.location.search).get('vehicle');

    if (!bonId) {
        document.body.innerHTML = '<div class="dn-error" style="padding:40px;text-align:center">Ugyldig URL: bon-ID mangler.</div>';
        return;
    }

    // ── State ────────────────────────────────────────────────
    const state = {
        bonId,
        selectedVehicleId: initialVehicleParam ? Number(initialVehicleParam) : null,
        vehicles: [],
        payload: null,
        mode: 'text',                     // 'fields' | 'text' — samlet tekst er default (nemmest at kopiere)
        copiedFields: new Set(),          // husker hvilke felter er kopieret (UX)
        clipText: '',                     // teksten der kopieres — IKKE DOM'ens
                                          // textContent, som også rummer tællerne
        loading: true,
        saving: false,
        error: null
    };

    // ── DOM ──────────────────────────────────────────────────
    const $title    = document.getElementById('dn-title');
    const $meta     = document.getElementById('dn-meta');
    const $select   = document.getElementById('dn-vehicle-select');
    const $estimate = document.getElementById('dn-estimate');
    const $modes    = document.getElementById('dn-modes');
    const $modeTabs = $modes.querySelectorAll('.dn-mode-tab');
    const $loading  = document.getElementById('dn-loading');
    const $error    = document.getElementById('dn-error');
    const $warnings = document.getElementById('dn-warnings');
    const $missing  = document.getElementById('dn-missing');
    const $fieldsView = document.getElementById('dn-fields-view');
    const $textView   = document.getElementById('dn-text-view');
    const $clipText   = document.getElementById('dn-clipboard-text');
    const $copyAll    = document.getElementById('dn-copy-all');
    const $copyOpen   = document.getElementById('dn-copy-open');
    const $supplierLink = document.getElementById('dn-supplier-link');
    const $bookingRef = document.getElementById('dn-booking-ref');
    const $actualCost = document.getElementById('dn-actual-cost');
    const $skipBtn    = document.getElementById('dn-skip');
    const $bookBtn    = document.getElementById('dn-book');
    const $toast      = document.getElementById('dn-toast');

    // ── Init ─────────────────────────────────────────────────
    async function init() {
        try {
            // Pre-load vehicles + bon parallelt
            const [vehicles, bon] = await Promise.all([
                fetchDeliveryVehicles(),
                fetchBon(bonId)
            ]);
            state.vehicles = vehicles.filter(v => v.is_active !== 0 && v.is_active !== false);

            if (state.vehicles.length === 0) {
                showError('Ingen leveringsmetoder er konfigureret. Tilføj én under Indstillinger → Leveringsmetoder.');
                return;
            }

            // Sæt header med bon-info
            renderHeader(bon);

            // Pre-vælg vehicle: explicit param, eksisterende på bon, eller første aktive
            if (!state.selectedVehicleId) {
                const fromBon = bon && bon.delivery_vehicle_id;
                if (fromBon && state.vehicles.some(v => v.id === Number(fromBon))) {
                    state.selectedVehicleId = Number(fromBon);
                } else {
                    state.selectedVehicleId = state.vehicles[0].id;
                }
            }

            // Render dropdown
            renderVehicleDropdown();

            await loadPayload();
            setupSSE();
        } catch (err) {
            console.error('[delivery-note] init fejl:', err);
            showError('Kunne ikke indlæse data: ' + (err.message || 'ukendt fejl'));
        }
    }

    function renderHeader(bon) {
        if (!bon) return;
        const bonNum = bon.bon_number || ('#' + bon.id);
        const cust = bon.contact_name_full || bon.company_name || '';
        $title.textContent = 'Bestil bud · ' + bonNum + (cust ? ' · ' + cust : '');

        const parts = [];
        if (bon.delivery_date) {
            const m = String(bon.delivery_date).match(/^(\d{4})-(\d{2})-(\d{2})/);
            parts.push(m ? `${m[3]}-${m[2]}-${m[1]}` : bon.delivery_date);
        }
        if (bon.delivery_time) parts.push('lev. ' + bon.delivery_time);
        if (bon.pickup_time)   parts.push('afhent ' + bon.pickup_time);
        if (bon.pax)           parts.push(bon.pax + ' pers.');
        if (bon.boxes)         parts.push(bon.boxes + ' kasser');
        $meta.textContent = parts.join(' · ');
    }

    function renderVehicleDropdown() {
        $select.innerHTML = state.vehicles.map(v => {
            const tag = v.booking_method === 'manual_clipboard' ? ' — bud' : ' — eget';
            const selAttr = v.id === state.selectedVehicleId ? 'selected' : '';
            return `<option value="${v.id}" ${selAttr}>${esc(v.label)}${tag}</option>`;
        }).join('');
    }

    async function loadPayload() {
        state.loading = true;
        state.copiedFields.clear();
        $loading.hidden = false;
        $error.hidden = true;
        $warnings.hidden = true;
        $missing.hidden = true;
        $fieldsView.innerHTML = '';
        $clipText.textContent = '';

        try {
            const payload = await fetchBookingPayload(state.bonId, state.selectedVehicleId);
            state.payload = payload;
            state.loading = false;
            $loading.hidden = true;
            render();
        } catch (err) {
            state.loading = false;
            $loading.hidden = true;
            showError('Kunne ikke hente bestillingsdata: ' + (err.message || 'fejl'));
        }
    }

    function render() {
        const p = state.payload;
        if (!p) return;

        // Estimat-pille
        if (p.estimated_cost_dkk != null) {
            $estimate.textContent = '≈ ' + p.estimated_cost_dkk + ' kr';
            $estimate.hidden = false;
        } else {
            $estimate.hidden = true;
        }

        // Warnings (template_not_configured, booking_url_not_configured)
        const warnings = p.warnings || [];
        if (warnings.length > 0) {
            const lines = warnings.map(w => {
                if (w === 'template_not_configured') return '⚠ Samlet tekst-skabelon er ikke konfigureret. Tilføj den under Indstillinger → Leveringsmetoder.';
                if (w === 'booking_url_not_configured') return '⚠ Leverandørens bookingside er ikke konfigureret. Tilføj URL\'en under Indstillinger → Leveringsmetoder.';
                return '⚠ ' + esc(w);
            });
            $warnings.innerHTML = lines.map(l => '<div class="dn-warning-line">' + l + '</div>').join('');
            $warnings.hidden = false;
        } else {
            $warnings.hidden = true;
        }

        renderSupplierLink();

        const hasFields = Array.isArray(p.fields);

        // Toggle tabs visibility — vi viser begge hvis fields findes
        if (hasFields) {
            $modes.hidden = false;
        } else {
            // Ingen felter konfigureret — skjul tabs, default til text
            $modes.hidden = true;
            state.mode = 'text';
        }

        // Render felt-liste
        if (hasFields) {
            renderFields(p.fields);
        }

        // Render samlet tekst
        if (p.clipboard_text) {
            state.clipText = p.clipboard_text;
            renderClipboard(p.clipboard_text, p.text_blocks);
        } else if (hasFields) {
            // Generér fallback fra fields hvis ikke clipboard_text leveres
            state.clipText = p.fields.map(f => f.label + ': ' + f.value).join('\n');
            $clipText.textContent = state.clipText;
        } else {
            state.clipText = '';
            $clipText.textContent = '(ingen tekst — konfigurér skabelon under Indstillinger → Leveringsmetoder)';
        }

        applyMode();
        updateMissingBanner();
        updateBookButton();
    }

    // Link til leverandørens bookingside. Vises kun når der ER en brugbar URL —
    // en vogn vi kører selv (calendar) har ingen, og så er der intet at åbne.
    function renderSupplierLink() {
        const href = httpUrlOrNull(state.payload && state.payload.booking_url);
        const host = href ? urlHostLabel(href) : '';

        if (href) {
            $supplierLink.href = href;
            $supplierLink.textContent = '↗ ' + host;
            $supplierLink.title = 'Åbn ' + href + ' i ny fane';
            $supplierLink.hidden = false;

            $copyOpen.href = href;
            $copyOpen.textContent = 'Kopiér og åbn ' + host;
            $copyOpen.title = 'Kopierer teksten og åbner ' + href;
            $copyOpen.hidden = false;
            $copyAll.classList.remove('dn-btn-primary');
            $copyAll.classList.add('dn-btn-secondary');
        } else {
            $supplierLink.hidden = true;
            $supplierLink.removeAttribute('href');
            $copyOpen.hidden = true;
            $copyOpen.removeAttribute('href');
            $copyAll.classList.remove('dn-btn-secondary');
            $copyAll.classList.add('dn-btn-primary');
        }
    }

    // Den samlede tekst som klikbare blokke.
    //
    // Kontoret kopierer blok for blok ind i leverandørens formular, så hver blok
    // er sin egen kopi-knap. Har blokken en tegngrænse ({{max:N}} i skabelonen),
    // står tælleren ved siden af — den bor UDEN FOR blokkens span, så den aldrig
    // følger med i det der kopieres.
    //
    // Teksten der kopieres er payloadets egen (state.clipText), ikke DOM'ens
    // textContent: tællerne ville ellers snige sig med.
    function renderClipboard(text, blocks) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
            $clipText.textContent = text;
            return;
        }

        let html = '';
        let pos = 0;
        blocks.forEach((b, i) => {
            const at = text.indexOf(b.text, pos);
            if (at < 0) return;                       // blokken findes ikke — spring over
            html += esc(text.slice(pos, at));         // whitespace mellem blokke, uændret
            // Tælleren står OVER blokken, ikke ved siden af dens sidste linje:
            // grænsen gælder hele blokken, og hængt bagpå så den ud som en del
            // af den nederste linje. Den bor stadig uden for blokkens span, så
            // den hverken følger med ved klik eller ved en musemarkering.
            if (b.maxlen) {
                html += '<span class="dn-block-count' + (b.over ? ' over' : '') + '">'
                      + b.length + '/' + b.maxlen + '</span>';
            }
            html += '<span class="dn-block' + (b.over ? ' over' : '')
                  + '" data-block="' + i + '" title="Klik for at kopiere denne blok">'
                  + esc(b.text) + '</span>';
            pos = at + b.text.length;
        });
        html += esc(text.slice(pos));
        $clipText.innerHTML = html;

        $clipText.querySelectorAll('.dn-block').forEach(el => {
            el.addEventListener('click', async () => {
                const b = blocks[Number(el.dataset.block)];
                if (!b) return;
                const ok = await copyToClipboard(b.text);
                if (ok) {
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1200);
                    showToast(b.over
                        ? 'Blok kopieret — men den er ' + (b.length - b.maxlen) + ' tegn for lang'
                        : 'Blok kopieret');
                }
            });
        });
    }

    function renderFields(fields) {
        if (!fields || fields.length === 0) {
            $fieldsView.innerHTML = '<div class="dn-error" style="text-align:left">Ingen felt-konfiguration for denne leverandør. Brug "Samlet tekst" eller tilføj felter under Indstillinger → Leveringsmetoder.</div>';
            return;
        }

        // Gruppér efter step hvis nogle felter har step
        const hasSteps = fields.some(f => f.step);
        let html = '';

        if (hasSteps) {
            // Bevarer rækkefølgen fra arrayet; samler felter med samme step efter hinanden
            const seen = new Set();
            fields.forEach((f, idx) => {
                if (f.step && !seen.has(f.step)) {
                    html += '<div class="dn-field-step">' + esc(f.step) + '</div>';
                    seen.add(f.step);
                }
                html += renderFieldRow(f, idx);
            });
        } else {
            html = fields.map((f, idx) => renderFieldRow(f, idx)).join('');
        }

        $fieldsView.innerHTML = html;

        // Bind klik-handlere
        $fieldsView.querySelectorAll('.dn-field-row').forEach(row => {
            row.addEventListener('click', () => onFieldClick(Number(row.dataset.idx)));
        });
    }

    function renderFieldRow(field, idx) {
        const missing = !!field.missing;
        const copied = state.copiedFields.has(idx);
        const classes = ['dn-field-row'];
        if (missing) classes.push('missing');
        if (copied)  classes.push('copied');

        const icon = missing ? '⚠' : (copied ? '✓' : '⧉');
        const valueCls = missing ? 'dn-field-value dim' : 'dn-field-value';
        const valueEsc = esc(field.value || '');

        if (field.over) classes.push('over');
        const count = field.maxlen
            ? `<span class="dn-field-count${field.over ? ' over' : ''}">${field.length}/${field.maxlen}</span>`
            : '';

        return `
            <div class="${classes.join(' ')}" data-idx="${idx}" data-value="${valueEsc}" title="${valueEsc}">
                <span class="dn-field-label">${esc(field.label)}</span>
                <span class="${valueCls}">${valueEsc || '&nbsp;'}</span>
                ${count}
                <span class="dn-field-icon">${icon}</span>
            </div>`;
    }

    function updateMissingBanner() {
        const p = state.payload;
        if (!p) return;

        let labels = [];
        if (Array.isArray(p.fields)) {
            // Brug felt-labels fra konfiguration
            labels = p.fields.filter(f => f.missing).map(f => f.label);
        } else {
            // Fallback: variable-keys → læsbare labels
            labels = (p.missing_fields || [])
                .map(k => MISSING_LABELS[k] || k)
                .filter(Boolean);
        }

        // For lange blokke/felter: leverandørens formular afviser dem, så det
        // skal stå fremme — ikke kun som et tal man selv skal opdage.
        const over = []
            .concat((p.text_blocks || []).filter(b => b.over)
                .map(b => 'tekstblok (' + b.length + '/' + b.maxlen + ')'))
            .concat((p.fields || []).filter(f => f.over)
                .map(f => f.label + ' (' + f.length + '/' + f.maxlen + ')'));

        let html = '';
        if (labels.length > 0) {
            html += '<strong>Mangler:</strong> ' + esc(labels.join(', ')) + ' · markeres som <em>[mangler]</em>';
        }
        if (over.length > 0) {
            if (html) html += '<br>';
            html += '<strong>For lang:</strong> ' + esc(over.join(', '))
                 + ' · forkort teksten, ellers afviser leverandøren den';
        }

        if (html) {
            $missing.innerHTML = html;
            $missing.hidden = false;
        } else {
            $missing.hidden = true;
        }
    }

    function applyMode() {
        $modeTabs.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === state.mode);
        });
        const showFields = state.mode === 'fields';
        $fieldsView.hidden = !showFields;
        $textView.hidden = showFields;
    }

    function updateBookButton() {
        // "Marker som booket" er altid mulig — selv hvis felter mangler, kan
        // brugeren have udfyldt manuelt på leverandørens side.
        $bookBtn.disabled = state.saving;
        $skipBtn.disabled = state.saving;
    }

    function showError(msg) {
        $loading.hidden = true;
        $error.textContent = msg;
        $error.hidden = false;
    }

    // ── Toast ────────────────────────────────────────────────
    let toastTimer = null;
    function showToast(text) {
        $toast.textContent = text;
        $toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => $toast.classList.remove('show'), 1500);
    }

    // ── Klikbar felt-chip → clipboard ────────────────────────
    async function onFieldClick(idx) {
        const p = state.payload;
        if (!p || !Array.isArray(p.fields)) return;
        const field = p.fields[idx];
        if (!field || field.missing) return;
        const text = field.value || '';
        if (!text) return;

        const ok = await copyToClipboard(text);
        if (ok) {
            state.copiedFields.add(idx);
            const row = $fieldsView.querySelector(`.dn-field-row[data-idx="${idx}"]`);
            if (row) {
                row.classList.add('copied');
                const ic = row.querySelector('.dn-field-icon');
                if (ic) ic.textContent = '✓';
            }
            const short = text.length > 36 ? text.substring(0, 36) + '…' : text;
            showToast('Kopieret: ' + short);
        }
    }

    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {
            console.warn('[delivery-note] clipboard.writeText fejlede:', err);
        }
        // Fallback: pre-selected textarea + bed bruger trykke Cmd+C
        return promptManualCopy(text);
    }

    function promptManualCopy(text) {
        return new Promise(resolve => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '50%';
            ta.style.left = '50%';
            ta.style.transform = 'translate(-50%, -50%)';
            ta.style.width = '80%';
            ta.style.height = '80px';
            ta.style.zIndex = '9999';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            alert('Kunne ikke kopiere automatisk. Tekst er markeret — tryk Cmd+C (Mac) eller Ctrl+C (Win), og luk derefter dialogen.');
            ta.remove();
            resolve(true);
        });
    }

    // ── Marker som booket ────────────────────────────────────
    async function onMarkBooked(status /* 'booked' | 'in_progress' */) {
        if (state.saving || !state.payload) return;
        const reference = ($bookingRef.value || '').trim() || null;
        const costRaw = ($actualCost.value || '').trim();
        const costAmount = costRaw ? Number(costRaw) : null;
        if (costRaw && (isNaN(costAmount) || costAmount < 0)) {
            alert('Ugyldigt pris-beløb');
            return;
        }

        state.saving = true;
        updateBookButton();
        const targetBtn = status === 'booked' ? $bookBtn : $skipBtn;
        const originalText = targetBtn.textContent;
        targetBtn.textContent = 'Gemmer…';

        try {
            await bookDelivery({
                bon_id: state.bonId,
                vehicle_id: state.selectedVehicleId,
                reference,
                status
            });
            if (costAmount != null && costAmount > 0) {
                await setDeliveryActualCost({
                    bon_id: state.bonId,
                    amount_dkk: costAmount,
                    source: 'manual'
                });
            }
            // Bed åbner-vinduet (drawer / bon-kort) genindlæse bonnen, og luk.
            notifyOpener();
            window.close();
        } catch (err) {
            console.error('[delivery-note] book fejl:', err);
            alert('Kunne ikke gemme booking: ' + (err.message || 'fejl'));
            state.saving = false;
            updateBookButton();
            targetBtn.textContent = originalText;
        }
    }

    // ── Signalér åbner-vinduet ───────────────────────────────
    // Bon-drawer'en lytter på window-eventet 'sse:bon_updated'. Popoutet og
    // hovedvinduet deler bruger/session, så server-SSE ekskluderer ikke, men
    // når til hovedvinduet — vi signalerer alligevel direkte for at være
    // robuste mod manglende SSE-bro i drawer'en.
    function notifyOpener() {
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.dispatchEvent(
                    new CustomEvent('sse:bon_updated', { detail: { id: state.bonId } })
                );
            }
        } catch (e) {
            // cross-origin eller lukket vindue — ignorér
        }
    }

    // ── SSE — opdater hvis bonen ændres i hovedvinduet ───────
    function setupSSE() {
        if (typeof connectSSE !== 'function') {
            console.warn('[delivery-note] connectSSE ikke tilgængelig — springer realtid over');
            return;
        }
        connectSSE('/api/sse', {
            connected: () => {},
            bon_updated: (data) => {
                if (data && Number(data.id) === state.bonId) loadPayload();
            },
            bon_status: (data) => {
                if (data && Number(data.id) === state.bonId) loadPayload();
            }
        });
    }

    // ── Klipboard "Kopier hele teksten" ──────────────────────
    $copyAll.addEventListener('click', async () => {
        const text = state.clipText || '';
        if (!text) return;
        const ok = await copyToClipboard(text);
        if (ok) showToast('Hele teksten kopieret');
    });

    // "Kopiér og åbn" er bevidst et <a target="_blank">: browseren følger linket
    // som en almindelig navigation, så et window.open() efter await på clipboard
    // ikke kan blive popup-blokeret. Vi kalder kun copy oveni — intet preventDefault.
    $copyOpen.addEventListener('click', () => {
        const text = state.clipText || '';
        if (text) copyToClipboard(text);
    });

    // ── Vehicle-skift ────────────────────────────────────────
    $select.addEventListener('change', () => {
        state.selectedVehicleId = Number($select.value);
        state.mode = 'fields'; // reset
        loadPayload();
    });

    // ── Mode tabs ────────────────────────────────────────────
    $modeTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            state.mode = btn.dataset.mode;
            applyMode();
        });
    });

    // ── Footer-knapper ───────────────────────────────────────
    $bookBtn.addEventListener('click', () => onMarkBooked('booked'));
    $skipBtn.addEventListener('click', () => onMarkBooked('in_progress'));

    // ── Escape lukker vinduet ────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.close();
    });

    init();
})();
